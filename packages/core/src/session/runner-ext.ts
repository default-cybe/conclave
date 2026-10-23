/**
 * Extension points of the session runner (ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 6.1 item 9). Features register here from their own modules instead of
 * editing the loop in runner.ts:
 *
 * - beforeStep: before each model step (and before a harness turn). May park
 *   the session as waiting_input until something changes, or stop the turn.
 * - beforeTool: after the permission check, before a tool runs. May deny the
 *   call with a reason, or force an approval prompt.
 * - afterTool: may add to a tool's result (a note, meta).
 * - onStop: when the model ends a turn. A reminder keeps the loop going.
 * - onPathChange: the session's device or folder changed.
 * - toolContext: extra fields for each call's ToolContext (pathMap).
 * - tools: change a session's tool list (a workflow agent's StructuredOutput,
 *   the Workflow tool in Ultra). Called from engine.toolsFor.
 *
 * A failing extension is logged and skipped; it never fails the turn.
 */
import type { Session, SessionMode } from '../types';
import type { Tool, ToolContext, ToolOutput } from '../tools/types';
import { logger } from '../util/log';

const log = logger('runner-ext');

export interface StepContext {
  sessionId: string;
  session: Session;
  mode: SessionMode;
  /** Subagent depth (0 for the main session). */
  depth: number;
  /** Model step in this turn, from 0. */
  iter: number;
  signal: AbortSignal;
}

export interface StopContext extends StepContext {
  lastText: string;
  pending: readonly string[];
}

export type StepVerdict =
  /**
   * Park the session as waiting_input with this text. The turn waits for
   * `until`, then the runner asks again: 'resume' goes on, 'stop' ends the turn.
   */
  | { park: string; until: (signal: AbortSignal) => Promise<'resume' | 'stop'> }
  /** End the turn with this notice. */
  | { stop: string };

export interface ToolCallContext {
  sessionId: string;
  session: Session;
  tool: Tool;
  input: Record<string, unknown>;
  toolUseId: string;
  depth: number;
  readOnly: boolean;
  signal: AbortSignal;
}

export type ToolVerdict = { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string };

export interface PathChange {
  sessionId: string;
  from: { device: string; cwd: string };
  to: { device: string; cwd: string };
}

export interface RunnerExtension {
  name: string;
  beforeStep?(ctx: StepContext): Promise<StepVerdict | undefined | void> | StepVerdict | undefined | void;
  beforeTool?(ctx: ToolCallContext): Promise<ToolVerdict | undefined | void> | ToolVerdict | undefined | void;
  afterTool?(ctx: ToolCallContext, toolCtx: ToolContext, output: ToolOutput): Promise<ToolOutput | undefined | void> | ToolOutput | undefined | void;
  /**
   * Return a reminder to keep the model going, or nothing to let the turn end.
   * `pending` holds the reminders of extensions registered before this one in
   * the same stop (the verify gate's, for the regression gate).
   */
  onStop?(ctx: StopContext): Promise<string | undefined | void> | string | undefined | void;
  onPathChange?(change: PathChange): void;
  toolContext?(session: Session): Partial<Pick<ToolContext, 'pathMap'>> | undefined;
  /** Add tools to a session's list or take some away. Return nothing to leave it. */
  tools?(session: Session, tools: Tool[], depth: number): Tool[] | undefined | void;
}

export class RunnerExtensions {
  private list: RunnerExtension[] = [];

  /** Add an extension. Returns a function that removes it. A second one with the same name replaces the first. */
  register(ext: RunnerExtension): () => void {
    this.list = [...this.list.filter((e) => e.name !== ext.name), ext];
    return () => {
      this.list = this.list.filter((e) => e !== ext);
    };
  }

  get size(): number {
    return this.list.length;
  }

  /** The first extension with a verdict wins. */
  async beforeStep(ctx: StepContext): Promise<StepVerdict | undefined> {
    for (const e of this.list) {
      if (!e.beforeStep) continue;
      try {
        const v = await e.beforeStep(ctx);
        if (v) return v;
      } catch (err) {
        log.warn(`${e.name}.beforeStep failed`, err);
      }
    }
    return undefined;
  }

  /**
   * A deny from any extension wins over an ask. A check that throws is
   * skipped, except with failClosed (an untrusted session): then the call
   * asks, since the check that failed might have said no.
   */
  async beforeTool(ctx: ToolCallContext, opts: { failClosed?: boolean } = {}): Promise<ToolVerdict | undefined> {
    let ask: ToolVerdict | undefined;
    for (const e of this.list) {
      if (!e.beforeTool) continue;
      try {
        const v = await e.beforeTool(ctx);
        if (v?.decision === 'deny') return v;
        if (v?.decision === 'ask' && !ask) ask = v;
      } catch (err) {
        log.warn(`${e.name}.beforeTool failed`, err);
        if (opts.failClosed && !ask) ask = { decision: 'ask', reason: `The ${e.name} check failed` };
      }
    }
    return ask;
  }

  async afterTool(ctx: ToolCallContext, toolCtx: ToolContext, output: ToolOutput): Promise<ToolOutput> {
    let out = output;
    for (const e of this.list) {
      if (!e.afterTool) continue;
      try {
        out = (await e.afterTool(ctx, toolCtx, out)) ?? out;
      } catch (err) {
        log.warn(`${e.name}.afterTool failed`, err);
      }
    }
    return out;
  }

  /** Reminders from every extension that wants the turn to go on, in registration order. */
  async onStop(ctx: StepContext & { lastText: string }): Promise<string[]> {
    const out: string[] = [];
    for (const e of this.list) {
      if (!e.onStop) continue;
      try {
        const r = await e.onStop({ ...ctx, pending: [...out] });
        if (r) out.push(r);
      } catch (err) {
        log.warn(`${e.name}.onStop failed`, err);
      }
    }
    return out;
  }

  pathChanged(change: PathChange): void {
    for (const e of this.list) {
      try {
        e.onPathChange?.(change);
      } catch (err) {
        log.warn(`${e.name}.onPathChange failed`, err);
      }
    }
  }

  /** A session's tool list after every extension had its say. */
  toolList(session: Session, tools: Tool[], depth: number): Tool[] {
    let out = tools;
    for (const e of this.list) {
      if (!e.tools) continue;
      try {
        out = e.tools(session, out, depth) ?? out;
      } catch (err) {
        log.warn(`${e.name}.tools failed`, err);
      }
    }
    return out;
  }

  toolContext(session: Session): Partial<Pick<ToolContext, 'pathMap'>> {
    let out: Partial<Pick<ToolContext, 'pathMap'>> = {};
    for (const e of this.list) {
      if (!e.toolContext) continue;
      try {
        out = { ...out, ...(e.toolContext(session) ?? {}) };
      } catch (err) {
        log.warn(`${e.name}.toolContext failed`, err);
      }
    }
    return out;
  }
}
