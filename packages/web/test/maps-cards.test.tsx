/**
 * Maps cards (src/features/maps): the data a result carries, a place's
 * facts with Google and without them on OpenStreetMap, a route's words,
 * the phone's tool line for maps calls, and the cards as HTML: links that
 * open the maps app, a map picture that comes from the hub, never a
 * provider URL.
 *
 *   bun test packages/web/test/maps-cards.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MapsCardData, PlaceCard, RouteCard } from '@conclave/core/client';
import { MapsCard } from '../src/features/maps/MapsCard';
import { mapsCardOf, mapsDoneWords, mapsLineWords, mapsRowTarget, placeFacts, routeExtra, routeHeadline, routeTimes, routeWhere } from '../src/features/maps/words';
import { toolLine, toolRowWords, workingWords } from '../src/lib/toolLine';

const google: PlaceCard = {
  id: 'ChIJlinde0000000000000001',
  name: 'Café Linde',
  address: 'Linienstraße 40, 10119 Berlin',
  lat: 52.5281,
  lng: 13.4049,
  rating: 4.6,
  ratings: 1203,
  openNow: true,
  price: 2,
  mapsUrl: 'https://maps.google.com/?cid=1',
  directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=52.5281%2C13.4049&travelmode=transit',
  distanceMeters: 340,
};
const osm: PlaceCard = { id: 'osm:N1001', name: 'Café Linde', address: 'Linienstraße 40, Mitte', lat: 52.5281, lng: 13.4049, mapsUrl: 'https://maps.apple.com/?ll=52.5281%2C13.4049&q=Caf%C3%A9+Linde', directionsUrl: 'https://maps.apple.com/?daddr=52.5281%2C13.4049&dirflg=r' };
const route: RouteCard = {
  id: 'route_1',
  from: { label: 'Home', lat: 52.5294, lng: 13.401 },
  to: { label: 'Café Linde', lat: 52.5281, lng: 13.4049 },
  mode: 'transit',
  durationSec: 24 * 60,
  distanceMeters: 5130,
  departAt: 0,
  arriveAt: 0,
  leaveBy: 0,
  departText: '17:36',
  arriveText: '18:00',
  leaveByText: '17:36',
  zone: 'Europe/Berlin',
  summary: 'U8, M10',
  directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=52.5281%2C13.4049&travelmode=transit',
};

describe('card data', () => {
  test('only a well formed card from a result that did not fail', () => {
    const card: MapsCardData = { kind: 'places', provider: 'google', links: 'google', places: [google] };
    expect(mapsCardOf({ meta: { maps: card } })).toBe(card);
    expect(mapsCardOf({ meta: { maps: card }, isError: true })).toBeUndefined();
    expect(mapsCardOf({ meta: { maps: { kind: 'places', places: [] } } })).toBeUndefined();
    expect(mapsCardOf({ meta: { maps: { kind: 'route' } } })).toBeUndefined();
    expect(mapsCardOf(undefined)).toBeUndefined();
  });

  test('Google places show rating, open now and price; OpenStreetMap places show none', () => {
    expect(placeFacts(google)).toEqual([{ text: '4.6 stars (1,203)' }, { text: 'Open now', tone: 'ok' }, { text: '$$' }]);
    expect(placeFacts({ ...google, openNow: false, price: 0 })).toEqual([{ text: '4.6 stars (1,203)' }, { text: 'Closed now', tone: 'dim' }, { text: 'Free' }]);
    expect(placeFacts(osm)).toEqual([]);
  });

  test('a route in words', () => {
    expect(routeHeadline(route)).toBe('24 min by transit');
    expect(routeTimes(route)).toBe('Leave by 17:36, arrive 18:00');
    expect(routeTimes({ ...route, leaveByText: undefined, departText: '17:12', arriveText: '17:36' })).toBe('Leaving 17:12, arriving 17:36');
    expect(routeWhere(route)).toBe('Home to Café Linde, 5.1 km');
    expect(routeExtra(route)).toBe('U8, M10.');
    expect(routeExtra({ ...route, mode: 'drive', summary: 'via Torstraße', trafficSec: 360 })).toBe('Via Torstraße. Traffic adds 6 min.');
    expect(routeExtra({ ...route, mode: 'walk', asked: 'transit', summary: undefined, note: 'OpenStreetMap has no public transport times, so this is the walking time.' })).toBe('OpenStreetMap has no public transport times, so this is the walking time.');
  });

  test('row and line words', () => {
    const places: MapsCardData = { kind: 'places', provider: 'google', links: 'google', places: [google, osm] };
    expect(mapsDoneWords(places)).toBe('2 places');
    expect(mapsDoneWords({ kind: 'route', provider: 'osm', links: 'google', route })).toBe('24 min');
    expect(mapsLineWords('PlaceSearch', { query: 'coffee' }, places)).toBe('Found 2 places for coffee');
    expect(mapsLineWords('PlaceSearch', { type: 'night_pharmacy' }, undefined)).toBe('No places found for night pharmacy');
    expect(mapsLineWords('Directions', { to: 'x' }, { kind: 'route', provider: 'google', links: 'google', route })).toBe('Directions to Café Linde');
    expect(mapsLineWords('MapImage', {}, undefined)).toBe('Drew a map');
    // a done row names what came back, never the ids it was given
    expect(mapsRowTarget({ kind: 'route', provider: 'osm', links: 'google', route }, { to: 'osm:N1001' })).toBe('Home to Café Linde');
    expect(mapsRowTarget(places, { query: 'coffee', near: 'home' })).toBe('coffee near home');
    expect(mapsRowTarget({ kind: 'places', provider: 'google', links: 'google', places: [google] }, { id: google.id })).toBe('Café Linde');
    expect(mapsRowTarget({ kind: 'map', provider: 'osm', image: { id: 'map_1', width: 600, height: 320, alt: 'Map of the walk route from Home to Café Linde' } }, {})).toBe('the walk route from Home to Café Linde');
  });
});

describe('the phone tool line', () => {
  test('maps calls read as plain words', () => {
    const calls = [
      { name: 'PlaceSearch', input: { query: 'coffee', near: 'home' } },
      { name: 'Directions', input: { to: 'ChIJlinde0000000000000001', mode: 'transit' } },
      { name: 'MapImage', input: { route: 'route_1' } },
    ];
    expect(toolLine(calls)).toBe('Looked for coffee, got directions, drew a map');
    expect(toolLine([calls[0], { name: 'PlaceSearch', input: { query: 'tea' } }])).toBe('Looked for places 2 times');
    expect(toolLine([{ name: 'PlaceSearch', input: { type: 'pharmacy' } }])).toBe('Looked for pharmacy');
    expect(toolLine([{ name: 'PlaceSearch', input: {} }])).toBe('Looked for places');
    expect(toolRowWords(calls[1])).toEqual({ verb: 'Directions', target: 'to a place', mono: false });
    expect(toolRowWords({ name: 'Directions', input: { to: 'Bernauer Straße 63' } }).target).toBe('to Bernauer Straße 63');
    expect(workingWords(calls[0])).toBe('Searching places');
    expect(workingWords(calls[2])).toBe('Drawing a map');
  });
});

describe('cards as HTML', () => {
  test('a place card: name, facts, address, Open in Google Maps and Directions', () => {
    const html = renderToStaticMarkup(<MapsCard card={{ kind: 'places', provider: 'google', links: 'google', places: [google] }} />);
    expect(html).toContain('Café Linde');
    expect(html).toContain('4.6 stars (1,203)');
    expect(html).toContain('open now');
    expect(html).toContain('Linienstraße 40, 10119 Berlin');
    expect(html).toContain('340 m');
    expect(html).toContain('>Open in Google Maps</a>');
    expect(html).toContain('href="https://maps.google.com/?cid=1"');
    expect(html).toContain('>Directions</a>');
    expect(html).toContain('target="_blank"');
  });

  test('an OpenStreetMap place: no stars, Apple Maps links, the attribution', () => {
    const html = renderToStaticMarkup(<MapsCard card={{ kind: 'places', provider: 'osm', links: 'apple', places: [osm], attribution: '© OpenStreetMap contributors' }} />);
    expect(html).not.toContain('stars');
    expect(html).not.toContain('open now');
    expect(html).toContain('>Open in Apple Maps</a>');
    expect(html).toContain('© OpenStreetMap contributors');
  });

  test('a route card: time, mode, leave-by, distance and the link', () => {
    const html = renderToStaticMarkup(<MapsCard card={{ kind: 'route', provider: 'google', links: 'google', route }} />);
    expect(html).toContain('24 min by transit');
    expect(html).toContain('Leave by 17:36, arrive 18:00');
    expect(html).toContain('Home to Café Linde, 5.1 km');
    expect(html).toContain('U8, M10.');
    expect(html).toContain('>Open in Google Maps</a>');
  });

  test('a map card holds a place for the picture the hub serves, and no provider URL', () => {
    const html = renderToStaticMarkup(<MapsCard card={{ kind: 'map', provider: 'google', image: { id: 'map_abc', width: 600, height: 320, alt: 'Map of Home, Café Linde' } }} />);
    expect(html).toContain('aspect-ratio:600 / 320');
    expect(html).toContain('Map of Home, Café Linde');
    expect(html).not.toContain('googleapis');
    expect(html).not.toContain('key=');
  });
});
