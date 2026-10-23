/**
 * A turn's work, grouped (docs/design/CHAT-AND-MOTION.md 6.3). The thoughts
 * and calls between two pieces of prose are one stretch of work; two or more
 * of them fold into one summary row, "Thought for 15s, ran git log" or "Ran
 * 6 commands, read 2 files", that opens to the thoughts and calls in order.
 * A single call stays a row of its own and a lone thought stays as it is. A
 * workflow or a subagent (one compact row each that follows the work live,
 * as the Claude app shows them), a card (places and routes, a watch) or a
 * call that asks you something keeps its own row and splits the work around
 * it: those are never hidden in a fold.
 *
 * Pure, so the rules are tested (test/tool-groups.test.tsx). The words are in
 * lib/toolLine.ts (workSummary, groupSummary).
 */

/** One step of a turn's work, in the order it ran: a call, or a thought. */
export type WorkEntry<C, T> = { type: 'call'; name: string; item: C } | { type: 'thought'; item: T };

export type Segment<C, T> =
  /** A call on its own row: a single call, or a card. */
  | { kind: 'one'; item: C }
  /** A lone thought, as it is. */
  | { kind: 'thought'; item: T }
  /** Two or more thoughts and calls in a row, as one summary row. */
  | { kind: 'group'; entries: WorkEntry<C, T>[] };

/** Calls that are background work, cards or that need you: they keep a row of their own. */
const ALONE = new Set(['Workflow', 'Task', 'AskUserQuestion', 'PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage', 'WatchReport', 'WatchCreate']);

/**
 * The name a call groups and draws by. A tool another server or a harness
 * hands on keeps its row or card: "mcp__conclave__Workflow" is Workflow.
 * A call a harness only titled (no tool name, "Tool") whose input is a
 * workflow script is Workflow too, and Claude Code's "Agent" with a
 * subagent's input is Task. Delegate (a Code or Assistant session on a
 * device doing a job) draws as a subagent: Task.
 */
export function workName(name: string, input?: Record<string, unknown>): string {
  if (name === 'Delegate') return 'Task';
  if (name.startsWith('mcp__')) {
    const base = name.split('__').slice(2).join('__');
    if (ALONE.has(base)) return base;
  }
  if (/^workflow$/i.test(name)) return 'Workflow';
  if (name === 'Tool' && typeof input?.script === 'string' && /export\s+const\s+meta\b/.test(input.script)) return 'Workflow';
  if (name === 'Agent' && input && (typeof input.subagent_type === 'string' || (typeof input.description === 'string' && typeof input.prompt === 'string'))) return 'Task';
  return name;
}

/** A call that never folds into a group. */
export function standsAlone(name: string): boolean {
  return ALONE.has(workName(name));
}

/** Split a stretch of work into rows, groups and lone thoughts, keeping the order. */
export function segment<C, T>(entries: readonly WorkEntry<C, T>[]): Segment<C, T>[] {
  const out: Segment<C, T>[] = [];
  let run: WorkEntry<C, T>[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'group', entries: run });
    else if (run.length === 1) out.push(run[0].type === 'call' ? { kind: 'one', item: run[0].item } : { kind: 'thought', item: run[0].item });
    run = [];
  };
  for (const e of entries) {
    if (e.type === 'call' && standsAlone(e.name)) {
      flush();
      out.push({ kind: 'one', item: e.item });
    } else run.push(e);
  }
  flush();
  return out;
}

export type CallStatus = 'running' | 'done' | 'failed' | 'denied' | 'waiting' | 'pending';

/** What a group's summary row says at its right: the state of its calls, in one place. */
export interface GroupState {
  /** waiting: a call asks you. running: a call runs. failed: one or more failed. done: the rest. */
  state: 'waiting' | 'running' | 'failed' | 'done';
  failed: number;
  denied: number;
}

export function groupState(statuses: readonly CallStatus[]): GroupState {
  let failed = 0;
  let denied = 0;
  let running = false;
  let waiting = false;
  for (const s of statuses) {
    if (s === 'failed') failed++;
    else if (s === 'denied') denied++;
    else if (s === 'running') running = true;
    else if (s === 'waiting') waiting = true;
  }
  return { state: waiting ? 'waiting' : running ? 'running' : failed ? 'failed' : 'done', failed, denied };
}

/** "1 failed", "2 failed, 1 denied", "1 denied"; empty when nothing went wrong. */
export function troubleWords(g: Pick<GroupState, 'failed' | 'denied'>): string {
  const parts: string[] = [];
  if (g.failed) parts.push(`${g.failed} failed`);
  if (g.denied) parts.push(`${g.denied} denied`);
  return parts.join(', ');
}

/**
 * Calls of a closed group that stay in view under its summary: any that waits
 * on you. The one running now is the summary's own words while the turn works
 * (ToolRows.tsx groupNow), as on Android.
 */
export function pinned(status: CallStatus): boolean {
  return status === 'waiting';
}
