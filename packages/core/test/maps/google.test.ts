/**
 * Google as the maps provider, against the fake Google in this folder:
 * field masks ask only for what the cards use, the key travels in a header
 * (or the query of the three older APIs) and nowhere else, request bodies
 * match the Routes and Places APIs, and every failure reads as plain words.
 *
 *   bun test packages/core/test/maps/google.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DETAILS_MASK, ROUTE_MASK, SEARCH_MASK, googleError } from '../../src/maps/google';
import { MapsError } from '../../src/maps/types';
import { FAKE_KEY, PLACES, type GoogleApi, type GoogleFailure } from './fakes';
import { makeMaps, type MapsFixture } from './helpers';

let f: MapsFixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
});

describe('field masks', () => {
  test('search and details ask for the card fields and nothing else', async () => {
    f = makeMaps();
    expect(SEARCH_MASK.split(',').sort()).toEqual(['places.currentOpeningHours', 'places.displayName', 'places.formattedAddress', 'places.googleMapsUri', 'places.id', 'places.location', 'places.priceLevel', 'places.rating', 'places.userRatingCount']);
    expect(DETAILS_MASK).toBe(SEARCH_MASK.replace(/places\./g, ''));
    const a = await f.maps.searchPlaces({ query: 'coffee', near: 'home' });
    const req = f.google.requests.find((r) => r.path === '/v1/places:searchText')!;
    expect(req.headers['x-goog-fieldmask']).toBe(SEARCH_MASK);
    expect(req.body).toMatchObject({ textQuery: 'coffee', pageSize: 5, locationBias: { circle: { center: { latitude: 52.5294, longitude: 13.401 }, radius: 1500 } } });
    // the fake drops what the mask leaves out, like Google: the cards still have every field
    const linde = a.value.find((p) => p.name === 'Café Linde')!;
    expect(linde).toMatchObject({ rating: 4.6, ratings: 1203, openNow: true, price: 2, address: 'Linienstraße 40, 10119 Berlin' });
    expect(linde.mapsUrl).toStartWith('https://maps.google.com/?cid=');
    expect(linde.directionsUrl).toBe(`https://www.google.com/maps/dir/?api=1&destination=52.5281%2C13.4049&travelmode=transit&destination_place_id=${PLACES[0].id}`);
    expect(linde.distanceMeters).toBeGreaterThan(200);
    expect(JSON.stringify(a.card)).not.toContain('not asked for');

    await f.maps.placeDetails(PLACES[0].id);
    const d = f.google.requests.find((r) => r.path.startsWith('/v1/places/ChIJ'))!;
    expect(d.method).toBe('GET');
    expect(d.headers['x-goog-fieldmask']).toBe(DETAILS_MASK);
  });

  test('a type around a point is a Nearby Search, closest first', async () => {
    f = makeMaps();
    await f.maps.searchPlaces({ type: 'pharmacy', limit: 3 });
    const req = f.google.requests.find((r) => r.path === '/v1/places:searchNearby')!;
    expect(req.headers['x-goog-fieldmask']).toBe(SEARCH_MASK);
    expect(req.body).toEqual({ includedTypes: ['pharmacy'], maxResultCount: 3, locationRestriction: { circle: { center: { latitude: 52.5294, longitude: 13.401 }, radius: 1500 } }, rankPreference: 'DISTANCE' });
  });

  test('near a named place searches around that place, and two places do not share a cached answer', async () => {
    f = makeMaps();
    await f.maps.searchPlaces({ query: 'coffee', near: 'Kreuzberg, Berlin' });
    const first = f.google.requests.filter((r) => r.path === '/v1/places:searchText');
    expect(first).toHaveLength(1);
    expect((first[0].body as { locationBias?: unknown }).locationBias).toMatchObject({ circle: { radius: 1500 } });
    await f.maps.searchPlaces({ query: 'coffee', near: 'Prenzlauer Berg, Berlin' });
    const both = f.google.requests.filter((r) => r.path === '/v1/places:searchText');
    expect(both).toHaveLength(2);
    expect(JSON.stringify((both[1].body as { locationBias?: unknown }).locationBias)).not.toBe(JSON.stringify((both[0].body as { locationBias?: unknown }).locationBias));
    // a kind of place around a named place is a Nearby Search there
    await f.maps.searchPlaces({ type: 'pharmacy', near: 'Kreuzberg, Berlin' });
    expect(f.google.requests.some((r) => r.path === '/v1/places:searchNearby')).toBe(true);
  });

  test('routes ask for duration, traffic, distance, the line, the ends and transit lines', async () => {
    f = makeMaps();
    expect(ROUTE_MASK.split(',')).toEqual([
      'routes.duration',
      'routes.staticDuration',
      'routes.distanceMeters',
      'routes.polyline.encodedPolyline',
      'routes.description',
      'routes.legs.startLocation',
      'routes.legs.endLocation',
      'routes.legs.steps.transitDetails.transitLine.nameShort',
      'routes.legs.steps.transitDetails.transitLine.name',
    ]);
    const r = await f.maps.directions({ to: PLACES[1].id, mode: 'transit' });
    const req = f.google.requests.find((x) => x.path === '/directions/v2:computeRoutes')!;
    expect(req.headers['x-goog-fieldmask']).toBe(ROUTE_MASK);
    expect(r.value.summary).toBe('U8, M10');
    expect(JSON.stringify(r)).not.toContain('tollInfo');
  });
});

describe('the key', () => {
  test('goes in X-Goog-Api-Key for Places and Routes, in the query for the older APIs, never in a body', async () => {
    f = makeMaps();
    await f.maps.searchPlaces({ query: 'coffee' });
    await f.maps.directions({ from: 'Torstraße 1', to: 'Café Linde', mode: 'walk' });
    await f.maps.mapImage({ markers: [{ at: 'home' }] });
    await f.maps.patch({ home: 'Torstraße 1, Berlin' });
    const byPath = (p: string) => f!.google.requests.filter((r) => r.path.startsWith(p));
    for (const r of [...byPath('/v1/places'), ...byPath('/directions')]) {
      expect(r.headers['x-goog-api-key']).toBe(FAKE_KEY);
      expect(r.query.key).toBeUndefined();
      expect(JSON.stringify(r.body ?? {})).not.toContain(FAKE_KEY);
    }
    for (const r of [...byPath('/maps/api/geocode'), ...byPath('/maps/api/timezone'), ...byPath('/maps/api/staticmap')]) expect(r.query.key).toBe(FAKE_KEY);
    expect(byPath('/maps/api/timezone')).toHaveLength(1);
    expect(f.config().home).toMatchObject({ address: 'Torstraße 1, 10119 Berlin, Germany', zone: 'Europe/Berlin' });
  });

  test('without a key the hub uses OpenStreetMap; a chosen Google without one says how to add it', async () => {
    f = makeMaps({ key: null });
    expect(f.maps.providerId()).toBe('osm');
    expect(f.maps.settings().google).toEqual({ keySet: false });
    f.setConfig({ ...f.config(), provider: 'google' });
    const err = await f.maps.searchPlaces({ query: 'coffee' }).catch((e) => e);
    expect(err).toBeInstanceOf(MapsError);
    expect(err.code).toBe('no_key');
    expect(err.message).toContain('conclave secret google-maps');
    expect(f.google.requests).toHaveLength(0);
  });

  test('a saved key turns Google on, and settings never show it', async () => {
    f = makeMaps({ key: null });
    expect(() => f!.maps.setKey('not a key')).toThrow('does not look like a Google API key');
    const s = f.maps.setKey(`  ${FAKE_KEY}  `);
    expect(f.key()).toBe(FAKE_KEY);
    expect(s.provider).toBe('google');
    expect(s.google).toEqual({ keySet: true, keyFrom: 'hub' });
    expect(JSON.stringify(s)).not.toContain(FAKE_KEY);
    expect(f.maps.setKey(null).google.keySet).toBe(false);
  });
});

describe('requests', () => {
  test('a drive asks for traffic; transit takes an arrival time; walk takes neither', async () => {
    f = makeMaps();
    const drive = await f.maps.directions({ to: 'Rösterei am Kanal', mode: 'drive' });
    const transit = await f.maps.directions({ to: PLACES[1].id, mode: 'transit', arriveBy: '2099-01-02 18:00' });
    await f.maps.directions({ to: PLACES[2].id, mode: 'walk', arriveBy: '2099-01-02 18:00' });
    const reqs = f.google.requests.filter((r) => r.path === '/directions/v2:computeRoutes').map((r) => r.body);
    expect(reqs[0]).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', origin: { location: { latLng: { latitude: 52.5294, longitude: 13.401 } } }, destination: { address: 'Rösterei am Kanal' } });
    // a place id from a search goes as its point, so Google needs no lookup
    expect(reqs[1]).toMatchObject({ travelMode: 'TRANSIT', destination: { location: { latLng: { latitude: PLACES[1].lat, longitude: PLACES[1].lng } } } });
    expect(reqs[1].arrivalTime).toBe('2099-01-02T17:00:00.000Z');
    expect(reqs[1].routingPreference).toBeUndefined();
    expect(reqs[2]).not.toHaveProperty('arrivalTime');
    expect(reqs[2]).not.toHaveProperty('departureTime');
    expect(reqs[2]).not.toHaveProperty('routingPreference');
    // traffic: the fake's drive takes a quarter longer than without traffic
    expect(drive.value.trafficSec).toBeGreaterThan(0);
    expect(drive.text).toContain('Traffic adds');
    // a transit time's static twin says nothing about traffic
    expect(transit.value.trafficSec).toBeUndefined();
    expect(transit.value.leaveByText).toBe(transit.value.departText);
    expect(transit.value.arriveText).toBe('18:00');
    expect(transit.text).toContain(`Leave by ${transit.value.leaveByText} to arrive at 18:00.`);
  });

  test('a far destination gets its own local arrival time from the Time Zone API', async () => {
    f = makeMaps();
    const r = await f.maps.directions({ to: 'London', mode: 'drive' });
    expect(r.value.arriveLocal).toMatch(/^\d\d:\d\d Europe\/London$/);
    expect(f.google.requests.filter((x) => x.path === '/maps/api/timezone/json')).toHaveLength(1);
  });
});

describe('errors in plain words', () => {
  const cases: Array<[GoogleFailure, RegExp, string]> = [
    ['billing', /Billing is not enabled on the key's Google Cloud project/, 'billing'],
    ['restricted', /The key is restricted and does not allow the/, 'restricted'],
    ['referrer', /only works from some websites, apps or addresses/, 'restricted'],
    ['disabled', /is not enabled on the key's project/, 'disabled'],
    ['bad_key', /Google does not accept the key/, 'bad_key'],
    ['quota', /quota for the .* is used up/, 'quota'],
  ];
  const apis: Array<[GoogleApi, (m: MapsFixture) => Promise<unknown>, string]> = [
    ['places', (m) => m.maps.searchPlaces({ query: 'coffee' }), 'Places API (New)'],
    ['routes', (m) => m.maps.directions({ to: PLACES[0].id, mode: 'walk' }), 'Routes API'],
    ['geocode', (m) => m.maps.patch({ home: 'Somewhere 5, Berlin' }), 'Geocoding API'],
    ['staticmap', (m) => m.maps.mapImage({ markers: [{ at: 'home' }] }), 'Maps Static API'],
  ];
  for (const [kind, words, code] of cases)
    for (const [api, call, name] of apis) {
      // the Static API only says "rejected" in text, so the quota case has no words for it
      if (api === 'staticmap' && kind === 'quota') continue;
      test(`${api}: ${kind}`, async () => {
        f = makeMaps();
        f.google.fail[api] = kind;
        const err = (await call(f).catch((e) => e)) as MapsError;
        expect(err).toBeInstanceOf(MapsError);
        expect(err.code).toBe(code as MapsError['code']);
        expect(err.message).toMatch(words);
        if (kind === 'billing' || kind === 'restricted' || kind === 'disabled') expect(err.message).toContain(name);
        expect(err.message).not.toContain(FAKE_KEY);
        expect(err.message).not.toContain('http');
      });
    }

  test('the error mapper never repeats a key Google echoes', () => {
    const e = googleError('places', 400, { error: { code: 400, message: `bad ${FAKE_KEY}`, status: 'INVALID_ARGUMENT' } });
    expect(e.code).toBe('bad_input');
    // the service scrubs what a mapper passes through
    f = makeMaps();
    expect(f.maps.scrub(e.message)).not.toContain(FAKE_KEY);
  });

  test('no route, nothing found and a network failure', async () => {
    f = makeMaps();
    f.google.noRoute = true;
    expect(await f.maps.directions({ to: PLACES[0].id, mode: 'transit' }).catch((e) => e.message)).toContain('no public transport route');
    const none = await f.maps.searchPlaces({ query: 'nowhere at all' });
    expect(none.text).toBe('No places found for "nowhere at all".');
    expect(await f.maps.patch({ home: 'nowhere' }).catch((e) => e.message)).toContain('Could not find "nowhere"');
    f.google.stop();
    const err = (await f.maps.searchPlaces({ query: 'tea' }).catch((e) => e)) as MapsError;
    expect(err.code).toBe('network');
    expect(err.message).toBe('Could not reach the Places API (New). Check that the hub can reach the internet.');
  });
});
