/**
 * Security start mode (docs/design/SECURITY-MODE.md 1.1): the switch's fifth
 * mode starts the security agent in a hunt folder, keeps picks of its own,
 * and lists its sessions as Hunts by project. Settings > Security sits under
 * Models.
 *
 *   bun test packages/web/test/security-start.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import { customAgent, lastOwnSession, modeOf, offersIncognito, readMode, showsDay, readPicks, saveMode, savePicks, sessionSetup, START_MODES } from '../src/features/home/start';
import { fromWords, inFolders, modeSessions, NEW_WORDS, sideGroups, sideListWord, sideModeOf } from '../src/lib/sidebar';
import { groupSections, searchSections } from '../src/features/settings/nav';

const g = globalThis as { localStorage?: unknown };

function session(id: string, p: Partial<Session> = {}): Session {
  return { id, title: id, agent: 'coder', model: 'm/a', mode: 'agent', permissionMode: 'default', cwd: '~/hunt', device: 'arch', status: 'idle', tags: [], pinned: false, archived: false, createdAt: 1, updatedAt: 1, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, ...p };
}

const agents = [
  { name: 'coder', model: 'anthropic/claude-sonnet-5-5' },
  { name: 'security', model: 'cliproxy/claude-opus-5-5' },
];
const devices = { local: { id: 'local', online: true }, arch: { id: 'arch', online: true } };

describe('Security start mode', () => {
  test('is a mode of the switch, between Code and Canvas, and is remembered', () => {
    expect(START_MODES.map((m) => m.value)).toEqual(['chat', 'assistant', 'code', 'security', 'canvas']);
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveMode('security');
    expect(readMode()).toBe('security');
  });

  test('a hunt is never incognito: only Chat and Code offer it', () => {
    expect(START_MODES.map((m) => m.value).filter(offersIncognito)).toEqual(['chat', 'code']);
  });

  test('Chat, Code and Security Home leave out the day (calendar, tasks, plan); Assistant keeps it', () => {
    expect(START_MODES.map((m) => m.value).filter(showsDay)).toEqual(['assistant']);
  });

  test('a session of the security agent belongs to Security; Code never offers it as a custom agent', () => {
    expect(modeOf({ agent: 'security' })).toBe('security');
    expect(sideModeOf({ agent: 'security' })).toBe('security');
    expect(modeOf({ kind: 'chat', agent: 'security' })).toBe('chat');
    expect(customAgent('security')).toBe(false);
  });

  test('starts the security agent, whatever Code picked, on the last hunt folder', () => {
    const last = session('h', { agent: 'security', model: 'zai/glm-5.3', cwd: '~/hunts/app', device: 'arch' });
    // a phone starts on the last computer used (startDevice), as Code does
    const s = sessionSetup({ kind: 'security', surface: 'phone', picks: { agent: 'coder' }, last, agents, devices, defaultModel: 'x/y' });
    expect(s).toMatchObject({ agent: 'security', model: 'zai/glm-5.3', device: 'arch', cwd: '~/hunts/app' });
    expect(lastOwnSession({ h: last, c: session('c', { updatedAt: 9 }) }, false, 'security')?.id).toBe('h');
  });

  test('keeps picks of its own, so a hunt folder never becomes Code\u2019s', () => {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    savePicks({ cwd: '~/code/app', cwdDevice: 'arch' });
    savePicks({ cwd: '~/hunts/target', cwdDevice: 'arch' }, 'security');
    expect(readPicks().cwd).toBe('~/code/app');
    expect(readPicks('security').cwd).toBe('~/hunts/target');
  });

  test('the sidebar lists hunts apart from Code, by project, with their own words', () => {
    const all = [session('h', { agent: 'security', cwd: '~/hunts/a' }), session('c', { cwd: '~/code/b' })];
    expect(modeSessions(all, 'security').map((s) => s.id)).toEqual(['h']);
    expect(modeSessions(all, 'code').map((s) => s.id)).toEqual(['c']);
    expect(inFolders('security')).toBe(true);
    expect(sideListWord('security')).toBe('Hunts');
    expect(NEW_WORDS.security).toBe('New hunt');
    const groups = sideGroups({ sessions: all, mode: 'security', by: 'project', ctx: { projects: [], devices: {} }, now: 2 });
    expect(groups.flatMap((x) => x.rows.map((r) => r.id))).toEqual(['h']);
    expect(groups[0].target).toEqual({ device: 'arch', cwd: '~/hunts/a' });
    expect(fromWords({ title: 'Hunt app', agent: 'security' })).toBe('from Hunt app in Security');
  });

  test('Settings > Security is under Advanced and found by its words', () => {
    const sections = [{ id: 'usage', label: 'Limit fallback', desc: '' }, { id: 'security', label: 'Security', desc: 'Roles' }, { id: 'defaults', label: 'Defaults', desc: '' }];
    expect(groupSections(sections).find((x) => x.label === 'Advanced')?.items.map((s) => s.id)).toEqual(['usage', 'security']);
    expect(searchSections(sections, 'hunter').map((s) => s.id)).toEqual(['security']);
  });
});
