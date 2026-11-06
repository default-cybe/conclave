/**
 * Flow routes (routes-flows.ts) on a scripted engine: the owner creates,
 * reads and edits a flow in a Code session; a member gets 404 on another
 * account's session flows, the same as an unknown session, and the block
 * catalog leaves Call AI out for members.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-flow-routes-0123456789';
const PASSWORD = 'correct horse battery staple';

let t: TestEngine;
let running: RunningServer;
let alice: { id: string; token: string };

async function call(token: string, method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.body.person.id, token: login.token };
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('flow routes', () => {
  test('the owner creates, reads and edits a flow', async () => {
    const s = await t.engine.createSession({ title: 'code', cwd: t.cwd });
    const made = await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn`);
    expect(made.status).toBe(201);
    expect(existsSync(join(t.cwd, 'flows/hn.flow.ts'))).toBe(true);
    expect(existsSync(join(t.cwd, 'flows/lib/index.ts'))).toBe(true);
    expect((await call(OWNER, 'GET', `/api/sessions/${s.id}/flows`)).body).toEqual([{ name: 'hn', path: 'flows/hn.flow.ts' }]);
    const g = await call(OWNER, 'GET', `/api/sessions/${s.id}/flows/hn/graph`);
    expect(g.status).toBe(200);
    const op = await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn/graph/op`, { op: 'set', nodeId: 'stars', input: 'field', value: 'forks', baseSha: g.body.sha });
    expect(op.status).toBe(200);
    expect(op.body.diff).toContain("field: 'forks'");
    // a stale canvas is refused, bad ops and names are 400
    expect((await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn/graph/op`, { op: 'set', nodeId: 'stars', input: 'field', value: 'x', baseSha: g.body.sha })).status).toBe(409);
    expect((await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn/graph/op`, { op: 'eval', baseSha: g.body.sha })).status).toBe(400);
    expect((await call(OWNER, 'GET', `/api/sessions/${s.id}/flows/Bad_Name/graph`)).status).toBe(400);
    expect((await call(OWNER, 'GET', `/api/sessions/${s.id}/flows/nope/graph`)).status).toBe(404);
  });

  test('a member gets 404 on another account session flows', async () => {
    const s = await t.engine.createSession({ title: 'owner code', cwd: t.cwd });
    for (const [method, path] of [
      ['GET', `/api/sessions/${s.id}/flows`],
      ['POST', `/api/sessions/${s.id}/flows/x`],
      ['GET', `/api/sessions/${s.id}/flows/hn/graph`],
      ['POST', `/api/sessions/${s.id}/flows/hn/graph/op`],
      ['POST', `/api/sessions/${s.id}/flows/hn/graph/restore`],
      ['PUT', `/api/sessions/${s.id}/flows/hn/graph/layout`],
      ['POST', `/api/sessions/${s.id}/flows/hn/run`],
      ['GET', `/api/sessions/${s.id}/flows/hn/run`],
      ['POST', `/api/sessions/${s.id}/flows/hn/stop`],
    ] as const) {
      expect((await call(alice.token, method, path, method === 'GET' ? undefined : {})).status).toBe(404);
    }
    expect(existsSync(join(t.cwd, 'flows/x.flow.ts'))).toBe(false);
  });

  test("Canvas's New makes a blank program in the owner's Canvas folder on the hub, which takes a first block and a rename", async () => {
    const root = join(t.cwd, 'hub-projects');
    t.engine.config.update({ projects: { hubRoot: root } });
    const a = await call(OWNER, 'POST', '/api/canvas/programs', {});
    expect(a.status).toBe(201);
    expect(a.body.device).toBe('local');
    expect(a.body.cwd).toBe(join(root, 'canvas', 'owner'));
    expect(a.body.view.name).toBe('untitled-1');
    expect(a.body.view.graph.nodes).toEqual([]);
    expect(existsSync(join(root, 'canvas/owner/flows/untitled-1.flow.ts'))).toBe(true);
    // the second New reuses the folder's session and takes the next name
    const b = await call(OWNER, 'POST', '/api/canvas/programs', {});
    expect(b.body.sessionId).toBe(a.body.sessionId);
    expect(b.body.view.name).toBe('untitled-2');
    // the empty graph takes its first block, and a second wired after it
    const sid = a.body.sessionId;
    const first = await call(OWNER, 'POST', `/api/sessions/${sid}/flows/untitled-1/graph/op`, { op: 'insert', block: 'fetchUrl', baseSha: a.body.view.sha });
    expect(first.status).toBe(200);
    expect(first.body.view.graph.nodes.map((n: { block: string }) => n.block)).toEqual(['fetchUrl']);
    const second = await call(OWNER, 'POST', `/api/sessions/${sid}/flows/untitled-1/graph/op`, { op: 'insert', block: 'log', after: first.body.nodeId, baseSha: first.body.sha });
    expect(second.body.view.graph.edges).toEqual([{ from: first.body.nodeId, to: second.body.nodeId, name: 'value' }]);
    // renamed from the title: the file moves, and a taken name is refused
    const r = await call(OWNER, 'POST', `/api/sessions/${sid}/flows/untitled-1/rename`, { to: 'hn-digest' });
    expect(r.status).toBe(200);
    expect(r.body.graph.nodes.length).toBe(2);
    expect(readFileSync(join(root, 'canvas/owner/flows/hn-digest.flow.ts'), 'utf8')).toContain('// Flow "hn-digest".');
    expect(existsSync(join(root, 'canvas/owner/flows/untitled-1.flow.ts'))).toBe(false);
    expect((await call(OWNER, 'POST', `/api/sessions/${sid}/flows/untitled-2/rename`, { to: 'hn-digest' })).status).toBe(409);
    expect((await call(alice.token, 'POST', `/api/sessions/${sid}/flows/untitled-2/rename`, { to: 'mine' })).status).toBe(404);
  });

  test("a member's New never lands on the hub or in the owner's folder", async () => {
    const root = join(t.cwd, 'hub-projects');
    t.engine.config.update({ projects: { hubRoot: root } });
    const before = readdirSync(join(root, 'canvas')).sort();
    // no folder: a member picks one on a device of their own
    const none = await call(alice.token, 'POST', '/api/canvas/programs', {});
    expect(none.status).toBe(400);
    expect(none.body.error).toContain('pick a folder');
    // the hub's own computer, or the owner's folder there, is refused
    expect((await call(alice.token, 'POST', '/api/canvas/programs', { cwd: join(root, 'canvas', 'owner') })).status).toBe(400);
    const hub = await call(alice.token, 'POST', '/api/canvas/programs', { device: 'local', cwd: t.cwd });
    expect(hub.status).toBe(400);
    expect(hub.body.error).toBe("Members can't run code on the hub. Pick one of your devices.");
    // someone else's device is unknown
    expect((await call(alice.token, 'POST', '/api/canvas/programs', { device: 'dev_not_hers', cwd: '/x' })).status).toBe(404);
    expect(readdirSync(join(root, 'canvas')).sort()).toEqual(before);
    expect(readdirSync(join(root, 'canvas/owner/flows')).filter((f) => f.endsWith('.flow.ts')).sort()).toEqual(['hn-digest.flow.ts', 'untitled-2.flow.ts']);
  });

  test("New and rename refuse names that leave flows/, and New stops at 999 untitled files", async () => {
    // a fresh hub root, so a refused name would be the one to make the folder's session
    t.engine.config.update({ projects: { hubRoot: join(t.cwd, 'hub-fresh') } });
    const sessions = t.engine.listSessions({ limit: 1000 }).length;
    for (const name of ['../x', 'a/b', '..', 'é', 'x\n', 'A', '.hidden', 'a'.repeat(65)]) {
      expect((await call(OWNER, 'POST', '/api/canvas/programs', { name })).status).toBe(400);
    }
    // a refused name makes no session and no folder
    expect(t.engine.listSessions({ limit: 1000 }).length).toBe(sessions);
    expect(existsSync(join(t.cwd, 'hub-fresh'))).toBe(false);
    const root = join(t.cwd, 'hub-projects');
    t.engine.config.update({ projects: { hubRoot: root } });
    const a = await call(OWNER, 'POST', '/api/canvas/programs', {});
    const sid = a.body.sessionId;
    for (const to of ['../../escape', 'a/b', 'ü', '..']) {
      expect((await call(OWNER, 'POST', `/api/sessions/${sid}/flows/${a.body.view.name}/rename`, { to })).status).toBe(400);
    }
    expect(readdirSync(join(root, 'canvas')).sort()).toEqual(['owner']);
    // past the 200 files the list reads, New still finds the next free name
    const flows = join(root, 'canvas/owner/flows');
    for (let n = 1; n < 300; n++) writeFileSync(join(flows, `untitled-${n}.flow.ts`), '// x\n');
    const next = await call(OWNER, 'POST', '/api/canvas/programs', {});
    expect(next.status).toBe(201);
    expect(next.body.view.name).toBe('untitled-300');
    // the folder full of untitled-1..999: New answers 409, not a 1000th file
    for (let n = 301; n < 1000; n++) writeFileSync(join(flows, `untitled-${n}.flow.ts`), '// x\n');
    const full = await call(OWNER, 'POST', '/api/canvas/programs', {});
    expect(full.status).toBe(409);
    expect(full.body.error).toContain('too many untitled programs');
    expect(existsSync(join(flows, 'untitled-1000.flow.ts'))).toBe(false);
    for (let n = 1; n < 1000; n++) rmSync(join(flows, `untitled-${n}.flow.ts`));
  });

  test("New workflow makes an empty script of the caller's own that takes a first node", async () => {
    const made = await call(OWNER, 'POST', '/api/workflows');
    expect(made.status).toBe(201);
    expect(made.body.name).toMatch(/^untitled-\d+$/);
    const g = await call(OWNER, 'GET', `/api/workflows/${made.body.id}/graph`);
    expect(g.body.editable).toBe(true);
    expect(g.body.graph.nodes).toEqual([]);
    const ins = await call(OWNER, 'POST', `/api/workflows/${made.body.id}/graph/insert`, { kind: 'agent', baseSha: g.body.sha });
    expect(ins.status).toBe(200);
    expect(ins.body.view.graph.nodes.map((n: { kind: string }) => n.kind)).toEqual(['agent']);
    // a member's New workflow is theirs: the owner's library does not list it
    const hers = await call(alice.token, 'POST', '/api/workflows');
    expect(hers.status).toBe(201);
    expect(hers.body.path).not.toBe(made.body.path);
    const ownerList = (await call(OWNER, 'GET', '/api/workflows')).body.map((w: { path?: string }) => w.path);
    expect(ownerList).not.toContain(hers.body.path);
  });

  test('the catalog hides Call AI from members', async () => {
    const owner = await call(OWNER, 'GET', '/api/graph/nodes?use=program');
    const member = await call(alice.token, 'GET', '/api/graph/nodes?use=program');
    expect(owner.body.map((b: { block: string }) => b.block)).toContain('ai');
    expect(member.status).toBe(200);
    expect(member.body.map((b: { block: string }) => b.block)).not.toContain('ai');
    expect(member.body.length).toBe(owner.body.length - 1);
  });
});
