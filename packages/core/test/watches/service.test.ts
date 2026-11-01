/**
 * The watch service without a browser or a model: a photo download that
 * never ends, and a watch deleted while its run was going.
 *
 *   bun test packages/core/test/watches/service.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { EventBus } from '../../src/util/bus';
import { WatchError, WatchService } from '../../src/watches';
import type { Routine } from '../../src/types';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function service(routines: Routine[]) {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'watch-svc-'));
  const bus = new EventBus();
  const svc = new WatchService({
    db,
    bus,
    routines: { get: (id) => routines.find((r) => r.id === id), list: () => routines },
    notify: () => undefined,
    imageDir: dir,
  });
  cleanups.push(() => {
    svc.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { svc, bus, db };
}

test('a photo that never ends is cut off at the size limit, not read whole into memory', async () => {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(7);
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      // no content-length, and more bytes than anyone should keep: 256 MB if read to the end
      const body = new ReadableStream({
        pull(c) {
          if (sent >= 256 * 1024 * 1024) return c.close();
          sent += chunk.length;
          c.enqueue(chunk);
        },
      });
      return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  cleanups.push(() => server.stop(true));
  const { svc } = service([]);
  const base = `http://127.0.0.1:${server.port}`;
  svc.report({ id: 'ses_chat' }, [{ id: '1', title: 'Car', url: `${base}/item/1`, image: `${base}/img/1.jpg` }]);
  const err = await svc.draftImage('ses_chat', '1').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WatchError);
  expect((err as WatchError).message).toContain('larger than 3 MB');
  // the hub stopped reading soon after the limit
  expect(sent).toBeLessThan(16 * 1024 * 1024);
}, 30_000);

test('photos of a deleted watch go at the next start even when its rows went first; a photo that arrives after the delete is not kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-img-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'rt_gone'));
  writeFileSync(join(dir, 'rt_gone', 'abc'), 'jpg');
  mkdirSync(join(dir, 'rt_kept'));
  writeFileSync(join(dir, 'rt_kept', 'abc'), 'jpg');
  const kept = { id: 'rt_kept', name: 'Kept', prompt: 'p', schedule: '0 9 * * *', watch: { url: 'http://127.0.0.1/s' } } as unknown as Routine;
  const routines = [kept];
  const db = openDb(':memory:');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      await gate;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  cleanups.push(() => server.stop(true));
  const svc = new WatchService({ db, bus: new EventBus(), routines: { get: (id) => routines.find((r) => r.id === id), list: () => routines }, notify: () => undefined, imageDir: dir });
  cleanups.push(() => (svc.stop(), db.close()));
  expect(existsSync(join(dir, 'rt_gone'))).toBe(false);
  expect(existsSync(join(dir, 'rt_kept', 'abc'))).toBe(true);
  // a photo is on its way when the owner deletes the watch
  const live = { ...kept, watch: { url: `http://127.0.0.1:${server.port}/s` } } as unknown as Routine;
  routines.splice(0, 1, live);
  db.query('INSERT INTO watch_items (routine_id, item_id, present, last_seen, data) VALUES (?, ?, 1, 0, ?)').run('rt_kept', '1', JSON.stringify({ id: '1', title: 'Car', image: `http://127.0.0.1:${server.port}/img/1.jpg`, present: true, mark: 'new', firstSeen: 0, lastSeen: 0, history: [], status: 'available' }));
  const photo = svc.image('rt_kept', '1');
  await Bun.sleep(50);
  routines.splice(0, 1);
  svc.remove('rt_kept');
  release();
  expect((await photo).bytes.length).toBe(3);
  expect(existsSync(join(dir, 'rt_kept'))).toBe(false);
});

test('a watch deleted while its run was going keeps nothing of that run', async () => {
  const routine = { id: 'rt_1', name: 'Cars', prompt: 'Watch cars.', schedule: '0 9 * * *', watch: { url: 'https://market.test/search' } } as unknown as Routine;
  const routines = [routine];
  const { svc, bus, db } = service(routines);
  svc.begin(routine, { id: 'run_1' }, 'ses_run');
  svc.report({ id: 'ses_run', meta: { watch: 'rt_1', watchRun: 'run_1' } }, [{ id: '7', title: 'Civic', price: 6500 }]);
  // the owner deletes the watch mid-run
  routines.splice(0, 1);
  bus.emit({ type: 'routine.deleted', routineId: 'rt_1' } as never);
  const res = await svc.finish(routine, { id: 'run_1', trigger: 'schedule' } as never, 'ses_run', { sessionId: 'ses_run' });
  expect(res.error).toBeUndefined();
  const rows = (db.query('SELECT COUNT(*) AS n FROM watch_items WHERE routine_id = ?').get('rt_1') as { n: number }).n;
  const runs = (db.query('SELECT COUNT(*) AS n FROM watch_runs WHERE routine_id = ?').get('rt_1') as { n: number }).n;
  expect([rows, runs]).toEqual([0, 0]);
});
