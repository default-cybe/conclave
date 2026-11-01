/**
 * The hub's HTTP + WebSocket server. createServer() builds the handlers for
 * Bun.serve; startServer() also listens on config.server.host/port.
 *
 *   /api/*        REST (bearer token), contract in core/src/client/index.ts
 *   /api/ws       live engine events for clients
 *   /api/daemon   device daemons (device token)
 *   /gw/*         model gateway (gateway keys or relayed upstream credentials)
 *   /v1/metrics   OTLP/HTTP JSON ingest (gateway key or owner token)
 *   /mcp          Conclave's own MCP server for other tools (gateway key, client or owner token, or an OAuth token)
 *   /oauth/*, /.well-known/oauth-*  the hub as the OAuth server for /mcp (claude.ai, ChatGPT)
 *   /peer/v1/*    friends' hubs (signed requests, checked by the peer verifier only; peer/routes.ts)
 *   (CLIProxyAPI, when the hub runs it, listens on 127.0.0.1 only and is never proxied here)
 *   everything else: the web app (SPA)
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { LimitState, UsageRecord } from '@conclave/core/types.ts';
import { logEvent, logger } from '@conclave/core/util/log.ts';
import { HubLogs } from '@conclave/core/logs/index.ts';
import { Auth, RateLimiter, bearerToken } from './auth';
import { actionSecret as loadActionSecret, signActionWith } from './actions';
import type { HonoEnv, ServerContext, WsData } from './context';
import { clientIp, credentialMark, errorStatus, isDirectLocal, peerAddress, readJson, setTrustedProxies } from './http';
import { ClientHub, type ClientSocketData } from './ws/clients';
import { DaemonHub, type DaemonSocketData } from './ws/daemons';
import { Gateway, wireError, type WireType } from './gateway';
import { OtlpIngest } from './otlp';
import { announceApp, registerRoutes } from './routes';
import { registerMcpEndpoint } from './mcp-endpoint';
import { OAuthService, registerOAuthRoutes, type OAuthOptions } from './oauth';
import { registerRemoteRoutes } from './routes-remote';
import { registerSubscriptionRoutes } from './routes-subscriptions';
import { registerAccountRoutes } from './routes-accounts';
import { registerAlertRoutes } from './routes-alerts';
import { registerLogRoutes } from './routes-logs';
import { startLoopLagWatch, type LoopLagWatch } from './lag';
import { CliproxyManager, type CliproxyOptions } from './cliproxy';
import { MemberPlansManager } from './cliproxy/member';
import { RemoteAccess, type RemoteOptions } from './remote';
import { FailureGuard } from './guard';
import { loadHubKey } from './identity';
import { PeerService, type PeerOptions } from './peer/service';
import { createMapLive, registerMapRoutes } from './routes-map';
import { registerFriendRoutes, registerPeerRoutes, registerShareRoutes } from './peer/routes';
import { registerSharedProjectRoutes } from './peer/project-routes';
import { isLocalPeer, isWildcard } from './remote/lan';
import { runAs } from '@conclave/core/people/context.ts';
import { routePolicy } from './route-policy';
import { registerPeopleRoutes } from './routes-people';
import { registerSharedChatRoutes } from './routes-shared-chats';
import { SECURITY_HEADERS, placeholderPage, resolveWebDir, serveStatic, webDirCandidates } from './static';
import { UpdateService, type UpdateOptions } from './update/service';
import { registerUpdateRoutes } from './routes-update';
import { registerMeetingRoutes } from './routes-meetings';

const log = logger('server');

export interface ServerOptions {
  engine: EngineApi;
  /** Web build to serve. Default: packages/web/dist, then ~/.conclave/web. */
  webDir?: string;
  /** Gateway hooks. Defaults write to repos.usage and emit bus events. */
  gateway?: {
    onUsage?: (record: UsageRecord) => void;
    onLimit?: (limit: LimitState) => void;
    /** Upstream fetch (tests). */
    fetch?: typeof fetch;
  };
  /** Daemon heartbeat and RPC timeout overrides (tests). */
  heartbeatMs?: number;
  rpcTimeoutMs?: number;
  /** Remote access overrides (tests: a fake cloudflared, fake interfaces). */
  remote?: Omit<Partial<RemoteOptions>, 'engine' | 'onAddresses'>;
  /** OAuth overrides (tests: a clock, client document fetching). */
  oauth?: OAuthOptions;
  /** Subscription sign-in overrides (tests: a fake CLIProxyAPI and release). */
  cliproxy?: Omit<Partial<CliproxyOptions>, 'engine'>;
  /** Friends overrides (tests: a running scheduler, short backoff, a clock). */
  peer?: PeerOptions;
  /** Update overrides (tests: a fake release server, an install, a key, the finisher in this process). */
  update?: UpdateOptions;
}

export interface ConclaveServer {
  /** Pass to Bun.serve. */
  fetch: (req: Request, server: Server<WsData>) => Response | Promise<Response>;
  websocket: WebSocketHandler<WsData>;
  app: Hono<HonoEnv>;
  ctx: ServerContext;
  webDir: string | undefined;
  /** Signature for a one-tap approval link (see actions.ts). */
  signAction(approvalId: string, decision: string): string;
  /** Stop timers, close sockets, unsubscribe from the bus. */
  close(): void;
}

/**
 * Public to the bearer check: friends' hubs call these with signed requests,
 * and only the peer verifier (peer/service.ts verify) checks them, never
 * Auth.check. They sit outside /api, so the bearer middleware never sees them.
 */
const PEER_ROUTES = /^\/peer\/v1\//;

/** Routes that skip the bearer check (they have their own auth or none). */
const PUBLIC_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/api\/health$/],
  ['POST', /^\/api\/pair$/],
  ['POST', /^\/api\/login$/],
  ['GET', /^\/api\/identity$/],
  ['POST', /^\/api\/daemon\/register$/],
  ['POST', /^\/api\/daemon\/unpair$/],
  ['GET', /^\/api\/daemon$/],
  ['POST', /^\/api\/routines\/[^/]+\/trigger$/],
  ['POST', /^\/api\/approvals\/[^/]+\/act$/],
  ['GET', /^\/api\/approvals\/[^/]+\/act$/],
  // an invite link: its own secret (routes-people.ts)
  ['GET', /^\/api\/invite\/[^/]+$/],
  ['POST', /^\/api\/invite\/[^/]+$/],
  // Google sends the browser back here; the state is checked against a sign-in the owner started (routes-pim.ts)
  ['GET', /^\/api\/pim\/oauth\/google\/callback$/],
  // an MCP server's sign-in page sends the browser back here; same state check (extensions/mcp-oauth.ts)
  ['GET', /^\/api\/mcp\/oauth\/callback$/],
];

function isLocalOrigin(origin: string): boolean {
  return (
    /^(tauri|capacitor|app):\/\//i.test(origin) ||
    /^https?:\/\/(tauri\.)?localhost(:\d+)?$/i.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) ||
    /^https?:\/\/\[::1\](:\d+)?$/.test(origin)
  );
}

export function createServer(opts: ServerOptions): ConclaveServer {
  const { engine } = opts;
  const auth = new Auth(engine);
  const actionSecret = loadActionSecret(engine.repos.kv);
  // a proxy on another machine (cloudflared in its own container): lockouts count the visitor behind it
  setTrustedProxies(engine.config.get().server.trustedProxies);
  engine.config.onChange(() => setTrustedProxies(engine.config.get().server.trustedProxies));
  // daemons and friends hear every address change; the remote module asks the daemon hub and the peer service to send it
  let daemons: DaemonHub | undefined;
  let peer: PeerService | undefined;
  const remote = new RemoteAccess({
    ...opts.remote,
    engine,
    onAddresses: (urls) => {
      daemons?.sendAddresses(urls);
      peer?.addressesChanged();
    },
  });
  daemons = new DaemonHub(engine, { heartbeatMs: opts.heartbeatMs, rpcTimeoutMs: opts.rpcTimeoutMs, addresses: () => remote.addresses().map((a) => a.url) });
  const identity = loadHubKey(engine.config.paths.home);
  peer = new PeerService({ engine, identity, remote }, opts.peer);
  const clients = new ClientHub(engine);
  const ctx: ServerContext = {
    engine,
    auth,
    clients,
    daemons,
    gateway: new Gateway({ engine, auth, ...opts.gateway }),
    otlp: new OtlpIngest(),
    actionSecret,
    identity,
    pairLimiter: new RateLimiter(10, 60_000),
    webhookLimiter: new RateLimiter(20, 60_000),
    remote,
    authGuard: new FailureGuard({ limit: 20, windowMs: 10 * 60_000, blockMs: 60_000, maxBlockMs: 3_600_000 }),
    pairGuard: new FailureGuard({ limit: 10, windowMs: 10 * 60_000, blockMs: 60_000, maxBlockMs: 3_600_000 }),
    oauth: new OAuthService({ engine }, opts.oauth),
    cliproxy: new CliproxyManager({ ...opts.cliproxy, engine }),
    memberPlans: new MemberPlansManager({ ...opts.cliproxy, engine }),
    peer,
    map: createMapLive(engine, () => clients.mapWatchers > 0),
    logs: new HubLogs({ config: engine.config, version: engine.version }),
    updates: new UpdateService(engine, opts.update),
  };
  // a phone that connects or goes away shows as online or offline on Devices
  clients.onPresence = (id) => announceApp(ctx, id);
  // a member's cliproxy calls go to their own CLIProxyAPI first (people/plans.ts)
  engine.access.setPlans(ctx.memberPlans);
  // how the last update went, and the daily check (off under bun test)
  ctx.updates.start();
  // one warn line whenever the event loop stalls, so the cause shows in the log (optimisation review 2026-11-01, fix 3)
  const lagWatch: LoopLagWatch = startLoopLagWatch();
  // the hub's home (CONCLAVE_HOME) first among the places a build can be put, then next to the binary
  const webPlaces = [opts.webDir, ...webDirCandidates(), engine.config.paths.web].filter((p): p is string => !!p);
  let webDir = resolveWebDir(webPlaces);

  const app = new Hono<HonoEnv>();

  // ----- errors ------------------------------------------------------------
  app.onError((err, c) => {
    const status = errorStatus(err);
    if (status >= 500) log.error(`${c.req.method} ${new URL(c.req.url).pathname} failed`, err);
    const headers: Record<string, string> = {};
    const retryAfter = (err as { retryAfter?: number }).retryAfter;
    if (retryAfter) headers['retry-after'] = String(retryAfter);
    const message = status >= 500 && !(err as Error)?.message ? 'internal error' : ((err as Error)?.message ?? String(err));
    // field: which form field a 400 is about (meeting create/patch), so the form shows it under that field
    const field = (err as { field?: unknown }).field;
    return c.json({ error: message, ...(status < 500 && typeof field === 'string' ? { field } : {}) }, status as 400, headers);
  });

  // ----- 5xx answers go to the log files, thrown or returned (docs/DESIGN.md 33) ---
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const status = c.res.status;
    if (status < 500) return;
    const path = new URL(c.req.url).pathname;
    const err = c.error;
    // a thrown error already has its line with the stack (onError above); an upstream model's 5xx on the gateway is not the hub's fault
    const level = err || path.startsWith('/gw/') ? 'warn' : 'error';
    logEvent(level, 'http', 'server error', { method: c.req.method, path, status, durationMs: Date.now() - started, ...(err ? { error: err } : {}) });
  });

  // ----- headers, CORS, auth -----------------------------------------------
  app.use('*', async (c, next) => {
    await next();
    // upgraded sockets and streamed bodies keep their headers; set only what is missing
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    } catch {
      /* immutable headers (fetch passthrough); fine */
    }
  });

  // ----- who may connect: the same network, and addresses that keep failing ---
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!remote.allowPeer(peerAddress(c))) {
      const msg = remote.status().lan.on
        ? 'This hub answers its own network and its remote address, not the internet directly. Use the remote address: Settings, Remote access on the hub shows it.'
        : 'This hub only answers this computer and its remote address. On the hub, turn on Devices on this network in Settings, Remote access.';
      // code: an app checking the hub's key tells this refusal from a stranger's 403
      return path.startsWith('/api/') || path === '/mcp' ? c.json({ error: msg, code: 'network' }, 403) : c.text(msg, 403);
    }
    if (!(path.startsWith('/api/') || path === '/mcp' || path.startsWith('/v1/') || path.startsWith('/gw/') || path.startsWith('/oauth/') || PEER_ROUTES.test(path))) return next();
    const ip = clientIp(c);
    // requests from this machine with no proxy in front are never blocked; tunnel and proxy requests always count
    const local = isDirectLocal(c);
    const wait = local || path === '/api/health' ? 0 : ctx.authGuard.blocked(ip);
    if (wait) return c.json({ error: `Too many failed attempts from this address. Try again in ${wait} seconds.` }, 429, { 'retry-after': String(wait) });
    await next();
    // gateway keys fail often for honest reasons (a CLI with an old key); only tokens count, each wrong one once.
    // /oauth counts its own failures (a wrong code is a 400 there), so it is not counted twice here
    if (local || c.res.status !== 401 || path.startsWith('/gw/') || path.startsWith('/oauth/')) return;
    const block = ctx.authGuard.fail(ip, Date.now(), credentialMark(c));
    if (block) {
      log.warn(`blocked ${ip} for ${block}s after repeated failed tokens`);
      try {
        engine.repos.audit.add({ actor: `ip:${ip}`, action: 'auth.blocked', detail: `${ctx.authGuard.opts.limit} different wrong tokens in 10 minutes, blocked for ${block}s` });
      } catch {
        /* auditing must not break the request */
      }
    }
  });

  app.use(
    '/api/*',
    cors({
      origin: (origin) => {
        if (!origin) return null;
        const server = engine.config.get().server;
        const extra = server.cors ?? [];
        if (extra.includes('*') || extra.includes(origin) || isLocalOrigin(origin) || remote.knownOrigins().has(origin)) return origin;
        try {
          if (server.publicUrl && new URL(server.publicUrl).origin === origin) return origin;
        } catch {
          /* bad publicUrl */
        }
        return null;
      },
      allowHeaders: ['authorization', 'content-type', 'x-conclave-secret'],
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    if (PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path))) return next();
    const token = bearerToken(c.req.raw, new URL(c.req.url), path === '/api/ws');
    const who = auth.check(token);
    if (!who) return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
    c.set('auth', who);
    return next();
  });

  // who may call which route, and whose ids are in its path (route-policy.ts, docs/design/ACCOUNTS.md 4)
  app.use('/api/*', routePolicy(ctx));

  // the rest of the request runs as the caller's account: the machine guard and every account-aware service read it
  app.use('/api/*', (c, next) => {
    const who = c.get('auth');
    return who ? runAs(who.accountId, () => next()) : next();
  });

  // ----- websockets --------------------------------------------------------
  const upgrade = (c: { env: Server<WsData> | undefined; req: { raw: Request } }, data: WsData): Response => {
    const server = c.env;
    if (!server?.upgrade) return Response.json({ error: 'websocket not supported here' }, { status: 500 });
    if ((c.req.raw.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return Response.json({ error: 'expected a websocket upgrade' }, { status: 426 });
    }
    return server.upgrade(c.req.raw, { data }) ? new Response(null) : Response.json({ error: 'upgrade failed' }, { status: 400 });
  };

  // ?active=0: the app connects from the background (see ClientSocketData.active)
  // a socket gets its own account's events only (ws/clients.ts)
  app.get('/api/ws', (c) => upgrade(c, { kind: 'client', clientId: c.get('auth').clientId, accountId: c.get('auth').accountId, filter: null, ...(c.req.query('active') === '0' ? { active: false } : {}) }));

  app.get('/api/daemon', (c) => {
    const url = new URL(c.req.url);
    const token = bearerToken(c.req.raw, url, true);
    const id = c.req.header('x-conclave-device') ?? url.searchParams.get('deviceId') ?? undefined;
    const deviceId = auth.checkDevice(id, token);
    if (!deviceId) return c.json({ error: 'unauthorized device' }, 401);
    return upgrade(c, { kind: 'daemon', deviceId, ip: clientIp(c) });
  });

  // ----- REST ----------------------------------------------------------------
  registerRoutes(app, ctx);

  // ----- accounts: who you are, and People for the owner (docs/design/ACCOUNTS.md) -----
  registerPeopleRoutes(app, ctx);

  // ----- shared chats: invites, participants, leave (docs/design/SHARED-WITH-MEMBERS.md) -----
  registerSharedChatRoutes(app, ctx);

  // ----- remote access (Settings, Remote access) ----------------------------
  registerRemoteRoutes(app, ctx);

  // ----- subscription sign-in (Settings > Models > Subscriptions) -------------
  registerSubscriptionRoutes(app, ctx);
  registerAccountRoutes(app, ctx);

  // ----- alerts: file conflicts and stuck turns, for the Inbox ---------------
  registerAlertRoutes(app, ctx);

  // ----- Conclave as an MCP server (/mcp), its OAuth server and its client snippets
  registerOAuthRoutes(app, ctx);
  registerMcpEndpoint(app, ctx);

  // ----- friends: other hubs on /peer/v1, the owner on /api/friends (docs/design/FRIENDS.md)
  registerPeerRoutes(app, ctx);
  registerFriendRoutes(app, ctx);
  registerShareRoutes(app, ctx);
  registerSharedProjectRoutes(app, ctx);

  // ----- the Map: GET /api/map, replay with ?at (docs/DESIGN.md 29)
  registerMapRoutes(app, ctx);

  // ----- hub logs: status, tail, errors, debug, app lines, export (docs/DESIGN.md 33)
  registerLogRoutes(app, ctx);

  // ----- updates: the hub's own and its devices' daemons (docs/DESIGN.md, Updates)
  registerUpdateRoutes(app, ctx);

  // ----- meeting mode: meetings, segments from the desktop app, answers, notes (docs/design/MEETING-MODE.md 3.1)
  registerMeetingRoutes(app, ctx);

  // ----- gateway -------------------------------------------------------------
  const gw = (type: WireType | undefined, prefix: (c: { req: { param: (k: string) => string } }) => string) => async (c: any) => {
    const url = new URL(c.req.url);
    const p = prefix(c);
    const rest = url.pathname.startsWith(p) ? url.pathname.slice(p.length) : '/';
    // a call that arrived through a tunnel or proxy from the internet may not relay without a gateway key
    const ip = clientIp(c);
    const remoteCall = ip !== 'local' && !isLocalPeer(ip);
    return ctx.gateway.handle(c.req.raw, { type, provider: type ? undefined : c.req.param('provider'), path: rest || '/', remote: remoteCall });
  };
  for (const type of ['anthropic', 'openai', 'gemini'] as const) {
    app.all(`/gw/${type}/*`, gw(type, () => `/gw/${type}`));
    app.all(`/gw/${type}`, gw(type, () => `/gw/${type}`));
  }
  app.all('/gw/p/:provider/*', gw(undefined, (c) => `/gw/p/${c.req.param('provider')}`));
  app.all('/gw/*', (c) => wireError(undefined, 404, 'unknown gateway route; use /gw/anthropic, /gw/openai, /gw/gemini or /gw/p/<provider>'));

  // ----- OTLP ingest ---------------------------------------------------------
  const otlpAuth = (req: Request): boolean => {
    const token = bearerToken(req, new URL(req.url), false) ?? req.headers.get('x-api-key') ?? undefined;
    return !!token && (auth.isOwner(token) || !!auth.checkGatewayKey(token));
  };
  app.post('/v1/metrics', async (c) => {
    if (!otlpAuth(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const type = c.req.header('content-type') ?? '';
    if (type.includes('protobuf')) {
      return c.json({ error: 'protobuf is not supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json' }, 415);
    }
    const body = await readJson(c);
    const rows = ctx.otlp.convert(body);
    for (const { record, extKey } of rows) {
      try {
        if (engine.repos.usage.insert(record, extKey)) engine.bus.emit({ type: 'usage.recorded', record });
      } catch (err) {
        log.warn(`otlp insert failed: ${(err as Error).message}`);
      }
    }
    return c.json({});
  });
  // accepted and dropped so an exporter configured for everything does not log errors
  for (const p of ['/v1/logs', '/v1/traces']) {
    app.post(p, (c) => (otlpAuth(c.req.raw) ? c.json({}) : c.json({ error: 'unauthorized' }, 401)));
  }

  // ----- static web app ------------------------------------------------------
  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path === '/api' || path.startsWith('/v1/') || PEER_ROUTES.test(path)) return c.json({ error: 'not found' }, 404);
    // a build put in place after the hub started is used without a restart
    if (!webDir && (path === '/' || path === '/index.html')) webDir = resolveWebDir(webPlaces);
    if (webDir) {
      const res = await serveStatic(webDir, path, c.req.method);
      if (res) return res;
    } else if ((c.req.method === 'GET' || c.req.method === 'HEAD') && (path === '/' || path === '/index.html')) {
      return placeholderPage(engine.version, [engine.config.paths.web, ...webPlaces.filter((p) => p !== engine.config.paths.web)]);
    }
    return c.json({ error: 'not found' }, 404);
  });

  // app sockets in the log files: who connected, for how long (devices log their own in ws/daemons.ts)
  const opened = new WeakMap<object, number>();
  const clientName = (id: string): string | undefined => {
    if (id === 'owner') return 'owner token';
    try {
      return auth.clients.list().find((r) => r.id === id)?.name;
    } catch {
      return undefined;
    }
  };
  const websocket: WebSocketHandler<WsData> = {
    open(ws) {
      if (ws.data.kind === 'client') {
        ctx.clients.open(ws as ServerWebSocket<ClientSocketData>);
        opened.set(ws.data, Date.now());
        const name = clientName(ws.data.clientId);
        logEvent('info', 'ws', 'client connected', { clientId: ws.data.clientId, ...(name ? { name } : {}), ...(ws.data.active === false ? { background: true } : {}), sockets: ctx.clients.count });
      } else ctx.daemons.open(ws as ServerWebSocket<DaemonSocketData>);
    },
    message(ws, msg) {
      if (ws.data.kind === 'client') ctx.clients.message(ws as ServerWebSocket<ClientSocketData>, msg);
      else ctx.daemons.message(ws as ServerWebSocket<DaemonSocketData>, msg);
    },
    close(ws, code, reason) {
      if (ws.data.kind === 'client') {
        ctx.clients.close(ws as ServerWebSocket<ClientSocketData>);
        const at = opened.get(ws.data);
        logEvent('info', 'ws', 'client disconnected', { clientId: ws.data.clientId, code, ...(reason ? { reason: String(reason).slice(0, 120) } : {}), ...(at ? { connectedMs: Date.now() - at } : {}), sockets: ctx.clients.count });
      } else ctx.daemons.close(ws as ServerWebSocket<DaemonSocketData>, code, reason);
    },
    // phones on mobile networks drop quietly; Bun pings and closes dead sockets
    idleTimeout: 120,
    sendPings: true,
    maxPayloadLength: 64 * 1024 * 1024,
  };

  return {
    fetch: (req, server) => app.fetch(req, server),
    websocket,
    app,
    ctx,
    get webDir() {
      return webDir;
    },
    signAction: (approvalId, decision) => signActionWith(actionSecret, approvalId, decision),
    close() {
      ctx.updates.dispose();
      ctx.map.dispose();
      ctx.peer.close();
      void ctx.remote.close();
      void ctx.cliproxy.close();
      void ctx.memberPlans.close();
      engine.access.setPlans(undefined);
      ctx.clients.dispose();
      ctx.daemons.dispose();
      lagWatch.stop();
    },
  };
}

export interface StartOptions extends Omit<ServerOptions, 'engine'> {
  /** Override config.server.host / port (port 0 picks a free one). */
  host?: string;
  port?: number;
}

export interface RunningServer {
  server: Server<WsData>;
  conclave: ConclaveServer;
  /** http://host:port as bound. */
  url: string;
  /** reason (a signal) goes in the log files' "hub stopped" line. */
  stop(reason?: string): Promise<void>;
}

/**
 * Where to listen. --host, CONCLAVE_HOST or a server.host in config.json pin
 * it. Otherwise the hub listens on every interface and remote access decides
 * whom it answers: the same network, or only this computer and the tunnel.
 * 127.0.0.1 in config.json counts as unset, because first runs wrote it there
 * before the same network option existed.
 */
export function listenHost(engine: EngineApi, explicit?: string): { host: string; pinned: boolean } {
  if (explicit) return { host: explicit, pinned: true };
  const env = process.env.CONCLAVE_HOST;
  if (env) return { host: env, pinned: true };
  const user = engine.config.getUser().server?.host;
  if (user && user !== '127.0.0.1') return { host: user, pinned: true };
  return { host: '0.0.0.0', pinned: false };
}

/** createServer + Bun.serve on the listen address (see listenHost) and config.server.port. */
export function startServer(engine: EngineApi, opts: StartOptions = {}): RunningServer {
  const cfg = engine.config.get().server;
  const conclave = createServer({ ...opts, engine });
  const listen = listenHost(engine, opts.host);
  const server = Bun.serve<WsData>({
    hostname: listen.host,
    port: opts.port ?? cfg.port,
    fetch: conclave.fetch,
    websocket: conclave.websocket,
    // SSE and long model streams must not be cut by the idle timer
    idleTimeout: 0,
    // never show Bun's dev error page (stack traces) to remote clients
    development: false,
    maxRequestBodySize: 128 * 1024 * 1024,
  });
  const host = isWildcard(server.hostname) ? '127.0.0.1' : server.hostname;
  const url = `http://${host?.includes(':') ? `[${host}]` : host}:${server.port}`;
  // tunnels start now that the port is known
  conclave.ctx.remote.attach({ port: server.port ?? cfg.port, host: listen.host, pinned: listen.pinned });
  // serve --port: the Preview refuses the port the hub really listens on
  (engine as { preview?: { hubListening(port: number): void } }).preview?.hubListening(server.port ?? cfg.port);
  // the hub's own CLIProxyAPI, when models.cliproxy.mode is builtin
  conclave.ctx.cliproxy.attach();
  // and each member's own, for the members with plans
  conclave.ctx.memberPlans.attach();
  // friends: the outbox, the pull path and address updates
  conclave.ctx.peer.start();
  // the log files: every logger() line and engine event from here on, and a line that the hub started
  conclave.ctx.logs.start({ bus: engine.bus, host: listen.host, port: server.port ?? cfg.port });
  // where the updater asks /api/health after a restart
  conclave.ctx.updates.attach({ url });
  return {
    server,
    conclave,
    url,
    async stop(reason?: string) {
      conclave.ctx.peer.close();
      await conclave.ctx.remote.close();
      await conclave.ctx.cliproxy.close();
      await conclave.ctx.memberPlans.close();
      conclave.close();
      await server.stop(true);
      conclave.ctx.logs.stop(reason);
    },
  };
}
