/**
 * A chat session's live browser view over HTTP (routes-browser.ts,
 * /api/browser/sessions/:session): the status opens nothing; frames come
 * only from that session's tab and only while it has one; input is refused
 * until the owner takes over, then goes to that tab; Give back and closing
 * the view hand the browser back. A fake browser: no Chromium runs.
 *
 *   bun test packages/server/test/browser-live-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { BrowserManager } from '@conclave/core/browser/index.ts';
import type { BrowserLiveDto, SignInFrameDto } from '@conclave/core/watches/index.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
let browser: BrowserManager;
/** Every CDP command the hub sent, with the page it went to. */
const sent: Array<{ page: string; method: string }> = [];
const casts: Array<(f: unknown) => void> = [];

class FakePage extends EventEmitter {
  closed = false;
  constructor(public name: string) {
    super();
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return `https://${this.name}.example/`;
  }
  mainFrame() {
    return {};
  }
  viewportSize() {
    return { width: 1280, height: 800 };
  }
  async bringToFront() {}
  async screenshot() {
    return Buffer.from(`shot of ${this.name}`);
  }
  context() {
    const page = this;
    return {
      async newCDPSession() {
        const cdp = new EventEmitter() as EventEmitter & { send: (m: string) => Promise<unknown>; detach: () => Promise<void> };
        cdp.send = async (method: string) => {
          sent.push({ page: page.name, method });
          if (method === 'Page.startScreencast') casts.push((f) => cdp.emit('Page.screencastFrame', f));
          return {};
        };
        cdp.detach = async () => {};
        return cdp;
      },
    };
  }
  async close() {
    this.closed = true;
    this.emit('close', this);
  }
}

let n = 0;
beforeAll(() => {
  hub = startHub();
  browser = new BrowserManager({
    config: hub.engine.config,
    launcher: {
      launchPersistentContext: async () => {
        const pages: FakePage[] = [];
        return {
          pages: () => pages,
          newPage: async () => {
            const p = new FakePage(`tab${++n}`);
            pages.push(p);
            return p;
          },
          on: () => {},
          setDefaultTimeout: () => {},
          setDefaultNavigationTimeout: () => {},
          close: async () => {
            for (const p of pages) await p.close();
          },
        } as never;
      },
    },
  });
  (hub.engine as unknown as { browser: BrowserManager }).browser = browser;
});

afterAll(async () => {
  await browser.close();
  await hub.stop();
});

const json = async <T>(r: Response) => (await r.json()) as T;
const mouse = [{ type: 'mouse', action: 'down', x: 10, y: 10, button: 'left' }];

describe('a session browser live view', () => {
  let sid = '';
  let other = '';

  test('status opens nothing; no tab means no frames and no take over', async () => {
    sid = (await hub.engine.createSession({ title: 'Browse' })).id;
    other = (await hub.engine.createSession({ title: 'Other' })).id;
    const st = await json<BrowserLiveDto>(await hub.api(`/api/browser/sessions/${sid}`));
    expect(st).toEqual({ open: false, held: false });
    expect(browser.hasPage(sid)).toBe(false);
    expect((await hub.api(`/api/browser/sessions/${sid}/frame`)).status).toBe(404);
    expect((await hub.api(`/api/browser/sessions/${sid}/control`, { method: 'POST', json: { take: true } })).status).toBe(404);
    // still nothing opened by asking
    expect(browser.hasPage(sid)).toBe(false);
    expect((await hub.api('/api/browser/sessions/nope/frame')).status).toBe(404);
  });

  test("frames are of the session's own tab", async () => {
    const page = (await browser.page(sid)) as unknown as FakePage;
    await browser.page(other);
    const st = await json<BrowserLiveDto>(await hub.api(`/api/browser/sessions/${sid}`));
    expect(st).toMatchObject({ open: true, held: false, profile: 'default' });
    // no screencast frame yet: the hub takes a picture of the tab
    const first = await hub.api(`/api/browser/sessions/${sid}/frame?after=0`);
    expect(first.status).toBe(200);
    const shot = await json<SignInFrameDto>(first);
    expect(shot.url).toBe(page.url());
    expect(Buffer.from(shot.data, 'base64').toString()).toBe(`shot of ${page.name}`);
    // then the screencast's frames, of that tab only
    expect(sent.filter((s) => s.method === 'Page.startScreencast').map((s) => s.page)).toEqual([page.name]);
    casts.at(-1)!({ data: 'AAAA', sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
    const cast = await json<SignInFrameDto>(await hub.api(`/api/browser/sessions/${sid}/frame?after=${shot.seq}`));
    expect(cast).toMatchObject({ data: 'AAAA', url: page.url(), width: 1280 });
    expect((await hub.api(`/api/browser/sessions/${sid}/frame?after=${cast.seq}`)).status).toBe(204);
    expect((await json<BrowserLiveDto>(await hub.api(`/api/browser/sessions/${sid}`))).url).toBe(page.url());
  });

  test('input is refused until Take over, then goes to that tab; Give back stops it', async () => {
    const before = sent.length;
    const refused = await hub.api(`/api/browser/sessions/${sid}/input`, { method: 'POST', json: { events: mouse } });
    expect(refused.status).toBe(409);
    expect(sent.length).toBe(before);

    const took = await json<BrowserLiveDto>(await hub.api(`/api/browser/sessions/${sid}/control`, { method: 'POST', json: { take: true } }));
    expect(took.held).toBe(true);
    expect(browser.ownerHolds(sid)).toBe(true);
    expect(browser.ownerHolds(other)).toBe(false);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'browser.takeover')).toBe(true);

    const ok = await hub.api(`/api/browser/sessions/${sid}/input`, { method: 'POST', json: { events: mouse } });
    expect(ok.status).toBe(200);
    const mine = sent.slice(before).filter((s) => s.method === 'Input.dispatchMouseEvent');
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((s) => s.page))).toEqual(new Set([((await browser.page(sid)) as unknown as FakePage).name]));
    // another session is not held, so its page takes no input
    expect((await hub.api(`/api/browser/sessions/${other}/input`, { method: 'POST', json: { events: mouse } })).status).toBe(409);
    expect((await hub.api(`/api/browser/sessions/${sid}/input`, { method: 'POST', json: { events: [{ type: 'evil' }] } })).status).toBe(400);

    const back = await json<BrowserLiveDto>(await hub.api(`/api/browser/sessions/${sid}/control`, { method: 'POST', json: { take: false } }));
    expect(back.held).toBe(false);
    expect((await hub.api(`/api/browser/sessions/${sid}/input`, { method: 'POST', json: { events: mouse } })).status).toBe(409);
    expect((await hub.api(`/api/browser/sessions/${sid}/control`, { method: 'POST', json: { take: 'yes' } })).status).toBe(400);
  });

  test("closing the view gives the browser back and keeps the session's tab", async () => {
    await hub.api(`/api/browser/sessions/${sid}/control`, { method: 'POST', json: { take: true } });
    expect((await hub.api(`/api/browser/sessions/${sid}/frame`, { method: 'DELETE' })).status).toBe(200);
    expect(browser.ownerHolds(sid)).toBe(false);
    expect(browser.hasPage(sid)).toBe(true);
  });

  test("a member gets 403 on every live view route, also for a session of their own, and changes nothing", async () => {
    const PW = 'a long enough password';
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'alice', password: PW } })).status).toBe(200);
    const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: PW, name: 'phone' } });
    expect(login.status).toBe(200);
    const token = ((await login.json()) as { token: string }).token;
    const made = await hub.api('/api/sessions', { method: 'POST', token, json: { title: 'alice chat' } });
    expect(made.status).toBe(200);
    const own = ((await made.json()) as { id: string }).id;
    await browser.page(own);
    const before = sent.length;
    for (const s of [sid, own]) {
      const base = `/api/browser/sessions/${s}`;
      const calls: Array<[string, string, unknown?]> = [
        ['GET', base],
        ['GET', `${base}/frame?after=0`],
        ['DELETE', `${base}/frame`],
        ['POST', `${base}/input`, { events: mouse }],
        ['POST', `${base}/control`, { take: true }],
      ];
      for (const [method, path, json] of calls) {
        const res = await hub.api(path, { method, token, json });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
        // no frame, no state comes back
        expect(await res.text()).not.toContain('data');
      }
      expect(browser.ownerHolds(s)).toBe(false);
    }
    // nothing reached a page: no screencast, no input
    expect(sent.length).toBe(before);
  });

  test('a token that is not the owner gets nothing', async () => {
    expect((await hub.api(`/api/browser/sessions/${sid}/frame`, { token: null })).status).toBe(401);
    expect((await hub.api(`/api/browser/sessions/${sid}/control`, { method: 'POST', json: { take: true }, token: 'not-a-token' })).status).toBe(401);
  });
});
