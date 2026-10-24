/**
 * Accounts and their order (docs/research/2026-10-20-next-features.md 1).
 * Conclave decides, CLIProxyAPI executes.
 *
 * An account is a signed in plan (a CLIProxyAPI credential, by its name,
 * which survives restarts where auth_index may not) or a native provider
 * with an API key. models.accounts lists the owner's; any the hub finds
 * that are not listed join with defaults. models.routes holds the order per
 * vendor (optionally per model match); accounts left out of an order come
 * after it, subscriptions before API keys.
 *
 * The service:
 * - tells the registry which provider serves a vendor's model now
 *   (providersFor), so the subscription goes first and the API key last;
 * - names the account each call used (accountFor) for usage rows. For a
 *   CLIProxyAPI call this is inferred the way its session affinity binds:
 *   a session stays on its account until that account is blocked;
 * - keeps per-account windows as LimitStates (provider:account), the API
 *   budget from Conclave's own cost records with its reset day, and warns
 *   and stops at the budget;
 * - gives the server CLIProxyAPI priorities from the order.
 *
 * The cliproxy manager (server/src/cliproxy) feeds it the credentials,
 * their windows, cooldowns and models (setCliproxy).
 */
import type { AccountDto, AccountNowDto, AccountOrderInput, AccountPatch, AccountRouteDto, AccountsStatus, StarterDto } from '../client/accounts';
import type { ConfigStore } from '../config';
import type { AccountBudget, AccountConfig, AccountRoute, AccountStarter, ProviderConfig } from '../config/schema';
import type { Repos } from '../storage/repos';
import type { LimitState, LimitWindow, UsageRecord } from '../types';
import type { EventBus } from '../util/bus';
import { catalogEntries, familyForProvider, lookupModel } from '../providers/catalog';
import { budgetPeriod, hubZone, validZone, type Period } from './period';
import { assess, bareModel, orderIds, pickAccount, priorities, reaches, routeFor, usable, type AccountView, type Verdict } from './policy';
import { credentialVendor, vendorName, vendorOfModel } from './vendors';
import { splitAccount } from '../providers/split';
import { DEFAULT_END, DEFAULT_START, type StarterFacts } from './starter';
import { annotateWindow, limitKey, mergeWindows, windowOrder } from './windows';
import type { CyberProgram } from '../providers/access-programs';

/** One CLIProxyAPI credential as the cliproxy manager reads it. No tokens. */
export interface CliproxyCredentialFacts {
  /** The credential's file name: the stable key. */
  name: string;
  /** CLIProxyAPI's index for it, for api-call and cooldown reset. May change across its restarts. */
  authIndex?: string;
  /** claude, codex, antigravity... */
  provider: string;
  email?: string;
  label?: string;
  /** "Max 20x", "Pro", from the plan's profile endpoint. */
  plan?: string;
  prefix?: string;
  priority?: number;
  disabled: boolean;
  /** Signed out or failing, in words. */
  error?: string;
  /** Merged from the last response's signals and the usage endpoint. */
  windows: LimitWindow[];
  cooldowns: Array<{ model?: string; reason: string; until: number }>;
  /** Undefined until read. */
  models?: Array<{ id: string; name?: string }>;
  /** A ChatGPT plan approved for Daybreak: the programs whose alias its own model list has. */
  daybreak?: CyberProgram[];
  observedAt?: number;
}

export interface CliproxyFacts {
  /** The gateway provider id the models appear under. */
  provider: string;
  credentials: CliproxyCredentialFacts[];
  /** The management API answers. */
  management: boolean;
  refreshedAt?: number;
}

export interface AccountsDeps {
  config: ConfigStore;
  repos: Repos;
  bus: EventBus;
  now?: () => number;
  /** Tell the owner, for a budget warning. */
  notify?: (title: string, body: string) => void;
}

interface Acct {
  cfg: AccountConfig;
  saved: boolean;
  /** The provider that serves it: the gateway, or the native provider with the key. */
  provider: string;
  facts?: CliproxyCredentialFacts;
  /** api: the provider has a key. */
  hasKey: boolean;
}

const API_FAMILIES = new Set(['anthropic', 'openai', 'gemini', 'zai']);
/** How long a session keeps its inferred account without a call. */
const STICKY_MS = 6 * 3_600_000;
/** A 429 with no reset: treat the account as blocked this long, until the next read says more. */
const BLIND_BLOCK_MS = 60_000;

const API_PLAN = 'API key';

export class AccountsService {
  private cliproxy?: CliproxyFacts;
  /** Header windows of API accounts, by account id. */
  private observed = new Map<string, LimitWindow[]>();
  /** Blocks the hub saw itself (a 429), by account: until when, and when it was seen. */
  private blocked = new Map<string, { until: number; at: number }>();
  /** Budget spend by account:periodStart, cleared when a call is recorded. */
  private spent = new Map<string, number>();
  private sticky = new Map<string, { account: string; at: number }>();
  private hitListeners = new Set<(vendor: string) => void>();
  private changeListeners = new Set<() => void>();
  private lastEvent = '';
  private lastLimits = new Map<string, string>();
  private queued = false;
  private cache?: { at: number; accts: Acct[] };
  private offs: Array<() => void> = [];
  /** The window starter's view of a plan (accounts/starter.ts), when one runs. */
  private starterView?: { view: (f: StarterFacts, all: StarterFacts[]) => StarterDto; noted: () => boolean; onEnable: () => void };
  /** Reads one account again now (the cliproxy manager). */
  private reader?: (id: string, opts: { usage?: boolean }) => Promise<void>;

  constructor(private readonly deps: AccountsDeps) {
    // header windows of API accounts survive a restart
    for (const l of deps.repos.usage.limits()) {
      if (l.account && l.account.startsWith('api-')) this.observed.set(l.account, l.windows.filter((w) => w.kind !== 'budget' && w.name !== 'budget'));
    }
    this.offs.push(deps.config.onChange(() => this.changed()));
    this.offs.push(
      deps.bus.on((e) => {
        if (e.type === 'usage.recorded' && e.record.account) this.afterUsage(e.record);
        // a key plan's reader stored new windows: its account shows them
        else if (e.type === 'limit.updated' && !e.limit.account && this.deps.config.get().providers?.[e.limit.provider]?.subscription) this.changed();
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  private configured(): AccountConfig[] {
    const list = this.deps.config.get().models?.accounts;
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string' && a.id && (a.kind === 'subscription' || a.kind === 'api')) : [];
  }

  private routes(): AccountRoute[] {
    const r = this.deps.config.get().models?.routes;
    return Array.isArray(r) ? r : [];
  }

  /** Native providers with a key that serve a vendor's models directly: API accounts. */
  private apiProviders(): Array<{ id: string; vendor: string; cfg: ProviderConfig }> {
    const out: Array<{ id: string; vendor: string; cfg: ProviderConfig }> = [];
    for (const [id, cfg] of Object.entries(this.deps.config.get().providers ?? {})) {
      // a provider with cfg.subscription (the Z.ai Coding Plan) is a plan paid with a key: still an API account, so routing stays as it was
      if (!cfg || cfg.type === 'acp' || cfg.anthropicWire || cfg.enabled === false) continue;
      const fam = familyForProvider(cfg.type, cfg.baseUrl ? this.deps.config.expand(cfg.baseUrl) : undefined);
      if (!fam || fam === 'any' || !API_FAMILIES.has(fam)) continue;
      if (!this.deps.config.hasProviderKey(id)) continue;
      out.push({ id, vendor: fam, cfg });
    }
    return out;
  }

  /** Saved accounts in config order, then the ones the hub found. */
  private accts(): Acct[] {
    const now = this.now();
    if (this.cache && now - this.cache.at < 1500) return this.cache.accts;
    const gateway = this.cliproxy?.provider ?? 'cliproxy';
    const creds = this.cliproxy?.credentials ?? [];
    const out: Acct[] = [];
    const seenCred = new Set<string>();
    const seenProvider = new Set<string>();
    for (const cfg of this.configured()) {
      if (cfg.kind === 'subscription') {
        const facts = creds.find((c) => c.name === cfg.credential);
        if (cfg.credential) seenCred.add(cfg.credential);
        out.push({ cfg, saved: true, provider: gateway, facts, hasKey: true });
      } else {
        const provider = cfg.provider ?? cfg.vendor;
        seenProvider.add(provider);
        out.push({ cfg, saved: true, provider, hasKey: this.deps.config.hasProviderKey(provider) });
      }
    }
    // found accounts by vendor, then name, as CLIProxyAPI lists them
    const found = [...creds].sort((a, b) => credentialVendor(a.provider).localeCompare(credentialVendor(b.provider)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const c of found) {
      if (seenCred.has(c.name)) continue;
      out.push({ cfg: { id: c.name.replace(/\.json$/i, ''), vendor: credentialVendor(c.provider), kind: 'subscription', credential: c.name }, saved: false, provider: gateway, facts: c, hasKey: true });
    }
    for (const p of this.apiProviders()) {
      if (seenProvider.has(p.id)) continue;
      out.push({ cfg: { id: `api-${p.id}`, vendor: p.vendor, kind: 'api', provider: p.id }, saved: false, provider: p.id, hasKey: true });
    }
    // two saved entries with one id: the first wins
    const ids = new Set<string>();
    const list = out.filter((a) => (ids.has(a.cfg.id) ? false : (ids.add(a.cfg.id), true)));
    this.cache = { at: now, accts: list };
    return list;
  }

  private changed(): void {
    this.cache = undefined;
    this.publishSoon();
  }

  private budgetOf(a: Acct, now: number): (AccountBudget & { spentUsd: number; span: Period }) | undefined {
    const b = a.cfg.budget;
    if (!b || !(b.usd > 0)) return undefined;
    const span = budgetPeriod(b, now);
    // the registry asks on every resolve: one sum per account and period until the next call is recorded
    const key = `${a.cfg.id}:${span.start}`;
    let spentUsd = this.spent.get(key);
    if (spentUsd === undefined) {
      spentUsd = this.deps.repos.usage.spend(a.cfg.id, span.start, span.end);
      this.spent.set(key, spentUsd);
    }
    return { ...b, spentUsd, span };
  }

  private budgetWindow(b: AccountBudget & { spentUsd: number; span: Period }, now: number): LimitWindow {
    return {
      name: 'budget',
      kind: 'budget',
      usedPercent: Math.round(Math.min(100, (b.spentUsd / b.usd) * 100) * 10) / 10,
      limit: b.usd,
      remaining: Math.max(0, Math.round((b.usd - b.spentUsd) * 100) / 100),
      resetsAt: b.span.end,
      windowMs: b.span.end - b.span.start,
      source: 'ledger',
      observedAt: now,
    };
  }

  private windowsOf(a: Acct, now: number): LimitWindow[] {
    // a window whose reset passed says nothing any more: unknown until the next read, not full and not zero
    const own = a.cfg.kind === 'subscription' ? (a.facts?.windows ?? []) : (this.observed.get(a.cfg.id) ?? []);
    // a key plan's 5 hour and weekly windows come from its usage reader (usage/readers/zai.ts), stored for the provider
    // its MCP tool quota does not stop coding calls: extra, as the reader's blocked says
    const read = this.keyPlan(a) ? (this.deps.repos.usage.limits().find((l) => l.provider === a.provider && !l.account)?.windows ?? []).map((w) => (w.name === 'MCP monthly' ? { ...w, kind: 'extra' as const } : w)) : [];
    const base = (read.length ? mergeWindows(read, own) : own).filter((w) => w.resetsAt === undefined || w.resetsAt > now);
    const b = this.budgetOf(a, now);
    const all = b ? [...base.filter((w) => w.name !== 'budget'), this.budgetWindow(b, now)] : base;
    return all.map((w) => annotateWindow(w)).sort((x, y) => windowOrder(x) - windowOrder(y));
  }

  /** The subscription an API account's key bills against (zai-coding), from its provider. */
  private keyPlan(a: Acct): string | undefined {
    return a.cfg.kind === 'api' ? this.deps.config.get().providers?.[a.provider]?.subscription : undefined;
  }

  private errorOf(a: Acct): string | undefined {
    if (a.cfg.kind === 'api') return a.hasKey ? undefined : 'No API key';
    if (!this.cliproxy) return 'Subscriptions are off';
    if (!a.facts) return this.cliproxy.management ? 'Not signed in' : undefined;
    return a.facts.error;
  }

  private view(a: Acct, now: number): AccountView {
    const b = this.budgetOf(a, now);
    return {
      id: a.cfg.id,
      kind: a.cfg.kind,
      enabled: a.cfg.enabled !== false && !a.facts?.disabled,
      error: this.errorOf(a),
      windows: this.windowsOf(a, now),
      cooldowns: a.facts?.cooldowns ?? [],
      ...(a.cfg.kind === 'subscription' && a.facts?.models ? { models: a.facts.models.map((m) => m.id) } : {}),
      ...(b ? { budget: { usd: b.usd, spentUsd: b.spentUsd, periodEnd: b.span.end, hardStop: b.hardStop } } : {}),
      ...(this.blocked.get(a.cfg.id) ? { blockedUntil: this.blocked.get(a.cfg.id)!.until } : {}),
    };
  }

  private forVendor(vendor: string, model?: string): Acct[] {
    return this.ordered(vendor, routeFor(this.routes(), vendor, model)?.order);
  }

  private ordered(vendor: string, order?: string[]): Acct[] {
    const all = this.accts().filter((a) => a.cfg.vendor === vendor);
    const ids = orderIds(
      all.map((a) => ({ id: a.cfg.id, kind: a.cfg.kind })),
      order,
    );
    return ids.map((id) => all.find((a) => a.cfg.id === id)!);
  }

  private label(a: Acct, all: Acct[]): string {
    if (a.cfg.label) return a.cfg.label;
    if (a.cfg.kind === 'api') {
      const name = this.deps.config.get().providers?.[a.provider]?.name;
      return this.keyPlan(a) && name ? name : `${name ?? vendorName(a.cfg.vendor)} API key`;
    }
    if (a.facts?.email) return a.facts.email;
    if (a.facts?.label && !/ user$/i.test(a.facts.label)) return a.facts.label;
    const subs = all.filter((x) => x.cfg.vendor === a.cfg.vendor && x.cfg.kind === 'subscription');
    return `${vendorName(a.cfg.vendor)} ${subs.indexOf(a) + 1}`;
  }

  private models(a: Acct): Array<{ id: string; name: string }> {
    if (a.cfg.kind === 'subscription') return (a.facts?.models ?? []).map((m) => ({ id: m.id, name: m.name || lookupModel(a.provider, bareModel(m.id)).name }));
    const listed = this.deps.config.get().providers?.[a.provider]?.models;
    const ids = listed?.length ? listed : catalogEntries(a.cfg.vendor as never).map((e) => e.id);
    return ids.map((id) => ({ id, name: lookupModel(a.provider, id).name }));
  }

  private dto(a: Acct, v: Verdict, view: AccountView, all: Acct[], now: number, starter?: StarterDto): AccountDto {
    const b = this.budgetOf(a, now);
    const f = a.facts;
    return {
      id: a.cfg.id,
      label: this.label(a, all),
      vendor: a.cfg.vendor,
      vendorName: vendorName(a.cfg.vendor),
      kind: a.cfg.kind,
      ...(a.cfg.credential ? { credential: a.cfg.credential } : {}),
      ...(a.cfg.kind === 'api' ? { provider: a.provider } : {}),
      ...(f?.email ? { email: f.email } : {}),
      ...(this.keyPlan(a) ? { plan: this.deps.config.get().providers?.[a.provider]?.name ?? API_PLAN, subscription: this.keyPlan(a) } : a.cfg.kind === 'api' ? { plan: API_PLAN } : f?.plan ? { plan: f.plan } : {}),
      enabled: view.enabled,
      state: v.state,
      ...(v.reason && v.state !== 'ready' && v.state !== 'unknown' ? { detail: v.reason } : {}),
      ...(v.until ? { until: v.until } : {}),
      windows: view.windows,
      models: this.models(a),
      ...(f?.prefix ? { prefix: f.prefix } : {}),
      ...(a.cfg.refusal ? { refusal: true } : {}),
      ...(f?.priority !== undefined ? { priority: f.priority } : {}),
      ...(b ? { budget: { usd: b.usd, period: b.period, resetDay: b.resetDay, resetHour: b.resetHour, tz: b.tz, warnAt: b.warnAt, hardStop: b.hardStop, spentUsd: Math.round(b.spentUsd * 1e4) / 1e4, periodStart: b.span.start, periodEnd: b.span.end } as AccountDto['budget'] } : {}),
      ...(f?.cooldowns?.length ? { cooldowns: f.cooldowns.filter((c) => c.until > now) } : {}),
      ...(f?.observedAt ? { observedAt: f.observedAt } : {}),
      saved: a.saved,
      ...(starter ? { starter } : {}),
    };
  }

  /** Each signed in plan as the window starter sees it: its windows as last read (also ones whose reset passed), cooldowns, models and prefix. No tokens. */
  starterFacts(all: Acct[] = this.accts()): StarterFacts[] {
    return all
      .filter((a) => a.cfg.kind === 'subscription')
      .map((a) => ({
        id: a.cfg.id,
        label: this.label(a, all),
        vendor: a.cfg.vendor,
        provider: a.provider,
        enabled: a.cfg.enabled !== false && !!a.facts && !a.facts.disabled,
        disabled: !a.facts || a.facts.disabled,
        ...(this.errorOf(a) ? { error: this.errorOf(a) } : {}),
        windows: (a.facts?.windows ?? []).map((w) => annotateWindow(w)),
        cooldowns: a.facts?.cooldowns ?? [],
        ...(a.facts?.models ? { models: a.facts.models.map((m) => m.id) } : {}),
        ...(a.facts?.prefix ? { prefix: a.facts.prefix } : {}),
        ...(a.cfg.starter ? { starter: a.cfg.starter } : {}),
      }));
  }

  private starterOf(a: Acct, facts: StarterFacts[]): StarterDto | undefined {
    if (a.cfg.kind !== 'subscription') return undefined;
    const f = facts.find((x) => x.id === a.cfg.id);
    if (f && this.starterView) return this.starterView.view(f, facts);
    // no starter runs (a server over another engine): the settings, and off or waiting
    const c = a.cfg.starter ?? {};
    return { enabled: !!c.enabled, ...(c.model ? { model: c.model } : {}), start: c.start ?? DEFAULT_START, end: c.end ?? DEFAULT_END, ...(c.tz ? { tz: c.tz } : {}), zone: validZone(c.tz) ?? hubZone(), state: c.enabled ? 'waiting' : 'off' };
  }

  /** The window starter shows itself on each plan through this (accounts/starter.ts). */
  setStarterView(v: { view: (f: StarterFacts, all: StarterFacts[]) => StarterDto; noted: () => boolean; onEnable: () => void } | undefined): void {
    this.starterView = v;
    this.changed();
  }

  /** The cliproxy manager reads one account again on request (the window starter, around a reset). */
  setReader(fn: ((id: string, opts: { usage?: boolean }) => Promise<void>) | undefined): void {
    this.reader = fn;
  }

  /** Read an account's headers again now, and its plan usage when asked. Nothing when no reader is set. */
  async readNow(id: string, opts: { usage?: boolean } = {}): Promise<void> {
    await this.reader?.(id, opts);
  }

  /** Something the page shows changed outside the service (the window starter): publish again. */
  refreshView(): void {
    this.changed();
  }

  /** Everything the Accounts page shows. */
  status(): AccountsStatus {
    const now = this.now();
    const all = this.accts();
    const views = new Map(all.map((a) => [a.cfg.id, this.view(a, now)]));
    const starters = all.some((a) => a.cfg.kind === 'subscription') ? this.starterFacts(all) : [];
    const accounts = all.map((a) => this.dto(a, assess(views.get(a.cfg.id)!, now), views.get(a.cfg.id)!, all, now, this.starterOf(a, starters)));
    const vendors = [...new Set(all.map((a) => a.cfg.vendor))];
    const routes: AccountRouteDto[] = vendors.map((vendor) => ({ vendor, vendorName: vendorName(vendor), order: this.forVendor(vendor).map((a) => a.cfg.id) }));
    for (const r of this.routes()) {
      if (r.match && vendors.includes(r.vendor)) routes.push({ vendor: r.vendor, vendorName: vendorName(r.vendor), match: r.match, order: this.ordered(r.vendor, r.order).map((a) => a.cfg.id) });
    }
    const nowDtos: AccountNowDto[] = vendors.map((vendor) => {
      const ordered = this.forVendor(vendor);
      const pick = pickAccount(
        ordered.map((a) => views.get(a.cfg.id)!),
        now,
      );
      const chosen = pick.account ? pick.verdicts.find((x) => x.id === pick.account) : undefined;
      return { vendor, vendorName: vendorName(vendor), ...(pick.account ? { account: pick.account } : {}), ...(chosen?.window ? { window: chosen.window } : {}), skipped: pick.skipped, ...(pick.until ? { until: pick.until } : {}) };
    });
    return { accounts, routes, now: nowDtos, ...(this.cliproxy?.refreshedAt ? { refreshedAt: this.cliproxy.refreshedAt } : {}), management: !!this.cliproxy?.management, ...(this.starterView?.noted() ? { starterNoted: true } : {}) };
  }

  // -------------------------------------------------------------------------
  // What the registry, the stream and the server ask
  // -------------------------------------------------------------------------

  /** The gateway's provider id while CLIProxyAPI answers. */
  get gateway(): string | undefined {
    return this.cliproxy?.provider;
  }

  /** True when a provider's windows belong to its accounts (the gateway), so header windows are not stored for the provider as a whole. */
  hasAccounts(provider: string): boolean {
    return !!this.cliproxy && provider === this.cliproxy.provider && this.cliproxy.credentials.length > 0;
  }

  private ranked(model: string, skip?: string): { ready: Acct[]; blocked: Acct[] } {
    const vendor = vendorOfModel(model);
    const ready: Acct[] = [];
    const blocked: Acct[] = [];
    if (!vendor) return { ready, blocked };
    const now = this.now();
    for (const a of this.forVendor(vendor, model)) {
      if (a.provider === skip) continue;
      const view = this.view(a, now);
      // a credential with a prefix serves bare ids too (CLIProxyAPI's force-model-prefix is off)
      if (!view.enabled || !reaches(view, model)) continue;
      (usable(assess(view, now, model)) ? ready : blocked).push(a);
    }
    return { ready, blocked };
  }

  /**
   * Provider ids for a model in the owner's order: those with a usable
   * account first, then the blocked ones (so an error still names the first).
   * Undefined when no order applies: no subscription account for its vendor,
   * or an id with an account prefix ("neu/claude-opus-5-5" names one account).
   */
  providersFor(model: string): string[] | undefined {
    if (model.includes('/')) return undefined;
    const vendor = vendorOfModel(model);
    if (!vendor || !this.accts().some((a) => a.cfg.vendor === vendor && a.cfg.kind === 'subscription')) return undefined;
    const { ready, blocked } = this.ranked(model);
    const list = [...new Set([...ready, ...blocked].map((a) => a.provider))];
    return list.length ? list : undefined;
  }

  /**
   * The owner's order for a model as the pickers say it (providers/merge.ts):
   * each account that is on, signed in and offers the model, first tried
   * first. Unlike providersFor it keeps a blocked plan in its place, so the
   * words do not move while it waits for its reset. Undefined when no order
   * applies (as providersFor).
   */
  routeOf(model: string): Array<{ provider: string; kind: 'subscription' | 'api' }> | undefined {
    if (model.includes('/')) return undefined;
    const vendor = vendorOfModel(model);
    if (!vendor || !this.accts().some((a) => a.cfg.vendor === vendor && a.cfg.kind === 'subscription')) return undefined;
    const now = this.now();
    const steps = this.forVendor(vendor, model)
      .filter((a) => {
        const v = this.view(a, now);
        return v.enabled && !v.error && reaches(v, model);
      })
      .map((a) => ({ provider: a.provider, kind: a.cfg.kind }));
    return steps.length ? steps : undefined;
  }

  /**
   * The vendor of a plan whose own list has this model, account prefix
   * ignored: for an id no catalog or name places (a new model only a
   * ChatGPT plan lists), so pickers file it under its maker. Undefined when no plan lists it.
   */
  listedVendor(model: string): string | undefined {
    const want = bareModel(model).toLowerCase();
    return this.accts().find((a) => a.cfg.kind === 'subscription' && a.facts?.models?.some((m) => bareModel(m.id).toLowerCase() === want))?.cfg.vendor;
  }

  /**
   * The plans and keys marked "Use when a model refuses" that can take this
   * model now, in the owner's order for it: on, signed in, not at a limit or
   * resting, and offering the model. A refused reply is tried on these first,
   * same model (session/refusal-fallback.ts). An account prefix on the model
   * is ignored.
   */
  refusalAccounts(model: string): AccountDto[] {
    return this.readyAccounts(model).filter((a) => a.refusal);
  }

  /**
   * Every plan and key that can take this model now, in the owner's order
   * for it: on, signed in, not at a limit or resting, and offering the
   * model. An account prefix on the model is ignored.
   */
  readyAccounts(model: string): AccountDto[] {
    const bare = bareModel(model);
    const vendor = vendorOfModel(bare);
    if (!vendor) return [];
    const now = this.now();
    const all = this.accts();
    const out: AccountDto[] = [];
    for (const a of this.forVendor(vendor, bare)) {
      const view = this.view(a, now);
      if (!view.enabled || view.error || !reaches(view, bare)) continue;
      const v = assess(view, now, bare);
      if (!usable(v)) continue;
      out.push(this.dto(a, v, view, all, now));
    }
    return out;
  }

  /** After a provider refused a call: the next provider in the order with a usable account. */
  fallbackFor(provider: string, model: string, tried: Set<string> = new Set()): string | undefined {
    if (model.includes('/')) return undefined;
    const vendor = vendorOfModel(model);
    if (!vendor || !this.accts().some((a) => a.cfg.vendor === vendor && a.cfg.kind === 'subscription')) return undefined;
    return this.ranked(model, provider).ready.map((a) => a.provider).find((p) => p !== provider && !tried.has(p));
  }

  /**
   * The account a call on this provider and model used. A native provider's
   * API account; for the gateway, the account a prefix names, else the one
   * the session is bound to (inferred: the first usable in the order, kept
   * until it is blocked, as CLIProxyAPI's session affinity does).
   */
  accountFor(provider: string, model: string, sessionId?: string): string | undefined {
    const all = this.accts();
    const api = all.find((a) => a.cfg.kind === 'api' && a.provider === provider);
    if (api) return api.cfg.id;
    if (!this.cliproxy || provider !== this.cliproxy.provider) return undefined;
    const i = model.lastIndexOf('/');
    if (i > 0) {
      const prefix = model.slice(0, i);
      return all.find((a) => a.facts?.prefix === prefix)?.cfg.id;
    }
    const vendor = vendorOfModel(model);
    if (!vendor) return undefined;
    const now = this.now();
    const subs = this.forVendor(vendor, model).filter((a) => a.cfg.kind === 'subscription');
    if (!subs.length) return undefined;
    const views = subs.map((a) => this.view(a, now));
    const held = sessionId ? this.sticky.get(sessionId) : undefined;
    if (held) {
      const v = views.find((x) => x.id === held.account);
      if (v && usable(assess(v, now, model)) && reaches(v, model)) {
        held.at = now;
        return held.account;
      }
    }
    const pick = pickAccount(views, now, model);
    const chosen = pick.account ?? subs[0].cfg.id;
    if (sessionId) {
      this.sticky.set(sessionId, { account: chosen, at: now });
      if (this.sticky.size > 500) for (const [k, s] of this.sticky) if (now - s.at > STICKY_MS) this.sticky.delete(k);
    }
    return chosen;
  }

  /** An API account whose budget is spent and stops calls: what to say and when it resets. */
  budgetStop(provider: string): { account: string; label: string; usd: number; until: number } | undefined {
    const all = this.accts();
    const a = all.find((x) => x.cfg.kind === 'api' && x.provider === provider);
    if (!a) return undefined;
    const b = this.budgetOf(a, this.now());
    if (!b || b.hardStop === false || b.spentUsd < b.usd) return undefined;
    return { account: a.cfg.id, label: this.label(a, all), usd: b.usd, until: b.span.end };
  }

  /**
   * A provider refused a call for its limit or a spend cap. The gateway's
   * accounts for the model's vendor are blocked until the reset (CLIProxyAPI
   * already tried each before it said 429); an API account until the reset,
   * or its budget period's end for a spend cap. Listeners (the cliproxy
   * manager) read the accounts again right away.
   */
  noteLimit(provider: string, model: string, info: { resetAt?: number; spendCap?: boolean } = {}): void {
    const now = this.now();
    const vendor = vendorOfModel(model);
    const all = this.accts();
    if (this.cliproxy && provider === this.cliproxy.provider) {
      const until = Math.max(info.resetAt ?? 0, now + BLIND_BLOCK_MS);
      // a prefixed id ("neu/gpt-6-sol") went to that one plan only: the others were not tried
      const prefix = splitAccount(model).account;
      for (const a of all) if (a.cfg.kind === 'subscription' && a.cfg.vendor === vendor && (prefix ? a.facts?.prefix === prefix : reaches(this.view(a, now), model))) this.blocked.set(a.cfg.id, { until, at: now });
    } else {
      const a = all.find((x) => x.cfg.kind === 'api' && x.provider === provider);
      if (a) {
        const b = this.budgetOf(a, now);
        const until = info.resetAt ?? (info.spendCap ? (b?.span.end ?? now + 3_600_000) : now + BLIND_BLOCK_MS);
        this.blocked.set(a.cfg.id, { until, at: now });
      }
    }
    if (vendor) for (const fn of this.hitListeners) fn(vendor);
    this.changed();
  }

  /** Forget the block the hub guessed from a 429 ("Try now"). */
  clearBlock(id: string): void {
    if (this.blocked.delete(id)) this.changed();
  }

  /** Header windows from a native provider's response, for its API account. */
  observeHeaders(provider: string, windows: LimitWindow[]): boolean {
    const a = this.accts().find((x) => x.cfg.kind === 'api' && x.provider === provider);
    if (!a || !windows.length) return false;
    const now = this.now();
    this.observed.set(a.cfg.id, mergeWindows(this.observed.get(a.cfg.id) ?? [], windows.map((w) => annotateWindow(w, { source: 'headers', observedAt: now }))));
    this.changed();
    return true;
  }

  /** The credentials, their windows and models, from the cliproxy manager. Undefined when CLIProxyAPI is off. */
  setCliproxy(facts: CliproxyFacts | undefined): void {
    const before = JSON.stringify(this.cliproxy ?? null);
    this.cliproxy = facts;
    this.cache = undefined;
    // a read made after a 429 replaces the block the hub guessed from it: CLIProxyAPI's cooldowns say the rest
    if (facts?.refreshedAt) {
      for (const a of this.accts()) {
        const b = this.blocked.get(a.cfg.id);
        if (b && a.facts && b.at <= facts.refreshedAt) this.blocked.delete(a.cfg.id);
      }
    }
    if (JSON.stringify(facts ?? null) !== before) this.changed();
  }

  /** The priority each subscription credential should have in CLIProxyAPI, from each vendor's default order. */
  credentialPriorities(): Map<string, number> {
    const out = new Map<string, number>();
    const vendors = [...new Set(this.accts().map((a) => a.cfg.vendor))];
    for (const vendor of vendors) {
      const creds = this.forVendor(vendor)
        .filter((a) => a.cfg.kind === 'subscription' && a.cfg.credential && a.facts)
        .map((a) => a.cfg.credential!);
      for (const [name, p] of priorities(creds)) out.set(name, p);
    }
    return out;
  }

  /** The owner has set an order (models.routes). */
  ownerOrdered(): boolean {
    return this.routes().some((r) => Array.isArray(r.order) && r.order.length > 0);
  }

  /** The credential name and auth_index of an account, for the server's calls to CLIProxyAPI. */
  credentialOf(id: string): CliproxyCredentialFacts | undefined {
    return this.accts().find((a) => a.cfg.id === id)?.facts;
  }

  account(id: string): AccountDto | undefined {
    return this.status().accounts.find((a) => a.id === id);
  }

  /** A provider refused a call: the listener reads the accounts again. Returns the unsubscribe. */
  onLimitHit(fn: (vendor: string) => void): () => void {
    this.hitListeners.add(fn);
    return () => this.hitListeners.delete(fn);
  }

  /** The list or the order changed (the cliproxy manager writes priorities). */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  // -------------------------------------------------------------------------
  // Owner changes: written to models.accounts and models.routes
  // -------------------------------------------------------------------------

  private save(edit: (accounts: AccountConfig[], routes: AccountRoute[]) => void): void {
    // every account the page shows is saved, so its id and place stay put
    const accounts: AccountConfig[] = this.accts().map((a) => structuredClone(a.cfg));
    const routes: AccountRoute[] = structuredClone(this.routes());
    edit(accounts, routes);
    const user = structuredClone(this.deps.config.getUser()) as Record<string, any>;
    user.models = { ...(user.models ?? {}), accounts, routes };
    this.deps.config.replace(user);
    this.cache = undefined;
  }

  setOrder(input: AccountOrderInput): AccountsStatus {
    const all = this.accts();
    if (typeof input?.vendor !== 'string' || !Array.isArray(input.order)) throw new AccountsError(400, 'vendor and order are required');
    const mine = all.filter((a) => a.cfg.vendor === input.vendor);
    if (!mine.length) throw new AccountsError(404, `No accounts for ${input.vendor}.`);
    const unknown = input.order.filter((id) => typeof id !== 'string' || !mine.some((a) => a.cfg.id === id));
    if (unknown.length) throw new AccountsError(400, `Not an account of ${vendorName(input.vendor)}: ${unknown.join(', ')}`);
    const match = typeof input.match === 'string' && input.match.trim() ? input.match.trim() : undefined;
    this.save((_, routes) => {
      const i = routes.findIndex((r) => r.vendor === input.vendor && (r.match ?? undefined) === match);
      const next: AccountRoute = { vendor: input.vendor, ...(match ? { match } : {}), order: [...new Set(input.order)] };
      if (i >= 0) routes[i] = next;
      else routes.push(next);
    });
    this.changed();
    return this.status();
  }

  patch(id: string, p: AccountPatch): AccountsStatus {
    if (!this.accts().some((a) => a.cfg.id === id)) throw new AccountsError(404, 'That account is not here any more. Reload the list.');
    if (p.label !== undefined && typeof p.label !== 'string') throw new AccountsError(400, 'label must be text');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new AccountsError(400, 'enabled must be true or false');
    if (p.refusal !== undefined && typeof p.refusal !== 'boolean') throw new AccountsError(400, 'refusal must be true or false');
    const budget = p.budget === undefined || p.budget === null ? p.budget : checkBudget(p.budget);
    const starter = p.starter === undefined || p.starter === null ? p.starter : checkStarter(p.starter);
    let starterOn = false;
    this.save((accounts) => {
      const a = accounts.find((x) => x.id === id)!;
      if (p.label !== undefined) {
        const label = p.label.trim().slice(0, 60);
        if (label) a.label = label;
        else delete a.label;
      }
      if (p.enabled !== undefined) {
        if (p.enabled) delete a.enabled;
        else a.enabled = false;
      }
      if (p.refusal !== undefined) {
        if (p.refusal) a.refusal = true;
        else delete a.refusal;
      }
      if (budget === null) delete a.budget;
      else if (budget) {
        if (a.kind !== 'api') throw new AccountsError(400, 'Budgets are for API keys. A plan has its own limits.');
        a.budget = budget;
      }
      if (starter === null) delete a.starter;
      else if (starter) {
        if (a.kind !== 'subscription') throw new AccountsError(400, 'The window starter is for signed in plans. An API key has no 5 hour window.');
        const next: AccountStarter = { ...(a.starter ?? {}) };
        for (const [k, v] of Object.entries(starter) as Array<[keyof AccountStarter, unknown]>) {
          if (v === '') delete next[k];
          else (next as Record<string, unknown>)[k] = v;
        }
        if (next.enabled === false) delete next.enabled;
        if ((next.start ?? DEFAULT_START) === (next.end ?? DEFAULT_END)) throw new AccountsError(400, 'The hours need a start and an end that differ.');
        if (Object.keys(next).length) a.starter = next;
        else delete a.starter;
        starterOn = !!next.enabled;
      }
    });
    if (starterOn) this.starterView?.onEnable();
    this.changed();
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Budget warnings, limit states and events
  // -------------------------------------------------------------------------

  private afterUsage(r: UsageRecord): void {
    this.cache = undefined;
    this.spent.clear();
    const all = this.accts();
    const a = all.find((x) => x.cfg.id === r.account);
    if (a?.cfg.budget) {
      const now = this.now();
      const b = this.budgetOf(a, now);
      if (b) {
        const pct = (b.spentUsd / b.usd) * 100;
        const warnAt = typeof b.warnAt === 'number' && b.warnAt > 0 ? b.warnAt : 80;
        const label = this.label(a, all);
        const resets = new Date(b.span.end).toLocaleString();
        const kv = this.deps.repos.kv;
        if (pct >= 100 && kv.get<number>(`accounts.budgetSpent.${a.cfg.id}`, 0) !== b.span.start) {
          kv.set(`accounts.budgetSpent.${a.cfg.id}`, b.span.start);
          this.deps.notify?.(`${label}: budget spent`, `$${b.spentUsd.toFixed(2)} of $${b.usd}. ${b.hardStop === false ? 'Calls go on.' : 'Calls on it stop'} until it resets ${resets}.`);
        } else if (pct >= warnAt && pct < 100 && kv.get<number>(`accounts.budgetWarned.${a.cfg.id}`, 0) !== b.span.start) {
          kv.set(`accounts.budgetWarned.${a.cfg.id}`, b.span.start);
          this.deps.notify?.(`${label}: ${Math.floor(pct)}% of the budget used`, `$${b.spentUsd.toFixed(2)} of $${b.usd}. It resets ${resets}.`);
        }
      }
    }
    this.publishSoon();
  }

  private publishSoon(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      try {
        this.publish();
      } catch {
        /* a broken config must not break the caller */
      }
    });
  }

  /** Per-account limit states (provider:account) and one accounts.updated event when something changed. */
  publish(): void {
    const now = this.now();
    const status = this.status();
    const all = this.accts();
    const live = new Set<string>();
    for (const d of status.accounts) {
      const a = all.find((x) => x.cfg.id === d.id)!;
      // a key plan's windows are already stored for its provider by the usage reader: one state, not two; a 429 marks that one blocked, with the reset when known
      if (d.subscription) {
        const r = this.deps.repos.usage.limits().find((l) => l.provider === a.provider && !l.account);
        const blocked = d.state === 'limited';
        if (r && !!r.blocked !== blocked) {
          const next: LimitState = { ...r, blocked, ...(blocked ? { windows: d.windows } : {}) };
          this.deps.repos.usage.setLimit(next);
          this.deps.bus.emit({ type: 'limit.updated', limit: next });
        }
        continue;
      }
      if (!d.windows.length) continue;
      const l: LimitState = {
        provider: a.provider,
        account: d.id,
        // "Claude Max 20x · Account 2", "Claude API key": the vendor first, as plan labels read
        label: d.kind === 'subscription' ? `${d.vendorName} ${d.plan ?? 'plan'} · ${d.label}` : d.label.startsWith(d.vendorName) ? d.label : `${d.vendorName} API · ${d.label}`,
        windows: d.windows,
        updatedAt: d.observedAt ?? now,
        blocked: d.state === 'limited' || d.state === 'cooldown' || d.state === 'budget',
        source: d.windows.some((w) => w.source === 'oauth') ? 'oauth' : d.kind === 'api' && d.windows.every((w) => w.kind === 'budget') ? 'ledger' : 'headers',
        // the window starter's line, for clients that show limits only (Android's Usage)
        ...(d.starter?.enabled ? { starter: { state: d.starter.state, ...pick(d.starter, ['nextAt', 'startedAt', 'until', 'reason']) } } : {}),
      };
      const key = limitKey(l);
      live.add(key);
      const sig = JSON.stringify({ ...l, updatedAt: 0, windows: l.windows.map((w) => ({ ...w, observedAt: 0 })) });
      if (this.lastLimits.get(key) === sig) continue;
      this.lastLimits.set(key, sig);
      this.deps.repos.usage.setLimit(l);
      this.deps.bus.emit({ type: 'limit.updated', limit: l });
    }
    // states of accounts that left, and the old shared state of a provider whose accounts now hold its windows, go
    const apiProviders = new Set(all.filter((a) => a.cfg.kind === 'api' && !this.keyPlan(a)).map((a) => a.provider));
    for (const l of this.deps.repos.usage.limits()) {
      const key = limitKey(l);
      const stale = (l.account && !live.has(key)) || (!l.account && (this.hasAccounts(l.provider) || apiProviders.has(l.provider)));
      if (stale && this.deps.repos.usage.deleteLimit(key)) this.lastLimits.delete(key);
    }
    const sig = JSON.stringify({ ...status, accounts: status.accounts.map((a) => ({ ...a, observedAt: 0, windows: a.windows.map((w) => ({ ...w, observedAt: 0 })) })) });
    if (sig === this.lastEvent) return;
    this.lastEvent = sig;
    this.deps.bus.emit({ type: 'accounts.updated', status });
    for (const fn of this.changeListeners) fn();
  }
}

export class AccountsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccountsError';
  }
}

/** A budget from the page, checked and cut to the fields Conclave reads. */
export function checkBudget(b: unknown): AccountBudget {
  const x = (b ?? {}) as Record<string, unknown>;
  const usd = Math.round(Number(x.usd) * 1e4) / 1e4;
  if (!Number.isFinite(usd) || usd <= 0) throw new AccountsError(400, 'The budget must be more than $0.');
  const period = x.period === undefined ? 'month' : x.period;
  if (period !== 'month' && period !== 'week' && period !== 'day') throw new AccountsError(400, 'period must be month, week or day');
  const out: AccountBudget = { usd, period };
  const int = (v: unknown, lo: number, hi: number, what: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new AccountsError(400, `${what} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  const day = int(x.resetDay, period === 'week' ? 0 : 1, period === 'week' ? 6 : 31, 'resetDay');
  if (day !== undefined && period !== 'day') out.resetDay = day;
  const hour = int(x.resetHour, 0, 23, 'resetHour');
  if (hour !== undefined) out.resetHour = hour;
  if (x.tz !== undefined && x.tz !== '') {
    if (typeof x.tz !== 'string') throw new AccountsError(400, 'tz must be a time zone name');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: x.tz });
    } catch {
      throw new AccountsError(400, `${x.tz} is not a time zone. Use a name like Europe/Berlin.`);
    }
    out.tz = x.tz;
  }
  const warn = int(x.warnAt, 1, 100, 'warnAt');
  if (warn !== undefined) out.warnAt = warn;
  if (x.hardStop !== undefined) {
    if (typeof x.hardStop !== 'boolean') throw new AccountsError(400, 'hardStop must be true or false');
    out.hardStop = x.hardStop;
  }
  return out;
}

/** The window starter's settings from the page, checked. "" clears a field (model: back to the cheapest; hours: the defaults). */
export function checkStarter(x: unknown): AccountStarter & Record<string, unknown> {
  const v = (x ?? {}) as Record<string, unknown>;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new AccountsError(400, 'starter must be an object');
  const out: Record<string, unknown> = {};
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') throw new AccountsError(400, 'starter.enabled must be true or false');
    out.enabled = v.enabled;
  }
  if (v.model !== undefined) {
    if (typeof v.model !== 'string' || v.model.length > 200 || /\s/.test(v.model.trim())) throw new AccountsError(400, 'starter.model must be a model id');
    out.model = v.model.trim();
  }
  for (const k of ['start', 'end'] as const) {
    if (v[k] === undefined) continue;
    if (v[k] === '') {
      out[k] = '';
      continue;
    }
    const m = typeof v[k] === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((v[k] as string).trim()) : null;
    if (!m) throw new AccountsError(400, `starter.${k} must be a time like 07:00`);
    out[k] = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  if (v.tz !== undefined) {
    if (typeof v.tz !== 'string') throw new AccountsError(400, 'starter.tz must be a time zone name');
    if (v.tz.trim() && !validZone(v.tz.trim())) throw new AccountsError(400, `${v.tz} is not a time zone. Use a name like Europe/Berlin.`);
    out.tz = v.tz.trim();
  }
  return out as AccountStarter & Record<string, unknown>;
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
