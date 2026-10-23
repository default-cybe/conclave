/**
 * Messages sent while a session works (src/store/queue.ts, store.ts,
 * docs/design/CHAT-AND-MOTION.md 2.11): yours shows at once, the hub's list
 * takes it over, the stored message takes its place in the same update (so
 * the bubble is never there twice, or gone for a moment), Remove takes it
 * off, and a load never lays an older list over a newer one.
 *
 *   cd packages/web && bun test test/session-queue.test.ts
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { EngineEvent, Message, QueuedMessage } from '@conclave/core/types';
import { ApiError, type SendInput } from '@conclave/core/client';
import { api, connectClient } from '../src/lib/api';
import { afterHubList, newPendingId, pendingIdsOf, replacesPending, shownQueue, withoutIds } from '../src/store/queue';
import { applyEvent, loadMessages, removeQueued, sendQueued, stopLive, useHub } from '../src/store/store';
import { pendingWord } from '../src/features/chat/Pending';

let seq = 0;
const send = (e: EngineEvent) => applyEvent({ ...e, seq: ++seq, ts: 1000 + seq } as Parameters<typeof applyEvent>[0]);
const q = (id: string, text = id, whenBusy: QueuedMessage['whenBusy'] = 'queue'): QueuedMessage => ({ id, text, at: 1, whenBusy });
const user = (id: string, s: number, meta?: Record<string, unknown>): Message => ({ id, sessionId: 's1', seq: s, role: 'user', kind: 'normal', content: [{ type: 'text', text: id }], createdAt: 1, ...(meta ? { meta } : {}) });
/** What a session shows as waiting, ids only. */
const shown = (id = 's1') => shownQueue(useHub.getState().queues[id], useHub.getState().sending[id]).map((x) => x.id);

beforeEach(() => stopLive());

describe('the rules', () => {
  test("the hub's list in its order, then what this app sent that it does not list yet", () => {
    expect(shownQueue([q('a'), q('b')], [{ ...q('b') }, { ...q('c') }]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(shownQueue(undefined, undefined)).toEqual([]);
    // nothing of this app's own: the hub's array as it is, so views skip the redraw
    const hub = [q('a')];
    expect(shownQueue(hub, [])).toBe(hub);
  });

  test('a list from an event keeps a send still on its way; a load asked after the send was answered is the whole truth', () => {
    const sending = [{ ...q('mine') }, { ...q('done'), confirmedAt: 100 }];
    expect(afterHubList(sending, [q('other')])!.map((x) => x.id)).toEqual(['mine', 'done']);
    expect(afterHubList(sending, [q('mine')])!.map((x) => x.id)).toEqual(['done']);
    // a load asked after the hub answered "done": it ran or was dropped
    expect(afterHubList(sending, [], 200)!.map((x) => x.id)).toEqual(['mine']);
    // a load asked before that answer still keeps it
    expect(afterHubList(sending, [], 50)!.map((x) => x.id)).toEqual(['mine', 'done']);
  });

  test('a message names the waiting ones it took the place of', () => {
    expect(pendingIdsOf(user('u', 1, { pendingIds: ['a', 2, 'b'] }))).toEqual(['a', 'b']);
    expect(pendingIdsOf({ role: 'assistant', meta: { pendingIds: ['a'] } })).toEqual([]);
    expect(replacesPending(user('u', 1))).toBe(false);
    expect(replacesPending(user('u', 1, { pendingIds: ['a'] }))).toBe(true);
  });

  test('withoutIds keeps the same array when nothing goes', () => {
    const list = [q('a')];
    expect(withoutIds(list, ['x'])).toBe(list);
    expect(withoutIds(list, ['a'])).toEqual([]);
  });

  test('an id the hub keeps (6 to 64 letters, digits, _ or -), new each time', () => {
    const a = newPendingId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect(newPendingId()).not.toBe(a);
  });

  test('the words: Queued, or Sending to the running turn', () => {
    expect(pendingWord({ whenBusy: 'queue' })).toBe('Queued');
    expect(pendingWord({ whenBusy: 'steer' })).toBe('Sending to the running turn');
  });
});

describe('the store', () => {
  test('session.queue sets the list; the stored message takes its place in one update', () => {
    send({ type: 'session.queue', sessionId: 's1', queue: [q('a'), q('b')] });
    expect(shown()).toEqual(['a', 'b']);
    // every state the store passes through has the message or the bubble, never both, never neither
    const states: Array<{ bubble: boolean; message: boolean }> = [];
    const off = useHub.subscribe((s) => states.push({ bubble: shownQueue(s.queues.s1, s.sending.s1).some((x) => x.id === 'a'), message: !!s.messages.s1?.some((m) => m.id === 'u-a') }));
    send({ type: 'message.created', message: user('u-a', 3, { pendingIds: ['a'], whenBusy: 'queue' }) });
    send({ type: 'session.queue', sessionId: 's1', queue: [q('b')] });
    off();
    expect(states.every((x) => x.bubble !== x.message)).toBe(true);
    expect(shown()).toEqual(['b']);
  });

  test('a message without pendingIds leaves the list alone', () => {
    send({ type: 'session.queue', sessionId: 's1', queue: [q('a')] });
    const before = useHub.getState().queues;
    send({ type: 'message.created', message: user('u1', 1) });
    expect(useHub.getState().queues).toBe(before);
  });

  test('a deleted session takes its list with it', () => {
    send({ type: 'session.queue', sessionId: 's1', queue: [q('a')] });
    send({ type: 'session.deleted', sessionId: 's1' });
    expect(useHub.getState().queues.s1).toBeUndefined();
  });

  test('yours shows the moment you send, keeps its place when the hub lists it, and leaves on a refusal', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    let answer: (r: { queued: boolean; pendingId?: string }) => void = () => {};
    let asked: SendInput | undefined;
    Object.assign(api(), {
      send: (_id: string, input: SendInput) => {
        asked = input;
        return new Promise((r) => (answer = r));
      },
    });
    const sent = sendQueued('s1', { text: 'next', whenBusy: 'queue' });
    // shown before the hub answers, under the id the send carries
    expect(shown()).toEqual([asked!.pendingId!]);
    expect(useHub.getState().sending.s1[0]).toMatchObject({ text: 'next', whenBusy: 'queue' });
    // the hub's event comes first: the hub's list has it now, in the same place
    send({ type: 'session.queue', sessionId: 's1', queue: [q(asked!.pendingId!, 'next')] });
    expect(shown()).toEqual([asked!.pendingId!]);
    expect(useHub.getState().sending.s1).toEqual([]);
    answer({ queued: true, pendingId: asked!.pendingId });
    await sent;
    expect(shown()).toEqual([asked!.pendingId!]);

    // the session was free after all: it ran at once, and the bubble goes
    const first = asked!.pendingId!;
    const again = sendQueued('s1', { text: 'now', whenBusy: 'queue' });
    expect(shown()).toEqual([first, asked!.pendingId!]);
    answer({ queued: false });
    await again;
    expect(shown()).toEqual([first]);

    // refused: it goes, and the toast says why
    Object.assign(api(), { send: async () => Promise.reject(new ApiError(500, 'The hub is busy.')) });
    const r = await sendQueued('s1', { text: 'no', whenBusy: 'steer' });
    expect(r).toBeUndefined();
    expect(shown()).toHaveLength(1);
    expect(useHub.getState().toasts.at(-1)?.title).toBe('The hub is busy.');
  });

  test('Remove takes it off at once; it comes back only when the hub refuses for another reason', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    send({ type: 'session.queue', sessionId: 's1', queue: [q('a'), q('b')] });
    let fail: Error | undefined;
    Object.assign(api(), { unqueue: async () => (fail ? Promise.reject(fail) : { ok: true }) });
    await removeQueued('s1', 'a');
    expect(shown()).toEqual(['b']);
    // its turn started meanwhile (409) or it is gone (404): it stays off
    fail = new ApiError(409, 'That message has started.');
    await removeQueued('s1', 'b');
    expect(shown()).toEqual([]);
    send({ type: 'session.queue', sessionId: 's1', queue: [q('c')] });
    fail = new ApiError(500, 'Could not reach the hub.');
    await removeQueued('s1', 'c');
    expect(shown()).toEqual(['c']);
    expect(useHub.getState().toasts.at(-1)?.title).toBe('Could not reach the hub.');
  });

  test('a transcript load brings the list, without one already in the transcript, and never over a newer event', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    Object.assign(api(), {
      messages: async () => [user('u-a', 1, { pendingIds: ['a'] })],
      todos: async () => [],
      queue: async () => [q('a'), q('b')],
    });
    await loadMessages('s1');
    expect(shown()).toEqual(['b']);

    let answer: (l: QueuedMessage[]) => void = () => {};
    Object.assign(api(), { messages: async () => [], queue: () => new Promise<QueuedMessage[]>((r) => (answer = r)) });
    const loading = loadMessages('s1', true);
    send({ type: 'session.queue', sessionId: 's1', queue: [q('c')] });
    answer([q('b')]);
    await loading;
    expect(shown()).toEqual(['c']);
  });

  test('a hub from before the queue (404) leaves the list as it is', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    Object.assign(api(), { messages: async () => [], todos: async () => [], queue: async () => Promise.reject(new ApiError(404, 'Not found')) });
    await loadMessages('s1');
    expect(useHub.getState().messagesLoaded.s1).toBe(true);
    expect(shown()).toEqual([]);
  });
});
