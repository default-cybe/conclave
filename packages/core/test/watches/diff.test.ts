/**
 * The compare step of a watch (watches/diff.ts) and its input checks
 * (watches/spec.ts), on plain data.
 *
 *   bun test packages/core/test/watches/diff.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { countWords, diffRun, mergeReports } from '../../src/watches/diff';
import { cleanItem, cleanWatchSpec, filteredOut, parsePrice, ruleHost } from '../../src/watches/spec';
import { runContext, syncWatchAllow, watchAllow } from '../../src/watches/rules';
import type { ReportedItem, WatchItem } from '../../src/watches/types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 9);

const civic: ReportedItem = { id: '101', title: '2014 Honda Civic LX', price: 6500, location: 'Oakland, CA', url: 'https://m.test/item/101/', image: 'https://m.test/img/101.jpg' };
const corolla: ReportedItem = { id: '102', title: '2012 Toyota Corolla', price: 6400, location: 'Berkeley, CA', url: 'https://m.test/item/102/' };
const fit: ReportedItem = { id: '103', title: '2010 Honda Fit', price: 4800, location: 'Alameda, CA', url: 'https://m.test/item/103/' };

function first(): WatchItem[] {
  return diffRun([], [civic, corolla, fit], {}, T0).items;
}

describe('diffRun', () => {
  test('the first run: every item is new and has a first seen entry', () => {
    const r = diffRun([], [civic, corolla], {}, T0);
    expect(r.summary.counts).toMatchObject({ new: 2, gone: 0, still: 0 });
    expect(r.summary.words).toBe('2 new');
    expect(r.items.every((i) => i.present && i.mark === 'new' && i.firstSeen === T0)).toBe(true);
    expect(r.items[0].history).toEqual([{ at: T0, kind: 'seen', price: expect.any(Number) }]);
  });

  test('new, gone, price drop, price rise and still there', () => {
    const prev = first();
    const t1 = T0 + DAY;
    const mazda: ReportedItem = { id: '104', title: '2013 Mazda3', price: 7200, location: 'Oakland, CA' };
    const r = diffRun(prev, [{ ...civic, price: 5900 }, { ...corolla, price: 6600 }, mazda], {}, t1);
    expect(r.summary.counts).toEqual({ new: 1, gone: 1, priceDown: 1, priceUp: 1, changed: 0, still: 0 });
    expect(r.summary.words).toBe('1 new, 1 gone, 1 price drop, 1 price rise');
    expect(r.summary.changes).toEqual({ new: ['104'], gone: ['103'], priceDown: ['101'], priceUp: ['102'], changed: [] });
    const byId = new Map(r.items.map((i) => [i.id, i]));
    expect(byId.get('101')).toMatchObject({ mark: 'price_down', price: 5900, firstSeen: T0, lastSeen: t1 });
    expect(byId.get('101')!.history.at(-1)).toEqual({ at: t1, kind: 'price', price: 5900, from: 6500 });
    expect(byId.get('103')).toMatchObject({ present: false, mark: 'gone', goneAt: t1 });
    expect(byId.get('103')!.history.at(-1)).toEqual({ at: t1, kind: 'gone', status: 'not found' });
    // listed first, gone last
    expect(r.items.map((i) => i.id)).toEqual(['104', '101', '102', '103']);
    expect(r.summary.total).toBe(3);
  });

  test('an unchanged run says no change and keeps first seen', () => {
    const prev = first();
    const r = diffRun(prev, [civic, corolla, fit], {}, T0 + DAY);
    expect(r.summary.words).toBe('No change');
    expect(countWords(r.summary.counts, { still: true })).toBe('No change, 3 still there');
    expect(r.items.every((i) => i.mark === 'still' && i.firstSeen === T0 && i.lastSeen === T0 + DAY)).toBe(true);
  });

  test('sold and gone reports end an item; pending is a change', () => {
    const prev = first();
    const r = diffRun(prev, [{ ...civic, status: 'sold' }, { id: '102', title: '', status: 'gone' }, { ...fit, status: 'pending' }], {}, T0 + DAY);
    expect(r.summary.counts).toMatchObject({ gone: 2, changed: 1 });
    const byId = new Map(r.items.map((i) => [i.id, i]));
    expect(byId.get('101')).toMatchObject({ present: false, status: 'sold', mark: 'gone' });
    expect(byId.get('102')).toMatchObject({ present: false, status: 'gone', title: '2012 Toyota Corolla' });
    expect(byId.get('103')).toMatchObject({ present: true, status: 'pending', mark: 'changed' });
  });

  test('an item that comes back is new again, with its history kept', () => {
    const gone = diffRun(first(), [civic, corolla], {}, T0 + DAY).items;
    const r = diffRun(gone, [civic, corolla, fit], {}, T0 + 2 * DAY);
    const back = r.items.find((i) => i.id === '103')!;
    expect(back).toMatchObject({ mark: 'new', present: true, firstSeen: T0 });
    expect(back.history.map((h) => h.kind)).toEqual(['seen', 'gone', 'back']);
    expect(r.summary.counts.new).toBe(1);
  });

  test('a gone item is marked gone only in the run that saw it go', () => {
    const one = diffRun(first(), [civic, corolla], {}, T0 + DAY);
    const two = diffRun(one.items, [civic, corolla], {}, T0 + 2 * DAY);
    expect(two.summary.counts.gone).toBe(0);
    expect(two.items.find((i) => i.id === '103')).toMatchObject({ present: false, mark: 'gone', goneAt: T0 + DAY });
  });

  test('a run that did not finish marks nothing gone for being left out', () => {
    const r = diffRun(first(), [civic], {}, T0 + DAY, { complete: false });
    expect(r.summary.counts.gone).toBe(0);
    expect(r.items.filter((i) => i.present)).toHaveLength(3);
  });

  test('filters keep new items out, but not items already kept', () => {
    const f = { maxPrice: 6000, exclude: ['salvage'] };
    const r = diffRun([], [civic, fit, { ...fit, id: '105', title: 'Honda Fit salvage title', price: 2000 }], { filters: f }, T0);
    expect(r.items.map((i) => i.id)).toEqual(['103']);
    expect(r.summary.filtered).toBe(2);
    // a kept item whose price went over the limit is a price rise, not gone
    const r2 = diffRun(r.items, [{ ...fit, price: 6200 }], { filters: f }, T0 + DAY);
    expect(r2.items[0]).toMatchObject({ id: '103', mark: 'price_up', present: true });
  });

  test('the cap drops gone items first, then the ones seen longest ago', () => {
    let items = diffRun([], Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, title: `Car ${i}`, price: 1000 + i })), { cap: 6 }, T0).items;
    // two go, three new come: 3 listed + 2 gone + 3 new = 8 > 6
    items = diffRun(items, [...['a0', 'a1', 'a2'].map((id) => ({ id, title: id })), ...['b0', 'b1', 'b2'].map((id) => ({ id, title: id }))], { cap: 6 }, T0 + DAY).items;
    expect(items).toHaveLength(6);
    expect(items.every((i) => i.present)).toBe(true);
    const r = diffRun(items, [{ id: 'c0', title: 'c0' }, ...items.map((i) => ({ id: i.id, title: i.title }))], { cap: 6 }, T0 + 2 * DAY);
    expect(r.items).toHaveLength(6);
    expect(r.dropped).toEqual(['c0']);
    // a full watch keeps what it has: the one that does not fit is not news
    expect(r.summary.counts.new).toBe(0);
  });

  test('a search that lists more than the cap settles: unchanged runs say no change, not "new" every time', () => {
    const cars = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `Car ${i}`, price: 1000 + i }));
    let r = diffRun([], cars, { cap: 3 }, T0);
    expect(r.summary.counts.new).toBe(3);
    for (let d = 1; d <= 3; d++) {
      r = diffRun(r.items, cars, { cap: 3 }, T0 + d * DAY);
      expect(r.summary.words).toBe('No change');
      expect(r.items).toHaveLength(3);
    }
  });

  test('history is capped per item', () => {
    let items = diffRun([], [{ ...civic, price: 100 }], {}, T0).items;
    for (let d = 1; d <= 40; d++) items = diffRun(items, [{ ...civic, price: 100 + d }], {}, T0 + d * DAY).items;
    expect(items[0].history.length).toBe(30);
    expect(items[0].history.at(-1)).toMatchObject({ kind: 'price', price: 140, from: 139 });
  });

  test('reports of the same item in one run merge, the later one winning', () => {
    const m = mergeReports([{ ...civic, fields: { year: '2014' } }, { id: '101', title: '', price: 6000, fields: { mileage: '98,000 mi' } }]);
    expect(m.get('101')).toMatchObject({ title: '2014 Honda Civic LX', price: 6000, fields: { year: '2014', mileage: '98,000 mi' } });
  });
});

describe('checks on what comes in', () => {
  test('prices in the forms sites show them', () => {
    expect(parsePrice('$6,500')).toBe(6500);
    expect(parsePrice('6.500 €')).toBe(6500);
    expect(parsePrice('$12,345.67')).toBe(12345.67);
    expect(parsePrice('Free')).toBe(0);
    expect(parsePrice('CA$4,800 obo')).toBe(4800);
    expect(parsePrice('Ask')).toBeUndefined();
    expect(parsePrice(7200)).toBe(7200);
    // spaces group thousands ("1 500 €", with a no-break space too), but a number after the price is not part of it
    expect(parsePrice('1 500 €')).toBe(1500);
    expect(parsePrice('12 345,67 €')).toBe(12345.67);
    expect(parsePrice('$1,200 1 bd')).toBe(1200);
    expect(parsePrice('$8,500 2019 Honda Civic')).toBe(8500);
    expect(parsePrice('$8,500 200 miles')).toBe(8500);
    expect(parsePrice('7 200 km')).toBe(7200);
    // Swiss thousands
    expect(parsePrice('CHF 1’200.50')).toBe(1200.5);
    expect(parsePrice("CHF 1'200")).toBe(1200);
  });

  test('a link that names its listing in the query keeps it in the id; tracking parameters do not', () => {
    const a = cleanItem({ url: 'https://suchen.mobile.de/fahrzeuge/details.html?id=402&ref=srp&utm_source=x', title: 'Golf' }).item!;
    const b = cleanItem({ url: 'https://suchen.mobile.de/fahrzeuge/details.html?ref=dsp&id=403', title: 'Polo' }).item!;
    expect(a.id).toBe('suchen.mobile.de/fahrzeuge/details.html?id=402');
    expect(b.id).toBe('suchen.mobile.de/fahrzeuge/details.html?id=403');
    // two listings stay two items in a run
    expect(diffRun([], [a, b], {}, T0).items).toHaveLength(2);
    // a path id is unchanged
    expect(cleanItem({ url: 'https://m.test/item/9/?ref=x', title: 'A car' }).item!.id).toBe('m.test/item/9');
  });

  test('an item needs an id or a link, and a title unless it is gone', () => {
    expect(cleanItem({ title: 'x' }).problem).toContain('neither an id nor a url');
    expect(cleanItem({ id: '1' }).problem).toContain('no title');
    expect(cleanItem({ id: '1', status: 'gone' }).item).toEqual({ id: '1', title: '', status: 'gone' });
    const c = cleanItem({ url: 'https://m.test/item/9/?ref=x', title: '  A   car ', price: '$1,200', image: 'javascript:alert(1)', fields: { Year: 2014 } }).item!;
    expect(c).toEqual({ id: 'm.test/item/9', title: 'A car', price: 1200, priceText: '$1,200', url: 'https://m.test/item/9/?ref=x', fields: { year: '2014' } });
  });

  test('a spec is checked and tidied', () => {
    expect(() => cleanWatchSpec({ url: 'ftp://x' })).toThrow('http or https');
    expect(() => cleanWatchSpec({ url: 'https://x.test', filters: { minPrice: 9, maxPrice: 3 } })).toThrow('above');
    expect(() => cleanWatchSpec({ url: 'https://x.test', profile: '../etc' })).toThrow('profile');
    expect(() => cleanWatchSpec({ url: 'https://x.test', cap: 5000 })).toThrow('cap');
    expect(cleanWatchSpec({ url: 'https://www.facebook.com/marketplace/oakland/search?query=civic', profile: 'marketplace', fields: 'Year, Mileage', filters: { maxPrice: '8000', unit: 'mi', maxDistance: 40, keywords: ['civic'] }, currency: 'usd' })).toEqual({
      url: 'https://www.facebook.com/marketplace/oakland/search?query=civic',
      profile: 'marketplace',
      fields: ['year', 'mileage'],
      filters: { maxPrice: 8000, maxDistance: 40, unit: 'mi', keywords: ['civic'] },
      currency: 'USD',
    });
  });

  test('filters say why they leave an item out', () => {
    const f = { minPrice: 1000, maxPrice: 8000, maxDistance: 40, exclude: ['parts'] };
    expect(filteredOut({ title: 'Civic', price: 500 }, f)).toBe('under the lowest price');
    expect(filteredOut({ title: 'Civic', price: 9000 }, f)).toBe('over the highest price');
    expect(filteredOut({ title: 'Civic', price: 5000, distance: 60 }, f)).toBe('too far');
    expect(filteredOut({ title: 'Civic for parts', price: 5000 }, f)).toBe('the title has "parts"');
    expect(filteredOut({ title: 'Civic' }, f)).toBeUndefined();
  });

  test('the allow rules name the site and only reading tools', () => {
    expect(ruleHost('https://www.facebook.com/marketplace/x')).toBe('facebook.com');
    const allow = watchAllow({ url: 'https://www.facebook.com/marketplace/x' });
    expect(allow[0]).toBe('browser_navigate(domain:facebook.com)');
    expect(allow).toContain('WatchReport');
    for (const t of ['browser_type', 'browser_evaluate', 'browser_select', 'browser_profile', 'Bash', 'WebFetch']) expect(allow.some((r) => r.startsWith(t))).toBe(false);
    expect(syncWatchAllow([...allow, 'browser_hover'], { url: 'https://craigslist.org/search' })).toEqual(['browser_navigate(domain:craigslist.org)', ...allow.slice(1), 'browser_hover']);
  });

  test('the run gets the filters and every listed item', () => {
    const items = diffRun([], [civic, corolla], {}, T0).items;
    const text = runContext({ name: 'Cars' }, { url: 'https://m.test/s', profile: 'mk', fields: ['year'], filters: { maxPrice: 8000 }, currency: 'USD' }, items);
    expect(text).toContain('Start at: https://m.test/s');
    expect(text).toContain('Browser profile: mk');
    expect(text).toContain('Filters: price up to 8000 USD');
    expect(text).toContain('Fields to read for each item: year');
    expect(text).toContain('- 101 | 2014 Honda Civic LX | 6500 USD | https://m.test/item/101/');
  });
});
