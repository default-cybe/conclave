/**
 * A background task that ended and reported back (core types.ts
 * AgentResultRef): a Task or Delegate subagent, or a workflow run. The hub
 * writes a notice line ("Background task finished: count widgets") and hands
 * the report to the model in a user message that holds only a
 * <system-reminder>. The log draws the two as one compact row, "Message
 * from subagent count widgets", that opens to the report; the reminder
 * message itself draws nothing.
 */
import type { AgentResultRef, Message } from '@conclave/core/types';

export type { AgentResultRef };

/** A row's task and, once the message that carries it is in view, its report. */
export interface AgentResultView extends AgentResultRef {
  report?: string;
}

const SUBAGENT_RE = /<subagent_result session="([^"]*)" agent="([^"]*)" state="([^"]*)" description="([^"]*)">\n?([\s\S]*?)\n?<\/subagent_result>/g;
const WORKFLOW_RE = /<workflow_result run="([^"]*)" name="([^"]*)" status="([^"]*)">\n?([\s\S]*?)\n?<\/workflow_result>/g;
/** A hub from before meta.agentResult wrote only this line. */
const OLD_NOTICE = /^Background task (finished|failed): (.+?)\.?$/;

function subagentState(s: string): AgentResultRef['state'] {
  return s === 'completed' ? 'completed' : 'failed';
}

function workflowState(s: string): AgentResultRef['state'] {
  return s === 'done' ? 'completed' : s === 'stopped' ? 'stopped' : 'failed';
}

/** The reports in a block of text the hub wrote for the model. */
export function parseResults(text: string): AgentResultView[] {
  const out: AgentResultView[] = [];
  for (const m of text.matchAll(SUBAGENT_RE)) out.push({ type: 'subagent', id: m[1], agent: m[2], state: subagentState(m[3]), label: m[4], report: m[5].trim() });
  for (const m of text.matchAll(WORKFLOW_RE)) out.push({ type: 'workflow', id: m[1], label: m[2], state: workflowState(m[3]), report: m[4].trim() });
  return out;
}

/** The reports a message hands the model (a reminder only message, or tool results with the note after them). */
export function resultsIn(m: Message): AgentResultView[] {
  if (m.role !== 'user') return [];
  return m.content.flatMap((b) => (b.type === 'text' && b.text.includes('_result ') ? parseResults(b.text) : []));
}

function isRef(v: unknown): v is AgentResultRef {
  const r = v as AgentResultRef | undefined;
  return !!r && (r.type === 'subagent' || r.type === 'workflow') && typeof r.id === 'string' && typeof r.label === 'string';
}

/** The task a notice line is about: meta.agentResult, or the words of a hub from before it. */
export function noticeResult(m: Message): AgentResultRef | undefined {
  if (m.kind !== 'notice') return undefined;
  const meta = m.meta as { kind?: string; agentResult?: unknown } | undefined;
  if (meta?.kind === 'agent-result' && isRef(meta.agentResult)) return meta.agentResult;
  const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const old = OLD_NOTICE.exec(text);
  return old ? { type: 'subagent', id: '', label: old[2], state: old[1] === 'finished' ? 'completed' : 'failed' } : undefined;
}

/** How the hub writes a label into the block's attribute (core engine/subagent.ts attr), to match an old notice by its label. */
function attr(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/</g, '(').replace(/>/g, ')');
}

/** The report of a task, from the message that carries it: by id, or for an old notice by its label (the first such report from seq `after` on). */
export function reportFor(messages: readonly Message[], ref: AgentResultRef, after = 0): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user' || m.seq < after) continue;
    for (const r of resultsIn(m)) {
      if (r.type !== ref.type) continue;
      if (ref.id ? r.id === ref.id : r.label === attr(ref.label)) return r.report;
    }
  }
  return undefined;
}

/** "Message from subagent count widgets" or "Message from workflow deep-research", and the state word. */
export function agentResultWords(ref: AgentResultRef): { title: string; state: string } {
  const title = `Message from ${ref.type === 'workflow' ? 'workflow' : 'subagent'} ${ref.label}`.trim();
  return { title, state: ref.state === 'completed' ? 'done' : ref.state };
}

/** Where the task's own work opens: the subagent's session, or the run. */
export function agentResultHref(ref: AgentResultRef): string | undefined {
  if (!ref.id) return undefined;
  return ref.type === 'workflow' ? `/workflows/runs/${ref.id}` : `/s/${ref.id}`;
}
