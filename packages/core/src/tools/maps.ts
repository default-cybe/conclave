/**
 * Maps tools (maps/service.ts): PlaceSearch, PlaceDetails, Directions and
 * MapImage. They only read, so they never ask. The model gets text; the
 * result's meta.maps carries the card the clients draw (a place, a route,
 * a map image served by the hub). No key or keyed URL is in either.
 * Untrusted agents never get them (UNTRUSTED_DENY): a web page must not
 * steer calls that spend the owner's quota or read where home is.
 */
import type { MapsAnswer, MapsService } from '../maps/service';
import { MapsError } from '../maps/types';
import { defuseFrameworkTags } from '../session/untrusted';
import type { Tool, ToolContext, ToolOutput } from './types';
import { fail } from './util';

const NO_MAPS = 'Maps are not available on this hub.';
const MODES = ['walk', 'transit', 'drive', 'bicycle'];

async function answer<T>(ctx: ToolContext, run: (s: MapsService) => Promise<MapsAnswer<T>>): Promise<ToolOutput> {
  const s = ctx.host.maps;
  if (!s) return fail(NO_MAPS);
  try {
    const a = await run(s);
    // place names, addresses and hours are map data (OpenStreetMap is anyone's edit): framework tags defused
    return { content: defuseFrameworkTags(a.text), meta: { maps: a.card } };
  } catch (err) {
    if (err instanceof MapsError) return fail(err.message, { code: `MAPS_${err.code.toUpperCase()}` });
    return fail(s.scrub(`Maps failed: ${(err as Error)?.message ?? String(err)}`));
  }
}

export interface PlaceSearchInput {
  query?: string;
  type?: string;
  near?: string;
  radiusMeters?: number;
  openNow?: boolean;
  limit?: number;
}

export const PlaceSearchTool: Tool<PlaceSearchInput> = {
  name: 'PlaceSearch',
  description: `Find places: shops, cafes, pharmacies, venues, addresses. Returns names, addresses, ids and, with Google as the provider, rating, open now and price. The owner sees each place as a card with links.

- query: what to find, "coffee", "Café Einstein Berlin", "24h pharmacy".
- type: a place type instead of a query for "nearest X", such as cafe, restaurant, pharmacy, supermarket, gym. Searches around near, or around home.
- near: where to search around: "home", an address, or "lat,lng". Without it a query searches everywhere and a type searches around home.
- radiusMeters: how far around near, default 1500.
- openNow: only places open now (Google only).
- limit: 1 to 10, default 5.

Use the ids with PlaceDetails, Directions and MapImage.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      type: { type: 'string' },
      near: { type: 'string' },
      radiusMeters: { type: 'number' },
      openNow: { type: 'boolean' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  timeoutMs: 60_000,
  summarize: (i) => `Find ${i.query ?? i.type ?? 'places'}${i.near ? ` near ${i.near}` : ''}`,
  run: (input, ctx) => answer(ctx, (s) => s.searchPlaces(input)),
};

export const PlaceDetailsTool: Tool<{ id: string }> = {
  name: 'PlaceDetails',
  description: `One place by the id PlaceSearch gave: name, address, location, and with Google as the provider the rating, open now, this week's hours and price. Use it for "is it open on Sunday" or "when does it close".`,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  readOnly: true,
  timeoutMs: 60_000,
  summarize: (i) => `Look up place ${String(i.id ?? '').slice(0, 40)}`,
  run: (input, ctx) => answer(ctx, (s) => s.placeDetails(input.id)),
};

export interface DirectionsToolInput {
  from?: string;
  to: string;
  mode?: string;
  departAt?: string;
  arriveBy?: string;
}

export const DirectionsTool: Tool<DirectionsToolInput> = {
  name: 'Directions',
  description: `Travel time and distance between two places, in the owner's timezone, with a leave-by time when you give an arrival time. The owner sees a route card with a link that opens the directions.

- from: "home" (default), an address, a place id from PlaceSearch, or "lat,lng".
- to: an address, a place id from PlaceSearch, "home", or "lat,lng".
- mode: walk, transit, drive or bicycle. Default: the owner's travel mode from Settings.
- departAt or arriveBy: "17:40" (the next one), "2026-10-24 17:40", or ISO 8601. arriveBy gives the leave-by time.

Driving times include traffic with Google. OpenStreetMap has no transit times and gives the walk instead. The result has a route id for MapImage.`,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      mode: { type: 'string', enum: MODES },
      departAt: { type: 'string' },
      arriveBy: { type: 'string' },
    },
    required: ['to'],
    additionalProperties: false,
  },
  readOnly: true,
  timeoutMs: 60_000,
  summarize: (i) => `Directions to ${String(i.to ?? '').slice(0, 60)}${i.mode ? ` (${i.mode})` : ''}`,
  run: (input, ctx) => answer(ctx, (s) => s.directions(input)),
};

export interface MapImageToolInput {
  markers?: Array<string | { at: string; label?: string }>;
  route?: string;
  width?: number;
  height?: number;
  zoom?: number;
}

export const MapImageTool: Tool<MapImageToolInput> = {
  name: 'MapImage',
  description: `Show the owner a map in the chat: markers, a route, or both. You cannot see the image; it is for the owner.

- markers: up to 10, each { at, label }. at is "home", an address, a place id from PlaceSearch, or "lat,lng"; label is one letter or digit, default A, B, C.
- route: a route id from Directions, drawn as a line. With no markers its two ends get A and B.
- width and height: pixels, default 600 by 320, at most 640.
- zoom: 1 to 19. Default fits everything.`,
  inputSchema: {
    type: 'object',
    properties: {
      markers: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, label: { type: 'string' } }, required: ['at'] } },
      route: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      zoom: { type: 'number' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  timeoutMs: 90_000,
  summarize: (i) => (i.route ? 'Map of a route' : `Map of ${Array.isArray(i.markers) ? i.markers.length : 0} places`),
  run: (input, ctx) => answer(ctx, (s) => s.mapImage(input)),
};

export const MAPS_TOOLS = [PlaceSearchTool, PlaceDetailsTool, DirectionsTool, MapImageTool];
