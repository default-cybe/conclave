/**
 * /api/ws fan-out cost (ws/clients.ts broadcast): a socket whose filter skips
 * the event builds no frame, and one dispatch stringifies each account's view
 * once, while every account still gets its own exact view.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { EngineEventEnvelope } from '@conclave/core/types.ts';
import { sharedChatEventView } from '@conclave/core/people/shared-chats.ts';
import { ClientHub, type ClientSocketData } from '../src/ws/clients';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
let alice: string;
let bob: string;
let chat: { id: string };

beforeAll(async () => {
  hub = startHub();
  alice = hub.engine.people.create({ name: 'alice-bc', displayName: 'Alice' }).id;
  bob = hub.engine.people.create({ name: 'bob-bc', displayName: 'Bob' }).id;
  const aliceToken = hub.running.conclave.ctx.auth.clients.create({ name: 'alice phone', accountId: alice }).token;
  chat = await hub.engine.createSession({ kind: 'chat', title: 'Broadcast' }, 'owner');
  expect((await hub.api(`/api/sessions/${chat.id}/participants`, { method: 'POST', json: { party: `account:${alice}` } })).status).toBe(200);
  expect((await hub.api(`/api/chats/invites/${chat.id}/accept`, { method: 'POST', token: aliceToken, json: {} })).status).toBe(200);
});
afterAll(() => hub.stop());

function fakeSocket(accountId: string | undefined, filter: Set<string> | null) {
  const sent: string[] = [];
  const ws = {
    data: { kind: 'client', clientId: accountId ?? 'owner', accountId, filter } as ClientSocketData,
    send: (f: string) => void sent.push(f),
    getBufferedAmount: () => 0,
    close: () => undefined,
  };
  return { ws: ws as unknown as ServerWebSocket<ClientSocketData>, sent };
}

/** The envelope the bus stamps for an event, caught from the bus itself. */
function capture(emit: () => void, match: (e: EngineEventEnvelope) => boolean): EngineEventEnvelope {
  let got: EngineEventEnvelope | undefined;
  const off = hub.engine.bus.on((e) => {
    if (!got && match(e)) got = e;
  });
  emit();
  off();
  if (!got) throw new Error('no event');
  return got;
}

test('sockets whose filter skips a live delta cost no stringify', () => {
  const clients = new ClientHub(hub.engine);
  try {
    const socks = Array.from({ length: 8 }, () => fakeSocket(undefined, new Set(['some-other-session'])));
    for (const s of socks) clients.open(s.ws);
    const e = capture(
      () => hub.engine.bus.emit({ type: 'message.delta', sessionId: chat.id, messageId: 'm1', index: 0, kind: 'text', text: 'x'.repeat(10_000) }),
      (x) => x.type === 'message.delta',
    );
    const stringify = spyOn(JSON, 'stringify');
    try {
      clients.broadcast(e);
      expect(stringify).toHaveBeenCalledTimes(0);
    } finally {
      stringify.mockRestore();
    }
    for (const s of socks) expect(s.sent.filter((f) => f.includes('message.delta'))).toEqual([]);
  } finally {
    clients.dispose();
  }
});

test('one stringify per account view; owner and member sockets get their own exact frames, others none', () => {
  const clients = new ClientHub(hub.engine);
  try {
    const owners = [fakeSocket(undefined, null), fakeSocket('owner', null), fakeSocket(undefined, null)];
    const alices = [fakeSocket(alice, null), fakeSocket(alice, null)];
    const bobs = [fakeSocket(bob, null)];
    const all = [...owners, ...alices, ...bobs];
    for (const s of all) clients.open(s.ws);
    const e = capture(
      () =>
        hub.engine.addMessage(chat.id, {
          role: 'assistant',
          kind: 'normal',
          model: 'm',
          content: [
            { type: 'text', text: 'broadcast text' },
            { type: 'tool_result', toolUseId: 'tb', content: 'broadcast-secret-output' },
          ],
        }),
      (x) => x.type === 'message.created',
    );
    for (const s of all) s.sent.length = 0;
    const ownerView = JSON.stringify(e);
    const aliceView = JSON.stringify(sharedChatEventView(hub.engine.repos.db, e, alice));
    const stringify = spyOn(JSON, 'stringify');
    try {
      clients.broadcast(e);
      expect(stringify).toHaveBeenCalledTimes(2);
    } finally {
      stringify.mockRestore();
    }
    for (const s of owners) expect(s.sent).toEqual([ownerView]);
    for (const s of alices) expect(s.sent).toEqual([aliceView]);
    expect(aliceView).not.toContain('broadcast-secret-output');
    expect(ownerView).toContain('broadcast-secret-output');
    expect(bobs[0].sent).toEqual([]);
  } finally {
    clients.dispose();
  }
});
