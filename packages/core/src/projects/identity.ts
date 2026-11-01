/**
 * Project identity (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.2).
 *
 * A project is a stable identity plus a location per device. The identity of
 * a folder is read through machine.exec on the device that has it, so the
 * device protocol does not change for it: git's root commits, HEAD, the
 * normalized remotes, the Syncthing folder it sits in, and a marker file
 * (.conclave/project.json) for plain folders the owner marked.
 */
import type { Machine } from '../machine/types';
import type { FolderIdentity, MatchLevel, ProjectIdentity } from '../client/projects';
import { syncthingFolderFor, type SyncthingFolder } from '../machine/syncthing';

export { syncthingFolderFor };
import { shellQuote } from '../tools/util';

/**
 * What one identify call on a device found. FolderIdentity is the HTTP shape;
 * the probe adds what the projects service keeps for itself.
 */
export interface FolderProbe extends FolderIdentity {
  /** The folder relative to the git top level ("" at the top or outside git). */
  rel: string;
  /** Uncommitted files (git status --porcelain lines). */
  dirty?: number;
  /** Remotes as git prints them, for Clone here. */
  rawRemotes: string[];
}

/** The identity a project keeps, plus the first remote URL to clone from. */
export type StoredIdentity = ProjectIdentity & { cloneUrl?: string };

const MARK = '__CONCLAVE_ID__';

/**
 * One shell call that prints everything identify needs. Output is
 * line-based: key=value, repeated keys for lists.
 */
export function identifyScript(path: string): string {
  const p = shellQuote(path);
  return [
    `cd ${p} 2>/dev/null || { echo "${MARK}missing"; exit 0; }`,
    `echo "${MARK}ok"`,
    `echo "pwd=$(pwd -P)"`,
    `top=$(git rev-parse --show-toplevel 2>/dev/null) || top=""`,
    `if [ -n "$top" ]; then`,
    `  echo "top=$top"`,
    `  echo "shallow=$(git rev-parse --is-shallow-repository 2>/dev/null)"`,
    `  echo "head=$(git rev-parse HEAD 2>/dev/null)"`,
    `  echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"`,
    `  git rev-list --max-parents=0 HEAD 2>/dev/null | sed 's/^/root=/'`,
    `  git remote -v 2>/dev/null | awk '{print "remote=" $2}' | sort -u`,
    `  echo "dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"`,
    `fi`,
    `[ -f package.json ] && sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/pkg=\\1/p' package.json | head -n 1`,
    `true`,
  ].join('\n');
}

/**
 * Normalize a git remote so the same repository matches on every device:
 * lower-case host; no scheme, user, port or ".git"; scp form converted.
 * Local paths and file: URLs return undefined (they differ per device).
 * aliases maps an SSH host alias to its real host name (ssh -G).
 */
export function normalizeRemote(raw: string, aliases: Record<string, string> = {}): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (s.startsWith('/') || s.startsWith('.') || /^file:/i.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return undefined;
  let host: string;
  let path: string;
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(s);
  if (url) {
    host = url[2];
    path = url[3];
  } else {
    // scp form: [user@]host:path
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(s);
    if (!scp) return undefined;
    host = scp[1];
    path = scp[2];
  }
  host = (aliases[host] ?? aliases[host.toLowerCase()] ?? host).toLowerCase();
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !path) return undefined;
  return `${host}/${path}`;
}

/**
 * A remote as git prints it, without a password or token in it. An https
 * remote can carry one (https://kai:ghp_x@github.com/...); it never goes
 * into the projects table, a Clone here URL or the web. An ssh user stays,
 * since git needs it to connect.
 */
export function cleanRemote(raw: string): string {
  const s = raw.trim();
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@(.*)$/i.exec(s);
  if (!m) return s;
  const scheme = m[1].toLowerCase();
  const user = m[2].split(':')[0];
  if (scheme.startsWith('ssh') && user) return `${m[1]}${user}@${m[3]}`;
  return `${m[1]}${m[3]}`;
}

/** The HTTP shape of a probe: what the folder is, without the service's own fields. */
export function folderIdentity(probe: FolderProbe): FolderIdentity {
  const { rel: _r, dirty: _d, rawRemotes: _raw, ...rest } = probe as FolderProbe & { cloneUrl?: string };
  delete (rest as { cloneUrl?: string }).cloneUrl;
  return rest;
}

/** Hosts in raw remotes that may be SSH aliases (no dot, not localhost). */
export function aliasHosts(remotes: string[]): string[] {
  const out = new Set<string>();
  for (const r of remotes) {
    const t = r.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^ssh:\/\//i.test(t)) continue;
    const m = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]/.exec(t);
    const h = m?.[1];
    if (h && !h.includes('.') && h !== 'localhost' && !/^[A-Za-z]$/.test(h)) out.add(h);
  }
  return [...out];
}

export function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Parse identifyScript output. Remotes are left raw; identifyFolder normalizes them. */
export function parseIdentify(stdout: string, path: string): FolderProbe {
  const lines = stdout.split('\n');
  const status = lines.find((l) => l.startsWith(MARK))?.slice(MARK.length).trim();
  const roots: string[] = [];
  const raw: string[] = [];
  const kv: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf('=');
    if (i <= 0) continue;
    const k = l.slice(0, i);
    const v = l.slice(i + 1).trim();
    if (k === 'root') {
      if (v) roots.push(v);
    } else if (k === 'remote') {
      // a token in an https remote is dropped here, before anything keeps or shows it
      if (v) raw.push(cleanRemote(v));
    } else kv[k] = v;
  }
  const exists = status === 'ok';
  const top = kv.top || undefined;
  // pwd -P resolves symlinks; the top level from git is resolved too
  const here = (kv.pwd || path).replace(/\/+$/, '');
  let rel = '';
  if (top && here !== top && here.startsWith(top + '/')) rel = here.slice(top.length + 1);
  const dirty = kv.dirty !== undefined && kv.dirty !== '' ? Number(kv.dirty) : undefined;
  return {
    path,
    exists,
    isGit: !!top,
    ...(top ? { toplevel: top } : {}),
    roots: [...new Set(roots)].sort(),
    remotes: [],
    rawRemotes: [...new Set(raw)].sort(),
    shallow: kv.shallow === 'true',
    ...(kv.head && /^[0-9a-f]{7,64}$/.test(kv.head) ? { head: kv.head } : {}),
    ...(kv.branch && kv.branch !== 'HEAD' ? { branch: kv.branch } : {}),
    name: baseName(top ?? path),
    ...(kv.pkg ? { packageName: kv.pkg } : {}),
    rel,
    ...(Number.isFinite(dirty) ? { dirty } : {}),
  };
}

/** Read the marker id from <root>/.conclave/project.json, when there is one. */
async function readMarker(machine: Machine, root: string): Promise<string | undefined> {
  try {
    const text = await machine.readText(`${root.replace(/\/+$/, '')}/.conclave/project.json`);
    const id = (JSON.parse(text) as { id?: unknown }).id;
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve SSH host aliases on the device (ssh -G prints the real hostname). */
async function resolveAliases(machine: Machine, hosts: string[]): Promise<Record<string, string>> {
  if (!hosts.length) return {};
  const script = hosts.map((h) => `printf '%s=' ${shellQuote(h)}; ssh -G ${shellQuote(h)} 2>/dev/null | sed -n 's/^hostname //p' | head -n 1; echo`).join('; ');
  try {
    const res = await machine.exec(script, { cwd: '/', timeoutMs: 5_000 });
    const out: Record<string, string> = {};
    for (const line of res.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const alias = line.slice(0, i);
      const host = line.slice(i + 1).trim();
      if (host && host !== alias) out[alias] = host;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Identify the folder at path on a machine. A missing folder gives
 * exists: false; a device that cannot be reached throws.
 */
export async function identifyFolder(machine: Machine, path: string, opts: { syncthing?: SyncthingFolder[] | null } = {}): Promise<FolderProbe> {
  const res = await machine.exec(identifyScript(path), { cwd: '/', timeoutMs: 10_000 });
  if (res.timedOut || res.aborted) throw new Error(`Reading ${path} on ${machine.name} timed out`);
  const probe = parseIdentify(res.stdout, path);
  if (!probe.exists) return probe;
  const root = probe.toplevel ?? path;
  const aliases = await resolveAliases(machine, aliasHosts(probe.rawRemotes));
  probe.remotes = [...new Set(probe.rawRemotes.map((r) => normalizeRemote(r, aliases)).filter((r): r is string => !!r))].sort();
  const marker = await readMarker(machine, root);
  if (marker) probe.marker = marker;
  const synced = opts.syncthing ? syncthingFolderFor(opts.syncthing, root) : undefined;
  if (synced) probe.syncthing = { folderId: synced.folder.id, rel: synced.rel };
  return probe;
}

/** The identity a project keeps, from one probe. */
export function identityOf(probe: FolderProbe): StoredIdentity {
  return {
    gitRoots: probe.roots,
    remotes: probe.remotes,
    shallow: probe.shallow,
    ...(probe.syncthing ? { syncthing: probe.syncthing } : {}),
    ...(probe.marker ? { marker: probe.marker } : {}),
    ...(probe.head ? { head: probe.head } : {}),
    ...(probe.rawRemotes.find((r) => !!normalizeRemote(r)) ? { cloneUrl: probe.rawRemotes.find((r) => !!normalizeRemote(r)) } : {}),
  };
}

export interface Comparison {
  level: MatchLevel;
  /** Why, for the one-line explanation. */
  reason: 'marker' | 'syncthing' | 'history-remote' | 'history' | 'head' | 'name' | 'remote-only' | 'different-history' | 'nothing';
}

/**
 * Match level between a known project and a candidate folder (2.2): exact,
 * strong, weak (ranking only), none, or mismatch. headOnTarget says whether
 * the project's last HEAD exists in the candidate (git cat-file -e), which
 * counts for shallow clones whose root is the shallow boundary.
 */
export function compareIdentity(known: ProjectIdentity, knownName: string, cand: FolderIdentity, opts: { headOnTarget?: boolean } = {}): Comparison {
  if (!cand.exists) return { level: 'none', reason: 'nothing' };
  if (known.marker && cand.marker) return known.marker === cand.marker ? { level: 'exact', reason: 'marker' } : { level: 'mismatch', reason: 'different-history' };
  if (known.syncthing && cand.syncthing && known.syncthing.folderId === cand.syncthing.folderId && known.syncthing.rel === cand.syncthing.rel) return { level: 'exact', reason: 'syncthing' };
  const kr = known.gitRoots;
  const cr = cand.roots;
  const rootsEqual = kr.length > 0 && kr.length === cr.length && kr.every((r) => cr.includes(r));
  const sharedRemote = known.remotes.some((r) => cand.remotes.includes(r));
  if (rootsEqual && sharedRemote) return { level: 'exact', reason: 'history-remote' };
  if (rootsEqual) return { level: 'strong', reason: 'history' };
  if (opts.headOnTarget) return { level: 'strong', reason: 'head' };
  const name = knownName.toLowerCase();
  const sameName = !!name && (cand.name.toLowerCase() === name || cand.packageName?.toLowerCase() === name);
  if (kr.length && cr.length) {
    // a shallow clone's root is its shallow boundary: with a shared remote that is not a mismatch
    if ((known.shallow || cand.shallow) && sharedRemote) return { level: 'weak', reason: 'remote-only' };
    return { level: 'mismatch', reason: 'different-history' };
  }
  if (sharedRemote) return { level: 'weak', reason: 'remote-only' };
  if (sameName) return { level: 'weak', reason: 'name' };
  return { level: 'none', reason: 'nothing' };
}

const LEVEL_RANK: Record<MatchLevel, number> = { exact: 4, strong: 3, weak: 2, none: 1, mismatch: 0 };

/** True when a is at least as good as b. */
export function atLeast(a: MatchLevel | undefined, b: MatchLevel): boolean {
  return !!a && LEVEL_RANK[a] >= LEVEL_RANK[b];
}

export function levelRank(l: MatchLevel): number {
  return LEVEL_RANK[l];
}

/** One line for the owner, e.g. "Same git history and remote as the arch-desktop copy". */
export function comparisonLine(c: Comparison, otherDevice: string): string {
  const copy = `the ${otherDevice} copy`;
  switch (c.reason) {
    case 'marker':
      return c.level === 'exact' ? `Same project marker as ${copy}` : `A different project marker from ${copy}`;
    case 'syncthing':
      return `Same Syncthing folder as ${copy}`;
    case 'history-remote':
      return `Same git history and remote as ${copy}`;
    case 'history':
      return `Same git history as ${copy}`;
    case 'head':
      return `Has the last commit of ${copy}`;
    case 'remote-only':
      return `Same remote as ${copy}, but the history could not be compared`;
    case 'name':
      return `Same folder name as ${copy}, nothing else to compare`;
    case 'different-history':
      return `A different git repository from ${copy}`;
    default:
      return `Nothing in common with ${copy}`;
  }
}

/** Does sha exist in the repo at path on the machine (git cat-file -e). */
export async function hasCommit(machine: Machine, path: string, sha: string | undefined): Promise<boolean> {
  if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) return false;
  try {
    const res = await machine.exec(`git -C ${shellQuote(path)} cat-file -e ${sha}^{commit} 2>/dev/null`, { cwd: '/', timeoutMs: 5_000 });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}
