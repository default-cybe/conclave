/**
 * Maps over HTTP (routes-maps.ts) with the fake Google: Settings > Maps,
 * the key going in and never coming out, the image proxy, the Test button,
 * leave-by times, and a refused Google key that must not read as a bad hub
 * token.
 *
 *   bun test packages/server/test/maps-routes.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createMaps } from '@conclave/core/engine/create.ts';
import { attachMaps, setCalendarPort, type MapsService, type MapsSettingsDto } from '@conclave/core/maps/index.ts';
import { addDays, atLocal, localDate } from '@conclave/core/assistant/time.ts';
import { FAKE_KEY, PLACES, startFakeGoogle, type FakeGoogle } from '../../core/test/maps/fakes';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
let google: FakeGoogle;
let maps: MapsService;

beforeAll(() => {
  google = startFakeGoogle();
  process.env.CONCLAVE_MAPS_GOOGLE_URL = google.url;
  hub = startHub();
  maps = createMaps(hub.engine, hub.engine.config, hub.engine.repos, () => 'Europe/Berlin', 'test');
  attachMaps(hub.engine, maps);
});

afterAll(async () => {
  await hub.stop();
  google.stop();
  delete process.env.CONCLAVE_MAPS_GOOGLE_URL;
});

afterEach(() => {
  google.fail = {};
});

const json = async <T>(r: Response) => (await r.json()) as T;

describe('settings and the key', () => {
  test('needs the hub token', async () => {
    expect((await hub.api('/api/maps', { token: null })).status).toBe(401);
    expect((await hub.api('/api/maps/image/map_0000000000abcdef', { token: null })).status).toBe(401);
  });

  test('OpenStreetMap until a key is saved; the key goes in and never comes back out', async () => {
    const before = await json<MapsSettingsDto>(await hub.api('/api/maps'));
    expect(before).toMatchObject({ provider: 'osm', google: { keySet: false }, mode: 'transit', dailyCap: 300 });
    const bad = await hub.api('/api/maps/key', { method: 'PUT', json: { key: 'nope' } });
    expect(bad.status).toBe(400);
    const put = await hub.api('/api/maps/key', { method: 'PUT', json: { key: FAKE_KEY } });
    const text = await put.text();
    expect(put.status).toBe(200);
    expect(text).not.toContain(FAKE_KEY);
    expect(JSON.parse(text)).toMatchObject({ provider: 'google', google: { keySet: true, keyFrom: 'hub' } });
    // the same place `conclave secret google-maps` writes
    expect(hub.engine.config.storedKey('google-maps')).toBe(FAKE_KEY);
    const cfg = await (await hub.api('/api/config')).text();
    expect(cfg).not.toContain(FAKE_KEY);
    expect(JSON.parse(cfg).secrets.providers).toContain('google-maps');
    const audit = hub.engine.repos.audit.list({ limit: 20 }).map((a) => `${a.action} ${a.detail}`);
    expect(audit).toContain('maps.key set');
    expect(JSON.stringify(audit)).not.toContain(FAKE_KEY);
  });

  test('conclave secret google-maps (PUT /api/secrets) is the same key', async () => {
    await hub.api('/api/maps/key', { method: 'PUT', json: { key: null } });
    expect((await json<MapsSettingsDto>(await hub.api('/api/maps'))).google.keySet).toBe(false);
    await hub.api('/api/secrets', { method: 'PUT', json: { kind: 'providers', key: 'google-maps', value: FAKE_KEY } });
    expect((await json<MapsSettingsDto>(await hub.api('/api/maps'))).google).toEqual({ keySet: true, keyFrom: 'hub' });
  });

  test('home, mode and cap save; a bad value is a 400 in words', async () => {
    const r = await hub.api('/api/maps', { method: 'PATCH', json: { home: 'Torstraße 1, Berlin', mode: 'walk', dailyCap: 50 } });
    expect(r.status).toBe(200);
    const s = await json<MapsSettingsDto>(r);
    expect(s).toMatchObject({ mode: 'walk', dailyCap: 50, home: { address: 'Torstraße 1, 10119 Berlin, Germany', lat: 52.5294, lng: 13.401, zone: 'Europe/Berlin' } });
    expect(hub.engine.config.getUser().maps).toMatchObject({ mode: 'walk', dailyCap: 50 });
    const bad = await hub.api('/api/maps', { method: 'PATCH', json: { mode: 'boat' } });
    expect(bad.status).toBe(400);
    expect(await json<{ error: string; code: string }>(bad)).toEqual({ error: 'mode must be one of walk, transit, drive, bicycle.', code: 'bad_input' });
  });

  test("Google refusing the key is a 502 with plain words, never a 401 that would sign the app out", async () => {
    google.fail.geocode = 'bad_key';
    const r = await hub.api('/api/maps', { method: 'PATCH', json: { home: 'Somewhere 9, Berlin' } });
    expect(r.status).toBe(502);
    const body = await json<{ error: string; code: string }>(r);
    expect(body.code).toBe('bad_key');
    expect(body.error).toBe('Google does not accept the key. Copy it again from the Cloud console, Credentials, and paste it in Settings, Maps.');
  });

  test('the Test button reports each API', async () => {
    google.fail.staticmap = 'disabled';
    const r = await json<{ provider: string; ok: boolean; steps: Array<{ name: string; ok: boolean; message: string }> }>(await hub.api('/api/maps/test', { method: 'POST' }));
    expect(r.provider).toBe('google');
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.name === 'Maps Static API')).toEqual({ api: 'staticmap', name: 'Maps Static API', ok: false, message: "The Maps Static API is not enabled on the key's project. Enable it in the Cloud console, APIs and services." } as never);
    expect(r.steps.filter((s) => s.ok)).toHaveLength(4);
  });
});

describe('the image proxy', () => {
  test('serves the picture the hub fetched, without the key', async () => {
    const m = await maps.mapImage({ markers: [{ at: 'home' }, { at: PLACES[0].id }] });
    const statics = google.requests.filter((r) => r.path === '/maps/api/staticmap').length;
    const r = await hub.api(`/api/maps/image/${m.value.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(1, 4))).toBe('PNG');
    expect(Buffer.from(bytes).includes(Buffer.from(FAKE_KEY))).toBe(false);
    for (const [, v] of r.headers) expect(v).not.toContain(FAKE_KEY);
    // fetched once by the tool; the view is a cache hit
    expect(google.requests.filter((x) => x.path === '/maps/api/staticmap').length).toBe(statics);
  });

  test('unknown maps are 404s, a provider failure is a 502 in words', async () => {
    expect((await hub.api('/api/maps/image/map_0000000000zzzz')).status).toBe(404);
    expect((await hub.api('/api/maps/image/..%2Fsecrets.json')).status).toBe(404);
    // an image whose hour in memory is over: the hub asks Google again, and Google refuses
    const id = 'map_0000000000test1';
    hub.engine.repos.db.query('INSERT INTO maps_items (id, kind, data, created_at) VALUES (?, ?, ?, ?)').run(id, 'image', JSON.stringify({ provider: 'google', width: 300, height: 200, markers: [{ lat: 52.5, lng: 13.4 }], alt: 'x' }), Date.now());
    google.fail.staticmap = 'billing';
    const r = await hub.api(`/api/maps/image/${id}`);
    expect(r.status).toBe(502);
    expect((await json<{ code: string }>(r)).code).toBe('billing');
  });
});

describe('leave-by', () => {
  test('lists travel times for events with a place', async () => {
    await hub.api('/api/maps', { method: 'PATCH', json: { mode: 'transit' } });
    const zone = 'Europe/Berlin';
    const day = addDays(localDate(Date.now(), zone), 1);
    const start = atLocal(day, '12:00', zone);
    setCalendarPort(hub.engine, { eventsBetween: async (a, b) => [{ id: 'e', title: 'Dentist', start, location: 'Rösterei am Kanal' }].filter((e) => e.start >= a && e.start < b) });
    const r = await json<{ date: string; items: Array<{ title: string; leaveByText?: string; mode: string }> }>(await hub.api(`/api/maps/leave-by?date=${day}`));
    expect(r.date).toBe(day);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ title: 'Dentist', mode: 'transit' });
    expect(r.items[0].leaveByText).toMatch(/^11:\d\d$/);
  });
});
