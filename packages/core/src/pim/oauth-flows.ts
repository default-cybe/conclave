/**
 * Signing in to Google and Microsoft from the hub, and keeping the tokens
 * fresh. Which client signs in:
 *
 * - Google, shipped Desktop client (oauth-clients.ts): loopback redirect.
 *   From a browser on the hub machine the redirect is the hub's own
 *   http://127.0.0.1:<port> callback; from the desktop app it is the app's
 *   own loopback listener, and the app hands the code to the hub.
 * - Google, shipped iOS or Android client: the phone signs in through the
 *   system browser and its custom scheme, then hands the code (or a refresh
 *   token it got itself) to the hub.
 * - Google, the hub's own Web application client: redirect to the hub's
 *   https address (a tunnel, an own domain or a ts.net name).
 * - Google, the shipped Web application client (the relay): redirect to the
 *   relay page on the project site (GOOGLE_RELAY_URL). The state carries the
 *   hub address the owner's browser uses; the page shows that host and, on
 *   a click, sends the code there, to the same public callback. Any browser,
 *   the desktop app or a phone, with no https address and no setup.
 * - Microsoft: the device code flow with a public client, from any device.
 *
 * PKCE on every Google sign-in. The state names one pending flow made by the
 * owner in the last 15 minutes, which is what lets the public callback route
 * accept a code.
 */
import { GOOGLE_RELAY_URL, OAUTH_CLIENTS, type ShippedOAuthClients } from '../mail/oauth-clients';
import {
  DEFAULT_ENDPOINTS,
  GOOGLE_SCOPES,
  MICROSOFT_SCOPES,
  OAuthError,
  googleAuthUrl,
  googleExchange,
  googleRefresh,
  googleRevoke,
  microsoftDeviceCode,
  microsoftPoll,
  microsoftRefresh,
  pkce,
  randomState,
  type OAuthEndpoints,
  type TokenSet,
} from '../mail/oauth';
import type { KvRepo } from '../storage/repos';
import { newId } from '../util/ids';
import type { GoogleOAuthStatus, MicrosoftOAuthStatus, OAuthClientKind, OAuthFlowDto, PimAccount } from './types';

const HUB_CLIENTS = 'pim.oauthClients';
const FLOW_TTL = 15 * 60_000;

/** This hub's own OAuth clients, overriding the shipped ones. Secrets live in the secret store. */
export interface HubClients {
  google?: { webClientId?: string; desktopClientId?: string };
  microsoft?: { clientId?: string };
}

export interface FlowHost {
  kv: KvRepo;
  secret(name: string): string | undefined;
  setSecret(name: string, value: string | undefined): void;
  publicUrl?(): string | undefined;
  loopbackUrl?(): string;
  now(): number;
  fetch: typeof fetch;
  endpoints: OAuthEndpoints;
  shipped?: ShippedOAuthClients;
  /** An account signed in or signed in again: the service stores it. */
  signedIn(input: { provider: 'google' | 'microsoft'; tokens: TokenSet; client: OAuthClientKind; clientId: string; accountId?: string; wants: Wants }): Promise<PimAccount>;
}

export interface Wants {
  mail?: boolean;
  drafts?: boolean;
  send?: boolean;
  calendar?: boolean;
  calendarWrite?: boolean;
}

interface Flow {
  id: string;
  provider: 'google' | 'microsoft';
  state: OAuthFlowDto['state'];
  createdAt: number;
  expiresAt: number;
  wants: Wants;
  accountId?: string;
  error?: string;
  doneAccount?: string;
  // google
  oauthState?: string;
  verifier?: string;
  redirectUri?: string;
  client?: OAuthClientKind;
  clientId?: string;
  scopes?: string[];
  url?: string;
  // microsoft
  userCode?: string;
  verificationUri?: string;
  stop?: boolean;
  /** The finish under way, which a second callback for the same flow waits for. */
  finishing?: Promise<OAuthFlowDto>;
}

export const GOOGLE_CALLBACK = '/api/pim/oauth/google/callback';

/**
 * The callback a relayed sign-in finishes at: this hub origin (one of the
 * hub's own addresses, which the server checked) and GOOGLE_CALLBACK. http
 * or https only, with no user name, password, path, query or fragment.
 */
export function relayCallback(origin: string): string | undefined {
  const t = origin.trim().replace(/\/+$/, '');
  if (!URL.canParse(t)) return undefined;
  const u = new URL(t);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (!u.hostname || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return undefined;
  return `${u.origin}${GOOGLE_CALLBACK}`;
}

/**
 * Where the relay page may send a code: exactly <http or https origin> and
 * GOOGLE_CALLBACK, as relayCallback writes it. The site's own copy of this
 * rule is site/oauth/google/relay.js; both must say the same.
 */
export function isRelayReturn(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && url === `${u.origin}${GOOGLE_CALLBACK}`;
}

/** The OAuth state of a relayed sign-in: a random flow id, a dot, and the callback to finish at in base64url. */
export function relayState(id: string, callback: string): string {
  return `${id}.${Buffer.from(callback, 'utf8').toString('base64url')}`;
}

/** The callback a relay state names, when the relay page would accept it. */
export function relayReturn(state: string): string | undefined {
  const m = /^([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]+)$/.exec(state);
  if (!m) return undefined;
  const url = Buffer.from(m[2], 'base64url').toString('utf8');
  return isRelayReturn(url) ? url : undefined;
}

const SECRET_WEB = 'pim.oauth.google.web';
const SECRET_DESKTOP = 'pim.oauth.google.desktop';

export class OAuthFlows {
  private flows = new Map<string, Flow>();
  private refreshing = new Map<string, Promise<string>>();
  private access = new Map<string, { token: string; expiresAt: number }>();

  constructor(private h: FlowHost) {}

  private shipped(): ShippedOAuthClients {
    return this.h.shipped ?? OAUTH_CLIENTS;
  }

  hubClients(): HubClients {
    return this.h.kv.get<HubClients>(HUB_CLIENTS, {});
  }

  /** Change this hub's own clients. A secret of "" clears it; undefined leaves it. */
  setHubClients(input: { googleWebClientId?: string; googleWebSecret?: string; googleDesktopClientId?: string; googleDesktopSecret?: string; microsoftClientId?: string }): void {
    const cur = this.hubClients();
    const t = (v: string | undefined, old: string | undefined) => (v === undefined ? old : v.trim() || undefined);
    const next: HubClients = {
      google: { webClientId: t(input.googleWebClientId, cur.google?.webClientId), desktopClientId: t(input.googleDesktopClientId, cur.google?.desktopClientId) },
      microsoft: { clientId: t(input.microsoftClientId, cur.microsoft?.clientId) },
    };
    this.h.kv.set(HUB_CLIENTS, next);
    if (input.googleWebSecret !== undefined) this.h.setSecret(SECRET_WEB, input.googleWebSecret.trim() || undefined);
    if (input.googleDesktopSecret !== undefined) this.h.setSecret(SECRET_DESKTOP, input.googleDesktopSecret.trim() || undefined);
  }

  /** The https callback, when the hub has an https address. */
  webRedirect(): string | undefined {
    const u = this.h.publicUrl?.();
    if (!u) return undefined;
    try {
      const url = new URL(u);
      if (url.protocol !== 'https:') return undefined;
      return `${url.origin}${GOOGLE_CALLBACK}`;
    } catch {
      return undefined;
    }
  }

  loopbackRedirect(): string {
    return `${this.h.loopbackUrl?.() ?? 'http://127.0.0.1:7777'}${GOOGLE_CALLBACK}`;
  }

  /** The client id and secret for a Google client kind: the hub's own first, then the shipped one. */
  googleClient(kind: OAuthClientKind): { clientId: string; clientSecret?: string } | undefined {
    const hub = this.hubClients().google ?? {};
    const s = this.shipped().google;
    if (kind === 'web') return hub.webClientId ? { clientId: hub.webClientId, ...(this.h.secret(SECRET_WEB) ? { clientSecret: this.h.secret(SECRET_WEB) } : {}) } : undefined;
    // a Web client cannot exchange a code without its secret, so the relay is on only with both
    if (kind === 'relay') return s.web.clientId && s.web.clientSecret ? { clientId: s.web.clientId, clientSecret: s.web.clientSecret } : undefined;
    if (kind === 'desktop') {
      if (hub.desktopClientId) return { clientId: hub.desktopClientId, ...(this.h.secret(SECRET_DESKTOP) ? { clientSecret: this.h.secret(SECRET_DESKTOP) } : {}) };
      return s.desktop.clientId ? { clientId: s.desktop.clientId, ...(s.desktop.clientSecret ? { clientSecret: s.desktop.clientSecret } : {}) } : undefined;
    }
    if (kind === 'ios') return s.ios.clientId ? { clientId: s.ios.clientId } : undefined;
    if (kind === 'android') return s.android.clientId ? { clientId: s.android.clientId } : undefined;
    return undefined;
  }

  microsoftClient(): string | undefined {
    return this.hubClients().microsoft?.clientId || this.shipped().microsoft.clientId || undefined;
  }

  googleStatus(): GoogleOAuthStatus {
    const s = this.shipped().google;
    const hub = this.hubClients().google ?? {};
    const web = this.webRedirect();
    const relay = !!this.googleClient('relay');
    const builtin = { desktop: !!s.desktop.clientId, web: relay, ios: !!s.ios.clientId, android: !!s.android.clientId };
    const desktop = !!this.googleClient('desktop');
    const webReady = !!(web && hub.webClientId && this.h.secret(SECRET_WEB));
    // the order Settings starts them in: the hub's own Web client, the relay, loopback (pasted back away from the hub machine)
    let how: string;
    if (webReady) how = 'Sign in from any browser: Google sends you back to this hub at its https address.';
    else if (relay) how = `Sign in from any browser, the desktop app or a phone. After you allow, Google opens a Conclave page at ${new URL(GOOGLE_RELAY_URL).host}. Press Continue there and it sends you back to this hub.`;
    else if (desktop) how = 'Sign in from any browser. This hub has no https address for Google, so after you allow, Google opens a page at 127.0.0.1 that may not load. Copy that address and paste it here.';
    else how = 'No Google client is set up yet. Follow the steps below once, or ask whoever runs Conclave for the shared one.';
    return {
      builtin,
      hub: { ...(hub.webClientId ? { webClientId: hub.webClientId } : {}), webSecret: !!this.h.secret(SECRET_WEB), ...(hub.desktopClientId ? { desktopClientId: hub.desktopClientId } : {}), desktopSecret: !!this.h.secret(SECRET_DESKTOP) },
      redirect: { ...(web ? { web } : {}), loopback: this.loopbackRedirect() },
      ...(relay ? { relay: GOOGLE_RELAY_URL } : {}),
      how,
      ready: webReady || relay || desktop,
    };
  }

  microsoftStatus(): MicrosoftOAuthStatus {
    const hub = this.hubClients().microsoft?.clientId;
    return { builtin: !!this.shipped().microsoft.clientId, ...(hub ? { hubClientId: hub } : {}), ready: !!this.microsoftClient() };
  }

  googleScopes(w: Wants): string[] {
    const out: string[] = [...GOOGLE_SCOPES.identity];
    if (w.mail) out.push(GOOGLE_SCOPES.mailRead);
    if (w.mail && (w.drafts || w.send)) out.push(GOOGLE_SCOPES.mailDrafts);
    if (w.calendar) out.push(GOOGLE_SCOPES.calendarRead);
    if (w.calendar && w.calendarWrite) out.push(GOOGLE_SCOPES.calendarWrite);
    return out;
  }

  microsoftScopes(w: Wants): string[] {
    const out: string[] = [...MICROSOFT_SCOPES.base, MICROSOFT_SCOPES.mailRead];
    if (w.drafts || w.send) out.push(MICROSOFT_SCOPES.mailDrafts);
    if (w.send) out.push(MICROSOFT_SCOPES.mailSend);
    return out;
  }

  private dto(f: Flow): OAuthFlowDto {
    return {
      id: f.id,
      provider: f.provider,
      state: f.state,
      expiresAt: f.expiresAt,
      ...(f.url ? { url: f.url } : {}),
      ...(f.userCode ? { userCode: f.userCode, verificationUri: f.verificationUri } : {}),
      ...(f.error ? { error: f.error } : {}),
      ...(f.doneAccount ? { accountId: f.doneAccount } : {}),
    };
  }

  private sweep(): void {
    const now = this.h.now();
    for (const [id, f] of this.flows) if (f.expiresAt + 10 * 60_000 < now) this.flows.delete(id);
  }

  flow(id: string): OAuthFlowDto | undefined {
    const f = this.flows.get(id);
    if (!f) return undefined;
    if (f.state === 'waiting' && f.expiresAt < this.h.now()) {
      f.state = 'failed';
      f.error = 'The sign-in took too long. Start it again.';
    }
    return this.dto(f);
  }

  /**
   * Start a Google sign-in. client: web (the hub's https callback), relay (the
   * shared Web client: Google sends the browser to the relay page, which
   * sends it on to returnTo, the hub origin the server checked), desktop
   * (loopback: the hub's own when redirectUri is left out), ios or android
   * (the app's custom scheme). Returns the URL to open.
   */
  startGoogle(input: { client: OAuthClientKind; redirectUri?: string; returnTo?: string; wants: Wants; accountId?: string; loginHint?: string }): OAuthFlowDto {
    this.sweep();
    const kind = input.client;
    if (!['web', 'relay', 'desktop', 'ios', 'android'].includes(kind)) throw new OAuthError('client must be web, relay, desktop, ios or android.');
    const creds = this.googleClient(kind);
    if (!creds) throw new OAuthError(kind === 'web' ? 'Add this hub\'s own Web application client in Settings first.' : kind === 'relay' ? 'This version of Conclave has no shared Google Web client, so the relay is off. Sign in with the 127.0.0.1 address instead.' : `There is no Google ${kind} client set up on this hub.`);
    let redirectUri: string;
    let back: string | undefined;
    if (kind === 'web') {
      const web = this.webRedirect();
      if (!web) throw new OAuthError('Google needs an https address to send the sign-in back to. Set up remote access with a tunnel or your own domain, or sign in from the desktop app.');
      redirectUri = web;
    } else if (kind === 'relay') {
      back = relayCallback(input.returnTo ?? '');
      if (!back) throw new OAuthError('The relay needs the hub address to send the sign-in back to: http or https, with nothing after the host.');
      redirectUri = GOOGLE_RELAY_URL;
    } else if (kind === 'desktop') {
      redirectUri = input.redirectUri?.trim() || this.loopbackRedirect();
      const u = URL.canParse(redirectUri) ? new URL(redirectUri) : undefined;
      if (!u || u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new OAuthError('A desktop sign-in must come back to http://127.0.0.1 or http://localhost.');
    } else {
      redirectUri = input.redirectUri?.trim() ?? '';
      const scheme = redirectUri.split(':')[0];
      const expected = creds.clientId.split('.').reverse().join('.');
      if (!redirectUri || (scheme !== expected && !scheme.startsWith('com.googleusercontent.apps.'))) throw new OAuthError(`A phone sign-in must come back to the app's scheme, ${expected}:/oauth2redirect.`);
    }
    const wants = { ...input.wants, mail: input.wants.mail ?? true };
    if (!wants.mail && !wants.calendar) throw new OAuthError('Pick mail, calendar or both.');
    const scopes = this.googleScopes(wants);
    const { verifier, challenge } = pkce();
    // a relayed sign-in carries where to finish in its state, for the relay page to read
    const oauthState = back ? relayState(randomState(), back) : randomState();
    const url = googleAuthUrl({ clientId: creds.clientId, redirectUri, scopes, state: oauthState, challenge, ...(input.loginHint ? { loginHint: input.loginHint } : {}) }, this.h.endpoints);
    const now = this.h.now();
    const f: Flow = { id: newId('flow'), provider: 'google', state: 'waiting', createdAt: now, expiresAt: now + FLOW_TTL, wants, oauthState, verifier, redirectUri, client: kind, clientId: creds.clientId, scopes, url, ...(input.accountId ? { accountId: input.accountId } : {}) };
    this.flows.set(f.id, f);
    return this.dto(f);
  }

  private byState(state: string): Flow | undefined {
    for (const f of this.flows.values()) if (f.provider === 'google' && f.oauthState === state) return f;
    return undefined;
  }

  /** A Google sign-in with this state was started here (each account has its own flows; the callback asks each). */
  ownsState(state: string): boolean {
    return !!state && !!this.byState(state);
  }

  /**
   * Finish a Google sign-in: the callback's code (the hub exchanges it with
   * the verifier it kept), or tokens a phone got itself with the same client.
   */
  async finishGoogle(input: { state: string; code?: string; error?: string; tokens?: { refreshToken: string; accessToken?: string; expiresIn?: number; scope?: string } }): Promise<OAuthFlowDto> {
    const f = typeof input.state === 'string' ? this.byState(input.state) : undefined;
    if (!f) throw new OAuthError('This sign-in is unknown or already finished. Start it again from Settings.');
    if (f.state !== 'waiting') return this.dto(f);
    // the same callback twice at once (a reload, an app's retry): one exchange, one account, one answer
    if (f.finishing) return f.finishing;
    const p = this.finishFlow(f, input);
    f.finishing = p;
    return p;
  }

  private async finishFlow(f: Flow, input: { code?: string; error?: string; tokens?: { refreshToken: string; accessToken?: string; expiresIn?: number; scope?: string } }): Promise<OAuthFlowDto> {
    if (f.expiresAt < this.h.now()) {
      f.state = 'failed';
      f.error = 'The sign-in took too long. Start it again.';
      return this.dto(f);
    }
    if (input.error) {
      f.state = 'failed';
      f.error = input.error === 'access_denied' ? 'You cancelled the sign-in at Google.' : `Google said: ${input.error}`;
      return this.dto(f);
    }
    try {
      let tokens: TokenSet;
      if (input.code) {
        const creds = this.googleClient(f.client!)!;
        tokens = await googleExchange({ code: input.code, clientId: creds.clientId, ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}), redirectUri: f.redirectUri!, verifier: f.verifier!, scopes: f.scopes! }, this.h.endpoints, this.h.fetch, this.h.now());
      } else if (input.tokens?.refreshToken && (f.client === 'ios' || f.client === 'android')) {
        // the phone exchanged the code itself; check the refresh token works with this client before keeping it
        const fresh = await googleRefresh({ refreshToken: input.tokens.refreshToken, clientId: f.clientId! }, this.h.endpoints, this.h.fetch, this.h.now());
        tokens = { ...fresh, refreshToken: input.tokens.refreshToken, scopes: fresh.scopes.length ? fresh.scopes : (input.tokens.scope?.split(/\s+/) ?? f.scopes!) };
      } else {
        throw new OAuthError('The sign-in came back without a code.');
      }
      const acc = await this.h.signedIn({ provider: 'google', tokens, client: f.client!, clientId: f.clientId!, wants: f.wants, ...(f.accountId ? { accountId: f.accountId } : {}) });
      this.access.set(acc.id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
      f.state = 'done';
      f.doneAccount = acc.id;
    } catch (err) {
      f.state = 'failed';
      f.error = (err as Error).message;
    }
    return this.dto(f);
  }

  /** Start a Microsoft sign-in with the device code flow; the hub polls until the owner finishes. */
  async startMicrosoft(input: { wants: Wants; accountId?: string }): Promise<OAuthFlowDto> {
    this.sweep();
    const clientId = this.microsoftClient();
    if (!clientId) throw new OAuthError('There is no Microsoft client set up on this hub. Add one in Settings first.');
    const scopes = this.microsoftScopes(input.wants);
    const code = await microsoftDeviceCode({ clientId, scopes }, this.h.endpoints, this.h.fetch, this.h.now());
    const now = this.h.now();
    const f: Flow = { id: newId('flow'), provider: 'microsoft', state: 'waiting', createdAt: now, expiresAt: code.expiresAt, wants: { ...input.wants, mail: true }, client: 'microsoft', clientId, scopes, userCode: code.userCode, verificationUri: code.verificationUri, ...(input.accountId ? { accountId: input.accountId } : {}) };
    this.flows.set(f.id, f);
    void this.pollMicrosoft(f, code.deviceCode, code.intervalMs);
    return this.dto(f);
  }

  /** Stop polling a sign-in the owner gave up on. */
  cancel(id: string): void {
    const f = this.flows.get(id);
    if (!f || f.state !== 'waiting') return;
    f.stop = true;
    f.state = 'failed';
    f.error = 'Cancelled.';
  }

  private async pollMicrosoft(f: Flow, deviceCode: string, intervalMs: number): Promise<void> {
    let wait = intervalMs;
    while (f.state === 'waiting' && !f.stop) {
      await Bun.sleep(wait);
      if (f.stop || f.state !== 'waiting') return;
      if (this.h.now() > f.expiresAt) {
        f.state = 'failed';
        f.error = 'The code expired. Start the sign-in again.';
        return;
      }
      try {
        const r = await microsoftPoll({ clientId: f.clientId!, deviceCode, scopes: f.scopes! }, this.h.endpoints, this.h.fetch, this.h.now());
        if (r === 'pending') continue;
        if (r === 'slow_down') {
          wait += 5_000;
          continue;
        }
        if (!r.refreshToken) throw new OAuthError('Microsoft sent no refresh token. The app registration must allow offline_access.');
        const acc = await this.h.signedIn({ provider: 'microsoft', tokens: r, client: 'microsoft', clientId: f.clientId!, wants: f.wants, ...(f.accountId ? { accountId: f.accountId } : {}) });
        this.access.set(acc.id, { token: r.accessToken, expiresAt: r.expiresAt });
        f.state = 'done';
        f.doneAccount = acc.id;
      } catch (err) {
        f.state = 'failed';
        f.error = (err as Error).message;
      }
    }
  }

  /** A valid access token for an OAuth account, refreshed when it is close to lapsing. One refresh at a time per account. */
  async token(acc: PimAccount): Promise<string> {
    const cached = this.access.get(acc.id);
    if (cached && cached.expiresAt > this.h.now()) return cached.token;
    const running = this.refreshing.get(acc.id);
    if (running) return running;
    const p = this.refresh(acc).finally(() => this.refreshing.delete(acc.id));
    this.refreshing.set(acc.id, p);
    return p;
  }

  private async refresh(acc: PimAccount): Promise<string> {
    const refreshToken = this.h.secret(refreshSecret(acc.id));
    if (!refreshToken) throw new OAuthError(`${acc.label} is signed out. Sign in again in Settings > Calendar and mail.`);
    let t: TokenSet;
    if (acc.kind === 'google') {
      const creds = this.googleClient(acc.client ?? 'desktop');
      // the account remembers the client id it signed in with; refresh needs that same one
      const clientId = acc.clientId ?? creds?.clientId;
      if (!clientId) throw new OAuthError('The Google client this account signed in with is gone from the hub.');
      t = await googleRefresh({ refreshToken, clientId, ...(creds?.clientId === clientId && creds.clientSecret ? { clientSecret: creds.clientSecret } : {}) }, this.h.endpoints, this.h.fetch, this.h.now());
    } else if (acc.kind === 'microsoft') {
      const clientId = acc.clientId ?? this.microsoftClient();
      if (!clientId) throw new OAuthError('The Microsoft client this account signed in with is gone from the hub.');
      t = await microsoftRefresh({ refreshToken, clientId, scopes: acc.scopes?.length ? acc.scopes : this.microsoftScopes({ mail: true }) }, this.h.endpoints, this.h.fetch, this.h.now());
    } else {
      throw new OAuthError('That account does not sign in with OAuth.');
    }
    // signed out (disconnected, or signed in again) while the refresh was out: keep nothing of it
    if (this.h.secret(refreshSecret(acc.id)) !== refreshToken) throw new OAuthError(`${acc.label} was signed out or signed in again. Try again.`);
    if (t.refreshToken && t.refreshToken !== refreshToken) this.h.setSecret(refreshSecret(acc.id), t.refreshToken);
    this.access.set(acc.id, { token: t.accessToken, expiresAt: t.expiresAt });
    return t.accessToken;
  }

  /** Forget an account's tokens, revoking them where the provider allows it. */
  async disconnect(acc: PimAccount): Promise<{ revoked: boolean; note?: string }> {
    const refreshToken = this.h.secret(refreshSecret(acc.id));
    this.access.delete(acc.id);
    this.h.setSecret(refreshSecret(acc.id), undefined);
    if (acc.kind === 'google' && refreshToken) {
      const ok = await googleRevoke(refreshToken, this.h.endpoints, this.h.fetch);
      return ok ? { revoked: true } : { revoked: false, note: 'Google did not confirm the revoke. Remove Conclave at myaccount.google.com/permissions.' };
    }
    if (acc.kind === 'microsoft') return { revoked: false, note: 'Microsoft has no revoke for one app\'s tokens. The hub forgot them; to remove the app\'s access, go to account.live.com/consent/Manage (personal) or myapps.microsoft.com (work).' };
    return { revoked: false };
  }

  /** Tokens cached in memory, for tests. */
  dropCached(accountId: string): void {
    this.access.delete(accountId);
  }
}

export function refreshSecret(accountId: string): string {
  return `pim.${accountId}.refresh`;
}

export { DEFAULT_ENDPOINTS };
