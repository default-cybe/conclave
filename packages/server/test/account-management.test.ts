/**
 * Account management (routes-people.ts): the owner disables and enables a
 * member, which cuts their sockets and daemons at once and stops their work;
 * the owner lists and unpairs a member's devices; every account has its own
 * usage summary and profile picture, and sees another's picture only when
 * that account is a contact. Each route's access rule: owner, member, other
 * member.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RateLimiter } from '../src/auth';
import { openWs, startHub, type TestHub } from './helpers';

const PW = 'a long enough password';
const AVATAR_MAX = 512 * 1024;
let hub: TestHub;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

type Person = { id: string; token: string };
let alice: Person;
let bob: Person;

async function member(name: string): Promise<Person> {
  const made = await (await hub.api('/api/people', { method: 'POST', json: { name, password: PW } })).json();
  const login = await (await hub.api('/api/login', { method: 'POST', token: null, json: { account: name, password: PW, name: `${name} laptop` } })).json();
  return { id: made.person.id, token: login.token };
}

/** Pair a computer for an account and connect its daemon; resolves once the hub welcomed it. */
async function daemonOf(token: string, name: string): Promise<{ deviceId: string; token: string; ws: WebSocket; closed: Promise<number> }> {
  const { code } = await (await hub.api('/api/pairing', { method: 'POST', token, json: { kind: 'device' } })).json();
  const reg = await (await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code, name } })).json();
  const ws = new WebSocket(`${hub.url.replace('http', 'ws')}/api/daemon?deviceId=${reg.deviceId}`, { headers: { authorization: `Bearer ${reg.token}` } } as any);
  const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
  const welcomed = new Promise<void>((r) => ws.addEventListener('message', (m) => JSON.parse(String(m.data)).type === 'welcome' && r()));
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ type: 'hello', version: 1, deviceId: reg.deviceId, info: { hostname: name, platform: 'linux', arch: 'x64', home: '/home/x', shell: 'bash', clis: {}, capabilities: [] } }));
  await welcomed;
  return { deviceId: reg.deviceId, token: reg.token, ws, closed };
}

beforeAll(async () => {
  hub = startHub();
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
  alice = await member('alice');
  bob = await member('bob');
});
afterAll(() => hub.stop());
beforeEach(() => {
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
});

describe('owner routes refuse members', () => {
  const routes: Array<[string, (id: string) => string]> = [
    ['POST', (id) => `/api/people/${id}/disable`],
    ['POST', (id) => `/api/people/${id}/enable`],
    ['GET', (id) => `/api/people/${id}/devices`],
    ['DELETE', (id) => `/api/people/${id}/devices/dev_x`],
  ];
  test('alice gets 403 on her own id and on bob\'s, and bob stays enabled', async () => {
    for (const [method, path] of routes) {
      for (const target of [alice.id, bob.id, 'owner']) {
        const r = await hub.api(path(target), { method, token: alice.token });
        expect([method, path(target), r.status]).toEqual([method, path(target), 403]);
      }
    }
    expect(hub.engine.people.get(bob.id)?.disabled).toBe(false);
  });

  test('the owner cannot be disabled', async () => {
    expect((await hub.api('/api/people/owner/disable', { method: 'POST' })).status).toBe(400);
  });
});

describe('the owner manages a member\'s devices', () => {
  test('lists only that member\'s, unpairs one, and refuses a device of someone else as unknown', async () => {
    const a = await daemonOf(alice.token, 'alice-box');
    const b = await daemonOf(bob.token, 'bob-box');
    const list = await (await hub.api(`/api/people/${alice.id}/devices`)).json();
    expect(list.map((d: { id: string }) => d.id)).toEqual([a.deviceId]);
    // bob's device through alice's path: 404, and it stays
    expect((await hub.api(`/api/people/${alice.id}/devices/${b.deviceId}`, { method: 'DELETE' })).status).toBe(404);
    expect(hub.engine.repos.devices.get(b.deviceId)).toBeTruthy();
    expect((await hub.api(`/api/people/${alice.id}/devices/${a.deviceId}`, { method: 'DELETE' })).status).toBe(200);
    expect(await a.closed).toBe(4001);
    expect(hub.engine.repos.devices.get(a.deviceId)).toBeFalsy();
    b.ws.close();
  });
});

describe('disable', () => {
  test('cuts the member\'s open sockets and daemons at once, stops their work, refuses them after, and enable lets them back', async () => {
    const d = await daemonOf(bob.token, 'bob-desk');
    const sock = await openWs(`${hub.url.replace('http', 'ws')}/api/ws?token=${bob.token}`);
    const sockClosed = new Promise<number>((r) => sock.ws.addEventListener('close', (e) => r(e.code)));
    const aliceSock = await openWs(`${hub.url.replace('http', 'ws')}/api/ws?token=${alice.token}`);
    let aliceClosed = false;
    aliceSock.ws.addEventListener('close', () => (aliceClosed = true));

    const r = await hub.api(`/api/people/${bob.id}/disable`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await r.json()).disabled).toBe(true);
    expect(await sockClosed).toBe(4001);
    expect(await d.closed).toBe(4001);
    expect(hub.engine.calls.some((c) => c.method === 'stopAccount' && c.args[0] === bob.id)).toBe(true);
    // only bob's
    await Bun.sleep(50);
    expect(aliceClosed).toBe(false);
    aliceSock.close();

    // the same token, a socket, a daemon, a login and a pairing code are all refused now
    expect((await hub.api('/api/me', { token: bob.token })).status).toBe(401);
    expect((await fetch(`${hub.url}/api/daemon?deviceId=${d.deviceId}`, { headers: { authorization: `Bearer ${d.token}` } })).status).toBe(401);
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'bob', password: PW } })).status).toBe(400);
    const listed = await (await hub.api('/api/people')).json();
    expect(listed.find((p: { id: string }) => p.id === bob.id).disabled).toBe(true);

    expect((await hub.api(`/api/people/${bob.id}/enable`, { method: 'POST' })).status).toBe(200);
    expect((await hub.api('/api/me', { token: bob.token })).status).toBe(200);
    expect(hub.engine.repos.devices.get(d.deviceId)).toBeTruthy();
  });
});

describe('disable an OAuth-connected app', () => {
  test('an MCP app the member allowed stops while they are disabled', async () => {
    const store = (hub.running.conclave.ctx as { oauth: { store: any } }).oauth.store;
    const { client } = store.register({ name: 'tool', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], applicationType: 'web', authMethod: 'none' });
    const grant = store.createGrant({ id: 'oag_alice', client: client.id, scope: ['memory:read'], resource: `${hub.url}/mcp`, redirectUri: 'https://claude.ai/api/mcp/auth_callback', approvedBy: 'alice', accountId: alice.id });
    const { accessToken } = store.issue(grant.id, ['memory:read']);
    const rpc = () => fetch(`${hub.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await rpc()).status).toBe(200);
    await hub.api(`/api/people/${alice.id}/disable`, { method: 'POST' });
    expect((await rpc()).status).toBe(401);
    await hub.api(`/api/people/${alice.id}/enable`, { method: 'POST' });
    expect((await rpc()).status).toBe(200);
  });
});

describe('usage', () => {
  test('each account sees its own week and month; the owner sees everyone\'s in People', async () => {
    const now = Date.now();
    const row = (id: string, acct: string, cost: number) =>
      hub.engine.repos.db
        .query("INSERT INTO usage (id, ts, source, provider, model, input_tokens, output_tokens, cost_usd, account_id) VALUES (?, ?, 'api', 'anthropic', 'm', 100, 50, ?, ?)")
        .run(id, now, cost, acct);
    row('u_alice', alice.id, 0.5);
    row('u_bob', bob.id, 2);
    const mine = await (await hub.api('/api/me/usage', { token: alice.token })).json();
    expect(mine.week).toMatchObject({ tokens: 150, costUsd: 0.5 });
    expect(mine.month).toMatchObject({ tokens: 150, costUsd: 0.5 });
    expect(mine.week.from).toBeLessThanOrEqual(now);
    const people = await (await hub.api('/api/people')).json();
    expect(people.find((p: { id: string }) => p.id === bob.id).usage.month).toMatchObject({ tokens: 150, costUsd: 2 });
  });
});

describe('avatars', () => {
  test('set, read and delete your own; served with the sniffed type, nosniff and a sandbox', async () => {
    const put = await hub.api('/api/me/avatar', { method: 'PUT', token: alice.token, headers: { 'content-type': 'text/html' }, body: PNG });
    expect(put.status).toBe(200);
    const { avatarVersion } = await put.json();
    expect(avatarVersion).toBeGreaterThan(0);
    const me = await (await hub.api('/api/me', { token: alice.token })).json();
    expect(me.avatarVersion).toBe(avatarVersion);
    const got = await hub.api('/api/me/avatar', { token: alice.token });
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  });

  test('refuses a script, an SVG and a file over 512 KB', async () => {
    const svg = await hub.api('/api/me/avatar', { method: 'PUT', token: bob.token, headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    expect(svg.status).toBe(415);
    const html = await hub.api('/api/me/avatar', { method: 'PUT', token: bob.token, headers: { 'content-type': 'image/png' }, body: '<html><script>alert(1)</script></html>' });
    expect(html.status).toBe(415);
    const big = new Uint8Array(AVATAR_MAX + 1);
    big.set(PNG);
    expect((await hub.api('/api/me/avatar', { method: 'PUT', token: bob.token, body: big })).status).toBe(413);
    expect(hub.engine.people.avatar(bob.id)).toBeUndefined();
  });

  test('another account\'s picture: a contact sees it, the owner sees it, someone who is not a contact gets 404', async () => {
    // contacts are everyone on the hub (SHARED-WITH-MEMBERS.md 3), so bob sees alice's
    expect((await hub.api(`/api/avatars/${alice.id}`, { token: bob.token })).status).toBe(200);
    expect((await hub.api(`/api/avatars/${alice.id}`)).status).toBe(200);
    const contacts = await (await hub.api('/api/contacts', { token: bob.token })).json();
    expect(contacts.find((c: { party: string }) => c.party === `account:${alice.id}`).avatarVersion).toBeGreaterThan(0);
    // an id that is no contact of bob's (unknown, or gone) answers like one with no picture
    expect((await hub.api('/api/avatars/acc_nobody', { token: bob.token })).status).toBe(404);
    // a disabled account is no contact: its picture is hidden from members
    await hub.api(`/api/people/${alice.id}/disable`, { method: 'POST' });
    expect((await hub.api(`/api/avatars/${alice.id}`, { token: bob.token })).status).toBe(404);
    await hub.api(`/api/people/${alice.id}/enable`, { method: 'POST' });
  });

  test('a member deletes only their own', async () => {
    expect((await hub.api('/api/me/avatar', { method: 'DELETE', token: bob.token })).status).toBe(200);
    expect(hub.engine.people.avatar(alice.id)).toBeTruthy();
    expect((await hub.api('/api/me/avatar', { method: 'DELETE', token: alice.token })).status).toBe(200);
    expect((await hub.api('/api/me/avatar', { token: alice.token })).status).toBe(404);
    expect((await (await hub.api('/api/me', { token: alice.token })).json()).avatarVersion).toBeUndefined();
  });
});
