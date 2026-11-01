/**
 * Fake Google Maps Platform and OpenStreetMap servers, in process, for the
 * maps tests and the screenshot run. They answer the paths the real APIs
 * use, apply field masks like Google does, check the key, record every
 * request, and can be told to fail the way the real ones do (billing off,
 * key restricted, API not enabled, bad key, quota, a 429 from Nominatim).
 * Nothing here calls the internet.
 */
import { decodePolyline, fitZoom, metersBetween, worldPx, encodePolyline } from '../../src/maps/geo';
import type { LatLng } from '../../src/maps/types';
import { Canvas, fakeTile, paintGround } from './png';

export const FAKE_KEY = 'AIzaSyFAKE-0123456789abcdefghijklmnopqr';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: any;
  at: number;
}

export type GoogleFailure = 'billing' | 'restricted' | 'disabled' | 'bad_key' | 'quota' | 'referrer';
export type GoogleApi = 'places' | 'routes' | 'geocode' | 'timezone' | 'staticmap';

export interface FakePlace {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  ratings?: number;
  openNow?: boolean;
  price?: string;
  hours?: string[];
}

export const HOME = { address: 'Torstraße 1, 10119 Berlin, Germany', lat: 52.5294, lng: 13.401 };

/** Made-up places around Berlin Mitte. */
export const PLACES: FakePlace[] = [
  { id: 'ChIJlinde0000000000000001', name: 'Café Linde', address: 'Linienstraße 40, 10119 Berlin', lat: 52.5281, lng: 13.4049, rating: 4.6, ratings: 1203, openNow: true, price: 'PRICE_LEVEL_MODERATE', hours: ['Monday: 8:00 AM to 6:00 PM', 'Tuesday: 8:00 AM to 6:00 PM', 'Wednesday: 8:00 AM to 6:00 PM', 'Thursday: 8:00 AM to 6:00 PM', 'Friday: 8:00 AM to 7:00 PM', 'Saturday: 9:00 AM to 7:00 PM', 'Sunday: 9:00 AM to 5:00 PM'] },
  { id: 'ChIJroest0000000000000002', name: 'Rösterei am Kanal', address: 'Fraenkelufer 12, 10999 Berlin', lat: 52.4963, lng: 13.4142, rating: 4.4, ratings: 512, openNow: false, price: 'PRICE_LEVEL_INEXPENSIVE' },
  { id: 'ChIJkiosk0000000000000003', name: 'Kiosk Nord', address: 'Bernauer Straße 63, 13355 Berlin', lat: 52.5369, lng: 13.3976, rating: 4.1, ratings: 88, openNow: true },
];

const PLACE_JSON = (p: FakePlace) => ({
  id: p.id,
  displayName: { text: p.name, languageCode: 'de' },
  formattedAddress: p.address,
  location: { latitude: p.lat, longitude: p.lng },
  ...(p.rating !== undefined ? { rating: p.rating, userRatingCount: p.ratings } : {}),
  ...(p.openNow !== undefined ? { currentOpeningHours: { openNow: p.openNow, ...(p.hours ? { weekdayDescriptions: p.hours } : {}) } } : {}),
  googleMapsUri: `https://maps.google.com/?cid=${p.id.length}${Math.round(p.lat * 1000)}`,
  ...(p.price ? { priceLevel: p.price } : {}),
  // never asked for: a mask that lets this through is too wide
  reviews: [{ text: 'not asked for' }],
  websiteUri: 'https://example.com/not-asked-for',
});

/** Keep only what the field mask names, as Google does. */
function masked(obj: Record<string, any>, mask: string, prefix: string): Record<string, any> {
  const fields = mask.split(',').map((f) => f.trim());
  if (fields.includes('*')) return obj;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) if (fields.some((f) => f === `${prefix}${k}` || f.startsWith(`${prefix}${k}.`))) out[k] = v;
  return out;
}

function googleErrorBody(kind: GoogleFailure, service: string): { status: number; body: unknown } {
  const info = (reason: string) => [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service, consumer: 'projects/123456' } }];
  switch (kind) {
    case 'billing':
      return { status: 403, body: { error: { code: 403, message: 'This API method requires billing to be enabled. Please enable billing on project #123456 by visiting https://console.developers.google.com/billing/enable?project=123456 then retry.', status: 'PERMISSION_DENIED', details: info('BILLING_DISABLED') } } };
    case 'restricted':
      return { status: 403, body: { error: { code: 403, message: `Requests to this API ${service} method are blocked.`, status: 'PERMISSION_DENIED', details: info('API_KEY_SERVICE_BLOCKED') } } };
    case 'referrer':
      return { status: 403, body: { error: { code: 403, message: 'Requests from referer <empty> are blocked.', status: 'PERMISSION_DENIED', details: info('API_KEY_HTTP_REFERRER_BLOCKED') } } };
    case 'disabled':
      return { status: 403, body: { error: { code: 403, message: `${service} has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${service}/overview?project=123456 then retry.`, status: 'PERMISSION_DENIED', details: info('SERVICE_DISABLED') } } };
    case 'bad_key':
      return { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: info('API_KEY_INVALID') } } };
    case 'quota':
      return { status: 429, body: { error: { code: 429, message: 'Quota exceeded for quota metric.', status: 'RESOURCE_EXHAUSTED', details: info('RATE_LIMIT_EXCEEDED') } } };
  }
}

const LEGACY_DENIED: Record<GoogleFailure, { status: string; message: string }> = {
  billing: { status: 'REQUEST_DENIED', message: 'You must enable Billing on the Google Cloud Project at https://console.cloud.google.com/project/_/billing/enable Learn more at https://developers.google.com/maps/gmp-get-started' },
  restricted: { status: 'REQUEST_DENIED', message: 'This API key is not authorized to use this service or API.' },
  referrer: { status: 'REQUEST_DENIED', message: 'API keys with referer restrictions cannot be used with this API.' },
  disabled: { status: 'REQUEST_DENIED', message: 'This API project is not authorized to use this API.' },
  bad_key: { status: 'REQUEST_DENIED', message: 'The provided API key is invalid.' },
  quota: { status: 'OVER_QUERY_LIMIT', message: 'You have exceeded your rate-limit for this API.' },
};

/** A wiggly line between two points, so a route looks like one. */
export function fakePath(a: LatLng, b: LatLng): LatLng[] {
  const mid1 = { lat: a.lat + (b.lat - a.lat) * 0.35, lng: a.lng + (b.lng - a.lng) * 0.1 };
  const mid2 = { lat: a.lat + (b.lat - a.lat) * 0.55, lng: a.lng + (b.lng - a.lng) * 0.6 };
  const mid3 = { lat: a.lat + (b.lat - a.lat) * 0.9, lng: a.lng + (b.lng - a.lng) * 0.75 };
  return [a, mid1, mid2, mid3, b];
}

function pointOf(w: any): LatLng | undefined {
  const ll = w?.location?.latLng;
  if (ll) return { lat: ll.latitude, lng: ll.longitude };
  if (w?.placeId) {
    const p = PLACES.find((x) => x.id === w.placeId);
    return p ? { lat: p.lat, lng: p.lng } : { lat: 52.52, lng: 13.405 };
  }
  if (typeof w?.address === 'string') return geocodeText(w.address)?.point;
  return undefined;
}

function geocodeText(text: string): { label: string; point: LatLng; placeId?: string } | undefined {
  const t = text.toLowerCase();
  if (t.includes('nowhere')) return undefined;
  if (t.includes('torstr')) return { label: HOME.address, point: { lat: HOME.lat, lng: HOME.lng } };
  if (t.includes('london')) return { label: 'London, UK', point: { lat: 51.5072, lng: -0.1276 } };
  const p = PLACES.find((x) => t.includes(x.name.toLowerCase()) || t.includes(x.address.toLowerCase().split(',')[0]));
  if (p) return { label: `${p.name}, ${p.address}`, point: { lat: p.lat, lng: p.lng }, placeId: p.id };
  if (t.includes('brandenburger')) return { label: 'Brandenburger Tor, Pariser Platz, 10117 Berlin, Germany', point: { lat: 52.5163, lng: 13.3777 } };
  // anything else lands near Alexanderplatz, a little off by the text length
  return { label: `${text}, Berlin, Germany`, point: { lat: 52.5219 + (t.length % 7) * 0.001, lng: 13.4132 - (t.length % 5) * 0.002 } };
}

const SPEEDS: Record<string, number> = { WALK: 1.35, BICYCLE: 4.3, DRIVE: 8.5, TRANSIT: 6.5 };

/** Draw a static map like Google's: ground, the path, the markers. */
function staticPng(q: URLSearchParams): Uint8Array {
  const [w, h] = (q.get('size') ?? '600x300').split('x').map(Number);
  const scale = Number(q.get('scale') ?? 1);
  const W = w * scale;
  const H = h * scale;
  const markers = q.getAll('markers').map((m) => {
    const parts = m.split('|');
    const [lat, lng] = parts[parts.length - 1].split(',').map(Number);
    return { lat, lng };
  });
  const pathParam = q.get('path');
  const path = pathParam ? decodePolyline(pathParam.split('enc:')[1] ?? '') : [];
  const pts = [...markers, ...path];
  const z = q.get('zoom') ? Number(q.get('zoom')) : fitZoom(pts, w - 40, h - 40, 17);
  const px = pts.map((p) => worldPx(p, z));
  const cx = pts.length ? (Math.min(...px.map((p) => p.x)) + Math.max(...px.map((p) => p.x))) / 2 : 0;
  const cy = pts.length ? (Math.min(...px.map((p) => p.y)) + Math.max(...px.map((p) => p.y))) / 2 : 0;
  const left = cx - w / 2;
  const top = cy - h / 2;
  const c = new Canvas(W, H, [242, 239, 233]);
  paintGround(c, left, top, scale);
  const at = (p: LatLng) => {
    const q2 = worldPx(p, z);
    return [(q2.x - left) * scale, (q2.y - top) * scale] as const;
  };
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = at(path[i - 1]);
    const [x1, y1] = at(path[i]);
    c.line(x0, y0, x1, y1, 6 * scale, [66, 133, 244]);
  }
  for (const m of markers) {
    const [x, y] = at(m);
    c.disc(x, y - 10 * scale, 9 * scale, [234, 67, 53]);
    c.line(x, y - 10 * scale, x, y, 3 * scale, [234, 67, 53]);
    c.disc(x, y - 10 * scale, 3 * scale, [120, 20, 15]);
  }
  return c.png();
}

export interface FakeGoogle {
  url: string;
  requests: Recorded[];
  /** Fail one API (or all) the way Google does. */
  fail: Partial<Record<GoogleApi | 'all', GoogleFailure>>;
  /** Routes answer with no route. */
  noRoute: boolean;
  stop(): void;
}

export function startFakeGoogle(key = FAKE_KEY): FakeGoogle {
  const requests: Recorded[] = [];
  const state: FakeGoogle = { url: '', requests, fail: {}, noRoute: false, stop: () => server.stop(true) };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const text = req.method === 'POST' ? await req.text() : '';
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, ...(body ? { body } : {}), at: Date.now() });
      const api: GoogleApi = u.pathname.startsWith('/v1/places') ? 'places' : u.pathname.startsWith('/directions') ? 'routes' : u.pathname.includes('geocode') ? 'geocode' : u.pathname.includes('timezone') ? 'timezone' : 'staticmap';
      const service = { places: 'places.googleapis.com', routes: 'routes.googleapis.com', geocode: 'geocoding-backend.googleapis.com', timezone: 'timezone-backend.googleapis.com', staticmap: 'static-maps-backend.googleapis.com' }[api];
      const legacy = api === 'geocode' || api === 'timezone';
      const given = api === 'places' || api === 'routes' ? headers['x-goog-api-key'] : u.searchParams.get('key');
      const failure = state.fail[api] ?? state.fail.all ?? (given === key ? undefined : 'bad_key');
      if (failure) {
        if (legacy) {
          const d = LEGACY_DENIED[failure];
          return Response.json({ status: d.status, error_message: d.message, results: [] });
        }
        if (api === 'staticmap') return new Response(`The Google Maps Platform server rejected your request. ${LEGACY_DENIED[failure].message}`, { status: 403, headers: { 'content-type': 'text/plain' } });
        const e = googleErrorBody(failure, service);
        return Response.json(e.body, { status: e.status });
      }
      const mask = headers['x-goog-fieldmask'] ?? '';
      if ((api === 'places' || api === 'routes') && !mask)
        return Response.json({ error: { code: 400, message: 'FieldMask is a required parameter. See https://cloud.google.com/apis/docs/system-parameters on how to provide it.', status: 'INVALID_ARGUMENT' } }, { status: 400 });

      if (u.pathname === '/v1/places:searchText' || u.pathname === '/v1/places:searchNearby') {
        const q = String(body?.textQuery ?? body?.includedTypes?.[0] ?? '').toLowerCase();
        let list = q.includes('nowhere') ? [] : PLACES.filter((p) => !q.includes('kiosk') || p.name.includes('Kiosk'));
        if (body?.openNow) list = list.filter((p) => p.openNow);
        const n = body?.pageSize ?? body?.maxResultCount ?? 20;
        return Response.json({ places: list.slice(0, n).map((p) => masked(PLACE_JSON(p), mask, 'places.')) });
      }
      if (u.pathname.startsWith('/v1/places/')) {
        const id = decodeURIComponent(u.pathname.slice('/v1/places/'.length));
        const p = PLACES.find((x) => x.id === id);
        if (!p) return Response.json({ error: { code: 404, message: `Place ID ${id} not found.`, status: 'NOT_FOUND' } }, { status: 404 });
        return Response.json(masked(PLACE_JSON(p), mask, ''));
      }
      if (u.pathname === '/directions/v2:computeRoutes') {
        if (state.noRoute) return Response.json({});
        const a = pointOf(body.origin) ?? { lat: HOME.lat, lng: HOME.lng };
        const b = pointOf(body.destination) ?? { lat: 52.52, lng: 13.405 };
        const dist = Math.round(metersBetween(a, b) * 1.3);
        const mode = String(body.travelMode);
        const dur = Math.round(dist / (SPEEDS[mode] ?? 5)) + (mode === 'TRANSIT' ? 300 : 0);
        const route: Record<string, any> = {
          duration: `${mode === 'DRIVE' ? Math.round(dur * 1.25) : dur}s`,
          // Google's static time for transit can differ too; only a drive's gap is traffic
          staticDuration: `${mode === 'TRANSIT' ? dur - 120 : dur}s`,
          distanceMeters: dist,
          polyline: { encodedPolyline: encodePolyline(fakePath(a, b)) },
          description: mode === 'DRIVE' ? 'Torstraße and Karl-Liebknecht-Straße' : 'Linienstraße',
          legs: [
            {
              startLocation: { latLng: { latitude: a.lat, longitude: a.lng } },
              endLocation: { latLng: { latitude: b.lat, longitude: b.lng } },
              steps: mode === 'TRANSIT' ? [{ travelMode: 'WALK' }, { travelMode: 'TRANSIT', transitDetails: { transitLine: { nameShort: 'U8', name: 'U-Bahn U8' } } }, { travelMode: 'TRANSIT', transitDetails: { transitLine: { nameShort: 'M10', name: 'Tram M10' } } }] : [],
            },
          ],
          // never asked for
          travelAdvisory: { tollInfo: {} },
        };
        const keep = mask.split(',').map((f) => f.trim().replace(/^routes\./, ''));
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(route)) if (keep.some((f) => f === k || f.startsWith(`${k}.`))) out[k] = v;
        return Response.json({ routes: [out] });
      }
      if (u.pathname === '/maps/api/geocode/json') {
        const g = geocodeText(u.searchParams.get('address') ?? '');
        if (!g) return Response.json({ status: 'ZERO_RESULTS', results: [] });
        return Response.json({ status: 'OK', results: [{ formatted_address: g.label, geometry: { location: { lat: g.point.lat, lng: g.point.lng } }, ...(g.placeId ? { place_id: g.placeId } : {}) }] });
      }
      if (u.pathname === '/maps/api/timezone/json') {
        const [, lng] = (u.searchParams.get('location') ?? '0,0').split(',').map(Number);
        return Response.json({ status: 'OK', timeZoneId: lng < 2 ? 'Europe/London' : 'Europe/Berlin', timeZoneName: 'x', rawOffset: 0, dstOffset: 0 });
      }
      if (u.pathname === '/maps/api/staticmap') return new Response(staticPng(u.searchParams) as unknown as BodyInit, { headers: { 'content-type': 'image/png' } });
      return new Response('not found', { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  return state;
}

// ---------------------------------------------------------------------------
// OpenStreetMap: Nominatim, OSRM and tiles on one server
// ---------------------------------------------------------------------------

export interface FakeOsm {
  url: string;
  tileUrl: string;
  requests: Recorded[];
  /** Answer Nominatim with a 429, as it does past its limit. */
  refuse: boolean;
  stop(): void;
}

const OSM_PLACES = [
  { osm_type: 'node', osm_id: 1001, name: 'Café Linde', lat: '52.5281', lon: '13.4049', display_name: 'Café Linde, Linienstraße 40, Mitte, 10119 Berlin, Deutschland', extratags: { opening_hours: 'Mo-Fr 08:00-18:00; Sa,Su 09:00-17:00', website: 'https://example.org/linde' } },
  { osm_type: 'way', osm_id: 2002, name: 'Rösterei am Kanal', lat: '52.4963', lon: '13.4142', display_name: 'Rösterei am Kanal, Fraenkelufer 12, Kreuzberg, 10999 Berlin, Deutschland', extratags: {} },
];

export function startFakeOsm(): FakeOsm {
  const requests: Recorded[] = [];
  const state: FakeOsm = { url: '', tileUrl: '', requests, refuse: false, stop: () => server.stop(true) };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, at: Date.now() });
      if (u.pathname === '/search' || u.pathname === '/lookup') {
        if (state.refuse) return new Response('Too many requests', { status: 429 });
        const q = (u.searchParams.get('q') ?? '').toLowerCase();
        if (u.pathname === '/lookup') {
          const id = u.searchParams.get('osm_ids') ?? '';
          return Response.json(OSM_PLACES.filter((p) => `${p.osm_type[0].toUpperCase()}${p.osm_id}` === id));
        }
        if (q.includes('nowhere')) return Response.json([]);
        if (q.includes('torstr')) return Response.json([{ osm_type: 'node', osm_id: 7, lat: String(HOME.lat), lon: String(HOME.lng), display_name: 'Torstraße 1, Mitte, 10119 Berlin, Deutschland', name: '' }]);
        if (q.includes('brandenburger')) return Response.json([{ osm_type: 'way', osm_id: 518071791, lat: '52.5163', lon: '13.3777', display_name: 'Brandenburger Tor, Pariser Platz, Mitte, Berlin, 10117, Deutschland', name: 'Brandenburger Tor' }]);
        const named = OSM_PLACES.filter((p) => q.includes(p.name.toLowerCase()));
        return Response.json((named.length ? named : OSM_PLACES).map(({ extratags: _e, ...p }) => p).slice(0, Number(u.searchParams.get('limit') ?? 10)));
      }
      const r = /^\/route\/v1\/[a-z]+\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)$/.exec(u.pathname);
      if (r) {
        const a = { lat: Number(r[2]), lng: Number(r[1]) };
        const b = { lat: Number(r[4]), lng: Number(r[3]) };
        const distance = metersBetween(a, b) * 1.3;
        return Response.json({ code: 'Ok', routes: [{ duration: distance / 8.5, distance, geometry: encodePolyline(fakePath(a, b)), weight: 1 }], waypoints: [] });
      }
      const t = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u.pathname);
      if (t) return new Response(fakeTile(Number(t[1]), Number(t[2]), Number(t[3])) as unknown as BodyInit, { headers: { 'content-type': 'image/png' } });
      return new Response('not found', { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.tileUrl = `${state.url}/tiles/{z}/{x}/{y}.png`;
  return state;
}
