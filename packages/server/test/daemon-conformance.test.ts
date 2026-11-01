/**
 * Daemon conformance on a real hub: the TypeScript daemon
 * (packages/cli/src/daemon-main.ts) and the Rust one (packages/daemon-rs)
 * run as their own processes with the same fixture HOME, pair with the hub
 * like a user would, and every case in core/test/machine/conformance.ts
 * runs on each through the hub's RemoteMachine. Results must match each
 * other and the case's own checks.
 *
 * The Rust binary is CONCLAVE_DAEMON_RS, or a build under
 * packages/daemon-rs/target. Without one, only the TypeScript daemon runs.
 * Nothing here installs a service: install only runs with --dry-run, and
 * systemctl has no bus to talk to.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { PROTOCOL_VERSION, RPC_METHODS } from '@conclave/core/machine/protocol.ts';
import type { Machine } from '@conclave/core/machine/types.ts';
import { CASES, buildFixtures, outcome, type CaseCtx } from '../../core/test/machine/conformance';
import { waitFor } from '../../core/test/machine/fake-machine';
import { startServer, type RunningServer } from '../src/app';
import { startHub, type TestHub } from './helpers';

const ROOT = new URL('../../..', import.meta.url).pathname;

function rustBinary(): string | undefined {
  const env = process.env.CONCLAVE_DAEMON_RS;
  if (env) {
    if (!existsSync(env)) throw new Error(`CONCLAVE_DAEMON_RS=${env} does not exist`);
    return env;
  }
  const dirs = [process.env.CARGO_TARGET_DIR, join(ROOT, 'packages/daemon-rs/target')].filter(Boolean) as string[];
  for (const d of dirs) for (const p of ['release', 'debug']) if (existsSync(join(d, p, 'conclave-daemon'))) return join(d, p, 'conclave-daemon');
  return undefined;
}

interface Impl {
  name: string;
  argv: string[];
  env?: Record<string, string>;
  /** Run only the search cases (the built-in search of the Rust daemon). */
  searchOnly?: boolean;
}

const RUST = rustBinary();
const IMPLS: Impl[] = [{ name: 'ts', argv: ['bun', join(ROOT, 'packages/cli/src/daemon-main.ts')] }];
if (RUST) IMPLS.push({ name: 'rust', argv: [RUST] }, { name: 'rust-builtin', argv: [RUST], env: { CONCLAVE_DAEMON_SEARCH: 'builtin' }, searchOnly: true });
// CONFORMANCE_IMPLS=ts,rust picks some (for a look at one); ts stays the reference when it is in
if (process.env.CONFORMANCE_IMPLS) {
  const pick = process.env.CONFORMANCE_IMPLS.split(',');
  IMPLS.splice(0, IMPLS.length, ...IMPLS.filter((i) => pick.includes(i.name)));
}
if (!RUST) console.warn('daemon-conformance: no Rust daemon found (set CONCLAVE_DAEMON_RS); checking the TypeScript daemon only');

let root: string;
let home: string;
let hub: TestHub;
let running: RunningServer;
let port: number;
let syncthing: Server<undefined>;
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
const devices = new Map<string, string>();

function envFor(impl: Impl, conclaveHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'STCONFDIR', 'STHOMEDIR', 'LOCALAPPDATA', 'RIPGREP_CONFIG_PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR', 'CONCLAVE_DAEMON_SEARCH']) delete env[k];
  return {
    ...env,
    HOME: home,
    CONCLAVE_HOME: conclaveHome,
    NO_COLOR: '1',
    XDG_RUNTIME_DIR: join(root, 'run'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent',
    // hub secrets the daemon must keep from tools, one passed through on purpose
    CONCLAVE_TOKEN: 'hub-secret-token',
    ANTHROPIC_API_KEY: 'sk-ant-hub-secret',
    CONCLAVE_GITHUB_TOKEN: 'gh-hub-secret',
    OPENAI_API_KEY: 'passed-through',
    CONCLAVE_PASS_ENV: 'OPENAI_API_KEY',
    CONFORMANCE_VISIBLE: 'visible',
    ...(impl.env ?? {}),
  };
}

async function cli(impl: Impl, conclaveHome: string, args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([...impl.argv, ...args], { env: envFor(impl, conclaveHome), stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

const machineOf = (impl: string): Machine => {
  const m = hub.engine.devices.get(devices.get(impl)!);
  if (!m) throw new Error(`${impl} is not connected`);
  return m;
};

const allOnline = () => IMPLS.every((i) => hub.engine.devices.isOnline(devices.get(i.name)!));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'conclave-conformance-'));
  home = join(root, 'home');
  mkdirSync(join(root, 'run'), { recursive: true });
  syncthing = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/rest/db/status' || req.headers.get('x-api-key') !== 'test-api-key') return new Response('no', { status: 403 });
      return Response.json({ state: url.searchParams.get('folder') === 'proj-1' ? 'idle' : 'unknown', needFiles: 2, needBytes: 1024, pullErrors: 0, apiKeyNeverLeaves: true });
    },
  });
  buildFixtures(home, `127.0.0.1:${syncthing.port}`);
  // the hub pings every second and drops a daemon silent for three
  hub = startHub({ heartbeatMs: 1000 });
  running = hub.running;
  port = Number(new URL(hub.url).port);
  for (const impl of IMPLS) {
    const ch = join(root, `conclave-${impl.name}`);
    const { code } = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    const paired = await cli(impl, ch, ['pair', '--hub', hub.url, '--code', code, '--name', impl.name, '--json']);
    expect(paired.err).toBe('');
    expect(paired.code).toBe(0);
    const r = JSON.parse(paired.out);
    expect(r).toMatchObject({ paired: true, hub: hub.url, name: impl.name, kept: false });
    devices.set(impl.name, r.deviceId);
    // the pairing file is private
    const mode = (await import('node:fs')).statSync(join(ch, 'device.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    procs.push(Bun.spawn([...impl.argv, 'run'], { env: envFor(impl, ch), stdin: 'ignore', stdout: Bun.file(join(root, `${impl.name}.log`)), stderr: Bun.file(join(root, `${impl.name}.err`)) }));
  }
  await waitFor(allOnline, 20_000, 'every daemon online');
}, 60_000);

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => Promise.race([p.exited, Bun.sleep(3000)])));
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  await running?.stop();
  hub?.engine.cleanup();
  syncthing?.stop(true);
  // CONFORMANCE_KEEP=1 keeps the fixtures and the daemons' logs for a look
  if (root && !process.env.CONFORMANCE_KEEP) rmSync(root, { recursive: true, force: true });
  else if (root) console.warn(`daemon-conformance: kept ${root}`);
});

describe('daemon conformance', () => {
  test('every RPC has a case', () => {
    const covered = new Set(CASES.flatMap((c) => c.rpc));
    for (const m of [...RPC_METHODS, 'rpc', 'exec.abort', 'exec.output', 'proc.stdin', 'proc.kill', 'proc.exit']) expect(covered.has(m)).toBe(true);
  });

  test('hello: both say the same protocol version, the Rust one names itself', () => {
    for (const impl of IMPLS) {
      const m = machineOf(impl.name) as unknown as { protocol: number; lastInfo: { daemon?: { impl: string } } };
      expect(m.protocol).toBe(PROTOCOL_VERSION);
      if (impl.name.startsWith('rust')) expect(m.lastInfo.daemon?.impl).toBe('rust');
    }
  });

  // glob and grep match rg's results; the TypeScript daemon without rg uses grep, which differs
  const HAS_RG = !!Bun.which('rg');
  if (!HAS_RG) console.warn('daemon-conformance: rg is not on PATH; the glob and grep cases are skipped');
  for (const c of CASES) {
    const isSearchCase = c.rpc.includes('glob') || c.rpc.includes('grep');
    (isSearchCase && !HAS_RG ? test.skip : test)(
      c.name,
      async () => {
        const results: Record<string, unknown> = {};
        const isSearch = c.rpc.includes('glob') || c.rpc.includes('grep');
        for (const impl of IMPLS) {
          if (impl.searchOnly && (!isSearch || c.rgOnly)) continue;
          const ctx: CaseCtx = { home, out: join(home, `out-${impl.name}`), impl: impl.name, syncthing: `127.0.0.1:${syncthing.port}` };
          let r: unknown = await outcome(() => c.run(machineOf(impl.name), ctx));
          if (c.normalize) r = c.normalize(r, ctx);
          results[impl.name] = r;
          try {
            c.check?.(r, ctx);
          } catch (err) {
            throw new Error(`${impl.name}: ${(err as Error).message}\n${JSON.stringify(r).slice(0, 3000)}`);
          }
        }
        if (process.env.CONFORMANCE_KEEP) for (const [name, r] of Object.entries(results)) await Bun.write(join(root, 'results', `${c.name.replace(/[^\w]+/g, '-')}.${name}.json`), JSON.stringify(r, null, 1));
        for (const name of Object.keys(results)) if (name !== 'ts') expect({ [name]: results[name] }).toEqual({ [name]: results.ts });
      },
      c.timeoutMs ?? 20_000,
    );
  }

  test('ping: the hub pings every second and the daemons stay on the same connection', async () => {
    const before = IMPLS.map((i) => machineOf(i.name));
    await Bun.sleep(4500);
    expect(allOnline()).toBe(true);
    IMPLS.forEach((i, n) => expect(machineOf(i.name)).toBe(before[n]));
  }, 10_000);

  test('reconnect: the hub restarts and every daemon comes back', async () => {
    await running.stop();
    await waitFor(() => IMPLS.every((i) => !hub.engine.devices.isOnline(devices.get(i.name)!)), 5000, 'daemons offline');
    await Bun.sleep(1500);
    running = startServer(hub.engine, { host: '127.0.0.1', port, heartbeatMs: 1000 });
    await waitFor(allOnline, 20_000, 'every daemon back online');
    for (const impl of IMPLS) expect(await machineOf(impl.name).readText(join(home, 'files', 'text.txt'))).toBe('hello world\n');
  }, 40_000);

  test('the hub addresses are saved in device.json', async () => {
    running.conclave.ctx.daemons.sendAddresses([hub.url, 'http://192.0.2.10:7717']);
    for (const impl of IMPLS) {
      const file = join(root, `conclave-${impl.name}`, 'device.json');
      await waitFor(() => (JSON.parse(readFileSync(file, 'utf8')).addresses ?? []).length === 2, 5000, `${impl.name} saved the addresses`);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      // a daemon on the hub machine keeps its loopback address
      expect(saved).toMatchObject({ hub: hub.url, addresses: [hub.url, 'http://192.0.2.10:7717'] });
    }
    expect(allOnline()).toBe(true);
  }, 15_000);

  test('a stopped daemon removes its pid file and the hub sees it go', async () => {
    for (const impl of IMPLS) expect(existsSync(join(root, `conclave-${impl.name}`, 'daemon.pid'))).toBe(true);
    for (const p of procs) p.kill('SIGTERM');
    await Promise.all(procs.map((p) => p.exited));
    await waitFor(() => IMPLS.every((i) => !hub.engine.devices.isOnline(devices.get(i.name)!)), 5000, 'daemons offline');
    for (const impl of IMPLS) expect(existsSync(join(root, `conclave-${impl.name}`, 'daemon.pid'))).toBe(false);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// The sidecar contract (docs/design/DAEMON-SIDECAR.md) on each binary
// ---------------------------------------------------------------------------

describe('sidecar contract', () => {
  const sidecarImpls = IMPLS.filter((i) => !i.searchOnly);
  let side: TestHub;
  beforeAll(() => {
    side = startHub();
  });
  afterAll(async () => {
    await side.stop();
  });

  test('--version, help and usage errors, the same on each binary', async () => {
    const seen: Record<string, unknown> = {};
    for (const impl of sidecarImpls) {
      const ch = join(root, `side-usage-${impl.name}`);
      const v = await cli(impl, ch, ['--version']);
      expect(v.code).toBe(0);
      expect(v.out).toMatch(/^\d+\.\d+\.\d+\n$/);
      expect((await cli(impl, ch, ['--help'])).out).toContain('conclave-daemon pair --hub URL --app-token-stdin');
      const bad = await cli(impl, ch, ['frobnicate']);
      const noHub = await cli(impl, ch, ['pair', '--app-token-stdin'], 'x\n');
      const noToken = await cli(impl, ch, ['pair', '--hub', side.url, '--app-token-stdin'], '\n');
      const notPaired = await cli(impl, ch, ['run']);
      seen[impl.name] = { version: v.out, bad: [bad.code, bad.err], noHub: [noHub.code, noHub.err], noToken: [noToken.code, noToken.err], notPaired: notPaired.code };
      expect(bad).toMatchObject({ code: 2, err: 'Error: Unknown command "frobnicate". Run conclave-daemon --help.\n' });
      expect(noHub).toMatchObject({ code: 2, err: 'Error: pair needs --hub URL. Run conclave-daemon --help.\n' });
      expect(noToken).toMatchObject({ code: 2, err: 'Error: No app token on stdin. Run conclave-daemon --help.\n' });
      expect(notPaired.code).toBe(1);
      expect(notPaired.err.startsWith('Error: This machine is not paired.')).toBe(true);
    }
    for (const name of Object.keys(seen)) expect(seen[name]).toEqual(seen.ts);
  }, 30_000);

  test('install --dry-run: the service runs this binary with `run`, and nothing is written', async () => {
    const shown: Record<string, string> = {};
    for (const impl of sidecarImpls) {
      // one CONCLAVE_HOME for both: a dry run writes nothing
      const ch = join(root, 'side-install');
      const r = await cli(impl, ch, ['install', '--dry-run']);
      expect(r.code).toBe(0);
      // the same unit and commands from both, but for the binary it names (bun and its script for ts):
      // systemd has them on the ExecStart line, launchd has one <string> each before run
      shown[impl.name] = r.out
        .replace(/^ExecStart=.* run$/gm, 'ExecStart=<binary> run')
        .replace(/(<key>ProgramArguments<\/key>\n\s*<array>\n)(?:\s*<string>.*<\/string>\n)*?(\s*<string>run<\/string>\n)/, '$1    <string><binary></string>\n$2');
      if (process.platform === 'linux') {
        expect(r.out).toContain(`Would write ${home}/.config/systemd/user/conclave-daemon.service`);
        expect(r.out).toMatch(impl.name === 'ts' ? /ExecStart=.*daemon-main\.ts run\n/ : new RegExp(`ExecStart=${RUST} run\\n`));
        expect(r.out).toContain('Environment=PATH=');
        expect(r.out).toContain('systemctl --user restart conclave-daemon');
      }
      const u = await cli(impl, ch, ['uninstall', '--dry-run']);
      expect(u.code).toBe(0);
      expect(u.out).toContain('Would run');
      shown[`${impl.name}-uninstall`] = u.out;
    }
    expect(existsSync(join(home, '.config', 'systemd'))).toBe(false);
    if (shown.rust) {
      expect(shown.rust).toBe(shown.ts);
      expect(shown['rust-uninstall']).toBe(shown['ts-uninstall']);
    }
  }, 60_000);

  test('status, pair with the app token on stdin (twice), status, uninstall --json', async () => {
    const seen: Record<string, unknown[]> = {};
    for (const impl of sidecarImpls) {
      const ch = join(root, `side-flow-${impl.name}`);
      const steps: unknown[] = [];
      const json = async (args: string[], stdin?: string) => {
        const r = await cli(impl, ch, args, stdin);
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
        return JSON.parse(r.out);
      };
      const empty = await json(['status', '--json']);
      expect(Object.keys(empty)).toEqual(['version', 'paired', 'hub', 'deviceId', 'name', 'installed', 'running']);
      expect(empty).toMatchObject({ paired: false, hub: null, deviceId: null, name: null, installed: false });
      steps.push(empty);

      const pairing = await side.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
      const app = await side.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: `Desktop ${impl.name}`, platform: 'desktop' } }).then((r) => r.json());

      const refused = await cli(impl, ch, ['pair', '--hub', side.url, '--app-token-stdin', '--json'], 'ccl_wrong\n');
      expect(refused.code).toBe(1);
      expect(refused.err).toBe('Error: The hub did not accept the app token. Connect the app to the hub again.\n');

      const first = await json(['pair', '--hub', side.url, '--app-token-stdin', '--json', '--name', 'desk'], `${app.token}\n`);
      expect(first).toMatchObject({ paired: true, hub: side.url, name: 'desk', kept: false });
      expect(side.engine.repos.devices.get(first.deviceId)?.name).toBe('desk');
      const again = await json(['pair', '--hub', side.url, '--app-token-stdin', '--json'], `${app.token}\n`);
      expect(again).toEqual({ ...first, kept: true });
      const status = await json(['status', '--json']);
      expect(status).toMatchObject({ paired: true, hub: side.url, deviceId: first.deviceId, name: 'desk', installed: false });

      const gone = await json(['uninstall', '--json']);
      expect(gone).toEqual({ removed: false, unpaired: true, removedOnHub: true, name: 'desk', deviceId: first.deviceId, error: null });
      expect(side.engine.repos.devices.get(first.deviceId)).toBeUndefined();
      expect(existsSync(join(ch, 'device.json'))).toBe(false);
      const nothing = await json(['uninstall', '--json']);
      expect(nothing).toEqual({ removed: false, unpaired: false, removedOnHub: false, name: null, deviceId: null, error: null });
      const anon = (x: Record<string, unknown>) => ({ ...x, ...(x.deviceId ? { deviceId: '<id>' } : {}) });
      seen[impl.name] = [empty, anon(first), anon(again), anon(status), anon(gone), nothing];
    }
    for (const name of Object.keys(seen)) expect(seen[name]).toEqual(seen.ts);
  }, 60_000);

  test.skipIf(!RUST)('a pairing made by one binary runs with the other (switching needs no new pairing)', async () => {
    const ts = sidecarImpls.find((i) => i.name === 'ts')!;
    const rust = sidecarImpls.find((i) => i.name === 'rust')!;
    for (const [pairer, runner] of [
      [ts, rust],
      [rust, ts],
    ]) {
      const ch = join(root, `side-switch-${pairer.name}`);
      const { code } = await side.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
      const paired = JSON.parse((await cli(pairer, ch, ['pair', '--hub', side.url, '--code', code, '--name', `by-${pairer.name}`, '--json'])).out);
      const status = JSON.parse((await cli(runner, ch, ['status', '--json'])).out);
      expect(status).toMatchObject({ paired: true, deviceId: paired.deviceId, name: `by-${pairer.name}` });
      const p = Bun.spawn([...runner.argv, 'run'], { env: envFor(runner, ch), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      try {
        await waitFor(() => side.engine.devices.isOnline(paired.deviceId), 15_000, `${runner.name} online with a pairing from ${pairer.name}`);
        expect(await side.engine.devices.get(paired.deviceId)!.readText(join(home, 'files', 'text.txt'))).toBe('hello world\n');
      } finally {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  }, 60_000);

  test('uninstall when the hub is gone still forgets the pairing, and says why', async () => {
    for (const impl of sidecarImpls) {
      const ch = join(root, `side-gone-${impl.name}`);
      const { code } = await side.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
      expect((await cli(impl, ch, ['pair', '--hub', side.url, '--code', code])).code).toBe(0);
      const file = join(ch, 'device.json');
      const creds = JSON.parse(readFileSync(file, 'utf8'));
      await Bun.write(file, JSON.stringify({ ...creds, hub: 'http://127.0.0.1:9', addresses: [] }));
      const r = await cli(impl, ch, ['uninstall', '--json']);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.out);
      expect(out).toMatchObject({ removed: false, unpaired: true, removedOnHub: false, deviceId: creds.deviceId });
      expect(out.error).toStartWith('Cannot reach http://127.0.0.1:9');
      expect(existsSync(file)).toBe(false);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// TLS: https pairing and a wss connection, trusting a certificate from
// NODE_EXTRA_CA_CERTS (a hub behind a reverse proxy with its own CA)
// ---------------------------------------------------------------------------

describe.skipIf(!Bun.which('openssl'))('TLS', () => {
  let tlsHub: Server<undefined>;
  let cert: string;
  const hellos: Array<{ deviceId: string; version: number }> = [];

  beforeAll(() => {
    const dir = join(root, 'tls');
    mkdirSync(dir, { recursive: true });
    // a private CA and a server certificate it signs (rustls refuses a CA certificate used as the server's own)
    cert = join(dir, 'ca.pem');
    const ssl = (...args: string[]) => expect(Bun.spawnSync(['openssl', ...args], { cwd: dir }).exitCode).toBe(0);
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Conformance CA');
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'leaf.csr', '-subj', '/CN=localhost');
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'cert.pem', '-days', '1', '-extfile', 'ext.cnf');
    // a hub of its own: register answers a fixed pairing, the socket says welcome to a hello
    tlsHub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') },
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/api/daemon/register' && req.method === 'POST') {
          const body = (await req.json()) as { code?: string };
          return body.code === 'TLS-CODE' ? Response.json({ deviceId: 'dev_tls', token: 'cdv_tls', addresses: [] }) : Response.json({ error: 'wrong code' }, { status: 400 });
        }
        if (url.pathname === '/api/daemon' && req.headers.get('authorization') === 'Bearer cdv_tls') return srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 });
        return new Response('not found', { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'hello') {
            hellos.push({ deviceId: msg.deviceId, version: msg.version });
            ws.send(JSON.stringify({ type: 'welcome', version: PROTOCOL_VERSION, deviceId: msg.deviceId, name: 'tls' }));
          } else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
        },
      },
    }) as unknown as Server<undefined>;
  });
  afterAll(() => {
    tlsHub?.stop(true);
  });

  test('pair over https and connect over wss when the CA is trusted; refuse it otherwise', async () => {
    const url = `https://127.0.0.1:${tlsHub.port}`;
    for (const impl of IMPLS.filter((i) => !i.searchOnly)) {
      const ch = join(root, `tls-${impl.name}`);
      const trusting: Impl = { ...impl, env: { ...(impl.env ?? {}), NODE_EXTRA_CA_CERTS: cert } };
      const refused = await cli(impl, ch, ['pair', '--hub', url, '--code', 'TLS-CODE', '--json']);
      expect(refused.code).toBe(1);
      expect(refused.err.startsWith('Error: ')).toBe(true);
      const paired = await cli(trusting, ch, ['pair', '--hub', url, '--code', 'TLS-CODE', '--json']);
      expect(paired.err).toBe('');
      expect(JSON.parse(paired.out)).toEqual({ paired: true, hub: url, deviceId: 'dev_tls', name: expect.any(String), kept: false });
      const before = hellos.length;
      const p = Bun.spawn([...trusting.argv, 'run'], { env: envFor(trusting, ch), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      try {
        await waitFor(() => hellos.length > before, 20_000, `${impl.name} hello over wss`);
        expect(hellos[hellos.length - 1]).toEqual({ deviceId: 'dev_tls', version: PROTOCOL_VERSION });
      } finally {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  }, 60_000);
});
