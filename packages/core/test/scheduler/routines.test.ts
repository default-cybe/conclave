import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { JobScheduler } from '../../src/scheduler/scheduler';
import { Routines, ROUTINE_JOB } from '../../src/scheduler/routines';
import { nextRun, parseSchedule, previewRuns, previousRun, parseOnceDate } from '../../src/scheduler/schedule';
import type { Routine, RoutineRun } from '../../src/types';

describe('schedule parsing', () => {
  test('accepts cron, nicknames, @every and @once', () => {
    expect(parseSchedule('30 7 * * 1-5')).toEqual({ kind: 'cron', expr: '30 7 * * 1-5' });
    expect(parseSchedule('0 */5 * * * *').kind).toBe('cron');
    expect(parseSchedule('@daily')).toEqual({ kind: 'cron', expr: '@daily' });
    expect(parseSchedule('@every 30m')).toEqual({ kind: 'every', ms: 30 * 60_000 });
    expect(parseSchedule('@every 1h30m')).toEqual({ kind: 'every', ms: 90 * 60_000 });
    expect(parseSchedule('@once 2026-10-20T09:00:00Z')).toEqual({ kind: 'once', at: Date.parse('2026-10-20T09:00:00Z'), raw: '2026-10-20T09:00:00Z' });
  });

  test('rejects bad input', () => {
    expect(() => parseSchedule('')).toThrow();
    expect(() => parseSchedule('* * *')).toThrow(/5 or 6/);
    expect(() => parseSchedule('0 0 0 * * * *')).toThrow(/5 or 6/);
    expect(() => parseSchedule('61 * * * *')).toThrow(/Invalid cron/);
    expect(() => parseSchedule('@every 10s')).toThrow(/1 minute/);
    expect(() => parseSchedule('@every soon')).toThrow(/interval/);
    expect(() => parseSchedule('@once tomorrow')).toThrow(/date/);
    expect(() => parseSchedule('@fortnightly')).toThrow(/keyword/);
    expect(() => parseSchedule('@daily', 'Mars/Olympus')).toThrow(/timezone/);
  });

  test('cron next run honours the timezone', () => {
    // Friday 2026-10-16 10:00Z, Berlin is UTC+2 until Oct 25
    const after = Date.parse('2026-10-16T10:00:00Z');
    expect(new Date(nextRun('30 7 * * 1-5', { after, timezone: 'Europe/Berlin' })!).toISOString()).toBe('2026-10-19T05:30:00.000Z');
    expect(new Date(nextRun('30 7 * * 1-5', { after, timezone: 'America/New_York' })!).toISOString()).toBe('2026-10-16T11:30:00.000Z');
    // after the DST switch Berlin is UTC+1
    expect(new Date(nextRun('0 3 * * *', { after: Date.parse('2026-10-26T00:00:00Z'), timezone: 'Europe/Berlin' })!).toISOString()).toBe('2026-10-26T02:00:00.000Z');
    expect(new Date(previousRun('30 7 * * 1-5', { before: after, timezone: 'Europe/Berlin' })!).toISOString()).toBe('2026-10-16T05:30:00.000Z');
  });

  test('@every keeps cadence from its anchor', () => {
    const anchor = Date.parse('2026-10-16T10:00:00Z');
    expect(nextRun('@every 30m', { after: anchor + 1, anchor })).toBe(anchor + 30 * 60_000);
    // missed several slots: lands on the next slot after `after`
    expect(nextRun('@every 30m', { after: anchor + 95 * 60_000, anchor })).toBe(anchor + 120 * 60_000);
    expect(previousRun('@every 30m', { before: anchor + 95 * 60_000, anchor })).toBe(anchor + 90 * 60_000);
  });

  test('@once uses wall time in the routine timezone', () => {
    expect(new Date(parseOnceDate('2026-10-20T09:00', 'America/New_York')).toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(new Date(parseOnceDate('2026-12-20 09:00', 'Europe/Berlin')).toISOString()).toBe('2026-12-20T08:00:00.000Z');
    const at = Date.parse('2026-10-20T09:00:00Z');
    expect(nextRun('@once 2026-10-20T09:00:00Z', { after: at - 1 })).toBe(at);
    expect(nextRun('@once 2026-10-20T09:00:00Z', { after: at })).toBeUndefined();
  });

  test('@once with no timezone is host wall time, for a bare date too', () => {
    // a child process starts in the time zone; changing TZ inside this one does not stick on every runner
    const src = join(import.meta.dir, '../../src/scheduler/schedule.ts');
    const code = `const { parseOnceDate } = await import(${JSON.stringify(src)}); console.log(JSON.stringify([new Date(parseOnceDate('2026-10-20')).toISOString(), parseOnceDate('2026-10-20') === parseOnceDate('2026-10-20T00:00')]))`;
    const out = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, TZ: 'America/New_York' } });
    expect(JSON.parse(out.stdout.toString())).toEqual(['2026-10-20T04:00:00.000Z', true]);
    expect(() => parseOnceDate('2026-13-40')).toThrow(/Invalid date/);
  });

  test('preview lists the next runs', () => {
    const from = Date.parse('2026-10-16T10:00:00Z');
    expect(previewRuns('@hourly', 'UTC', 3, from).map((t) => new Date(t).toISOString())).toEqual([
      '2026-10-16T11:00:00.000Z',
      '2026-10-16T12:00:00.000Z',
      '2026-10-16T13:00:00.000Z',
    ]);
    expect(previewRuns('@every 2h', undefined, 2, from)).toEqual([from + 2 * 36e5, from + 4 * 36e5]);
    expect(previewRuns('@once 2026-10-20T09:00:00Z', undefined, 5, from).length).toBe(1);
  });
});

describe('Routines', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  function mk(runner?: (r: Routine, run: RoutineRun, extra?: string) => Promise<{ sessionId: string; summary?: string; error?: string }>) {
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on((e) => events.push(e.type));
    const scheduler = new JobScheduler({ repos, backoff: () => 5, maxSleepMs: 200 });
    const calls: Array<{ id: string; extra?: string; trigger: string }> = [];
    const routines = new Routines({
      repos,
      bus,
      scheduler,
      run:
        runner ??
        (async (r, run, extra) => {
          calls.push({ id: r.id, extra, trigger: run.trigger });
          return { sessionId: `ses_${calls.length}`, summary: 'done' };
        }),
    });
    stop = () => (scheduler.stop(), db.close());
    return { routines, repos, scheduler, events, calls, db };
  }

  const base = { name: 'Brief', prompt: 'Do the thing', schedule: '30 7 * * 1-5', timezone: 'Europe/Berlin' };

  test('create schedules exactly one pending job and a webhook secret', () => {
    const { routines, repos } = mk();
    const r = routines.create(base);
    expect(r.webhookSecret?.length).toBeGreaterThan(20);
    expect(r.agent).toBe('assistant');
    const jobs = repos.jobs.pending(ROUTINE_JOB);
    expect(jobs.length).toBe(1);
    expect(jobs[0].dedupeKey).toBe(`routine:${r.id}`);
    expect(jobs[0].runAt).toBe(r.nextRunAt!);
    expect(routines.verifyWebhook(r.id, r.webhookSecret!)).toBe(true);
    expect(routines.verifyWebhook(r.id, 'nope')).toBe(false);

    const u = routines.update(r.id, { schedule: '@every 2h' });
    expect(repos.jobs.pending(ROUTINE_JOB).length).toBe(1);
    expect(repos.jobs.pending(ROUTINE_JOB)[0].runAt).toBe(u.nextRunAt!);

    routines.update(r.id, { enabled: false });
    expect(repos.jobs.pending(ROUTINE_JOB).length).toBe(0);
    expect(routines.get(r.id)?.nextRunAt).toBeUndefined();

    routines.update(r.id, { enabled: true });
    expect(repos.jobs.pending(ROUTINE_JOB).length).toBe(1);
    routines.remove(r.id);
    expect(repos.jobs.pending(ROUTINE_JOB).length).toBe(0);
    expect(routines.list().length).toBe(0);
  });

  test('update keeps to routine fields and refuses an empty name or prompt', () => {
    const { routines } = mk();
    const a = routines.create({ ...base, name: 'A' });
    const b = routines.create({ ...base, name: 'B' });
    const u = routines.update(a.id, { id: b.id, webhookSecret: 'guessable', name: '  A2 ' } as never);
    expect(u.id).toBe(a.id);
    expect(u.name).toBe('A2');
    expect(u.webhookSecret).toBe(a.webhookSecret);
    expect(routines.get(b.id)?.name).toBe('B');
    expect(() => routines.update(a.id, { prompt: ' ' })).toThrow(/prompt/);
    expect(() => routines.update(a.id, { name: null as never })).toThrow(/name/);
    expect(routines.get(a.id)?.prompt).toBe(base.prompt);
  });

  test('invalid schedules are rejected', () => {
    const { routines } = mk();
    expect(() => routines.create({ ...base, schedule: 'every day' })).toThrow();
    const r = routines.create(base);
    expect(() => routines.update(r.id, { schedule: '@every 5s' })).toThrow();
    expect(routines.get(r.id)?.schedule).toBe(base.schedule);
  });

  test('runNow records the run, emits events and remembers a reused session', async () => {
    const { routines, events, calls } = mk();
    const r = routines.create({ ...base, sessionPolicy: 'reuse' });
    const run = await routines.runNow(r.id, 'webhook', 'payload text');
    expect(run.status).toBe('ok');
    expect(run.sessionId).toBe('ses_1');
    expect(run.summary).toBe('done');
    expect(calls[0]).toEqual({ id: r.id, extra: 'payload text', trigger: 'webhook' });
    expect(routines.runs(r.id)[0].status).toBe('ok');
    expect(routines.get(r.id)?.sessionId).toBe('ses_1');
    expect(routines.get(r.id)?.lastRunAt).toBe(run.startedAt);
    expect(events.filter((e) => e === 'routine.run').length).toBe(2);
    expect(events).toContain('routine.updated');
  });

  test('runner errors become error runs, overlapping runs are skipped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { routines } = mk(async () => {
      await gate;
      throw new Error('model unavailable');
    });
    const r = routines.create(base);
    const first = routines.runNow(r.id);
    const second = await routines.runNow(r.id);
    expect(second.status).toBe('skipped');
    release();
    const done = await first;
    expect(done.status).toBe('error');
    expect(done.error).toBe('model unavailable');
  });

  test('a run missed within 6 hours is made up once on startup', async () => {
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    const now = Date.now();
    repos.routines.upsert({
      id: 'rt_missed',
      name: 'Daily',
      schedule: `${oneHourAgo.getUTCMinutes()} ${oneHourAgo.getUTCHours()} * * *`,
      timezone: 'UTC',
      agent: 'assistant',
      mode: 'agent',
      prompt: 'x',
      enabled: true,
      sessionPolicy: 'new',
      notify: 'never',
      lastRunAt: now - 2 * 86_400_000,
      createdAt: now - 3 * 86_400_000,
      updatedAt: now,
    });
    const bus = new EventBus();
    const scheduler = new JobScheduler({ repos, maxSleepMs: 200 });
    const ran: string[] = [];
    new Routines({ repos, bus, scheduler, run: async (r) => (ran.push(r.id), { sessionId: 's' }) });
    stop = () => (scheduler.stop(), db.close());
    scheduler.start();
    const end = Date.now() + 2000;
    while (!ran.length && Date.now() < end) await Bun.sleep(5);
    await scheduler.idle();
    expect(ran).toEqual(['rt_missed']);
    const next = repos.jobs.pending(ROUTINE_JOB);
    expect(next.length).toBe(1);
    expect(next[0].runAt).toBeGreaterThan(Date.now() + 22 * 3_600_000);
  });

  test('a run missed by more than 6 hours is skipped and the next one is queued', async () => {
    const { routines, repos, scheduler, calls } = mk();
    const r = routines.create({ ...base, schedule: '@every 1d', timezone: undefined });
    const late = Date.now() - 10 * 3_600_000;
    scheduler.enqueue(ROUTINE_JOB, late, { routineId: r.id, scheduledAt: late }, `routine:${r.id}`);
    scheduler.start();
    const end = Date.now() + 2000;
    while (!routines.runs(r.id).length && Date.now() < end) await Bun.sleep(5);
    await scheduler.idle();
    expect(calls.length).toBe(0);
    expect(routines.runs(r.id)[0].status).toBe('skipped');
    const next = repos.jobs.pending(ROUTINE_JOB);
    expect(next.length).toBe(1);
    expect(next[0].runAt).toBe(late + 86_400_000);
  });

  test('templates are valid routines', () => {
    const { routines } = mk();
    const ts = routines.templates();
    expect(ts.map((t) => t.id)).toEqual(
      expect.arrayContaining(['morning-brief', 'evening-wrap-up', 'nightly-librarian', 'weekly-review', 'server-watchdog', 'uni-deadlines', 'research-digest', 'repo-health']),
    );
    for (const t of ts) {
      expect(() => parseSchedule(t.schedule, t.timezone)).not.toThrow();
      expect(t.prompt.length).toBeGreaterThan(100);
      expect(t.prompt).not.toContain('\u2014');
    }
    expect(routines.preview('@daily', 'UTC', 2).length).toBe(2);
  });
});
