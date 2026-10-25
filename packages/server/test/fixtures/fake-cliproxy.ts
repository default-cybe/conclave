/**
 * A fake CLIProxyAPI for tests and local checks. It answers what the hub
 * uses: `-h` (the version line), `-config <file>` (the v8 YAML the hub
 * writes), /healthz, /v1/models, /v1/messages, /v1/chat/completions,
 * /v1/responses and /v1beta/models/<model>:streamGenerateContent (canned
 * streams; the Gemini route takes the key as x-goog-api-key or ?key=), and
 * the management API: oauth/auth-url, status,
 * callback, session, credentials (list, delete, refresh) and plugins.
 * It never reaches a real provider.
 *
 * A pasted callback code "ok:<email>[:<prefix>]" signs that account in;
 * "bad" fails the token exchange. Device sign-ins (xai, kimi, meta) finish
 * by themselves after FAKE_CPA_DEVICE_MS.
 *
 * For the accounts: each credential's priority, quota signals and
 * cooldowns (from fields in its auth file: priority, signals, cooldowns),
 * its models (credentials/models), PATCH credentials/fields,
 * routing/cooldown/reset, and requests/api-call with canned answers for the
 * addresses the hub may ask for (an auth file's "usage", "usage_status",
 * "profile" and "codex_models" override them; "quota_daily" and "quota" answer
 * Antigravity's retrieveUserQuotaSummary, else 404). api-call answers any other
 * address with status_code 599, so a test sees it.
 *
 * Shapes as the real 8.0.32 gives them (checked against its binary):
 * - the credentials list never carries the prefix, though the auth file
 *   keeps it and PATCH fields sets it;
 * - an account with a prefix lists each model twice in credentials/models
 *   and /v1/models: "claude-opus-5-5" and "neu/claude-opus-5-5" (its bare
 *   ids still route to it, force-model-prefix is off);
 * - a ChatGPT plan's models come from the catalog only, by its plan
 *   (codex-pro unless the auth file's plan_type says otherwise): the
 *   built-in list below, plus what models.catalog adds (a file path in the
 *   config, or PUT /v8/management/config/models/catalog);
 * - a request for a model no account lists ends with 400 model_not_found,
 *   "unknown provider for model X", before any provider is asked.
 *
 * Env: FAKE_CPA_VERSION (8.0.32), FAKE_CPA_CRASH=1 (exit at start),
 * FAKE_CPA_BROKEN=1 (-h fails), FAKE_CPA_V0=1 (only /v0/management),
 * FAKE_CPA_CALLBACK_PORT (54545), FAKE_CPA_DEVICE_MS (400),
 * FAKE_CPA_LOG (append one JSON line per model call), FAKE_CPA_PLUGIN=1,
 * FAKE_CPA_MGMT_LOG (one JSON line per fields, cooldown reset and api-call).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = process.env.FAKE_CPA_VERSION || '8.0.32';
const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  if (process.env.FAKE_CPA_BROKEN === '1') process.exit(1);
  console.log(`CLIProxyAPI Version: ${VERSION}, Commit: fake, BuiltAt: 2026-10-17T00:00:00Z`);
  console.error('Usage of cli-proxy-api:\n  -config string\n    \tConfigure File Path (default "config.yaml")');
  process.exit(0);
}

console.log(`CLIProxyAPI Version: ${VERSION}, Commit: fake, BuiltAt: 2026-10-17T00:00:00Z`);
if (process.env.FAKE_CPA_CRASH === '1') {
  console.log('time="2026-10-18T07:00:00Z" level=fatal msg="failed to start: fake crash"');
  process.exit(1);
}

const configPath = args[args.indexOf('-config') + 1] ?? 'config.yaml';
const cfg = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
  server?: { host?: string; port?: number };
  management?: { 'secret-key'?: string; 'allow-remote'?: boolean };
  access?: { 'api-keys'?: string[] };
  oauth?: { 'auth-dir'?: string };
  plugins?: { enabled?: boolean; configs?: Record<string, { enabled: boolean; store?: { version: string } }> };
};
const host = cfg.server?.host || '127.0.0.1';
const port = cfg.server?.port ?? 8317;
const secret = cfg.management?.['secret-key'] ?? '';
const clientKeys = cfg.access?.['api-keys'] ?? [];
const authDir = (cfg.oauth?.['auth-dir'] ?? './auths').replace(/^~/, process.env.HOME ?? '');
mkdirSync(authDir, { recursive: true });
const cbPort = Number(process.env.FAKE_CPA_CALLBACK_PORT || 54545);
const deviceMs = Number(process.env.FAKE_CPA_DEVICE_MS || 400);
const v0Only = process.env.FAKE_CPA_V0 === '1';

const MODELS: Record<string, Array<[string, string]>> = {
  claude: [['claude-opus-5-5', 'anthropic'], ['claude-sonnet-5-5', 'anthropic'], ['claude-haiku-5-5', 'anthropic']],
  codex: [['gpt-6-astra', 'openai'], ['gpt-6.1-sol', 'openai']],
  antigravity: [['gemini-4-argon', 'google']],
  xai: [['grok-4.7', 'xai']],
  kimi: [['kimi-k3', 'moonshot']],
  'kimi-ai': [['kimi-k3', 'moonshot']],
  meta: [['muse-spark-1.3', 'meta']],
  devin: [['swe-2', 'devin']],
  copilot: [['copilot-test-model', 'github']],
  kiro4cpa: [['claude-kiro-test', 'kiro']],
};
const REDIRECT_PATH: Record<string, string> = { claude: '/callback', codex: '/auth/callback', antigravity: '/oauth-callback', devin: '/callback' };
const DEVICE = new Set(['xai', 'kimi', 'kimi-ai', 'meta', 'copilot', 'kiro4cpa']);
const STORE_SOURCE = 'https://raw.githubusercontent.com/router-for-me/CLIProxyAPI-Plugins-Store/main/registry.json';
const STORE = [
  { id: 'github-copilot', provider: 'copilot', version: '0.1.1', repository: 'https://github.com/syepes/CLIProxyAPI-plugin-github-copilot' },
  { id: 'kiro4cpa', provider: 'kiro4cpa', version: '1.0.5', repository: 'https://github.com/AkkunYo/kiro4cpa-plugin' },
];
const pluginConfigs = () => cfg.plugins?.configs ?? {};
const pluginEntries = () => STORE.filter((p) => pluginConfigs()[p.id]).map((p) => ({ id: p.id, supports_oauth: true, oauth_provider: p.provider, effective_enabled: cfg.plugins?.enabled === true && pluginConfigs()[p.id].enabled, enabled: pluginConfigs()[p.id].enabled, metadata: { name: p.provider, version: pluginConfigs()[p.id].store?.version } }));
const KNOWN = new Set([...Object.keys(MODELS), ...(process.env.FAKE_CPA_PLUGIN === '1' ? ['qwen'] : [])]);

interface Session {
  provider: string;
  status: 'wait' | 'ok' | 'error';
  error?: string;
}
const sessions = new Map<string, Session>();

interface Account {
  type: string;
  email?: string;
  prefix?: string;
  disabled?: boolean;
  priority?: number;
  weight?: number;
  note?: string;
  /** Quota signals as CLIProxyAPI keeps them: canonical header names. */
  signals?: Record<string, string>;
  cooldowns?: Array<{ scope: string; model_key?: string; reason: string; retry_at: string }>;
  /** Canned answer of the usage address for this account. */
  usage?: unknown;
  usage_status?: number;
  /** antigravity: retrieveUserQuotaSummary answers of the daily and prod hosts. */
  quota_daily?: unknown;
  quota?: unknown;
  profile?: unknown;
  chatgpt_account_id?: string;
  /** codex: the plan in the id token (free, plus, pro, team). */
  plan_type?: string;
  /** codex: the plan's own model list as ChatGPT's Codex models address gives it (slugs, or full entries). */
  codex_models?: Array<string | Record<string, unknown>>;
  codex_models_etag?: string;
  /** More models CLIProxyAPI registers for it (as the real one lists codex-auto-review and GPT Image for a ChatGPT plan). */
  extra_models?: string[];
}

const USAGE_URLS = {
  claudeUsage: 'https://api.anthropic.com/api/oauth/usage',
  claudeProfile: 'https://api.anthropic.com/api/oauth/profile',
  codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
  codexModels: 'https://chatgpt.com/backend-api/codex/models?client_version=',
};

function logMgmt(entry: Record<string, unknown>): void {
  if (process.env.FAKE_CPA_MGMT_LOG) appendFileSync(process.env.FAKE_CPA_MGMT_LOG, JSON.stringify(entry) + '\n');
}

const indexOf = (name: string) => `idx-${name.replace(/[^\w.-]/g, '_')}`;

function writeAccount(name: string, acct: Account): void {
  writeFileSync(join(authDir, name), JSON.stringify(acct), { mode: 0o600 });
}

function accounts(): Array<{ name: string; acct: Account; mtime: number }> {
  if (!existsSync(authDir)) return [];
  return readdirSync(authDir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => {
      const file = join(authDir, name);
      return { name, acct: JSON.parse(readFileSync(file, 'utf8')) as Account, mtime: statSync(file).mtimeMs };
    });
}

/** models.catalog: a file path from the config, or set through the management API. */
let catalogPath: string | undefined = (cfg as { models?: { catalog?: string } }).models?.catalog || undefined;

/** The catalog section of a ChatGPT plan, as CLIProxyAPI picks it. */
function codexSection(plan: string | undefined): string {
  const p = (plan ?? '').toLowerCase();
  return p === 'plus' ? 'codex-plus' : p === 'free' ? 'codex-free' : p === 'team' || p === 'business' || p === 'go' ? 'codex-team' : 'codex-pro';
}

/** An account's models as CLIProxyAPI registers them: the built-in list for its type, plus a ChatGPT plan's catalog section. */
function modelsOf(acct: Account): Array<[string, string]> {
  const out = [...(MODELS[acct.type] ?? []), ...(acct.extra_models ?? []).map((id): [string, string] => [id, 'openai'])];
  if (acct.type === 'codex' && catalogPath && existsSync(catalogPath)) {
    const section = (JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, Array<{ id: string }>>)[codexSection(acct.plan_type)] ?? [];
    for (const m of section) if (!out.some(([id]) => id === m.id)) out.push([m.id, 'openai']);
  }
  return out;
}

/** With a prefix, each model twice: bare (force-model-prefix is off) and prefixed. */
function idsOf(acct: Account): Array<[string, string]> {
  return modelsOf(acct).flatMap(([id, owner]): Array<[string, string]> => (acct.prefix ? [[id, owner], [`${acct.prefix}/${id}`, owner]] : [[id, owner]]));
}

/** Every model some account that is on lists: what /v1/models gives and what a request may name. */
function servedIds(): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const { acct } of accounts()) {
    if (acct.disabled) continue;
    for (const [id, owner] of idsOf(acct)) if (!seen.has(id)) (seen.add(id), out.push([id, owner]));
  }
  return out;
}

function saveAccount(provider: string, email: string, prefix?: string): void {
  const name = `${provider}-${email}.json`;
  writeFileSync(join(authDir, name), JSON.stringify({ type: provider, email, ...(prefix ? { prefix } : {}), access_token: 'at-fake-SECRET', refresh_token: 'rt-fake-SECRET' }), { mode: 0o600 });
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
const mgmtHeaders = { 'x-cpa-version': VERSION, 'x-cpa-commit': 'fake' };

async function mgmtAuthorized(req: Request): Promise<boolean> {
  if (!secret) return false;
  const h = req.headers.get('authorization') ?? '';
  const given = h.toLowerCase().startsWith('bearer ') ? h.slice(7) : (req.headers.get('x-management-key') ?? h);
  if (!given) return false;
  if (/^\$2[aby]\$/.test(secret)) return Bun.password.verify(given, secret).catch(() => false);
  return given === secret;
}

function clientAuthorized(req: Request): boolean {
  const h = req.headers.get('authorization') ?? '';
  const key = h.toLowerCase().startsWith('bearer ') ? h.slice(7) : (req.headers.get('x-api-key') ?? req.headers.get('x-goog-api-key') ?? new URL(req.url).searchParams.get('key') ?? '');
  return clientKeys.includes(key);
}

function startLogin(provider: string): Response {
  logMgmt({ path: 'auth-url', provider });
  if (!KNOWN.has(provider) || (STORE.some((p) => p.provider === provider) && !pluginEntries().some((p) => p.oauth_provider === provider && p.effective_enabled))) return json({ error: 'provider_not_found' }, 404, mgmtHeaders);
  const state = `st-${crypto.randomUUID()}`;
  sessions.set(state, { provider, status: 'wait' });
  if (DEVICE.has(provider)) {
    setTimeout(() => {
      const s = sessions.get(state);
      if (s?.status !== 'wait') return;
      saveAccount(provider, `${provider}-device@example.test`);
      s.status = 'ok';
    }, deviceMs);
    return json({ status: 'ok', url: `https://${provider}.example.test/device?user_code=WXYZ-1234`, state, flow: 'device', user_code: 'WXYZ-1234', expires_in: 600 }, 200, mgmtHeaders);
  }
  const redirect = `http://localhost:${cbPort}${REDIRECT_PATH[provider] ?? '/callback'}`;
  const url = `https://${provider}.example.test/oauth/authorize?client_id=fake&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  return json({ status: 'ok', url, state }, 200, mgmtHeaders);
}

async function callback(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { provider?: string; state?: string; code?: string; error?: string; redirect_url?: string };
  let { state, code, error } = body;
  if (body.redirect_url) {
    const u = new URL(body.redirect_url);
    state ||= u.searchParams.get('state') ?? undefined;
    code ||= u.searchParams.get('code') ?? undefined;
    error ||= u.searchParams.get('error') ?? undefined;
  }
  if (!state) return json({ status: 'error', error: 'state is required' }, 400);
  const s = sessions.get(state);
  if (!s) return json({ status: 'error', error: 'unknown or expired state' }, 404);
  if (s.status === 'ok') return json({ status: 'error', error: 'oauth flow is already completed' }, 409);
  if (body.provider && body.provider !== s.provider) return json({ status: 'error', error: 'provider does not match state' }, 400);
  if (!code && !error) return json({ status: 'error', error: 'code or error is required' }, 400);
  setTimeout(() => {
    if (error) {
      s.status = 'error';
      s.error = 'Bad request';
    } else if (code === 'bad') {
      s.status = 'error';
      s.error = 'Failed to exchange authorization code for tokens';
    } else {
      const [, email = 'someone@example.test', prefix] = (code ?? '').split(':');
      saveAccount(s.provider, email, prefix);
      s.status = 'ok';
    }
  }, 150);
  return json({ status: 'ok' });
}

function credentialList(): Response {
  const now = Date.now();
  const files = accounts().map(({ name, acct, mtime }) => {
    const cooldowns = (acct.cooldowns ?? []).filter((c) => Date.parse(c.retry_at) > now).map((c) => ({ ...c, remaining_seconds: Math.ceil((Date.parse(c.retry_at) - now) / 1000) }));
    return {
      id: name,
      auth_index: indexOf(name),
      name,
      type: acct.type,
      provider: acct.type,
      label: acct.email ?? '',
      ...(acct.email ? { account: acct.email } : {}),
      status: acct.disabled ? 'disabled' : 'active',
      status_message: '',
      disabled: !!acct.disabled,
      unavailable: cooldowns.length > 0,
      runtime_only: false,
      source: 'file',
      email: acct.email,
      account_type: 'oauth',
      updated_at: new Date(mtime).toISOString(),
      success: 3,
      failed: 0,
      quota: { ...(acct.signals ? { observed_at: new Date(mtime).toISOString() } : {}), signals: acct.signals ?? {} },
      cooldowns,
      ...(cooldowns.length ? { next_retry_after: cooldowns[0].retry_at } : {}),
      // the real list has priority and note, never the prefix
      ...(acct.priority !== undefined ? { priority: acct.priority } : {}),
      ...(acct.note ? { note: acct.note } : {}),
      ...(acct.type === 'codex' ? { id_token: { chatgpt_account_id: acct.chatgpt_account_id ?? 'acct-fake-1', plan_type: acct.plan_type ?? 'pro' } } : {}),
    };
  });
  return json({ observed_at: new Date().toISOString(), files }, 200, mgmtHeaders);
}

function logCall(path: string, model: string, session?: string | null): void {
  if (process.env.FAKE_CPA_LOG) appendFileSync(process.env.FAKE_CPA_LOG, JSON.stringify({ path, model, ...(session ? { session } : {}) }) + '\n');
}

function sse(chunks: Array<{ event?: string; data: unknown }>, tail = ''): Response {
  const text = chunks.map((c) => `${c.event ? `event: ${c.event}\n` : ''}data: ${JSON.stringify(c.data)}\n\n`).join('') + tail;
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function management(req: Request, url: URL, api: 'v8' | 'v0'): Promise<Response> {
  const p = url.pathname.slice(`/${api}/management`.length);
  // callbacks need no key, only a pending state (as the real one)
  if (req.method === 'POST' && (p === '/oauth/callback' || p === '/oauth-callback')) return callback(req);
  if (!(await mgmtAuthorized(req))) return json({ error: secret ? 'invalid management key' : 'management disabled' }, secret ? 401 : 404);
  if (p === '/plugin-store' && req.method === 'GET') return json({ sources: [{ id: 'official', url: STORE_SOURCE }], plugins: STORE.map((s) => ({ ...s, source_id: 'official', source_url: STORE_SOURCE, installed: !!pluginConfigs()[s.id], configured: !!pluginConfigs()[s.id] })) }, 200, mgmtHeaders);
  const install = /^\/plugin-store\/([^/]+)\/install$/.exec(p);
  if (install && req.method === 'POST') {
    const entry = STORE.find((s) => s.id === install[1]);
    const body = await req.json() as { version?: string };
    logMgmt({ path: 'plugin-install', id: install[1], source: url.searchParams.get('source'), body });
    if (!entry || body.version !== entry.version || url.searchParams.get('source') !== 'official') return json({ error: 'unreviewed install' }, 400);
    cfg.plugins ??= { enabled: true };
    cfg.plugins.configs ??= {};
    cfg.plugins.configs[entry.id] = { enabled: true, store: { version: entry.version } };
    writeFileSync(configPath, Bun.YAML.stringify(cfg));
    return json({ status: 'installed', id: entry.id, version: entry.version, source_id: 'official', source_url: STORE_SOURCE, restart_required: false, ...(process.env.FAKE_CPA_INSTALL_RESPONSE ? JSON.parse(process.env.FAKE_CPA_INSTALL_RESPONSE) : {}) }, 200, mgmtHeaders);
  }
  if (api === 'v8') {
    if (p === '/credentials' && req.method === 'GET') return credentialList();
    if (p === '/credentials/models' && req.method === 'GET') {
      const a = accounts().find((x) => x.name === url.searchParams.get('name'));
      if (!a) return json({ error: 'auth file not found' }, 404, mgmtHeaders);
      return json({ models: idsOf(a.acct).map(([id, owner]) => ({ id, display_name: id.slice(id.lastIndexOf('/') + 1), type: a.acct.type, owned_by: owner })) }, 200, mgmtHeaders);
    }
    if (p === '/credentials/fields' && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const a = accounts().find((x) => x.name === body.name);
      if (!a) return json({ error: 'auth file not found' }, 404, mgmtHeaders);
      const fields: Record<string, unknown> = {};
      for (const k of ['priority', 'prefix', 'weight', 'note', 'disabled']) if (k in body) fields[k] = body[k];
      if (!Object.keys(fields).length) return json({ error: 'no fields to update' }, 400, mgmtHeaders);
      writeAccount(a.name, { ...a.acct, ...fields } as Account);
      logMgmt({ path: 'fields', name: a.name, fields });
      return json({ status: 'ok' }, 200, mgmtHeaders);
    }
    if (p === '/routing/cooldown/reset' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { auth_index?: string };
      const a = accounts().find((x) => indexOf(x.name) === body.auth_index);
      if (!a) return json({ error: 'auth not found' }, 404, mgmtHeaders);
      writeAccount(a.name, { ...a.acct, cooldowns: [] });
      logMgmt({ path: 'cooldown-reset', name: a.name });
      return json({ status: 'ok', auth_index: body.auth_index, models: [] }, 200, mgmtHeaders);
    }
    if (p === '/requests/api-call' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { auth_index?: string; method?: string; url?: string; header?: Record<string, string>; data?: string };
      const a = accounts().find((x) => indexOf(x.name) === body.auth_index);
      // the hub sends the placeholder; the real CLIProxyAPI puts the token in, so the hub never holds it
      logMgmt({ path: 'api-call', name: a?.name, method: body.method, url: body.url, authorization: body.header?.Authorization ?? body.header?.authorization, headers: Object.keys(body.header ?? {}).sort(), data: body.data ?? null });
      if (!a) return json({ error: 'auth credential not found for auth_index' }, 400, mgmtHeaders);
      const answer = (status: number, payload: unknown, header: Record<string, string[]> = {}) => json({ status_code: status, header: { 'Content-Type': ['application/json'], ...header }, body: JSON.stringify(payload) }, 200, mgmtHeaders);
      if (body.method === 'GET' && body.url === USAGE_URLS.claudeUsage) {
        const st = a.acct.usage_status ?? 200;
        if (st === 429) return answer(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, { 'Retry-After': ['900'] });
        return answer(st, a.acct.usage ?? { five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3 * 3600_000).toISOString() }, seven_day: { utilization: 34, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() } });
      }
      if (body.method === 'GET' && body.url === USAGE_URLS.claudeProfile) return answer(200, a.acct.profile ?? { account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_20x' } });
      if (body.method === 'GET' && body.url?.startsWith(USAGE_URLS.codexModels)) {
        const list = a.acct.codex_models ?? (MODELS.codex ?? []).map(([id]) => id);
        // an entity tag on the list (codex_models_etag): the same tag back is a 304 with no body
        const tag = a.acct.codex_models_etag;
        if (tag && (body.header?.['If-None-Match'] ?? '') === tag) return json({ status_code: 304, header: { ETag: [tag] }, body: '' }, 200, mgmtHeaders);
        return answer(200, { models: list.map((m) => (typeof m === 'string' ? { slug: m, display_name: m, visibility: 'list', supported_in_api: true, minimal_client_version: '0.98.0' } : m)) }, tag ? { ETag: [tag] } : {});
      }
      if (body.method === 'POST' && body.url === 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')
        return answer(a.acct.usage_status ?? 200, a.acct.usage ?? { currentTier: { id: 'GOOGLE_ONE_AI_PREMIUM' }, paidTier: { id: 'GOOGLE_ONE_AI_PREMIUM', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '96.5', minimumCreditAmountForUsage: '5' }] } });
      if (body.method === 'POST' && body.url === 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary') return a.acct.quota_daily ? answer(200, a.acct.quota_daily) : answer(404, { error: 'not found' });
      if (body.method === 'POST' && body.url === 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary') return a.acct.quota ? answer(200, a.acct.quota) : answer(404, { error: 'not found' });
      if (body.method === 'GET' && body.url === USAGE_URLS.codexUsage) return answer(a.acct.usage_status ?? 200, a.acct.usage ?? { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 300_000 } } });
      return answer(599, { error: 'the fake answers only the usage addresses' });
    }
    if (p === '/config/models/catalog') {
      if (req.method === 'GET') return json({ catalog: catalogPath ?? '' }, 200, mgmtHeaders);
      if (req.method === 'DELETE') {
        catalogPath = undefined;
        logMgmt({ path: 'catalog', catalog: null });
        return json({ 'config-version': 8, status: 'ok' }, 200, mgmtHeaders);
      }
      if (req.method === 'PUT') {
        const v = await req.json().catch(() => undefined);
        if (typeof v !== 'string' || !v.startsWith('/')) return json({ error: 'catalog must be an absolute path or a URL' }, 400, mgmtHeaders);
        catalogPath = v;
        logMgmt({ path: 'catalog', catalog: v });
        return json({ 'config-version': 8, status: 'ok' }, 200, mgmtHeaders);
      }
    }
    if (p === '/oauth/auth-url') return startLogin((url.searchParams.get('provider') ?? '').toLowerCase());
    if (p === '/oauth/status') {
      const s = sessions.get(url.searchParams.get('state') ?? '');
      if (!s) return json({ status: 'error', error: 'unknown or expired state' }, 200, mgmtHeaders);
      return json(s.status === 'error' ? { status: 'error', error: s.error } : { status: s.status }, 200, mgmtHeaders);
    }
    if (p === '/oauth/session' && req.method === 'DELETE') {
      const s = sessions.get(url.searchParams.get('state') ?? '');
      if (s && s.status === 'wait') sessions.delete(url.searchParams.get('state') ?? '');
      return json({ status: 'ok', cancelled: !!s }, 200, mgmtHeaders);
    }
    if (p === '/credentials/refresh' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      if (!accounts().some((a) => a.name === body.name)) return json({ error: 'auth file not found' }, 404, mgmtHeaders);
      return json({ ok: true, auth: { id: body.name, access_token: 'at-REFRESHED-SECRET', refresh_token: 'rt-REFRESHED-SECRET' } }, 200, mgmtHeaders);
    }
    if (p === '/plugins') {
      const plugins = process.env.FAKE_CPA_PLUGIN === '1' ? [{ id: 'qwen-login', supports_oauth: true, oauth_provider: 'qwen', enabled: true, effective_enabled: true, metadata: { name: 'Qwen' } }] : [];
      return json({ plugins_dir: 'plugins', plugins: [...plugins, ...pluginEntries()] }, 200, mgmtHeaders);
    }
  } else {
    if (p === '/auth-files' && req.method === 'GET') return credentialList();
    const m = /^\/([a-z-]+)-auth-url$/.exec(p);
    if (m) return startLogin(m[1] === 'anthropic' ? 'claude' : m[1]);
    if (p === '/get-auth-status') {
      const s = sessions.get(url.searchParams.get('state') ?? '');
      return json(!s ? { status: 'error', error: 'unknown or expired state' } : s.status === 'error' ? { status: 'error', error: s.error } : { status: s.status }, 200, mgmtHeaders);
    }
  }
  if ((p === '/credentials' || p === '/auth-files') && req.method === 'DELETE') {
    const name = url.searchParams.get('name') ?? '';
    if (!accounts().some((a) => a.name === name)) return json({ error: 'file not found' }, 404, mgmtHeaders);
    rmSync(join(authDir, name));
    return json({ status: 'ok' }, 200, mgmtHeaders);
  }
  // Gin answers an unknown route with plain text
  return new Response('404 page not found', { status: 404 });
}

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.startsWith('/v8/management') || path.startsWith('/v0/management')) {
      const api = path.startsWith('/v8') ? 'v8' : 'v0';
      if (api === 'v8' && v0Only) return new Response('404 page not found', { status: 404 });
      const peer = srv.requestIP(req)?.address ?? '';
      const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      if (!local && !cfg.management?.['allow-remote']) return json({ error: 'remote management disabled' }, 403);
      return management(req, url, api);
    }
    const gemini = /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/.exec(path);
    if (gemini) {
      if (!clientAuthorized(req)) return json({ error: { code: 401, message: 'Missing API key', status: 'UNAUTHENTICATED' } }, 401);
      const model = decodeURIComponent(gemini[1]);
      if (!servedIds().some(([id]) => id === model)) return json({ error: { code: 400, message: `unknown provider for model ${model}`, status: 'INVALID_ARGUMENT' } }, 400);
      logCall(path, model, req.headers.get('x-session-id'));
      return sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: `Hello from ${model} over gemini` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 } } }]);
    }
    if (path.startsWith('/v1/')) {
      if (!clientAuthorized(req)) return json({ error: { message: 'Missing API key', type: 'invalid_request_error' } }, 401);
      if (path === '/v1/models') return json({ object: 'list', data: servedIds().map(([id, owner]) => ({ id, object: 'model', created: 1760000000, owned_by: owner })) });
      const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean };
      const model = body.model ?? 'unknown';
      // the router knows only what the accounts list: anything else ends here, before a provider is asked
      if ((path === '/v1/messages' || path === '/v1/chat/completions' || path === '/v1/responses') && !servedIds().some(([id]) => id === model)) {
        return json({ error: { message: `unknown provider for model ${model}`, type: 'invalid_request_error', code: 'model_not_found', param: 'model' } }, 400);
      }
      if (path === '/v1/messages') {
        logCall(path, model, req.headers.get('x-session-id'));
        const text = `Hello from ${model} over messages`;
        if (!body.stream) return json({ id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 6 } });
        return sse([
          { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }
      if (path === '/v1/chat/completions') {
        logCall(path, model, req.headers.get('x-session-id'));
        const text = `Hello from ${model} over chat`;
        if (!body.stream) return json({ id: 'chatcmpl-fake', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } });
        return sse(
          [
            { data: { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] } },
            { data: { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } } },
          ],
          'data: [DONE]\n\n',
        );
      }
      if (path === '/v1/responses') {
        logCall(path, model, req.headers.get('x-session-id'));
        const text = `Hello from ${model} over responses`;
        const ev = (type: string, data: Record<string, unknown>) => ({ event: type, data: { type, ...data } });
        return sse([
          ev('response.created', { response: { id: 'resp_fake', model } }),
          ev('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_fake', role: 'assistant', content: [] } }),
          ev('response.output_text.delta', { item_id: 'msg_fake', output_index: 0, content_index: 0, delta: text }),
          ev('response.output_item.done', { output_index: 0, item: { type: 'message', id: 'msg_fake', content: [{ type: 'output_text', text }] } }),
          ev('response.completed', { response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6 } } }),
        ]);
      }
    }
    return json({ error: 'not found' }, 404);
  },
});

console.log(`time="${new Date().toISOString()}" level=info msg="API server started successfully on: ${host}:${server.port}"`);
const stop = () => {
  server.stop(true);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
