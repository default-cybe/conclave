/**
 * A session's running tasks (docs/design/CHAT-AND-MOTION.md 6.3): the work
 * it has going on its own, as the Claude app lists it above the composer
 * ("2 running tasks", RunningTasks.tsx). Worked out here on the client, from
 * the transcript, the store and the session's workflow runs; the hub has no
 * endpoint for it.
 *
 * - A workflow runs while its run is live (queued, running, paused, waiting
 *   for a limit). A Workflow call finds its run by the call's id on the run
 *   (toolUseId), by its result (meta.workflowRunId), or, for an older hub, as
 *   the newest live run of that name. A live run of the session that no call
 *   names (one started from the Workflows page for it) counts too.
 * - A subagent runs while its Task call has no result and the call runs (or
 *   the session is at work on it), and, started in the background (its
 *   result came at once, meta.background), while its own session is at work.
 *   A Delegate call (a Code or Assistant session on a device doing the job)
 *   is a subagent too, named by who does it and where.
 * - A task waits on you while an approval or a question of its own, or of a
 *   session under it, is open (lib/asks.ts): a subagent's by its session, a
 *   workflow's by its run.
 *
 * The rules are pure and tested (test/running-tasks.test.tsx).
 */
import { useMemo } from 'react';
import type { Message, Session, SessionStatus, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import type { WorkflowRun } from '@conclave/core/client';
import { useHub, type HubState, type ToolRun } from '@/store/store';
import { isLive, workflowName } from '@/features/workflows/words';
import { useSessionRuns } from '@/features/workflows/data';
import { workName } from './toolGroups';
import { runWaits, waitsIn, type Ask } from '@/lib/asks';

/** "1 running task", "2 running tasks": the same words on the web and on Android. */
export function tasksWord(n: number): string {
  return `${n} running ${n === 1 ? 'task' : 'tasks'}`;
}

const LIVE_SESSION: readonly SessionStatus[] = ['running', 'waiting_approval', 'waiting_input', 'waiting_reset', 'paused'];

/** The session is at work: a turn runs, waits on you, waits for a limit or is paused (it stays listed until Resume). */
export function sessionLive(status: SessionStatus | undefined): boolean {
  return !!status && LIVE_SESSION.includes(status);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** A Workflow or Task call of a session (a Delegate call counts as Task), with its result once it came. */
export interface TaskCall {
  kind: 'workflow' | 'subagent';
  tool: ToolUseBlock;
  result?: ToolResultBlock;
  /** When the message that made the call was created. */
  at: number;
}

/** The session's Workflow and Task calls in the order they were made, each with its result. */
export function taskCalls(messages: readonly Message[]): TaskCall[] {
  const out: TaskCall[] = [];
  const byId = new Map<string, TaskCall>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const name = workName(b.name, b.input);
        if (name !== 'Workflow' && name !== 'Task') continue;
        const c: TaskCall = { kind: name === 'Workflow' ? 'workflow' : 'subagent', tool: b, at: m.createdAt };
        out.push(c);
        byId.set(b.id, c);
      } else if (b.type === 'tool_result') {
        const c = byId.get(b.toolUseId);
        if (c) c.result = b;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export type SubagentState = 'running' | 'done' | 'failed' | 'pending';

/** A Task call's subagent: whether it runs, its session, when it started. */
export interface Subagent {
  /** pending: no result and nothing at work on it (an interrupted turn). */
  state: SubagentState;
  /** Its own session, when known: the result's meta.sessionId, else the session's child with its description as title. */
  childId?: string;
  startedAt?: number;
  /** Started with run_in_background: its result came at once and it works on in its own session. */
  background: boolean;
  /** "explore". */
  agent?: string;
  /** "Find the auth code". */
  description: string;
  /** A Delegate call: who does the job and where, "Code on MadX Arch". Rows say it in place of "Subagent explore". */
  handedTo?: string;
}

/** Where a Delegate call's job runs, from its result's or its session's meta.delegate (meta.movedFrom once the session moved to the main list). */
function placeOf(meta: Record<string, unknown> | undefined): { deviceName?: string; toolUseId?: string } | undefined {
  const d = meta?.delegate ?? meta?.movedFrom;
  return d && typeof d === 'object' ? (d as { deviceName?: string; toolUseId?: string }) : undefined;
}

/** A Delegate call: its label is the description, else the brief's first line (the hub titles its session the same, cut at 60). */
function delegateLabel(input: Record<string, unknown> | undefined): string {
  const first = (str(input?.prompt)?.trim().split(/\r\n|\n|\r/)[0] ?? '').trim();
  return str(input?.description)?.trim() || first || 'Delegated work';
}

/** The words before a subagent's description: "Subagent" and its agent, or who does a delegated job and where. */
export function subagentLead(s: Pick<Subagent, 'agent' | 'handedTo'>): { verb: string; who?: string } {
  return s.handedTo ? { verb: `${s.handedTo}:` } : { verb: 'Subagent', ...(s.agent ? { who: s.agent } : {}) };
}

export interface SubagentContext {
  /** The session that made the call. */
  sessionId: string;
  status?: SessionStatus;
  sessions: Record<string, Session>;
}

/** The subagent of a Task call, from its result, its run in the store and the sessions. */
export function subagentOf(call: { tool: ToolUseBlock; result?: ToolResultBlock; run?: ToolRun; at?: number }, ctx: SubagentContext): Subagent {
  const { tool } = call;
  const res = call.result ?? call.run?.result;
  const delegated = tool.name === 'Delegate';
  const description = delegated ? delegateLabel(tool.input) : (str(tool.input?.description) ?? 'Subagent');
  let childId = str(res?.meta?.sessionId);
  if (!childId) {
    // a delegated session carries the call's id; a subagent is titled with its description, cut at 60
    const mine = (s: Session) => (delegated && placeOf(s.meta)?.toolUseId === tool.id) || s.title === description || s.title === description.slice(0, 60);
    let newest: Session | undefined;
    for (const s of Object.values(ctx.sessions)) if (s.parentId === ctx.sessionId && mine(s) && (!newest || s.createdAt > newest.createdAt)) newest = s;
    childId = newest?.id;
  }
  const child = childId ? ctx.sessions[childId] : undefined;
  const background = !!res?.meta?.background;
  const agent = str(res?.meta?.agent) ?? str(tool.input?.subagent_type) ?? child?.agent ?? (delegated ? str(tool.input?.agent) : undefined);
  let handedTo: string | undefined;
  if (delegated) {
    const where = str(placeOf(res?.meta)?.deviceName) ?? str(placeOf(child?.meta)?.deviceName) ?? str(tool.input?.device);
    const who = str(tool.input?.to) === 'assistant' ? 'Assistant' : 'Code';
    handedTo = where ? `${who} on ${where}` : who;
  }
  const startedAt = call.run?.startedAt ?? child?.createdAt ?? call.at;
  let state: SubagentState;
  if (res && !(background && !res.isError)) state = res.isError ? 'failed' : 'done';
  else if (res) state = child && sessionLive(child.status) ? 'running' : 'done';
  else if (call.run?.status === 'running' || (child && sessionLive(child.status)) || sessionLive(ctx.status)) state = 'running';
  else state = 'pending';
  return { state, childId, startedAt, background, agent, description, ...(handedTo ? { handedTo } : {}) };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/**
 * The run a Workflow call started: the one its result names, else the one
 * that carries the call's id, else, while the call has no result, the newest
 * live run of the session by that name that no call claims (a hub from
 * before runs carried toolUseId). Undefined until it is known.
 */
export function runIdFor(tool: ToolUseBlock, result: ToolResultBlock | undefined, runs: readonly WorkflowRun[]): string | undefined {
  const named = str(result?.meta?.workflowRunId);
  if (named) return named;
  const own = runs.find((r) => r.toolUseId === tool.id);
  if (own) return own.id;
  if (result) return undefined;
  const name = str(tool.input?.name) || /name:\s*['"]/.test(String(tool.input?.script ?? '')) ? workflowName(tool.input) : undefined;
  return runs.find((r) => !r.toolUseId && !r.parentRunId && isLive(r.status) && (!name || r.name === name))?.id;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface RunningWorkflow {
  kind: 'workflow';
  key: string;
  /** The Workflow call that started it, if one in the transcript did. */
  toolUseId?: string;
  run: WorkflowRun;
  startedAt: number;
  /** One of its agents waits on you. */
  waiting: boolean;
}

export interface RunningSubagent extends Subagent {
  kind: 'subagent';
  key: string;
  toolUseId: string;
  startedAt: number;
  /** It, or a subagent under it, waits on you. */
  waiting: boolean;
}

export type RunningTask = RunningWorkflow | RunningSubagent;

export interface RunningInput {
  sessionId: string;
  status?: SessionStatus;
  calls: readonly TaskCall[];
  tools: Record<string, ToolRun>;
  sessions: Record<string, Session>;
  runs: readonly WorkflowRun[];
  /** The open approvals and questions. */
  asks?: readonly Ask[];
}

/** The subagents among the calls that run now. */
export function runningSubagents(input: Omit<RunningInput, 'runs'>): RunningSubagent[] {
  const out: RunningSubagent[] = [];
  for (const c of input.calls) {
    if (c.kind !== 'subagent') continue;
    const run = input.tools[c.tool.id];
    const res = c.result ?? run?.result;
    // a subagent that answered is over, unless it went on in the background
    if (res && (res.isError || !res.meta?.background)) continue;
    const s = subagentOf({ ...c, run }, input);
    const waiting = waitsIn(input.asks ?? [], s.childId) || (!!s.childId && ['waiting_approval', 'waiting_input'].includes(input.sessions[s.childId]?.status ?? ''));
    if (s.state === 'running') out.push({ ...s, kind: 'subagent', key: `t:${c.tool.id}`, toolUseId: c.tool.id, startedAt: s.startedAt ?? c.at, waiting });
  }
  return out;
}

/** The session's running tasks, the one started first first. */
export function runningTasks(input: RunningInput): RunningTask[] {
  const out: RunningTask[] = [];
  const claimed = new Map<string, string>();
  for (const c of input.calls) {
    if (c.kind !== 'workflow') continue;
    const id = runIdFor(c.tool, c.result, input.runs);
    if (id && !claimed.has(id)) claimed.set(id, c.tool.id);
  }
  for (const r of input.runs) {
    if (r.sessionId !== input.sessionId || r.parentRunId || !isLive(r.status)) continue;
    const toolUseId = claimed.get(r.id) ?? r.toolUseId;
    out.push({ kind: 'workflow', key: `w:${r.id}`, ...(toolUseId ? { toolUseId } : {}), run: r, startedAt: r.startedAt ?? r.createdAt, waiting: runWaits(input.asks ?? [], r.id) });
  }
  out.push(...runningSubagents(input));
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** The open approvals and questions, one list. */
export function openAsks(s: Pick<HubState, 'approvals' | 'questions'>): Ask[] {
  return [...Object.values(s.approvals), ...Object.values(s.questions)];
}

/** The subagents that run, and what waits on you, as one string, so the store's other events do not draw the list again. */
function subagentsKey(s: Pick<HubState, 'sessions' | 'tools' | 'approvals' | 'questions'>, sessionId: string, calls: readonly TaskCall[]): string {
  const asks = openAsks(s);
  // what waits on you changes a task's words, workflows' too
  const waiting = asks.map((a) => `${a.sessionId}>${a.from?.workflow?.runId ?? ''}`).join(',');
  if (!calls.some((c) => c.kind === 'subagent')) return waiting;
  return `${runningSubagents({ sessionId, status: s.sessions[sessionId]?.status, calls, tools: s.tools, sessions: s.sessions, asks })
    .map((t) => `${t.toolUseId}:${t.childId ?? ''}:${t.agent ?? ''}:${t.startedAt}:${t.waiting ? 1 : 0}`)
    .join(' ')}|${waiting}`;
}

/**
 * The session's running tasks, live: from its transcript and the store (a
 * subagent's call, result and session) and its workflow runs (asked for
 * once, then kept by the hub's events). No polling.
 */
export function useRunningTasks(sessionId: string): RunningTask[] {
  const messages = useHub((s) => s.messages[sessionId]);
  const calls = useMemo(() => taskCalls(messages ?? []), [messages]);
  const runs = useSessionRuns(sessionId);
  const key = useHub((s) => subagentsKey(s, sessionId, calls));
  return useMemo(() => {
    const s = useHub.getState();
    return runningTasks({ sessionId, status: s.sessions[sessionId]?.status, calls, tools: s.tools, sessions: s.sessions, runs, asks: openAsks(s) });
    // key: the subagents' state, read from the store above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, calls, runs, key]);
}
