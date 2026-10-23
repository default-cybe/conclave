/**
 * Which key pays for a member's call, and the budget on the hub's keys
 * (docs/design/ACCOUNTS.md 6). The owner always uses the hub's keys. A
 * member uses their own key for a provider when they have one, else the
 * hub's when the owner allowed that provider, else nothing. Budgets count
 * only the hub's money: usage rows with paid_by = 'hub', and the calls on
 * the hub's key still running, each at an estimate of its cost until its
 * row is written (reserve), so calls started together cannot overshoot.
 */
import type { ConfigStore } from '../config';
import type { Db } from '../storage/db';
import type { ProviderConfig } from '../config/schema';
import type { Provider } from '../providers/types';
import { createProvider, isLocalUrl, type RegistryOverlay } from '../providers/registry';
import { OWNER_ID } from './context';
import type { PeopleStore } from './store';
import type { AccountSecrets } from './secrets';
import { MemberPlanProvider, PLAN_PROVIDER, entryServes, memberPlanConfig, type MemberPlans } from './plans';

export type KeySource = 'hub' | 'own' | 'none';

export interface ProviderAccessInfo {
  provider: string;
  name: string;
  /** Whose key a call would use now. */
  source: KeySource;
  /** The owner allows the hub's key. */
  hubAllowed: boolean;
  /** The member has a key of their own. */
  ownKey: boolean;
  /** Plans the member signed in themselves (cliproxy only, docs/design/ACCOUNTS.md 12). */
  ownPlans?: number;
  /** Monthly cap on the hub's key in USD; undefined is no cap. */
  monthlyUsd?: number;
  /** Spent on the hub's key since the first of the month. */
  spentUsd: number;
  /** When the budget starts again. */
  resetsAt: number;
}

export class AccessError extends Error {
  constructor(
    readonly kind: 'no_access' | 'budget',
    message: string,
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

/** The first of this month and of next month, in the hub's local time. */
export function monthWindow(now = Date.now()): { from: number; to: number } {
  const d = new Date(now);
  return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}

export class ProviderAccess {
  /** A member's calls on the hub's key in flight, per account and provider: their estimated cost and how many. In memory: a restart ends them all. */
  private readonly inFlight = new Map<string, { usd: number; calls: number }>();
  /** Members' own signed in plans (people/plans.ts), when the server runs them. */
  private memberPlans?: MemberPlans;
  private offPlans?: () => void;
  private readonly planListeners = new Set<(accountId: string) => void>();

  constructor(
    private readonly deps: {
      db: Db;
      config: ConfigStore;
      people: PeopleStore;
      secrets: AccountSecrets;
    },
  ) {}

  private label(provider: string): string {
    return this.deps.config.get().providers[provider]?.name ?? provider;
  }

  /** A provider that needs no key of anyone's: an agent harness on the session's own device. */
  private keyless(provider: string): boolean {
    return this.deps.config.get().providers[provider]?.type === 'acp';
  }

  /**
   * The hub has something of its own to share for this provider: a key, or
   * no need of one (a local server, and CLIProxyAPI once subscriptions are
   * set up, which turns it on). Only these can be granted to a member.
   */
  hubHas(provider: string): boolean {
    const p = this.deps.config.get().providers[provider];
    if (!p || this.keyless(provider) || p.enabled === false) return false;
    return this.deps.config.hasProviderKey(provider) || isLocalUrl(p.baseUrl);
  }

  /** Why the owner cannot let a member use the hub's key for this provider, or undefined when they can. */
  grantRefusal(provider: string): string | undefined {
    if (this.hubHas(provider)) return undefined;
    if (this.keyless(provider)) return `${this.label(provider)} runs on each person's own device with their own sign in. There is no hub key to share.`;
    return `The hub has no key for ${this.label(provider)}. Add one in Settings, Providers first.`;
  }

  // -------------------------------------------------------------------------
  // Members' own plans (docs/design/ACCOUNTS.md 12)
  // -------------------------------------------------------------------------

  /** The server's members' own CLIProxyAPIs. A change of one member's tells the listeners (their registry is built again). */
  setPlans(plans: MemberPlans | undefined): void {
    this.offPlans?.();
    this.memberPlans = plans;
    this.offPlans = plans?.onChange((id) => {
      for (const fn of this.planListeners) fn(id);
    });
  }

  get plans(): MemberPlans | undefined {
    return this.memberPlans;
  }

  /** fn(accountId) after a member's own plans changed. Returns the unsubscribe. */
  onPlansChange(fn: (accountId: string) => void): () => void {
    this.planListeners.add(fn);
    return () => this.planListeners.delete(fn);
  }

  /**
   * True when this call goes to the member's own plan: a member, the plans
   * provider, and (with a model) one of their own plans lists it; without a
   * model, they have their own CLIProxyAPI running. Never the owner's.
   */
  ownPlan(accountId: string, provider: string, model?: string): boolean {
    if (accountId === OWNER_ID || provider !== PLAN_PROVIDER || !this.memberPlans) return false;
    const entry = this.memberPlans.entry(accountId);
    return model === undefined ? !!entry : entryServes(entry, model);
  }

  /** The owner lets this member use the hub's own entry of a provider (a grant, and the hub has something to share). */
  private hubGranted(accountId: string, provider: string): boolean {
    return accountId === OWNER_ID || (!!this.deps.people.get(accountId)?.settings.providers?.[provider] && this.hubHas(provider));
  }

  /**
   * What a member's registry uses: their keys, which providers they may use,
   * and their own plans over the hub's `cliproxy` (people/plans.ts).
   */
  registryKeys(accountId: string): { apiKey: (provider: string) => string | undefined; allowed: (provider: string) => boolean; overlay: RegistryOverlay } {
    return {
      apiKey: (provider) => this.apiKey(accountId, provider),
      allowed: (provider) => this.source(accountId, provider) !== 'none',
      overlay: {
        configs: (): Record<string, ProviderConfig> => {
          const entry = this.memberPlans?.entry(accountId);
          if (!entry) return {};
          const hub = this.deps.config.get().providers[PLAN_PROVIDER];
          return { [PLAN_PROVIDER]: memberPlanConfig(entry, hub, this.hubGranted(accountId, PLAN_PROVIDER)) };
        },
        make: (provider, cfg, hub) => {
          const entry = this.memberPlans?.entry(accountId);
          if (!entry || provider !== PLAN_PROVIDER) return undefined;
          // the member's own CLIProxyAPI, on its own key; the overlay entry's address is the member's
          const own = createPlanProvider(provider, { ...entry.config, name: cfg.name ?? entry.config.name }, entry.apiKey);
          if (!own) return undefined;
          return new MemberPlanProvider(provider, own, hub, {
            serves: (model) => entryServes(this.memberPlans?.entry(accountId), model),
            hubAllowed: () => this.hubGranted(accountId, provider),
            refusal: () => noAccess(this.label(provider)),
          });
        },
      },
    };
  }

  /** Whose key a call by this account to this provider uses now. With a model, a member's own plan that lists it counts as their own. */
  source(accountId: string, provider: string, model?: string): KeySource {
    if (accountId === OWNER_ID || this.keyless(provider)) return 'hub';
    if (this.ownPlan(accountId, provider, model)) return 'own';
    if (this.deps.secrets.providerKey(accountId, provider)) return 'own';
    return this.deps.people.get(accountId)?.settings.providers?.[provider] ? 'hub' : 'none';
  }

  /** The API key this account's call uses, or undefined (no access, or the provider needs none). */
  apiKey(accountId: string, provider: string): string | undefined {
    const src = this.source(accountId, provider);
    if (src === 'own') return this.ownPlan(accountId, provider) ? this.memberPlans?.entry(accountId)?.apiKey : this.deps.secrets.providerKey(accountId, provider);
    if (src === 'hub') return this.deps.config.apiKey(provider);
    return undefined;
  }

  /** USD this account spent on the hub's key for a provider since `from`. */
  spent(accountId: string, provider: string, from = monthWindow().from): number {
    const r = this.deps.db
      .query("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE account_id = ? AND provider = ? AND (paid_by IS NULL OR paid_by = 'hub') AND ts >= ?")
      .get(accountId, provider, from) as { usd: number };
    return r.usd;
  }

  /** USD the account's calls on the hub's key for a provider hold while they run. */
  reserved(accountId: string, provider: string): number {
    return this.inFlight.get(`${accountId}\u0000${provider}`)?.usd ?? 0;
  }

  /**
   * Hold `usd`, an estimate of a call's cost, against a member's budget on
   * the hub's key while the call runs: check() counts it as spent, so calls
   * started together do not all pass on the same total. Returns the release,
   * for when the call's usage row is written or it ends; a second call does
   * nothing. The owner has no budget, so nothing is held.
   */
  reserve(accountId: string, provider: string, usd: number): () => void {
    if (accountId === OWNER_ID || !(usd > 0)) return () => {};
    const key = `${accountId}\u0000${provider}`;
    const cur = this.inFlight.get(key) ?? { usd: 0, calls: 0 };
    this.inFlight.set(key, { usd: cur.usd + usd, calls: cur.calls + 1 });
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const now = this.inFlight.get(key);
      if (!now || now.calls <= 1) this.inFlight.delete(key);
      else this.inFlight.set(key, { usd: Math.max(0, now.usd - usd), calls: now.calls - 1 });
    };
  }

  info(accountId: string, provider: string): ProviderAccessInfo {
    const grant = this.deps.people.get(accountId)?.settings.providers?.[provider];
    const win = monthWindow();
    const cap = typeof grant?.monthlyUsd === 'number' ? grant.monthlyUsd : undefined;
    // counted from the member's own CLIProxyAPI folder, also while it is not running
    const plans = accountId !== OWNER_ID && provider === PLAN_PROVIDER ? (this.memberPlans?.count(accountId) ?? 0) : 0;
    return {
      provider,
      name: this.label(provider),
      source: this.source(accountId, provider),
      hubAllowed: accountId === OWNER_ID || !!grant,
      ownKey: accountId !== OWNER_ID && !!this.deps.secrets.providerKey(accountId, provider),
      ...(plans ? { ownPlans: plans } : {}),
      ...(cap !== undefined ? { monthlyUsd: cap } : {}),
      spentUsd: this.spent(accountId, provider, win.from),
      resetsAt: win.to,
    };
  }

  /** Every provider in the hub's config that takes a key, as this account may use it (agent harnesses need none; turned off ones are left out). */
  list(accountId: string): ProviderAccessInfo[] {
    return Object.entries(this.deps.config.get().providers)
      .filter(([id, p]) => !this.keyless(id) && (p as { enabled?: boolean }).enabled !== false)
      .map(([id]) => this.info(accountId, id));
  }

  /**
   * Throw when this account may not call the provider now: no key of its own
   * and no allowance on the hub's, or the month's budget on the hub's key is spent.
   */
  check(accountId: string, provider: string, model?: string): KeySource {
    const src = this.source(accountId, provider, model);
    if (src === 'none') throw new AccessError('no_access', noAccess(this.label(provider)));
    if (src === 'own' || accountId === OWNER_ID) return src;
    const grant = this.deps.people.get(accountId)?.settings.providers?.[provider];
    const cap = grant?.monthlyUsd;
    if (typeof cap === 'number') {
      const win = monthWindow();
      const spent = this.spent(accountId, provider, win.from);
      if (spent >= cap) {
        const when = new Date(win.to).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        throw new AccessError('budget', `You reached your $${cap} monthly budget for ${this.label(provider)}. It resets on ${when}. Add your own key in Settings, Providers, or ask the owner.`, win.to);
      }
      // calls still running count at their estimate: what is left may be theirs once they finish
      if (spent + this.reserved(accountId, provider) >= cap) {
        throw new AccessError('budget', `Calls running now use the rest of your $${cap} monthly budget for ${this.label(provider)}. Try again when they finish, add your own key in Settings, Providers, or ask the owner.`);
      }
    }
    return src;
  }
}

/** What a call says when this account may not use a provider. */
function noAccess(label: string): string {
  return `You can't use ${label} on this hub. Add your own key in Settings, Providers, or ask the owner.`;
}

/** A provider for a member's own CLIProxyAPI entry, on its own key. */
function createPlanProvider(id: string, cfg: ProviderConfig, apiKey: string): Provider | undefined {
  return createProvider(id, cfg, { apiKey });
}
