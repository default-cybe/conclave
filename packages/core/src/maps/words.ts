/**
 * Maps numbers as words, the same on the hub, in the model's text and on
 * the web cards: "24 min", "1 h 5 min", "850 m", "5.1 km", "Transit".
 * No node imports.
 */
import type { MapsLinkApp, TravelMode } from './types';

export const MODE_WORDS: Record<TravelMode, string> = { walk: 'Walk', transit: 'Transit', drive: 'Drive', bicycle: 'Bicycle' };
/** "by transit", "on foot". */
export const MODE_BY: Record<TravelMode, string> = { walk: 'on foot', transit: 'by transit', drive: 'by car', bicycle: 'by bicycle' };
export const LINK_WORDS: Record<MapsLinkApp, string> = { google: 'Google Maps', apple: 'Apple Maps' };

/** "4 min", "1 h", "1 h 5 min". Under a minute is "1 min". */
export function durationWords(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "850 m", "5.1 km", "120 km". */
export function distanceWords(m: number): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  return km < 20 ? `${km.toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(km)} km`;
}

/** "4.6", one decimal. */
export function ratingWords(r: number): string {
  return r.toFixed(1);
}

/** "1,203". */
export function countWords(n: number): string {
  return n.toLocaleString('en-US');
}

/** "$$" for a 1 to 4 price level, as Google Maps shows it; 0 is "Free". */
export function priceMarks(level: number): string {
  return level <= 0 ? 'Free' : '$'.repeat(Math.min(4, level));
}
