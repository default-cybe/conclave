/**
 * `conclave daemon install | uninstall | status | unpair`: the service plans per
 * OS, PATH handling, and the whole pair, status, unpair round against a real
 * hub. Nothing here writes a real service: the CLI runs with a temp HOME and
 * install and uninstall only run with --dry-run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergePath, parseMarkedPath, pidAlive, pidFile, runSteps, servicePlan, stopByPid, windowsQuote, systemdQuote, withoutAppImage, type Step, type StepResult } from '../src/service';
import { startHub, type TestHub } from '../../server/test/helpers';

const base = { home: '/home/kai', pathEnv: '/home/kai/.local/bin:/usr/bin:/bin', logFile: '/home/kai/.conclave/logs/daemon.log', uid: 501 };

describe('service plans', () => {
  test('Linux: a systemd user unit with the PATH, restarted on start', () => {
    const plan = servicePlan({ ...base, os: 'linux', cmd: ['/home/kai/.local/share/dev.conclave.desktop/daemon/conclave', 'daemon'] });
    expect(plan.kind).toBe('systemd');
    expect(plan.file).toBe('/home/kai/.config/systemd/user/conclave-daemon.service');
    expect(plan.content).toContain('ExecStart=/home/kai/.local/share/dev.conclave.desktop/daemon/conclave daemon\n');
    expect(plan.content).toContain('Environment=PATH=/home/kai/.local/bin:/usr/bin:/bin\n');
    expect(plan.content).toContain('Restart=always');
    expect(plan.content).not.toContain('CONCLAVE_HOME');
    expect(plan.start.map((s) => s.show)).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable conclave-daemon', 'systemctl --user restart conclave-daemon']);
    expect(plan.stop.map((s) => [s.show, s.optional])).toEqual([['systemctl --user disable --now conclave-daemon', true]]);
    expect(plan.probe?.show).toBe('systemctl --user is-active --quiet conclave-daemon');
  });

  test('Linux: spaces, quotes and % survive systemd', () => {
    const plan = servicePlan({ ...base, os: 'linux', pathEnv: '/opt/my tools/bin:/usr/bin', conclaveHome: '/data/100%', cmd: ['/home/kai/My Apps/conclave', 'daemon'] });
    expect(plan.content).toContain('ExecStart="/home/kai/My Apps/conclave" daemon\n');
    expect(plan.content).toContain('Environment="PATH=/opt/my tools/bin:/usr/bin"\n');
    expect(plan.content).toContain('Environment=CONCLAVE_HOME=/data/100%%\n');
    expect(systemdQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test('macOS: a LaunchAgent, booted out and in again on start', () => {
    const plan = servicePlan({ ...base, os: 'darwin', home: '/Users/kai', cmd: ['/Users/kai/Library/Application Support/dev.conclave.desktop/daemon/conclave', 'daemon'] });
    expect(plan.kind).toBe('launchd');
    expect(plan.file).toBe('/Users/kai/Library/LaunchAgents/dev.conclave.daemon.plist');
    expect(plan.content).toContain('<string>/Users/kai/Library/Application Support/dev.conclave.desktop/daemon/conclave</string>');
    expect(plan.content).toContain('<key>PATH</key><string>/home/kai/.local/bin:/usr/bin:/bin</string>');
    expect(plan.content).toContain('<key>KeepAlive</key><true/>');
    expect(plan.start.map((s) => s.show)).toEqual(['launchctl bootout gui/501/dev.conclave.daemon', "launchctl bootstrap gui/501 /Users/kai/Library/LaunchAgents/dev.conclave.daemon.plist"]);
    expect(plan.start[0].optional).toBe(true);
    expect(plan.start[1].retries).toBeGreaterThan(0);
    expect(servicePlan({ ...base, os: 'darwin', cmd: ['/a&b/<c>', 'daemon'] }).content).toContain('<string>/a&amp;b/&lt;c&gt;</string>');
  });

  test('Windows: a Run key that starts it hidden at sign in, with a log file', () => {
    const exe = 'C:\\Users\\Kai\\AppData\\Local\\dev.conclave.desktop\\daemon\\conclave.exe';
    const plan = servicePlan({ ...base, os: 'win32', home: 'C:\\Users\\Kai', cmd: [exe, 'daemon', '--log', 'C:\\Users\\Kai\\.conclave\\logs\\daemon.log'] });
    expect(plan.kind).toBe('run-key');
    expect(plan.file).toBeUndefined();
    expect(plan.content).toBe(`${exe} daemon --log C:\\Users\\Kai\\.conclave\\logs\\daemon.log`);
    expect(plan.register[0].argv).toEqual(['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'ConclaveDaemon', '/t', 'REG_SZ', '/d', plan.content!, '/f']);
    expect(plan.start).toEqual([{ show: plan.content!, argv: [exe, 'daemon', '--log', 'C:\\Users\\Kai\\.conclave\\logs\\daemon.log'], detached: true }]);
    expect(plan.stop[0].argv.slice(0, 2)).toEqual(['reg', 'delete']);
    expect(windowsQuote('C:\\Program Files\\Conclave\\conclave.exe')).toBe('"C:\\Program Files\\Conclave\\conclave.exe"');
    expect(windowsQuote('C:\\with space\\')).toBe('"C:\\with space\\\\"');
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  test('other systems say what to run instead', () => {
    expect(() => servicePlan({ ...base, os: 'freebsd', cmd: ['conclave', 'daemon'] })).toThrow('Run this at login: conclave daemon');
  });
});

describe('PATH', () => {
  test('the login shell value is read between markers, whatever the rc files print', () => {
    expect(parseMarkedPath('Welcome!\n__CONCLAVE_PATH__/opt/homebrew/bin:/usr/bin__CONCLAVE_PATH__')).toBe('/opt/homebrew/bin:/usr/bin');
    expect(parseMarkedPath('no markers here')).toBeUndefined();
    expect(parseMarkedPath('__CONCLAVE_PATH____CONCLAVE_PATH__')).toBeUndefined();
  });

  test("an AppImage's own mount is left out", () => {
    expect(withoutAppImage('/tmp/.mount_ConclaXy12/usr/bin:/usr/bin:/home/kai/.local/bin', {}, ':')).toBe('/usr/bin:/home/kai/.local/bin');
    expect(withoutAppImage('/opt/app/usr/bin:/usr/bin', { APPDIR: '/opt/app' }, ':')).toBe('/usr/bin');
  });

  test('merged in order, without duplicates; extra folders only when they exist', () => {
    const exists = (d: string) => d !== '/missing';
    expect(mergePath(['/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:', undefined], ['/home/kai/.local/bin', '/missing', '/bin'], exists, ':')).toBe('/opt/homebrew/bin:/usr/bin:/bin:/home/kai/.local/bin');
  });
});

describe('running steps', () => {
  const result = (ok: boolean, stderr = ''): StepResult => ({ ok, status: ok ? 0 : 1, stdout: '', stderr });

  test('optional failures pass, others stop with what the command said', () => {
    const seen: string[] = [];
    const steps: Step[] = [
      { show: 'stop it', argv: ['stop'], optional: true },
      { show: 'start it', argv: ['start'] },
    ];
    expect(() =>
      runSteps(steps, (s) => {
        seen.push(s.show);
        return result(false, 'Failed to connect to bus: No medium found');
      }),
    ).toThrow('`start it` failed: Failed to connect to bus: No medium found');
    expect(seen).toEqual(['stop it', 'start it']);
  });

  test('retries, and detached steps go to the spawner', () => {
    let tries = 0;
    const spawned: string[] = [];
    runSteps(
      [
        { show: 'flaky', argv: ['x'], retries: 2 },
        { show: 'bg', argv: ['y'], detached: true },
      ],
      () => result(++tries === 2),
      (s) => spawned.push(s.show),
    );
    expect(tries).toBe(2);
    expect(spawned).toEqual(['bg']);
  });
});

describe('the pid file', () => {
  // started by a shell that exits at once, so it is not our child, as a real daemon is not
  const live = async (args: string[]): Promise<number> => {
    const sh = Bun.spawn(['sh', '-c', `"${process.execPath}" -e 'setTimeout(() => {}, 30000)' ${args.join(' ')} >/dev/null 2>&1 & echo $!`], { stdout: 'pipe' });
    const pid = Number((await new Response(sh.stdout).text()).trim());
    // $! is the forked shell until it has run the program: wait for the program's own command line
    for (let i = 0; i < 50; i++) {
      const cmd = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)]).stdout.toString();
      if (cmd.includes('setTimeout') && !cmd.startsWith('sh ')) break;
      await Bun.sleep(20);
    }
    return pid;
  };
  const naming = (pid: number) => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-pid-'));
    writeFileSync(pidFile(home), JSON.stringify({ pid, startedAt: Date.now(), version: 'test' }));
    return home;
  };

  test.skipIf(process.platform === 'win32')('a pid now used by another program is left alone', async () => {
    // a daemon that was killed left its pid file; the system gave that pid to something else
    const other = await live(['some-editor']);
    const home = naming(other);
    try {
      expect(stopByPid(home)).toBe(false);
      expect(pidAlive(other)).toBe(true);
    } finally {
      if (pidAlive(other)) process.kill(other);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('the daemon the pid file names is stopped', async () => {
    const daemon = await live(['conclave-daemon', 'run']);
    const home = naming(daemon);
    try {
      expect(stopByPid(home)).toBe(true);
      expect(pidAlive(daemon)).toBe(false);
      expect(existsSync(pidFile(home))).toBe(false);
    } finally {
      if (pidAlive(daemon)) process.kill(daemon);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The real CLI against a real hub, with a temp HOME
// ---------------------------------------------------------------------------

const CLI = new URL('../src/index.ts', import.meta.url).pathname;
let home: string;
let hub: TestHub;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'conclave-daemon-cli-'));
  hub = startHub();
});
afterAll(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, HOME: home, CONCLAVE_HOME: join(home, '.conclave'), NO_COLOR: '1', XDG_RUNTIME_DIR: join(home, 'run'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe('conclave daemon, end to end', () => {
  test('install and uninstall --dry-run print the unit and change nothing', async () => {
    const r = await cli('daemon', 'install', '--dry-run', '--start');
    expect(r.code).toBe(0);
    if (process.platform === 'linux') {
      expect(r.out).toContain(`Would write ${home}/.config/systemd/user/conclave-daemon.service`);
      expect(r.out).toContain('ExecStart=');
      expect(r.out).toContain(' daemon\n');
      expect(r.out).toContain('systemctl --user restart conclave-daemon');
      expect(existsSync(join(home, '.config'))).toBe(false);
    }
    const u = await cli('daemon', 'uninstall', '--dry-run');
    expect(u.code).toBe(0);
    expect(u.out).toContain('Would run');
  });

  test('status, pair with a code the app asked for, status again, unpair', async () => {
    const before = JSON.parse((await cli('daemon', 'status', '--json')).out);
    expect(before).toMatchObject({ paired: false, service: { installed: false } });
    expect(typeof before.version).toBe('string');

    // the desktop app's own pairing: a client token asks for a device code
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const app = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'Desktop', platform: 'desktop' } }).then((r) => r.json());
    const { code } = await hub.api('/api/daemon/pairing', { method: 'POST', token: app.token }).then((r) => r.json());

    const paired = await cli('daemon', 'pair', hub.url, code, '--name', 'test-box');
    expect(paired.err).toBe('');
    expect(paired.code).toBe(0);
    const after = JSON.parse((await cli('daemon', 'status', '--json')).out);
    expect(after).toMatchObject({ paired: true, hub: hub.url, name: 'test-box' });
    expect(hub.engine.repos.devices.get(after.deviceId)?.name).toBe('test-box');

    const human = await cli('daemon', 'status');
    expect(human.out).toContain(`Paired      test-box (${after.deviceId}) with ${hub.url}`);

    const gone = JSON.parse((await cli('daemon', 'unpair', '--json')).out);
    expect(gone).toMatchObject({ paired: false, removedOnHub: true, name: 'test-box' });
    expect(hub.engine.repos.devices.get(after.deviceId)).toBeUndefined();
    expect(existsSync(join(home, '.conclave', 'device.json'))).toBe(false);

    // nothing left to unpair
    expect(JSON.parse((await cli('daemon', 'unpair', '--json')).out)).toEqual({ paired: false });
  });

  test('unpair still forgets the pairing here when the hub is gone, and says so', async () => {
    const { code } = await hub.api('/api/daemon/pairing', { method: 'POST' }).then((r) => r.json());
    expect((await cli('daemon', 'pair', hub.url, code)).code).toBe(0);
    // point it at an address where nothing listens
    const file = join(home, '.conclave', 'device.json');
    const creds = await Bun.file(file).json();
    await Bun.write(file, JSON.stringify({ ...creds, hub: 'http://127.0.0.1:9', addresses: [] }));
    const r = await cli('daemon', 'unpair');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Forgot the pairing with http://127.0.0.1:9.');
    expect(r.out).toContain("Remove ");
    expect(r.out).toContain("on the hub's Devices page.");
    expect(existsSync(file)).toBe(false);
  });

  test('help lists the new commands', async () => {
    const r = await cli('daemon', '--help');
    expect(r.out).toContain('conclave daemon uninstall');
    expect(r.out).toContain('conclave daemon status [--json]');
  });
});

// ---------------------------------------------------------------------------
// conclave-daemon: the contract in docs/design/DAEMON-SIDECAR.md
// ---------------------------------------------------------------------------

const SIDECAR = new URL('../src/daemon-main.ts', import.meta.url).pathname;

async function sidecar(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', SIDECAR, ...args], {
    env: { ...process.env, HOME: home, CONCLAVE_HOME: join(home, '.conclave'), NO_COLOR: '1', XDG_RUNTIME_DIR: join(home, 'run'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe('conclave-daemon (the desktop sidecar)', () => {
  test('--version, help, and usage errors exit 2 with one Error line', async () => {
    const v = await sidecar(['--version']);
    expect(v.code).toBe(0);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await sidecar(['--help'])).out).toContain('conclave-daemon pair --hub URL --app-token-stdin');
    const bad = await sidecar(['frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.err.trim().split('\n')).toEqual(['Error: Unknown command "frobnicate". Run conclave-daemon --help.']);
    const noHub = await sidecar(['pair', '--app-token-stdin'], 'x\n');
    expect(noHub.code).toBe(2);
    const noToken = await sidecar(['pair', '--hub', hub.url, '--app-token-stdin'], '\n');
    expect(noToken.code).toBe(2);
  });

  test('install --dry-run: the service runs `conclave-daemon run`', async () => {
    const r = await sidecar(['install', '--dry-run']);
    expect(r.code).toBe(0);
    if (process.platform === 'linux') {
      expect(r.out).toMatch(/ExecStart=.*daemon-main\.ts run\n/);
      expect(r.out).toContain('systemctl --user restart conclave-daemon');
    }
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  test('status --json, pair with the app token on stdin (twice), uninstall --json', async () => {
    const empty = JSON.parse((await sidecar(['status', '--json'])).out);
    expect(empty).toEqual({ version: expect.any(String), paired: false, hub: null, deviceId: null, name: null, installed: false, running: expect.anything() });

    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const app = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'Desktop', platform: 'desktop' } }).then((r) => r.json());

    // a wrong app token: exit 1 and words the app can show
    const refused = await sidecar(['pair', '--hub', hub.url, '--app-token-stdin', '--json'], 'ccl_wrong\n');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Error: The hub did not accept the app token.');

    const first = await sidecar(['pair', '--hub', hub.url, '--app-token-stdin', '--json', '--name', 'desk'], `${app.token}\n`);
    expect(first.err).toBe('');
    const a = JSON.parse(first.out);
    expect(a).toMatchObject({ paired: true, hub: hub.url, name: 'desk', kept: false });
    // the token never went on the command line, and the device is linked to the app
    expect(hub.engine.repos.devices.get(a.deviceId)?.name).toBe('desk');

    // again: already a device of this hub, so nothing changes
    const b = JSON.parse((await sidecar(['pair', '--hub', hub.url, '--app-token-stdin', '--json'], `${app.token}\n`)).out);
    expect(b).toMatchObject({ deviceId: a.deviceId, kept: true });

    const s = JSON.parse((await sidecar(['status', '--json'])).out);
    expect(s).toMatchObject({ paired: true, hub: hub.url, deviceId: a.deviceId, name: 'desk', installed: false });

    // uninstall unpairs too: the hub removes the device
    const u = await sidecar(['uninstall', '--json']);
    expect(u.code).toBe(0);
    expect(JSON.parse(u.out)).toEqual({ removed: false, unpaired: true, removedOnHub: true, name: 'desk', deviceId: a.deviceId, error: null });
    expect(hub.engine.repos.devices.get(a.deviceId)).toBeUndefined();
    expect(JSON.parse((await sidecar(['status', '--json'])).out).paired).toBe(false);

    // nothing left: still exit 0
    expect(JSON.parse((await sidecar(['uninstall', '--json'])).out)).toMatchObject({ removed: false, unpaired: false, error: null });
  });
});
