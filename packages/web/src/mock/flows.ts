/**
 * Flows in the mock app (features/graph/FlowView): one scraper flow parsed by
 * the hub's own parser, and a finished run with values on its wires and one
 * block that failed, for the screenshots and the graph test.
 */
import type { FlowEditResult, FlowOp, FlowRunView, FlowView } from '@conclave/core/client';
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
  const view = (): FlowView => ({ name: 'scraper', path: 'flows/scraper.flow.ts', graph: parseFlow(src), sha: `mock${sha}`, lastRun: SCRAPER_RUN });
  ctx.on('GET', '/api/graph/nodes', () => FLOW_BLOCKS);
  ctx.on('GET', '/api/sessions/:id/flows', () => [{ name: 'scraper', path: 'flows/scraper.flow.ts' }]);
  ctx.on('GET', '/api/sessions/:id/flows/:name/graph', () => view());
  ctx.on('GET', '/api/sessions/:id/flows/:name/run', () => SCRAPER_RUN);
  ctx.on('POST', '/api/sessions/:id/flows/:name/run', () => SCRAPER_RUN);
  ctx.on('PUT', '/api/sessions/:id/flows/:name/graph/layout', ({ body }) => body);
  ctx.on('POST', '/api/sessions/:id/flows/:name/graph/op', ({ body }) => {
    const before = src;
    const r = applyFlowOp(src, body as FlowOp);
    src = r.src;
    sha++;
    return { sha: `mock${sha}`, diff: lineDiff(before, src), view: view(), ...(r.nodeId ? { nodeId: r.nodeId } : {}) } satisfies FlowEditResult;
  });
}
