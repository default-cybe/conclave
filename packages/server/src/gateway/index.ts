/**
 * Model gateway: a pass-through proxy so Claude Code, Codex, OpenCode and
 * friends can send their model calls through the hub. Usage and rate limits
 * show up in Conclave without the CLIs knowing about it.
 *
 *   ANTHROPIC_BASE_URL=<hub>/gw/anthropic   ANTHROPIC_API_KEY=cgw_...
 *   OPENAI_BASE_URL=<hub>/gw/openai/v1      OPENAI_API_KEY=cgw_...
 *   <hub>/gw/gemini/v1beta/models/...       x-goog-api-key: cgw_...
 *   <hub>/gw/p/<providerId>/...             any configured provider by id
 *
 * Bodies are forwarded as received (except a model alias rewrite) and the
 * response streams back chunk for chunk while a tap reads usage from it.
 * Request bodies are never logged.
 */
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { GatewayRouteId, ProviderConfig } from '@conclave/core/config/schema.ts';
import type { LimitState, UsageRecord } from '@conclave/core/types.ts';
import type { GatewayKey } from '@conclave/core/storage/repos.ts';
import { newId } from '@conclave/core/util/ids.ts';
import { logger } from '@conclave/core/util/log.ts';
import { accountsOf } from '@conclave/core/accounts/attached.ts';
import { GATEWAY_KEY_PREFIX, type Auth } from '../auth';
import { AliasResolver, gatewayConfig, type GatewayConfig } from './aliases';
import { UpstreamLimiter } from './limiter';
import { limitFromHeaders, retryAfterMs } from './limits';
import { UsageTap, type WireType } from './usage';

export { UsageTap, type WireType } from './usage';
export { limitFromHeaders } from './limits';
export { type GatewayConfig } from './aliases';

const log = logger('gateway');

export const DEFAULT_BASE_URLS: Record<WireType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
};

/** Provider id tried first for each wire type. */
const DEFAULT_PROVIDER: Record<WireType, string[]> = {
  anthropic: ['anthropic'],
  openai: ['openai'],
  gemini: ['google', 'gemini'],
};

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export interface GatewayOptions {
  engine: EngineApi;
  auth: Auth;
  /** Called once per metered response. Default: insert into repos.usage and emit usage.recorded. */
  onUsage?: (record: UsageRecord) => void;
  /** Called with limits parsed from response headers. Default: repos.usage.setLimit and emit limit.updated. */
  onLimit?: (limit: LimitState) => void;
  /** Upstream fetch, for tests. */
  fetch?: typeof fetch;
}

export interface GatewayRoute {
  /** Wire type from the URL (/gw/anthropic...). Unset for /gw/p/<provider>. */
  type?: WireType;
  provider?: string;
  /** Path after the route prefix, starting with "/". */
  path: string;
  /** The call came from the internet (a tunnel or proxy), not this machine or its network. Relaying then needs a gateway key unless gateway.relay is "open". */
  remote?: boolean;
}

interface Target {
  id: string;
  cfg: ProviderConfig;
  type: WireType;
  /** Upstream for this wire when it is not cfg.baseUrl (anthropicBaseUrl). */
  baseUrl?: string;
}

/** Anthropic Messages paths, for /gw/p/<id> on a provider that has an anthropicBaseUrl. */
const MESSAGES_PATH = /^\/(v1\/)?messages(\/|$)/;

/**
 * Where a provider takes Anthropic-format requests. The zai default names
 * api.z.ai; a baseUrl on bigmodel.cn (Z.ai's mainland site) gets its own shim
 * instead of inheriting that. `baseUrl` is the expanded cfg.baseUrl.
 */
export function anthropicBase(cfg: ProviderConfig, baseUrl = cfg.baseUrl): string | undefined {
  if (!cfg.anthropicBaseUrl) return undefined;
  if (/^https:\/\/api\.z\.ai\//.test(cfg.anthropicBaseUrl) && /^https?:\/\/([^/]+\.)?bigmodel\.cn(:\d+)?(\/|$)/.test(baseUrl ?? '')) return 'https://open.bigmodel.cn/api/anthropic';
  return cfg.anthropicBaseUrl;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Error body in the shape the calling SDK expects. All shapes have an "error" key. */
export function wireError(type: WireType | undefined, status: number, message: string, headers?: Record<string, string>): Response {
  let body: unknown;
  if (type === 'anthropic') {
    const kind =
      status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
    body = { type: 'error', error: { type: kind, message } };
  } else if (type === 'gemini') {
    body = { error: { code: status, message, status: status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT' } };
  } else {
    body = { error: { message, type: status === 429 ? 'rate_limit_error' : status === 401 ? 'invalid_api_key' : 'invalid_request_error', code: null } };
  }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers ?? {}) } });
}

/** Join base URL and request path, dropping a repeated version segment (/v1 + /v1/messages). */
export function joinUpstream(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  const last = /\/(v\d+[a-z0-9]*)$/i.exec(base)?.[1];
  if (last && (p === `/${last}` || p.startsWith(`/${last}/`))) return base + p.slice(last.length + 1);
  return base + p;
}

/** Which CLI sent this, from the user agent. Used as the usage purpose when no key name is known. */
function clientName(ua: string | null): string | undefined {
  if (!ua) return undefined;
  const u = ua.toLowerCase();
  if (u.includes('claude-cli') || u.includes('claude-code')) return 'claude-code';
  if (u.includes('codex')) return 'codex';
  if (u.includes('opencode')) return 'opencode';
  if (u.includes('gemini-cli') || u.includes('geminicli')) return 'gemini-cli';
  if (u.includes('crush')) return 'crush';
  return undefined;
}

/** Which on/off switch (config gateway.routes) a request falls under. */
export function routeId(route: GatewayRoute): GatewayRouteId {
  return route.type ?? 'provider';
}

/** A route is on unless config turns it off. */
export function routeEnabled(cfg: GatewayConfig, id: GatewayRouteId): boolean {
  return cfg.routes?.[id] !== false;
}

export const ROUTE_PATHS: Record<GatewayRouteId, string> = {
  anthropic: '/gw/anthropic',
  openai: '/gw/openai',
  gemini: '/gw/gemini',
  provider: '/gw/p/<provider>',
};

export class Gateway {
  private readonly engine: EngineApi;
  private readonly auth: Auth;
  private readonly fetchImpl: typeof fetch;
  readonly onUsage: (record: UsageRecord) => void;
  readonly onLimit: (limit: LimitState) => void;
  private readonly aliases: AliasResolver;
  private limiters = new Map<string, UpstreamLimiter>();
  private lastLimitAt = new Map<string, number>();

  constructor(opts: GatewayOptions) {
    this.engine = opts.engine;
    this.auth = opts.auth;
    this.fetchImpl = opts.fetch ?? fetch;
    this.aliases = new AliasResolver(opts.engine);
    this.onUsage =
      opts.onUsage ??
      ((r) => {
        this.engine.repos.usage.insert(r);
        this.engine.bus.emit({ type: 'usage.recorded', record: r });
      });
    this.onLimit =
      opts.onLimit ??
      ((l) => {
        this.engine.repos.usage.setLimit(l);
        this.engine.bus.emit({ type: 'limit.updated', limit: l });
      });
  }

  async handle(req: Request, route: GatewayRoute): Promise<Response> {
    const id = routeId(route);
    if (!routeEnabled(gatewayConfig(this.engine), id)) {
      return wireError(route.type, 403, `The ${ROUTE_PATHS[id]} gateway route is off on this hub. Turn it on in Settings, Gateway keys.`);
    }
    try {
      return await this.relay(req, route);
    } catch (err) {
      if (err instanceof GatewayError) return wireError(route.type, err.status, err.message, err.headers);
      if ((err as Error)?.name === 'AbortError' || req.signal.aborted) return wireError(route.type, 499, 'client closed request');
      log.warn(`relay failed: ${(err as Error)?.message ?? err}`);
      return wireError(route.type, 502, `upstream request failed: ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }

  private pickProvider(route: GatewayRoute, header: string | null): Target {
    const providers = this.engine.config.get().providers;
    const wanted = header?.trim() || route.provider;
    const asTarget = (id: string): Target | undefined => {
      const cfg = providers[id];
      if (!cfg || cfg.type === 'acp') return undefined;
      // Anthropic-format requests to a provider with an Anthropic upstream next to its own wire (Z.ai)
      const anthropic = cfg.type !== 'anthropic' && cfg.anthropicBaseUrl && (route.type ? route.type === 'anthropic' : MESSAGES_PATH.test(route.path));
      if (anthropic) return { id, cfg, type: 'anthropic', baseUrl: anthropicBase(cfg, cfg.baseUrl && this.engine.config.expand(cfg.baseUrl)) };
      return { id, cfg, type: cfg.type as WireType };
    };
    if (wanted) {
      const t = asTarget(wanted);
      if (!t) throw new GatewayError(404, `unknown provider "${wanted}"`);
      if (route.type && t.type !== route.type) throw new GatewayError(400, `provider "${wanted}" is ${t.type}, not ${route.type}`);
      if (t.cfg.enabled === false) throw new GatewayError(403, `provider "${wanted}" is disabled`);
      return t;
    }
    if (!route.type) throw new GatewayError(400, 'no provider given');
    for (const id of DEFAULT_PROVIDER[route.type]) {
      const t = asTarget(id);
      if (t && t.type === route.type && t.cfg.enabled !== false) return t;
    }
    const any = Object.keys(providers)
      .map(asTarget)
      .find((t): t is Target => !!t && t.type === route.type && t.cfg.enabled !== false);
    if (!any) throw new GatewayError(404, `no ${route.type} provider configured`);
    return any;
  }

  private limiter(key: string, max: number): UpstreamLimiter {
    let l = this.limiters.get(key);
    if (!l) this.limiters.set(key, (l = new UpstreamLimiter(max)));
    l.max = max;
    return l;
  }

  private async relay(req: Request, route: GatewayRoute): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    const gcfg = gatewayConfig(this.engine);
    let target = this.pickProvider(route, req.headers.get('x-conclave-provider'));
    const type = target.type;

    // --- credentials: find our key, note foreign upstream credentials ---
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')?.[1]?.trim();
    const creds = {
      conclave: req.headers.get('x-conclave-key') ?? undefined,
      xApiKey: req.headers.get('x-api-key') ?? undefined,
      bearer,
      goog: req.headers.get('x-goog-api-key') ?? undefined,
      query: url.searchParams.get('key') ?? undefined,
    };
    const isOurs = (v: string | undefined) => !!v && v.startsWith(GATEWAY_KEY_PREFIX);
    const ourKey = [creds.conclave, creds.xApiKey, creds.bearer, creds.goog, creds.query].find(isOurs);
    let key: GatewayKey | undefined;
    if (ourKey) {
      key = this.auth.checkGatewayKey(ourKey);
      if (!key) throw new GatewayError(401, 'invalid or revoked gateway key');
    }
    const foreign = {
      xApiKey: creds.xApiKey && !isOurs(creds.xApiKey) ? creds.xApiKey : undefined,
      bearer: creds.bearer && !isOurs(creds.bearer) ? creds.bearer : undefined,
      goog: creds.goog && !isOurs(creds.goog) ? creds.goog : undefined,
      query: creds.query && !isOurs(creds.query) ? creds.query : undefined,
    };
    const hasForeign = !!(foreign.xApiKey || foreign.bearer || foreign.goog || foreign.query);

    // --- what no body could let through, refused before the body is read (up to 128 MB from anyone) ---
    // the same answers as "decide auth mode" below: without a gateway key these fail whichever provider a model alias picks
    if (!key) {
      const hubKey = !!this.engine.config.apiKey(target.id);
      const relayClosed = gcfg.relay === 'key' || (route.remote && gcfg.relay !== 'open');
      if (hubKey && !hasForeign) throw new GatewayError(401, 'gateway key required');
      if (hubKey && relayClosed) throw new GatewayError(401, 'this provider uses the hub key; send a gateway key (cgw_...)');
      if (!hubKey && !hasForeign) throw new GatewayError(401, `provider "${target.id}" has no API key on the hub and the request carries none`);
      if (!hubKey && gcfg.relay === 'key') throw new GatewayError(401, 'gateway key required (relay mode is "key")');
      if (!hubKey && relayClosed) throw new GatewayError(401, "calls through the hub's remote address need a gateway key (cgw_...). Make one in Settings, Gateway keys");
    }

    // --- body and model alias ---
    const method = req.method.toUpperCase();
    let body: ArrayBuffer | undefined = method === 'GET' || method === 'HEAD' ? undefined : await req.arrayBuffer();
    let path = route.path || '/';
    let requestModel: string | undefined;
    let json: Record<string, unknown> | undefined;
    if (body && body.byteLength && body.byteLength < 32 * 1024 * 1024 && (req.headers.get('content-type') ?? '').includes('json')) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
      } catch {
        /* not JSON after all; forward as is */
      }
    }
    if (type === 'gemini') {
      const m = /\/models\/([^/:]+)(:[A-Za-z]+)?/.exec(path);
      if (m) {
        requestModel = decodeURIComponent(m[1]);
        const alias = await this.aliases.resolve(requestModel, type, target.id);
        if (alias) {
          path = path.replace(m[0], `/models/${encodeURIComponent(alias.model)}${m[2] ?? ''}`);
          requestModel = alias.model;
          if (alias.provider && alias.provider !== target.id) target = this.pickProvider({ ...route, type, provider: alias.provider }, null);
        }
      }
    } else if (json && typeof json.model === 'string') {
      requestModel = json.model;
      const alias = await this.aliases.resolve(json.model, type, target.id);
      if (alias) {
        json.model = alias.model;
        requestModel = alias.model;
        body = new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
        if (alias.provider && alias.provider !== target.id) target = this.pickProvider({ ...route, type, provider: alias.provider }, null);
      }
    }

    // --- decide auth mode ---
    const providerKey = this.engine.config.apiKey(target.id);
    let relayMode = false;
    if (providerKey) {
      if (!key) throw new GatewayError(401, hasForeign ? 'this provider uses the hub key; send a gateway key (cgw_...)' : 'gateway key required');
    } else {
      if (!hasForeign) throw new GatewayError(401, `provider "${target.id}" has no API key on the hub and the request carries none`);
      if (!key && gcfg.relay === 'key') throw new GatewayError(401, 'gateway key required (relay mode is "key")');
      if (!key && route.remote && gcfg.relay !== 'open') throw new GatewayError(401, "calls through the hub's remote address need a gateway key (cgw_...). Make one in Settings, Gateway keys");
      relayMode = true;
    }

    // --- upstream request ---
    const raw = target.baseUrl ?? target.cfg.baseUrl;
    const base = raw ? this.engine.config.expand(raw) : DEFAULT_BASE_URLS[type];
    const upstream = new URL(joinUpstream(base, path));
    url.searchParams.forEach((v, k) => {
      if (k === 'key' && (isOurs(v) || !relayMode)) return;
      upstream.searchParams.append(k, v);
    });

    const headers = new Headers();
    req.headers.forEach((v, k) => {
      const name = k.toLowerCase();
      if (HOP_BY_HOP.has(name) || name.startsWith('x-conclave-') || name === 'cookie' || name === 'accept-encoding') return;
      if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip') return;
      if (name === 'x-api-key' || name === 'authorization' || name === 'x-goog-api-key') {
        // only foreign credentials survive, and only in relay mode
        if (!relayMode) return;
        if (name === 'x-api-key' && !foreign.xApiKey) return;
        if (name === 'authorization' && !foreign.bearer) return;
        if (name === 'x-goog-api-key' && !foreign.goog) return;
      }
      headers.append(k, v);
    });
    // keep the body readable for the usage tap
    headers.set('accept-encoding', 'identity');
    if (providerKey) {
      if (type === 'anthropic') headers.set('x-api-key', providerKey);
      else if (type === 'openai') headers.set('authorization', `Bearer ${providerKey}`);
      else headers.set('x-goog-api-key', providerKey);
    }
    for (const [k, v] of Object.entries(this.engine.config.expandRecord(target.cfg.headers) ?? {})) headers.set(k, v);

    // --- concurrency gate and cooldown ---
    const maxWait = gcfg.maxQueueWaitMs ?? 120_000;
    const limiter = this.limiter(`${target.id}|${base}`, Math.max(1, gcfg.concurrency ?? 8));
    const left = limiter.cooldownLeft();
    if (left > maxWait) {
      throw new GatewayError(429, `upstream ${target.id} is rate limited for ${Math.ceil(left / 1000)}s`, { 'retry-after': String(Math.ceil(left / 1000)) });
    }
    const waitAbort = new AbortController();
    const onClientAbort = () => waitAbort.abort();
    req.signal.addEventListener('abort', onClientAbort, { once: true });
    const waitTimer = setTimeout(() => waitAbort.abort(), maxWait);
    let release: () => void;
    try {
      release = await limiter.acquire(waitAbort.signal);
    } catch {
      if (req.signal.aborted) throw new GatewayError(499, 'client closed request');
      throw new GatewayError(429, `upstream ${target.id} queue is full`, { 'retry-after': String(Math.ceil(Math.max(1000, limiter.cooldownLeft()) / 1000)) });
    } finally {
      clearTimeout(waitTimer);
      req.signal.removeEventListener('abort', onClientAbort);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(upstream, {
        method,
        headers,
        body,
        signal: req.signal,
        redirect: 'manual',
      });
    } catch (err) {
      release();
      throw err;
    }

    // --- limits ---
    const limitId = this.limitProvider(target, relayMode ? foreign.bearer : undefined);
    if (res.status === 429) limiter.cooldown(retryAfterMs(res.headers) ?? 5_000);
    this.reportLimits(limitId.id, limitId.label, res);

    const outHeaders = new Headers();
    res.headers.forEach((v, k) => {
      const name = k.toLowerCase();
      if (HOP_BY_HOP.has(name) || name === 'content-encoding') return;
      outHeaders.append(k, v);
    });

    const meter = res.status < 400;
    const purpose = key?.agent ?? key?.name ?? clientName(req.headers.get('user-agent')) ?? 'relay';
    const finish = (tap: UsageTap | undefined) => {
      release();
      if (!tap) return;
      let usage;
      try {
        usage = tap.finish();
      } catch {
        usage = undefined;
      }
      if (!usage || usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) return;
      const record: UsageRecord = {
        id: newId('use'),
        ts: Date.now(),
        source: 'gateway',
        provider: target.id,
        model: usage.model ?? requestModel ?? 'unknown',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        costUsd: 0,
        latencyMs: Date.now() - started,
        purpose,
        ...(key?.device ? { device: key.device } : {}),
      };
      // the account it billed: an API key's account; a relayed client's own key is no account of the hub's
      const account = relayMode ? undefined : accountsOf(this.engine)?.accountFor(target.id, record.model);
      if (account) record.account = account;
      try {
        this.onUsage(record);
      } catch (err) {
        log.warn(`usage callback failed: ${(err as Error).message}`);
      }
    };

    if (!res.body || method === 'HEAD') {
      finish(undefined);
      return new Response(null, { status: res.status, statusText: res.statusText, headers: outHeaders });
    }

    const tap = meter ? new UsageTap(type, res.headers.get('content-type')) : undefined;
    const reader = res.body.getReader();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      finish(tap);
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { done: eof, value } = await reader.read();
            if (eof) {
              controller.close();
              end();
              return;
            }
            if (tap) {
              try {
                tap.push(value);
              } catch {
                /* metering must never break the relay */
              }
            }
            controller.enqueue(value);
          } catch (err) {
            end();
            controller.error(err);
          }
        },
        cancel(reason) {
          end();
          return reader.cancel(reason).catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: outHeaders });
  }

  /** LimitState id: the provider's subscription when set, or the Claude subscription for relayed OAuth tokens. */
  private limitProvider(target: Target, relayedBearer: string | undefined): { id: string; label: string } {
    if (target.type === 'anthropic' && relayedBearer?.startsWith('sk-ant-oat')) return { id: 'claude-max', label: 'Claude subscription' };
    const id = target.cfg.subscription ?? target.id;
    return { id, label: target.cfg.name ?? target.id };
  }

  private reportLimits(provider: string, label: string, res: Response): void {
    let limit: LimitState | undefined;
    try {
      limit = limitFromHeaders(provider, label, res.headers, res.status);
    } catch {
      return;
    }
    if (!limit) return;
    const now = Date.now();
    // headers come with every response; store at most every 5s unless blocked
    if (!limit.blocked && now - (this.lastLimitAt.get(provider) ?? 0) < 5_000) return;
    this.lastLimitAt.set(provider, now);
    try {
      this.onLimit(limit);
    } catch (err) {
      log.warn(`limit callback failed: ${(err as Error).message}`);
    }
  }
}
