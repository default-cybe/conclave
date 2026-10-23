import type { ProviderError } from '../providers/types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from './runner';
import { keepTurnBase } from './checkpoints';
import { activeMessages } from './transcript';
import { regionTokens } from './compaction';
import { SWITCH_BRIEF_AT } from '../modes/switch-math';
import { logger } from '../util/log';

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
 * A long rate limit or quota window was hit. In order:
 * 1. If a fallback model is configured and usable, switch to it for this turn,
 *    unless the limit resets within a few minutes and the chat is big
 *    (waitInsteadOfFallback): then wait as in 2.
 * 2. Else if auto-resume is on and we know when it resets, park the session and
 *    schedule a durable resume job. The session continues on its own when the
 *    window reopens, even across a hub restart.
 * 3. Else surface the error.
 */
export async function handleLimit(engine: Engine, runner: SessionRunner, modelRef: string, err: ProviderError): Promise<LimitOutcome> {
  const cfg = engine.config.get();
  const sessionId = runner.id;
  const resetAt = err.resetAt ?? (err.retryAfterMs ? Date.now() + err.retryAfterMs : undefined);

  const fallbacks = cfg.limits.fallbacks[modelRef] ?? cfg.limits.fallbacks[engine.providers.resolve(modelRef).provider] ?? [];
  const fallback = fallbacks.find((fb) => fb !== modelRef && engine.isUsable(fb) && !engine.providers.resolve(fb).acp);
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
  engine.setStatus(sessionId, 'idle');
  const runner = engine.runnerFor(sessionId);
  await runner.enqueue({ text: engine.config.get().limits.resumePrompt }, { auto: true, resume: true });
}
