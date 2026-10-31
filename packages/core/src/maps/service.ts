/**
 * Maps in the hub: one service in front of the providers (google.ts,
 * osm.ts). It picks the provider, resolves "home", names and place ids,
 * counts every outbound call against the daily cap, caches results for a
 * short while, keeps routes and map image specs (never URLs with a key) in
 * a small table, and turns results into text for the model and card data
 * for the clients. The Google key stays here: it is read from the hub's
 * secrets at call time and scrubbed from anything that leaves.
 *
 * A member's maps are their own (docs/design/ACCOUNTS.md 2): their own Google
 * key (never the hub's or its env var), their home and their daily cap and
 * count in kv under their account's keys, their own cache entries. Nothing of
 * the owner's maps config reaches them; without a key of their own they get
 * MEMBER_NO_KEY.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { MapsConfig } from '../config/schema';
import { redactSecrets } from '../memory/secrets';
import { defuseFrameworkTags } from '../session/untrusted';
import { newId } from '../util/ids';
import { atLocal, dayRange, localDate, localHhmm, addDays } from '../assistant/time';
import { directionsLink, metersBetween, parseLatLng, placeLink, pointText, validPoint } from './geo';
import { GoogleProvider } from './google';
import { OsmProvider, OSM_ATTRIBUTION, OSM_DEFAULTS } from './osm';
import { DailyCap, TtlCache } from './limits';
import { NO_CALENDAR, travelEvents, type CalendarPort } from './leave-by';
import type { Geocoded, MapsProvider, ProviderRoute, RawPlace, Waypoint } from './provider';
import type {
  LatLng,
  LeaveByDto,
  LeaveByItem,
  MapImageCard,
  MapImageSpec,
  MapMarker,
  MapsCardData,
  MapsHome,
  MapsLinkApp,
  MapsProviderId,
  MapsSettingsDto,
  MapsSettingsPatch,
  MapsTestResult,
  PlaceCard,
  PlaceDetails,
  RouteCard,
  TravelMode,
} from './types';
import { MapsError, TRAVEL_MODES } from './types';
import { OWNER_ID, currentAccount, isMember } from '../people/context';
import { ensureAccountColumn } from '../people/tables';
import { accountKv } from '../people/scoped';
import type { KvRepo } from '../storage/repos';
import { countWords, distanceWords, durationWords, LINK_WORDS, MODE_BY, MODE_WORDS, priceMarks, ratingWords } from './words';

/** The secret name: `conclave secret google-maps`, Settings > Maps. */
export const MAPS_KEY = 'google-maps';
/** An env var some installs use instead; tool shells never inherit it (machine/local.ts). */
export const MAPS_KEY_ENV = 'GOOGLE_MAPS_API_KEY';
export const DEFAULT_CAP = 300;
/** What a member without a maps key of their own is told: the hub's key is never theirs. */
export const MEMBER_NO_KEY = 'Add your own maps key in Settings, Maps.';
/** A member's home and their mode, links and cap, in kv under their account's keys. */
const MEMBER_HOME = 'maps.home';
const MEMBER_PREFS = 'maps.prefs';
const DEFAULT_MODE: TravelMode = 'transit';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maps_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS maps_items_created ON maps_items(created_at);
`;
/** Routes and map specs are kept a month, so a card in an old chat still opens. */
const KEEP_MS = 30 * 86_400_000;

const TTL = {
  search: 10 * 60_000,
  details: 60 * 60_000,
  geocode: 24 * 60 * 60_000,
  route: 5 * 60_000,
  zone: 7 * 24 * 60 * 60_000,
  image: 60 * 60_000,
  leave: 20 * 60_000,
};

interface KvLike {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix: string): string[];
}

/** What the service needs from the hub, as closures so tests can fake it. */
export interface MapsHost {
  /** The maps block of the config (merged), or {}. */
  config(): MapsConfig;
  /** Replace the maps block in the user config. */
  setConfig(next: MapsConfig): void;
  /** The Google key of the account the work runs for, and where it came from ('own': a member's own). */
  key(): { key?: string; from?: 'hub' | 'env' | 'own' };
  /** Store or remove the key as a hub secret. */
  setKey(key: string | undefined): void;
  kv: KvLike;
  db: Db;
  /** The owner's timezone (Settings > Assistant). */
  zone(): string;
  /** Where OpenStreetMap tiles are kept for a week. */
  tileDir: string;
  version: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** One base URL for every Google API (a fake server in tests and the screenshot run). */
  googleBase?: () => string | undefined;
  /** Calendar events for leave-by times; NO_CALENDAR until a calendar module attaches one. */
  calendar?: () => CalendarPort;
  /** Spacing between OpenStreetMap calls. Default 1100 ms; tests set less. */
  osmSpacingMs?: number;
}

/** What a tool returns: the model's text and the card. */
export interface MapsAnswer<T> {
  value: T;
  text: string;
  card: MapsCardData;
}

export interface SearchInput {
  query?: string;
  type?: string;
  near?: string;
  radiusMeters?: number;
  openNow?: boolean;
  limit?: number;
}

export interface DirectionsInput {
  from?: string;
  to: string;
  mode?: string;
  departAt?: string;
  arriveBy?: string;
}

export interface MapImageInput {
  markers?: Array<string | { at: string; label?: string }>;
  route?: string;
  width?: number;
  height?: number;
  zoom?: number;
}

interface StoredRoute {
  polyline?: string;
  from: RouteCard['from'];
  to: RouteCard['to'];
  mode: TravelMode;
  provider: MapsProviderId;
}

interface Resolved {
  label: string;
  point?: LatLng;
  waypoint: Waypoint;
  googleId?: string;
}

export class MapsService {
  private host: MapsHost;
  private now: () => number;
  private cache = new TtlCache<unknown>(400);
  private images = new TtlCache<{ bytes: Uint8Array; type: string }>(40, 16 * 1024 * 1024);
  /** Places from recent results by id, so a follow-up call needs no lookup. */
  private seen = new TtlCache<PlaceCard>(500);
  private google: GoogleProvider;
  private osm: OsmProvider;
  private lastPrune = 0;

  constructor(host: MapsHost) {
    this.host = host;
    this.now = host.now ?? Date.now;
    host.db.exec(SCHEMA);
    // a route or a map picture is the account's that asked for it (docs/design/ACCOUNTS.md)
    ensureAccountColumn(host.db, 'maps_items');
    const env = {
      fetch: host.fetch ?? fetch.bind(globalThis),
      take: (api: Parameters<DailyCap['take']>[0]) => this.cap().take(api),
      userAgent: () => {
        const email = this.cfg().osm?.email?.trim();
        return `Conclave/${host.version} (self-hosted assistant hub${email ? `; ${email}` : ''})`;
      },
    };
    this.google = new GoogleProvider(env, { key: () => this.keyNow().key, base: host.googleBase });
    const osm = () => this.cfg().osm ?? {};
    this.osm = new OsmProvider(env, {
      nominatimUrl: () => osm().nominatimUrl || OSM_DEFAULTS.nominatimUrl,
      osrmUrl: () => osm().osrmUrl || OSM_DEFAULTS.osrmUrl,
      osrmWalkUrl: () => osm().osrmWalkUrl,
      osrmBicycleUrl: () => osm().osrmBicycleUrl,
      tileUrl: () => osm().tileUrl || OSM_DEFAULTS.tileUrl,
      email: () => osm().email,
      tileDir: host.tileDir,
      ...(host.osmSpacingMs !== undefined ? { spacingMs: host.osmSpacingMs } : {}),
    });
  }

  /** The member the work runs for, or undefined for the owner (and outside any account). */
  private member(): string | undefined {
    const a = currentAccount();
    return isMember(a) ? a : undefined;
  }

  /** The kv of the account the work runs for: the owner keeps the old keys. */
  private kv(): KvLike {
    const a = this.member();
    return a ? accountKv(this.host.kv as KvRepo, a) : this.host.kv;
  }

  private cfg(): MapsConfig {
    if (!this.member()) return this.host.config() ?? {};
    // a member's own: always Google on their own key, their home and prefs; nothing of the owner's maps config
    const kv = this.kv();
    const home = kv.get<MapsHome | undefined>(MEMBER_HOME, undefined);
    return { ...kv.get<MapsConfig>(MEMBER_PREFS, {}), provider: 'google', ...(home ? { home } : {}) };
  }

  private saveCfg(next: MapsConfig): void {
    if (!this.member()) return this.host.setConfig(next);
    const kv = this.kv();
    if (next.home) kv.set(MEMBER_HOME, next.home);
    else kv.delete(MEMBER_HOME);
    kv.set(MEMBER_PREFS, { ...(next.mode ? { mode: next.mode } : {}), ...(next.links ? { links: next.links } : {}), ...(next.dailyCap !== undefined ? { dailyCap: next.dailyCap } : {}) });
  }

  /** The day's count and cap of the account the work runs for. */
  private cap(): DailyCap {
    return new DailyCap(this.kv(), () => this.cfg().dailyCap ?? DEFAULT_CAP, () => localDate(this.now(), this.zone()));
  }

  /** The key for this call: a member's own only, never the hub's or its env var. */
  private keyNow(): { key?: string; from?: 'hub' | 'env' | 'own' } {
    const k = this.host.key();
    return this.member() && k.from !== 'own' ? {} : k;
  }

  /** Cache keys of a member's own, so no answer bought with one account's key serves another. */
  private scoped(key: string): string {
    const a = this.member();
    return a ? `${a}\u0000${key}` : key;
  }

  zone(): string {
    return this.host.zone();
  }

  // -------------------------------------------------------------------------
  // provider and settings
  // -------------------------------------------------------------------------

  providerId(): MapsProviderId {
    const chosen = this.cfg().provider;
    if (chosen === 'google' || chosen === 'osm') return chosen;
    return this.keyNow().key ? 'google' : 'osm';
  }

  private provider(): MapsProvider {
    if (this.member() && !this.keyNow().key) throw new MapsError('no_key', MEMBER_NO_KEY, 400);
    return this.providerId() === 'google' ? this.google : this.osm;
  }

  links(): MapsLinkApp {
    return this.cfg().links === 'apple' ? 'apple' : 'google';
  }

  defaultMode(): TravelMode {
    const m = this.cfg().mode;
    return m && TRAVEL_MODES.includes(m) ? m : DEFAULT_MODE;
  }

  home(): MapsHome | undefined {
    // a member's home is their own (cfg); the owner's never reaches them
    const h = this.cfg().home;
    return h && typeof h.address === 'string' && validPoint(h) ? h : undefined;
  }

  settings(): MapsSettingsDto {
    const c = this.cfg();
    const k = this.keyNow();
    const osm = c.osm ?? {};
    const nominatimUrl = osm.nominatimUrl || OSM_DEFAULTS.nominatimUrl;
    const osrmUrl = osm.osrmUrl || OSM_DEFAULTS.osrmUrl;
    const tileUrl = osm.tileUrl || OSM_DEFAULTS.tileUrl;
    const u = this.cap().usage();
    const home = this.home();
    return {
      provider: this.providerId(),
      ...(c.provider === 'google' || c.provider === 'osm' ? { chosen: c.provider } : {}),
      google: { keySet: !!k.key, ...(k.key && k.from ? { keyFrom: k.from } : {}) },
      osm: { ...(osm.email ? { email: osm.email } : {}), nominatimUrl, osrmUrl, tileUrl, publicServers: nominatimUrl === OSM_DEFAULTS.nominatimUrl || osrmUrl === OSM_DEFAULTS.osrmUrl || tileUrl === OSM_DEFAULTS.tileUrl },
      ...(home ? { home } : {}),
      mode: this.defaultMode(),
      links: this.links(),
      dailyCap: c.dailyCap ?? DEFAULT_CAP,
      today: { date: u.date, calls: u.calls, byApi: u.byApi },
    };
  }

  /** Save a key (trimmed) or remove it with null. */
  setKey(key: string | null): MapsSettingsDto {
    if (key === null || key === '') {
      this.host.setKey(undefined);
    } else {
      const k = key.trim();
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(k)) throw new MapsError('bad_input', 'That does not look like a Google API key. It is about 39 letters and digits and usually starts with AIza.', 400);
      this.host.setKey(k);
    }
    this.cache.clear();
    this.images.clear();
    return this.settings();
  }

  async patch(p: MapsSettingsPatch): Promise<MapsSettingsDto> {
    const next: MapsConfig = structuredClone(this.cfg());
    if (this.member() && (p.provider !== undefined || p.osm !== undefined)) throw new MapsError('bad_input', "The provider and the OpenStreetMap servers are the hub owner's. Your maps use your own Google key.", 400);
    if (p.provider !== undefined) {
      if (p.provider === null) delete next.provider;
      else if (p.provider === 'google' || p.provider === 'osm') next.provider = p.provider;
      else throw new MapsError('bad_input', 'provider must be google or osm.', 400);
    }
    if (p.mode !== undefined) {
      if (!TRAVEL_MODES.includes(p.mode)) throw new MapsError('bad_input', `mode must be one of ${TRAVEL_MODES.join(', ')}.`, 400);
      next.mode = p.mode;
    }
    if (p.links !== undefined) {
      if (p.links !== 'google' && p.links !== 'apple') throw new MapsError('bad_input', 'links must be google or apple.', 400);
      next.links = p.links;
    }
    if (p.dailyCap !== undefined) {
      if (typeof p.dailyCap !== 'number' || !Number.isInteger(p.dailyCap) || p.dailyCap < 0 || p.dailyCap > 100_000) throw new MapsError('bad_input', 'dailyCap must be a whole number from 0 to 100000.', 400);
      next.dailyCap = p.dailyCap;
    }
    if (p.osm !== undefined) {
      if (!p.osm || typeof p.osm !== 'object') throw new MapsError('bad_input', 'osm must be an object.', 400);
      const o = { ...(next.osm ?? {}) };
      for (const k of ['email', 'nominatimUrl', 'osrmUrl', 'tileUrl'] as const) {
        const v = p.osm[k];
        if (v === undefined) continue;
        if (v === null || v === '') {
          delete o[k];
          continue;
        }
        if (typeof v !== 'string') throw new MapsError('bad_input', `osm.${k} must be text.`, 400);
        const t = v.trim();
        if (k === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new MapsError('bad_input', 'That email does not look right.', 400);
        if (k !== 'email' && !/^https?:\/\/[^\s]+$/.test(t)) throw new MapsError('bad_input', `osm.${k} must be an http or https URL.`, 400);
        if (k === 'tileUrl' && !(t.includes('{z}') && t.includes('{x}') && t.includes('{y}'))) throw new MapsError('bad_input', 'The tile URL needs {z}, {x} and {y}.', 400);
        o[k] = t;
      }
      next.osm = o;
    }
    // set the provider first, so the home is found with the provider that will use it
    if (p.provider !== undefined || p.osm !== undefined) this.saveCfg(next);
    if (p.home !== undefined) {
      if (p.home === null || (typeof p.home === 'string' && !p.home.trim())) delete next.home;
      else if (typeof p.home !== 'string') throw new MapsError('bad_input', 'home must be an address or "lat,lng".', 400);
      else next.home = await this.findHome(p.home.trim());
    }
    this.saveCfg(next);
    return this.settings();
  }

  /** Look up a home address once, with its timezone when the provider has one. */
  private async findHome(text: string): Promise<MapsHome> {
    const point = parseLatLng(text);
    let home: MapsHome;
    if (point) home = { address: text, ...point };
    else {
      const g = await this.guard(() => this.provider().geocode(text));
      if (!g) throw new MapsError('not_found', `Could not find "${text}". Try a fuller address, or "lat,lng".`, 404);
      home = { address: g.label, lat: g.lat, lng: g.lng };
    }
    // a member's "lat,lng" home needs no key; the zone lookup does
    const p = this.member() && !this.keyNow().key ? undefined : this.provider();
    if (p?.timezone) {
      const zone = await this.guard(() => p.timezone!(home, this.now())).catch(() => undefined);
      if (zone) home.zone = zone;
    }
    return home;
  }

  async test(): Promise<MapsTestResult> {
    const provider = this.providerId();
    const steps = await this.guard(() => this.provider().test(this.home()));
    return { provider, ok: steps.every((s) => s.ok), steps: steps.map((s) => ({ ...s, message: this.scrub(s.message) })) };
  }

  // -------------------------------------------------------------------------
  // the four tools
  // -------------------------------------------------------------------------

  async searchPlaces(input: SearchInput): Promise<MapsAnswer<PlaceCard[]>> {
    const query = clean(input.query, 200);
    const type = clean(input.type, 60)?.toLowerCase().replace(/\s+/g, '_');
    if (!query && !type) throw new MapsError('bad_input', 'Give a query ("coffee", "Café Einstein Berlin") or a type ("pharmacy").', 400);
    const limit = clamp(input.limit ?? 5, 1, 10);
    // around a point (near, or home for a type) means walking distance; a bare query looks wider
    const radius = clamp(input.radiusMeters ?? (input.near || (input.type && !input.query) ? 1500 : 5000), 100, 50_000);
    const nearText = clean(input.near, 200);
    // with no place to search around, a type search looks around home
    // a search needs the place as a point (with Google an address alone would be dropped, and the cache key would not tell places apart)
    const near = nearText ? await this.resolve(nearText, true) : type && !query ? this.homeResolved() : undefined;
    if (type && !query && !near) throw new MapsError('bad_input', 'A search by type needs a place to look around: give near, or set your home in Settings, Maps.', 400);
    const provider = this.provider();
    const key = `search:${provider.id}:${JSON.stringify([query?.toLowerCase(), type, near?.point, radius, input.openNow, limit])}`;
    const raw = await this.cached(key, TTL.search, () => provider.search({ text: query, type, near: near?.point, radiusMeters: radius, openNow: input.openNow, limit }));
    const places = raw.map((r) => this.card(r, near?.point));
    for (const p of places) this.seen.set(this.scoped(p.id), p, TTL.geocode);
    const what = query ? `"${query}"` : type!.replace(/_/g, ' ');
    const where = near ? ` near ${near.label}` : '';
    const lines = places.map((p, i) => `${i + 1}. ${this.placeLine(p)}`);
    const text = places.length
      ? [`${places.length} ${places.length === 1 ? 'place' : 'places'} for ${what}${where}${provider.id === 'osm' ? ' (OpenStreetMap: no ratings or opening hours)' : ''}:`, ...lines, '', this.cardNote('places')].join('\n')
      : `No places found for ${what}${where}.${input.openNow ? ' Try without openNow.' : ''}`;
    return { value: places, text, card: { kind: 'places', provider: provider.id, links: this.links(), places, ...(provider.attribution ? { attribution: provider.attribution } : {}) } };
  }

  async placeDetails(id: string): Promise<MapsAnswer<PlaceDetails>> {
    const pid = clean(id, 300);
    if (!pid) throw new MapsError('bad_input', 'Give the id of a place from PlaceSearch.', 400);
    const provider = this.providerFor(pid);
    const raw = await this.cached(`details:${provider.id}:${pid}`, TTL.details, () => provider.details(pid));
    const place: PlaceDetails = { ...this.card(raw), ...(raw.hours?.length && provider.id === 'google' ? { hours: raw.hours } : {}), ...(raw.website ? { website: raw.website } : {}) };
    this.seen.set(this.scoped(place.id), place, TTL.geocode);
    const lines = [this.placeLine(place)];
    if (provider.id === 'google' && raw.hours?.length) lines.push('Hours this week:', ...raw.hours.map((h) => `- ${h}`));
    // OpenStreetMap's hours tag is what a mapper typed, often old: the model sees it with that warning, the card leaves it out
    if (provider.id === 'osm' && raw.hours?.length) lines.push(`Hours as tagged in OpenStreetMap, may be out of date: ${raw.hours[0]}`);
    if (raw.website) lines.push(`Website: ${raw.website}`);
    lines.push('', this.cardNote('places'));
    return { value: place, text: lines.join('\n'), card: { kind: 'places', provider: provider.id, links: this.links(), places: [place], ...(provider.attribution ? { attribution: provider.attribution } : {}) } };
  }

  async directions(input: DirectionsInput): Promise<MapsAnswer<RouteCard>> {
    const toText = clean(input.to, 300);
    if (!toText) throw new MapsError('bad_input', 'Say where to: an address, a place id from PlaceSearch, or "lat,lng".', 400);
    const mode = input.mode === undefined ? this.defaultMode() : (input.mode as TravelMode);
    if (!TRAVEL_MODES.includes(mode)) throw new MapsError('bad_input', `mode must be one of ${TRAVEL_MODES.join(', ')}.`, 400);
    const departAt = input.departAt ? this.when(input.departAt, 'departAt') : undefined;
    const arriveBy = input.arriveBy ? this.when(input.arriveBy, 'arriveBy') : undefined;
    if (departAt && arriveBy) throw new MapsError('bad_input', 'Give departAt or arriveBy, not both.', 400);
    const from = input.from && !/^home$/i.test(input.from.trim()) ? await this.resolve(input.from.trim()) : this.homeResolved();
    if (!from) throw new MapsError('bad_input', 'Where from? Give from, or set your home in Settings, Maps.', 400);
    const to = /^home$/i.test(toText) ? this.homeResolved() : await this.resolve(toText);
    if (!to) throw new MapsError('bad_input', 'Your home is not set. Set it in Settings, Maps, or give an address.', 400);
    return this.routeBetween(from, to, mode, departAt, arriveBy);
  }

  private async routeBetween(from: Resolved, to: Resolved, mode: TravelMode, departAt?: number, arriveBy?: number): Promise<MapsAnswer<RouteCard>> {
    const provider = this.provider();
    const slot = (t?: number) => (t ? Math.round(t / 300_000) : 0);
    const key = `route:${provider.id}:${JSON.stringify([from.waypoint, to.waypoint, mode, slot(departAt), slot(arriveBy)])}`;
    const r = await this.cached<ProviderRoute>(key, TTL.route, () => provider.route({ from: from.waypoint, to: to.waypoint, mode, ...(departAt ? { departAt } : {}), ...(arriveBy ? { arriveBy } : {}) }));
    const zone = this.zone();
    const now = this.now();
    const used = r.usedMode ?? mode;
    const start = r.start ?? from.point;
    const end = r.end ?? to.point;
    if (!start || !end) throw new MapsError('error', 'The route came back without its ends.', 502);
    let depart = departAt ?? now;
    let arrive = depart + r.durationSec * 1000;
    let leaveBy: number | undefined;
    if (arriveBy) {
      leaveBy = arriveBy - r.durationSec * 1000;
      depart = leaveBy;
      arrive = arriveBy;
    }
    let arriveLocal: string | undefined;
    if (provider.timezone && r.distanceMeters > 150_000) {
      const there = await this.cached(`zone:${end.lat.toFixed(1)},${end.lng.toFixed(1)}`, TTL.zone, () => provider.timezone!(end, arrive)).catch(() => undefined);
      if (there && there !== zone) arriveLocal = `${localHhmm(arrive, there)} ${there}`;
    }
    const id = newId('route');
    const card: RouteCard = {
      id,
      from: { label: from.label, lat: start.lat, lng: start.lng },
      to: { label: to.label, lat: end.lat, lng: end.lng },
      mode: used,
      ...(used !== mode ? { asked: mode } : {}),
      durationSec: r.durationSec,
      // traffic is a drive's: a transit or walking time's static twin says nothing about it
      ...(used === 'drive' && r.staticDurationSec && r.durationSec - r.staticDurationSec >= 60 ? { trafficSec: r.durationSec - r.staticDurationSec } : {}),
      distanceMeters: r.distanceMeters,
      departAt: depart,
      arriveAt: arrive,
      departText: localHhmm(depart, zone),
      arriveText: localHhmm(arrive, zone),
      ...(leaveBy ? { leaveBy, leaveByText: localHhmm(leaveBy, zone) } : {}),
      ...(arriveLocal ? { arriveLocal } : {}),
      zone,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.note ? { note: r.note } : {}),
      directionsUrl: directionsLink(this.links(), { ...end, ...(to.googleId ? { googleId: to.googleId } : {}) }, used, from.label === 'Home' ? undefined : start),
    };
    this.store<StoredRoute>(id, 'route', { polyline: r.polyline, from: card.from, to: card.to, mode: used, provider: provider.id });
    const lines = [
      `${MODE_WORDS[used]} from ${from.label} to ${to.label}: ${durationWords(r.durationSec)}, ${distanceWords(r.distanceMeters)}.${card.trafficSec ? ` Traffic adds ${durationWords(card.trafficSec)}.` : ''}`,
      leaveBy ? `Leave by ${card.leaveByText} to arrive at ${card.arriveText}.${leaveBy < now ? ' That time has already passed.' : ''}` : `Leaving at ${card.departText}, arriving at ${card.arriveText}${arriveLocal ? ` (${arriveLocal} local time there)` : ''}.`,
      ...(r.summary ? [`Route: ${r.summary}.`] : []),
      ...(r.note ? [r.note] : []),
      `Route id ${id}: pass it to MapImage as route to draw it.`,
      '',
      this.cardNote('route'),
    ];
    return { value: card, text: lines.join('\n'), card: { kind: 'route', provider: provider.id, links: this.links(), route: card, ...(provider.attribution ? { attribution: provider.attribution } : {}) } };
  }

  async mapImage(input: MapImageInput): Promise<MapsAnswer<MapImageCard>> {
    const width = clamp(Math.round(input.width ?? 600), 200, 640);
    const height = clamp(Math.round(input.height ?? 320), 150, 640);
    const markers: MapMarker[] = [];
    const names: string[] = [];
    const list = Array.isArray(input.markers) ? input.markers.slice(0, 10) : [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const at = typeof m === 'string' ? m : m?.at;
      if (typeof at !== 'string' || !at.trim()) throw new MapsError('bad_input', 'Each marker needs at: an address, "lat,lng", "home" or a place id.', 400);
      const r = /^home$/i.test(at.trim()) ? this.homeResolved() : await this.resolve(at.trim(), true);
      if (!r?.point) throw new MapsError('not_found', `Could not place the marker "${at}".`, 404);
      const label = typeof m === 'object' && typeof m.label === 'string' && /^[A-Za-z0-9]$/.test(m.label.trim()) ? m.label.trim().toUpperCase() : String.fromCharCode(65 + i);
      markers.push({ ...r.point, label });
      names.push(r.label);
    }
    let path: string | undefined;
    let routeWords = '';
    if (input.route) {
      const route = this.load<StoredRoute>(String(input.route), 'route');
      if (!route) throw new MapsError('not_found', 'That route id is unknown or more than a month old. Run Directions again.', 404);
      path = route.polyline;
      routeWords = `${MODE_WORDS[route.mode].toLowerCase()} route from ${route.from.label} to ${route.to.label}`;
      if (!markers.length) {
        markers.push({ lat: route.from.lat, lng: route.from.lng, label: 'A' }, { lat: route.to.lat, lng: route.to.lng, label: 'B' });
        names.push(route.from.label, route.to.label);
      }
    }
    if (!markers.length && !path) throw new MapsError('bad_input', 'Give markers, a route id from Directions, or both.', 400);
    const provider = this.provider();
    const alt = routeWords ? `Map of the ${routeWords}` : `Map of ${names.join(', ')}`;
    const spec: MapImageSpec = { provider: provider.id, width, height, markers, ...(path ? { path } : {}), ...(input.zoom ? { zoom: clamp(Math.round(input.zoom), 1, 19) } : {}), alt };
    const id = newId('map');
    this.store(id, 'image', spec);
    // fetch it once now: a refused key shows in the result, and the card's first view is a cache hit
    await this.imageBytes(id);
    const image: MapImageCard = { id, width, height, alt };
    const text = `${alt}${markers.length ? `, markers ${markers.map((m, i) => `${m.label} ${names[i] ?? ''}`.trim()).join('; ')}` : ''}. The owner sees it in the chat; you cannot see the image.`;
    return { value: image, text, card: { kind: 'map', provider: provider.id, image, ...(provider.attribution ? { attribution: provider.attribution } : {}) } };
  }

  /** The image for a map card: from memory for an hour, else from the provider (a counted call). */
  async imageBytes(id: string): Promise<{ bytes: Uint8Array; type: string }> {
    const hit = this.images.get(this.scoped(id));
    if (hit) return hit;
    const spec = this.load<MapImageSpec>(id, 'image');
    if (!spec) throw new MapsError('not_found', 'That map is unknown or more than a month old.', 404);
    const provider = this.member() ? this.provider() : spec.provider === 'google' ? this.google : this.osm;
    const img = await this.guard(() => provider.image(spec));
    this.images.set(this.scoped(id), img, TTL.image, img.bytes.length);
    return img;
  }

  // -------------------------------------------------------------------------
  // leave-by times for the day plan
  // -------------------------------------------------------------------------

  /** Travel from home to the day's events with a place: "Leave by 17:40". */
  async leaveBy(date?: string): Promise<LeaveByDto> {
    const zone = this.zone();
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate(this.now(), zone);
    const { start, end } = dayRange(day, zone);
    const port = this.host.calendar?.() ?? NO_CALENDAR;
    let events;
    try {
      events = travelEvents(await port.eventsBetween(start, end), this.now());
    } catch {
      return { date: day, zone, items: [], reason: 'The calendar could not be read.' };
    }
    if (!events.length) return { date: day, zone, items: [] };
    const home = this.homeResolved();
    if (!home) return { date: day, zone, items: [], reason: 'Set your home in Settings, Maps, to get leave-by times.' };
    const mode = this.defaultMode();
    const items: LeaveByItem[] = [];
    for (const e of events) {
      const base = { title: e.title, start: e.start, startText: localHhmm(e.start, zone), location: e.location!.trim(), mode };
      try {
        const route = await this.cached(`leave:${e.id}:${e.start}:${base.location}:${mode}`, TTL.leave, async () => (await this.routeBetween(home, await this.resolve(base.location), mode, undefined, e.start)).value);
        items.push({ ...base, mode: route.mode, durationSec: route.durationSec, ...(route.leaveBy ? { leaveBy: route.leaveBy, leaveByText: route.leaveByText } : {}) });
      } catch (err) {
        items.push({ ...base, error: err instanceof MapsError ? err.message : 'Could not work out the travel time.' });
      }
    }
    return { date: day, zone, items };
  }

  /** The leave-by lines for DayPlan's text, or '' when there is nothing to say. */
  async travelText(date?: string): Promise<string> {
    const d = await this.leaveBy(date);
    if (!d.items.length) return d.reason ? `Travel\n- ${d.reason}` : '';
    const lines = d.items.map((i) => (i.leaveByText ? `- Leave by ${i.leaveByText} for ${i.title} at ${i.startText} (${i.location}): ${durationWords(i.durationSec ?? 0)} ${MODE_BY[i.mode]}.` : `- ${i.title} at ${i.startText} (${i.location}): no travel time. ${i.error ?? ''}`.trim()));
    // titles and places come from the calendar, invites from strangers included: framework tags defused
    return defuseFrameworkTags(['Travel from home for events with a place. Put each leave-by time in the plan as a reminder item:', ...lines].join('\n'));
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** A place id goes to the provider that made it, so an old card still works after a switch. */
  private providerFor(id: string): MapsProvider {
    if (this.member()) return this.provider();
    return id.startsWith('osm:') ? this.osm : this.google;
  }

  private homeResolved(): Resolved | undefined {
    const h = this.home();
    return h ? { label: 'Home', point: { lat: h.lat, lng: h.lng }, waypoint: { point: { lat: h.lat, lng: h.lng } } } : undefined;
  }

  /** "lat,lng", a place id from a result, or a name or address. `point`: the caller needs coordinates. */
  private async resolve(text: string, point = false): Promise<Resolved> {
    const ll = parseLatLng(text);
    if (ll) return { label: pointText(ll), point: ll, waypoint: { point: ll } };
    if (/^home$/i.test(text)) {
      const h = this.homeResolved();
      if (!h) throw new MapsError('bad_input', 'Your home is not set. Set it in Settings, Maps.', 400);
      return h;
    }
    const seen = this.seen.get(this.scoped(text));
    if (seen) return { label: seen.name, point: { lat: seen.lat, lng: seen.lng }, waypoint: { point: { lat: seen.lat, lng: seen.lng } }, ...(seen.id.startsWith('osm:') ? {} : { googleId: seen.id }) };
    const google = this.providerId() === 'google';
    if (/^osm:[NWR]\d+$/.test(text) || (google && looksLikeGoogleId(text))) {
      const d = (await this.placeDetails(text)).value;
      return { label: d.name, point: { lat: d.lat, lng: d.lng }, waypoint: { point: { lat: d.lat, lng: d.lng } }, ...(text.startsWith('osm:') ? {} : { googleId: d.id }) };
    }
    // Google routes an address itself, one call fewer; a map marker or OpenStreetMap needs the point
    if (google && !point) return { label: text, waypoint: { address: text } };
    const provider = this.provider();
    const g = await this.cached<Geocoded | undefined>(`geocode:${provider.id}:${text.toLowerCase()}`, TTL.geocode, () => provider.geocode(text));
    if (!g) throw new MapsError('not_found', `Could not find "${text}". Try a fuller address.`, 404);
    return { label: shortLabel(text, g.label), point: { lat: g.lat, lng: g.lng }, waypoint: g.placeId ? { placeId: g.placeId } : { point: { lat: g.lat, lng: g.lng } }, ...(g.placeId ? { googleId: g.placeId } : {}) };
  }

  /** Time words to epoch ms in the owner's zone: "17:40" (next one), "2026-10-24 17:40", or ISO with an offset. */
  private when(v: string, field: string): number {
    const s = v.trim();
    const zone = this.zone();
    const now = this.now();
    let t: number;
    if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) {
      const hhmm = s.padStart(5, '0');
      t = atLocal(localDate(now, zone), hhmm, zone);
      if (t < now - 5 * 60_000) t = atLocal(addDays(localDate(now, zone), 1), hhmm, zone);
    } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(s)) t = atLocal(s.slice(0, 10), s.slice(11, 16), zone);
    else t = Date.parse(s);
    if (!Number.isFinite(t)) throw new MapsError('bad_input', `${field} must be a time like 17:40, 2026-10-24 17:40, or ISO 8601.`, 400);
    if (t < now - 5 * 60_000) throw new MapsError('bad_input', `${field} is in the past.`, 400);
    return t;
  }

  private card(r: RawPlace, near?: LatLng): PlaceCard {
    const app = this.links();
    const googleId = r.id.startsWith('osm:') ? undefined : r.id;
    // Google's own link opens the place page; by coordinates for OpenStreetMap places and Apple Maps
    const mapsUrl = app === 'google' && r.googleUri ? r.googleUri : placeLink(app, { lat: r.lat, lng: r.lng, name: r.name, ...(googleId ? { googleId } : {}) });
    return {
      id: r.id,
      name: r.name,
      ...(r.address ? { address: r.address } : {}),
      lat: r.lat,
      lng: r.lng,
      ...(r.rating !== undefined ? { rating: r.rating } : {}),
      ...(r.ratings !== undefined ? { ratings: r.ratings } : {}),
      ...(r.openNow !== undefined ? { openNow: r.openNow } : {}),
      ...(r.price !== undefined ? { price: r.price } : {}),
      mapsUrl,
      directionsUrl: directionsLink(app, { lat: r.lat, lng: r.lng, ...(googleId ? { googleId } : {}) }, this.defaultMode()),
      ...(near ? { distanceMeters: Math.round(metersBetween(near, r)) } : {}),
    };
  }

  private placeLine(p: PlaceCard): string {
    const bits = [`${p.name} [${p.id}].`];
    if (p.rating !== undefined) bits.push(`${ratingWords(p.rating)} stars${p.ratings ? ` from ${countWords(p.ratings)} ratings` : ''}.`);
    if (p.openNow !== undefined) bits.push(p.openNow ? 'Open now.' : 'Closed now.');
    if (p.price !== undefined) bits.push(`Price ${priceMarks(p.price)}.`);
    if (p.address) bits.push(`${p.address}.`);
    if (p.distanceMeters !== undefined) bits.push(`${distanceWords(p.distanceMeters)} away.`);
    return bits.join(' ').replace(/\.\./g, '.');
  }

  private cardNote(kind: 'places' | 'route'): string {
    const app = LINK_WORDS[this.links()];
    return kind === 'places'
      ? `The owner sees each place as a card with Open in ${app} and Directions buttons, so do not repeat links or every detail.`
      : `The owner sees this as a card with an Open in ${app} button, so do not repeat links or every number.`;
  }

  private async cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const k = this.scoped(key);
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit as T;
    const v = await this.guard(fn);
    if (v !== undefined) this.cache.set(k, v, ttl);
    return v;
  }

  /** Run a provider call; anything it throws leaves as plain words without the key. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MapsError) throw new MapsError(err.code, this.scrub(err.message), err.status);
      throw new MapsError('error', this.scrub(`Maps failed: ${(err as Error)?.message ?? String(err)}`), 502);
    }
  }

  /** The key, and anything shaped like one, out of a text. */
  scrub(text: string): string {
    const k = this.keyNow().key;
    const out = k ? text.split(k).join('[key]') : text;
    return redactSecrets(out);
  }

  private store<T>(id: string, kind: 'route' | 'image', data: T): void {
    const now = this.now();
    this.host.db.query('INSERT OR REPLACE INTO maps_items (id, kind, data, created_at, account_id) VALUES (?, ?, ?, ?, ?)').run(id, kind, JSON.stringify(data), now, currentAccount() ?? OWNER_ID);
    if (now - this.lastPrune > 3_600_000) {
      this.lastPrune = now;
      this.host.db.query('DELETE FROM maps_items WHERE created_at < ?').run(now - KEEP_MS);
    }
  }

  private load<T>(id: string, kind: 'route' | 'image'): T | undefined {
    const row = this.host.db.query('SELECT data FROM maps_items WHERE id = ? AND kind = ? AND account_id = ?').get(id, kind, currentAccount() ?? OWNER_ID) as { data: string } | null;
    return row ? json<T | undefined>(row.data, undefined) : undefined;
  }
}

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** Google place ids: "ChIJ..." mostly, else a long run of mixed case letters and digits. Not a street name. */
export function looksLikeGoogleId(s: string): boolean {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(s)) return false;
  return s.startsWith('ChIJ') || (/\d/.test(s) && /[A-Z]/.test(s.slice(1)) && /[a-z]/.test(s));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

/** What the owner typed when it is short, else the first parts of the found address. */
function shortLabel(typed: string, found: string): string {
  if (typed.length <= 48) return typed;
  return found.split(',').slice(0, 2).join(',').trim();
}

export { OSM_ATTRIBUTION };
