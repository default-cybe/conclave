/**
 * Checking what comes in: a watch's spec (Routine.watch, from WatchCreate or
 * the filters sheet) and the items a run reports (WatchReport). Every limit
 * that keeps a watch small lives here. Pure, no imports beyond types.
 */
import type { ListingStatus, ReportedItem, WatchFilters, WatchSpec } from './types';

export const DEFAULT_CAP = 200;
export const MAX_CAP = 1000;
/** Items one run may report, over all its WatchReport calls. */
export const MAX_REPORTED = 400;
/** History entries kept per item. */
export const HISTORY_MAX = 30;
/** Runs kept per watch. */
export const RUNS_KEPT = 60;
export const MAX_FIELDS = 12;

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATUSES: ReadonlySet<ListingStatus> = new Set(['available', 'pending', 'sold', 'gone']);

function text(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const t = String(v).replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function num(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} must be a number of 0 or more`);
  return n;
}

function words(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : undefined;
  if (!list) throw new Error(`${field} must be a list of words`);
  const out = [...new Set(list.map((x) => text(x, 60)).filter((x): x is string => !!x))];
  if (out.length > 20) throw new Error(`${field} has more than 20 entries`);
  return out.length ? out : undefined;
}

/** An http(s) address, or undefined. Anything else is not kept. */
export function httpUrl(v: unknown, max = 2000): string | undefined {
  const t = text(v, max + 1);
  if (!t || t.length > max) return undefined;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function cleanFilters(v: unknown): WatchFilters | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('filters must be an object');
  const f = v as Record<string, unknown>;
  const out: WatchFilters = {};
  const minPrice = num(f.minPrice, 'filters.minPrice');
  const maxPrice = num(f.maxPrice, 'filters.maxPrice');
  if (minPrice !== undefined) out.minPrice = minPrice;
  if (maxPrice !== undefined) out.maxPrice = maxPrice;
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) throw new Error('filters.minPrice is above filters.maxPrice');
  const maxDistance = num(f.maxDistance, 'filters.maxDistance');
  if (maxDistance !== undefined) out.maxDistance = maxDistance;
  if (f.unit !== undefined && f.unit !== null && f.unit !== '') {
    if (f.unit !== 'km' && f.unit !== 'mi') throw new Error('filters.unit must be km or mi');
    out.unit = f.unit;
  }
  const near = text(f.near, 120);
  if (near) out.near = near;
  const keywords = words(f.keywords, 'filters.keywords');
  if (keywords) out.keywords = keywords;
  const exclude = words(f.exclude, 'filters.exclude');
  if (exclude) out.exclude = exclude;
  return Object.keys(out).length ? out : undefined;
}

/** A watch spec the hub can keep. Throws a sentence the API returns as a 400. */
export function cleanWatchSpec(v: unknown): WatchSpec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('watch must be an object with a url');
  const w = v as Record<string, unknown>;
  const url = httpUrl(w.url);
  if (!url) throw new Error('watch.url must be an http or https address');
  const out: WatchSpec = { url };
  if (w.profile !== undefined && w.profile !== null && w.profile !== '') {
    if (typeof w.profile !== 'string' || !PROFILE.test(w.profile.trim()) || w.profile.includes('..')) throw new Error('watch.profile must be a browser profile name');
    out.profile = w.profile.trim();
  }
  const fields = words(w.fields, 'watch.fields');
  if (fields) {
    if (fields.length > MAX_FIELDS) throw new Error(`watch.fields has more than ${MAX_FIELDS} names`);
    out.fields = fields.map((f) => f.toLowerCase());
  }
  const filters = cleanFilters(w.filters);
  if (filters) out.filters = filters;
  if (w.notify !== undefined && w.notify !== null && w.notify !== '') {
    if (w.notify !== 'change' && w.notify !== 'daily') throw new Error('watch.notify must be change or daily');
    out.notify = w.notify;
  }
  const cap = num(w.cap, 'watch.cap');
  if (cap !== undefined) {
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP) throw new Error(`watch.cap must be a whole number from 1 to ${MAX_CAP}`);
    out.cap = cap;
  }
  const currency = text(w.currency, 8);
  if (currency) {
    if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error('watch.currency must be a three letter code such as USD');
    out.currency = currency.toUpperCase();
  }
  return out;
}

/** "$6,500", "6.500 €", "6500" -> 6500. Undefined when there is no number ("Free" is 0). */
export function parsePrice(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^free\b/i.test(s)) return 0;
  // groups of three after a space or an apostrophe ("1 500 €", "CHF 1'200"), else digits with dots and commas;
  // a number after the price ("$1,200 1 bd", "$8,500 2019 Honda") is not part of it
  const m = /\d{1,3}(?:[   '’]\d{3})+(?!\d)(?:[.,]\d{1,2}(?!\d))?|\d[\d.,]*/.exec(s);
  if (!m) return undefined;
  let digits = m[0].replace(/[\s'’]/g, '').replace(/[.,]$/, '');
  // "6.500" and "6,500" are thousands; "6,50" and "6.5" are decimals
  const last = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  if (last >= 0 && digits.length - last - 1 === 3) digits = digits.replace(/[.,]/g, '');
  else if (last >= 0) digits = digits.slice(0, last).replace(/[.,]/g, '') + '.' + digits.slice(last + 1);
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}

/** Query parameters that name a listing ("details.html?id=402"), kept in an id made from a link. */
const ID_PARAMS = /^(id|item|itemid|item_id|listing|listingid|listing_id|ad|adid|ad_id|aid|pid|productid|product_id|offer|offerid|expose|vid)$/i;

/**
 * The id a site gives an item: the one reported, else the item's address
 * without its query, but with a parameter that names the listing, so two
 * listings on one page address stay two items. Tracking parameters change
 * between visits, so they are left out.
 */
function itemId(id: unknown, url: string | undefined): string | undefined {
  const t = text(id, 200);
  if (t) return t;
  if (!url) return undefined;
  const u = new URL(url);
  const named = [...u.searchParams].filter(([k, v]) => ID_PARAMS.test(k) && v).sort(([a], [b]) => a.localeCompare(b));
  const query = named.length ? `?${named.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${`${u.host}${u.pathname}`.replace(/\/$/, '')}${query}`.slice(0, 300);
}

/** One reported item, cleaned; undefined with a reason when it cannot be kept. */
export function cleanItem(v: unknown): { item?: ReportedItem; problem?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { problem: 'an item is not an object' };
  const r = v as Record<string, unknown>;
  const url = httpUrl(r.url);
  const id = itemId(r.id, url);
  if (!id) return { problem: 'an item has neither an id nor a url' };
  const title = text(r.title, 200);
  const status = typeof r.status === 'string' && STATUSES.has(r.status as ListingStatus) ? (r.status as ListingStatus) : undefined;
  // a gone item needs only its id
  if (!title && status !== 'gone') return { problem: `item ${id} has no title` };
  const item: ReportedItem = { id, title: title ?? '' };
  const price = parsePrice(r.price);
  if (price !== undefined) item.price = price;
  // the site's own words for the price ("$6,500", "Free"); comparisons use the number
  const priceText = typeof r.price === 'string' ? text(r.price, 40) : text(r.priceText, 40);
  if (priceText) item.priceText = priceText;
  const location = text(r.location, 120);
  if (location) item.location = location;
  const distance = typeof r.distance === 'number' && Number.isFinite(r.distance) && r.distance >= 0 ? r.distance : undefined;
  if (distance !== undefined) item.distance = distance;
  if (url) item.url = url;
  const image = httpUrl(r.image);
  if (image) item.image = image;
  if (status) item.status = status;
  if (r.fields && typeof r.fields === 'object' && !Array.isArray(r.fields)) {
    const fields: Record<string, string> = {};
    for (const [k, val] of Object.entries(r.fields as Record<string, unknown>).slice(0, MAX_FIELDS)) {
      const key = text(k, 40)?.toLowerCase();
      const value = text(val, 200);
      if (key && value) fields[key] = value;
    }
    if (Object.keys(fields).length) item.fields = fields;
  }
  return { item };
}

/** Why the filters leave an item out, or undefined when they keep it. */
export function filteredOut(item: Pick<ReportedItem, 'title' | 'price' | 'distance'>, f: WatchFilters | undefined): string | undefined {
  if (!f) return undefined;
  if (item.price !== undefined && f.minPrice !== undefined && item.price < f.minPrice) return 'under the lowest price';
  if (item.price !== undefined && f.maxPrice !== undefined && item.price > f.maxPrice) return 'over the highest price';
  if (item.distance !== undefined && f.maxDistance !== undefined && item.distance > f.maxDistance) return 'too far';
  const title = item.title.toLowerCase();
  const hit = f.exclude?.find((w) => title.includes(w.toLowerCase()));
  if (hit) return `the title has "${hit}"`;
  return undefined;
}

/** The host a watch browses, for its allow rule: www. is dropped, so subdomains match. */
export function ruleHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
}
