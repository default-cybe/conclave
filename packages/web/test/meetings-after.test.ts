/**
 * The Meetings page lists every meeting, those made by the old chat-header
 * button (0.4.51: no scheduledAt) included, and "Add to chat..." offers the
 * account's recent chats only.
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import type { Meeting, MeetingStatus } from '@/overlay/wire';
import { sections } from '@/features/meeting/time';
import { chatHref, recentChats } from '@/features/meeting/AfterActions';

const NOW = Date.UTC(2026, 10, 1, 18);
const H = 3_600_000;
const mtg = (id: string, status: MeetingStatus, extra: Partial<Meeting> = {}): Meeting =>
  ({ id, accountId: 'owner', sessionId: `ses_${id}`, device: 'local', cwd: '/x', title: id, status, createdAt: NOW - 48 * H, autoAnswer: 'questions', answerLength: 'short', reminders: [], autoPrep: true, prepState: 'none', ...extra }) as Meeting;

describe('Meetings page lists all meetings', () => {
  test('every status, old and scheduled, lands in exactly one section', () => {
    const list = [
      // made from the old chat button: no scheduledAt
      mtg('old_ended', 'ended', { startedAt: NOW - 47 * H }),
      mtg('old_failed', 'failed'),
      mtg('old_ready', 'ready'),
      mtg('old_preparing', 'preparing'),
      mtg('live', 'live', { startedAt: NOW - H / 4 }),
      mtg('paused', 'paused'),
      mtg('ending', 'ending'),
      mtg('sched', 'scheduled', { scheduledAt: NOW + 24 * H }),
      mtg('not_held', 'scheduled', { scheduledAt: NOW - 10 * H }),
    ];
    const s = sections(list, NOW);
    const all = [...s.now, ...s.upcoming, ...s.past].map((m) => m.id);
    expect(all.sort()).toEqual(list.map((m) => m.id).sort());
    expect(s.past.map((m) => m.id)).toContain('old_ended');
    expect(s.now.map((m) => m.id)).toContain('old_ready');
  });
});

describe('Add to chat', () => {
  const ses = (id: string, extra: Partial<Session>): Session => ({ id, title: id, updatedAt: 0, archived: false, kind: 'chat', ...extra }) as Session;
  test('recent chats, newest first, no archived, delegated or meeting sessions', () => {
    const got = recentChats({
      a: ses('a', { updatedAt: 1 }),
      b: ses('b', { updatedAt: 3, kind: 'agent' }),
      c: ses('c', { updatedAt: 5, archived: true }),
      d: ses('d', { updatedAt: 4, parentId: 'a' }),
      e: ses('e', { updatedAt: 6, kind: 'meeting' as never }),
    });
    expect(got.map((s) => s.id)).toEqual(['b', 'a']);
    expect(chatHref({ id: 'a', kind: 'chat' })).toBe('/chat/a');
    expect(chatHref({ id: 'b', kind: 'agent' })).toBe('/s/b');
  });
});
