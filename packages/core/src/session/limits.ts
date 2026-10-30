import type { ProviderError } from '../providers/types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from './runner';
import { keepTurnBase } from './checkpoints';
import { checkFallback } from './limit-tree';
import { activeMessages, lastAssistantText } from './transcript';
import { regionTokens } from './compaction';
import { SWITCH_BRIEF_AT } from '../modes/switch-math';
import { logger } from '../util/log';
import { accountsOf } from '../accounts/attached';
import { OWNER_ID, isMember } from '../people/context';
import { splitAccount } from '../providers/split';
import { refusalPlan, shortModelName, targetFor, usable } from './refusal-fallback';
import { memberCanUse, memberRoute, refusalPlanFor, usageListFor } from './member-fallbacks';
import { bareModel, ownModel } from '../accounts/policy';
import { variantBase } from '../providers/model-id';
import { forgetFallbackNotice } from './stream';
import { PLAN_PROVIDER, entryServes } from '../people/plans';
import type { AgentDef } from '../extensions/types';
import type { AccountDto } from '../client/accounts';

const log = logger('limits');

/** A limit that resets within this long is waited out instead of falling back, when the chat is big (limits.waitShortResets). */
export const SHORT_RESET_MS = 5 * 60_000;

/**
 * Wait for the reset instead of falling back to another model? Yes when the
 * rule is on (limits.waitShortResets, default true), auto-resume can wait,
 * the limit resets within SHORT_RESET_MS, and the chat holds at least
 * bigTokens (context.switchBriefAt): the fallback would read all of it again
 * with no cache, while waiting costs a few minutes and keeps the cache. It
 * never changes what the model sees.
 */
export function waitInsteadOfFallback(o: { enabled: boolean | undefined; autoResume: boolean; resetInMs: number | undefined; chatTokens: number; bigTokens: number | undefined }): boolean {
  if (o.enabled === false || !o.autoResume || o.resetInMs === undefined) return false;
  const big = o.bigTokens ?? SWITCH_BRIEF_AT;
  return o.resetInMs <= SHORT_RESET_MS && big > 0 && o.chatTokens >= big;
}

export interface LimitOutcome {
  /** A model to retry this turn with instead of waiting. */
  fallback?: string;
  /** The session was parked until the window resets. */
  parked?: boolean;
}

/**
 * After a plan pinned by its prefix (cliproxy/neu/gpt-6-sol) hit its limit:
 * the same model on the next plan in the owner's order that is on, signed in,
 * offers it, is not at a limit and can be called for this session. A
 * member's session moves only between the member's own plans (people/plans.ts
 * readyAccounts), never to the owner's. A plan without a prefix gets the
 * bare id; CLIProxyAPI gives it to the first ready plan in the same order.
 * An effort variant (Antigravity's claude-opus-5-5-high, prefixed or not)
 * moves to the model itself on the owner's other plans, unless exact: the
 * refusal walk passes it, as the model's other plans may be the one that refused.
 */
export function nextAccount(engine: Engine, sessionId: string, modelRef: string, opts: { exact?: boolean } = {}): { ref: string; account: string; from: string; to: string } | undefined {
  const session = engine.repos.sessions.get(sessionId);
  if (!session) return undefined;
  const member = isMember(session.accountId) ? session.accountId! : undefined;
  const plans = member ? engine.access.plans : undefined;
  const accounts = member ? undefined : accountsOf(engine);
  if (member ? !plans?.readyAccounts : !accounts) return undefined;
  const gw = accounts ? (accounts.gateway ?? 'cliproxy') : PLAN_PROVIDER;
  let wireModel: string;
  try {
    const r = engine.registryFor(session).resolve(modelRef);
    if (r.provider !== gw) return undefined;
    wireModel = r.model;
  } catch {
    return undefined;
  }
  const { account: prefix, model: bare } = splitAccount(wireModel);
  // an effort variant (Antigravity's claude-opus-5-5-high) moves to the model itself on the owner's other plans
  const base = opts.exact ? bare : variantBase(bare);
  // an id without a prefix: CLIProxyAPI already moves it between plans, except a variant only the plan at its limit lists
  if (!prefix && (member || base === bare)) return undefined;
  // the plan's own name for the bare id (GPT-6.1-Sol), as the pickers show it
  const nameOf = (id: string): string => {
    try {
      return shortModelName(engine.registryFor(session).resolveAt(gw, id).info.name);
    } catch {
      return id; // not listed bare: its id is its name
    }
  };
  const name = nameOf(bare);
  if (member) {
    // the member's own plans only: a wire their own CLIProxyAPI does not list would go to the hub's
    const entry = plans!.entry(member);
    for (const a of plans!.readyAccounts!(member, bare)) {
      if (a.kind !== 'subscription' || !a.prefix || a.prefix === prefix) continue;
      // the plan's own id: Antigravity lists claude-opus-5-5-high, not claude-opus-5-5
      const wire = `${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), bare) ?? bare)}`;
      if (!entryServes(entry, wire)) continue;
      return { ref: `${gw}/${wire}`, account: a.id, from: `${name} (${prefix})`, to: `${name} (${a.label})` };
    }
    return undefined;
  }
  const current = prefix ? accounts!.accountFor(gw, wireModel) : undefined;
  const atLimit = atLimitFor(bare, prefix, current);
  const plan = (current && accounts!.account(current)?.label) || prefix;
  const toName = base === bare ? name : nameOf(base);
  for (const a of accounts!.readyAccounts(base)) {
    if (a.kind !== 'subscription' || atLimit(a)) continue;
    const own = bareModel(ownModel((a.models ?? []).map((m) => m.id), base) ?? base);
    const wire = a.prefix ? `${a.prefix}/${own}` : own;
    const ref = `${gw}/${wire}`;
    if (!usable(engine, session, { index: -1, entry: { model: ref, account: a.id }, ref, pin: { provider: gw, model: wire, account: a.id }, label: '' })) continue;
    return { ref, account: a.id, from: plan ? `${name} (${plan})` : name, to: `${toName} (${a.label})` };
  }
  return undefined;
}

/**
 * Another model to run after `modelRef` hit its limit: the owner's
 * limits.fallbacks for it first, else the first entry of the owner's
 * refusal fallback list (models.refusalFallback) that the hub can call now,
 * is another model than the one at its limit, was not tried this turn, and
 * whose plan or key is not paused or at a limit. The list is the one
 * refusalPlan gives the session's agent: its own, or none when it turned the
 * fallback off. Both lists name the owner's models and plans: a member's
 * session gets an entry of limits.fallbacks only when the member can call
 * it, then the member's own lists (memberLimitFallback).
 * With the usage fallback on (models.limitFallback), its list replaces the
 * refusal list here (usageChainFallback); an agent with the refusal fallback
 * off still gets no other model. An effort variant at its limit (Antigravity's
 * claude-opus-5-5-high) first gets the model itself on the owner's other plans
 * and keys, even for that agent: it is the same model, as in nextAccount.
 */
export function limitFallback(engine: Engine, accountId: string | undefined, modelRef: string, tried: readonly string[] = [], agent?: Pick<AgentDef, 'refusalFallback'>): string | undefined {
  const cfg = engine.config.get();
  const member = isMember(accountId) ? accountId! : undefined;
  let resolved;
  try {
    resolved = engine.providersFor(accountId).resolve(modelRef);
  } catch {
    return undefined;
  }
  const { account: prefix, model: bare } = splitAccount(resolved.model ?? modelRef.slice(modelRef.indexOf('/') + 1));
  const bareRef = prefix ? `${resolved.provider}/${bare}` : undefined;
  const fallbacks =
    cfg.limits.fallbacks[modelRef] ??
    (bareRef ? cfg.limits.fallbacks[bareRef] : undefined) ??
    Object.entries(cfg.limits.fallbacks).find(([k]) => {
      const i = k.indexOf('/');
      return i > 0 && k.slice(0, i) === resolved.provider && splitAccount(k.slice(i + 1)).model === bare;
    })?.[1] ??
    cfg.limits.fallbacks[resolved.provider] ??
    [];
  // a member gets only an entry they can call: their own keys and plans, or a hub key granted to them
  const configured = fallbacks.find((fb) => fb !== modelRef && !tried.includes(fb) && (member ? memberCanUse(engine, member, fb) : engine.isUsable(fb) && !engine.providers.resolve(fb).acp));
  if (configured) return configured;
  if (member) return memberLimitFallback(engine, member, modelRef, prefix, bare, tried, agent);
  const accounts = accountsOf(engine);
  const session = { accountId: accountId ?? OWNER_ID };
  // an effort variant at its limit (Antigravity's claude-opus-5-5-high): the model itself on the owner's other plans and keys first
  const base = variantBase(bare);
  if (base !== bare && accounts) {
    const same = readyRef(engine, session, base, tried, atLimitFor(bare, prefix, prefix ? accounts.accountFor(resolved.provider, resolved.model) : undefined));
    if (same) return same;
  }
  const skip = new Set([bare, ...tried.map((r) => bareOf(engine, r))]);
  const chain = cfg.models?.limitFallback;
  if (chain?.enabled === true && Array.isArray(chain.models) && chain.models.length) {
    return agent?.refusalFallback === false ? undefined : usageChainFallback(engine, session, bare, chain.models, skip, tried);
  }
  const entries = refusalPlan(cfg, agent)?.entries ?? [];
  for (let i = 0; i < entries.length; i++) {
    const t = targetFor(engine, entries[i], i);
    if (!t || !usable(engine, session, t)) continue;
    const model = t.pin ? bareModel(t.pin.model) : bareOf(engine, t.ref);
    if (!model || skip.has(model) || tried.includes(t.ref)) continue;
    if (accounts) {
      // a plan or key that is paused or at a limit: an entry pinned to it is skipped, and so is a loose one when none of its vendor's is ready
      const ready = accounts.readyAccounts(model);
      if (t.pin?.account ? !ready.some((a) => a.id === t.pin!.account) : !!accounts.routeOf(model) && !ready.length) continue;
    }
    return t.ref;
  }
  return undefined;
}

/**
 * limitFallback for a member's session, on the member's own lists
 * (session/member-fallbacks.ts): an effort variant first gets the model
 * itself on their other plans; then their usage fallback list when it is on,
 * else their refusal fallback list. Every step is a model they can call, on
 * their own plans first (memberRoute). Never the owner's lists or plans.
 */
function memberLimitFallback(engine: Engine, member: string, modelRef: string, prefix: string, bare: string, tried: readonly string[], agent?: Pick<AgentDef, 'refusalFallback'>): string | undefined {
  const reg = engine.providersFor(member);
  const bareOfRef = (ref: string): string => {
    try {
      return bareModel(reg.resolve(ref).model);
    } catch {
      return '';
    }
  };
  const gwRef = (m: string) => `${PLAN_PROVIDER}/${m}`;
  const base = variantBase(bare);
  if (base !== bare) {
    const same = memberRoute(engine, member, gwRef(base), [modelRef, ...tried], prefix || undefined);
    if (same) return same;
  }
  const skip = new Set([bare, ...tried.map(bareOfRef)]);
  const chain = usageListFor(engine, member);
  if (chain?.enabled === true && Array.isArray(chain.models) && chain.models.length) {
    if (agent?.refusalFallback === false) return undefined;
    const list = chain.models.filter((r): r is string => typeof r === 'string' && r.includes('/'));
    const ids = list.map((r) => bareModel(r));
    for (let i = ids.indexOf(bare) + 1; i < list.length; i++) {
      if (skip.has(ids[i])) continue;
      const ref = memberRoute(engine, member, list[i], tried);
      if (ref) return ref;
    }
    return undefined;
  }
  for (const e of refusalPlanFor(engine, member, agent)?.entries ?? []) {
    const m = bareOfRef(e.model);
    if (!m || skip.has(m)) continue;
    const ref = memberRoute(engine, member, e.model, tried);
    if (ref) return ref;
  }
  return undefined;
}

/**
 * The usage fallback list (models.limitFallback): the models after the one at
 * its limit (by bare id; from the top when it is not listed), each on the
 * first ready plan or key of its own account order. A model tried this turn,
 * one with no ready account, or one the hub cannot call now is skipped.
 */
function usageChainFallback(engine: Engine, session: { accountId: string }, bare: string, refs: readonly unknown[], skip: Set<string>, tried: readonly string[]): string | undefined {
  const list = refs.filter((r): r is string => typeof r === 'string' && r.includes('/'));
  const ids = list.map((r) => bareModel(r));
  const accounts = accountsOf(engine);
  for (let i = ids.indexOf(bare) + 1; i < list.length; i++) {
    const model = ids[i];
    if (skip.has(model)) continue;
    const ref = readyRef(engine, session, model, tried);
    if (ref) return ref;
    // no account order for it (a key the accounts do not track): the ref as written
    if (!accounts?.readyAccounts(model).length && !accounts?.routeOf(model) && !tried.includes(list[i]) && usable(engine, session, { index: -1, entry: { model: list[i] }, ref: list[i], label: '' })) return list[i];
  }
  return undefined;
}

/** The model on the first ready plan or key of its account order, as a ref; not on an account `skip` names, nor a ref tried this turn. */
function readyRef(engine: Engine, session: { accountId: string }, model: string, tried: readonly string[], skip: (a: AccountDto) => boolean = () => false): string | undefined {
  const accounts = accountsOf(engine);
  const gw = accounts?.gateway ?? 'cliproxy';
  for (const a of accounts ? accounts.readyAccounts(model) : []) {
    const p = a.kind === 'api' ? a.provider : gw;
    if (!p || skip(a)) continue;
    // a plan gets its own id (Antigravity lists claude-opus-5-5-high), as nextAccount sends
    const wire = a.kind === 'subscription' && a.prefix ? `${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), model) ?? model)}` : model;
    const ref = `${p}/${wire}`;
    if (tried.includes(ref) || !usable(engine, session, { index: -1, entry: { model: ref, account: a.id }, ref, pin: { provider: p, model: wire, account: a.id }, label: '' })) continue;
    return ref;
  }
  return undefined;
}

/**
 * The account a model at its limit ran on: the one its prefix names, else
 * (an id without a prefix) every plan that lists that exact id, the ones
 * CLIProxyAPI gives it to.
 */
function atLimitFor(bare: string, prefix: string | undefined, current: string | undefined): (a: AccountDto) => boolean {
  return (a) => (prefix ? a.id === current : a.kind === 'subscription' && ownModel((a.models ?? []).map((m) => m.id), bare, true) !== undefined);
}

/** A ref's model id without provider or account prefix, in the account's registry (the owner's when left out); '' when it does not resolve. */
function bareOf(engine: Engine, ref: string, accountId?: string): string {
  try {
    return bareModel(engine.providersFor(accountId).resolve(ref).model);
  } catch {
    return '';
  }
}

/**
 * A long rate limit or quota window was hit. In order:
 * 0. If the model is pinned to one plan by its prefix and another plan of the
 *    owner serves the same model now, continue there and keep it for the
 *    session (nextAccount). Same model, so waitInsteadOfFallback does not apply.
 * 1. If a fallback model is configured and usable, or else the owner's refusal
 *    fallback list has one that is ready (limitFallback), switch to it for this turn,
 *    unless the limit resets within a few minutes and the chat is big
 *    (waitInsteadOfFallback): then wait as in 2.
 * 2. Else if auto-resume is on and we know when it resets, park the session and
 *    schedule a durable resume job. The session continues on its own when the
 *    window reopens, even across a hub restart.
 * 3. Else surface the error.
 */
export async function handleLimit(engine: Engine, runner: SessionRunner, modelRef: string, err: ProviderError, tried: readonly string[] = [], opts: { sticky?: boolean } = {}): Promise<LimitOutcome> {
  const cfg = engine.config.get();
  const sessionId = runner.id;
  const resetAt = err.resetAt ?? (err.retryAfterMs ? Date.now() + err.retryAfterMs : undefined);
  const session = engine.repos.sessions.get(sessionId);
  // the chat the fallback would read again, for the cost ceiling's estimate
  const chatTokens = () => regionTokens(activeMessages(engine.repos.messages.list(sessionId)));

  let next = nextAccount(engine, sessionId, modelRef);
  if (next) {
    // the task's fallback policy (ideas item 8): allowed destinations, paid rule, cost ceiling
    const check = checkFallback(engine, session, next.ref, chatTokens(), undefined, true);
    if (!check.ok) {
      engine.notice(sessionId, `Not moving to ${next.to}: ${check.why}.`, 'warning');
      log.info(`${sessionId}: fallback to ${next.ref} denied by policy: ${check.why}`);
      next = undefined;
    }
  }
  if (next) {
    engine.notice(sessionId, `${next.from} hit its limit. Continuing on ${next.to}.`, 'warning');
    // kept for the session: later turns skip the plan at its limit, and go back once it resets (switchBack)
    const s = engine.repos.sessions.get(sessionId);
    if (s?.model === modelRef) {
      try {
        engine.updateSession(sessionId, { model: next.ref });
        // a chain of failovers keeps the ref the owner chose
        const prev = s.meta?.limitSwitch as LimitSwitch | undefined;
        const chain = prev?.to === modelRef ? prev : undefined;
        const until = chain ? chain.until : resetAt;
        engine.patchMeta(sessionId, { limitSwitch: { from: chain?.from ?? modelRef, to: next.ref, at: chain?.at ?? Date.now(), ...(until ? { until } : {}) } });
      } catch (e) {
        log.warn(`${sessionId}: could not keep ${next.ref}: ${(e as Error).message}`);
      }
    }
    log.info(`${sessionId}: ${modelRef} hit its limit; continuing on ${next.ref}`);
    return { fallback: next.ref };
  }

  const fallback = (() => {
    const f = limitFallback(engine, session?.accountId, modelRef, tried, session ? engine.agentFor(session) : undefined);
    if (!f) return undefined;
    const check = checkFallback(engine, session, f, chatTokens(), undefined, true);
    if (!check.ok) {
      engine.notice(sessionId, `Not falling back to ${f}: ${check.why}.`, 'warning');
      log.info(`${sessionId}: fallback to ${f} denied by policy: ${check.why}`);
      return undefined;
    }
    return f;
  })();
  if (fallback) {
    const wait = waitInsteadOfFallback({
      enabled: cfg.limits.waitShortResets,
      autoResume: cfg.limits.autoResume,
      resetInMs: resetAt === undefined ? undefined : Math.max(0, resetAt - Date.now()),
      chatTokens: regionTokens(activeMessages(engine.repos.messages.list(sessionId))),
      bigTokens: cfg.context.switchBriefAt,
    });
    if (!wait) {
      const s = engine.repos.sessions.get(sessionId);
      // a member's fallback comes from their own lists (memberLimitFallback), so it sticks and goes back the same way (switchBackModel)
      const stick = !!s && opts.sticky !== false && s.model === modelRef;
      engine.notice(sessionId, `${modelRef} hit its limit. Falling back to ${fallback} ${stick ? 'until a higher model on the list is ready' : 'for this turn'}.`, 'warning');
      if (stick) {
        try {
          engine.updateSession(sessionId, { model: fallback });
          const prev = s.meta?.limitFallback as LimitSwitch | undefined;
          const chain = prev?.to === modelRef ? prev : undefined;
          // an account failover (limitSwitch) that ended in this model fallback: the ref it left is the one to go back to
          const sw = s.meta?.limitSwitch as LimitSwitch | undefined;
          const seed = chain ?? (sw?.to === modelRef ? sw : undefined);
          const until = seed ? seed.until : resetAt;
          engine.patchMeta(sessionId, { limitFallback: { from: seed?.from ?? modelRef, to: fallback, at: seed?.at ?? Date.now(), ...(until ? { until } : {}) }, limitSwitch: undefined });
        } catch (e) {
          log.warn(`${sessionId}: could not keep ${fallback}: ${(e as Error).message}`);
        }
      }
      return { fallback };
    }
    log.info(`${sessionId}: ${modelRef} resets within ${Math.round(SHORT_RESET_MS / 60_000)} min and the chat is big; waiting instead of falling back to ${fallback}`);
  }

  if (!cfg.limits.autoResume || !resetAt || resetAt - Date.now() > 24 * 3600_000) {
    engine.notice(sessionId, `Rate limit on ${modelRef}: ${err.message}${resetAt ? `. Resets ${new Date(resetAt).toLocaleString()}.` : ''}`, 'error');
    return {};
  }

  const waitMs = Math.max(5_000, resetAt - Date.now());
  // the resumed run continues this user turn: the regression gate compares with the code from before it
  keepTurnBase(engine, sessionId, runner.turnCheckpoint);
  engine.parkForReset(sessionId, resetAt);
  engine.scheduler.enqueue('session.resume', resetAt + 2000, { sessionId, modelRef }, `resume:${sessionId}`);
  const why = fallback ? ` It waits instead of switching to ${fallback}, which would read the whole chat again.` : '';
  engine.notice(sessionId, `Usage limit reached. This session will continue automatically when the limit resets (${new Date(resetAt).toLocaleString()}).${why}`, 'warning');
  engine.notifyEvent('limitReset', {
    title: 'Usage limit reached',
    body: `${engine.providerLabel(engine.providers.resolve(modelRef).provider)} is rate limited. Conclave will resume this session when it resets.`,
    level: 'warning',
    sessionId,
    link: `/s/${sessionId}`,
  });
  log.info(`parked ${sessionId} for ${Math.round(waitMs / 1000)}s until ${new Date(resetAt).toISOString()}`);
  return { parked: true };
}

/** Session meta a usage-limit failover leaves (handleLimit): the ref the session ran on, and the one it moved to. */
interface LimitSwitch {
  from: string;
  to: string;
  /** When the session left the first plan. */
  at?: number;
  /** That plan's reset, when the limit said it. */
  until?: number;
}

/** How long a session stays on the plan it moved to when the reset time is unknown: a short block that lifts must not bounce it back each turn. */
const SWITCH_BACK_AFTER_MS = 15 * 60_000;

/**
 * At the start of a turn, for a session a usage-limit failover moved off a
 * plan: the same model on the highest ready plan in the owner's order, when
 * that ranks above the one it runs on now (its limit reset). The original
 * ref when that plan is the one it left. Returns the new ref, else undefined.
 * A session the owner switched by hand since is left alone and forgets the
 * failover. A member's session goes back on their own plans only
 * (memberSwitchBack), as nextAccount moves it.
 */
export function switchBack(engine: Engine, sessionId: string): string | undefined {
  const session = engine.repos.sessions.get(sessionId);
  const ls = session?.meta?.limitSwitch as LimitSwitch | undefined;
  if (!session || !ls?.from || !ls.to) return undefined;
  if (session.model !== ls.to) {
    engine.patchMeta(sessionId, { limitSwitch: undefined });
    return undefined;
  }
  // the first plan's reset passed, or a while went by since the failover
  const t = Date.now();
  if (!((ls.until !== undefined && t >= ls.until) || t - (ls.at ?? 0) >= SWITCH_BACK_AFTER_MS)) return undefined;
  if (isMember(session.accountId)) return memberSwitchBack(engine, sessionId, session.accountId!, session.model, ls);
  const accounts = accountsOf(engine);
  if (!accounts) return undefined;
  const gw = accounts.gateway ?? 'cliproxy';
  const wireOf = (ref: string): string | undefined => {
    try {
      const r = engine.registryFor(session).resolve(ref);
      return r.provider === gw ? r.model : undefined;
    } catch {
      return undefined;
    }
  };
  const now = wireOf(session.model);
  const from = wireOf(ls.from);
  if (!now) return undefined;
  // the model the owner chose, without the plan's prefix or effort variant (Antigravity's -high)
  const bare = variantBase(splitAccount(now).model);
  const current = accounts.accountFor(gw, now);
  // the plan it left; an unprefixed variant (Antigravity's claude-opus-5-5-high) left the plan that lists that id
  const f = from ? splitAccount(from) : undefined;
  const left = f ? atLimitFor(f.model, f.account, f.account ? accounts.accountFor(gw, from!) : undefined) : () => false;
  for (const a of accounts.readyAccounts(bare)) {
    // nothing above the plan it runs on has room
    if (a.id === current) return undefined;
    if (a.kind !== 'subscription') continue;
    const ref = left(a) ? ls.from : a.prefix ? `${gw}/${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), bare) ?? bare)}` : undefined;
    if (!ref || !usable(engine, session, { index: -1, entry: { model: ref, account: a.id }, ref, pin: { provider: gw, model: ref.slice(gw.length + 1), account: a.id }, label: '' })) continue;
    try {
      engine.updateSession(sessionId, { model: ref });
    } catch (e) {
      log.warn(`${sessionId}: could not go back to ${ref}: ${(e as Error).message}`);
      return undefined;
    }
    engine.patchMeta(sessionId, { limitSwitch: ref === ls.from ? undefined : { ...ls, to: ref } });
    engine.notice(sessionId, `Back on ${a.label}, its limit reset.`, 'info');
    forgetFallbackNotice(sessionId);
    log.info(`${sessionId}: back on ${ref} from ${session.model}`);
    return ref;
  }
  return undefined;
}

/**
 * switchBack for a member's session: the same model on the highest of the
 * member's own plans that is ready, in their order, when that ranks above the
 * plan it runs on now; the original ref when that is the plan it left. Only
 * their own plans (people/plans.ts readyAccounts), as nextAccount moves.
 */
function memberSwitchBack(engine: Engine, sessionId: string, member: string, model: string, ls: LimitSwitch): string | undefined {
  const plans = engine.access.plans;
  if (!plans?.readyAccounts) return undefined;
  const reg = engine.providersFor(member);
  const wireOf = (ref: string): string | undefined => {
    try {
      const r = reg.resolve(ref);
      return r.provider === PLAN_PROVIDER ? r.model : undefined;
    } catch {
      return undefined;
    }
  };
  const now = wireOf(model);
  if (!now) return undefined;
  const current = splitAccount(now).account;
  const left = splitAccount(wireOf(ls.from) ?? '').account;
  const bare = variantBase(splitAccount(now).model);
  const entry = plans.entry(member);
  for (const a of plans.readyAccounts(member, bare)) {
    // nothing above the plan it runs on has room
    if (a.prefix === current) return undefined;
    if (a.kind !== 'subscription' || !a.prefix) continue;
    const wire = `${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), bare) ?? bare)}`;
    const ref = a.prefix === left ? ls.from : `${PLAN_PROVIDER}/${wire}`;
    if ((a.prefix !== left && !entryServes(entry, wire)) || !memberCanUse(engine, member, ref)) continue;
    try {
      engine.updateSession(sessionId, { model: ref });
    } catch (e) {
      log.warn(`${sessionId}: could not go back to ${ref}: ${(e as Error).message}`);
      return undefined;
    }
    engine.patchMeta(sessionId, { limitSwitch: ref === ls.from ? undefined : { ...ls, to: ref } });
    engine.notice(sessionId, `Back on ${a.label}, its limit reset.`, 'info');
    forgetFallbackNotice(sessionId);
    log.info(`${sessionId}: back on ${ref} from ${model}`);
    return ref;
  }
  return undefined;
}

/**
 * At the start of a turn, for a session a usage-chain model fallback moved to
 * another model (meta.limitFallback): walk the owner's priority (the model it
 * left first, gated by its reset time or SWITCH_BACK_AFTER_MS, then the usage
 * fallback list models in config order above the current one, or the refusal
 * fallback list entries above it when the usage list is off), each via
 * readyRef on ready accounts in the owner's order (a provider the accounts do
 * not track keeps the ref as written); switch to the first ready
 * one with a notice, clearing limitFallback when it is the original model.
 * A manual pick clears the meta. A member's session walks the member's own
 * lists (usageListFor, refusalPlanFor) on their own plans (memberRoute).
 */
export function switchBackModel(engine: Engine, sessionId: string): string | undefined {
  const session = engine.repos.sessions.get(sessionId);
  const lf = session?.meta?.limitFallback as LimitSwitch | undefined;
  if (!session || !lf?.from || !lf.to) return undefined;
  if (session.model !== lf.to) {
    engine.patchMeta(sessionId, { limitFallback: undefined });
    return undefined;
  }
  // a member walks their own lists on their own plans (session/member-fallbacks.ts)
  const member = isMember(session.accountId) ? session.accountId! : undefined;
  const accounts = member ? undefined : accountsOf(engine);
  if (!member && !accounts) return undefined;
  const nowBare = variantBase(bareOf(engine, session.model, member) || bareModel(session.model));
  const fromBare = variantBase(bareOf(engine, lf.from, member) || bareModel(lf.from));
  if (!nowBare || !fromBare) return undefined;
  const t = Date.now();
  const canReturnToFrom = (lf.until !== undefined && t >= lf.until) || t - (lf.at ?? 0) >= SWITCH_BACK_AFTER_MS;
  const candidates: Array<{ model: string; isFrom: boolean; ref?: string }> = [];
  const seen = new Set<string>([nowBare]);
  if (canReturnToFrom && !seen.has(fromBare)) {
    seen.add(fromBare);
    candidates.push({ model: fromBare, isFrom: true, ref: lf.from });
  }
  const chain = usageListFor(engine, session.accountId);
  if (chain?.enabled === true && Array.isArray(chain.models)) {
    const list = chain.models.filter((r): r is string => typeof r === 'string' && r.includes('/'));
    const ids = list.map((r) => variantBase(bareModel(r)));
    const curIdx = ids.indexOf(nowBare);
    const stop = curIdx >= 0 ? curIdx : list.length;
    for (let i = 0; i < stop; i++) {
      const m = ids[i];
      if (!m || seen.has(m)) continue;
      if (m === fromBare && !canReturnToFrom) continue;
      seen.add(m);
      candidates.push({ model: m, isFrom: m === fromBare, ref: list[i] });
    }
  } else {
    // the refusal fallback list (models.refusalFallback) is the priority when the usage list is off: the entries above the current model
    const entries = refusalPlanFor(engine, session.accountId, engine.agentFor(session))?.entries ?? [];
    const targets = entries.map((e, i) => {
      const t = targetFor(engine, e, i);
      if (!t) return undefined;
      const wire = t.pin ? t.pin.model : t.ref.slice(t.ref.indexOf('/') + 1);
      return { t, m: variantBase(bareModel(wire)) };
    });
    const curIdx = targets.findIndex((x) => x?.m === nowBare);
    const stop = curIdx >= 0 ? curIdx : targets.length;
    for (let i = 0; i < stop; i++) {
      const x = targets[i];
      if (!x || !x.m || seen.has(x.m)) continue;
      if (x.m === fromBare && !canReturnToFrom) continue;
      if (!usable(engine, session, x.t)) continue;
      if (accounts) {
        // a plan or key that is paused or at a limit: an entry pinned to it is skipped, and so is a loose one when none of its vendor's is ready
        const ready = accounts.readyAccounts(x.m);
        if (x.t.pin?.account ? !ready.some((a) => a.id === x.t.pin!.account) : !!accounts.routeOf(x.m) && !ready.length) continue;
      }
      seen.add(x.m);
      candidates.push({ model: x.m, isFrom: x.m === fromBare, ref: x.t.ref });
    }
  }
  const ownerSession = { accountId: session.accountId ?? OWNER_ID };
  for (const c of candidates) {
    // readyRef walks the owner's account order; a model no account of the owner's tracks (limits.fallbacks naming another provider) keeps the ref as written
    const tracked = !!accounts && (!!accounts.readyAccounts(c.model).length || !!accounts.routeOf(c.model));
    const ref = member
      ? c.ref && memberRoute(engine, member, c.ref)
      : (readyRef(engine, ownerSession, c.model, []) ??
        (!tracked && c.ref && usable(engine, ownerSession, { index: -1, entry: { model: c.ref }, ref: c.ref, label: '' }) ? c.ref : undefined));
    if (!ref) continue;
    try {
      engine.updateSession(sessionId, { model: ref });
    } catch (e) {
      log.warn(`${sessionId}: could not go back to ${ref}: ${(e as Error).message}`);
      return undefined;
    }
    engine.patchMeta(sessionId, { limitFallback: c.isFrom ? undefined : { ...lf, to: ref } });
    engine.notice(sessionId, `Back on ${ref}, its limit reset.`, 'info');
    forgetFallbackNotice(sessionId);
    log.info(`${sessionId}: back on ${ref} from ${session.model}`);
    return ref;
  }
  return undefined;
}

/** Handler for the durable "session.resume" job. */
export async function resumeAfterReset(engine: Engine, payload: Record<string, unknown>): Promise<void> {
  const sessionId = String(payload.sessionId ?? '');
  const session = engine.repos.sessions.get(sessionId);
  if (!session || session.status !== 'waiting_reset') return;
  engine.notice(sessionId, 'Usage limit reset. Resuming.', 'success');
  const sub = await import('../engine/subagent');
  if (sub.waitsForParent(session)) return sub.resumeParkedSubagent(engine, session);
  engine.setStatus(sessionId, 'idle');
  const runner = engine.runnerFor(sessionId);
  await runner.enqueue({ text: engine.config.get().limits.resumePrompt }, { auto: true, resume: true });
}

/**
 * After a turn the runner drained (a message, not the resume job): a parked
 * Task or Delegate child that a message woke has run on. Unless that turn
 * parked it again, its resume job goes, it stops waiting for the reset, and
 * its report goes to the parent, which still waits for it.
 */
export async function afterWokenTurn(engine: Engine, sessionId: string): Promise<void> {
  const sub = await import('../engine/subagent');
  // read after the import: a next queued turn that already started reports when it ends
  const s = engine.repos.sessions.get(sessionId);
  if (!s || s.status === 'waiting_reset' || s.status === 'running' || !sub.waitsForParent(s)) return;
  engine.scheduler.cancel(`resume:${sessionId}`);
  engine.patchMeta(sessionId, { background: { ...(s.meta?.background as Record<string, unknown>), waitingReset: false } });
  const text = lastAssistantText(engine.repos.messages.list(sessionId));
  if (s.status === 'error') sub.deliverSubagentResult(engine, s.parentId!, sessionId, 'error', `${text}\n\nError: ${s.error ?? 'the turn failed'}`);
  else sub.deliverSubagentResult(engine, s.parentId!, sessionId, 'completed', text);
}
