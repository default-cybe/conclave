/**
 * Watches on a real engine, a real Chromium and a fake marketplace whose
 * listings change between runs. The scripted model drives the browser tools
 * the way a model would (test/watches/market.ts): it reads what browser_links
 * and the item pages say and reports it with WatchReport.
 *
 * Proves: the chat shows item cards and makes the watch from them; a run
 * compares (new, gone, sold, price drop) and keeps each item's history; the
 * owner hears about a change and nothing else (or a summary with daily);
 * quiet hours hold the notice; a run that reads nothing changes nothing; the
 * cap; cleanup on delete; a watch run sends nothing to the site and never
 * gets the writing tools; a profile signed in once is what the runs use.
 *
 *   bun test packages/core/test/watches/engine.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findBrowserExecutable, type BrowserManager } from '../../src/browser';
import { assistantOf, QUIET_JOB } from '../../src/assistant';
import { watchesOf, type WatchCardData } from '../../src/watches';
import type { Notice, Routine } from '../../src/types';
import { startTestEngine, toolResults, type RequestBody, type TestEngine } from '../engine/harness';
import { CARS, marketStep, startFakeMarket, type FakeMarket } from './market';

let hasPlaywright = true;
try {
  await import('playwright-core');
} catch {
  hasPlaywright = false;
}
const live = findBrowserExecutable({ headless: true }) && hasPlaywright ? describe : describe.skip;

let t: TestEngine | undefined;
let market: FakeMarket | undefined;

afterEach(async () => {
  const b = (t?.engine as unknown as { browser?: BrowserManager } | undefined)?.browser;
  await b?.close();
  await t?.close();
  market?.stop();
  t = undefined;
  market = undefined;
});

function browserOf(t: TestEngine): BrowserManager {
  return (t.engine as unknown as { browser: BrowserManager }).browser;
}

function notices(t: TestEngine): Notice[] {
  const out: Notice[] = [];
  t.engine.bus.on((e) => {
    if (e.type === 'notice') out.push(e.notice);
  });
  return out;
}

async function start(route?: (body: RequestBody) => ReturnType<typeof marketStep> | undefined): Promise<TestEngine> {
  const search = `${market!.url}/marketplace/search?query=cars&maxPrice=8000`;
  const e = await startTestEngine({
    approve: 'allow',
    script: [[{ text: 'ok' }]],
    route: (body) => route?.(body) ?? marketStep(body.messages as never, { search }),
  });
  // every hour is a message hour, unless a test says otherwise
  await assistantOf(e.engine)!.prefs.set({ hours: '00:00-00:00', timezone: 'UTC' });
  return e;
}

function cards(t: TestEngine, sessionId: string): WatchCardData[] {
  return t.engine
    .getMessages(sessionId)
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => (b.meta as { watch?: WatchCardData } | undefined)?.watch)
    .filter((c): c is WatchCardData => !!c);
}

live('watches', () => {
  test('from a chat to a watch, two runs with the listings changed between them', async () => {
    market = startFakeMarket();
    t = await start();
    const { engine } = t;
    const heard = notices(t);
    const watches = watchesOf(engine)!;

    // 1. ask in chat: the assistant searches once and shows cards
    const s = await engine.createSession({ cwd: t.cwd });
    expect(s.agent).toBe('assistant');
    await t.run(s.id, 'Look for used cars under $8,000 near Oakland on the marketplace.');
    const shown = cards(t, s.id);
    expect(shown).toHaveLength(1);
    const card = shown[0] as Extract<WatchCardData, { kind: 'items' }>;
    expect(card.kind).toBe('items');
    expect(card.offer).toBe(true);
    expect(card.items.map((i) => i.id)).toEqual(['101', '102', '103', '104']);
    expect(card.items[0]).toMatchObject({ title: '2014 Honda Civic LX', price: 6500, priceText: '$6,500', location: 'Oakland, CA', url: `${market.url}/marketplace/item/101/`, image: `${market.url}/img/101.svg` });
    // the assistant has the browser; reading tools never asked
    const chatTools = JSON.parse(t.requests[0]).tools.map((x: { name: string }) => x.name) as string[];
    for (const n of ['browser_navigate', 'browser_links', 'browser_profile', 'browser_login', 'WatchReport', 'WatchCreate']) expect(chatTools).toContain(n);
    expect(t.approvals.some((a) => /Links|Report/.test(a))).toBe(false);

    // 2. "Watch this daily": a watch routine with the search, the profile, the fields and the filters
    await t.run(s.id, 'Yes, watch this daily.');
    const made = cards(t, s.id).find((c) => c.kind === 'created') as Extract<WatchCardData, { kind: 'created' }>;
    expect(made).toMatchObject({ name: 'Cars under $8,000', schedule: '0 9 * * *', count: 4 });
    const r = engine.routines.get(made.routineId)!;
    expect(r).toMatchObject({ agent: 'assistant', notify: 'on_error', sessionPolicy: 'new', timezone: 'UTC' });
    expect(r.watch).toMatchObject({ url: `${market.url}/marketplace/search?query=cars&maxPrice=8000`, profile: 'default', fields: ['year', 'mileage'], filters: { maxPrice: 8000, exclude: ['salvage', 'parts'] }, currency: 'USD' });
    expect(r.allow).toContain('browser_navigate(domain:127.0.0.1)');
    expect(r.allow).toContain('WatchReport');
    expect(r.deny).toEqual(expect.arrayContaining(['browser_type', 'browser_evaluate']));
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    // it starts from what the chat showed
    expect(watches.items(r.id).map((i) => [i.id, i.mark]).sort()).toEqual([
      ['101', 'still'],
      ['102', 'still'],
      ['103', 'still'],
      ['104', 'still'],
    ]);

    // 3. the listings change: one new, one removed, one sold, one cheaper
    market.listings.push({ id: '105', title: '2015 Toyota Yaris', price: 7800, location: 'Hayward, CA', year: '2015' });
    market.removed.add('103');
    market.listings.find((l) => l.id === '102')!.status = 'sold';
    market.listings.find((l) => l.id === '101')!.price = 5900;
    const posted = market.posts.length;

    const run1 = await engine.routines.runNow(r.id, 'schedule');
    expect(run1.status).toBe('ok');
    expect(run1.summary).toBe('1 new, 2 gone, 1 price drop. 3 listed.');
    const after1 = new Map(watches.items(r.id).map((i) => [i.id, i]));
    expect(after1.get('105')).toMatchObject({ mark: 'new', present: true, price: 7800 });
    expect(after1.get('101')).toMatchObject({ mark: 'price_down', price: 5900 });
    expect(after1.get('101')!.history.map((h) => h.kind)).toEqual(['seen', 'price']);
    expect(after1.get('101')!.history[1]).toMatchObject({ price: 5900, from: 6500 });
    // sold: its link said so; removed: its link said it is gone
    expect(after1.get('102')).toMatchObject({ present: false, status: 'sold', mark: 'gone' });
    expect(after1.get('103')).toMatchObject({ present: false, status: 'gone', mark: 'gone' });
    expect(after1.get('104')).toMatchObject({ mark: 'still', present: true });
    // the run opened the old items' links to check them
    const run1Calls = toolResults(engine, run1.sessionId!).map((x) => x.name);
    expect(run1Calls.filter((n) => n === 'browser_navigate').length).toBe(3);

    // one notice, the counts first, the card data with it, linked to the watch page
    const n1 = heard.filter((n) => n.watch);
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ title: 'Cars under $8,000', link: `/routines/${r.id}`, sessionId: run1.sessionId, level: 'success' });
    expect(n1[0].body.startsWith('1 new, 2 gone, 1 price drop.')).toBe(true);
    expect(n1[0].body).toContain('New: 2015 Toyota Yaris, $7,800.');
    expect(n1[0].body).toContain('Price drop: 2014 Honda Civic LX, $5,900 (was $6,500).');
    expect(n1[0].watch!.items.map((i) => [i.id, i.mark]).sort()).toEqual([
      ['101', 'price_down'],
      ['102', 'gone'],
      ['103', 'gone'],
      ['105', 'new'],
    ]);
    // new first, then price drops, then gone
    expect(n1[0].watch!.items.map((i) => i.mark)).toEqual(['new', 'price_down', 'gone', 'gone']);
    // no generic "Routine: ..." notice besides it
    expect(heard.filter((n) => n.title.startsWith('Routine'))).toHaveLength(0);

    // 4. a second run with nothing changed: no notice
    const run2 = await engine.routines.runNow(r.id, 'schedule');
    expect(run2.status).toBe('ok');
    expect(run2.summary).toBe('No change, 3 still there. 3 listed.');
    expect(heard.filter((n) => n.watch)).toHaveLength(1);
    expect(watches.runs(r.id).map((x) => x.words)).toEqual(['No change', '1 new, 2 gone, 1 price drop']);

    // daily: a summary even when nothing changed
    engine.routines.update(r.id, { watch: { ...r.watch!, notify: 'daily' } });
    await engine.routines.runNow(r.id, 'schedule');
    const daily = heard.filter((n) => n.watch);
    expect(daily).toHaveLength(2);
    expect(daily[1]).toMatchObject({ level: 'info', body: 'No change, 3 still there.' });

    // the runs sent nothing to the site
    expect(market.posts.slice(posted)).toEqual([]);
    expect(market.sockets).toBe(0);

    // the run was a watch run: untrusted, only the reading tools and WatchReport
    const runSession = engine.getSession(run1.sessionId!)!;
    expect(runSession.meta).toMatchObject({ untrusted: true, watch: r.id });
    const runTools = new Set<string>();
    for (const body of t.requests) if (body.includes('Start at: ')) for (const x of JSON.parse(body).tools as Array<{ name: string }>) runTools.add(x.name);
    expect([...runTools].sort()).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ReadToolOutput', 'TodoWrite', 'WatchReport', 'browser_back', 'browser_click', 'browser_links', 'browser_navigate', 'browser_press', 'browser_screenshot', 'browser_snapshot', 'browser_tabs', 'browser_wait'].sort());
    // and the prompt had the rules and the items to check
    const firstRun = t.requests.find((b) => b.includes('Start at: '))!;
    expect(firstRun).toContain('You only read the web');
    expect(firstRun).toContain('<hub-data from=\\"@watch\\">');
    expect(firstRun).toContain('- 103 | 2010 Honda Fit Sport | $4,800');

    // the photo comes through the hub (the watch's own site may be on a private address)
    const img = await watches.image(r.id, '105');
    expect(img.type).toBe('image/svg+xml');
    expect(watches.sizes(r.id).images).toBe(2);

    // 5. cleanup on delete
    expect(watches.sizes(r.id)).toMatchObject({ items: 5, runs: 3 });
    engine.routines.remove(r.id);
    expect(watches.sizes(r.id)).toEqual({ items: 0, runs: 0, images: 0 });
    expect(existsSync(join(t.home, 'cache', 'watch-images', r.id))).toBe(false);
  }, 120_000);

  test('a watch run sends nothing and never gets the writing tools', async () => {
    market = startFakeMarket();
    const item = () => `${market!.url}/marketplace/item/101/`;
    let ref = '';
    t = await start((body) => {
      const msgs = body.messages as Array<{ role: string; content: unknown }>;
      if (!JSON.stringify(msgs[0]).includes('Start at: ')) return undefined;
      const last = JSON.stringify(msgs[msgs.length - 1]);
      const turn = msgs.filter((m) => m.role === 'assistant').length;
      ref = /button \\"Message seller\\" \[ref=(e\d+)\]/.exec(last)?.[1] ?? ref;
      const steps = [
        [{ tool: 'browser_navigate', input: { url: item() } }],
        [{ tool: 'browser_snapshot', input: {} }],
        [{ tool: 'browser_click', input: { ref } }],
        [{ tool: 'browser_type', input: { ref, text: 'I will buy it' } }],
        [{ tool: 'browser_evaluate', input: { expression: "() => fetch('/checkout', { method: 'POST', body: '101' }).then(r => r.status)" } }],
        [{ tool: 'browser_profile', input: { name: 'work' } }],
        [{ tool: 'browser_login', input: {} }],
        [{ tool: 'WatchReport', input: { items: [{ id: '101', title: '2014 Honda Civic LX', price: '$6,500', url: item() }] } }],
        [{ text: 'Done.' }],
      ];
      return steps[Math.min(turn, steps.length - 1)] as never;
    });
    const { engine } = t;
    const watches = watchesOf(engine)!;
    const { routine } = watches.create({ name: 'Civic', schedule: '0 9 * * *', url: `${market.url}/marketplace/search?query=civic`, prompt: 'Watch the Civic.' }, { agent: 'assistant' });
    // even an owner's allow rule cannot bring a writing tool back
    engine.routines.update(routine.id, { allow: [...routine.allow!, 'browser_type', 'browser_evaluate', 'browser_login'] });

    // control: a normal session on the same page does send its beacon and open its WebSocket
    const b = browserOf(t);
    await b.navigate('control', item());
    const until = Date.now() + 5_000;
    while ((market.posts.length === 0 || market.sockets === 0) && Date.now() < until) await Bun.sleep(50);
    expect(market.posts.map((p) => p.path)).toContain('/beacon');
    expect(market.sockets).toBeGreaterThan(0);
    await b.closeSession('control');
    market.posts.length = 0;
    market.sockets = 0;

    const run = await engine.routines.runNow(routine.id, 'schedule');
    expect(run.status).toBe('ok');
    const results = toolResults(engine, run.sessionId!);
    const by = (n: string) => results.find((r) => r.name === n)!;
    // the page's beacon and WebSocket on load, the form post and the fetch: none reached the site
    expect(market.posts).toEqual([]);
    expect(market.sockets).toBe(0);
    expect(by('browser_click').content).toContain('Blocked a POST request');
    // the writing tools are not there at all
    for (const n of ['browser_type', 'browser_evaluate', 'browser_profile', 'browser_login']) {
      const r = results.find((x) => x.name === n || x.content.includes(n));
      expect(r?.isError).toBe(true);
    }
    expect(results.filter((r) => r.name === 'WatchReport')[0].isError).toBe(false);
    expect(watches.items(routine.id).map((i) => i.id)).toEqual(['101']);
    // the session's browser is closed and back to normal after the run
    expect(browserOf(t).isReadOnly(run.sessionId!)).toBe(false);
  }, 90_000);

  test('a profile signed in once is what the runs use; a run that reads nothing changes nothing', async () => {
    market = startFakeMarket({ requireLogin: true });
    t = await start();
    const { engine } = t;
    const heard = notices(t);
    const watches = watchesOf(engine)!;
    const b = browserOf(t);
    const { routine } = watches.create({ name: 'Cars', schedule: '0 9 * * *', url: `${market.url}/marketplace/search?query=cars`, prompt: 'Watch cars.', profile: 'market' }, { agent: 'assistant' });
    watches.seed(routine.id, CARS.slice(0, 2).map((c) => ({ id: c.id, title: c.title, price: c.price })));

    // signed out: the search shows a login wall, the run reports nothing, the items stay
    const out = await engine.routines.runNow(routine.id, 'schedule');
    expect(out.status).toBe('error');
    expect(out.error).toContain('reported no items');
    expect(watches.items(routine.id).filter((i) => i.present)).toHaveLength(2);
    expect(watches.runs(routine.id)).toHaveLength(0);
    expect(heard.find((n) => n.title === 'Watch failed: Cars')).toBeDefined();

    // Settings > Browser: the owner signs in once in the profile (the view is not read-only)
    const view = 'signin:test';
    b.setProfile(view, 'market');
    await b.navigate(view, `${market.url}/login`);
    const page = await b.page(view);
    await page.fill('input[name=email]', 'owner@example.com');
    await page.fill('input[name=password]', 'secret');
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    await b.closeSession(view);
    b.recordSignIn('market', new URL(market.url).hostname);
    expect(b.profileSignedInTo('127.0.0.1')).toBe('market');

    // the next run uses that profile's login
    const ok = await engine.routines.runNow(routine.id, 'schedule');
    expect(ok.status).toBe('ok');
    expect(market.searches.at(-1)).toEqual({ loggedIn: true });
    expect(ok.summary).toBe('2 new. 4 listed.');
    expect(watches.items(routine.id).filter((i) => i.mark === 'still')).toHaveLength(2);
    // a watch made from a chat that browsed with the default profile picks the signed in one
    const again = watches.create({ name: 'Cars 2', schedule: '0 9 * * *', url: `${market.url}/marketplace/search?query=honda`, prompt: 'Watch Hondas.' }, { agent: 'assistant' });
    expect(again.routine.watch!.profile).toBe('market');
  }, 90_000);

  test('the cap, and quiet hours hold the notice', async () => {
    market = startFakeMarket();
    t = await start();
    const { engine } = t;
    const heard = notices(t);
    const watches = watchesOf(engine)!;
    const { routine } = watches.create({ name: 'Few cars', schedule: '0 9 * * *', url: `${market.url}/marketplace/search?query=cars`, prompt: 'Watch cars.', cap: 3 }, { agent: 'assistant' });
    // quiet now: message hours start in two hours
    const h = (new Date().getUTCHours() + 2) % 24;
    const hh = (n: number) => String(n).padStart(2, '0');
    await assistantOf(engine)!.prefs.set({ hours: `${hh(h)}:00-${hh((h + 1) % 24)}:00` });

    const run = await engine.routines.runNow(routine.id, 'schedule');
    expect(run.status).toBe('ok');
    expect(watches.items(routine.id)).toHaveLength(3);
    expect(heard.filter((n) => n.watch)).toHaveLength(0);
    const held = engine.repos.jobs.pending(QUIET_JOB).map((j) => (j.payload as { notice: Notice }).notice);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ title: 'Few cars', link: `/routines/${routine.id}` });
    expect(held[0].watch?.counts.new).toBe(3);
  }, 90_000);
});

describe('watches without a browser', () => {
  test('a routine edit checks the watch and keeps the navigate rule on the site', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const watches = watchesOf(engine)!;
    const { routine } = watches.create({ name: 'Flats', schedule: '0 8 * * *', url: 'https://www.example-flats.test/search?q=2br', prompt: 'Watch flats.', filters: { maxPrice: 1500 } }, { agent: 'assistant' });
    expect(() => engine.routines.update(routine.id, { watch: { url: 'nope' } as never })).toThrow('http or https');
    const moved = engine.routines.update(routine.id, { watch: { ...routine.watch!, url: 'https://rentals.other.test/s' } }) as Routine;
    expect(moved.allow![0]).toBe('browser_navigate(domain:rentals.other.test)');
    expect(moved.allow).toContain('WatchReport');
    expect(watches.summaries()).toEqual([{ routineId: routine.id, count: 0, newCount: 0 }]);
    // a chat's report is remembered for a watch made from it, also after a restart (read back from the transcript)
    const s = await engine.createSession({ cwd: t.cwd });
    engine.repos.messages.insert({
      id: 'msg_w1',
      sessionId: s.id,
      seq: engine.repos.messages.nextSeq(s.id),
      role: 'assistant',
      kind: 'normal',
      content: [{ type: 'tool_use', id: 'tu1', name: 'WatchReport', input: { items: [{ id: '7', title: 'Flat 7', price: 1400 }, { title: 'no id' }] } }],
      createdAt: Date.now(),
    });
    expect(watches.draft(s.id)).toEqual([{ id: '7', title: 'Flat 7', price: 1400 }]);
    const made = watches.create({ name: 'Flats 2', schedule: '0 8 * * *', url: 'https://www.example-flats.test/search?q=2br', prompt: 'Watch flats.' }, { agent: 'assistant', sessionId: s.id });
    expect(made.seeded).toBe(1);
    expect(watches.summary(made.routine)).toMatchObject({ count: 1, newCount: 0 });
  });
});
