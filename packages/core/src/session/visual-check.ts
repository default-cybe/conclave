/**
 * The visual check: a coding agent that changed UI should look at it before
 * it reports, as Claude Code does. When a main-session turn edited UI files
 * and looked at no image, one short reminder at stop asks it to take
 * screenshots and look at them, or to say why it cannot.
 *
 * - A UI edit is a successful Edit, MultiEdit or Write of a file the UI_FILE
 *   pattern below matches: web components and styles (.tsx .jsx .vue .svelte
 *   .css .scss .html .svg) and Jetpack Compose files (.kt under a ui/ folder).
 *   Edits through Bash are not seen.
 * - Looking at an image is any tool result in the turn that carries an image
 *   block and is not an error: a Read of a .png/.jpg/.webp/.gif, and
 *   browser_screenshot, both return one; so does an MCP screenshot tool.
 *   The order does not matter: a screenshot before the edit counts too.
 * - One reminder per user turn. The state lives on the turn's checkpoint
 *   object, as in the regression gate (session/regression-gate.ts), so a run
 *   resumed after a usage limit keeps it. The first stop of a turn with UI
 *   edits writes an audit row `visual.check` and a `visual.checked` event,
 *   outcome `looked` or `reminded`; a turn with no UI edit writes nothing.
 * - It runs in the onStop chain after the verify and regression gates, under
 *   the runner's cap on continuations (session/runner.ts STOP_BLOCK_CAP).
 * - On for agents whose profile lists the `visual-check` recipe (coder,
 *   builder, refactorer). The designer takes and reads its own screenshots,
 *   so it does not list it.
 * - Main sessions only: only the main session's own tool calls count. A
 *   subagent that changed UI answers to its own prompt; a designer subagent
 *   that did the UI work has looked, and its parent is not reminded.
 */
import type { Engine } from '../engine/engine';
import type { Session } from '../types';
import type { ToolOutput } from '../tools/types';
import type { RunnerExtension } from './runner-ext';
import type { TurnCheckpoint } from './checkpoints';
import { wantsVisualCheck } from '../extensions/agent-hooks';

export const VISUAL_REMINDER =
  'You changed UI files and have not looked at the result. Take screenshots at phone and desktop width (light and dark if the app has themes) and look at them with Read, then fix what looks wrong. If you cannot, say why.';

/** Files whose change shows on screen. */
export const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|html|svg)$|(^|\/)ui\/.*\.kt$/i;
/** Test files, which match UI_FILE by extension but show nothing (Button.test.tsx). */
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx$|(^|\/)(test|androidTest)\/.*\.kt$/;
/** Tools that write a file at input.file_path. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

interface CheckState {
  /** UI files the turn edited. */
  edited: string[];
  /** A tool result in the turn carried an image. */
  looked: boolean;
  /** The check already recorded this user turn (and reminded, unless it had looked). */
  done: boolean;
}

export function hasImage(output: ToolOutput): boolean {
  return !output.isError && Array.isArray(output.content) && output.content.some((b) => b.type === 'image');
}

export class VisualCheck {
  private states = new WeakMap<TurnCheckpoint, CheckState>();

  constructor(private engine: Engine) {}

  private state(turn: TurnCheckpoint): CheckState {
    let s = this.states.get(turn);
    if (!s) this.states.set(turn, (s = { edited: [], looked: false, done: false }));
    return s;
  }

  enabled(session: Session): boolean {
    if (session.kind === 'chat') return false;
    return wantsVisualCheck(this.engine.extensions.agent(session.agent, session.cwd));
  }

  /** A main-session tool finished: note a UI edit or an image it returned. */
  noteResult(session: Session, tool: string, input: Record<string, unknown>, output: ToolOutput): void {
    const turn = this.engine.runnerFor(session.id).turnCheckpoint;
    if (!turn || !this.enabled(session)) return;
    const s = this.state(turn);
    if (hasImage(output)) s.looked = true;
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (EDIT_TOOLS.has(tool) && !output.isError && UI_FILE.test(path) && !TEST_FILE.test(path) && !s.edited.includes(path)) s.edited.push(path);
  }

  /** The turn wants to end: the reminder when it edited UI and looked at no image, once per user turn. */
  check(session: Session, turn: TurnCheckpoint | undefined): string | undefined {
    if (!turn || !this.enabled(session)) return undefined;
    const s = this.states.get(turn);
    if (!s || !s.edited.length || s.done) return undefined;
    s.done = true;
    const outcome = s.looked ? 'looked' : 'reminded';
    const files = s.edited.slice(0, 10);
    const n = `${s.edited.length} UI file${s.edited.length === 1 ? '' : 's'} changed`;
    this.engine.audit(session.id, 'visual.check', `${outcome}: ${n}${s.looked ? '' : ', no image looked at'} (${files.join(', ')})`);
    this.engine.bus.emit({ type: 'visual.checked', sessionId: session.id, outcome, files, reminded: !s.looked });
    return s.looked ? undefined : VISUAL_REMINDER;
  }

  extension(): RunnerExtension {
    return {
      name: 'visual-check',
      afterTool: (ctx, _toolCtx, output) => {
        if (ctx.depth === 0) this.noteResult(ctx.session, ctx.tool.name, ctx.input, output);
      },
      // after the verify and regression gates: while one of them sends the agent back, wait for the next stop
      onStop: (ctx) => (ctx.depth === 0 && !ctx.pending.length ? this.check(ctx.session, this.engine.runnerFor(ctx.sessionId).turnCheckpoint) : undefined),
    };
  }
}

/** Make the check and register it with the runner, after the regression gate. */
export function attachVisualCheck(engine: Engine): VisualCheck {
  const check = new VisualCheck(engine);
  engine.runnerExtensions.register(check.extension());
  return check;
}
