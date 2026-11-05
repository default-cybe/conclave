/**
 * Canvas mode, PR 3 (features/canvas/run.ts, core client/graph.ts): the hub's
 * queue key per file and when the hub started the next queued run, a running
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
const { agentMessage, agentSessionOf, folderOf, headLeft, programStates, queueFile, rememberAgentSession, startGuard, workflowLive } = await import('../src/features/canvas/run');

describe('the queue (on the hub)', () => {
  test('a file is keyed as the hub keys it', () => {
    expect(queueFile({ workflow: 'x' })).toBe('workflow:x');
    expect(queueFile({ sessionId: 'ses_1', flow: 'tick' })).toBe('program:ses_1:tick');
  });
  test('the head leaving the queue means the hub started it; a later cancel does not', () => {
    expect(headLeft([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }])).toBe(true);
    expect(headLeft([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }])).toBe(false);
    expect(headLeft([], [])).toBe(false);
  });
});

describe('Run starts one run', () => {
  test('a double-click starts once; the next click after the start lands starts again', async () => {
    const g = startGuard();
    let starts = 0;
    let finish = () => {};
    const start = () => (starts++, new Promise<void>((r) => (finish = r)));
    expect(g.run(start)).toBe(true);
    expect(g.run(start)).toBe(false);
    expect(starts).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(g.busy()).toBe(false);
    expect(g.run(start)).toBe(true);
    expect(starts).toBe(2);
  });
  test('a run just started is live while the detail still shows the old run, or none yet', () => {
    const old = { run: { id: 'wfr_old', status: 'done' as const } };
    expect(workflowLive(undefined, 'wfr_old', old)).toBe(false);
    expect(workflowLive('wfr_new', 'wfr_new', old)).toBe(true);
    expect(workflowLive('wfr_new', 'wfr_new', undefined)).toBe(true);
    expect(workflowLive('wfr_new', 'wfr_new', { run: { id: 'wfr_new', status: 'running' } })).toBe(true);
    expect(workflowLive('wfr_new', 'wfr_new', { run: { id: 'wfr_new', status: 'done' } })).toBe(false);
    // its detail failed to load: Run again, not a queue that never moves
    expect(workflowLive('wfr_new', 'wfr_new', old, true)).toBe(false);
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
