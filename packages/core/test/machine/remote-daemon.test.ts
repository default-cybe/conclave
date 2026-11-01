import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { RemoteMachine } from '../../src/machine/remote';
import { runDaemon, type DaemonHandle, type DaemonStatus } from '../../src/machine/daemon';
import { PROTOCOL_VERSION, parseFrame, type DaemonMessage } from '../../src/machine/protocol';
import { FakeMachine, readAll, waitFor } from './fake-machine';

/**
 * A tiny hub: authenticates the upgrade, builds a RemoteMachine on hello and
 * replies welcome. Mirrors what packages/server does, without the engine.
 */
interface Conn {
  ws: ServerWebSocket<{ id: number }>;
  machine?: RemoteMachine;
}

let server: Server<{ id: number }>;
let conns: Conn[] = [];
let rejectUpgrades = false;
let nextConn = 0;
const fake = new FakeMachine();
let daemon: DaemonHandle | undefined;
let statuses: DaemonStatus[] = [];

beforeAll(() => {
  server = Bun.serve<{ id: number }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/daemon') return new Response('nope', { status: 404 });
      if (rejectUpgrades || req.headers.get('authorization') !== 'Bearer tok-1' || req.headers.get('x-conclave-device') !== 'dev-1') {
        return new Response('unauthorized', { status: 401 });
      }
      return srv.upgrade(req, { data: { id: ++nextConn } }) ? undefined : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ ws });
      },
      message(ws, raw) {
        const conn = conns.find((c) => c.ws === ws)!;
        const msg = parseFrame(raw) as DaemonMessage | undefined;
        if (!msg) return;
        if (msg.type === 'ping') return void ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
        if (msg.type === 'hello') {
          expect(msg.version).toBe(PROTOCOL_VERSION);
          conn.machine = new RemoteMachine({
            id: msg.deviceId,
            name: 'dev',
            info: msg.info,
            send: (m) => {
              if (ws.send(JSON.stringify(m)) === 0) throw new Error('closed');
            },
            rpcTimeoutMs: 2000,
            execGraceMs: 500,
          });
          ws.send(JSON.stringify({ type: 'welcome', version: PROTOCOL_VERSION, deviceId: msg.deviceId, name: 'dev' }));
          return;
        }
        conn.machine?.handleMessage(msg);
      },
      close(ws) {
        const conn = conns.find((c) => c.ws === ws);
        conn?.machine?.dispose();
        conns = conns.filter((c) => c !== conn);
      },
    },
  });
});

afterAll(() => {
  daemon?.stop();
  server.stop(true);
});

afterEach(() => {
  rejectUpgrades = false;
});

function start(): DaemonHandle {
  statuses = [];
  daemon?.stop();
  daemon = runDaemon({
    hubUrl: `http://127.0.0.1:${server.port}/`,
    deviceId: 'dev-1',
    token: 'tok-1',
    machine: fake,
    name: 'test daemon',
    onStatus: (s) => statuses.push(s),
    maxBackoffMs: 200,
    heartbeatMs: 1000,
  });
  return daemon;
}

async function machine(): Promise<RemoteMachine> {
  await waitFor(() => conns.some((c) => c.machine?.online), 3000, 'daemon hello');
  return conns.find((c) => c.machine?.online)!.machine!;
}

describe('RemoteMachine <-> runDaemon', () => {
  test('connects, says hello and reports online', async () => {
    const d = start();
    const m = await machine();
    await waitFor(() => d.state === 'online', 2000, 'online status');
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'online']);
    expect(m.lastInfo.hostname).toBe('fakebox');
    expect((await m.info()).clis.git).toBe('2.50.0');
  });

  test('file operations round trip, including binary data', async () => {
    const m = await machine();
    await m.writeFile('/home/me/a.txt', 'hello\nworld\n');
    expect(await m.readText('/home/me/a.txt')).toBe('hello\nworld\n');
    const bytes = new Uint8Array([0, 255, 1, 254, 10, 13]);
    await m.writeFile('/home/me/b.bin', bytes);
    expect(Array.from(await m.readFile('/home/me/b.bin'))).toEqual(Array.from(bytes));
    expect(await m.stat('/home/me/a.txt')).toEqual({ type: 'file', size: 12, mtimeMs: 1 });
    expect(await m.stat('/nope')).toBeNull();
    expect((await m.readdir('/home/me')).map((e) => e.name)).toEqual(['a.txt', 'b.bin']);
    await m.rename('/home/me/b.bin', '/home/me/c.bin');
    await m.mkdir('/home/me/sub');
    expect(await m.glob('*.txt', { cwd: '/home/me' })).toEqual(['/home/me/a.txt']);
    expect((await m.grep({ pattern: 'wor', path: '/home/me', outputMode: 'content' })).output).toBe('/home/me/a.txt:2:world');
    await m.remove('/home/me/c.bin');
    expect(await m.stat('/home/me/c.bin')).toBeNull();
  });

  test('errors keep their message and code', async () => {
    const m = await machine();
    const err = (await m.readText('/missing').catch((e) => e)) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ENOENT');
    expect(err.message).toContain('/missing');
  });

  test('exec streams output and returns the result', async () => {
    const m = await machine();
    const chunks: string[] = [];
    const r = await m.exec('stream 3', { cwd: '/home/me', onOutput: (c, s) => chunks.push(`${s}:${c}`) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('line 0\nline 1\nline 2\n');
    expect(chunks).toEqual(['stdout:line 0\n', 'stdout:line 1\n', 'stdout:line 2\n']);
    const env = await m.exec('env FOO', { cwd: '/', env: { FOO: 'bar' } });
    expect(env.stdout).toBe('bar\n');
    const cat = await m.exec('cat', { cwd: '/', stdin: 'piped' });
    expect(cat.stdout).toBe('piped');
    const code = await m.exec('exit 3', { cwd: '/' });
    expect(code.exitCode).toBe(3);
  });

  test('exec abort reaches the daemon', async () => {
    const m = await machine();
    const ac = new AbortController();
    const p = m.exec('sleep 5000', { cwd: '/', signal: ac.signal });
    await Bun.sleep(30);
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  test('exec timeout is enforced by the daemon', async () => {
    const m = await machine();
    const r = await m.exec('sleep 5000', { cwd: '/', timeoutMs: 50 });
    expect(r.timedOut).toBe(true);
  });

  test('spawn: stdin, stdout, stderr and exit code', async () => {
    const m = await machine();
    const p = m.spawn('cat', [], { cwd: '/' });
    p.write('one\n');
    p.write(new TextEncoder().encode('two\n'));
    const out = readAll(p.stdout);
    const err = readAll(p.stderr);
    await Bun.sleep(30);
    p.closeStdin();
    expect(await p.exited).toBe(0);
    expect(await out).toBe('one\ntwo\n');
    expect(await err).toBe('stdin closed\n');
    expect(p.pid).toBe(4242);
  });

  test('spawn: kill', async () => {
    const m = await machine();
    const p = m.spawn('yes', [], { cwd: '/' });
    const reader = p.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('y\n');
    reader.releaseLock();
    p.kill('SIGKILL');
    expect(await p.exited).toBe(137);
    expect(fake.killed).toContain('SIGKILL');
  });

  test('spawn failure ends the process with the error on stderr', async () => {
    const m = await machine();
    const p = m.spawn('does-not-exist', ['x'], { cwd: '/' });
    const [err, code] = await Promise.all([readAll(p.stderr), p.exited]);
    expect(code).toBeNull();
    expect(err).toContain('ENOENT');
  });

  test('resolve runs locally from the hello info', async () => {
    const m = await machine();
    expect(m.resolve('~/x', '/tmp')).toBe('/home/me/x');
    expect(m.resolve('a/../b', '/srv/app')).toBe('/srv/app/b');
    expect(m.resolve('/abs', '/srv')).toBe('/abs');
    const win = new RemoteMachine({ id: 'w', name: 'w', info: { ...m.lastInfo, platform: 'win32', home: 'C:\\Users\\me' }, send: () => {} });
    expect(win.resolve('~\\code', 'C:\\x')).toBe('C:\\Users\\me\\code');
    expect(win.resolve('src', 'D:\\proj')).toBe('D:\\proj\\src');
  });

  test('disconnect fails in-flight calls and live processes, then the daemon reconnects', async () => {
    const m = await machine();
    const pending = m.exec('sleep 5000', { cwd: '/' });
    const proc = m.spawn('yes', [], { cwd: '/' });
    void readAll(proc.stdout);
    await Bun.sleep(20);
    const killedBefore = fake.killed.length;
    conns[0].ws.close(4000, 'test drop');
    await expect(pending).rejects.toThrow('device disconnected');
    expect(await proc.exited).toBeNull();
    expect(m.online).toBe(false);
    await expect(m.stat('/')).rejects.toThrow();
    // daemon side killed the orphaned process and aborted the exec
    await waitFor(() => fake.killed.length > killedBefore, 2000, 'daemon cleanup');
    // and comes back on its own
    const m2 = await machine();
    expect(m2).not.toBe(m);
    expect(await m2.stat('/home/me')).toEqual({ type: 'dir', size: 0, mtimeMs: 1 });
    expect(statuses.some((s) => s.state === 'offline')).toBe(true);
  });

  test('keeps retrying while the hub refuses, with backoff', async () => {
    rejectUpgrades = true;
    for (const c of conns) c.ws.close(4000, 'bye');
    await waitFor(() => statuses.filter((s) => s.state === 'offline').length >= 3, 4000, 'several retries');
    const offline = statuses.filter((s) => s.state === 'offline');
    expect(offline.every((s) => (s.retryInMs ?? 0) <= 200)).toBe(true);
    rejectUpgrades = false;
    await machine();
  });

  test('RPC timeout when the daemon never answers', async () => {
    const sent: unknown[] = [];
    const m = new RemoteMachine({ id: 'x', name: 'x', info: (await machine()).lastInfo, send: (msg) => sent.push(msg), rpcTimeoutMs: 50 });
    await expect(m.stat('/')).rejects.toThrow('timed out');
    // exec with a timeout waits timeout + grace, then sends exec.abort
    const m2 = new RemoteMachine({ id: 'y', name: 'y', info: m.lastInfo, send: (msg) => sent.push(msg), rpcTimeoutMs: 10_000, execGraceMs: 20 });
    await expect(m2.exec('sleep 1', { cwd: '/', timeoutMs: 30 })).rejects.toThrow('timed out');
    expect(sent.some((s) => (s as { type: string }).type === 'exec.abort')).toBe(true);
  });

  test('stop() ends the loop', async () => {
    const d = daemon!;
    d.stop();
    await d.closed;
    expect(d.state).toBe('stopped');
    await waitFor(() => conns.length === 0, 2000, 'socket closed');
    daemon = undefined;
  });
});
