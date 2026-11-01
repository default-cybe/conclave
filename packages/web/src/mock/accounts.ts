/**
 * Mock routes for Settings > Models > Accounts and the per-account limits on
 * Usage. The busy hub has the owner's example: personal (a 5 hour limit
 * only) is at its limit, so neu (a 20x plan whose week resets Tuesday 10:00,
 * ids also as neu/) takes the calls, and the Claude API key (a $100 budget
 * that resets on the 22nd) comes last. ChatGPT's plan is at its weekly limit, so its API
 * key takes over. A first-run hub (?fresh=1) has no accounts.
 *
 * Window starters: Account 2's is on and starts its next window at the
 * reset, ChatGPT's waits for the week, Account 1's is off. ?starter=stopped
 * turns Account 1's on, stopped after a 429; ?starter=new has every one off
 * and the note not shown yet. ?prefix=none leaves neu without its short
 * name, so both Claude plans ask for one.
 *
 * "Use when a model refuses" is off on every account. Turning it on for a
 * plan without a short name gives the plan the suggested one, as the hub
 * does; a first-run hub (no management key) refuses it for plans.
 */
import type { AccountDto, AccountNowDto, AccountOrderInput, AccountPatch, AccountRouteDto, AccountsStatus, StarterDto } from '@conclave/core/client';
import type { LimitState, LimitWindow } from '@conclave/core/types';
import { prefixProblem, suggestPrefixes } from '@conclave/core/accounts/prefix';
import type { MockCtx } from './index';

const MIN = 60_000;
const H = 3_600_000;
const D = 86_400_000;

/** Next Tuesday 10:00 local time (today when it is Tuesday before 10:00). */
function nextTuesday(now: number): number {
  const d = new Date(now);
  d.setHours(10, 0, 0, 0);
  let add = (2 - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

/** The 22nd at 00:00 local after now, and the one before. */
function budgetSpan(now: number): { start: number; end: number } {
  const d = new Date(now);
  const here = new Date(d.getFullYear(), d.getMonth(), 22).getTime();
  if (here <= now) return { start: here, end: new Date(d.getFullYear(), d.getMonth() + 1, 22).getTime() };
  return { start: new Date(d.getFullYear(), d.getMonth() - 1, 22).getTime(), end: here };
}

const CLAUDE = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
];
const GPT = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
];

const w = (name: string, usedPercent: number, resetsAt: number | undefined, extra: Partial<LimitWindow> = {}): LimitWindow => ({
  name,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
  kind: name === '5h' ? 'session' : name === 'budget' ? 'budget' : 'weekly',
  windowMs: name === '5h' ? 5 * H : 7 * D,
  source: name === 'budget' ? 'ledger' : 'oauth',
  observedAt: Date.now() - 2 * MIN,
  ...extra,
});

const ZONE = 'America/Los_Angeles';
const starterOff = (auto: string): StarterDto => ({ enabled: false, start: '07:00', end: '22:30', zone: ZONE, autoModel: auto, state: 'off' });

/** Tomorrow at 07:00 local. */
function tomorrowSeven(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d.getTime();
}

function seed(now: number): AccountDto[] {
  const span = budgetSpan(now);
  const tue = nextTuesday(now);
  const spent = 38.4;
  const mode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('starter') : null;
  const stopped = mode === 'stopped';
  const unnamed = typeof location !== 'undefined' && new URLSearchParams(location.search).get('prefix') === 'none';
  const on = <T extends StarterDto>(s: T): StarterDto => (mode === 'new' ? starterOff(s.autoModel ?? '') : s);
  return [
    {
      id: 'claude-kai@kaivalya.dev',
      label: 'personal',
      vendor: 'anthropic',
      vendorName: 'Claude',
      kind: 'subscription',
      credential: 'claude-kai@kaivalya.dev.json',
      email: 'kai@kaivalya.dev',
      plan: 'Max 5x',
      enabled: true,
      state: 'limited',
      detail: '5 hour limit reached',
      until: now + 83 * MIN,
      windows: [w('5h', 100, now + 83 * MIN)],
      models: CLAUDE,
      priority: 2,
      observedAt: now - 2 * MIN,
      saved: true,
      starter: stopped
        ? { ...starterOff('claude-haiku-5-5'), enabled: true, state: 'stopped', until: tomorrowSeven(now), reason: '429', lastModel: 'claude-haiku-5-5' }
        : starterOff('claude-haiku-5-5'),
    },
    {
      id: 'claude-kai@neu.edu',
      label: 'neu',
      vendor: 'anthropic',
      vendorName: 'Claude',
      kind: 'subscription',
      credential: 'claude-kai@neu.edu.json',
      email: 'kai@neu.edu',
      plan: 'Max 20x',
      enabled: true,
      state: 'ready',
      windows: [w('5h', 22, now + 3 * H + 10 * MIN), w('7d', 55, tue), w('7d opus', 30, tue), w('7d fable', 12, tue)],
      models: CLAUDE,
      ...(unnamed ? {} : { prefix: 'neu' }),
      priority: 1,
      observedAt: now - 2 * MIN,
      saved: true,
      starter: on({ ...starterOff('claude-haiku-5-5'), enabled: true, state: 'scheduled', nextAt: now + 3 * H + 10 * MIN + 3_000, startedAt: now - H - 50 * MIN, lastModel: 'neu/claude-haiku-5-5' }),
    },
    {
      id: 'api-anthropic',
      label: 'Claude API key',
      vendor: 'anthropic',
      vendorName: 'Claude',
      kind: 'api',
      provider: 'anthropic',
      plan: 'API key',
      enabled: true,
      state: 'ready',
      windows: [w('budget', 38.4, span.end, { limit: 100, remaining: 100 - spent, windowMs: span.end - span.start }), { name: 'requests', usedPercent: 12, remaining: 3_520, limit: 4_000, resetsAt: now + 40_000, kind: 'rate', windowMs: 60_000, source: 'headers' }],
      models: CLAUDE,
      budget: { usd: 100, period: 'month', resetDay: 22, warnAt: 80, hardStop: true, spentUsd: spent, periodStart: span.start, periodEnd: span.end },
      saved: true,
    },
    {
      id: 'codex-kai@kaivalya.dev',
      label: 'kai@kaivalya.dev',
      vendor: 'openai',
      vendorName: 'ChatGPT',
      kind: 'subscription',
      credential: 'codex-kai@kaivalya.dev.json',
      email: 'kai@kaivalya.dev',
      plan: 'Pro',
      enabled: true,
      state: 'limited',
      detail: 'Weekly limit reached',
      until: now + 2 * D + 9 * H,
      windows: [w('5h', 18, now + 3 * H + 12 * MIN), w('7d', 100, now + 2 * D + 9 * H)],
      models: GPT,
      priority: 1,
      observedAt: now - 6 * MIN,
      saved: false,
      starter: on({ ...starterOff('gpt-6-luna'), enabled: true, state: 'paused', until: now + 2 * D + 9 * H, reason: 'Weekly limit used up' }),
    },
    { id: 'api-openai', label: 'OpenAI API key', vendor: 'openai', vendorName: 'ChatGPT', kind: 'api', provider: 'openai', plan: 'API key', enabled: true, state: 'ready', windows: [], models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini' }], saved: false },
    { id: 'api-google', label: 'Gemini API key', vendor: 'gemini', vendorName: 'Gemini', kind: 'api', provider: 'google', plan: 'API key', enabled: true, state: 'ready', windows: [], models: [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }, { id: 'gemini-3-flash', name: 'Gemini 3 Flash' }], saved: false },
  ];
}

const usable = (a: AccountDto) => a.enabled && (a.state === 'ready' || a.state === 'unknown');

export function registerAccounts(ctx: MockCtx) {
  const { on, emit, sleep, fail } = ctx;
  const accounts: AccountDto[] = ctx.FRESH ? [] : seed(Date.now());
  const order = new Map<string, string[]>();
  for (const a of accounts) order.set(a.vendor, [...(order.get(a.vendor) ?? []), a.id]);
  let refreshedAt = Date.now() - 40_000;

  const routes = (): AccountRouteDto[] => [...order.entries()].map(([vendor, ids]) => ({ vendor, vendorName: accounts.find((a) => a.vendor === vendor)?.vendorName ?? vendor, order: ids }));
  const now = (): AccountNowDto[] =>
    routes().map((r) => {
      const list = r.order.map((id) => accounts.find((a) => a.id === id)!);
      const pick = list.find(usable);
      const skipped = list.slice(0, pick ? list.indexOf(pick) : list.length).map((a) => ({ account: a.id, reason: a.enabled ? (a.detail ?? 'Not usable') : 'Paused' }));
      const window = pick?.windows.filter((x) => x.kind !== 'rate' && x.usedPercent !== undefined).sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
      const opens = list.filter((a) => a.until).map((a) => a.until!);
      return { vendor: r.vendor, vendorName: r.vendorName, ...(pick ? { account: pick.id } : {}), ...(window ? { window } : {}), skipped, ...(!pick && opens.length ? { until: Math.min(...opens) } : {}) };
    });
  let starterNoted = accounts.some((a) => a.starter?.enabled);
  const status = (): AccountsStatus => ({ accounts: structuredClone(accounts), routes: routes(), now: now(), refreshedAt, management: !ctx.FRESH, ...(starterNoted ? { starterNoted } : {}) });

  /** Per-account limit states for Usage, as the hub keeps them (provider:account). */
  const limitOf = (a: AccountDto): LimitState => ({
    provider: a.kind === 'api' ? (a.provider ?? a.vendor) : 'cliproxy',
    account: a.id,
    label: a.kind === 'subscription' ? `${a.vendorName} ${a.plan ?? 'plan'} · ${a.label}` : a.label,
    windows: a.windows,
    updatedAt: a.observedAt ?? Date.now() - 30_000,
    blocked: a.state === 'limited' || a.state === 'cooldown' || a.state === 'budget',
    source: a.windows.some((x) => x.source === 'oauth') ? 'oauth' : a.windows.every((x) => x.kind === 'budget') ? 'ledger' : 'headers',
    ...(a.starter?.enabled ? { starter: { state: a.starter.state, nextAt: a.starter.nextAt, startedAt: a.starter.startedAt, until: a.starter.until, reason: a.starter.reason } } : {}),
  });
  const syncLimits = () => {
    for (const a of accounts) {
      if (!a.windows.length) continue;
      const l = limitOf(a);
      ctx.db.limits.set(`${l.provider}:${a.id}`, l as never);
      emit({ type: 'limit.updated', limit: l });
    }
  };
  // the API key's windows now live in its account's state, as on the hub
  if (accounts.length) ctx.db.limits.delete('anthropic');
  syncLimits();

  const publish = () => {
    syncLimits();
    emit({ type: 'accounts.updated', status: status() });
  };

  const find = (id: string) => {
    const a = accounts.find((x) => x.id === decodeURIComponent(id));
    if (!a) fail(404, 'That account is not here any more. Reload the list.');
    return a!;
  };

  on('GET', '/api/accounts', () => status());

  on('POST', '/api/accounts/refresh', async () => {
    await sleep(700);
    refreshedAt = Date.now();
    for (const a of accounts) if (a.observedAt) a.observedAt = Date.now();
    publish();
    return status();
  });

  on('PUT', '/api/accounts/order', ({ body }) => {
    const b = (body ?? {}) as AccountOrderInput;
    const cur = order.get(b.vendor);
    if (!cur) fail(404, `No accounts for ${b.vendor}.`);
    const bad = (b.order ?? []).filter((id) => !cur!.includes(id));
    if (bad.length) fail(400, `Not an account of this vendor: ${bad.join(', ')}`);
    const next = [...new Set([...b.order, ...cur!])];
    order.set(b.vendor, next);
    const subs = next.map((id) => accounts.find((a) => a.id === id)!).filter((a) => a.kind === 'subscription');
    subs.forEach((a, i) => (a.priority = subs.length - i));
    publish();
    return status();
  });

  on('PATCH', '/api/accounts/:id', ({ params, body }) => {
    const a = find(params[0]);
    const p = (body ?? {}) as AccountPatch;
    if (typeof p.label === 'string') a.label = p.label.trim() || a.email || `${a.vendorName} API key`;
    if (typeof p.enabled === 'boolean') {
      a.enabled = p.enabled;
      if (!p.enabled) a.state = 'paused';
      else a.state = a.until && a.until > Date.now() ? (a.detail?.includes('limit') ? 'limited' : 'cooldown') : 'ready';
    }
    if (p.budget === null) {
      delete a.budget;
      a.windows = a.windows.filter((x) => x.kind !== 'budget');
    } else if (p.budget) {
      if (a.kind !== 'api') fail(400, 'Budgets are for API keys. A plan has its own limits.');
      if (!(Number(p.budget.usd) > 0)) fail(400, 'The budget must be more than $0.');
      const spent = a.budget?.spentUsd ?? 0;
      const span = budgetSpan(Date.now());
      a.budget = { ...p.budget, usd: Number(p.budget.usd), spentUsd: spent, periodStart: span.start, periodEnd: span.end };
      a.windows = [...a.windows.filter((x) => x.kind !== 'budget'), w('budget', Math.round((spent / a.budget.usd) * 1000) / 10, span.end, { limit: a.budget.usd, remaining: Math.max(0, a.budget.usd - spent) })];
    }
    if (p.refusal !== undefined) {
      if (typeof p.refusal !== 'boolean') fail(400, 'refusal must be true or false');
      // a marked plan must be reachable alone: the hub names one that has no short name
      if (p.refusal && a.kind === 'subscription' && !a.prefix) {
        if (ctx.FRESH) fail(409, "Using a plan when a model refuses needs a short name, and short names need CLIProxyAPI's management key. Add it in Subscriptions.");
        const taken = accounts.filter((x) => x.id !== a.id && x.prefix).map((x) => x.prefix!);
        a.prefix = suggestPrefixes([{ id: a.id, label: a.label, ...(a.email ? { email: a.email } : {}) }], taken).get(a.id);
      }
      if (p.refusal) a.refusal = true;
      else delete a.refusal;
    }
    if (p.starter === null) a.starter = a.starter ? starterOff(a.starter.autoModel ?? '') : undefined;
    else if (p.starter) {
      if (a.kind !== 'subscription' || !a.starter) fail(400, 'The window starter is for signed in plans. An API key has no 5 hour window.');
      const s = a.starter!;
      const t = p.starter;
      if (t.start !== undefined && t.end !== undefined && t.start === t.end) fail(400, 'The hours need a start and an end that differ.');
      if (t.model !== undefined) s.model = t.model || undefined;
      if (t.start !== undefined) s.start = t.start || '07:00';
      if (t.end !== undefined) s.end = t.end || '22:30';
      if (t.tz !== undefined) {
        s.tz = t.tz || undefined;
        s.zone = t.tz || ZONE;
      }
      if (typeof t.enabled === 'boolean') {
        s.enabled = t.enabled;
        if (t.enabled) starterNoted = true;
        // the next start: 3 s after the 5 hour reset ahead, else in a minute
        const reset = a.windows.find((x) => x.name === '5h')?.resetsAt;
        Object.assign(s, t.enabled ? { state: 'scheduled', nextAt: reset && reset > Date.now() ? reset + 3_000 : Date.now() + MIN } : { state: 'off', nextAt: undefined, until: undefined, reason: undefined });
      }
    }
    a.saved = true;
    publish();
    return status();
  });

  // a plan's short name: CLIProxyAPI's prefix, checked as the hub checks it
  on('PUT', '/api/accounts/:id/prefix', async ({ params, body }) => {
    const a = find(params[0]);
    const raw = (body as { prefix?: unknown } | undefined)?.prefix;
    if (typeof raw !== 'string') fail(400, 'prefix must be text. Empty removes the short name.');
    const name = (raw as string).trim();
    if (a.kind !== 'subscription') fail(400, 'A short name is for a signed in plan. An API key is picked by its own provider.');
    const problem = prefixProblem(
      name,
      accounts.filter((x) => x.id !== a.id && x.prefix).map((x) => x.prefix!),
    );
    if (problem) fail(problem.reason === 'taken' ? 409 : 400, problem.message);
    await sleep(500);
    if (name) a.prefix = name;
    else delete a.prefix;
    publish();
    return status();
  });

  on('POST', '/api/accounts/:id/try', async ({ params }) => {
    const a = find(params[0]);
    await sleep(400);
    if (a.kind === 'subscription' && (a.state === 'cooldown' || a.state === 'limited')) {
      a.state = 'ready';
      delete a.detail;
      delete a.until;
    }
    publish();
    return status();
  });
}
