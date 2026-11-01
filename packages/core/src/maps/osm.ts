/**
 * OpenStreetMap, with no key and no billing: search and geocoding through
 * Nominatim, routes through OSRM, and map images drawn on the hub from OSM
 * tiles. The public servers are run by volunteers for light use, so every
 * call carries a User-Agent with the owner's contact email, Nominatim gets
 * at most one call a second, OSRM the same, tiles two at a time from a
 * week-long disk cache, and the images carry the attribution.
 * Policies: operations.osmfoundation.org/policies/nominatim and /tiles.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodePolyline, fitZoom, metersBetween, TILE, worldPx } from './geo';
import { Gate } from './limits';
import type { Geocoded, MapsProvider, ProviderEnv, ProviderRoute, RawPlace, RouteRequest, SearchQuery } from './provider';
import { API_NAMES } from './google';
import type { LatLng, MapImageSpec, MapsApi, MapsTestStep, TravelMode } from './types';
import { MapsError } from './types';

export const OSM_DEFAULTS = {
  nominatimUrl: 'https://nominatim.openstreetmap.org',
  osrmUrl: 'https://router.project-osrm.org',
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Speeds for a walk or ride worked out from a road distance, when no foot or bike router is set. */
const SPEED_MS: Partial<Record<TravelMode, number>> = { walk: 4.8 / 3.6, bicycle: 15 / 3.6 };
const TILE_TTL_MS = 7 * 86_400_000;

export interface OsmOptions {
  nominatimUrl: () => string;
  osrmUrl: () => string;
  /** OSRM servers with a foot or bike profile. Without one, walk and bicycle times come from the road distance. */
  osrmWalkUrl?: () => string | undefined;
  osrmBicycleUrl?: () => string | undefined;
  tileUrl: () => string;
  /** Contact email for the User-Agent and Nominatim's email parameter. */
  email: () => string | undefined;
  /** Where tiles are kept for a week. */
  tileDir: string;
  /** Spacing between Nominatim calls and between OSRM calls. Default 1100 ms. */
  spacingMs?: number;
}

type Json = Record<string, any>;

/** "osm:N123" from Nominatim's osm_type and osm_id. */
export function osmId(type: unknown, id: unknown): string | undefined {
  const t = String(type ?? '').charAt(0).toUpperCase();
  return 'NWR'.includes(t) && t && /^\d+$/.test(String(id)) ? `osm:${t}${id}` : undefined;
}

function nominatimPlace(r: Json, near?: LatLng): RawPlace | undefined {
  const id = osmId(r.osm_type, r.osm_id);
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const display = String(r.display_name ?? '');
  const name = String(r.name || display.split(',')[0] || 'Unnamed place').trim();
  // the address is the display name without the name it starts with
  const address = display.startsWith(name) ? display.slice(name.length).replace(/^,\s*/, '') : display;
  const tags = (r.extratags ?? {}) as Record<string, string>;
  return {
    id,
    name,
    ...(address ? { address } : {}),
    lat,
    lng,
    ...(tags.opening_hours ? { hours: [tags.opening_hours] } : {}),
    ...(tags.website || tags['contact:website'] ? { website: tags.website || tags['contact:website'] } : {}),
    ...(near ? {} : {}),
  };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export class OsmProvider implements MapsProvider {
  readonly id = 'osm' as const;
  readonly attribution = OSM_ATTRIBUTION;
  private nominatimGate: Gate;
  private osrmGate: Gate;
  private tileGate = new Gate(50, 2);

  constructor(
    private env: ProviderEnv,
    private opts: OsmOptions,
  ) {
    this.nominatimGate = new Gate(opts.spacingMs ?? 1100);
    this.osrmGate = new Gate(opts.spacingMs ?? 1100);
  }

  private base(url: string): string {
    return url.replace(/\/+$/, '');
  }

  /** The public servers want a way to reach whoever runs the app. */
  private contact(url: string): string | undefined {
    const email = this.opts.email()?.trim();
    if (!email && /(^|\.)openstreetmap\.(org|de)$|project-osrm\.org$/.test(hostOf(url)))
      throw new MapsError('bad_input', "Add a contact email in Settings, Maps. OpenStreetMap's public servers ask every app for one, so they can reach you before blocking it.", 400);
    return email || undefined;
  }

  private async get(api: MapsApi, gate: Gate, url: string, accept = 'application/json'): Promise<Response> {
    this.env.take(api);
    return gate.run(async () => {
      let res: Response;
      try {
        res = await this.env.fetch(url, { headers: { 'user-agent': this.env.userAgent(), accept }, signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        const timeout = (err as Error)?.name === 'TimeoutError';
        throw new MapsError('network', timeout ? `${API_NAMES[api]} did not answer within 15 seconds.` : `Could not reach ${hostOf(url)} for ${API_NAMES[api]}. Check that the hub can reach the internet.`, 504);
      }
      if (res.status === 429 || res.status === 403 || res.status === 418)
        throw new MapsError('refused', `${hostOf(url)} refused the call (HTTP ${res.status}). The public OpenStreetMap servers are for light use: wait a few minutes, check the contact email in Settings, Maps, or set your own server there.`, 429);
      if (!res.ok && res.status !== 400) throw new MapsError('error', `${API_NAMES[api]} answered with an error (HTTP ${res.status}). Try again in a minute.`, 502);
      return res;
    });
  }

  private async json(api: MapsApi, gate: Gate, url: string): Promise<unknown> {
    const res = await this.get(api, gate, url);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new MapsError('error', `${API_NAMES[api]} sent something that is not JSON.`, 502);
    }
  }

  private nominatim(path: string, params: Record<string, string>): Promise<unknown> {
    const base = this.base(this.opts.nominatimUrl());
    const email = this.contact(base);
    const q = new URLSearchParams({ ...params, format: 'jsonv2', ...(email ? { email } : {}) });
    return this.json('nominatim', this.nominatimGate, `${base}${path}?${q}`);
  }

  async search(q: SearchQuery): Promise<RawPlace[]> {
    const text = [q.text, q.text ? '' : q.type].filter(Boolean).join(' ').trim();
    if (!text) throw new MapsError('bad_input', 'Say what to look for: a name, an address or a kind of place.', 400);
    const params: Record<string, string> = { q: text, limit: String(Math.min(20, q.near ? q.limit * 3 : q.limit)), addressdetails: '0' };
    if (q.near) {
      // a box around the point: degrees of latitude are 111 km, of longitude less away from the equator
      const dLat = q.radiusMeters / 111_000;
      const dLng = q.radiusMeters / (111_000 * Math.max(0.2, Math.cos((q.near.lat * Math.PI) / 180)));
      params.viewbox = [q.near.lng - dLng, q.near.lat + dLat, q.near.lng + dLng, q.near.lat - dLat].map((n) => n.toFixed(5)).join(',');
      // a kind of place stays inside the box; a name may be further away
      if (!q.text) params.bounded = '1';
    }
    const list = await this.nominatim('/search', params);
    const out = (Array.isArray(list) ? (list as Json[]) : []).map((r) => nominatimPlace(r)).filter((p): p is RawPlace => !!p);
    const near = q.near;
    if (near && !q.text) out.sort((a, b) => metersBetween(near, a) - metersBetween(near, b));
    return out.slice(0, q.limit);
  }

  async details(id: string): Promise<RawPlace> {
    const m = /^osm:([NWR]\d+)$/.exec(id);
    if (!m) throw new MapsError('bad_input', 'That is not an OpenStreetMap place id. Use the id PlaceSearch gave, such as osm:N123.', 400);
    const list = await this.nominatim('/lookup', { osm_ids: m[1], extratags: '1', addressdetails: '0' });
    const first = Array.isArray(list) ? list[0] : undefined;
    const p = first && typeof first === 'object' ? nominatimPlace(first as Json) : undefined;
    if (!p) throw new MapsError('not_found', 'OpenStreetMap has no place with that id.', 404);
    return p;
  }

  async geocode(text: string): Promise<Geocoded | undefined> {
    const list = await this.nominatim('/search', { q: text, limit: '1', addressdetails: '0' });
    const r = Array.isArray(list) ? (list[0] as Json | undefined) : undefined;
    if (!r) return undefined;
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    return { label: String(r.display_name ?? text), lat, lng };
  }

  async route(req: RouteRequest): Promise<ProviderRoute> {
    const from = req.from.point;
    const to = req.to.point;
    if (!from || !to) throw new MapsError('bad_input', 'OpenStreetMap routing needs both ends as places it found.', 400);
    // OSRM has no timetables: transit becomes a walk, and the card says so
    const mode: TravelMode = req.mode === 'transit' ? 'walk' : req.mode;
    const own = mode === 'walk' ? this.opts.osrmWalkUrl?.() : mode === 'bicycle' ? this.opts.osrmBicycleUrl?.() : undefined;
    const base = this.base(own || this.opts.osrmUrl());
    this.contact(base);
    // osrm-routed serves the one profile it was built with, whatever the URL names
    const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline&alternatives=false&steps=false`;
    const body = (await this.json('osrm', this.osrmGate, url)) as Json;
    if (body.code !== 'Ok' || !Array.isArray(body.routes) || !body.routes.length) {
      if (body.code === 'NoRoute' || body.code === 'NoSegment') throw new MapsError('no_route', 'OpenStreetMap routing found no route between those places.', 404);
      throw new MapsError('error', `OSRM routing could not route that (${String(body.code ?? 'no answer')}).`, 502);
    }
    const r = body.routes[0] as Json;
    const distance = Math.round(Number(r.distance) || 0);
    const estimate = !own && SPEED_MS[mode] !== undefined;
    const notes: string[] = [];
    if (req.mode === 'transit') notes.push('OpenStreetMap has no public transport times, so this is the walking time.');
    if (estimate) notes.push(`${mode === 'walk' ? 'Walking' : 'Cycling'} time worked out from the road distance at ${mode === 'walk' ? '4.8' : '15'} km/h.`);
    if (mode === 'drive') notes.push('No traffic data.');
    return {
      durationSec: estimate ? Math.round(distance / SPEED_MS[mode]!) : Math.round(Number(r.duration) || 0),
      distanceMeters: distance,
      ...(typeof r.geometry === 'string' ? { polyline: r.geometry } : {}),
      start: from,
      end: to,
      ...(mode !== req.mode ? { usedMode: mode } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // map images: tiles from a week-long disk cache, drawn as one SVG
  // -------------------------------------------------------------------------

  private tilePath(z: number, x: number, y: number): string {
    return join(this.opts.tileDir, String(z), String(x), `${y}.png`);
  }

  /** One tile, from disk when it is under a week old, else from the tile server (two at a time). */
  async tile(z: number, x: number, y: number): Promise<Uint8Array | undefined> {
    const file = this.tilePath(z, x, y);
    try {
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs < TILE_TTL_MS) return new Uint8Array(readFileSync(file));
    } catch {
      /* fetch it again */
    }
    const template = this.opts.tileUrl();
    this.contact(template.replace(/\{[xyzs]\}/g, '0'));
    const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', 'a');
    const res = await this.tileGate.run(async () => {
      try {
        return await this.env.fetch(url, { headers: { 'user-agent': this.env.userAgent(), accept: 'image/png,image/*' }, signal: AbortSignal.timeout(15_000) });
      } catch {
        return undefined;
      }
    });
    if (!res) return undefined;
    if (res.status === 429 || res.status === 403 || res.status === 418)
      throw new MapsError('refused', `${hostOf(url)} refused map tiles (HTTP ${res.status}). The public tile server is for light use: wait a while, or set your own tile server in Settings, Maps.`, 429);
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    } catch {
      /* the cache is a courtesy */
    }
    void this.sweepTiles().catch(() => undefined);
    return bytes;
  }

  private lastSweep = 0;

  /**
   * Tiles past their week leave the disk, at most once a day, after a tile
   * was written: a tile is only read again within a week, and areas viewed
   * once would otherwise stay for good.
   */
  private async sweepTiles(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 86_400_000) return;
    this.lastSweep = now;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
          // an emptied folder goes too; one that still holds tiles refuses
          await rmdir(p).catch(() => undefined);
          continue;
        }
        try {
          if (now - (await stat(p)).mtimeMs > TILE_TTL_MS) await rm(p, { force: true });
        } catch {
          /* gone meanwhile */
        }
      }
    };
    await walk(this.opts.tileDir);
  }

  async image(spec: MapImageSpec): Promise<{ bytes: Uint8Array; type: string }> {
    this.env.take('staticmap');
    const { width: w, height: h } = spec;
    const route = spec.path ? decodePolyline(spec.path) : [];
    const points: LatLng[] = [...spec.markers, ...route];
    if (!points.length) throw new MapsError('bad_input', 'A map needs at least one marker or a route.', 400);
    const pad = 28;
    const z = spec.zoom ?? fitZoom(points, w - 2 * pad, h - 2 * pad, 17);
    const px = points.map((p) => worldPx(p, z));
    const cx = (Math.min(...px.map((p) => p.x)) + Math.max(...px.map((p) => p.x))) / 2;
    const cy = (Math.min(...px.map((p) => p.y)) + Math.max(...px.map((p) => p.y))) / 2;
    const left = cx - w / 2;
    const top = cy - h / 2;
    const n = 2 ** z;
    const parts: string[] = [];
    let got = 0;
    let tried = 0;
    const jobs: Array<Promise<void>> = [];
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h - 1) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w - 1) / TILE); tx++) {
        const x = ((tx % n) + n) % n;
        const ox = Math.round(tx * TILE - left);
        const oy = Math.round(ty * TILE - top);
        tried++;
        jobs.push(
          this.tile(z, x, ty).then((bytes) => {
            if (!bytes) {
              parts.push(`<rect x="${ox}" y="${oy}" width="${TILE}" height="${TILE}" fill="#e8e6e1"/>`);
              return;
            }
            got++;
            parts.push(`<image x="${ox}" y="${oy}" width="${TILE}" height="${TILE}" href="data:image/png;base64,${Buffer.from(bytes).toString('base64')}"/>`);
          }),
        );
      }
    }
    await Promise.all(jobs);
    if (tried && !got) throw new MapsError('network', `Could not load map tiles from ${hostOf(this.opts.tileUrl())}. Check that the hub can reach it.`, 504);
    const at = (p: LatLng) => {
      const q = worldPx(p, z);
      return `${(q.x - left).toFixed(1)} ${(q.y - top).toFixed(1)}`;
    };
    if (route.length > 1) {
      const d = `M ${route.map(at).join(' L ')}`;
      parts.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
      parts.push(`<path d="${d}" fill="none" stroke="#2f6fde" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    for (const m of spec.markers) {
      const [x, y] = at(m).split(' ');
      parts.push(`<circle cx="${x}" cy="${y}" r="11" fill="#d6453d" stroke="#ffffff" stroke-width="2.5"/>`);
      if (m.label) parts.push(`<text x="${x}" y="${y}" dy="4" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#ffffff">${escapeXml(m.label.slice(0, 1).toUpperCase())}</text>`);
    }
    const label = OSM_ATTRIBUTION;
    const bw = label.length * 5.6 + 12;
    parts.push(`<rect x="${w - bw}" y="${h - 18}" width="${bw}" height="18" fill="#ffffff" opacity="0.85"/>`);
    parts.push(`<text x="${w - 6}" y="${h - 5}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="10.5" fill="#333333">${escapeXml(label)}</text>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${escapeXml(spec.alt)}</title><rect width="${w}" height="${h}" fill="#e8e6e1"/>${parts.join('')}</svg>`;
    return { bytes: new TextEncoder().encode(svg), type: 'image/svg+xml' };
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
    await step('nominatim', async () => {
      const g = await this.geocode('Brandenburger Tor, Berlin');
      if (!g) return 'Works. It found nothing for the test address, which is fine.';
      at ??= g;
      return `Works. Found ${g.label.split(',').slice(0, 2).join(',')}.`;
    });
    const point = at ?? { lat: 52.5163, lng: 13.3777 };
    await step('osrm', async () => {
      const r = await this.route({ from: { point }, to: { point: { lat: point.lat + 0.005, lng: point.lng + 0.005 } }, mode: 'drive' });
      return `Works. A short drive is ${(r.distanceMeters / 1000).toFixed(1)} km.`;
    });
    await step('tiles', async () => {
      this.env.take('tiles');
      const z = 15;
      const p = worldPx(point, z);
      const bytes = await this.tile(z, Math.floor(p.x / TILE), Math.floor(p.y / TILE));
      if (!bytes) throw new MapsError('network', `Could not load a map tile from ${hostOf(this.opts.tileUrl())}.`, 504);
      return `Works. Got a ${Math.max(1, Math.round(bytes.length / 1024))} KB tile.`;
    });
    return steps;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.split('/')[2] ?? url;
  }
}
