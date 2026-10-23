/**
 * Friends in the app (src/lib/friends.ts): the invite link in pasted or
 * scanned text, the short key and the safety code in groups, reachability
 * in words, a friend's state, what friends put in the Inbox (from the hub's
 * read marks), how a sent note is doing, and where Friends sits on a phone.
 *
 *   bun test packages/web/test/friends.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { FriendDto, FriendReachability, InboxItemDto, OutboxItemDto } from '@conclave/core/client';
import {
  agoText,
  deliveryWords,
  friendInbox,
  friendOrder,
  friendState,
  friendWaiting,
  parseFriendLink,
  reachWords,
  safetyGroups,
  shortFingerprint,
  stampText,
  untilText,
} from '../src/lib/friends';
import { phonePlace } from '../src/components/PhoneFrame';
import { MORE_PAGES } from '../src/components/nav';

const FP = '3f9a12c08e4107b2d55e6a1c9b0f4e21';
const SECRET = 'q8Zr2LxP0vT7mN4kW1sY9a';
const link = (extra = '') => `conclave://friend?fp=${FP}&url=${encodeURIComponent('https://alice.example.net')}${extra}&s=${SECRET}&exp=1792000000`;

const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function friend(p: Partial<FriendDto> = {}): FriendDto {
  return {
    id: 'frd_a',
    name: 'Alice',
    fingerprint: FP,
    status: 'active',
    direction: 'out',
    verified: false,
    safetyCode: '18342 90311 55120 07718',
    grants: { receiveShares: true },
    addresses: [{ url: 'https://alice.example.net', kind: 'own' }],
    createdAt: NOW - 30 * DAY,
    queued: 0,
    ...p,
  };
}

function note(p: Partial<InboxItemDto> = {}): InboxItemDto {
  return { id: '01JA0000000000000000000001', friendId: 'frd_a', friendName: 'Alice', type: 'note', state: 'received', text: 'Lunch on Friday?', receivedAt: NOW - HOUR, ...p };
}

function sent(p: Partial<OutboxItemDto> = {}): OutboxItemDto {
  return { id: '01JA0000000000000000000002', friendId: 'frd_a', type: 'note', state: 'delivered', attempts: 1, createdAt: NOW - 30 * MIN, deliveredAt: NOW - 30 * MIN, via: 'push', preview: 'note: Yes, 12:30 at the usual place.', ...p };
}

describe('parseFriendLink', () => {
  test('the link alone', () => {
    expect(parseFriendLink(link())).toEqual({ link: link(), fp: FP, url: 'https://alice.example.net', alts: [], expiresAt: 1792000000 * 1000 });
  });

  test('a link inside a message, with the full stop after it', () => {
    const got = parseFriendLink(`Here is my invite: ${link()}. See you there!`);
    expect(got?.link).toBe(link());
    expect(got?.fp).toBe(FP);
  });

  test('other addresses, cleaned, without the first one again or repeats', () => {
    const alts = ['http://192.168.1.20:7717/', 'https://alice.example.net', 'http://192.168.1.20:7717'].map((a) => `&alt=${encodeURIComponent(a)}`).join('');
    expect(parseFriendLink(link(alts))?.alts).toEqual(['http://192.168.1.20:7717']);
  });

  test('a fingerprint in capitals reads the same', () => {
    expect(parseFriendLink(link().replace(FP, FP.toUpperCase()))?.fp).toBe(FP);
  });

  test('not an invite: a pairing link, a web address, half a link, nothing', () => {
    expect(parseFriendLink('conclave://pair?url=http%3A%2F%2F192.168.1.20%3A7717&code=ABCD-EFGH')).toBeUndefined();
    expect(parseFriendLink('https://alice.example.net')).toBeUndefined();
    expect(parseFriendLink(link().replace(/&s=[^&]+/, ''))).toBeUndefined();
    expect(parseFriendLink(link().replace(/&exp=\d+/, ''))).toBeUndefined();
    expect(parseFriendLink(link().replace(FP, 'abc'))).toBeUndefined();
    expect(parseFriendLink(link().replace(encodeURIComponent('https://alice.example.net'), encodeURIComponent('ftp://alice')))).toBeUndefined();
    expect(parseFriendLink('')).toBeUndefined();
    expect(parseFriendLink(undefined)).toBeUndefined();
  });
});

describe('keys and codes', () => {
  test('a short key is the first four groups', () => {
    expect(shortFingerprint(FP)).toBe('3f9a 12c0 8e41 07b2');
    expect(shortFingerprint(FP, 2)).toBe('3f9a 12c0');
    expect(shortFingerprint('3F9A 12C0 8E41 07B2 D55E')).toBe('3f9a 12c0 8e41 07b2');
  });

  test('the safety code in four groups of five, however it came', () => {
    expect(safetyGroups('18342 90311 55120 07718')).toEqual(['18342', '90311', '55120', '07718']);
    expect(safetyGroups('18342903115512007718')).toEqual(['18342', '90311', '55120', '07718']);
    expect(safetyGroups('18342-90311-55120-07718')).toEqual(['18342', '90311', '55120', '07718']);
    expect(safetyGroups('')).toEqual([]);
  });
});

describe('times', () => {
  test('ago', () => {
    expect(agoText(NOW - 10_000, NOW)).toBe('just now');
    expect(agoText(NOW - 4 * MIN, NOW)).toBe('4m ago');
    expect(agoText(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(agoText(NOW - 2 * DAY, NOW)).toBe('2d ago');
    expect(agoText(NOW - 30 * DAY, NOW)).toMatch(/^on \d{1,2} \w{3,4}$/);
  });

  test('a label over notes: today, yesterday, a date', () => {
    expect(stampText(NOW - HOUR, NOW)).toBe('Today 14:00');
    expect(stampText(NOW - DAY, NOW)).toBe('Yesterday 15:00');
    expect(stampText(NOW - 5 * DAY, NOW)).toBe('15 Oct 15:00');
  });

  test('until when an invite works', () => {
    expect(untilText(NOW + HOUR, NOW)).toBe('until 16:00 today');
    expect(untilText(NOW + DAY, NOW)).toBe('until 15:00 tomorrow');
    expect(untilText(NOW + 3 * DAY, NOW)).toBe('until 23 Oct 15:00');
  });
});

describe('reachWords', () => {
  const r = (p: Partial<FriendReachability>): FriendReachability => ({ ok: false, mode: 'off', ...p });

  test('remote access off says so plainly and what to do', () => {
    const w = reachWords(r({ mode: 'off' }))!;
    expect(w.ok).toBe(false);
    expect(w.title).toBe('Friends cannot reach this hub.');
    expect(w.why).toBe('Remote access is off.');
    expect(w.detail).toContain('Remote access');
    expect(w.detail).toContain('still fetches');
  });

  test('Tailscale serves only the tailnet', () => {
    expect(reachWords(r({ mode: 'tailscale', best: { url: 'https://madx.tail4e2a.ts.net', kind: 'own' } }))).toMatchObject({ ok: false, title: 'Friends cannot reach this hub.', why: 'Tailscale serves only your tailnet.' });
  });

  test('a tunnel that is not up yet takes the hub\'s reason', () => {
    const w = reachWords(r({ mode: 'quick', reason: 'The tunnel is still starting. Until then your hub still fetches what friends hold for it.' }))!;
    expect(w.title).toBe('Friends cannot reach this hub yet.');
    expect(w.detail).toStartWith('The tunnel is still starting.');
    expect(reachWords(r({ mode: 'custom' }))!.detail).toStartWith('The hub has no outside address yet.');
  });

  test('reached: the host, and a word about quick tunnels', () => {
    expect(reachWords({ ok: true, mode: 'custom', best: { url: 'https://hub.example.com', kind: 'own' } })).toEqual({ ok: true, title: 'Friends reach this hub at hub.example.com.' });
    const quick = reachWords({ ok: true, mode: 'quick', best: { url: 'https://quiet-river-lamp.trycloudflare.com', kind: 'quick' } })!;
    expect(quick.title).toBe('Friends reach this hub at quiet-river-lamp.trycloudflare.com.');
    expect(quick.detail).toContain('new address');
  });

  test('nothing loaded yet', () => {
    expect(reachWords(undefined)).toBeUndefined();
  });
});

describe('friendState', () => {
  test('seen, not seen, a problem reaching them, waiting messages', () => {
    expect(friendState(friend({ lastSeen: NOW - 4 * MIN }), NOW)).toEqual({ word: 'Seen 4m ago', tone: 'dim' });
    expect(friendState(friend(), NOW)).toEqual({ word: 'Not seen yet', tone: 'dim' });
    expect(friendState(friend({ lastSeen: NOW - 2 * DAY, lastError: "Could not reach Alice's hub.", queued: 2 }), NOW)).toEqual({ word: 'Seen 2d ago', tone: 'warn', line: "Could not reach Alice's hub. 2 waiting to go." });
    expect(friendState(friend({ lastError: 'x' }), NOW).word).toBe('Not reached yet');
  });

  test('requests both ways, a new key', () => {
    expect(friendState(friend({ status: 'pending', direction: 'in', createdAt: NOW - 2 * HOUR }), NOW)).toEqual({ word: 'Wants to be friends', tone: 'warn', line: 'Asked 2h ago.' });
    expect(friendState(friend({ status: 'pending', direction: 'out', createdAt: NOW - 2 * HOUR }), NOW).word).toBe('Waiting for them');
    const key = friendState(friend({ status: 'blocked', blockedReason: "Alice's hub answers with a new key." }), NOW);
    expect(key).toEqual({ word: 'New key', tone: 'fault', line: "Alice's hub answers with a new key." });
  });

  test('order: a new key, then requests, then friends by name, then requests out', () => {
    const list = [friend({ id: 'z', name: 'Zoe' }), friend({ id: 'o', name: 'Out', status: 'pending', direction: 'out' }), friend({ id: 'b', name: 'Ben' }), friend({ id: 'k', name: 'Key', status: 'blocked' }), friend({ id: 'r', name: 'Req', status: 'pending', direction: 'in' })];
    expect(friendOrder(list).map((f) => f.id)).toEqual(['k', 'r', 'b', 'z', 'o']);
  });
});

describe('friendInbox', () => {
  test("new notes: one row per friend with its newest, each note after the hub's read mark counts", () => {
    const notes = [note({ id: '1', text: 'First', receivedAt: NOW - 3 * HOUR }), note({ id: '2', text: 'Lunch\non Friday?', receivedAt: NOW - HOUR })];
    const items = friendInbox([friend({ unread: 2, unreadNotes: 2, unreadShares: 0, readAt: NOW - 4 * HOUR })], notes);
    expect(items).toEqual([{ id: 'note:frd_a', kind: 'note', friendId: 'frd_a', name: 'Alice', at: NOW - HOUR, line: 'Lunch on Friday?', count: 2, href: '/settings/friends/frd_a' }]);
    expect(friendWaiting(items)).toBe(2);
  });

  test('notes the mark covers, failed ones and a removed friend do not count', () => {
    const read = friend({ unread: 0, unreadNotes: 0, unreadShares: 0, readAt: NOW - 2 * HOUR });
    const notes = [note({ id: '1', receivedAt: NOW - 3 * HOUR }), note({ id: '3', state: 'failed' }), note({ id: '4', friendId: 'gone' })];
    expect(friendInbox([read], notes)).toEqual([]);
    expect(friendInbox([read], [note({ id: '5', receivedAt: NOW - HOUR })])).toHaveLength(1);
    expect(friendInbox([friend({ status: 'removed', unread: 1, unreadNotes: 1 })], [note()])).toEqual([]);
  });

  test('the mark moved on another device: the same notes stop counting here', () => {
    const notes = [note({ id: '1', receivedAt: NOW - HOUR, read: false })];
    expect(friendInbox([friend({ unread: 1, unreadNotes: 1, readAt: NOW - 2 * HOUR })], notes)).toHaveLength(1);
    // the note's own flag is as old as the list; the friend's mark is current
    expect(friendInbox([friend({ unread: 0, unreadNotes: 0, readAt: NOW })], notes)).toEqual([]);
  });

  test('the hub counts more notes than the app holds', () => {
    const items = friendInbox([friend({ unread: 240, unreadNotes: 240, readAt: NOW - 30 * DAY })], [note({ receivedAt: NOW - HOUR })]);
    expect(items[0].count).toBe(240);
  });

  test('a hub from before read marks: only notes it says are not read', () => {
    expect(friendInbox([friend()], [note({ id: '1', read: false }), note({ id: '2' })])[0].count).toBe(1);
    expect(friendInbox([friend()], [note()])).toEqual([]);
  });

  test('a request and a new key wait too, newest first', () => {
    const list = [friend({ id: 'r', name: 'Chen', status: 'pending', direction: 'in', createdAt: NOW - 2 * HOUR }), friend({ id: 'k', name: 'Eli', status: 'blocked', lastSeen: NOW - 10 * MIN }), friend({ id: 'o', status: 'pending', direction: 'out' })];
    const items = friendInbox(list, []);
    expect(items.map((i) => [i.kind, i.name, i.line])).toEqual([
      ['key', 'Eli', 'Has a new key. Confirm it before anything more moves.'],
      ['request', 'Chen', 'Wants to be friends'],
    ]);
    expect(friendWaiting(items)).toBe(2);
  });

  test('a large note still on its way', () => {
    expect(friendInbox([friend({ unread: 1, unreadNotes: 1 })], [note({ text: undefined, state: 'fetching' })])[0].line).toBe('A note is on its way.');
  });
});

describe('deliveryWords', () => {
  test('each state of a sent note', () => {
    expect(deliveryWords(sent(), 'Alice', NOW)).toEqual({ word: 'Delivered', tone: 'dim' });
    expect(deliveryWords(sent({ via: 'pull' }), 'Alice', NOW).word).toBe("Alice's hub fetched it");
    expect(deliveryWords(sent({ state: 'queued', attempts: 0 }), 'Alice', NOW)).toEqual({ word: 'Sending', tone: 'dim', cancel: true });
    const waiting = deliveryWords(sent({ state: 'queued', attempts: 3, nextTry: NOW + 6 * MIN, lastError: "Could not reach Alice's hub." }), 'Alice', NOW);
    expect(waiting).toEqual({ word: 'Waiting', tone: 'warn', line: "Could not reach Alice's hub. Trying again in 6 min.", cancel: true });
    // a long reason stays on the friend's details
    const long = deliveryWords(sent({ state: 'queued', attempts: 3, nextTry: NOW + 6 * MIN, lastError: `Could not reach Alice's hub. https://${'x'.repeat(40)}.trycloudflare.com did not answer.` }), 'Alice', NOW);
    expect(long.line).toBe("Alice's hub has not taken it yet. Trying again in 6 min.");
    expect(deliveryWords(sent({ state: 'failed', lastError: undefined }), 'Alice', NOW)).toEqual({ word: 'Not delivered', tone: 'fault', line: "Alice's hub could not be reached for 7 days.", retry: true });
    expect(deliveryWords(sent({ state: 'cancelled' }), 'Alice', NOW).word).toBe('Cancelled');
  });
});

describe('where friends live on a phone', () => {
  test("Friends is a row of the sidebar's More menu, before Remote access", () => {
    const rows = MORE_PAGES.map((p) => p.label);
    expect(rows.indexOf('Friends')).toBe(rows.indexOf('Remote access') - 1);
    expect(MORE_PAGES.find((p) => p.label === 'Friends')?.to).toBe('/settings/friends');
  });

  test("the list is a settings page; a friend's notes draw their own bar, like a conversation", () => {
    expect(phonePlace('/settings/friends')).toBe('inner');
    expect(phonePlace('/settings/friends/frd_a')).toBe('conversation');
    expect(phonePlace('/settings/friends/frd_a?x=1')).toBe('conversation');
  });
});
