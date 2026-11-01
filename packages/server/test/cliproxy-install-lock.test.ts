/**
 * Two installs into one home at once, and close() while CLIProxyAPI is being
 * started. The fake release is served from 127.0.0.1, as in cliproxy.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliproxyManager } from '../src/cliproxy';
import { assetFor, installRelease, type Pin } from '../src/cliproxy/release';
import type { CliProcess, CliSpawner } from '../src/cliproxy/runner';
import { createFakeEngine } from './fake-engine';

const scratch = mkdtempSync(join(tmpdir(), 'conclave-cpa-lock-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function until<T>(fn: () => T | undefined | false, ms = 8000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const SIZE = 4 * 1024 * 1024 + 4096;

function program(version: string): Uint8Array {
  // random filler: a real build does not compress to nothing, and the hub checks the archive size
  const b = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i += 65_536) crypto.getRandomValues(b.subarray(i, Math.min(SIZE, i + 65_536)));
  b.set([0x7f, 0x45, 0x4c, 0x46]);
  b.set(new TextEncoder().encode(`${JSON.stringify({ version })}\n`), 4);
  return b;
}

const readVersion = (path: string): string => JSON.parse(new TextDecoder().decode(readFileSync(path).subarray(4, 512)).split('\n')[0]).version;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const asset = (v: string) => assetFor(v, 'linux', 'x64')!.name;

async function archive(version: string): Promise<Uint8Array> {
  const dir = mkdtempSync(join(scratch, 'pkg-'));
  writeFileSync(join(dir, 'cli-proxy-api'), program(version), { mode: 0o755 });
  const out = join(dir, 'a.tar.gz');
  await Bun.spawn(['tar', '-czf', out, '-C', dir, 'cli-proxy-api'], { stdout: 'ignore', stderr: 'ignore' }).exited;
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Serves /<tag>/<asset> and /<tag>/checksums.txt; records each path asked for. */
function releaseServer() {
  const files = new Map<string, Uint8Array>();
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
        const lines = [...files.entries()].filter(([k]) => k.startsWith(`${m[1]}/`)).map(([k, v]) => `${sha(v)}  ${k.slice(m[1].length + 1)}`);
        return new Response(lines.join('\n') + '\n');
      }
      const b = files.get(`${m[1]}/${m[2]}`);
      return b ? new Response(b as unknown as BodyInit, { headers: { 'content-length': String(b.byteLength) } }) : new Response('no', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, files, seen, stop: () => server.stop(true) };
}

async function publish(rel: ReturnType<typeof releaseServer>, version: string): Promise<Pin> {
  const bytes = await archive(version);
  const name = asset(version);
  rel.files.set(`v${version}/${name}`, bytes);
  return { version, tag: `v${version}`, providers: ['claude'], assets: { [name]: { sha256: sha(bytes), size: bytes.byteLength } } };
}

describe('two installs into one home', () => {
  const rel = releaseServer();
  afterAll(() => rel.stop());
  const probe = async (p: string) => readVersion(p);

  test('the second waits for the first: one download, one program, no stray temp files', async () => {
    const pin = await publish(rel, '8.0.50');
    const home = mkdtempSync(join(scratch, 'home-'));
    const opts = { home, pin, base: rel.url, platform: 'linux', arch: 'x64', probe };
    const [a, b] = await Promise.all([installRelease(opts), installRelease({ ...opts, home: `${home}/` })]);
    expect(a).toMatchObject({ path: join(home, 'bin', 'cli-proxy-api'), version: '8.0.50', managed: true });
    expect(b.path).toBe(a.path);
    expect(b.version).toBe(a.version);
    expect(rel.seen.filter((p) => p === `/v8.0.50/${asset('8.0.50')}`)).toHaveLength(1);
    expect(readdirSync(join(home, 'bin')).sort()).toEqual(['cli-proxy-api', 'cli-proxy-api.json']);
    expect(readVersion(a.path)).toBe('8.0.50');

    // once it is done, the next call installs again
    await installRelease(opts);
    expect(rel.seen.filter((p) => p === `/v8.0.50/${asset('8.0.50')}`)).toHaveLength(2);
  });

  test('after a failed install the next call tries again', async () => {
    const pin = await publish(rel, '8.0.51');
    const home = mkdtempSync(join(scratch, 'home-'));
    const opts = { home, pin, base: rel.url, platform: 'linux', arch: 'x64' };
    expect((await installRelease({ ...opts, probe: async () => undefined }).catch((e) => e)).message).toContain('does not start');
    expect((await installRelease({ ...opts, probe })).version).toBe('8.0.51');
  });
});

describe('close() while it starts', () => {
  test('writes no config and starts nothing once closed', async () => {
    let probed = false;
    const starts: string[][] = [];
    const spawn: CliSpawner = (cmd) => {
      let end!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => (end = r));
      if (cmd[1] === '-h') {
        probed = true;
        end(0);
        return { stdout: new Response('CLIProxyAPI Version: 8.0.32, Commit: test\n').body, stderr: null, exited, kill: () => {} } as CliProcess;
      }
      starts.push(cmd);
      return { stdout: new Response('').body, stderr: null, exited, kill: () => end(null) } as CliProcess;
    };
    const bin = join(scratch, 'own-cli-proxy-api');
    writeFileSync(bin, 'a program the fake spawner stands in for');
    const engine = createFakeEngine({ models: { cliproxy: { mode: 'builtin', binary: bin, port: 41999 } } } as any);
    const m = new CliproxyManager({ engine, spawn, readyTimeoutMs: 10_000 });
    const dir = join(engine.config.paths.home, 'cliproxy');
    try {
      m.attach();
      // the probe is done; the bcrypt hash of the management key takes far longer than this
      await until(() => probed, 3000, 'the -h probe');
      await Bun.sleep(5);
      await m.close();
      rmSync(dir, { recursive: true, force: true });
      await Bun.sleep(500);
      expect(existsSync(dir)).toBe(false);
      expect(starts).toEqual([]);
    } finally {
      engine.cleanup();
    }
  });
});
