import type { ProviderError } from '../providers/types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from './runner';
import { keepTurnBase } from './checkpoints';
import { activeMessages } from './transcript';
import { regionTokens } from './compaction';
import { SWITCH_BRIEF_AT } from '../modes/switch-math';
import { logger } from '../util/log';
import { accountsOf } from '../accounts/attached';
import { OWNER_ID, isMember } from '../people/context';
import { splitAccount } from '../providers/split';
import { shortModelName, targetFor, usable } from './refusal-fallback';
import { parseRefusalEntries } from './refusal-entries';
import { bareModel } from '../accounts/policy';

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
 * offers it, is not at a limit and can be called for this session. Owner
 * sessions only: the plans are the owner's. A plan without a prefix gets the
 * bare id; CLIProxyAPI gives it to the first ready plan in the same order.
 */
export function nextAccount(engine: Engine, sessionId: string, modelRef: string): { ref: string; account: string; from: string; to: string } | undefined {
  const accounts = accountsOf(engine);
  if (!accounts) return undefined;
  const session = engine.repos.sessions.get(sessionId);
  if (!session || isMember(session.accountId)) return undefined;
  const gw = accounts.gateway ?? 'cliproxy';
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
  const current = accounts.accountFor(gw, wireModel);
  for (const a of accounts.readyAccounts(bare)) {
    if (a.kind !== 'subscription' || a.id === current) continue;
    const wire = a.prefix ? `${a.prefix}/${bare}` : bare;
    const ref = `${gw}/${wire}`;
    if (!usable(engine, session, { index: -1, entry: { model: ref, account: a.id }, ref, pin: { provider: gw, model: wire, account: a.id }, label: '' })) continue;
    return { ref, account: a.id, from: `${name} (${(current && accounts.account(current)?.label) || prefix})`, to: `${name} (${a.label})` };
  }
  return undefined;
}

/**
 * Another model to run after `modelRef` hit its limit: the owner's
 * limits.fallbacks for it first, else the first entry of the owner's
 * refusal fallback list (models.refusalFallback) that the hub can call now,
 * is another model than the one at its limit, was not tried this turn, and
 * whose plan or key is not paused or at a limit. Owner only: both lists name
 * the owner's models and plans.
 */
export function limitFallback(engine: Engine, accountId: string | undefined, modelRef: string, tried: readonly string[] = []): string | undefined {
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
  const entries = parseRefusalEntries(cfg.models?.refusalFallback?.entries);
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
    // kept for the session, as a manual switch: later turns skip the plan at its limit
    if (engine.repos.sessions.get(sessionId)?.model === modelRef) {
      try {
        engine.updateSession(sessionId, { model: next.ref });
      } catch (e) {
        log.warn(`${sessionId}: could not keep ${next.ref}: ${(e as Error).message}`);
      }
    }
    log.info(`${sessionId}: ${modelRef} hit its limit; continuing on ${next.ref}`);
    return { fallback: next.ref };
  }

  const fallback = limitFallback(engine, engine.repos.sessions.get(sessionId)?.accountId, modelRef, tried);
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
