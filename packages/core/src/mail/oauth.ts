/**
 * OAuth 2.0 as a client, for Gmail, Google Calendar and Microsoft Graph:
 * authorization code with PKCE for Google (a hub https address, a loopback
 * address, or a phone's custom scheme), the device code flow for Microsoft,
 * refresh, and revoke. The hub keeps refresh tokens as hub secrets and access
 * tokens in memory only.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface OAuthEndpoints {
  googleAuth: string;
  googleToken: string;
  googleRevoke: string;
  /** https://login.microsoftonline.com/common/oauth2/v2.0 */
  microsoft: string;
}

export const DEFAULT_ENDPOINTS: OAuthEndpoints = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  googleRevoke: 'https://oauth2.googleapis.com/revoke',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0',
};

/** Google scopes, by what the owner turns on. */
export const GOOGLE_SCOPES = {
  identity: ['openid', 'email'],
  mailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  mailDrafts: 'https://www.googleapis.com/auth/gmail.compose',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarWrite: 'https://www.googleapis.com/auth/calendar.events',
} as const;

/** Microsoft Graph scopes. Mail.ReadWrite only for drafts, Mail.Send only for sending. */
export const MICROSOFT_SCOPES = {
  base: ['openid', 'email', 'profile', 'offline_access'],
  mailRead: 'https://graph.microsoft.com/Mail.Read',
  mailDrafts: 'https://graph.microsoft.com/Mail.ReadWrite',
  mailSend: 'https://graph.microsoft.com/Mail.Send',
} as const;

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  email?: string;
}

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}

/** The email in an id_token. It came straight from the token endpoint over TLS, so it is read, not verified. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const e = payload.email ?? payload.preferred_username ?? payload.upn;
    return typeof e === 'string' && e.includes('@') ? e : undefined;
  } catch {
    return undefined;
  }
}

async function postForm(url: string, form: Record<string, string>, f: typeof fetch): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new OAuthError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: 'bad_response', error_description: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

function tokenSet(body: Record<string, unknown>, now: number, asked: string[]): TokenSet {
  const access = body.access_token;
  if (typeof access !== 'string' || !access) throw new OAuthError('The token answer has no access token.');
  const expires = Number(body.expires_in ?? 3600);
  const scopes = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim().split(/\s+/) : asked;
  const email = emailFromIdToken(typeof body.id_token === 'string' ? body.id_token : undefined);
  return {
    accessToken: access,
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    // a minute early, so a call never starts with a token about to lapse
    expiresAt: now + Math.max(60, expires - 60) * 1000,
    scopes,
    ...(email ? { email } : {}),
  };
}

function oauthFail(body: Record<string, unknown>, what: string): never {
  const code = typeof body.error === 'string' ? body.error : 'error';
  const desc = typeof body.error_description === 'string' ? body.error_description : '';
  if (code === 'invalid_grant') throw new OAuthError(`${what}: the sign-in expired or was revoked. Sign in again.`, code);
  if (code === 'invalid_client' || code === 'unauthorized_client') throw new OAuthError(`${what}: the provider does not know this OAuth client (${desc || code}). Check the client id and secret in Settings.`, code);
  throw new OAuthError(`${what}: ${desc || code}`, code);
}

// ---------------------------------------------------------------------------
// Google: authorization code with PKCE
// ---------------------------------------------------------------------------

export function googleAuthUrl(o: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string; loginHint?: string }, ep: OAuthEndpoints = DEFAULT_ENDPOINTS): string {
  const u = new URL(ep.googleAuth);
  const q = u.searchParams;
  q.set('client_id', o.clientId);
  q.set('redirect_uri', o.redirectUri);
  q.set('response_type', 'code');
  q.set('scope', o.scopes.join(' '));
  q.set('state', o.state);
  q.set('code_challenge', o.challenge);
  q.set('code_challenge_method', 'S256');
  // offline access and a fresh consent, so Google sends a refresh token every time
  q.set('access_type', 'offline');
  q.set('prompt', 'consent');
  q.set('include_granted_scopes', 'true');
  if (o.loginHint) q.set('login_hint', o.loginHint);
  return u.toString();
}

export async function googleExchange(o: { code: string; clientId: string; clientSecret?: string; redirectUri: string; verifier: string; scopes: string[] }, ep: OAuthEndpoints = DEFAULT_ENDPOINTS, f: typeof fetch = fetch, now = Date.now()): Promise<TokenSet> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code: o.code, client_id: o.clientId, redirect_uri: o.redirectUri, code_verifier: o.verifier };
  if (o.clientSecret) form.client_secret = o.clientSecret;
  const r = await postForm(ep.googleToken, form, f);
  if (r.status !== 200) oauthFail(r.body, 'Google sign-in failed');
  const t = tokenSet(r.body, now, o.scopes);
  if (!t.refreshToken) throw new OAuthError('Google sent no refresh token. Remove Conclave at myaccount.google.com/permissions and sign in again.');
  return t;
}

export async function googleRefresh(o: { refreshToken: string; clientId: string; clientSecret?: string }, ep: OAuthEndpoints = DEFAULT_ENDPOINTS, f: typeof fetch = fetch, now = Date.now()): Promise<TokenSet> {
  const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId };
  if (o.clientSecret) form.client_secret = o.clientSecret;
  const r = await postForm(ep.googleToken, form, f);
  if (r.status !== 200) oauthFail(r.body, 'Google refresh failed');
  return tokenSet(r.body, now, []);
}

/** Revoke a Google token (refresh tokens revoke the whole grant). True when Google confirmed it. */
export async function googleRevoke(token: string, ep: OAuthEndpoints = DEFAULT_ENDPOINTS, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await postForm(ep.googleRevoke, { token }, f);
    return r.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Microsoft: device code flow
// ---------------------------------------------------------------------------

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
  message?: string;
}

export async function microsoftDeviceCode(o: { clientId: string; scopes: string[] }, ep: OAuthEndpoints = DEFAULT_ENDPOINTS, f: typeof fetch = fetch, now = Date.now()): Promise<DeviceCode> {
  const r = await postForm(`${ep.microsoft}/devicecode`, { client_id: o.clientId, scope: o.scopes.join(' ') }, f);
  if (r.status !== 200) oauthFail(r.body, 'Microsoft sign-in could not start');
  const b = r.body;
  return {
    deviceCode: String(b.device_code ?? ''),
    userCode: String(b.user_code ?? ''),
    verificationUri: String(b.verification_uri ?? 'https://microsoft.com/devicelogin'),
    expiresAt: now + Number(b.expires_in ?? 900) * 1000,
    intervalMs: Math.max(1, Number(b.interval ?? 5)) * 1000,
    ...(typeof b.message === 'string' ? { message: b.message } : {}),
  };
}

/** One poll of the token endpoint: the tokens, or "pending" / "slow_down" while the owner has not finished. */
export async function microsoftPoll(o: { clientId: string; deviceCode: string; scopes: string[] }, ep: OAuthEndpoints = DEFAULT_ENDPOINTS, f: typeof fetch = fetch, now = Date.now()): Promise<TokenSet | 'pending' | 'slow_down'> {
  const r = await postForm(`${ep.microsoft}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: o.clientId, device_code: o.deviceCode }, f);
  if (r.status === 200) return tokenSet(r.body, now, o.scopes);
  const code = r.body.error;
  if (code === 'authorization_pending') return 'pending';
  if (code === 'slow_down') return 'slow_down';
  if (code === 'authorization_declined') throw new OAuthError('The sign-in was declined.', 'authorization_declined');
  if (code === 'expired_token') throw new OAuthError('The code expired. Start the sign-in again.', 'expired_token');
  oauthFail(r.body, 'Microsoft sign-in failed');
}

/** Refresh; Microsoft rotates the refresh token, so keep the new one. */
export async function microsoftRefresh(o: { refreshToken: string; clientId: string; scopes: string[] }, ep: OAuthEndpoints = DEFAULT_ENDPOINTS, f: typeof fetch = fetch, now = Date.now()): Promise<TokenSet> {
  const r = await postForm(`${ep.microsoft}/token`, { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, scope: o.scopes.join(' ') }, f);
  if (r.status !== 200) oauthFail(r.body, 'Microsoft refresh failed');
  return tokenSet(r.body, now, o.scopes);
}
