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

/** True when a shell command names a private folder by its path, ~ form or CONCLAVE_HOME form. */
export function commandTouchesHubPrivate(command: string): boolean {
  const home = clean(conclaveHome());
  const needles = new Set<string>();
  for (const d of hubPrivateDirs()) {
    needles.add(d);
    if (d.startsWith(home + sep)) needles.add(`$CONCLAVE_HOME${d.slice(home.length)}`).add(`\${CONCLAVE_HOME}${d.slice(home.length)}`);
  }
  needles.add('.conclave/cliproxy');
  needles.add('cliproxy/auth');
  needles.add('cliproxy/config.yaml');
  needles.add('.conclave/secrets.json');
  // saved browser logins: their list and the key that opens their passwords (browser/logins.ts)
  needles.add('.conclave/browser-logins');
  if ([...needles].some((n) => command.includes(n))) return true;
  // each account's own CLIProxyAPI and secrets file, by any home form, a glob for the id included
  return accountNamed(command);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A command that names <home>/accounts/<anything>/cliproxy or .../secrets.json, or the accounts folder of ~/.conclave. */
function accountNamed(command: string): boolean {
  if (command.includes('.conclave/accounts')) return true;
  const roots = ['\\$\\{?CONCLAVE_HOME\\}?', ...hubHomes().map(esc)];
  return roots.some((r) => new RegExp(`${r}/accounts/[^\\s/]*/(?:cliproxy|secrets\\.json)`).test(command));
}
