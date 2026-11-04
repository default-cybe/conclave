/**
 * Running a flow (flows/service.ts, flows/lib-source.js): the service on the
 * hub's own machine with a scripted approval, real `bun`, and a local fake
 * API. The scraper writes its CSV, each block's value lands on its node,
 * .env values are masked, a throwing code node is pinned by line, and a
 * denied approval never spawns. The helpers print nothing extra without
 * CONCLAVE_FLOW_TRACE.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, until, type TestEngine } from '../engine/harness';
import { flowsOf } from '../../src/flows/service';
import { LIB_SOURCE } from '../../src/flows/lib';
import type { FlowRunView } from '../../src/client/flows';

const api = Bun.serve({
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === '/api/posts'
      ? Response.json({ items: [{ id: 1, title: 'Bun 2 is out', url: 'https://bun.sh/x', secret: 'tok-abcdef123' }, { id: 2, title: 'Deno news', url: 'https://deno.com' }, { id: 3, title: 'Why bun, "fast"', url: 'https://e.x' }] })
      : new Response('no', { status: 404 }),
});
const scraper = readFileSync(join(import.meta.dir, 'fixtures', 'scraper.flow.ts'), 'utf8').replace('http://127.0.0.1:0', `http://127.0.0.1:${api.port}`);

let allow: TestEngine;
let deny: TestEngine;

beforeAll(async () => {
  allow = await startTestEngine({ script: [], approve: 'allow' });
  deny = await startTestEngine({ script: [], approve: 'deny' });
});
afterAll(async () => {
  await allow.close();
  await deny.close();
  api.stop(true);
});

async function finished(t: TestEngine, sid: string, name: string): Promise<FlowRunView> {
  await until(() => !['approval', 'running'].includes(flowsOf(t.engine).runState(sid, name)?.status ?? 'running'), 30_000);
  return flowsOf(t.engine).runState(sid, name)!;
}

describe('flows on the local machine', () => {
  test('create writes the helpers once and a starter that parses', async () => {
    const s = await allow.engine.createSession({ title: 'flows', cwd: allow.cwd });
    const svc = flowsOf(allow.engine);
    const v = await svc.create(s.id, 'starter');
    expect(v.graph.nodes.length).toBeGreaterThan(2);
    expect(readFileSync(join(allow.cwd, 'flows/lib/index.ts'), 'utf8')).toBe(LIB_SOURCE);
    // never overwritten: an edited helpers file stays
    writeFileSync(join(allow.cwd, 'flows/lib/index.ts'), `${LIB_SOURCE}\n// mine\n`);
    await svc.create(s.id, 'second');
    expect(readFileSync(join(allow.cwd, 'flows/lib/index.ts'), 'utf8')).toEndWith('// mine\n');
    await expect(svc.create(s.id, 'starter')).rejects.toThrow('already exists');
    await expect(svc.create(s.id, '../x')).rejects.toThrow('flow name');
    expect((await svc.list(s.id)).map((f) => f.name)).toEqual(['second', 'starter']);
  });

  test('the scraper runs, writes its CSV and records a value per node', async () => {
    const s = await allow.engine.createSession({ title: 'scrape', cwd: allow.cwd });
    const svc = flowsOf(allow.engine);
    mkdirSync(join(allow.cwd, 'flows/lib'), { recursive: true });
    writeFileSync(join(allow.cwd, 'flows/lib/index.ts'), LIB_SOURCE);
    writeFileSync(join(allow.cwd, 'flows/scraper.flow.ts'), scraper);
    writeFileSync(join(allow.cwd, '.env'), 'API_TOKEN=tok-abcdef123\nSHORT=abc\n');
    const started = await svc.run(s.id, 'scraper');
    expect(['approval', 'running']).toContain(started.status);
    const r = await finished(allow, s.id, 'scraper');
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('done');
    expect(readFileSync(join(allow.cwd, 'out/posts.csv'), 'utf8')).toBe('id,title,url\n1,Bun 2 is out,https://bun.sh/x\n3,"Why bun, ""fast""",https://e.x\n');
    expect(Object.keys(r.nodes).sort()).toEqual(['bun', 'csv', 'data', 'log-1', 'posts']);
    expect(r.nodes.posts).toMatchObject({ ok: true, summary: '3 items' });
    expect(r.nodes.bun.summary).toBe('2 items');
    // a .env value of 6+ characters is masked in values and output; trace lines are cut out of the output
    expect(r.nodes.data.value).toContain('***');
    expect(r.nodes.data.value).not.toContain('tok-abcdef123');
    expect(r.output).toBe('out/posts.csv\n');
    expect(allow.approvals.some((a) => a.startsWith(`Run flow scraper: bun flows/scraper.flow.ts\nfetch: a URL from url`))).toBe(true);
    // the view carries the last run
    expect((await svc.view(s.id, 'scraper')).lastRun?.runId).toBe(r.runId);
  });

  test('an uncaught error in a code node is pinned to it by line', async () => {
    const s = await allow.engine.createSession({ title: 'throw', cwd: allow.cwd });
    writeFileSync(
      join(allow.cwd, 'flows/boom.flow.ts'),
      "import { log } from './lib';\nconst a = 'x';\nawait log({ value: a });\nconst n: number = JSON.parse('{');\nawait log({ value: n });\n",
    );
    const svc = flowsOf(allow.engine);
    const v = await svc.view(s.id, 'boom');
    const code = v.graph.nodes.find((n) => n.kind === 'code')!;
    await svc.run(s.id, 'boom');
    const r = await finished(allow, s.id, 'boom');
    expect(r.status).toBe('failed');
    expect(r.exitCode).toBe(1);
    expect(r.nodes['log-1']).toMatchObject({ ok: true, summary: 'x' });
    expect(r.nodes[code.id]?.ok).toBe(false);
    expect(r.nodes[code.id]?.error).toContain('JSON Parse error');
    expect(r.nodes['log-2']).toBeUndefined();
  });

  test('a denied approval never spawns', async () => {
    const s = await deny.engine.createSession({ title: 'denied', cwd: deny.cwd });
    mkdirSync(join(deny.cwd, 'flows/lib'), { recursive: true });
    writeFileSync(join(deny.cwd, 'flows/lib/index.ts'), LIB_SOURCE);
    writeFileSync(join(deny.cwd, 'flows/touch.flow.ts'), "import { shell } from './lib';\nconst out = await shell({ command: 'touch ran.txt' });\n");
    await flowsOf(deny.engine).run(s.id, 'touch');
    const r = await finished(deny, s.id, 'touch');
    expect(r.status).toBe('refused');
    expect(existsSync(join(deny.cwd, 'ran.txt'))).toBe(false);
    expect(deny.approvals[0]).toStartWith("Run flow touch: bun flows/touch.flow.ts\nshell: touch ran.txt");
  });

  test('edits check the sha and undo puts the old version back', async () => {
    const s = await allow.engine.createSession({ title: 'edit', cwd: allow.cwd });
    const svc = flowsOf(allow.engine);
    const v = await svc.view(s.id, 'scraper');
    await expect(svc.edit(s.id, 'scraper', { op: 'set', nodeId: 'bun', input: 'value', value: 'deno' }, 'stale')).rejects.toThrow('flow changed');
    const e = await svc.edit(s.id, 'scraper', { op: 'set', nodeId: 'bun', input: 'value', value: 'deno' }, v.sha);
    expect(e.diff).toContain("+ const bun = await filter({ items: posts, field: 'title', op: 'contains', value: 'deno' });");
    await expect(svc.edit(s.id, 'scraper', { op: 'insert', block: 'ai' }, e.sha, { member: true })).rejects.toThrow('owner');
    const back = await svc.restore(s.id, 'scraper', v.sha, e.sha);
    expect(back.sha).toBe(v.sha);
    expect(readFileSync(join(allow.cwd, 'flows/scraper.flow.ts'), 'utf8')).toBe(scraper);
    const layout = await svc.saveLayout(s.id, 'scraper', { bun: { x: 13, y: 21 }, 'log-1': { x: 0, y: 0 }, nope: { x: 1, y: 1 }, '../x': { x: 1, y: 1 } });
    expect(layout).toEqual({ bun: { x: 16, y: 24 }, 'log-1': { x: 0, y: 0 } });
    expect((await svc.view(s.id, 'scraper')).layout).toEqual(layout);
    expect(existsSync(join(allow.cwd, '.conclave/graph/scraper.json'))).toBe(true);
  });
});

describe('the helpers', () => {
  test('print nothing extra without CONCLAVE_FLOW_TRACE, and pin the trace format with it', async () => {
    const dir = join(allow.cwd, 'plain');
    mkdirSync(join(dir, 'flows/lib'), { recursive: true });
    writeFileSync(join(dir, 'flows/lib/index.ts'), LIB_SOURCE);
    writeFileSync(join(dir, 'flows/t.flow.ts'), "import { regex, joinText, log } from './lib';\n\nconst m = await regex({ text: 'a1 b22 c333', pattern: '\\\\d+', flags: 'g', many: true });\nconst j = await joinText({ items: m, sep: '+' });\nawait log({ value: j });\n");
    const run = (env: Record<string, string>) => Bun.spawnSync(['bun', 'flows/t.flow.ts'], { cwd: dir, env: { ...process.env, ...env } as Record<string, string> });
    const plain = run({});
    expect(plain.stdout.toString()).toBe('1+22+333\n');
    expect(plain.stderr.toString()).toBe('');
    const traced = run({ CONCLAVE_FLOW_TRACE: 'n1' });
    const lines = traced.stderr.toString().trim().split('\n');
    expect(lines[0]).toBe('\x1en1 {"line":3,"ok":true,"ms":' + JSON.parse(lines[0].slice(4)).ms + ',"summary":"3 items","value":"[\\n  \\"1\\",\\n  \\"22\\",\\n  \\"333\\"\\n]"}');
    expect(lines.map((l) => JSON.parse(l.slice(4)).line)).toEqual([3, 4, 5]);
  });
});
