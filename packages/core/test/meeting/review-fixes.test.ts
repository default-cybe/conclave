/**
 * Fixes from the meeting-mode review (security and tests): delete is refused
 * while the desktop may still capture or the wrap-up still writes, delete
 * takes the memory episode with it, the episode of other people's speech
 * waits for review and honours the memory switch, the context pack holds no
 * global profile and no other project's tasks, and the notes folder keeps
 * itself out of git.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, until, type RequestBody, type TestEngine } from '../engine/harness';
import { meetingsOf, type MeetingService } from '../../src/meeting/index';
import type { Segment } from '../../src/meeting/wire';

let t: TestEngine | undefined;
afterEach(async () => {
  await meetingsOf(t?.engine ?? {})?.settled();
  await t?.close();
  t = undefined;
});

const sys = (b: RequestBody) => JSON.stringify(b.system ?? '');

async function boot(memory = false) {
  t = await startTestEngine({
    script: [[{ text: 'unused' }]],
    chore: (b) => {
      if (sys(b).includes('You prepare the owner')) return [{ text: '## Brief' }];
      if (sys(b).includes('You write the notes')) return [{ text: '{"summary":"Export is in review.","decisions":[],"actionItems":[],"openQuestions":[]}' }];
      return [{ text: 'ok' }];
    },
    ...(memory ? { overrides: { memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 0 } } as never } : {}),
  });
  return meetingsOf(t.engine)!;
}

async function ready(svc: MeetingService) {
  const m = await svc.create({ cwd: t!.cwd, title: 'Standup' }, 'owner');
  expect(await until(() => svc.store.get(m.id)!.status === 'ready')).toBe(true);
  return m;
}

const seg = (seq: number, text: string): Segment => ({ seq, channel: 'them', startMs: seq * 5000, endMs: seq * 5000 + 2500, text, final: true });
const batch = (...segments: Segment[]) => ({ clientId: 'cli_1', t0: Date.now(), segments });
const episodes = (sessionId: string) => t!.engine.repos.db.query(`SELECT content, meta FROM memories WHERE source_session_id = ?`).all(sessionId) as Array<{ content: string; meta: string | null }>;
const status = (n: number) => expect.objectContaining({ status: n });

describe('delete', () => {
  test('refused while paused (the desktop still captures) and while ending (the wrap-up still writes)', async () => {
    const svc = await boot(true);
    const m = await ready(svc);
    svc.ingest(m.id, batch(seg(0, 'Morning everyone here')), 'owner');
    svc.patch(m.id, { status: 'paused' }, 'owner');
    await expect(svc.delete(m.id, 'owner')).rejects.toThrow(status(409));
    svc.end(m.id, 'owner');
    await expect(svc.delete(m.id, 'owner')).rejects.toThrow(status(409));
    expect(await until(() => svc.store.get(m.id)!.status === 'ended')).toBe(true);
    // the wrap-up finished against a meeting that still exists, and then delete takes the episode too
    expect(episodes(m.sessionId)).toHaveLength(1);
    await svc.delete(m.id, 'owner');
    expect(episodes(m.sessionId)).toEqual([]);
  });
});

describe('the wrap-up episode', () => {
  test('waits for review and is marked untrusted: a summary of other people\'s speech', async () => {
    const svc = await boot(true);
    const m = await ready(svc);
    svc.patch(m.id, { autoAnswer: 'off' }, 'owner');
    svc.ingest(m.id, batch(seg(0, 'The export is in review now')), 'owner');
    svc.end(m.id, 'owner');
    expect(await until(() => svc.store.get(m.id)!.status === 'ended')).toBe(true);
    const [e] = episodes(m.sessionId);
    expect(e.content).toContain('Export is in review.');
    expect(JSON.parse(e.meta ?? '{}')).toMatchObject({ review: 'pending', untrusted: true });
    // recall skips it until the owner accepts it
    const hits = await t!.engine.memoryFor('owner').recall('Export review Standup', { limit: 10 });
    expect(hits.map((h) => h.content).filter((c) => c.includes('Export is in review'))).toEqual([]);
  });

  test('memory switched off: no episode', async () => {
    const svc = await boot(false);
    const m = await ready(svc);
    svc.end(m.id, 'owner');
    expect(await until(() => svc.store.get(m.id)!.status === 'ended')).toBe(true);
    expect(episodes(m.sessionId)).toEqual([]);
  });
});

describe('the context pack', () => {
  test("no global profile or facts, and no task of another project in a folder-only meeting", async () => {
    const svc = await boot(true);
    const mem = t!.engine.memoryFor('owner');
    await mem.save({ content: 'PROFILE-PRIVATE the owner has a dentist appointment', kind: 'profile' });
    await mem.save({ content: 'FACT-PRIVATE the owner lives on Elm street', kind: 'fact' });
    t!.engine.createTask({ title: 'OWNER-TASK ship export' }, 'owner');
    t!.engine.createTask({ title: 'OTHER-PROJECT-TASK launch plan', project: 'prj_other' }, 'owner');
    const m = await ready(svc);
    const pack = svc.store.context(m.id) ?? '';
    expect(pack).toContain('OWNER-TASK');
    for (const no of ['PROFILE-PRIVATE', 'FACT-PRIVATE', 'OTHER-PROJECT-TASK']) expect([no, pack.includes(no)]).toEqual([no, false]);
  });
});

describe('the notes folder', () => {
  test('gets a .gitignore that ignores everything in it, so notes never reach git', async () => {
    const svc = await boot();
    const m = await ready(svc);
    svc.end(m.id, 'owner');
    expect(await until(() => svc.store.get(m.id)!.status === 'ended')).toBe(true);
    expect(readFileSync(join(t!.cwd, '.conclave', 'meetings', '.gitignore'), 'utf8')).toBe('*\n');
  });
});
