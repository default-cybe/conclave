/**
 * The hub as its own OAuth 2.1 authorization server for /mcp, so claude.ai
 * custom connectors and ChatGPT apps can sign in (docs/design/MCP-OAUTH.md):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728
 *   GET  /.well-known/oauth-authorization-server      RFC 8414
 *   POST /oauth/register     dynamic client registration (RFC 7591)
 *   GET  /oauth/authorize    PKCE S256 only; sends the browser to the consent page
 *   POST /oauth/token        authorization_code and refresh_token (rotated)
 *   POST /oauth/revoke       RFC 7009
 *   Both authenticate a client by nothing (public), a client secret, or a
 *   private_key_jwt client_assertion (RFC 7523; assertion.ts).
 *   GET  /api/oauth/requests/:id, POST the answer  the consent page (owner token)
 *   GET  /api/oauth/apps, DELETE /api/oauth/apps/:id  Settings > Connected apps
 *
 * Tokens, codes and secrets never reach a log line or the audit log.
 */
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ConnectedAppDto, OAuthConsentDto, OAuthScope } from '@conclave/core/client/index.ts';
import { logger } from '@conclave/core/util/log.ts';
import type { HonoEnv, ServerContext } from '../context';
import { RateLimiter, sha256 } from '../auth';
import { HttpError, PUBLIC_BODY_MAX, actorOf, clientIp, isDirectLocal, readBody, requestOrigin } from '../http';
import { esc, htmlPage } from '../static';
import { cleanName, hostOf, isLoopbackHost, matchRedirect, nameWarning, pkceMatches, redirectProblem, validPkceValue } from './checks';
import { ASSERTION_ALGS, CLOCK_SKEW_S, JWT_BEARER, assertionSubject, verifyClientAssertion, type PublicJwk } from './assertion';
import { CimdError, JWKS_REFETCH_MS, JwksCache, fetchClientDocument, isDocumentUrl, keySource, type CimdOptions } from './cimd';
import { OAuthStore, type AuthMethod, type OAuthClient, type PendingRequest } from './store';
import { OFFLINE_ACCESS, SCOPES, SCOPE_WORDS, parseScopes, scopeText, unknownScopes } from './scopes';

const log = logger('oauth');

/** Where the web app shows the consent screen. */
export const CONSENT_PATH = '/oauth/consent';
export const PRM_PATH = '/.well-known/oauth-protected-resource';
/** A client ID metadata document is fetched again after this. */
const DOCUMENT_TTL_MS = 60 * 60_000;
/** One audit line a day per app for its token refreshes. */
const REFRESH_AUDIT_MS = 24 * 3_600_000;

export interface OAuthOptions {
  /** Clock for codes and tokens (tests). */
  now?: () => number;
  /** Client ID metadata document fetching (tests). */
  cimd?: CimdOptions;
}

export class OAuthService {
  readonly store: OAuthStore;
  readonly now: () => number;
  readonly cimd: CimdOptions;
  /** Registrations per address: 60 in 10 minutes. */
  readonly registerLimiter = new RateLimiter(60, 10 * 60_000);
  /** Authorize requests per address: 60 a minute (each may fetch a client document). */
  readonly authorizeLimiter = new RateLimiter(60, 60_000);
  /** Public keys of private_key_jwt clients that publish them at a jwks_uri. */
  readonly jwks: JwksCache;

  constructor(ctx: { engine: ServerContext['engine'] }, opts: OAuthOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.store = new OAuthStore(ctx.engine.repos.db, this.now);
    this.cimd = opts.cimd ?? {};
    this.jwks = new JwksCache(this.now);
  }
}

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

/** The issuer for this request: the origin the client used. */
export function issuerFor(req: Request): string {
  return requestOrigin(req).replace(/\/+$/, '');
}

/** https, or plain http only on this computer. */
function secureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}

/** Origins that are this hub: the one this request used and every address the hub has. */
function hubOrigins(ctx: ServerContext, req: Request): Set<string> {
  const out = new Set<string>([issuerFor(req)]);
  for (const o of ctx.remote.knownOrigins()) out.add(o);
  const pub = ctx.engine.config.get().server.publicUrl;
  if (pub) {
    try {
      out.add(new URL(pub).origin);
    } catch {
      /* bad publicUrl */
    }
  }
  return out;
}

/**
 * Origins that are this hub whatever a request's headers claim: its tunnels
 * and addresses, server.publicUrl, and the address a request made on this
 * computer used. X-Forwarded-Host can come from the internet, so the origin
 * a request names counts only while the hub knows no https address of its
 * own (behind a proxy it was not told about); setting publicUrl ends that.
 */
function ownOrigins(ctx: ServerContext, c: Context): Set<string> {
  const out = new Set<string>(ctx.remote.knownOrigins());
  const pub = ctx.engine.config.get().server.publicUrl;
  if (pub) {
    try {
      out.add(new URL(pub).origin);
    } catch {
      /* bad publicUrl */
    }
  }
  if (isDirectLocal(c)) out.add(new URL(c.req.url).origin);
  if (![...out].some((o) => o.startsWith('https://'))) out.add(issuerFor(c.req.raw));
  return out;
}

/** A resource indicator (RFC 8707) that names this hub's /mcp, exactly. */
export function isHubResource(ctx: ServerContext, req: Request, value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return value === `${u.origin}/mcp` && hubOrigins(ctx, req).has(u.origin);
}

export function protectedResourceMetadataUrl(req: Request): string {
  return `${issuerFor(req)}${PRM_PATH}/mcp`;
}

/** WWW-Authenticate for /mcp: where the metadata is, what to ask for, and an error when a token was wrong. */
export function bearerChallenge(req: Request, opts: { error?: 'invalid_token' | 'insufficient_scope'; description?: string; scope?: readonly OAuthScope[] } = {}): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(req)}"`, `scope="${scopeText(opts.scope ?? SCOPES)}"`];
  if (opts.error) parts.unshift(`error="${opts.error}"`);
  if (opts.description) parts.push(`error_description="${opts.description.replace(/["\\]/g, '')}"`);
  return `Bearer ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** The hub's own page for errors that must not go back to the app: a wrong client or redirect URI. */
function errorPage(title: string, message: string, status = 400): Response {
  return htmlPage(title, `<p>${esc(message)}</p>`, status);
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function oauthError(c: Context, status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return c.json({ error, error_description: description }, status as 400, { ...NO_STORE, ...headers });
}

/** The answer to the app: the checked redirect URI with code or error, state and iss (RFC 9207). */
function answerUrl(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

function audit(ctx: ServerContext, actor: string, action: string, detail: string, accountId?: string): void {
  try {
    ctx.engine.repos.audit.add({ actor, action, detail, ...(accountId ? { accountId } : {}) });
  } catch {
    /* auditing must not break the request */
  }
}

/** A wrong code, refresh token or client secret counts like a wrong hub token: twenty different ones block the address. */
function countFailure(ctx: ServerContext, c: Context, value: string): void {
  if (isDirectLocal(c)) return;
  const ip = clientIp(c);
  const block = ctx.authGuard.fail(ip, Date.now(), sha256(value).slice(0, 16));
  if (block) {
    log.warn(`blocked ${ip} for ${block}s after repeated failed OAuth attempts`);
    audit(ctx, `ip:${ip}`, 'auth.blocked', `${ctx.authGuard.opts.limit} different wrong OAuth codes or tokens in 10 minutes, blocked for ${block}s`);
  }
}

function limited(c: Context, limiter: RateLimiter): Response | undefined {
  const ip = clientIp(c);
  if (isDirectLocal(c) || limiter.hit(ip)) return undefined;
  const wait = limiter.retryAfterSec(ip);
  return c.json({ error: 'slow_down', error_description: `Too many requests from this address. Try again in ${wait} seconds.` }, 429, { 'retry-after': String(wait) });
}

/** Form body (RFC 6749) or JSON. A parameter sent twice is an error. */
async function readParams(c: Context): Promise<Record<string, string> | 'duplicate'> {
  const type = c.req.header('content-type') ?? '';
  // a client with no token yet: read only up to the small cap (413 past it)
  const text = await readBody(c, PUBLIC_BODY_MAX);
  if (type.includes('json')) {
    try {
      const data = JSON.parse(text || '{}') as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data ?? {})) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  const form = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const k of new Set(form.keys())) {
    const all = form.getAll(k);
    if (all.length > 1) return 'duplicate';
    out[k] = all[0];
  }
  return out;
}

/** Client credentials from HTTP Basic (RFC 6749 2.3.1) or the body. */
function clientCredentials(c: Context, params: Record<string, string>): { id?: string; secret?: string; basic: boolean } {
  const h = c.req.header('authorization') ?? '';
  const m = /^Basic\s+(\S+)$/i.exec(h.trim());
  if (m) {
    try {
      const raw = Buffer.from(m[1], 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i > 0) return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)), basic: true };
    } catch {
      /* fall through to the body */
    }
  }
  return { id: params.client_id, secret: params.client_secret, basic: false };
}

function scopeList(list: readonly OAuthScope[]): Array<{ id: OAuthScope; label: string }> {
  return SCOPES.filter((s) => list.includes(s)).map((id) => ({ id, label: SCOPE_WORDS[id] }));
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function registerOAuthRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const oauth = ctx.oauth;
  const store = oauth.store;

  // metadata, registration, token and revocation carry no cookies: any origin may call them (browser based MCP clients do)
  const open = cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 });
  for (const p of [`${PRM_PATH}`, `${PRM_PATH}/*`, '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke']) app.use(p, open);

  // ----- discovery -------------------------------------------------------------

  const prm = (c: Context<HonoEnv>) => {
    const issuer = issuerFor(c.req.raw);
    return c.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Conclave',
    });
  };
  app.get(PRM_PATH, prm);
  app.get(`${PRM_PATH}/mcp`, prm);

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const issuer = issuerFor(c.req.raw);
    const methods: AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'];
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: [...SCOPES, OFFLINE_ACCESS],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: methods,
      token_endpoint_auth_signing_alg_values_supported: [...ASSERTION_ALGS],
      revocation_endpoint_auth_methods_supported: methods,
      revocation_endpoint_auth_signing_alg_values_supported: [...ASSERTION_ALGS],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  // ----- dynamic client registration (RFC 7591) ----------------------------------

  app.post('/oauth/register', async (c) => {
    const slow = limited(c, oauth.registerLimiter);
    if (slow) return slow;
    if (!secureOrigin(issuerFor(c.req.raw))) return oauthError(c, 400, 'invalid_request', "Register through the hub's https address.");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(c, PUBLIC_BODY_MAX)) || '{}') as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return oauthError(c, 400, 'invalid_client_metadata', 'The body must be a JSON object.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError(c, 400, 'invalid_client_metadata', 'The body must be a JSON object.');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris must list at least one URI.');
    if (uris.length > 10) return oauthError(c, 400, 'invalid_redirect_uri', 'At most 10 redirect URIs.');
    for (const u of uris) {
      const problem = redirectProblem(u);
      if (problem) return oauthError(c, 400, 'invalid_redirect_uri', problem);
    }
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
    if (!grants.includes('authorization_code') || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      return oauthError(c, 400, 'invalid_client_metadata', 'grant_types may be authorization_code and refresh_token only.');
    }
    const responses = Array.isArray(body.response_types) ? body.response_types : ['code'];
    if (responses.some((r) => r !== 'code')) return oauthError(c, 400, 'invalid_client_metadata', 'response_types may be code only.');
    // RFC 7591 makes client_secret_basic the default when the client names none
    const method = (body.token_endpoint_auth_method ?? 'client_secret_basic') as string;
    if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic' && method !== 'private_key_jwt') {
      return oauthError(c, 400, 'invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post, client_secret_basic or private_key_jwt.');
    }
    // private_key_jwt brings its public keys, at a jwks_uri or inline, as a client document does
    const keys = method === 'private_key_jwt' ? keySource(body, 'The registration details') : {};
    if (typeof keys === 'string') return oauthError(c, 400, 'invalid_client_metadata', keys);
    const asked = typeof body.scope === 'string' ? parseScopes(body.scope) : [];
    const name = cleanName(body.client_name) || 'Unnamed app';
    const appType = body.application_type === 'native' ? 'native' : 'web';
    const { client, secret } = store.register({ name, redirectUris: uris as string[], applicationType: appType, authMethod: method as AuthMethod, ...keys, ...(asked.length ? { scope: asked } : {}) });
    const hosts = [...new Set(client.redirectUris.map(hostOf))].join(', ');
    audit(ctx, `ip:${clientIp(c)}`, 'oauth.register', `${name} (${hosts}) registered as ${client.id}`);
    return c.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: client.authMethod,
        ...(client.jwksUri ? { jwks_uri: client.jwksUri } : {}),
        ...(client.jwks ? { jwks: { keys: client.jwks } } : {}),
        ...(client.authAlg ? { token_endpoint_auth_signing_alg: client.authAlg } : {}),
        application_type: client.applicationType,
        ...(client.scope ? { scope: scopeText(client.scope) } : {}),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      },
      201,
      NO_STORE,
    );
  });

  // ----- authorize ----------------------------------------------------------------------

  /** Read a client's metadata document now and save what it says, or a sentence saying why not. */
  async function readDocument(clientId: string): Promise<OAuthClient | string> {
    try {
      const doc = await fetchClientDocument(clientId, oauth.cimd);
      return store.upsertDocumentClient({ url: clientId, ...doc });
    } catch (err) {
      return err instanceof CimdError ? err.message : 'The hub could not read the app details.';
    }
  }

  /** The client for a client_id: a registration, or a metadata document fetched (again) now. */
  async function resolveClient(clientId: string): Promise<OAuthClient | string> {
    if (isDocumentUrl(clientId)) {
      const cur = store.byClientId(clientId);
      if (cur && cur.fetchedAt && oauth.now() - cur.fetchedAt < DOCUMENT_TTL_MS) return cur;
      return readDocument(clientId);
    }
    return store.byClientId(clientId) ?? 'This app is not registered with this hub, or it was revoked. Remove the connector in the app and add it again.';
  }

  // ----- client authentication (token and revocation) -----------------------------------

  /** A private_key_jwt client's public keys. force: fetch them again, after an unknown kid. */
  async function clientKeys(client: OAuthClient, force: boolean): Promise<PublicJwk[]> {
    if (client.jwksUri) return oauth.jwks.get(client.jwksUri, oauth.cimd, force);
    // inline keys live in the client document: an unknown kid reads it again, at most once a minute
    if (force && client.kind === 'cimd' && oauth.now() - (client.fetchedAt ?? 0) >= JWKS_REFETCH_MS) {
      const fresh = await readDocument(client.clientId);
      if (typeof fresh === 'string') throw new CimdError(fresh);
      if (fresh.authMethod !== 'private_key_jwt') return [];
      return fresh.jwksUri ? oauth.jwks.get(fresh.jwksUri, oauth.cimd) : (fresh.jwks ?? []);
    }
    return client.jwks ?? [];
  }

  /**
   * aud values that name this hub (RFC 7523 3): the issuer, the token
   * endpoint and the endpoint called, for each origin that is this hub
   * whatever the request's headers say (ownOrigins). An app like ChatGPT signs
   * for every server with the same key, so a header must not let a stranger
   * pass off an assertion made for another server as one made for this hub.
   */
  function audiences(c: Context, path: string): string[] {
    const out = new Set<string>();
    for (const o of ownOrigins(ctx, c)) for (const a of [o, `${o}/oauth/token`, `${o}${path}`]) out.add(a);
    return [...out];
  }

  /**
   * Who is calling the token or revocation endpoint: a public client by its
   * client_id, a client secret (Basic or the body), or a private_key_jwt
   * client_assertion. A client registered for private_key_jwt must send the
   * assertion; any other client that sends one is refused, not ignored,
   * because the app and the hub then disagree about how it signs in.
   * Returns the client, or the 401 to send.
   */
  async function authenticateClient(c: Context, params: Record<string, string>, path: string, unknownClient: string): Promise<OAuthClient | Response> {
    const cred = clientCredentials(c, params);
    const deny = (description: string, failed?: string) => {
      if (failed !== undefined) countFailure(ctx, c, failed);
      return oauthError(c, 401, 'invalid_client', description, cred.basic ? { 'www-authenticate': 'Basic realm="conclave"' } : {});
    };
    const assertion = params.client_assertion;
    if (assertion === undefined && params.client_assertion_type === undefined) {
      const named = cred.id ? store.byClientId(cred.id) : undefined;
      if (named?.authMethod === 'private_key_jwt') {
        return deny(`This app signs in with private_key_jwt: send client_assertion_type ${JWT_BEARER} and a client_assertion signed with its key.`, `client:${cred.id}:${cred.secret ?? ''}`);
      }
      const client = store.authenticate(cred.id, cred.secret);
      if (!client) return deny(unknownClient, `client:${cred.id ?? ''}:${cred.secret ?? ''}`);
      return client;
    }
    if (params.client_assertion_type !== JWT_BEARER) return deny(`client_assertion_type must be ${JWT_BEARER}.`);
    if (!assertion) return deny('client_assertion is missing.');
    // one way to authenticate per request (RFC 6749 2.3)
    if (cred.basic || cred.secret !== undefined) return deny('Send a client_assertion or a client secret, not both.');
    const clientId = cred.id ?? assertionSubject(assertion);
    const client = clientId ? store.byClientId(clientId) : undefined;
    if (!client) return deny(unknownClient, `client:${clientId ?? ''}:assertion`);
    if (client.authMethod !== 'private_key_jwt') return deny('This app is not registered for private_key_jwt, so the hub takes no client_assertion from it.');
    const result = await verifyClientAssertion(assertion, {
      clientId: client.clientId,
      audiences: audiences(c, path),
      nowMs: oauth.now(),
      ...(client.authAlg ? { alg: client.authAlg } : {}),
      keys: (force) => clientKeys(client, force),
    });
    if (!result.ok) return deny(result.reason, `assertion:${assertion}`);
    // each assertion works once: its jti is kept until it expires
    if (!store.useAssertion(client.clientId, result.jti, (result.exp + CLOCK_SKEW_S) * 1000)) {
      log.warn(`a client assertion for ${client.name} was used twice; refused`);
      audit(ctx, `oauth:${client.id}`, 'oauth.replay', `a client assertion for ${client.name} was used twice; refused`);
      return deny('This client_assertion was already used. Sign a new one, with a new jti, for each request.', `assertion:${assertion}`);
    }
    return client;
  }

  app.get('/oauth/authorize', async (c) => {
    const slow = limited(c, oauth.authorizeLimiter);
    if (slow) return errorPage('Too many sign in attempts', 'Wait a minute, then start again from the app.', 429);
    const issuer = issuerFor(c.req.raw);
    if (!secureOrigin(issuer)) return errorPage('Use the https address', "Signing in an app needs the hub's https address: the stable tunnel or your own URL. Add the connector again with that address.");
    const url = new URL(c.req.url);
    const q = url.searchParams;
    for (const k of new Set(q.keys())) if (k !== 'resource' && q.getAll(k).length > 1) return errorPage('This sign in link is broken', `It names ${k} more than once. Start again from the app.`);
    const clientId = q.get('client_id');
    if (!clientId) return errorPage('This sign in link is broken', 'It has no client_id. Start again from the app.');
    const client = await resolveClient(clientId);
    if (typeof client === 'string') return errorPage('This app cannot sign in', client);
    const given = q.get('redirect_uri');
    let redirectUri: string | undefined;
    if (given !== null) redirectUri = matchRedirect(client.redirectUris, given);
    else if (client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
    if (!redirectUri) {
      return errorPage('This app cannot sign in', "The address it wants to send you back to is not one it registered. Conclave stopped here and sent nothing. Remove the connector in the app and add it again.");
    }

    // from here on, errors go back to the app on the checked redirect URI, with state and iss
    const state = q.get('state') ?? undefined;
    const fail = (error: string, description: string) => c.redirect(answerUrl(redirectUri!, { error, error_description: description, state, iss: issuer }), 302);
    if (state !== undefined && state.length > 2048) return fail('invalid_request', 'state is longer than 2048 characters.');
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code.');
    const challenge = q.get('code_challenge');
    if (!challenge) return fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method S256.');
    if (q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256. plain is not accepted.');
    if (!validPkceValue(challenge)) return fail('invalid_request', 'code_challenge must be 43 to 128 characters of base64url.');
    const resources = q.getAll('resource');
    if (resources.length > 1) return fail('invalid_target', 'Ask for one resource: this hub serves only /mcp.');
    const resource = resources[0] ?? `${issuer}/mcp`;
    if (!isHubResource(ctx, c.req.raw, resource)) return fail('invalid_target', `This hub serves ${issuer}/mcp only.`);
    const rawScope = q.get('scope');
    const asked = parseScopes(rawScope);
    if (client.scope && asked.some((s) => !client.scope!.includes(s))) return fail('invalid_scope', `This app registered for ${scopeText(client.scope)} only.`);
    // no known scope asked for (none, or only offline_access and words we do not know): what the app registered for, else all three
    const scope: OAuthScope[] = asked.length ? asked : (client.scope ?? [...SCOPES]);
    const req = store.createRequest({ client: client.id, redirectUri, redirectGiven: given !== null, state, challenge, scope, resource, issuer });
    const res = c.redirect(`${issuer}${CONSENT_PATH}?request=${encodeURIComponent(req.id)}`, 302);
    res.headers.set('cache-control', 'no-store');
    return res;
  });

  // ----- consent (the web app, owner token) -------------------------------------------

  const requestDto = (req: PendingRequest, client: OAuthClient, consent: string): OAuthConsentDto => {
    const host = hostOf(req.redirectUri);
    const identity = client.kind === 'cimd' ? hostOf(client.clientId) : undefined;
    const warning = nameWarning(client.name, req.redirectUri, client.redirectUris);
    return {
      id: req.id,
      app: { name: client.name, host, ...(identity ? { identity } : {}), kind: client.kind, loopback: isLoopbackHost(host), ...(warning ? { warning } : {}) },
      redirectUri: req.redirectUri,
      scopes: scopeList(req.scope),
      expiresAt: req.expiresAt,
      consent,
    };
  };

  const gone = "This sign in request expired or was already answered. Start again from the app.";

  app.get('/api/oauth/requests/:id', (c) => {
    const req = store.request(c.req.param('id'));
    const client = req && store.client(req.client);
    if (!req || !client) return c.json({ error: gone }, 404, NO_STORE);
    const consent = store.consentValue(req.id);
    if (!consent) return c.json({ error: gone }, 404, NO_STORE);
    return c.json(requestDto(req, client, consent), 200, NO_STORE);
  });

  app.post('/api/oauth/requests/:id', async (c) => {
    let body: { decision?: unknown; consent?: unknown; scopes?: unknown };
    try {
      body = JSON.parse((await c.req.text()) || '{}');
    } catch {
      return c.json({ error: 'The body must be JSON.' }, 400);
    }
    if (body.decision !== 'allow' && body.decision !== 'deny') return c.json({ error: 'decision must be allow or deny.' }, 400);
    const id = c.req.param('id');
    const open = store.request(id);
    if (!open) return c.json({ error: gone }, 404, NO_STORE);
    let granted: OAuthScope[] = open.scope;
    if (body.decision === 'allow' && body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string')) return c.json({ error: 'scopes must be a list.' }, 400);
      const picked = body.scopes as string[];
      // consent can leave scopes out, never add one
      if (picked.some((s) => !open.scope.includes(s as OAuthScope))) return c.json({ error: 'Only the scopes the app asked for can be allowed.' }, 400);
      granted = SCOPES.filter((s) => picked.includes(s));
      if (!granted.length) return c.json({ error: 'Pick at least one thing to allow, or press Deny.' }, 400);
    }
    const req = store.decide(id, body.consent);
    if (req === 'stale') return c.json({ error: 'This consent page is out of date. Reload it and choose again.' }, 403, NO_STORE);
    if (!req) return c.json({ error: gone }, 404, NO_STORE);
    const client = store.client(req.client);
    if (!client) return c.json({ error: gone }, 404, NO_STORE);
    const host = hostOf(req.redirectUri);
    if (body.decision === 'deny') {
      audit(ctx, actorOf(c), 'oauth.consent', `denied ${client.name} (${host})`, c.get('auth')?.accountId);
      return c.json({ redirect: answerUrl(req.redirectUri, { error: 'access_denied', error_description: 'The owner said no.', state: req.state, iss: req.issuer }) }, 200, NO_STORE);
    }
    // the app gets the memory and chats of the account that allowed it
    const code = store.createCode(req, granted, actorOf(c), c.get('auth')?.accountId);
    audit(ctx, actorOf(c), 'oauth.consent', `allowed ${client.name} (${host}): ${scopeText(granted)}`, c.get('auth')?.accountId);
    return c.json({ redirect: answerUrl(req.redirectUri, { code, state: req.state, iss: req.issuer }) }, 200, NO_STORE);
  });

  // ----- token ------------------------------------------------------------------------------

  app.post('/oauth/token', async (c) => {
    if (!secureOrigin(issuerFor(c.req.raw))) return oauthError(c, 400, 'invalid_request', "Use the hub's https address.");
    const params = await readParams(c);
    if (params === 'duplicate') return oauthError(c, 400, 'invalid_request', 'A parameter was sent more than once.');
    const client = await authenticateClient(c, params, '/oauth/token', 'Unknown client, or a wrong client secret. Remove the connector in the app and add it again.');
    if (client instanceof Response) return client;
    const grantType = params.grant_type;

    if (grantType === 'authorization_code') {
      const code = params.code;
      const verifier = params.code_verifier;
      if (!code) return oauthError(c, 400, 'invalid_request', 'code is required.');
      if (!verifier) return oauthError(c, 400, 'invalid_request', 'code_verifier is required (PKCE).');
      const used = store.useCode(code, client.id);
      if (!used.ok) {
        if (used.reason === 'replay') {
          log.warn(`an authorization code for ${client.name} was used twice; its tokens are revoked`);
          audit(ctx, `ip:${clientIp(c)}`, 'oauth.replay', `a code for ${used.client?.name ?? client.name} was used twice; its tokens are revoked`);
        } else if (used.reason === 'unknown') countFailure(ctx, c, code);
        return oauthError(c, 400, 'invalid_grant', 'This code is wrong, expired or already used.');
      }
      const v = used.value;
      if (v.redirectGiven ? params.redirect_uri !== v.redirectUri : params.redirect_uri !== undefined && params.redirect_uri !== v.redirectUri) {
        return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the one in the authorization request.');
      }
      if (!validPkceValue(verifier) || !pkceMatches(verifier, v.challenge)) return oauthError(c, 400, 'invalid_grant', 'code_verifier does not match the code_challenge.');
      if (params.resource !== undefined && params.resource !== v.resource) return oauthError(c, 400, 'invalid_target', 'resource does not match the authorization request.');
      const grant = store.createGrant({ id: v.grantId, client: client.id, scope: v.scope, resource: v.resource, redirectUri: v.redirectUri, approvedBy: v.approvedBy, accountId: v.accountId });
      const tokens = store.issue(grant.id, v.scope);
      audit(ctx, `oauth:${client.id}`, 'oauth.token', `first tokens for ${client.name} (${hostOf(v.redirectUri)}): ${scopeText(v.scope)}`);
      return c.json(tokenBody(tokens), 200, NO_STORE);
    }

    if (grantType === 'refresh_token') {
      const token = params.refresh_token;
      if (!token) return oauthError(c, 400, 'invalid_request', 'refresh_token is required.');
      let ask: OAuthScope[] | undefined;
      if (params.scope !== undefined) {
        if (unknownScopes(params.scope).length) return oauthError(c, 400, 'invalid_scope', 'A refresh can keep or narrow the scope, never widen it.');
        // only offline_access, or nothing: keep the scope the grant has
        const known = parseScopes(params.scope);
        ask = known.length ? known : undefined;
      }
      const used = store.useRefresh(token, client.id, { scope: ask, resource: params.resource });
      if (!used.ok) {
        if (used.reason === 'scope') return oauthError(c, 400, 'invalid_scope', 'A refresh can keep or narrow the scope, never widen it.');
        if (used.reason === 'target') return oauthError(c, 400, 'invalid_target', 'resource does not match the grant.');
        if (used.reason === 'replay') {
          log.warn(`a refresh token for ${used.client?.name ?? client.name} was used twice; the grant is revoked`);
          audit(ctx, `oauth:${client.id}`, 'oauth.replay', `a refresh token for ${used.client?.name ?? client.name} was used twice; that app's access is revoked`);
        } else if (used.reason === 'unknown') countFailure(ctx, c, token);
        return oauthError(c, 400, 'invalid_grant', 'This refresh token is wrong, expired or already used. Connect the app again.');
      }
      const { grant, scope } = used.value;
      const tokens = store.issue(grant.id, scope);
      if (store.auditDue(grant.id, REFRESH_AUDIT_MS)) audit(ctx, `oauth:${client.id}`, 'oauth.token', `refreshed tokens for ${client.name}: ${scopeText(scope)}`);
      return c.json(tokenBody(tokens), 200, NO_STORE);
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
  });

  // ----- revocation (RFC 7009) ----------------------------------------------------------------

  app.post('/oauth/revoke', async (c) => {
    const params = await readParams(c);
    if (params === 'duplicate') return oauthError(c, 400, 'invalid_request', 'A parameter was sent more than once.');
    const client = await authenticateClient(c, params, '/oauth/revoke', 'Unknown client, or a wrong client secret.');
    if (client instanceof Response) return client;
    if (params.token) {
      const done = store.revokeToken(params.token, client.id);
      if (done) audit(ctx, `oauth:${client.id}`, 'oauth.revoke', `${client.name} revoked its ${done.kind === 'refresh' ? 'access' : 'access token'}`);
    }
    // RFC 7009: the same answer for unknown tokens
    return c.body(null, 200, NO_STORE);
  });

  // ----- Settings > Connected apps --------------------------------------------------------------

  app.get('/api/oauth/apps', (c) => {
    const list: ConnectedAppDto[] = store.connected(c.get('auth')?.accountId).map(({ client, grants }) => {
      const scope = SCOPES.filter((s) => grants.some((g) => g.scope.includes(s)));
      const last = Math.max(client.lastUsedAt ?? 0, ...grants.map((g) => g.lastUsedAt ?? 0));
      return {
        id: client.id,
        name: client.name,
        host: hostOf(grants[0]?.redirectUri ?? client.redirectUris[0] ?? ''),
        ...(client.kind === 'cimd' ? { identity: hostOf(client.clientId) } : {}),
        kind: client.kind,
        scopes: scopeList(scope),
        createdAt: Math.min(...grants.map((g) => g.createdAt)),
        ...(last ? { lastUsedAt: last } : {}),
      };
    });
    return c.json(list);
  });

  app.delete('/api/oauth/apps/:id', (c) => {
    const client = store.removeClient(c.req.param('id'), c.get('auth')?.accountId);
    if (!client) return c.json({ error: 'That app is not connected any more. Reload the list.' }, 404);
    audit(ctx, actorOf(c), 'oauth.revoke', `revoked ${client.name} (${[...new Set(client.redirectUris.map(hostOf))].join(', ')})`, c.get('auth')?.accountId);
    return c.json({ ok: true as const });
  });
}

function tokenBody(t: { accessToken: string; refreshToken: string; expiresIn: number; scope: OAuthScope[] }) {
  return { access_token: t.accessToken, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: scopeText(t.scope) };
}
