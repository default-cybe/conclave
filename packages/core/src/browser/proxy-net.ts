/**
 * Proxies on the wire: a tunnel through a SOCKS5 or HTTP proxy, a quick
 * check and an exit IP test, and the loopback relay.
 *
 * Chromium speaks SOCKS5 without a user name and password only. For a SOCKS5
 * proxy that needs them, the hub runs a relay on 127.0.0.1: Chromium talks
 * to it with no auth, and the relay logs in to the upstream proxy (RFC 1929)
 * for each connection. The password never reaches Chromium's command line,
 * where any process on the machine could read it. The relay listens on
 * loopback only and speaks CONNECT only.
 *
 * Nothing here logs a password, a user name or a list URL.
 */
import { createServer, connect as netConnect, isIP, type Server, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { logger } from '../util/log';
import { proxyLabel, type ProxyEntry } from './proxy-list';

const log = logger('browser');

export interface Target {
  host: string;
  port: number;
}

/** A proxy failed. `code` is the SOCKS5 reply code when the proxy sent one. */
export class ProxyError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

const SOCKS_REPLY: Record<number, string> = {
  1: 'general failure',
  2: 'not allowed by its rules',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

/** Reads exact byte counts from a socket during a handshake, then hands back what is left. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private failed?: Error;
  private readonly onData = (d: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this.wake();
  };
  private readonly onEnd = () => {
    this.failed ??= new ProxyError('the connection closed during the handshake');
    this.wake();
  };
  private readonly onError = (e: Error) => {
    this.failed ??= e;
    this.wake();
  };

  constructor(private readonly sock: Socket) {
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Wait for the next chunk; rejects once the socket is gone. */
  private more(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((done, fail) => this.waiters.push(() => (this.failed ? fail(this.failed) : done())));
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Bytes up to and including the first blank line, at most `max`. */
  async readHead(max = 16 * 1024): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i >= 0) return (await this.read(i + 4)).toString('latin1');
      if (this.buf.length > max) throw new ProxyError('the proxy sent a header that is too long');
      await this.more();
    }
  }

  /** Stop reading; what came after the handshake. */
  release(): Buffer {
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

/** The SOCKS5 address of a target: ATYP and address bytes, then the port. */
export function socksAddress(t: Target): Buffer {
  const port = Buffer.from([(t.port >> 8) & 0xff, t.port & 0xff]);
  const kind = isIP(t.host);
  if (kind === 4) return Buffer.concat([Buffer.from([1]), Buffer.from(t.host.split('.').map(Number)), port]);
  if (kind === 6) return Buffer.concat([Buffer.from([4]), ipv6Bytes(t.host), port]);
  const name = Buffer.from(t.host, 'utf8');
  if (name.length > 255) throw new ProxyError('the host name is too long for SOCKS5');
  return Buffer.concat([Buffer.from([3, name.length]), name, port]);
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail = ''] = host.split('::');
  const parse = (s: string) => (s ? s.split(':') : []);
  let left = parse(head);
  let right = parse(tail);
  // an embedded IPv4 tail
  const v4 = (parts: string[]) => {
    const last = parts[parts.length - 1];
    if (last && last.includes('.')) {
      const b = last.split('.').map(Number);
      parts.splice(parts.length - 1, 1, ((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
    }
    return parts;
  };
  if (host.includes('::')) {
    left = v4(left);
    right = v4(right);
  } else left = v4(left);
  const fill = host.includes('::') ? new Array(8 - left.length - right.length).fill('0') : [];
  const words = [...left, ...fill, ...right];
  const out = Buffer.alloc(16);
  words.slice(0, 8).forEach((w, i) => out.writeUInt16BE(parseInt(w || '0', 16), i * 2));
  return out;
}

/** Read the rest of a SOCKS5 reply after VER REP RSV ATYP: the bound address and port. */
async function readBound(r: Reader, atyp: number): Promise<void> {
  if (atyp === 1) await r.read(4 + 2);
  else if (atyp === 4) await r.read(16 + 2);
  else if (atyp === 3) {
    const [len] = await r.read(1);
    await r.read(len + 2);
  } else throw new ProxyError('the proxy answered with an unknown address type');
}

function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((done, fail) => {
    const s = netConnect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      fail(new ProxyError(`no answer from the proxy in ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      done(s);
    });
    s.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new ProxyError(e.code === 'ECONNREFUSED' ? 'the proxy refused the connection' : e.code === 'ENOTFOUND' ? 'the proxy host name does not resolve' : `could not reach the proxy (${e.code ?? e.message})`));
    });
  });
}

/** Log in to a SOCKS5 proxy and ask it for a tunnel to the target. */
async function socks5Handshake(sock: Socket, r: Reader, p: ProxyEntry, t: Target): Promise<void> {
  const auth = !!p.username;
  sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await r.read(2);
  if (ver !== 5) throw new ProxyError('it is not a SOCKS5 proxy');
  if (method === 0xff) throw new ProxyError(auth ? 'the proxy accepts none of the login methods offered' : 'the proxy needs a user name and password');
  if (method === 2) {
    if (!auth) throw new ProxyError('the proxy needs a user name and password');
    const u = Buffer.from(p.username ?? '', 'utf8');
    const pw = Buffer.from(p.password ?? '', 'utf8');
    if (u.length > 255 || pw.length > 255) throw new ProxyError('the user name or password is too long for SOCKS5');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const [, status] = await r.read(2);
    if (status !== 0) throw new ProxyError('the proxy refused the user name or password', 0x100);
  } else if (method !== 0) throw new ProxyError('the proxy asked for a login method the hub does not speak');
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(t)]));
  const [v2, rep, , atyp] = await r.read(4);
  if (v2 !== 5) throw new ProxyError('the proxy answered the connect request with something else');
  await readBound(r, atyp);
  if (rep !== 0) throw new ProxyError(`the proxy could not connect: ${SOCKS_REPLY[rep] ?? `code ${rep}`}`, rep);
}

/** Ask an HTTP proxy for a CONNECT tunnel. */
async function httpHandshake(sock: Socket, r: Reader, p: ProxyEntry, t: Target): Promise<void> {
  const where = `${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port}`;
  const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}\r\n` : '';
  sock.write(`CONNECT ${where} HTTP/1.1\r\nHost: ${where}\r\n${auth}\r\n`);
  const head = await r.readHead();
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  if (status === 407) throw new ProxyError('the proxy refused the user name or password', 0x100);
  if (status < 200 || status > 299) throw new ProxyError(status ? `the proxy answered ${status} to CONNECT` : 'it is not an HTTP proxy');
}

/**
 * A socket that reaches the target through the proxy. Bytes the proxy sent
 * after its handshake are pushed back so the caller reads them first.
 */
export async function connectThrough(p: ProxyEntry, t: Target, timeoutMs = 10_000): Promise<Socket> {
  const sock = await openSocket(p.host, p.port, timeoutMs);
  const r = new Reader(sock);
  const timer = setTimeout(() => sock.destroy(new ProxyError(`the proxy did not finish in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  try {
    if (p.scheme === 'socks5') await socks5Handshake(sock, r, p, t);
    else await httpHandshake(sock, r, p, t);
  } catch (err) {
    sock.destroy();
    throw err instanceof ProxyError ? err : new ProxyError(String((err as Error)?.message ?? err));
  } finally {
    clearTimeout(timer);
  }
  const rest = r.release();
  if (rest.length) sock.unshift(rest);
  return sock;
}

/** Where the exit IP test asks. Cloudflare's trace page answers ip= and loc= (the country) with no key. */
export const PROBE_TARGET = { host: 'www.cloudflare.com', port: 443, tls: true, path: '/cdn-cgi/trace' };

export interface ProbeTarget {
  host: string;
  port: number;
  tls: boolean;
  path: string;
}

export interface ProbeResult {
  ok: boolean;
  /** proxyLabel: no password. */
  proxy: string;
  ip?: string;
  /** ISO country code, as the trace page says it. */
  country?: string;
  ms: number;
  error?: string;
}

/** A GET through an open socket; the whole answer, at most 64 KB. */
function getOver(sock: Socket, target: ProbeTarget, timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    let s: Socket = sock;
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      s.destroy();
      fail(new ProxyError(`no answer through the proxy in ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString('utf8'));
    };
    const start = () => {
      s.on('data', (d: Buffer) => {
        size += d.length;
        if (size <= 64 * 1024) chunks.push(d);
        else s.destroy();
      });
      s.on('end', finish);
      s.on('close', finish);
      s.on('error', (e) => {
        clearTimeout(timer);
        fail(new ProxyError(`the page through the proxy failed: ${e.message}`));
      });
      s.write(`GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: conclave-proxy-check\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    };
    if (target.tls) {
      s = tlsConnect({ socket: sock, servername: isIP(target.host) ? undefined : target.host }, start);
      s.once('error', (e) => {
        clearTimeout(timer);
        fail(new ProxyError(`TLS through the proxy failed: ${e.message}`));
      });
    } else start();
  });
}

/** Read ip= and loc= from a Cloudflare trace answer (headers included). */
export function parseTrace(answer: string): { ip?: string; country?: string } {
  const body = answer.includes('\r\n\r\n') ? answer.slice(answer.indexOf('\r\n\r\n') + 4) : answer;
  const ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim();
  const loc = /^loc=([A-Za-z]{2})$/m.exec(body)?.[1]?.toUpperCase();
  return { ...(ip ? { ip } : {}), ...(loc ? { country: loc } : {}) };
}

/**
 * Check a proxy. quick: only the tunnel opens.
 * Otherwise also fetch the trace page through it: the exit IP and country.
 */
export async function probeProxy(p: ProxyEntry, opts: { quick?: boolean; timeoutMs?: number; target?: ProbeTarget } = {}): Promise<ProbeResult> {
  const target = opts.target ?? PROBE_TARGET;
  const timeoutMs = opts.timeoutMs ?? (opts.quick ? 6_000 : 15_000);
  const started = Date.now();
  const proxy = proxyLabel(p);
  let sock: Socket | undefined;
  try {
    sock = await connectThrough(p, { host: target.host, port: target.port }, timeoutMs);
    if (opts.quick) return { ok: true, proxy, ms: Date.now() - started };
    const answer = await getOver(sock, target, Math.max(1_000, timeoutMs - (Date.now() - started)));
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? 0);
    const t = parseTrace(answer);
    if (status !== 200 || !t.ip) return { ok: false, proxy, ms: Date.now() - started, error: status ? `the test page answered ${status}` : 'the test page did not answer' };
    return { ok: true, proxy, ...t, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, proxy, ms: Date.now() - started, error: String((err as Error)?.message ?? err) };
  } finally {
    sock?.destroy();
  }
}

// ---------------------------------------------------------------------------
// The loopback relay
// ---------------------------------------------------------------------------

const HANDSHAKE_MS = 15_000;

/** A SOCKS5 server on 127.0.0.1 with no auth that opens each connection through one upstream proxy. */
export class SocksRelay {
  private sockets = new Set<Socket>();
  private closed = false;
  /** Connections it could not open upstream, for tests and the log. */
  failures = 0;

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly upstream: ProxyEntry,
    private readonly timeoutMs: number,
  ) {}

  /** Start a relay for this upstream on 127.0.0.1 and a free port. */
  static start(upstream: ProxyEntry, opts: { timeoutMs?: number } = {}): Promise<SocksRelay> {
    return new Promise((done, fail) => {
      let relay: SocksRelay | undefined;
      const server = createServer((client) => relay?.handle(client));
      server.once('error', fail);
      // loopback only: nothing else on the network may use the owner's proxy through the hub
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          fail(new Error('the proxy relay has no port'));
          return;
        }
        relay = new SocksRelay(server, addr.port, upstream, opts.timeoutMs ?? HANDSHAKE_MS);
        done(relay);
      });
    });
  }

  /** What Chromium gets as its proxy server. */
  get url(): string {
    return `socks5://127.0.0.1:${this.port}`;
  }

  /** The address it listens on, for tests. */
  address(): { address: string; port: number } {
    const a = this.server.address();
    return typeof a === 'object' && a ? { address: a.address, port: a.port } : { address: '', port: 0 };
  }

  get label(): string {
    return proxyLabel(this.upstream);
  }

  private async handle(client: Socket): Promise<void> {
    if (this.closed) {
      client.destroy();
      return;
    }
    this.sockets.add(client);
    client.once('close', () => this.sockets.delete(client));
    client.on('error', () => {});
    const r = new Reader(client);
    const timer = setTimeout(() => client.destroy(), this.timeoutMs);
    let upstream: Socket | undefined;
    const reply = (rep: number) => client.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
    try {
      const [ver, n] = await r.read(2);
      if (ver !== 5) throw new ProxyError('not SOCKS5');
      const methods = await r.read(n);
      if (!methods.includes(0)) {
        client.write(Buffer.from([5, 0xff]));
        throw new ProxyError('the client wants a login');
      }
      client.write(Buffer.from([5, 0]));
      const [v, cmd, , atyp] = await r.read(4);
      if (v !== 5) throw new ProxyError('not SOCKS5');
      let host: string;
      if (atyp === 1) host = [...(await r.read(4))].join('.');
      else if (atyp === 3) {
        const [len] = await r.read(1);
        host = (await r.read(len)).toString('utf8');
      } else if (atyp === 4) {
        const b = await r.read(16);
        host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');
      } else {
        reply(8);
        throw new ProxyError('unknown address type');
      }
      const pb = await r.read(2);
      const port = (pb[0] << 8) | pb[1];
      if (cmd !== 1) {
        // CONNECT only: no BIND, no UDP
        reply(7);
        throw new ProxyError('only CONNECT');
      }
      try {
        upstream = await connectThrough(this.upstream, { host, port }, this.timeoutMs);
      } catch (err) {
        this.failures++;
        const code = err instanceof ProxyError && err.code !== undefined && err.code < 0x100 ? err.code : 1;
        reply(code);
        // the target is the page's business; the upstream's label has no password
        log.debug(`proxy relay: ${this.label} could not connect: ${(err as Error).message}`);
        throw err;
      }
      clearTimeout(timer);
      reply(0);
      const rest = r.release();
      const up = upstream;
      this.sockets.add(up);
      up.once('close', () => this.sockets.delete(up));
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
      if (rest.length) up.write(rest);
      client.pipe(up);
      up.pipe(client);
      up.once('close', () => client.destroy());
      client.once('close', () => up.destroy());
    } catch {
      clearTimeout(timer);
      upstream?.destroy();
      client.end();
      setTimeout(() => client.destroy(), 1_000).unref?.();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}
