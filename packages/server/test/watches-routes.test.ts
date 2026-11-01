/**
 * Watches and the browser over HTTP (routes-watches.ts, routes-browser.ts):
 * the Routines page rows, a watch page, item photos through the hub, and
 * Settings > Browser's sign-in view on a real Chromium against the fake
 * marketplace: the owner clicks and types into a frame of the page, the
 * login cookie stays in the profile, and the next search with that profile
 * is signed in.
 *
 *   bun test packages/server/test/watches-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserManager, findBrowserExecutable } from '@conclave/core/browser/index.ts';
import { attachWatches, WatchService, type BrowserStatusDto, type SignInFrameDto, type SignInViewDto, type WatchDetailDto, type WatchSummaryDto } from '@conclave/core/watches/index.ts';
import type { Notice } from '@conclave/core/types.ts';
import { startFakeMarket, type FakeMarket } from '../../core/test/watches/market';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
let market: FakeMarket;
let watches: WatchService;
let browser: BrowserManager;
const heard: Notice[] = [];

// playwright-core is an optional dependency of core, so look for it from there
let hasPlaywright = true;
try {
  Bun.resolveSync('playwright-core', join(import.meta.dir, '../../core/src'));
} catch {
  hasPlaywright = false;
}
const live = findBrowserExecutable({ headless: true }) && hasPlaywright ? describe : describe.skip;

beforeAll(() => {
  market = startFakeMarket({ requireLogin: true });
  hub = startHub();
  browser = new BrowserManager({ config: hub.engine.config });
  (hub.engine as unknown as { browser: BrowserManager }).browser = browser;
  watches = new WatchService({
    db: hub.engine.repos.db,
    bus: hub.engine.bus,
    routines: hub.engine.routines,
    browser: () => browser,
    notify: (_k, n) => void heard.push(n as Notice),
    imageDir: join(hub.engine.config.paths.cache, 'watch-images'),
  });
  attachWatches(hub.engine, watches);
});

// a busy machine can take more than the default 5 s to close Chrome (closeProfile waits up to 15 s)
afterAll(async () => {
  await browser.close();
  await hub.stop();
  market.stop();
}, 30_000);

const json = async <T>(r: Response) => (await r.json()) as T;

describe('watch routes', () => {
  test('need the hub token', async () => {
    expect((await hub.api('/api/watches', { token: null })).status).toBe(401);
    expect((await hub.api('/api/browser', { token: null })).status).toBe(401);
    expect((await hub.api('/api/watches/x/items/1/image', { token: null })).status).toBe(401);
  });

  test('rows, a watch page and the photos', async () => {
    const { routine } = watches.create({ name: 'Cars', schedule: '0 9 * * *', url: `${market.url}/marketplace/search?query=cars`, prompt: 'Watch cars.', currency: 'USD' }, { agent: 'assistant' });
    // a plain routine is not a row
    hub.engine.routines.create({ name: 'Brief', schedule: '0 7 * * *', prompt: 'Brief me.' });
    watches.seed(routine.id, [
      { id: '101', title: '2014 Honda Civic LX', price: 6500, url: `${market.url}/marketplace/item/101/`, image: `${market.url}/img/101.svg` },
      { id: '102', title: '2012 Toyota Corolla LE', price: 6400, image: 'http://192.168.1.1/admin/reboot' },
      { id: '103', title: '2010 Honda Fit Sport', price: 4800 },
    ]);
    // a run: one new, one cheaper, one gone
    const run = { id: 'run_1', trigger: 'schedule' as const };
    watches.begin(routine, run, 'ses_run1');
    watches.report({ id: 'ses_run1', meta: { watch: routine.id, watchRun: 'run_1' } }, [
      { id: '101', title: '2014 Honda Civic LX', price: '$5,900' },
      { id: '102', title: '2012 Toyota Corolla LE', price: 6400 },
      { id: '104', title: '2013 Mazda3', price: 7200, image: `${market.url}/img/104.svg` },
    ]);
    const res = await watches.finish(routine, run, 'ses_run1', { sessionId: 'ses_run1' });
    expect(res.summary).toBe('1 new, 1 gone, 1 price drop. 3 listed.');
    expect(heard.at(-1)).toMatchObject({ title: 'Cars', link: `/routines/${routine.id}` });

    const rows = await json<WatchSummaryDto[]>(await hub.api('/api/watches'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routineId: routine.id, count: 3, newCount: 1, last: { words: '1 new, 1 gone, 1 price drop', total: 3 } });
    expect(rows[0].cover?.itemId).toBe('104');

    const page = await json<WatchDetailDto>(await hub.api(`/api/watches/${routine.id}`));
    expect(page.spec).toMatchObject({ currency: 'USD', profile: 'default' });
    expect(page.items.map((i) => [i.id, i.mark])).toEqual([
      ['104', 'new'],
      ['101', 'price_down'],
      ['102', 'still'],
      ['103', 'gone'],
    ]);
    expect(page.items[1].history.at(-1)).toMatchObject({ kind: 'price', price: 5900, from: 6500 });
    expect(page.runs).toHaveLength(1);
    expect((await hub.api('/api/watches/rt_nope')).status).toBe(404);

    // the photo comes from the hub, with a policy that lets nothing in it run
    const img = await hub.api(`/api/watches/${routine.id}/items/101/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/svg+xml');
    expect(img.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await img.text()).startsWith('<svg')).toBe(true);
    // kept on the hub: the photo and its type, once
    expect((await hub.api(`/api/watches/${routine.id}/items/101/image`)).status).toBe(200);
    expect(watches.sizes(routine.id).images).toBe(2);
    // a photo on a private address that is not the watch's own site is refused; no photo is a 404
    expect((await hub.api(`/api/watches/${routine.id}/items/102/image`)).status).toBe(403);
    expect((await hub.api(`/api/watches/${routine.id}/items/103/image`)).status).toBe(404);
  });

  test("a chat card's photos: only the items that chat reported", async () => {
    const r = watches.report({ id: 'ses_chat' }, [{ id: '101', title: '2014 Honda Civic LX', price: '$6,500', url: `${market.url}/marketplace/item/101/`, image: `${market.url}/img/101.svg` }]);
    expect(r.card.offer).toBe(true);
    const ok = await hub.api('/api/watches/sessions/ses_chat/items/101/image');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/svg+xml');
    expect((await hub.api('/api/watches/sessions/ses_chat/items/999/image')).status).toBe(404);
    expect((await hub.api('/api/watches/sessions/ses_other/items/101/image')).status).toBe(404);
  });

  test('a photo whose item id has a percent sign: the id is decoded once', async () => {
    const ids = ['50% off sofa', 'm.test/item/caf%C3%A9'];
    watches.report({ id: 'ses_pct' }, ids.map((id) => ({ id, title: id, url: `${market.url}/marketplace/item/101/`, image: `${market.url}/img/101.svg` })));
    // as the client asks for it (core/client watchImage): the id encoded once in the path
    for (const id of ids) expect((await hub.api(`/api/watches/sessions/ses_pct/items/${encodeURIComponent(id)}/image`)).status).toBe(200);
  });

  test('a filters edit goes through the routine route, and a delete cleans up', async () => {
    const { routine } = watches.create({ name: 'Flats', schedule: '0 9 * * *', url: 'https://flats.example.test/s', prompt: 'Watch flats.' }, { agent: 'assistant' });
    watches.seed(routine.id, [{ id: '1', title: 'Flat 1', price: 1200 }]);
    const r = await hub.api(`/api/routines/${routine.id}`, { method: 'PATCH', json: { watch: { ...routine.watch, filters: { maxPrice: 1500 }, notify: 'daily' } } });
    expect(r.status).toBe(200);
    expect((await json<WatchDetailDto>(await hub.api(`/api/watches/${routine.id}`))).spec).toMatchObject({ filters: { maxPrice: 1500 }, notify: 'daily' });
    hub.engine.routines.remove(routine.id);
    hub.engine.bus.emit({ type: 'routine.deleted', routineId: routine.id });
    expect(watches.sizes(routine.id)).toEqual({ items: 0, runs: 0, images: 0 });
  });
});

/**
 * Every awaited step of the live test has its own bound, so a slow or stuck
 * browser fails with the step's name instead of the test's timeout.
 */
async function step<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step "${name}" took longer than ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([fn(), late]);
  } finally {
    clearTimeout(timer);
  }
}

live('Settings > Browser: sign in to a site', () => {
  test('a remote view: frames, clicks and typing; the profile keeps the login', async () => {
    const status = await step('GET /api/browser', 10_000, async () => json<BrowserStatusDto>(await hub.api('/api/browser')));
    expect(status.available).toBe(true);
    expect(status.profiles.map((p) => p.name)).toContain('default');

    // bad input is refused in words
    expect((await step('a bad profile', 10_000, () => hub.api('/api/browser/signin', { method: 'POST', json: { profile: '../x', url: market.url } }))).status).toBe(400);
    expect((await step('a bad address', 10_000, () => hub.api('/api/browser/signin', { method: 'POST', json: { profile: 'market', url: 'file:///etc/passwd' } }))).status).toBe(400);

    const open = await step('POST /api/browser/signin', 45_000, () => hub.api('/api/browser/signin', { method: 'POST', json: { profile: 'market', url: `${market.url}/login` } }));
    expect(open.status).toBe(200);
    const view = await json<SignInViewDto>(open);
    expect(view).toMatchObject({ profile: 'market', url: `${market.url}/login` });

    const frame = await step('the first frame', 20_000, async () => json<SignInFrameDto>(await hub.api(`/api/browser/signin/${view.id}/frame?after=0`)));
    expect(frame.seq).toBeGreaterThan(0);
    expect(frame.url).toBe(`${market.url}/login`);
    expect(frame.width).toBeGreaterThan(0);
    expect(Buffer.from(frame.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    // after a frame: nothing (204), or a newer one when the page painted again; never the same frame twice
    const again = await step('a frame after the first', 20_000, () => hub.api(`/api/browser/signin/${view.id}/frame?after=${frame.seq}`));
    if (again.status === 200) expect((await json<SignInFrameDto>(again)).seq).toBeGreaterThan(frame.seq);
    else expect(again.status).toBe(204);

    // the owner clicks into the fields and types, as the app sends it
    const page = await step('the view page', 10_000, () => browser.page(view.id));
    const at = async (sel: string) => {
      // the view answers once the page starts loading; under load the field is not laid out yet
      const field = page.locator(sel);
      await field.waitFor({ state: 'visible', timeout: 15_000 });
      const b = (await step(`the box of ${sel}`, 10_000, () => field.boundingBox()))!;
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    };
    const click = (p: { x: number; y: number }) => [
      { type: 'mouse', action: 'move', ...p },
      { type: 'mouse', action: 'down', ...p },
      { type: 'mouse', action: 'up', ...p },
    ];
    const send = (what: string, events: unknown[]) => step(`input: ${what}`, 20_000, () => hub.api(`/api/browser/signin/${view.id}/input`, { method: 'POST', json: { events } }));
    expect((await send('the email', [...click(await at('input[name=email]')), { type: 'text', text: 'owner@example.com' }])).status).toBe(200);
    expect((await send('the password', [...click(await at('input[name=password]')), { type: 'text', text: 'hunter22' }])).status).toBe(200);
    expect((await send('Enter', [{ type: 'key', action: 'down', key: 'Enter' }, { type: 'key', action: 'up', key: 'Enter' }])).status).toBe(200);
    expect((await send('a bad event', [{ type: 'nope' }])).status).toBe(400);
    const until = Date.now() + 15_000;
    while (!market.posts.some((p) => p.path === '/login') && Date.now() < until) await Bun.sleep(50);
    expect(market.posts.filter((p) => p.path === '/login')).toHaveLength(1);

    // Done as soon as the post is out, before its answer loads: the hub waits for the answer (it sets the
    // cookie) before closing the tab; Chrome 156 can leave a tab closed mid post half closed for good
    const done = await step('POST /done', 20_000, async () => json<BrowserStatusDto>(await hub.api(`/api/browser/signin/${view.id}/done`, { method: 'POST' })));
    expect(done.profiles.find((p) => p.name === 'market')?.sites.map((s) => s.host)).toEqual(['127.0.0.1']);
    expect((await step('a frame after done', 10_000, () => hub.api(`/api/browser/signin/${view.id}/frame?after=0`))).status).toBe(404);

    // the profile keeps the login: a search in it is signed in
    browser.setProfile('later', 'market');
    await step('a search in the profile', 30_000, () => browser.navigate('later', `${market.url}/marketplace/search?query=cars`));
    expect(market.searches.at(-1)).toEqual({ loggedIn: true });
    await step('closing the search', 10_000, () => browser.closeSession('later'));
    expect(browser.profileSignedInTo('127.0.0.1')).toBe('market');
  }, 120_000);
});
