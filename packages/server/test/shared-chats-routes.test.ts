/**
 * Shared chats, runtime access (docs/design/SHARED-WITH-MEMBERS.md 6). The
 * owner invites a contact, the contact accepts, and the rules hold end to
 * end: shaped reads, no history before the join, no other account's notices,
 * approvals or tool output, Viewer cannot post, removal closes everything.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { Message } from '@conclave/core/types.ts';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

let hub: TestHub;
let alice: string;
let bob: string;
let aliceToken: string;
let bobToken: string;
let chat: { id: string };

beforeAll(async () => {
  hub = startHub();
  hub.engine.people.update('owner', { displayName: 'Kai' });
  alice = hub.engine.people.create({ name: 'alice-signin', displayName: 'Alice' }).id;
  bob = hub.engine.people.create({ name: 'bob-signin', displayName: 'Bob' }).id;
  const clients = hub.running.conclave.ctx.auth.clients;
  aliceToken = clients.create({ name: 'alice phone', accountId: alice }).token;
  bobToken = clients.create({ name: 'bob phone', accountId: bob }).token;
  chat = await hub.engine.createSession({ kind: 'chat', title: 'Trip plan' }, 'owner');
  // the owner's private turn before anyone joins: a reminder and a tool call
  hub.engine.addMessage(chat.id, {
    role: 'user',
    kind: 'normal',
    content: [{ type: 'text', text: 'secret-before-join' }],
  });
  hub.engine.addMessage(chat.id, {
    role: 'assistant',
    kind: 'normal',
    model: 'm',
    content: [
      { type: 'text', text: 'Looking' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls /home/kai' } },
      { type: 'tool_result', toolUseId: 't1', content: 'secret-tool-output' },
    ],
  });
});
afterAll(() => hub.stop());

const invite = (chatId: string, accountId: string, body: Record<string, unknown> = {}) =>
  hub.api(`/api/sessions/${chatId}/participants`, { method: 'POST', json: { party: `account:${accountId}`, ...body } });

const accept = (chatId: string, token: string) => hub.api(`/api/chats/invites/${chatId}/accept`, { method: 'POST', token, json: {} });

test('a stranger, another member and a not-yet-accepted invite all read 404, as for an unknown chat', async () => {
  const res = await invite(chat.id, alice);
  expect(res.status).toBe(200);
  expect((await res.json()).state).toBe('invited');
  for (const token of [aliceToken, bobToken]) {
    expect((await hub.api(`/api/sessions/${chat.id}/messages`, { token })).status).toBe(404);
    expect((await hub.api(`/api/sessions/${chat.id}`, { token })).status).toBe(404);
  }
  // the owner still reads it all
  expect((await hub.api(`/api/sessions/${chat.id}/messages`)).status).toBe(200);
});

test('the invite lists on the invitee side only, with no transcript', async () => {
  const got = await (await hub.api('/api/chats/invites', { token: aliceToken })).json();
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ chatId: chat.id, title: 'Trip plan', owner: 'Kai', access: 'participant' });
  expect(JSON.stringify(got)).not.toContain('secret-before-join');
  // nobody else's invite: bob's list is empty, the owner's too
  expect(await (await hub.api('/api/chats/invites', { token: bobToken })).json()).toEqual([]);
  expect(await (await hub.api('/api/chats/invites')).json()).toEqual([]);
});

test('accepting makes a Participant a seat of their own: their chat session, memory off, hidden from their list', async () => {
  expect((await accept(chat.id, aliceToken)).status).toBe(200);
  const p = await (await hub.api(`/api/sessions/${chat.id}/participants`, { token: aliceToken })).json();
  expect(p).toEqual([
    expect.objectContaining({ accountId: alice, name: 'Alice', access: 'participant', state: 'active', history: 'joined' }),
  ]);
  const seat = hub.engine.repos.sessions.get(p[0].seatId ?? '');
  expect(seat).toMatchObject({ accountId: alice, kind: 'chat' });
  expect(seat?.chat?.memory).toBe(false);
  expect((seat?.meta as { seat?: { chatId?: string } })?.seat?.chatId).toBe(chat.id);
  const list = await (await hub.api('/api/sessions', { token: aliceToken })).json();
  expect(list.some((s: { id: string }) => s.id === p[0].seatId)).toBe(false);
  expect(await (await hub.api('/api/chats/shared', { token: aliceToken })).json()).toHaveLength(1);
});

test('a participant reads the chat shaped: history from the join, one-line tool summaries, no private machine', async () => {
  // after the join, the owner writes a turn with a tool call
  hub.engine.addMessage(chat.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'after-join' }] });
  hub.engine.addMessage(chat.id, {
    role: 'assistant',
    kind: 'normal',
    model: 'm',
    content: [
      { type: 'text', text: 'Running ls' },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolUseId: 't2', content: 'listed files' },
    ],
  });
  const s = await (await hub.api(`/api/sessions/${chat.id}`, { token: aliceToken })).json();
  expect(s.title).toBe('Trip plan');
  for (const field of ['cwd', 'device', 'permissionMode', 'modeConfig', 'stats', 'chat']) expect(s).not.toHaveProperty(field);
  const msgs = await (await hub.api(`/api/sessions/${chat.id}/messages`, { token: aliceToken })).json();
  const text = JSON.stringify(msgs);
  expect(text).toContain('after-join');
  expect(text).toContain('[Called Bash]'); // one-line tool summary, not the result
  // history starts at the join; the tool result is never the participant's
  for (const secret of ['secret-before-join', 'secret-tool-output', 'listed files', 'ls /home/kai']) expect(text).not.toContain(secret);
  // the owner still sees everything
  const own = await (await hub.api(`/api/sessions/${chat.id}/messages`)).json();
  expect(JSON.stringify(own)).toContain('secret-tool-output');
});

test('a message from a participant is theirs, stored with sender and author, and starts their seat turn', async () => {
  const res = await hub.api(`/api/sessions/${chat.id}/messages`, { method: 'POST', token: aliceToken, json: { text: 'hello from alice' } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ queued: true });
  const stored = hub.engine.getMessages(chat.id).find((m) => (m.content[0] as { text?: string })?.text === 'hello from alice');
  expect(stored).toMatchObject({ sender: `account:${alice}`, author: 'Alice' });
  // the turn is queued on the sender's own seat, never on the chat itself
  const turn = hub.engine.calls.find((c) => c.method === 'sharedTurn');
  expect(turn?.args).toEqual([chat.id, { accountId: alice, text: 'hello from alice' }]);
});

test('Just talk posts a plain human message of theirs and starts no turn', async () => {
  const before = hub.engine.calls.length;
  const res = await hub.api(`/api/sessions/${chat.id}/messages`, { method: 'POST', token: aliceToken, json: { text: 'just saying hi', justTalk: true } });
  expect(res.status).toBe(200);
  const stored = hub.engine.getMessages(chat.id).find((m) => (m.content[0] as { text?: string })?.text === 'just saying hi');
  expect(stored).toMatchObject({ sender: `account:${alice}`, author: 'Alice' });
  expect(hub.engine.calls.slice(before).some((c) => c.method === 'sharedTurn' || c.method === 'send')).toBe(false);
});

test('the owner still sends and turns run on the chat itself', async () => {
  expect((await hub.api(`/api/sessions/${chat.id}/messages`, { method: 'POST', json: { text: 'owner words' } })).status).toBe(200);
});

test('a Viewer cannot post and cannot stop the owner; a Participant cannot stop the owner either', async () => {
  await invite(chat.id, bob, { access: 'viewer' });
  await accept(chat.id, bobToken);
  const post = await hub.api(`/api/sessions/${chat.id}/messages`, { method: 'POST', token: bobToken, json: { text: 'viewer words' } });
  expect(post.status).toBe(403);
  // a Viewer reads
  expect((await hub.api(`/api/sessions/${chat.id}/messages`, { token: bobToken })).status).toBe(200);
  expect((await hub.api(`/api/sessions/${chat.id}/abort`, { method: 'POST', token: bobToken, json: {} })).status).toBe(403);
  expect((await hub.api(`/api/sessions/${chat.id}/abort`, { method: 'POST', token: aliceToken, json: {} })).status).toBe(403);
  expect((await hub.api(`/api/sessions/${chat.id}/abort`, { method: 'POST', json: {} })).status).toBe(200);
  expect(hub.engine.calls.filter((c) => c.method === 'stopChatTurn').length).toBe(3);
});

test('every other session route stays the owner only', async () => {
  // the chat's shape (GET) and its messages are the seat routes; everything else is 404 for a participant
  expect((await hub.api(`/api/sessions/${chat.id}/queue`, { token: aliceToken })).status).toBe(404);
  for (const path of ['fork', 'export', 'context', 'todos', 'diff', 'bundle']) {
    const res = await hub.api(`/api/sessions/${chat.id}/${path}`, { token: aliceToken });
    expect([404, 405]).toContain(res.status);
    if (res.status === 405) continue;
    expect(await res.text()).toBe(JSON.stringify({ error: 'not found' }));
  }
  expect((await hub.api(`/api/sessions/${chat.id}`, { method: 'PATCH', token: aliceToken, json: { title: 'nope' } })).status).toBe(404);
  expect((await hub.api(`/api/sessions/${chat.id}`, { method: 'DELETE', token: aliceToken })).status).toBe(404);
});

test('the owner changes role and history; removal and leaving close access at once', async () => {
  const change = await hub.api(`/api/sessions/${chat.id}/participants/${bob}`, { method: 'PATCH', json: { access: 'participant', history: 'all' } });
  expect(change.status).toBe(200);
  const withAll = await (await hub.api(`/api/sessions/${chat.id}/messages`, { token: bobToken })).json();
  expect(JSON.stringify(withAll)).toContain('secret-before-join'); // history: all shows the whole transcript, still shaped
  expect(JSON.stringify(withAll)).not.toContain('secret-tool-output');
  const post = await hub.api(`/api/sessions/${chat.id}/messages`, { method: 'POST', token: bobToken, json: { text: 'bob words' } });
  expect(post.status).toBe(200);
  // remove: bob is out now
  expect((await hub.api(`/api/sessions/${chat.id}/participants/${bob}`, { method: 'DELETE' })).status).toBe(200);
  expect((await hub.api(`/api/sessions/${chat.id}/messages`, { token: bobToken })).status).toBe(404);
  expect((await hub.api(`/api/sessions/${chat.id}/messages`, { method: 'POST', token: bobToken, json: { text: 'again' } })).status).toBe(404);
  // alice leaves on her own
  expect((await hub.api(`/api/sessions/${chat.id}/leave`, { method: 'POST', token: aliceToken, json: {} })).status).toBe(200);
  expect((await hub.api(`/api/sessions/${chat.id}/messages`, { token: aliceToken })).status).toBe(404);
  // and the owner's view is untouched
  expect((await hub.api(`/api/sessions/${chat.id}/messages`)).status).toBe(200);
});

test('invite and accepted notify exactly the two sides, nobody else', async () => {
  const send = spyOn(hub.engine.notifier, 'send');
  try {
    await invite(chat.id, alice);
    await accept(chat.id, aliceToken);
    const calls = send.mock.calls.map((a) => a[0]);
    expect(calls.find((n) => n.accountId === alice)?.title).toContain('added you to "Trip plan"');
    expect(calls.find((n) => n.accountId === 'owner')?.title).toContain('Alice accepted');
    expect(calls.every((n) => n.accountId === alice || n.accountId === 'owner')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('secret');
  } finally {
    send.mockRestore();
  }
});

// ---- sockets -----------------------------------------------------------------

test('a participant socket gets only the chat allow list, shaped; removal stops the stream', async () => {
  await invite(chat.id, alice);
  await accept(chat.id, aliceToken);
  const ws = (hub.url.replace(/^http/, 'ws') + '/api/ws');
  const ownerS = await openWs(`${ws}?token=${OWNER}`);
  const aliceS = await openWs(`${ws}?token=${aliceToken}`);
  const bobS = await openWs(`${ws}?token=${bobToken}`);
  await Promise.all([ownerS, aliceS, bobS].map((s) => s.next((f) => f.type === 'hello')));

  // a fresh turn of the owner's
  const m = hub.engine.addMessage(chat.id, {
    role: 'assistant',
    kind: 'normal',
    model: 'm',
    content: [
      { type: 'text', text: 'live text' },
      { type: 'tool_result', toolUseId: 't3', content: 'socket-secret-output' },
    ],
  });
  const got = await aliceS.next((f) => f.type === 'message.created' && f.message?.id === m.id);
  expect(got.message.content.map((b: { type: string }) => b.type)).toEqual(['text', 'text']); // tool result became a summary line
  expect(JSON.stringify(got)).not.toContain('socket-secret-output');
  expect(await ownerS.next((f) => f.type === 'message.created' && f.message?.id === m.id)).toBeTruthy();
  expect(bobS.frames.some((f) => f.message?.id === m.id)).toBe(false);

  // text deltas stream; tool input and results never do
  hub.engine.bus.emit({ type: 'message.delta', sessionId: chat.id, messageId: 'm2', index: 0, kind: 'text', text: 'chunk' });
  await aliceS.next((f) => f.type === 'message.delta' && f.text === 'chunk');
  hub.engine.bus.emit({ type: 'message.delta', sessionId: chat.id, messageId: 'm3', index: 0, kind: 'tool_input', text: '{"secret":1}' });
  hub.engine.bus.emit({ type: 'tool.progress', sessionId: chat.id, toolUseId: 't3', text: 'socket-secret-progress' });

  // the owner's approvals, questions, notices and other sessions never cross
  hub.engine.bus.emit({ type: 'notice', notice: { id: 'n1', accountId: 'owner', title: 'socket-secret-notice', body: '', level: 'info' } as never });
  hub.engine.bus.emit({ type: 'approval.requested', approval: { id: 'a1', sessionId: chat.id } as never });
  hub.engine.bus.emit({ type: 'task.deleted', taskId: 'owner-task' });
  await ownerS.next((f) => f.type === 'notice');
  await ownerS.next((f) => f.type === 'approval.requested');
  await new Promise((r) => setTimeout(r, 150));
  const leaked = JSON.stringify(aliceS.frames);
  for (const secret of ['socket-secret-notice', 'approval', 'owner-task', 'socket-secret-progress', '"secret"']) expect(leaked).not.toContain(secret);

  // removal stops the stream at once, and the replay never serves the chat again
  await hub.api(`/api/sessions/${chat.id}/participants/${alice}`, { method: 'DELETE' });
  const after = hub.engine.addMessage(chat.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'after-removal' }] });
  await ownerS.next((f) => f.type === 'message.created' && f.message?.id === after.id);
  await new Promise((r) => setTimeout(r, 150));
  expect(aliceS.frames.some((f) => f.message?.id === after.id)).toBe(false);
  // replay from before everything: only allowed, shaped events
  const since = await openWs(`${ws}?token=${aliceToken}`);
  const start = await since.next((f) => f.type === 'hello');
  since.ws.send(JSON.stringify({ type: 'since', seq: start.seq - 5 }));
  await new Promise((r) => setTimeout(r, 200));
  const replay = JSON.stringify(since.frames);
  expect(replay).not.toContain('socket-secret-output');
  expect(replay).not.toContain('socket-secret-notice');
  expect(since.frames.some((f) => f.type === 'message.created' && f.message?.sessionId === chat.id)).toBe(false);

  for (const s of [ownerS, aliceS, bobS, since]) s.close();
});

// ---- review fixes ------------------------------------------------------------

test('two pending invites to one chat: each invitee accepts or declines their own', async () => {
  const two = await hub.engine.createSession({ kind: 'chat', title: 'Two invites' }, 'owner');
  // alice's row comes first; bob must still reach his own
  expect((await invite(two.id, alice)).status).toBe(200);
  expect((await invite(two.id, bob)).status).toBe(200);
  expect((await accept(two.id, bobToken)).status).toBe(200);
  expect((await hub.api(`/api/chats/invites/${two.id}/decline`, { method: 'POST', token: aliceToken, json: {} })).status).toBe(200);
  // nobody accepts an invite that is not theirs: a second accept is 404
  expect((await accept(two.id, bobToken)).status).toBe(404);
  expect((await accept(two.id, aliceToken)).status).toBe(404);
});

test(`a participant reads only their own seat id; the owner reads everyone's`, async () => {
  const seats = await hub.engine.createSession({ kind: 'chat', title: 'Seats' }, 'owner');
  for (const [id, token] of [[alice, aliceToken], [bob, bobToken]] as const) {
    await invite(seats.id, id);
    await accept(seats.id, token);
  }
  const seatOf = (rows: { accountId: string; seatId?: string }[], id: string) => rows.find((r) => r.accountId === id)?.seatId;
  const owner = await (await hub.api(`/api/sessions/${seats.id}/participants`)).json();
  expect(seatOf(owner, alice)).toBeString();
  expect(seatOf(owner, bob)).toBeString();
  const asAlice = await (await hub.api(`/api/sessions/${seats.id}/participants`, { token: aliceToken })).json();
  expect(seatOf(asAlice, alice)).toBe(seatOf(owner, alice));
  expect(seatOf(asAlice, bob)).toBeUndefined();
  expect(JSON.stringify(asAlice)).not.toContain(seatOf(owner, bob)!);
});

test('an invite notification links to where Accept waits, not to the chat they cannot open yet', async () => {
  const three = await hub.engine.createSession({ kind: 'chat', title: 'Link' }, 'owner');
  const send = spyOn(hub.engine.notifier, 'send');
  try {
    await invite(three.id, alice);
    const n = send.mock.calls.map((a) => a[0]).find((x) => x.accountId === alice);
    expect(n?.link).toBe('/chat');
  } finally {
    send.mockRestore();
  }
});

test(`the owner reads a participant's turn shaped: full tool output is only the starter's`, async () => {
  const four = await hub.engine.createSession({ kind: 'chat', title: 'Owner view' }, 'owner');
  await invite(four.id, alice);
  await accept(four.id, aliceToken);
  const ws = hub.url.replace(/^http/, 'ws') + '/api/ws';
  const ownerS = await openWs(`${ws}?token=${OWNER}`);
  const aliceS = await openWs(`${ws}?token=${aliceToken}`);
  await Promise.all([ownerS, aliceS].map((s) => s.next((f) => f.type === 'hello')));
  // her seat turn's tool call and result, written into the chat with her sender
  const m = hub.engine.addMessage(four.id, {
    role: 'user',
    kind: 'normal',
    sender: `account:${alice}`,
    author: 'Alice',
    content: [{ type: 'tool_result', toolUseId: 'w1', content: 'alice-bank-pin-4417' }],
  });
  const own = JSON.stringify(await (await hub.api(`/api/sessions/${four.id}/messages`)).json());
  expect(own).not.toContain('alice-bank-pin-4417');
  expect(own).toContain('[Tool completed]');
  expect((await hub.api(`/api/sessions/${four.id}/messages/${m.id}/blocks/0`)).status).toBe(200);
  expect(await (await hub.api(`/api/sessions/${four.id}/messages/${m.id}/blocks/0`)).text()).not.toContain('4417');
  // the starter still reads her own in full
  expect(JSON.stringify(await (await hub.api(`/api/sessions/${four.id}/messages`, { token: aliceToken })).json())).toContain('alice-bank-pin-4417');
  // and the socket: the owner's frame is shaped, hers is whole
  const ownerFrame = await ownerS.next((f) => f.type === 'message.created' && f.message?.id === m.id);
  expect(JSON.stringify(ownerFrame)).not.toContain('4417');
  const aliceFrame = await aliceS.next((f) => f.type === 'message.created' && f.message?.id === m.id);
  expect(JSON.stringify(aliceFrame)).toContain('alice-bank-pin-4417');
  for (const s of [ownerS, aliceS]) s.close();
});

test(`a participant's send answers at once, not after their queued turn finishes`, async () => {
  const five = await hub.engine.createSession({ kind: 'chat', title: 'No wait' }, 'owner');
  await invite(five.id, alice);
  await accept(five.id, aliceToken);
  // a turn that waits behind others for as long as it likes
  const held = spyOn(hub.engine, 'sharedTurn').mockImplementation(() => new Promise<void>(() => {}));
  try {
    const res = await Promise.race([
      hub.api(`/api/sessions/${five.id}/messages`, { method: 'POST', token: aliceToken, json: { text: 'queued words' } }),
      Bun.sleep(2000).then(() => undefined),
    ]);
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ queued: true });
  } finally {
    held.mockRestore();
  }
});

test('history from all to joined drops what their seat summarized; widening it does not', async () => {
  const six = await hub.engine.createSession({ kind: 'chat', title: 'Narrow' }, 'owner');
  await invite(six.id, alice, { history: 'all' });
  await accept(six.id, aliceToken);
  const before = hub.engine.calls.length;
  expect((await hub.api(`/api/sessions/${six.id}/participants/${alice}`, { method: 'PATCH', json: { history: 'joined' } })).status).toBe(200);
  expect(hub.engine.calls.slice(before).find((c) => c.method === 'narrowChatHistory')?.args).toEqual([six.id, alice]);
  const wide = hub.engine.calls.length;
  expect((await hub.api(`/api/sessions/${six.id}/participants/${alice}`, { method: 'PATCH', json: { history: 'all' } })).status).toBe(200);
  expect(hub.engine.calls.slice(wide).some((c) => c.method === 'narrowChatHistory')).toBe(false);
});
