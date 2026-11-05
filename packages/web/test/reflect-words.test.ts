/**
 * Settings > Reflect (features/settings/reflect.tsx): where it sits in
 * Settings, and its words for the last run, the time and the model.
 */
import { describe, expect, test } from 'bun:test';
import { groupSections, searchSections, SETTINGS_GROUPS } from '../src/features/settings/nav';
import { bigNumbers, dayWords, excludedWords, fallbackWords, heatLevel, lastRunWords, lateLine, madeWords, modelChoice, reportRange, REFLECT_LINE, rhythmWords, TIME, timeWords } from '../src/features/settings/reflectWords';

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

  test('report words: range, made, numbers, heat, late night, footnote', () => {
    const start = Date.parse('2026-10-30T07:00:00Z');
    expect(reportRange({ start, end: Date.parse('2026-11-05T18:00:00Z'), timezone: 'America/Los_Angeles' })).toBe('30 Oct to 5 Nov');
    expect(reportRange({ start: Date.parse('2025-11-06T08:00:00Z'), end: Date.parse('2026-11-05T18:00:00Z'), timezone: 'America/Los_Angeles' })).toBe('6 Nov 2025 to 5 Nov 2026');
    const now = Date.parse('2026-11-05T18:00:00Z');
    expect(madeWords({ generatedAt: now - 2 * 3600_000, insights: 'model' }, now)).toContain('Made 2 h ago with your small model');
    expect(madeWords({ generatedAt: now, insights: 'basic' }, now)).toContain('from the numbers only');
    const b = bigNumbers({ chats: 12, sessions: 1, workflows: 0, hoursActive: 3.5, tokens: 3_200_000, costUsd: 4, projects: 2 });
    expect(b.map((x) => x.value)).toEqual(['13', '3.5', '3.2M', '2']);
    expect(b[0]!.label).toBe('12 chats, 1 session');
    expect([heatLevel(0, 10), heatLevel(1, 10), heatLevel(10, 10)]).toEqual([0, 1, 4]);
    expect(lateLine(0.1, 100)).toBeUndefined();
    expect(lateLine(0.3, 100)).toContain('30%');
    expect(excludedWords({ health: 0, incognito: 0 })).toBeUndefined();
    expect(excludedWords({ health: 2, incognito: 0 })).toContain('2 health-related sessions');
    expect(dayWords('2026-11-03')).toBe('Tue 3 Nov');
  });

  test('the late-night share is said once: in the stats line only when the gentle line is not shown', () => {
    const rhythm = { heatmap: [], messages: 100, activeDays: 4, longestStreak: 1, busiestDay: { date: '2026-11-03', count: 40 }, lateNightShare: 0.27 };
    const stats = rhythmWords(rhythm);
    expect(stats).toBe('4 active days, longest streak 1 day, busiest Tue 3 Nov with 40 messages.');
    expect(`${stats} ${lateLine(rhythm.lateNightShare, rhythm.messages)}`.match(/27%/g)).toHaveLength(1);
    expect(rhythmWords({ ...rhythm, lateNightShare: 0.1 })).toContain('10% late at night.');
  });

  test('fallbacks and models read with the model picker names, not raw ids', () => {
    expect(fallbackWords({ fallbacks: 3, topFallback: 'cliproxy/claude-opus-5-5 to anthropic/claude-sonnet-5-5' })).toBe('3 fallbacks, most often Opus 5.5 to Sonnet 5.5. ');
    expect(fallbackWords({ fallbacks: 1 })).toBe('1 fallback. ');
    expect(fallbackWords({ fallbacks: 0 })).toBe('');
  });
});
