/**
 * The loopback relay and tunnels (browser/proxy-net.ts), against a fake
 * SOCKS5 proxy that needs a user name and password (RFC 1929) and a fake HTTP
 * proxy that needs Basic auth. A plain HTTP server stands in for a site; the
 * fake proxies connect to it for real, so bytes go through end to end.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { setLogTap } from '../../src/util/log';
import { connectThrough, parseTrace, probeProxy, SocksRelay, socksAddress, type ProbeTarget } from '../../src/browser/proxy-net';
import type { ProxyEntry } from '../../src/browser/proxy-list';

const USER = 'alice';
const PASS = 'sw0rdfish-9f3a';

/** A site: answers a trace-like page with the client's address. */
let site: Server;
let sitePort = 0;
/** A SOCKS5 proxy that only takes alice's login; records the targets it was asked for. */
let socks: Server;
let socksPort = 0;
const asked: string[] = [];
let logins = 0;
/** An HTTP proxy that only takes alice's login. */
let httpProxy: Server;
let httpPort = 0;

function readExactly(sock: Socket): (n: number) => Promise<Buffer> {
  let buf = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d as Buffer]);
    wake?.();
  });
  return async (n) => {
    while (buf.length < n) await new Promise<void>((r) => (wake = r));
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return Buffer.from(out);
  };
}

function fakeSocks(): Server {
  return createServer(async (c) => {
    c.on('error', () => {});
    const read = readExactly(c);
    const [, n] = await read(2);
    const methods = await read(n);
    if (!methods.includes(2)) {
      c.end(Buffer.from([5, 0xff]));
      return;
    }
    c.write(Buffer.from([5, 2]));
    const [, ulen] = await read(2);
    const user = (await read(ulen)).toString();
    const [plen] = await read(1);
    const pass = (await read(plen)).toString();
    if (user !== USER || pass !== PASS) {
      c.end(Buffer.from([1, 1]));
      return;
    }
    logins++;
    c.write(Buffer.from([1, 0]));
    const [, cmd, , atyp] = await read(4);
    let host = '';
    if (atyp === 1) host = [...(await read(4))].join('.');
    else if (atyp === 3) host = (await read((await read(1))[0])).toString();
    const pb = await read(2);
    const port = (pb[0] << 8) | pb[1];
    asked.push(`${host}:${port}`);
    if (cmd !== 1 || host === 'refused.example') {
      c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const target = host === 'site.example' ? '127.0.0.1' : host;
    const up = connect({ host: target, port }, () => {
      c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      c.removeAllListeners('data');
      c.pipe(up);
      up.pipe(c);
    });
    up.on('error', () => c.destroy());
  });
}

function fakeHttpProxy(): Server {
  return createServer((c) => {
    c.on('error', () => {});
    let head = '';
    const onData = (d: Buffer) => {
      head += d.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      c.off('data', onData);
      const want = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
      if (!head.includes(`Proxy-Authorization: ${want}`)) {
        c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const m = /^CONNECT ([^:]+):(\d+) /.exec(head)!;
      const up = connect({ host: m[1] === 'site.example' ? '127.0.0.1' : m[1], port: Number(m[2]) }, () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        c.pipe(up);
        up.pipe(c);
      });
      up.on('error', () => c.destroy());
    };
    c.on('data', onData);
  });
}

const listen = (s: Server) => new Promise<number>((done) => s.listen(0, '127.0.0.1', () => done((s.address() as { port: number }).port)));

beforeAll(async () => {
  site = createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => c.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nfl=1\nip=203.0.113.9\nloc=VN\nwarp=off\n'));
  });
  sitePort = await listen(site);
  socks = fakeSocks();
  socksPort = await listen(socks);
  httpProxy = fakeHttpProxy();
  httpPort = await listen(httpProxy);
});

afterAll(() => {
  site.close();
  socks.close();
  httpProxy.close();
});

const logs: string[] = [];
let prevTap: ReturnType<typeof setLogTap>;
beforeAll(() => {
  prevTap = setLogTap((level, scope, msg, extra) => logs.push(`${level} ${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
});
afterAll(() => setLogTap(prevTap));
afterEach(() => {
  asked.length = 0;
});

const upstream = (): ProxyEntry => ({ scheme: 'socks5', host: '127.0.0.1', port: socksPort, username: USER, password: PASS });
const target = (): ProbeTarget => ({ host: 'site.example', port: sitePort, tls: false, path: '/cdn-cgi/trace' });

/** GET / through a socket, the whole answer. */
function get(sock: Socket): Promise<string> {
  return new Promise((done) => {
    let out = '';
    sock.on('data', (d) => (out += d.toString()));
    sock.on('close', () => done(out));
    sock.write('GET / HTTP/1.1\r\nHost: site.example\r\n\r\n');
  });
}

describe('connectThrough', () => {
  test('logs in to a SOCKS5 proxy and tunnels to the target by name', async () => {
    const s = await connectThrough(upstream(), { host: 'site.example', port: sitePort });
    expect(await get(s)).toContain('ip=203.0.113.9');
    expect(asked).toEqual([`site.example:${sitePort}`]);
  });

  test('a wrong password is a clear error with no password in it', async () => {
    const err = await connectThrough({ ...upstream(), password: 'nope' }, { host: 'site.example', port: sitePort }).catch((e: Error) => e);
    expect(String((err as Error).message)).toBe('the proxy refused the user name or password');
  });

  test('a proxy that needs a login, asked without one', async () => {
    const err = await connectThrough({ scheme: 'socks5', host: '127.0.0.1', port: socksPort }, { host: 'site.example', port: sitePort }).catch((e: Error) => e);
    expect((err as Error).message).toContain('needs a user name and password');
  });

  test('the proxy refusing the target names the SOCKS5 reason', async () => {
    const err = await connectThrough(upstream(), { host: 'refused.example', port: 80 }).catch((e: Error) => e);
    expect((err as Error).message).toContain('connection refused');
  });

  test('an HTTP proxy with Basic auth', async () => {
    const s = await connectThrough({ scheme: 'http', host: '127.0.0.1', port: httpPort, username: USER, password: PASS }, { host: 'site.example', port: sitePort });
    expect(await get(s)).toContain('loc=VN');
    const err = await connectThrough({ scheme: 'http', host: '127.0.0.1', port: httpPort, username: USER, password: 'x' }, { host: 'site.example', port: sitePort }).catch((e: Error) => e);
    expect((err as Error).message).toBe('the proxy refused the user name or password');
  });

  test('nothing listening', async () => {
    const dead = createServer();
    const port = await listen(dead);
    dead.close();
    const err = await connectThrough({ scheme: 'socks5', host: '127.0.0.1', port }, { host: 'x', port: 1 }, 2_000).catch((e: Error) => e);
    expect((err as Error).message).toBe('the proxy refused the connection');
  });

  test('socksAddress encodes names, IPv4 and IPv6', () => {
    expect([...socksAddress({ host: '1.2.3.4', port: 443 })]).toEqual([1, 1, 2, 3, 4, 1, 187]);
    expect([...socksAddress({ host: 'ab.c', port: 80 })]).toEqual([3, 4, 97, 98, 46, 99, 0, 80]);
    const v6 = socksAddress({ host: '2001:db8::1', port: 1 });
    expect(v6[0]).toBe(4);
    expect(v6.subarray(1, 17).toString('hex')).toBe('20010db8000000000000000000000001');
  });
});

describe('probeProxy', () => {
  test('the exit IP and country from the trace page', async () => {
    const r = await probeProxy(upstream(), { target: target() });
    expect(r).toMatchObject({ ok: true, ip: '203.0.113.9', country: 'VN', proxy: `socks5://alice@127.0.0.1:${socksPort}` });
    expect(JSON.stringify(r)).not.toContain(PASS);
  });

  test('quick only opens the tunnel', async () => {
    expect((await probeProxy(upstream(), { quick: true, target: target() })).ok).toBe(true);
    const bad = await probeProxy({ ...upstream(), password: 'x' }, { quick: true, target: target() });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(PASS);
  });

  test('parseTrace', () => {
    expect(parseTrace('HTTP/1.1 200 OK\r\n\r\nip=2001:db8::5\nloc=de\n')).toEqual({ ip: '2001:db8::5', country: 'DE' });
  });
});

describe('SocksRelay', () => {
  let relay: SocksRelay;
  afterEach(async () => {
    await relay?.close();
  });

  test('listens on loopback only and needs no login from Chromium', async () => {
    relay = await SocksRelay.start(upstream());
    expect(relay.address().address).toBe('127.0.0.1');
    expect(relay.url).toBe(`socks5://127.0.0.1:${relay.port}`);
    // a client with no credentials: what Chromium is
    const s = await connectThrough({ scheme: 'socks5', host: '127.0.0.1', port: relay.port }, { host: 'site.example', port: sitePort });
    expect(await get(s)).toContain('ip=203.0.113.9');
    // the relay did the upstream login
    expect(asked).toEqual([`site.example:${sitePort}`]);
  });

  test('passes an IPv4 target through, and many connections at once', async () => {
    relay = await SocksRelay.start(upstream());
    const before = logins;
    const answers = await Promise.all(
      [1, 2, 3, 4].map(async () => get(await connectThrough({ scheme: 'socks5', host: '127.0.0.1', port: relay.port }, { host: '127.0.0.1', port: sitePort }))),
    );
    for (const a of answers) expect(a).toContain('loc=VN');
    expect(logins - before).toBe(4);
  });

  test('an upstream that refuses the login fails the client, and nothing logs the password or user', async () => {
    relay = await SocksRelay.start({ ...upstream(), password: 'wrong-password-123' });
    const err = await connectThrough({ scheme: 'socks5', host: '127.0.0.1', port: relay.port }, { host: 'site.example', port: sitePort }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(relay.failures).toBe(1);
    const all = logs.join('\n');
    expect(all).not.toContain('wrong-password-123');
    expect(all).not.toContain(PASS);
  });

  test('a client that only speaks a login is turned away, and BIND is refused', async () => {
    relay = await SocksRelay.start(upstream());
    const talk = (bytes: number[][]) =>
      new Promise<number[]>((done) => {
        const s = connect({ host: '127.0.0.1', port: relay.port }, () => {
          for (const b of bytes) s.write(Buffer.from(b));
        });
        const got: number[] = [];
        s.on('data', (d) => got.push(...(d as Buffer)));
        s.on('close', () => done(got));
        s.on('error', () => done(got));
      });
    expect(await talk([[5, 1, 2]])).toEqual([5, 0xff]);
    // greeting, then BIND (2) to 1.2.3.4:80
    expect((await talk([[5, 1, 0], [5, 2, 0, 1, 1, 2, 3, 4, 0, 80]])).slice(0, 4)).toEqual([5, 0, 5, 7]);
    expect(asked).toEqual([]);
  });

  test('close stops it listening', async () => {
    relay = await SocksRelay.start(upstream());
    const port = relay.port;
    await relay.close();
    const err = await connectThrough({ scheme: 'socks5', host: '127.0.0.1', port }, { host: 'x', port: 1 }, 2_000).catch((e: Error) => e);
    expect((err as Error).message).toBe('the proxy refused the connection');
  });
});
