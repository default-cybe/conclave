/**
 * CLIProxyAPI's management API, as the hub uses it: sign in, the sign-in
 * status, the pasted callback, the accounts (credentials) and their
 * removal and refresh, and the plugins that add sign-in providers. The v8
 * paths (docs/management-api-v8.md in its repo) come first; an older
 * CLIProxyAPI that only has /v0/management is spoken to there.
 *
 * Only the hub calls this, with the management key from its secrets store.
 * Nothing here is ever proxied to a browser, and what comes back is cut down
 * to the fields the hub shows (a refresh answer carries the new tokens; they
 * stop here).
 *
 * For the accounts (core/src/accounts): each credential's last quota
 * signals, cooldowns and priority, its models, setting its priority,
 * clearing a cooldown, and the plan usage reads through api-call, which go
 * only to the exact addresses in USAGE_CALLS. observability/usage/api-keys
 * is never read: its map keys are raw API keys.
 */

export type ManagementApi = 'v8' | 'v0';

/** Store IDs differ from the OAuth provider IDs returned by the plugins. */
export const SUBSCRIPTION_PLUGINS: Record<string, { id: string; version: string; repository: string }> = {
  copilot: { id: 'github-copilot', version: '0.1.1', repository: 'https://github.com/syepes/CLIProxyAPI-plugin-github-copilot' },
  kiro4cpa: { id: 'kiro4cpa', version: '1.0.5', repository: 'https://github.com/AkkunYo/kiro4cpa-plugin' },
};
export const OFFICIAL_PLUGIN_SOURCE = 'https://raw.githubusercontent.com/router-for-me/CLIProxyAPI-Plugins-Store/main/registry.json';

export class ManagementError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ManagementError';
  }
}

export interface AuthStart {
  url: string;
  state: string;
  flow: 'redirect' | 'device';
  userCode?: string;
  expiresIn?: number;
}

export interface AuthStatus {
  status: 'wait' | 'ok' | 'error';
  error?: string;
}

/** A local retry restriction CLIProxyAPI keeps on a credential (all models, or one). */
export interface RawCooldown {
  scope: 'credential' | 'model' | string;
  model?: string;
  /** quota, unauthorized, payment_required, transient_error... */
  reason: string;
  retryAt?: number;
  backoffLevel?: number;
  httpStatus?: number;
}

/** A credential as /credentials lists it, cut down to what the hub uses. No tokens. */
export interface RawCredential {
  /** The file name: the stable key (auth_index may change across CLIProxyAPI restarts). */
  name: string;
  /** For api-call and cooldown reset. */
  authIndex?: string;
  provider: string;
  label?: string;
  email?: string;
  account?: string;
  accountType?: string;
  status?: string;
  statusMessage?: string;
  disabled?: boolean;
  unavailable?: boolean;
  runtimeOnly?: boolean;
  updatedAt?: number;
  priority?: number;
  prefix?: string;
  weight?: number;
  note?: string;
  /** The last quota headers it saw: Retry-After, Anthropic-Ratelimit-Unified-*, X-Codex-*. */
  signals?: Record<string, string>;
  signalsAt?: number;
  cooldowns?: RawCooldown[];
  nextRetryAfter?: number;
  /** ChatGPT accounts: the account id from the id token's claims, sent with the usage call. Not a secret. */
  chatgptAccountId?: string;
  /** ChatGPT accounts: the plan from the id token's claims (free, plus, pro, team). CLIProxyAPI picks the account's models by it. */
  planType?: string;
  /** Antigravity accounts: the Cloud Code project id, when the listing carries it. Not a secret. */
  projectId?: string;
}

/** The only calls the hub makes through api-call, and nothing from a user or a model goes into them. */
export type UsageCallKind = 'claude-usage' | 'claude-profile' | 'codex-usage' | 'codex-models' | 'antigravity-usage' | 'antigravity-quota-daily' | 'antigravity-quota';

/**
 * The Codex client version the hub names when it asks a ChatGPT plan for its
 * models. ChatGPT leaves out models that need a newer client, so this sits
 * at or above the newest version CLIProxyAPI's own Codex catalog names.
 */
export const CODEX_CLIENT_VERSION = '0.164.0';

const CLAUDE_HEADERS = { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' };
/** CLIProxyAPI's own Antigravity client name: Cloud Code refuses clients below 2.23.0. */
const ANTIGRAVITY_QUOTA_HEADERS = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)' };
/** A Cloud Code project id, the only value that goes into the quota body. */
const PROJECT_ID = /^[\w.:-]{1,128}$/;

/**
 * The api-call allowlist: exact method and URL. api-call is an authenticated
 * fetch for any address with the credential's token put in, so the hub
 * builds every request from this table alone.
 */
export const USAGE_CALLS: Record<UsageCallKind, { method: 'GET' | 'POST'; url: string; header: Record<string, string>; body?: string }> = {
  'claude-usage': { method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header: CLAUDE_HEADERS },
  'claude-profile': { method: 'GET', url: 'https://api.anthropic.com/api/oauth/profile', header: CLAUDE_HEADERS },
  'codex-usage': { method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' } },
  // the plan's own model list, as the Codex app reads it: CLIProxyAPI lists a ChatGPT plan's models from its own catalog only
  // as Codex CLI asks: the token, the account id (added per call) and its originator
  'codex-models': { method: 'GET', url: `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`, header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', originator: 'codex_cli_rs' } },
  // the Antigravity editor's own startup call: the plan tier and the GOOGLE_ONE_AI credits balance (usage/readers/antigravity.ts)
  'antigravity-usage': { method: 'POST', url: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{"metadata":{"ideType":"ANTIGRAVITY"}}' },
  // the 5h and weekly quota buckets, from both hosts (one may leave the Gemini group out); the body names the project, added per call
  'antigravity-quota-daily': { method: 'POST', url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', header: ANTIGRAVITY_QUOTA_HEADERS, body: '{}' },
  'antigravity-quota': { method: 'POST', url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', header: ANTIGRAVITY_QUOTA_HEADERS, body: '{}' },
};

/** Throws unless the call is exactly one of USAGE_CALLS. */
export function assertAllowedCall(call: { method: string; url: string }): void {
  const ok = Object.values(USAGE_CALLS).some((c) => c.method === call.method && c.url === call.url);
  if (!ok) throw new ManagementError(`The hub does not send ${call.method} ${call.url} through CLIProxyAPI.`, 400);
}

/** Headers CLIProxyAPI keeps as quota signals; anything else in that map is dropped. */
const SIGNAL = /^(retry-after|anthropic-ratelimit-unified-[a-z0-9_-]+|x-codex-[a-z0-9_-]+|x-ratelimit-[a-z0-9_-]+)$/i;

function signalsOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SIGNAL.test(k) && typeof val === 'string' && val.length <= 512) out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function cooldownsOf(v: unknown): RawCooldown[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      scope: str(c.scope) ?? 'credential',
      ...(str(c.model_key) ? { model: str(c.model_key) } : {}),
      reason: str(c.reason) ?? 'unknown',
      ...(time(c.retry_at) ? { retryAt: time(c.retry_at) } : {}),
      ...(typeof c.backoff_level === 'number' ? { backoffLevel: c.backoff_level } : {}),
      ...(typeof c.http_status === 'number' ? { httpStatus: c.http_status } : {}),
    }));
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

const AUTH_INDEX = /^[\w.:-]{1,128}$/;

/** v0 login paths: /v0/management/<name>-auth-url. Claude's is "anthropic". */
const V0_AUTH: Record<string, string> = { claude: 'anthropic' };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function time(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

export class Management {
  /** From the X-CPA-VERSION header of the last answer. */
  version?: string;
  private api?: ManagementApi;
  private readonly installingPlugins = new Map<string, Promise<void>>();

  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly f: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  get apiVersion(): ManagementApi | undefined {
    return this.api;
  }

  private async call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>, timeoutMs = this.timeoutMs): Promise<{ status: number; data: T }> {
    const url = new URL(this.base.replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers: { authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (err) {
      throw new ManagementError(`CLIProxyAPI did not answer (${(err as Error).message}).`, 0);
    }
    const v = res.headers.get('x-cpa-version');
    if (v) this.version = v.replace(/^v/i, '');
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // a plain text page (Gin's "404 page not found") says nothing the owner can use
      data = {};
    }
    return { status: res.status, data: data as T };
  }

  private fail(status: number, data: unknown, what: string): never {
    const said = str((data as { error?: unknown; message?: unknown })?.error) ?? str((data as { message?: unknown })?.message);
    if (status === 401) throw new ManagementError('CLIProxyAPI refused the management key. Check it in its config.yaml (management.secret-key) and paste it again.', 401);
    if (status === 403)
      throw new ManagementError(
        said && /remote/i.test(said)
          ? 'CLIProxyAPI only allows its management API from its own computer. Set management.allow-remote: true in its config.yaml to sign in from here, or sign in on that computer.'
          : `CLIProxyAPI refused to ${what}${said ? `: ${said}` : ''}.`,
        403,
      );
    if (status === 404 && !said) throw new ManagementError('This CLIProxyAPI has its management API turned off. Set management.secret-key in its config.yaml.', 404);
    throw new ManagementError(`CLIProxyAPI could not ${what}${said ? `: ${said}` : ` (HTTP ${status})`}.`, status);
  }

  /** Which management API answers: v8, else v0. Throws with the reason when neither does. */
  async detect(): Promise<ManagementApi> {
    if (this.api) return this.api;
    const v8 = await this.call<unknown>('GET', '/v8/management/credentials');
    if (v8.status === 200) return (this.api = 'v8');
    if (v8.status !== 404) this.fail(v8.status, v8.data, 'list the accounts');
    const v0 = await this.call<unknown>('GET', '/v0/management/auth-files');
    if (v0.status === 200) return (this.api = 'v0');
    this.fail(v0.status, v0.data, 'list the accounts');
  }

  async authUrl(provider: string): Promise<AuthStart> {
    const api = await this.detect();
    const r =
      api === 'v8'
        ? await this.call<Record<string, unknown>>('GET', '/v8/management/oauth/auth-url', undefined, { provider })
        : await this.call<Record<string, unknown>>('GET', `/v0/management/${V0_AUTH[provider] ?? provider}-auth-url`);
    if (r.status === 404 && (str(r.data.error) === 'provider_not_found' || api === 'v0')) throw new ManagementError(`This CLIProxyAPI cannot sign in to ${provider}. Update it to a newer version.`, 404);
    if (r.status !== 200) this.fail(r.status, r.data, 'start the sign-in');
    let url = str(r.data.url);
    const state = str(r.data.state);
    if (!url || !state) throw new ManagementError('CLIProxyAPI started a sign-in but sent no address for it.', 502);
    // kiro4cpa normally opens a local connect page requiring the management
    // key. Start its Builder ID device flow on the server instead; never send
    // that page, a loopback URL, or the management key to the browser.
    if (provider === 'kiro4cpa' && url.startsWith('/v0/resource/plugins/kiro4cpa/connect#')) {
      const device = await this.call<Record<string, unknown>>('POST', '/v0/management/plugins/kiro4cpa/login/device', { state, kind: 'builder' });
      if (device.status !== 200) this.fail(device.status, device.data, 'start Kiro Builder ID sign-in');
      url = str(device.data.verificationUri);
      if (!url || !/^https:\/\//i.test(url)) throw new ManagementError('Kiro sent no valid device authorization address.', 502);
      return { url, state, flow: 'device', userCode: str(device.data.userCode), expiresIn: typeof device.data.expiresIn === 'number' ? device.data.expiresIn : undefined };
    }
    if (!/^https?:\/\//i.test(url)) throw new ManagementError('CLIProxyAPI sent a sign-in address that is not a web page.', 502);
    const device = r.data.flow === 'device' || !!str(r.data.user_code) || provider === 'copilot' || provider === 'kiro4cpa';
    const expiresIn = typeof r.data.expires_in === 'number' ? r.data.expires_in : undefined;
    return { url, state, flow: device ? 'device' : 'redirect', userCode: str(r.data.user_code) ?? (device ? new URL(url).searchParams.get('user_code') ?? undefined : undefined), expiresIn };
  }

  async status(state: string): Promise<AuthStatus> {
    const api = await this.detect();
    const r = api === 'v8' ? await this.call<Record<string, unknown>>('GET', '/v8/management/oauth/status', undefined, { state }) : await this.call<Record<string, unknown>>('GET', '/v0/management/get-auth-status', undefined, { state });
    if (r.status !== 200 && r.status !== 400) this.fail(r.status, r.data, 'check the sign-in');
    const s = str(r.data.status);
    if (s === 'ok') return { status: 'ok' };
    if (s === 'wait') return { status: 'wait' };
    return { status: 'error', error: str(r.data.error) ?? 'The sign-in failed.' };
  }

  /** The address the provider redirected to (a remote sign-in, pasted from the browser bar). */
  async callback(provider: string, state: string, redirectUrl: string): Promise<void> {
    const api = await this.detect();
    const path = api === 'v8' ? '/v8/management/oauth/callback' : '/v0/management/oauth-callback';
    const r = await this.call<Record<string, unknown>>('POST', path, { provider, state, redirect_url: redirectUrl });
    if (r.status === 200) return;
    const said = str(r.data.error);
    if (r.status === 404 && said) throw new ManagementError('That sign-in ended. Start it again.', 409);
    if (r.status === 409) throw new ManagementError(said === 'oauth flow is already completed' ? 'That sign-in already finished.' : `That sign-in cannot take an address now${said ? ` (${said})` : ''}. Start it again.`, 409);
    if (r.status === 400) throw new ManagementError(`CLIProxyAPI did not take that address${said ? ` (${said})` : ''}. Paste the whole address from the browser bar.`, 400);
    this.fail(r.status, r.data, 'finish the sign-in');
  }

  async cancel(state: string): Promise<void> {
    const api = await this.detect();
    await this.call('DELETE', api === 'v8' ? '/v8/management/oauth/session' : '/v0/management/oauth-session', undefined, { state }).catch(() => undefined);
  }

  async credentials(): Promise<RawCredential[]> {
    const api = await this.detect();
    const r = await this.call<{ files?: Array<Record<string, unknown>> }>('GET', api === 'v8' ? '/v8/management/credentials' : '/v0/management/auth-files');
    if (r.status !== 200) this.fail(r.status, r.data, 'list the accounts');
    return (r.data.files ?? [])
      .map((x): RawCredential | undefined => {
        const name = str(x.name) ?? str(x.id);
        if (!name) return undefined;
        const quota = (x.quota && typeof x.quota === 'object' ? x.quota : {}) as Record<string, unknown>;
        const claims = (x.id_token && typeof x.id_token === 'object' ? x.id_token : {}) as Record<string, unknown>;
        const authIndex = str(x.auth_index) ?? (typeof x.auth_index === 'number' ? String(x.auth_index) : undefined);
        const chatgpt = str(claims.chatgpt_account_id);
        const plan = str(claims.plan_type)?.toLowerCase();
        const project = str(x.project_id);
        return {
          name,
          ...(authIndex && AUTH_INDEX.test(authIndex) ? { authIndex } : {}),
          provider: (str(x.provider) ?? str(x.type) ?? 'unknown').toLowerCase(),
          label: str(x.label),
          email: str(x.email),
          account: str(x.account),
          accountType: str(x.account_type),
          status: str(x.status),
          statusMessage: str(x.status_message),
          disabled: x.disabled === true,
          unavailable: x.unavailable === true,
          runtimeOnly: x.runtime_only === true,
          updatedAt: time(x.updated_at) ?? time(x.modtime),
          priority: int(x.priority),
          prefix: str(x.prefix),
          weight: int(x.weight),
          note: str(x.note),
          signals: signalsOf(quota.signals),
          signalsAt: time(quota.observed_at),
          cooldowns: cooldownsOf(x.cooldowns),
          nextRetryAfter: time(x.next_retry_after),
          ...(chatgpt && /^[\w-]{1,80}$/.test(chatgpt) ? { chatgptAccountId: chatgpt } : {}),
          ...(plan && /^[a-z_-]{1,20}$/.test(plan) ? { planType: plan } : {}),
          ...(project && PROJECT_ID.test(project) ? { projectId: project } : {}),
        };
      })
      .filter((x): x is RawCredential => !!x);
  }

  /**
   * The models one account reaches. Empty on a CLIProxyAPI without the v8 API.
   * Once the account has a prefix, CLIProxyAPI lists each model twice, as
   * "gpt-6-astra" and "work/gpt-6-astra" (see splitPrefixed).
   */
  async credentialModels(name: string): Promise<Array<{ id: string; name?: string; ownedBy?: string }>> {
    const api = await this.detect();
    if (api !== 'v8') return [];
    const r = await this.call<{ models?: Array<Record<string, unknown>> }>('GET', '/v8/management/credentials/models', undefined, { name });
    if (r.status !== 200) this.fail(r.status, r.data, 'list the account\'s models');
    return (r.data.models ?? [])
      .filter((m) => str(m.id))
      .map((m) => ({ id: str(m.id)!, ...(str(m.display_name) ? { name: str(m.display_name) } : {}), ...(str(m.owned_by) ? { ownedBy: str(m.owned_by) } : {}) }));
  }

  /** Set a credential's routing fields: priority (higher is used first), prefix, weight, note, disabled. */
  async setFields(name: string, fields: { priority?: number; prefix?: string; weight?: number; note?: string; disabled?: boolean }): Promise<void> {
    const api = await this.detect();
    if (api !== 'v8') throw new ManagementError('This CLIProxyAPI cannot change its accounts. Update it to version 8 or newer.', 404);
    const body: Record<string, unknown> = { name };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
    const r = await this.call<Record<string, unknown>>('PATCH', '/v8/management/credentials/fields', body);
    if (r.status !== 200) this.fail(r.status, r.data, 'change the account');
  }

  /**
   * Point CLIProxyAPI at a model catalog file (models.catalog, an absolute
   * path), or back to its own sources with undefined. It reloads at once and
   * registers each account's models again.
   */
  async setCatalog(path: string | undefined): Promise<void> {
    const api = await this.detect();
    if (api !== 'v8') throw new ManagementError('This CLIProxyAPI cannot take a model catalog. Update it to version 8 or newer.', 404);
    const r = path ? await this.call<Record<string, unknown>>('PUT', '/v8/management/config/models/catalog', path) : await this.call<Record<string, unknown>>('DELETE', '/v8/management/config/models/catalog');
    if (r.status !== 200) this.fail(r.status, r.data, 'change its model catalog');
  }

  /** Clear the cooldowns on a credential, so the next call tries it. */
  async resetCooldown(authIndex: string): Promise<void> {
    if (!AUTH_INDEX.test(authIndex)) throw new ManagementError('That account has no index CLIProxyAPI knows.', 400);
    const api = await this.detect();
    if (api !== 'v8') throw new ManagementError('This CLIProxyAPI cannot clear a cooldown. Update it to version 8 or newer.', 404);
    const r = await this.call<Record<string, unknown>>('POST', '/v8/management/routing/cooldown/reset', { auth_index: authIndex });
    if (r.status !== 200) this.fail(r.status, r.data, 'clear the cooldown');
  }

  /**
   * One of the allowlisted usage reads (USAGE_CALLS), made by CLIProxyAPI with
   * the account's own token, which never reaches the hub. Returns the status
   * and the parsed JSON body; nothing of the request or the headers is kept
   * or logged, except Retry-After on a 429.
   */
  async usageCall(kind: UsageCallKind, authIndex: string, opts: { chatgptAccountId?: string; etag?: string; projectId?: string } = {}): Promise<{ status: number; json?: unknown; retryAfterMs?: number; etag?: string }> {
    const call = USAGE_CALLS[kind];
    if (!call) throw new ManagementError(`The hub does not send that call through CLIProxyAPI.`, 400);
    assertAllowedCall(call);
    if (!AUTH_INDEX.test(authIndex)) throw new ManagementError('That account has no index CLIProxyAPI knows.', 400);
    const header: Record<string, string> = { ...call.header };
    if ((kind === 'codex-usage' || kind === 'codex-models') && opts.chatgptAccountId && /^[\w-]{1,80}$/.test(opts.chatgptAccountId)) header['Chatgpt-Account-Id'] = opts.chatgptAccountId;
    // the plan's model list again: a 304 when nothing changed
    if (kind === 'codex-models' && opts.etag && ETAG.test(opts.etag)) header['If-None-Match'] = opts.etag;
    const quota = kind === 'antigravity-quota-daily' || kind === 'antigravity-quota';
    const body = quota && opts.projectId && PROJECT_ID.test(opts.projectId) ? JSON.stringify({ project: opts.projectId }) : call.body;
    const api = await this.detect();
    if (api !== 'v8') throw new ManagementError('This CLIProxyAPI cannot read plan usage. Update it to version 8 or newer.', 404);
    const r = await this.call<Record<string, unknown>>('POST', '/v8/management/requests/api-call', { auth_index: authIndex, method: call.method, url: call.url, header, ...(body !== undefined ? { data: body } : {}) });
    if (r.status !== 200) this.fail(r.status, r.data, 'read the plan\'s usage');
    const status = typeof r.data.status_code === 'number' ? r.data.status_code : 0;
    let json: unknown;
    if (typeof r.data.body === 'string' && r.data.body) {
      try {
        json = JSON.parse(r.data.body);
      } catch {
        json = undefined;
      }
    } else if (r.data.body && typeof r.data.body === 'object') json = r.data.body;
    let retryAfterMs: number | undefined;
    let etag: string | undefined;
    if (r.data.header && typeof r.data.header === 'object') {
      for (const [k, v] of Object.entries(r.data.header as Record<string, unknown>)) {
        const raw = Array.isArray(v) ? v[0] : v;
        if (status === 429 && k.toLowerCase() === 'retry-after') {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0) retryAfterMs = n * 1000;
        }
        if (kind === 'codex-models' && k.toLowerCase() === 'etag' && typeof raw === 'string' && ETAG.test(raw)) etag = raw;
      }
    }
    return { status, ...(json !== undefined ? { json } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(etag ? { etag } : {}) };
  }

  async remove(name: string): Promise<void> {
    const api = await this.detect();
    const r = await this.call<Record<string, unknown>>('DELETE', api === 'v8' ? '/v8/management/credentials' : '/v0/management/auth-files', undefined, { name });
    if (r.status !== 200) this.fail(r.status, r.data, 'remove the account');
  }

  /** Ask the provider for a new token now. The answer's tokens are dropped here. */
  async refresh(name: string): Promise<void> {
    const api = await this.detect();
    const r = await this.call<Record<string, unknown>>('POST', api === 'v8' ? '/v8/management/credentials/refresh' : '/v0/management/auth-files/refresh', { name });
    if (r.status === 404 && !str(r.data.error)) throw new ManagementError('This CLIProxyAPI cannot refresh accounts. Update it to a newer version.', 404);
    if (r.status !== 200) this.fail(r.status, r.data, 'refresh the account');
  }

  /** Install only a known subscription plugin, on a sign-in request (owner or member).
   * Trust is the official store's claim plus the pinned version string: no
   * artifact hash is checked, so the upstream plugin repository is trusted. */
  ensureSubscriptionPlugin(provider: string): Promise<void> {
    const id = Object.hasOwn(SUBSCRIPTION_PLUGINS, provider) ? SUBSCRIPTION_PLUGINS[provider].id : undefined;
    if (!id) return Promise.reject(new ManagementError('That subscription has no supported store plugin.', 400));
    const running = this.installingPlugins.get(id);
    if (running) return running;
    const run = this.installSubscriptionPlugin(provider, id).finally(() => this.installingPlugins.delete(id));
    this.installingPlugins.set(id, run);
    return run;
  }

  private async installSubscriptionPlugin(provider: string, id: string): Promise<void> {
    const api = await this.detect();
    const local = await this.call<{ plugins?: Array<Record<string, unknown>> }>('GET', `/${api}/management/plugins`);
    if (local.status !== 200 || !Array.isArray(local.data.plugins)) throw new ManagementError('Cannot safely inspect existing CLIProxyAPI plugins; nothing was installed.', 409);
    const existing = local.data.plugins.filter((p) => p.id === id || p.oauth_provider === provider);
    // Keep deliberately installed providers, including another implementation.
    // Never reinstall a disabled, incompatible or configured local plugin.
    if (existing.some((p) => p.supports_oauth === true && p.effective_enabled === true && p.oauth_provider === provider)) return;
    if (existing.length) throw new ManagementError(`The ${id} provider already has a plugin configured. Enable or repair it in CLIProxyAPI; Conclave will not overwrite it.`, 409);
    const store = await this.call<{ sources?: Array<Record<string, unknown>>; plugins?: Array<Record<string, unknown>> }>('GET', '/v0/management/plugin-store', undefined, undefined, 120_000);
    if (store.status !== 200) this.fail(store.status, store.data, 'inspect the plugin store');
    const reviewed = SUBSCRIPTION_PLUGINS[provider];
    const entries = store.data.plugins?.filter((p) => p.id === id);
    if (!entries || entries.some((p) => p.installed === true || p.configured === true || p.registered === true))
      throw new ManagementError(`The ${id} plugin is already installed or its local state is unknown. Conclave will not overwrite it.`, 409);
    if (!store.data.sources?.some((s) => s.id === 'official' && s.url === OFFICIAL_PLUGIN_SOURCE)
      || !entries.some((p) => p.source_id === 'official' && p.source_url === OFFICIAL_PLUGIN_SOURCE && p.repository === reviewed.repository))
      throw new ManagementError(`The official store no longer identifies the reviewed ${id} repository. Nothing was installed.`, 409);
    // 8.0.32 accepts the version in JSON and the source selector in the query.
    const r = await this.call<Record<string, unknown>>('POST', `/v0/management/plugin-store/${id}/install`, { version: reviewed.version }, { source: 'official' }, 120_000);
    if (r.status !== 200) this.fail(r.status, r.data, `install the ${id} plugin`);
    if (r.data.id !== id || r.data.version !== reviewed.version || r.data.source_id !== 'official' || r.data.source_url !== OFFICIAL_PLUGIN_SOURCE)
      throw new ManagementError(`CLIProxyAPI returned an unexpected plugin identity, version or source for ${id}. Sign-in was not started; inspect the installed plugin before retrying.`, 409);
    if (r.data.restart_required === true) throw new ManagementError(`The ${id} plugin needs a CLIProxyAPI restart before sign-in.`, 409);
    // Installation reloads config asynchronously. Do not start OAuth until
    // the new provider is actually registered and effective.
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await this.oauthPlugins()).some((p) => p.id === provider)) return;
      await Bun.sleep(250);
    }
    throw new ManagementError(`The ${id} plugin was installed but did not become available. Check CLIProxyAPI's plugin compatibility and logs.`, 409);
  }

  /** Sign-in providers that plugins add (supports_oauth). Empty when the list is not available. */
  async oauthPlugins(): Promise<Array<{ id: string; name: string }>> {
    const api = await this.detect().catch(() => undefined);
    if (!api) return [];
    const r = await this.call<{ plugins?: Array<Record<string, unknown>> }>('GET', `/${api}/management/plugins`).catch(() => undefined);
    if (!r || r.status !== 200) return [];
    return (r.data.plugins ?? [])
      .filter((p) => p.supports_oauth === true && (p.effective_enabled === true || (p.effective_enabled === undefined && p.enabled === true)) && str(p.oauth_provider))
      .map((p) => ({ id: str(p.oauth_provider)!.toLowerCase(), name: str((p.metadata as Record<string, unknown> | undefined)?.name) ?? str(p.oauth_provider)! }));
  }
}

/**
 * One account's model list as credentials/models gives it, split into its
 * prefix and each model once. CLIProxyAPI's credentials list never carries
 * the prefix (8.0.32 keeps it in the auth file only), but once a plan has
 * one its list names every model twice: "claude-opus-5-5" and
 * "personal/claude-opus-5-5". Undefined prefix: the list has no prefixed id.
 * While a renamed plan is listed under both names, `prefer` (the name the
 * hub wrote or last saw) wins when listed; otherwise the most listed one.
 */
export function splitPrefixed<T extends { id: string }>(models: T[], prefer?: string): { prefix?: string; models: T[] } {
  const count = new Map<string, number>();
  for (const m of models) {
    const i = m.id.lastIndexOf('/');
    if (i > 0) count.set(m.id.slice(0, i), (count.get(m.id.slice(0, i)) ?? 0) + 1);
  }
  const prefix = prefer && count.has(prefer) ? prefer : [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const out: T[] = [];
  const seen = new Set<string>();
  // another prefix on an id the list also has bare or under the prefix (the old short name, before CLIProxyAPI drops it) is the same model too
  const bare = new Set(models.map((m) => m.id).filter((id) => !id.includes('/') || (prefix && id.startsWith(`${prefix}/`))).map((id) => id.slice(id.lastIndexOf('/') + 1)));
  for (const m of models) {
    const own = m.id.slice(m.id.lastIndexOf('/') + 1);
    const id = (prefix && m.id.startsWith(`${prefix}/`)) || bare.has(own) ? own : m.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id === m.id ? m : { ...m, id });
  }
  return { ...(prefix ? { prefix } : {}), models: out };
}

/** A quoted entity tag, as ChatGPT sends it. */
const ETAG = /^(W\/)?"[\w.:+/=-]{1,200}"$/;

/** One model of a ChatGPT plan's own list. */
export interface CodexModel {
  id: string;
  name?: string;
  /** The Effort levels it takes, lowest first ("low" to "ultra"). */
  efforts?: string[];
  defaultEffort?: string;
  /** visibility "hide": kept out of the Codex app's picker (review models, reserve models). */
  hidden?: true;
}

const LEVEL = /^[a-z]{2,12}$/;

/**
 * The models a ChatGPT plan offers, from its Codex models answer, each once:
 * its name, the Effort levels it takes and its default. A model the plan
 * hides from the Codex app (visibility "hide") or keeps from the API comes
 * back marked hidden.
 */
export function codexModels(json: unknown): CodexModel[] {
  const list = (json as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  const out: CodexModel[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const id = str(r.slug) ?? str(r.id);
    if (!id || !/^[\w.:-]{1,80}$/.test(id) || out.some((x) => x.id === id)) continue;
    const name = str(r.display_name);
    // Codex's shape: supported_reasoning_levels [{effort, description}] or plain words, default_reasoning_level
    const raw = Array.isArray(r.supported_reasoning_levels) ? r.supported_reasoning_levels : Array.isArray(r.supported_reasoning_efforts) ? r.supported_reasoning_efforts : [];
    const efforts = raw.map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.effort))).filter((l): l is string => !!l && LEVEL.test(l));
    const def = str(r.default_reasoning_level) ?? str(r.default_reasoning_effort);
    const hidden = ['hide', 'hidden'].includes(str(r.visibility) ?? '') || r.supported_in_api === false;
    out.push({ id, ...(name && name.length <= 80 ? { name } : {}), ...(efforts.length ? { efforts: [...new Set(efforts)] } : {}), ...(def && LEVEL.test(def) ? { defaultEffort: def } : {}), ...(hidden ? { hidden: true as const } : {}) });
  }
  return out;
}

/** GET {root}/v1/models with a client key: the ids and who owns them. */
export async function listModels(root: string, key: string, f: typeof fetch = fetch, timeoutMs = 10_000): Promise<Array<{ id: string; ownedBy?: string }>> {
  let res: Response;
  try {
    res = await f(`${root.replace(/\/+$/, '')}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ManagementError(`CLIProxyAPI did not answer at ${root} (${(err as Error).message}). Check the address and that it runs.`, 0);
  }
  if (res.status === 401 || res.status === 403) throw new ManagementError('CLIProxyAPI refused the client key. Copy one from access.api-keys in its config.yaml.', res.status);
  if (!res.ok) throw new ManagementError(`CLIProxyAPI answered ${res.status} for its model list.`, res.status);
  const data = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
  return (data.data ?? []).filter((m) => typeof m.id === 'string' && m.id).map((m) => ({ id: m.id as string, ownedBy: str(m.owned_by) }));
}
