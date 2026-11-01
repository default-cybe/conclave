/**
 * Paired apps (GET /api/clients, app.updated): a phone pairs with a code as
 * an app, not as a device, so the page that showed the code (setup's
 * Devices step, Devices) learns about it from app.updated, with its
 * platform, and sees it connect, go away and be revoked.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AppDto } from '@conclave/core/client/index.ts';
import { eventAccount } from '@conclave/core/people/events.ts';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

const wsUrl = (token: string) => `${hub.url.replace('http', 'ws')}/api/ws?token=${token}`;
const apps = async (): Promise<AppDto[]> => hub.api('/api/clients').then((r) => r.json());

describe('a phone paired with a code', () => {
  test('shows up at once as an app with its platform, online while it is connected', async () => {
    // found in a real setup: the Android app paired from setup step 8, and the step kept waiting for the phone
    const owner = await openWs(wsUrl(OWNER));
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const paired = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'Pixel 8', platform: 'android' } }).then((r) => r.json());
    const added = await owner.next((f) => f.type === 'app.updated' && f.app.id === paired.clientId);
    expect(added.app).toMatchObject({ name: 'Pixel 8', platform: 'android', revoked: false, online: false, accountId: 'owner' });
    // not a device: sessions never pick a phone to run on
    expect(hub.engine.repos.devices.list().some((d) => d.name === 'Pixel 8')).toBe(false);
    expect((await apps()).find((a) => a.id === paired.clientId)).toMatchObject({ name: 'Pixel 8', platform: 'android', online: false });

    const phone = await openWs(wsUrl(paired.token));
    expect((await owner.next((f) => f.type === 'app.updated' && f.app.id === paired.clientId)).app.online).toBe(true);
    expect((await apps()).find((a) => a.id === paired.clientId)?.online).toBe(true);
    phone.close();
    expect((await owner.next((f) => f.type === 'app.updated' && f.app.id === paired.clientId)).app.online).toBe(false);

    // the hub token's own sockets are not an app
    expect(owner.frames.some((f) => f.type === 'app.updated' && f.app.id === 'owner')).toBe(false);

    expect((await hub.api(`/api/clients/${paired.clientId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await owner.next((f) => f.type === 'app.updated' && f.app.id === paired.clientId)).app.revoked).toBe(true);
    owner.close();
  });

  test("another person's phone is theirs: its event goes to them, and the owner does not list it", async () => {
    const made = await hub.api('/api/people', { method: 'POST', json: { name: 'riley', password: 'a long enough password' } }).then((r) => r.json());
    const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'riley', password: 'a long enough password', name: 'Riley laptop', platform: 'web' } }).then((r) => r.json());
    const code = await hub.api('/api/pairing', { method: 'POST', token: login.token, json: { kind: 'client' } }).then((r) => r.json());
    const phone = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: code.code, name: 'iPhone', platform: 'ios' } }).then((r) => r.json());
    const theirs: AppDto[] = await hub.api('/api/clients', { token: login.token }).then((r) => r.json());
    expect(theirs.map((a) => a.name).sort()).toEqual(['Riley laptop', 'iPhone']);
    expect((await apps()).some((a) => a.id === phone.clientId)).toBe(false);
    // the hub's bus sends an event to the account it names (people/events.ts)
    const app = theirs.find((a) => a.id === phone.clientId)!;
    expect(eventAccount({ type: 'app.updated', app }, { session: () => undefined })).toBe(made.person.id);

    // the owner sees them in People and can sign one out; another person's app answers as an unknown one
    const listed: AppDto[] = await hub.api(`/api/people/${made.person.id}/clients`).then((r) => r.json());
    expect(listed.map((a) => a.name).sort()).toEqual(['Riley laptop', 'iPhone']);
    const own = (await apps())[0];
    expect((await hub.api(`/api/people/${made.person.id}/clients/${own.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await hub.api(`/api/people/${made.person.id}/clients/${phone.clientId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await hub.api(`/api/people/${made.person.id}/clients/${phone.clientId}`, { method: 'DELETE' })).status).toBe(404);
    const after: AppDto[] = await hub.api('/api/clients', { token: login.token }).then((r) => r.json());
    expect(after.find((a) => a.id === phone.clientId)?.revoked).toBe(true);
    // /api/clients/:id is each account's own: the owner's app answers a member as an unknown one
    expect((await hub.api(`/api/clients/${own.id}`, { method: 'DELETE', token: login.token })).status).toBe(404);
    // a member sees nobody's apps through People, theirs included
    expect((await hub.api(`/api/people/${made.person.id}/clients`, { token: login.token })).status).toBe(403);
  });
});
