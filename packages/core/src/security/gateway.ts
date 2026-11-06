/**
 * The egress gateway (docs/design/SECURITY-MODE.md 4.2): a small forward
 * proxy, one per hunt, that a Security mode session's shell and its validator
 * reach the network through (HTTP_PROXY / HTTPS_PROXY, session/egress.ts).
 *
 * - Lab hosts (loopback, the hunt's sec-lab-<t> networks) pass.
 * - A non-lab host passes only while a live approval grant covers it, checked
 *   against the scope the grant was approved on (pinned), and never when it
 *   is out of scope or outside the in-scope paths. Unlisted hosts are refused.
 * - Each granted request takes a token at the grant's rate (429 when over)
 *   and counts once toward its budget (`used`); a spent, expired or revoked
 *   grant is refused.
 * - Every request line, passed or refused, goes to the log (egress.log).
 * - The proxy listens on 127.0.0.1 and wants its own credentials, so another
 *   local process cannot spend this hunt's grant.
 *
 * shortcut: an HTTPS tunnel (CONNECT) counts as one request and its path is not seen (no TLS interception), so `paths` limits plain HTTP only; upgrade with a MITM CA in the hunt container.
 * shortcut: in-process on the hub, so a program that ignores the proxy variables (raw sockets) is not stopped; the design's per-hunt Madx container with only this proxy as its way out closes that.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { classify, classifyAll, grantLive, hostMatches, normHost, type Scope, type ScopeGrant, type ScopeState } from './scope';

export interface GatewayVerdict {
  allow: boolean;
  /** HTTP status of a refusal: 403, or 429 over the rate. */
  status: number;
  reason: string;
  grant?: ScopeGrant;
  lab?: boolean;
}

const NO_SCOPE: Scope = { program: '', inScope: [], paths: [], outOfScope: [], lab: [], callback: [], rateLimitRps: 1, requestBudget: 1, accounts: [], no: [] };

/** The gateway's answer for one request, before the rate. Pure. */
export function gatewayDecide(state: ScopeState, grants: ScopeGrant[], rawHost: string, path: string | undefined, now: number): GatewayVerdict {
  const host = normHost(rawHost);
  const scopes = state.kind === 'ok' ? state.scopes : [];
  const c = scopes.length ? classifyAll(scopes, host, path) : classify(NO_SCOPE, host);
  if (c === 'lab') return { allow: true, status: 200, reason: 'lab', lab: true };
  const refuse = (reason: string): GatewayVerdict => ({ allow: false, status: 403, reason });
  if (state.kind !== 'ok') return refuse(state.kind === 'bad' ? `the scope file is not usable (${state.why}); only lab hosts pass` : 'no scope.yaml for this hunt; only lab hosts pass');
  if (c === 'out') return refuse(`${host}${path ?? ''} is out of scope`);
  if (c === 'in-bad-path') return refuse(`${host}${path ?? ''} is outside the in-scope paths`);
  if (c === 'unknown') return refuse(`${host} is not in scope.yaml; only lab hosts and granted in-scope hosts pass`);
  const mine = grants.filter((g) => Array.isArray(g?.hosts) && g.hosts.some((h) => hostMatches(h, host)));
  // the pinned scope decides, so an edit of scope.yaml after the approval cannot widen the grant
  const live = mine.find((g) => grantLive(g, now) && (!g.scope || classify(g.scope, host, path) === 'in'));
  if (live) return { allow: true, status: 200, reason: 'granted', grant: live };
  if (!mine.length) return refuse(`${host} is in scope but no approval grant covers it`);
  const g = mine[mine.length - 1];
  if (g.revokedAt) return refuse(`the grant for ${host} was revoked`);
  if (now >= g.expiresAt) return refuse(`the grant for ${host} expired`);
  if ((g.used ?? 0) >= g.requestBudget) return refuse(`the grant for ${host} spent its budget of ${g.requestBudget} requests`);
  return refuse(`the grant for ${host} does not cover ${host}${path ?? ''} in the scope it was approved on`);
}

export interface GatewayOptions {
  /** The hunt's scope files now. */
  scope(): Promise<ScopeState>;
  /** The hunt's grants now (kv). */
  grants(): ScopeGrant[];
  /** Count one request on a grant. */
  count(grantId: string): void;
  /** One line per request, for egress.log. */
  log(line: string, host: string): void;
  now?(): number;
  /** Tests: where a host:port really connects. */
  dial?(host: string, port: number): Socket;
}

/** "host:443", "[::1]:8443" */
function splitAuthority(a: string): { host: string; port: number } | undefined {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(a);
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : undefined;
}

const REASON: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 407: 'Proxy Authentication Required', 429: 'Too Many Requests', 502: 'Bad Gateway' };

export class EgressGateway {
  private server?: Server;
  private port = 0;
  private readonly token = randomBytes(18).toString('base64url');
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly sockets = new Set<Socket>();
  /** Open CONNECT tunnels and the grant each was let through on. */
  private readonly tunnels = new Map<Socket, string>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private opts: GatewayOptions) {}

  /** The proxy URL with its credentials, for HTTP(S)_PROXY. */
  get url(): string {
    return `http://conclave:${this.token}@127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.onRequest(req, res));
    server.on('connect', (req: IncomingMessage, sock: Socket, head: Buffer) => void this.onConnect(req, sock, head));
    server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.port = (server.address() as { port: number }).port;
    this.server = server;
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.sweeper.unref?.();
  }

  /** Close the tunnels whose grant was revoked or expired since they opened (a tunnel otherwise outlives its grant). */
  sweep(): void {
    if (!this.tunnels.size) return;
    const now = this.now();
    let grants: ScopeGrant[];
    try {
      grants = this.opts.grants();
    } catch {
      grants = [];
    }
    for (const [sock, id] of this.tunnels) {
      const g = grants.find((x) => x?.id === id);
      if (!g || g.revokedAt || now >= g.expiresAt) sock.destroy();
    }
  }

  stop(): void {
    clearInterval(this.sweeper);
    for (const s of this.sockets) s.destroy();
    this.server?.close();
    this.server = undefined;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers['proxy-authorization'];
    const m = typeof h === 'string' ? /^Basic\s+(\S+)$/i.exec(h) : null;
    if (!m) return false;
    const got = Buffer.from(Buffer.from(m[1], 'base64').toString('utf8'));
    const want = Buffer.from(`conclave:${this.token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** The decision, the rate and the count for one request, logged. */
  async check(method: string, host: string, port: number, path?: string): Promise<GatewayVerdict> {
    const now = this.now();
    let v: GatewayVerdict;
    try {
      v = gatewayDecide(await this.opts.scope(), this.opts.grants(), host, path, now);
    } catch (err) {
      v = { allow: false, status: 403, reason: `could not read the hunt's scope: ${(err as Error).message}` };
    }
    if (v.allow && v.grant) {
      const g = v.grant;
      const cap = Math.max(1, g.rateRps);
      const b = this.buckets.get(g.id) ?? { tokens: cap, at: now };
      b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * g.rateRps);
      b.at = now;
      if (b.tokens < 1) v = { allow: false, status: 429, reason: `over the grant's rate of ${g.rateRps} requests per second`, grant: g };
      else {
        b.tokens -= 1;
        this.opts.count(g.id);
      }
      this.buckets.set(g.id, b);
    }
    const tag = v.lab ? 'lab' : (v.grant?.id ?? '-');
    try {
      this.opts.log(`${new Date(now).toISOString()} ${v.allow ? 'PASS' : `REFUSE ${v.status}`} ${tag} ${method} ${normHost(host)}:${port}${path ?? ''}${v.allow ? '' : ` ${v.reason}`}`, normHost(host));
    } catch {
      /* the log never breaks a request */
    }
    return v;
  }

  private dial(host: string, port: number): Socket {
    return this.opts.dial ? this.opts.dial(host, port) : connect({ host, port });
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deny = (status: number, text: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-conclave-egress': 'refused', connection: 'close', ...extra });
      res.end(`Conclave egress gateway: ${text}\n`);
    };
    if (!this.authorized(req)) return deny(407, 'proxy credentials missing or wrong', { 'proxy-authenticate': 'Basic realm="conclave-egress"' });
    let u: URL;
    try {
      u = new URL(req.url ?? '');
    } catch {
      return deny(400, 'send absolute URLs (this is a forward proxy)');
    }
    if (u.protocol !== 'http:') return deny(400, `${u.protocol} is not proxied here; HTTPS goes through CONNECT`);
    const port = Number(u.port) || 80;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // the path as the server reads it: %6c is l, so an encoded out_of_scope path is still out
    let path: string;
    try {
      path = new URL(decodeURIComponent(u.pathname), 'http://h').pathname;
    } catch {
      return deny(400, 'the path has a broken %-escape');
    }
    const v = await this.check(req.method ?? 'GET', host, port, path);
    if (!v.allow) return deny(v.status, v.reason);
    const headers = { ...req.headers };
    // the checked host is the one the server sees: a Host header naming another (out-of-scope) vhost on the same server is replaced
    headers.host = u.host;
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = httpRequest({ host, port, method: req.method, path: `${u.pathname}${u.search}`, headers, ...(this.opts.dial ? { createConnection: () => this.dial(host, port) } : {}) });
    up.on('response', (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Conclave egress gateway: upstream error: ${err.message}\n`);
    });
    req.pipe(up);
  }

  private async onConnect(req: IncomingMessage, sock: Socket, head: Buffer): Promise<void> {
    sock.on('error', () => sock.destroy());
    const refuse = (status: number, text: string, extra = '') => {
      const body = `Conclave egress gateway: ${text}\n`;
      sock.end(`HTTP/1.1 ${status} ${REASON[status] ?? 'Forbidden'}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Conclave-Egress: refused\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    if (!this.authorized(req)) return refuse(407, 'proxy credentials missing or wrong', 'Proxy-Authenticate: Basic realm="conclave-egress"\r\n');
    const t = splitAuthority(req.url ?? '');
    if (!t) return refuse(400, 'CONNECT wants host:port');
    const v = await this.check('CONNECT', t.host, t.port);
    if (!v.allow) return refuse(v.status, v.reason);
    const up = this.dial(t.host, t.port);
    let open = false;
    up.on('error', () => {
      if (open) sock.destroy();
      else if (!sock.destroyed) refuse(502, 'upstream connection failed');
    });
    up.once('connect', () => {
      open = true;
      if (v.grant) {
        this.tunnels.set(sock, v.grant.id);
        sock.on('close', () => this.tunnels.delete(sock));
      }
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    sock.on('close', () => up.destroy());
  }
}
