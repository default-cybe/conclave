import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteStatus } from '@conclave/core/types.ts';
import { assetFor, ensureCloudflared, looksExecutable, parseVersion, CloudflaredError } from '../src/remote/cloudflared';
import { TunnelRunner, cloudflaredEnv, quickUrlIn, type Spawner, type TunnelProcess } from '../src/remote/tunnel';
import { PidFile } from '../src/remote/pids';
import { CloudflareApi, CloudflareError } from '../src/remote/cloudflare-api';
import { isLocalPeer, lanAddresses, type Interfaces } from '../src/remote/lan';
import { parseTailscale } from '../src/remote/tailscale';
import { FailureGuard } from '../src/guard';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

// ---------------------------------------------------------------------------
// A fake cloudflared: prints what the real one prints, exits when told
// ---------------------------------------------------------------------------

class FakeProc implements TunnelProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  killed = false;
  ended = false;
  private ctl!: ReadableStreamDefaultController<Uint8Array>;
  private done!: (code: number | null) => void;

  constructor(
    readonly cmd: string[],
    readonly env: Record<string, string>,
  ) {
    this.stdout = new ReadableStream({ start: (c) => c.close() });
    this.stderr = new ReadableStream({ start: (c) => (this.ctl = c) });
    this.exited = new Promise((r) => (this.done = r));
  }

  line(text: string) {
    if (!this.ended) this.ctl.enqueue(new TextEncoder().encode(`2026-10-17T07:00:00Z INF ${text}\n`));
  }

  exit(code: number | null = 1) {
    if (this.ended) return;
    this.ended = true;
    try {
      this.ctl.close();
    } catch {
      /* closed */
    }
    this.done(code);
  }

  kill() {
    this.killed = true;
    this.exit(0);
  }
}

function fakeCloudflared(opts: { auto?: boolean } = {}) {
  const procs: FakeProc[] = [];
  let n = 0;
  const spawn: Spawner = (cmd, env) => {
    const p = new FakeProc(cmd, env);
    procs.push(p);
    const id = ++n;
    if (opts.auto !== false) {
      setTimeout(() => {
        p.line('Thank you for trying Cloudflare Tunnel. See https://www.cloudflare.com/website-terms/');
        if (cmd.includes('--url')) {
          p.line('Requesting new quick Tunnel on trycloudflare.com...');
          p.line('+--------------------------------------------------------------------------------------------+');
          p.line(`|  https://tunnel-${id}-words.trycloudflare.com                                     |`);
        }
        p.line(`Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=lhr01 protocol=quic`);
      }, 5);
    }
    return p;
  };
  return { procs, spawn };
}

const binary = async () => ({ path: '/opt/fake/cloudflared', version: '2026.9.0', managed: true });

const IFACES: Interfaces = {
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
  wlan0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: '192.168.1.20/24' }],
  docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '02:00:00:00:00:02', internal: false, cidr: '172.17.0.1/16' }],
};

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 3000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe('same network', () => {
  test('lists private addresses, home Wi-Fi first, skips virtual interfaces', () => {
    const list = lanAddresses(
      {
        ...IFACES,
        eth1: [{ address: '10.0.20.14', netmask: '255.255.255.0', family: 'IPv4', mac: 'x', internal: false, cidr: null }],
        tailscale0: [{ address: '100.81.4.12', netmask: '255.255.255.255', family: 'IPv4', mac: 'x', internal: false, cidr: null }],
        eth2: [{ address: '203.0.113.7', netmask: '255.255.255.0', family: 'IPv4', mac: 'x', internal: false, cidr: null }],
      },
      { container: false },
    );
    expect(list.map((a) => a.ip)).toEqual(['192.168.1.20', '10.0.20.14']);
  });

  test('a container leaves out its bridge addresses', () => {
    const list = lanAddresses({ eth0: [{ address: '172.18.0.4', netmask: '255.255.0.0', family: 'IPv4', mac: 'x', internal: false, cidr: null }] }, { container: true });
    expect(list).toEqual([]);
  });

  test('local peers: loopback, private, link-local, 100.64/10, IPv6 ULA; not the internet', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.9', '10.1.2.3', '172.20.0.1', '169.254.3.3', '100.81.4.12', 'fd7a:115c::1', 'fe80::1']) expect(isLocalPeer(ip)).toBe(true);
    for (const ip of ['203.0.113.5', '8.8.8.8', '172.32.0.1', '2001:db8::1', '']) expect(isLocalPeer(ip)).toBe(false);
  });
});

describe('cloudflared binary', () => {
  test('picks the release asset for each OS and CPU', () => {
    expect(assetFor('linux', 'x64')).toEqual({ name: 'cloudflared-linux-amd64', archive: false });
    expect(assetFor('linux', 'arm64')?.name).toBe('cloudflared-linux-arm64');
    expect(assetFor('darwin', 'arm64')).toEqual({ name: 'cloudflared-darwin-arm64.tgz', archive: true });
    expect(assetFor('win32', 'arm64')?.name).toBe('cloudflared-windows-amd64.exe');
    expect(assetFor('freebsd', 'x64')).toBeUndefined();
  });

  test('knows an executable and a version line', () => {
    expect(looksExecutable(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), 'linux')).toBe(true);
    expect(looksExecutable(new TextEncoder().encode('<!DO'), 'linux')).toBe(false);
    expect(looksExecutable(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]), 'darwin')).toBe(true);
    expect(looksExecutable(new Uint8Array([0x4d, 0x5a, 0, 0]), 'win32')).toBe(true);
    expect(parseVersion('cloudflared version 2026.9.0 (built 2026-09-01-1200 UTC)')).toBe('2026.9.0');
  });

  const SIZE = 9 * 1024 * 1024;
  const body = () => {
    const b = new Uint8Array(SIZE);
    b.set([0x7f, 0x45, 0x4c, 0x46]);
    return b;
  };
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  function releaseFetch(opts: { digest?: string; size?: number; api?: boolean; bytes?: Uint8Array } = {}) {
    const bytes = opts.bytes ?? body();
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('api.github.com')) {
        if (opts.api === false) return new Response('rate limited', { status: 403 });
        return Response.json({
          tag_name: '2026.9.0',
          assets: [{ name: 'cloudflared-linux-amd64', size: opts.size ?? bytes.byteLength, digest: `sha256:${opts.digest ?? sha(bytes)}`, browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-linux-amd64' }],
        });
      }
      return new Response(bytes as unknown as BodyInit, { headers: { 'content-length': String(bytes.byteLength) } });
    }) as typeof fetch;
    return { f, seen };
  }

  let home = '';
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  test('downloads into the hub home, checks size and SHA-256, and makes it executable', async () => {
    home = mkdtempSync(join(tmpdir(), 'cf-bin-'));
    const { f, seen } = releaseFetch();
    const ran: string[] = [];
    const info = await ensureCloudflared({ home, fetch: f, platform: 'linux', arch: 'x64', which: () => null, version: async (p) => (ran.push(p), '2026.9.0') });
    expect(info).toEqual({ path: join(home, 'bin', 'cloudflared'), version: '2026.9.0', managed: true, verified: true });
    expect(statSync(info.path).size).toBe(SIZE);
    expect(statSync(info.path).mode & 0o111).toBeTruthy();
    expect(seen[1]).toContain('/releases/download/2026.9.0/');
    // it ran only from inside the hub home
    expect(ran.every((p) => p.startsWith(join(home, 'bin')))).toBe(true);
    // the program, and a note of its checksum for Settings
    expect(readdirSync(join(home, 'bin')).sort()).toEqual(['cloudflared', 'cloudflared.json']);
    // the next start uses that copy without the network, and still knows it was checked
    const again = await ensureCloudflared({ home, fetch: (async () => Response.error()) as unknown as typeof fetch, platform: 'linux', arch: 'x64', which: () => null, version: async () => '2026.9.0' });
    expect(again.path).toBe(info.path);
    expect(again.verified).toBe(true);
  });

  test('refuses a download whose checksum does not match, and leaves nothing behind', async () => {
    home = mkdtempSync(join(tmpdir(), 'cf-bin-'));
    const { f } = releaseFetch({ digest: 'a'.repeat(64) });
    const err = await ensureCloudflared({ home, fetch: f, platform: 'linux', arch: 'x64', which: () => null, version: async () => '1' }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflaredError);
    expect(err.message).toContain('checksum');
    expect(readdirSync(join(home, 'bin'))).toEqual([]);
  });

  test('refuses a download of the wrong size', async () => {
    home = mkdtempSync(join(tmpdir(), 'cf-bin-'));
    const { f } = releaseFetch({ size: SIZE + 10 });
    const err = await ensureCloudflared({ home, fetch: f, platform: 'linux', arch: 'x64', which: () => null, version: async () => '1' }).catch((e) => e);
    expect(err.message).toContain('bytes');
    expect(existsSync(join(home, 'bin', 'cloudflared'))).toBe(false);
  });

  test('refuses something that is not a program', async () => {
    home = mkdtempSync(join(tmpdir(), 'cf-bin-'));
    const page = new Uint8Array(SIZE).fill(0x3c);
    const { f } = releaseFetch({ bytes: page });
    const err = await ensureCloudflared({ home, fetch: f, platform: 'linux', arch: 'x64', which: () => null, version: async () => '1' }).catch((e) => e);
    expect(err.message).toContain('not a program');
    expect(readdirSync(join(home, 'bin'))).toEqual([]);
  });

  test('without the GitHub API it still checks size and Content-Length', async () => {
    home = mkdtempSync(join(tmpdir(), 'cf-bin-'));
    const { f, seen } = releaseFetch({ api: false });
    const info = await ensureCloudflared({ home, fetch: f, platform: 'linux', arch: 'x64', which: () => null, version: async () => '2026.9.0' });
    expect(seen[1]).toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
    expect(info.managed).toBe(true);
    // Settings must not claim a checksum it could not check
    expect(info.verified).toBe(false);
  });
});

describe('cloudflared output', () => {
  test('finds the quick tunnel address in the boxed line and nowhere else', () => {
    expect(quickUrlIn('INF |  https://sea-river-cloud.trycloudflare.com                   |')).toBe('https://sea-river-cloud.trycloudflare.com');
    expect(quickUrlIn('INF see https://www.cloudflare.com/website-terms/')).toBeUndefined();
    // where cloudflared asks for an address, named in its errors, is not one
    expect(quickUrlIn('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host')).toBeUndefined();
  });

  test('a runner is ready once Cloudflare registered a connection', async () => {
    const { spawn, procs } = fakeCloudflared();
    const r = new TunnelRunner({ bin: 'cloudflared', args: ['tunnel', '--url', 'http://127.0.0.1:1'], spawn, expectUrl: true });
    const exits: string[] = [];
    r.events.onExit = (_c, why) => exits.push(why);
    const { url } = await r.start();
    expect(url).toBe('https://tunnel-1-words.trycloudflare.com');
    procs[0].line('ERR the process is going away');
    await Bun.sleep(5);
    procs[0].exit(1);
    await until(() => exits.length, 1000, 'exit');
    expect(exits[0]).toContain('going away');
  });

  test('exit before the tunnel is up is an error with what cloudflared said', async () => {
    const { spawn, procs } = fakeCloudflared({ auto: false });
    const r = new TunnelRunner({ bin: 'cloudflared', args: ['tunnel', '--url', 'x'], spawn, expectUrl: true });
    const p = r.start();
    procs[0].line('ERR failed to dial edge: no route to host');
    await Bun.sleep(5);
    procs[0].exit(1);
    const err = await p.catch((e) => e);
    expect(err.message).toContain('no route to host');
  });

  test('a rate limited quick tunnel says to wait', async () => {
    const { spawn, procs } = fakeCloudflared({ auto: false });
    const r = new TunnelRunner({ bin: 'cloudflared', args: ['tunnel', '--url', 'x'], spawn, expectUrl: true });
    const p = r.start();
    procs[0].line('ERR failed to request quick Tunnel: 429 Too Many Requests');
    const err = await p.catch((e) => e);
    expect(err.message).toContain('Wait a few minutes');
    expect(procs[0].killed).toBe(true);
  });

  test('no internet says so, in words', async () => {
    const { spawn, procs } = fakeCloudflared({ auto: false });
    const r = new TunnelRunner({ bin: 'cloudflared', args: ['tunnel', '--url', 'x'], spawn, expectUrl: true });
    const p = r.start();
    procs[0].line('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com on 8.8.8.8:53: no such host');
    const err = await p.catch((e) => e);
    expect(err.message).toBe('cloudflared could not reach Cloudflare (dial tcp: lookup api.trycloudflare.com on 8.8.8.8:53: no such host). Check that the hub has internet access and working DNS.');
  });

  test('stop() does not count as a crash', async () => {
    const { spawn } = fakeCloudflared();
    const r = new TunnelRunner({ bin: 'cloudflared', args: ['tunnel', 'run'], spawn, expectUrl: false });
    let crashed = false;
    r.events.onExit = () => (crashed = true);
    await r.start();
    await r.stop();
    await Bun.sleep(10);
    expect(crashed).toBe(false);
  });
});

describe('failure guard', () => {
  test('blocks after the limit, then longer each time', () => {
    const g = new FailureGuard({ limit: 3, windowMs: 60_000, blockMs: 1_000, maxBlockMs: 4_000 });
    const t = 1_000_000;
    expect([g.fail('a', t), g.fail('a', t)]).toEqual([0, 0]);
    expect(g.fail('a', t)).toBe(1);
    expect(g.blocked('a', t + 500)).toBe(1);
    expect(g.blocked('a', t + 1_001)).toBe(0);
    for (let i = 0; i < 2; i++) g.fail('a', t + 2_000);
    expect(g.fail('a', t + 2_000)).toBe(2);
    for (let i = 0; i < 2; i++) g.fail('a', t + 5_000);
    expect(g.fail('a', t + 5_000)).toBe(4);
    for (let i = 0; i < 2; i++) g.fail('a', t + 10_000);
    expect(g.fail('a', t + 10_000)).toBe(4);
    expect(g.blocked('b', t)).toBe(0);
  });

  test('the same wrong value again counts once, so an app with an old token cannot lock out its network', () => {
    const g = new FailureGuard({ limit: 3, windowMs: 60_000, blockMs: 1_000, maxBlockMs: 4_000 });
    const t = 1_000_000;
    for (let i = 0; i < 50; i++) expect(g.fail('home', t + i, 'old-token')).toBe(0);
    expect(g.failures('home', t + 50)).toBe(1);
    // guesses differ each time, and each one counts
    expect([g.fail('home', t + 60, 'g1'), g.fail('home', t + 61, 'g2')]).toEqual([0, 1]);
    // after the window the old token counts again, once
    expect(g.fail('home', t + 70_000, 'old-token')).toBe(0);
    expect(g.failures('home', t + 70_000)).toBe(1);
  });
});

describe('cloudflared process', () => {
  test('runs without Conclave secrets or settings that would change the tunnel', () => {
    const env = cloudflaredEnv(
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy:3128',
        CONCLAVE_TOKEN: 'owner',
        ANTHROPIC_API_KEY: 'sk-ant',
        GITHUB_TOKEN: 'ghp',
        TUNNEL_TOKEN: 'someone-elses-tunnel',
        TUNNEL_LOGLEVEL: 'warn',
        TUNNEL_URL: 'http://127.0.0.1:1',
        TUNNEL_TRANSPORT_PROTOCOL: 'http2',
        UNSET: undefined,
      },
      { HOME: '/hub/cloudflared' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:3128', TUNNEL_TRANSPORT_PROTOCOL: 'http2', HOME: '/hub/cloudflared' });
    // stable mode hands its own token over explicitly
    expect(cloudflaredEnv({ TUNNEL_TOKEN: 'x' }, { TUNNEL_TOKEN: 'ours' })).toEqual({ TUNNEL_TOKEN: 'ours' });
  });

  test('a hub that died leaves a pid file; the next start stops only the cloudflared it names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-pids-'));
    try {
      const file = join(dir, 'pids');
      const first = new PidFile(file);
      first.add(4101);
      first.add(4102);
      first.add(4103);
      first.remove(4103);
      // the hub was killed here; a new one starts
      const killed: number[] = [];
      const next = new PidFile(file);
      const stopped = next.reap({ isOurs: (pid) => pid === 4101, kill: (pid) => killed.push(pid) });
      expect(stopped).toEqual([4101]);
      expect(killed).toEqual([4101]);
      // 4102 is some other program now: untouched, and forgotten
      expect(new PidFile(file).reap({ isOurs: () => true, kill: () => killed.push(-1) })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the runner reports its pid while cloudflared runs', async () => {
    const { spawn, procs } = fakeCloudflared();
    const seen: string[] = [];
    const withPid: Spawner = (cmd, env) => Object.assign(spawn(cmd, env), { pid: 777 });
    const r = new TunnelRunner({ bin: 'cloudflared', args: ['tunnel', '--url', 'http://127.0.0.1:1'], spawn: withPid, expectUrl: true, pids: { add: (p) => seen.push(`+${p}`), remove: (p) => seen.push(`-${p}`) } });
    await r.start();
    expect(seen).toEqual(['+777']);
    procs[0].exit(1);
    await until(() => seen.length === 2, 1000, 'pid removed');
    expect(seen).toEqual(['+777', '-777']);
  });
});

describe('tailscale', () => {
  test('reads the MagicDNS name of a running node', () => {
    expect(parseTailscale(undefined, 7717)).toEqual({ installed: false, running: false, command: 'tailscale serve --bg 7717' });
    const info = parseTailscale(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'madx.tail4e2a.ts.net.' } }), 7717);
    expect(info).toMatchObject({ installed: true, running: true, dnsName: 'madx.tail4e2a.ts.net', url: 'https://madx.tail4e2a.ts.net' });
    expect(parseTailscale(JSON.stringify({ BackendState: 'NeedsLogin' }), 7717).url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Through the real server
// ---------------------------------------------------------------------------

describe('remote access on a hub', () => {
  let hub: TestHub;
  let cf: ReturnType<typeof fakeCloudflared>;
  const status = (): Promise<RemoteStatus> => hub.api('/api/remote').then((r) => r.json());

  beforeAll(() => {
    cf = fakeCloudflared();
    // host undefined: the hub picks its own listen address, as it does for a real owner
    hub = startHub({ host: undefined, remote: { spawn: cf.spawn, binary, interfaces: () => IFACES, container: false, graceMs: 80, backoffMs: [20] } });
  });
  afterAll(() => hub.stop());

  test('starts off, on the same network, with the LAN address in pairing codes', async () => {
    const s = await status();
    expect(s.mode).toBe('off');
    expect(s.state).toBe('off');
    expect(s.lan).toEqual({ on: true, listening: true });
    const port = new URL(hub.url).port;
    expect(s.addresses).toEqual([{ url: `http://192.168.1.20:${port}`, kind: 'lan', label: 'Wi-Fi 192.168.1.20' }]);
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    expect(pairing.url).toBe(`http://192.168.1.20:${port}`);
    // the best address is the hub's public URL while it runs (hub info, notification links), never saved to config.json
    expect(hub.engine.config.get().server.publicUrl).toBe(`http://192.168.1.20:${port}`);
    expect(hub.engine.config.getUser().server?.publicUrl).toBeUndefined();
  });

  test('quick mode: downloads nothing it has, runs cloudflared, announces the address', async () => {
    const ws = await openWs(`${hub.url.replace('http', 'ws')}/api/ws?token=${OWNER}`);
    const put = await hub.api('/api/remote', { method: 'PUT', json: { mode: 'quick' } });
    expect(put.status).toBe(200);
    const on = await ws.next((f) => f.type === 'remote.updated' && f.remote.state === 'on');
    const url = on.remote.url as string;
    expect(url).toMatch(/^https:\/\/tunnel-\d+-words\.trycloudflare\.com$/);
    expect(on.remote.addresses[0]).toEqual({ url, kind: 'quick', label: 'Cloudflare quick tunnel' });
    expect(on.remote.addresses[1].kind).toBe('lan');
    const proc = cf.procs.at(-1)!;
    expect(proc.cmd).toEqual(['/opt/fake/cloudflared', 'tunnel', '--config', expect.stringContaining('cloudflared'), '--no-autoupdate', '--url', `http://127.0.0.1:${new URL(hub.url).port}`]);
    // the owner's ~/.cloudflared stays out of it
    expect(proc.env.HOME).toContain('cloudflared');
    // pairing codes, links and hub info use the tunnel; the LAN address rides along as alt
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    expect(pairing.url).toBe(url);
    expect(pairing.deepLink).toContain(`url=${encodeURIComponent(url)}`);
    expect(pairing.deepLink).toContain(`&alt=${encodeURIComponent(`http://192.168.1.20:${new URL(hub.url).port}`)}`);
    expect(pairing.addresses).toHaveLength(2);
    expect(hub.engine.config.get().server.publicUrl).toBe(url);
    // the tunnel's origin may call the API
    const pre = await fetch(`${hub.url}/api/info`, { method: 'OPTIONS', headers: { origin: url, 'access-control-request-method': 'GET' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe(url);
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.some((a: { action: string }) => a.action === 'remote.on')).toBe(true);
    ws.close();
  });

  test('a new address is announced before the old tunnel stops', async () => {
    const before = await status();
    const oldProc = cf.procs.at(-1)!;
    const ws = await openWs(`${hub.url.replace('http', 'ws')}/api/ws?token=${OWNER}`);
    const res = await hub.api('/api/remote/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    const moved = await ws.next((f) => f.type === 'remote.updated' && f.remote.url && f.remote.url !== before.url);
    expect(moved.remote.previousUrl).toBe(before.url);
    expect(moved.remote.state).toBe('on');
    // still serving while clients move
    expect(oldProc.killed).toBe(false);
    await until(() => oldProc.killed, 2000, 'old tunnel stopped after the grace period');
    ws.close();
  });

  test('cloudflared dying is noticed, and a new tunnel starts', async () => {
    const before = await status();
    const proc = cf.procs.at(-1)!;
    const ws = await openWs(`${hub.url.replace('http', 'ws')}/api/ws?token=${OWNER}`);
    proc.exit(1);
    const down = await ws.next((f) => f.type === 'remote.updated' && f.remote.state === 'starting');
    expect(down.remote.detail).toContain('address will change');
    expect(down.remote.addresses.map((a: { kind: string }) => a.kind)).toEqual(['lan']);
    const back = await ws.next((f) => f.type === 'remote.updated' && f.remote.state === 'on', 4000);
    expect(back.remote.url).not.toBe(before.url);
    expect(back.remote.previousUrl).toBe(before.url);
    ws.close();
  });

  test('daemons get the address list after welcome and when it changes', async () => {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    const reg = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: pairing.code, name: 'pc' } }).then((r) => r.json());
    expect(reg.addresses[0]).toBe((await status()).url);
    const frames: any[] = [];
    const ws = new WebSocket(`${hub.url.replace('http', 'ws')}/api/daemon?deviceId=${reg.deviceId}`, { headers: { authorization: `Bearer ${reg.token}` } } as any);
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: 'hello', version: 1, deviceId: reg.deviceId, info: { hostname: 'pc', platform: 'linux', arch: 'x64', home: '/home/me', shell: 'bash', clis: {}, capabilities: [] } }));
    await until(() => frames.find((f) => f.type === 'addresses'), 2000, 'addresses frame');
    const first = frames.find((f) => f.type === 'addresses');
    expect(first.urls[0]).toMatch(/trycloudflare\.com$/);
    await hub.api('/api/remote/restart', { method: 'POST' });
    await until(() => frames.filter((f) => f.type === 'addresses').length >= 2, 2000, 'second addresses frame');
    const second = frames.filter((f) => f.type === 'addresses')[1];
    expect(second.urls[0]).not.toBe(first.urls[0]);
    ws.close();
  });

  test('same network off: no LAN address, and only this computer and the tunnel are answered', async () => {
    await hub.api('/api/remote', { method: 'PUT', json: { lan: false } });
    const s = await status();
    expect(s.lan.on).toBe(false);
    expect(s.addresses.map((a) => a.kind)).toEqual(['quick']);
    const remote = hub.running.conclave.ctx.remote;
    expect(remote.allowPeer('127.0.0.1')).toBe(true);
    expect(remote.allowPeer('192.168.1.30')).toBe(false);
    await hub.api('/api/remote', { method: 'PUT', json: { lan: true } });
    expect(remote.allowPeer('192.168.1.30')).toBe(true);
    // the internet never reaches the hub directly, only through the tunnel
    expect(remote.allowPeer('203.0.113.4')).toBe(false);
  });

  test('my own URL: saved as server.publicUrl, listed before the network', async () => {
    const quickProc = cf.procs.at(-1)!;
    const bad = await hub.api('/api/remote', { method: 'PUT', json: { mode: 'custom', url: 'not a url' } });
    expect(bad.status).toBe(400);
    const s = await hub.api('/api/remote', { method: 'PUT', json: { mode: 'custom', url: 'https://hub.example.com/' } }).then((r) => r.json());
    expect(s).toMatchObject({ mode: 'custom', state: 'on', url: 'https://hub.example.com' });
    expect(s.addresses.map((a: { kind: string }) => a.kind)).toEqual(['own', 'lan']);
    const cfg = await hub.api('/api/config').then((r) => r.json());
    expect(cfg.user.server.publicUrl).toBe('https://hub.example.com');
    await until(() => quickProc.killed, 2000, 'quick tunnel stopped');
    // local only forgets nothing but uses none of it
    const off = await hub.api('/api/remote', { method: 'PUT', json: { mode: 'off', url: null } }).then((r) => r.json());
    expect(off.state).toBe('off');
    expect(off.addresses.map((a: { kind: string }) => a.kind)).toEqual(['lan']);
    expect((await hub.api('/api/config').then((r) => r.json())).user.server.publicUrl).toBeUndefined();
  });

  test('custom without an address says what to type', async () => {
    const r = await hub.api('/api/remote', { method: 'PUT', json: { mode: 'custom' } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('https://hub.example.com');
    expect((await hub.api('/api/remote', { method: 'PUT', json: { mode: 'sideways' } })).status).toBe(400);
    expect((await hub.api('/api/remote', { method: 'PUT', json: { mode: 'stable' } })).status).toBe(409);
  });
});

describe('stable mode through the Cloudflare API', () => {
  let hub: TestHub;
  let cf: ReturnType<typeof fakeCloudflared>;
  const calls: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
  let refuse = false;

  const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace('/client/v4', '') + u.search;
    const method = init?.method ?? 'GET';
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth });
    if (refuse) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }, { status: 403 });
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (method === 'GET' && path === '/zones?per_page=50') return ok([{ id: 'z1', name: 'example.com', status: 'active', account: { id: 'acc1', name: 'Kai' } }]);
    if (method === 'GET' && path === '/zones/z1') return ok({ id: 'z1', name: 'example.com', account: { id: 'acc1', name: 'Kai' } });
    if (method === 'GET' && path.startsWith('/accounts/acc1/cfd_tunnel?')) return ok([]);
    if (method === 'POST' && path === '/accounts/acc1/cfd_tunnel') return ok({ id: 'tun1', name: init?.body ? JSON.parse(String(init.body)).name : '' });
    if (method === 'PUT' && path === '/accounts/acc1/cfd_tunnel/tun1/configurations') return ok({});
    if (method === 'GET' && path.startsWith('/zones/z1/dns_records?')) return ok([]);
    if (method === 'POST' && path === '/zones/z1/dns_records') return ok({ id: 'rec1' });
    if (method === 'GET' && path === '/accounts/acc1/cfd_tunnel/tun1/token') return ok('eyJ0dW5uZWwtdG9rZW4');
    if (method === 'DELETE') return ok({});
    return Response.json({ success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }], result: null }, { status: 404 });
  }) as typeof fetch;

  beforeAll(() => {
    cf = fakeCloudflared();
    hub = startHub({ remote: { spawn: cf.spawn, binary, fetch: api, interfaces: () => ({}), graceMs: 50, backoffMs: [20] } });
  });
  afterAll(() => hub.stop());

  test('a refused token says how to make one', async () => {
    refuse = true;
    const r = await hub.api('/api/remote/cloudflare', { method: 'POST', json: { token: 'x'.repeat(40) } });
    refuse = false;
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('Cloudflare Tunnel, Edit');
    expect((await hub.api('/api/remote').then((x) => x.json())).cloudflareToken).toBe(false);
  });

  test('token, zone, name: makes the tunnel and the DNS name, runs it with the tunnel token', async () => {
    calls.length = 0;
    const zones = await hub.api('/api/remote/cloudflare', { method: 'POST', json: { token: 'cf-token-0123456789abcdefghij' } }).then((r) => r.json());
    expect(zones.zones).toEqual([{ id: 'z1', name: 'example.com', accountId: 'acc1', accountName: 'Kai' }]);
    const cfg = await hub.api('/api/config').then((r) => r.json());
    expect(cfg.secrets.values).toContain('cloudflare.apiToken');
    // the token is never sent back
    expect(JSON.stringify(cfg)).not.toContain('cf-token-0123456789abcdefghij');

    const res = await hub.api('/api/remote/stable', { method: 'POST', json: { zoneId: 'z1', name: 'Hub' } });
    expect(res.status).toBe(200);
    const s = await until(async () => {
      const x = await hub.api('/api/remote').then((r) => r.json());
      return x.state === 'on' && x;
    }, 3000, 'stable on');
    expect(s).toMatchObject({ mode: 'stable', url: 'https://hub.example.com', stable: { hostname: 'hub.example.com', zone: 'example.com' } });
    expect(calls.every((c) => c.auth === 'Bearer cf-token-0123456789abcdefghij')).toBe(true);
    const ingress = calls.find((c) => c.path.endsWith('/configurations'))!.body.config.ingress;
    expect(ingress[0]).toEqual({ hostname: 'hub.example.com', service: `http://127.0.0.1:${new URL(hub.url).port}` });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/zones/z1/dns_records')!.body).toMatchObject({ type: 'CNAME', name: 'hub.example.com', content: 'tun1.cfargotunnel.com', proxied: true });
    const proc = cf.procs.at(-1)!;
    expect(proc.cmd.slice(-1)).toEqual(['run']);
    // the tunnel token rides in the environment, not the command line
    expect(proc.env.TUNNEL_TOKEN).toBe('eyJ0dW5uZWwtdG9rZW4');
    expect(proc.cmd.join(' ')).not.toContain('eyJ0dW5uZWwtdG9rZW4');
  });

  test('remove deletes the tunnel and DNS name at Cloudflare and forgets the token', async () => {
    const proc = cf.procs.at(-1)!;
    const s = await hub.api('/api/remote/stable', { method: 'DELETE' }).then((r) => r.json());
    expect(s.mode).toBe('off');
    expect(s.stable).toBeUndefined();
    expect(s.cloudflareToken).toBe(false);
    expect(proc.killed).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/zones/z1/dns_records/rec1')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/accounts/acc1/cfd_tunnel/tun1')).toBe(true);
  });
});

describe('the stable DNS name', () => {
  const dnsApi = (records: Array<{ id: string; type: string; content: string; comment?: string }>) => {
    const writes: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Response.json({ success: true, result: records });
      writes.push(`${method} ${u.pathname.replace('/client/v4', '')}`);
      return Response.json({ success: true, result: { id: 'rec-new' } });
    }) as typeof fetch;
    return { api: new CloudflareApi('t'.repeat(40), f), writes };
  };

  test('replaces only a record this tunnel or Conclave made', async () => {
    const same = dnsApi([{ id: 'r1', type: 'CNAME', content: 'tun1.cfargotunnel.com' }]);
    expect(await same.api.upsertCname('z1', 'hub.example.com', 'tun1')).toBe('rec-new');
    expect(same.writes).toEqual(['PUT /zones/z1/dns_records/r1']);
    // an old record of ours that points at a tunnel since deleted
    const mine = dnsApi([{ id: 'r2', type: 'CNAME', content: 'dead.cfargotunnel.com', comment: 'Conclave hub' }]);
    await mine.api.upsertCname('z1', 'hub.example.com', 'tun1');
    expect(mine.writes).toEqual(['PUT /zones/z1/dns_records/r2']);
  });

  test("leaves the owner's other tunnel and records alone", async () => {
    for (const rec of [
      { id: 'r3', type: 'CNAME', content: 'other-app.cfargotunnel.com' },
      { id: 'r4', type: 'A', content: '203.0.113.9' },
    ]) {
      const other = dnsApi([rec]);
      const err = await other.api.upsertCname('z1', 'hub.example.com', 'tun1').catch((e) => e);
      expect(err).toBeInstanceOf(CloudflareError);
      expect(err.message).toContain('Pick another name');
      expect(other.writes).toEqual([]);
    }
  });
});

describe('a public address is guarded', () => {
  let hub: TestHub;
  beforeAll(() => {
    hub = startHub({}, { providers: { openai: { type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'CONCLAVE_TEST_NO_SUCH_KEY' } } } as never);
  });

  test('the gateway does not relay internet calls without a gateway key', async () => {
    const call = (xff?: string) =>
      hub.api('/gw/openai/chat/completions', { method: 'POST', token: 'sk-someone-elses-key', json: { model: 'gpt-5.5', messages: [] }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    const remote = await call('203.0.113.50');
    expect(remote.status).toBe(401);
    expect(JSON.stringify(await remote.json())).toContain('remote address need a gateway key');
    // the same network still relays (here it fails upstream, which is past the key check)
    expect((await call('192.168.1.40')).status).not.toBe(401);
  });
  afterAll(() => hub.stop());

  test('an app retrying one old token does not block its address', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < 40; i++) expect((await hub.api('/api/sessions', { token: 'ccl_old-token', headers: { 'x-forwarded-for': ip } })).status).toBe(401);
    expect((await hub.api('/api/sessions', { headers: { 'x-forwarded-for': ip } })).status).toBe(200);
  });

  test('a proxied request cannot claim to be this machine to skip the limit', async () => {
    let status = 0;
    for (let i = 0; i < 21; i++) status = (await hub.api('/api/sessions', { token: `guess-${i}`, headers: { 'x-forwarded-for': '127.0.0.1' } })).status;
    expect(status).toBe(429);
    for (let i = 0; i < 21; i++) status = (await hub.api('/api/sessions', { token: `guess-${i}`, headers: { 'cf-connecting-ip': '127.0.0.1' } })).status;
    expect(status).toBe(429);
    // this machine with no proxy in front is still never blocked
    expect((await hub.api('/api/sessions')).status).toBe(200);
  });

  test('wrong tokens from one address block it, longer each time, and it is audited', async () => {
    const ip = '198.51.100.7';
    let status = 0;
    for (let i = 0; i < 20; i++) {
      // the first entry is what the client claims; the last is what the proxy saw
      status = (await hub.api('/api/sessions', { token: `wrong-token-${i}`, headers: { 'x-forwarded-for': `10.9.9.${i}, ${ip}` } })).status;
    }
    expect(status).toBe(401);
    const blocked = await hub.api('/api/sessions', { token: OWNER, headers: { 'x-forwarded-for': ip } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toContain('Try again in');
    // others are fine, and so is this machine
    expect((await hub.api('/api/sessions', { headers: { 'x-forwarded-for': '198.51.100.8' } })).status).toBe(200);
    expect((await hub.api('/api/sessions')).status).toBe(200);
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.find((a: { action: string }) => a.action === 'auth.blocked')).toMatchObject({ actor: `ip:${ip}` });
  });

  test('pairing codes work once, and wrong ones are audited', async () => {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const ok = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'phone' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).addresses).toEqual([hub.url]);
    const again = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'phone' } });
    expect(again.status).toBe(400);
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.some((a: { action: string }) => a.action === 'pair.failed')).toBe(true);
  });
});

describe('a code shown before remote access was set', () => {
  let hub: TestHub;
  beforeAll(() => {
    hub = startHub({ host: undefined, remote: { spawn: fakeCloudflared().spawn, binary, interfaces: () => IFACES, container: false, graceMs: 80, backoffMs: [20] } });
  });
  afterAll(() => hub.stop());

  test('the same code comes back with the address the hub has now', async () => {
    // found in a real setup: the QR was made on the same network, then the owner added their URL, and the old QR kept only the LAN address
    const lan = `http://192.168.1.20:${new URL(hub.url).port}`;
    const first = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    expect(first.addresses).toEqual([lan]);
    await hub.api('/api/remote', { method: 'PUT', json: { mode: 'custom', url: 'https://hub.example.com' } });
    const again = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client', code: first.code } }).then((r) => r.json());
    expect(again.code).toBe(first.code);
    expect(again.expiresAt).toBe(first.expiresAt);
    // own URL first, the same network after it (docs/INSTALL.md 2)
    expect(again.addresses).toEqual(['https://hub.example.com', lan]);
    expect(again.deepLink).toContain(`url=${encodeURIComponent('https://hub.example.com')}`);
    expect(again.deepLink).toContain(`&alt=${encodeURIComponent(lan)}`);
    expect(again.qrSvg).not.toBe(first.qrSvg);
    // one code made, not two
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.filter((a: { action: string }) => a.action === 'pairing.create').length).toBe(1);
    // and it still pairs, once
    expect((await hub.api('/api/pair', { method: 'POST', token: null, json: { code: first.code, name: 'phone', platform: 'android' } })).status).toBe(200);
  });

  test('a used code, or one of another kind, gets a new code instead', async () => {
    const used = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    await hub.api('/api/pair', { method: 'POST', token: null, json: { code: used.code, name: 'phone' } });
    const after = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client', code: used.code } }).then((r) => r.json());
    expect(after.code).not.toBe(used.code);
    const device = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    const asClient = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client', code: device.code } }).then((r) => r.json());
    expect(asClient.code).not.toBe(device.code);
    expect((await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client', code: 5 } })).status).toBe(400);
  });
});
