/**
 * Subscription sign-in through CLIProxyAPI, against a fake CLIProxyAPI
 * (fixtures/fake-cliproxy.ts) and a fake release served from 127.0.0.1 with
 * its own checksums file. Nothing here reaches GitHub or a provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubscriptionsStatus } from '@conclave/core/client/index.ts';
import { ProviderRegistry } from '@conclave/core/providers/registry.ts';
import { CliproxyManager, cleanRoot, pastedCallback } from '../src/cliproxy';
import { cliproxyEnv, renderConfig } from '../src/cliproxy/config';
import { ReleaseError, assetFor, compareVersions, installRelease, parseChecksums, parseVersion, pinFor, type Pin } from '../src/cliproxy/release';
import { isProblem, message, scrub, type CliProcess, type CliSpawner } from '../src/cliproxy/runner';
import { PidFile, processMatches } from '../src/remote/pids';
import { OWNER, startHub, type TestHub } from './helpers';
import { createFakeEngine } from './fake-engine';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-cliproxy.ts');
const BUN = process.execPath;
const scratch = mkdtempSync(join(tmpdir(), 'conclave-cpa-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function freePort(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
}

// ---------------------------------------------------------------------------
// A fake release: ELF-headed "programs" whose JSON says which fake to be
// ---------------------------------------------------------------------------

const SIZE = 4 * 1024 * 1024 + 4096;
interface Meta {
  version: string;
  crash?: boolean;
}

function program(meta: Meta, elf = true): Uint8Array {
  // random filler: a real build does not compress to nothing, and the hub checks the archive size
  const b = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i += 65_536) crypto.getRandomValues(b.subarray(i, Math.min(SIZE, i + 65_536)));
  b.set(elf ? [0x7f, 0x45, 0x4c, 0x46] : [0x3c, 0x21, 0x44, 0x4f]);
  b.set(new TextEncoder().encode(`${JSON.stringify(meta)}\n`), 4);
  return b;
}

function readMeta(path: string): Meta {
  const head = readFileSync(path).subarray(4, 512);
  return JSON.parse(new TextDecoder().decode(head).split('\n')[0]) as Meta;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const asset = (v: string) => assetFor(v, 'linux', 'x64')!.name;

/** A tar.gz with cli-proxy-api in it. */
async function archive(meta: Meta, elf = true): Promise<Uint8Array> {
  const dir = mkdtempSync(join(scratch, 'pkg-'));
  writeFileSync(join(dir, 'cli-proxy-api'), program(meta, elf), { mode: 0o755 });
  writeFileSync(join(dir, 'LICENSE'), 'MIT\n');
  const out = join(dir, 'a.tar.gz');
  const p = Bun.spawn(['tar', '-czf', out, '-C', dir, 'cli-proxy-api', 'LICENSE'], { stdout: 'ignore', stderr: 'ignore' });
  await p.exited;
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Serves /<tag>/<asset> and /<tag>/checksums.txt from `files`; checksums can be overridden. */
function releaseServer() {
  const files = new Map<string, Uint8Array>();
  const sums = new Map<string, string>();
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      const m = /^\/(v[^/]+)\/(.+)$/.exec(path);
      if (!m) return new Response('no', { status: 404 });
      if (m[2] === 'checksums.txt') {
        if (sums.has(m[1])) return new Response(sums.get(m[1]));
        const lines = [...files.entries()].filter(([k]) => k.startsWith(`${m[1]}/`)).map(([k, v]) => `${sha(v)}  ${k.slice(m[1].length + 1)}`);
        return new Response(lines.join('\n') + '\n');
      }
      const b = files.get(`${m[1]}/${m[2]}`);
      return b ? new Response(b as unknown as BodyInit, { headers: { 'content-length': String(b.byteLength) } }) : new Response('no', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, files, sums, seen, stop: () => server.stop(true) };
}

async function publish(rel: ReturnType<typeof releaseServer>, meta: Meta, opts: { elf?: boolean } = {}): Promise<Pin> {
  const bytes = await archive(meta, opts.elf ?? true);
  const name = asset(meta.version);
  rel.files.set(`v${meta.version}/${name}`, bytes);
  return { version: meta.version, tag: `v${meta.version}`, providers: ['claude', 'codex', 'antigravity', 'xai', 'kimi', 'meta'], assets: { [name]: { sha256: sha(bytes), size: bytes.byteLength } } };
}

/** Runs the fake CLIProxyAPI for any "program" the hub starts; records each start. */
function fakeSpawner(extra: () => Record<string, string>) {
  const starts: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  const spawn: CliSpawner = (cmd, opts) => {
    starts.push({ cmd, env: opts.env });
    const meta = readMeta(cmd[0]);
    const proc = Bun.spawn([BUN, FAKE, ...cmd.slice(1)], {
      cwd: opts.cwd,
      env: { ...opts.env, ...extra(), FAKE_CPA_VERSION: meta.version, FAKE_CPA_CRASH: meta.crash ? '1' : '' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return proc as unknown as CliProcess;
  };
  return { spawn, starts };
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe('release names, checksums and versions', () => {
  test('picks the release archive for each OS and CPU', () => {
    expect(assetFor('8.0.32', 'linux', 'x64')?.name).toBe('CLIProxyAPI_8.0.32_linux_amd64_no-plugin.tar.gz');
    expect(assetFor('8.0.32', 'linux', 'arm64')?.name).toBe('CLIProxyAPI_8.0.32_linux_aarch64_no-plugin.tar.gz');
    expect(assetFor('8.0.32', 'darwin', 'arm64')?.name).toBe('CLIProxyAPI_8.0.32_darwin_aarch64.tar.gz');
    expect(assetFor('8.0.32', 'win32', 'x64')).toEqual({ name: 'CLIProxyAPI_8.0.32_windows_amd64.zip', kind: 'zip', binary: 'cli-proxy-api.exe' });
    expect(assetFor('8.0.32', 'freebsd', 'x64')).toBeUndefined();
    expect(assetFor('8.0.32', 'linux', 'ia32')).toBeUndefined();
  });

  test('reads checksums.txt, the version line and compares versions', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  CLIProxyAPI_8.0.32_linux_amd64_no-plugin.tar.gz\n${'B'.repeat(64)}  checksums-of-something.zip\ngarbage line\n`);
    expect(sums.get('CLIProxyAPI_8.0.32_linux_amd64_no-plugin.tar.gz')).toBe('a'.repeat(64));
    expect(sums.get('checksums-of-something.zip')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
    expect(parseVersion('CLIProxyAPI Version: 8.0.32, Commit: 911f49c, BuiltAt: 2026-10-17')).toBe('8.0.32');
    expect(parseVersion('Usage of cli-proxy-api')).toBeUndefined();
    expect(compareVersions('8.0.10', '8.0.9')).toBe(1);
    expect(compareVersions('v8.0.32', '8.0.32')).toBe(0);
    const pins = [{ version: '8.0.31' }, { version: '8.0.32' }] as Pin[];
    expect(pinFor('8.0.40', pins).version).toBe('8.0.32');
    expect(pinFor('8.0.31', pins).version).toBe('8.0.31');
    expect(pinFor(undefined, pins).version).toBe('8.0.32');
  });

  test('the config listens on 127.0.0.1, keeps management local and holds only the hash of its key', () => {
    const yaml = renderConfig({ port: 41001, managementHash: '$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012', clientKey: 'cpk-client', authDir: '/data/cliproxy/auth' });
    const parsed = Bun.YAML.parse(yaml) as any;
    expect(parsed.server).toEqual({ host: '127.0.0.1', port: 41001, discovery: { enabled: false } });
    expect(parsed.management['allow-remote']).toBe(false);
    expect(parsed.management['secret-key']).toStartWith('$2b$10$');
    expect(parsed.management['disable-control-panel']).toBe(true);
    expect(parsed.access['api-keys']).toEqual(['cpk-client']);
    expect(parsed.oauth['auth-dir']).toBe('/data/cliproxy/auth');
    expect(parsed.plugins.enabled).toBe(false);
    expect(parsed.observability.logs['request-log']).toBe(false);
  });

  test('its environment has none of the hub in it', () => {
    const env = cliproxyEnv({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:3128', LC_ALL: 'C', CONCLAVE_TOKEN: 't', ANTHROPIC_API_KEY: 'k', MANAGEMENT_PASSWORD: 'p', DEPLOY: 'cloud', GITHUB_TOKEN: 'g', HOME: '/root' }, '/h/cliproxy');
    expect(env).toEqual({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:3128', LC_ALL: 'C', HOME: '/h/cliproxy', USERPROFILE: '/h/cliproxy', APPDATA: '/h/cliproxy', LOCALAPPDATA: '/h/cliproxy' });
  });

  test('log lines lose keys and tokens', () => {
    expect(scrub('auth with mgmt-key-1234567890 ok', ['mgmt-key-1234567890'])).toBe('auth with [key] ok');
    expect(scrub('Authorization: Bearer abcdefghijklmnop', [])).toBe('Authorization: Bearer [key]');
    expect(scrub('{"refresh_token":"rt-xyz"}', [])).toBe('{"refresh_token":"[key]"}');
  });

  test('reads CLIProxyAPI 8 log lines (as the real 8.0.32 prints them) and logrus lines', () => {
    const real = '[2026-10-18 07:44:25] [--------] [info ] [gin_logger.go:108] 200 |          77ms |       127.0.0.1 | GET     "/v8/management/plugins"';
    expect(message(real)).toStartWith('200 |');
    expect(isProblem(real)).toBe(false);
    const bad = '[2026-10-18 07:44:25] [--------] [error] [server.go:40] failed to bind 127.0.0.1:8317: address already in use';
    expect(isProblem(bad)).toBe(true);
    expect(message(bad)).toBe('failed to bind 127.0.0.1:8317: address already in use');
    expect(message('time="x" level=fatal msg="failed to start: fake crash"')).toBe('failed to start: fake crash');
    expect(isProblem('time="x" level=fatal msg="y"')).toBe(true);
  });

  test('a pasted address must be the localhost one with a code', () => {
    expect(pastedCallback('localhost:54545/callback?code=abc&state=s1', 's1')).toBe('http://localhost:54545/callback?code=abc&state=s1');
    expect(pastedCallback('http://127.0.0.1:1455/auth/callback?code=x', 's1')).toBe('http://127.0.0.1:1455/auth/callback?code=x');
    expect(() => pastedCallback('https://evil.example/callback?code=x', 's1')).toThrow(/evil\.example/);
    expect(() => pastedCallback('http://localhost:54545/callback', 's1')).toThrow(/no sign-in code/);
    expect(() => pastedCallback('http://localhost:54545/callback?code=x&state=other', 's1')).toThrow(/another sign-in/);
    expect(() => pastedCallback('', 's1')).toThrow(/Paste/);
  });

  test('an external address is cut to its base', () => {
    expect(cleanRoot('http://192.168.1.10:8317/v1/')).toBe('http://192.168.1.10:8317');
    expect(cleanRoot('cpa.lan:8317')).toBe('http://cpa.lan:8317');
    expect(cleanRoot('https://cpa.example.com/proxy')).toBe('https://cpa.example.com/proxy');
    expect(cleanRoot('http://x:1/?a=b')).toBeUndefined();
    expect(cleanRoot('ftp://x')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Download and checks
// ---------------------------------------------------------------------------

describe('installing the pinned release', () => {
  const rel = releaseServer();
  afterAll(() => rel.stop());
  const probe = async (p: string) => readMeta(p).version;
  let n = 0;
  const home = () => mkdtempSync(join(scratch, `home-${n++}-`));

  test('downloads into <home>/bin, checks size and SHA-256 against checksums.txt and the pin, and keeps a receipt', async () => {
    const pin = await publish(rel, { version: '8.0.40' });
    const h = home();
    const ran: string[] = [];
    const info = await installRelease({ home: h, pin, base: rel.url, platform: 'linux', arch: 'x64', probe: async (p) => (ran.push(p), probe(p)) });
    expect(info).toMatchObject({ path: join(h, 'bin', 'cli-proxy-api'), version: '8.0.40', managed: true, verified: true });
    expect(statSync(info.path).mode & 0o111).toBeTruthy();
    expect(readdirSync(join(h, 'bin')).sort()).toEqual(['cli-proxy-api', 'cli-proxy-api.json']);
    expect(JSON.parse(readFileSync(join(h, 'bin', 'cli-proxy-api.json'), 'utf8'))).toMatchObject({ version: '8.0.40', checks: { checksums: true, pin: true } });
    // it ran only from next to its final place, never from a temp folder
    expect(ran).toEqual([join(h, 'bin', 'cli-proxy-api.new')]);
    expect(rel.seen).toContain('/v8.0.40/checksums.txt');
  });

  test('refuses an archive the checksums file does not vouch for, and leaves nothing', async () => {
    const pin = await publish(rel, { version: '8.0.41' });
    rel.sums.set('v8.0.41', `${'c'.repeat(64)}  ${asset('8.0.41')}\n`);
    const h = home();
    const err = await installRelease({ home: h, pin: { ...pin, assets: {} }, base: rel.url, platform: 'linux', arch: 'x64', probe }).catch((e) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect(err.message).toContain('does not match the checksum its release publishes');
    expect(readdirSync(join(h, 'bin'))).toEqual([]);
  });

  test('refuses a checksums file that disagrees with the pin', async () => {
    const pin = await publish(rel, { version: '8.0.42' });
    rel.sums.set('v8.0.42', `${'d'.repeat(64)}  ${asset('8.0.42')}\n`);
    const err = await installRelease({ home: home(), pin, base: rel.url, platform: 'linux', arch: 'x64', probe }).catch((e) => e);
    expect(err.message).toContain('does not match the checksum this hub pins');
  });

  test('refuses the wrong size, something that is not a program, and the wrong version', async () => {
    const pin = await publish(rel, { version: '8.0.43' });
    const wrongSize = { ...pin, assets: { [asset('8.0.43')]: { ...pin.assets[asset('8.0.43')], size: 999 } } };
    expect((await installRelease({ home: home(), pin: wrongSize, base: rel.url, platform: 'linux', arch: 'x64', probe }).catch((e) => e)).message).toContain('bytes');

    const page = await publish(rel, { version: '8.0.44' }, { elf: false });
    const h = home();
    expect((await installRelease({ home: h, pin: page, base: rel.url, platform: 'linux', arch: 'x64', probe }).catch((e) => e)).message).toContain('not a program');
    expect(readdirSync(join(h, 'bin'))).toEqual([]);

    const liar = await publish(rel, { version: '8.0.45' });
    expect((await installRelease({ home: home(), pin: liar, base: rel.url, platform: 'linux', arch: 'x64', probe: async () => '9.9.9' }).catch((e) => e)).message).toContain('says it is CLIProxyAPI 9.9.9');

    const dead = await publish(rel, { version: '8.0.46' });
    expect((await installRelease({ home: home(), pin: dead, base: rel.url, platform: 'linux', arch: 'x64', probe: async () => undefined }).catch((e) => e)).message).toContain('does not start');
  });

  test('without the checksums file nothing is installed', async () => {
    const pin = await publish(rel, { version: '8.0.47' });
    rel.sums.set('v8.0.47', '');
    const err = await installRelease({ home: home(), pin, base: rel.url, platform: 'linux', arch: 'x64', probe }).catch((e) => e);
    expect(err.message).toContain('does not list');
  });
});

describe('orphans', () => {
  test('a CLIProxyAPI a killed hub left behind is stopped; other processes in the file are not', async () => {
    const dir = mkdtempSync(join(scratch, 'orph-'));
    const config = join(dir, 'cliproxy', 'config.yaml');
    const keep = 'setInterval(() => {}, 1000)';
    const ours = Bun.spawn([BUN, '-e', keep, '--', '-config', config], { stdout: 'ignore', stderr: 'ignore' });
    const other = Bun.spawn([BUN, '-e', keep, '--', '-config', join(dir, 'elsewhere.yaml')], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await until(() => processMatches(ours.pid, (c) => c.includes(config)), 3000, 'the stray to start');
      mkdirSync(join(dir, 'cliproxy'), { recursive: true });
      writeFileSync(join(dir, 'cliproxy', 'pids'), `${ours.pid}\n${other.pid}\n`);
      const pids = new PidFile(join(dir, 'cliproxy', 'pids'));
      const stopped = pids.reap({ isOurs: (pid) => processMatches(pid, (c) => c.includes(config)) });
      expect(stopped).toEqual([ours.pid]);
      expect(await Promise.race([ours.exited.then(() => 'gone'), Bun.sleep(3000).then(() => 'alive')])).toBe('gone');
      expect(processMatches(other.pid, () => true)).toBe(true);
    } finally {
      ours.kill('SIGKILL');
      other.kill('SIGKILL');
    }
  });
});

// ---------------------------------------------------------------------------
// The hub runs it
// ---------------------------------------------------------------------------

const KEYS = /cpk-[A-Za-z0-9_-]{20,}|SECRET/;

describe('builtin: the hub runs CLIProxyAPI', () => {
  const rel = releaseServer();
  const cbPort = freePort();
  const callLog = join(scratch, 'calls.jsonl');
  const pins: Pin[] = [];
  const fake = fakeSpawner(() => ({ FAKE_CPA_CALLBACK_PORT: String(cbPort), FAKE_CPA_LOG: callLog, FAKE_CPA_DEVICE_MS: '200' }));
  let hub: TestHub;
  let events: SubscriptionsStatus[] = [];
  const savedPw = process.env.MANAGEMENT_PASSWORD;
  const api = async (path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}) => {
    const res = await hub.api(path, init);
    const text = await res.text();
    // keys and tokens never reach a client
    expect(text).not.toMatch(KEYS);
    const secrets = [hub.engine.config.expand('${secret:cliproxy.managementKey}'), hub.engine.config.expand('${secret:cliproxy.clientKey}')].filter(Boolean);
    for (const s of secrets) expect(text).not.toContain(s);
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const remote = { 'x-forwarded-for': '203.0.113.9' };
  const status = async (headers: Record<string, string> = {}) => (await api('/api/subscriptions', { headers })).body as SubscriptionsStatus;

  beforeAll(async () => {
    process.env.MANAGEMENT_PASSWORD = 'must-not-reach-cliproxy';
    pins.push(await publish(rel, { version: '8.0.31' }));
    hub = startHub({ cliproxy: { spawn: fake.spawn, pins, releaseBase: rel.url, platform: 'linux', arch: 'x64', backoffMs: [50, 100, 200], readyTimeoutMs: 15_000, credentialsMs: 500, usageMs: [200, 400] } }, { models: { cliproxy: { mode: 'builtin' } } } as any);
    hub.engine.bus.on((e) => {
      if (e.type === 'subscriptions.updated') events.push(e.status);
    });
    await until(async () => (await status()).state === 'on', 20_000, 'CLIProxyAPI on');
  }, 30_000);

  afterAll(async () => {
    if (savedPw === undefined) delete process.env.MANAGEMENT_PASSWORD;
    else process.env.MANAGEMENT_PASSWORD = savedPw;
    await hub.stop();
    rel.stop();
  });

  test('downloads the pin, writes its own config and folders, and runs it on 127.0.0.1', async () => {
    const st = await status();
    expect(st).toMatchObject({ mode: 'builtin', state: 'on', version: '8.0.31', provider: 'cliproxy', management: true, local: true });
    expect(st.binary).toMatchObject({ path: join(hub.engine.home, 'bin', 'cli-proxy-api'), managed: true, verified: true });
    const dir = join(hub.engine.home, 'cliproxy');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'auth')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'config.yaml')).mode & 0o777).toBe(0o600);
    const yaml = readFileSync(join(dir, 'config.yaml'), 'utf8');
    const mk = hub.engine.config.expand('${secret:cliproxy.managementKey}');
    expect(mk.length).toBeGreaterThan(30);
    // only the bcrypt hash of the management key is on disk
    expect(yaml).not.toContain(mk);
    expect(yaml).toMatch(/secret-key: "\$2b\$10\$/);
    expect(yaml).toContain('host: "127.0.0.1"');
    // the program started with the hub's own config and a clean environment
    const start = fake.starts.find((s) => s.cmd.includes('-config'))!;
    expect(start.cmd).toEqual([join(hub.engine.home, 'bin', 'cli-proxy-api'), '-config', join(dir, 'config.yaml')]);
    expect(start.env.HOME).toBe(dir);
    for (const k of ['MANAGEMENT_PASSWORD', 'CONCLAVE_TOKEN', 'ANTHROPIC_API_KEY', 'CONCLAVE_HOME']) expect(start.env[k]).toBeUndefined();
    // the provider entry points at it, Claude over the Anthropic wire
    const p = hub.engine.config.get().providers.cliproxy;
    expect(p.enabled).toBe(true);
    expect(p.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(p.anthropicWire).toEqual({ baseUrl: p.baseUrl!.replace(/\/v1$/, ''), models: ['claude-*', '*/claude-*'] });
    // GPT over Responses, Gemini over its own wire, at the same root and key
    expect(p.responsesWire).toEqual({ models: ['gpt-*', '*/gpt-*'] });
    expect(p.geminiWire).toEqual({ baseUrl: p.baseUrl!.replace(/\/v1$/, ''), models: ['gemini-*'] });
    expect(p.apiKey).toBe('${secret:cliproxy.clientKey}');
    // none of it went into config.json
    expect(JSON.stringify(hub.engine.config.getUser())).not.toContain('127.0.0.1:');
    expect(events.some((e) => e.state === 'installing')).toBe(true);
    // the cards come from the running version's pin
    expect(st.providers.map((x) => x.id)).toEqual(['claude', 'codex', 'antigravity', 'xai', 'kimi', 'meta']);
  });

  test('the management API is not reachable through the hub', async () => {
    const port = Number(new URL(hub.engine.config.get().providers.cliproxy.baseUrl!).port);
    // the hub answers 404, or its web page when packages/web/dist is built; never CLIProxyAPI's JSON
    const viaHub = await hub.api('/v8/management/credentials');
    if (viaHub.status !== 404) {
      expect(viaHub.headers.get('content-type') ?? '').toContain('text/html');
      expect(await viaHub.text()).not.toContain('"files"');
    }
    expect((await hub.api('/gw/p/cliproxy/v8/management/credentials', { token: null })).status).toBe(401);
    // and it answers only with its key, even on 127.0.0.1
    expect((await fetch(`http://127.0.0.1:${port}/v8/management/credentials`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/v8/management/credentials`, { headers: { authorization: `Bearer ${hub.engine.config.expand('${secret:cliproxy.clientKey}')}` } })).status).toBe(401);
  });

  let claudeState = '';
  test('remote browser: sign in to Claude by pasting the address from the browser bar', async () => {
    const st = await status(remote);
    expect(st.local).toBe(false);
    const start = await api('/api/subscriptions/signin', { method: 'POST', headers: remote, json: { provider: 'claude' } });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ provider: 'claude', flow: 'redirect', caught: false, callbackHost: `localhost:${cbPort}` });
    expect(start.body.url).toStartWith('https://claude.example.test/oauth/authorize?');
    claudeState = start.body.state;
    expect((await api(`/api/subscriptions/signin/${claudeState}`)).body.status).toBe('wait');
    // a wrong paste says what is wrong and changes nothing
    const wrong = await api(`/api/subscriptions/signin/${claudeState}/callback`, { method: 'POST', json: { url: `https://claude.ai/done?code=x` } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('claude.ai');
    // the browser bar shows it without http://
    const done = await api(`/api/subscriptions/signin/${claudeState}/callback`, { method: 'POST', json: { url: `localhost:${cbPort}/callback?code=ok:me@example.test&state=${claudeState}` } });
    expect(done.body.status).toBe('ok');
    expect(done.body.account).toMatchObject({ provider: 'claude', providerName: 'Claude', label: 'me@example.test', state: 'active' });
    const after = await status();
    expect(after.accounts.map((a) => a.label)).toEqual(['me@example.test']);
    expect(after.providers.find((x) => x.id === 'claude')?.accounts).toBe(1);
    expect(after.models).toEqual([
      {
        account: '',
        label: 'Main accounts',
        models: [
          { id: 'claude-haiku-5-5', ref: 'cliproxy/claude-haiku-5-5', name: 'Claude Haiku 5.5', wire: 'anthropic', ownedBy: 'anthropic' },
          { id: 'claude-opus-5-5', ref: 'cliproxy/claude-opus-5-5', name: 'Claude Opus 5.5', wire: 'anthropic', ownedBy: 'anthropic' },
          { id: 'claude-sonnet-5-5', ref: 'cliproxy/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', wire: 'anthropic', ownedBy: 'anthropic' },
        ],
      },
    ]);
    expect([...(hub.engine.config.get().providers.cliproxy.models ?? [])].sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    const audit = hub.engine.repos.audit.list({ limit: 20 });
    expect(audit.find((a) => a.action === 'subscriptions.signin')).toMatchObject({ actor: 'owner', detail: 'Claude me@example.test' });
    // pasting again after it finished is harmless
    expect((await api(`/api/subscriptions/signin/${claudeState}/callback`, { method: 'POST', json: { url: `localhost:${cbPort}/callback?code=ok:x&state=${claudeState}` } })).body.status).toBe('ok');
  });

  test('same computer: the hub catches the localhost redirect itself (a second ChatGPT account under neu/)', async () => {
    const start = await api('/api/subscriptions/signin', { method: 'POST', json: { provider: 'codex' } });
    expect(start.body).toMatchObject({ provider: 'codex', caught: true, callbackHost: `localhost:${cbPort}` });
    const state = start.body.state;
    // the provider sends the browser here; only this path with this state is taken
    expect((await fetch(`http://127.0.0.1:${cbPort}/other`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${cbPort}/auth/callback?code=ok:x&state=forged`)).status).toBe(400);
    const page = await fetch(`http://127.0.0.1:${cbPort}/auth/callback?code=ok:you@example.test:neu&state=${state}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Signed in');
    const done = await until(async () => {
      const r = await api(`/api/subscriptions/signin/${state}`);
      return r.body.status !== 'wait' && r.body;
    });
    expect(done).toMatchObject({ status: 'ok', account: { provider: 'codex', label: 'you@example.test' } });
    // the listener is gone once the sign-in finished
    expect(await fetch(`http://127.0.0.1:${cbPort}/auth/callback`).then(() => 'open', () => 'closed')).toBe('closed');
    const st = await status();
    expect(st.models.map((g) => g.label)).toEqual(['Main accounts', 'neu']);
    expect(st.models[1].models.map((m) => [m.id, m.name, m.wire])).toEqual([
      ['neu/gpt-6-astra', 'neu/gpt-6-astra', 'openai'],
      ['neu/gpt-6.1-sol', 'neu/gpt-6.1-sol', 'openai'],
    ]);
  });

  test('the hub runs it with fill-first routing and session affinity, and writes each account its priority', async () => {
    const yaml = Bun.YAML.parse(readFileSync(join(hub.engine.home, 'cliproxy', 'config.yaml'), 'utf8')) as any;
    expect(yaml.routing).toEqual({ strategy: 'fill-first', 'session-affinity': true, 'session-affinity-rebind-on': 'quota' });
    const file = (n: string) => JSON.parse(readFileSync(join(hub.engine.home, 'cliproxy', 'auth', n), 'utf8'));
    // one account per vendor so far: each is first in its order
    await until(() => file('claude-me@example.test.json').priority === 1 && file('codex-you@example.test.json').priority === 1, 5000, 'priorities');
    expect(hub.engine.config.get().providers.cliproxy.sessionHeader).toBe('X-Session-ID');
  });

  test('device sign-in (Grok): a code to type, then the hub sees it finish', async () => {
    const start = await api('/api/subscriptions/signin', { method: 'POST', headers: remote, json: { provider: 'xai' } });
    expect(start.body).toMatchObject({ flow: 'device', userCode: 'WXYZ-1234', caught: false });
    const done = await until(async () => {
      const r = await api(`/api/subscriptions/signin/${start.body.state}`);
      return r.body.status !== 'wait' && r.body;
    });
    expect(done.status).toBe('ok');
    expect((await api(`/api/subscriptions/signin/${start.body.state}/callback`, { method: 'POST', json: { url: 'localhost:1/x?code=1' } })).body.status).toBe('ok');
  });

  test('a failed exchange and a cancel come back in words', async () => {
    const a = await api('/api/subscriptions/signin', { method: 'POST', headers: remote, json: { provider: 'antigravity' } });
    const bad = await api(`/api/subscriptions/signin/${a.body.state}/callback`, { method: 'POST', json: { url: `localhost:${cbPort}/oauth-callback?code=bad&state=${a.body.state}` } });
    expect(bad.body).toEqual({ state: a.body.state, status: 'error', error: 'Failed to exchange authorization code for tokens' });
    const b = await api('/api/subscriptions/signin', { method: 'POST', headers: remote, json: { provider: 'antigravity' } });
    expect((await api(`/api/subscriptions/signin/${b.body.state}`, { method: 'DELETE' })).body.status).toBe('cancelled');
    expect((await api('/api/subscriptions/signin/nope')).status).toBe(404);
    expect((await api('/api/subscriptions/signin', { method: 'POST', json: { provider: 'myspace' } })).status).toBe(400);
  });

  test('a chat request is routed: Claude over /v1/messages, ChatGPT over /v1/responses, Gemini over /v1beta, the rest over /v1/chat/completions', async () => {
    rmSync(callLog, { force: true });
    // a Google account for the Gemini round trip, removed after
    const gfile = join(hub.engine.home, 'cliproxy', 'auth', 'antigravity-g@example.test.json');
    writeFileSync(gfile, JSON.stringify({ type: 'antigravity', email: 'g@example.test' }));
    const reg = new ProviderRegistry(hub.engine.config);
    try {
      const run = async (model: string) => {
        let text = '';
        for await (const ev of reg.get('cliproxy')!.stream({ model, system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 16 })) if (ev.type === 'text_delta') text += ev.text;
        return text;
      };
      expect(await run('claude-opus-5-5')).toBe('Hello from claude-opus-5-5 over messages');
      expect(await run('neu/gpt-6-astra')).toBe('Hello from neu/gpt-6-astra over responses');
      expect(await run('gemini-4-argon')).toBe('Hello from gemini-4-argon over gemini');
      expect(await run('grok-4.7')).toBe('Hello from grok-4.7 over chat');
      expect(reg.resolve('cliproxy/claude-opus-5-5').info.name).toBe('Claude Opus 5.5');
      // no Anthropic key on this hub: the alias goes to the signed in subscription
      expect(reg.resolve('opus').provider).toBe('cliproxy');
    } finally {
      reg.dispose();
      rmSync(gfile, { force: true });
    }
    const calls = readFileSync(callLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toEqual([
      { path: '/v1/messages', model: 'claude-opus-5-5' },
      { path: '/v1/responses', model: 'neu/gpt-6-astra' },
      { path: '/v1beta/models/gemini-4-argon:streamGenerateContent', model: 'gemini-4-argon' },
      { path: '/v1/chat/completions', model: 'grok-4.7' },
    ]);
  });

  test('a Google (Antigravity) plan shows its credits balance and tier from loadCodeAssist', async () => {
    const gfile = join(hub.engine.home, 'cliproxy', 'auth', 'antigravity-g2@example.test.json');
    writeFileSync(gfile, JSON.stringify({ type: 'antigravity', email: 'g2@example.test', usage: { paidTier: { id: 'GOOGLE_ONE_AI_PREMIUM', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '96.5', minimumCreditAmountForUsage: '5' }] } } }));
    try {
      const acct = await until(async () => {
        const r = await api('/api/accounts');
        const a = r.body.accounts.find((x: { credential?: string }) => x.credential === 'antigravity-g2@example.test.json');
        return a && a.windows.length ? a : undefined;
      }, 10_000, 'the Google plan to read its usage');
      expect(acct.vendor).toBe('gemini');
      expect(acct.plan).toBe('AI Pro');
      expect(acct.windows).toEqual([expect.objectContaining({ name: 'credits', kind: 'extra', remaining: 96.5 })]);
      expect(acct.windows[0].usedPercent).toBeUndefined();
      expect(acct.windows[0].limit).toBeUndefined();
    } finally {
      rmSync(gfile, { force: true });
    }
  });

  test('a Google (Antigravity) plan shows its 5h and weekly quota from both quota hosts, next to its credits', async () => {
    const gfile = join(hub.engine.home, 'cliproxy', 'auth', 'antigravity-q@example.test.json');
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    writeFileSync(
      gfile,
      JSON.stringify({
        type: 'antigravity',
        email: 'q@example.test',
        usage: { cloudaicompanionProject: { id: 'proj-q' }, paidTier: { id: 'GOOGLE_ONE_AI_PREMIUM', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '10' }] } },
        // the daily host leaves the Gemini group out
        quota_daily: { groups: [{ buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.5, resetTime: at(2) }, { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: at(100) }] }] },
        // the Gemini week is spent (no fraction), so its 5h bucket comes back disabled
        quota: {
          groups: [
            { buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, disabled: true }, { bucketId: 'gemini-weekly', window: 'weekly', resetTime: at(30) }] },
            { buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.8, resetTime: at(2) }, { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: at(100) }] },
          ],
        },
      }),
    );
    try {
      const acct = await until(async () => {
        const r = await api('/api/accounts');
        const a = r.body.accounts.find((x: { credential?: string }) => x.credential === 'antigravity-q@example.test.json');
        return a && a.windows.length > 1 ? a : undefined;
      }, 10_000, 'the Google plan to read its quota');
      const by = Object.fromEntries(acct.windows.map((w: { name: string }) => [w.name, w]));
      expect(Object.keys(by).sort()).toEqual(['5h 3p', '7d 3p', '7d gemini', 'credits']);
      expect(by['5h 3p']).toMatchObject({ kind: 'session', usedPercent: 50, source: 'oauth' });
      expect(by['7d 3p']).toMatchObject({ kind: 'weekly', usedPercent: 0 });
      expect(by['7d 3p'].resetsAt).toBeUndefined();
      expect(by['7d gemini']).toMatchObject({ kind: 'weekly', usedPercent: 100 });
      expect(by.credits).toMatchObject({ kind: 'extra', remaining: 10 });
      const limits = await api('/api/limits');
      const limit = limits.body.find((x: { account?: string }) => x.account === acct.id);
      expect(limit.note).toBeUndefined();
    } finally {
      rmSync(gfile, { force: true });
    }
  });

  test('a below-minimum Google credit balance stays informational and callable', async () => {
    const gfile = join(hub.engine.home, 'cliproxy', 'auth', 'antigravity-low@example.test.json');
    writeFileSync(gfile, JSON.stringify({ type: 'antigravity', email: 'low@example.test', usage: { paidTier: { id: 'GOOGLE_ONE_AI_PREMIUM', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1.234567', minimumCreditAmountForUsage: '5' }] } } }));
    try {
      const acct = await until(async () => {
        const r = await api('/api/accounts');
        const a = r.body.accounts.find((x: { credential?: string }) => x.credential === 'antigravity-low@example.test.json');
        return a && a.windows.length ? a : undefined;
      }, 10_000, 'the low-credit Google plan to read its balance');
      expect(acct.plan).toBe('AI Pro');
      expect(['ready', 'unknown']).toContain(acct.state);
      expect(acct.windows).toEqual([expect.objectContaining({ name: 'credits', kind: 'extra', remaining: 1.234567 })]);
      expect(acct.windows[0].usedPercent).toBeUndefined();
      expect(acct.windows[0].limit).toBeUndefined();
      const limits = await api('/api/limits');
      const limit = limits.body.find((x: { account?: string }) => x.account === acct.id);
      expect(limit.windows).toEqual(acct.windows);
      expect(limit.blocked).not.toBe(true);
    } finally {
      rmSync(gfile, { force: true });
    }
  });

  test('refresh and remove an account; the tokens in the refresh answer stay on the hub', async () => {
    const st = await status();
    const codex = st.accounts.find((a) => a.provider === 'codex')!;
    const r = await api(`/api/subscriptions/accounts/${encodeURIComponent(codex.name)}/refresh`, { method: 'POST' });
    expect(r.status).toBe(200);
    const removed = await api(`/api/subscriptions/accounts/${encodeURIComponent(codex.name)}`, { method: 'DELETE' });
    expect(removed.body.accounts.some((a: { name: string }) => a.name === codex.name)).toBe(false);
    expect(removed.body.models.map((g: { label: string }) => g.label)).toEqual(['Main accounts']);
    expect(hub.engine.config.get().providers.cliproxy.models).not.toContain('neu/gpt-6-astra');
    const audit = hub.engine.repos.audit.list({ limit: 30 });
    expect(audit.find((a) => a.action === 'subscriptions.remove')?.detail).toBe('ChatGPT you@example.test');
    expect((await api('/api/subscriptions/accounts/nobody.json', { method: 'DELETE' })).status).toBe(404);
  });

  test('when it dies the hub starts it again', async () => {
    const pid = Number(readFileSync(join(hub.engine.home, 'cliproxy', 'pids'), 'utf8').trim().split('\n')[0]);
    expect(pid).toBeGreaterThan(1);
    process.kill(pid, 'SIGKILL');
    await until(() => events.some((e) => e.state === 'starting' && /stopped/.test(e.detail ?? '')), 5000, 'the hub to notice');
    await until(async () => (await status()).state === 'on', 15_000, 'it to come back');
    const again = Number(readFileSync(join(hub.engine.home, 'cliproxy', 'pids'), 'utf8').trim().split('\n')[0]);
    expect(again).not.toBe(pid);
    // the accounts survive a restart: they live in its auth folder
    expect((await status()).accounts.length).toBeGreaterThan(0);
    expect(hub.engine.repos.audit.list({ limit: 40 }).some((a) => a.action === 'subscriptions.stopped')).toBe(true);
  });

  test('update: a new version that does not start is rolled back; a good one replaces the old', async () => {
    const broken = await publish(rel, { version: '8.0.32', crash: true });
    pins.push(broken);
    expect((await status()).update).toEqual({ version: '8.0.32' });
    const failed = await api('/api/subscriptions/update', { method: 'POST' });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain('went back to 8.0.31');
    await until(async () => (await status()).state === 'on', 15_000, 'the old one back');
    const st = await status();
    expect(st.version).toBe('8.0.31');
    expect(readdirSync(join(hub.engine.home, 'bin')).sort()).toEqual(['cli-proxy-api', 'cli-proxy-api.json']);

    pins[1] = await publish(rel, { version: '8.0.32' });
    const ok = await api('/api/subscriptions/update', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'on', version: '8.0.32' });
    expect(ok.body.update).toBeUndefined();
    expect(readdirSync(join(hub.engine.home, 'bin')).sort()).toEqual(['cli-proxy-api', 'cli-proxy-api.json']);
    const updates = hub.engine.repos.audit.list({ limit: 60 }).filter((a) => a.action === 'subscriptions.update').map((a) => a.detail);
    expect(updates.some((d) => d.startsWith('8.0.32 did not start') && d.endsWith('back on 8.0.31'))).toBe(true);
    expect(updates).toContain('8.0.31 -> 8.0.32');
    expect((await api('/api/subscriptions/update', { method: 'POST' })).status).toBe(409);
  });

  test('switching to off stops it and puts providers.cliproxy back as it was', async () => {
    const pidBefore = Number(readFileSync(join(hub.engine.home, 'cliproxy', 'pids'), 'utf8').trim().split('\n')[0]);
    const off = await api('/api/subscriptions', { method: 'PUT', json: { mode: 'off' } });
    expect(off.body).toMatchObject({ mode: 'off', state: 'off' });
    expect(hub.engine.config.get().providers.cliproxy).toMatchObject({ enabled: false, baseUrl: 'http://127.0.0.1:8317/v1' });
    await until(() => !processMatches(pidBefore, () => true), 6000, 'the process to stop');
    expect(hub.engine.repos.audit.list({ limit: 80 }).find((a) => a.action === 'subscriptions.mode')).toMatchObject({ actor: 'owner', detail: 'mode off' });
    expect((await api('/api/subscriptions/signin', { method: 'POST', json: { provider: 'claude' } })).status).toBe(409);
    // back on: same accounts, no download this time
    const seen = rel.seen.length;
    await api('/api/subscriptions', { method: 'PUT', json: { mode: 'builtin' } });
    await until(async () => (await status()).state === 'on', 15_000, 'on again');
    expect(rel.seen.length).toBe(seen);
    expect((await status()).accounts.map((a) => a.label)).toContain('me@example.test');
  });
});

// ---------------------------------------------------------------------------
// One the owner already runs
// ---------------------------------------------------------------------------

function startExternal(opts: { v0?: boolean; plugin?: boolean } = {}) {
  const dir = mkdtempSync(join(scratch, 'ext-'));
  const port = freePort();
  writeFileSync(
    join(dir, 'config.yaml'),
    `server:\n  host: "127.0.0.1"\n  port: ${port}\nmanagement:\n  allow-remote: false\n  secret-key: "ext-mgmt-key"\naccess:\n  api-keys:\n    - "ext-client-key"\noauth:\n  auth-dir: "${join(dir, 'auth')}"\n`,
  );
  mkdirSync(join(dir, 'auth'));
  writeFileSync(join(dir, 'auth', 'claude-owner@example.test.json'), JSON.stringify({ type: 'claude', email: 'owner@example.test' }));
  writeFileSync(join(dir, 'auth', 'claude-work@example.test.json'), JSON.stringify({ type: 'claude', email: 'work@example.test', prefix: 'work' }));
  const proc = Bun.spawn([BUN, FAKE, '-config', join(dir, 'config.yaml')], { env: { ...process.env, FAKE_CPA_V0: opts.v0 ? '1' : '', FAKE_CPA_PLUGIN: opts.plugin ? '1' : '', FAKE_CPA_VERSION: '8.1.0' }, stdout: 'ignore', stderr: 'ignore' });
  return { url: `http://127.0.0.1:${port}`, proc, dir, stop: () => proc.kill('SIGKILL') };
}

describe('external: one the owner already runs', () => {
  test('off by default: nothing runs and the existing provider is untouched', async () => {
    const hub = startHub();
    try {
      const st = (await (await hub.api('/api/subscriptions')).json()) as SubscriptionsStatus;
      expect(st).toMatchObject({ mode: 'off', state: 'off', management: false, accounts: [], models: [] });
      expect(st.pinned).toEqual({ version: '8.0.32', repo: 'github.com/router-for-me/CLIProxyAPI', license: 'MIT' });
      expect(st.providers.map((p) => p.id)).toContain('claude');
      expect(existsSync(join(hub.engine.home, 'cliproxy'))).toBe(false);
      expect(existsSync(join(hub.engine.home, 'bin'))).toBe(false);
      expect(hub.engine.config.get().providers.cliproxy).toMatchObject({ enabled: false, baseUrl: 'http://127.0.0.1:8317/v1', apiKeyEnv: 'CLIPROXY_API_KEY' });
    } finally {
      await hub.stop();
    }
  });

  test('url, client key and management key: models, accounts and sign-in from here; keys go to the secrets store', async () => {
    await until(async () => true);
    const ext = startExternal({ plugin: true });
    // the owner's existing entry, made by hand before this feature
    const hub = startHub({}, { providers: { cliproxy: { type: 'openai', baseUrl: `${ext.url}/v1`, enabled: true } } } as any);
    try {
      await until(() => fetch(`${ext.url}/healthz`).then((r) => r.ok, () => false), 5000, 'the external one');
      const before = (await (await hub.api('/api/subscriptions')).json()) as SubscriptionsStatus;
      expect(before.suggested).toEqual({ url: ext.url, key: false });
      const res = await hub.api('/api/subscriptions', { method: 'PUT', json: { mode: 'external', url: `${ext.url}/v1`, key: 'ext-client-key', managementKey: 'ext-mgmt-key' } });
      const st = (await res.json()) as SubscriptionsStatus;
      expect(JSON.stringify(st)).not.toMatch(/ext-client-key|ext-mgmt-key/);
      expect(st).toMatchObject({ mode: 'external', state: 'on', version: '8.1.0', management: true, external: { url: ext.url, key: true, managementKey: true } });
      expect(st.accounts.map((a) => a.label).sort()).toEqual(['owner@example.test', 'work@example.test']);
      expect(st.models.map((g) => g.label)).toEqual(['Main accounts', 'work']);
      expect(st.models[1].models[0]).toMatchObject({ id: 'work/claude-haiku-5-5', name: 'Claude Haiku 5.5, work', wire: 'anthropic' });
      // a plugin's sign-in shows up as a card from the running version
      expect(st.providers.find((p) => p.id === 'qwen')).toMatchObject({ name: 'Qwen', more: true });
      const user = hub.engine.config.getUser() as any;
      expect(user.models.cliproxy).toEqual({ mode: 'external', url: ext.url, key: '${secret:cliproxy.external.key}', managementKey: '${secret:cliproxy.external.managementKey}' });
      expect(JSON.stringify(user)).not.toContain('ext-client-key');
      // the ids the owner used before keep working
      const reg = new ProviderRegistry(hub.engine.config);
      expect(reg.resolve('cliproxy/work/claude-opus-5-5')).toMatchObject({ provider: 'cliproxy', model: 'work/claude-opus-5-5' });
      let text = '';
      for await (const ev of reg.get('cliproxy')!.stream({ model: 'work/claude-opus-5-5', system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 8 })) if (ev.type === 'text_delta') text += ev.text;
      expect(text).toBe('Hello from work/claude-opus-5-5 over messages');
      reg.dispose();
      // sign in to another account through it, pasting the address
      const start = (await (await hub.api('/api/subscriptions/signin', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.5' }, json: { provider: 'claude' } })).json()) as any;
      const done = (await (await hub.api(`/api/subscriptions/signin/${start.state}/callback`, { method: 'POST', json: { url: `http://localhost:54545/callback?code=ok:third@example.test&state=${start.state}` } })).json()) as any;
      expect(done.status).toBe('ok');
      expect(readdirSync(join(ext.dir, 'auth'))).toContain('claude-third@example.test.json');
      // a wrong client key is said in words
      const wrong = (await (await hub.api('/api/subscriptions', { method: 'PUT', json: { key: 'nope' } })).json()) as SubscriptionsStatus;
      expect(wrong.state).toBe('error');
      expect(wrong.error).toContain('refused the client key');
    } finally {
      await hub.stop();
      ext.stop();
    }
  });

  test('without a management key models work and sign-in says what it needs; an old v0 one still lists accounts', async () => {
    const ext = startExternal({ v0: true });
    const hub = startHub();
    try {
      await until(() => fetch(`${ext.url}/healthz`).then((r) => r.ok, () => false), 5000, 'the external one');
      let st = (await (await hub.api('/api/subscriptions', { method: 'PUT', json: { mode: 'external', url: ext.url, key: 'ext-client-key' } })).json()) as SubscriptionsStatus;
      expect(st).toMatchObject({ state: 'on', management: false });
      expect(st.managementNote).toContain('management key');
      expect(st.models[0].models.length).toBeGreaterThan(0);
      const refused = await hub.api('/api/subscriptions/signin', { method: 'POST', json: { provider: 'claude' } });
      expect(refused.status).toBe(409);
      st = (await (await hub.api('/api/subscriptions', { method: 'PUT', json: { managementKey: 'ext-mgmt-key' } })).json()) as SubscriptionsStatus;
      expect(st.management).toBe(true);
      expect(st.accounts.length).toBe(2);
      // forget the management key again
      st = (await (await hub.api('/api/subscriptions', { method: 'PUT', json: { managementKey: null } })).json()) as SubscriptionsStatus;
      expect(st.management).toBe(false);
      expect(hub.engine.config.secretNames().values).not.toContain('cliproxy.external.managementKey');
    } finally {
      await hub.stop();
      ext.stop();
    }
  });

  test('an address that does not answer: an error in words, and the provider stays so refs say what failed', async () => {
    const hub = startHub({ cliproxy: { backoffMs: [60_000] } });
    try {
      const st = (await (await hub.api('/api/subscriptions', { method: 'PUT', json: { mode: 'external', url: `http://127.0.0.1:${freePort()}`, key: 'k' } })).json()) as SubscriptionsStatus;
      expect(st.state).toBe('error');
      expect(st.error).toContain('did not answer');
      expect(hub.engine.config.get().providers.cliproxy.enabled).toBe(true);
      expect((await hub.api('/api/subscriptions', { method: 'PUT', json: { mode: 'external', url: 'ftp://x' } })).status).toBe(400);
      expect((await hub.api('/api/subscriptions', { method: 'PUT', json: { mode: 'sideways' } })).status).toBe(400);
    } finally {
      await hub.stop();
    }
  });
});

describe('manager without a server', () => {
  test('a manager that never attached reports off and starts nothing', () => {
    const engine = createFakeEngine({ models: { cliproxy: { mode: 'builtin' } } } as any);
    try {
      const m = new CliproxyManager({ engine });
      expect(m.status()).toMatchObject({ mode: 'builtin', state: 'off' });
      expect(existsSync(join(engine.home, 'cliproxy'))).toBe(false);
    } finally {
      engine.cleanup();
    }
  });

  test('a new port while it is still starting: it starts again on the new port', async () => {
    const proc = (out: string, exitNow: boolean): CliProcess => {
      let end!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => (end = r));
      if (exitNow) end(0);
      return { stdout: new Response(out).body, stderr: null, exited, kill: () => end(null) };
    };
    const starts: string[][] = [];
    const spawn: CliSpawner = (cmd) => {
      if (cmd[1] === '-h') return proc('CLIProxyAPI Version: 8.0.32, Commit: test\n', true);
      starts.push(cmd);
      return proc('', false);
    };
    const bin = join(scratch, 'own-cli-proxy-api');
    writeFileSync(bin, 'a program the fake spawner stands in for');
    // nothing answers on the first port; the second one is up
    const first = freePort();
    const up = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => (new URL(req.url).pathname === '/healthz' ? new Response('ok') : new Response('{}', { status: 404 })) });
    const engine = createFakeEngine({ models: { cliproxy: { mode: 'builtin', binary: bin, port: first } } } as any);
    const m = new CliproxyManager({ engine, spawn, readyTimeoutMs: 10_000 });
    try {
      m.attach();
      await until(() => starts.length === 1, 3000, 'the first start');
      engine.config.update({ models: { cliproxy: { mode: 'builtin', binary: bin, port: up.port } } } as any);
      await until(() => m.status().state === 'on', 4000, 'it to start on the new port');
      expect(starts).toHaveLength(2);
    } finally {
      await m.close();
      up.stop(true);
      engine.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Members' own plans (cliproxy/member.ts, docs/design/ACCOUNTS.md 12)
// ---------------------------------------------------------------------------

describe("a member's own plans", () => {
  const rel = releaseServer();
  const cbPort = freePort();
  /** True: the program prints no version to -h, so her CLIProxyAPI ends in an error that does not retry. */
  let broken = false;
  const fake = fakeSpawner(() => ({ FAKE_CPA_CALLBACK_PORT: String(cbPort), ...(broken ? { FAKE_CPA_BROKEN: '1' } : {}) }));
  const PW = 'correct horse battery staple';
  let hub: TestHub;
  let alice = { id: '', token: '' };
  const events: Array<{ type: string; accountId?: string }> = [];
  /** Every answer, checked for keys: the member's and the hub's. */
  const as = async (token: string, path: string, init: RequestInit & { json?: unknown } = {}) => {
    const res = await hub.api(path, { ...init, token });
    const text = await res.text();
    expect(text).not.toMatch(KEYS);
    if (alice.id) for (const name of hub.engine.accountSecrets.hubNames(alice.id)) expect(text).not.toContain(hub.engine.accountSecrets.hubValue(alice.id, name)!);
    return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
  };
  /** Her status: never the hub's version, pin or program folder. */
  const mine = async () => {
    const r = await as(alice.token, '/api/subscriptions');
    expect(r.text).not.toContain(join(hub.engine.home, 'bin'));
    expect(r.text).not.toContain('models.cliproxy');
    expect(r.body.version).toBeUndefined();
    expect(r.body.pinned).toBeUndefined();
    return r.body as SubscriptionsStatus;
  };
  const dir = () => join(hub.engine.home, 'accounts', alice.id, 'cliproxy');
  const signIn = async (email: string) => {
    const start = await as(alice.token, '/api/subscriptions/signin', { method: 'POST', json: { provider: 'claude' } });
    expect(start.status).toBe(200);
    const state = start.body.state;
    const done = await as(alice.token, `/api/subscriptions/signin/${state}/callback`, { method: 'POST', json: { url: `localhost:${cbPort}/callback?code=ok:${email}&state=${state}` } });
    expect(done.body.status).toBe('ok');
    await until(() => hub.engine.access.plans?.entry(alice.id)?.config.models?.length, 8000, 'her models');
  };

  beforeAll(async () => {
    const pins = [await publish(rel, { version: '8.0.31' })];
    // the owner's own CLIProxyAPI stays off: a member's runs anyway
    hub = startHub({ cliproxy: { spawn: fake.spawn, pins, releaseBase: rel.url, platform: 'linux', arch: 'x64', backoffMs: [50, 100, 200], readyTimeoutMs: 15_000 } });
    hub.engine.bus.on((e) => {
      if (e.type === 'subscriptions.updated' || e.type === 'accounts.updated') events.push({ type: e.type, accountId: e.accountId });
    });
    const made = await as(OWNER, '/api/people', { method: 'POST', json: { name: 'alice', password: PW } });
    const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: PW, name: 'laptop' } }).then((r) => r.json());
    alice = { id: made.body.person.id, token: login.token };
  }, 30_000);

  afterAll(async () => {
    await hub.stop();
    rel.stop();
  });

  test('she turns hers on; how the hub reaches one stays the owner’s', async () => {
    const before = await mine();
    expect(before).toMatchObject({ mode: 'off', accounts: [] });
    expect(before.binary).toBeUndefined();
    expect((await as(alice.token, '/api/subscriptions', { method: 'PUT', json: { mode: 'external', url: 'http://10.0.0.9:8317' } })).status).toBe(403);
    expect((await as(alice.token, '/api/subscriptions', { method: 'PUT', json: { mode: 'off' } })).status).toBe(403);
    expect((await as(alice.token, '/api/subscriptions/update', { method: 'POST' })).status).toBe(403);
    expect((await as(alice.token, '/api/subscriptions', { method: 'PUT', json: { mode: 'builtin' } })).status).toBe(200);
    await until(async () => (await mine()).state === 'on', 20_000, 'her CLIProxyAPI on');
    // in her own folder, on 127.0.0.1, its keys in her secrets file only
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir(), 'config.yaml'), 'utf8')).toContain('host: "127.0.0.1"');
    expect(fake.starts.at(-1)!.cmd).toEqual([join(hub.engine.home, 'bin', 'cli-proxy-api'), '-config', join(dir(), 'config.yaml')]);
    expect(hub.engine.accountSecrets.hubNames(alice.id).sort()).toEqual(['cliproxy.clientKey', 'cliproxy.managementKey']);
    expect(hub.engine.config.secretNames().values).not.toContain('cliproxy.clientKey');
    expect(existsSync(join(hub.engine.home, 'cliproxy', 'config.yaml'))).toBe(false);
    // the owner's stays off, and the hub's providers do not change
    expect((await as(OWNER, '/api/subscriptions')).body).toMatchObject({ mode: 'off', state: 'off' });
    expect(hub.engine.config.get().providers.cliproxy).toMatchObject({ baseUrl: 'http://127.0.0.1:8317/v1', enabled: false });
  }, 30_000);

  test('her plan is hers: her models, her Accounts page, and only a count on the owner’s People page', async () => {
    await signIn('alice-plan@example.test');
    const st = await mine();
    expect(st.accounts.map((a) => a.label)).toEqual(['alice-plan@example.test']);
    expect(st.models.flatMap((g) => g.models.map((m) => m.id))).toContain('claude-opus-5-5');
    const entry = hub.engine.access.plans!.entry(alice.id)!;
    expect(entry.config.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(hub.engine.access.plans!.entry('owner')).toBeUndefined();
    // her ready plans for a model, for failover between them (session/limits.ts nextAccount): hers only
    const ready = await until(() => {
      const r = hub.engine.access.plans!.readyAccounts!(alice.id, 'claude-opus-5-5');
      return r.length ? r : undefined;
    }, 8000, 'her ready plans');
    expect(ready.map((a) => a.label)).toEqual(['alice-plan@example.test']);
    expect(hub.engine.access.plans!.readyAccounts!('owner', 'claude-opus-5-5')).toEqual([]);
    expect(hub.engine.access.info(alice.id, 'cliproxy')).toMatchObject({ source: 'own', ownPlans: 1 });
    const accts = await as(alice.token, '/api/accounts');
    expect(accts.text).toContain('alice-plan@example.test');
    // the window starter is the owner's
    const id = accts.body.accounts.find((a: { kind: string }) => a.kind === 'subscription').id;
    expect((await as(alice.token, `/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { starter: { enabled: true } } })).status).toBe(400);
    expect((await as(alice.token, `/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { label: 'Mine' } })).status).toBe(200);
    // the owner sees none of it but how many
    for (const path of ['/api/subscriptions', '/api/accounts', '/api/audit']) expect([path, (await as(OWNER, path)).text.includes('alice-plan@example.test')]).toEqual([path, false]);
    const people = await as(OWNER, '/api/people');
    expect(people.text).not.toContain('alice-plan@example.test');
    expect(people.body.find((p: { id: string }) => p.id === alice.id).ownPlans).toBe(1);
    // her events go to her only
    expect(events.filter((e) => e.accountId === alice.id).length).toBeGreaterThan(0);
  }, 30_000);

  test('signing out her last plan while she signs in to another keeps hers running', async () => {
    const start = await as(alice.token, '/api/subscriptions/signin', { method: 'POST', json: { provider: 'codex' } });
    expect(start.status).toBe(200);
    const name = (await mine()).accounts[0].name;
    const after = await as(alice.token, `/api/subscriptions/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    expect(after.body).toMatchObject({ state: 'on', accounts: [] });
    expect(existsSync(dir())).toBe(true);
    await as(alice.token, `/api/subscriptions/signin/${start.body.state}`, { method: 'DELETE' });
    expect((await mine()).state).toBe('on');
    // back to one plan for the next test
    await signIn('alice-plan@example.test');
  }, 30_000);

  test('signing out her last plan stops hers and deletes its folder and keys', async () => {
    const name = (await mine()).accounts[0].name;
    const after = await as(alice.token, `/api/subscriptions/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ state: 'off', accounts: [] });
    expect(existsSync(dir())).toBe(false);
    expect(hub.engine.accountSecrets.hubNames(alice.id)).toEqual([]);
    expect(hub.engine.access.plans!.entry(alice.id)).toBeUndefined();
    expect(hub.engine.access.info(alice.id, 'cliproxy').ownPlans).toBeUndefined();
  });

  test('hers ended in an error: Try again starts a new one, and the error names nothing of the owner’s', async () => {
    broken = true;
    try {
      expect((await as(alice.token, '/api/subscriptions', { method: 'PUT', json: { mode: 'builtin' } })).status).toBe(200);
      const failed = await until(async () => ((s) => s.state === 'error' && s)(await mine()), 20_000, 'her CLIProxyAPI to fail');
      expect(failed.error).toBe('CLIProxyAPI could not start on the hub. Try again, or ask the owner.');
      expect(failed.detail).toBeUndefined();
    } finally {
      broken = false;
    }
    expect((await as(alice.token, '/api/subscriptions', { method: 'PUT', json: { mode: 'builtin' } })).status).toBe(200);
    await until(async () => (await mine()).state === 'on', 20_000, 'her CLIProxyAPI on after Try again');
  }, 45_000);

  test('removing her stops hers and deletes its folder', async () => {
    await as(alice.token, '/api/subscriptions', { method: 'PUT', json: { mode: 'builtin' } });
    await until(async () => (await mine()).state === 'on', 20_000, 'her CLIProxyAPI on again');
    await signIn('alice-again@example.test');
    const port = Number(new URL(hub.engine.access.plans!.entry(alice.id)!.config.baseUrl!).port);
    expect((await as(OWNER, `/api/people/${alice.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(dir())).toBe(false);
    await until(() => fetch(`http://127.0.0.1:${port}/healthz`).then(() => false, () => true), 5000, 'her CLIProxyAPI to stop');
  }, 40_000);

  test('a killed hub left hers running with no plans: the next start stops it and deletes its folder', async () => {
    const { MemberPlansManager } = await import('../src/cliproxy/member');
    const made = await as(OWNER, '/api/people', { method: 'POST', json: { name: 'dora', password: PW } });
    const folder = join(hub.engine.home, 'accounts', made.body.person.id, 'cliproxy');
    const config = join(folder, 'config.yaml');
    mkdirSync(folder, { recursive: true });
    const stray = Bun.spawn([BUN, '-e', 'setInterval(() => {}, 1000)', '--', '-config', config], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await until(() => processMatches(stray.pid, (c) => c.includes(config)), 3000, 'the stray to start');
      writeFileSync(join(folder, 'pids'), `${stray.pid}\n`);
      const plans = new MemberPlansManager({ engine: hub.engine as any, spawn: fake.spawn });
      plans.attach();
      expect(await Promise.race([stray.exited.then(() => 'gone'), Bun.sleep(3000).then(() => 'alive')])).toBe('gone');
      await until(() => !existsSync(folder), 3000, 'her folder to go');
      await plans.close();
    } finally {
      stray.kill('SIGKILL');
    }
  });
});

describe("two members' own plans", () => {
  const rel = releaseServer();
  // the fake never listens on it; the hub's catcher binds it per sign-in and frees it when done, so sequential sign-ins share it
  const cbPort = freePort();
  const fake = fakeSpawner(() => ({ FAKE_CPA_CALLBACK_PORT: String(cbPort) }));
  const PW = 'correct horse battery staple';
  let hub: TestHub;
  type Who = { id: string; token: string; email: string; provider: string; name: string; account: string };
  const alice: Who = { id: '', token: '', email: 'alice-own@example.test', provider: 'claude', name: '', account: '' };
  const bob: Who = { id: '', token: '', email: 'bob-own@example.test', provider: 'codex', name: '', account: '' };
  const other = (w: Who) => (w === alice ? bob : alice);
  /** Every answer to a member: no keys, and none of the other member's hub secrets. */
  const as = async (w: Who, path: string, init: RequestInit & { json?: unknown } = {}) => {
    const res = await hub.api(path, { ...init, token: w.token });
    const text = await res.text();
    expect(text).not.toMatch(KEYS);
    const o = other(w);
    if (o.id) for (const name of hub.engine.accountSecrets.hubNames(o.id)) expect(text).not.toContain(hub.engine.accountSecrets.hubValue(o.id, name)!);
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body };
  };
  const status = async (w: Who) => (await as(w, '/api/subscriptions')).body as SubscriptionsStatus;
  const signIn = async (w: Who) => {
    const start = await as(w, '/api/subscriptions/signin', { method: 'POST', json: { provider: w.provider } });
    expect(start.status).toBe(200);
    const state = start.body.state;
    const path = w.provider === 'codex' ? '/auth/callback' : '/callback';
    const done = await as(w, `/api/subscriptions/signin/${state}/callback`, { method: 'POST', json: { url: `localhost:${cbPort}${path}?code=ok:${w.email}&state=${state}` } });
    expect(done.body.status).toBe('ok');
    await until(() => hub.engine.access.plans?.entry(w.id)?.config.models?.length, 8000, `${w.email} models`);
  };

  beforeAll(async () => {
    const pins = [await publish(rel, { version: '8.0.31' })];
    hub = startHub({ cliproxy: { spawn: fake.spawn, pins, releaseBase: rel.url, platform: 'linux', arch: 'x64', backoffMs: [50, 100, 200], readyTimeoutMs: 15_000 } });
    for (const w of [alice, bob]) {
      const who = w === alice ? 'alice' : 'bob';
      const made = await hub.api('/api/people', { method: 'POST', json: { name: who, password: PW } }).then((r) => r.json());
      const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: who, password: PW, name: 'laptop' } }).then((r) => r.json());
      w.id = made.person.id;
      w.token = login.token;
    }
    for (const w of [alice, bob]) {
      expect((await as(w, '/api/subscriptions', { method: 'PUT', json: { mode: 'builtin' } })).status).toBe(200);
      await until(async () => (await status(w)).state === 'on', 20_000, `${w.email} CLIProxyAPI on`);
      await signIn(w);
      w.name = (await status(w)).accounts[0].name;
      w.account = (await as(w, '/api/accounts')).body.accounts.find((a: { kind: string }) => a.kind === 'subscription').id;
    }
  }, 60_000);

  afterAll(async () => {
    await hub.stop();
    rel.stop();
  });

  test('each one’s Subscriptions and Accounts show their own plan only', async () => {
    for (const w of [alice, bob]) {
      const st = await status(w);
      expect(st.accounts.map((a) => a.label)).toEqual([w.email]);
      const subs = await as(w, '/api/subscriptions');
      expect(subs.text).not.toContain(other(w).email);
      const accts = await as(w, '/api/accounts');
      expect(accts.text).toContain(w.email);
      expect(accts.text).not.toContain(other(w).email);
    }
  });

  test('alice cannot sign out, refresh, relabel or try bob’s plan', async () => {
    const before = await as(bob, '/api/accounts');
    const bobLabel = before.body.accounts.find((a: { id: string }) => a.id === bob.account).label;
    const tries = [
      await as(alice, `/api/subscriptions/accounts/${encodeURIComponent(bob.name)}`, { method: 'DELETE' }),
      await as(alice, `/api/subscriptions/accounts/${encodeURIComponent(bob.name)}/refresh`, { method: 'POST' }),
      await as(alice, `/api/accounts/${encodeURIComponent(bob.account)}`, { method: 'PATCH', json: { label: 'x' } }),
      await as(alice, `/api/accounts/${encodeURIComponent(bob.account)}/try`, { method: 'POST' }),
    ];
    // observed 2026-10-23: DELETE 404, refresh 404, PATCH 404, try 404 (her own plans do not have his)
    expect(tries.map((t) => t.status)).toEqual([404, 404, 404, 404]);
    for (const t of tries) {
      expect(t.text).not.toContain(bob.email);
      if (t.status === 200) expect(t.text).not.toContain(bob.name);
    }
    const st = await status(bob);
    expect(st.accounts.map((a) => a.name)).toEqual([bob.name]);
    const after = await as(bob, '/api/accounts');
    expect(after.body.accounts.find((a: { id: string }) => a.id === bob.account).label).toBe(bobLabel);
    expect(hub.engine.access.plans!.entry(bob.id)).toBeDefined();
  });

  test('alice cannot set bob’s plan short name', async () => {
    const prefixOf = async () => (await as(bob, '/api/accounts')).body.accounts.find((a: { id: string }) => a.id === bob.account).prefix;
    const before = await prefixOf();
    const r = await as(alice, `/api/accounts/${encodeURIComponent(bob.account)}/prefix`, { method: 'PUT', json: { prefix: 'stolen' } });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain(bob.email);
    expect(await prefixOf()).toBe(before);
  });

  test("a member's CLIProxyAPI sees none of the hub's config but its own parts", () => {
    const hubCfg = hub.engine.config.get();
    const token = hubCfg.server?.token;
    expect(token).toBeTruthy();
    for (const w of [alice, bob]) {
      const view = (hub.engine.access.plans as unknown as { manager(id: string): { opts: { engine: { config: { get(): Record<string, any> } } } } }).manager(w.id).opts.engine.config.get();
      expect(Object.keys(view).sort()).toEqual(['models', 'providers']);
      expect(Object.keys(view.models ?? {}).sort()).toEqual(['accounts', 'cliproxy', 'routes']);
      expect(JSON.stringify(view)).not.toContain(token!);
      expect(view.providers.mock).toBeUndefined();
    }
  });

  test('their engine entries are apart: own ports, own keys, own models', () => {
    const plans = hub.engine.access.plans!;
    const a = plans.entry(alice.id)!;
    const b = plans.entry(bob.id)!;
    expect(plans.entry('owner')).toBeUndefined();
    expect(a.config.baseUrl).not.toBe(b.config.baseUrl);
    expect(new URL(a.config.baseUrl!).port).not.toBe(new URL(b.config.baseUrl!).port);
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(b.config.models).toContain('gpt-6-astra');
    expect(a.config.models).not.toContain('gpt-6-astra');
    expect(hub.engine.access.source(alice.id, 'cliproxy', 'gpt-6-astra')).not.toBe('own');
    expect(hub.engine.access.source(bob.id, 'cliproxy', 'gpt-6-astra')).toBe('own');
    expect(hub.engine.access.source(bob.id, 'cliproxy', 'claude-opus-5-5')).not.toBe('own');
  });

  test('the owner sees a count for each, and neither email', async () => {
    const res = await hub.api('/api/people');
    const text = await res.text();
    for (const w of [alice, bob]) expect(text).not.toContain(w.email);
    const people = JSON.parse(text) as Array<{ id: string; ownPlans?: number }>;
    for (const w of [alice, bob]) expect(people.find((p) => p.id === w.id)?.ownPlans).toBe(1);
  });

  test('a member cannot mark her plan for refusals', async () => {
    expect((await as(alice, `/api/accounts/${encodeURIComponent(alice.account)}`, { method: 'PATCH', json: { refusal: true } })).status).toBe(400);
  });
});

void OWNER;
