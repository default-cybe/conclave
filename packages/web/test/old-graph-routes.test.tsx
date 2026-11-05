/**
 * The old graph boxes are gone (Canvas PR 4): /workflows/graph/:id and a
 * run's ?view=graph open the same file in Canvas, a run page without it
 * still renders, a Code session's Open in Canvas goes to its first program,
 * and a run's summary says its state, time, cost and the failed step.
 *
 *   bun test packages/web/test/old-graph-routes.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WorkflowCall, WorkflowRun } from '@conclave/core/client';
import { oldGraphRedirect, sessionCanvasHref } from '../src/features/canvas/model';
import { runSummary } from '../src/features/workflows/words';

describe('old graph addresses', () => {
  test('a workflow graph and a run in graph view go to Canvas', () => {
    expect(oldGraphRedirect('/workflows/graph/triage', '')).toBe('/canvas/workflow/triage');
    expect(oldGraphRedirect('/workflows/graph/my%20flow', '')).toBe('/canvas/workflow/my%20flow');
    expect(oldGraphRedirect('/workflows/runs/wfr_1', 'view=graph')).toBe('/canvas/workflow/wfr_1');
    expect(oldGraphRedirect('/workflows/runs/wfr_1', '?view=graph')).toBe('/canvas/workflow/wfr_1');
  });
  test('the run list and a run without ?view=graph stay', () => {
    expect(oldGraphRedirect('/workflows/runs/wfr_1', '')).toBeUndefined();
    expect(oldGraphRedirect('/workflows/runs/wfr_1', 'view=list')).toBeUndefined();
    expect(oldGraphRedirect('/workflows/runs', 'view=graph')).toBeUndefined();
  });
});

describe('Open in Canvas from a Code session', () => {
  test('the first program in the folder, else the start page', () => {
    expect(sessionCanvasHref({ device: 'local', cwd: '/w/app' }, [{ name: 'scraper' }, { name: 'b' }])).toBe('/canvas/program/scraper?device=local&cwd=%2Fw%2Fapp');
    expect(sessionCanvasHref({ device: 'local', cwd: '/w/app' }, [])).toBe('/canvas');
    expect(sessionCanvasHref({ device: 'local', cwd: '' }, [{ name: 'scraper' }])).toBe('/canvas');
  });
});

describe('run summary', () => {
  const run = { status: 'failed', createdAt: 0, startedAt: 1000, finishedAt: 61_000, costUsd: 0.42, error: 'script threw', phaseTitle: 'Review' } as WorkflowRun;
  test('state, time, cost and the failed call with its error', () => {
    const calls = [{ seq: 1, state: 'done' }, { seq: 2, state: 'failed', label: 'reviewer', error: 'rate limited' }] as WorkflowCall[];
    const s = runSummary(run, calls);
    expect(s.state).toBe('failed');
    expect(s.took).toBe('1m');
    expect(s.cost).toContain('0.42');
    expect(s.failed).toEqual({ step: 'reviewer', error: 'rate limited' });
  });
  test('a failed script with no failed call names the phase; a done run has no failure', () => {
    expect(runSummary(run, []).failed).toEqual({ step: 'Review', error: 'script threw' });
    expect(runSummary({ ...run, status: 'done', error: undefined }, []).failed).toBeUndefined();
    // still running: the time counts to now
    expect(runSummary({ ...run, status: 'running', finishedAt: undefined }, [], 31_000).took).toBe('30s');
  });
});

// rendered: an old address never leaves a blank page
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
const saved: Record<string, unknown> = {};
beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  g.window = dom.window;
  g.document = dom.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

async function open(path: string) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Route, Router, Switch } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { OldGraph } = await import('../src/features/canvas/OldGraph');
  const mem = memoryLocation({ path, record: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  // the routes as App.tsx has them
  await act(async () =>
    root.render(
      <Router hook={mem.hook} searchHook={mem.searchHook}>
        <Switch>
          <Route path="/workflows/runs/:id?">
            <OldGraph fallback={<p>run page</p>} />
          </Route>
          <Route path="/workflows/graph/:id">
            <OldGraph />
          </Route>
          <Route path="/canvas/:kind/:name">{(p) => <p>canvas {p.kind} {p.name}</p>}</Route>
          <Route path="/canvas">
            <p>canvas start</p>
          </Route>
        </Switch>
      </Router>,
    ),
  );
  const text = host.textContent;
  await act(async () => root.unmount());
  host.remove();
  return { text, at: mem.history.at(-1) };
}

describe('old routes render something', () => {
  test('/workflows/graph/:id opens the workflow in Canvas', async () => {
    expect(await open('/workflows/graph/triage')).toEqual({ text: 'canvas workflow triage', at: '/canvas/workflow/triage' });
  });
  test('a run with ?view=graph opens the run in Canvas', async () => {
    expect(await open('/workflows/runs/wfr_7?view=graph')).toEqual({ text: 'canvas workflow wfr_7', at: '/canvas/workflow/wfr_7' });
  });
  test('a run without it is the run page', async () => {
    expect((await open('/workflows/runs/wfr_7')).text).toBe('run page');
  });
});
