/**
 * Folders on the hub that sessions never touch: the hub's own CLIProxyAPI
 * (its config with the client key, and the auth folder with every signed in
 * account's tokens), and the hub's secrets.json (provider keys, the GitHub
 * token). Each member's own CLIProxyAPI (<home>/accounts/<id>/cliproxy) and
 * own secrets file (<home>/accounts/<id>/secrets.json) are the same, for
 * every session, the owner's too (docs/design/ACCOUNTS.md 12). The hub
 * reads and writes them with node:fs itself; LocalMachine, which every
 * built-in tool goes through, refuses them.
 *
 * Tools run as the same user as the hub, so this is a guard against a
 * model reading them by accident or because a web page told it to, not a
 * wall: a shell script can still get there. The folder is mode 0700 against
 * other users, and the management key never sits in a file at all (the
 * config holds only its bcrypt hash).
 */
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { conclaveHome } from '../config/paths';

const marked = new Set<string>();
const homes = new Set<string>();

function clean(p: string): string {
  const n = normalize(resolve(p));
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/** The hub's homes: CONCLAVE_HOME, and the one the hub said it runs in (tests move it). */
function hubHomes(): string[] {
  return [...new Set([clean(conclaveHome()), ...homes])];
}

/** Under a member's folder: their own CLIProxyAPI and their own secrets file. */
const ACCOUNT_PRIVATE = ['cliproxy', 'secrets.json'];

/** <home>/accounts/<id>/cliproxy and <home>/accounts/<id>/secrets.json for each account folder there now. */
function accountPrivate(): string[] {
  const out: string[] = [];
  for (const h of hubHomes()) {
    let ids: string[];
    try {
      ids = readdirSync(join(h, 'accounts'));
    } catch {
      continue;
    }
    for (const id of ids) for (const name of ACCOUNT_PRIVATE) out.push(join(h, 'accounts', id, name));
  }
  return out;
}

/** True for <home>/accounts/<id>/cliproxy (and inside it) or <home>/accounts/<id>/secrets.json, also before that folder exists. */
function inAccountPrivate(p: string): boolean {
  for (const h of hubHomes()) {
    if (!p.startsWith(h + sep)) continue;
    const parts = p.slice(h.length + 1).split(sep);
    if (parts.length >= 3 && parts[0] === 'accounts' && parts[1] && ACCOUNT_PRIVATE.includes(parts[2]) && (parts[2] === 'cliproxy' || parts.length === 3)) return true;
  }
  return false;
}

/** The hub's private folders and files: <home>/cliproxy, <home>/secrets.json, each account's own CLIProxyAPI and secrets file, plus any the hub marked. */
export function hubPrivateDirs(): string[] {
  return [...new Set([clean(join(conclaveHome(), 'cliproxy')), clean(join(conclaveHome(), 'secrets.json')), ...accountPrivate(), ...marked])];
}

/** Add a folder or a file (the hub calls this with its real home, which tests move). */
export function markHubPrivate(dir: string): void {
  marked.add(clean(dir));
}

/** The home the hub runs in: every account's own CLIProxyAPI and secrets file under it is private (tests move the home). */
export function markHubHome(home: string): void {
  homes.add(clean(home));
}

/** True when a line of grep output (path:line:text, path-line-text) or a path is inside a private folder or is a private file. */
export function startsWithPrivate(line: string, dirs = hubPrivateDirs()): boolean {
  return dirs.some((d) => line.startsWith(d) && (line.length === d.length || line[d.length] === sep || line[d.length] === ':' || line[d.length] === '-'));
}

function within(p: string, dirs: string[]): boolean {
  return dirs.some((d) => p === d || p.startsWith(d + sep));
}

/** The real path of p, or of its nearest existing parent with the rest added back. */
function real(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
      cur = up;
    }
  }
  return p;
}

/** True when an absolute path is inside a private folder, following symlinks. */
export function isHubPrivatePath(path: string): boolean {
  const dirs = hubPrivateDirs();
  const p = clean(path);
  if (within(p, dirs) || inAccountPrivate(p)) return true;
  const r = clean(real(p));
  return r !== p && (within(r, dirs.map((d) => clean(real(d)))) || inAccountPrivate(r));
}

export const PRIVATE_REFUSAL = 'Refused: that folder holds the hub\'s subscription sign-ins (CLIProxyAPI). Sessions cannot read or change it. Settings > Models > Subscriptions shows the accounts.';
export const SECRETS_REFUSAL = 'Refused: that file holds the hub\'s keys and tokens. Sessions cannot read or change it. Settings shows which keys are set.';

/** The refusal for a path or a command: the secrets file has its own words. */
export function privateRefusal(pathOrCommand: string): string {
  return pathOrCommand.includes('secrets.json') ? SECRETS_REFUSAL : PRIVATE_REFUSAL;
}

/** Throw when a tool asks for a private path. */
export function assertNotHubPrivate(path: string): void {
  if (isHubPrivatePath(path)) throw Object.assign(new Error(privateRefusal(path)), { code: 'EACCES' });
}

/**
 * True when a shell command names a private folder or file: by its path, its
 * ~/.conclave, $HOME or $CONCLAVE_HOME form (quoted or not), with globs in any
 * segment, or relative to the hub home when the command's cwd is in it or the
 * command names the home (cd $CONCLAVE_HOME && cat accounts/x/secrets.json).
 */
export function commandTouchesHubPrivate(command: string, cwd?: string): boolean {
  // the shell drops quotes and backslashes before it reads a path: so does this check
  const cmd = command
    .replace(/\\(.)/g, '$1')
    .replace(/["']/g, '')
    .replace(/\$\{(CONCLAVE_HOME|HOME)\}/g, '$$$1')
    .replace(/\$HOME\//g, '~/');
  const home = clean(conclaveHome());
  const needles = new Set<string>();
  for (const d of hubPrivateDirs()) {
    needles.add(d);
    if (d.startsWith(home + sep)) needles.add(`$CONCLAVE_HOME${d.slice(home.length)}`);
  }
  needles.add('.conclave/cliproxy');
  needles.add('cliproxy/auth');
  needles.add('cliproxy/config.yaml');
  needles.add('.conclave/secrets.json');
  // saved browser logins: their list and the key that opens their passwords (browser/logins.ts)
  needles.add('.conclave/browser-logins');
  needles.add('.conclave/accounts');
  if ([...needles].some((n) => cmd.includes(n))) return true;
  return globNamed(cmd, cwd);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Private names under a hub home, by segment ('' is any account id). */
const PRIVATE_REL = [['cliproxy'], ['secrets.json'], ['browser-logins.json'], ['browser-logins.key'], ['accounts', '', 'cliproxy'], ['accounts', '', 'secrets.json']];

/** True when one path segment, maybe a glob (* ? [..] {a,b}), can be `name`. As in the shell, only a segment that starts with a dot matches a dot name. */
function segMatches(seg: string, name: string): boolean {
  if (!name) return !!seg;
  if (name.startsWith('.') && !seg.startsWith('.')) return false;
  if (!/[*?[{]/.test(seg)) return seg === name;
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    const close = c === '[' ? seg.indexOf(']', i + 2) : c === '{' ? seg.indexOf('}', i) : -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[' && close > 0) re += `[${seg.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
    else if (c === '{' && close > 0) re += `(?:${seg.slice(i + 1, close).split(',').map(esc).join('|')})`;
    else re += esc(c);
    if (close > 0 && (c === '[' || c === '{')) i = close;
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return seg === name;
  }
}

/** Segments under a hub home that reach a private name (or into one). */
function hitsPrivate(rel: string[]): boolean {
  return PRIVATE_REL.some((c) => rel.length >= c.length && c.every((name, i) => segMatches(rel[i], name)));
}

/** Segments under a hub home that lead toward a private name: the home itself, accounts, accounts/<id>. */
function leadsToPrivate(rel: string[]): boolean {
  return PRIVATE_REL.some((c) => rel.length < c.length && rel.every((s, i) => segMatches(s, c[i])));
}

/** The segments of a word under a hub home ($CONCLAVE_HOME, a hub home's path, a .conclave folder), or undefined. */
function underHome(segs: string[], homes: string[][]): string[] | undefined {
  if (segs[0] === '$CONCLAVE_HOME') return segs.slice(1);
  for (const h of homes) if (segs.length >= h.length && h.every((s, i) => (s ? segMatches(segs[i], s) : segs[i] === s))) return segs.slice(h.length);
  const i = segs.findIndex((s) => segMatches(s, '.conclave'));
  return i >= 0 ? segs.slice(i + 1) : undefined;
}

/** A command whose words, read as paths (globs included), reach a private name under a hub home, also relative to the cwd or a home folder it names. */
function globNamed(cmd: string, cwd?: string): boolean {
  const homes = hubHomes().map((h) => h.split(sep));
  const words = cmd.split(/[\s;|&<>()=`]+/).filter(Boolean);
  const bases: string[][] = [];
  if (cwd) {
    const c = clean(cwd);
    for (const h of hubHomes()) if (c === h || c.startsWith(h + sep)) bases.push(c.slice(h.length + 1).split(sep).filter(Boolean));
  }
  const relative: string[][] = [];
  for (const w of words) {
    const segs = w.split('/').filter((s, i) => (i === 0 || s) && s !== '.');
    if (!/^[/~$]/.test(w)) relative.push(segs);
    const rel = underHome(segs, homes);
    if (!rel) continue;
    if (hitsPrivate(rel)) return true;
    // cd $CONCLAVE_HOME, cd ~/.conclave/accounts: the command's relative paths may start there
    if (leadsToPrivate(rel)) bases.push(rel);
  }
  return bases.some((b) => relative.some((r) => hitsPrivate([...b, ...r])));
}
