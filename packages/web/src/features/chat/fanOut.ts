/**
 * One fan-out as one card (FanOutCard.tsx). The Task and Delegate calls of
 * one assistant message are one card, keyed by that message's id; each call
 * is a line. What arrives later about one of its subagents is folded into
 * its line instead of drawing a row of its own:
 *
 * - the hub's agent-result notice ("Background task finished") and the
 *   report the hub hands the model, matched by the subagent's session id;
 * - TaskWait, TaskList, TaskResult and TaskContinue calls whose task ids all
 *   belong to cards (a TaskResult's text is the report, a TaskContinue starts
 *   round 2 of that line);
 * - for a Workflow call: WorkflowStatus calls about its run and its
 *   workflow_result notice.
 *
 * A notice with prose or a message of yours between it and its card is not
 * hidden: it stays as a small "updated" line where it arrived, so the order
 * of the chat still reads. Pure and cached per messages array, so every row
 * that asks shares one pass (test/fan-out.test.tsx).
 */
import type { Message } from '@conclave/core/types';
import { workName } from './toolGroups';
import { noticeResult, resultsIn, type AgentResultRef } from './agentResult';
import { isContextOnly, isToolResultOnly, resultText } from './util';

/** The background task tools: they read or steer a card's subagents. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskWait', 'TaskList', 'TaskResult', 'TaskContinue']);

/** What the transcript says about one subagent of a card, past its Task call. */
export interface ChildNews {
  /** The card: the id of the assistant message that made the Task call. */
  card: string;
  /** The Task call. */
  toolId: string;
  label: string;
  /** How its latest round ended, once the hub said so. */
  state?: AgentResultRef['state'];
  /** Its latest report. */
  report?: string;
  /** When its latest round ended (the notice's time). */
  finishedAt?: number;
  /** 1, then 2 after a TaskContinue, and so on. */
  round: number;
  /** Prose or messages of yours seen when the card was made. */
  breaks: number;
}

export interface FanOutIndex {
  /** By the subagent's session id. */
  byChild: Map<string, ChildNews>;
  /** By the Task call's id. */
  byTool: Map<string, ChildNews>;
  /** Calls a card draws: never a row of their own. */
  folded: Set<string>;
  /** Notice ids a card draws: hide, or a small "updated" line where it arrived. */
  notices: Map<string, { mode: 'hide' | 'updated'; toolId: string; label: string; state: AgentResultRef['state'] }>;
}

const SES = /\bses_[A-Za-z0-9_-]+/g;
/** A foreground Task that hit a usage limit (core engine/subagent.ts): no answer yet. */
const LIMITED = /^Subagent \S+ hit a usage limit/;
/** The hub's stand-in when a subagent ended with no answer: the line says why instead. */
const NO_ANSWER = /^\(the subagent produced no final answer\)$/i;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The task ids a task tool call is about: its input, else the ids its result lists. */
function taskIds(input: Record<string, unknown> | undefined, result: string | undefined): string[] {
  const own = [str(input?.id), ...(Array.isArray(input?.ids) ? input.ids : [])].filter((v): v is string => typeof v === 'string' && !!v);
  if (own.length) return own;
  return result ? [...new Set(result.match(SES) ?? [])] : [];
}

const cache = new WeakMap<readonly Message[], FanOutIndex>();

export function fanOutIndex(messages: readonly Message[]): FanOutIndex {
  const hit = cache.get(messages);
  if (hit) return hit;
  const idx: FanOutIndex = { byChild: new Map(), byTool: new Map(), folded: new Set(), notices: new Map() };
  const task = new Map<string, { name: string; input?: Record<string, unknown>; result?: string; done: boolean }>();
  const workflows = new Map<string, { breaks: number; label: string }>(); // Workflow call id
  const runs = new Map<string, string>(); // run id -> Workflow call id
  const statusCalls: Array<{ id: string; input?: Record<string, unknown>; run?: string }> = [];
  let breaks = 0;

  for (const m of messages) {
    if (m.kind === 'notice') {
      const ref = noticeResult(m);
      if (!ref?.id) continue;
      const kid = ref.type === 'subagent' ? idx.byChild.get(ref.id) : undefined;
      const wf = ref.type === 'workflow' ? runs.get(ref.id) : undefined;
      if (kid) {
        kid.state = ref.state;
        kid.finishedAt = m.createdAt;
        idx.notices.set(m.id, { mode: breaks > kid.breaks ? 'updated' : 'hide', toolId: kid.toolId, label: kid.label, state: ref.state });
      } else if (wf) {
        idx.notices.set(m.id, { mode: breaks > workflows.get(wf)!.breaks ? 'updated' : 'hide', toolId: wf, label: ref.label, state: ref.state });
      }
      continue;
    }
    if (m.role === 'user') {
      if (!isToolResultOnly(m) && !isContextOnly(m)) breaks++;
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const kid = idx.byTool.get(b.toolUseId);
        if (kid) {
          const child = str(b.meta?.sessionId);
          if (child) idx.byChild.set(child, kid);
          const text = resultText(b).trim();
          if (LIMITED.test(text)) kid.state = 'limited';
          else if (!b.meta?.background && text) kid.report = text;
          continue;
        }
        const wf = workflows.has(b.toolUseId) ? str(b.meta?.workflowRunId) : undefined;
        if (wf) runs.set(wf, b.toolUseId);
        const t = task.get(b.toolUseId);
        if (t) {
          t.result = resultText(b);
          t.done = true;
          const kid = t.name === 'TaskResult' && !b.isError ? idx.byChild.get(str(t.input?.id) ?? '') : undefined;
          if (kid) kid.report = t.result.trim();
        }
        const s = statusCalls.find((c) => c.id === b.toolUseId);
        if (s) s.run = str(b.meta?.workflowRunId);
      }
      // the reports the hub handed the model: the latest for each child
      for (const r of resultsIn(m)) {
        const kid = r.type === 'subagent' ? idx.byChild.get(r.id) : undefined;
        if (kid && r.report && !NO_ANSWER.test(r.report)) kid.report = r.report;
      }
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) breaks++;
      if (b.type !== 'tool_use') continue;
      const name = workName(b.name, b.input);
      if (name === 'Task') {
        const news: ChildNews = { card: m.id, toolId: b.id, label: str(b.input?.description) ?? str(b.input?.subagent_type) ?? 'Subagent', round: 1, breaks };
        idx.byTool.set(b.id, news);
      } else if (name === 'Workflow') workflows.set(b.id, { breaks, label: str(b.input?.name) ?? 'workflow' });
      else if (name === 'WorkflowStatus') statusCalls.push({ id: b.id, input: b.input });
      else if (TASK_TOOLS.has(name)) {
        task.set(b.id, { name, input: b.input, done: false });
        // a new round: the last one's ending no longer holds
        const kid = name === 'TaskContinue' ? idx.byChild.get(str(b.input?.id) ?? '') : undefined;
        if (kid) {
          kid.round++;
          kid.state = undefined;
          kid.finishedAt = undefined;
        }
      }
    }
  }

  for (const [id, t] of task) {
    const ids = taskIds(t.input, t.result);
    // a TaskWait or TaskList for all tasks still running: about the cards there are
    const fold = ids.length ? ids.every((i) => idx.byChild.has(i)) : !t.done && idx.byChild.size > 0;
    if (fold) idx.folded.add(id);
  }
  for (const s of statusCalls) {
    const run = str(s.input?.runId) ?? s.run;
    // no run named: the session's newest run, a card's when the session started one
    if (run ? runs.has(run) : workflows.size > 0) idx.folded.add(s.id);
  }
  cache.set(messages, idx);
  return idx;
}

/** A card line's state: the hub's word on its latest round, else what the call and the child's session say. */
export type LineState = 'running' | 'done' | 'failed' | 'limited' | 'pending';

export function lineState(live: 'running' | 'done' | 'failed' | 'pending', news: Pick<ChildNews, 'state'> | undefined): LineState {
  const s = news?.state;
  if (s === 'limited') return 'limited';
  if (s === 'failed' || s === 'stopped') return 'failed';
  if (s === 'completed') return 'done';
  return live;
}

/** "4 subagents, 2 running, 1 failed, 1 stopped at a limit": the card's header. */
export function fanOutWords(states: readonly LineState[]): string {
  const n = (s: LineState) => states.filter((x) => x === s).length;
  const running = n('running');
  return [
    `${states.length} ${states.length === 1 ? 'subagent' : 'subagents'}`,
    running ? `${running} running` : '',
    n('failed') ? `${n('failed')} failed` : '',
    n('limited') ? `${n('limited')} limited` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * A task tool call no card holds, in words and never with a raw session id:
 * "Waited for 2 subagents", "Checked 3 tasks", "Read a subagent's report",
 * "Continued a subagent". The verb and the rest, for the log's two columns.
 */
export function taskToolWords(name: string, input: Record<string, unknown> | undefined, result: string | undefined): { verb: string; target: string } {
  const n = taskIds(input, result).length;
  const subs = (k: number) => `${k} ${k === 1 ? 'subagent' : 'subagents'}`;
  switch (name) {
    case 'TaskWait':
      return { verb: 'Waited', target: n ? `for ${subs(n)}` : 'for subagents' };
    case 'TaskList':
      return { verb: 'Checked', target: result === undefined ? 'tasks' : `${n} ${n === 1 ? 'task' : 'tasks'}` };
    case 'TaskResult':
      return { verb: 'Read', target: "a subagent's report" };
    default:
      return { verb: 'Continued', target: 'a subagent' };
  }
}

/** The first line of a report, as plain words for a closed line. */
export function firstLine(report: string | undefined): string {
  for (const l of (report ?? '').split('\n')) {
    const t = l.replace(/^[#>*\-\s]+|[*_`]/g, '').trim();
    if (t) return t;
  }
  return '';
}
