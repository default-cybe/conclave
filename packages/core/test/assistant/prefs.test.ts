import { afterEach, describe, expect, test } from 'bun:test';
import { ASSISTANT_AGENT, PREFS_TAG, QuietHoursNotifier, QUIET_JOB, cronHours, insideHours, nextOpening, parsePrefsText, renderPrefs, zoneIn, DEFAULT_PREFS } from '../../src/assistant';
import type { Notifier } from '../../src/notify/types';
import type { Notice } from '../../src/types';
import { makeAssistant } from './helpers';

let t: ReturnType<typeof makeAssistant> | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe('proactive preferences', () => {
  test('defaults: messages 09:00 to 21:30 in the hub zone, a short list', () => {
    t = makeAssistant();
    expect(t.assistant.prefs.get()).toEqual(DEFAULT_PREFS);
    expect(t.assistant.prefs.timezone()).toEqual({ zone: 'Europe/Berlin', source: 'hub' });
  });

  test('saved as one profile memory the assistant sees, parsed back after an edit on the Memory page', async () => {
    t = makeAssistant();
    await t.assistant.prefs.set({ tell: ['uni deadlines within 3 days', 'homelab outages'], never: ['sports scores'], hours: '08:30-22:00', how: 'line' });
    const profile = t.memory.profile({ agent: ASSISTANT_AGENT });
    expect(profile).toHaveLength(1);
    expect(profile[0].tags).toEqual([PREFS_TAG]);
    expect(profile[0].content).toBe('Proactive preferences. Tell me about: uni deadlines within 3 days; homelab outages. Never tell me about: sports scores. Messages only between 08:30 and 22:00 (Europe/Berlin); outside that they wait, except approvals, questions and failures. How: one brief line.');
    // other agents do not pay for it
    expect(t.memory.profile({ agent: 'coder' })).toHaveLength(0);

    await t.memory.update(profile[0].id, { content: profile[0].content.replace('sports scores', 'sports scores; crypto prices').replace('How: one brief line', 'How: a full page when it needs one') });
    expect(t.assistant.prefs.get()).toMatchObject({ never: ['sports scores', 'crypto prices'], how: 'page', hours: { start: '08:30', end: '22:00' } });

    await expect(t.assistant.prefs.set({ hours: 'whenever' })).rejects.toThrow(/start and an end/);
    await expect(t.assistant.prefs.set({ how: 'poem' as never })).rejects.toThrow(/line, list or page/);
    await expect(t.assistant.prefs.set({ timezone: 'Mars/Olympus' })).rejects.toThrow(/not a timezone/);
  });

  test('render and parse agree, empty lists included', () => {
    const p = { ...DEFAULT_PREFS, tell: ['a', 'b'] };
    expect(parsePrefsText(renderPrefs(p, 'UTC'))).toEqual({ tell: ['a', 'b'], never: [], hours: { start: '09:00', end: '21:30' }, how: 'list' });
    expect(parsePrefsText('pve is the Proxmox host')).toBeUndefined();
  });

  test('the timezone comes from the preferences, then profile memory, then the hub', async () => {
    t = makeAssistant({ hubZone: 'UTC' });
    expect(t.assistant.prefs.timezone()).toEqual({ zone: 'UTC', source: 'hub' });
    await t.memory.save({ content: 'Lives in Berlin. Timezone: Europe/Berlin.', kind: 'profile' });
    expect(t.assistant.prefs.timezone()).toEqual({ zone: 'Europe/Berlin', source: 'profile' });
    await t.assistant.prefs.set({ timezone: 'Asia/Tokyo' });
    expect(t.assistant.prefs.timezone()).toEqual({ zone: 'Asia/Tokyo', source: 'set' });
    expect(zoneIn('my tz is UTC')).toBe('UTC');
    expect(zoneIn('no zone here')).toBeUndefined();
  });

  test('message hours and quiet hours', () => {
    const tz = 'Europe/Berlin';
    const hours = { start: '09:00', end: '21:30' };
    // 2026-10-17 is CEST (UTC+2)
    expect(insideHours(Date.parse('2026-10-17T07:30:00Z'), hours, tz)).toBe(true); // 09:30
    expect(insideHours(Date.parse('2026-10-17T19:45:00Z'), hours, tz)).toBe(false); // 21:45
    expect(insideHours(Date.parse('2026-10-17T05:00:00Z'), hours, tz)).toBe(false); // 07:00
    expect(new Date(nextOpening(Date.parse('2026-10-17T19:45:00Z'), hours, tz)).toISOString()).toBe('2026-10-18T07:00:00.000Z');
    expect(new Date(nextOpening(Date.parse('2026-10-17T05:00:00Z'), hours, tz)).toISOString()).toBe('2026-10-17T07:00:00.000Z');
    // a window over midnight
    expect(insideHours(Date.parse('2026-10-17T22:30:00Z'), { start: '22:00', end: '02:00' }, tz)).toBe(true);
    expect(cronHours(hours)).toBe('9-21');
    expect(cronHours({ start: '08:00', end: '21:00' })).toBe('8-20');
    expect(cronHours({ start: '22:00', end: '02:00' })).toBe('22-23,0-1');
  });
});

describe('quiet hours for routine notices', () => {
  function fakeNotifier() {
    const sent: Array<{ notice: Omit<Notice, 'id' | 'createdAt' | 'alert'>; force?: boolean }> = [];
    const inner = {
      send: async (notice: Omit<Notice, 'id' | 'createdAt' | 'alert'>, opts: { force?: boolean } = {}) => {
        sent.push({ notice, force: opts.force });
        return { ...notice, id: 'n', createdAt: 0 } as Notice;
      },
    } as unknown as Notifier;
    return { inner, sent };
  }

  test('a routine notice in quiet hours waits for the hours to start; failures, approvals and other sessions go now', async () => {
    let now = Date.parse('2026-10-17T21:00:00Z'); // 23:00 in Berlin
    t = makeAssistant({ now: () => now });
    const { inner, sent } = fakeNotifier();
    const routineSession = 'ses_routine';
    const q = new QuietHoursNotifier(inner, {
      routineSession: (id) => id === routineSession,
      quiet: (ts) => t!.assistant.prefs.quiet(ts),
      scheduler: t.scheduler,
      waiting: () => t!.repos.jobs.pending(QUIET_JOB).length,
      now: () => now,
    });

    await q.send({ title: 'Routine: Heartbeat', body: 'Lab report due at 23:59', level: 'warning', sessionId: routineSession });
    expect(sent).toHaveLength(0);
    const jobs = t.repos.jobs.pending(QUIET_JOB);
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].runAt).toISOString()).toBe('2026-10-18T07:00:00.000Z');
    expect(q.waiting()).toBe(1);

    await q.send({ title: 'Routine failed: Heartbeat', body: 'boom', level: 'error', sessionId: routineSession });
    await q.send({ title: 'Approval needed', body: 'Run rm', level: 'warning', sessionId: routineSession, approvalId: 'appr_1' });
    await q.send({ title: 'Question', body: 'Which host?', level: 'info', sessionId: routineSession }, { force: true });
    await q.send({ title: 'Done', body: 'A session I started', level: 'success', sessionId: 'ses_mine' });
    expect(sent.map((s) => s.notice.title)).toEqual(['Routine failed: Heartbeat', 'Approval needed', 'Question', 'Done']);

    // the job delivers once the hours start
    now = Date.parse('2026-10-18T07:00:00Z');
    const handler = (t.scheduler as unknown as { handlers: Map<string, (p: Record<string, unknown>) => Promise<void>> }).handlers.get(QUIET_JOB)!;
    await handler(jobs[0].payload as Record<string, unknown>);
    expect(sent.at(-1)!.notice.title).toBe('Routine: Heartbeat');

    // inside the hours a routine notice goes straight out
    sent.length = 0;
    await q.send({ title: 'Routine: Morning brief', body: 'Plan', level: 'success', sessionId: routineSession });
    expect(sent).toHaveLength(1);
  });
});
