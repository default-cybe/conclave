/**
 * Settings > Browser: the hub's browser profiles, the sites the owner
 * signed in to with each, and "Sign in to a site": a remote view of a
 * profile's page. The app shows the page's latest frame and sends clicks,
 * keys and text back, so the owner signs in once on the hub (Facebook for a
 * Marketplace watch) and the cookies stay in that profile for the watches.
 *
 *   GET    /api/browser                       BrowserStatusDto
 *   POST   /api/browser/signin                { profile, url } -> SignInViewDto
 *   GET    /api/browser/signin/:id/frame      ?after=seq -> SignInFrameDto, or 204 when nothing newer
 *   POST   /api/browser/signin/:id/input      { events: BrowserInputEvent[] }
 *   POST   /api/browser/signin/:id/done       records the sites, closes the view
 *   DELETE /api/browser/signin/:id            closes the view without recording
 *
 * The view is not read-only: signing in posts a form. Nothing typed is
 * logged or audited; the audit says which profile signed in where.
 *
 * The live view of a chat session's browser (the line above the composer,
 * features/chat/BrowserLive.tsx): the same frames, of the tab that session's
 * browser tools use, and nothing else. Input is taken only while the owner
 * holds the browser (Take over); the session's browser tool calls then wait
 * until Give back (BrowserManager.waitForOwner).
 *
 *   GET    /api/browser/sessions/:session          BrowserLiveDto, opens nothing
 *   GET    /api/browser/sessions/:session/frame    ?after=seq -> SignInFrameDto, 204, or 404 with no tab open
 *   POST   /api/browser/sessions/:session/input    { events } -> 409 unless the owner holds it
 *   POST   /api/browser/sessions/:session/control  { take: boolean } -> BrowserLiveDto
 *   DELETE /api/browser/sessions/:session/frame    stops the frames, gives the browser back
 *
 * Engines, the install and proxies (browser/setup.ts, browser/proxy-*.ts):
 *
 *   POST   /api/browser/setup                 { target, steps } -> BrowserSetupResult: Install on the hub
 *   POST   /api/browser/libs                  { steps } -> BrowserLibsResult: Install system libraries, through
 *                                             the root helper (sudo /usr/local/libexec/conclave-root-helper browser-deps)
 *   PUT    /api/browser/profiles/:name        { engine } -> BrowserStatusDto
 *   PUT    /api/browser/proxy                 BrowserProxyUpdate -> BrowserStatusDto
 *   POST   /api/browser/proxy/test            { country? } -> BrowserProxyTestDto
 *
 * Sites and logins (browser/logins.ts, Settings > Browser):
 *
 *   POST   /api/browser/logins                BrowserLoginInput -> BrowserStatusDto: save a login
 *   PUT    /api/browser/logins/:id            BrowserLoginInput -> BrowserStatusDto: change one
 *   DELETE /api/browser/logins/:id            -> BrowserStatusDto
 *   POST   /api/browser/profiles/:name/forget { host } -> BrowserStatusDto: clear the site's cookies and storage
 *   POST   /api/browser/profiles/:name/cookies { file } -> BrowserCookieImportResult: Import cookies; counts per site only
 *   DELETE /api/browser/profiles/:name        ?close=1 -> BrowserStatusDto: delete a profile; 409 while open without close
 *
 * All the owner's (route-policy.ts). The proxy's login and password, and a
 * saved login's password and 2FA key, go to the hub's secrets; no answer and
 * no audit line has them. The proxy is used only when the owner asks for it
 * in a chat (the browser tools' proxy input).
 */
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import {
  bounded,
  BrowserSetup,
  BrowserSetupError,
  BrowserStepTimeout,
  browserConfigProblems,
  COOKIE_FILE_MAX,
  CookieFileError,
  cloakInstalled,
  LoginUnreadable,
  normalizeUrl,
  ProfileInUse,
  siteHost,
  countryCode,
  DATAIMPULSE_HOST,
  DATAIMPULSE_PORT,
  parseProxyUrl,
  PROXY_SECRETS,
  SECRET_REF,
  validateInputEvent,
  validateProfileName,
  type BrowserCookieImportResult,
  type BrowserInputEvent,
  type BrowserLoginDto,
  type BrowserLoginInput,
  type BrowserManager,
  type BrowserProfileUserDto,
  type BrowserProfileUpdate,
  type BrowserProxyConfig,
  type BrowserProxySettingsDto,
  type BrowserProxyTestDto,
  type BrowserProxyUpdate,
  type BrowserSetupOptions,
  type ScreencastFrame,
} from '@conclave/core/browser/index.ts';
import type { ConclaveConfig } from '@conclave/core/config/schema.ts';
import { deepMerge } from '@conclave/core/config/index.ts';
import { logger } from '@conclave/core/util/log.ts';
import type { BrowserLiveDto, BrowserStatusDto, SignInFrameDto, SignInViewDto } from '@conclave/core/watches/types.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, qBool, readJson } from './http';
import type { AuditFn } from './routes-extensions';

const log = logger('browser');

/** A view nobody looked at or typed into for this long is closed. */
export const VIEW_IDLE_MS = 10 * 60_000;
/** A session's live view polls about twice a second; this long without a poll closes it (and gives the browser back). */
export const LIVE_IDLE_MS = 60_000;
const MAX_VIEWS = 3;
/** Without a screencast frame for this long, a frame request takes a screenshot. */
const STALE_MS = 1_500;
/**
 * The most each step of a view may take. The browser bounds its own steps
 * (a launch, a CDP command, a load); these are the backstop, so the app
 * hears which step is stuck instead of waiting with no answer.
 */
const START_MS = 90_000;
const LOAD_MS = 45_000;
const FRAME_MS = 35_000;
const INPUT_MS = 15_000;
const CLOSE_MS = 15_000;
const SETTLE_MS = 11_000;

/** A step that took too long answers 504 and names the step. */
function stepError(err: unknown, fallback: number, what: string): HttpError {
  if (err instanceof HttpError) return err;
  const msg = String((err as Error)?.message ?? err).split('\n')[0];
  return err instanceof BrowserStepTimeout ? new HttpError(504, `${what}: ${msg}`) : new HttpError(fallback, `${what}: ${msg}`);
}

interface View {
  id: string;
  /** Set for a chat session's live view: the browser session is that session's, not the view's own. */
  session?: string;
  profile: string;
  url: string;
  seq: number;
  frame?: SignInFrameDto;
  frameAt: number;
  stop?: () => void;
  lastUsed: number;
  /** The screenshot a frame request is waiting for; the next request waits for the same one. */
  shot?: Promise<SignInFrameDto>;
}

export class SignInViews {
  private views = new Map<string, View>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private browser: () => BrowserManager | undefined,
    private idleMs = VIEW_IDLE_MS,
    private liveIdleMs = LIVE_IDLE_MS,
  ) {}

  private manager(): BrowserManager {
    const b = this.browser();
    if (!b) throw new HttpError(501, 'This hub has no browser.');
    return b;
  }

  private view(id: string): View {
    const v = this.views.get(id);
    if (!v) throw new HttpError(404, 'That sign-in view was closed. Open it again.');
    v.lastUsed = Date.now();
    return v;
  }

  async open(profileRaw: unknown, urlRaw: unknown): Promise<SignInViewDto> {
    const b = this.manager();
    let profile: string;
    let url: string;
    try {
      profile = validateProfileName(typeof profileRaw === 'string' && profileRaw.trim() ? profileRaw : 'default');
      url = normalizeUrl(typeof urlRaw === 'string' ? urlRaw : '');
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    // one view per profile: a second one would fight over the same page
    for (const v of this.views.values()) if (v.profile === profile) await this.close(v.id);
    if ([...this.views.values()].filter((v) => !v.session).length >= MAX_VIEWS) throw new HttpError(409, `At most ${MAX_VIEWS} sign-in views can be open. Close one first.`);
    const id = `signin-${randomBytes(6).toString('hex')}`;
    const view: View = { id, profile, url, seq: 0, frameAt: 0, lastUsed: Date.now() };
    this.views.set(id, view);
    this.tick();
    b.setProfile(id, profile);
    const onFrame = (f: ScreencastFrame) => {
      // the blank tab before the page loads is not worth a frame
      if (!/^https?:/i.test(f.url)) return;
      view.frame = { seq: ++view.seq, url: f.url, width: f.width, height: f.height, data: f.data };
      view.frameAt = Date.now();
    };
    try {
      const starting = b.startScreencast(profile, id, onFrame);
      // a start that lands after the view gave up stops its screencast
      starting.then((stop) => (this.views.has(id) ? undefined : stop()), () => undefined);
      view.stop = await bounded('starting the browser', START_MS, starting);
      await bounded(`loading ${url}`, LOAD_MS, b.navigate(id, url));
    } catch (err) {
      await this.close(id);
      throw stepError(err, 502, `The browser could not open ${url}`);
    }
    return { id, profile, url };
  }

  /**
   * The live view of a chat session's tab: the one its browser tools use, in
   * its profile (or its proxied browser). Opens no browser and no tab: 404
   * when the session has none open.
   */
  async live(sessionId: string): Promise<View> {
    const b = this.manager();
    const id = `live-${sessionId}`;
    let v = this.views.get(id);
    // the session switched profile: watch the new one
    if (v && v.profile !== b.profileFor(sessionId)) {
      await this.close(id, { keepHold: true });
      v = undefined;
    }
    if (!b.hasPage(sessionId)) {
      if (v) await this.close(id, { keepHold: true });
      throw new HttpError(404, 'This session has no browser page open.');
    }
    if (v) {
      v.lastUsed = Date.now();
      return v;
    }
    const view: View = { id, session: sessionId, profile: b.profileFor(sessionId), url: '', seq: 0, frameAt: 0, lastUsed: Date.now() };
    this.views.set(id, view);
    this.tick();
    const onFrame = (f: ScreencastFrame) => {
      view.frame = { seq: ++view.seq, url: f.url, width: f.width, height: f.height, data: f.data };
      view.frameAt = Date.now();
    };
    try {
      const starting = b.startScreencast(view.profile, sessionId, onFrame);
      starting.then((stop) => (this.views.get(id) === view ? undefined : stop()), () => undefined);
      view.stop = await bounded('watching the page', START_MS, starting);
    } catch (err) {
      await this.close(id, { keepHold: true });
      throw stepError(err, 502, 'The page cannot be watched');
    }
    return view;
  }

  /** The newest frame after `after`, or undefined when there is none newer. */
  async frame(id: string, after: number): Promise<SignInFrameDto | undefined> {
    const v = this.view(id);
    if (v.frame && v.frame.seq > after && Date.now() - v.frameAt < STALE_MS * 4) return v.frame;
    // a page that does not repaint sends no screencast frames: take one
    if (!v.frame || Date.now() - v.frameAt > STALE_MS) {
      const b = this.manager();
      v.shot ??= this.shoot(b, v).finally(() => (v.shot = undefined));
      try {
        return await bounded('a picture of the page', FRAME_MS, v.shot);
      } catch (err) {
        throw stepError(err, 502, 'No picture of the page');
      }
    }
    return v.frame.seq > after ? v.frame : undefined;
  }

  private async shoot(b: BrowserManager, v: View): Promise<SignInFrameDto> {
    const page = await b.page(v.session ?? v.id, v.profile);
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const shot = await b.screenshot(v.session ?? v.id, { maxBytes: 600_000 });
    v.frame = { seq: ++v.seq, url: shot.url, width: vp.width, height: vp.height, data: shot.data };
    v.frameAt = Date.now();
    return v.frame;
  }

  async input(id: string, events: unknown): Promise<void> {
    const v = this.view(id);
    const b = this.manager();
    // a session's page takes the owner's input only while they hold it
    if (v.session && !b.ownerHolds(v.session)) throw new HttpError(409, 'Take over first: the assistant is using this browser.');
    if (!Array.isArray(events) || !events.length) throw new HttpError(400, 'events must be a list of input events');
    if (events.length > 60) throw new HttpError(400, 'At most 60 events at once');
    for (const ev of events) {
      const bad = validateInputEvent(ev);
      if (bad) throw new HttpError(400, `Invalid input event: ${bad}`);
    }
    for (const ev of events as BrowserInputEvent[]) {
      try {
        await bounded(`a ${ev.type} event`, ev.type === 'navigate' ? LOAD_MS : INPUT_MS, b.dispatchInput(v.profile, v.session ?? id, ev));
      } catch (err) {
        throw stepError(err, 502, 'The page did not take the input');
      }
    }
    v.frameAt = 0;
  }

  /** The owner is signed in: remember the sites (where it started and where it ended) for this profile. */
  async done(id: string): Promise<{ profile: string; sites: string[] }> {
    const v = this.view(id);
    const b = this.manager();
    // Done right after the last key: the login's post may still be loading, and its answer sets the cookie
    await bounded('the page loading', SETTLE_MS, b.settle(id, v.profile, SETTLE_MS - 1_000)).catch(() => undefined);
    // where the tab ended up; a view whose tab is gone still records where it started
    const page = await bounded('finding the tab', INPUT_MS, b.page(id, v.profile)).catch(() => undefined);
    const hosts = new Set<string>();
    for (const u of [v.url, page?.url()]) {
      try {
        const h = u ? new URL(u).hostname : '';
        if (h) hosts.add(h.replace(/^www\./, ''));
      } catch {
        /* about:blank */
      }
    }
    for (const h of hosts) b.recordSignIn(v.profile, h);
    await this.close(id);
    return { profile: v.profile, sites: [...hosts] };
  }

  async close(id: string, opts: { keepHold?: boolean } = {}): Promise<void> {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    try {
      v.stop?.();
    } catch {
      /* already stopped */
    }
    const b = this.browser();
    // a session's page stays with the session; a view nobody watches gives the browser back
    if (v.session) {
      if (!opts.keepHold) b?.giveBack(v.session);
      return;
    }
    if (b) await bounded('closing the view', CLOSE_MS, b.closeSession(id)).catch((err) => log.warn(`sign-in view ${id}: ${(err as Error).message}`));
  }

  /** Close the views open on a profile (before it is deleted). */
  async closeProfile(profile: string): Promise<void> {
    await Promise.all([...this.views.values()].filter((v) => v.profile === profile).map((v) => this.close(v.id)));
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.views.keys()].map((id) => this.close(id)));
  }

  private tick(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const v of this.views.values()) if (now - v.lastUsed > (v.session ? this.liveIdleMs : this.idleMs)) void this.close(v.id);
      if (!this.views.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, Math.max(1_000, Math.min(60_000, this.idleMs / 4, this.liveIdleMs / 4)));
    (this.timer as { unref?: () => void }).unref?.();
  }

  size(): number {
    return this.views.size;
  }

  /** A view's newest frame, if it has one. Takes nothing. */
  latest(id: string): SignInFrameDto | undefined {
    return this.views.get(id)?.frame;
  }
}

/** The hub's browser manager (engine/create.ts puts it on the engine). */
export function browserOf(engine: object): BrowserManager | undefined {
  return (engine as { browser?: BrowserManager }).browser;
}

export function status(b: BrowserManager | undefined, available: { ok: boolean; reason?: string }): BrowserStatusDto {
  if (!b) return { available: false, reason: 'This hub has no browser.', profiles: [] };
  const profiles = b.listProfiles().map((name) => {
    let info: { engine: string; label: string; open: boolean };
    try {
      info = b.profileInfo(name);
    } catch (err) {
      info = { engine: 'unknown', label: String((err as Error).message), open: false };
    }
    return { name, engine: info.engine, label: info.label, open: info.open, sites: b.signIns(name), logins: b.logins.list(name).map((l) => loginDto(b, l)), isDefault: name === b.defaultProfileName() };
  });
  return { available: available.ok, ...(available.reason ? { reason: available.reason } : {}), profiles };
}

/** A saved login for Settings: whether a password and 2FA key are saved, never what they are. */
export function loginDto(b: BrowserManager, l: ReturnType<BrowserManager['logins']['list']>[number]): BrowserLoginDto {
  const readable = b.logins.readable(l.id);
  return {
    id: l.id,
    profile: l.profile,
    origin: l.origin,
    host: siteHost(l.origin),
    username: l.username,
    subdomains: l.subdomains,
    password: readable,
    totp: l.totp,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    ...(l.lastUsed ? { lastUsed: l.lastUsed } : {}),
    ...(readable ? {} : { problem: 'The hub cannot read this password (saved with another key, or a restored backup). Save it again.' }),
  };
}

/** Watches on a profile, and routines whose prompt names it as a profile ("profile marketplace"). */
export function profileUsers(routines: Array<{ id: string; name: string; prompt?: string; watch?: { profile?: string } }>, profile: string): BrowserProfileUserDto[] {
  const n = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`\\bprofile\\s*[:=]?\\s*["'\`]?${n}(?![\\w.-])|(?<![\\w.-])${n}["'\`]?\\s+(browser\\s+)?profile\\b`, 'i');
  return routines
    .filter((r) => (r.watch ? (r.watch.profile || 'default') === profile : named.test(r.prompt ?? '')))
    .map((r) => ({ id: r.id, name: r.name, watch: !!r.watch }));
}

/** The hub's proxy for Settings: whether a login and password are saved, never what they are. */
export function proxySettings(cfg: BrowserProxyConfig | undefined, secret: (name: string) => string | undefined): BrowserProxySettingsDto {
  const saved = (ref: string | undefined) => {
    const name = ref ? SECRET_REF.exec(ref.trim())?.[1] : undefined;
    return !!(name && secret(name));
  };
  const d = cfg?.dataimpulse ?? {};
  const c = cfg?.custom ?? {};
  const out: BrowserProxySettingsDto = {
    provider: cfg?.provider ?? 'none',
    dataimpulse: { host: d.host || DATAIMPULSE_HOST, port: d.port ?? DATAIMPULSE_PORT, login: saved(d.login), password: saved(d.password), ...(d.country ? { country: d.country } : {}) },
    custom: { ...(c.url ? { url: c.url } : {}), password: saved(c.password) },
  };
  if (out.provider === 'dataimpulse' && (!out.dataimpulse.login || !out.dataimpulse.password)) out.problem = 'Save the DataImpulse login and password.';
  if (out.provider === 'custom' && c.url && !parseProxyUrl(c.url).ok) out.problem = 'The custom proxy address is not right.';
  return out;
}

/** Everything Settings > Browser shows: profiles with engine and proxy, both engines with their install, libraries, the pool. */
export async function fullStatus(
  b: BrowserManager | undefined,
  setup: BrowserSetup | undefined,
  cfg: ConclaveConfig['browser'] | undefined,
  secret: (name: string) => string | undefined,
): Promise<BrowserStatusDto> {
  const available = b ? await b.available() : { ok: false, reason: 'This hub has no browser.' };
  const base = status(b, available);
  if (!b || !setup) return base;
  const facts = await setup.facts();
  const [engines, libs] = await Promise.all([setup.engines(facts), setup.libs(facts)]);
  return {
    ...base,
    profiles: base.profiles.map((p) => ({ ...p, folder: b.hasRun(p.name), engineSet: !!cfg?.profiles?.[p.name]?.engine })),
    playwright: facts.playwright ? { installed: true, version: facts.playwright.version, where: facts.playwright.where } : { installed: false },
    engines,
    ...(libs ? { libs } : {}),
    proxy: proxySettings(cfg?.proxy, secret),
    newProfileEngine: b.newProfileEngine(),
    dir: setup.dir(),
  };
}

export function registerBrowserRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): SignInViews {
  const views = new SignInViews(() => browserOf(ctx.engine));
  const engine = ctx.engine;
  let setupSvc: BrowserSetup | undefined;
  const setupOf = (b: BrowserManager | undefined): BrowserSetup | undefined => {
    if (!b) return undefined;
    setupSvc ??= new BrowserSetup({
      config: engine.config,
      manager: b,
      // Install on the hub runs on the hub's own machine, as the hub's user, like Discover's
      shell: {
        exec: (command, opts) => {
          const m = engine.devices.get('local');
          if (!m) throw new HttpError(503, 'The hub machine is not available.');
          return m.exec(command, opts);
        },
      },
      // tests describe the machine (where it runs, the root helper) and its shell here
      ...(engine as { browserSetupOverrides?: Partial<BrowserSetupOptions> }).browserSetupOverrides,
    });
    return setupSvc;
  };
  const manager = (): BrowserManager => {
    const b = browserOf(engine);
    if (!b) throw new HttpError(501, 'This hub has no browser.');
    return b;
  };
  const answer = async () => {
    const b = browserOf(engine);
    const st = await fullStatus(b, setupOf(b), engine.config.get().browser, (n) => engine.config.secretValue(n));
    const routines = engine.routines.list();
    return { ...st, profiles: st.profiles.map((p) => ({ ...p, usedBy: profileUsers(routines, p.name) })) };
  };
  /** Write the user config's browser part, refusing a bad one. */
  const writeBrowser = (edit: (browser: Record<string, any>) => void) => {
    const user = structuredClone(engine.config.getUser()) as Record<string, any>;
    user.browser ??= {};
    edit(user.browser);
    const bad = browserConfigProblems(deepMerge(structuredClone(engine.config.get().browser), user.browser));
    if (bad.length) throw new HttpError(400, bad.join(' '));
    engine.config.replace(user as Partial<ConclaveConfig>);
    engine.bus.emit({ type: 'config.updated' });
  };
  const profileParam = (raw: string): string => {
    try {
      return validateProfileName(raw);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  };

  app.get('/api/browser', async (c) => c.json(await answer()));

  app.post('/api/browser/setup', async (c) => {
    const body = await readJson<{ target?: unknown; steps?: unknown }>(c);
    if (body.target !== 'chromium' && body.target !== 'cloak') throw new HttpError(400, 'target must be chromium or cloak');
    if (!Array.isArray(body.steps) || body.steps.some((x) => typeof x !== 'string')) throw new HttpError(400, 'steps must be the list of step lines you confirmed');
    const setup = setupOf(manager())!;
    try {
      const r = await setup.run(body.target, body.steps as string[], (action, detail) => audit(c, action, detail));
      return c.json(r);
    } catch (err) {
      if (err instanceof BrowserSetupError) return c.json({ error: err.message, ...(err.setup ? { setup: err.setup } : {}) }, err.status as 409);
      throw err;
    }
  });

  // Install system libraries: the root helper's browser-deps, the one line the owner confirmed
  app.post('/api/browser/libs', async (c) => {
    const body = await readJson<{ steps?: unknown }>(c);
    if (!Array.isArray(body.steps) || body.steps.some((x) => typeof x !== 'string')) throw new HttpError(400, 'steps must be the list of step lines you confirmed');
    const setup = setupOf(manager())!;
    try {
      return c.json(await setup.installLibs(body.steps as string[], (action, detail) => audit(c, action, detail)));
    } catch (err) {
      if (err instanceof BrowserSetupError) return c.json({ error: err.message, libs: await setup.libs().catch(() => undefined) }, err.status as 409);
      throw err;
    }
  });

  app.put('/api/browser/profiles/:name', async (c) => {
    const b = manager();
    const name = profileParam(c.req.param('name'));
    const body = await readJson<BrowserProfileUpdate>(c);
    if (body.engine !== 'chromium' && body.engine !== 'cloak') throw new HttpError(400, 'engine must be chromium or cloak');
    if (body.engine === 'cloak' && !cloakInstalled(engine.config.get().browser)) throw new HttpError(409, 'CloakBrowser is not installed on this hub. Install it first.');
    writeBrowser((browser) => {
      browser.profiles ??= {};
      (browser.profiles[name] ??= {}).engine = body.engine;
    });
    // an open browser closes, so the next use starts on the new engine
    await b.closeProfileBrowser(name);
    audit(c, 'browser.profile', `${name}: engine ${body.engine}`);
    return c.json(await answer());
  });

  app.put('/api/browser/proxy', async (c) => {
    manager();
    const body = await readJson<BrowserProxyUpdate>(c);
    if (!['none', 'dataimpulse', 'custom'].includes(body.provider as string)) throw new HttpError(400, 'provider must be none, dataimpulse or custom');
    const secrets: Array<[string, string | undefined]> = [];
    /** A login or password given: kept as a secret, the config names it. null removes it. */
    const secretField = (v: unknown, name: string, what: string): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || v === '') {
        secrets.push([name, undefined]);
        return null;
      }
      if (typeof v !== 'string' || v.length > 512) throw new HttpError(400, `${what} must be text up to 512 characters`);
      secrets.push([name, v]);
      return `\${secret:${name}}`;
    };
    const said: string[] = [`provider ${body.provider}`];
    writeBrowser((browser) => {
      const proxy = (browser.proxy ??= {}) as BrowserProxyConfig & Record<string, any>;
      if (body.provider === 'none') delete proxy.provider;
      else proxy.provider = body.provider;
      const d = body.dataimpulse;
      if (d !== undefined && d !== null) {
        if (typeof d !== 'object') throw new HttpError(400, 'dataimpulse must be an object');
        const di = (proxy.dataimpulse ??= {}) as Record<string, any>;
        if (d.host !== undefined) {
          if (d.host === null || d.host === '' || d.host === DATAIMPULSE_HOST) delete di.host;
          else di.host = String(d.host).trim();
        }
        if (d.port !== undefined) {
          if (d.port === null || d.port === DATAIMPULSE_PORT) delete di.port;
          else di.port = d.port;
        }
        if (d.country !== undefined) {
          if (d.country === null || d.country === '') delete di.country;
          else {
            const cc = countryCode(String(d.country));
            if (!cc) throw new HttpError(400, `"${d.country}" is not a country. Use a two-letter code such as JP.`);
            di.country = cc;
          }
        }
        for (const [k, name, what] of [
          ['login', PROXY_SECRETS.dataimpulseLogin, 'login'],
          ['password', PROXY_SECRETS.dataimpulsePassword, 'password'],
        ] as const) {
          const ref = secretField(d[k], name, what);
          if (ref === null) delete di[k];
          else if (ref) {
            di[k] = ref;
            said.push(`DataImpulse ${what} saved as a secret`);
          }
        }
        if (!Object.keys(di).length) delete proxy.dataimpulse;
      }
      const cu = body.custom;
      if (cu !== undefined && cu !== null) {
        if (typeof cu !== 'object') throw new HttpError(400, 'custom must be an object');
        const x = (proxy.custom ??= {}) as Record<string, any>;
        if (cu.url !== undefined) {
          if (cu.url === null || cu.url === '') delete x.url;
          else {
            const r = parseProxyUrl(String(cu.url));
            if (!r.ok) throw new HttpError(400, r.why);
            x.url = String(cu.url).trim().replace(/\/$/, '');
            said.push(`custom ${x.url}`);
          }
        }
        const ref = secretField(cu.password, PROXY_SECRETS.customPassword, 'password');
        if (ref === null) delete x.password;
        else if (ref) {
          x.password = ref;
          said.push('custom password saved as a secret');
        }
        if (!Object.keys(x).length) delete proxy.custom;
      }
      if (!Object.keys(proxy).length) delete browser.proxy;
    });
    for (const [k, v] of secrets) engine.config.setSecret('values', k, v);
    audit(c, 'browser.proxy', said.join(', '));
    return c.json(await answer());
  });

  app.post('/api/browser/proxy/test', async (c) => {
    const b = manager();
    const body = await readJson<{ country?: unknown }>(c);
    if (body.country !== undefined && body.country !== null && typeof body.country !== 'string') throw new HttpError(400, 'country must be a country name or code');
    let r: BrowserProxyTestDto;
    try {
      const t = await b.testProxy((body.country as string | undefined) || undefined);
      r = { ok: t.ok, proxy: t.label, ms: t.ms, ...(t.ip ? { ip: t.ip } : {}), ...(t.country ? { country: t.country } : {}), ...(t.error ? { error: t.error } : {}) };
    } catch (err) {
      throw new HttpError(409, String((err as Error)?.message ?? err));
    }
    return c.json(r);
  });

  // ----- sites and logins ---------------------------------------------------

  /** The fields of a login as given; the vault checks each. A password or 2FA key is never echoed. */
  const loginBody = (raw: Record<string, unknown>): BrowserLoginInput => {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Send the login as an object');
    const out: BrowserLoginInput = {};
    for (const k of ['profile', 'site', 'username', 'password'] as const) {
      const v = raw[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') throw new HttpError(400, `${k} must be text`);
      out[k] = v;
    }
    if (raw.totp !== undefined) {
      if (raw.totp !== null && typeof raw.totp !== 'string') throw new HttpError(400, 'totp must be text, or null to remove it');
      out.totp = raw.totp as string | null;
    }
    if (raw.subdomains !== undefined) {
      if (typeof raw.subdomains !== 'boolean') throw new HttpError(400, 'subdomains must be true or false');
      out.subdomains = raw.subdomains;
    }
    return out;
  };
  /** A vault call: what it refuses is a 400 with its sentence. */
  const vault = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw new HttpError(400, String((err as Error)?.message ?? err));
    }
  };

  app.post('/api/browser/logins', async (c) => {
    const b = manager();
    const input = loginBody(await readJson<Record<string, unknown>>(c));
    const l = vault(() => b.logins.add(input));
    audit(c, 'browser.login.save', `${l.profile}: ${siteHost(l.origin)}${l.subdomains ? ' and its subdomains' : ''}${l.totp ? ', with a 2FA key' : ''}`);
    return c.json(await answer());
  });

  app.put('/api/browser/logins/:id', async (c) => {
    const b = manager();
    const id = c.req.param('id');
    if (!b.logins.get(id)) throw new HttpError(404, 'That saved login is gone.');
    const input = loginBody(await readJson<Record<string, unknown>>(c));
    const l = vault(() => b.logins.update(id, input));
    const changed = [
      input.site !== undefined ? 'site' : '',
      input.profile !== undefined ? 'profile' : '',
      input.username !== undefined ? 'username' : '',
      input.password ? 'password' : '',
      input.totp === null || input.totp === '' ? '2FA key removed' : input.totp ? '2FA key' : '',
      input.subdomains !== undefined ? 'subdomains' : '',
    ].filter(Boolean);
    audit(c, 'browser.login.update', `${l.profile}: ${siteHost(l.origin)}${changed.length ? ` (${changed.join(', ')})` : ''}`);
    return c.json(await answer());
  });

  app.delete('/api/browser/logins/:id', async (c) => {
    const b = manager();
    const l = b.logins.get(c.req.param('id'));
    if (!l) throw new HttpError(404, 'That saved login is gone.');
    b.logins.remove(l.id);
    audit(c, 'browser.login.delete', `${l.profile}: ${siteHost(l.origin)}`);
    return c.json(await answer());
  });

  app.post('/api/browser/profiles/:name/forget', async (c) => {
    const b = manager();
    const name = profileParam(c.req.param('name'));
    const body = await readJson<{ host?: unknown }>(c);
    if (typeof body.host !== 'string' || !body.host.trim()) throw new HttpError(400, 'host must be the site, such as facebook.com');
    let r: { cookies: number };
    try {
      r = await bounded('forgetting the site', START_MS, b.forgetSite(name, body.host));
    } catch (err) {
      throw stepError(err, /not a web address|has no host|Site is empty/.test(String((err as Error)?.message)) ? 400 : 502, `Could not forget ${body.host}`);
    }
    audit(c, 'browser.forget', `${name}: ${body.host.trim()} (${r.cookies} cookies)`);
    return c.json(await answer());
  });

  // Import cookies: the file's text in, counts per site out. The file is not kept and no value is echoed or logged.
  app.post('/api/browser/profiles/:name/cookies', async (c) => {
    const b = manager();
    const name = profileParam(c.req.param('name'));
    if (!b.listProfiles().includes(name)) throw new HttpError(404, `There is no browser profile ${name}.`);
    // JSON escaping can double a file's size
    const body = await readJson<{ file?: unknown }>(c, COOKIE_FILE_MAX * 2 + 1024);
    if (typeof body.file !== 'string') throw new HttpError(400, 'file must be the text of the cookie export');
    let r: BrowserCookieImportResult;
    // what got in so far: a failed or timed-out import is audited with it, never a value
    const progress = { added: 0 };
    const job = b.importCookies(name, body.file, progress);
    let settled = false;
    job.then(
      () => (settled = true),
      () => (settled = true),
    );
    try {
      r = await bounded('importing the cookies', START_MS, job);
    } catch (err) {
      if (err instanceof CookieFileError) throw new HttpError(400, err.message);
      audit(c, 'browser.cookies.import', `${name}: failed after ${progress.added} cookies added`);
      // bounded does not stop the import: audit where it ends up too
      if (!settled) {
        job.then(
          (late) => audit(c, 'browser.cookies.import', `${name}: finished after the answer timed out, ${late.added} cookies for ${late.sites.length} site${late.sites.length === 1 ? '' : 's'}`),
          () => audit(c, 'browser.cookies.import', `${name}: stopped after the answer timed out, ${progress.added} cookies added`),
        );
      }
      throw stepError(err, 502, 'Could not import the cookies');
    }
    audit(c, 'browser.cookies.import', `${name}: ${r.added} cookies for ${r.sites.length} site${r.sites.length === 1 ? '' : 's'}`);
    return c.json(r);
  });

  app.delete('/api/browser/profiles/:name', async (c) => {
    const b = manager();
    const name = profileParam(c.req.param('name'));
    if (!b.listProfiles().includes(name)) throw new HttpError(404, `There is no browser profile ${name}.`);
    const close = qBool(c.req.query('close')) ?? false;
    // a sign-in view keeps the profile open: close it with the profile, or refuse with it
    if (close) await views.closeProfile(name);
    let r: { logins: number };
    try {
      r = await b.deleteProfile(name, { close });
    } catch (err) {
      if (err instanceof ProfileInUse) return c.json({ error: err.message, code: err.code }, err.code === 'default' ? 400 : 409);
      throw err;
    }
    audit(c, 'browser.profile.delete', `${name}${r.logins ? `, with ${r.logins} saved login${r.logins === 1 ? '' : 's'}` : ''}${close ? ', closed first' : ''}`);
    return c.json(await answer());
  });

  app.post('/api/browser/signin', async (c) => {
    const body = await readJson<{ profile?: unknown; url?: unknown }>(c);
    const view = await views.open(body.profile, body.url);
    audit(c, 'browser.signin.open', `${view.profile} ${new URL(view.url).hostname}`);
    return c.json(view);
  });

  app.get('/api/browser/signin/:id/frame', async (c) => {
    const after = Number(c.req.query('after') ?? 0) || 0;
    const f = await views.frame(c.req.param('id'), after);
    if (!f) return c.body(null, 204);
    return c.json(f, 200, { 'cache-control': 'no-store' });
  });

  app.post('/api/browser/signin/:id/input', async (c) => {
    const body = await readJson<{ events?: unknown }>(c);
    await views.input(c.req.param('id'), body.events);
    return c.json({ ok: true });
  });

  app.post('/api/browser/signin/:id/done', async (c) => {
    const r = await views.done(c.req.param('id'));
    audit(c, 'browser.signin', `${r.profile} signed in to ${r.sites.join(', ') || 'a site'}`);
    return c.json(await answer());
  });

  app.delete('/api/browser/signin/:id', async (c) => {
    await views.close(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- a chat session's live view: Watch, Take over, Give back -----

  /** The session in the path, which must be one on this hub. */
  const sessionParam = (raw: string): string => {
    if (!engine.sessionAccount(raw)) throw new HttpError(404, 'There is no such session.');
    return raw;
  };
  const liveDto = (b: BrowserManager, sid: string): BrowserLiveDto => {
    const open = b.hasPage(sid);
    const frame = open ? views.latest(`live-${sid}`) : undefined;
    return { open, held: b.ownerHolds(sid), ...(open ? { profile: b.profileFor(sid) } : {}), ...(frame?.url ? { url: frame.url } : {}) };
  };

  app.get('/api/browser/sessions/:session', (c) => {
    const b = browserOf(engine);
    const sid = sessionParam(c.req.param('session'));
    if (!b) return c.json({ open: false, held: false } satisfies BrowserLiveDto);
    return c.json(liveDto(b, sid), 200, { 'cache-control': 'no-store' });
  });

  app.get('/api/browser/sessions/:session/frame', async (c) => {
    const sid = sessionParam(c.req.param('session'));
    const after = Number(c.req.query('after') ?? 0) || 0;
    const v = await views.live(sid);
    const f = await views.frame(v.id, after);
    if (!f) return c.body(null, 204);
    return c.json(f, 200, { 'cache-control': 'no-store' });
  });

  app.delete('/api/browser/sessions/:session/frame', async (c) => {
    const sid = sessionParam(c.req.param('session'));
    await views.close(`live-${sid}`);
    browserOf(engine)?.giveBack(sid);
    return c.json({ ok: true });
  });

  app.post('/api/browser/sessions/:session/input', async (c) => {
    const sid = sessionParam(c.req.param('session'));
    const body = await readJson<{ events?: unknown }>(c);
    const v = await views.live(sid);
    await views.input(v.id, body.events);
    return c.json({ ok: true });
  });

  app.post('/api/browser/sessions/:session/control', async (c) => {
    const b = manager();
    const sid = sessionParam(c.req.param('session'));
    const body = await readJson<{ take?: unknown }>(c);
    if (typeof body.take !== 'boolean') throw new HttpError(400, 'take must be true or false');
    if (body.take) {
      if (!b.hasPage(sid)) throw new HttpError(404, 'This session has no browser page open.');
      b.takeControl(sid);
      audit(c, 'browser.takeover', `session ${sid}`);
    } else if (b.ownerHolds(sid)) {
      b.giveBack(sid);
      audit(c, 'browser.giveback', `session ${sid}`);
    }
    return c.json(liveDto(b, sid));
  });

  return views;
}
