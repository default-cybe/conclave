import type { Session } from '../types';
import type { Engine } from '../engine/engine';
import { lastAssistantText } from '../session/transcript';
import { truncateMiddle } from '../util/text';

/**
 * Loop mode: after each assistant turn, run a check. If it passes, stop. If it
 * fails, feed the failure back as the next prompt so the model keeps going.
 * Guarded by a max iteration count stored on the session.
 */
export async function loopCheck(engine: Engine, session: Session, signal: AbortSignal): Promise<string | undefined> {
  const cfg = session.modeConfig?.loop;
  if (!cfg) return undefined;
  const state = (session.meta?.loop as { iteration?: number } | undefined) ?? {};
  const iteration = (state.iteration ?? 0) + 1;
  engine.patchMeta(session.id, { loop: { iteration } });
  if (iteration >= cfg.maxIterations) {
    engine.notice(session.id, `Loop stopped after ${iteration} iterations.`, 'warning');
    return undefined;
  }

  if (cfg.untilText) {
    const text = lastAssistantText(engine.repos.messages.list(session.id));
    if (text.includes(cfg.untilText)) {
      engine.notice(session.id, `Loop done: output contains "${cfg.untilText}".`, 'success');
      return undefined;
    }
    return `That phrase ("${cfg.untilText}") is not in your answer yet. Keep working toward the goal, then include it when done.`;
  }

  if (cfg.untilCommand) {
    const machine = engine.machineFor(session);
    engine.notice(session.id, `Running check: ${cfg.untilCommand}`, 'info');
    const res = await machine.exec(cfg.untilCommand, { cwd: session.cwd, timeoutMs: 600_000, signal });
    if ((res.exitCode ?? 1) === 0) {
      engine.notice(session.id, `Loop done: \`${cfg.untilCommand}\` passed.`, 'success');
      return undefined;
    }
    const out = truncateMiddle(`${res.stdout}\n${res.stderr}`.trim(), 8000, 'omitted').text;
    return `The check \`${cfg.untilCommand}\` still fails (exit ${res.exitCode}). Fix the cause and continue. Output:\n\n\`\`\`\n${out}\n\`\`\``;
  }

  return undefined;
}
