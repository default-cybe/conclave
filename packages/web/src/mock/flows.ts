/**
 * Flows in the mock app (features/canvas/CanvasPage): one scraper flow parsed by
 * the hub's own parser, and a finished run with values on its wires and one
 * block that failed, for the screenshots and the graph test.
 */
import type { CanvasQueuedRun, FlowEditResult, FlowOp, FlowRunView, FlowView } from '@conclave/core/client';
import { applyFlowOp, parseFlow } from '@conclave/core/flows/graph';
import { FLOW_BLOCKS } from '@conclave/core/flows/plugins';
import { lineDiff } from '@conclave/core/workflows/graph';
import type { MockCtx } from './index';

export const SCRAPER_FLOW = `// Flow "scraper": fetch a JSON API, pick fields, filter, write CSV.
import { fetchUrl, pick, filter, writeCsv, log } from './lib';

const url = 'https://hn.algolia.com/api/v1/search?tags=front_page';
const data = await fetchUrl({ url, as: 'json', method: 'GET' });
const posts = await pick({ from: data, field: 'hits' });
const bun = await filter({ items: posts, field: 'title', op: 'contains', value: 'bun' });
const csv = await writeCsv({ path: 'out/posts.csv', rows: bun, columns: 'objectID, title, points' });
const top = bun.sort((a, b) => b.points - a.points)[0].title;
await log({ value: top });
`;

export const SCRAPER_RUN: FlowRunView = {
  runId: 'flr_mock1',
  flow: 'scraper',
  status: 'failed',
  startedAt: Date.now() - 4_000,
  finishedAt: Date.now() - 2_700,
  exitCode: 1,
  output: "TypeError: undefined is not an object (evaluating 'bun.sort(...)[0].title')\n      at flows/scraper.flow.ts:9:51\n",
  error: "TypeError: undefined is not an object (evaluating 'bun.sort(...)[0].title')",
  nodes: {
    data: { ok: true, ms: 412, summary: '{ hits, nbHits, page }', value: '{\n  "hits": [ … 30 items ],\n  "nbHits": 30,\n  "page": 0\n}' },
    posts: { ok: true, ms: 0, summary: '30 items', value: '[\n  { "objectID": "4211", "title": "Show HN: a tiny CSV tool", "points": 212 },\n  …\n]' },
    bun: { ok: true, ms: 1, summary: '0 items', value: '[]' },
    csv: { ok: true, ms: 3, summary: 'out/posts.csv', value: 'out/posts.csv' },
    'code-1': { ok: false, error: "TypeError: undefined is not an object (evaluating 'bun.sort(...)[0].title')" },
  },
};

export function registerFlows(ctx: MockCtx): void {
  let src = SCRAPER_FLOW;
  let sha = 1;
  // every version the mock wrote, for restore (undo and redo), as the hub keeps them
  const versions = new Map<string, string>([['mock1', src]]);
  const view = (): FlowView => ({ name: 'scraper', path: 'flows/scraper.flow.ts', graph: parseFlow(src), sha: `mock${sha}`, lastRun: now() });
  const stale = (base: unknown) => base !== `mock${sha}` && ctx.fail(409, 'script changed: the file changed since the graph was read; reload it');
  // screenshots read the file text, and write it as an editor outside the canvas would
  (globalThis as { __MOCK_FLOW__?: unknown }).__MOCK_FLOW__ = {
    src: () => src,
    write: (next: string) => {
      src = next;
      sha++;
    },
  };
  ctx.on('POST', '/api/sessions/:id/flows/:name/graph/restore', ({ body }) => {
    stale(body?.baseSha);
    const next = versions.get(String(body?.sha));
    if (next === undefined) return ctx.fail(400, 'that version is not one the canvas wrote');
    const before = src;
    src = next;
    sha++;
    versions.set(`mock${sha}`, src);
    return { sha: `mock${sha}`, diff: lineDiff(before, src), view: view() } satisfies FlowEditResult;
  });
  ctx.on('GET', '/api/graph/nodes', () => FLOW_BLOCKS);
  ctx.on('GET', '/api/sessions/:id/flows', () => [{ name: 'scraper', path: 'flows/scraper.flow.ts' }]);
  ctx.on('GET', '/api/sessions/:id/flows/:name/graph', () => view());
  // Run: the blocks end one a second, then the same failure as SCRAPER_RUN; Stop ends it where it is
  // the run and the queue live on the hub, so a reload keeps them: here in sessionStorage (a reload during a run reopens on it)
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('mock.canvas.run') ?? 'null') as { run: FlowRunView; queue: CanvasQueuedRun[] } | null;
    } catch {
      return null;
    }
  })();
  let run: FlowRunView = saved?.run ?? SCRAPER_RUN;
  const save = () => {
    try {
      sessionStorage.setItem('mock.canvas.run', JSON.stringify({ run, queue }));
    } catch {
      /* no storage (tests) */
    }
  };
  const now = (): FlowRunView => {
    if (run === SCRAPER_RUN || run.status !== 'running') return run;
    const ids = Object.keys(SCRAPER_RUN.nodes);
    const n = Math.floor((Date.now() - run.startedAt) / 1000);
    if (n >= ids.length) run = { ...SCRAPER_RUN, runId: run.runId, startedAt: run.startedAt, finishedAt: Date.now() };
    else run = { ...run, nodes: Object.fromEntries(ids.slice(0, n).map((id) => [id, SCRAPER_RUN.nodes[id]])) };
    save();
    return run;
  };
  const begin = () => {
    run = { runId: ctx.uid('flr'), flow: 'scraper', status: 'running', startedAt: Date.now(), output: '', nodes: {} } as FlowRunView;
    save();
    return run;
  };
  // the hub's run queue (core canvas/queue.ts): the next program run starts when the last ends, read or not;
  // the mock moves it whenever any route reads the run, as the hub's end event would
  const queue: CanvasQueuedRun[] = saved?.queue ?? [];
  const pump = () => {
    const r = now();
    const i = queue.findIndex((q) => q.kind === 'program');
    if (r.status !== 'running' && i >= 0) {
      queue.splice(i, 1);
      begin();
    }
  };
  (globalThis as { __MOCK_CANVAS_QUEUE__?: unknown }).__MOCK_CANVAS_QUEUE__ = queue;
  ctx.on('GET', '/api/canvas/queue', ({ query }) => (pump(), queue.filter((q) => !query.get('file') || q.file === query.get('file'))));
  ctx.on('POST', '/api/canvas/queue', ({ body }) => {
    const b = (body ?? {}) as { workflow?: string; sessionId?: string; flow?: string; args?: Record<string, unknown> };
    const item: CanvasQueuedRun = b.workflow
      ? { id: ctx.uid('cvq'), file: `workflow:${b.workflow}`, kind: 'workflow', workflow: b.workflow, ...(b.args ? { args: b.args } : {}), createdAt: Date.now() }
      : { id: ctx.uid('cvq'), file: `program:${b.sessionId}:${b.flow}`, kind: 'program', sessionId: b.sessionId, flow: b.flow, createdAt: Date.now() };
    queue.push(item);
    pump();
    save();
    return item;
  });
  ctx.on('DELETE', '/api/canvas/queue/:id', ({ params }) => {
    const i = queue.findIndex((q) => q.id === params[0]);
    if (i < 0) return ctx.fail(404, 'queued run not found');
    queue.splice(i, 1);
    save();
    return null;
  });
  ctx.on('GET', '/api/sessions/:id/flows/:name/run', () => (pump(), now()));
  ctx.on('POST', '/api/sessions/:id/flows/:name/run', async () => {
    await ctx.sleep(250);
    return begin();
  });
  ctx.on('POST', '/api/sessions/:id/flows/:name/stop', () => {
    const r = now();
    if (r.status !== 'running') return r;
    run = { ...r, status: 'stopped', finishedAt: Date.now(), error: 'stopped by the owner' } as FlowRunView;
    save();
    return run;
  });
  ctx.on('PUT', '/api/sessions/:id/flows/:name/graph/layout', ({ body }) => body);
  ctx.on('POST', '/api/sessions/:id/flows/:name/graph/op', ({ body }) => {
    stale(body?.baseSha);
    const before = src;
    let r: ReturnType<typeof applyFlowOp>;
    try {
      r = applyFlowOp(src, body as FlowOp);
    } catch (err) {
      return ctx.fail(400, (err as Error).message);
    }
    src = r.src;
    sha++;
    versions.set(`mock${sha}`, src);
    return { sha: `mock${sha}`, diff: lineDiff(before, src), view: view(), ...(r.nodeId ? { nodeId: r.nodeId } : {}) } satisfies FlowEditResult;
  });
}
