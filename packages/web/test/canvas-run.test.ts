/**
 * Canvas mode, PR 3 (features/canvas/run.ts, core client/graph.ts): the queue
 * of runs per file survives a reload and cancels one at a time, a running
 * program's blocks read running then queued, a workflow node carries its
 * error and short value, and the agent's message carries the file context.
 *
 *   bun test packages/web/test/canvas-run.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { nodeRuns, shortValue } from '@conclave/core/client/graph';
import type { WorkflowCall } from '@conclave/core/client';
import { parseGraph } from '@conclave/core/workflows/graph';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { agentMessage, agentSessionOf, dropQueued, folderOf, programStates, queueRun, queuedRuns, rememberAgentSession, takeQueued } = await import('../src/features/canvas/run');

describe('the queue', () => {
  test('Queue run adds after the rest, kept in storage; cancel drops one; take starts the oldest', () => {
    const a = queueRun('workflow:x', { q: 1 });
    queueRun('workflow:x');
    expect(queuedRuns('workflow:x').length).toBe(2);
    // a reload reads it back
    expect(queuedRuns('workflow:x')[0]).toEqual(a[0]);
    expect(queuedRuns('workflow:y')).toEqual([]);
    const left = dropQueued('workflow:x', queuedRuns('workflow:x')[1].id);
    expect(left.map((q) => q.args)).toEqual([{ q: 1 }]);
    expect(takeQueued('workflow:x')?.args).toEqual({ q: 1 });
    expect(takeQueued('workflow:x')).toBeUndefined();
    for (let i = 0; i < 12; i++) queueRun('workflow:z');
    expect(queuedRuns('workflow:z').length).toBe(10);
  });
  test('broken storage reads as empty', () => {
    store.clear();
    store.set([...store.keys()][0] ?? 'x', 'nope');
    expect(queuedRuns('anything')).toEqual([]);
  });
});

describe('a live program', () => {
  const nodes = [{ id: 'data' }, { id: 'posts' }, { id: 'csv' }];
  test('the first block with no value is running, the rest queued; nothing when it ended', () => {
    expect(programStates(nodes, { status: 'running', nodes: { data: { ok: true } } })).toEqual({ posts: 'running', csv: 'queued' });
    expect(programStates(nodes, { status: 'approval', nodes: {} })).toEqual({ data: 'queued', posts: 'queued', csv: 'queued' });
    expect(programStates(nodes, { status: 'failed', nodes: {} })).toEqual({});
    expect(programStates(nodes, undefined)).toEqual({});
  });
});

describe('a workflow run on its nodes', () => {
  const g = parseGraph(`export const meta = { name: 'w', description: 'w' }\nconst a = await agent('one', { label: 'one' })\nconst b = await agent('two ' + a, { label: 'two' })\nreturn b\n`);
  const call = (seq: number, line: number, x: Partial<WorkflowCall>): WorkflowCall => ({ seq, kind: 'agent', state: 'done', attempt: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, at: [line], ...x }) as WorkflowCall;
  test('a failed node keeps the first error; a done node a short value for its wires', () => {
    const r = nodeRuns(g, [call(1, 2, { resultPreview: 'five steps, all checked and ready to go' }), call(2, 3, { state: 'failed', error: 'rate limited' })]);
    expect(r.byNode.get('agent-1')?.value).toBe('five steps, all checked…');
    expect(r.byNode.get('agent-2')).toMatchObject({ state: 'failed', error: 'rate limited' });
    expect(shortValue('  \n ')).toBeUndefined();
  });
});

describe('Ask the agent', () => {
  test('the message names the file, the selection and the last error', () => {
    const m = agentMessage('  add a summary step ', { file: 'flows/scraper.flow.ts', selection: [{ label: 'bun', lines: 'line 7' }], error: 'TypeError: x\n at y' });
    expect(m).toContain('editing flows/scraper.flow.ts');
    expect(m).toContain('valid flow');
    expect(m).toContain('Selected: bun (line 7).');
    expect(m).toContain('The last run failed: TypeError: x');
    expect(m.endsWith('\n\nadd a summary step')).toBe(true);
    expect(agentMessage('hi', { file: 'a.js', selection: [] })).not.toContain('Selected');
  });
  test('the session is kept per file; a workflow folder comes from its path', () => {
    rememberAgentSession('a.js', 's1');
    expect(agentSessionOf('a.js')).toBe('s1');
    expect(agentSessionOf('b.js')).toBeUndefined();
    expect(folderOf('~/.conclave/workflows/nightly-deps.js')).toBe('~/.conclave/workflows');
    expect(folderOf('builtin:x')).toBeUndefined();
    expect(folderOf(undefined)).toBeUndefined();
  });
});
