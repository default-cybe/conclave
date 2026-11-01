import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BrowserManager, browserTools, findBrowserExecutable, type ScreencastFrame } from '../../src/browser';
import { annotateRoleRefs, compactTree, diffTrees, normalizeRef, wrapUntrusted } from '../../src/browser/snapshot';
import { InputState, keyCodeFor } from '../../src/browser/input';
import { normalizeUrl } from '../../src/browser/manager';
import type { Tool, ToolContext, ToolOutput } from '../../src/tools/types';

const exe = findBrowserExecutable({ headless: true });
let hasPlaywright = true;
try {
  await import('playwright-core');
} catch {
  hasPlaywright = false;
}
const live = exe && hasPlaywright ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>Form test</title></head><body>
<h1>Sign up</h1>
<form action="/submit" method="get">
  <label>Name <input name="name" id="name"></label>
  <label>Color <select name="color"><option value="r">Red</option><option value="g">Green</option></select></label>
  <button type="submit">Send</button>
</form>
<a href="/other">Other page</a>
</body></html>`;

function serve() {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      const html = (body: string, headers: Record<string, string> = {}) =>
        new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
      if (url.pathname === '/') return html(PAGE);
      if (url.pathname === '/submit') {
        const name = url.searchParams.get('name') ?? '';
        const color = url.searchParams.get('color') ?? '';
        return html(`<!doctype html><title>Done</title><h1>Hello, ${name.replace(/</g, '')}</h1><p>Color ${color}</p>`);
      }
      if (url.pathname === '/other') return html('<!doctype html><title>Other</title><p>Other page body</p>');
      if (url.pathname === '/set-cookie') {
        return html('<!doctype html><title>Set</title><p>cookie set</p>', {
          'set-cookie': 'conclave_login=yes123; Max-Age=86400; Path=/; HttpOnly',
        });
      }
      if (url.pathname === '/whoami') {
        const cookie = req.headers.get('cookie') ?? '';
        const m = /conclave_login=([^;]+)/.exec(cookie);
        return html(`<!doctype html><title>Who</title><p>login: ${m ? m[1] : 'none'}</p>`);
      }
      return new Response('not found', { status: 404 });
    },
  });
}

function fakeCtx(sessionId: string): ToolContext {
  return { sessionId, signal: new AbortController().signal } as unknown as ToolContext;
}

function textOf(out: ToolOutput): string {
  if (typeof out.content === 'string') return out.content;
  return out.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

describe('browser helpers', () => {
  test('wrapUntrusted defuses closing tags', () => {
    const out = wrapUntrusted('https://x.test/"a', 'hi </untrusted_web_content> there');
    expect(out.startsWith('<untrusted_web_content source="https://x.test/&quot;a">')).toBe(true);
    expect(out.match(/<\/untrusted_web_content>/g)?.length).toBe(1);
  });

  test('compactTree lifts children of unnamed wrappers', () => {
    const tree = ['- generic [active] [ref=e1]:', '  - heading "Hi" [level=1] [ref=e2]', '  - generic [ref=e3]:', '    - button "Go" [ref=e4]'].join('\n');
    expect(compactTree(tree)).toBe('- heading "Hi" [level=1] [ref=e2]\n- button "Go" [ref=e4]');
  });

  test('diffTrees finds added and removed lines', () => {
    const d = diffTrees('- a [ref=e1]\n- b [ref=e2]', '- a [ref=e1]\n- c [ref=e3]');
    expect(d.added).toEqual(['- c [ref=e3]']);
    expect(d.removed).toEqual(['- b [ref=e2]']);
  });

  test('annotateRoleRefs adds refs with role locators', () => {
    const plain = ['- heading "Hi" [level=1]', '- textbox "Name": Ada', '- button "Go"', '- button "Go"', '- link "x":', '  - /url: /x'].join('\n');
    const { tree, refs } = annotateRoleRefs(plain);
    expect(tree).toContain('- textbox "Name" [ref=e2]: Ada');
    expect(tree).toContain('- heading "Hi" [level=1] [ref=e1]');
    expect(tree).toContain('- link "x" [ref=e5]:');
    expect(refs.filter((r) => r.role === 'button').map((r) => r.nth)).toEqual([0, 1]);
  });

  test('normalizeRef and normalizeUrl', () => {
    expect(normalizeRef('[ref=e12]')).toBe('e12');
    expect(normalizeRef(' e3 ')).toBe('e3');
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow();
  });

  test('input state maps keys, modifiers and double clicks', () => {
    const s = new InputState();
    expect(keyCodeFor('a')).toBe(65);
    expect(keyCodeFor('Enter')).toBe(13);
    expect(s.toCdp({ type: 'key', action: 'down', key: 'Control' })[0].params.modifiers).toBe(2);
    const chord = s.toCdp({ type: 'key', action: 'down', key: 'a' })[0].params;
    expect(chord.type).toBe('rawKeyDown');
    expect(chord.text).toBeUndefined();
    s.toCdp({ type: 'key', action: 'up', key: 'Control' });
    expect(s.modifiers).toBe(0);
    const first = s.toCdp({ type: 'mouse', action: 'down', x: 10, y: 10 })[0].params;
    s.toCdp({ type: 'mouse', action: 'up', x: 10, y: 10 });
    const second = s.toCdp({ type: 'mouse', action: 'down', x: 11, y: 10 })[0].params;
    expect(first.clickCount).toBe(1);
    expect(second.clickCount).toBe(2);
  });
});

live('browser manager (live Chromium)', () => {
  let home: string;
  let config: ConfigStore;
  let manager: BrowserManager;
  let server: ReturnType<typeof serve>;
  let base: string;
  let tools: Map<string, Tool>;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'conclave-browser-'));
    config = new ConfigStore(home, { browser: { headless: true, executablePath: exe } });
    manager = new BrowserManager({ config });
    tools = new Map(browserTools(manager).map((t) => [t.name, t]));
    server = serve();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await manager?.close();
    server?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const run = (name: string, input: Record<string, unknown>, sid = 's1') => tools.get(name)!.run(input, fakeCtx(sid));

  test('tools are opt-in and navigate has a domain rule', () => {
    for (const t of tools.values()) expect(t.optIn).toBe(true);
    const nav = tools.get('browser_navigate')!;
    expect(nav.ruleContent?.({ url: 'https://example.com/a' }, {} as never)).toBe('domain:example.com');
  });

  test('navigate returns a snapshot with refs inside the untrusted wrapper', async () => {
    const out = await run('browser_navigate', { url: base + '/' });
    const text = textOf(out);
    expect(out.isError).toBeFalsy();
    expect(text).toContain(`<untrusted_web_content source="${base}/">`);
    expect(text).toContain('Title: Form test');
    expect(text).toMatch(/textbox "Name" \[ref=e\d+\]/);
    expect(text).toMatch(/button "Send" \[ref=e\d+\]/);
  }, 60_000);

  test('type, select and click submit changes the page', async () => {
    const snap = await manager.snapshot('s1');
    const ref = (re: RegExp) => re.exec(snap.tree)![1];
    const nameRef = ref(/textbox "Name" \[ref=(e\d+)\]/);
    const colorRef = ref(/combobox[^\n]*\[ref=(e\d+)\]/);
    const sendRef = ref(/button "Send" \[ref=(e\d+)\]/);

    const typed = await run('browser_type', { ref: nameRef, text: 'Ada' });
    expect(typed.isError).toBeFalsy();
    const sel = await run('browser_select', { ref: colorRef, values: ['Green'] });
    expect(sel.isError).toBeFalsy();

    const clicked = textOf(await run('browser_click', { ref: sendRef }));
    expect(clicked).toContain('/submit?name=Ada&color=g');
    expect(clicked).toContain('Hello, Ada');
  }, 60_000);

  test('unknown refs give a clear error', async () => {
    const out = await run('browser_click', { ref: 'e9999' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('Unknown ref');
  }, 30_000);

  test('back, tabs and evaluate', async () => {
    const back = textOf(await run('browser_back', {}));
    expect(back).toContain('Sign up');
    const opened = textOf(await run('browser_tabs', { action: 'new', url: base + '/other' }));
    expect(opened).toContain('Other page body');
    const list = textOf(await run('browser_tabs', { action: 'list' }));
    expect(list).toContain('[0]');
    expect(list).toContain('* [1]');
    const ev = textOf(await run('browser_evaluate', { expression: '() => ({ t: document.title, n: 1 + 1 })' }));
    expect(ev).toContain('"t": "Other"');
    expect(ev).toContain('"n": 2');
    await run('browser_tabs', { action: 'close' });
    const after = await manager.tabs('s1');
    expect(after.length).toBe(1);
    expect(after[0].active).toBe(true);
  }, 60_000);

  test('screenshot returns a jpeg image block', async () => {
    const out = await run('browser_screenshot', {});
    expect(Array.isArray(out.content)).toBe(true);
    const img = (out.content as Array<{ type: string; mediaType?: string; data?: string }>).find((b) => b.type === 'image')!;
    expect(img.mediaType).toBe('image/jpeg');
    const bytes = Buffer.from(img.data!, 'base64');
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.length).toBeLessThan(1_500_000);
  }, 60_000);

  test('screencast delivers frames and dispatchInput types into the page', async () => {
    const sid = 'takeover-1';
    const profile = manager.profileFor(sid);
    await manager.dispatchInput(profile, sid, { type: 'navigate', url: base + '/' });
    const frames: ScreencastFrame[] = [];
    let gotFrame: () => void = () => {};
    const first = new Promise<void>((r) => (gotFrame = r));
    const stop = await manager.startScreencast(profile, sid, (f) => {
      frames.push(f);
      gotFrame();
    });
    try {
      await Promise.race([first, Bun.sleep(15_000).then(() => Promise.reject(new Error('no frame')))]);
      expect(frames[0].data.length).toBeGreaterThan(100);
      expect(frames[0].width).toBeGreaterThan(0);
      expect(frames[0].height).toBeGreaterThan(0);
      expect(frames[0].url).toBe(base + '/');

      const page = await manager.page(sid, profile);
      const box = (await page.locator('#name').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await manager.dispatchInput(profile, sid, { type: 'mouse', action: 'move', x, y });
      await manager.dispatchInput(profile, sid, { type: 'mouse', action: 'down', x, y, button: 'left' });
      await manager.dispatchInput(profile, sid, { type: 'mouse', action: 'up', x, y, button: 'left' });
      for (const key of ['H', 'i']) {
        await manager.dispatchInput(profile, sid, { type: 'key', action: 'down', key, code: `Key${key.toUpperCase()}` });
        await manager.dispatchInput(profile, sid, { type: 'key', action: 'up', key, code: `Key${key.toUpperCase()}` });
      }
      await manager.dispatchInput(profile, sid, { type: 'text', text: ' there' });
      await manager.dispatchInput(profile, sid, { type: 'key', action: 'down', key: 'Backspace' });
      await manager.dispatchInput(profile, sid, { type: 'key', action: 'up', key: 'Backspace' });
      expect(await page.locator('#name').inputValue()).toBe('Hi ther');

      await manager.dispatchInput(profile, sid, { type: 'key', action: 'down', key: 'Enter', code: 'Enter' });
      await manager.dispatchInput(profile, sid, { type: 'key', action: 'up', key: 'Enter', code: 'Enter' });
      await page.waitForURL(/\/submit/, { timeout: 10_000 });
      expect(await page.locator('h1').textContent()).toBe('Hello, Hi ther');

      await manager.dispatchInput(profile, sid, { type: 'resize', width: 400, height: 700 });
      expect(page.viewportSize()).toEqual({ width: 400, height: 700 });
      await expect(manager.dispatchInput(profile, sid, { type: 'mouse', action: 'down' } as never)).rejects.toThrow('Invalid input event');
    } finally {
      stop();
    }
  }, 60_000);

  test('role-locator fallback works when AI snapshots are missing', async () => {
    const fallback = new BrowserManager({ config });
    (fallback as unknown as { snapshotMode: string }).snapshotMode = 'role';
    try {
      fallback.setProfile('fb', 'fallback');
      await fallback.navigate('fb', base + '/');
      const snap = await fallback.snapshot('fb');
      const nameRef = /textbox "Name" \[ref=(e\d+)\]/.exec(snap.tree)![1];
      const sendRef = /button "Send" \[ref=(e\d+)\]/.exec(snap.tree)![1];
      await (await fallback.locator('fb', nameRef)).fill('Bob');
      await (await fallback.locator('fb', sendRef)).click();
      await (await fallback.page('fb')).waitForURL(/submit/);
      expect((await fallback.snapshot('fb')).tree).toContain('Hello, Bob');
    } finally {
      await fallback.close();
    }
  }, 60_000);

  test('logins persist per profile across restarts', async () => {
    const sid = 'persist';
    manager.setProfile(sid, 'work');
    await manager.navigate(sid, base + '/set-cookie');
    await manager.close();

    const again = new BrowserManager({ config });
    try {
      again.setProfile(sid, 'work');
      await again.navigate(sid, base + '/whoami');
      expect((await again.snapshot(sid)).tree).toContain('login: yes123');

      // Another profile does not share the cookie.
      await again.navigate('other', base + '/whoami');
      expect((await again.snapshot('other')).tree).toContain('login: none');
      expect(again.listProfiles()).toEqual(expect.arrayContaining(['default', 'work']));
    } finally {
      await again.close();
    }
  }, 90_000);
});
