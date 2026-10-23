/**
 * A real CloakBrowser profile, end to end: launch, navigate, snapshot,
 * evaluate, a CDP screencast frame and takeover input against a local page,
 * with the renderer sandbox on. Runs only when CONCLAVE_CLOAK_BINARY points at
 * the CloakBrowser chrome binary (CONCLAVE_CLOAK_SHA256 pins it):
 *
 *   CONCLAVE_CLOAK_BINARY=~/.cloakbrowser/chromium-146.0.7680.177.5/chrome bun test packages/core/test/browser/browser-cloak.test.ts
 *
 * Chromium will not sandbox as root. On a root-only box, point it at a script
 * that runs chrome in a user namespace as another uid, for example
 * `exec unshare -U --map-user=1000 --map-group=1000 -- /path/to/chrome "$@"`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BrowserManager, CLOAK_SEED_FILE, browserTools, type ScreencastFrame } from '../../src/browser';
import type { Tool, ToolContext, ToolOutput } from '../../src/tools/types';

const BIN = process.env.CONCLAVE_CLOAK_BINARY;
let hasPlaywright = true;
try {
  await import('playwright-core');
} catch {
  hasPlaywright = false;
}
const live = BIN && hasPlaywright ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>Cloak test</title></head><body>
<h1>Sign up</h1>
<form action="/submit" method="get"><label>Name <input name="name" id="name"></label><button type="submit">Send</button></form>
</body></html>`;

/** The browser process of one profile and every process under it, from /proc (Linux only). Child processes rewrite their command line with spaces. */
function chromeTree(dir: string): { browser?: Proc; children: Proc[] } {
  const all: Proc[] = [];
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      let userNs = '';
      try {
        userNs = readlinkSync(`/proc/${pid}/ns/user`);
      } catch {
        // a sandboxed process is not dumpable, so its namespaces cannot be read: that alone says it is not ours
        userNs = 'unreadable';
      }
      all.push({ pid, ppid: /^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? '', args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/).filter(Boolean), status, userNs });
    } catch {
      /* gone, or not ours to read */
    }
  }
  const browser = all.find((p) => p.args.includes(`--user-data-dir=${dir}`) && !p.args.some((a) => a.startsWith('--type=')));
  const under = new Set(browser ? [browser.pid] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!under.has(p.pid) && under.has(p.ppid)) (under.add(p.pid), (grew = true));
  }
  return { browser, children: all.filter((p) => p !== browser && under.has(p.pid)) };
}

interface Proc {
  pid: string;
  ppid: string;
  args: string[];
  status: string;
  userNs: string;
}

live('CloakBrowser profile (live)', () => {
  let home: string;
  let manager: BrowserManager;
  let tools: Map<string, Tool>;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const ctx = (sessionId: string) => ({ sessionId, signal: new AbortController().signal }) as unknown as ToolContext;
  const text = (o: ToolOutput) => (typeof o.content === 'string' ? o.content : o.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n'));
  const run = (name: string, input: Record<string, unknown>, sid = 'c1') => tools.get(name)!.run(input, ctx(sid));

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'conclave-cloak-live-'));
    const config = new ConfigStore(home, {
      browser: { headless: true, profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: BIN, sha256: process.env.CONCLAVE_CLOAK_SHA256 } },
    });
    manager = new BrowserManager({ config, defaultProfile: 'stealth' });
    tools = new Map(browserTools(manager).map((t) => [t.name, t]));
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        const html = (b: string) => new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/') return html(PAGE);
        if (url.pathname === '/submit') return html(`<!doctype html><title>Done</title><h1>Hello, ${(url.searchParams.get('name') ?? '').replace(/</g, '')}</h1>`);
        return new Response('not found', { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await manager?.close();
    server?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('navigate and snapshot work, and the page sees no automation flag', async () => {
    const out = text(await run('browser_navigate', { url: base + '/' }));
    expect(out).toContain('Title: Cloak test');
    expect(out).toMatch(/textbox "Name" \[ref=e\d+\]/);
    expect(manager.profileInfo('stealth')).toMatchObject({ engine: 'cloak', label: 'CloakBrowser', open: true });
    const ev = text(await run('browser_evaluate', { expression: '() => ({ webdriver: navigator.webdriver, w: innerWidth })' }));
    expect(ev).toContain('"webdriver": false');
    expect(ev).toContain('"w": 1920');
  }, 90_000);

  test('the renderer sandbox is on and the profile keeps its seed', async () => {
    const dir = join(home, 'browser-profile', 'stealth');
    const seed = readFileSync(join(dir, CLOAK_SEED_FILE), 'utf8').trim();
    if (process.platform === 'linux') {
      const { browser, children } = chromeTree(dir);
      expect(browser).toBeDefined();
      expect(browser!.args).toContain(`--fingerprint=${seed}`);
      expect(browser!.args.some((a) => a.includes('no-sandbox'))).toBe(false);
      expect(browser!.args).not.toContain('--enable-automation');
      const renderers = children.filter((p) => p.args.includes('--type=renderer'));
      expect(renderers.length).toBeGreaterThan(0);
      // seccomp-bpf filter (mode 2) and a user namespace of their own: the renderer sandbox
      for (const r of renderers) {
        expect(r.status).toMatch(/^Seccomp:\s+2$/m);
        expect(r.userNs).not.toBe(browser!.userNs);
      }
    }
  }, 30_000);

  test('a CDP screencast frame arrives, says CloakBrowser, and takeover input types into the page', async () => {
    const sid = 'c1';
    const frames: ScreencastFrame[] = [];
    let got: () => void = () => {};
    const first = new Promise<void>((r) => (got = r));
    const stop = await manager.startScreencast('stealth', sid, (f) => {
      frames.push(f);
      got();
    });
    try {
      await Promise.race([first, Bun.sleep(20_000).then(() => Promise.reject(new Error('no frame')))]);
      expect(frames[0].engine).toBe('cloak');
      expect(frames[0].data.length).toBeGreaterThan(100);
      expect(frames[0].width).toBeGreaterThan(0);
      expect(frames[0].url).toBe(base + '/');
      const page = await manager.page(sid);
      const box = (await page.locator('#name').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await manager.dispatchInput('stealth', sid, { type: 'mouse', action: 'down', x, y, button: 'left' });
      await manager.dispatchInput('stealth', sid, { type: 'mouse', action: 'up', x, y, button: 'left' });
      await manager.dispatchInput('stealth', sid, { type: 'text', text: 'Ada' });
      expect(await page.locator('#name').inputValue()).toBe('Ada');
    } finally {
      stop();
    }
    const snap = await manager.snapshot(sid);
    const send = /button "Send" \[ref=(e\d+)\]/.exec(snap.tree)![1];
    expect(text(await run('browser_click', { ref: send }))).toContain('Hello, Ada');
  }, 90_000);

  test('the seed survives a restart of the browser', async () => {
    const dir = join(home, 'browser-profile', 'stealth');
    const seed = readFileSync(join(dir, CLOAK_SEED_FILE), 'utf8');
    await manager.close();
    expect(text(await run('browser_navigate', { url: base + '/' }))).toContain('Title: Cloak test');
    expect(readFileSync(join(dir, CLOAK_SEED_FILE), 'utf8')).toBe(seed);
    expect(existsSync(dir)).toBe(true);
  }, 90_000);
});
