/**
 * Mock routes for subscription sign-in (setup step 2 and Settings > Models >
 * Subscriptions). The busy hub runs CLIProxyAPI 8.0.32 with a Claude account,
 * a second Claude account under neu/ and a ChatGPT account. A first-run hub
 * (?fresh=1) starts off; the first sign-in turns it on and downloads it.
 *
 * ?sublocal=1: the browser is on the hub's own computer, so a sign-in
 * finishes by itself (the hub catches the localhost redirect). Without it the
 * page asks for the address from the browser bar, as on a phone or another
 * computer. ?subext=1: the busy hub uses an external CLIProxyAPI.
 */
import type { ModelGroup, SignInStartDto, SignInStatusDto, SubscriptionAccountDto, SubscriptionModelGroupDto, SubscriptionProviderDto, SubscriptionsSettingsInput, SubscriptionsStatus } from '@conclave/core/client';
import type { MockCtx } from './index';

const PROVIDERS: Array<Omit<SubscriptionProviderDto, 'accounts'>> = [
  { id: 'claude', name: 'Claude', plan: 'Claude Pro or Max', flow: 'redirect' },
  { id: 'codex', name: 'ChatGPT', plan: 'ChatGPT Plus or Pro, through Codex', flow: 'redirect' },
  { id: 'antigravity', name: 'Google', plan: 'Google AI Pro or Ultra, through Antigravity', flow: 'redirect' },
  { id: 'xai', name: 'Grok', plan: 'SuperGrok, through Grok Build', flow: 'device' },
  { id: 'kimi', name: 'Kimi', plan: 'Kimi Code plan on kimi.com', flow: 'device' },
  { id: 'meta', name: 'Muse', plan: 'Muse Code, with a Meta login', flow: 'device' },
  { id: 'kimi-ai', name: 'Kimi', plan: 'Kimi Code plan on kimi.ai', flow: 'device', more: true },
  { id: 'devin', name: 'Devin', plan: 'A Devin account', flow: 'redirect', more: true },
];

const MODELS: Record<string, Array<[string, string]>> = {
  claude: [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5']],
  codex: [['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-luna', 'GPT-6 Luna']],
  antigravity: [['gemini-4-argon', 'Gemini 4 Argon'], ['gemini-3.8-flash', 'Gemini 3.8 Flash']],
  xai: [['grok-4.7', 'Grok 4.7']],
  kimi: [['kimi-k3', 'Kimi K3']],
  'kimi-ai': [['kimi-k3', 'Kimi K3']],
  meta: [['muse-spark-1.3', 'Muse Spark 1.3']],
  devin: [['swe-2', 'SWE-2']],
};
const REDIRECT: Record<string, string> = { claude: 'localhost:54545/callback', codex: 'localhost:1455/auth/callback', antigravity: 'localhost:51121/oauth-callback', devin: 'localhost:54545/callback' };
const PAGE: Record<string, string> = { claude: 'https://claude.ai/oauth/authorize', codex: 'https://auth.openai.com/oauth/authorize', antigravity: 'https://accounts.google.com/o/oauth2/v2/auth', xai: 'https://accounts.x.ai/device', kimi: 'https://www.kimi.com/device', 'kimi-ai': 'https://www.kimi.ai/device', meta: 'https://www.meta.ai/device', devin: 'https://app.devin.ai/oauth/authorize' };

interface Acct {
  name: string;
  provider: string;
  label: string;
  prefix?: string;
  state: SubscriptionAccountDto['state'];
  detail?: string;
  updatedAt: number;
}

interface Session {
  state: string;
  provider: string;
  flow: 'redirect' | 'device';
  status: SignInStatusDto['status'];
  error?: string;
  account?: SubscriptionAccountDto;
  started: number;
  caught: boolean;
}

export function registerSubscriptions(ctx: MockCtx) {
  const { on, emit, sleep, fail, uid } = ctx;
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const local = q.get('sublocal') === '1';
  const ext = q.get('subext') === '1';
  const H = 3_600_000;

  let mode: SubscriptionsStatus['mode'] = ctx.FRESH ? 'off' : ext ? 'external' : 'builtin';
  let state: SubscriptionsStatus['state'] = ctx.FRESH ? 'off' : 'on';
  let since = Date.now() - (ctx.FRESH ? 0 : 26 * H);
  let detail: string | undefined;
  let error: string | undefined;
  let installed = !ctx.FRESH;
  let url = 'http://192.168.1.10:8317';
  let extKey = ext;
  let extMgmt = ext;
  const accounts: Acct[] = ctx.FRESH
    ? []
    : [
        { name: 'claude-kai@kaivalya.dev.json', provider: 'claude', label: 'kai@kaivalya.dev', state: 'active', updatedAt: Date.now() - 2 * H },
        { name: 'claude-kai@neu.edu.json', provider: 'claude', label: 'kai@neu.edu', prefix: 'neu', state: 'active', updatedAt: Date.now() - 5 * H },
        { name: 'codex-kai@kaivalya.dev.json', provider: 'codex', label: 'kai@kaivalya.dev', state: 'unavailable', detail: 'Weekly limit reached, back Monday', updatedAt: Date.now() - 30 * H },
      ];
  const sessions = new Map<string, Session>();
  /** Models an account's own list adds on Refresh models (core: credentials/models): a model the ChatGPT plan lists before CLIProxyAPI's catalog does. */
  const extra: Record<string, Array<[string, string]>> = {};

  const dto = (a: Acct): SubscriptionAccountDto => ({ name: a.name, provider: a.provider, providerName: PROVIDERS.find((p) => p.id === a.provider)?.name ?? a.provider, label: a.label, state: a.state, detail: a.detail, canRefresh: true, updatedAt: a.updatedAt });

  const groups = (): SubscriptionModelGroupDto[] => {
    const by = new Map<string, SubscriptionModelGroupDto>();
    for (const a of accounts) {
      const key = a.prefix ?? '';
      const g = by.get(key) ?? { account: key, label: key || 'Main accounts', models: [] };
      by.set(key, g);
      for (const [id, name] of [...(MODELS[a.provider] ?? []), ...(extra[a.provider] ?? [])]) {
        const full = a.prefix ? `${a.prefix}/${id}` : id;
        if (g.models.some((m) => m.id === full)) continue;
        g.models.push({ id: full, ref: `cliproxy/${full}`, name: a.prefix ? `${name}, ${a.prefix}` : name, wire: id.startsWith('claude') ? 'anthropic' : 'openai' });
      }
    }
    return [...by.values()].sort((a, b) => (a.account ? 1 : 0) - (b.account ? 1 : 0));
  };

  const management = () => state === 'on' && (mode === 'builtin' || (mode === 'external' && extMgmt));

  const status = (): SubscriptionsStatus => ({
    mode,
    state,
    since,
    detail,
    error,
    provider: 'cliproxy',
    version: mode === 'off' ? undefined : mode === 'external' ? '8.1.0' : installed ? '8.0.32' : undefined,
    binary: mode === 'builtin' && installed ? { path: '/home/kai/.conclave/bin/cli-proxy-api', version: '8.0.32', managed: true, verified: true, sha256: '2b48544067f25d8c8cb9db598baa4a741ed252292faacb22e67ef0a6f46257b7' } : undefined,
    pinned: { version: '8.0.32', repo: 'github.com/router-for-me/CLIProxyAPI', license: 'MIT' },
    external: mode === 'external' ? { url, key: extKey, managementKey: extMgmt } : undefined,
    management: management(),
    managementNote: mode === 'external' && !extMgmt ? 'Add its management key to sign in and see the accounts from here. Models work without it.' : undefined,
    providers: PROVIDERS.map((p) => ({ ...p, accounts: accounts.filter((a) => a.provider === p.id).length })),
    accounts: management() || mode === 'off' ? (mode === 'off' ? [] : accounts.map(dto)) : [],
    models: mode === 'off' ? [] : groups(),
    suggested: mode === 'external' ? undefined : ctx.FRESH ? undefined : { url, key: true },
  });

  const publish = () => emit({ type: 'subscriptions.updated', status: status() });
  const setState = (s: SubscriptionsStatus['state'], d?: string, e?: string) => {
    if (s !== state) since = Date.now();
    state = s;
    detail = d;
    error = e;
    publish();
  };

  /** Download (the first time), then start. */
  const startBuiltin = async () => {
    if (!installed) {
      for (const done of [3, 7, 11, 15, 19, 22]) {
        setState('installing', `Downloading CLIProxyAPI 8.0.32, ${done} of 22 MB`);
        await sleep(450);
        if (mode !== 'builtin') return;
      }
      installed = true;
    }
    setState('starting', 'Starting CLIProxyAPI 8.0.32');
    await sleep(700);
    if (mode === 'builtin') setState('on');
  };

  on('GET', '/api/subscriptions', () => ({ ...status(), local }));

  on('PUT', '/api/subscriptions', async ({ body }) => {
    const b = (body ?? {}) as SubscriptionsSettingsInput;
    const next = b.mode ?? mode;
    if (!['off', 'builtin', 'external'].includes(next)) fail(400, 'mode must be one of off, builtin, external');
    if (next === 'external') {
      const u = (b.url ?? url).trim();
      if (!/^https?:\/\/[^/?#]+/.test(u) && !/^[\w.-]+:\d+/.test(u)) fail(400, 'Use an address like http://192.168.1.10:8317, with no ? or # part.');
      url = u.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      if (!/^https?:/.test(url)) url = `http://${url}`;
      if (b.key) extKey = true;
      if (!extKey) fail(400, 'Paste a client key: one of access.api-keys in its config.yaml.');
      if (b.managementKey === null) extMgmt = false;
      else if (b.managementKey) extMgmt = true;
      mode = 'external';
      setState('starting', `Reaching ${url}`);
      await sleep(500);
      if (/bad|offline/.test(url)) setState('error', 'Trying again in 5 seconds.', `CLIProxyAPI did not answer at ${url} (connection refused). Check the address and that it runs.`);
      else setState('on');
      return { ...status(), local };
    }
    mode = next;
    if (mode === 'off') setState('off');
    else void startBuiltin();
    return { ...status(), local };
  });

  on('POST', '/api/subscriptions/update', () => fail(409, 'CLIProxyAPI 8.0.32 is the newest version this hub knows. A Conclave update brings newer ones.'));

  on('POST', '/api/subscriptions/signin', ({ body }) => {
    if (mode === 'off') fail(409, 'Subscriptions are off. Run CLIProxyAPI on the hub, or connect the one you run, first.');
    if (!management()) fail(409, 'Add its management key to sign in and see the accounts from here. Models work without it.');
    const p = PROVIDERS.find((x) => x.id === body?.provider);
    if (!p) fail(400, 'provider is required');
    const st = `st-${uid('s')}`;
    const s: Session = { state: st, provider: p!.id, flow: p!.flow, status: 'wait', started: Date.now(), caught: local && p!.flow === 'redirect' };
    sessions.set(st, s);
    const redirect = REDIRECT[p!.id];
    const res: SignInStartDto = {
      state: st,
      provider: p!.id,
      url: p!.flow === 'device' ? `${PAGE[p!.id]}?user_code=QXRT-7KMW` : `${PAGE[p!.id]}?client_id=cliproxy&response_type=code&redirect_uri=${encodeURIComponent(`http://${redirect}`)}&state=${st}`,
      flow: p!.flow,
      ...(p!.flow === 'device' ? { userCode: 'QXRT-7KMW' } : { callbackHost: redirect.split('/')[0] }),
      expiresAt: Date.now() + 10 * 60_000,
      caught: s.caught,
    };
    return res;
  });

  const finish = (s: Session) => {
    const n = accounts.filter((a) => a.provider === s.provider).length;
    const label = n ? `kai+${n + 1}@kaivalya.dev` : 'kai@kaivalya.dev';
    const a: Acct = { name: `${s.provider}-${label}.json`, provider: s.provider, label, ...(n ? { prefix: `acct${n + 1}` } : {}), state: 'active', updatedAt: Date.now() };
    accounts.push(a);
    s.status = 'ok';
    s.account = dto(a);
    publish();
  };

  const session = (state: string): Session => {
    const s = sessions.get(state);
    if (!s) fail(404, 'That sign-in ended or was not started here. Start it again.');
    return s!;
  };
  const view = (s: Session): SignInStatusDto => ({ state: s.state, status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.account ? { account: s.account } : {}) });

  on('GET', '/api/subscriptions/signin/:state', ({ params }) => {
    const s = session(params[0]);
    // the hub caught the redirect (same computer), or the device code was typed
    if (s.status === 'wait' && (s.caught || s.flow === 'device') && Date.now() - s.started > 6_000) finish(s);
    return view(s);
  });

  on('POST', '/api/subscriptions/signin/:state/callback', async ({ params, body }) => {
    const s = session(params[0]);
    if (s.status !== 'wait') return view(s);
    const raw = String(body?.url ?? '').trim();
    if (!raw) fail(400, 'Paste the address from the browser bar.');
    let u: URL;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    } catch {
      fail(400, 'That is not an address. Copy the whole address from the browser bar, starting with localhost.');
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u!.hostname)) fail(400, `That address goes to ${u!.hostname}. Paste the one that starts with localhost, from the tab that did not load.`);
    if (!u!.searchParams.get('code') && !u!.searchParams.get('error')) fail(400, 'That address has no sign-in code in it. Paste the address of the page that did not load, after the provider sent you back.');
    await sleep(700);
    if (u!.searchParams.get('error')) {
      s.status = 'error';
      s.error = 'Bad request';
    } else finish(s);
    return view(s);
  });

  on('DELETE', '/api/subscriptions/signin/:state', ({ params }) => {
    const s = session(params[0]);
    if (s.status === 'wait') s.status = 'cancelled';
    return view(s);
  });

  on('DELETE', '/api/subscriptions/accounts/:name', ({ params }) => {
    const i = accounts.findIndex((a) => a.name === params[0]);
    if (i < 0) fail(404, 'That account is not signed in here any more. Reload the list.');
    accounts.splice(i, 1);
    publish();
    return { ...status(), local };
  });

  on('POST', '/api/subscriptions/accounts/:name/refresh', async ({ params }) => {
    const a = accounts.find((x) => x.name === params[0]);
    if (!a) fail(404, 'That account is not signed in here any more. Reload the list.');
    await sleep(500);
    a!.updatedAt = Date.now();
    if (a!.state === 'error') a!.state = 'active';
    publish();
    return { ...status(), local };
  });

  // Refresh models (Settings, Subscriptions): each account's own list again; the ChatGPT plan now offers a new model
  on('POST', '/api/models/refresh', async () => {
    await sleep(900);
    if (mode !== 'off' && state === 'on') extra.codex = [['gpt-6.2-nova', 'GPT-6.2-Nova']];
    publish();
    emit({ type: 'models.updated' });
    const groups = (await (await ctx.request('/api/models')).json()) as ModelGroup[];
    return { groups, failed: [] };
  });

  // the model picker: the hub lists these under CLIProxyAPI while it answers
  on('GET', '/api/models', async ({ query }) => {
    // the inner call goes on to the routes in index.ts
    if (query.get('inner') === '1') return ctx.pass;
    const base = (await (await ctx.request('/api/models?inner=1')).json()) as ModelGroup[];
    const models = status().models.flatMap((g) => g.models);
    if (mode === 'off' || state !== 'on' || !models.length) return base;
    const group: ModelGroup = {
      provider: 'cliproxy',
      name: 'CLIProxyAPI',
      type: 'openai',
      configured: true,
      enabled: true,
      models: models.map((m) => ({
        id: m.id,
        ref: m.ref,
        provider: 'cliproxy',
        name: m.name,
        contextWindow: m.wire === 'anthropic' ? 1_000_000 : 400_000,
        maxOutput: 128_000,
        vision: true,
        tools: true,
        thinking: true,
        caching: m.wire === 'anthropic' ? 'explicit' : 'automatic',
        inputPrice: 0,
        outputPrice: 0,
        cacheReadPrice: 0,
        cacheWritePrice: 0,
      })),
    };
    return [...base.filter((g) => g.provider !== 'cliproxy'), group];
  });
}
