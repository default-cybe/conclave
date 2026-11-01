/**
 * `conclave system-helper` (commands/system-helper.ts) in a temp folder that
 * stands for /: install writes the helper and the sudo rule with their
 * owners and modes, checks the rule with visudo before anything moves into
 * place, finds the hub's user, refuses when not root, and remove and status.
 * systemctl, apt-get and the process list are descriptions; visudo is the
 * real one when this machine has it.
 *
 *   bun test packages/cli/test/system-helper.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_HELPER_PATH, ROOT_HELPER_SUDOERS, ROOT_HELPER_TAG, rootHelperScript, sudoersRule } from '@conclave/core/system/root-helper.ts';
import { parseArgs } from '../src/args';
import { findHub, helperStatus, installHelper, isHubArgv, removeHelper, runAction, systemHelperCommand, type HelperSys } from '../src/commands/system-helper';
import { CliError } from '../src/commands/shared';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const amRoot = process.getuid?.() === 0;
const VISUDO = ['/usr/sbin/visudo', '/usr/bin/visudo', '/sbin/visudo'].find((p) => existsSync(p));

interface Unit {
  User?: string;
  ExecStart?: string;
  NoNewPrivileges?: string;
}

interface FakeOptions {
  uid?: number;
  units?: Record<string, Unit>;
  procs?: Array<{ pid: number; uid: number; argv: string[] }>;
  users?: Record<string, { uid: number; gid: number }>;
  bins?: string[];
  /** real: this machine's visudo; ok and fail: a stand-in. */
  visudo?: 'real' | 'ok' | 'fail';
  groups?: Record<string, number[]>;
}

const HUB_UNIT: Unit = { User: 'conclave', ExecStart: '{ path=/opt/conclave/bin/conclave ; argv[]=/opt/conclave/bin/conclave serve ; ignore_errors=no }' };

function fake(o: FakeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conclave-sys-'));
  dirs.push(root);
  const said: string[] = [];
  const runs: Array<{ argv: string[]; env?: Record<string, string>; inherit?: boolean }> = [];
  const bins = new Set(o.bins ?? ['sudo', 'visudo', 'systemctl', 'apt-get']);
  const users = o.users ?? { root: { uid: 0, gid: 0 }, conclave: { uid: 1000, gid: 1000 } };
  const units = o.units ?? {};
  const sys: HelperSys = {
    root,
    uid: o.uid ?? 0,
    platform: 'linux',
    pid: 1,
    run: (argv, opts = {}) => {
      runs.push({ argv, ...opts });
      const [cmd, ...rest] = argv;
      if (cmd === 'systemctl' && rest[0] === 'list-units') return { code: 0, stdout: Object.keys(units).map((u) => `${u} loaded active running x`).join('\n'), stderr: '' };
      if (cmd === 'systemctl' && rest[0] === 'show') {
        const u = units[rest[1]];
        if (!u) return { code: 0, stdout: 'LoadState=not-found\nUser=\nExecStart=\nNoNewPrivileges=no\n', stderr: '' };
        return { code: 0, stdout: `LoadState=loaded\nUser=${u.User ?? ''}\nExecStart=${u.ExecStart ?? ''}\nNoNewPrivileges=${u.NoNewPrivileges ?? 'no'}\n`, stderr: '' };
      }
      if (cmd === 'visudo') {
        if (o.visudo === 'fail') return { code: 1, stdout: '', stderr: '>>> conclave: syntax error near line 3 <<<' };
        if (o.visudo === 'real' && VISUDO) {
          const r = spawnSync(VISUDO, rest, { encoding: 'utf8' });
          return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        }
        return { code: 0, stdout: 'parsed OK', stderr: '' };
      }
      if (cmd === 'apt-get') {
        if (rest.includes('sudo')) {
          bins.add('sudo');
          bins.add('visudo');
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'id' && rest[0] === '-G') return { code: 0, stdout: (o.groups?.[rest[1]] ?? [users[rest[1]]?.gid ?? 0]).join(' '), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    which: (bin) => (bins.has(bin) ? `/usr/bin/${bin}` : undefined),
    chown: (path, uid, gid) => {
      if (amRoot) chownSync(path, uid, gid);
    },
    passwd: (name) => users[name],
    nameOf: (uid) => Object.entries(users).find(([, u]) => u.uid === uid)?.[0],
    procs: () => o.procs ?? [],
    say: (line) => said.push(line),
  };
  return { sys, root, said, runs, out: () => said.join('\n') };
}

const mode = (path: string) => statSync(path).mode & 0o7777;
/** Every file under a folder, for "nothing was left behind". */
function files(dir: string): string[] {
  const outList: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else outList.push(p.slice(dir.length));
    }
  };
  if (existsSync(dir)) walk(dir);
  return outList.sort();
}

describe('system-helper install', () => {
  test('writes the helper root:root 0755 and the rule 0440, the rule checked with visudo first', () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT } });
    expect(installHelper(f.sys)).toBe(0);
    const helper = join(f.root, ROOT_HELPER_PATH);
    const rule = join(f.root, ROOT_HELPER_SUDOERS);
    expect(readFileSync(helper, 'utf8')).toBe(rootHelperScript());
    expect(mode(helper)).toBe(0o755);
    expect(readFileSync(rule, 'utf8')).toBe(sudoersRule('conclave'));
    expect(readFileSync(rule, 'utf8')).toContain('conclave ALL=(root) NOPASSWD: /usr/local/libexec/conclave-root-helper browser-deps');
    expect(mode(rule)).toBe(0o440);
    expect(mode(join(f.root, '/usr/local/libexec'))).toBe(0o755);
    if (amRoot) {
      expect(statSync(helper).uid).toBe(0);
      expect(statSync(helper).gid).toBe(0);
      expect(statSync(rule).uid).toBe(0);
    }
    // visudo saw the rule under a name sudo ignores, before it moved into place
    const check = f.runs.find((r) => r.argv[0] === 'visudo');
    expect(check?.argv).toEqual(['visudo', '-cf', join(f.root, '/etc/sudoers.d/.conclave.new')]);
    expect(files(f.root)).toEqual([ROOT_HELPER_SUDOERS, ROOT_HELPER_PATH].sort());
    expect(f.out()).toContain('The hub runs as conclave (its service conclave-hub).');
    expect(f.out()).toContain('It runs: sudo /usr/local/libexec/conclave-root-helper browser-deps');
  });

  test.if(!!VISUDO && amRoot)("this machine's visudo accepts the rule", () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT }, visudo: 'real' });
    expect(installHelper(f.sys)).toBe(0);
    expect(existsSync(join(f.root, ROOT_HELPER_SUDOERS))).toBe(true);
  });

  test('a rule visudo refuses changes nothing', () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT }, visudo: 'fail' });
    expect(() => installHelper(f.sys)).toThrow(/visudo did not accept the sudo rule, so nothing was changed/);
    expect(files(f.root)).toEqual([]);
  });

  test('refuses when not root, and writes nothing', () => {
    const f = fake({ uid: 1000, units: { 'conclave-hub.service': HUB_UNIT } });
    const err = (() => {
      try {
        installHelper(f.sys);
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect(err!.message).toContain('needs root');
    expect(err!.message).toContain('inside the container, not on the Proxmox host');
    expect(files(f.root)).toEqual([]);
  });

  test("not root behind setup.sh's older conclave command: names the binary to run as root", () => {
    const f = fake({ uid: 1000 });
    mkdirSync(join(f.root, 'usr/local/bin'), { recursive: true });
    mkdirSync(join(f.root, 'opt/conclave/bin'), { recursive: true });
    writeFileSync(join(f.root, 'usr/local/bin/conclave'), '#!/bin/sh\nexec runuser -u conclave -- /opt/conclave/bin/conclave "$@"\n');
    writeFileSync(join(f.root, 'opt/conclave/bin/conclave'), '');
    expect(() => installHelper(f.sys)).toThrow('run /opt/conclave/bin/conclave system-helper install instead');
  });

  test('a folder on the way that others can write is refused', () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT } });
    mkdirSync(join(f.root, 'usr/local/libexec'), { recursive: true, mode: 0o755 });
    spawnSync('chmod', ['0777', join(f.root, 'usr/local/libexec')]);
    // as root the first folder refused is the 0777 one; without root (CI) every folder made here is the runner's, so an earlier one is refused
    expect(() => installHelper(f.sys)).toThrow(amRoot ? "/usr/local/libexec is not root's alone" : "is not root's alone");
    expect(existsSync(join(f.root, ROOT_HELPER_PATH))).toBe(false);
  });

  test.if(amRoot)("a folder the hub's group can write is refused", () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT }, groups: { conclave: [1000, 50] } });
    mkdirSync(join(f.root, 'usr/local'), { recursive: true });
    chownSync(join(f.root, 'usr/local'), 0, 50);
    spawnSync('chmod', ['2775', join(f.root, 'usr/local')]);
    expect(() => installHelper(f.sys)).toThrow('writable by group 50, and conclave is in it');
  });

  test('--dry-run prints both files and writes nothing', () => {
    const f = fake({ uid: 1000, units: { 'conclave-hub.service': HUB_UNIT } });
    expect(installHelper(f.sys, { dryRun: true })).toBe(0);
    expect(f.out()).toContain(rootHelperScript());
    expect(f.out()).toContain(sudoersRule('conclave'));
    expect(files(f.root)).toEqual([]);
  });

  test('installs sudo with apt-get when it is missing', () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT }, bins: ['systemctl', 'apt-get'] });
    expect(installHelper(f.sys)).toBe(0);
    const apt = f.runs.find((r) => r.argv[0] === 'apt-get');
    expect(apt?.argv).toEqual(['apt-get', 'install', '-y', '-q', '--no-install-recommends', 'sudo']);
    expect(apt?.env).toEqual({ DEBIAN_FRONTEND: 'noninteractive' });
    const none = fake({ units: { 'conclave-hub.service': HUB_UNIT }, bins: ['systemctl'] });
    expect(() => installHelper(none.sys)).toThrow('sudo is not installed');
  });

  test('a hub that runs as root gets the helper and no sudo rule', () => {
    const f = fake({ units: { 'conclave-hub.service': { ExecStart: HUB_UNIT.ExecStart } } });
    expect(installHelper(f.sys)).toBe(0);
    expect(existsSync(join(f.root, ROOT_HELPER_PATH))).toBe(true);
    expect(existsSync(join(f.root, ROOT_HELPER_SUDOERS))).toBe(false);
    expect(f.out()).toContain('needs no sudo rule');
  });

  test('says when the service sets NoNewPrivileges, which stops sudo', () => {
    const f = fake({ units: { 'conclave-hub.service': { ...HUB_UNIT, NoNewPrivileges: 'yes' } } });
    expect(installHelper(f.sys)).toBe(0);
    expect(f.out()).toContain('conclave-hub.service sets NoNewPrivileges');
  });
});

describe("the hub's user", () => {
  test('from its service, else a running conclave serve, else the conclave user', () => {
    expect(findHub(fake({ units: { 'conclave-hub.service': HUB_UNIT } }).sys)).toMatchObject({ user: 'conclave', via: 'its service conclave-hub' });
    // another unit that runs conclave serve; the updater is never the hub
    const other = fake({ units: { 'conclave-update.service': { User: '' }, 'conclave-mine.service': { User: 'kai', ExecStart: '{ argv[]=/home/kai/.local/bin/conclave serve }' } }, users: { kai: { uid: 1001, gid: 1001 } } });
    expect(findHub(other.sys)).toMatchObject({ user: 'kai', via: 'its service conclave-mine' });
    const proc = fake({ bins: [], users: { kai: { uid: 1001, gid: 1001 } }, procs: [{ pid: 7, uid: 1001, argv: ['/usr/bin/vim'] }, { pid: 4242, uid: 1001, argv: ['/home/kai/.local/bin/conclave', 'serve', '--port', '7717'] }] });
    expect(findHub(proc.sys)).toEqual({ user: 'kai', via: 'a running conclave serve, pid 4242' });
    expect(findHub(fake({ bins: [] }).sys)).toEqual({ user: 'conclave', via: 'the conclave user' });
    expect(findHub(fake({ bins: [], users: {} }).sys)).toBeUndefined();
  });

  test('install refuses a user it cannot find or sudo cannot take; --user picks one', async () => {
    expect(() => installHelper(fake({ bins: ['sudo', 'visudo'], users: {} }).sys)).toThrow("Could not find the hub's user");
    expect(() => installHelper(fake().sys, { user: 'ALL' })).toThrow('not a user name sudo can take');
    expect(() => installHelper(fake().sys, { user: 'ghost' })).toThrow('There is no user ghost');
    const f = fake({ users: { root: { uid: 0, gid: 0 }, kai: { uid: 1001, gid: 1001 } } });
    expect(await systemHelperCommand(parseArgs(['system-helper', 'install', '--user', 'kai']), f.sys)).toBe(0);
    expect(readFileSync(join(f.root, ROOT_HELPER_SUDOERS), 'utf8')).toContain('kai ALL=(root) NOPASSWD: /usr/local/libexec/conclave-root-helper browser-deps');
  });

  test('isHubArgv', () => {
    expect(isHubArgv(['/opt/conclave/bin/conclave', 'serve'])).toBe(true);
    expect(isHubArgv(['/usr/local/bin/bun', '/opt/conclave/src/packages/cli/src/index.ts', 'serve'])).toBe(true);
    expect(isHubArgv(['conclave', 'daemon'])).toBe(false);
    expect(isHubArgv(['/usr/bin/serve'])).toBe(false);
  });
});

describe('system-helper remove, status and run', () => {
  test('remove takes both files out, rule first; again says there is nothing', () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT } });
    installHelper(f.sys);
    f.said.length = 0;
    expect(removeHelper(f.sys)).toBe(0);
    expect(f.said.slice(0, 2)).toEqual([`Removed ${ROOT_HELPER_SUDOERS}`, `Removed ${ROOT_HELPER_PATH}`]);
    expect(files(f.root)).toEqual([]);
    f.said.length = 0;
    removeHelper(f.sys);
    expect(f.out()).toContain('Nothing to remove');
    expect(() => removeHelper(fake({ uid: 1000 }).sys)).toThrow('needs root');
  });

  // installing needs root-owned folders on the way, which only root can make
  test.if(amRoot)('status: not installed, then installed with its rule and the hub', () => {
    const f = fake({ units: { 'conclave-hub.service': HUB_UNIT } });
    expect(helperStatus(f.sys)).toBe(1);
    expect(f.out()).toContain('not installed');
    installHelper(f.sys);
    f.said.length = 0;
    expect(helperStatus(f.sys)).toBe(0);
    expect(f.out()).toMatch(/Helper\s+\/usr\/local\/libexec\/conclave-root-helper, version 1, actions browser-deps/);
    expect(f.out()).toMatch(/Sudo rule\s+\/etc\/sudoers\.d\/conclave: conclave/);
    expect(f.out()).toMatch(/The hub\s+runs as conclave \(its service conclave-hub\)/);
  });

  test('run takes only a known action, as root, with this Conclave\'s script', () => {
    const f = fake();
    expect(() => runAction(f.sys, 'install-everything')).toThrow('takes one action: browser-deps');
    expect(() => runAction(f.sys, undefined)).toThrow('takes one action');
    expect(() => runAction(fake({ uid: 1000 }).sys, 'browser-deps')).toThrow('needs root');
    expect(runAction(f.sys, 'browser-deps')).toBe(0);
    expect(f.runs.at(-1)).toEqual({ argv: ['sh', '-c', rootHelperScript(), ROOT_HELPER_TAG, 'browser-deps'], inherit: true });
  });
});
