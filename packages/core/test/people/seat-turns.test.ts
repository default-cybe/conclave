/**
 * Seat turns (docs/design/SHARED-WITH-MEMBERS.md 6, "Turns"): a participant's
 * message starts a turn in their own seat session, on their own account. A
 * scripted provider with per-account keys proves it: whose key served the
 * call, what the request held, who the usage row bills, and that the chat's
 * one FIFO queue runs one turn at a time, in order, under the stop rules.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, until, type TestEngine } from '../engine/harness';
import { ChatParticipantStore } from '../../src/people/shared-chats';
import { OWNER_ID } from '../../src/people/context';
import { PeopleError } from '../../src/people/store';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const MEMORY = { memory: { enabled: true, autoExtract: false, autoInject: true, injectLimit: 5 } };
const userTexts = (engine: TestEngine['engine'], id: string) =>
  engine
    .getMessages(id)
    .filter((m) => m.role === 'user' && m.kind === 'normal')
    .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));

/** Invite, seat and accept, as the route does (routes-shared-chats.ts). */
async function join(engine: TestEngine['engine'], chatId: string, name: string): Promise<{ id: string; seatId: string }> {
  const acct = engine.people.create({ name, displayName: name });
  // their own key: the hub's key never serves their calls (people/access.ts source)
  engine.accountSecrets.set(acct.id, 'providers', 'mock', `sk-${name}-own-key`);
  const store = new ChatParticipantStore(engine.repos.db);
  store.invite(chatId, OWNER_ID, acct.id, {});
  const seat = await engine.createSession({ kind: 'chat', title: 'Trip plan', chat: { memory: false } }, acct.id, { byPerson: true });
  engine.repos.sessions.update({ ...seat, meta: { ...seat.meta, seat: { chatId } } });
  store.accept(chatId, acct.id, engine.requireSession(seat.id));
  return { id: acct.id, seatId: seat.id };
}

const turnsOf = (engine: TestEngine['engine'], sessionId: string) =>
  engine.repos.db.query('SELECT started_by FROM turns WHERE session_id = ?').all(sessionId) as Array<{ started_by: string | null }>;
const usageOf = (engine: TestEngine['engine'], sessionId: string) =>
  engine.repos.db.query('SELECT account_id FROM usage WHERE session_id = ?').all(sessionId) as Array<{ account_id: string }>;

describe(`a seat turn runs on its starter's account`, () => {
  test('their key serves the call, their seat is billed, and the request holds only what they may see', async () => {
    t = await startTestEngine({ script: [[{ text: 'owner reply' }], [{ text: 'alice reply' }]], overrides: MEMORY as never });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Trip plan' }, OWNER_ID);
    engine.addMessage(chat.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'secret-before-join' }] });
    await engine.memory.save({ content: 'The owner hides a flowerpot under the porch', kind: 'fact' } as never);
    const alice = await join(engine, chat.id, 'alice');
    // everything the seat derives the account from is hers, so the 93 session-derived paths are hers too
    expect(engine.sessionAccount(alice.seatId)).toBe(alice.id);

    await engine.send(chat.id, { text: 'owner words' });
    await engine.runnerFor(chat.id).waitIdle();
    await engine.sharedTurn(chat.id, alice.id, { text: 'alice words' });
    await engine.runnerFor(alice.seatId).waitIdle();

    expect(t.keys).toHaveLength(2);
    expect(t.keys[0]).toBe('test'); // the hub's key: the owner's own turn
    expect(t.keys[1]).toBe('sk-alice-own-key'); // her turn never fell back to the hub's

    // the starter pays: usage rows of her seat bill her account, and the owner's bill nothing of hers
    expect(usageOf(engine, alice.seatId).every((u) => u.account_id === alice.id)).toBe(true);
    expect(usageOf(engine, chat.id).every((u) => u.account_id === OWNER_ID)).toBe(true);
    expect(turnsOf(engine, alice.seatId).every((r) => r.started_by === alice.id)).toBe(true);
    expect(turnsOf(engine, chat.id).every((r) => r.started_by === OWNER_ID)).toBe(true);

    // her request: her words plain, the owner's reply as quoted history, and none of what she may not see
    const req = JSON.parse(t.requests[1]);
    const flat = JSON.stringify(req);
    expect(flat).toContain('alice words');
    expect(flat).toContain('owner reply');
    expect(flat).toContain('shared-history'); // the owner's words arrive quoted, never as her instructions
    for (const secret of ['secret-before-join', 'flowerpot']) expect(flat).not.toContain(secret);
    // chat tools only: no shell, no files outside the chat's own, no MCP
    const tools = (req.tools ?? []).map((x: { name: string }) => x.name);
    expect(tools).not.toContain('Bash');
    expect(tools.filter((n: string) => n.startsWith('mcp__'))).toEqual([]);
  }, 60_000);

  test('one turn at a time, in order: a post that arrives while a turn runs waits for it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    t = await startTestEngine({ script: [{ blocks: [{ text: 'first done' }], gate }, [{ text: 'second done' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Queue' }, OWNER_ID);
    const alice = await join(engine, chat.id, 'alice');
    const bob = await join(engine, chat.id, 'bob');

    // hold the first turn on the provider: the queue must not start the second
    (t as TestEngine & { script?: unknown }).script = undefined;
    const held = startTestEngine; // keep import used
    void held;
    const first = engine.sharedTurn(chat.id, alice.id, { text: 'alice first' });
    await until(() => t!.requests.length === 1);
    const second = engine.sharedTurn(chat.id, bob.id, { text: 'bob second' });
    await Bun.sleep(300);
    expect(t.requests).toHaveLength(1); // bob's turn waits, not interleaved
    expect(t.keys[0]).toBe('sk-alice-own-key');
    release();
    await Promise.all([first, second]);
    expect(t.keys[1]).toBe('sk-bob-own-key');
    expect(userTexts(engine, chat.id).slice(-2)).toEqual(['alice first', 'bob second']); // FIFO order in the one transcript
  }, 60_000);

  test(`stop rules: the owner stops anyone's running turn, a participant only their own`, async () => {
    const gates = [0, 1].map(() => {
      let release: () => void = () => {};
      return { promise: new Promise<void>((r) => (release = r)), release };
    });
    t = await startTestEngine({ script: gates.map((g) => ({ blocks: [{ text: 'slow' }], gate: g.promise })) });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Stop' }, OWNER_ID);
    const alice = await join(engine, chat.id, 'alice');
    const bob = await join(engine, chat.id, 'bob');

    const running = engine.sharedTurn(chat.id, alice.id, { text: 'hold this' });
    await until(() => t!.requests.length === 1);
    // bob is in the chat, but it is not his turn
    expect(() => engine.stopChatTurn(chat.id, bob.id)).toThrow(PeopleError);
    // the owner stops anyone's
    engine.stopChatTurn(chat.id, OWNER_ID);
    await running;
    expect(engine.getSession(alice.seatId)?.status).not.toBe('running');
    gates[0].release();

    // a demotion to Viewer ends a running turn the new role no longer allows
    const running2 = engine.sharedTurn(chat.id, alice.id, { text: 'hold again' });
    await until(() => t!.requests.length === 2);
    const store = new ChatParticipantStore(engine.repos.db);
    store.change(chat.id, OWNER_ID, alice.id, { access: 'viewer' });
    engine.revokeChatTurns(chat.id, alice.id);
    await running2;
    gates[1].release();
    let threw = false;
    try {
      store.require(chat.id, alice.id, true);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // her next post is refused
  }, 60_000);

  test('a seat takes no direct send, resume or retry: its turns run only through the chat queue', async () => {
    t = await startTestEngine({ script: [[{ text: 'reply' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Seat' }, OWNER_ID);
    const alice = await join(engine, chat.id, 'alice');
    await expect(engine.send(alice.seatId, { text: 'jump the queue' })).rejects.toMatchObject({ status: 409 });
    await expect(engine.resumeSession(alice.seatId)).rejects.toMatchObject({ status: 409 });
    await expect(engine.retryProvider(alice.seatId, 'msg_x', 'mock/mock-model')).rejects.toMatchObject({ status: 409 });
    expect(() => engine.sendQueued(alice.seatId, 'p1')).toThrow('Send in the shared chat');
    expect(t.requests).toHaveLength(0);
  }, 60_000);

  test('a declined invite leaves the chat unshared: the owner sends the normal way', async () => {
    t = await startTestEngine({ script: [[{ text: 'reply' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Solo' }, OWNER_ID);
    const bob = engine.people.create({ name: 'bob', displayName: 'Bob' });
    const store = new ChatParticipantStore(engine.repos.db);
    store.invite(chat.id, OWNER_ID, bob.id, {});
    store.decline(chat.id, bob.id);
    const res = await engine.send(chat.id, { text: 'just me' });
    expect(res.queued).toBe(false); // the stored runner queue, not the in-memory shared-turn tail
    await engine.runnerFor(chat.id).waitIdle();
  }, 60_000);

  test('history narrowed from all to joined drops the seat summaries of what it may no longer read', async () => {
    t = await startTestEngine({ script: [[{ text: 'reply' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'History' }, OWNER_ID);
    engine.addMessage(chat.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'before-join' }] });
    const alice = await join(engine, chat.id, 'alice');
    const store = new ChatParticipantStore(engine.repos.db);
    store.change(chat.id, OWNER_ID, alice.id, { history: 'all' });
    // her own compaction, saved private in her seat, summarizes the earlier messages
    engine.addMessage(alice.seatId, { role: 'user', kind: 'summary', content: [{ type: 'text', text: 'summary-of-before-join' }] });
    expect(JSON.stringify(engine.turnMessages(alice.seatId))).toContain('summary-of-before-join');
    store.change(chat.id, OWNER_ID, alice.id, { history: 'joined' });
    engine.narrowChatHistory(chat.id, alice.id);
    const seen = JSON.stringify(engine.turnMessages(alice.seatId));
    expect(seen).not.toContain('summary-of-before-join');
    expect(seen).not.toContain('before-join');
  }, 60_000);

  test(`the owner's digest catch-up learns only the owner's words, never a participant's`, async () => {
    t = await startTestEngine({ script: [[{ text: 'reply' }]], overrides: { memory: { enabled: true, autoExtract: true, autoInject: false, injectLimit: 5 } } as never });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Digest' }, OWNER_ID);
    engine.addMessage(chat.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'owner-digest-words about the porch' }] });
    engine.addMessage(chat.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'Noted the porch.' }] });
    const alice = await join(engine, chat.id, 'alice');
    // her seat turn writes into the chat (destination), her private tool output with it
    engine.addMessage(alice.seatId, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'alice asks about her bank' }] });
    engine.addMessage(alice.seatId, { role: 'assistant', kind: 'normal', content: [{ type: 'tool_use', id: 'm1', name: 'MemorySearch', input: { q: 'pin' } }] });
    engine.addMessage(alice.seatId, { role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: 'm1', content: 'alice-bank-pin-4417' }] });
    expect(engine.getMessages(chat.id).some((m) => m.sender === `account:${alice.id}`)).toBe(true);
    const { DailyDigest } = await import('../../src/memory/digest');
    await new DailyDigest(engine, { writer: { groupedTargets: () => [], writeGrouped: async () => {} } }).digest({ zone: 'UTC' });
    const chores = t.chores.join('\n');
    expect(chores).toContain('owner-digest-words'); // the catch-up ran on the owner's chat
    expect(chores).not.toContain('alice-bank-pin-4417');
    expect(chores).not.toContain('alice asks about her bank');
  }, 60_000);

  test('Just talk posts a plain human message with no provider call', async () => {
    t = await startTestEngine({ script: [[{ text: 'reply' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', title: 'Talk' }, OWNER_ID);
    const alice = await join(engine, chat.id, 'alice');
    const res = await engine.send(chat.id, { text: 'just talking', justTalk: true });
    expect(res.queued).toBe(false);
    expect(userTexts(engine, chat.id)).toContain('just talking');
    expect(t.requests).toHaveLength(0);
    expect(() => engine.send(chat.id, { text: 'x', justTalk: 'yes' as never })).toThrow();
    void alice;
  }, 60_000);
});
