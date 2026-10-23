/**
 * Group by Project and Device (lib/grouping.ts): one group per project
 * across devices, a project found from a location before the session had a
 * turn, the folder's name for sessions without a project, Chats last, and
 * the side panel's Recents in groups.
 *
 *   bun test packages/web/test/grouping.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import type { ProjectDto } from '@conclave/core/client';
import { CHATS, expandHome, groupSessions, projectGroupOf, type GroupContext } from '../src/lib/grouping';

const MIN = 60_000;
const now = Date.now();

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
    createdAt: now - 60 * MIN,
    updatedAt: now - 30 * MIN,
    stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...p,
  };
}

const loc = (projectId: string, device: string, path: string) => ({ projectId, device, path, via: 'origin' as const, pinned: false });
const project = (id: string, name: string, locations: ProjectDto['locations']): ProjectDto => ({ id, name, identity: { gitRoots: [], remotes: [], shallow: false }, createdAt: 0, updatedAt: 0, locations });

const ctx: GroupContext = {
  projects: {
    prj_conclave: project('prj_conclave', 'conclave', [loc('prj_conclave', 'macbook', '/Users/kai/Developer/conclave'), loc('prj_conclave', 'local', '/srv/conclave')]),
    prj_portfolio: project('prj_portfolio', 'portfolio', [loc('prj_portfolio', 'arch', '/home/kai/code/portfolio')]),
  },
  devices: {
    local: { id: 'local', name: 'homelab', info: { home: '/root' } as never },
    macbook: { id: 'macbook', name: 'MacBook', info: { home: '/Users/kai' } as never },
    arch: { id: 'arch', name: 'arch-desktop', info: { home: '/home/kai' } as never },
  },
};

describe('projectGroupOf', () => {
  test('a session with a project goes under its name', () => {
    expect(projectGroupOf(s('a', { projectId: 'prj_conclave', device: 'macbook', cwd: '/Users/kai/Developer/conclave' }), ctx)).toEqual({ key: 'p:prj_conclave', label: 'conclave' });
  });
  test('before its first turn, a location of a project on its device holds the folder (~ expanded)', () => {
    expect(projectGroupOf(s('b', { device: 'macbook', cwd: '~/Developer/conclave/packages/web' }), ctx).key).toBe('p:prj_conclave');
    expect(projectGroupOf(s('c', { device: 'local', cwd: '/srv/conclave' }), ctx).key).toBe('p:prj_conclave');
    // the same path on another device is not that location
    expect(projectGroupOf(s('d', { device: 'arch', cwd: '/srv/conclave' }), ctx)).toEqual({ key: 'f:conclave', label: 'conclave' });
  });
  test('no project: the folder name; no folder or a chat: Chats', () => {
    expect(projectGroupOf(s('e', { device: 'arch', cwd: '~/code/scantools' }), ctx)).toEqual({ key: 'f:scantools', label: 'scantools' });
    expect(projectGroupOf(s('f', { device: 'arch', cwd: '~' }), ctx).key).toBe(CHATS);
    expect(projectGroupOf(s('g', { device: 'local', cwd: '/root' }), ctx).key).toBe(CHATS);
    expect(projectGroupOf(s('h', { kind: 'chat', cwd: '/srv/conclave' }), ctx)).toEqual({ key: CHATS, label: 'Chats' });
  });
  test('a project the list has not loaded keeps its sessions together under the folder name', () => {
    expect(projectGroupOf(s('i', { projectId: 'prj_new', device: 'arch', cwd: '/home/kai/code/rust-tunnel' }), ctx)).toEqual({ key: 'p:prj_new', label: 'rust-tunnel' });
  });
  test('expandHome', () => {
    expect(expandHome('~', '/Users/kai/')).toBe('/Users/kai');
    expect(expandHome('~/x/', '/Users/kai')).toBe('/Users/kai/x');
    expect(expandHome('~/x', undefined)).toBe('~/x');
  });
});

describe('groupSessions', () => {
  const list = [
    s('mac', { title: 'Group the list by project', device: 'macbook', cwd: '/Users/kai/Developer/conclave', projectId: 'prj_conclave', updatedAt: now - 5 * MIN }),
    s('hub', { title: 'Run the core tests', device: 'local', cwd: '/srv/conclave', updatedAt: now - 50 * MIN }),
    s('cc', { title: 'Imported from Claude Code', device: 'macbook', cwd: '/Users/kai/Developer/conclave', projectId: 'prj_conclave', tags: ['imported', 'claude-code'], updatedAt: now - 3 * 60 * MIN }),
    s('home', { title: 'Reverse proxy for the homelab', device: 'local', cwd: '~', updatedAt: now - 2 * MIN }),
    s('port', { title: 'Dark mode toggle', device: 'arch', cwd: '/home/kai/code/portfolio/src', updatedAt: now - 20 * MIN }),
    s('scan', { title: 'Parse nmap XML', device: 'arch', cwd: '/home/kai/code/scantools', updatedAt: now - 9 * 60 * MIN }),
  ];

  test('by project: one group per project across devices, newest group first, Chats last', () => {
    const g = groupSessions(list, 'project', ctx);
    expect(g.map((x) => x.label)).toEqual(['conclave', 'portfolio', 'scantools', 'Chats']);
    expect(g[0].items.map((x) => x.id)).toEqual(['mac', 'hub', 'cc']);
    expect(new Set(g[0].items.map((x) => x.device))).toEqual(new Set(['macbook', 'local']));
    expect(g[0].last).toBe(now - 5 * MIN);
    expect(g[3].items.map((x) => x.id)).toEqual(['home']);
  });

  test('by device: one group per device, newest first', () => {
    const g = groupSessions(list, 'device', ctx);
    expect(g.map((x) => x.label)).toEqual(['homelab', 'MacBook', 'arch-desktop']);
    expect(g[0].items.map((x) => x.id)).toEqual(['home', 'hub']);
  });
});
