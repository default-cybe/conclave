/**
 * Shares with friends in the app (src/lib/shares.ts, src/lib/friendInbox.ts):
 * the card words both sides see, a share's state, the review sheet's state
 * (defaults, what the hub is asked, keep anyway, the found values), where a
 * share can stop, a shared conversation as quoted turns, a friend's thread
 * with notes and shares, the Inbox counts with share cards, the read marks
 * to send, and where a share sits on a phone.
 *
 *   bun test packages/web/test/shares.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { BundleMessage, FriendDto, InboxItemDto, OutboxItemDto, ReceivedShareDto, RedactionItem, RedactReport, SentShareDto } from '@conclave/core/client';
import type { Message } from '@conclave/core/types';
import { friendInbox, friendWaiting } from '../src/lib/friendInbox';
import {
  branchHint,
  codeWords,
  describeShare,
  friendThread,
  goesAs,
  maskValue,
  namesWords,
  planSentence,
  quotedUnits,
  rangeStops,
  rangeWords,
  readTargets,
  receivedWords,
  recipientWords,
  reportSentence,
  reportWords,
  reviewKey,
  reviewOptions,
  reviewStart,
  ruleWord,
  sendLabel,
  shareLine,
  shareTargets,
  shareWaiting,
  sizeWords,
  summaryText,
  timesWords,
  toggleKeep,
  unreadShare,
} from '../src/lib/shares';
import { phonePlace, phoneTitle } from '../src/components/PhoneFrame';
import { friendShareWords } from '../src/features/friends/FriendShareLine';

const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function friend(p: Partial<FriendDto> = {}): FriendDto {
  return {
    id: 'frd_a',
    name: 'Alice',
    fingerprint: '3f9a12c08e4107b2d55e6a1c9b0f4e21',
    status: 'active',
    direction: 'out',
    verified: true,
    safetyCode: '18342 90311 55120 07718',
    grants: { receiveShares: true },
    addresses: [],
    createdAt: NOW - 30 * DAY,
    queued: 0,
    unread: 0,
    unreadNotes: 0,
    unreadShares: 0,
    ...p,
  };
}

function received(p: Partial<ReceivedShareDto> = {}): ReceivedShareDto {
  return {
    id: 'shr_1',
    shareId: '01JA00000000000000000SHARE',
    friendId: 'frd_a',
    friendName: 'Alice',
    fingerprint: '3f9a12c08e4107b2d55e6a1c9b0f4e21',
    kind: 'session',
    title: 'Fix flaky auth test',
    revision: 1,
    updateWaiting: false,
    summary: { messages: 42, sessions: 1, code: { kind: 'diff', files: 12 }, bytes: 48_000 },
    line: "Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files)",
    state: 'offered',
    receivedAt: NOW - 20 * MIN,
    expiresAt: NOW - 20 * MIN + 30 * DAY,
    sessions: [],
    read: false,
    ...p,
  };
}

function sent(p: Partial<SentShareDto> = {}): SentShareDto {
  return {
    id: '01JA00000000000000000SENT01',
    sessionId: 'ses_1',
    kind: 'session',
    title: 'Fix login redirect',
    revision: 1,
    state: 'active',
    options: {},
    summary: { messages: 9, sessions: 1, code: { kind: 'diff', files: 1 }, bytes: 21_000 },
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 4 * HOUR,
    recipients: [{ friendId: 'frd_a', friendName: 'Alice', state: 'accepted', revision: 1, acceptedRevision: 1, acceptedAt: NOW - 4 * HOUR }],
    ...p,
  };
}

function note(p: Partial<InboxItemDto> = {}): InboxItemDto {
  return { id: '01JA0000000000000000000001', friendId: 'frd_a', friendName: 'Alice', type: 'note', state: 'received', text: 'Lunch on Friday?', receivedAt: NOW - HOUR, ...p };
}

function out(p: Partial<OutboxItemDto> = {}): OutboxItemDto {
  return { id: '01JA0000000000000000000002', friendId: 'frd_a', type: 'note', state: 'delivered', attempts: 1, createdAt: NOW - 30 * MIN, preview: 'note: Yes, 12:30.', ...p };
}

const report = (p: Partial<RedactReport> = {}): RedactReport => ({ reminders: 0, recalled: 0, thinking: 0, signatures: 0, redactedThinking: 0, secrets: 0, paths: 0, privateIps: 0, emails: 0, hostnames: 0, toolOutputs: 0, attachments: 0, ...p });

const item = (p: Partial<RedactionItem> = {}): RedactionItem => ({ id: 'a1', rule: 'secret', original: 'ghp_Zz9Yy8Xx7Ww6Vv5Uu4', replacement: '[REDACTED:secret]', count: 3, messageIds: ['m1'], kept: false, ...p });

describe('the card', () => {
  test('the Inbox line, as the hub writes it', () => {
    expect(describeShare('session', received().summary)).toBe('(session, 42 messages, diff 12 files)');
    expect(describeShare('chat', { messages: 1, sessions: 1, bytes: 10 })).toBe('(chat, 1 message)');
    expect(describeShare('session', { messages: 3, sessions: 1, code: { kind: 'git-bundle', files: 1 }, bytes: 10 })).toBe('(session, 3 messages, git bundle 1 file)');
    expect(summaryText('session', received().summary)).toBe('Session, 42 messages, diff 12 files');
  });

  test("the hub's line, else one made the same way", () => {
    expect(shareLine(received())).toBe("Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files)");
    expect(shareLine(received({ line: '' }))).toBe("Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files)");
  });

  test('each state of a share from a friend', () => {
    expect(receivedWords(received(), NOW)).toEqual({ word: 'Waiting for you', tone: 'warn', line: 'Nothing is fetched until you accept. It expires on 19 Nov.' });
    expect(receivedWords(received({ expiresAt: NOW + DAY + HOUR }), NOW).line).toBe('Nothing is fetched until you accept. It expires tomorrow.');
    expect(receivedWords(received({ state: 'accepted' }), NOW)).toEqual({ word: 'Accepted', tone: 'ok' });
    expect(receivedWords(received({ state: 'accepted', revision: 2, acceptedRevision: 1, updateWaiting: true }), NOW).word).toBe('Revision 2 waits');
    expect(receivedWords(received({ state: 'revoked' }), NOW).line).toBe("Alice unsent it. Their hub asked yours to delete its copy, and it did. Forks and handoffs you made stay yours.");
    expect(receivedWords(received({ state: 'expired' }), NOW)).toEqual({ word: 'Expired', tone: 'dim', line: 'It was not accepted in 30 days. Ask Alice to send it again.' });
    expect(receivedWords(received({ state: 'declined' }), NOW).line).toBe("Alice's hub is not told. You can still accept it.");
    expect(receivedWords(received({ error: 'Could not reach their hub.' }), NOW).line).toContain('Could not reach their hub.');
  });

  test('how each friend has a share you sent; unsent says "asked to delete"', () => {
    const s = sent();
    expect(recipientWords(s.recipients[0], s)).toEqual({ word: 'Accepted', tone: 'ok' });
    expect(recipientWords({ ...s.recipients[0], acceptedRevision: 1 }, { ...s, revision: 2 })).toEqual({ word: 'Accepted revision 1', tone: 'ok', line: 'Revision 2 waits for Alice.' });
    expect(recipientWords({ ...s.recipients[0], state: 'delivered' }, s).line).toBe('Waiting for Alice to accept.');
    expect(recipientWords({ ...s.recipients[0], state: 'sent' }, s)).toEqual({ word: 'Sending', tone: 'dim' });
    expect(recipientWords({ ...s.recipients[0], state: 'sent', lastError: 'Their hub did not answer.' }, s)).toEqual({ word: 'Not delivered yet', tone: 'warn', line: 'Their hub did not answer.' });
    expect(recipientWords({ ...s.recipients[0], state: 'failed' }, s).tone).toBe('fault');
    expect(recipientWords(s.recipients[0], { ...s, state: 'revoked' })).toEqual({ word: 'Unsent', tone: 'dim', line: "Alice's hub is asked to delete its copy." });
  });

  test('what waits for the owner, and what counts', () => {
    expect(shareWaiting(received())).toBe(true);
    expect(shareWaiting(received({ state: 'accepted' }))).toBe(false);
    expect(shareWaiting(received({ state: 'accepted', updateWaiting: true }))).toBe(true);
    expect(unreadShare(received())).toBe(true);
    expect(unreadShare(received({ read: true }))).toBe(false);
    expect(unreadShare(received({ state: 'revoked' }))).toBe(false);
  });
});

describe('the review sheet', () => {
  test("the hub's defaults: a session's diff, no code for a chat, full tool output, attachments, no thinking", () => {
    expect(reviewStart('session')).toEqual({ toolOutput: 'full', attachments: true, thinking: false, code: 'diff', keep: [] });
    expect(reviewStart('chat').code).toBe('none');
    // an update starts from what was sent
    expect(reviewStart('session', { code: 'git-bundle', toolOutput: 'summary', keep: ['b', 'a'], upTo: 'm9' })).toEqual({ upTo: 'm9', toolOutput: 'summary', attachments: true, thinking: false, code: 'git-bundle', keep: ['b', 'a'] });
  });

  test('what the hub is asked: every choice said, the keep list sorted', () => {
    expect(reviewOptions(reviewStart('session'))).toEqual({ toolOutput: 'full', attachments: true, thinking: false, code: 'diff' });
    expect(reviewOptions({ ...reviewStart('session'), upTo: 'm4', keep: ['b', 'a'] })).toEqual({ toolOutput: 'full', attachments: true, thinking: false, code: 'diff', upTo: 'm4', keep: ['a', 'b'] });
  });

  test('the review asks again when a choice changes, in any order of keeps', () => {
    const a = reviewStart('session');
    expect(reviewKey(a)).toBe(reviewKey({ ...a }));
    expect(reviewKey({ ...a, keep: ['x', 'y'] })).toBe(reviewKey({ ...a, keep: ['y', 'x'] }));
    expect(reviewKey({ ...a, toolOutput: 'none' })).not.toBe(reviewKey(a));
    expect(reviewKey({ ...a, code: 'none' })).not.toBe(reviewKey(a));
  });

  test('keep anyway, and take out again', () => {
    const a = toggleKeep(reviewStart('session'), 'a1');
    expect(a.keep).toEqual(['a1']);
    expect(toggleKeep(a, 'a1').keep).toEqual([]);
  });

  test('a found value: the rule, how often, hidden until Show, what goes in its place', () => {
    expect(ruleWord('privateIp')).toBe('Private address');
    expect(ruleWord('hostname')).toBe('Device name');
    expect(timesWords(1)).toBe('Found once');
    expect(timesWords(2)).toBe('Found twice');
    expect(timesWords(3)).toBe('Found 3 times');
    expect(maskValue('ghp_Zz9Yy8Xx7Ww6Vv5Uu4')).toBe('ghp_•••u4');
    expect(maskValue('abc')).toBe('••••');
    expect(goesAs(item())).toBe('Goes as [REDACTED:secret]');
    expect(goesAs(item({ replacement: '' }))).toBe('Taken out');
    expect(goesAs(item({ kept: true }))).toBe('Goes as it is');
  });

  test('what the sanitizer took out, the ones the owner can keep first', () => {
    const r = report({ reminders: 2, secrets: 1, paths: 3, recalled: 1 });
    expect(reportWords(r)).toEqual(['1 secret', '3 paths', '2 system reminders', '1 recalled memory']);
    expect(reportSentence(r)).toBe('Taken out: 1 secret, 3 paths, 2 system reminders and 1 recalled memory.');
    expect(reportSentence(report())).toBe('Nothing taken out.');
    expect(reportWords(report({ privateIps: 2 }))).toEqual(['2 private addresses']);
  });

  test('size, range and who it goes to', () => {
    expect(sizeWords(200)).toBe('About 1 KB');
    expect(sizeWords(48 * 1024)).toBe('About 48 KB');
    expect(sizeWords(3.4 * 1024 * 1024)).toBe('About 3.4 MB');
    expect(rangeWords({ messages: 42, total: 42 })).toBe('All 42 messages');
    expect(rangeWords({ messages: 12, total: 42 })).toBe('12 of 42 messages');
    expect(sendLabel(['Alice'])).toBe('Send to Alice');
    expect(sendLabel(['Alice', 'Ben'])).toBe('Send to Alice and Ben');
    expect(sendLabel(['Alice', 'Ben', 'Chen'])).toBe('Send to 3 friends');
    expect(namesWords(['Alice', 'Ben', 'Chen'])).toBe('Alice, Ben and Chen');
  });

  test('only friends who are friends now, by name', () => {
    const list = [friend({ id: 'z', name: 'Zoe' }), friend({ id: 'p', name: 'Pending', status: 'pending' }), friend({ id: 'b', name: 'Ben' }), friend({ id: 'k', name: 'Key', status: 'blocked' })];
    expect(shareTargets(list).map((f) => f.id)).toEqual(['b', 'z']);
  });

  test('where a share can stop: after each turn but the last', () => {
    const m = (id: string, role: 'user' | 'assistant', text: string, kind: Message['kind'] = 'normal'): Pick<Message, 'id' | 'role' | 'kind' | 'content'> => ({ id, role, kind, content: text ? [{ type: 'text', text }] : [{ type: 'tool_result', toolUseId: 't', content: 'ok' }] });
    const msgs = [
      m('1', 'user', 'Fix the redirect.'),
      m('2', 'assistant', 'Reading it.'),
      m('3', 'user', ''),
      m('4', 'assistant', 'Fixed.'),
      m('5', 'user', '<system-reminder>hook said hi</system-reminder>'),
      m('6', 'user', 'Now run   the tests.'),
      m('7', 'assistant', '3 pass.'),
    ];
    expect(rangeStops(msgs)).toEqual([{ id: '5', label: 'Fix the redirect.', count: 5 }]);
    expect(rangeStops(msgs.slice(0, 4))).toEqual([]);
  });
});

describe('a shared conversation, quoted', () => {
  const msg = (role: 'user' | 'assistant', content: BundleMessage['content'], n: number, model?: string): BundleMessage => ({ role, kind: 'normal', content, createdAt: NOW + n, ...(model ? { model } : {}), meta: { external: { id: `m${n}` } } });

  test("the friend's asks, then each reply with its tool calls after its words; results only count failures", () => {
    const units = quotedUnits([
      msg('user', [{ type: 'text', text: 'Fix the flaky test.' }], 1),
      msg('assistant', [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/auth.ts' } }], 2, 'anthropic/claude-sonnet-5-5'),
      msg('user', [{ type: 'tool_result', toolUseId: 't1', content: 'x' }], 3),
      msg('assistant', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'bun test' } }], 4),
      msg('user', [{ type: 'tool_result', toolUseId: 't2', content: 'fail', isError: true }], 5),
      msg('assistant', [{ type: 'text', text: 'Fixed.' }], 6),
      msg('user', [{ type: 'image', mediaType: 'image/png', data: '' }], 7),
    ]);
    expect(units.map((u) => [u.kind, u.text, u.kind === 'assistant' ? u.calls.map((c) => c.name).join(',') : '', u.kind === 'assistant' ? u.first : u.attachments])).toEqual([
      ['user', 'Fix the flaky test.', '', 0],
      ['assistant', 'Reading it.', 'Read', true],
      ['assistant', '', 'Bash', false],
      ['assistant', 'Fixed.', '', false],
      ['user', '', '', 1],
    ]);
    expect(units[2].kind === 'assistant' && units[2].failed).toBe(1);
    expect(units[1].kind === 'assistant' && units[1].model).toBe('anthropic/claude-sonnet-5-5');
    expect(units[1].key).toBe('m2');
  });

  test('empty assistant messages leave nothing', () => {
    expect(quotedUnits([msg('assistant', [{ type: 'thinking', thinking: 'hmm' }], 1)])).toEqual([]);
  });
});

describe('code', () => {
  test('in words, and the plan as a sentence', () => {
    expect(codeWords({ kind: 'diff', files: ['a', 'b', 'c'] })).toBe('Diff of 3 files');
    expect(codeWords({ kind: 'git-bundle', files: 1, branch: 'fix/login' })).toBe('Git bundle of fix/login, 1 file');
    expect(planSentence({ kind: 'diff', files: ['a', 'b'], branch: 'from-alice/fix-flaky-auth-test', root: '/home/bob/app', deviceName: 'MacBook' })).toBe('The diff of 2 files goes onto a new branch from-alice/fix-flaky-auth-test in /home/bob/app on MacBook.');
    expect(planSentence({ kind: 'git-bundle', files: ['a'], branch: 'from-ben/x', root: '/r', deviceName: 'hub', base: '0123456789abcdef' })).toBe('The git bundle of 1 file goes onto a new branch from-ben/x in /r on hub, from 0123456789.');
  });

  test('the branch the hub names', () => {
    expect(branchHint('Alice', 'Fix flaky auth test')).toBe('from-alice/fix-flaky-auth-test');
    expect(branchHint('Zoë Ålund', 'Café: ünïcode!')).toBe('from-zoe-alund/cafe-unicode');
    expect(branchHint('A', '???')).toBe('from-a/share');
  });
});

describe("a friend's thread", () => {
  test('notes and shares both ways, oldest first, the whole text of a sent note', () => {
    const t = friendThread(
      'frd_a',
      [note({ id: 'n1', receivedAt: NOW - 3 * HOUR }), note({ id: 'other', friendId: 'frd_b' })],
      [out({ id: 'o1', createdAt: NOW - 2 * HOUR, preview: 'note: The start…', text: 'The start of a long note and its end.' }), out({ id: 'o2', createdAt: NOW - 80 * MIN, preview: 'note: Short.' })],
      [received({ id: 's1', receivedAt: NOW - 20 * MIN }), received({ id: 's2', friendId: 'frd_b' })],
      [sent({ createdAt: NOW - 100 * MIN }), sent({ id: 'not-hers', recipients: [{ friendId: 'frd_b', friendName: 'Ben', state: 'sent', revision: 1 }] })],
      NOW,
    );
    expect(t.map((e) => [e.kind, e.id, 'text' in e ? e.text : '', e.stamp])).toEqual([
      ['in', 'n1', 'Lunch on Friday?', 'Today 12:00'],
      ['out', 'o1', 'The start of a long note and its end.', 'Today 13:00'],
      ['share-out', '01JA00000000000000000SENT01', '', undefined],
      ['out', 'o2', 'Short.', undefined],
      ['share-in', 's1', '', 'Today 14:40'],
    ]);
  });
});

describe('the Inbox and its counts with share cards', () => {
  test('a share card not seen yet: its own row with the share, counting one', () => {
    const items = friendInbox([friend({ unread: 1, unreadShares: 1 })], [], [received()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'share:shr_1', kind: 'share', name: 'Alice', line: "Sent 'Fix flaky auth test'", count: 1, href: '/shares/shr_1' });
    expect(items[0].share?.id).toBe('shr_1');
    expect(friendWaiting(items)).toBe(1);
  });

  test('a new revision of one accepted counts; one seen, accepted, unsent or from a removed friend does not', () => {
    const rev = received({ id: 'r', state: 'accepted', revision: 2, acceptedRevision: 1, updateWaiting: true });
    expect(friendInbox([friend()], [], [rev])[0].line).toBe("Sent revision 2 of 'Fix flaky auth test'");
    expect(friendInbox([friend()], [], [received({ read: true }), received({ id: 'b', state: 'accepted' }), received({ id: 'c', state: 'revoked' })])).toEqual([]);
    expect(friendInbox([friend({ status: 'removed' })], [], [received()])).toEqual([]);
    expect(friendInbox([], [], [received()])).toEqual([]);
  });

  test('notes and shares together, newest first, each counting', () => {
    const items = friendInbox([friend({ unread: 3, unreadNotes: 2, unreadShares: 1, readAt: NOW - 5 * HOUR })], [note({ id: '1', receivedAt: NOW - 3 * HOUR }), note({ id: '2', receivedAt: NOW - HOUR })], [received()]);
    expect(items.map((i) => [i.kind, i.count])).toEqual([
      ['share', 1],
      ['note', 2],
    ]);
    expect(friendWaiting(items)).toBe(3);
  });
});

describe('read marks', () => {
  test("what a friend's page tells the hub it showed: the newest unread note and each unread share card", () => {
    const f = friend({ unread: 3, unreadNotes: 2, unreadShares: 1, readAt: NOW - 5 * HOUR });
    const notes = [note({ id: 'old', receivedAt: NOW - 6 * HOUR }), note({ id: 'n1', receivedAt: NOW - 3 * HOUR }), note({ id: 'n2', receivedAt: NOW - HOUR }), note({ id: 'b', friendId: 'frd_b' })];
    expect(readTargets(f, notes, [received(), received({ id: 'seen', read: true }), received({ id: 'other', friendId: 'frd_b' })])).toEqual(['n2', 'shr_1']);
  });

  test('nothing when all is read', () => {
    expect(readTargets(friend({ unread: 0 }), [note()], [received()])).toEqual([]);
    expect(readTargets(friend({ unread: 1, unreadNotes: 1, readAt: NOW }), [note()], [])).toEqual([]);
  });
});

describe('where shares live on a phone', () => {
  test('a share draws its own bar like a conversation; the list is a page under Friends', () => {
    expect(phonePlace('/shares/shr_1')).toBe('conversation');
    expect(phonePlace('/shares')).toBe('inner');
    expect(phoneTitle('/shares')).toEqual({ title: 'Shares', back: '/settings/friends' });
  });
});

describe('a session made from a share', () => {
  test('the line under it says whose turns are quoted, and that the first turn asks', () => {
    expect(friendShareWords({ name: 'Alice', role: 'fork', guard: true, importedThrough: 8 })).toBe("A fork of Alice's share: the first 8 messages are quoted from Alice's hub. Its first turn asks before any tool runs, until you write a message of your own.");
    expect(friendShareWords({ name: 'Alice', role: 'fork', guard: false, importedThrough: 1 })).toBe("A fork of Alice's share: the first message is quoted from Alice's hub.");
    expect(friendShareWords({ name: 'Ben', role: 'handoff', guard: true })).toBe("A handoff from Ben's hub: its brief quotes Ben. Its first turn asks before any tool runs, until you write a message of your own.");
    expect(friendShareWords({ name: 'Ben', role: 'reference' })).toBe("A reference from Ben's hub: read only, quoted data. Your agents find it in past chats.");
  });
});
