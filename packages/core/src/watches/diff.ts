/**
 * The compare step of a watch run: what the run reported against what the
 * hub kept, into the new item list and what changed. Pure, so the tests
 * drive it with plain data.
 *
 * - An item the hub never saw (or saw gone) is new, if the filters keep it.
 * - A listed item reported again is still there, or changed: a lower or
 *   higher price, or another listing status (available to pending).
 * - A listed item reported as sold or gone, or not reported at all, is gone.
 *   The run is told which items it has not reported yet (WatchReport's
 *   reply), so it can open their links before it ends.
 * - Gone items stay for their history until the cap needs the room.
 */
import { DEFAULT_CAP, HISTORY_MAX, filteredOut } from './spec';
import type { ReportedItem, WatchCounts, WatchFilters, WatchHistoryEntry, WatchItem, WatchMark, WatchRunSummary, WatchSpec } from './types';

export interface DiffResult {
  /** Every item kept after the run, capped. */
  items: WatchItem[];
  /** Ids of items the cap dropped. */
  dropped: string[];
  summary: Omit<WatchRunSummary, 'runId' | 'routineId'>;
}

function push(h: WatchHistoryEntry[], e: WatchHistoryEntry): WatchHistoryEntry[] {
  const out = [...h, e];
  return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out;
}

/** Merge the run's reports: the latest report of an id wins, but a later report without a field keeps the earlier one's. */
export function mergeReports(reports: ReportedItem[]): Map<string, ReportedItem> {
  const out = new Map<string, ReportedItem>();
  for (const r of reports) {
    const prev = out.get(r.id);
    out.set(r.id, prev ? { ...prev, ...r, title: r.title || prev.title, fields: { ...prev.fields, ...r.fields } } : r);
  }
  return out;
}

const PLURAL: Record<keyof WatchCounts, [string, string]> = {
  new: ['new', 'new'],
  gone: ['gone', 'gone'],
  priceDown: ['price drop', 'price drops'],
  priceUp: ['price rise', 'price rises'],
  changed: ['other change', 'other changes'],
  still: ['still there', 'still there'],
};

/** "3 new, 1 gone, 1 price drop". "No change" when nothing moved. */
export function countWords(c: WatchCounts, opts: { still?: boolean } = {}): string {
  const keys: Array<keyof WatchCounts> = ['new', 'gone', 'priceDown', 'priceUp', 'changed'];
  const parts = keys.filter((k) => c[k] > 0).map((k) => `${c[k]} ${PLURAL[k][c[k] === 1 ? 0 : 1]}`);
  if (!parts.length) return opts.still && c.still ? `No change, ${c.still} still there` : 'No change';
  if (opts.still && c.still) parts.push(`${c.still} still there`);
  return parts.join(', ');
}

export function changedCount(c: WatchCounts): number {
  return c.new + c.gone + c.priceDown + c.priceUp + c.changed;
}

/** Listed first: new, price changes, other changes, still there; gone last, newest gone first. */
export function sortItems(items: WatchItem[]): WatchItem[] {
  const rank: Record<WatchMark, number> = { new: 0, price_down: 1, price_up: 2, changed: 3, still: 4, gone: 5 };
  return [...items].sort((a, b) => rank[a.mark] - rank[b.mark] || (a.present ? b.firstSeen - a.firstSeen : (b.goneAt ?? 0) - (a.goneAt ?? 0)) || a.title.localeCompare(b.title));
}

/**
 * Compare a run's reports with the kept items. `complete` is false when the
 * run did not finish (an error): then nothing is marked gone for being left
 * out, and only what it did report counts.
 */
export function diffRun(prev: WatchItem[], reports: ReportedItem[], spec: Pick<WatchSpec, 'filters' | 'cap'>, now: number, opts: { complete?: boolean } = {}): DiffResult {
  const complete = opts.complete !== false;
  const filters: WatchFilters | undefined = spec.filters;
  const seen = mergeReports(reports);
  const byId = new Map(prev.map((i) => [i.id, i]));
  const counts: WatchCounts = { new: 0, gone: 0, priceDown: 0, priceUp: 0, changed: 0, still: 0 };
  const changes: WatchRunSummary['changes'] = { new: [], gone: [], priceDown: [], priceUp: [], changed: [] };
  let filtered = 0;
  const next = new Map<string, WatchItem>();

  // last run's gone items keep their gone mark only for that run: from now on they are just gone
  for (const item of prev) next.set(item.id, item.present ? item : { ...item, mark: 'gone' });

  for (const r of seen.values()) {
    const old = byId.get(r.id);
    const ends = r.status === 'sold' || r.status === 'gone';
    if (!old || !old.present) {
      // never seen, or back after it was gone
      if (ends) continue;
      if (filteredOut(r, filters)) {
        filtered++;
        continue;
      }
      const back = !!old;
      const item: WatchItem = {
        id: r.id,
        title: r.title || old?.title || r.id,
        ...(r.price !== undefined ? { price: r.price } : {}),
        ...(r.priceText ? { priceText: r.priceText } : {}),
        ...(r.location ? { location: r.location } : {}),
        ...(r.distance !== undefined ? { distance: r.distance } : {}),
        ...(r.url ?? old?.url ? { url: r.url ?? old?.url } : {}),
        ...(r.image ?? old?.image ? { image: r.image ?? old?.image } : {}),
        status: r.status ?? 'available',
        ...(r.fields ? { fields: r.fields } : {}),
        present: true,
        mark: 'new',
        firstSeen: back ? old!.firstSeen : now,
        lastSeen: now,
        history: push(old?.history ?? [], { at: now, kind: back ? 'back' : 'seen', ...(r.price !== undefined ? { price: r.price } : {}) }),
      };
      next.set(r.id, item);
      counts.new++;
      changes.new.push(r.id);
      continue;
    }
    if (ends) {
      next.set(r.id, { ...old, status: r.status!, present: false, mark: 'gone', goneAt: now, lastSeen: now, history: push(old.history, { at: now, kind: 'gone', status: r.status }) });
      counts.gone++;
      changes.gone.push(r.id);
      continue;
    }
    let history = old.history;
    let mark: WatchMark = 'still';
    const price = r.price ?? old.price;
    if (r.price !== undefined && old.price !== undefined && r.price !== old.price) {
      history = push(history, { at: now, kind: 'price', price: r.price, from: old.price });
      mark = r.price < old.price ? 'price_down' : 'price_up';
    }
    const status = r.status ?? old.status;
    if (status !== old.status) {
      history = push(history, { at: now, kind: 'status', status });
      if (mark === 'still') mark = 'changed';
    }
    next.set(r.id, {
      ...old,
      title: r.title || old.title,
      ...(price !== undefined ? { price } : {}),
      ...(r.priceText ? { priceText: r.priceText } : r.price !== undefined && r.price !== old.price ? { priceText: undefined } : {}),
      ...(r.location ? { location: r.location } : {}),
      ...(r.distance !== undefined ? { distance: r.distance } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.image ? { image: r.image } : {}),
      ...(r.fields ? { fields: { ...old.fields, ...r.fields } } : {}),
      status,
      mark,
      lastSeen: now,
      history,
    });
    if (mark === 'price_down') {
      counts.priceDown++;
      changes.priceDown.push(r.id);
    } else if (mark === 'price_up') {
      counts.priceUp++;
      changes.priceUp.push(r.id);
    } else if (mark === 'changed') {
      counts.changed++;
      changes.changed.push(r.id);
    } else counts.still++;
  }

  // listed before, not reported now: gone (a run that did not finish leaves them as they were)
  for (const old of prev) {
    if (!old.present || seen.has(old.id)) continue;
    if (!complete) {
      next.set(old.id, { ...old, mark: 'still' });
      counts.still++;
      continue;
    }
    next.set(old.id, { ...old, present: false, mark: 'gone', goneAt: now, history: push(old.history, { at: now, kind: 'gone', status: 'not found' }) });
    counts.gone++;
    changes.gone.push(old.id);
  }

  // the cap: gone items go first, oldest gone first, then the items seen longest ago, then the newest:
  // a search that lists more than the cap keeps the items it has, or each run would drop some of them
  // and call them new the next time
  const cap = spec.cap ?? DEFAULT_CAP;
  let items = [...next.values()];
  const dropped: string[] = [];
  if (items.length > cap) {
    const order = [...items].sort((a, b) => Number(a.present) - Number(b.present) || (a.present ? a.lastSeen - b.lastSeen || b.firstSeen - a.firstSeen : (a.goneAt ?? 0) - (b.goneAt ?? 0)));
    // this run's changes stay when they fit, so the notice can show them
    const keep = new Set(order.slice(order.length - cap).map((i) => i.id));
    dropped.push(...items.filter((i) => !keep.has(i.id)).map((i) => i.id));
    items = items.filter((i) => keep.has(i.id));
    // what the cap dropped was not kept, so it is not news; a gone item still went
    for (const k of ['new', 'priceDown', 'priceUp', 'changed'] as const) {
      changes[k] = changes[k].filter((id) => keep.has(id));
      counts[k] = changes[k].length;
    }
    counts.still = items.filter((i) => i.present && i.mark === 'still').length;
  }
  const total = items.filter((i) => i.present).length;
  return {
    items: sortItems(items),
    dropped,
    summary: { at: now, counts, total, changes, ...(filtered ? { filtered } : {}), words: countWords(counts) },
  };
}
