/**
 * What a watch run may do, and what it is told. A watch only reads the web:
 *
 * - its session is untrusted (session/untrusted.ts), so it is offered only
 *   the tools its routine's allow list names: the reading browser tools
 *   below and WatchReport, with browser_navigate limited to the site;
 * - the writing browser tools are never offered (runner extension in
 *   service.ts), whatever the allow list says;
 * - its browser pages send nothing: every request but GET, HEAD and OPTIONS
 *   and every WebSocket is blocked (BrowserManager.setReadOnly).
 */
import type { Routine } from '../types';
import { ruleHost } from './spec';
import type { WatchItem, WatchSpec } from './types';

/** Browser tools a watch run gets: look, follow links, scroll, go back. */
export const WATCH_BROWSER_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_links', 'browser_click', 'browser_press', 'browser_wait', 'browser_back', 'browser_tabs', 'browser_screenshot'] as const;
/** Never in a watch run: they type, pick, run page code, leave the owner's profile or log in. */
export const WATCH_NEVER = ['browser_type', 'browser_select', 'browser_evaluate', 'browser_hover', 'browser_profile', 'browser_login'] as const;
export const WATCH_REPORT = 'WatchReport';

/** The allow rules a watch routine runs on: the reading tools, the site's domain and WatchReport. */
export function watchAllow(spec: Pick<WatchSpec, 'url'>): string[] {
  const host = ruleHost(spec.url);
  return [`browser_navigate(domain:${host})`, ...WATCH_BROWSER_TOOLS.filter((t) => t !== 'browser_navigate'), WATCH_REPORT];
}

/** A watch's allow list after its address changed: the navigate rule follows the new site, the owner's other rules stay. */
export function syncWatchAllow(allow: string[], spec: Pick<WatchSpec, 'url'>): string[] {
  const rule = `browser_navigate(domain:${ruleHost(spec.url)})`;
  const rest = allow.filter((r) => !/^browser_navigate\(domain:[^)]*\)$/.test(r));
  return allow.some((r) => /^browser_navigate\(domain:/.test(r)) ? [rule, ...rest] : allow;
}

export function watchDeny(): string[] {
  return [...WATCH_NEVER];
}

/** True when a routine is a watch. */
export function isWatch(r: Pick<Routine, 'watch'> | undefined): r is Pick<Routine, 'watch'> & { watch: WatchSpec } {
  return !!r?.watch?.url;
}

/** The hub's rules for every watch run, after the routine's own prompt. Instructions, so they stay out of the data block. */
export const RUN_RULES = `How this watch run works:
- You only read the web. Never post, message, offer, buy, save, like, follow or sign in. The browser blocks anything that sends data, so such a click does nothing.
- The browser is already on the owner's profile for this site. Start at the address in the hub data below.
- For each listing read its id (from its link), title, price, location, link and photo address with browser_links or browser_snapshot, plus the fields the data block names.
- Report what you find with WatchReport, in one call or several. Report every item from the last run too: from the search page when it is there, else open its link and report it with status available, pending, sold, or gone when the page says it is no longer listed. An item you leave out counts as gone.
- Leave out listings outside the filters.
- End with one line on what changed, or "No change". The hub compares the items and tells the owner.`;

function price(n: number | undefined, text: string | undefined, currency: string | undefined): string {
  if (text) return text;
  if (n === undefined) return 'no price';
  return currency ? `${n} ${currency}` : String(n);
}

/** The filters in words, for the data block and the cards. */
export function filterWords(spec: WatchSpec): string[] {
  const f = spec.filters ?? {};
  const out: string[] = [];
  const cur = spec.currency ? ` ${spec.currency}` : '';
  if (f.minPrice !== undefined && f.maxPrice !== undefined) out.push(`price ${f.minPrice} to ${f.maxPrice}${cur}`);
  else if (f.maxPrice !== undefined) out.push(`price up to ${f.maxPrice}${cur}`);
  else if (f.minPrice !== undefined) out.push(`price from ${f.minPrice}${cur}`);
  if (f.maxDistance !== undefined) out.push(`within ${f.maxDistance} ${f.unit ?? 'km'}${f.near ? ` of ${f.near}` : ''}`);
  else if (f.near) out.push(`near ${f.near}`);
  if (f.keywords?.length) out.push(`looking for ${f.keywords.join(', ')}`);
  if (f.exclude?.length) out.push(`leave out ${f.exclude.join(', ')}`);
  return out;
}

/** The data block a run gets: where to start, the filters, and every item listed after the last run. */
export function runContext(routine: Pick<Routine, 'name'>, spec: WatchSpec, items: WatchItem[]): string {
  const listed = items.filter((i) => i.present);
  const lines = [`Watch: ${routine.name}`, `Start at: ${spec.url}`, `Browser profile: ${spec.profile ?? 'default'}`];
  const filters = filterWords(spec);
  if (filters.length) lines.push(`Filters: ${filters.join('; ')}`);
  if (spec.fields?.length) lines.push(`Fields to read for each item: ${spec.fields.join(', ')}`);
  if (!listed.length) lines.push('Items from the last run: none yet. Report everything that matches.');
  else {
    lines.push(`Items from the last run (${listed.length}). Report each one again, or open its link to check it:`);
    for (const i of listed) lines.push(`- ${i.id} | ${i.title} | ${price(i.price, i.priceText, spec.currency)}${i.status !== 'available' ? ` | ${i.status}` : ''}${i.url ? ` | ${i.url}` : ''}`);
  }
  return lines.join('\n');
}
