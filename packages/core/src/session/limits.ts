import type { ProviderError } from '../providers/types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from './runner';
import { keepTurnBase } from './checkpoints';
import { activeMessages, lastAssistantText } from './transcript';
import { regionTokens } from './compaction';
import { SWITCH_BRIEF_AT } from '../modes/switch-math';
import { logger } from '../util/log';
import { accountsOf } from '../accounts/attached';
import { OWNER_ID, isMember } from '../people/context';
import { splitAccount } from '../providers/split';
import { refusalPlan, shortModelName, targetFor, usable } from './refusal-fallback';
import { bareModel, ownModel } from '../accounts/policy';
import { variantBase } from '../providers/model-id';
import { forgetFallbackNotice } from './stream';
import { PLAN_PROVIDER, entryServes } from '../people/plans';
import type { AgentDef } from '../extensions/types';

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
 */
export function nextAccount(engine: Engine, sessionId: string, modelRef: string): { ref: string; account: string; from: string; to: string } | undefined {
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
  // an id without a prefix: CLIProxyAPI already moves it between plans
  if (!prefix) return undefined;
  // the plan's own name for the bare id (GPT-6.1-Sol), as the pickers show it
  let name = bare;
  try {
    name = shortModelName(engine.registryFor(session).resolveAt(gw, bare).info.name);
  } catch {
    /* not listed bare: its id is its name */
  }
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
  const current = accounts!.accountFor(gw, wireModel);
  for (const a of accounts!.readyAccounts(bare)) {
    if (a.kind !== 'subscription' || a.id === current) continue;
    const own = bareModel(ownModel((a.models ?? []).map((m) => m.id), bare) ?? bare);
    const wire = a.prefix ? `${a.prefix}/${own}` : own;
    const ref = `${gw}/${wire}`;
    if (!usable(engine, session, { index: -1, entry: { model: ref, account: a.id }, ref, pin: { provider: gw, model: wire, account: a.id }, label: '' })) continue;
    return { ref, account: a.id, from: `${name} (${(current && accounts!.account(current)?.label) || prefix})`, to: `${name} (${a.label})` };
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
 * fallback off. Owner only: both lists name the owner's models and plans.
 * With the usage fallback on (models.limitFallback), its list replaces the
 * refusal list here (usageChainFallback); an agent with the refusal fallback
 * off still gets no other model.
 */
export function limitFallback(engine: Engine, accountId: string | undefined, modelRef: string, tried: readonly string[] = [], agent?: Pick<AgentDef, 'refusalFallback'>): string | undefined {
  const cfg = engine.config.get();
  let resolved;
  try {
    resolved = engine.providers.resolve(modelRef);
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
  const configured = fallbacks.find((fb) => fb !== modelRef && !tried.includes(fb) && engine.isUsable(fb) && !engine.providers.resolve(fb).acp);
  if (configured || isMember(accountId)) return configured;
  const accounts = accountsOf(engine);
  const session = { accountId: accountId ?? OWNER_ID };
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
 * The usage fallback list (models.limitFallback): the models after the one at
 * its limit (by bare id; from the top when it is not listed), each on the
 * first ready plan or key of its own account order. A model tried this turn,
 * one with no ready account, or one the hub cannot call now is skipped.
 */
function usageChainFallback(engine: Engine, session: { accountId: string }, bare: string, refs: readonly unknown[], skip: Set<string>, tried: readonly string[]): string | undefined {
  const list = refs.filter((r): r is string => typeof r === 'string' && r.includes('/'));
  const ids = list.map((r) => bareModel(r));
  const accounts = accountsOf(engine);
  const gw = accounts?.gateway ?? 'cliproxy';
  for (let i = ids.indexOf(bare) + 1; i < list.length; i++) {
    const model = ids[i];
    if (skip.has(model)) continue;
    const ready = accounts ? accounts.readyAccounts(model) : [];
    for (const a of ready) {
      const p = a.kind === 'api' ? a.provider : gw;
      if (!p) continue;
      // a plan gets its own id (Antigravity lists claude-opus-5-5-high), as nextAccount sends
      const wire = a.kind === 'subscription' && a.prefix ? `${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), model) ?? model)}` : model;
      const ref = `${p}/${wire}`;
      if (tried.includes(ref) || !usable(engine, session, { index: -1, entry: { model: ref, account: a.id }, ref, pin: { provider: p, model: wire, account: a.id }, label: '' })) continue;
      return ref;
    }
    // no account order for it (a key the accounts do not track): the ref as written
    if (!ready.length && !accounts?.routeOf(model) && !tried.includes(list[i]) && usable(engine, session, { index: -1, entry: { model: list[i] }, ref: list[i], label: '' })) return list[i];
  }
  return undefined;
}

/** A ref's model id without provider or account prefix; '' when it does not resolve. */
function bareOf(engine: Engine, ref: string): string {
  try {
    return bareModel(engine.providers.resolve(ref).model);
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
export async function handleLimit(engine: Engine, runner: SessionRunner, modelRef: string, err: ProviderError, tried: readonly string[] = []): Promise<LimitOutcome> {
  const cfg = engine.config.get();
  const sessionId = runner.id;
  const resetAt = err.resetAt ?? (err.retryAfterMs ? Date.now() + err.retryAfterMs : undefined);

  const next = nextAccount(engine, sessionId, modelRef);
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

  const session = engine.repos.sessions.get(sessionId);
  const fallback = limitFallback(engine, session?.accountId, modelRef, tried, session ? engine.agentFor(session) : undefined);
  if (fallback) {
    const wait = waitInsteadOfFallback({
      enabled: cfg.limits.waitShortResets,
      autoResume: cfg.limits.autoResume,
      resetInMs: resetAt === undefined ? undefined : Math.max(0, resetAt - Date.now()),
      chatTokens: regionTokens(activeMessages(engine.repos.messages.list(sessionId))),
      bigTokens: cfg.context.switchBriefAt,
    });
    if (!wait) {
      engine.notice(sessionId, `${modelRef} hit its limit. Falling back to ${fallback} for this turn.`, 'warning');
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
 * failover. Owner only, as nextAccount.
 */
export function switchBack(engine: Engine, sessionId: string): string | undefined {
  const session = engine.repos.sessions.get(sessionId);
  const ls = session?.meta?.limitSwitch as LimitSwitch | undefined;
  if (!session || !ls?.from || !ls.to) return undefined;
  if (session.model !== ls.to) {
    engine.patchMeta(sessionId, { limitSwitch: undefined });
    return undefined;
  }
  const accounts = accountsOf(engine);
  if (!accounts || isMember(session.accountId)) return undefined;
  // the first plan's reset passed, or a while went by since the failover
  const t = Date.now();
  if (!((ls.until !== undefined && t >= ls.until) || t - (ls.at ?? 0) >= SWITCH_BACK_AFTER_MS)) return undefined;
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
  const left = from ? accounts.accountFor(gw, from) : undefined;
  for (const a of accounts.readyAccounts(bare)) {
    // nothing above the plan it runs on has room
    if (a.id === current) return undefined;
    if (a.kind !== 'subscription') continue;
    const ref = a.id === left ? ls.from : a.prefix ? `${gw}/${a.prefix}/${bareModel(ownModel((a.models ?? []).map((m) => m.id), bare) ?? bare)}` : undefined;
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
