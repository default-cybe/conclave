/**
 * Capture: one call that looks at any http(s) URL the way a designer would.
 * Used by the Capture tool (tools/capture.ts) and lib.capture in workflows
 * (workflows/run.ts); this is the one implementation.
 *
 * Per browser (stock Chromium, and Playwright's Firefox when it is installed)
 * a fresh headless browser with no profile opens the page at each width and
 * theme and saves a full-page PNG, an early frame earlyFrame seconds after
 * load (intro animations), and frames while it scrolls, tiled into contact
 * sheets with ffmpeg (util/ffmpeg.ts). A JSON report holds console errors,
 * failed requests, horizontal overflow, loaded fonts, CLS, LCP and axe-core
 * violations. A page with H.264 video runs on real Chrome when one is
 * installed (Playwright's Chromium plays it black). CloakBrowser is never used.
 *
 * The URL and the page are untrusted: only http(s), cloud metadata hosts are
 * refused (tools/webfetch.ts guardHost) for the page and every request it
 * makes, and every string the page wrote sits in report.page inside
 * <untrusted_web_content>. Sizes are capped (CAPTURE_LIMITS).
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserType, Page } from 'playwright-core';
// axe-core's browser bundle as text, embedded in the compiled binary like the default workflows
import axeSource from 'axe-core/axe.min.js' with { type: 'text' };
import { guardHost } from '../tools/webfetch';
import { wrapUntrusted } from '../tools/util';
import { contactSheetArgs, findFfmpeg, runFfmpeg } from '../util/ffmpeg';
import { playwrightCacheDirs } from './executable';
import type { BrowserManager } from './manager';
import { hubBrowsersPath, loadPlaywright } from './runtime';

export type CaptureTheme = 'light' | 'dark';
export type CaptureBrowserName = 'chromium' | 'firefox';

export interface CaptureOptions {
  widths?: number[];
  themes?: CaptureTheme[];
  /** Seconds after the load event for the early frame. */
  earlyFrame?: number;
  scroll?: boolean;
  browsers?: CaptureBrowserName[];
  reducedMotion?: boolean;
}

export const CAPTURE_DEFAULTS = { widths: [390, 1440], themes: ['light', 'dark'] as CaptureTheme[], earlyFrame: 0.35, scroll: true, browsers: ['chromium', 'firefox'] as CaptureBrowserName[], reducedMotion: true };

export const CAPTURE_LIMITS = {
  widths: 4,
  minWidth: 240,
  maxWidth: 2560,
  /** Full-page shots are cut at this height. */
  maxPageHeight: 8000,
  /** Scroll frames per width. */
  scrollFrames: 24,
  /** Characters of page text in a report. */
  pageText: 30_000,
  listItems: 40,
  itemChars: 300,
  navMs: 30_000,
  settleMs: 4_000,
  totalMs: 240_000,
} as const;

/** What capture needs from the hub: playwright-core and the binaries it may start. */
export interface CaptureDeps {
  chromium: BrowserType;
  firefox?: BrowserType;
  /** Stock Chromium (BrowserManager.stockExecutable), never CloakBrowser. */
  chromiumPath?: string;
  /** Real Google Chrome, for H.264 video. */
  chromePath?: string;
  /** Playwright's Firefox build. */
  firefoxPath?: string;
  /** ffmpeg for contact sheets, or why there is none. */
  ffmpeg(): Promise<{ path: string } | { error: string }>;
  /** Folder the files go to; a sub-folder per capture is made in it. */
  outDir: string;
  signal?: AbortSignal;
}

export interface CaptureShot {
  width: number;
  theme: CaptureTheme;
  png: string;
  early?: string;
}

export interface CaptureBrowserResult {
  browser: CaptureBrowserName;
  /** chrome when real Chrome ran (H.264 video on the page). */
  ran: 'chromium' | 'chrome' | 'firefox';
  executable: string;
  version?: string;
  why?: string;
  shots: CaptureShot[];
  /** Contact sheets per width. */
  sheets: Record<number, string[]>;
  /** Scroll frames kept when no sheet could be made. */
  frames: Record<number, string[]>;
  sheetNote?: string;
  report: string;
  summary: CaptureSummary;
  error?: string;
}

export interface CaptureSummary {
  consoleErrors: number;
  failedRequests: number;
  overflow: Record<number, number>;
  fonts: number;
  cls: Record<number, number | null>;
  lcpMs: Record<number, number | null>;
  axe: Array<{ id: string; impact: string | null; help: string; nodes: number }>;
}

export interface CaptureResult {
  url: string;
  dir: string;
  results: CaptureBrowserResult[];
  skipped: Array<{ browser: CaptureBrowserName; why: string }>;
}

/** The URL as an http(s) URL, or why not. */
export function captureUrl(raw: unknown): URL | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'url is required.' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: `Not a URL: ${String(raw).slice(0, 200)}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `Refused: Capture opens only http and https URLs, not ${u.protocol}` };
  if (u.username || u.password) return { error: 'Refused: a URL with a user name or password in it.' };
  return u;
}

/** Options checked and capped, defaults filled in. */
export function captureOptions(o: CaptureOptions = {}): Required<CaptureOptions> {
  const widths = (Array.isArray(o.widths) && o.widths.length ? o.widths : CAPTURE_DEFAULTS.widths)
    .map((w) => Math.round(Number(w)))
    .filter((w) => Number.isFinite(w))
    .map((w) => Math.min(CAPTURE_LIMITS.maxWidth, Math.max(CAPTURE_LIMITS.minWidth, w)));
  const themes = (Array.isArray(o.themes) && o.themes.length ? o.themes : CAPTURE_DEFAULTS.themes).filter((t): t is CaptureTheme => t === 'light' || t === 'dark');
  const browsers = (Array.isArray(o.browsers) && o.browsers.length ? o.browsers : CAPTURE_DEFAULTS.browsers).filter((b): b is CaptureBrowserName => b === 'chromium' || b === 'firefox');
  const early = typeof o.earlyFrame === 'number' && Number.isFinite(o.earlyFrame) ? Math.min(10, Math.max(0, o.earlyFrame)) : CAPTURE_DEFAULTS.earlyFrame;
  return {
    widths: [...new Set(widths)].slice(0, CAPTURE_LIMITS.widths),
    themes: themes.length ? [...new Set(themes)] : CAPTURE_DEFAULTS.themes,
    earlyFrame: early,
    scroll: typeof o.scroll === 'boolean' ? o.scroll : CAPTURE_DEFAULTS.scroll,
    browsers: browsers.length ? [...new Set(browsers)] : ['chromium'],
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : CAPTURE_DEFAULTS.reducedMotion,
  };
}

const CHROME_PATHS: Record<string, string[]> = {
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map((r) => `${r}\\Google\\Chrome\\Application\\chrome.exe`),
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Real Google Chrome on this machine, if any. */
export function findChrome(): string | undefined {
  return (CHROME_PATHS[process.platform] ?? []).find(isFile);
}

/** Playwright's Firefox build (firefox-<rev>/firefox/firefox), newest first, in the hub's folder and Playwright's caches. */
export function findPlaywrightFirefox(extraDirs: string[] = []): string | undefined {
  const bins = ['firefox/firefox', 'firefox/Nightly.app/Contents/MacOS/firefox', 'firefox/firefox.exe'];
  for (const dir of playwrightCacheDirs(extraDirs)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const revs = names.filter((n) => /^firefox-\d+$/.test(n)).sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)));
    for (const r of revs) for (const b of bins) if (isFile(join(dir, r, b))) return join(dir, r, b);
  }
  return undefined;
}

/**
 * Capture with the hub's browser install: playwright-core from the app or the
 * hub's browser folder, the stock Chromium a preview uses, real Chrome and
 * Playwright's Firefox when they are there, ffmpeg from util/ffmpeg.ts.
 */
export async function hubCapture(browser: BrowserManager | undefined, home: string, outDir: string, url: string, opts: CaptureOptions, signal?: AbortSignal): Promise<CaptureResult> {
  if (!browser) throw new Error('This hub has no browser service.');
  const pw = await loadPlaywright(browser.runtimeDir());
  const chromiumPath = browser.stockExecutable();
  const chromePath = findChrome();
  if (!chromiumPath && !chromePath) throw new Error('No browser is installed on this hub yet. The owner can install one in Settings, Browser, Engines.');
  return capture(url, opts, { chromium: pw.chromium, firefox: pw.firefox, chromiumPath, chromePath, firefoxPath: findPlaywrightFirefox([hubBrowsersPath(home)]), ffmpeg: () => findFfmpeg(home), outDir, signal });
}

const clip = (s: unknown, n: number = CAPTURE_LIMITS.itemChars) => String(s ?? '').slice(0, n);

/** Measures that run in the page after it settled. Returns only plain data. */
const MEASURE = `async () => {
  const vw = document.documentElement.clientWidth;
  const sel = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  const wide = [];
  for (const e of document.body ? document.body.querySelectorAll('*') : []) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    // only the outermost offender: a child of a wide element is not listed again
    if (e.parentElement && wide.some((w) => w.el.contains(e))) continue;
    wide.push({ el: e, selector: sel(e), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    if (wide.length >= 40) break;
  }
  let cls = null, lcp = null;
  const entries = (type) => new Promise((done) => {
    try {
      const got = [];
      const po = new PerformanceObserver((l) => got.push(...l.getEntries()));
      po.observe({ type, buffered: true });
      setTimeout(() => { po.disconnect(); done(got); }, 50);
    } catch (e) { done(null); }
  });
  const ls = PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes('layout-shift') ? await entries('layout-shift') : null;
  if (ls) cls = Math.round(ls.filter((e) => !e.hadRecentInput).reduce((s, e) => s + e.value, 0) * 1000) / 1000;
  const lc = PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint') ? await entries('largest-contentful-paint') : null;
  if (lc && lc.length) lcp = Math.round(lc[lc.length - 1].startTime);
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
  const fonts = [];
  document.fonts.forEach((f) => { if (f.status === 'loaded') fonts.push(f.family.replace(/^["']|["']$/g, '') + ' ' + f.weight + ' ' + f.style); });
  return {
    title: document.title,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: vw,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    overflow: wide.map(({ el, ...rest }) => rest),
    cls, lcp, fonts: [...new Set(fonts)],
  };
}`;

/** True when a <video> on the page plays MP4/H.264 (by file name or type). shortcut: a stream fed through MediaSource (blob:) is not seen; pass browsers with real Chrome by hand then. */
const HAS_H264 = `() => [...document.querySelectorAll('video')].some((v) => {
  const s = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((x) => x.src + ' ' + (x.type || ''))].join(' ').toLowerCase();
  return /\\.(mp4|m4v|mov)(\\?|#|\\s|$)|avc1|h264|video\\/mp4/.test(s);
})`;

interface Seen {
  console: string[];
  failed: string[];
}

/** Text the page wrote, capped. */
function push(list: string[], s: string): void {
  if (list.length < CAPTURE_LIMITS.listItems && !list.includes(s)) list.push(s);
}

function slug(u: URL): string {
  return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
}

/** Run a capture. Throws only for a refused URL or no browser at all; per-browser failures are in the result. */
export async function capture(rawUrl: string, opts: CaptureOptions, deps: CaptureDeps): Promise<CaptureResult> {
  const u = captureUrl(rawUrl);
  if ('error' in u) throw new Error(u.error);
  const g = await guardHost(u);
  if ('error' in g) throw new Error(g.error);
  const o = captureOptions(opts);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(deps.outDir, 'capture', `${slug(u)}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const results: CaptureBrowserResult[] = [];
  const skipped: CaptureResult['skipped'] = [];
  const deadline = Date.now() + CAPTURE_LIMITS.totalMs;
  for (const name of o.browsers) {
    if (deps.signal?.aborted) throw new Error('Stopped.');
    if (name === 'firefox') {
      if (!deps.firefox || !deps.firefoxPath) {
        skipped.push({ browser: 'firefox', why: 'No Playwright Firefox build is installed on the hub.' });
        continue;
      }
      results.push(await runBrowser(u, o, deps, dir, { name, ran: 'firefox', type: deps.firefox, exe: deps.firefoxPath }, deadline));
      continue;
    }
    const exe = deps.chromiumPath ?? deps.chromePath;
    if (!exe) {
      skipped.push({ browser: 'chromium', why: 'No Chromium is installed on the hub.' });
      continue;
    }
    const first = await runBrowser(u, o, deps, dir, { name, ran: exe === deps.chromePath ? 'chrome' : 'chromium', type: deps.chromium, exe, watchH264: exe !== deps.chromePath }, deadline);
    if (first.error === H264 && deps.chromePath) {
      results.push(await runBrowser(u, o, deps, dir, { name, ran: 'chrome', type: deps.chromium, exe: deps.chromePath, why: 'The page has H.264 video, which Playwright\'s Chromium plays black: real Chrome ran it.' }, deadline));
    } else if (first.error === H264) {
      results.push(await runBrowser(u, o, deps, dir, { name, ran: 'chromium', type: deps.chromium, exe, why: 'The page has H.264 video and no real Chrome is installed: its video may show black.' }, deadline));
    } else results.push(first);
  }
  return { url: u.href, dir, results, skipped };
}

const H264 = 'h264';

async function runBrowser(
  u: URL,
  o: Required<CaptureOptions>,
  deps: CaptureDeps,
  root: string,
  b: { name: CaptureBrowserName; ran: CaptureBrowserResult['ran']; type: BrowserType; exe: string; why?: string; watchH264?: boolean },
  deadline: number,
): Promise<CaptureBrowserResult> {
  const dir = join(root, b.ran);
  mkdirSync(dir, { recursive: true });
  const res: CaptureBrowserResult = { browser: b.name, ran: b.ran, executable: b.exe, ...(b.why ? { why: b.why } : {}), shots: [], sheets: {}, frames: {}, report: join(dir, 'report.json'), summary: { consoleErrors: 0, failedRequests: 0, overflow: {}, fonts: 0, cls: {}, lcpMs: {}, axe: [] } };
  const seen: Seen = { console: [], failed: [] };
  const page: Record<string, unknown> = {};
  const hosts = new Map<string, Promise<boolean>>();
  let browser: Browser | undefined;
  const stop = () => void browser?.close().catch(() => {});
  deps.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, Math.max(5_000, deadline - Date.now()));
  try {
    browser = await b.type.launch({ executablePath: b.exe, headless: true, timeout: 30_000, ...(b.name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-networking', '--no-first-run'] } : {}) });
    res.version = browser.version();
    let axeDone = false;
    for (const width of o.widths) {
      for (const [ti, theme] of o.themes.entries()) {
        if (Date.now() > deadline) throw new Error('Capture ran out of time; the shots so far are kept.');
        const height = width < 600 ? 844 : 900;
        const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: o.reducedMotion ? 'reduce' : 'no-preference', serviceWorkers: 'block', acceptDownloads: false, deviceScaleFactor: 1 });
        try {
          // every request the page makes is checked like WebFetch's: no cloud metadata service (shortcut: names are checked once per capture, a DNS rebind after that is not seen)
          await ctx.route('**/*', async (route) => {
            let ok = true;
            try {
              const h = new URL(route.request().url());
              if (h.protocol === 'http:' || h.protocol === 'https:') {
                let p = hosts.get(h.hostname);
                if (!p) hosts.set(h.hostname, (p = guardHost(h).then((r) => !('error' in r))));
                ok = await p;
              }
            } catch {
              ok = true;
            }
            if (!ok) push(seen.failed, `blocked (metadata address): ${clip(route.request().url())}`);
            return ok ? route.continue().catch(() => {}) : route.abort('blockedbyclient').catch(() => {});
          });
          const p = await ctx.newPage();
          p.setDefaultTimeout(CAPTURE_LIMITS.navMs);
          p.on('console', (m) => {
            if (m.type() === 'error') push(seen.console, clip(m.text()));
          });
          p.on('pageerror', (e) => push(seen.console, clip(`pageerror: ${e.message}`)));
          p.on('requestfailed', (r) => push(seen.failed, clip(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`)));
          p.on('response', (r) => {
            if (r.status() >= 400) push(seen.failed, clip(`${r.status()} ${r.url()}`));
          });
          await p.goto(u.href, { waitUntil: 'load', timeout: CAPTURE_LIMITS.navMs });
          if (b.watchH264 && (await p.evaluate(`(${HAS_H264})()`).catch(() => false))) {
            res.error = H264;
            return res;
          }
          const tag = `${width}-${theme}`;
          let early: string | undefined;
          if (o.earlyFrame >= 0) {
            await p.waitForTimeout(o.earlyFrame * 1000);
            early = join(dir, `${tag}-early.png`);
            await p.screenshot({ path: early, type: 'png' });
          }
          await p.waitForLoadState('networkidle', { timeout: CAPTURE_LIMITS.settleMs }).catch(() => {});
          const m = (await p.evaluate(`(${MEASURE})()`)) as { title: string; scrollWidth: number; clientWidth: number; scrollHeight: number; overflow: Array<{ selector: string; left: number; right: number; width: number }>; cls: number | null; lcp: number | null; fonts: string[] };
          const png = join(dir, `${tag}.png`);
          await p.screenshot({ path: png, type: 'png', fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(Math.max(height, m.scrollHeight), CAPTURE_LIMITS.maxPageHeight) } });
          res.shots.push({ width, theme, png, ...(early ? { early } : {}) });
          if (ti === 0) {
            if (!page.finalUrl) Object.assign(page, { finalUrl: clip(p.url(), 2000), title: clip(m.title) });
            res.summary.overflow[width] = m.overflow.length + (m.scrollWidth > m.clientWidth + 1 && !m.overflow.length ? 1 : 0);
            res.summary.cls[width] = m.cls;
            res.summary.lcpMs[width] = m.lcp;
            res.summary.fonts = Math.max(res.summary.fonts, m.fonts.length);
            page[`overflow_${width}`] = { scrollWidth: m.scrollWidth, viewport: m.clientWidth, elements: m.overflow.slice(0, CAPTURE_LIMITS.listItems) };
            page.fonts = m.fonts.slice(0, CAPTURE_LIMITS.listItems).map((f) => clip(f, 120));
            if (!axeDone) {
              axeDone = true;
              const axe = await runAxe(p).catch((e: Error) => ({ error: clip(e.message) }));
              if ('error' in axe) page.axeError = axe.error;
              else {
                res.summary.axe = axe.map((v) => ({ id: clip(v.id, 80), impact: v.impact ?? null, help: clip(v.help, 200), nodes: v.nodes.length }));
                page.axeNodes = Object.fromEntries(axe.map((v) => [clip(v.id, 80), v.nodes.slice(0, 5).map((n) => clip(n.target.join(' '), 200))]));
              }
            }
            if (o.scroll) await scrollFrames(p, dir, width, height, m.scrollHeight, deps, res);
          }
        } finally {
          await ctx.close().catch(() => {});
        }
      }
    }
  } catch (e) {
    res.error = deps.signal?.aborted ? 'Stopped.' : clip(e instanceof Error ? e.message : String(e), 500);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', stop);
    await browser?.close().catch(() => {});
  }
  res.summary.consoleErrors = seen.console.length;
  res.summary.failedRequests = seen.failed.length;
  page.consoleErrors = seen.console;
  page.failedRequests = seen.failed;
  writeReport(u, res, page);
  return res;
}

/** The report file: structured counts, and every string from the page in one wrapped block. */
export function reportOf(u: URL, res: CaptureBrowserResult, page: Record<string, unknown>): Record<string, unknown> {
  let text = JSON.stringify(page, null, 1);
  if (text.length > CAPTURE_LIMITS.pageText) text = `${text.slice(0, CAPTURE_LIMITS.pageText)}\n... [cut at ${CAPTURE_LIMITS.pageText} characters]`;
  return {
    url: u.href,
    browser: { name: res.browser, ran: res.ran, executable: res.executable, version: res.version ?? null, ...(res.why ? { why: res.why } : {}) },
    ...(res.error ? { error: res.error } : {}),
    summary: res.summary,
    shots: res.shots,
    contactSheets: res.sheets,
    ...(Object.keys(res.frames).length ? { scrollFrames: res.frames } : {}),
    ...(res.sheetNote ? { sheetNote: res.sheetNote } : {}),
    page: wrapUntrusted(u.href, text),
  };
}

function writeReport(u: URL, res: CaptureBrowserResult, page: Record<string, unknown>): void {
  writeFileSync(res.report, JSON.stringify(reportOf(u, res, page), null, 2));
}

interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: string[] }>;
}

async function runAxe(p: Page): Promise<AxeViolation[]> {
  // evaluate, not a script tag: a page's CSP does not stop it
  await p.evaluate(axeSource);
  return (await p.evaluate(`(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.map(String) })) })); })()`)) as AxeViolation[];
}

/**
 * Frames while the page scrolls down, then contact sheets of them.
 * shortcut: a frame every 0.6 viewport with 250 ms between (a slow recording), not a video; a real screencast would need Playwright's ffmpeg in every browser.
 */
async function scrollFrames(p: Page, dir: string, width: number, height: number, scrollHeight: number, deps: CaptureDeps, res: CaptureBrowserResult): Promise<void> {
  const fdir = join(dir, `frames-${width}`);
  mkdirSync(fdir, { recursive: true });
  const total = Math.max(0, Math.min(scrollHeight, CAPTURE_LIMITS.maxPageHeight) - height);
  const steps = Math.min(CAPTURE_LIMITS.scrollFrames - 1, Math.ceil(total / (height * 0.6)));
  const frames: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = steps ? Math.round((total * i) / steps) : 0;
    await p.evaluate(`window.scrollTo(0, ${y})`);
    await p.waitForTimeout(250);
    const f = join(fdir, `f${String(i).padStart(3, '0')}.png`);
    await p.screenshot({ path: f, type: 'png' });
    frames.push(f);
  }
  await p.evaluate('window.scrollTo(0, 0)').catch(() => {});
  const ff = await deps.ffmpeg();
  if ('error' in ff) {
    res.frames[width] = frames;
    res.sheetNote = `No contact sheets: ${ff.error} The scroll frames are kept instead.`;
    return;
  }
  const out = join(dir, `${width}-scroll-%02d.png`);
  const r = await runFfmpeg(ff.path, contactSheetArgs({ input: join(fdir, 'f%03d.png'), output: out, frames: frames.length, width: Math.min(360, width) }), { signal: deps.signal });
  if (!r.ok) {
    res.frames[width] = frames;
    res.sheetNote = `No contact sheets: ${r.error}. The scroll frames are kept instead.`;
    return;
  }
  res.sheets[width] = readdirSync(dir).filter((n) => n.startsWith(`${width}-scroll-`)).sort().map((n) => join(dir, n));
  rmSync(fdir, { recursive: true, force: true });
}
