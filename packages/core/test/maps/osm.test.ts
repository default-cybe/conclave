/**
 * OpenStreetMap as the maps provider, against the fake Nominatim, OSRM and
 * tile server: the User-Agent and contact email its policies ask for, one
 * Nominatim call a second, cards without ratings or hours, routes with
 * honest notes, and map images drawn on the hub with the attribution.
 *
 *   bun test packages/core/test/maps/osm.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OsmProvider, OSM_DEFAULTS } from '../../src/maps/osm';
import { MapsError } from '../../src/maps/types';
import { startFakeOsm, type FakeOsm } from './fakes';
import { makeMaps, type MapsFixture } from './helpers';
import { tempHome } from '../memory/helpers';

let f: MapsFixture | undefined;
let extra: FakeOsm | undefined;
afterEach(() => {
  f?.cleanup();
  extra?.stop();
  f = undefined;
  extra = undefined;
});

function osmMaps(over: Record<string, unknown> = {}) {
  const fx = makeMaps({ key: null });
  fx.setConfig({ ...fx.config(), ...over });
  return fx;
}

describe('politeness', () => {
  test('every call names Conclave and the owner, and Nominatim gets the email too', async () => {
    f = osmMaps();
    await f.maps.searchPlaces({ query: 'coffee' });
    await f.maps.directions({ to: 'Café Linde', mode: 'drive' });
    await f.maps.mapImage({ markers: [{ at: 'home' }] });
    expect(f.google.requests).toHaveLength(0);
    for (const r of f.osm.requests) expect(r.headers['user-agent']).toBe('Conclave/test (self-hosted assistant hub; owner@example.org)');
    const searches = f.osm.requests.filter((r) => r.path === '/search');
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) expect(s.query).toMatchObject({ format: 'jsonv2', email: 'owner@example.org' });
    expect(f.osm.requests.some((r) => r.path.startsWith('/tiles/'))).toBe(true);
  });

  test('the public servers need a contact email first, and nothing is sent without one', async () => {
    f = makeMaps({ key: null, config: { osm: {} } });
    const err = (await f.maps.searchPlaces({ query: 'coffee' }).catch((e) => e)) as MapsError;
    expect(err.code).toBe('bad_input');
    expect(err.message).toBe("Add a contact email in Settings, Maps. OpenStreetMap's public servers ask every app for one, so they can reach you before blocking it.");
    expect(f.all()).toHaveLength(0);
    expect(f.maps.settings().osm).toEqual({ nominatimUrl: OSM_DEFAULTS.nominatimUrl, osrmUrl: OSM_DEFAULTS.osrmUrl, tileUrl: OSM_DEFAULTS.tileUrl, publicServers: true });
  });

  test('Nominatim gets at most one call a second by default', async () => {
    extra = startFakeOsm();
    const home = tempHome();
    const p = new OsmProvider(
      { fetch: fetch.bind(globalThis), take: () => {}, userAgent: () => 'Conclave/test (x@example.org)' },
      { nominatimUrl: () => extra!.url, osrmUrl: () => extra!.url, tileUrl: () => extra!.tileUrl, email: () => 'x@example.org', tileDir: join(home.dir, 't') },
    );
    await Promise.all([p.geocode('Torstraße 1'), p.geocode('Brandenburger Tor'), p.search({ text: 'coffee', radiusMeters: 1000, limit: 2 })]);
    const at = extra.requests.map((r) => r.at);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(1000);
    home.cleanup();
  });

  test('a 429 from Nominatim reads as plain words', async () => {
    f = osmMaps();
    f.osm.refuse = true;
    const err = (await f.maps.searchPlaces({ query: 'coffee' }).catch((e) => e)) as MapsError;
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/^127\.0\.0\.1:\d+ refused the call \(HTTP 429\)\. The public OpenStreetMap servers are for light use/);
  });
});

describe('places', () => {
  test('cards leave out ratings, hours and price, and links open by coordinates', async () => {
    f = osmMaps();
    const a = await f.maps.searchPlaces({ query: 'coffee', near: 'home' });
    expect(a.card).toMatchObject({ kind: 'places', provider: 'osm', links: 'google', attribution: '© OpenStreetMap contributors' });
    const linde = a.value[0];
    expect(linde).toEqual({
      id: 'osm:N1001',
      name: 'Café Linde',
      address: 'Linienstraße 40, Mitte, 10119 Berlin, Deutschland',
      lat: 52.5281,
      lng: 13.4049,
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=52.5281%2C13.4049',
      directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=52.5281%2C13.4049&travelmode=transit',
      distanceMeters: linde.distanceMeters,
    });
    expect(a.text).toContain('(OpenStreetMap: no ratings or opening hours)');
    const search = f.osm.requests.find((r) => r.path === '/search')!;
    expect(search.query.viewbox).toBeDefined();
    expect(search.query.bounded).toBeUndefined();

    f.setConfig({ ...f.config(), links: 'apple' });
    const apple = await f.maps.searchPlaces({ type: 'cafe' });
    expect(apple.value[0].mapsUrl).toBe('https://maps.apple.com/?ll=52.5281%2C13.4049&q=Caf%C3%A9+Linde');
    expect(apple.value[0].directionsUrl).toBe('https://maps.apple.com/?daddr=52.5281%2C13.4049&dirflg=r');
    expect(f.osm.requests.filter((r) => r.path === '/search').pop()!.query).toMatchObject({ q: 'cafe', bounded: '1' });
  });

  test('details: the hours tag goes to the model with a warning, never to the card', async () => {
    f = osmMaps();
    const d = await f.maps.placeDetails('osm:N1001');
    expect(f.osm.requests.find((r) => r.path === '/lookup')!.query).toMatchObject({ osm_ids: 'N1001', extratags: '1' });
    expect(d.text).toContain('Hours as tagged in OpenStreetMap, may be out of date: Mo-Fr 08:00-18:00; Sa,Su 09:00-17:00');
    expect(d.text).toContain('Website: https://example.org/linde');
    expect(d.value).not.toHaveProperty('hours');
    expect(d.value).not.toHaveProperty('openNow');
    expect(await f.maps.placeDetails('N1001').catch((e) => e.code)).toBe('bad_input');
  });
});

describe('routes', () => {
  test('a drive goes through OSRM; a walk without a foot router is worked out from the distance', async () => {
    f = osmMaps();
    const drive = await f.maps.directions({ to: 'Rösterei am Kanal', mode: 'drive' });
    const osrm = f.osm.requests.find((r) => r.path.startsWith('/route/v1/'))!;
    expect(osrm.path).toBe('/route/v1/driving/13.401,52.5294;13.4142,52.4963');
    expect(osrm.query).toMatchObject({ overview: 'full', geometries: 'polyline' });
    expect(drive.value).toMatchObject({ mode: 'drive', note: 'No traffic data.' });
    expect(drive.value.trafficSec).toBeUndefined();
    const walk = await f.maps.directions({ to: 'Rösterei am Kanal', mode: 'walk' });
    expect(walk.value.durationSec).toBe(Math.round(walk.value.distanceMeters / (4.8 / 3.6)));
    expect(walk.value.note).toBe('Walking time worked out from the road distance at 4.8 km/h.');
  });

  test('transit becomes a walk, and the card says so', async () => {
    f = osmMaps();
    const r = await f.maps.directions({ to: 'Café Linde', arriveBy: '2099-01-02 09:00' });
    expect(r.value).toMatchObject({ mode: 'walk', asked: 'transit', arriveText: '09:00' });
    expect(r.value.note).toContain('OpenStreetMap has no public transport times, so this is the walking time.');
    expect(r.text).toStartWith('Walk from Home to Café Linde:');
    expect(r.value.directionsUrl).toContain('travelmode=walking');
  });

  test('a foot router, when set, gives real walking times', async () => {
    extra = startFakeOsm();
    f = osmMaps();
    f.setConfig({ ...f.config(), osm: { ...f.config().osm, osrmWalkUrl: extra.url } });
    const r = await f.maps.directions({ to: 'Café Linde', mode: 'walk' });
    expect(extra.requests.filter((x) => x.path.startsWith('/route/'))).toHaveLength(1);
    expect(r.value.note).toBeUndefined();
  });
});

describe('map images', () => {
  test('drawn on the hub as SVG from week-cached tiles, with the attribution', async () => {
    f = osmMaps();
    const r = await f.maps.directions({ to: 'Rösterei am Kanal', mode: 'bicycle' });
    const m = await f.maps.mapImage({ route: r.value.id, width: 400, height: 240 });
    const img = await f.maps.imageBytes(m.value.id);
    expect(img.type).toBe('image/svg+xml');
    const svg = new TextDecoder().decode(img.bytes);
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"');
    expect(svg).toContain('© OpenStreetMap contributors');
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain('stroke="#2f6fde"');
    expect(svg).not.toMatch(/href="https?:/);
    expect(svg).toContain(`<title>Map of the bicycle route from Home to Rösterei am Kanal</title>`);
    const tiles = f.osm.requests.filter((x) => x.path.startsWith('/tiles/'));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(6);
    const t = tiles[0].path.split('/');
    expect(existsSync(join(f.tileDir, t[2], t[3], t[4]))).toBe(true);
    // the same area again: every tile from disk
    await f.maps.mapImage({ route: r.value.id, width: 400, height: 240 });
    expect(f.osm.requests.filter((x) => x.path.startsWith('/tiles/'))).toHaveLength(tiles.length);
    // one counted call per image, not per tile
    expect(f.maps.settings().today.byApi.staticmap).toBe(2);
  });

  test('tiles older than a week leave the disk, so the tile folder does not grow for ever', async () => {
    f = osmMaps();
    // a tile from an area viewed once, a month ago
    const old = join(f.tileDir, '3', '1', '1.png');
    mkdirSync(join(f.tileDir, '3', '1'), { recursive: true });
    writeFileSync(old, 'png');
    const month = (Date.now() - 30 * 86_400_000) / 1000;
    utimesSync(old, month, month);
    const r = await f.maps.directions({ to: 'Rösterei am Kanal', mode: 'bicycle' });
    await f.maps.mapImage({ route: r.value.id, width: 400, height: 240 });
    for (let i = 0; i < 40 && existsSync(old); i++) await Bun.sleep(25);
    expect(existsSync(old)).toBe(false);
    // the tiles just fetched stay
    const t = f.osm.requests.find((x) => x.path.startsWith('/tiles/'))!.path.split('/');
    expect(existsSync(join(f.tileDir, t[2], t[3], t[4]))).toBe(true);
  });

  test('labels are escaped and a dead tile server fails in plain words', async () => {
    f = osmMaps();
    f.setConfig({ ...f.config(), osm: { ...f.config().osm, tileUrl: 'http://127.0.0.1:9/{z}/{x}/{y}.png' } });
    const err = (await f.maps.mapImage({ markers: [{ at: '52.5,13.4', label: '<' }] }).catch((e) => e)) as MapsError;
    expect(err).toBeInstanceOf(MapsError);
    expect(err.message).toBe('Could not load map tiles from 127.0.0.1:9. Check that the hub can reach it.');
  });

  test('the Test button checks Nominatim, OSRM and the tiles', async () => {
    f = osmMaps();
    const t = await f.maps.test();
    expect(t.provider).toBe('osm');
    expect(t.ok).toBe(true);
    expect(t.steps.map((s) => [s.name, s.ok])).toEqual([
      ['Nominatim search', true],
      ['OSRM routing', true],
      ['OpenStreetMap tiles', true],
    ]);
  });
});

describe('Google test button', () => {
  test('one call per API, each in plain words', async () => {
    f = makeMaps();
    f.google.fail.routes = 'restricted';
    const t = await f.maps.test();
    expect(t.ok).toBe(false);
    expect(t.steps.map((s) => [s.name, s.ok])).toEqual([
      ['Geocoding API', true],
      ['Places API (New)', true],
      ['Routes API', false],
      ['Time Zone API', true],
      ['Maps Static API', true],
    ]);
    expect(t.steps[2].message).toBe("The key is restricted and does not allow the Routes API. In the Cloud console, Credentials, add it to the key's API restrictions.");
  });
});
