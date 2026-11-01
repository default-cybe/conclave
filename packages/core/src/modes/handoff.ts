import type { Session } from '../types';
import type { Engine } from '../engine/engine';
import { maybeCompact } from '../session/compaction';
import { applyClearing } from '../session/context-edit';
import { estimateTokens } from '../util/text';
import { estimateSwitch, SWITCH_CLEAR_PROTECT_TOKENS } from './switch-cost';

/**
 * A switch: the model (or harness) that drives the session going forward
 * changes. A notice records it. The transcript builder drops the old model's
 * thinking and flattens tool calls the new model cannot express, and the
 * next turn tells the new model it took over (runner.ts switchNote).
 *
 * By default the new model reads the full history, exactly as before. A
 * short handover (opts.brief, the owner's choice) first summarizes the chat
 * with the existing compaction, so the new model reads the summary and the
 * recent turns, and clears old tool output down to SWITCH_CLEAR_PROTECT_TOKENS
 * in one batch. It runs only when the chat is over context.switchBriefAt and
 * the target is not cheap (switch-cost.ts); otherwise the switch keeps the
 * full history and says so. The stored messages stay; the summary shows like
 * any compaction summary.
 */
export interface SwitchOptions {
  brief?: boolean;
  signal?: AbortSignal;
}

/** What the handover summary must keep, given to the compaction as its instructions. */
export function briefInstructions(to: string): string {
  return `This summary is a handover: ${to} continues the work from it and the recent turns. Keep the goal, the decisions and why they were made, exact identifiers (paths, names, ids, commands, numbers), the open asks, and the next step.`;
}

function label(engine: Engine, ref: string): string {
  if (engine.isAgentRef(ref)) return ref;
  try {
    return engine.providers.resolve(ref).info.name || engine.displayModel(ref);
  } catch {
    return engine.displayModel(ref);
  }
}

export async function handoff(engine: Engine, session: Session, modelRef: string, opts: SwitchOptions = {}): Promise<Session> {
  if (!engine.isUsableRef(modelRef)) throw new Error(engine.harnessOff(modelRef) ?? `Model ${modelRef} is not available`);
  const from = session.model;
  if (modelRef === from) return session;
  const id = session.id;

  let summaryTokens: number | undefined;
  let cleared = 0;
  let kept = '';
  if (opts.brief) {
    const est = estimateSwitch(engine, session, modelRef);
    if (!est.brief) kept = ' with the full history (the chat is small or the new model is cheap, so a short handover would save little)';
    else if (engine.runnerFor(id).busy) kept = ' with the full history (a reply was running)';
    else {
      const signal = opts.signal ?? new AbortController().signal;
      const meta = { switch: { from, to: modelRef } };
      if (await maybeCompact(engine, id, modelRef, signal, 'manual', briefInstructions(label(engine, modelRef)), { meta, quiet: true })) {
        engine.runnerFor(id).markSessionStart('compact');
        const summary = [...engine.repos.messages.list(id)].reverse().find((m) => m.kind === 'summary');
        if (summary) summaryTokens = estimateTokens(summary.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
      }
      // the new model's cache is empty anyway, so clearing now costs no extra cache miss
      const cfg = engine.config.get();
      if (cfg.context.clearToolResultsAfterTurns !== 0) cleared = applyClearing(engine, id, { protectTokens: SWITCH_CLEAR_PROTECT_TOKENS, batchTokens: 0 });
    }
  }

  engine.updateSession(id, { model: modelRef });
  const brief = summaryTokens !== undefined || cleared > 0;
  if (opts.brief && !brief && !kept) kept = ' with the full history (there was too little to summarize)';
  const how = brief
    ? ` with a short handover: ${summaryTokens !== undefined ? `a ${Math.max(1, Math.round(summaryTokens / 1000))}K token summary and the recent turns` : 'the recent turns'}${cleared ? `, ${cleared} old tool ${cleared === 1 ? 'output' : 'outputs'} cleared` : ''}`
    : kept;
  engine.notice(id, `Switched from ${label(engine, from)} to ${label(engine, modelRef)}${how}.`, 'info', undefined, {
    type: 'switch',
    from,
    model: modelRef,
    ...(brief ? { brief: true } : {}),
    ...(summaryTokens !== undefined ? { summaryTokens } : {}),
    ...(cleared ? { cleared } : {}),
  });
  return engine.requireSession(id);
}
