import { createHash } from 'node:crypto';
import type { ToolResultBlock } from '../types';

/**
 * Tool-call loop guard: notices when the model repeats itself inside one user
 * turn. Pure and free of I/O; the runner feeds it each call and its result in
 * tool_use order and decides what a verdict does.
 *
 * A call's signature is the tool name plus a hash of its key-sorted input,
 * and its result is a hash of the result text, so three reads of different
 * files never look alike and a poll that keeps getting new output is fine.
 */

export type LoopCode = 'repeat' | 'cycle' | 'same_error' | 'denied' | 'frequency' | 'after_compaction';

export interface Verdict {
  level: 'ok' | 'warn' | 'halt';
  code?: LoopCode;
  message?: string;
}

export interface LoopGuardOptions {
  /** Nobody watches the turn (subagent, routine, loop mode). The runner uses it; the guard only records it. */
  unattended: boolean;
}

/** Same call and same result this many times in a row: warn, then halt. */
export const REPEAT_WARN = 3;
export const REPEAT_HALT = 5;
/** Same call failing with the same error this many times (progress in between resets it). */
export const SAME_ERROR_HALT = 3;
/** Laps of a cycle of 2 to 4 calls with identical results. */
export const CYCLE_WARN = 3;
export const CYCLE_HALT = 5;
/** Denied calls in a row (user, rule or hook). */
export const DENIED_HALT = 3;
/** Calls of one tool in a turn before a single warning. */
export const FREQUENCY_WARN = 60;
/** Calls watched after a compaction. */
export const COMPACTION_WINDOW = 3;

/** A successful call of these tools is progress: failure streaks start over. */
const PROGRESS_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Pollers: repeating them with the same result is how they work. */
const POLLERS = new Set(['BashOutput']);

interface Entry {
  tool: string;
  sig: string;
  res: string;
  error: boolean;
  denied: boolean;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Tool name plus a hash of the key-sorted input. */
export function callSignature(tool: string, input: unknown): string {
  return `${tool}:${sha(JSON.stringify(stable(input ?? {})) ?? '')}`;
}

/** Hash of a result's text. Stored-output ids differ on every call, so they are masked first. */
export function resultHash(result: Pick<ToolResultBlock, 'content' | 'isError'>): string {
  const text =
    typeof result.content === 'string'
      ? result.content
      : result.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  return sha(`${result.isError ? 'E' : 'O'}:${text.replace(/\bout_[0-9a-z]{12,}\b/g, 'out_*')}`);
}

const SEVERITY = { ok: 0, warn: 1, halt: 2 } as const;

function worst(a: Verdict, b: Verdict): Verdict {
  return SEVERITY[b.level] > SEVERITY[a.level] ? b : a;
}

export class LoopGuard {
  readonly unattended: boolean;
  private history: Entry[] = [];
  private perTool = new Map<string, number>();
  /** Per signature: the error hash it keeps failing with and how often. */
  private errorStreaks = new Map<string, { res: string; n: number }>();
  /** Signatures that already tripped a halt this turn. */
  private stopped = new Set<string>();
  private frequencyWarned = new Set<string>();
  private compactionWindowStart = -1;

  constructor(opts: LoopGuardOptions) {
    this.unattended = opts.unattended;
  }

  /** Refuse a call that already tripped a halt this turn (used when an interactive turn was warned and went on). */
  before(tool: string, input: unknown): Verdict {
    if (!this.stopped.has(callSignature(tool, input))) return { level: 'ok' };
    return {
      level: 'halt',
      code: 'repeat',
      message: `Not run: the loop guard already stopped this exact ${tool} call in this turn. Use a different approach, or stop and report what is blocking you.`,
    };
  }

  /** Watch the next calls closely: a model that lost context in a compaction tends to redo its last actions. */
  armAfterCompaction(): void {
    this.compactionWindowStart = this.history.length;
  }

  /** Mark a signature as stopped, so before() refuses it for the rest of the turn. */
  stop(tool: string, input: unknown): void {
    this.stopped.add(callSignature(tool, input));
  }

  after(tool: string, input: unknown, result: Pick<ToolResultBlock, 'content' | 'isError' | 'meta'>): Verdict {
    const entry: Entry = {
      tool,
      sig: callSignature(tool, input),
      res: resultHash(result),
      error: !!result.isError,
      denied: !!result.meta?.denied,
    };
    const prevSame = [...this.history].reverse().find((e) => e.sig === entry.sig);
    this.history.push(entry);
    let v: Verdict = { level: 'ok' };

    // progress: a successful edit, or a shell command whose output changed, starts failure streaks over
    const progress = !entry.error && (PROGRESS_TOOLS.has(tool) || (tool === 'Bash' && (!prevSame || prevSame.res !== entry.res)));
    if (progress) this.errorStreaks.clear();

    // the same call failing with the same error
    if (entry.error && !entry.denied) {
      const s = this.errorStreaks.get(entry.sig);
      const next = s && s.res === entry.res ? { res: entry.res, n: s.n + 1 } : { res: entry.res, n: 1 };
      this.errorStreaks.set(entry.sig, next);
      if (next.n >= SAME_ERROR_HALT) {
        v = worst(v, { level: 'halt', code: 'same_error', message: `${tool} failed with the same error ${next.n} times with the same input. Do not retry it unchanged.` });
      }
    } else if (!entry.error) {
      this.errorStreaks.delete(entry.sig);
    }

    // denials in a row
    let denied = 0;
    for (let i = this.history.length - 1; i >= 0 && this.history[i].denied; i--) denied++;
    if (denied >= DENIED_HALT) {
      v = worst(v, {
        level: 'halt',
        code: 'denied',
        message: `${denied} calls in a row were denied. Stop trying variants of the refused action; ask the user or report what you need.`,
      });
    }

    // repeats and cycles, over the calls that are not pollers
    if (!POLLERS.has(tool)) {
      const seq = this.history.filter((e) => !POLLERS.has(e.tool));
      let run = 0;
      for (let i = seq.length - 1; i >= 0 && seq[i].sig === entry.sig && seq[i].res === entry.res; i--) run++;
      if (run >= REPEAT_HALT) {
        v = worst(v, { level: 'halt', code: 'repeat', message: `${tool} was called with the same input ${run} times in a row and got the same result each time.` });
      } else if (run >= REPEAT_WARN) {
        v = worst(v, {
          level: 'warn',
          code: 'repeat',
          message: `You called ${tool} with the same input ${run} times in a row and got the same result each time. Do not call it again with this input; change your approach, or stop and report what is blocking you.`,
        });
      }
      if (run < 2) v = worst(v, this.cycle(seq));
    }

    // one tool used very often
    const count = (this.perTool.get(tool) ?? 0) + 1;
    this.perTool.set(tool, count);
    if (count > FREQUENCY_WARN && !this.frequencyWarned.has(tool)) {
      this.frequencyWarned.add(tool);
      v = worst(v, { level: 'warn', code: 'frequency', message: `You have called ${tool} ${count} times in this turn. Check that each call makes progress.` });
    }

    // right after a compaction, the same call three times
    if (this.compactionWindowStart >= 0) {
      const win = this.history.slice(this.compactionWindowStart);
      if (win.length >= COMPACTION_WINDOW) {
        const first = win[0];
        if (win.slice(0, COMPACTION_WINDOW).every((e) => e.sig === first.sig && e.res === first.res)) {
          v = worst(v, {
            level: 'halt',
            code: 'after_compaction',
            message: `After the context was compacted you repeated the same ${first.tool} call ${COMPACTION_WINDOW} times with the same result. Check the summary and the real state instead of redoing earlier actions.`,
          });
        }
        this.compactionWindowStart = -1;
      }
    }
    return v;
  }

  /** A cycle of 2 to 4 calls repeating with identical results at the end of seq. */
  private cycle(seq: Entry[]): Verdict {
    const same = (a: Entry, b: Entry) => a.sig === b.sig && a.res === b.res;
    let best: Verdict = { level: 'ok' };
    for (let p = 2; p <= 4; p++) {
      if (seq.length < p * CYCLE_WARN) continue;
      const tail = seq.slice(seq.length - p);
      // a block of one call repeated is a repeat, not a cycle
      if (tail.every((e) => same(e, tail[0]))) continue;
      let laps = 1;
      while (seq.length >= (laps + 1) * p) {
        const start = seq.length - (laps + 1) * p;
        if (!tail.every((e, i) => same(e, seq[start + i]))) break;
        laps++;
      }
      const tools = [...new Set(tail.map((e) => e.tool))].join(', ');
      if (laps >= CYCLE_HALT) {
        best = worst(best, { level: 'halt', code: 'cycle', message: `The same ${p} calls (${tools}) repeated ${laps} times with the same results.` });
      } else if (laps >= CYCLE_WARN) {
        best = worst(best, {
          level: 'warn',
          code: 'cycle',
          message: `You are repeating the same ${p} calls (${tools}) with the same results (${laps} rounds). Break the cycle: try a different approach, or stop and report what is blocking you.`,
        });
      }
    }
    return best;
  }
}
