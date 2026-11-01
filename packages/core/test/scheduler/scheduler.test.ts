import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { JobScheduler } from '../../src/scheduler/scheduler';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mk(db: Db = openDb(':memory:'), opts: Partial<ConstructorParameters<typeof JobScheduler>[0]> = {}) {
  const repos = new Repos(db);
  const s = new JobScheduler({ repos, backoff: () => 5, maxSleepMs: 200, ...opts });
  cleanups.push(() => s.stop());
  return { s, repos, db };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await Bun.sleep(2);
  }
}

function status(db: Db, id: string) {
  return db.query('SELECT status, attempts, last_error FROM jobs WHERE id = ?').get(id) as { status: string; attempts: number; last_error: string | null };
}

describe('JobScheduler', () => {
  test('runs due jobs now and future jobs on time', async () => {
    const { s, db } = mk();
    const ran: Array<{ n: unknown; at: number }> = [];
    s.handle('t', async (p) => void ran.push({ n: p.n, at: Date.now() }));
    s.start();
    const start = Date.now();
    const a = s.enqueue('t', start - 1000, { n: 1 });
    const b = s.enqueue('t', start + 60, { n: 2 });
    await waitFor(() => ran.length === 2);
    expect(ran.map((r) => r.n)).toEqual([1, 2]);
    expect(ran[1].at - start).toBeGreaterThanOrEqual(55);
    await s.idle();
    expect(status(db, a).status).toBe('done');
    expect(status(db, b).status).toBe('done');
  });

  test('retries with backoff, then succeeds', async () => {
    const { s, db } = mk();
    let calls = 0;
    s.handle('flaky', async () => {
      if (++calls < 3) throw new Error(`fail ${calls}`);
    });
    s.start();
    const id = s.enqueue('flaky', Date.now());
    await waitFor(() => status(db, id).status === 'done');
    expect(calls).toBe(3);
    expect(status(db, id).attempts).toBe(3);
  });

  test('gives up after 5 attempts', async () => {
    const { s, db } = mk();
    let calls = 0;
    s.handle('bad', async () => {
      calls++;
      throw new Error('always');
    });
    s.start();
    const id = s.enqueue('bad', Date.now());
    await waitFor(() => status(db, id).status === 'failed');
    expect(calls).toBe(5);
    expect(status(db, id).last_error).toBe('always');
  });

  test('start drops finished jobs older than a month and keeps the rest', () => {
    const { s, repos, db } = mk();
    const old = Date.now() - 40 * 86_400_000;
    const done = repos.jobs.enqueue('t', old).id;
    const failed = repos.jobs.enqueue('t', old).id;
    const recent = repos.jobs.enqueue('t', Date.now() - 86_400_000).id;
    const waiting = repos.jobs.enqueue('t', old).id;
    repos.jobs.setStatus(done, 'done');
    repos.jobs.setStatus(failed, 'failed');
    repos.jobs.setStatus(recent, 'done');
    s.start();
    expect(status(db, done)).toBeNull();
    expect(status(db, failed)).toBeNull();
    expect(status(db, recent).status).toBe('done');
    expect(status(db, waiting).status).toBe('pending');
  });

  test('recovers jobs left running by a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-sched-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'db.sqlite');
    const db1 = openDb(file);
    const r1 = new Repos(db1);
    const stuck = r1.jobs.enqueue('t', Date.now() - 5000, { n: 'stuck' });
    r1.jobs.setStatus(stuck.id, 'running');
    // a routine job that crashed while a newer pending one with the same key already exists
    const old = r1.jobs.enqueue('t', Date.now() - 5000, { n: 'old' }, 'routine:x');
    r1.jobs.setStatus(old.id, 'running');
    const fresh = r1.jobs.enqueue('t', Date.now() + 60_000, { n: 'fresh' }, 'routine:x');
    db1.close();

    const db2 = openDb(file);
    cleanups.push(() => db2.close());
    const { s } = mk(db2);
    const ran: unknown[] = [];
    s.handle('t', async (p) => void ran.push(p.n));
    s.start();
    await waitFor(() => ran.length === 1);
    await s.idle();
    expect(ran).toEqual(['stuck']);
    expect(status(db2, stuck.id).status).toBe('done');
    expect(status(db2, old.id).status).toBe('cancelled');
    expect(status(db2, fresh.id).status).toBe('pending');
  });

  test('never runs a job twice, even with two schedulers on one database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-sched-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'db.sqlite');
    const dbA = openDb(file);
    const dbB = openDb(file);
    cleanups.push(() => (dbA.close(), dbB.close()));
    const a = mk(dbA).s;
    const b = mk(dbB).s;
    let calls = 0;
    const slow = async () => {
      calls++;
      await Bun.sleep(40);
    };
    a.handle('once', slow);
    b.handle('once', slow);
    const id = a.enqueue('once', Date.now());
    a.start();
    b.start();
    a.poke();
    b.poke();
    await Bun.sleep(10);
    a.poke();
    await waitFor(() => status(dbA, id).status === 'done');
    await Promise.all([a.idle(), b.idle()]);
    expect(calls).toBe(1);
  });

  test('dedupe keys keep one pending job, cancel removes it', () => {
    const { s, repos } = mk();
    s.enqueue('r', Date.now() + 10_000, {}, 'k');
    s.enqueue('r', Date.now() + 20_000, {}, 'k');
    expect(repos.jobs.pending('r').length).toBe(1);
    s.cancel('k');
    expect(repos.jobs.pending('r').length).toBe(0);
  });

  test('jobs wait for a handler registered after start', async () => {
    const { s } = mk();
    s.start();
    s.enqueue('late', Date.now() - 10);
    await Bun.sleep(20);
    let ran = false;
    s.handle('late', async () => {
      ran = true;
    });
    await waitFor(() => ran);
  });

  test('stop prevents further runs', async () => {
    const { s } = mk();
    let ran = 0;
    s.handle('t', async () => void ran++);
    s.start();
    s.stop();
    s.enqueue('t', Date.now());
    await Bun.sleep(30);
    expect(ran).toBe(0);
  });
});
