import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
let alice: string;
let bob: string;
let aliceToken: string;
let bobToken: string;

beforeAll(() => {
  hub = startHub();
  hub.engine.people.update('owner', { displayName: 'Kai' });
  alice = hub.engine.people.create({ name: 'alice-signin', displayName: 'Alice', email: 'private-alice@example.com', settings: { defaultModel: 'private/model' } }).id;
  bob = hub.engine.people.create({ name: 'bob-signin', displayName: 'Bob', email: 'private-bob@example.com' }).id;
  const clients = hub.running.conclave.ctx.auth.clients;
  aliceToken = clients.create({ name: 'alice phone', accountId: alice }).token;
  bobToken = clients.create({ name: 'bob phone', accountId: bob }).token;
});
afterAll(() => hub.stop());

const contacts = async (token?: string) => (await hub.api('/api/contacts', { ...(token ? { token } : {}) })).json();

test('members see the owner and other members by default, with only party ids and shown names', async () => {
  expect(await contacts(aliceToken)).toEqual([
    { party: 'account:owner', name: 'Kai' },
    { party: `account:${bob}`, name: 'Bob' },
  ]);
  expect(await contacts(bobToken)).toEqual([
    { party: 'account:owner', name: 'Kai' },
    { party: `account:${alice}`, name: 'Alice' },
  ]);
  const text = JSON.stringify(await contacts(aliceToken));
  for (const privateField of ['signin', '@example.com', 'private/model', 'settings', 'password', 'providers']) expect(text).not.toContain(privateField);
});

test('remote friends appear only to the owner; members never enumerate peer cards', async () => {
  const list = spyOn(hub.running.conclave.ctx.peer, 'list').mockReturnValue([
    { id: 'remote-active', name: 'Remote friend', status: 'active', fingerprint: 'private-fingerprint', addresses: [{ url: 'private-address' }], email: 'private@example.com' },
    { id: 'remote-pending', name: 'Not accepted', status: 'pending' },
    { id: 'remote-blocked', name: 'Blocked', status: 'blocked' },
    { id: 'remote-removed', name: 'Removed', status: 'removed' },
  ] as any);
  try {
    expect(await contacts()).toEqual([
      { party: `account:${alice}`, name: 'Alice' },
      { party: `account:${bob}`, name: 'Bob' },
      { party: 'friend:remote-active', name: 'Remote friend' },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect((await contacts(aliceToken)).every((c: { party: string }) => c.party.startsWith('account:'))).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  } finally { list.mockRestore(); }
});

test('the typed client exposes the same contact cards', async () => {
  const client = new ConclaveClient({ baseUrl: hub.url, token: aliceToken });
  expect(await client.contacts()).toEqual(await contacts(aliceToken));
});

test('contacts do not grant access to sessions, devices or account-management routes', async () => {
  const s = await hub.engine.createSession({ kind: 'chat', title: 'Private owner chat' }, 'owner');
  expect((await hub.api(`/api/sessions/${s.id}`, { token: aliceToken })).status).toBe(404);
  expect((await hub.api(`/api/sessions/${s.id}/messages`, { token: aliceToken })).status).toBe(404);
  expect((await hub.api(`/api/people/${bob}`, { token: aliceToken })).status).toBe(403);
  expect((await hub.api('/api/contacts', { token: null })).status).toBe(401);
});

test('renames and removals take effect at the next contacts request', async () => {
  hub.engine.people.update(bob, { displayName: 'Robert' });
  expect((await contacts(aliceToken)).find((c: { party: string }) => c.party === `account:${bob}`)?.name).toBe('Robert');
  hub.engine.people.remove(bob);
  expect((await contacts(aliceToken)).some((c: { party: string }) => c.party === `account:${bob}`)).toBe(false);
});
