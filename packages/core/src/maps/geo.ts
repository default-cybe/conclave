/**
 * Small geometry for maps: encoded polylines (precision 5, as Google and
 * OSRM send them), distances, web mercator pixels, "lat,lng" parsing and
 * the links that open a place or directions in Google Maps or Apple Maps.
 */
import type { LatLng, MapsLinkApp, TravelMode } from './types';

/** Decode an encoded polyline (precision 5). */
export function decodePolyline(s: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < s.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    if (i >= s.length) break;
    lng += next();
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/** Encode points as a polyline (precision 5). */
export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let plat = 0;
  let plng = 0;
  const put = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    put(lat - plat);
    put(lng - plng);
    plat = lat;
    plng = lng;
  }
  return out;
}

/** Fewer points for a long route, so a map URL stays short: every nth point, ends kept. */
export function thinPoints(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: LatLng[] = [];
  for (let k = 0; k < max; k++) out.push(points[Math.round(k * step)]);
  return out;
}

/** Great circle distance in metres. */
export function metersBetween(a: LatLng, b: LatLng): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "52.52,13.405" or "52.52, 13.405" as a point, else undefined. */
export function parseLatLng(s: string): LatLng | undefined {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return undefined;
  return { lat, lng };
}

export function validPoint(p: unknown): p is LatLng {
  const x = p as LatLng;
  return !!x && typeof x.lat === 'number' && typeof x.lng === 'number' && Number.isFinite(x.lat) && Number.isFinite(x.lng) && Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180;
}

/** "52.52,13.405": six decimals at most. */
export function pointText(p: LatLng): string {
  const f = (n: number) => String(Math.round(n * 1e6) / 1e6);
  return `${f(p.lat)},${f(p.lng)}`;
}

// ---------------------------------------------------------------------------
// web mercator
// ---------------------------------------------------------------------------

export const TILE = 256;

/** World pixel of a point at a zoom level. */
export function worldPx(p: LatLng, z: number): { x: number; y: number } {
  const size = TILE * 2 ** z;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

/** The highest zoom (up to max) at which every point fits inside w by h pixels. */
export function fitZoom(points: LatLng[], w: number, h: number, max = 17): number {
  if (points.length <= 1) return Math.min(max, 15);
  for (let z = max; z > 1; z--) {
    const px = points.map((p) => worldPx(p, z));
    const dx = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x));
    const dy = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y));
    if (dx <= w && dy <= h) return z;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

const GOOGLE_MODE: Record<TravelMode, string> = { walk: 'walking', transit: 'transit', drive: 'driving', bicycle: 'bicycling' };
const APPLE_MODE: Record<TravelMode, string> = { walk: 'w', transit: 'r', drive: 'd', bicycle: 'c' };

/** Opens a place by its coordinates, named. Google Maps takes its place id too when there is one. */
export function placeLink(app: MapsLinkApp, p: LatLng & { name?: string; googleId?: string }): string {
  if (app === 'apple') {
    const q = new URLSearchParams({ ll: pointText(p), ...(p.name ? { q: p.name } : {}) });
    return `https://maps.apple.com/?${q}`;
  }
  const q = new URLSearchParams({ api: '1', query: pointText(p), ...(p.googleId ? { query_place_id: p.googleId } : {}) });
  return `https://www.google.com/maps/search/?${q}`;
}

/** Directions to a point, from where the phone is unless `from` is given. */
export function directionsLink(app: MapsLinkApp, to: LatLng & { googleId?: string }, mode: TravelMode, from?: LatLng): string {
  if (app === 'apple') {
    const q = new URLSearchParams({ daddr: pointText(to), dirflg: APPLE_MODE[mode], ...(from ? { saddr: pointText(from) } : {}) });
    return `https://maps.apple.com/?${q}`;
  }
  const q = new URLSearchParams({ api: '1', destination: pointText(to), travelmode: GOOGLE_MODE[mode], ...(to.googleId ? { destination_place_id: to.googleId } : {}), ...(from ? { origin: pointText(from) } : {}) });
  return `https://www.google.com/maps/dir/?${q}`;
}
