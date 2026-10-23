/**
 * Shared projects in the web app: the words and orders (lib/sharedProjects.ts)
 * and their place in the Inbox (lib/friendInbox.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { FriendDto, SharedProjectDto } from '@conclave/core/client';
import { friendInbox, friendWaiting } from '../src/lib/friendInbox';
import { byLine, isMailto, itemsOf, membersLine, ownerLine, projectOrder, projectWords, repoOf, repoOfProject, sharedFrom } from '../src/lib/sharedProjects';
import { phonePlace, phoneTitle } from '../src/components/PhoneFrame';

const member = (name: string, state: SharedProjectDto['members'][number]['state'], you = false, role: 'owner' | 'member' = 'member'): SharedProjectDto['members'][number] => ({ fingerprint: name.toLowerCase().padEnd(32, '0'), name, role, state, you });

function project(over: Partial<SharedProjectDto> = {}): SharedProjectDto {
  return {
    id: 'p1',
    name: 'Site',
    role: 'member',
    state: 'active',
    owner: { fingerprint: 'a'.repeat(32), name: 'Alice', you: false, friendId: 'frd_a' },
    members: [member('Alice', 'active', false, 'owner'), member('You', 'active', true)],
    counts: { notes: 1, memories: 0, chats: 0 },
    unread: 0,
    line: 'With Alice',
    shareNewSessions: false,
    createdAt: 1,
    updatedAt: 10,
    ...over,
  };
}

describe('lib/sharedProjects', () => {
  test('repoOf takes owner/name, a GitHub address or a remote', () => {
    expect(repoOf('acme/site')).toBe('acme/site');
    expect(repoOf('https://github.com/acme/site.git')).toBe('acme/site');
    expect(repoOf('git@github.com:acme/site.git')).toBe('acme/site');
    expect(repoOf('github.com/acme/site/')).toBe('acme/site');
    expect(repoOf('https://gitlab.com/acme/site')).toBeUndefined();
    expect(repoOf('acme')).toBeUndefined();
    expect(repoOf('acme/..')).toBeUndefined();
    expect(repoOfProject({ identity: { gitRoots: [], remotes: ['gitlab.com/x/y', 'github.com/acme/site'], shallow: false } })).toBe('acme/site');
  });

  test('invites first, then something new, then the newest; read only last', () => {
    const list = [project({ id: 'old', updatedAt: 1 }), project({ id: 'left', state: 'left', updatedAt: 99 }), project({ id: 'new', unread: 2, updatedAt: 2 }), project({ id: 'inv', state: 'invited', updatedAt: 0 })];
    expect(projectOrder(list).map((p) => p.id)).toEqual(['inv', 'new', 'old', 'left']);
    expect(projectWords(project({ unread: 2 }))).toEqual({ word: '2 new', tone: 'warn' });
    expect(projectWords(project({ role: 'owner' })).word).toBe('Yours');
    expect(projectWords(project({ state: 'removed' })).word).toBe('Taken out');
  });

  test('who is in it, and the items of a kind', () => {
    expect(membersLine(project())).toBe('With Alice');
    expect(membersLine(project({ members: [member('You', 'active', true), member('Bob', 'invited'), member('Carol', 'invited')] }))).toBe('2 invites waiting');
    expect(membersLine(project({ members: [member('You', 'active', true), member('Bob', 'active'), member('Carol', 'active'), member('Dan', 'left')] }))).toBe('With Bob and Carol');
    const item = (id: string, kind: 'note' | 'memory', updatedAt: number, deleted = false) => ({ id, kind, author: 'x', authorName: 'Bob', mine: false, version: 1, text: '', createdAt: 1, updatedAt, receivedAt: 1, unread: false, ...(deleted ? { deleted } : {}) });
    expect(itemsOf([item('a', 'note', 1), item('b', 'note', 3), item('c', 'memory', 2), item('d', 'note', 4, true)], 'note').map((i) => i.id)).toEqual(['b', 'a']);
    expect(byLine({ mine: false, authorName: 'Bob', version: 3 })).toBe('Bob, version 3');
    expect(byLine({ mine: true, authorName: 'Me', version: 1 })).toBe('You');
    expect(sharedFrom('prj_1', [project({ localProjectId: 'prj_1', state: 'left' }), project({ id: 'p2', localProjectId: 'prj_1' })])?.id).toBe('p2');
    expect(isMailto('mailto:a@example.org?subject=x')).toBe(true);
    expect(isMailto('https://example.org')).toBe(false);
  });

  test("whose it is, without naming the owner twice", () => {
    expect(ownerLine(project())).toBe('Alice owns it.');
    expect(ownerLine(project({ members: [member('Alice', 'active', false, 'owner'), member('You', 'active', true), member('Carol', 'active')] }))).toBe('Alice owns it. Carol is in it too.');
    const mine = project({ role: 'owner', members: [member('You', 'active', true, 'owner'), member('Bob', 'active')] });
    expect(ownerLine(mine)).toBe('You own it. With Bob.');
  });

  test('on a phone a project draws its own bar; the list is under Friends', () => {
    expect(phonePlace('/projects/01ABC')).toBe('conversation');
    expect(phonePlace('/projects')).toBe('inner');
    expect(phoneTitle('/projects')).toEqual({ title: 'Shared projects', back: '/settings/friends' });
  });
});

describe('shared projects in the Inbox', () => {
  const alice = { id: 'frd_a', name: 'Alice', status: 'active', direction: 'out', unread: 0, unreadNotes: 0, unreadShares: 0, createdAt: 1 } as FriendDto;

  test('an invite counts one with Accept in place; new items count each; the rest nothing', () => {
    const items = friendInbox([alice], [], [], [project({ id: 'inv', state: 'invited', name: 'Logo' }), project({ id: 'new', unread: 3 }), project({ id: 'quiet' }), project({ id: 'ended', state: 'ended', unread: 0 })]);
    expect(items.map((i) => [i.id, i.kind, i.count])).toEqual([
      ['project:inv', 'project', 1],
      ['project:new', 'project', 3],
    ]);
    expect(items[0]).toMatchObject({ name: 'Alice', line: "Invited you to 'Logo'", href: '/projects/inv', friendId: 'frd_a' });
    expect(items[1]).toMatchObject({ name: 'Site', line: '3 new things from members' });
    expect(friendWaiting(items)).toBe(4);
  });
});
