/**
 * `conclave system-helper`: the root helper, the one way the hub gets
 * something done as root (docs/DESIGN.md, The root helper).
 *
 *   conclave system-helper install [--user NAME] [--dry-run]   as root, once
 *   conclave system-helper remove                              as root
 *   conclave system-helper status
 *   conclave system-helper run browser-deps                    as root: run one action now
 *
 * install writes the helper (core/system/root-helper.ts has its text) to
 * /usr/local/libexec/conclave-root-helper, root:root 0755, and a sudoers
 * drop-in, /etc/sudoers.d/conclave, 0440, that lets the hub's user run it
 * with its fixed action names and nothing else. The drop-in is checked with
 * `visudo -cf` before it moves into place. It finds the hub's user from its
 * systemd service, else a running `conclave serve`, else the conclave user.
 *
 * Every file operation goes through HelperSys, so tests run it in a temp
 * folder as if it were /.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  helperActions,
  helperVersion,
  ROOT_HELPER_ACTIONS,
  ROOT_HELPER_PATH,
  ROOT_HELPER_SUDOERS,
  ROOT_HELPER_TAG,
  ROOT_HELPER_VERSION,
  rootHelperLine,
  rootHelperScript,
  sudoersRule,
  validUserName,
  type RootHelperAction,
} from '@conclave/core/system/root-helper.ts';
import { out as p } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { CliError, print } from './shared';

export interface HelperSys {
  /** Prefix for every path: '' on the machine itself, a temp folder in tests. */
  root: string;
  uid: number;
  platform: string;
  /** This process, left out when looking for the hub. */
  pid: number;
  /** Run a program and wait. inherit: its output goes to the terminal. */
  run(argv: string[], opts?: { env?: Record<string, string>; inherit?: boolean }): { code: number; stdout: string; stderr: string };
  /** The program's path on root's PATH, or undefined. */
  which(bin: string): string | undefined;
  chown(path: string, uid: number, gid: number): void;
  /** A user's uid and gid (getent passwd). */
  passwd(name: string): { uid: number; gid: number } | undefined;
  /** The name of a uid. */
  nameOf(uid: number): string | undefined;
  /** The machine's processes: pid, real uid, argv. */
  procs(): Array<{ pid: number; uid: number; argv: string[] }>;
  say(line: string): void;
}

const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function realSys(): HelperSys {
  const run: HelperSys['run'] = (argv, opts = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      env: { ...process.env, ...opts.env },
      stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      timeout: opts.inherit ? undefined : 30_000,
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
  };
  const getent = (key: string) => {
    const r = run(['getent', 'passwd', key]);
    if (r.code !== 0) return undefined;
    const f = r.stdout.trim().split('\n')[0]?.split(':') ?? [];
    return f.length >= 4 ? { name: f[0], uid: Number(f[2]), gid: Number(f[3]) } : undefined;
  };
  return {
    root: '',
    uid: process.getuid?.() ?? -1,
    platform: process.platform,
    pid: process.pid,
    run,
    which: (bin) => Bun.which(bin, { PATH: `${process.env.PATH ?? ''}:${ROOT_PATH}` }) ?? undefined,
    chown: (path, uid, gid) => chownSync(path, uid, gid),
    passwd: (name) => {
      const e = getent(name);
      return e ? { uid: e.uid, gid: e.gid } : undefined;
    },
    nameOf: (uid) => getent(String(uid))?.name,
    procs: () => {
      const outList: Array<{ pid: number; uid: number; argv: string[] }> = [];
      let names: string[] = [];
      try {
        names = readdirSync('/proc');
      } catch {
        return outList;
      }
      for (const n of names) {
        if (!/^\d+$/.test(n)) continue;
        try {
          const argv = readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean);
          const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${n}/status`, 'utf8'))?.[1] ?? -1);
          if (argv.length) outList.push({ pid: Number(n), uid, argv });
        } catch {
          /* gone */
        }
      }
      return outList;
    },
    say: (line) => print(line),
  };
}

// ---------------------------------------------------------------------------
// The hub's user
// ---------------------------------------------------------------------------

export interface HubFound {
  user: string;
  /** How it was found, for the output. */
  via: string;
  unit?: string;
  /** The service sets NoNewPrivileges, which stops sudo. */
  noNewPrivs?: boolean;
}

/** argv of a running hub: conclave serve, or bun .../packages/cli/src/index.ts serve. */
export function isHubArgv(argv: string[]): boolean {
  const i = argv.findIndex((a) => /(^|\/)conclave$/.test(a) || /packages\/cli\/src\/index\.ts$/.test(a));
  return i >= 0 && argv[i + 1] === 'serve';
}

function props(text: string): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) outMap[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return outMap;
}

/** The hub's user: its systemd service, else a running conclave serve, else the conclave user. */
export function findHub(sys: HelperSys): HubFound | undefined {
  if (sys.which('systemctl')) {
    const units = new Set(['conclave-hub.service']);
    const list = sys.run(['systemctl', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', 'conclave*']);
    for (const line of list.stdout.split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (name?.endsWith('.service')) units.add(name);
    }
    for (const unit of units) {
      // the updater runs as root on purpose; it is not the hub
      if (unit === 'conclave-update.service') continue;
      const pr = props(sys.run(['systemctl', 'show', unit, '-p', 'LoadState', '-p', 'User', '-p', 'ExecStart', '-p', 'NoNewPrivileges']).stdout);
      if (pr.LoadState !== 'loaded') continue;
      if (unit !== 'conclave-hub.service' && !/\bserve\b/.test(pr.ExecStart ?? '')) continue;
      return { user: pr.User || 'root', via: `its service ${unit.replace(/\.service$/, '')}`, unit, ...(pr.NoNewPrivileges === 'yes' ? { noNewPrivs: true } : {}) };
    }
  }
  for (const pr of sys.procs()) {
    if (pr.pid === sys.pid || !isHubArgv(pr.argv)) continue;
    const name = sys.nameOf(pr.uid);
    if (name) return { user: name, via: `a running conclave serve, pid ${pr.pid}` };
  }
  if (sys.passwd('conclave')) return { user: 'conclave', via: 'the conclave user' };
  return undefined;
}

// ---------------------------------------------------------------------------
// install, remove, status, run
// ---------------------------------------------------------------------------

const at = (sys: HelperSys, path: string) => `${sys.root}${path}`;

function needRoot(sys: HelperSys, what: string): void {
  if (sys.platform !== 'linux') throw new CliError('The root helper is for Linux hubs.');
  if (sys.uid === 0) return;
  let hint = '';
  // setup.sh's conclave command from before system-helper switches to the conclave user, even for root
  try {
    const wrapper = readFileSync(at(sys, '/usr/local/bin/conclave'), 'utf8');
    if (/runuser/.test(wrapper) && !/system-helper/.test(wrapper) && existsSync(at(sys, '/opt/conclave/bin/conclave'))) hint = ` If you are root: the conclave command here runs as the conclave user, so run /opt/conclave/bin/conclave system-helper ${what} instead.`;
  } catch {
    /* no setup.sh wrapper */
  }
  throw new CliError(`system-helper ${what} needs root. Run it as root on the hub's machine; for a hub in a container, inside the container, not on the Proxmox host.${hint}`);
}

/** A folder on the way to a root-run file must be root's: whoever can write it could swap the file. */
function checkDir(sys: HelperSys, dir: string, hubUser: string | undefined): void {
  const path = at(sys, dir);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o755 });
    chmodSync(path, 0o755);
    sys.chown(path, 0, 0);
    return;
  }
  const st = statSync(path);
  const mode = (st.mode & 0o7777).toString(8);
  if (st.uid !== 0 || st.mode & 0o002) throw new CliError(`${dir} is not root's alone (owner uid ${st.uid}, mode ${mode}). Anyone who can write it could swap the helper. Fix that first, then run this again.`);
  if (st.mode & 0o020 && st.gid !== 0 && hubUser) {
    const groups = sys.run(['id', '-G', hubUser]).stdout.trim().split(/\s+/).map(Number);
    if (groups.includes(st.gid)) throw new CliError(`${dir} is writable by group ${st.gid}, and ${hubUser} is in it, so the hub could swap the helper. Run chmod g-w ${dir} first.`);
  }
}

/**
 * Write a root file with its mode under a temp name in the same folder (a
 * name sudo ignores: it has a dot), check it, and give back a function that
 * moves it into place. Nothing is in place until that runs.
 */
function stageRootFile(sys: HelperSys, path: string, text: string, mode: number, check?: (tmp: string) => void): { commit(): void; drop(): void } {
  const final = at(sys, path);
  const tmp = join(dirname(final), `.${path.split('/').pop()}.new`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600 });
  const drop = () => rmSync(tmp, { force: true });
  try {
    sys.chown(tmp, 0, 0);
    chmodSync(tmp, mode);
    check?.(tmp);
  } catch (err) {
    drop();
    throw err;
  }
  return { commit: () => renameSync(tmp, final), drop };
}

export interface InstallOptions {
  user?: string;
  dryRun?: boolean;
}

export function installHelper(sys: HelperSys, o: InstallOptions = {}): number {
  if (!o.dryRun) needRoot(sys, 'install');
  else if (sys.platform !== 'linux') throw new CliError('The root helper is for Linux hubs.');
  const hub: HubFound | undefined = o.user ? { user: o.user, via: 'given with --user' } : findHub(sys);
  if (!hub) throw new CliError("Could not find the hub's user: no conclave service, no running conclave serve and no conclave user. Run it again with --user NAME.");
  if (!validUserName(hub.user)) throw new CliError(`"${hub.user}" is not a user name sudo can take.`);
  if (!sys.passwd(hub.user)) throw new CliError(`There is no user ${hub.user} on this machine.`);
  const asRoot = hub.user === 'root';
  const script = rootHelperScript();
  const rule = asRoot ? undefined : sudoersRule(hub.user);
  sys.say(`The hub runs as ${hub.user} (${hub.via}).`);

  if (o.dryRun) {
    sys.say('');
    sys.say(`Would write ${ROOT_HELPER_PATH}, root:root 0755:`);
    sys.say(script);
    if (rule) {
      sys.say(`Would write ${ROOT_HELPER_SUDOERS}, root:root 0440, after visudo -cf accepts it:`);
      sys.say(rule);
    }
    return 0;
  }

  if (rule && !sys.which('sudo')) {
    if (!sys.which('apt-get')) throw new CliError('sudo is not installed. Install it with the system\'s package manager, then run this again.');
    sys.say('Installing sudo');
    const env = { DEBIAN_FRONTEND: 'noninteractive' };
    const install = ['apt-get', 'install', '-y', '-q', '--no-install-recommends', 'sudo'];
    let r = sys.run(install, { env });
    if (r.code !== 0) {
      sys.run(['apt-get', 'update', '-q'], { env });
      r = sys.run(install, { env });
    }
    if (r.code !== 0) throw new CliError(`apt-get could not install sudo:\n${(r.stderr || r.stdout).trim()}`);
  }
  if (rule && !sys.which('visudo')) throw new CliError('visudo is missing, so the sudo rule cannot be checked. Install sudo, then run this again.');

  for (const d of ['/usr', '/usr/local', '/usr/local/libexec']) checkDir(sys, d, asRoot ? undefined : hub.user);
  if (rule) for (const d of ['/etc', '/etc/sudoers.d']) checkDir(sys, d, hub.user);
  // the rule is checked before anything moves into place: a rule visudo refuses changes nothing
  const ruleFile = rule
    ? stageRootFile(sys, ROOT_HELPER_SUDOERS, rule, 0o440, (tmp) => {
        const r = sys.run(['visudo', '-cf', tmp]);
        if (r.code !== 0) throw new CliError(`visudo did not accept the sudo rule, so nothing was changed:\n${(r.stderr || r.stdout).trim()}`);
      })
    : undefined;
  try {
    stageRootFile(sys, ROOT_HELPER_PATH, script, 0o755).commit();
  } catch (err) {
    ruleFile?.drop();
    throw err;
  }
  sys.say(`Wrote ${ROOT_HELPER_PATH} (root, 0755). It takes one action: ${ROOT_HELPER_ACTIONS.join(', ')}.`);

  if (rule && ruleFile) {
    ruleFile.commit();
    if (!sys.root) {
      // the whole configuration, with the new file in it
      const all = sys.run(['visudo', '-c']);
      if (all.code !== 0) {
        rmSync(at(sys, ROOT_HELPER_SUDOERS), { force: true });
        throw new CliError(`sudo's configuration does not check out with the rule, so the rule was taken out again:\n${(all.stderr || all.stdout).trim()}`);
      }
    }
    sys.say(`Wrote ${ROOT_HELPER_SUDOERS} (root, 0440, checked with visudo): ${hub.user} may run the helper without a password.`);
    try {
      const main = readFileSync(at(sys, '/etc/sudoers'), 'utf8');
      if (!/^\s*[@#]includedir\s+\/etc\/sudoers\.d\b/m.test(main)) sys.say(p.yellow('/etc/sudoers does not read /etc/sudoers.d. Add this line to it with visudo: @includedir /etc/sudoers.d'));
    } catch {
      /* no /etc/sudoers to read (a test folder) */
    }
    if (!sys.root) {
      const ok = sys.run(['sudo', '-n', '-l', '-U', hub.user, ROOT_HELPER_PATH, ROOT_HELPER_ACTIONS[0]]).code === 0;
      if (!ok) sys.say(p.yellow(`sudo -l does not list the rule for ${hub.user}. Check /etc/sudoers.`));
    }
  } else sys.say('The hub runs as root, so it needs no sudo rule: it runs the helper itself.');
  if (hub.noNewPrivs) sys.say(p.yellow(`${hub.unit} sets NoNewPrivileges, which stops sudo. Remove it (systemctl edit ${hub.unit}) and restart the hub.`));

  sys.say('');
  sys.say(`Done. The hub can now install the system packages it needs by itself, such as the browser's libraries (Settings, Browser). It runs: ${rootHelperLine(ROOT_HELPER_ACTIONS[0], { asRoot })}`);
  sys.say('To take it out again: conclave system-helper remove');
  return 0;
}

export function removeHelper(sys: HelperSys): number {
  needRoot(sys, 'remove');
  const gone: string[] = [];
  // the rule first, so sudo stops at once
  for (const f of [ROOT_HELPER_SUDOERS, '/etc/sudoers.d/.conclave.new', ROOT_HELPER_PATH, '/usr/local/libexec/.conclave-root-helper.new']) {
    const path = at(sys, f);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    if (!f.includes('/.')) gone.push(f);
  }
  if (!gone.length) {
    sys.say('Nothing to remove: the root helper is not installed.');
    return 0;
  }
  for (const f of gone) sys.say(`Removed ${f}`);
  sys.say('sudo stays installed, and so do the packages the helper added.');
  return 0;
}

export function helperStatus(sys: HelperSys): number {
  const helperPath = at(sys, ROOT_HELPER_PATH);
  const rows: Array<[string, string]> = [];
  let ok = true;
  let st: Stats | undefined;
  try {
    st = statSync(helperPath);
  } catch {
    st = undefined;
  }
  if (!st) {
    sys.say(`The root helper is not installed. As root on the hub's machine: conclave system-helper install`);
    return 1;
  }
  const text = readFileSync(helperPath, 'utf8');
  const same = text === rootHelperScript();
  const v = helperVersion(text);
  const safe = st.uid === 0 && (Number(st.mode) & 0o022) === 0;
  if (!safe) ok = false;
  rows.push([
    'Helper',
    `${ROOT_HELPER_PATH}, version ${v ?? '?'}, actions ${helperActions(text).join(', ') || 'none'}${same ? '' : (v ?? 0) < ROOT_HELPER_VERSION ? ', older than this Conclave: install again to update it' : ', not the one this Conclave writes'}${safe ? '' : `, NOT root's alone (owner uid ${st.uid}, mode ${(Number(st.mode) & 0o7777).toString(8)})`}`,
  ]);
  const sudoersPath = at(sys, ROOT_HELPER_SUDOERS);
  if (existsSync(sudoersPath)) {
    let users = '';
    try {
      users = [...readFileSync(sudoersPath, 'utf8').matchAll(/^([A-Za-z_][\w.-]*)\s+ALL=/gm)].map((m) => m[1]).join(', ');
    } catch {
      users = '(only root can read it)';
    }
    rows.push(['Sudo rule', `${ROOT_HELPER_SUDOERS}${users ? `: ${users}` : ''}`]);
  } else rows.push(['Sudo rule', 'none']);
  const sudo = sys.which('sudo');
  rows.push(['sudo', sudo ?? 'not installed']);
  const hub = findHub(sys);
  rows.push(['The hub', hub ? `runs as ${hub.user} (${hub.via})` : 'not found']);
  if (hub && hub.user !== 'root') {
    if (!existsSync(sudoersPath) || !sudo) ok = false;
    else if (sys.uid === 0 && !sys.root) {
      const allowed = sys.run(['sudo', '-n', '-l', '-U', hub.user, ROOT_HELPER_PATH, ROOT_HELPER_ACTIONS[0]]).code === 0;
      if (!allowed) ok = false;
      rows.push(['Allowed', allowed ? `yes: ${hub.user} may run ${rootHelperLine(ROOT_HELPER_ACTIONS[0])}` : `no: sudo does not let ${hub.user} run it`]);
    }
  }
  if (hub?.noNewPrivs) {
    ok = false;
    rows.push(['Problem', `${hub.unit} sets NoNewPrivileges, which stops sudo`]);
  }
  const w = Math.max(...rows.map(([k]) => k.length)) + 2;
  for (const [k, val] of rows) sys.say(`${k.padEnd(w)}${val}`);
  if (!ok) sys.say(p.yellow('Run conclave system-helper install again as root to fix it.'));
  return ok ? 0 : 1;
}

export function runAction(sys: HelperSys, action: string | undefined): number {
  if (!action || !(ROOT_HELPER_ACTIONS as readonly string[]).includes(action)) throw new CliError(`system-helper run takes one action: ${ROOT_HELPER_ACTIONS.join(', ')}`);
  needRoot(sys, `run ${action}`);
  // this Conclave's own helper, whether or not one is installed
  return sys.run(['sh', '-c', rootHelperScript(), ROOT_HELPER_TAG, action as RootHelperAction], { inherit: true }).code;
}

export async function systemHelperCommand(args: ParsedArgs, sys: HelperSys = realSys()): Promise<number> {
  const sub = args._[1] ?? 'status';
  switch (sub) {
    case 'install': {
      const user = str(args, 'user');
      return installHelper(sys, { ...(user ? { user } : {}), dryRun: bool(args, 'dry-run') });
    }
    case 'remove':
    case 'uninstall':
      return removeHelper(sys);
    case 'status':
      return helperStatus(sys);
    case 'run':
      return runAction(sys, args._[2]);
    default:
      throw new CliError(`Unknown system-helper command "${sub}". Try: conclave system-helper install, remove, status or run browser-deps`);
  }
}
