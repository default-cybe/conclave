/**
 * SQLite settings at open (storage/db.ts openDb) and the hourly PRAGMA
 * optimize on the hub's job scheduler (engine/create.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, DB_OPTIMIZE_JOB } from '../../src/storage/db';
import { startTestEngine, type TestEngine } from '../engine/harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('openDb', () => {
  test('sets the page cache, in-memory temp store and mmap, and raises Bun\'s statement cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-pragmas-'));
    try {
      const db = openDb(join(dir, 'c.db'));
      const read = (p: string) => Object.values(db.query(`PRAGMA ${p}`).get() as Record<string, unknown>)[0];
      expect(read('cache_size')).toBe(-65536);
      expect(read('temp_store')).toBe(2); // 2 = MEMORY
      expect(read('mmap_size')).toBe(268435456);
      expect(read('journal_mode')).toBe('wal');
      expect(Database.MAX_QUERY_CACHE_SIZE).toBeGreaterThanOrEqual(200);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hourly optimize', () => {
  test('the engine plans PRAGMA optimize an hour out, and each run plans the next', async () => {
    t = await startTestEngine({ script: [] });
    const e = t.engine;
    const planned = e.repos.jobs.pending(DB_OPTIMIZE_JOB);
    expect(planned).toHaveLength(1);
    expect(planned[0].runAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    const due = e.scheduler.enqueue(DB_OPTIMIZE_JOB, Date.now(), {}, DB_OPTIMIZE_JOB);
    e.scheduler.start();
    const next = () => e.repos.jobs.pending(DB_OPTIMIZE_JOB).filter((j) => j.id !== due);
    for (let i = 0; i < 200 && !next().length; i++) await Bun.sleep(10);
    e.scheduler.stop();
    expect(next()).toHaveLength(1);
    expect(next()[0].runAt).toBeGreaterThan(Date.now() + 59 * 60_000);
  });
});
