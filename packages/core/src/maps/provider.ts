/**
 * What every maps provider answers (google.ts, osm.ts). The service
 * (service.ts) resolves names and "home", counts calls, caches and turns
 * results into cards and text; a provider only talks to its servers.
 */
import type { LatLng, MapImageSpec, MapsApi, MapsProviderId, MapsTestStep, RouteResult, TravelMode } from './types';

export interface RawPlace {
  id: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  rating?: number;
  ratings?: number;
  openNow?: boolean;
  price?: number;
  hours?: string[];
  website?: string;
  /** Google's own link for the place (googleMapsUri). */
  googleUri?: string;
}

export interface SearchQuery {
  /** Free text: "coffee", "Café Einstein Berlin". */
  text?: string;
  /** A place type: "cafe", "pharmacy". */
  type?: string;
  near?: LatLng;
  radiusMeters: number;
  openNow?: boolean;
  limit: number;
}

/** A route end: a point, or for Google a place id or an address it looks up itself. */
export interface Waypoint {
  point?: LatLng;
  placeId?: string;
  address?: string;
}

export interface RouteRequest {
  from: Waypoint;
  to: Waypoint;
  mode: TravelMode;
  /** Epoch ms, in the future. */
  departAt?: number;
  arriveBy?: number;
}

export interface ProviderRoute extends RouteResult {
  /** The mode the provider used, when it is not the one asked for. */
  usedMode?: TravelMode;
  note?: string;
}

export interface Geocoded {
  label: string;
  lat: number;
  lng: number;
  placeId?: string;
}

/** What a provider gets from the service. */
export interface ProviderEnv {
  fetch: typeof fetch;
  /** Count one call against the daily cap; throws MapsError('cap') when it is used up. */
  take(api: MapsApi): void;
  /** "Conclave/0.1.0 (self-hosted assistant hub; owner@example.com)". */
  userAgent(): string;
}

export interface MapsProvider {
  readonly id: MapsProviderId;
  /** Shown under cards and drawn on map images. */
  readonly attribution?: string;
  search(q: SearchQuery): Promise<RawPlace[]>;
  details(id: string): Promise<RawPlace>;
  geocode(text: string): Promise<Geocoded | undefined>;
  route(req: RouteRequest): Promise<ProviderRoute>;
  /** The IANA zone at a point. */
  timezone?(p: LatLng, at: number): Promise<string | undefined>;
  image(spec: MapImageSpec): Promise<{ bytes: Uint8Array; type: string }>;
  /** One real call per API, for the Test button. */
  test(near?: LatLng): Promise<MapsTestStep[]>;
}

/** Seconds from "1234s". */
export function seconds(v: unknown): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(v ?? ''));
  return m ? Math.round(Number(m[1])) : 0;
}
