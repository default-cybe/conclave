/**
 * Code in a share to a friend (docs/design/FRIENDS.md, phases 2 and 3).
 *
 * Sending: the session's diff against HEAD, with paths relative to the
 * repository, or, only when asked, a git bundle of the session branch.
 * Untracked files never go: a diff against HEAD does not show them, and a
 * bundle holds only commits. Credential files never go: they are left out of
 * the diff by name, and a branch with one in any commit of its range is not
 * bundled. Binary files are left out of a diff (the text rules would mangle
 * them).
 *
 * Receiving: the code lands on a new branch from-<friend>/<slug> on a device
 * the owner picks, after the owner approved the plan. Nothing from the share
 * runs. Every git command runs with hooks off (core.hooksPath=/dev/null) and
 * no fsmonitor. A diff is applied to a temporary index and committed with
 * commit-tree, so the working tree, the current branch and checkout filters
 * are never touched; a bundle is fetched into the new branch only.
 */
import type { Machine } from '../machine/types';
import type { BundleCode } from '../client/share';

/** Largest git bundle a share takes, before base64. A share is 100 MB at most. */
export const MAX_GIT_BUNDLE_BYTES = 70 * 1024 * 1024;
/** Largest diff a share takes. */
export const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 2000;

// ---------------------------------------------------------------------------
// Credential files
// ---------------------------------------------------------------------------

const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults']);

/** File names that hold credentials, whatever folder they are in. */
const NAMES: Record<string, string> = {
  '.envrc': 'an environment file',
  '.netrc': 'a login file',
  _netrc: 'a login file',
  '.npmrc': 'a package registry login',
  '.pypirc': 'a package registry login',
  '.git-credentials': 'saved git logins',
  '.htpasswd': 'a password file',
  '.pgpass': 'a database password file',
  '.my.cnf': 'a database login',
  '.vault-token': 'a Vault token',
  '.dockercfg': 'a registry login',
  '.credentials.json': 'a login file',
  'auth.json': 'a login file',
  credentials: 'a credentials file',
  kubeconfig: 'a Kubernetes login',
  'terraform.tfstate': 'Terraform state',
};

/** Extensions of key and secret files. */
const EXTENSIONS: Record<string, string> = {
  '.pem': 'a key or certificate file',
  '.key': 'a key file',
  '.p8': 'a key file',
  '.p12': 'a key store',
  '.pfx': 'a key store',
  '.jks': 'a key store',
  '.keystore': 'a key store',
  '.kdbx': 'a password database',
  '.ppk': 'an SSH key',
  '.gpg': 'an encrypted secret',
  '.ovpn': 'a VPN profile with keys',
  '.tfvars': 'Terraform variables',
  '.tfstate': 'Terraform state',
  '.keychain': 'a keychain',
  '.keychain-db': 'a keychain',
  '.secret': 'a secret file',
  '.secrets': 'a secret file',
};

/** Folders whose files are all credentials. */
const FOLDERS: Record<string, string> = {
  '.ssh': 'the SSH folder',
  '.gnupg': 'the GnuPG folder',
  '.aws': 'the AWS folder',
};

/** Paths inside a folder: .docker/config.json, .kube/config, .config/gh/hosts.yml. */
const NESTED: Array<[RegExp, string]> = [
  [/(^|\/)\.docker\/config\.json$/, 'a registry login'],
  [/(^|\/)\.kube\/config$/, 'a Kubernetes login'],
  [/(^|\/)\.config\/gh\/hosts\.ya?ml$/, 'a GitHub login'],
  [/(^|\/)\.config\/gcloud\//, 'a Google Cloud login'],
  [/(^|\/)\.azure\//, 'an Azure login'],
];

/** Config-like files named for credentials: client_secret.json, service-account.json, secrets.yaml. */
const NAMED_CONFIG = /(credential|secret|service[-_]?account|private[-_]?key)[^/]*\.(json|ya?ml|ini|txt|cfg|conf|toml|properties|xml|env)$/i;

/**
 * Why a path is a credential file, or undefined when it is not. The path is
 * relative to the repository, with either slash.
 */
export function credentialReason(path: string): string | undefined {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = p.split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  const lower = name.toLowerCase();
  for (const dir of parts.slice(0, -1)) if (FOLDERS[dir.toLowerCase()]) return `in ${FOLDERS[dir.toLowerCase()]}`;
  if (lower === '.env' || (lower.startsWith('.env.') && !ENV_TEMPLATES.has(lower))) return 'an environment file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(lower)) return 'an SSH private key';
  if (NAMES[lower]) return NAMES[lower];
  if (lower.endsWith('.tfvars.json') || lower.endsWith('.tfstate.backup')) return 'Terraform variables or state';
  for (const [ext, why] of Object.entries(EXTENSIONS)) if (lower.endsWith(ext)) return why;
  for (const [re, why] of NESTED) if (re.test(p.toLowerCase())) return why;
  if (NAMED_CONFIG.test(name)) return 'a file named for credentials';
  return undefined;
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

/** A word for sh: single quoted. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** git with hooks and fsmonitor off and pathspecs taken as they are. */
export const GIT = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false --literal-pathspecs';

export class CodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeError';
  }
}

async function run(machine: Machine, cwd: string, command: string, opts: { env?: Record<string, string>; timeoutMs?: number; allowFail?: boolean } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const res = await machine.exec(command, { cwd, timeoutMs: opts.timeoutMs ?? 60_000, maxOutputBytes: 4 * 1024 * 1024, ...(opts.env ? { env: opts.env } : {}) });
  const ok = res.exitCode === 0 && !res.timedOut;
  if (!ok && !opts.allowFail) throw new CodeError((res.stderr || res.stdout || `git exited with ${res.exitCode}`).trim().split('\n').slice(-3).join(' '));
  return { ok, out: res.stdout, err: res.stderr };
}

/** The repository a folder is in: its top folder and its .git folder. */
async function repoOf(machine: Machine, cwd: string): Promise<{ top: string; gitDir: string }> {
  const r = await run(machine, cwd, `${GIT} rev-parse --show-toplevel --absolute-git-dir`, { allowFail: true });
  if (!r.ok) throw new CodeError(`${cwd} is not in a git repository.`);
  const [top, gitDir] = r.out.trim().split('\n');
  if (!top || !gitDir) throw new CodeError(`${cwd} is not in a git repository.`);
  return { top, gitDir };
}

function nul(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

function tmpName(): string {
  return `conclave-share-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The session's changes against HEAD, credential and binary files left out.
 * The text rules run later, on the sending hub (share.ts Redactor).
 */
export async function collectDiff(machine: Machine, cwd: string): Promise<BundleCode> {
  const { top, gitDir } = await repoOf(machine, cwd);
  const head = await run(machine, top, `${GIT} rev-parse --verify --quiet HEAD`, { allowFail: true });
  if (!head.ok) throw new CodeError('The repository has no commits yet, so there is no diff to send.');
  // -z: names as they are; numstat shows a binary file as "-\t-"
  const stat = nul((await run(machine, top, `${GIT} diff --numstat -z --no-renames --no-ext-diff --no-textconv HEAD`)).out);
  const files: string[] = [];
  const excluded: BundleCode['excluded'] = [];
  for (const entry of stat) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const path = m[3];
    const why = credentialReason(path);
    if (why) excluded.push({ path, reason: `credential file: ${why}` });
    else if (m[1] === '-' && m[2] === '-') excluded.push({ path, reason: 'binary file' });
    else files.push(path);
  }
  if (files.length > MAX_FILES) throw new CodeError(`The diff changes ${files.length} files; a share takes ${MAX_FILES} at most.`);
  if (!files.length) return { kind: 'diff', diff: '', files, excluded };
  const out = `${gitDir}/${tmpName()}.diff`;
  try {
    await run(machine, top, `${GIT} diff --no-color --no-ext-diff --no-textconv --no-renames HEAD -- ${files.map(shq).join(' ')} > ${shq(out)}`);
    const st = await machine.stat(out);
    if (st && st.size > MAX_DIFF_BYTES) throw new CodeError(`The diff is ${Math.round(st.size / 1024 / 1024)} MB; a share takes ${MAX_DIFF_BYTES / 1024 / 1024} MB of diff at most.`);
    const diff = await machine.readText(out);
    return { kind: 'diff', diff, files, excluded };
  } finally {
    await machine.remove(out).catch(() => undefined);
  }
}

/**
 * A git bundle of the session branch: the commits after its upstream (or
 * origin's default branch), or the whole branch when it has neither.
 * Refused when any commit of the range touches a credential file.
 */
export async function collectGitBundle(machine: Machine, cwd: string): Promise<BundleCode> {
  const { top, gitDir } = await repoOf(machine, cwd);
  const branch = (await run(machine, top, `${GIT} rev-parse --abbrev-ref HEAD`, { allowFail: true })).out.trim();
  if (!branch || branch === 'HEAD') throw new CodeError('The session folder is not on a branch, so there is no branch to bundle. Send the diff instead.');
  let base: string | undefined;
  for (const ref of ['@{upstream}', 'refs/remotes/origin/HEAD']) {
    const r = await run(machine, top, `${GIT} merge-base HEAD ${shq(ref)}`, { allowFail: true });
    if (r.ok && r.out.trim()) {
      base = r.out.trim();
      break;
    }
  }
  const head = (await run(machine, top, `${GIT} rev-parse HEAD`)).out.trim();
  if (base === head) throw new CodeError(`${branch} has no commits after its upstream. Send the diff instead.`);
  const range = base ? `${base}..refs/heads/${branch}` : `refs/heads/${branch}`;
  // every file any commit of the range touched: a credential added then removed is still in the objects
  const touched = [...new Set(nul((await run(machine, top, `${GIT} log --format= --name-only -z --no-renames ${shq(range)}`, { timeoutMs: 120_000 })).out))];
  const bad = touched.map((path) => ({ path, why: credentialReason(path) })).filter((x) => x.why);
  if (bad.length) {
    throw new CodeError(`Commits on ${branch} touch credential files (${bad.slice(0, 5).map((b) => b.path).join(', ')}${bad.length > 5 ? ', ...' : ''}), so the branch cannot go as a bundle. Send the diff instead.`);
  }
  const files = nul((await run(machine, top, `${GIT} diff --name-only -z --no-renames ${base ? shq(base) : `$(${GIT} hash-object -t tree /dev/null)`} ${shq(head)}`)).out);
  const out = `${gitDir}/${tmpName()}.bundle`;
  try {
    await run(machine, top, `${GIT} bundle create ${shq(out)} ${shq(range)}`, { timeoutMs: 300_000 });
    const st = await machine.stat(out);
    if (!st) throw new CodeError('git bundle made no file.');
    if (st.size > MAX_GIT_BUNDLE_BYTES) throw new CodeError(`The bundle is ${Math.round(st.size / 1024 / 1024)} MB; a share takes ${MAX_GIT_BUNDLE_BYTES / 1024 / 1024} MB at most. Send the diff instead.`);
    const data = Buffer.from(await machine.readFile(out)).toString('base64');
    return { kind: 'git-bundle', data, branch, ...(base ? { base } : {}), files, excluded: [] };
  } finally {
    await machine.remove(out).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/** Lower case words and digits joined by dashes, at most `max` characters. */
export function slug(text: string, max = 40): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'share';
}

/** The branch a friend's code lands on: from-<friend>/<title>. */
export function friendBranch(friend: string, title: string): string {
  return `from-${slug(friend, 24)}/${slug(title)}`;
}

/** Files in a change that can run code on build, commit or checkout: the owner reads them first. */
export function runsCode(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const name = p.split('/').pop() ?? '';
  return (
    /(^|\/)\.(husky|githooks|git-hooks)\//.test(p) ||
    /(^|\/)\.github\/workflows\//.test(p) ||
    /(^|\/)\.vscode\/(tasks|launch|settings)\.json$/.test(p) ||
    ['package.json', 'makefile', 'gnumakefile', '.envrc', 'setup.py', 'build.gradle', 'build.gradle.kts', 'cargo.toml', 'build.rs', 'pyproject.toml', '.pre-commit-config.yaml', 'lefthook.yml', '.gitattributes'].includes(name) ||
    /\.(sh|bash|zsh|ps1|bat|cmd)$/.test(name)
  );
}

export interface ApplyPlan {
  /** The repository's top folder on the device. */
  root: string;
  branch: string;
  /** HEAD there now: a diff goes on top of it. */
  base?: string;
  files: string[];
  /** Files that can run code once checked out or built. */
  runsCode: string[];
  /** The dry run: ok, or why it would not apply. */
  check: { ok: true } | { ok: false; error: string };
}

/** A branch name git takes, and one not taken yet there (adds -2, -3...). */
async function freeBranch(machine: Machine, top: string, want: string): Promise<string> {
  const ok = await run(machine, top, `${GIT} check-ref-format --branch ${shq(want)}`, { allowFail: true });
  const base = ok.ok ? want : friendBranch('friend', want);
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    const taken = await run(machine, top, `${GIT} show-ref --verify --quiet ${shq(`refs/heads/${name}`)}`, { allowFail: true });
    if (!taken.ok) return name;
  }
  throw new CodeError(`Branches ${base} to ${base}-49 are all taken.`);
}

/** Write a share's code to a temporary file in the repository's .git folder. */
async function writeTemp(machine: Machine, gitDir: string, code: BundleCode): Promise<string> {
  const path = `${gitDir}/${tmpName()}.${code.kind === 'diff' ? 'diff' : 'bundle'}`;
  await machine.writeFile(path, code.kind === 'diff' ? (code.diff ?? '') : Buffer.from(code.data ?? '', 'base64'));
  return path;
}

/**
 * What applying would do, checked without touching the working tree or any
 * branch: a diff is applied to a temporary index, a bundle is verified.
 */
export async function planApply(machine: Machine, cwd: string, code: BundleCode, wantBranch: string): Promise<ApplyPlan> {
  const { top, gitDir } = await repoOf(machine, cwd);
  const branch = await freeBranch(machine, top, wantBranch);
  const head = await run(machine, top, `${GIT} rev-parse --verify --quiet HEAD`, { allowFail: true });
  const base = head.ok ? head.out.trim() : undefined;
  const plan: ApplyPlan = { root: top, branch, ...(base ? { base } : {}), files: code.files, runsCode: code.files.filter(runsCode), check: { ok: true } };
  if (code.kind === 'diff' && !base) return { ...plan, check: { ok: false, error: 'The repository has no commits yet; a diff needs a commit to go on.' } };
  if (code.kind === 'diff' && !code.diff?.trim()) return { ...plan, check: { ok: false, error: 'The share has no diff.' } };
  const file = await writeTemp(machine, gitDir, code);
  const index = `${gitDir}/${tmpName()}.index`;
  try {
    if (code.kind === 'diff') {
      const env = { GIT_INDEX_FILE: index };
      await run(machine, top, `${GIT} read-tree HEAD`, { env });
      const r = await run(machine, top, `${GIT} apply --cached --check --whitespace=nowarn ${shq(file)}`, { env, allowFail: true });
      if (!r.ok) plan.check = { ok: false, error: `The diff does not apply on ${base?.slice(0, 10)}: ${(r.err || r.out).trim().split('\n').slice(0, 3).join(' ')}` };
    } else {
      const r = await run(machine, top, `${GIT} bundle verify ${shq(file)}`, { allowFail: true });
      if (!r.ok) plan.check = { ok: false, error: `The bundle does not fit this repository: ${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}` };
    }
  } finally {
    await machine.remove(file).catch(() => undefined);
    await machine.remove(index).catch(() => undefined);
  }
  return plan;
}

/**
 * Put a share's code on the plan's branch. A diff: a temporary index from
 * HEAD, git apply --cached, write-tree, commit-tree, then the branch. A
 * bundle: git fetch from the bundle file into the branch. Nothing is checked
 * out and no hook runs.
 */
export async function applyCode(machine: Machine, plan: ApplyPlan, code: BundleCode, author: { name: string; email: string; message: string }): Promise<{ branch: string; commit: string }> {
  const { top, gitDir } = await repoOf(machine, plan.root);
  const branch = await freeBranch(machine, top, plan.branch);
  if (branch !== plan.branch) throw new CodeError(`The branch ${plan.branch} exists now. Make the plan again.`);
  const file = await writeTemp(machine, gitDir, code);
  const index = `${gitDir}/${tmpName()}.index`;
  try {
    if (code.kind === 'diff') {
      const head = (await run(machine, top, `${GIT} rev-parse --verify HEAD`)).out.trim();
      if (plan.base && head !== plan.base) throw new CodeError('HEAD moved since the plan. Make the plan again.');
      const env = { GIT_INDEX_FILE: index };
      await run(machine, top, `${GIT} read-tree HEAD`, { env });
      await run(machine, top, `${GIT} apply --cached --whitespace=nowarn ${shq(file)}`, { env });
      const tree = (await run(machine, top, `${GIT} write-tree`, { env })).out.trim();
      const who = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: 'Conclave', GIT_COMMITTER_EMAIL: 'conclave@localhost' };
      const made = (await run(machine, top, `${GIT} commit-tree ${shq(tree)} -p ${shq(head)} -m ${shq(author.message)}`, { env: who })).out.trim();
      await run(machine, top, `${GIT} update-ref ${shq(`refs/heads/${branch}`)} ${shq(made)} ''`);
      return { branch, commit: made };
    }
    const ref = code.branch ? `refs/heads/${code.branch}` : 'HEAD';
    await run(machine, top, `${GIT} -c fetch.fsckObjects=true -c maintenance.auto=false -c gc.auto=0 fetch --no-tags ${shq(file)} ${shq(`${ref}:refs/heads/${branch}`)}`, { timeoutMs: 300_000 });
    const commit = (await run(machine, top, `${GIT} rev-parse ${shq(`refs/heads/${branch}`)}`)).out.trim();
    return { branch, commit };
  } finally {
    await machine.remove(file).catch(() => undefined);
    await machine.remove(index).catch(() => undefined);
  }
}
