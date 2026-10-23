/**
 * Maps cards in words (MapsCard.tsx): the card data a maps tool result
 * carries, a place's facts line, a route's headline and times, and the one
 * line a tool row says when it is done. Pure, so the tests read it.
 */
import type { MapsCardData, PlaceCard, RouteCard } from '@conclave/core/client';
import { countWords, distanceWords, durationWords, LINK_WORDS, MODE_BY, priceMarks, ratingWords } from '@conclave/core/maps/words';

export const MAPS_TOOLS = new Set(['PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage']);

export function isMapsTool(name: string): boolean {
  return MAPS_TOOLS.has(name);
}

/** The card a result carries, when it is one the app knows how to draw. */
export function mapsCardOf(result: { meta?: Record<string, unknown>; isError?: boolean } | undefined): MapsCardData | undefined {
  const c = result && !result.isError ? (result.meta?.maps as MapsCardData | undefined) : undefined;
  if (!c || typeof c !== 'object') return undefined;
  if (c.kind === 'places' && Array.isArray(c.places) && c.places.length) return c;
  if (c.kind === 'route' && c.route && typeof c.route.durationSec === 'number') return c;
  if (c.kind === 'map' && c.image && typeof c.image.id === 'string') return c;
  return undefined;
}

/** "Open in Google Maps". */
export function openWords(c: Pick<MapsCardData, 'kind'> & { links?: 'google' | 'apple' }): string {
  return `Open in ${LINK_WORDS[c.links ?? 'google']}`;
}

export interface Fact {
  text: string;
  tone?: 'ok' | 'dim';
}

/** "4.6 stars (1,203)", "Open now", "$$": what Google knows. OpenStreetMap places have none, so the line is left out. */
export function placeFacts(p: PlaceCard): Fact[] {
  const out: Fact[] = [];
  if (p.rating !== undefined) out.push({ text: `${ratingWords(p.rating)} stars${p.ratings ? ` (${countWords(p.ratings)})` : ''}` });
  if (p.openNow !== undefined) out.push(p.openNow ? { text: 'Open now', tone: 'ok' } : { text: 'Closed now', tone: 'dim' });
  if (p.price !== undefined) out.push({ text: priceMarks(p.price) });
  return out;
}

/** "24 min by transit". */
export function routeHeadline(r: RouteCard): string {
  return `${durationWords(r.durationSec)} ${MODE_BY[r.mode]}`;
}

/** "Leave by 17:36, arrive 18:00", or "Leaving 17:12, arriving 17:36". */
export function routeTimes(r: RouteCard): string {
  if (r.leaveByText) return `Leave by ${r.leaveByText}, arrive ${r.arriveText}`;
  return `Leaving ${r.departText}, arriving ${r.arriveText}${r.arriveLocal ? ` (${r.arriveLocal})` : ''}`;
}

/** "Home to Café Linde, 5.1 km". */
export function routeWhere(r: RouteCard): string {
  return `${r.from.label} to ${r.to.label}, ${distanceWords(r.distanceMeters)}`;
}

/** The rest worth a line: the lines taken, traffic, what the provider could not do. */
export function routeExtra(r: RouteCard): string {
  const bits: string[] = [];
  if (r.summary) bits.push(r.summary.startsWith('via ') ? `${r.summary[0].toUpperCase()}${r.summary.slice(1)}.` : `${r.summary}.`);
  if (r.trafficSec) bits.push(`Traffic adds ${durationWords(r.trafficSec)}.`);
  if (r.note) bits.push(r.note);
  return bits.join(' ');
}

/** What a done maps row says: "3 places", "24 min", "map". */
export function mapsDoneWords(c: MapsCardData | undefined): string {
  if (!c) return 'done';
  if (c.kind === 'places') return c.places.length === 1 ? '1 place' : `${c.places.length} places`;
  if (c.kind === 'route') return durationWords(c.route.durationSec);
  return 'map';
}

/** The line of a maps call on the Chat page: "Found 3 places for coffee", "Directions to Café Linde", "Drew a map". */
export function mapsLineWords(name: string, input: Record<string, unknown> | undefined, c: MapsCardData | undefined): string {
  const q = typeof input?.query === 'string' ? input.query : typeof input?.type === 'string' ? input.type.replace(/_/g, ' ') : '';
  switch (name) {
    case 'PlaceSearch': {
      const n = c?.kind === 'places' ? c.places.length : 0;
      return n ? `Found ${n === 1 ? '1 place' : `${n} places`}${q ? ` for ${q}` : ''}` : `No places found${q ? ` for ${q}` : ''}`;
    }
    case 'PlaceDetails':
      return c?.kind === 'places' ? `Looked up ${c.places[0].name}` : 'Looked up a place';
    case 'Directions':
      return c?.kind === 'route' ? `Directions to ${c.route.to.label}` : 'Directions';
    default:
      return 'Drew a map';
  }
}

/** What a done maps row names, from its result: "coffee near Home", "Home to Café Linde", "of the walk route". */
export function mapsRowTarget(c: MapsCardData | undefined, input: Record<string, unknown> | undefined): string | undefined {
  if (!c) return undefined;
  if (c.kind === 'route') return `${c.route.from.label} to ${c.route.to.label}`;
  if (c.kind === 'places') {
    if (c.places.length === 1 && typeof input?.id === 'string') return c.places[0].name;
    const q = typeof input?.query === 'string' ? input.query : typeof input?.type === 'string' ? input.type.replace(/_/g, ' ') : undefined;
    return q ? `${q}${typeof input?.near === 'string' ? ` near ${input.near}` : ''}` : undefined;
  }
  return c.image.alt.replace(/^Map of /, '');
}

/** What runs now, for the working line: "Searching places", "Getting directions". */
export function mapsWorkingWords(name: string): string | undefined {
  switch (name) {
    case 'PlaceSearch':
      return 'Searching places';
    case 'PlaceDetails':
      return 'Looking up a place';
    case 'Directions':
      return 'Getting directions';
    case 'MapImage':
      return 'Drawing a map';
  }
  return undefined;
}
