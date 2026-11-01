/**
 * A member's own usage and refusal fallback lists (docs/design/ACCOUNTS.md 13).
 *
 * The owner's lists (models.limitFallback, models.refusalFallback) name the
 * owner's models and plans, so a member's session never walks them. A member
 * keeps their own in their account settings (people/store.ts AccountSettings
 * usageFallback, refusalFallback): models only, no accounts. Each model must
 * be one the member can call (memberCanUse): their own keys and plans, or a
 * hub key the owner granted them. It is checked when they save, and again at
 * run time, so a grant taken back or a plan signed out is skipped.
 *
 * A model routed through the plans gateway goes to the member's own plans
 * first, in their order (memberRoute), as nextAccount does; a prefixed id
 * that their own CLIProxyAPI does not list names someone else's plan and is
 * never used.
 */
import type { Engine } from '../engine/engine';
import type { AgentDef } from '../extensions/types';
import type { LimitFallbackConfig, RefusalFallbackConfig } from '../config/schema';
import { isMember } from '../people/context';
import { PLAN_PROVIDER, entryServes } from '../people/plans';
import { PeopleError } from '../people/store';
import { splitAccount } from '../providers/split';
import { bareModel, ownModel } from '../accounts/policy';
import { MAX_REFUSAL_ENTRIES, parseRefusalEntries } from './refusal-entries';
import { refusalPlan, usable, type RefusalPlan } from './refusal-fallback';

/**
 * Whether a member can call this ref now: their registry has it set up and
 * on, the task's fallback policy allows it, it is not a harness, and a
 * prefixed plan id is one their own CLIProxyAPI lists (never the owner's plan).
 */
export function memberCanUse(engine: Engine, accountId: string, ref: string): boolean {
  if (!engine.isUsable(ref, accountId)) return false;
  try {
    const r = engine.providersFor(accountId).resolve(ref);
    if (r.acp) return false;
    if (r.provider === PLAN_PROVIDER && splitAccount(r.model).account && !entryServes(engine.access.plans?.entry(accountId), r.model)) return false;
  } catch {
    return false;
  }
  return usable(engine, { accountId }, { index: -1, entry: { model: ref }, ref, label: '' });
}

/** The usage fallback list for an account: the owner's models.limitFallback, or a member's own. */
export function usageListFor(engine: Engine, accountId: string | undefined): LimitFallbackConfig | undefined {
  return isMember(accountId) ? engine.accountPrefs(accountId!).usageFallback : engine.config.get().models?.limitFallback;
}

/**
 * The refusal plan for a session: the owner's (refusalPlan, unchanged), or a
 * member's own list. A member's has no marked plans (those are the owner's)
 * and ignores an agent's own list (it may name the owner's plans), but an
 * agent with the refusal fallback off turns theirs off too. Entries the
 * member cannot call now are left out.
 */
export function refusalPlanFor(engine: Engine, accountId: string | undefined, agent?: Pick<AgentDef, 'refusalFallback'>): RefusalPlan | undefined {
  if (!isMember(accountId)) return refusalPlan(engine.config.get(), agent);
  if (agent?.refusalFallback === false) return undefined;
  const own = engine.accountPrefs(accountId!).refusalFallback;
  const entries = parseRefusalEntries(own?.entries)
    .map((e) => ({ model: e.model }))
    .filter((e) => memberCanUse(engine, accountId!, e.model));
  if (!entries.length) return undefined;
  return { entries, auto: own?.enabled === true, stay: own?.stay === true, source: 'config', tagged: false };
}

/**
 * Where a member's call for `ref` goes now, as a ref, or undefined. On the
 * plans gateway: the model on the first of the member's own plans that is
 * ready, in their order, skipping the plan `skipPrefix` names (the one at its
 * limit); when their own plans list the model but none is ready, nothing.
 * Otherwise (a hub plan or key the owner granted, or their own key) the ref
 * as written. Never a ref tried this turn.
 */
export function memberRoute(engine: Engine, accountId: string, ref: string, tried: readonly string[] = [], skipPrefix?: string): string | undefined {
  let provider: string;
  let wireModel: string;
  try {
    const r = engine.providersFor(accountId).resolve(ref);
    provider = r.provider;
    wireModel = r.model;
  } catch {
    return undefined;
  }
  const plans = engine.access.plans;
  if (provider === PLAN_PROVIDER && plans?.readyAccounts) {
    const bare = splitAccount(wireModel).model;
    const entry = plans.entry(accountId);
    for (const a of plans.readyAccounts(accountId, bare)) {
      if (a.kind !== 'subscription' || !a.prefix || a.prefix === skipPrefix) continue;
      const wire = `${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), bare) ?? bare)}`;
      if (!entryServes(entry, wire)) continue;
      const out = `${PLAN_PROVIDER}/${wire}`;
      if (!tried.includes(out) && memberCanUse(engine, accountId, out)) return out;
    }
    // their own plans have it and none is ready: a call would go to the same limit
    if (entryServes(entry, bare)) return undefined;
  }
  return !tried.includes(ref) && memberCanUse(engine, accountId, ref) ? ref : undefined;
}

/** Longest usage list kept, as the refusal list. */
const MAX_USAGE_MODELS = MAX_REFUSAL_ENTRIES;

/**
 * A member's lists from PATCH /api/me, cleaned and checked: models only,
 * each one the member can call now, else a PeopleError 400 that names it.
 * null clears the list. Undefined: not in the patch.
 */
export function checkMemberUsageList(engine: Engine, accountId: string, raw: unknown): LimitFallbackConfig | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new PeopleError(400, 'usageFallback must be an object with enabled and models.');
  const r = raw as Record<string, unknown>;
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw new PeopleError(400, 'usageFallback.enabled must be true or false.');
  if (r.models !== undefined && !Array.isArray(r.models)) throw new PeopleError(400, 'usageFallback.models must be a list of models.');
  const models = [...new Set(((r.models as unknown[]) ?? []).filter((m): m is string => typeof m === 'string' && m.includes('/')).map((m) => m.trim()))];
  if (models.length > MAX_USAGE_MODELS) throw new PeopleError(400, `A usage fallback list has at most ${MAX_USAGE_MODELS} models.`);
  for (const m of models) if (!memberCanUse(engine, accountId, m)) throw new PeopleError(400, cannotUse(m));
  return { ...(r.enabled !== undefined ? { enabled: r.enabled as boolean } : {}), models };
}

export function checkMemberRefusalList(engine: Engine, accountId: string, raw: unknown): RefusalFallbackConfig | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new PeopleError(400, 'refusalFallback must be an object with enabled, stay and entries.');
  const r = raw as Record<string, unknown>;
  for (const k of ['enabled', 'stay'] as const) if (r[k] !== undefined && typeof r[k] !== 'boolean') throw new PeopleError(400, `refusalFallback.${k} must be true or false.`);
  if (r.entries !== undefined && !Array.isArray(r.entries)) throw new PeopleError(400, 'refusalFallback.entries must be a list.');
  if (Array.isArray(r.entries) && r.entries.length > MAX_REFUSAL_ENTRIES) throw new PeopleError(400, `A refusal fallback list has at most ${MAX_REFUSAL_ENTRIES} models.`);
  // the accounts in an entry are the owner's (Accounts); a member's list names models only
  const entries = parseRefusalEntries(r.entries).map((e) => ({ model: e.model }));
  for (const e of entries) if (!memberCanUse(engine, accountId, e.model)) throw new PeopleError(400, cannotUse(e.model));
  return { ...(r.enabled !== undefined ? { enabled: r.enabled as boolean } : {}), ...(r.stay !== undefined ? { stay: r.stay as boolean } : {}), entries };
}

function cannotUse(model: string): string {
  return `You can't use ${model} on this hub. Pick a model from your own keys and plans, or one the owner allows you.`;
}
