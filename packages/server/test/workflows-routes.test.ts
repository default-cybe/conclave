/**
 * Workflow routes (routes-workflows.ts): input checks, the calls they make,
 * and the 501 without a workflow service. The service runs real workflows
 * in packages/core/test/workflows; here a stub stands in for it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setWorkflows } from '@conclave/core/workflows/attached.ts';
import type { WorkflowService } from '@conclave/core/workflows/service.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
const calls: Array<{ method: string; args: unknown[] }> = [];
const run = { id: 'wfr_1', name: 'review-changes', status: 'running' };

beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

function stub(): void {
  const rec =
    (method: string, out: unknown = run) =>
    (...args: unknown[]) => (calls.push({ method, args }), out);
  const svc = {
    library: rec('library', [{ id: 'review-changes' }]),
    detail: rec('detail', { id: 'claude-security:scan', script: 'x' }),
    runs: rec('runs', [run]),
    startRun: async (...args: unknown[]) => rec('startRun')(...args),
    run: rec('run', { run, calls: [], logs: [], findings: [] }),
    pause: rec('pause'),
    resume: async (...args: unknown[]) => rec('resume')(...args),
    stop: rec('stop'),
    rerun: async (...args: unknown[]) => rec('rerun')(...args),
    skip: rec('skip'),
    worktree: async (...args: unknown[]) => rec('worktree', { ok: true, state: 'kept', output: 'diff' })(...args),
    judgeFinding: rec('judgeFinding', { id: 'wff_1', verdict: 'dismissed' }),
  };
  setWorkflows(hub.engine, svc as unknown as WorkflowService);
}

describe('without a workflow service', () => {
  test('the routes answer 501', async () => {
    const r = await hub.api('/api/workflows');
    expect(r.status).toBe(501);
  });
});

describe('with a workflow service', () => {
  beforeAll(() => stub());

  test('library, one workflow by an encoded plugin id, and runs', async () => {
    expect((await hub.api('/api/workflows')).status).toBe(200);
    const one = await hub.api(`/api/workflows/${encodeURIComponent('claude-security:scan')}`);
    expect(one.status).toBe(200);
    expect(calls.find((c) => c.method === 'detail')?.args[0]).toBe('claude-security:scan');
    // a session in the query must be the caller's own
    expect((await hub.api('/api/workflows/runs?sessionId=ses_x')).status).toBe(404);
    const s = await hub.engine.createSession({ title: 'Runs' });
    const runs = await hub.api(`/api/workflows/runs?status=running&limit=5&sessionId=${s.id}`);
    expect(runs.status).toBe(200);
    expect(calls.find((c) => c.method === 'runs')?.args[0]).toEqual({ sessionId: s.id, accountId: 'owner', status: 'running', limit: 5 });
    expect((await hub.api('/api/workflows/runs?status=sleeping')).status).toBe(400);
  });

  test('starting a run checks its body', async () => {
    expect((await hub.api('/api/workflows/runs', { method: 'POST', json: {} })).status).toBe(400);
    expect((await hub.api('/api/workflows/runs', { method: 'POST', json: { name: 'x', budget: { tokens: -5 } } })).status).toBe(400);
    expect((await hub.api('/api/workflows/runs', { method: 'POST', json: { name: 'x', background: 'yes' } })).status).toBe(400);
    expect((await hub.api('/api/workflows/runs', { method: 'POST', json: { name: 'x', device: 'nope' } })).status).toBe(409);
    const ok = await hub.api('/api/workflows/runs', { method: 'POST', json: { name: 'review-changes', args: { base: 'main' }, budget: { tokens: 500000.7, costUsd: 3 }, background: true } });
    expect(ok.status).toBe(201);
    expect(calls.find((c) => c.method === 'startRun')?.args[0]).toEqual({ name: 'review-changes', args: { base: 'main' }, budget: { tokens: 500000, costUsd: 3 }, background: true });
  });

  test('controls, skip, rerun, worktree actions and verdicts', async () => {
    for (const a of ['pause', 'resume', 'stop']) expect((await hub.api(`/api/workflows/runs/wfr_1/${a}`, { method: 'POST' })).status).toBe(200);
    expect((await hub.api('/api/workflows/runs/wfr_1/rerun', { method: 'POST', json: { fromSeq: 0 } })).status).toBe(400);
    expect((await hub.api('/api/workflows/runs/wfr_1/rerun', { method: 'POST', json: { fromSeq: 3 } })).status).toBe(200);
    expect(calls.find((c) => c.method === 'rerun')?.args).toEqual(['wfr_1', 3]);
    expect((await hub.api('/api/workflows/runs/wfr_1/calls/x/skip', { method: 'POST' })).status).toBe(400);
    expect((await hub.api('/api/workflows/runs/wfr_1/calls/2/skip', { method: 'POST' })).status).toBe(200);
    expect((await hub.api('/api/workflows/runs/wfr_1/calls/2/worktree', { method: 'POST', json: { action: 'rebase' } })).status).toBe(400);
    const wt = await hub.api('/api/workflows/runs/wfr_1/calls/2/worktree', { method: 'POST', json: { action: 'merge' } });
    expect(wt.status).toBe(200);
    expect(calls.find((c) => c.method === 'worktree')?.args).toEqual(['wfr_1', 2, 'merge']);
    expect((await hub.api('/api/workflows/runs/wfr_1/findings/wff_1', { method: 'POST', json: { verdict: 'maybe' } })).status).toBe(400);
    const v = await hub.api('/api/workflows/runs/wfr_1/findings/wff_1', { method: 'POST', json: { verdict: 'dismissed', reason: 'intended' } });
    expect(v.status).toBe(200);
    expect(calls.find((c) => c.method === 'judgeFinding')?.args).toEqual(['wfr_1', 'wff_1', 'dismissed', 'intended']);
  });

  test('the routes need the owner token', async () => {
    expect((await hub.api('/api/workflows', { token: null })).status).toBe(401);
  });
});

describe('malformed input (QA)', () => {
  beforeAll(() => stub());

  test('a workflow id with a broken percent escape is a 400, not a 500', async () => {
    const r = await hub.api('/api/workflows/%E0%A4%A');
    expect(r.status).toBe(400);
  });

  test('a workflow named with a % is decoded once', async () => {
    calls.length = 0;
    const r = await hub.api(`/api/workflows/${encodeURIComponent('100% tests')}`);
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.method === 'detail')?.args[0]).toBe('100% tests');
  });
});
