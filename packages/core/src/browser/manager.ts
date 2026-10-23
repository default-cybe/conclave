import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BrowserContext, BrowserType, CDPSession, Frame, Locator, Page, Request, Route } from 'playwright-core';
import type { ConfigStore } from '../config';
import type { ConclaveConfig } from '../config/schema';
import { logger } from '../util/log';
import { oneLine, sleep } from '../util/text';
import { findBrowserExecutable } from './executable';
import {
  CLOAK_SANDBOX_HELP,
  ENGINE_LABEL,
  cloakExecutable,
  cloakLaunchOptions,
  engineFor,
  isMissingLibrary,
  isSandboxFailure,
  MISSING_LIBS_HELP,
  profileSeed,
  verifyCloakBinary,
  type BrowserEngine,
  type BrowserProfileInfo,
} from './engine';
import { fillSavedLogin, LoginRefused, type FillOutcome } from './autofill';
import { InputState, validateInputEvent, type BrowserInputEvent } from './input';
import { LoginVault, originMatches, siteHost, siteOrigin, type SavedLogin } from './logins';
import type { ProxyEntry } from './proxy-list';
import { probeProxy, SocksRelay, type ProbeResult } from './proxy-net';
import { countryCode, countryLabel, defaultCountry, resolveProxy, type ResolvedProxy } from './proxy-provider';
import { browserDir, cloakInstalled, hubBrowsersPath, loadPlaywright } from './runtime';
import { annotateRoleRefs, capLines, compactTree, extractRefs, normalizeRef, SNAPSHOT_MAX_CHARS, wrapUntrusted } from './snapshot';

const log = logger('browser');

export const DEFAULT_PROFILE = 'default';
export const IDLE_CLOSE_MS = 15 * 60_000;
export const SCREENSHOT_MAX_BYTES = 1_500_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** Most image APIs reject sides over 8000px. */
const MAX_SHOT_HEIGHT = 7900;

export interface BrowserManagerOptions {
  config: ConfigStore;
  /** Close a profile's browser after this long without use. Default 15 minutes. */
  idleMs?: number;
  /** Profile for sessions that never picked one. Default "default". */
  defaultProfile?: string;
  /** Launches the browser. Default Playwright's chromium; tests pass a fake. */
  launcher?: Pick<BrowserType, 'launchPersistentContext'>;
  /** The exit IP check of a proxied browser. Default probeProxy against Cloudflare's trace page. */
  proxyProbe?: (p: ProxyEntry) => Promise<ProbeResult>;
}

/** A session's proxy, as the tools report it. Never a login or password. */
export interface SessionProxyInfo {
  /** "DataImpulse, Japan", or a custom proxy's address. */
  label: string;
  /** The country asked for, two letters. */
  country?: string;
  /** What the check through the proxy saw, when it is done. */
  exit?: { ip?: string; country?: string; error?: string };
}

/** Keeps WebRTC from sending UDP around the proxy, which would show the hub's own address. */
export const WEBRTC_PROXY_FLAG = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

export interface PageSnapshot {
  url: string;
  title: string;
  /** Full compact tree with refs (not capped). */
  tree: string;
  /** Model-facing text: URL, tab info, then title and capped tree inside the untrusted wrapper. */
  text: string;
  truncated: boolean;
  refCount: number;
  tabCount: number;
  activeTab: number;
  /** The tab's previous snapshot, for diffs. */
  previous?: { url: string; tree: string };
}

export interface ScreencastFrame {
  /** JPEG, base64 without the data: prefix. */
  data: string;
  /** Viewport size in CSS pixels. Input coordinates use this space. */
  width: number;
  height: number;
  url: string;
  /** Engine of the profile the frame comes from, for the takeover header. */
  engine: BrowserEngine;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface Screenshot {
  data: string;
  mediaType: 'image/jpeg';
  bytes: number;
  url: string;
  note?: string;
}

interface PageState {
  page: Page;
  refs: Map<string, Locator>;
  lastTree?: string;
  lastUrl?: string;
  cdp?: Promise<CDPSession>;
  input: InputState;
  /** The route that keeps a read-only session's page from sending anything (setReadOnly). */
  guard?: (route: Route) => Promise<void>;
  /** The main frame's navigation that has not committed yet (a form post loading), for settle(). */
  navigating?: Request;
}

interface Cast {
  onFrame: (frame: ScreencastFrame) => void;
  stopped: boolean;
  gen: number;
  cdp?: CDPSession;
}

interface SessionState {
  sessionId: string;
  profile: string;
  tabs: PageState[];
  active: number;
  casts: Set<Cast>;
  notes: string[];
}

interface ProfileState {
  name: string;
  engine: BrowserEngine;
  dir: string;
  /**
   * Set for a throwaway browser that goes out through the hub's proxy for one
   * session (useProxy): a fresh folder, deleted when it closes, so no saved
   * login of a profile ever goes through the proxy.
   */
  proxied?: { sessionId: string; label: string; country?: string; exit: Promise<ProbeResult> };
  /** The loopback relay in front of a SOCKS5 proxy that needs a login. */
  relay?: SocksRelay;
  context: BrowserContext;
  sessions: Map<string, SessionState>;
  /** Pages the browser opened on launch, handed to the first sessions. */
  spare: Page[];
  lastUsed: number;
  closing: boolean;
}

type SnapshotMode = 'ai' | 'internal' | 'role';
type RawCdp = { send(method: string, params?: object): Promise<any> };

const MAX_NOTES = 20;

function addNote(s: SessionState, text: string): void {
  s.notes.push(text);
  if (s.notes.length > MAX_NOTES) s.notes.splice(0, s.notes.length - MAX_NOTES);
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Requests a read-only page may still make: they fetch, they do not send. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Where Settings > Browser records the sites the owner signed in to, inside the profile's folder. */
const SITES_FILE = 'conclave-sites.json';

/** browser_login: which saved login, and how to ask the owner for a code. */
export interface LoginRequest {
  /** The saved login's site ("facebook.com"). Default: the site of the tab. */
  site?: string;
  /** The saved username, when the site has more than one login. */
  account?: string;
  /** Asks the owner for a sign-in code; undefined when they would rather sign in themselves. */
  askCode?: (q: { host: string; username: string }) => Promise<string | undefined>;
}

export interface LoginResult extends FillOutcome {
  host: string;
  profile: string;
}

/** Thrown by deleteProfile: the default profile, or one a session has open. */
export class ProfileInUse extends Error {
  constructor(
    message: string,
    readonly code: 'default' | 'open',
  ) {
    super(message);
    this.name = 'ProfileInUse';
  }
}

/** The forms of a secret that can show up in text: as is, JSON or YAML quoted, and in an address. */
function secretForms(s: string): string[] {
  const forms = new Set([s, JSON.stringify(s).slice(1, -1), s.replace(/'/g, "''"), encodeURIComponent(s), encodeURIComponent(s).replace(/%20/g, '+')]);
  return [...forms].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
}

/** A link on the page as browser_links reads it. */
export interface PageLink {
  url: string;
  text: string;
  image?: string;
  alt?: string;
}

export function validateProfileName(name: string): string {
  const n = (name ?? '').trim();
  if (!PROFILE_NAME.test(n) || n.includes('..')) {
    throw new Error(`Invalid profile name "${name}". Use letters, digits, dot, dash or underscore (max 64).`);
  }
  return n;
}

/** Add a scheme when missing and allow only http(s) and about:blank. */
export function normalizeUrl(input: string): string {
  let s = (input ?? '').trim();
  if (!s) throw new Error('URL is empty');
  if (s === 'about:blank') return s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^(about|data|file|javascript|chrome|blob|view-source):/i.test(s)) {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/i.test(s);
    s = (local ? 'http://' : 'https://') + s;
  }
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed, got ${u.protocol}`);
  }
  return u.toString();
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** Thrown by `bounded` when a browser step does not finish in time. */
export class BrowserStepTimeout extends Error {
  constructor(readonly step: string, ms: number) {
    super(`The browser did not finish ${step} in ${ms < 1_000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`}.`);
    this.name = 'BrowserStepTimeout';
  }
}

/**
 * Wait for one browser step, at most `ms`. CDP commands, page.close,
 * bringToFront and context.close have no timeout of their own, and a
 * renderer that stops answering leaves them pending for good; this names
 * the step instead.
 */
export function bounded<T>(step: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserStepTimeout(step, ms)), ms);
  });
  // a late rejection of the step itself is not an unhandled one
  p.catch(() => {});
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Bounds of the takeover steps (startScreencast, dispatchInput, closing). */
const CDP_MS = 10_000;
/** How long page.close() gets before the page's own close is tried (closePage). */
const CLOSE_FIRST_MS = 3_000;
const CLOSE_PAGE_MS = 5_000;
const CLOSE_CONTEXT_MS = 15_000;
const LAUNCH_MS = 60_000;
/** All the tries of one screenshot together. */
const SCREENSHOT_MS = 30_000;

/**
 * The takeover surface. Every argument and frame is plain data so it can run
 * behind RPC in a remote daemon; only the returned stop function is local.
 */
export interface BrowserTakeover {
  startScreencast(profile: string, sessionId: string, onFrame: (frame: ScreencastFrame) => void): Promise<() => void>;
  dispatchInput(profile: string, sessionId: string, ev: BrowserInputEvent): Promise<void>;
  profileFor(sessionId: string): string;
  listProfiles(): string[];
  /** Name, engine and label of a profile, for the takeover header ("CloakBrowser"). */
  profileInfo(profile: string): BrowserProfileInfo;
}

/**
 * Owns one persistent Chromium context per named profile (cookies and logins
 * survive restarts) and one set of tabs per (profile, session). Playwright is
 * loaded lazily so the engine runs without it.
 */
export class BrowserManager implements BrowserTakeover {
  private readonly config: ConfigStore;
  private readonly idleMs: number;
  private readonly defaultProfile: string;
  private readonly launcher?: Pick<BrowserType, 'launchPersistentContext'>;
  private profiles = new Map<string, ProfileState>();
  private launching = new Map<string, Promise<ProfileState>>();
  private sessionProfiles = new Map<string, string>();
  /** "profile\0session" keys whose pages were dropped by an idle close. */
  private reset = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private epoch = 0;
  private snapshotMode?: SnapshotMode;
  /** Sessions whose pages only read: watch runs (watches/rules.ts). */
  private readOnly = new Set<string>();
  /** Requests blocked per read-only session. */
  private blockedCount = new Map<string, number>();
  /** Sessions the owner asked to go out through the proxy, with the country. Nothing else uses the proxy. */
  private sessionProxy = new Map<string, { country?: string }>();
  /** The throwaway proxied browser of each such session. */
  private proxiedStates = new Map<string, ProfileState>();
  private readonly probe: (p: ProxyEntry) => Promise<ProbeResult>;
  private proxyRootCleaned = false;
  /** Saved logins (Settings > Browser): the list, and the passwords as encrypted hub secrets. */
  readonly logins: LoginVault;
  /** Per session, the saved passwords the hub filled there: no tool result shows them (hideSecrets). */
  private filled = new Map<string, Set<string>>();

  constructor(opts: BrowserManagerOptions) {
    this.config = opts.config;
    this.idleMs = opts.idleMs ?? IDLE_CLOSE_MS;
    this.defaultProfile = validateProfileName(opts.defaultProfile ?? DEFAULT_PROFILE);
    this.launcher = opts.launcher;
    this.probe = opts.proxyProbe ?? ((p) => probeProxy(p, { timeoutMs: 12_000 }));
    this.logins = new LoginVault(opts.config);
  }

  /** The profile sessions use when they never picked one. It cannot be deleted. */
  defaultProfileName(): string {
    return this.defaultProfile;
  }

  /** The hub's browser folder, where Install on the hub puts playwright-core and the browsers. */
  runtimeDir(): string {
    return browserDir(this.config.paths.home);
  }

  // -------------------------------------------------------------------------
  // Profiles and launch
  // -------------------------------------------------------------------------

  /** Folder that holds one sub-folder per profile. */
  profilesDir(): string {
    const custom = this.config.get().browser?.profileDir;
    if (custom) return resolve(custom.replace(/^~(?=$|[\\/])/, homedir()));
    return this.config.paths.browserProfile;
  }

  /** Profiles on disk, in browser.profiles, with a saved login, plus any open ones. */
  listProfiles(): string[] {
    const names = new Set<string>([this.defaultProfile, ...this.profiles.keys()]);
    for (const n of Object.keys(this.config.get().browser?.profiles ?? {})) if (PROFILE_NAME.test(n) && !n.includes('..')) names.add(n);
    for (const l of this.logins.list()) if (PROFILE_NAME.test(l.profile) && !l.profile.includes('..')) names.add(l.profile);
    try {
      const dir = this.profilesDir();
      for (const n of readdirSync(dir)) {
        if (PROFILE_NAME.test(n) && statSync(join(dir, n)).isDirectory()) names.add(n);
      }
    } catch {
      /* not created yet */
    }
    return [...names].sort();
  }

  profileFor(sessionId: string): string {
    return this.sessionProfiles.get(sessionId) ?? this.defaultProfile;
  }

  /** The engine a profile runs on: the open browser's, else what the config says, else the default for a new profile. */
  engineOf(profile: string): BrowserEngine {
    const name = validateProfileName(profile);
    return this.profiles.get(name)?.engine ?? this.engineToUse(name).engine;
  }

  /**
   * True when a browser has run in the profile: Chromium wrote its Local
   * State or Default folder there. A folder from a launch that failed (a
   * missing library, the sandbox as root) does not count, so such a profile
   * is still new.
   */
  hasRun(profile: string): boolean {
    const dir = join(this.profilesDir(), profile);
    return existsSync(join(dir, 'Local State')) || existsSync(join(dir, 'Default'));
  }

  /** The engine new profiles get: CloakBrowser when it is installed, else Chromium. */
  newProfileEngine(): BrowserEngine {
    return cloakInstalled(this.config.get().browser) ? 'cloak' : 'chromium';
  }

  /**
   * The engine for a launch. A profile with no engine set and no folder yet
   * is new: it gets CloakBrowser when that is installed. An old profile with
   * no engine set stays on Chromium, since a new engine is a new identity.
   */
  private engineToUse(name: string): { engine: BrowserEngine; fresh: boolean } {
    const cfg = this.config.get().browser;
    const set = cfg?.profiles?.[name]?.engine as unknown;
    if ((set === undefined || set === null || set === '') && !this.hasRun(name)) return { engine: this.newProfileEngine(), fresh: true };
    return { engine: engineFor(cfg, name), fresh: false };
  }

  profileInfo(profile: string): BrowserProfileInfo {
    const name = validateProfileName(profile);
    const engine = this.engineOf(name);
    return { name, engine, label: ENGINE_LABEL[engine], open: this.profiles.has(name) };
  }

  /** Point a session at another profile. Its tabs in the old profile stay open until idle close. */
  setProfile(sessionId: string, name: string): string {
    const n = validateProfileName(name);
    this.sessionProfiles.set(sessionId, n);
    return n;
  }

  /** Configured or detected browser binary, if any. The hub's browser folder is searched first. */
  executable(): string | undefined {
    const b = this.config.get().browser;
    return findBrowserExecutable({ explicit: b?.executablePath || undefined, headless: b?.headless !== false, extraDirs: [hubBrowsersPath(this.config.paths.home)] });
  }

  /** Cheap check (no launch): is playwright-core importable and a browser present? */
  async available(): Promise<{ ok: boolean; executable?: string; reason?: string }> {
    if (!this.launcher) {
      try {
        await loadPlaywright(this.runtimeDir());
      } catch {
        return { ok: false, reason: 'No browser is installed on this hub yet. The owner can install one in Settings, Browser, Engines.' };
      }
    }
    const exe = this.executable();
    const explicit = this.config.get().browser?.executablePath;
    if (explicit && !exe) return { ok: false, reason: `browser.executablePath not found: ${explicit}` };
    // Without a path Playwright may still find its own download.
    return { ok: true, executable: exe };
  }

  isOpen(profile: string): boolean {
    return this.profiles.has(profile);
  }

  private async ensureProfile(name: string): Promise<ProfileState> {
    const open = this.profiles.get(name);
    if (open && !open.closing) {
      open.lastUsed = Date.now();
      return open;
    }
    let p = this.launching.get(name);
    if (!p) {
      p = this.launch(name).finally(() => this.launching.delete(name));
      this.launching.set(name, p);
    }
    return p;
  }

  private async launch(name: string, proxied?: { sessionId: string; proxy: ResolvedProxy }): Promise<ProfileState> {
    const epoch = this.epoch;
    let chromium: Pick<BrowserType, 'launchPersistentContext'>;
    if (this.launcher) chromium = this.launcher;
    else {
      try {
        chromium = (await loadPlaywright(this.runtimeDir())).chromium;
      } catch {
        throw new Error('The browser is not installed on this hub. The owner can install it in Settings, Browser (Install on the hub).');
      }
    }
    const cfg = this.config.get().browser ?? { headless: true };
    // a proxied browser runs on the session's profile's engine, in a fresh folder of its own
    const { engine, fresh } = proxied ? { engine: this.engineToUse(name).engine, fresh: false } : this.engineToUse(name);
    // a new profile that gets CloakBrowser keeps it, written before its folder is made, so a failed first launch does not turn it into Chromium
    if (fresh && engine === 'cloak' && !this.config.get().browser?.profiles?.[name]?.engine) this.config.update({ browser: { profiles: { [name]: { engine: 'cloak' } } } } as Partial<ConclaveConfig>);
    const headless = cfg.headless !== false;
    type Options = NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>;
    // the binary first: nothing is made on disk for a launch that cannot happen
    let executablePath: string | undefined;
    if (engine === 'cloak') {
      // the owner's binary, checked against its pin before anything runs
      executablePath = cloakExecutable(cfg, name);
      await verifyCloakBinary(executablePath, cfg.cloak?.sha256);
    } else {
      executablePath = this.executable();
      if (cfg.executablePath && !executablePath) throw new Error(`browser.executablePath not found: ${cfg.executablePath}`);
    }
    const dir = proxied ? this.proxyDir() : join(this.profilesDir(), name);
    mkdirSync(dir, { recursive: true });
    let options: Options;
    /** What to try when there is no display for a headed browser, or old headless is gone. */
    let fallback: () => Options;
    if (engine === 'cloak') {
      // one seed per profile, kept with the cookie jar, so the jar keeps one identity (a proxied browser gets a new one)
      const seed = profileSeed(dir);
      options = cloakLaunchOptions({ executablePath: executablePath!, seed, headless });
      fallback = () => cloakLaunchOptions({ executablePath: executablePath!, seed, headless: true });
    } else {
      const base = { executablePath, viewport: DEFAULT_VIEWPORT };
      options = { ...base, headless };
      fallback = () => ({ ...base, headless: false, args: ['--headless=new'] });
    }

    // only a browser the owner asked to proxy has a proxy; a SOCKS5 login goes through a loopback relay
    const proxy = proxied?.proxy;
    let relay: SocksRelay | undefined;
    let proxyOption: Options['proxy'];
    const withProxy = (o: Options): Options => (proxyOption ? { ...o, proxy: proxyOption, args: [...(o.args ?? []), WEBRTC_PROXY_FLAG] } : o);

    // a sandbox Chromium cannot start is never retried without it
    const start = async (o: Options) => {
      try {
        // Playwright waits up to 3 minutes for a browser that does not start
        return await chromium.launchPersistentContext(dir, { timeout: LAUNCH_MS, ...withProxy(o) });
      } catch (err) {
        if (engine === 'cloak' && isSandboxFailure(errText(err))) throw new Error(CLOAK_SANDBOX_HELP);
        throw err;
      }
    };
    const open = async (): Promise<BrowserContext> => {
      try {
        return await start(options);
      } catch (err) {
        const msg = errText(err);
        const oldHeadlessGone = headless && /old headless|headless mode (has been|was) removed|chrome-headless-shell/i.test(msg);
        const noDisplay = !headless && /Missing X server|\$DISPLAY|cannot open display|without having a XServer/i.test(msg);
        if (oldHeadlessGone || noDisplay) {
          if (noDisplay) log.warn('no display for a headed browser, using new headless mode (takeover still works)');
          return start(fallback());
        }
        if (/ProcessSingleton|SingletonLock|profile (directory )?is (already )?in use/i.test(msg)) throw new Error(`Browser profile "${name}" is in use by another browser process (${dir}).`);
        if (engine === 'chromium' && !executablePath && /Executable doesn't exist|executable.*not found/i.test(msg)) throw new Error('No Chromium found. Set browser.executablePath or run: bunx playwright-core install chromium');
        // the agent can fix this itself when the owner installed the root helper
        if (isMissingLibrary(msg)) throw new Error(`${MISSING_LIBS_HELP} (${oneLine(/error while loading shared libraries:[^\n]*/i.exec(msg)?.[0] ?? msg).slice(0, 200)})`);
        throw err;
      }
    };
    let context: BrowserContext;
    try {
      if (proxy) {
        const e = proxy.entry;
        const host = e.host.includes(':') ? `[${e.host}]` : e.host;
        if (e.scheme === 'socks5' && e.username) {
          relay = await SocksRelay.start(e);
          proxyOption = { server: relay.url };
        } else if (e.scheme === 'socks5') proxyOption = { server: `socks5://${host}:${e.port}` };
        // Playwright answers an HTTP proxy's login itself, so the password stays off the command line
        else proxyOption = { server: `http://${host}:${e.port}`, ...(e.username ? { username: e.username, password: e.password ?? '' } : {}) };
      }
      context = await open();
      if (epoch !== this.epoch) {
        await context.close().catch(() => {});
        throw new Error('Browser was closed while starting');
      }
    } catch (err) {
      // a launch that did not happen leaves no relay and no proxied folder behind
      await relay?.close();
      if (proxied) rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(30_000);
    const state: ProfileState = {
      name,
      engine,
      dir,
      context,
      sessions: new Map(),
      spare: [...context.pages()],
      lastUsed: Date.now(),
      closing: false,
      ...(proxied ? { proxied: { sessionId: proxied.sessionId, label: proxied.proxy.label, country: proxied.proxy.country, exit: this.probe(proxied.proxy.entry) } } : {}),
      ...(relay ? { relay } : {}),
    };
    // the check runs alongside; a failed one is a line in the tool result, not a failed launch
    state.proxied?.exit.catch(() => undefined);
    context.on('close', () => this.dropProfile(state));
    if (proxied) this.proxiedStates.set(proxied.sessionId, state);
    else this.profiles.set(name, state);
    this.startTimer();
    // the proxy's label: no login, no password
    log.info(
      proxied
        ? `browser for session ${proxied.sessionId} started through the proxy (${proxied.proxy.label}, ${ENGINE_LABEL[engine]}${relay ? ', through a loopback relay' : ''})`
        : `browser profile "${name}" started (${ENGINE_LABEL[engine]}${executablePath ? `, ${executablePath}` : ''})`,
    );
    return state;
  }

  // -------------------------------------------------------------------------
  // Proxies
  // -------------------------------------------------------------------------

  /** A fresh folder for a proxied browser, under the hub's cache. Leftovers from a crash go the first time. */
  private proxyDir(): string {
    const root = join(this.config.paths.cache, 'browser-proxy');
    if (!this.proxyRootCleaned && !this.proxiedStates.size) {
      rmSync(root, { recursive: true, force: true });
      this.proxyRootCleaned = true;
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return mkdtempSync(join(root, 'session-'));
  }

  /**
   * Go out through the hub's proxy for this session, or stop. Only the
   * browser tools' proxy input calls this, which the agent passes when the
   * owner asks (or a watch's or routine's own instructions do). `true` takes
   * the provider's default country; a country name or code picks one; false
   * goes back to the hub's own address. The session then browses in a
   * throwaway browser with no saved logins; its pages in the profile stay
   * where they are for when the proxy is off again.
   */
  async useProxy(sessionId: string, want: boolean | string): Promise<SessionProxyInfo | undefined> {
    if (want === false) {
      this.sessionProxy.delete(sessionId);
      await this.closeProxied(sessionId);
      return undefined;
    }
    let country: string | undefined;
    if (typeof want === 'string' && want.trim() && !/^(true|yes|on|default|any)$/i.test(want.trim())) {
      country = countryCode(want);
      if (!country) throw new Error(`"${want}" is not a country the hub knows. Use a two-letter code such as JP, or a name such as Japan.`);
    }
    const cfg = this.config.get().browser?.proxy;
    // read the settings and secrets now, so a missing one is said at once
    const proxy = resolveProxy(cfg, (n) => this.config.secretValue(n), country);
    const want2 = { country: proxy.country ?? country ?? defaultCountry(cfg) };
    const had = this.sessionProxy.get(sessionId);
    this.sessionProxy.set(sessionId, want2);
    // another country is another browser
    if (had && had.country !== want2.country) await this.closeProxied(sessionId);
    return { label: proxy.label, ...(want2.country ? { country: want2.country } : {}) };
  }

  /** True when the session goes out through the proxy. */
  proxied(sessionId: string): boolean {
    return this.sessionProxy.has(sessionId);
  }

  /**
   * The session's proxy and what the check through it saw, waiting at most
   * `waitMs` for the check. undefined when the session uses no proxy.
   */
  async proxyInfo(sessionId: string, waitMs = 0): Promise<SessionProxyInfo | undefined> {
    const want = this.sessionProxy.get(sessionId);
    if (!want) return undefined;
    const st = this.proxiedStates.get(sessionId);
    const label = st?.proxied?.label ?? (want.country ? countryLabel(want.country) : 'the hub\'s proxy');
    const base: SessionProxyInfo = { label, ...(want.country ? { country: want.country } : {}) };
    if (!st?.proxied) return base;
    const late = new Promise<undefined>((done) => setTimeout(() => done(undefined), waitMs).unref?.());
    const r = await Promise.race([st.proxied.exit.catch((err: Error): ProbeResult => ({ ok: false, proxy: '', ms: 0, error: err.message })), late]);
    if (!r) return base;
    return { ...base, exit: r.ok ? { ...(r.ip ? { ip: r.ip } : {}), ...(r.country ? { country: r.country } : {}) } : { error: r.error ?? 'no answer' } };
  }

  /**
   * Settings > Browser's Test: through the proxy, for a country or the
   * default, the exit IP and country. Opens no browser.
   */
  async testProxy(country?: string): Promise<ProbeResult & { label: string }> {
    let cc: string | undefined;
    if (country?.trim()) {
      cc = countryCode(country);
      if (!cc) throw new Error(`"${country}" is not a country the hub knows. Use a two-letter code such as JP.`);
    }
    const proxy = resolveProxy(this.config.get().browser?.proxy, (n) => this.config.secretValue(n), cc);
    const r = await this.probe(proxy.entry);
    // the probe names the proxy with its user name, which for DataImpulse is the login: use the label
    return { ...r, proxy: proxy.label, label: proxy.label };
  }

  private async closeProxied(sessionId: string): Promise<void> {
    const st = this.proxiedStates.get(sessionId);
    if (st) await this.closeProfile(st);
  }

  private async ensureProxied(sessionId: string, want: { country?: string }): Promise<ProfileState> {
    const open = this.proxiedStates.get(sessionId);
    if (open && !open.closing) {
      open.lastUsed = Date.now();
      return open;
    }
    const key = `\0proxy\0${sessionId}`;
    let p = this.launching.get(key);
    if (!p) {
      const proxy = resolveProxy(this.config.get().browser?.proxy, (n) => this.config.secretValue(n), want.country);
      p = this.launch(this.profileFor(sessionId), { sessionId, proxy }).finally(() => this.launching.delete(key));
      this.launching.set(key, p);
    }
    return p;
  }

  /** Close a profile's browser if it is open: a new engine or proxy applies from its next launch. */
  async closeProfileBrowser(profile: string): Promise<void> {
    const p = this.profiles.get(validateProfileName(profile));
    if (p) await this.closeProfile(p);
  }

  private resetKey(p: ProfileState, sessionId: string): string {
    return p.proxied ? `\0proxy\0${sessionId}` : `${p.name}\0${sessionId}`;
  }

  private dropProfile(p: ProfileState): void {
    p.closing = true;
    if (p.relay) void p.relay.close();
    for (const s of p.sessions.values()) {
      for (const c of s.casts) c.stopped = true;
      s.casts.clear();
      if (s.tabs.length) this.reset.add(this.resetKey(p, s.sessionId));
    }
    if (p.proxied) {
      if (this.proxiedStates.get(p.proxied.sessionId) === p) this.proxiedStates.delete(p.proxied.sessionId);
    } else if (this.profiles.get(p.name) === p) this.profiles.delete(p.name);
  }

  private async closeProfile(p: ProfileState): Promise<void> {
    this.dropProfile(p);
    await bounded(`closing profile ${p.name}`, CLOSE_CONTEXT_MS, p.context.close()).catch((err) => log.warn(`closing profile ${p.name}: ${errText(err)}`));
    // a proxied browser's folder goes with it
    if (p.proxied) rmSync(p.dir, { recursive: true, force: true });
  }

  private startTimer(): void {
    if (this.timer) return;
    const every = Math.max(250, Math.min(60_000, Math.floor(this.idleMs / 2)));
    this.timer = setInterval(() => void this.sweep(), every);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const p of [...this.profiles.values(), ...this.proxiedStates.values()]) {
      const casting = [...p.sessions.values()].some((s) => s.casts.size > 0);
      if (!casting && now - p.lastUsed > this.idleMs) {
        log.info(`closing idle browser profile "${p.name}"`);
        await this.closeProfile(p);
      }
    }
    if (!this.profiles.size && !this.proxiedStates.size && !this.launching.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Sessions and tabs
  // -------------------------------------------------------------------------

  /** The browser a session's tabs are in. */
  private ownerOf(s: SessionState): ProfileState | undefined {
    const proxied = this.proxiedStates.get(s.sessionId);
    return proxied?.sessions.get(s.sessionId) === s ? proxied : this.profiles.get(s.profile);
  }

  /** The state a session's pages live in: its proxied browser while the proxy is on, else its profile's. */
  private stateNow(sessionId: string): ProfileState | undefined {
    return this.sessionProxy.has(sessionId) ? this.proxiedStates.get(sessionId) : this.profiles.get(this.profileFor(sessionId));
  }

  private async sessionState(sessionId: string, profile?: string): Promise<{ p: ProfileState; s: SessionState }> {
    const name = profile ? validateProfileName(profile) : this.profileFor(sessionId);
    // the proxy only for a session the owner asked it for, and only for that session's own profile
    const want = this.sessionProxy.get(sessionId);
    const p = want && name === this.profileFor(sessionId) ? await this.ensureProxied(sessionId, want) : await this.ensureProfile(name);
    let s = p.sessions.get(sessionId);
    if (!s) {
      s = { sessionId, profile: name, tabs: [], active: 0, casts: new Set(), notes: [] };
      p.sessions.set(sessionId, s);
      if (this.reset.delete(this.resetKey(p, sessionId))) {
        addNote(s, p.proxied ? 'The proxied browser had closed (idle or crash), so this session starts on a blank tab in a new one.' : 'The browser had closed (idle or crash), so this session starts on a blank tab. Logins in the profile are kept.');
      }
    }
    p.lastUsed = Date.now();
    return { p, s };
  }

  private async activeState(sessionId: string, profile?: string): Promise<PageState> {
    const { p, s } = await this.sessionState(sessionId, profile);
    if (!s.tabs.length) await this.openTab(p, s);
    s.active = Math.min(Math.max(0, s.active), s.tabs.length - 1);
    return s.tabs[s.active];
  }

  private async openTab(p: ProfileState, s: SessionState, existing?: Page): Promise<PageState> {
    let page = existing;
    while (!page && p.spare.length) {
      const candidate = p.spare.shift()!;
      if (!candidate.isClosed()) page = candidate;
    }
    if (!page) page = await bounded('opening a tab', CDP_MS * 2, p.context.newPage());
    const st: PageState = { page, refs: new Map(), input: new InputState() };
    // a read-only session's tab (and every popup it opens) is guarded before it loads anything more
    if (this.readOnly.has(s.sessionId)) await this.guardPage(s, st);
    s.tabs.push(st);
    s.active = s.tabs.length - 1;
    page.on('popup', (popup) => {
      if (p.closing || !p.sessions.has(s.sessionId)) return;
      void this.openTab(p, s, popup).then(() => addNote(s, `A new tab opened (index ${s.tabs.length - 1}) and is now active.`));
    });
    page.on('close', () => this.onPageClosed(s, st));
    // a navigation is in flight from its request until the main frame commits (or it fails)
    page.on('request', (r) => {
      try {
        if (r.isNavigationRequest() && r.frame() === page!.mainFrame()) st.navigating = r;
      } catch {
        /* a service worker's request has no frame */
      }
    });
    page.on('requestfailed', (r) => {
      if (r === st.navigating) st.navigating = undefined;
    });
    page.on('requestfinished', (r) => {
      // a 204 or a download never commits
      if (r === st.navigating) setTimeout(() => st.navigating === r && (st.navigating = undefined), 1_000);
    });
    page.on('framenavigated', (f) => {
      if (f === page!.mainFrame()) st.navigating = undefined;
    });
    page.on('crash', () => {
      addNote(s, 'A tab crashed and was closed.');
      void page!.close().catch(() => {});
    });
    page.on('dialog', (d) => {
      const accept = d.type() === 'beforeunload';
      addNote(s, `Dialog (${d.type()}) was ${accept ? 'accepted' : 'dismissed'}. Its text:\n${wrapUntrusted(page!.url(), oneLine(d.message(), 300))}`);
      (accept ? d.accept() : d.dismiss()).catch(() => {});
    });
    this.rebindCasts(s);
    return st;
  }

  private onPageClosed(s: SessionState, st: PageState): void {
    const i = s.tabs.indexOf(st);
    if (i < 0) return;
    s.tabs.splice(i, 1);
    if (s.active > i || s.active >= s.tabs.length) s.active = Math.max(0, s.active - 1);
    this.rebindCasts(s);
  }

  /** The session's active page, created on first use. */
  async page(sessionId: string, profile?: string): Promise<Page> {
    return (await this.activeState(sessionId, profile)).page;
  }

  async tabs(sessionId: string): Promise<TabInfo[]> {
    const { s } = await this.sessionState(sessionId);
    return Promise.all(
      s.tabs.map(async (t, index) => ({
        index,
        url: t.page.url(),
        title: await t.page.title().catch(() => ''),
        active: index === s.active,
      })),
    );
  }

  async newTab(sessionId: string, url?: string): Promise<TabInfo[]> {
    const target = url ? normalizeUrl(url) : undefined;
    const { p, s } = await this.sessionState(sessionId);
    const st = await this.openTab(p, s);
    if (target) await this.goto(st.page, target);
    return this.tabs(sessionId);
  }

  async selectTab(sessionId: string, index: number): Promise<TabInfo[]> {
    const { s } = await this.sessionState(sessionId);
    if (!Number.isInteger(index) || index < 0 || index >= s.tabs.length) {
      throw new Error(`No tab ${index}. Open tabs: ${s.tabs.length} (index from 0).`);
    }
    s.active = index;
    await bounded('showing the tab', CDP_MS, s.tabs[index].page.bringToFront()).catch(() => {});
    this.rebindCasts(s);
    return this.tabs(sessionId);
  }

  async closeTab(sessionId: string, index?: number): Promise<TabInfo[]> {
    const { s } = await this.sessionState(sessionId);
    const i = index ?? s.active;
    const st = s.tabs[i];
    if (!st) throw new Error(`No tab ${i}. Open tabs: ${s.tabs.length} (index from 0).`);
    await this.closePage(st.page).catch((err) => log.warn(errText(err)));
    this.onPageClosed(s, st);
    return this.tabs(sessionId);
  }

  // -------------------------------------------------------------------------
  // Read-only sessions (watch runs)
  // -------------------------------------------------------------------------

  /**
   * A read-only session's pages send nothing: every request but GET, HEAD
   * and OPTIONS is aborted, form posts and beacons included, and every
   * WebSocket is closed. Reading, following links and scrolling still work.
   * A note in the next tool result says what was blocked.
   */
  setReadOnly(sessionId: string, on: boolean): void {
    if (on) this.readOnly.add(sessionId);
    else {
      this.readOnly.delete(sessionId);
      this.blockedCount.delete(sessionId);
    }
    for (const p of [...this.profiles.values(), ...this.proxiedStates.values()]) {
      const s = p.sessions.get(sessionId);
      if (!s) continue;
      for (const st of s.tabs) void (on ? this.guardPage(s, st) : this.unguardPage(st)).catch((err) => log.warn(`read-only guard: ${errText(err)}`));
    }
  }

  isReadOnly(sessionId: string): boolean {
    return this.readOnly.has(sessionId);
  }

  /** Requests a read-only session tried to send and the browser blocked. */
  blocked(sessionId: string): number {
    return this.blockedCount.get(sessionId) ?? 0;
  }

  private async guardPage(s: SessionState, st: PageState): Promise<void> {
    if (st.guard) return;
    const guard = async (route: Route) => {
      const req = route.request();
      const method = req.method().toUpperCase();
      if (READ_METHODS.has(method)) return route.fallback();
      this.blockedCount.set(s.sessionId, (this.blockedCount.get(s.sessionId) ?? 0) + 1);
      let where = req.url();
      try {
        const u = new URL(where);
        where = `${u.host}${u.pathname}`;
      } catch {
        /* keep it */
      }
      addNote(s, `Blocked a ${method} request to ${oneLine(where, 120)}: this session only reads, so nothing was sent.`);
      await route.abort('blockedbyclient').catch(() => {});
    };
    st.guard = guard;
    await st.page.route('**/*', guard);
    // WebSockets carry chat and live updates both ways: none in a read-only session
    await st.page.routeWebSocket(/.*/, (ws) => {
      this.blockedCount.set(s.sessionId, (this.blockedCount.get(s.sessionId) ?? 0) + 1);
      addNote(s, 'Blocked a WebSocket: this session only reads.');
      void ws.close({ code: 1008, reason: 'read only' }).catch(() => {});
    });
  }

  private async unguardPage(st: PageState): Promise<void> {
    const g = st.guard;
    if (!g) return;
    st.guard = undefined;
    if (!st.page.isClosed()) await st.page.unroute('**/*', g).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Sites signed in to (Settings > Browser)
  // -------------------------------------------------------------------------

  /** The sites the owner signed in to with this profile, newest first. */
  signIns(profile: string): Array<{ host: string; at: number }> {
    const name = validateProfileName(profile);
    try {
      const raw = JSON.parse(readFileSync(join(this.profilesDir(), name, SITES_FILE), 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((x): x is { host: string; at: number } => !!x && typeof x.host === 'string' && typeof x.at === 'number')
        .sort((a, b) => b.at - a.at)
        .slice(0, 50);
    } catch {
      return [];
    }
  }

  /** Remember that the owner signed in to a site with this profile. */
  recordSignIn(profile: string, host: string): void {
    const name = validateProfileName(profile);
    const h = host.trim().toLowerCase().replace(/^www\./, '');
    if (!/^[a-z0-9.-]{1,253}$/.test(h)) throw new Error(`"${host}" is not a site name`);
    const dir = join(this.profilesDir(), name);
    mkdirSync(dir, { recursive: true });
    const list = [{ host: h, at: Date.now() }, ...this.signIns(name).filter((x) => x.host !== h)].slice(0, 50);
    writeFileSync(join(dir, SITES_FILE), JSON.stringify(list, null, 2));
  }

  /** The profile the owner signed in to this host with, or saved a login for it in, newest first. */
  profileSignedInTo(host: string): string | undefined {
    const h = host.toLowerCase().replace(/^www\./, '');
    const same = (x: string) => h === x || h.endsWith(`.${x}`) || x.endsWith(`.${h}`);
    let best: { name: string; at: number } | undefined;
    for (const name of this.listProfiles()) {
      for (const site of this.signIns(name)) {
        if (same(site.host) && (!best || site.at > best.at)) best = { name, at: site.at };
      }
    }
    for (const l of this.logins.list()) {
      const at = l.lastUsed ?? l.updatedAt;
      if (same(siteHost(l.origin)) && (!best || at > best.at)) best = { name: l.profile, at };
    }
    return best?.name;
  }

  /** Stop listing a site as signed in for this profile. */
  private dropSignIn(profile: string, host: string): void {
    const h = host.toLowerCase().replace(/^www\./, '');
    const dir = join(this.profilesDir(), profile);
    const list = this.signIns(profile);
    const left = list.filter((x) => x.host !== h && !x.host.endsWith(`.${h}`));
    if (left.length !== list.length && existsSync(dir)) writeFileSync(join(dir, SITES_FILE), JSON.stringify(left, null, 2));
  }

  /**
   * Forget a site in a profile: its cookies (the site's own and those of its
   * parent domain that it gets) and what it stored (local storage,
   * IndexedDB, caches, service workers), then its line in the sites list.
   * Starts the profile's browser when it is closed, and closes it again
   * after. A saved login stays: that is Delete login.
   */
  async forgetSite(profile: string, hostRaw: string): Promise<{ cookies: number }> {
    const name = validateProfileName(profile);
    let host: string;
    try {
      host = new URL(siteOrigin(hostRaw)).hostname.toLowerCase().replace(/^www\./, '');
    } catch (err) {
      throw new Error(errText(err));
    }
    // a profile no browser ever ran in has no cookies
    if (!this.profiles.has(name) && !this.hasRun(name)) {
      this.dropSignIn(name, host);
      return { cookies: 0 };
    }
    const wasOpen = this.profiles.has(name);
    const p = await this.ensureProfile(name);
    let cookies = 0;
    try {
      const applies = (domain: string) => {
        const d = domain.replace(/^\./, '').toLowerCase();
        return d === host || d.endsWith(`.${host}`) || (d.includes('.') && host.endsWith(`.${d}`));
      };
      const all = await bounded('reading the cookies', CDP_MS, p.context.cookies());
      const hit = all.filter((c) => applies(c.domain));
      for (const domain of new Set(hit.map((c) => c.domain))) await bounded('clearing the cookies', CDP_MS, p.context.clearCookies({ domain }));
      cookies = hit.length;
      // what the site stored, for each origin it may have used
      const hosts = new Set([host, `www.${host}`, ...hit.map((c) => c.domain.replace(/^\./, '')).filter((d) => d === host || d.endsWith(`.${host}`))]);
      let page = p.context.pages().find((x) => !x.isClosed());
      const made = !page;
      page ??= await bounded('opening a tab', CDP_MS * 2, p.context.newPage());
      const cdp = await bounded('attaching to the tab', CDP_MS, p.context.newCDPSession(page));
      try {
        for (const h of hosts) {
          for (const scheme of ['https', 'http']) {
            await bounded('clearing site data', CDP_MS, (cdp as unknown as RawCdp).send('Storage.clearDataForOrigin', { origin: `${scheme}://${h}`, storageTypes: 'all' })).catch(() => {});
          }
        }
      } finally {
        await bounded('detaching', CDP_MS, cdp.detach()).catch(() => {});
        if (made) await this.closePage(page).catch(() => {});
      }
    } finally {
      if (!wasOpen && ![...p.sessions.values()].some((s) => s.tabs.length)) await this.closeProfile(p);
    }
    this.dropSignIn(name, host);
    log.info(`forgot ${host} in browser profile "${name}" (${cookies} cookies)`);
    return { cookies };
  }

  /** Sessions with tabs open in a profile right now. */
  openIn(profile: string): string[] {
    const p = this.profiles.get(profile);
    return p ? [...p.sessions.values()].filter((s) => s.tabs.length).map((s) => s.sessionId) : [];
  }

  /**
   * Delete a profile: its browser (closed first), its folder with every
   * cookie in it, its entry in browser.profiles and its saved logins.
   * Sessions that used it go back to the default profile. The default
   * profile cannot be deleted, and one a session has tabs open in is
   * refused unless `close` says to close them.
   */
  async deleteProfile(profile: string, opts: { close?: boolean } = {}): Promise<{ logins: number }> {
    const name = validateProfileName(profile);
    if (name === this.defaultProfile) throw new ProfileInUse(`The ${name} profile cannot be deleted. Sessions use it when they pick no other.`, 'default');
    const open = this.openIn(name);
    if ((open.length || this.launching.has(name)) && !opts.close) {
      const where = open.length > 1 ? `open in ${open.length} sessions` : open.length ? 'open in a session' : 'starting';
      throw new ProfileInUse(`Profile ${name} is ${where} now. Close it first, or delete it with close.`, 'open');
    }
    await this.launching.get(name)?.catch(() => undefined);
    const p = this.profiles.get(name);
    if (p) await this.closeProfile(p);
    for (const [sid, prof] of [...this.sessionProfiles]) if (prof === name) this.sessionProfiles.delete(sid);
    for (const key of [...this.reset]) if (key.startsWith(`${name}\0`)) this.reset.delete(key);
    // the name is checked (no separators, no ..), and the folder must sit right under the profiles folder
    const root = resolve(this.profilesDir());
    const dir = resolve(root, name);
    if (dirname(dir) === root) rmSync(dir, { recursive: true, force: true });
    const user = structuredClone(this.config.getUser()) as Partial<ConclaveConfig> & { browser?: { profiles?: Record<string, unknown> } };
    if (user.browser?.profiles && name in user.browser.profiles) {
      delete user.browser.profiles[name];
      if (!Object.keys(user.browser.profiles).length) delete user.browser.profiles;
      this.config.replace(user as Partial<ConclaveConfig>);
    }
    const logins = this.logins.removeProfile(name);
    log.info(`deleted browser profile "${name}"`);
    return { logins };
  }

  // -------------------------------------------------------------------------
  // Saved logins (browser_login)
  // -------------------------------------------------------------------------

  /** The saved login a browser_login call means, or a sentence on why none fits. */
  private pickLogin(profile: string, pageUrl: string, req: LoginRequest): SavedLogin {
    const all = this.logins.list();
    let want: { origin: string; host: string } | undefined;
    if (req.site?.trim()) {
      try {
        const origin = siteOrigin(req.site);
        want = { origin, host: siteHost(origin) };
      } catch (err) {
        throw new LoginRefused(errText(err));
      }
    }
    // a site named by its address means that origin; by its name, any login of that name
    const exact = want ? all.filter((l) => l.origin === want!.origin || originMatches(l, want!.origin)) : [];
    const fits = want ? (exact.length ? exact : all.filter((l) => siteHost(l.origin) === want!.host)) : all.filter((l) => originMatches(l, pageUrl));
    const where = want?.host ?? (() => {
      try {
        return new URL(pageUrl).hostname.replace(/^www\./, '') || 'this site';
      } catch {
        return 'this site';
      }
    })();
    if (!fits.length) throw new LoginRefused(`No saved login for ${where}. The owner can save one in Settings, Browser, Sites and logins, or sign in once there. Never type a password yourself.`);
    let mine = fits.filter((l) => l.profile === profile);
    if (!mine.length) {
      const others = [...new Set(fits.map((l) => l.profile))].sort();
      throw new LoginRefused(`The saved login for ${where} is in profile ${others.join(' and ')}, and this session uses ${profile}. Switch with browser_profile first.`);
    }
    if (req.account?.trim()) {
      const a = req.account.trim().toLowerCase();
      mine = mine.filter((l) => l.username.toLowerCase() === a);
      if (!mine.length) throw new LoginRefused(`No saved login for ${where} with that account in profile ${profile}.`);
    }
    if (mine.length > 1) throw new LoginRefused(`Profile ${profile} has ${mine.length} saved logins for ${where}: ${mine.map((l) => l.username).join(', ')}. Name one with account.`);
    return mine[0];
  }

  /**
   * Log in on the session's tab with a saved login (browser_login): the hub
   * fills the username, password and any code itself and submits. Only on
   * the saved site (autofill.ts), never in a read-only or proxied session.
   * The password never leaves this call; tool results hide it (hideSecrets).
   */
  async login(sessionId: string, req: LoginRequest = {}): Promise<LoginResult> {
    if (this.readOnly.has(sessionId)) throw new LoginRefused('This session only reads, so it cannot log in.');
    if (this.sessionProxy.has(sessionId)) throw new LoginRefused('This session browses through the proxy, in a browser with no saved logins. Call browser_navigate with proxy false first.');
    const profile = this.profileFor(sessionId);
    const st = await this.activeState(sessionId);
    const login = this.pickLogin(profile, st.page.url(), req);
    const password = this.logins.secret(login.id, 'password');
    const totp = login.totp ? this.logins.secret(login.id, 'totp') : undefined;
    let set = this.filled.get(sessionId);
    if (!set) this.filled.set(sessionId, (set = new Set()));
    set.add(password);
    const outcome = await fillSavedLogin({ page: st.page, login, password, totp, settle: (fn) => this.withSettle(sessionId, () => fn()), askCode: req.askCode });
    if (outcome.filled.length) this.logins.touch(login.id);
    if (outcome.submitted && !outcome.stillAsking && outcome.code !== 'declined') {
      try {
        this.recordSignIn(profile, new URL(login.origin).hostname);
      } catch {
        /* an address that is not a site name */
      }
    }
    return { ...outcome, host: siteHost(login.origin), profile };
  }

  /** Replace every saved password the hub filled in this session with a placeholder. */
  hideSecrets(sessionId: string, text: string): string {
    const set = this.filled.get(sessionId);
    if (!set?.size || !text) return text;
    let out = text;
    for (const s of set) for (const form of secretForms(s)) if (out.includes(form)) out = out.split(form).join('[saved password]');
    return out;
  }

  /**
   * The links on the session's page with their text and the first picture in
   * each: the listings of a search page in one read. Hub code, not page code
   * the model wrote, so it runs in a read-only session too.
   */
  async links(sessionId: string, opts: { match?: string; limit?: number } = {}): Promise<{ url: string; links: PageLink[]; total: number }> {
    const page = await this.page(sessionId);
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 60)));
    const match = (opts.match ?? '').trim().slice(0, 200);
    const found = await page.evaluate(
      ({ match, limit }) => {
        const seen = new Set<string>();
        const out: Array<{ url: string; text: string; image?: string; alt?: string }> = [];
        let total = 0;
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = (a as HTMLAnchorElement).href;
          if (!/^https?:/i.test(href) || (match && !href.includes(match)) || seen.has(href)) continue;
          seen.add(href);
          total++;
          if (out.length >= limit) continue;
          const text = ((a as HTMLElement).innerText || a.textContent || '')
            .split(/\n+/)
            .map((t) => t.trim())
            .filter(Boolean)
            .join(' | ')
            .slice(0, 300);
          const img = a.querySelector('img') as HTMLImageElement | null;
          const bg = img ? undefined : (a.querySelector('[style*="background-image"]') as HTMLElement | null)?.style.backgroundImage.match(/url\(["']?([^"')]+)/)?.[1];
          const src = img?.currentSrc || img?.src || bg;
          out.push({ url: href, text, ...(src && /^https?:/i.test(src) ? { image: src } : {}), ...(img?.alt ? { alt: img.alt.slice(0, 200) } : {}) });
        }
        return { links: out, total };
      },
      { match, limit },
    );
    return { url: page.url(), ...found };
  }

  /** Close every tab a session owns, in every profile, and its proxied browser. */
  async closeSession(sessionId: string): Promise<void> {
    this.sessionProxy.delete(sessionId);
    this.filled.delete(sessionId);
    await this.closeProxied(sessionId);
    for (const p of this.profiles.values()) {
      const s = p.sessions.get(sessionId);
      if (!s) continue;
      for (const c of s.casts) c.stopped = true;
      s.casts.clear();
      p.sessions.delete(sessionId);
      await Promise.all(s.tabs.map((t) => this.closePage(t.page).catch((err) => log.warn(errText(err)))));
    }
    this.sessionProfiles.delete(sessionId);
  }

  /**
   * Close one tab. Chrome 15x can leave a tab half closed when it is closed
   * while a form post is loading: page.close() (Target.closeTarget) then
   * never finishes, and closing it again the same way does nothing. The
   * page's own close (Page.close, what runBeforeUnload uses) still works,
   * so that is the second try.
   */
  private async closePage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const closed = new Promise<void>((resolve) => page.once('close', () => resolve()));
    try {
      await bounded('closing a tab', CLOSE_FIRST_MS, page.close());
      return;
    } catch (err) {
      if (page.isClosed()) return;
      if (!(err instanceof BrowserStepTimeout)) throw err;
    }
    log.warn(`a tab did not close in ${CLOSE_FIRST_MS / 1000}s; closing it from the page`);
    // with runBeforeUnload Playwright sends Page.close and does not wait; the close event says it is gone
    await bounded('closing a tab from the page', CDP_MS, page.close({ runBeforeUnload: true })).catch(() => {});
    await bounded('closing a tab', CLOSE_PAGE_MS, closed);
  }

  /**
   * Wait, at most `ms`, for the session's tab to finish a navigation in
   * flight (a login form's post) and load what it got. Closing a tab before
   * then can drop the login cookie with the response, and trips the Chrome
   * close bug closePage works around. Opens nothing.
   */
  async settle(sessionId: string, profile?: string, ms = 10_000): Promise<void> {
    const name = profile ? validateProfileName(profile) : this.profileFor(sessionId);
    const owner = this.sessionProxy.has(sessionId) && name === this.profileFor(sessionId) ? this.proxiedStates.get(sessionId) : this.profiles.get(name);
    const s = owner?.sessions.get(sessionId);
    const st = s?.tabs[s.active];
    if (!st || st.page.isClosed()) return;
    const deadline = Date.now() + ms;
    while (st.navigating && Date.now() < deadline && !st.page.isClosed()) await sleep(50);
    if (st.page.isClosed() || Date.now() >= deadline) return;
    await st.page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
  }

  /** Close every browser. The manager relaunches on next use. */
  async close(): Promise<void> {
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = [...this.launching.values()].map((p) => p.catch(() => undefined));
    await Promise.all([...this.profiles.values(), ...this.proxiedStates.values()].map((p) => this.closeProfile(p)));
    await Promise.all(pending);
    this.reset.clear();
  }

  /** Notes about dialogs, popups and resets since the last call. */
  drainNotes(sessionId: string): string[] {
    const s = this.stateNow(sessionId)?.sessions.get(sessionId);
    if (!s) return [];
    return s.notes.splice(0);
  }

  // -------------------------------------------------------------------------
  // Navigation, snapshots, refs
  // -------------------------------------------------------------------------

  private async goto(page: Page, url: string): Promise<number | undefined> {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
    return resp?.status();
  }

  async navigate(sessionId: string, url: string): Promise<{ url: string; status?: number }> {
    const target = normalizeUrl(url);
    const st = await this.activeState(sessionId);
    const status = await this.goto(st.page, target);
    return { url: st.page.url(), status };
  }

  /**
   * Run an action on the active page, then wait briefly for the requests and
   * navigation it caused to finish.
   */
  async withSettle<T>(sessionId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = (await this.activeState(sessionId)).page;
    const pending = new Set<Request>();
    let navigated = false;
    const onReq = (r: Request) => {
      const t = r.resourceType();
      if (t === 'document' || t === 'fetch' || t === 'xhr') pending.add(r);
    };
    const onDone = (r: Request) => void pending.delete(r);
    const onNav = (f: Frame) => {
      if (f === page.mainFrame()) navigated = true;
    };
    page.on('request', onReq);
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);
    page.on('framenavigated', onNav);
    try {
      const out = await fn(page);
      await sleep(150);
      const deadline = Date.now() + 4_000;
      while (pending.size && Date.now() < deadline && !page.isClosed()) await sleep(50);
      if ((navigated || pending.size) && !page.isClosed()) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      }
      return out;
    } finally {
      page.off('request', onReq);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
      page.off('framenavigated', onNav);
    }
  }

  private detectMode(page: Page): SnapshotMode {
    if (this.snapshotMode) return this.snapshotMode;
    const pg = page as unknown as Record<string, unknown>;
    if (typeof pg.ariaSnapshot === 'function' && typeof pg.getByRef === 'function') this.snapshotMode = 'ai';
    else if (typeof pg._snapshotForAI === 'function') this.snapshotMode = 'internal';
    else this.snapshotMode = 'role';
    return this.snapshotMode;
  }

  /** Raw tree plus a ref -> locator resolver for the current page. */
  private async captureTree(page: Page): Promise<{ tree: string; locate: (ref: string) => Locator }> {
    const mode = this.detectMode(page);
    const pg = page as any;
    if (mode === 'ai') {
      const tree: string = await pg.ariaSnapshot({ mode: 'ai' });
      return { tree, locate: (ref) => pg.getByRef(ref) as Locator };
    }
    if (mode === 'internal') {
      const r = await pg._snapshotForAI();
      const tree: string = typeof r === 'string' ? r : (r?.full ?? '');
      return { tree, locate: (ref) => page.locator(`aria-ref=${ref}`) };
    }
    const plain = await page.locator('body').ariaSnapshot();
    const { tree, refs } = annotateRoleRefs(plain);
    const byRef = new Map(refs.map((r) => [r.ref, r]));
    return {
      tree,
      locate: (ref) => {
        const r = byRef.get(ref)!;
        const loc = r.name !== undefined ? page.getByRole(r.role as any, { name: r.name, exact: true }) : page.getByRole(r.role as any);
        return loc.nth(r.nth);
      },
    };
  }

  /** Compact text tree of the active page with [ref=eN] markers. Rebuilds the ref map. */
  async snapshot(sessionId: string): Promise<PageSnapshot> {
    const { s } = await this.sessionState(sessionId);
    const st = await this.activeState(sessionId);
    const page = st.page;
    let captured: Awaited<ReturnType<BrowserManager['captureTree']>>;
    try {
      captured = await this.captureTree(page);
    } catch (err) {
      // Usually a navigation raced the snapshot. Wait for the new document once.
      if (page.isClosed()) throw new Error('The tab was closed.');
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      try {
        captured = await this.captureTree(page);
      } catch {
        throw err;
      }
    }
    const tree = compactTree(captured.tree);
    const refs = new Map<string, Locator>();
    for (const ref of extractRefs(tree)) refs.set(ref, captured.locate(ref));
    st.refs = refs;

    const url = page.url();
    const title = await page.title().catch(() => '');
    const previous = st.lastTree !== undefined ? { url: st.lastUrl ?? '', tree: st.lastTree } : undefined;
    st.lastTree = tree;
    st.lastUrl = url;

    const capped = capLines(tree, SNAPSHOT_MAX_CHARS);
    const lines = [`Page: ${url}`];
    if (s.tabs.length > 1) lines.push(`Tab ${s.active} of ${s.tabs.length} open tabs (index from 0, see browser_tabs).`);
    lines.push(wrapUntrusted(url, `Title: ${title}\n${capped.text || '(empty page)'}`));
    if (capped.truncated) {
      lines.push(`[Snapshot truncated at ${SNAPSHOT_MAX_CHARS} chars, ${capped.omittedLines} more lines not shown. Use browser_evaluate to read a specific part.]`);
    }
    return {
      url,
      title,
      tree,
      text: lines.join('\n'),
      truncated: capped.truncated,
      refCount: refs.size,
      tabCount: s.tabs.length,
      activeTab: s.active,
      previous,
    };
  }

  /** Locator for a ref from the active tab's latest snapshot. */
  async locator(sessionId: string, ref: string): Promise<Locator> {
    const st = await this.activeState(sessionId);
    const r = normalizeRef(ref);
    const loc = st.refs.get(r);
    if (loc) return loc;
    if (!st.refs.size) throw new Error('No snapshot for this tab yet. Call browser_snapshot first.');
    throw new Error(`Unknown ref "${r}". Refs come from the latest snapshot of the active tab; take a new browser_snapshot.`);
  }

  // -------------------------------------------------------------------------
  // Screenshots
  // -------------------------------------------------------------------------

  async screenshot(sessionId: string, opts: { fullPage?: boolean; maxBytes?: number } = {}): Promise<Screenshot> {
    const page = (await this.activeState(sessionId)).page;
    const maxBytes = opts.maxBytes ?? SCREENSHOT_MAX_BYTES;
    // each try has its own timeout; all of them together stop here
    const deadline = Date.now() + SCREENSHOT_MS;
    let fullPage = !!opts.fullPage;
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    const notes: string[] = [];
    if (fullPage) {
      const dims = await bounded(
        'measuring the page',
        CDP_MS,
        page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })),
      ).catch(() => undefined);
      if (dims && dims.h > MAX_SHOT_HEIGHT) {
        clip = { x: 0, y: 0, width: dims.w, height: MAX_SHOT_HEIGHT };
        notes.push(`Page is ${dims.h}px tall; the image stops at ${MAX_SHOT_HEIGHT}px.`);
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const quality of [70, 50, 35, 20]) {
        const left = deadline - Date.now();
        if (left < 1_000) throw new BrowserStepTimeout('the screenshot', SCREENSHOT_MS);
        const shot = page.screenshot({ type: 'jpeg', quality, fullPage, clip, scale: 'css', timeout: Math.min(15_000, left) });
        const buf = await bounded('the screenshot', Math.min(15_000, left) + 2_000, shot);
        if (buf.length <= maxBytes) {
          return {
            data: Buffer.from(buf).toString('base64'),
            mediaType: 'image/jpeg',
            bytes: buf.length,
            url: page.url(),
            note: notes.length ? notes.join(' ') : undefined,
          };
        }
      }
      if (!fullPage) break;
      fullPage = false;
      clip = undefined;
      notes.length = 0;
      notes.push('Full page image was too large; showing the viewport.');
    }
    throw new Error(`Screenshot is larger than ${maxBytes} bytes even at low quality.`);
  }

  // -------------------------------------------------------------------------
  // Takeover: screencast and input
  // -------------------------------------------------------------------------

  /**
   * Stream the session's active tab as JPEG frames. Follows tab switches.
   * Returns a stop function. While a screencast runs the profile is not idle-closed.
   */
  async startScreencast(profile: string, sessionId: string, onFrame: (frame: ScreencastFrame) => void): Promise<() => void> {
    const name = validateProfileName(profile);
    await this.activeState(sessionId, name);
    const { s } = await this.sessionState(sessionId, name);
    const cast: Cast = { onFrame, stopped: false, gen: 0 };
    s.casts.add(cast);
    await this.bindCast(s, cast);
    return () => {
      if (cast.stopped) return;
      cast.stopped = true;
      s.casts.delete(cast);
      void this.unbindCast(cast);
      const p = this.ownerOf(s);
      if (p) p.lastUsed = Date.now();
    };
  }

  private rebindCasts(s: SessionState): void {
    for (const c of s.casts) void this.bindCast(s, c).catch((err) => log.warn(`screencast rebind: ${errText(err)}`));
  }

  private async unbindCast(cast: Cast): Promise<void> {
    const cdp = cast.cdp;
    cast.cdp = undefined;
    if (!cdp) return;
    await bounded('Page.stopScreencast', CDP_MS, (cdp as unknown as RawCdp).send('Page.stopScreencast')).catch(() => {});
    await bounded('detaching the screencast', CDP_MS, cdp.detach()).catch(() => {});
  }

  private async bindCast(s: SessionState, cast: Cast): Promise<void> {
    const gen = ++cast.gen;
    await this.unbindCast(cast);
    const st = s.tabs[s.active];
    if (cast.stopped || !st || st.page.isClosed()) return;
    const page = st.page;
    const cdp = await bounded('attaching to the tab', CDP_MS, page.context().newCDPSession(page));
    if (cast.stopped || gen !== cast.gen) {
      await bounded('detaching the screencast', CDP_MS, cdp.detach()).catch(() => {});
      return;
    }
    cast.cdp = cdp;
    const raw = cdp as unknown as RawCdp;
    cdp.on('Page.screencastFrame', (f) => {
      raw.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (cast.stopped || cast.cdp !== cdp) return;
      const p = this.ownerOf(s);
      if (p) p.lastUsed = Date.now();
      const vp = page.viewportSize();
      try {
        cast.onFrame({
          data: f.data,
          width: Math.round(f.metadata.deviceWidth || vp?.width || 0),
          height: Math.round(f.metadata.deviceHeight || vp?.height || 0),
          url: page.url(),
          engine: p?.engine ?? 'chromium',
        });
      } catch (err) {
        log.warn(`screencast listener threw: ${errText(err)}`);
      }
    });
    await bounded('showing the tab', CDP_MS, page.bringToFront()).catch(() => {});
    await bounded('Page.startScreencast', CDP_MS, raw.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 }));
  }

  private cdpFor(st: PageState): Promise<CDPSession> {
    if (!st.cdp) {
      const cdp = bounded('attaching to the tab', CDP_MS, st.page.context().newCDPSession(st.page));
      st.cdp = cdp;
      cdp.catch(() => {
        if (st.cdp === cdp) st.cdp = undefined;
      });
    }
    return st.cdp;
  }

  /** Forget a tab's input session after a step on it timed out; the next input attaches a new one. */
  private dropCdp(st: PageState): void {
    const old = st.cdp;
    st.cdp = undefined;
    void old?.then((c) => c.detach()).catch(() => {});
  }

  /** Apply one viewer input event to the session's active tab in `profile`. */
  async dispatchInput(profile: string, sessionId: string, ev: BrowserInputEvent): Promise<void> {
    const bad = validateInputEvent(ev);
    if (bad) throw new Error(`Invalid input event: ${bad}`);
    const st = await this.activeState(sessionId, validateProfileName(profile));
    if (ev.type === 'navigate') {
      await this.goto(st.page, normalizeUrl(ev.url));
      return;
    }
    if (ev.type === 'resize') {
      const clamp = (n: number) => Math.round(Math.min(3840, Math.max(240, n)));
      await bounded('resizing the page', CDP_MS, st.page.setViewportSize({ width: clamp(ev.width), height: clamp(ev.height) }));
      return;
    }
    const cdp = (await this.cdpFor(st)) as unknown as RawCdp;
    for (const cmd of st.input.toCdp(ev)) {
      try {
        // the renderer answers an input event once it handled it; one that stopped answering would hold this for good
        await bounded(cmd.method, CDP_MS, cdp.send(cmd.method, cmd.params));
      } catch (err) {
        if (err instanceof BrowserStepTimeout) this.dropCdp(st);
        throw err;
      }
    }
  }
}
