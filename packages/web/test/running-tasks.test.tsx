/**
 * A session's running tasks, as the Claude app shows them above the
 * composer (docs/design/CHAT-AND-MOTION.md 6.3): "2 running tasks", which
 * opens the list of each workflow and subagent at work. Worked out on the
 * client (src/features/chat/liveTasks.ts): a workflow while its run is live,
 * a subagent while its Task call has no result (and the call or the session
 * is at work), or, in the background, while its own session is. The line
 * and the list (src/features/chat/RunningTasks.tsx).
 *
 *   bun test packages/web/test/running-tasks.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { WorkflowRun } from '@conclave/core/client';
import type { ContentBlock, Message, Session, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { Bot, Bug, Eye, FlaskConical, Globe, Hammer, Laptop, Palette, Search, ShieldCheck, Workflow } from 'lucide-react';
import { groupByKind, taskIcon } from '../src/lib/taskKinds';
import { runIdFor, runningTasks, sessionLive, subagentOf, taskCalls, taskKind, tasksWord, type RunningInput, type RunningTask } from '../src/features/chat/liveTasks';
import { RunningTasksView, TaskList } from '../src/features/chat/RunningTasks';
import type { ToolRun } from '../src/store/store';

const NOW = 1_800_000_000_000;

function run(p: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wfr_1',
    name: 'deep-research',
    source: 'builtin',
    status: 'running',
    sessionId: 's1',
    device: 'local',
    cwd: '~',
    phases: [{ title: 'Frame' }, { title: 'Search' }, { title: 'Check' }, { title: 'Write' }, { title: 'Critic' }],
    phaseIndex: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    counts: { agents: 6, queued: 1, running: 3, done: 2, cached: 0, failed: 0, skipped: 0, parked: 0 },
    portable: true,
    createdAt: NOW - 120_000,
    startedAt: NOW - 119_000,
    ...p,
  };
}

const session = (p: Partial<Session> & { id: string }): Session => ({ title: '', agent: 'explore', model: 'anthropic/claude-haiku-5-5', mode: 'agent', permissionMode: 'default', cwd: '~', device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: NOW - 60_000, updatedAt: NOW, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, ...p });

const use = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: 'tool_use', id, name, input });
const res = (id: string, content = 'ok', meta?: Record<string, unknown>, isError?: boolean): ToolResultBlock => ({ type: 'tool_result', toolUseId: id, content, ...(meta ? { meta } : {}), ...(isError ? { isError } : {}) });
const msg = (id: string, role: Message['role'], content: ContentBlock[], createdAt = NOW - 100_000): Message => ({ id, sessionId: 's1', seq: 1, role, kind: 'normal', content, createdAt });
const toolRun = (p: Partial<ToolRun> = {}): ToolRun => ({ status: 'running', name: 'Task', startedAt: NOW - 30_000, progress: '', ...p });

const explore = use('t1', 'Task', { description: 'Find the auth code', subagent_type: 'explore', prompt: 'Find it.' });
const html = (node: React.ReactNode) => renderToStaticMarkup(<Router ssrPath="/s/s1">{node}</Router>);

describe('the words', () => {
  test('"1 running task", "2 running tasks": the same words Android uses', () => {
    expect(tasksWord(1)).toBe('1 running task');
    expect(tasksWord(2)).toBe('2 running tasks');
  });

  test('a session is at work while a turn runs, waits on you or waits for a limit', () => {
    for (const s of ['running', 'waiting_approval', 'waiting_input', 'waiting_reset'] as const) expect(sessionLive(s)).toBe(true);
    for (const s of ['idle', 'error', undefined] as const) expect(sessionLive(s)).toBe(false);
  });
});

describe('the calls', () => {
  test('Workflow and Task calls in order, each with its result, whatever name they arrive under', () => {
    const list = taskCalls([
      msg('a', 'assistant', [use('r', 'Read', { file_path: 'a.ts' }), explore, use('w', 'mcp__conclave__Workflow', { name: 'deep-research' })], NOW - 90_000),
      msg('u', 'user', [res('r'), res('t1', 'Found it.', { sessionId: 'c1' })]),
    ]);
    expect(list.map((c) => [c.kind, c.tool.id, c.result?.content ?? null])).toEqual([
      ['subagent', 't1', 'Found it.'],
      ['workflow', 'w', null],
    ]);
    expect(list[0].at).toBe(NOW - 90_000);
  });
});

describe('a subagent', () => {
  const ctx = (status: Session['status'] = 'running', sessions: Record<string, Session> = {}) => ({ sessionId: 's1', status, sessions });
  const child = session({ id: 'c1', parentId: 's1', title: 'Find the auth code', status: 'running', createdAt: NOW - 25_000 });

  test('runs while its call runs, from when the call started', () => {
    expect(subagentOf({ tool: explore, run: toolRun() }, ctx('idle'))).toMatchObject({ state: 'running', startedAt: NOW - 30_000, agent: 'explore', description: 'Find the auth code', background: false });
  });

  test('a call with no result runs while the session is at work (the page loaded mid call); in a session at rest it was cut off', () => {
    expect(subagentOf({ tool: explore, at: NOW - 40_000 }, ctx('running'))).toMatchObject({ state: 'running', startedAt: NOW - 40_000 });
    expect(subagentOf({ tool: explore }, ctx('idle')).state).toBe('pending');
    // its own session at work says so too, and gives the time
    expect(subagentOf({ tool: explore }, ctx('idle', { c1: child }))).toMatchObject({ state: 'running', childId: 'c1', startedAt: NOW - 25_000 });
  });

  test('answered: done or failed', () => {
    expect(subagentOf({ tool: explore, result: res('t1', 'Found it.', { sessionId: 'c1' }) }, ctx('running', { c1: child }))).toMatchObject({ state: 'done', childId: 'c1' });
    expect(subagentOf({ tool: explore, result: res('t1', 'Subagent was interrupted.', undefined, true) }, ctx()).state).toBe('failed');
    // the result in the store, before the transcript has it
    expect(subagentOf({ tool: explore, run: toolRun({ status: 'ok', result: res('t1') }) }, ctx()).state).toBe('done');
  });

  test('in the background: its call answered at once, it runs while its own session is at work', () => {
    const started = res('t1', 'Subagent "explore" started in the background.', { sessionId: 'c1', agent: 'explore', background: true });
    expect(subagentOf({ tool: explore, result: started }, ctx('idle', { c1: child }))).toMatchObject({ state: 'running', background: true, childId: 'c1' });
    expect(subagentOf({ tool: explore, result: started }, ctx('idle', { c1: { ...child, status: 'waiting_approval' } })).state).toBe('running');
    expect(subagentOf({ tool: explore, result: started }, ctx('running', { c1: { ...child, status: 'idle' } })).state).toBe('done');
  });

  test('its session: the one its result names, else the newest child with its description as title', () => {
    const older = session({ id: 'c0', parentId: 's1', title: 'Find the auth code', createdAt: NOW - 900_000 });
    const other = session({ id: 'cx', parentId: 's2', title: 'Find the auth code', createdAt: NOW });
    expect(subagentOf({ tool: explore }, ctx('running', { c0: older, c1: child, cx: other })).childId).toBe('c1');
    expect(subagentOf({ tool: use('t2', 'Task', { description: 'Something else' }) }, ctx('running', { c1: child })).childId).toBeUndefined();
  });
});

describe('the run of a Workflow call', () => {
  const call = use('w1', 'Workflow', { name: 'deep-research' });

  test('the one its result names, else the one carrying the call id', () => {
    expect(runIdFor(call, res('w1', 'done', { workflowRunId: 'wfr_9' }), [run()])).toBe('wfr_9');
    expect(runIdFor(call, undefined, [run({ id: 'wfr_a', toolUseId: 'w0' }), run({ id: 'wfr_b', toolUseId: 'w1' })])).toBe('wfr_b');
  });

  test('from a hub before runs carried the call id: the live run of that name, while the call waits', () => {
    expect(runIdFor(call, undefined, [run({ id: 'wfr_old', status: 'done' }), run({ id: 'wfr_live' })])).toBe('wfr_live');
    expect(runIdFor(call, undefined, [run({ id: 'wfr_x', name: 'review-changes' })])).toBeUndefined();
    // a run another call claims is not this one's
    expect(runIdFor(call, undefined, [run({ id: 'wfr_c', toolUseId: 'w0' })])).toBeUndefined();
    // with a result that names no run, it has none
    expect(runIdFor(call, res('w1', 'refused', undefined, true), [run()])).toBeUndefined();
  });
});

describe('the running tasks of a session', () => {
  const wfCall = use('w1', 'Workflow', { name: 'deep-research' });
  const bg = use('t2', 'Task', { description: 'Read the proxy config', subagent_type: 'explore', run_in_background: true });
  const fg = use('t3', 'Task', { description: 'Check the tests', subagent_type: 'general-purpose' });
  const doneTask = use('t4', 'Task', { description: 'List the routes', subagent_type: 'explore' });
  const messages: Message[] = [
    msg('a1', 'assistant', [doneTask], NOW - 300_000),
    msg('u1', 'user', [res('t4', 'Three routes.', { sessionId: 'c4' })]),
    msg('a2', 'assistant', [bg, wfCall, fg], NOW - 100_000),
    msg('u2', 'user', [res('t2', 'Started in the background.', { sessionId: 'c2', agent: 'explore', background: true })]),
  ];
  const sessions = {
    s1: session({ id: 's1', status: 'running' }),
    c2: session({ id: 'c2', parentId: 's1', title: 'Read the proxy config', status: 'running', createdAt: NOW - 99_000 }),
    c4: session({ id: 'c4', parentId: 's1', title: 'List the routes', status: 'idle' }),
  };
  const input = (p: Partial<RunningInput> = {}): RunningInput => ({
    sessionId: 's1',
    status: 'running',
    calls: taskCalls(messages),
    tools: { t3: toolRun({ startedAt: NOW - 50_000 }) },
    sessions,
    runs: [run({ toolUseId: 'w1' }), run({ id: 'wfr_done', status: 'done', toolUseId: 'w0' }), run({ id: 'wfr_other', sessionId: 's9' }), run({ id: 'wfr_nested', parentRunId: 'wfr_1' })],
    ...p,
  });

  test('a live workflow, a subagent in the background and one in the foreground; finished work and other sessions are not', () => {
    const list = runningTasks(input());
    expect(list.map((t) => t.key)).toEqual(['w:wfr_1', 't:t2', 't:t3']);
    expect(list[0]).toMatchObject({ kind: 'workflow', toolUseId: 'w1', startedAt: NOW - 119_000 });
    expect(list[1]).toMatchObject({ kind: 'subagent', childId: 'c2', background: true, agent: 'explore', description: 'Read the proxy config' });
    expect(list[2]).toMatchObject({ kind: 'subagent', toolUseId: 't3', startedAt: NOW - 50_000 });
    expect(tasksWord(list.length)).toBe('3 running tasks');
  });

  test('a live run of the session that no call names counts too; a paused run is still a task', () => {
    const list = runningTasks(input({ calls: [], runs: [run({ id: 'wfr_ui', status: 'paused' })] }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'workflow', run: { id: 'wfr_ui', status: 'paused' } });
    expect(list[0]).not.toHaveProperty('toolUseId');
  });

  test('when the work ends the list is empty, and the line goes away', () => {
    const over = runningTasks(
      input({
        status: 'idle',
        tools: { t3: toolRun({ status: 'ok', result: res('t3') }) },
        sessions: { ...sessions, c2: { ...sessions.c2, status: 'idle' } },
        runs: [run({ toolUseId: 'w1', status: 'done', finishedAt: NOW })],
      }),
    );
    expect(over).toEqual([]);
    expect(html(<RunningTasksView tasks={over} />)).toBe('');
  });
});

describe('the line and the list', () => {
  const tasks: RunningTask[] = [
    { kind: 'workflow', key: 'w:wfr_1', toolUseId: 'w1', run: run(), startedAt: NOW - 119_000 },
    { kind: 'subagent', key: 't:t2', toolUseId: 't2', state: 'running', childId: 'c2', background: true, agent: 'explore', description: 'Read the proxy config', startedAt: NOW - 99_000 },
  ];

  test('the line above the composer says how many, and opens the list', () => {
    const out = html(<RunningTasksView tasks={tasks} />);
    expect(out).toContain('data-running-tasks');
    expect(out).toContain('2 running tasks');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain('aria-expanded="false"');
    expect(html(<RunningTasksView tasks={tasks.slice(0, 1)} />)).toContain('1 running task<');
  });

  test('a workflow: its name, where it is, "3 of 6 agents running" and Open run; it opens to its agents', () => {
    const out = html(<TaskList tasks={tasks} />);
    expect(out).toContain('data-task="workflow"');
    expect(out).toContain('deep-research');
    expect(out).toContain('Phase 2 of 5, Search. 3 of 6 agents running');
    expect(out).toContain('href="/workflows/runs/wfr_1"');
    expect(out).toContain('Open run');
    expect(out).toContain('aria-expanded="false"');
  });

  test('a subagent: what it does, who does it, what it is doing now and Open session', () => {
    const out = html(<TaskList tasks={tasks} />);
    expect(out).toContain('data-task="subagent"');
    expect(out).toContain('>Subagent<');
    expect(out).toContain('explore: ');
    expect(out).toContain('Read the proxy config');
    // a string render reads the store as it starts: the subagent's transcript is not there yet
    expect(out).toContain('data-subagent-now');
    expect(out).toContain('>Starting<');
    expect(out).toContain('href="/s/c2"');
    expect(out).toContain('Open session');
  });
});

describe('a Delegate call', () => {
  const brief = 'List every person named in the PDFs in ~/capstone.\nReturn one name per line.';
  const call = use('d1', 'Delegate', { to: 'code', device: 'madx arch', prompt: brief, description: 'Find names in the capstone PDFs' });
  const place = { to: 'code', device: 'arch', deviceName: 'MadX Arch', folder: '/home/kai/capstone', readOnly: true, permissionMode: 'plan' };
  const ctx = (sessions: Record<string, Session> = {}, status: Session['status'] = 'running') => ({ sessionId: 's1', status, sessions });
  const child = session({ id: 'c9', parentId: 's1', title: 'Find names in the capstone PDFs', status: 'running', device: 'arch', meta: { delegate: { ...place, toolUseId: 'd1' } } });

  test('is a subagent, named by who does it and where', () => {
    expect(taskCalls([msg('a', 'assistant', [call])]).map((c) => c.kind)).toEqual(['subagent']);
    // before its session shows up: the device as the call wrote it
    expect(subagentOf({ tool: call }, ctx())).toMatchObject({ state: 'running', description: 'Find names in the capstone PDFs', handedTo: 'Code on madx arch' });
    // its session carries the call id and the device's name
    expect(subagentOf({ tool: call }, ctx({ c9: child }))).toMatchObject({ childId: 'c9', agent: 'explore', handedTo: 'Code on MadX Arch' });
    // answered: from the result
    const done = subagentOf({ tool: call, result: res('d1', 'Ada Lovelace', { sessionId: 'c9', agent: 'explore', delegate: place }) }, ctx({}, 'idle'));
    expect(done).toMatchObject({ state: 'done', childId: 'c9', handedTo: 'Code on MadX Arch' });
  });

  test("with no description it goes by the brief's first line; the assistant is named so", () => {
    const bare = use('d2', 'Delegate', { to: 'assistant', prompt: brief });
    const mine = session({ id: 'c8', parentId: 's1', title: 'List every person named in the PDFs in ~/capstone.', status: 'running', meta: { delegate: { ...place, to: 'assistant', device: 'local', deviceName: 'conclave-hub', toolUseId: 'd2' } } });
    expect(subagentOf({ tool: bare }, ctx({ c8: mine }))).toMatchObject({ description: 'List every person named in the PDFs in ~/capstone.', childId: 'c8', handedTo: 'Assistant on conclave-hub' });
  });

  test('the running tasks list says "Code on MadX Arch:" in place of "Subagent"', () => {
    const list = runningTasks({ sessionId: 's1', status: 'running', calls: taskCalls([msg('a', 'assistant', [call])]), tools: { d1: toolRun({ name: 'Delegate' }) }, sessions: { c9: child }, runs: [] });
    expect(list).toHaveLength(1);
    const out = html(<TaskList tasks={list} />);
    expect(out).toContain('>Code on MadX Arch:<');
    expect(out).toContain('Find names in the capstone PDFs');
    expect(out).not.toContain('>Subagent<');
    expect(out).toContain('href="/s/c9"');
  });
});

describe('kinds: an icon and a word per kind, workflows first', () => {
  test('a workflow, a delegated job and each agent type have their own icon; an unknown agent is a bot', () => {
    expect(taskIcon('workflow')).toBe(Workflow);
    expect(taskIcon('delegate', 'explore')).toBe(Laptop);
    expect(taskIcon('subagent', 'explore')).toBe(Search);
    expect(taskIcon('subagent', 'Builder')).toBe(Hammer);
    expect(taskIcon('subagent', 'tester')).toBe(FlaskConical);
    expect(taskIcon('subagent', 'reviewer')).toBe(Eye);
    expect(taskIcon('subagent', 'debugger')).toBe(Bug);
    expect(taskIcon('subagent', 'researcher')).toBe(Globe);
    expect(taskIcon('subagent', 'designer')).toBe(Palette);
    expect(taskIcon('subagent', 'verifier')).toBe(ShieldCheck);
    expect(taskIcon('subagent', 'general-purpose')).toBe(Bot);
    expect(taskIcon('subagent')).toBe(Bot);
  });

  test('groups keep their order, workflows first, and empty ones are left out', () => {
    const items = [{ k: 'subagent', id: 1 }, { k: 'delegate', id: 2 }, { k: 'workflow', id: 3 }, { k: 'subagent', id: 4 }] as const;
    expect(groupByKind(items, (t) => t.k).map((g) => [g.kind, g.items.map((t) => t.id)])).toEqual([['workflow', [3]], ['subagent', [1, 4]], ['delegate', [2]]]);
    expect(groupByKind(items.slice(0, 1), (t) => t.k).map((g) => g.kind)).toEqual(['subagent']);
  });

  test('a subagent reads its model; the list heads each kind and leads each row with its icon and word', () => {
    expect(subagentOf({ tool: explore }, { sessionId: 's1', status: 'running', sessions: {} }).model).toBeUndefined();
    expect(subagentOf({ tool: use('t9', 'Task', { description: 'x', model: 'openai/gpt-5.5' }) }, { sessionId: 's1', status: 'running', sessions: {} }).model).toBe('openai/gpt-5.5');
    const delegated: RunningTask = { kind: 'subagent', key: 't:d1', toolUseId: 'd1', state: 'running', background: false, description: 'Find names', handedTo: 'Code on MadX Arch', startedAt: NOW - 10_000, waiting: false };
    const agent: RunningTask = { kind: 'subagent', key: 't:t2', toolUseId: 't2', state: 'running', background: false, agent: 'builder', model: 'anthropic/claude-haiku-5-5', description: 'Build it', startedAt: NOW - 20_000, waiting: false };
    const flow: RunningTask = { kind: 'workflow', key: 'w:wfr_1', run: run(), startedAt: NOW - 119_000, waiting: false };
    expect([delegated, agent, flow].map(taskKind)).toEqual(['delegate', 'subagent', 'workflow']);
    const out = html(<TaskList tasks={[delegated, agent, flow]} />);
    expect(out.indexOf('>Workflows<')).toBeLessThan(out.indexOf('>Subagents<'));
    expect(out.indexOf('>Subagents<')).toBeLessThan(out.indexOf('>Delegated<'));
    expect(out).toContain('data-kind="workflow"');
    expect(out).toContain('data-kind="delegate"');
    expect(out).toContain('>Delegate<');
    expect(out).toContain('builder: ');
    expect(out).toContain('Haiku 5.5');
    // one kind: no headings
    expect(html(<TaskList tasks={[agent]} />)).not.toContain('>Subagents<');
  });
});
