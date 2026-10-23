/**
 * Watches in words (WatchCards.tsx, WatchPage.tsx, the Routines rows): the
 * card a WatchReport or WatchCreate result carries, prices, the chip of
 * each item, its history, and the one line a row says. Pure, so the tests
 * read it.
 */
import type { WatchCardData, WatchCounts, WatchHistoryEntry, WatchItem, WatchMark, WatchRunSummary, WatchSpec, WatchSummaryDto } from '@conclave/core/client';
import { countWords } from '@conclave/core/watches/diff';

export { countWords };

export const WATCH_TOOLS = new Set(['WatchReport', 'WatchCreate']);

/** The card a result carries, when it is one the app knows how to draw. */
export function watchCardOf(result: { meta?: Record<string, unknown>; isError?: boolean } | undefined): WatchCardData | undefined {
  const c = result && !result.isError ? (result.meta?.watch as WatchCardData | undefined) : undefined;
  if (!c || typeof c !== 'object') return undefined;
  if (c.kind === 'items' && Array.isArray(c.items) && c.items.length) return c;
  if (c.kind === 'created' && typeof c.routineId === 'string') return c;
  return undefined;
}

/** The result column of a watch call's row: the row already names what it found. */
export function watchDoneWords(tool: string, c: WatchCardData | undefined): string {
  if (tool === 'WatchCreate') return c?.kind === 'created' ? 'made' : 'done';
  if (c?.kind === 'items' && c.routineId) return 'recorded';
  return c?.kind === 'items' ? 'shown below' : 'done';
}

/** "$6,500" for USD, "6,500 EUR" otherwise; the site's own words when it gave some. */
export function priceWords(price: number | undefined, text?: string, currency?: string): string {
  if (text) return text;
  if (price === undefined) return 'No price';
  const n = price.toLocaleString('en-US', { maximumFractionDigits: price % 1 ? 2 : 0 });
  if (price === 0) return 'Free';
  if (currency === 'USD' || !currency) return currency ? `$${n}` : n;
  if (currency === 'EUR') return `€${n}`;
  if (currency === 'GBP') return `£${n}`;
  return `${n} ${currency}`;
}

/** The old price of an item whose price moved in the last run. */
export function wasPrice(item: Pick<WatchItem, 'mark' | 'history'>): number | undefined {
  if (item.mark !== 'price_down' && item.mark !== 'price_up') return undefined;
  return [...item.history].reverse().find((h) => h.kind === 'price')?.from;
}

export const MARK_WORD: Record<WatchMark, string> = {
  new: 'New',
  still: 'Still there',
  gone: 'Gone',
  price_down: 'Price down',
  price_up: 'Price up',
  changed: 'Changed',
};

export type MarkTone = 'signal' | 'ok' | 'warn' | 'dim';

export const MARK_TONE: Record<WatchMark, MarkTone> = {
  new: 'signal',
  price_down: 'ok',
  price_up: 'warn',
  changed: 'warn',
  still: 'dim',
  gone: 'dim',
};

/** The chip of an item: its mark, and "Sold" or "Pending" when the site said so. */
export function chipWords(item: Pick<WatchItem, 'mark' | 'status' | 'present'>): string {
  if (!item.present && item.status === 'sold') return 'Sold';
  if (item.present && item.status === 'pending' && item.mark === 'changed') return 'Pending';
  return MARK_WORD[item.mark];
}

/** "21 Oct" or "21 Oct 2025" when not this year. */
export function dayWords(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const same = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(same ? {} : { year: 'numeric' }) });
}

/** One history line: "First seen 20 Oct at $6,500", "Price $6,500 to $5,900", "Gone, sold". */
export function historyWords(h: WatchHistoryEntry, currency?: string): string {
  switch (h.kind) {
    case 'seen':
      return h.price !== undefined ? `First seen at ${priceWords(h.price, undefined, currency)}` : 'First seen';
    case 'back':
      return 'Listed again';
    case 'price':
      return `Price ${priceWords(h.from, undefined, currency)} to ${priceWords(h.price, undefined, currency)}`;
    case 'status':
      return h.status === 'pending' ? 'Marked pending' : h.status === 'available' ? 'Available again' : `Now ${h.status}`;
    case 'gone':
      return h.status === 'sold' ? 'Gone, sold' : h.status === 'gone' ? 'Gone, no longer listed' : 'Gone, not found';
  }
}

/** "First seen 20 Oct, last seen 21 Oct". */
export function seenWords(item: Pick<WatchItem, 'firstSeen' | 'lastSeen' | 'present' | 'goneAt'>, now = Date.now()): string {
  const first = `First seen ${dayWords(item.firstSeen, now)}`;
  if (!item.present && item.goneAt) return `${first}, gone ${dayWords(item.goneAt, now)}`;
  return `${first}, last seen ${dayWords(item.lastSeen, now)}`;
}

/** What a row on the Routines page says: "12 listed, 3 new". */
export function rowWords(s: Pick<WatchSummaryDto, 'count' | 'newCount'> | undefined): string {
  if (!s) return 'Watching';
  if (!s.count) return 'Nothing listed yet';
  return `${s.count} listed${s.newCount ? `, ${s.newCount} new` : ''}`;
}

/** "3 new, 1 gone, 1 price drop" for the last run, or "No change". */
export function lastRunWords(last: Pick<WatchRunSummary, 'counts'> | undefined): string | undefined {
  return last ? countWords(last.counts) : undefined;
}

/** The facts under an item's title: its place and the fields the watch reads. */
export function factsWords(item: Pick<WatchItem, 'location' | 'fields'>, fields?: string[]): string {
  const parts: string[] = [];
  if (item.location) parts.push(item.location);
  const keys = fields?.length ? fields : Object.keys(item.fields ?? {});
  for (const k of keys) {
    const v = item.fields?.[k];
    if (v) parts.push(v);
  }
  return parts.join(', ');
}

export type ItemFilter = 'all' | 'new' | 'price' | 'still' | 'gone';

/** Items for a filter chip on the watch page. */
export function filterItems(items: WatchItem[], f: ItemFilter): WatchItem[] {
  switch (f) {
    case 'new':
      return items.filter((i) => i.present && i.mark === 'new');
    case 'price':
      return items.filter((i) => i.present && (i.mark === 'price_down' || i.mark === 'price_up'));
    case 'still':
      return items.filter((i) => i.present && (i.mark === 'still' || i.mark === 'changed'));
    case 'gone':
      return items.filter((i) => !i.present);
    default:
      return items;
  }
}

/** "$8,000", "8,000 CHF": an amount in a filter, never "Free". */
function amount(n: number, currency?: string): string {
  return n === 0 ? (currency === 'USD' ? '$0' : '0') : priceWords(n, undefined, currency);
}

/** The filters of a watch in one line ("up to $8,000, within 40 mi of Oakland"), or undefined when it has none. */
export function specWords(spec: WatchSpec): string | undefined {
  const f = spec.filters ?? {};
  const out: string[] = [];
  if (f.minPrice !== undefined && f.maxPrice !== undefined) out.push(`${amount(f.minPrice, spec.currency)} to ${amount(f.maxPrice, spec.currency)}`);
  else if (f.maxPrice !== undefined) out.push(`up to ${amount(f.maxPrice, spec.currency)}`);
  else if (f.minPrice !== undefined) out.push(`from ${amount(f.minPrice, spec.currency)}`);
  if (f.maxDistance !== undefined) out.push(`within ${f.maxDistance} ${f.unit ?? 'km'}${f.near ? ` of ${f.near}` : ''}`);
  else if (f.near) out.push(`near ${f.near}`);
  if (f.keywords?.length) out.push(`looking for ${f.keywords.join(', ')}`);
  if (f.exclude?.length) out.push(`leaving out ${f.exclude.join(', ')}`);
  return out.length ? out.join('; ') : undefined;
}

/** "3 new, 1 gone" for a notice's counts, the same words as the hub's. */
export function noticeWords(c: WatchCounts): string {
  return countWords(c);
}

/** The schedule of a new watch in words for its card: "daily at 09:00". */
export function scheduleShort(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron.trim());
  if (m) return `daily at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  return cron;
}
