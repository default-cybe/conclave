import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { JobScheduler } from '../../src/scheduler/scheduler';
import { Routines } from '../../src/scheduler/routines';
import { PREVIOUS_PROMPTS, ROUTINE_TEMPLATES, planUpgrades, promptHash } from '../../src/scheduler';
import type { Routine } from '../../src/types';
import { OLD_TEMPLATES } from './fixtures/old-templates';

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

function hub() {
  const db = openDb(':memory:');
  const repos = new Repos(db);
  const bus = new EventBus();
  const scheduler = new JobScheduler({ repos });
  stops.push(() => (scheduler.stop(), db.close()));
  const make = () => new Routines({ repos, bus, scheduler, run: async () => ({ sessionId: '' }) });
  return { repos, make };
}

function installed(over: Partial<Routine> & Pick<Routine, 'name' | 'prompt' | 'schedule'>): Routine {
  const now = Date.now();
  return { id: `rt_${Math.random().toString(36).slice(2, 8)}`, agent: 'assistant', mode: 'agent', enabled: true, sessionPolicy: 'new', notify: 'always', createdAt: now, updatedAt: now, ...over };
}

describe('template upgrades', () => {
  test('the shipped hashes are the prompts that shipped', () => {
    for (const old of OLD_TEMPLATES) expect(PREVIOUS_PROMPTS[old.id]).toContain(promptHash(old.prompt));
    for (const t of ROUTINE_TEMPLATES) expect(t.template).toBe(t.id);
  });

  test('an installed routine with an old prompt gets the new one and keeps what the owner chose', () => {
    const { repos, make } = hub();
    const old = OLD_TEMPLATES.find((t) => t.id === 'morning-brief')!;
    // made by onboarding before routines kept their template: matched by name
    const mine = installed({ name: 'Morning brief', prompt: old.prompt, schedule: '45 6 * * 1-5', timezone: 'Europe/Berlin', model: 'zai/glm-5', notify: 'on_error', enabled: false });
    repos.routines.upsert(mine);
    const routines = make();
    const r = routines.get(mine.id)!;
    const now = ROUTINE_TEMPLATES.find((t) => t.id === 'morning-brief')!;
    expect(r.prompt).toBe(now.prompt);
    expect(r.prompt).toContain('DayPlan save');
    expect(r).toMatchObject({ template: 'morning-brief', schedule: '45 6 * * 1-5', timezone: 'Europe/Berlin', model: 'zai/glm-5', notify: 'on_error', enabled: false });
    expect(r.allow).toEqual(['DayPlan', 'MailSearch', 'MailRead']);
    // the second start finds it current
    expect(planUpgrades(repos.routines.list())[0].state).toBe('current');
  });

  test('every day-loop template upgrades by its template id too', () => {
    const { repos, make } = hub();
    for (const old of OLD_TEMPLATES) repos.routines.upsert(installed({ name: `${old.name} (mine)`, prompt: old.prompt, schedule: old.schedule, template: old.id }));
    const routines = make();
    for (const r of routines.list()) {
      const t = ROUTINE_TEMPLATES.find((x) => x.id === r.template)!;
      expect(r.prompt).toBe(t.prompt);
      expect(r.name).toEndWith('(mine)');
    }
    expect(routines.list().find((r) => r.template === 'evening-wrap-up')!.allow).toEqual(['GoalLog', 'MemorySave']);
  });

  test('an edited prompt is left alone, and upgrade() applies the template when asked', () => {
    const { repos, make } = hub();
    const old = OLD_TEMPLATES.find((t) => t.id === 'evening-wrap-up')!;
    const edited = installed({ name: 'Evening wrap-up', prompt: `${old.prompt}\n\nAlso list my CTF writeups.`, schedule: '0 22 * * *', allow: ['Bash(ls:*)'] });
    repos.routines.upsert(edited);
    const routines = make();
    expect(routines.get(edited.id)!.prompt).toContain('CTF writeups');
    expect(planUpgrades(repos.routines.list())[0].state).toBe('edited');

    const up = routines.upgrade(edited.id);
    expect(up.prompt).toContain('GoalLog');
    expect(up.schedule).toBe('0 22 * * *');
    expect(up.allow).toEqual(['Bash(ls:*)', 'GoalLog', 'MemorySave']);
    expect(() => routines.upgrade(repos.routines.list().find((r) => r.id !== edited.id)?.id ?? 'rt_none')).toThrow();
  });

  test('a routine with the current prompt and no template id gets linked; one from a suggestion is not touched', () => {
    const { repos, make } = hub();
    const hb = ROUTINE_TEMPLATES.find((t) => t.id === 'heartbeat')!;
    const a = installed({ name: 'Heartbeat', prompt: hb.prompt, schedule: hb.schedule });
    const b = installed({ name: 'Weekly review', prompt: 'my own words', schedule: '0 9 * * 0', suggestion: 'weekly-thing' });
    repos.routines.upsert(a);
    repos.routines.upsert(b);
    const routines = make();
    expect(routines.get(a.id)!.template).toBe('heartbeat');
    expect(routines.get(b.id)!.prompt).toBe('my own words');
    expect(routines.get(b.id)!.template).toBeUndefined();
  });
});
