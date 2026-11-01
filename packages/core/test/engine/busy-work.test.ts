/**
 * engine.busyWork() / isIdle(): what an update's restart would cut. Each kind
 * of work blocks on its own; a session parked for a usage limit does not (its
 * session.resume job is in the jobs table and boot keeps its status); with a
 * device, only work on that device counts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Session } from '../../src/types';
import { startTestEngine, type TestEngine } from './harness';

describe('busyWork and isIdle', () => {
  let t: TestEngine;
  beforeAll(async () => {
    t = await startTestEngine({ script: [] });
  });
  afterAll(async () => {
    await t.close();
  });

  const set = (s: Session, patch: Partial<Session>) => t.engine.repos.sessions.update({ ...t.engine.repos.sessions.get(s.id)!, ...patch });
  const kinds = (device?: string) => t.engine.busyWork(device).map((b) => b.kind);

  test('a fresh hub is idle', () => {
    expect(t.engine.isIdle()).toBe(true);
  });

  test('running, waiting_approval and waiting_input sessions block; waiting_reset does not', async () => {
    const s = await t.engine.createSession({ title: 'work', cwd: t.cwd });
    for (const status of ['running', 'waiting_approval', 'waiting_input'] as const) {
      set(s, { status });
      expect(t.engine.busyWork()).toEqual([{ kind: 'session', id: s.id, name: 'work', device: 'local', status }]);
    }
    set(s, { status: 'waiting_reset', resumeAt: Date.now() + 3_600_000 });
    // the resume job is durable: a restart keeps it
    t.engine.scheduler.enqueue('session.resume', Date.now() + 3_600_000, { sessionId: s.id }, `resume:${s.id}`);
    expect(t.engine.repos.jobs.pending('session.resume').length).toBe(1);
    expect(t.engine.isIdle()).toBe(true);
    t.engine.scheduler.cancel(`resume:${s.id}`);
    set(s, { status: 'idle' });
  });

  test('a background task blocks while its state is running, also between turns', async () => {
    const s = await t.engine.createSession({ title: 'child', cwd: t.cwd });
    t.engine.patchMeta(s.id, { background: { parentId: 'p1', state: 'running' } });
    expect(kinds()).toEqual(['task']);
    t.engine.patchMeta(s.id, { background: { parentId: 'p1', state: 'completed' } });
    expect(t.engine.isIdle()).toBe(true);
  });

  test('a queued message waiting to be sent blocks; one Stop held does not', async () => {
    const s = await t.engine.createSession({ title: 'queue', cwd: t.cwd });
    // archived: the restored queue waits instead of running
    set(s, { archived: true });
    const held = { input: { text: 'later' }, pending: { id: 'pend_held1', text: 'later', at: 1, whenBusy: 'queue' as const, held: true } };
    t.engine.runnerFor(s.id).restore([held]);
    expect(t.engine.isIdle()).toBe(true);
    t.engine.runnerFor(s.id).restore([{ input: { text: 'next' }, pending: { id: 'pend_next1', text: 'next', at: 2, whenBusy: 'queue' } }]);
    expect(kinds()).toEqual(['queued']);
    t.engine.unqueue(s.id, 'pend_next1');
    expect(t.engine.isIdle()).toBe(true);
  });

  test('a workflow run that is running or queued blocks', () => {
    const insert = (id: string, status: string) =>
      t.engine.repos.db
        .query(`INSERT INTO workflow_runs (id, name, source, script, script_sha, device, cwd, status, created_at) VALUES (?, 'review', 'library', 'x', 'x', 'local', '/', ?, ?)`)
        .run(id, status, Date.now());
    t.engine.busyWork(); // makes the table
    insert('wr_1', 'queued');
    insert('wr_2', 'done');
    expect(kinds()).toEqual(['workflow']);
    t.engine.repos.db.query(`UPDATE workflow_runs SET status = 'running' WHERE id = 'wr_1'`).run();
    expect(kinds()).toEqual(['workflow']);
    t.engine.repos.db.query(`UPDATE workflow_runs SET status = 'done' WHERE id = 'wr_1'`).run();
    expect(t.engine.isIdle()).toBe(true);
  });

  test('a routine run in progress blocks', () => {
    const r = t.engine.routines.create({ name: 'brief', schedule: '0 8 * * *', prompt: 'hi', agent: 'general-purpose' } as never);
    const inflight = (t.engine.routines as unknown as { inflight: Set<string> }).inflight;
    inflight.add(r.id);
    expect(t.engine.busyWork()).toEqual([{ kind: 'routine', id: r.id, name: 'brief' }]);
    inflight.delete(r.id);
    expect(t.engine.isIdle()).toBe(true);
  });

  test('with a device, only work on that device counts', async () => {
    const s = await t.engine.createSession({ title: 'remote', cwd: t.cwd });
    set(s, { status: 'running', device: 'dev_pc' });
    expect(t.engine.isIdle('dev_pc')).toBe(false);
    expect(t.engine.isIdle('dev_other')).toBe(true);
    expect(t.engine.isIdle()).toBe(false);
    set(s, { status: 'idle' });
  });
});
