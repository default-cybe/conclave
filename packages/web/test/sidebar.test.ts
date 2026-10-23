/**
 * The sidebar's sessions (lib/sidebar.ts, docs/design/SPEC.md 5.3): the mode's
 * conversations, Code by project, device or time, chats and the
 * assistant's by time; a row's device only when the list is not by device;
 * a project's + starting where its newest session is.
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import type { ProjectDto } from '@conclave/core/client';
import type { GroupContext } from '../src/lib/grouping';
import { modeSessions, sideGroups, sideListWord, timeBucket, NEW_WORDS } from '../src/lib/sidebar';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// a fixed afternoon, so Today and Yesterday do not move with the clock
const NOW = new Date(2026, 9, 22, 15, 0).getTime();

function s(id: string, p: Partial<Session>): Session {
  return {
    id,
    title: id,
    agent: 'coder',
    model: 'anthropic/claude-sonnet-5-5',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 30 * MIN,
    stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...p,
  };
}

const loc = (projectId: string, device: string, path: string) => ({ projectId, device, path, via: 'origin' as const, pinned: false });
const project = (id: string, name: string, locations: ProjectDto['locations']): ProjectDto => ({ id, name, identity: { gitRoots: [], remotes: [], shallow: false }, createdAt: 0, updatedAt: 0, locations });

const ctx: GroupContext = {
  projects: {
    prj_conclave: project('prj_conclave', 'conclave', [loc('prj_conclave', 'macbook', '/Users/kai/Developer/conclave'), loc('prj_conclave', 'arch', '/home/kai/code/conclave')]),
  },
  devices: {
    local: { id: 'local', name: 'madx', info: { home: '/root' } as never },
    macbook: { id: 'macbook', name: 'MacBook', info: { home: '/Users/kai' } as never },
    arch: { id: 'arch', name: 'arch-desktop', info: { home: '/home/kai' } as never },
  },
};

const sessions = [
  s('auth', { title: 'Move auth to jose', projectId: 'prj_conclave', device: 'arch', cwd: '/home/kai/code/conclave', updatedAt: NOW - 5 * MIN, status: 'running' }),
  s('list', { title: 'Group the list', projectId: 'prj_conclave', device: 'macbook', cwd: '/Users/kai/Developer/conclave', updatedAt: NOW - 3 * HOUR }),
  s('heap', { title: 'pwn 300', device: 'arch', cwd: '~/ctf/heapnote', updatedAt: NOW - 20 * MIN, status: 'waiting_approval' }),
  s('caddy', { title: 'Caddy or Traefik', device: 'local', cwd: '~', updatedAt: NOW - DAY - HOUR }),
  s('repo', { title: 'Fix the README', device: 'local', cwd: '/root/.conclave/worktrees/fix-readme', meta: { repo: { repo: 'kai/notes', branch: 'conclave/fix-readme', base: 'main' } }, updatedAt: NOW - 3 * DAY }),
  s('old', { title: 'Old session', device: 'macbook', cwd: '~/code/old', updatedAt: NOW - 20 * DAY }),
  // not places the owner went: a subagent, a workflow's agent, a routine run, archived
  s('child', { parentId: 'auth', updatedAt: NOW - MIN }),
  s('wf', { tags: ['workflow'], updatedAt: NOW - MIN }),
  s('routine', { routineId: 'r1', updatedAt: NOW - MIN }),
  s('gone', { archived: true, updatedAt: NOW - MIN }),
  // the other modes
  s('chat1', { kind: 'chat', agent: 'chat', title: 'Caddy certs', updatedAt: NOW - 10 * MIN }),
  s('chat2', { kind: 'chat', agent: 'chat', title: 'Gift ideas', pinned: true, updatedAt: NOW - 40 * DAY }),
  s('asst', { agent: 'assistant', title: 'Plan my week', updatedAt: NOW - 2 * DAY }),
];

const titles = (g: { rows: Array<{ title: string }> }) => g.rows.map((r) => r.title);

describe('the mode', () => {
  test("each switch lists its own conversations, newest first, and only the owner's", () => {
    expect(modeSessions(sessions, 'code').map((x) => x.id)).toEqual(['auth', 'heap', 'list', 'caddy', 'repo', 'old']);
    expect(modeSessions(sessions, 'chat').map((x) => x.id)).toEqual(['chat1', 'chat2']);
    expect(modeSessions(sessions, 'assistant').map((x) => x.id)).toEqual(['asst']);
    expect(sideListWord('code')).toBe('Sessions');
    expect(NEW_WORDS.chat).toBe('New chat');
  });
});

describe('grouped by project', () => {
  const groups = sideGroups({ sessions, mode: 'code', by: 'project', ctx, now: NOW, waiting: new Set(['heap']) });

  test('one group per project across devices, newest group first; no folder goes last', () => {
    expect(groups.map((g) => g.label)).toEqual(['conclave', 'heapnote', 'kai/notes', 'old', 'No folder']);
    expect(titles(groups[0])).toEqual(['Move auth to jose', 'Group the list']);
  });

  test('a row is its title, a quiet state and its device', () => {
    expect(groups[0].rows[0]).toEqual({ id: 'auth', title: 'Move auth to jose', href: '/s/auth', state: 'running', device: 'arch-desktop' });
    expect(groups[0].rows[1]).toEqual({ id: 'list', title: 'Group the list', href: '/s/list', device: 'MacBook' });
    expect(groups[1].rows[0].state).toBe('waiting');
  });

  test("the + starts in the newest session's folder on its device, or its repository", () => {
    expect(groups[0].target).toEqual({ device: 'arch', cwd: '/home/kai/code/conclave' });
    expect(groups[0].projectId).toBe('prj_conclave');
    expect(groups[2].target).toEqual({ device: 'local', repo: 'kai/notes' });
    // no folder has no place to start in
    expect(groups[4].target).toBeUndefined();
  });
});

describe('grouped by device', () => {
  test('one group per device, and the rows leave the device out', () => {
    const groups = sideGroups({ sessions, mode: 'code', by: 'device', ctx, now: NOW });
    expect(groups.map((g) => g.label)).toEqual(['arch-desktop', 'MacBook', 'madx']);
    expect(titles(groups[0])).toEqual(['Move auth to jose', 'pwn 300']);
    expect(groups.flatMap((g) => g.rows).every((r) => r.device === undefined)).toBe(true);
    expect(groups.every((g) => g.target === undefined)).toBe(true);
  });
});

describe('grouped by time', () => {
  test('Today, Yesterday, This week, Older, with the device on Code rows', () => {
    const groups = sideGroups({ sessions, mode: 'code', by: 'time', ctx, now: NOW });
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'This week', 'Older']);
    expect(titles(groups[0])).toEqual(['Move auth to jose', 'pwn 300', 'Group the list']);
    expect(titles(groups[1])).toEqual(['Caddy or Traefik']);
    expect(titles(groups[2])).toEqual(['Fix the README']);
    expect(titles(groups[3])).toEqual(['Old session']);
    expect(groups[0].rows[0].device).toBe('arch-desktop');
  });

  test('chats and the assistant always go by time, pinned first, with no device', () => {
    const chats = sideGroups({ sessions, mode: 'chat', by: 'project', ctx, now: NOW });
    expect(chats.map((g) => g.label)).toEqual(['Pinned', 'Today']);
    expect(chats[1].rows[0]).toEqual({ id: 'chat1', title: 'Caddy certs', href: '/chat/chat1' });
    const asst = sideGroups({ sessions, mode: 'assistant', by: 'device', ctx, now: NOW });
    expect(asst.map((g) => g.label)).toEqual(['This week']);
  });

  test('the buckets follow the calendar', () => {
    const at = (d: number, h: number) => new Date(2026, 9, 22 - d, h, 0).getTime();
    expect(timeBucket(at(0, 0), NOW).key).toBe('today');
    expect(timeBucket(at(1, 23), NOW).key).toBe('yesterday');
    expect(timeBucket(at(1, 0), NOW).key).toBe('yesterday');
    expect(timeBucket(at(2, 23), NOW).key).toBe('week');
    expect(timeBucket(at(6, 0), NOW).key).toBe('week');
    expect(timeBucket(at(7, 23), NOW).key).toBe('older');
  });

  test('it lists at most the limit', () => {
    const many = Array.from({ length: 120 }, (_, i) => s(`m${i}`, { updatedAt: NOW - i * MIN }));
    const rows = sideGroups({ sessions: many, mode: 'code', by: 'time', ctx, now: NOW }).flatMap((g) => g.rows);
    expect(rows.length).toBe(80);
  });
});
