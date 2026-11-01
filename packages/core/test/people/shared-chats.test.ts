import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { ChatParticipantStore, messageAccount, migrateSharedChats, sharedMessageView } from '../../src/people/shared-chats';
import { PeopleError, PeopleStore } from '../../src/people/store';
import { ACCOUNT_TABLES } from '../../src/people/tables';
import type { Message, Session } from '../../src/types';

let db: ReturnType<typeof openDb>;
let repos: Repos;
let people: PeopleStore;
let store: ChatParticipantStore;
let alice: string;
let bob: string;

function session(id: string, accountId: string, seatFor?: string): Session {
  return {
    id, accountId, kind: 'chat', title: id, agent: 'assistant', model: `${accountId}/model`, mode: 'chat',
    permissionMode: 'default', cwd: '/', device: 'local', status: 'idle', tags: [], pinned: false, archived: false,
    createdAt: 1, updatedAt: 1, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...(seatFor ? { meta: { seat: { chatId: seatFor } }, chat: { memory: false, webSearch: true } } : {}),
  };
}
function seat(accountId = alice, id = 'seat'): Session {
  const s = session(id, accountId, 'chat');
  repos.sessions.insert(s);
  return s;
}
function message(seq: number, patch: Partial<Message> = {}): Message {
  return { id: `m${seq}`, sessionId: 'chat', seq, role: 'user', kind: 'normal', content: [{ type: 'text', text: `message ${seq}` }], createdAt: seq, ...patch };
}
function status(action: () => unknown, code: number): void {
  try {
    action();
    throw new Error('Expected refusal');
  } catch (e) {
    expect(e).toBeInstanceOf(PeopleError);
    expect((e as PeopleError).status).toBe(code);
  }
}
function join(): void {
  store.invite('chat', 'owner', alice);
  store.accept('chat', alice, seat());
}

beforeEach(() => {
  db = openDb(':memory:');
  repos = new Repos(db);
  people = new PeopleStore(db);
  alice = people.create({ name: 'alice', displayName: 'Alice' }).id;
  bob = people.create({ name: 'bob', displayName: 'Bob' }).id;
  repos.sessions.insert(session('chat', 'owner'));
  store = new ChatParticipantStore(db, () => 100);
});
afterEach(() => db.close());

describe('shared-chat migration and attribution', () => {
  test('migration is additive and idempotent; legacy senders and starters remain NULL', () => {
    repos.messages.insert(message(1));
    const turn = repos.turns.start({ sessionId: 'chat' });
    migrateSharedChats(db);
    migrateSharedChats(db);
    expect(repos.messages.get('m1')?.sender).toBeUndefined();
    expect(repos.turns.list({ sessionId: 'chat' }).find((t) => t.id === turn)?.startedBy).toBeUndefined();
    expect(messageAccount(repos.messages.get('m1')!, 'chat-owner')).toBe('chat-owner');
    expect(ACCOUNT_TABLES).toContain('chat_participants');
  });

  test('upgrades a pre-feature schema without changing its rows', () => {
    const old = new Database(':memory:');
    try {
      old.exec(`CREATE TABLE hub_accounts (id TEXT PRIMARY KEY); CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE messages (id TEXT PRIMARY KEY); CREATE TABLE turns (id TEXT PRIMARY KEY);
        INSERT INTO messages VALUES ('old-message'); INSERT INTO turns VALUES ('old-turn');`);
      migrateSharedChats(old);
      migrateSharedChats(old);
      expect(old.query('SELECT * FROM messages').get()).toEqual({ id: 'old-message', sender: null });
      expect(old.query('SELECT * FROM turns').get()).toEqual({ id: 'old-turn', started_by: null });
    } finally { old.close(); }
  });

  test('sender and saved name round-trip through inserts, updates and pages', () => {
    const m = message(1, { sender: `account:${alice}`, author: 'Alice' });
    repos.messages.insert(m);
    people.update(alice, { displayName: 'New name' });
    expect(repos.messages.get(m.id)).toMatchObject({ sender: `account:${alice}`, author: 'Alice' });
    repos.messages.update({ ...m, content: [{ type: 'text', text: 'updated message' }] });
    expect(repos.messages.list('chat')[0]).toMatchObject({ sender: `account:${alice}`, author: 'Alice' });
    expect(repos.messages.tail('chat', 10)[0]?.sender).toBe(`account:${alice}`);
    expect(repos.messages.page('chat', { limit: 10 })[0]?.sender).toBe(`account:${alice}`);
  });

  test('turn starter and usage payer round-trip with their own seat account', () => {
    const s = seat();
    const id = repos.turns.start({ sessionId: s.id, startedBy: alice, model: s.model });
    repos.turns.end(id, { outcome: 'done' });
    expect(repos.usage.insert({ id: 'usage', ts: 1, source: 'chat', provider: 'test', sessionId: s.id, model: s.model, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01, accountId: alice })).toBe(true);
    expect(repos.turns.list({ accountId: alice })[0]).toMatchObject({ id, sessionId: s.id, startedBy: alice });
    expect(repos.turns.list({ accountId: 'owner' })).toEqual([]);
    expect(repos.usage.totals({ accountId: alice })).toMatchObject({ calls: 1, costUsd: 0.01 });
    expect(repos.usage.totals({ accountId: 'owner' })).toMatchObject({ calls: 0, costUsd: 0 });
    expect(db.query('SELECT session_id, account_id FROM usage WHERE id = ?').get('usage')).toEqual({ session_id: s.id, account_id: alice });
  });
});

describe('membership and seats', () => {
  test('new invites default to Participant, joined history, no personal memory', () => {
    repos.messages.insert(message(1));
    expect(store.invite('chat', 'owner', alice)).toMatchObject({ access: 'participant', state: 'invited', history: 'joined', joinedSeq: 2, useMyMemory: false, muted: false, addedBy: 'owner' });
    status(() => store.require('chat', alice), 404);
    expect(store.forAccount(alice)).toHaveLength(1);
    expect(store.forAccount(bob)).toEqual([]);
  });

  test('only the chat owner can invite, change access or remove', () => {
    join();
    status(() => store.invite('chat', alice, bob), 403);
    status(() => store.change('chat', alice, alice, { access: 'viewer' }), 403);
    status(() => store.remove('chat', alice, alice), 403);
    status(() => store.invite('chat', bob, alice), 404);
    status(() => store.list('chat', bob), 404);
    status(() => store.change('missing', 'owner', alice, {}), 404);
  });

  test('only a real non-seat chat may be shared', () => {
    const code = { ...session('code', 'owner'), kind: undefined };
    repos.sessions.insert(code);
    status(() => store.invite('code', 'owner', alice), 404);
    const s = seat('owner');
    status(() => store.invite(s.id, 'owner', alice), 404);
    status(() => store.invite('chat', 'owner', 'missing'), 404);
    status(() => store.invite('chat', 'owner', 'owner'), 400);
  });

  test('phase 1 rejects Collaborator and invalid histories at the store boundary', () => {
    status(() => store.invite('chat', 'owner', alice, { access: 'collaborator' as any }), 400);
    status(() => store.invite('chat', 'owner', alice, { history: 'since-yesterday' as any }), 400);
    join();
    status(() => store.change('chat', 'owner', alice, { access: 'collaborator' as any }), 400);
    status(() => store.change('chat', 'owner', alice, { history: 'nope' as any }), 400);
  });

  test('Accept requires a stored own seat; a forged object cannot borrow the owner or another member', () => {
    store.invite('chat', 'owner', alice);
    status(() => store.accept('chat', alice), 400);
    const wrong = seat('owner');
    status(() => store.accept('chat', alice, { ...wrong, accountId: alice }), 400);
    const other = seat(bob, 'bob-seat');
    status(() => store.accept('chat', alice, other), 400);
    expect(store.get('chat', alice)?.state).toBe('invited');
    const own = seat(alice, 'own-seat');
    expect(store.accept('chat', alice, own)).toMatchObject({ state: 'active', seatId: own.id, useMyMemory: false });
    expect(repos.sessions.get(own.id)?.model).toBe(`${alice}/model`);
    expect(repos.messages.list(own.id)).toEqual([]);
    status(() => store.accept('chat', alice, own), 404);
  });

  test('Accept rejects memory-enabled seats and seats holding transcripts', () => {
    store.invite('chat', 'owner', alice);
    const s = seat();
    repos.sessions.update({ ...s, chat: { memory: true, webSearch: true } });
    status(() => store.accept('chat', alice, s), 400);
    repos.sessions.update(s);
    repos.messages.insert(message(1, { sessionId: s.id }));
    status(() => store.accept('chat', alice, s), 400);
  });

  test('a Viewer can read but cannot post or start turns and has no seat', () => {
    store.invite('chat', 'owner', alice, { access: 'viewer' });
    status(() => store.accept('chat', alice, seat()), 400);
    expect(store.accept('chat', alice)).toMatchObject({ access: 'viewer', state: 'active' });
    expect(store.require('chat', alice)).toBeDefined();
    status(() => store.require('chat', alice, true), 403);
    status(() => store.change('chat', 'owner', alice, { access: 'participant' }), 409);
  });

  test('Decline grants nothing; only the intended recipient answers an invite', () => {
    store.invite('chat', 'owner', alice);
    status(() => store.decline('chat', bob), 404);
    status(() => store.accept('chat', bob), 404);
    store.decline('chat', alice);
    expect(store.forAccount(alice)).toEqual([]);
    status(() => store.require('chat', alice), 404);
    status(() => store.accept('chat', alice, seat()), 404);
  });

  test('joined history is captured at invitation and changes take effect on the next read', () => {
    repos.messages.insert(message(1));
    join();
    repos.messages.insert(message(2));
    const messages = repos.messages.list('chat');
    expect(store.visible('chat', alice, messages).map((m) => m.seq)).toEqual([2]);
    store.change('chat', 'owner', alice, { history: 'all' });
    expect(store.visible('chat', alice, messages).map((m) => m.seq)).toEqual([1, 2]);
    store.change('chat', 'owner', alice, { history: 'joined' });
    expect(store.visible('chat', alice, messages).map((m) => m.seq)).toEqual([2]);
    expect(store.visible('chat', 'owner', messages).map((m) => m.seq)).toEqual([1, 2]);
    expect(store.visible('chat', 'owner', [message(3, { sessionId: 'someone-elses-chat' })])).toEqual([]);
  });

  test('demotion forbids writes immediately and returns the seat the service must stop', () => {
    join();
    const changed = store.change('chat', 'owner', alice, { access: 'viewer' });
    expect(changed.seatId).toBe('seat');
    status(() => store.require('chat', alice, true), 403);
    expect(store.change('chat', 'owner', alice, { access: 'participant' }).access).toBe('participant');
  });

  test.each(['leave', 'remove'] as const)('%s revokes next read and write without deleting messages', (action) => {
    join();
    const m = message(1, { sender: `account:${alice}`, author: 'Alice' });
    repos.messages.insert(m);
    store.preferences('chat', alice, { useMyMemory: true });
    const ended = action === 'leave' ? store.leave('chat', alice) : store.remove('chat', 'owner', alice);
    expect(ended).toMatchObject({ state: action === 'leave' ? 'left' : 'removed', seatId: 'seat', useMyMemory: false });
    status(() => store.require('chat', alice), 404);
    status(() => store.require('chat', alice, true), 404);
    status(() => store.visible('chat', alice, [m]), 404);
    expect(store.forAccount(alice)).toEqual([]);
    expect(repos.messages.get(m.id)).toMatchObject({ author: 'Alice', sender: `account:${alice}` });
  });

  test('only the participant controls their memory, mute and monotonic read mark', () => {
    join();
    repos.messages.insert(message(1));
    expect(store.preferences('chat', alice, { useMyMemory: true, muted: true, readUptoSeq: 1 })).toMatchObject({ useMyMemory: true, muted: true, readUptoSeq: 1 });
    expect(store.preferences('chat', alice, { readUptoSeq: 0 }).readUptoSeq).toBe(1);
    status(() => store.preferences('chat', bob, { useMyMemory: true }), 404);
    status(() => store.preferences('chat', 'owner', { useMyMemory: true }), 400);
    status(() => store.preferences('chat', alice, { readUptoSeq: 2 }), 400);
    status(() => store.preferences('chat', alice, { readUptoSeq: 0.5 }), 400);
    status(() => store.preferences('chat', alice, { muted: 'yes' as any }), 400);
  });

  test('reinviting after removal resets history, seat and preferences', () => {
    join();
    store.preferences('chat', alice, { useMyMemory: true, muted: true });
    store.remove('chat', 'owner', alice);
    repos.messages.insert(message(1));
    const p = store.invite('chat', 'owner', alice);
    expect(p).toMatchObject({ state: 'invited', joinedSeq: 2, history: 'joined', muted: false, useMyMemory: false });
    expect(p.seatId).toBeUndefined();
    status(() => store.require('chat', alice), 404);
  });

  test('removing a hub member keeps their saved name and messages in someone else’s chat', () => {
    join();
    repos.messages.insert(message(1, { sender: `account:${alice}`, author: 'Alice' }));
    people.remove(alice);
    expect(store.get('chat', alice)).toBeUndefined();
    expect(repos.sessions.get('seat')).toBeUndefined();
    expect(repos.messages.get('m1')).toMatchObject({ author: 'Alice', sender: 'account:removed' });
    status(() => store.require('chat', alice), 404);
    expect(repos.sessions.get('chat')).toBeDefined();
  });

  test('deleting the chat cascades membership, while deleting a seat only clears its pointer', () => {
    join();
    repos.sessions.delete('seat');
    expect(store.get('chat', alice)?.seatId).toBeUndefined();
    repos.sessions.delete('chat');
    expect(store.get('chat', alice)).toBeUndefined();
  });
});

describe('tool output is private to its starter', () => {
  const full = () => message(1, {
    sender: 'account:starter', author: 'Saved name', role: 'assistant', model: 'provider/model',
    content: [
      { type: 'text', text: 'Public reply' },
      { type: 'text', text: '<system-reminder>private memory</system-reminder>' },
      { type: 'thinking', thinking: 'private reasoning', signature: 'private signature' },
      { type: 'tool_use', id: 'call', name: 'WebFetch', input: { url: 'private-url' } },
      { type: 'tool_result', toolUseId: 'call', content: 'private tool output' },
    ],
    meta: { recalled: ['private-memory-id'], debug: 'private data' },
  });

  test('the starter keeps their complete original message', () => {
    const m = full();
    expect(sharedMessageView(m, 'starter', 'owner')).toBe(m);
  });

  test.each(['owner', 'other-member'])('%s sees only text and one-line tool summaries', (caller) => {
    const m = sharedMessageView(full(), caller, 'owner');
    expect(m.content).toEqual([
      { type: 'text', text: 'Public reply' },
      { type: 'text', text: '[Called WebFetch]' },
      { type: 'text', text: '[Tool completed]' },
    ]);
    expect(m.meta).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('private');
    expect(m).toMatchObject({ author: 'Saved name', sender: 'account:starter', model: 'provider/model' });
  });

  test('legacy NULL senders do not become the current reader', () => {
    const m = full();
    delete m.sender;
    expect(sharedMessageView(m, 'owner', 'owner')).toBe(m);
    expect(JSON.stringify(sharedMessageView(m, alice, 'owner'))).not.toContain('private');
    expect(messageAccount({ sender: 'friend:remote' }, 'owner')).toBeUndefined();
  });

  test('another seat’s summary cannot carry hidden history or compact a reader’s context', () => {
    const m = sharedMessageView(message(10, { sender: 'account:other', kind: 'summary', content: [{ type: 'text', text: 'Earlier private history' }], meta: { coversThroughSeq: 9 } }), alice, 'owner');
    expect(m.kind).toBe('notice');
    expect(m.content).toEqual([]);
    expect(m.meta).toBeUndefined();
  });
});
