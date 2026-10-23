/**
 * Watches in the web app (src/features/watches, Settings > Browser): the
 * card data a result carries, prices, item states, history and row words,
 * the tool lines, and the chat cards as HTML (photos from the hub, never the
 * site's own photo links; "Watch this daily"; the made watch's link). The
 * words have no em or en dashes.
 *
 *   bun test packages/web/test/watches.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { WatchCardData, WatchItem } from '@conclave/core/client';
import { WatchCard, watchLineWords } from '../src/features/watches/WatchCards';
import { WatchStrip } from '../src/features/watches/WatchStrip';
import { chipWords, factsWords, filterItems, historyWords, priceWords, rowWords, seenWords, specWords, wasPrice, watchCardOf } from '../src/features/watches/words';
import { sitesWords } from '../src/features/settings/browser';
import { toolLine, toolRowWords, workingWords } from '../src/lib/toolLine';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 9);

function item(p: Partial<WatchItem> & Pick<WatchItem, 'id' | 'title'>): WatchItem {
  return { status: 'available', present: true, mark: 'still', firstSeen: T0, lastSeen: T0 + DAY, history: [{ at: T0, kind: 'seen', price: p.price }], ...p };
}

const items: WatchCardData = {
  kind: 'items',
  source: 'https://www.facebook.com/marketplace/oakland/search?query=civic',
  offer: true,
  items: [
    { id: '101', title: '2014 Honda Civic LX', price: 6500, priceText: '$6,500', location: 'Oakland, CA', url: 'https://www.facebook.com/marketplace/item/101/', image: 'https://scontent.example/101.jpg', status: 'available' },
    { id: '102', title: '2012 Toyota Corolla LE', price: 6400, location: 'Berkeley, CA', url: 'https://www.facebook.com/marketplace/item/102/', status: 'available', fields: { year: '2012' } },
  ],
};

describe('card data and words', () => {
  test('only a well formed card from a result that did not fail', () => {
    expect(watchCardOf({ meta: { watch: items } })).toBe(items);
    expect(watchCardOf({ meta: { watch: items }, isError: true })).toBeUndefined();
    expect(watchCardOf({ meta: { watch: { kind: 'items', items: [] } } })).toBeUndefined();
    expect(watchCardOf({ meta: { watch: { kind: 'created', routineId: 'rt_1', name: 'Cars', schedule: '0 9 * * *', count: 2 } } })?.kind).toBe('created');
    expect(watchCardOf(undefined)).toBeUndefined();
  });

  test('prices, the site words first', () => {
    expect(priceWords(6500, undefined, 'USD')).toBe('$6,500');
    expect(priceWords(6500, '$6,500 obo', 'USD')).toBe('$6,500 obo');
    expect(priceWords(6500, undefined, 'EUR')).toBe('€6,500');
    expect(priceWords(6500, undefined, 'CHF')).toBe('6,500 CHF');
    expect(priceWords(6500)).toBe('6,500');
    expect(priceWords(0, undefined, 'USD')).toBe('Free');
    expect(priceWords(undefined)).toBe('No price');
  });

  test('an item says what happened to it, with its history', () => {
    const cheaper = item({ id: '1', title: 'Civic', price: 5900, mark: 'price_down', history: [{ at: T0, kind: 'seen', price: 6500 }, { at: T0 + DAY, kind: 'price', price: 5900, from: 6500 }] });
    expect(chipWords(cheaper)).toBe('Price down');
    expect(wasPrice(cheaper)).toBe(6500);
    expect(historyWords(cheaper.history[0], 'USD')).toBe('First seen at $6,500');
    expect(historyWords(cheaper.history[1], 'USD')).toBe('Price $6,500 to $5,900');
    expect(historyWords({ at: T0, kind: 'gone', status: 'sold' })).toBe('Gone, sold');
    expect(historyWords({ at: T0, kind: 'gone', status: 'not found' })).toBe('Gone, not found');
    expect(chipWords(item({ id: '2', title: 'Fit', present: false, status: 'sold', mark: 'gone' }))).toBe('Sold');
    expect(chipWords(item({ id: '3', title: 'Fit', present: false, mark: 'gone' }))).toBe('Gone');
    expect(chipWords(item({ id: '4', title: 'Yaris', mark: 'new' }))).toBe('New');
    expect(seenWords(item({ id: '5', title: 'x' }), T0 + 2 * DAY)).toBe('First seen 20 Oct, last seen 21 Oct');
    expect(seenWords(item({ id: '6', title: 'x', present: false, goneAt: T0 + DAY }), T0 + 2 * DAY)).toBe('First seen 20 Oct, gone 21 Oct');
    expect(factsWords({ location: 'Oakland, CA', fields: { year: '2014', mileage: '98,000 mi', color: 'blue' } }, ['year', 'mileage'])).toBe('Oakland, CA, 2014, 98,000 mi');
  });

  test('the filter links pick the right items', () => {
    const list = [item({ id: 'a', title: 'a', mark: 'new' }), item({ id: 'b', title: 'b', mark: 'price_down' }), item({ id: 'c', title: 'c' }), item({ id: 'd', title: 'd', present: false, mark: 'gone' })];
    expect(filterItems(list, 'new').map((i) => i.id)).toEqual(['a']);
    expect(filterItems(list, 'price').map((i) => i.id)).toEqual(['b']);
    expect(filterItems(list, 'still').map((i) => i.id)).toEqual(['c']);
    expect(filterItems(list, 'gone').map((i) => i.id)).toEqual(['d']);
    expect(filterItems(list, 'all')).toHaveLength(4);
  });

  test('rows, filters and profiles in words', () => {
    expect(rowWords({ count: 12, newCount: 3 })).toBe('12 listed, 3 new');
    expect(rowWords({ count: 12, newCount: 0 })).toBe('12 listed');
    expect(rowWords({ count: 0, newCount: 0 })).toBe('Nothing listed yet');
    expect(specWords({ url: 'https://x.test', filters: { maxPrice: 8000, maxDistance: 40, unit: 'mi', near: 'Oakland', exclude: ['salvage'] }, currency: 'USD' })).toBe('up to $8,000; within 40 mi of Oakland; leaving out salvage');
    expect(specWords({ url: 'https://x.test' })).toBeUndefined();
    expect(sitesWords({ name: 'marketplace', engine: 'chromium', label: 'Chromium', open: false, sites: [{ host: 'facebook.com', at: T0 }] }, T0 + 2 * DAY)).toBe('Signed in to facebook.com 2d ago');
    expect(sitesWords({ name: 'default', engine: 'chromium', label: 'Chromium', open: false, sites: [] })).toBe('No sites signed in yet');
  });

  test('tool lines', () => {
    const report = { name: 'WatchReport', input: { items: [{}, {}, {}] } };
    expect(toolLine([report])).toContain('Found 3 items');
    expect(toolRowWords(report)).toEqual({ verb: 'Found', target: '3 items', mono: false });
    expect(workingWords({ name: 'browser_navigate', input: { url: 'https://www.facebook.com/marketplace' } })).toBe('Opening facebook.com');
    expect(workingWords({ name: 'browser_links', input: {} })).toBe('Reading the page');
    expect(toolLine([{ name: 'WatchCreate', input: { name: 'Cars' } }])).toContain('Made a watch');
    expect(watchLineWords({ name: 'WatchReport', input: {} }, items)).toBe('Found 2 items');
    expect(watchLineWords({ name: 'WatchCreate', input: {} }, { kind: 'created', routineId: 'rt_1', name: 'Cars', schedule: '0 9 * * *', count: 2 })).toBe('Made a watch: Cars');
  });
});

describe('cards as HTML', () => {
  test('items: prices, titles, places and listing links; photos come from the hub', () => {
    const html = renderToStaticMarkup(<WatchCard card={items} sessionId="ses_1" />);
    expect(html).toContain('2014 Honda Civic LX');
    expect(html).toContain('$6,500');
    expect(html).toContain('6,400');
    expect(html).toContain('Oakland, CA');
    expect(html).toContain('Berkeley, CA, 2012');
    expect(html).toContain('href="https://www.facebook.com/marketplace/item/101/"');
    expect(html).toContain('Watch this daily');
    expect(html).toContain('Open the search');
    // the site's photo link is never put in the page; the hub fetches it
    expect(html).not.toContain('scontent.example');
  });

  test('a made watch links to its page', () => {
    const html = renderToStaticMarkup(
      <Router ssrPath="/chat/ses_1">
        <WatchCard card={{ kind: 'created', routineId: 'rt_9', name: 'Cars under $8,000', schedule: '0 9 * * *', count: 4 }} sessionId="ses_1" />
      </Router>,
    );
    expect(html).toContain('Cars under $8,000');
    expect(html).toContain('Watching daily at 09:00, starting from 4 items');
    expect(html).toContain('href="/routines/rt_9"');
  });

  test('the notice strip: what changed, with prices', () => {
    const html = renderToStaticMarkup(
      <WatchStrip
        notice={{
          routineId: 'rt_9',
          runId: 'run_1',
          currency: 'USD',
          counts: { new: 1, gone: 1, priceDown: 1, priceUp: 0, changed: 0, still: 1 },
          items: [
            { id: '105', title: '2015 Toyota Yaris', price: 7800, mark: 'new', image: true, url: 'https://m.test/item/105/' },
            { id: '101', title: '2014 Honda Civic LX', price: 5900, was: 6500, mark: 'price_down' },
          ],
        }}
      />,
    );
    expect(html).toContain('$7,800');
    expect(html).toContain('Price down');
    expect(html).toContain('href="https://m.test/item/105/"');
  });
});

describe('UI text', () => {
  test('no em or en dashes in the watch screens', () => {
    const root = join(import.meta.dir, '../src');
    const files = [...readdirSync(join(root, 'features/watches')).map((f) => join(root, 'features/watches', f)), join(root, 'features/settings/browser.tsx')];
    for (const f of files) expect({ f, dash: /[–—]/.test(readFileSync(f, 'utf8')) }).toEqual({ f, dash: false });
  });
});
