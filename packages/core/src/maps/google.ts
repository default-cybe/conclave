/**
 * Google Maps Platform: Places API (New) text and nearby search and place
 * details, Routes API computeRoutes, Geocoding, Time Zone and the Maps
 * Static API. Every request asks only for the fields a card or the model
 * uses (field masks). The key goes in the X-Goog-Api-Key header where the
 * API takes it, and in the query string for the three older APIs; it never
 * appears in a result, an error or a log line.
 */
import { decodePolyline, encodePolyline, pointText, thinPoints } from './geo';
import type { Geocoded, MapsProvider, ProviderEnv, ProviderRoute, RawPlace, RouteRequest, SearchQuery, Waypoint } from './provider';
import { seconds } from './provider';
import type { LatLng, MapImageSpec, MapsApi, MapsTestStep } from './types';
import { MapsError } from './types';

export const GOOGLE_HOSTS = {
  places: 'https://places.googleapis.com',
  routes: 'https://routes.googleapis.com',
  maps: 'https://maps.googleapis.com',
};

/** Only what PlaceCard and the model's text use: name, address, location, rating, hours, link, price. */
export const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'currentOpeningHours', 'googleMapsUri', 'priceLevel'];
export const SEARCH_MASK = PLACE_FIELDS.map((f) => `places.${f}`).join(',');
export const DETAILS_MASK = PLACE_FIELDS.join(',');
/** Duration with and without traffic, distance, the line to draw, the ends, and transit lines. */
export const ROUTE_MASK = [
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.description',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.name',
].join(',');

export const API_NAMES: Record<MapsApi, string> = {
  places: 'Places API (New)',
  routes: 'Routes API',
  geocode: 'Geocoding API',
  timezone: 'Time Zone API',
  staticmap: 'Maps Static API',
  nominatim: 'Nominatim search',
  osrm: 'OSRM routing',
  tiles: 'OpenStreetMap tiles',
};

const TRAVEL: Record<string, string> = { walk: 'WALK', transit: 'TRANSIT', drive: 'DRIVE', bicycle: 'BICYCLE' };
const PRICE: Record<string, number> = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

type Json = Record<string, any>;

/**
 * Google's answer as plain words. New APIs send error.details[].reason;
 * the older ones send status and error_message; the Static API sends text.
 */
export function googleError(api: MapsApi, status: number, body: unknown): MapsError {
  const name = API_NAMES[api];
  const b = (body && typeof body === 'object' ? body : {}) as Json;
  const reasons: string[] = Array.isArray(b.error?.details) ? b.error.details.map((d: Json) => String(d?.reason ?? '')).filter(Boolean) : [];
  const text = [typeof body === 'string' ? body : '', b.error?.message, b.error?.status, b.error_message, b.errorMessage, b.status].filter((x) => typeof x === 'string').join(' ');
  const has = (r: string) => reasons.includes(r);

  if (has('BILLING_DISABLED') || /billing/i.test(text))
    return new MapsError('billing', `Billing is not enabled on the key's Google Cloud project, so the ${name} refuses calls. Turn on billing for the project in the Cloud console, set a budget alert, then press Test again.`, 402);
  if (has('API_KEY_HTTP_REFERRER_BLOCKED') || has('API_KEY_IP_ADDRESS_BLOCKED') || has('API_KEY_ANDROID_APP_BLOCKED') || has('API_KEY_IOS_APP_BLOCKED') || /referer restrictions|IP, site or mobile application is not authorized|requests from referer/i.test(text))
    return new MapsError('restricted', `The key only works from some websites, apps or addresses, and the hub is not one of them. Set the key's application restriction to None, or to the hub's IP address. Keep the API restrictions.`, 403);
  if (has('API_KEY_SERVICE_BLOCKED') || /key is not authorized to use this service|requests to this API .* are blocked/i.test(text))
    return new MapsError('restricted', `The key is restricted and does not allow the ${name}. In the Cloud console, Credentials, add it to the key's API restrictions.`, 403);
  if (has('SERVICE_DISABLED') || has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /project is not authorized to use this API|has not been used in project|is disabled|not enabled/i.test(text))
    return new MapsError('disabled', `The ${name} is not enabled on the key's project. Enable it in the Cloud console, APIs and services.`, 403);
  if (has('API_KEY_INVALID') || /API key not valid|provided API key is invalid|invalid api key/i.test(text))
    return new MapsError('bad_key', 'Google does not accept the key. Copy it again from the Cloud console, Credentials, and paste it in Settings, Maps.', 401);
  if (status === 429 || has('RATE_LIMIT_EXCEEDED') || /RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT|quota/i.test(text))
    return new MapsError('quota', `Google's quota for the ${name} is used up for now. Try again later, or raise the quota in the Cloud console.`, 429);
  if (/OVER_DAILY_LIMIT/.test(text)) return new MapsError('billing', `Google refused the ${name}: billing is off, the key is not valid, or a daily quota set on the project is used up.`, 402);
  if (status === 400 || /INVALID_ARGUMENT|INVALID_REQUEST/.test(text)) {
    const detail = typeof b.error?.message === 'string' ? ` Google says: ${b.error.message.slice(0, 200)}` : '';
    return new MapsError('bad_input', `The ${name} did not accept the request.${detail}`, 400);
  }
  if (status === 404 || /NOT_FOUND/.test(text)) return new MapsError('not_found', `The ${name} found nothing for that.`, 404);
  return new MapsError('error', `The ${name} answered with an error (HTTP ${status}). Try again in a minute.`, 502);
}

function lat(v: Json | undefined): LatLng | undefined {
  const ll = v?.latLng ?? v;
  return typeof ll?.latitude === 'number' && typeof ll?.longitude === 'number' ? { lat: ll.latitude, lng: ll.longitude } : undefined;
}

function place(p: Json): RawPlace | undefined {
  const at = lat(p.location);
  if (!p.id || !at) return undefined;
  return {
    id: String(p.id),
    name: String(p.displayName?.text ?? p.formattedAddress ?? 'Unnamed place'),
    ...(p.formattedAddress ? { address: String(p.formattedAddress) } : {}),
    lat: at.lat,
    lng: at.lng,
    ...(typeof p.rating === 'number' ? { rating: p.rating } : {}),
    ...(typeof p.userRatingCount === 'number' ? { ratings: p.userRatingCount } : {}),
    ...(typeof p.currentOpeningHours?.openNow === 'boolean' ? { openNow: p.currentOpeningHours.openNow } : {}),
    ...(Array.isArray(p.currentOpeningHours?.weekdayDescriptions) ? { hours: p.currentOpeningHours.weekdayDescriptions.map(String) } : {}),
    ...(typeof p.priceLevel === 'string' && p.priceLevel in PRICE ? { price: PRICE[p.priceLevel] } : {}),
    ...(p.googleMapsUri ? { googleUri: String(p.googleMapsUri) } : {}),
  };
}

function waypoint(w: Waypoint): Json {
  if (w.point) return { location: { latLng: { latitude: w.point.lat, longitude: w.point.lng } } };
  if (w.placeId) return { placeId: w.placeId };
  return { address: w.address ?? '' };
}

export interface GoogleOptions {
  key: () => string | undefined;
  /** One base URL for every Google API, for a fake server in tests. */
  base?: () => string | undefined;
}

export class GoogleProvider implements MapsProvider {
  readonly id = 'google' as const;
  readonly attribution = undefined;

  constructor(
    private env: ProviderEnv,
    private opts: GoogleOptions,
  ) {}

  private host(kind: keyof typeof GOOGLE_HOSTS): string {
    return (this.opts.base?.() || GOOGLE_HOSTS[kind]).replace(/\/+$/, '');
  }

  private key(): string {
    const k = this.opts.key();
    if (!k) throw new MapsError('no_key', 'No Google Maps key is set. Paste one in Settings, Maps, or run conclave secret google-maps. Or switch the provider to OpenStreetMap.', 400);
    return k;
  }

  /** One call: counted, with a time limit, and errors in plain words without the key. */
  private async call(api: MapsApi, url: string, init: RequestInit, want: 'json' | 'bytes' = 'json'): Promise<{ json?: Json; bytes?: Uint8Array; type?: string }> {
    this.env.take(api);
    let res: Response;
    try {
      res = await this.env.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      const timeout = (err as Error)?.name === 'TimeoutError';
      throw new MapsError('network', timeout ? `The ${API_NAMES[api]} did not answer within 15 seconds.` : `Could not reach the ${API_NAMES[api]}. Check that the hub can reach the internet.`, 504);
    }
    if (want === 'bytes' && res.ok) {
      const type = res.headers.get('content-type') ?? 'image/png';
      if (type.startsWith('image/')) return { bytes: new Uint8Array(await res.arrayBuffer()), type };
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* the Static API answers errors in text */
    }
    if (!res.ok) throw googleError(api, res.status, body);
    const json = (body && typeof body === 'object' ? body : {}) as Json;
    // the older APIs answer 200 with a status field
    if (typeof json.status === 'string' && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') throw googleError(api, res.status, json);
    if (want === 'bytes') throw googleError(api, res.status, body);
    return { json };
  }

  private post(api: MapsApi, url: string, mask: string, body: unknown) {
    return this.call(api, url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key(), 'x-goog-fieldmask': mask }, body: JSON.stringify(body) });
  }

  async search(q: SearchQuery): Promise<RawPlace[]> {
    const circle = q.near ? { circle: { center: { latitude: q.near.lat, longitude: q.near.lng }, radius: Math.min(50_000, q.radiusMeters) } } : undefined;
    let res;
    if (!q.text && q.type && circle) {
      // Nearby Search: places of a type around a point, closest first
      res = await this.post('places', `${this.host('places')}/v1/places:searchNearby`, SEARCH_MASK, { includedTypes: [q.type], maxResultCount: q.limit, locationRestriction: circle, rankPreference: 'DISTANCE' });
    } else {
      const textQuery = q.text ?? q.type ?? '';
      res = await this.post('places', `${this.host('places')}/v1/places:searchText`, SEARCH_MASK, {
        textQuery,
        pageSize: q.limit,
        ...(circle ? { locationBias: circle } : {}),
        ...(q.openNow ? { openNow: true } : {}),
        ...(q.text && q.type ? { includedType: q.type } : {}),
      });
    }
    const list = Array.isArray(res.json?.places) ? (res.json!.places as Json[]) : [];
    const out = list.map(place).filter((p): p is RawPlace => !!p);
    return q.openNow ? out.filter((p) => p.openNow !== false) : out;
  }

  async details(id: string): Promise<RawPlace> {
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(id)) throw new MapsError('bad_input', 'That is not a Google place id. Use the id PlaceSearch gave.', 400);
    const res = await this.call('places', `${this.host('places')}/v1/places/${encodeURIComponent(id)}`, { method: 'GET', headers: { 'x-goog-api-key': this.key(), 'x-goog-fieldmask': DETAILS_MASK } });
    const p = place(res.json ?? {});
    if (!p) throw new MapsError('not_found', 'Google has no place with that id.', 404);
    return p;
  }

  async geocode(text: string): Promise<Geocoded | undefined> {
    const q = new URLSearchParams({ address: text, key: this.key() });
    const res = await this.call('geocode', `${this.host('maps')}/maps/api/geocode/json?${q}`, { method: 'GET' });
    const r = Array.isArray(res.json?.results) ? (res.json!.results[0] as Json | undefined) : undefined;
    const at = r?.geometry?.location;
    if (!r || typeof at?.lat !== 'number' || typeof at?.lng !== 'number') return undefined;
    return { label: String(r.formatted_address ?? text), lat: at.lat, lng: at.lng, ...(r.place_id ? { placeId: String(r.place_id) } : {}) };
  }

  async route(req: RouteRequest): Promise<ProviderRoute> {
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    const body: Json = {
      origin: waypoint(req.from),
      destination: waypoint(req.to),
      travelMode: TRAVEL[req.mode],
      computeAlternativeRoutes: false,
      units: 'METRIC',
    };
    if (req.mode === 'drive') body.routingPreference = 'TRAFFIC_AWARE';
    // an arrival time is a transit option only; a drive asks for its departure so traffic counts
    if (req.mode === 'transit' && req.arriveBy && req.arriveBy > now) body.arrivalTime = iso(req.arriveBy);
    else if ((req.mode === 'transit' || req.mode === 'drive') && req.departAt && req.departAt > now + 60_000) body.departureTime = iso(req.departAt);
    else if (req.mode === 'drive' && req.arriveBy && req.arriveBy - 30 * 60_000 > now + 60_000) body.departureTime = iso(req.arriveBy - 30 * 60_000);
    const res = await this.post('routes', `${this.host('routes')}/directions/v2:computeRoutes`, ROUTE_MASK, body);
    const r = Array.isArray(res.json?.routes) ? (res.json!.routes[0] as Json | undefined) : undefined;
    if (!r) throw new MapsError('no_route', req.mode === 'transit' ? 'Google found no public transport route for that trip and time. Try another time or mode.' : 'Google found no route between those places.', 404);
    const legs = Array.isArray(r.legs) ? (r.legs as Json[]) : [];
    const lines: string[] = [];
    for (const leg of legs)
      for (const step of Array.isArray(leg.steps) ? (leg.steps as Json[]) : []) {
        const line = step.transitDetails?.transitLine;
        const name = line?.nameShort ?? line?.name;
        if (name && !lines.includes(String(name))) lines.push(String(name));
      }
    const start = lat(legs[0]?.startLocation);
    const end = lat(legs[legs.length - 1]?.endLocation);
    return {
      durationSec: seconds(r.duration),
      ...(r.staticDuration ? { staticDurationSec: seconds(r.staticDuration) } : {}),
      distanceMeters: typeof r.distanceMeters === 'number' ? r.distanceMeters : 0,
      ...(r.polyline?.encodedPolyline ? { polyline: String(r.polyline.encodedPolyline) } : {}),
      ...(lines.length ? { summary: lines.join(', ') } : r.description ? { summary: `via ${r.description}` } : {}),
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    };
  }

  async timezone(p: LatLng, at: number): Promise<string | undefined> {
    const q = new URLSearchParams({ location: pointText(p), timestamp: String(Math.floor(at / 1000)), key: this.key() });
    const res = await this.call('timezone', `${this.host('maps')}/maps/api/timezone/json?${q}`, { method: 'GET' });
    return typeof res.json?.timeZoneId === 'string' ? res.json.timeZoneId : undefined;
  }

  /** The Static API URL for a spec, key included: built at fetch time on the hub and never stored or sent on. */
  staticUrl(spec: MapImageSpec): string {
    const q = new URLSearchParams({ size: `${Math.min(640, spec.width)}x${Math.min(640, spec.height)}`, scale: '2', maptype: 'roadmap' });
    if (spec.zoom) q.set('zoom', String(spec.zoom));
    else if (spec.markers.length === 1 && !spec.path) q.set('zoom', '15');
    for (const m of spec.markers) q.append('markers', `color:0xd6453d|${m.label ? `label:${m.label.toUpperCase()}|` : ''}${pointText(m)}`);
    if (spec.path) q.append('path', `color:0x2f6fdecc|weight:5|enc:${encodePolyline(thinPoints(decodePolyline(spec.path), 300))}`);
    q.set('key', this.key());
    return `${this.host('maps')}/maps/api/staticmap?${q}`;
  }

  async image(spec: MapImageSpec): Promise<{ bytes: Uint8Array; type: string }> {
    const res = await this.call('staticmap', this.staticUrl(spec), { method: 'GET' }, 'bytes');
    return { bytes: res.bytes!, type: res.type! };
  }

  async test(near?: LatLng): Promise<MapsTestStep[]> {
    const steps: MapsTestStep[] = [];
    const step = async (api: MapsApi, fn: () => Promise<string>) => {
      try {
        steps.push({ api, name: API_NAMES[api], ok: true, message: await fn() });
      } catch (err) {
        steps.push({ api, name: API_NAMES[api], ok: false, message: err instanceof MapsError ? err.message : 'Failed for an unknown reason.' });
      }
    };
    let at = near;
    await step('geocode', async () => {
      const g = await this.geocode('Brandenburger Tor, Berlin');
      if (!g) return 'Works. It found nothing for the test address, which is fine.';
      at ??= g;
      return `Works. Found ${g.label}.`;
    });
    const point = at ?? { lat: 52.5163, lng: 13.3777 };
    await step('places', async () => {
      const list = await this.search({ text: 'coffee', near: point, radiusMeters: 2000, limit: 1 });
      return list.length ? `Works. Found ${list[0].name}.` : 'Works. No coffee nearby, which is fine.';
    });
    await step('routes', async () => {
      const r = await this.route({ from: { point }, to: { point: { lat: point.lat + 0.005, lng: point.lng + 0.005 } }, mode: 'walk' });
      return `Works. A short walk takes ${Math.max(1, Math.round(r.durationSec / 60))} min.`;
    });
    await step('timezone', async () => `Works. The zone there is ${(await this.timezone(point, Date.now())) ?? 'unknown'}.`);
    await step('staticmap', async () => {
      const img = await this.image({ provider: 'google', width: 100, height: 100, markers: [{ ...point }], alt: 'Test' });
      return `Works. Got a ${Math.round(img.bytes.length / 1024)} KB image.`;
    });
    return steps;
  }
}
