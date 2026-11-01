/**
 * Approvals and questions from subagents and workflow agents, in the chat
 * the owner is in (docs/design/CHAT-AND-MOTION.md 1.4, src/lib/asks.ts):
 * which requests show in a session, the quiet line above the card, the
 * session answer's words, the Inbox line, and "waiting on you" on the task
 * row and the running tasks line. The words have no em or en dashes.
 *
 *   bun test packages/web/test/subagent-asks.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { WorkflowRun } from '@conclave/core/client';
import type { ApprovalRequest, Message, QuestionRequest, Session } from '@conclave/core/types';
import { askFromInbox, askFromLine, askHome, askerLine, asksBelow, asksIn, asksOf, runWaits, sessionDoneWord, sessionWord, waitsIn } from '../src/lib/asks';
import { runningTasks, taskCalls } from '../src/features/chat/liveTasks';
import { RunningTasksView } from '../src/features/chat/RunningTasks';
import { subagentNowOf } from '../src/features/chat/ToolRows';
import { ApprovalCard } from '../src/components/inbox/ApprovalCard';
import { QuestionCard } from '../src/components/inbox/QuestionCard';

const NOW = 1_800_000_000_000;

const session = (p: Partial<Session> & { id: string }): Session => ({ title: '', agent: 'assistant', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'default', cwd: '~', device: 'local', status: 'running', tags: [], pinned: false, archived: false, createdAt: NOW - 60_000, updatedAt: NOW, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, ...p });

const top = session({ id: 's_mail', title: 'Lisbon flight booking code' });
const email = session({ id: 's_email', title: 'Find the Lisbon booking mail', agent: 'email', parentId: 's_mail', status: 'waiting_approval', tags: ['subagent'] });
const deeper = session({ id: 's_read', title: 'Read the thread', agent: 'explore', parentId: 's_email', status: 'waiting_approval', tags: ['subagent'] });

function approval(p: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap_mail',
    sessionId: 's_email',
    rootSessionId: 's_mail',
    from: { sessionId: 's_email', agent: 'email', label: 'Find the Lisbon booking mail', chain: ['s_email'] },
    toolUseId: 'tu_read',
    tool: 'MailRead',
    input: { id: 'msg_4f1c' },
    summary: 'Read message msg_4f1c',
    createdAt: NOW - 60_000,
    ...p,
  };
}

const own = approval({ id: 'ap_own', sessionId: 's_mail', rootSessionId: 's_mail', from: undefined });
const twoDown = approval({ id: 'ap_deep', sessionId: 's_read', from: { sessionId: 's_read', agent: 'explore', label: 'Read the thread', chain: ['s_email', 's_read'] } });
const workflowAsk = approval({ id: 'ap_wf', sessionId: 's_wf3', from: { sessionId: 's_wf3', agent: 'workflow', label: 'search r1 3', workflow: { runId: 'wfr_1', name: 'deep-research' }, chain: ['s_wf3'] } });
const older = approval({ id: 'ap_old', sessionId: 's_mail', rootSessionId: undefined, from: undefined });

const html = (node: React.ReactNode) => renderToStaticMarkup(<Router ssrPath="/s/s_mail">{node}</Router>);

describe('which requests show where', () => {
  test("the top session shows its own and its subagents' and workflow agents'; the subagent shows its own", () => {
    for (const a of [own, approval(), twoDown, workflowAsk, older]) expect(asksIn(a, 's_mail')).toBe(true);
    expect(asksIn(approval(), 's_email')).toBe(true);
    // a subagent two levels down shows in the subagent between, too
    expect(asksIn(twoDown, 's_email')).toBe(true);
    expect(asksIn(own, 's_email')).toBe(false);
    expect(asksIn(approval(), 's_other')).toBe(false);
    expect(asksOf([own, approval(), twoDown], 's_email').map((a) => a.id)).toEqual(['ap_mail', 'ap_deep']);
    expect(askHome(approval())).toBe('s_mail');
    // a hub from before rootSessionId: the session that asks
    expect(askHome(older)).toBe('s_mail');
  });

  test('a session under this one waits on you: the turn that started it does too', () => {
    expect(asksBelow([approval()], 's_mail')).toBe(true);
    expect(asksBelow([own], 's_mail')).toBe(false);
    expect(asksBelow([approval()], 's_email')).toBe(false);
    expect(waitsIn([twoDown], 's_email')).toBe(true);
    expect(waitsIn([twoDown], 's_read')).toBe(true);
    expect(waitsIn([own], 's_email')).toBe(false);
    expect(waitsIn([approval()], undefined)).toBe(false);
    expect(runWaits([workflowAsk], 'wfr_1')).toBe(true);
    expect(runWaits([approval()], 'wfr_1')).toBe(false);
  });
});

describe('the words', () => {
  test('who asks, above the card; nothing for your own request or in the session that asks', () => {
    expect(askFromLine(approval(), 's_mail')).toBe('Subagent email asks');
    expect(askFromLine(workflowAsk, 's_mail')).toBe('Workflow deep-research, agent search r1 3, asks');
    expect(askFromLine(own, 's_mail')).toBeUndefined();
    expect(askFromLine(approval(), 's_email')).toBeUndefined();
    expect(askFromLine(twoDown, 's_email')).toBe('Subagent explore asks');
  });

  test('the Inbox line, a phone row, and the session answer', () => {
    expect(askFromInbox(approval(), 'Lisbon flight booking code')).toBe('from subagent email in Lisbon flight booking code');
    expect(askFromInbox(workflowAsk, 'Research')).toBe('from workflow deep-research, agent search r1 3, in Research');
    expect(askFromInbox(approval())).toBe('from subagent email');
    expect(askFromInbox(own, 'x')).toBeUndefined();
    expect(askerLine(approval(), 'Wants to use MailRead')).toBe('Subagent email wants to use MailRead');
    expect(askerLine(own, 'Wants to run git push')).toBe('Wants to run git push');
    expect(sessionWord(approval(), 'session')).toBe('Allow for this subagent');
    expect(sessionWord(approval(), 'chat')).toBe('Allow for this subagent');
    expect(sessionWord(own, 'session')).toBe('Allow for this session');
    expect(sessionWord(own, 'chat')).toBe('Allow for this chat');
    expect(sessionDoneWord(approval())).toBe('Allowed for this subagent');
    expect(sessionDoneWord(own)).toBe('Allowed for this session');
    const all = [askFromLine(workflowAsk, 's_mail'), askFromInbox(workflowAsk, 'R'), askerLine(workflowAsk, 'Wants to run ls')].join(' ');
    expect(all).not.toMatch(/[–—]/);
  });
});

// a string render reads the store as it starts (no sessions): the chat's title joins the Inbox line in the app (askFromInbox above)
describe('the cards', () => {
  test('in the chat: "Subagent email asks" above the card, and the session answer is for this subagent', () => {
    const out = html(<ApprovalCard approval={approval()} inSession here="s_mail" />);
    expect(out).toContain('data-ask-from');
    expect(out).toContain('Subagent email asks');
    expect(out).toContain('Allow for this subagent');
    expect(out).toContain('Allow once');
    expect(out).toContain('Deny');
  });

  test('your own request has no line above it; in the Inbox a subagent request says where it is from', () => {
    const mine = html(<ApprovalCard approval={own} inSession here="s_mail" />);
    expect(mine).not.toContain('data-ask-from');
    expect(mine).toContain('Allow for this session');
    const inbox = html(<ApprovalCard approval={approval()} />);
    expect(inbox).not.toContain('data-ask-from');
    expect(inbox).toContain('from subagent email');
    expect(inbox).not.toContain('>email<');
    // Open session opens the chat it shows in
    expect(inbox).toContain('href="/s/s_mail"');
  });

  test('an untrusted session offers no standing rule', () => {
    expect(html(<ApprovalCard approval={approval({ noAlways: true })} inSession here="s_mail" />)).not.toContain('Always allow');
    expect(html(<ApprovalCard approval={own} inSession here="s_mail" />)).toContain('Always allow');
  });

  test('a question from a subagent: who asks, above it, in place of the model', () => {
    const q: QuestionRequest = { id: 'q1', sessionId: 's_email', rootSessionId: 's_mail', from: approval().from, questions: [{ question: 'Which inbox?', options: [{ label: 'Work' }, { label: 'Home' }] }], createdAt: NOW };
    const out = html(<QuestionCard question={q} inSession here="s_mail" />);
    expect(out).toContain('Subagent email asks');
    expect(out).toContain('Which inbox?');
    expect(out).not.toContain('asks: ');
    const inbox = html(<QuestionCard question={q} />);
    expect(inbox).toContain('>from subagent email<');
  });
});

describe('waiting on you, on the task', () => {
  const task: Message = {
    id: 'm1',
    sessionId: 's_mail',
    seq: 2,
    role: 'assistant',
    kind: 'normal',
    createdAt: NOW - 50_000,
    content: [{ type: 'tool_use', id: 'tu_task', name: 'Task', input: { description: 'Find the Lisbon booking mail', subagent_type: 'email', prompt: 'Find it.' } }],
  };
  const run: WorkflowRun = {
    id: 'wfr_1',
    name: 'deep-research',
    source: 'builtin',
    status: 'running',
    sessionId: 's_mail',
    device: 'local',
    cwd: '~',
    phases: [{ title: 'Search' }],
    phaseIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    counts: { agents: 3, queued: 0, running: 3, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 },
    portable: true,
    createdAt: NOW - 120_000,
    startedAt: NOW - 119_000,
  };
  // the subagent itself is running (its own Task call is open), and the one under it asks
  const sessions = { s_mail: top, s_email: { ...email, status: 'running' as const }, s_read: deeper };
  const input = { sessionId: 's_mail', status: 'running' as const, calls: taskCalls([task]), tools: {}, sessions, runs: [run] };

  test("a subagent's task waits when it or a session under it asks; a workflow's when one of its agents asks", () => {
    const quiet = runningTasks({ ...input, asks: [] });
    expect(quiet.map((t) => [t.kind, t.waiting])).toEqual([
      ['workflow', false],
      ['subagent', false],
    ]);
    const asking = runningTasks({ ...input, asks: [twoDown, workflowAsk] });
    expect(asking.map((t) => [t.kind, t.waiting])).toEqual([
      ['workflow', true],
      ['subagent', true],
    ]);
  });

  test('the line says it in amber, and the subagent row reads "waiting on you"', () => {
    const tasks = runningTasks({ ...input, asks: [twoDown] });
    const out = html(<RunningTasksView tasks={tasks} />);
    expect(out).toContain('2 running tasks');
    expect(out).toContain('<span class="text-warn">, waiting on you</span>');
    expect(html(<RunningTasksView tasks={runningTasks({ ...input, asks: [] })} />)).not.toContain('waiting on you');
    const state = { sessions, messages: {}, tools: {}, streaming: {}, approvals: { ap_deep: twoDown }, questions: {} };
    expect(subagentNowOf(state, 's_email')).toEqual({ text: 'Waiting on you', waiting: true });
    expect(subagentNowOf({ ...state, approvals: {} }, 's_email').waiting).toBe(false);
  });
});
