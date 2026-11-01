/**
 * Settings > Reflect (features/settings/reflect.tsx): where it sits in
 * Settings, and its words for the last run, the time and the model.
 */
import { describe, expect, test } from 'bun:test';
import { groupSections, searchSections, SETTINGS_GROUPS } from '../src/features/settings/nav';
import { lastRunWords, modelChoice, REFLECT_LINE, TIME, timeWords } from '../src/features/settings/reflectWords';

const at = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

describe('Settings > Reflect', () => {
  test('sits in the Settings group after Assistant, and search finds it', () => {
    const settings = SETTINGS_GROUPS.find((g) => g.label === 'Settings')!;
    expect(settings.ids.indexOf('reflect')).toBe(settings.ids.indexOf('assistant') + 1);
    const sections = [
      { id: 'assistant', label: 'Assistant', desc: 'What the assistant brings up on its own.' },
      { id: 'reflect', label: 'Reflect', desc: 'What the assistant learns each night.' },
    ];
    expect(groupSections(sections)[0].items.map((s) => s.id)).toEqual(['assistant', 'reflect']);
    expect(searchSections(sections, 'reflection notes').map((s) => s.id)).toEqual(['reflect']);
  });

  test('the last run in words', () => {
    const now = at(9, 0);
    const base = { id: 'r', trigger: 'schedule' as const, startedAt: at(2, 40), finishedAt: at(2, 41) };
    expect(lastRunWords({ ...base, status: 'ok', saved: 2, retired: 1 }, now)).toBe('Last ran 02:40, saved 2 notes, retired 1.');
    expect(lastRunWords({ ...base, status: 'ok', saved: 1, retired: 0 }, now)).toBe('Last ran 02:40, saved 1 note.');
    expect(lastRunWords({ ...base, status: 'ok', saved: 0, retired: 0 }, now)).toBe('Last ran 02:40, nothing new to keep.');
    expect(lastRunWords({ ...base, status: 'skipped', saved: 0, retired: 0, reason: 'No chats since the last reflection' }, now)).toBe('Last ran 02:40, skipped: no chats since the last reflection.');
    expect(lastRunWords({ ...base, trigger: 'manual', status: 'ok', saved: 1, retired: 1 }, now)).toBe('Last ran 02:40 (Reflect now), saved 1 note, retired 1.');
    expect(lastRunWords({ ...base, status: 'running', saved: 0, retired: 0 }, now)).toBe('Running since 02:40.');
    expect(lastRunWords(undefined)).toBe('Has not run yet.');
  });

  test('the time and the model', () => {
    expect(TIME.test('02:40')).toBe(true);
    expect(TIME.test('2:40')).toBe(false);
    expect(TIME.test('24:00')).toBe(false);
    expect(timeWords({ enabled: false, time: '02:40', schedule: '40 2 * * *', timezone: 'Europe/Berlin' })).toBe('Every night at 02:40, Europe/Berlin. Off for now.');
    expect(timeWords({ enabled: true, schedule: '0 */6 * * *', timezone: 'UTC' })).toContain('set on Routines');
    expect(modelChoice(undefined)).toBe('default');
    expect(modelChoice('fast')).toBe('fast');
    expect(modelChoice('anthropic/claude-haiku-5-5')).toBe('other');
  });

  test('the line on what it does and costs is plain', () => {
    expect(REFLECT_LINE).toContain('at most 3 notes');
    expect(REFLECT_LINE).toContain('$0.07');
    expect(REFLECT_LINE).not.toMatch(/[\u2013\u2014]/);
  });
});
