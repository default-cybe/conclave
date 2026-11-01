/**
 * Approvals and questions from subagents and workflow agents, in the chat
 * the owner is in (docs/design/CHAT-AND-MOTION.md 1.4). The hub names the
 * top session of the one that asks (rootSessionId) and who asks (from), so a
 * card shows inline where you are as well as in the Inbox, with a quiet line
 * above it: "Subagent email asks", "Workflow deep-research, agent search r1
 * 3, asks". The request keeps the session that asks: answering resolves it
 * there, and "for this session" is that session's.
 *
 * Pure, and tested (test/subagent-asks.test.ts).
 */
import type { ApprovalRequest, QuestionRequest } from '@conclave/core/types';

/** The parts of an approval or a question these rules read. */
export type Ask = Pick<ApprovalRequest | QuestionRequest, 'sessionId' | 'rootSessionId' | 'from'>;

/** The conversation the request shows in: its top session, else (an older hub) the one that asks. */
export function askHome(r: Ask): string {
  return r.rootSessionId ?? r.sessionId;
}

/** The request shows inline in this session: it asks here, or a subagent or workflow agent under it asks. */
export function asksIn(r: Ask, sessionId: string): boolean {
  return r.sessionId === sessionId || r.rootSessionId === sessionId || !!r.from?.chain?.includes(sessionId);
}

/** The requests that show in this session, approvals and questions alike. */
export function asksOf<T extends Ask>(list: Iterable<T>, sessionId: string): T[] {
  const out: T[] = [];
  for (const r of list) if (asksIn(r, sessionId)) out.push(r);
  return out;
}

/** A session under this one waits on you (this session itself keeps working on the call that started it). */
export function asksBelow(list: Iterable<Ask>, sessionId: string): boolean {
  for (const r of list) if (r.sessionId !== sessionId && asksIn(r, sessionId)) return true;
  return false;
}

/** This session, or one under it, waits on you: a subagent's row and its running task say so. */
export function waitsIn(list: Iterable<Ask>, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  for (const r of list) if (r.sessionId === sessionId || r.from?.chain?.includes(sessionId)) return true;
  return false;
}

/** An agent of this workflow run waits on you. */
export function runWaits(list: Iterable<Ask>, runId: string): boolean {
  for (const r of list) if (r.from?.workflow?.runId === runId) return true;
  return false;
}

/** The one that asks is a subagent or a workflow agent: "for this session" is said "for this subagent". */
export function fromChild(r: Ask): boolean {
  return !!r.from;
}

/** Who asks, as the start of a sentence: "Subagent email", "Workflow deep-research, agent search r1 3,". */
function who(r: Ask): string | undefined {
  const f = r.from;
  if (!f) return undefined;
  return f.workflow ? `Workflow ${f.workflow.name}, agent ${f.label},` : `Subagent ${f.agent}`;
}

/**
 * The quiet line above a card: "Subagent email asks", "Workflow
 * deep-research, agent search r1 3, asks". Nothing for a top session's own
 * request, or in the session that asks (it is the one you are looking at).
 */
export function askFromLine(r: Ask, viewing?: string): string | undefined {
  if (viewing === r.sessionId) return undefined;
  const w = who(r);
  return w ? `${w} asks` : undefined;
}

/** For the Inbox: "from subagent email in Find my Lisbon mail". */
export function askFromInbox(r: Ask, rootTitle?: string): string | undefined {
  const f = r.from;
  if (!f) return undefined;
  const w = f.workflow ? `workflow ${f.workflow.name}, agent ${f.label},` : `subagent ${f.agent}`;
  return rootTitle ? `from ${w} in ${rootTitle}` : `from ${w}`;
}

/** A phone Inbox row's line with who asks in front: "Subagent email wants to use mail read". The line as it is for a top session. */
export function askerLine(r: Ask, line: string): string {
  const w = who(r);
  return w ? `${w} ${line ? line[0].toLowerCase() + line.slice(1) : line}` : line;
}

/** "Allow for this session" (or "this chat" on a phone), and "this subagent" when a subagent or a workflow agent asks. */
export function sessionWord(r: Ask, place: 'session' | 'chat'): string {
  return `Allow for this ${fromChild(r) ? 'subagent' : place}`;
}

/** What the session answer reads once given: "Allowed for this session", "Allowed for this subagent". */
export function sessionDoneWord(r: Ask): string {
  return `Allowed for this ${fromChild(r) ? 'subagent' : 'session'}`;
}
