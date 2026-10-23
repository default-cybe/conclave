/**
 * The offer to import a computer's chats when it pairs (import/offers.ts,
 * docs/DESIGN.md 38): a first pairing marks the device, its first time online
 * scans it, chats found open one offer (Inbox, notification, the import.offer
 * event), nothing found opens none. Once per device: dismissed, imported and
 * re-paired devices are not asked again, and a member's device is offered to
 * that member only. The scan itself is a stub here; ImportService.newChats is
 * the real one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ImportOffer, ImportSource } from '@conclave/core/client/import.ts';
import type { Notice } from '@conclave/core/types.ts';
import { ImportOffers } from '@conclave/core/import/offers.ts';
import { attachImport, attachImportOffers } from '@conclave/core/import/registry.ts';
import type { ImportService } from '@conclave/core/import/service.ts';
import { FakeMachine, waitFor } from '../../core/test/machine/fake-machine';
import { RateLimiter } from '../src/auth';
import { startHub, type TestHub } from './helpers';

const PW = 'a long enough password';
let hub: TestHub;
let offers: ImportOffers;
/** What the stub scan finds per device name. */
const found = new Map<string, Partial<Record<ImportSource, number>>>();
const scans: string[] = [];
const notices: Array<Omit<Notice, 'id' | 'createdAt'>> = [];
const events: Array<{ device: string; offer?: ImportOffer; accountId: string }> = [];

beforeAll(() => {
  hub = startHub();
  const name = (id: string) => hub.engine.registry.list().find((d) => d.id === id)?.name ?? id;
  offers = new ImportOffers({
    kv: hub.engine.repos.kv,
    bus: hub.engine.bus,
    notify: (n) => notices.push(n),
    deviceName: name,
    count: async (device) => {
      scans.push(device);
      return found.get(name(device)) ?? {};
    },
  }).start();
  attachImportOffers(hub.engine, offers);
  // the batch route needs a service; it records nothing here
  attachImport(hub.engine, { startBatch: async (input: { device: string }) => ({ id: 'imp_1', device: input.device, mode: 'chats', status: 'importing', total: 1 }) } as unknown as ImportService);
  hub.engine.bus.on((e) => {
    if (e.type === 'import.offer') events.push({ device: e.device, offer: e.offer, accountId: e.accountId });
  });
});
afterAll(() => {
  offers.stop();
  return hub.stop();
});
beforeEach(() => {
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
});

async function pair(name: string, token?: string): Promise<string> {
  const code = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' }, ...(token ? { token } : {}) }).then((r) => r.json());
  const res = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: code.code, name } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { deviceId: string }).deviceId;
}

/** The daemon connects: the device comes online. */
function online(id: string, name: string) {
  hub.engine.registry.attach({ id, name, online: true, roots: [], createdAt: Date.now() }, new FakeMachine(id, name));
}

function offline(id: string) {
  hub.engine.registry.detach(id);
}

const list = async (token?: string) => (await hub.api('/api/import/offers', token ? { token } : {}).then((r) => r.json())) as ImportOffer[];

describe('a computer that pairs for the first time', () => {
  test('chats found: one offer in the Inbox, a notification and an event; nothing is imported', async () => {
    found.set('studio', { 'claude-code': 9, codex: 3 });
    const id = await pair('studio');
    // registered, not online yet: no scan
    expect(scans).not.toContain(id);
    expect(offers.state(id)).toBe('pending');
    online(id, 'studio');
    await waitFor(() => offers.state(id) === 'open');
    const [offer] = await list();
    expect(offer).toMatchObject({ device: id, deviceName: 'studio', chats: 12, sources: { 'claude-code': 9, codex: 3 } });
    expect(offer.text).toBe('Found 12 chats from Claude Code and Codex on studio. Import them?');
    expect(notices.at(-1)).toMatchObject({ body: offer.text, level: 'info', link: `/sessions?import=${id}`, accountId: 'owner' });
    expect(events.at(-1)).toMatchObject({ device: id, accountId: 'owner', offer: { chats: 12 } });
  });

  test('once: coming online again does not scan or offer again; dismiss closes it for good', async () => {
    const id = (await list())[0].device;
    const before = scans.length;
    offline(id);
    online(id, 'studio');
    await Bun.sleep(20);
    expect(scans.length).toBe(before);
    expect(await list()).toHaveLength(1);

    expect((await hub.api(`/api/import/offers/${id}/dismiss`, { method: 'POST' })).status).toBe(200);
    expect(events.at(-1)).toEqual({ device: id, accountId: 'owner', offer: undefined });
    expect(await list()).toEqual([]);
    expect(offers.state(id)).toBe('dismissed');
    // a second dismiss has nothing to close
    expect((await hub.api(`/api/import/offers/${id}/dismiss`, { method: 'POST' })).status).toBe(404);
    offline(id);
    online(id, 'studio');
    await Bun.sleep(20);
    expect(await list()).toEqual([]);
  });

  test('an import from the device answers its offer', async () => {
    found.set('laptop', { gemini: 1 });
    const id = await pair('laptop');
    online(id, 'laptop');
    await waitFor(() => offers.state(id) === 'open');
    expect((await list()).find((o) => o.device === id)?.text).toBe('Found 1 chat from Gemini CLI on laptop. Import it?');
    const r = await hub.api('/api/import/batches', { method: 'POST', json: { device: id, mode: 'chats', query: {} } });
    expect(r.status).toBe(200);
    expect(offers.state(id)).toBe('imported');
    expect((await list()).find((o) => o.device === id)).toBeUndefined();
  });

  test('nothing to bring: no offer, and the device is not asked later', async () => {
    const id = await pair('empty-box');
    online(id, 'empty-box');
    await waitFor(() => offers.state(id) === 'empty');
    expect((await list()).find((o) => o.device === id)).toBeUndefined();
    found.set('empty-box', { codex: 4 });
    offline(id);
    online(id, 'empty-box');
    await Bun.sleep(20);
    expect(offers.state(id)).toBe('empty');
  });

  test('a device the hub already knew is never offered', async () => {
    found.set('old-pc', { 'claude-code': 2 });
    hub.engine.repos.devices.insert({ id: 'dev_old', name: 'old-pc', tokenHash: 'x', roots: [] });
    online('dev_old', 'old-pc');
    await Bun.sleep(20);
    expect(offers.state('dev_old')).toBeUndefined();
    expect(scans).not.toContain('dev_old');
  });

  test('the desktop app pairing its computer again keeps the device, and it is not asked again', async () => {
    const code = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const app = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: code.code, name: 'Desktop', platform: 'desktop' } }).then((r) => r.json());
    const register = async () => {
      const dc = await hub.api('/api/daemon/pairing', { method: 'POST', token: app.token }).then((r) => r.json());
      return (await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: dc.code, name: 'desk' } }).then((r) => r.json())).deviceId as string;
    };
    found.set('desk', { codex: 2 });
    const id = await register();
    online(id, 'desk');
    await waitFor(() => offers.state(id) === 'open');
    expect((await hub.api(`/api/import/offers/${id}/dismiss`, { method: 'POST' })).status).toBe(200);
    offline(id);
    // the switch off and on again: the same device with a new token
    expect(await register()).toBe(id);
    online(id, 'desk');
    await Bun.sleep(20);
    expect(offers.state(id)).toBe('dismissed');
    expect((await list()).find((o) => o.device === id)).toBeUndefined();
  });

  test('removing the device closes its offer', async () => {
    found.set('gone', { codex: 2 });
    const id = await pair('gone');
    online(id, 'gone');
    await waitFor(() => offers.state(id) === 'open');
    expect((await hub.api(`/api/devices/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(offers.state(id)).toBeUndefined();
    expect((await list()).find((o) => o.device === id)).toBeUndefined();
  });
});

describe("a member's computer", () => {
  test('is offered to that member only', async () => {
    const made = await hub.api('/api/people', { method: 'POST', json: { name: 'alice', password: PW } }).then((r) => r.json());
    const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: PW, name: 'phone' } }).then((r) => r.json());
    const alice = { id: made.person.id as string, token: login.token as string };
    found.set('alice-laptop', { 'claude-code': 5 });
    const id = await pair('alice-laptop', alice.token);
    online(id, 'alice-laptop');
    await waitFor(() => offers.state(id) === 'open');
    expect((await list(alice.token)).map((o) => o.device)).toEqual([id]);
    expect((await list()).find((o) => o.device === id)).toBeUndefined();
    expect(notices.at(-1)).toMatchObject({ accountId: alice.id });
    expect(events.at(-1)).toMatchObject({ device: id, accountId: alice.id });
    // the owner cannot dismiss it for her
    expect((await hub.api(`/api/import/offers/${id}/dismiss`, { method: 'POST' })).status).toBe(404);
    expect((await hub.api(`/api/import/offers/${id}/dismiss`, { method: 'POST', token: alice.token })).status).toBe(200);
    expect(await list(alice.token)).toEqual([]);
  });
});
