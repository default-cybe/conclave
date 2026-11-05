/**
 * Canvas's run queue on the hub (canvas/queue.ts): runs queued while a file
 * runs start in order when the last one ends, with no app open; a cancelled
 * one never starts; queued rows survive a restart, and a program run the
 * restart cut is the program's last run, failed with the reason.
 *
 *   bun test packages/core/test/canvas/queue.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, until, type TestEngine } from '../engine/harness';
import { lastUserText, noHarnesses, reopen, svcOf } from '../workflows/helpers';
import { canvasQueueOf, programFile, RESTART_ERROR, workflowFile } from '../../src/canvas/queue';
import { flowsOf } from '../../src/flows/service';
import { OWNER_ID } from '../../src/people/context';

let t: TestEngine;
let release: () => void = () => {};
let gate = new Promise<void>((r) => (release = r));

beforeAll(async () => {
  // "say slow" waits for the test to let it go, so the first run is still going while more are queued
  t = await startTestEngine({ script: [], approve: 'allow', route: (body) => (lastUserText(body).includes('say slow') ? { blocks: [{ text: 'slow done' }], gate } : [{ text: 'ok' }]) });
  noHarnesses(t.engine);
});
afterAll(async () => {
  release();
  await t?.close();
});

describe('the canvas queue', () => {
  test('workflow runs queued while one goes on start in order; a cancelled one never runs', async () => {
    const svc = svcOf(t.engine);
    mkdirSync(svc.registry.userDir, { recursive: true });
    writeFileSync(join(svc.registry.userDir, 'q-flow.js'), `export const meta = { name: 'q-flow', description: 'q' }\nawait agent('say ' + (args?.word ?? 'slow'))\nreturn 1\n`);
    const q = canvasQueueOf(t.engine);
    const first = await svc.startRun({ name: 'q-flow' }, { accountId: OWNER_ID });
    const a = await q.add(OWNER_ID, { workflow: 'q-flow', args: { word: 'one' } });
    const b = await q.add(OWNER_ID, { workflow: 'q-flow', args: { word: 'two' } });
    const c = await q.add(OWNER_ID, { workflow: 'q-flow', args: { word: 'three' } });
    expect(q.list(OWNER_ID, workflowFile('q-flow')).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    // someone else cannot see or cancel it
    expect(q.list('acct_other')).toEqual([]);
    expect(() => q.cancel('acct_other', b.id)).toThrow('not found');
    q.cancel(OWNER_ID, b.id);
    // nothing started while the first goes on
    expect(svc.store.listRuns({ name: 'q-flow' }).length).toBe(1);
    release();
    await svc.wait(first.id);
    await until(() => svc.store.listRuns({ name: 'q-flow' }).length === 3 && q.list(OWNER_ID).length === 0, 20_000);
    await until(() => svc.store.listRuns({ name: 'q-flow' }).every((r) => r.status === 'done'), 20_000);
    const runs = svc.store.listRuns({ name: 'q-flow' }).sort((x, y) => x.createdAt - y.createdAt);
    expect(runs.map((r) => (r.args as { word?: string } | undefined)?.word)).toEqual([undefined, 'one', 'three']);
  });

  test('a queued run starts at once when the file is idle; a workflow the caller cannot see is 404', async () => {
    const svc = svcOf(t.engine);
    const q = canvasQueueOf(t.engine);
    const before = svc.store.listRuns({ name: 'q-flow' }).length;
    await q.add(OWNER_ID, { workflow: 'q-flow', args: { word: 'now' } });
    expect(q.list(OWNER_ID)).toEqual([]);
    expect(svc.store.listRuns({ name: 'q-flow' }).length).toBe(before + 1);
    await expect(q.add(OWNER_ID, { workflow: 'no-such-flow' })).rejects.toThrow('not found');
    await until(() => svc.store.listRuns({ name: 'q-flow' }).every((r) => r.status === 'done'), 20_000);
  });

  test('a restart keeps queued runs and fails the program run it cut, with the reason; the next one then starts', async () => {
    const s = await t.engine.createSession({ title: 'flows', cwd: t.cwd });
    mkdirSync(join(t.cwd, 'flows'), { recursive: true });
    writeFileSync(join(t.cwd, 'flows/tick.flow.ts'), `console.log('tick')\n`);
    const db = t.engine.repos.db;
    // as the last hub left it: one program run going (in its memory, now gone) and one queued behind it
    db.query("INSERT INTO canvas_queue (id, account_id, file, kind, target, session_id, args, state, started_at, created_at) VALUES ('flr_cut', 'owner', ?, 'program', 'tick', ?, NULL, 'running', 1, 1)").run(programFile(s.id, 'tick'), s.id);
    db.query("INSERT INTO canvas_queue (id, account_id, file, kind, target, session_id, args, state, started_at, created_at) VALUES ('cvq_next', 'owner', ?, 'program', 'tick', ?, NULL, 'queued', NULL, 2)").run(programFile(s.id, 'tick'), s.id);
    await t.engine.shutdown();
    const second = await reopen(t);
    try {
      const flows = flowsOf(second);
      // the queued one started on boot, after the cut run was marked failed and dropped
      await until(() => (flows.runState(s.id, 'tick')?.runId ?? 'flr_cut') !== 'flr_cut', 10_000);
      expect(canvasQueueOf(second).list(OWNER_ID)).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM canvas_queue WHERE id IN ('flr_cut', 'cvq_next')").get()).toEqual({ n: 0 });
      flows.stop(s.id, 'tick');
    } finally {
      await second.shutdown();
      t.engine = await reopen(t);
    }
  });

  test("one account's busy file does not hold another account's queued run of the same workflow id", async () => {
    gate = new Promise<void>((r) => (release = r));
    const svc = svcOf(t.engine);
    const q = canvasQueueOf(t.engine);
    const first = await svc.startRun({ name: 'q-flow' }, { accountId: OWNER_ID });
    const mine = await q.add(OWNER_ID, { workflow: 'q-flow' });
    // a member's row for the same id, newer than the owner's waiting one
    t.engine.repos.db.query("INSERT INTO canvas_queue (id, account_id, file, kind, target, session_id, args, state, started_at, created_at) VALUES ('cvq_member', 'acct_m', ?, 'workflow', 'q-flow', NULL, NULL, 'queued', NULL, ?)").run(workflowFile('q-flow'), Date.now() + 1);
    await q.pump('acct_m', workflowFile('q-flow'));
    // the member's was weighed on its own (it cannot see the owner's workflow, so it is dropped with a notice); the owner's still waits
    expect(t.engine.repos.db.query("SELECT id FROM canvas_queue WHERE id = 'cvq_member'").get()).toBeNull();
    expect(q.list(OWNER_ID).map((x) => x.id)).toEqual([mine.id]);
    release();
    await svc.wait(first.id);
    await until(() => q.list(OWNER_ID).length === 0, 10_000);
    await until(() => svc.store.listRuns({ name: 'q-flow' }).every((r) => r.status === 'done'), 20_000);
  });

  test('runs that end while the next is being started do not stall the queue', async () => {
    gate = new Promise<void>((r) => (release = r));
    const svc = svcOf(t.engine);
    writeFileSync(join(svc.registry.userDir, 'q-fast.js'), `export const meta = { name: 'q-fast', description: 'q' }\nif (args?.slow) await agent('say slow')\nreturn 1\n`);
    const q = canvasQueueOf(t.engine);
    const first = await svc.startRun({ name: 'q-fast', args: { slow: true } }, { accountId: OWNER_ID });
    for (let i = 0; i < 4; i++) await q.add(OWNER_ID, { workflow: 'q-fast', args: { n: i } });
    release();
    await svc.wait(first.id);
    await until(() => q.list(OWNER_ID).length === 0 && svc.store.listRuns({ name: 'q-fast' }).length === 5, 10_000);
  });

  test('a hub shutdown that interrupts the running workflow keeps the run queued behind it', async () => {
    gate = new Promise<void>((r) => (release = r));
    const svc = svcOf(t.engine);
    const first = await svc.startRun({ name: 'q-flow' }, { accountId: OWNER_ID });
    await until(() => svc.store.getRun(first.id)?.status === 'running', 10_000);
    const queued = await canvasQueueOf(t.engine).add(OWNER_ID, { workflow: 'q-flow', args: { word: 'later' } });
    await t.engine.shutdown();
    release();
    // the shutdown marks the first interrupted; that is not the end the queued one waits for
    expect(t.engine.repos.db.query('SELECT id FROM canvas_queue WHERE id = ?').get(queued.id)).toEqual({ id: queued.id });
    t.engine = await reopen(t);
    await until(() => canvasQueueOf(t.engine).list(OWNER_ID).length === 0, 20_000);
    await until(() => svcOf(t.engine).store.listRuns({ name: 'q-flow' }).every((r) => r.status === 'done' || r.status === 'interrupted'), 20_000);
    const later = svcOf(t.engine).store.listRuns({ name: 'q-flow' }).find((r) => (r.args as { word?: string } | undefined)?.word === 'later');
    expect(later).toBeDefined();
    // it waited for the resumed first run to end
    const resumed = svcOf(t.engine).store.getRun(first.id)!;
    expect(resumed.status).toBe('done');
    expect(later!.createdAt).toBeGreaterThanOrEqual(resumed.finishedAt!);
  });

  test('a program run cut with nothing queued reads failed with the reason in its view', async () => {
    const s = await t.engine.createSession({ title: 'flows 2', cwd: t.cwd });
    t.engine.repos.db.query("INSERT INTO canvas_queue (id, account_id, file, kind, target, session_id, args, state, started_at, created_at) VALUES ('flr_cut2', 'owner', ?, 'program', 'tick', ?, NULL, 'running', 5, 5)").run(programFile(s.id, 'tick'), s.id);
    await t.engine.shutdown();
    const second = await reopen(t);
    try {
      expect((await flowsOf(second).view(s.id, 'tick')).lastRun).toMatchObject({ runId: 'flr_cut2', status: 'failed', error: RESTART_ERROR });
    } finally {
      await second.shutdown();
      t.engine = await reopen(t);
    }
  });
});
