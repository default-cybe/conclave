/**
 * Flows in the mock app (features/canvas/CanvasPage): one scraper flow parsed by
 * the hub's own parser, and a finished run with values on its wires and one
 * block that failed, for the screenshots and the graph test.
 */
import type { CanvasQueuedRun, FlowEditResult, FlowOp, FlowRunView, FlowView } from '@conclave/core/client';
import { applyFlowOp, parseFlow } from '@conclave/core/flows/graph';
import { FLOW_BLOCKS } from '@conclave/core/flows/plugins';
import { lineDiff } from '@conclave/core/workflows/graph';
import type { Session } from '@conclave/core/types';
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

/**
 * Programs made with Canvas's New (core canvas/new.ts): blank files in the
 * owner's Canvas folder on the hub, or in a folder picked with New in
 * folder... Each keeps its own text, versions and last run; a run ends one
 * block every 0.7 s, all fine, with a line of output per block. The scraper
 * stays on the routes below (ctx.pass).
 */
function registerNewFlows(ctx: MockCtx): void {
  interface File {
    name: string;
    src: string;
    sha: string;
    run?: FlowRunView;
    layout?: Record<string, { x: number; y: number }>;
  }
  const files = new Map<string, File>(); // `${session}/${name}`
  const versions = new Map<string, string>();
  let n = 0;
  const bump = (f: File) => {
    f.sha = `new${++n}`;
    versions.set(f.sha, f.src);
  };
  const fileOf = (params: string[]) => files.get(`${params[0]}/${decodeURIComponent(params[1])}`);
  const runOf = (f: File): FlowRunView | undefined => {
    const r = f.run;
    if (!r || r.status !== 'running') return r;
    const nodes = parseFlow(f.src).nodes;
    const done = Math.min(nodes.length, Math.floor((Date.now() - r.startedAt) / 700));
    const live = Object.fromEntries(nodes.slice(0, done).map((x) => [x.id, { ok: true, ms: 40, summary: 'ok', value: `${x.label}: ok` }]));
    const output = nodes.slice(0, done).map((x) => `${x.label}: ok`).join('\n');
    f.run = done < nodes.length ? { ...r, nodes: live, output } : { ...r, nodes: live, output: `${output}\nfinished: ${nodes.length} ${nodes.length === 1 ? 'block' : 'blocks'}\n`, status: 'done', exitCode: 0, finishedAt: Date.now() };
    return f.run;
  };
  const view = (f: File): FlowView => ({ name: f.name, path: `flows/${f.name}.flow.ts`, graph: parseFlow(f.src), sha: f.sha, ...(f.layout ? { layout: f.layout } : {}), ...(f.run ? { lastRun: runOf(f) } : {}) });
  const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const make = (sid: string, name: string) => {
    if (!NAME.test(name)) return ctx.fail(400, 'a flow name is lowercase letters, digits and dashes, up to 64');
    if (files.has(`${sid}/${name}`)) return ctx.fail(409, `flows/${name}.flow.ts already exists`);
    const f: File = { name, src: `// Flow "${name}". Conclave draws this file as blocks (.conclave/graph/${name}.json); edit it as code or as blocks.\n`, sha: '' };
    bump(f);
    files.set(`${sid}/${name}`, f);
    return view(f);
  };
  const namesIn = (sid: string) => [...files.keys()].filter((k) => k.startsWith(`${sid}/`)).map((k) => k.slice(sid.length + 1));
  // the owner's Canvas folder on the hub, and its Code session made on first use
  const HUB_CWD = '~/conclave-projects/canvas/owner';
  const canvasSession = () => {
    const old = [...ctx.db.sessions.values()].find((s) => s.device === 'local' && s.cwd === HUB_CWD && s.kind !== 'chat');
    if (old) return old;
    const t = Date.now();
    const s = { id: ctx.uid('s'), title: 'Canvas', agent: 'coder', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'default', cwd: HUB_CWD, device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: t, updatedAt: t, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } } as Session;
    ctx.db.sessions.set(s.id, s);
    ctx.db.messages.set(s.id, []);
    ctx.emit({ type: 'session.created', session: structuredClone(s) });
    return s;
  };
  ctx.on('POST', '/api/canvas/programs', ({ body }) => {
    const b = (body ?? {}) as { device?: string; cwd?: string; name?: string };
    const s = b.cwd ? [...ctx.db.sessions.values()].find((x) => x.device === (b.device ?? 'local') && x.cwd === b.cwd && x.kind !== 'chat' && !x.parentId) : canvasSession();
    if (!s) return ctx.fail(400, `No Code session works in ${b.cwd} on that computer in the mock`);
    const taken = new Set([...namesIn(s.id), 'scraper']);
    let i = 1;
    while (taken.has(`untitled-${i}`)) i++;
    return { sessionId: s.id, device: s.device, cwd: s.cwd, view: make(s.id, b.name ?? `untitled-${i}`) };
  });
  ctx.on('GET', '/api/sessions/:id/flows', ({ params }) => {
    const mine = namesIn(params[0]);
    const s = ctx.db.sessions.get(params[0]);
    // the hub's Canvas folder holds only what New made there; other folders have the scraper too
    const names = s?.cwd === HUB_CWD ? mine : ['scraper', ...mine];
    return names.sort().map((name) => ({ name, path: `flows/${name}.flow.ts` }));
  });
  ctx.on('POST', '/api/sessions/:id/flows/:name', ({ params }) => make(params[0], decodeURIComponent(params[1])));
  ctx.on('POST', '/api/sessions/:id/flows/:name/rename', ({ params, body }) => {
    const f = fileOf(params);
    if (!f) return ctx.fail(404, 'only programs made with New rename in the mock');
    const to = String(body?.to ?? '');
    if (!NAME.test(to)) return ctx.fail(400, 'a flow name is lowercase letters, digits and dashes, up to 64');
    if (files.has(`${params[0]}/${to}`) || to === 'scraper') return ctx.fail(409, `flows/${to}.flow.ts already exists`);
    files.delete(`${params[0]}/${f.name}`);
    f.src = f.src.replace(`// Flow "${f.name}".`, `// Flow "${to}".`).replace(`.conclave/graph/${f.name}.json`, `.conclave/graph/${to}.json`);
    f.name = to;
    bump(f);
    files.set(`${params[0]}/${to}`, f);
    return view(f);
  });
  ctx.on('GET', '/api/sessions/:id/flows/:name/graph', ({ params }) => {
    const f = fileOf(params);
    return f ? view(f) : ctx.pass;
  });
  ctx.on('POST', '/api/sessions/:id/flows/:name/graph/op', ({ params, body }) => {
    const f = fileOf(params);
    if (!f) return ctx.pass;
    if (body?.baseSha !== f.sha) return ctx.fail(409, 'script changed: the file changed since the graph was read; reload it');
    const before = f.src;
    let r: ReturnType<typeof applyFlowOp>;
    try {
      r = applyFlowOp(f.src, body as FlowOp);
    } catch (err) {
      return ctx.fail(400, (err as Error).message);
    }
    f.src = r.src;
    bump(f);
    return { sha: f.sha, diff: lineDiff(before, f.src), view: view(f), ...(r.nodeId ? { nodeId: r.nodeId } : {}) } satisfies FlowEditResult;
  });
  ctx.on('POST', '/api/sessions/:id/flows/:name/graph/restore', ({ params, body }) => {
    const f = fileOf(params);
    if (!f) return ctx.pass;
    if (body?.baseSha !== f.sha) return ctx.fail(409, 'script changed: the file changed since the graph was read; reload it');
    const next = versions.get(String(body?.sha));
    if (next === undefined) return ctx.fail(400, 'that version is not one the canvas wrote');
    const before = f.src;
    f.src = next;
    bump(f);
    return { sha: f.sha, diff: lineDiff(before, f.src), view: view(f) } satisfies FlowEditResult;
  });
  // the layout side file moves with a rename, as the hub's does
  ctx.on('PUT', '/api/sessions/:id/flows/:name/graph/layout', ({ params, body }) => {
    const f = fileOf(params);
    if (!f) return ctx.pass;
    f.layout = (body?.nodes ?? body) as File['layout'];
    return body;
  });
  ctx.on('GET', '/api/sessions/:id/flows/:name/run', ({ params }) => {
    const f = fileOf(params);
    return f ? (runOf(f) ?? null) : ctx.pass;
  });
  ctx.on('POST', '/api/sessions/:id/flows/:name/run', async ({ params }) => {
    const f = fileOf(params);
    if (!f) return ctx.pass;
    if (!parseFlow(f.src).nodes.length) return ctx.fail(400, 'Add a block first: there is nothing to run yet');
    await ctx.sleep(250);
    f.run = { runId: ctx.uid('flr'), flow: f.name, status: 'running', startedAt: Date.now(), output: '', nodes: {} };
    return f.run;
  });
  ctx.on('POST', '/api/sessions/:id/flows/:name/stop', ({ params }) => {
    const f = fileOf(params);
    if (!f) return ctx.pass;
    const r = runOf(f);
    if (r?.status === 'running') f.run = { ...r, status: 'stopped', finishedAt: Date.now(), error: 'stopped by the owner' };
    return f.run ?? null;
  });
}

export function registerFlows(ctx: MockCtx): void {
  registerNewFlows(ctx);
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
