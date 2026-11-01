/**
 * Git for the catalog. None of this uses GitHub API quota: ls-remote for
 * heads and update checks, a fetch of one commit with no blobs, then a
 * sparse checkout of only the paths an install needs. Repo scripts are never
 * run: no hooks are installed in these clones and nothing is executed from
 * them.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { copyRepoTree, listRepoFiles, missingLinkTargets } from '../util/copy-tree';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRun = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<GitResult>;

const ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_CONFIG_NOSYSTEM: '1',
  // LFS files stay pointers: no downloads from a server the repo names
  GIT_LFS_SKIP_SMUDGE: '1',
  // no repo-provided hooks or filters ever run in catalog clones
  GIT_CONFIG_COUNT: '5',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'advice.detachedHead',
  GIT_CONFIG_VALUE_1: 'false',
  // transports that run commands are never used, whatever the global git config says
  GIT_CONFIG_KEY_2: 'protocol.ext.allow',
  GIT_CONFIG_VALUE_2: 'never',
  GIT_CONFIG_KEY_3: 'protocol.fd.allow',
  GIT_CONFIG_VALUE_3: 'never',
  // no submodules are fetched from catalog clones
  GIT_CONFIG_KEY_4: 'submodule.recurse',
  GIT_CONFIG_VALUE_4: 'false',
};

export function gitRunner(spawn: typeof Bun.spawn = Bun.spawn): GitRun {
  return async (args, opts = {}) => {
    const proc = spawn(['git', ...args], {
      cwd: opts.cwd,
      env: { ...(process.env as Record<string, string>), ...ENV },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const isFullSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

/** https URL for owner/repo, or the URL as given. */
export function repoUrl(repoOrUrl: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(repoOrUrl)) return `https://github.com/${repoOrUrl}.git`;
  return repoOrUrl;
}

/** Commit a ref points at on the remote (HEAD by default), or undefined. */
export async function lsRemote(git: GitRun, url: string, ref = 'HEAD'): Promise<string | undefined> {
  const r = await git(['ls-remote', '--', url, ref], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const line = r.stdout.split('\n').find((l) => l.trim());
  const sha = line?.split(/\s+/)[0];
  return isFullSha(sha) ? sha : undefined;
}

/** Commit for a tag or branch name, or the name itself when it is already a full sha. */
export async function resolveRef(git: GitRun, url: string, ref?: string): Promise<string> {
  if (isFullSha(ref)) return ref;
  const want = ref ?? 'HEAD';
  const r = await git(['ls-remote', '--', url, want, `refs/tags/${want}^{}`, `refs/heads/${want}`, `refs/tags/${want}`], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const lines = r.stdout.split('\n').filter((l) => l.trim()).map((l) => l.split(/\s+/));
  const peeled = lines.find((l) => l[1]?.endsWith('^{}'));
  const sha = (peeled ?? lines[0])?.[0];
  if (!isFullSha(sha)) throw new Error(`no commit found for ${want} at ${url}`);
  return sha;
}

/**
 * Fetch exactly one commit into `dest` with no history and no blobs, then
 * check out only `paths` (folders end in "/"; empty means the whole tree).
 * Fails loudly when the commit cannot be fetched: there is no fallback to
 * the default branch.
 */
export async function fetchCommit(git: GitRun, url: string, sha: string, dest: string, paths: string[] = []): Promise<void> {
  if (!isFullSha(sha)) throw new Error(`not a full commit sha: ${sha}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const step = async (args: string[], timeoutMs?: number) => {
    const r = await git(args, { cwd: dest, timeoutMs });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r;
  };
  await step(['init', '-q']);
  await step(['remote', 'add', 'origin', url]);
  await step(['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', sha], 300_000);
  const wanted = paths.map((p) => p.replace(/^\.?\//, '')).filter((p) => p && p !== '.');
  if (wanted.length) {
    await step(['sparse-checkout', 'set', '--no-cone', ...wanted.map((p) => `/${p}`)]);
  }
  await step(['checkout', '-q', 'FETCH_HEAD'], 300_000);
  if (wanted.length) {
    // skill repos sometimes link SKILL.md from a package folder the sparse checkout left out: add the link targets too
    for (let round = 0; round < 3; round++) {
      const missing = new Set<string>();
      for (const w of wanted) {
        const abs = join(dest, w);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          const target = resolve(dirname(abs), readlinkSync(abs));
          const rel = relative(dest, target);
          if (!rel.startsWith('..') && !existsSync(target)) missing.add(rel);
        } else if (st.isDirectory()) for (const m of missingLinkTargets(abs, dest)) missing.add(m);
      }
      if (!missing.size) break;
      wanted.push(...missing);
      // "set" again with every path: newer git (2.55) rejects --no-cone on "add", older git needs the mode stated
      await step(['sparse-checkout', 'set', '--no-cone', ...wanted.map((p) => `/${p}`)], 300_000);
    }
  }
  const head = (await step(['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== sha) throw new Error(`fetched ${head.slice(0, 7)}, wanted ${sha.slice(0, 7)}`);
}

export interface TreeEntry {
  path: string;
  /** 100644, 100755, 120000 (symlink), 160000 (submodule). */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
}

/** Every path in the commit, without fetching any blob. */
export async function listTree(git: GitRun, dir: string, rev = 'HEAD'): Promise<TreeEntry[]> {
  const r = await git(['ls-tree', '-r', '--full-tree', rev], { cwd: dir, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim()}`);
  const out: TreeEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/.exec(line);
    if (m) out.push({ mode: m[1], type: m[2] as TreeEntry['type'], path: m[3] });
  }
  return out;
}

/** Copy a folder without .git; symlinks count only when they resolve inside `root` (the clone). */
export function copyTree(from: string, to: string, root = from): void {
  copyRepoTree(from, to, root);
}

/** Files under a folder, relative, skipping .git; symlinks count when they resolve to a file inside `root`. */
export function walkFiles(dir: string, root = dir): string[] {
  return listRepoFiles(dir, root);
}
