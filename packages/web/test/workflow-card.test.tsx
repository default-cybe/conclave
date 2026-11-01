/**
 * A workflow and a subagent in a session, as the Claude app shows them: a
 * Workflow call is ONE compact row that stands alone and follows its run,
 * "Workflow deep-research, 2 of 5 agents running" with its time, closed by
 * default; a click opens the detail (features/workflows/WorkflowCard.tsx
 * WorkflowRowView and WorkflowDetail, words.ts): where the run is, its
 * phases, each agent with what it does now, its state and time, the spend
 * and Open run. When the run ends the row says the first line of its result
 * and how long it took. A Task call is one row too, "Subagent explore: Find
 * all JWT usages, starting", that says what the subagent is doing now from
 * its own transcript (ToolRows.tsx SubagentRow, subagentNowOf, lib/toolLine.ts
 * subagentNow). Neither is ever folded into a group, on desktop or on a
 * phone (PhoneTranscript.tsx PhoneWork).
 *
 *   bun test packages/web/test/workflow-card.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { WorkflowCall, WorkflowRun } from '@conclave/core/client';
import type { Message, Session, ToolUseBlock } from '@conclave/core/types';
import { WorkflowDetail, WorkflowRowView, workflowName } from '../src/features/workflows/WorkflowCard';
import { agentsRunning, cardPhases, phaseLine, phaseWords, resultLine, shownCalls, taskLine, workflowRowState } from '../src/features/workflows/words';
import { ToolGroup, ToolRow, asWork, subagentNowOf } from '../src/features/chat/ToolRows';
import { PhoneWork } from '../src/features/chat/PhoneTranscript';
import { agentDoing, lowerFirst, subagentNow, workingWords } from '../src/lib/toolLine';
import type { HubState } from '../src/store/store';

const NOW = Date.now();

function run(p: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wfr_1',
    name: 'deep-research',
    source: 'builtin',
    status: 'running',
    sessionId: 's1',
    device: 'local',
    cwd: '~',
    phases: [{ title: 'Frame' }, { title: 'Search' }, { title: 'Check' }, { title: 'Write' }],
    phaseIndex: 1,
    inputTokens: 300_000,
    outputTokens: 12_000,
    costUsd: 1.24,
    counts: { agents: 5, queued: 1, running: 2, done: 2, cached: 0, failed: 0, skipped: 0, parked: 0 },
    portable: true,
    createdAt: NOW - 140_000,
    startedAt: NOW - 134_000,
    ...p,
  };
}

function agent(seq: number, label: string, phase: string, state: WorkflowCall['state'], p: Partial<WorkflowCall> = {}): WorkflowCall {
  return { seq, kind: 'agent', label, phase, state, attempt: 1, inputTokens: 1000, outputTokens: 100, costUsd: 0.01, ...(state !== 'queued' ? { startedAt: NOW - 60_000 } : {}), ...(state === 'done' ? { finishedAt: NOW - 19_000 } : {}), ...p };
}

const calls = [
  agent(1, 'framer', 'Frame', 'done'),
  agent(2, 'searcher 1', 'Search', 'done'),
  agent(3, 'searcher 2', 'Search', 'running', { lastTool: 'Fetch caddyserver.com' }),
  agent(4, 'searcher 3', 'Search', 'running', { waiting: 'approval', lastTool: 'needs approval: Fetch community.traefik.io' }),
  agent(5, 'searcher 4', 'Search', 'queued'),
];

const ended = run({ status: 'done', phaseIndex: 3, finishedAt: NOW - 4_000, counts: { agents: 5, queued: 0, running: 0, done: 5, cached: 0, failed: 0, skipped: 0, parked: 0 } });
const report = { report: 'Use Caddy for the homelab front door.\n\nSources' };

const wf = (id = 'wf'): ToolUseBlock => ({ type: 'tool_use', id, name: 'Workflow', input: { name: 'deep-research', args: { question: 'Caddy or Traefik' } } });
const html = (node: React.ReactNode) => renderToStaticMarkup(<Router ssrPath="/s/s1">{node}</Router>);

describe('a workflow is one row that follows its run', () => {
  test('while the run goes: its name, how many agents run and the time, closed', () => {
    const out = html(<WorkflowRowView toolId="wf" name="deep-research" run={run()} calls={calls} progress={{ 3: 'Fetch traefik.io' }} />);
    expect(out).toContain('id="tool-wf"');
    expect(out).toContain('data-workflow-row');
    expect(out).toContain('data-state="running"');
    expect(out).toContain('>Workflow<');
    expect(out).toContain('deep-research');
    expect(out).toContain(', 2 of 5 agents running');
    // the time runs at the right, in signal
    expect(out).toContain('text-signal');
    // the big card is not open in the transcript: the agents are in the detail
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('searcher 2');
    expect(out).not.toContain('data-workflow-detail');
  });

  test('opened: where the run is, the phases, each agent with what it does now, its state and time, then Open run', () => {
    const out = html(<WorkflowRowView toolId="wf" name="deep-research" run={run()} calls={calls} progress={{ 3: 'Fetch traefik.io' }} defaultOpen />);
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('Phase 2 of 4, Search. 2 of 5 agents running');
    for (const p of ['Frame', 'Search', 'Check', 'Write']) expect(out).toContain(p);
    expect(out).toContain('1 of 4 done, 1 running, 1 waiting');
    // the phase it is in lists its agents: label, what it does now (the newest progress wins, in a subagent's words), state
    expect(out).toContain('searcher 2');
    expect(out).toContain('Reading traefik.io');
    expect(out).toContain('Reading community.traefik.io');
    expect(out).toContain('data-agent-state="running"');
    expect(out).toContain('>waiting<');
    expect(out).toContain('>queued<');
    // a phase that is over stays one line
    expect(out).not.toContain('framer');
    expect(out).toContain('href="/workflows/runs/wfr_1"');
    expect(out).toContain('Open run');
  });

  test('when the run ends: the first line of its result and how long it took', () => {
    const out = html(<WorkflowRowView name="deep-research" run={ended} calls={calls.map((c) => ({ ...c, state: 'done', finishedAt: NOW - 5_000 }))} runResult={report} result={{ type: 'tool_result', toolUseId: 'wf', content: 'Workflow deep-research done.', meta: { workflowRunId: 'wfr_1' } }} />);
    expect(out).toContain('data-state="done"');
    expect(out).toContain(': Use Caddy for the homelab front door.');
    expect(out).toContain('done in 2m');
    expect(out).not.toContain('searcher 2');
    // opened: the result line, the phases and Open run
    const open = html(<WorkflowDetail name="deep-research" run={ended} calls={calls} runResult={report} />);
    expect(open).toContain('Use Caddy for the homelab front door.');
    expect(open).toContain('Open run');
  });

  test('before the run is known: starting; a call refused before it ran: did not start, in its own words', () => {
    const starting = html(<WorkflowRowView name="deep-research" />);
    expect(starting).toContain('>starting<');
    expect(starting).not.toContain(', starting');
    expect(starting).toContain('data-state="starting"');
    expect(html(<WorkflowDetail name="deep-research" />)).toContain('Waiting for approval or starting.');
    const refused = html(<WorkflowRowView name="deep-research" result={{ type: 'tool_result', toolUseId: 'wf', content: 'The owner did not approve the workflow deep-research.', isError: true }} />);
    expect(refused).toContain('did not start');
    expect(refused).toContain(': The owner did not approve the workflow deep-research.');
    expect(refused).toContain('text-fault');
  });

  test('on a phone: the same row in one line, closed', () => {
    const out = html(<WorkflowRowView name="deep-research" run={run()} calls={calls} layout="phone" />);
    expect(out).toContain('data-workflow-row');
    expect(out).toContain(', 2 of 5 agents running');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('min-h-11');
  });

  test('a workflow is named by the library name or its script', () => {
    expect(workflowName({ name: 'review-changes' })).toBe('review-changes');
    expect(workflowName({ script: "export const meta = { name: 'sweep', description: 'x' }" })).toBe('sweep');
    expect(workflowName({ scriptPath: '/a.js' })).toBe('workflow');
  });
});

describe('row words', () => {
  test('"3 of 6 agents running" and where the run is: the words Android uses too', () => {
    const r = run({ phases: [{ title: 'Frame' }, { title: 'Search' }, { title: 'Check' }, { title: 'Write' }, { title: 'Critic' }], counts: { agents: 6, queued: 1, running: 3, done: 2, cached: 0, failed: 0, skipped: 0, parked: 0 } });
    expect(agentsRunning(r)).toBe('3 of 6 agents running');
    expect(phaseLine(r)).toBe('Phase 2 of 5, Search');
    expect(taskLine(r)).toBe('Phase 2 of 5, Search. 3 of 6 agents running');
    expect(agentsRunning(run({ counts: { agents: 1, queued: 0, running: 1, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 } }))).toBe('1 of 1 agent running');
    // before its first phase and its first agent
    expect(phaseLine(run({ phaseIndex: -1 }))).toBeUndefined();
    expect(taskLine(run({ phaseIndex: -1, counts: { agents: 0, queued: 0, running: 0, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 } }))).toBe('Starting');
  });

  test('the state at the right: the time while it runs, a word otherwise', () => {
    expect(workflowRowState({ run: run() })).toMatchObject({ detail: '2 of 5 agents running', sep: ', ', running: true, live: true });
    expect(workflowRowState({ run: run({ status: 'paused' }) })).toMatchObject({ word: 'paused', tone: 'warn', running: false, live: true });
    expect(workflowRowState({ run: run({ status: 'waiting_reset' }) })).toMatchObject({ word: 'waiting for the limit', tone: 'warn' });
    expect(workflowRowState({ run: ended, runResult: report })).toMatchObject({ detail: 'Use Caddy for the homelab front door.', sep: ': ', word: 'done in 2m', live: false });
    expect(workflowRowState({ run: run({ status: 'failed', error: 'budget reached', finishedAt: NOW }) })).toMatchObject({ detail: 'budget reached', word: 'failed', tone: 'fault' });
    // a run with no result line says how many agents it had
    expect(workflowRowState({ run: run({ status: 'stopped', finishedAt: NOW }) })).toMatchObject({ detail: '5 agents', sep: ', ', word: 'stopped' });
    // the call names its run and it is loading: nothing yet, so it never reads done first
    const loading = workflowRowState({ result: { meta: { workflowRunId: 'wfr_1' } } });
    expect(loading.detail).toBeUndefined();
    expect(loading.word).toBeUndefined();
    // a harness's own workflow: its text
    expect(workflowRowState({ result: {}, toolText: 'Workflow sweep done.\n\nAll clear.' })).toMatchObject({ detail: 'All clear.', word: 'done' });
  });

  test("an agent's last tool in a subagent's words", () => {
    expect(agentDoing('Grep "jwt" in packages/server')).toEqual({ text: 'Searching for jwt', waiting: false });
    expect(agentDoing('Glob **/*.ts')?.text).toBe('Searching for **/*.ts');
    expect(agentDoing('Read /home/me/code/src/auth.ts')?.text).toBe('Reading auth.ts');
    expect(agentDoing('Edit src/auth.ts')?.text).toBe('Editing auth.ts');
    expect(agentDoing('Fetch https://www.caddyserver.com/docs/caddyfile')?.text).toBe('Reading caddyserver.com');
    expect(agentDoing('WebFetch doc.traefik.io')?.text).toBe('Reading doc.traefik.io');
    expect(agentDoing('Search: caddy vs traefik')?.text).toBe('Searching the web for caddy vs traefik');
    expect(agentDoing('Run: cd app && bun test')?.text).toBe('Running bun test');
    expect(agentDoing('needs approval: Fetch community.traefik.io')).toEqual({ text: 'Reading community.traefik.io', waiting: true });
    // a summary it does not know stays as it is
    expect(agentDoing('Write the report')?.text).toBe('Write the report');
    expect(agentDoing('Run the server tests')?.text).toBe('Run the server tests');
    expect(agentDoing(undefined)).toBeUndefined();
    expect(lowerFirst('Searching for jwt')).toBe('searching for jwt');
  });
});

describe('card words', () => {
  test('phases: done, current and next, with the calls of each', () => {
    const p = cardPhases(run(), calls);
    expect(p.map((x) => [x.title, x.state, x.calls.length])).toEqual([
      ['Frame', 'done', 1],
      ['Search', 'current', 4],
      ['Check', 'next', 0],
      ['Write', 'next', 0],
    ]);
    expect(phaseWords(p[1])).toBe('1 of 4 done, 1 running, 1 waiting');
    expect(phaseWords(p[2])).toBe('');
    // an ended run has no current phase
    expect(cardPhases(run({ status: 'failed' }), calls).map((x) => x.state)).toEqual(['done', 'done', 'next', 'next']);
    // calls in a phase meta does not name come last
    expect(cardPhases(run(), [...calls, agent(9, 'extra', 'Elsewhere', 'running')]).at(-1)).toMatchObject({ title: 'Other calls', state: 'current' });
  });

  test('a long phase shows the agents still at work, in order, and how many more the run has', () => {
    const many = Array.from({ length: 12 }, (_, i) => agent(i + 1, `a${i + 1}`, 'Search', i < 7 ? 'done' : 'running'));
    const { shown, more } = shownCalls(many);
    expect(shown.map((c) => c.label)).toEqual(['a8', 'a9', 'a10', 'a11', 'a12']);
    expect(more).toBe(7);
    expect(shownCalls(many.slice(0, 3)).more).toBe(0);
  });

  test("the result in one line: the run's report, else the tool's text, else the error", () => {
    expect(resultLine('Use Caddy.\nMore lines.')).toBe('Use Caddy.');
    expect(resultLine({ summary: '**3 findings**, 1 proven' })).toBe('3 findings, 1 proven');
    expect(resultLine(undefined, 'Workflow review-changes done. Run wfr_1. 4 agents (4 done), 9 tokens, $0.10.\n\n{"report":"- No problems found."}')).toBe('No problems found.');
    expect(resultLine(undefined, 'Workflow x failed. Run wfr_2.\n\n(no result)', 'budget reached')).toBe('budget reached');
    expect(resultLine(undefined, undefined, undefined)).toBeUndefined();
    expect(resultLine('x'.repeat(300))?.length).toBe(200);
  });
});

describe('a workflow and a subagent are never folded', () => {
  const bash = (id: string): ToolUseBlock => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'flutter analyze' } });
  const ok = (id: string) => ({ type: 'tool_result' as const, toolUseId: id, content: 'ok' });
  const task: ToolUseBlock = { type: 'tool_use', id: 't9', name: 'Task', input: { description: 'Check the tests', subagent_type: 'explore', prompt: 'x' } };

  test('desktop: the calls around them fold, the workflow and the subagent are a row each', () => {
    // the owner's turn on a phone: "Ran set, ran flutter analyze, ran a workflow and 1 more"
    const items = [{ tool: bash('b1'), result: ok('b1') }, { tool: bash('b2'), result: ok('b2') }, { tool: wf() }, { tool: task, result: { ...ok('t9'), meta: { durationMs: 3000 } } }, { tool: bash('b3'), result: ok('b3') }];
    const out = html(<ToolGroup entries={asWork(items)} sessionId="s1" />);
    expect(out).toContain('data-workflow-row');
    expect(out).toContain('data-fanout-line');
    expect(out).toContain('Ran 2 commands');
    expect(out).not.toContain('workflow and');
    expect(out).not.toContain('ran 1 subagent');
    expect(out).not.toContain('data-workflow-card');
  });

  test('a phone: each workflow is one row that opens in place, not a card and not a sheet', () => {
    const items = [{ tool: bash('b1'), result: ok('b1') }, { tool: wf() }, { tool: { ...wf('w2'), name: 'mcp__conclave__Workflow' } }];
    const out = html(<PhoneWork entries={asWork(items)} sessionId="s1" live />);
    expect((out.match(/data-workflow-row/g) ?? []).length).toBe(2);
    expect(out).not.toContain('data-workflow-card');
  });
});

describe('a subagent while it runs', () => {
  const task: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Find all JWT usages', subagent_type: 'explore', prompt: 'List them.' } };
  const child = { id: 'c1', parentId: 's1', title: 'Find all JWT usages', agent: 'explore', model: 'anthropic/claude-haiku-5-5', status: 'running' } as Session;
  const grep: Message = { id: 'cm', sessionId: 'c1', seq: 2, role: 'assistant', kind: 'normal', createdAt: NOW, content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'jwt\\.(sign|verify)' } }] };
  const running = { status: 'running' as const, name: 'Task', startedAt: NOW - 41_000, progress: '' };
  const state = (p: Partial<Pick<HubState, 'sessions' | 'messages' | 'tools' | 'streaming'>> = {}) => ({ sessions: { c1: child }, messages: { c1: [grep] }, tools: { g1: { status: 'running' as const, name: 'Grep', startedAt: NOW - 1000, progress: '' } }, streaming: {}, ...p });

  test('its one row names the subagent and what it does, says what it is doing now and runs the time', () => {
    // a string render reads the store as it starts: no subagent session yet, so it says starting
    // the time runs from when the call started (the clock reads whole seconds)
    const out = html(<ToolRow item={{ tool: task, run: { ...running, startedAt: Date.now() - 41_500 } }} sessionId="s1" />);
    expect(out).toContain('id="tool-t1"');
    // one Task is the fan-out card with one line
    expect(out).toContain('1 subagent, 1 running');
    expect(out).toContain('Find all JWT usages<span class="text-fg-3">, explore</span>');
    expect(out).toContain('>Starting<');
    expect(out).toContain('41s');
    // done: the first line of its report, and the time it took
    const done = html(<ToolRow item={{ tool: task, result: { type: 'tool_result', toolUseId: 't1', content: 'Found 3.', meta: { durationMs: 41_000 } } }} sessionId="s1" />);
    expect(done).not.toContain('Starting');
    expect(done).toContain('>Found 3.<');
    expect(done).toContain('41s');
    expect(done).toContain('data-state="done"');
  });

  test('what it is doing now comes from its own session: its latest call, writing, thinking, or waiting on you', () => {
    expect(subagentNowOf(state(), 'c1')).toEqual({ text: 'Searching for jwt\\.(sign|verify)', waiting: false });
    expect(subagentNowOf(state({ tools: {} }), 'c1').text).toBe('Searched jwt\\.(sign|verify)');
    expect(subagentNowOf(state({ sessions: { c1: { ...child, status: 'waiting_approval' } } }), 'c1')).toEqual({ text: 'Waiting on you', waiting: true });
    const writing: Message = { ...grep, id: 'cm2', seq: 4, content: [{ type: 'text', text: 'Found three.' }] };
    expect(subagentNowOf(state({ messages: { c1: [grep, writing] }, streaming: { cm2: true } }), 'c1').text).toBe('Writing');
    const thinking: Message = { ...grep, id: 'cm3', seq: 4, content: [{ type: 'thinking', thinking: 'Hm' }] };
    expect(subagentNowOf(state({ messages: { c1: [grep, thinking] }, streaming: { cm3: true } }), 'c1').text).toBe('Thinking');
    expect(subagentNowOf(state({ messages: {} }), 'c1').text).toBe('Starting');
    expect(subagentNowOf(state(), undefined).text).toBe('Starting');
  });

  test('on a phone the same one row, with its name', () => {
    const out = html(<PhoneWork entries={asWork([{ tool: task, run: running }])} sessionId="s1" live />);
    expect(out).toContain('data-fanout-line');
    expect(out).toContain('Find all JWT usages<span class="text-fg-3">, explore</span>');
    expect(out).toContain('>Starting<');
  });

  test('the words: the call running now in the present, the last one in the past', () => {
    expect(subagentNow(undefined, false)).toBe('Starting');
    expect(subagentNow({ name: 'Bash', input: { command: 'cd app && bun test' } }, true)).toBe('Running bun test');
    expect(subagentNow({ name: 'Read', input: { file_path: 'src/auth.ts' } }, true)).toBe('Reading auth.ts');
    expect(subagentNow({ name: 'Read', input: { file_path: 'src/auth.ts' } }, false)).toBe('Read auth.ts');
    expect(subagentNow({ name: 'Glob', input: { pattern: '**/*.ts' } }, true)).toBe('Searching for **/*.ts');
    // the phone's working line while a workflow runs
    expect(workingWords({ name: 'Workflow', input: { name: 'deep-research' } })).toBe('Running deep-research');
    expect(workingWords({ name: 'Workflow', input: { script: 'export const meta = {}' } })).toBe('Running a workflow');
  });
});
