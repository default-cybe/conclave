/**
 * The stuck watch (alerts/service.ts feeds it the event stream). Pure: it
 * keeps one entry per running turn and says when a turn looks stuck.
 *
 * - idle: no progress (streamed text, a tool call starting or ending) for
 *   longer than the threshold. A tool that still runs inside its own time
 *   limit is working, not stuck. Waiting on the owner (an approval, a
 *   question) is not stuck either, and the clock starts over when the turn
 *   runs again.
 * - loop: the same tool failed with the same error LOOP_FAILURES times in a
 *   row in one turn.
 *
 * Keep waiting doubles the threshold (or the failure count) for the rest of
 * the turn, and the doubled wait counts from the answer, so an owner who
 * answers late is not asked again at once. A flag clears itself when
 * progress comes (for a loop: another outcome) or the turn ends.
 */

export const DEFAULT_STUCK_MINUTES = 5;
export const LOOP_FAILURES = 3;

export type StuckReason = 'idle' | 'loop';

export interface IdleVerdict {
  sessionId: string;
  /** When the last progress came. */
  since: number;
  /** The threshold in force. */
  thresholdMs: number;
}

export interface LoopVerdict {
  sessionId: string;
  /** When the first failure of the run came. */
  since: number;
  tool: string;
  error: string;
  count: number;
}

interface RunningTool {
  name: string;
  startedAt: number;
  /** The tool's own time limit in ms: 0 when it has none, Infinity when it waits on other work (a subagent). */
  limitMs: number;
}

interface Turn {
  model: string;
  lastProgress: number;
  /** The last Keep waiting: the quiet time counts from here when it is later than the last progress. */
  waitFrom: number;
  /** Waiting on the owner. */
  paused: boolean;
  idleMult: number;
  loopMult: number;
  tools: Map<string, RunningTool>;
  fail?: { key: string; tool: string; error: string; count: number; since: number };
  idle?: { since: number };
  loop?: { since: number };
}

export class StuckWatch {
  private turns = new Map<string, Turn>();

  /** The session runs: a turn started, or it came back from waiting on the owner. */
  running(sessionId: string, model: string, at: number): void {
    const t = this.turns.get(sessionId);
    if (!t) {
      this.turns.set(sessionId, { model, lastProgress: at, waitFrom: 0, paused: false, idleMult: 1, loopMult: 1, tools: new Map() });
      return;
    }
    t.model = model;
    if (t.paused) {
      t.paused = false;
      t.lastProgress = at;
    }
  }

  /** The session waits on the owner. Returns true when that cleared an idle flag. */
  pause(sessionId: string): boolean {
    const t = this.turns.get(sessionId);
    if (!t) return false;
    t.paused = true;
    const had = !!t.idle;
    t.idle = undefined;
    return had;
  }

  /** The turn ended (or the session went away). Returns the flags it had. */
  end(sessionId: string): StuckReason[] {
    const t = this.turns.get(sessionId);
    if (!t) return [];
    this.turns.delete(sessionId);
    return [...(t.idle ? (['idle'] as const) : []), ...(t.loop ? (['loop'] as const) : [])];
  }

  has(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  /** Streamed text, or a tool call starting or ending. Returns true when that cleared an idle flag. */
  progress(sessionId: string, at: number): boolean {
    const t = this.turns.get(sessionId);
    if (!t) return false;
    t.lastProgress = Math.max(t.lastProgress, at);
    const had = !!t.idle;
    t.idle = undefined;
    return had;
  }

  toolStarted(sessionId: string, toolUseId: string, name: string, limitMs: number, at: number): void {
    this.turns.get(sessionId)?.tools.set(toolUseId, { name, startedAt: at, limitMs });
  }

  /** A call ended. Returns its tool's name when the watch saw it start. */
  toolEnded(sessionId: string, toolUseId: string): string | undefined {
    const t = this.turns.get(sessionId);
    const tool = t?.tools.get(toolUseId);
    t?.tools.delete(toolUseId);
    return tool?.name;
  }

  /**
   * A call failed. The same tool and error again counts up; anything else
   * starts a new run. Returns a verdict when the run reaches the limit, and
   * cleared when a loop flag went because the outcome changed.
   */
  failure(sessionId: string, tool: string, error: string, at: number): { loop?: LoopVerdict; cleared?: boolean } {
    const t = this.turns.get(sessionId);
    if (!t) return {};
    const key = `${tool}\n${error}`;
    let cleared = false;
    if (t.fail?.key === key) t.fail.count++;
    else {
      cleared = !!t.loop;
      t.loop = undefined;
      t.fail = { key, tool, error, count: 1, since: at };
    }
    if (!t.loop && t.fail.count >= LOOP_FAILURES * t.loopMult) {
      t.loop = { since: t.fail.since };
      return { loop: { sessionId, since: t.fail.since, tool, error, count: t.fail.count }, cleared };
    }
    return { cleared };
  }

  /** A call succeeded: the run of failures is over. Returns true when that cleared a loop flag. */
  success(sessionId: string): boolean {
    const t = this.turns.get(sessionId);
    if (!t) return false;
    t.fail = undefined;
    const had = !!t.loop;
    t.loop = undefined;
    return had;
  }

  /** Turns that went quiet past their threshold since the last check. thresholdOf gives ms for a model, 0 for off. */
  check(now: number, thresholdOf: (model: string) => number): IdleVerdict[] {
    const out: IdleVerdict[] = [];
    for (const [sessionId, t] of this.turns) {
      if (t.paused || t.idle) continue;
      const limit = thresholdOf(t.model) * t.idleMult;
      if (!(limit > 0) || now - Math.max(t.lastProgress, t.waitFrom) <= limit) continue;
      // a tool inside its own time limit is working, not stuck
      if ([...t.tools.values()].some((x) => now - x.startedAt < x.limitMs)) continue;
      t.idle = { since: t.lastProgress };
      out.push({ sessionId, since: t.lastProgress, thresholdMs: limit });
    }
    return out;
  }

  /** Keep waiting at `at`: the threshold (or the failure count) doubles for the rest of the turn, and the flag goes. */
  keepWaiting(sessionId: string, reason: StuckReason, at: number): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    if (reason === 'idle') {
      t.idleMult *= 2;
      t.waitFrom = at;
      t.idle = undefined;
    } else {
      t.loopMult *= 2;
      t.loop = undefined;
    }
  }

  /** Sessions flagged now, with since when. */
  flags(): Array<{ sessionId: string; reason: StuckReason; since: number }> {
    const out: Array<{ sessionId: string; reason: StuckReason; since: number }> = [];
    for (const [sessionId, t] of this.turns) {
      if (t.idle) out.push({ sessionId, reason: 'idle', since: t.idle.since });
      if (t.loop) out.push({ sessionId, reason: 'loop', since: t.loop.since });
    }
    return out;
  }
}
