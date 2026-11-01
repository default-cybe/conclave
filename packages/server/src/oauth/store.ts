/**
 * OAuth storage for /mcp (docs/design/MCP-OAUTH.md): registered clients,
 * pending sign in requests, codes, grants and their tokens, and the client
 * assertions already used. Codes, tokens, client secrets, consent values and
 * assertion ids are kept as SHA-256 hashes; nothing here
 * can give a token back. The tables are made here, like the goal tables, so
 * the shared migration list stays as it is.
 */
import type { Db } from '@conclave/core/storage/db.ts';
import type { OAuthScope } from '@conclave/core/client/index.ts';
import { newId } from '@conclave/core/util/ids.ts';
import { ensureAccountColumn, ensureColumn } from '@conclave/core/people/tables.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import { randomToken, safeEqual, sha256 } from '../auth';
import { isAssertionAlg, type AssertionAlg, type PublicJwk } from './assertion';
import { parseScopes, scopeText } from './scopes';

export const ACCESS_PREFIX = 'cat_';
export const REFRESH_PREFIX = 'crt_';
export const CODE_PREFIX = 'cac_';
export const SECRET_PREFIX = 'ccs_';
export const CLIENT_ID_PREFIX = 'ccid_';

export const REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 3_600_000;
/** Registrations that never got consent go after this. */
export const UNUSED_CLIENT_TTL_MS = 24 * 3_600_000;
/** At most this many registrations without consent are kept. */
export const MAX_UNUSED_CLIENTS = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  application_type TEXT NOT NULL DEFAULT 'web',
  auth_method TEXT NOT NULL DEFAULT 'none',
  secret_hash TEXT,
  jwks_uri TEXT,
  jwks TEXT,
  auth_alg TEXT,
  scope TEXT,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER,
  consented_at INTEGER,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  redirect_given INTEGER NOT NULL,
  state TEXT,
  challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  issuer TEXT NOT NULL,
  consent_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  redirect_given INTEGER NOT NULL,
  challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_audit_at INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants(client);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE TABLE IF NOT EXISTS oauth_assertions (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

type Row = Record<string, any>;

export type ClientKind = 'dcr' | 'cimd';
export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic' | 'private_key_jwt';

export interface OAuthClient {
  /** Our row id (oac_...). */
  id: string;
  /** What the client sends: ccid_... for a registration, the document URL for a metadata document. */
  clientId: string;
  kind: ClientKind;
  name: string;
  redirectUris: string[];
  applicationType: 'web' | 'native';
  authMethod: AuthMethod;
  /** private_key_jwt: where its public keys are, a URL or the keys themselves. */
  jwksUri?: string;
  jwks?: PublicJwk[];
  /** private_key_jwt: the one signing algorithm it said it uses, if it said. */
  authAlg?: AssertionAlg;
  /** Scopes it registered for; undefined means any. */
  scope?: OAuthScope[];
  createdAt: number;
  fetchedAt?: number;
  consentedAt?: number;
  lastUsedAt?: number;
}

export interface PendingRequest {
  id: string;
  client: string;
  redirectUri: string;
  redirectGiven: boolean;
  state?: string;
  challenge: string;
  scope: OAuthScope[];
  resource: string;
  issuer: string;
  createdAt: number;
  expiresAt: number;
}

export interface Grant {
  id: string;
  client: string;
  /** The account that allowed it: the app reads and writes that account's memory and chats (docs/design/ACCOUNTS.md). */
  accountId: string;
  scope: OAuthScope[];
  resource: string;
  redirectUri: string;
  approvedBy: string;
  createdAt: number;
  lastUsedAt?: number;
  lastAuditAt?: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: OAuthScope[];
}

/** What a valid access token stands for. */
export interface AccessInfo {
  grant: Grant;
  client: OAuthClient;
  scope: OAuthScope[];
  resource: string;
}

/** The outcome of using a code or a refresh token. */
export type Redeem<T> = { ok: true; value: T } | { ok: false; reason: 'unknown' | 'expired' | 'mismatch' | 'replay' | 'scope' | 'target'; grant?: Grant; client?: OAuthClient };

function parseKeys(raw: unknown): PublicJwk[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as PublicJwk[]) : undefined;
  } catch {
    return undefined;
  }
}

function toClient(r: Row): OAuthClient {
  const jwks = parseKeys(r.jwks);
  return {
    id: r.id,
    clientId: r.client_id,
    kind: r.kind,
    name: r.name,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    applicationType: r.application_type === 'native' ? 'native' : 'web',
    authMethod: r.auth_method,
    ...(r.jwks_uri ? { jwksUri: r.jwks_uri } : {}),
    ...(jwks ? { jwks } : {}),
    ...(isAssertionAlg(r.auth_alg) ? { authAlg: r.auth_alg } : {}),
    ...(r.scope ? { scope: parseScopes(r.scope) } : {}),
    createdAt: r.created_at,
    ...(r.fetched_at ? { fetchedAt: r.fetched_at } : {}),
    ...(r.consented_at ? { consentedAt: r.consented_at } : {}),
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  };
}

/** A private_key_jwt client's keys, as given by its document or registration. */
export interface KeyFields {
  jwksUri?: string;
  jwks?: PublicJwk[];
  authAlg?: AssertionAlg;
}

/** The key columns for a client: only a private_key_jwt client has any. */
function keyColumns(method: AuthMethod, k: KeyFields): { jwksUri: string | null; jwks: string | null; alg: string | null } {
  if (method !== 'private_key_jwt') return { jwksUri: null, jwks: null, alg: null };
  return { jwksUri: k.jwksUri ?? null, jwks: k.jwks ? JSON.stringify(k.jwks) : null, alg: k.authAlg ?? null };
}

function toRequest(r: Row): PendingRequest {
  return {
    id: r.id,
    client: r.client,
    redirectUri: r.redirect_uri,
    redirectGiven: !!r.redirect_given,
    ...(r.state !== null && r.state !== undefined ? { state: r.state } : {}),
    challenge: r.challenge,
    scope: parseScopes(r.scope),
    resource: r.resource,
    issuer: r.issuer,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function toGrant(r: Row): Grant {
  return {
    id: r.id,
    client: r.client,
    accountId: r.account_id ?? OWNER_ID,
    scope: parseScopes(r.scope),
    resource: r.resource,
    redirectUri: r.redirect_uri,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
    ...(r.last_audit_at ? { lastAuditAt: r.last_audit_at } : {}),
  };
}

export class OAuthStore {
  private lastPrune = 0;
  private touched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    // a code and a grant belong to the account that allowed the app (people/tables.ts)
    ensureAccountColumn(this.db, 'oauth_codes');
    ensureAccountColumn(this.db, 'oauth_grants');
    // private_key_jwt clients (assertion.ts); tables made before it lack these
    for (const col of ['jwks_uri', 'jwks', 'auth_alg']) ensureColumn(this.db, 'oauth_clients', col, 'TEXT');
  }

  // ----- clients -------------------------------------------------------------

  /**
   * A dynamic registration (RFC 7591). Returns the secret once, for clients
   * that authenticate with one. A private_key_jwt client gets no secret: it
   * brings its public keys.
   */
  register(input: { name: string; redirectUris: string[]; applicationType: 'web' | 'native'; authMethod: AuthMethod; scope?: OAuthScope[] } & KeyFields): { client: OAuthClient; secret?: string } {
    this.prune();
    this.makeRoom();
    const id = newId('oac');
    const clientId = randomToken(CLIENT_ID_PREFIX, 18);
    const secret = input.authMethod === 'client_secret_post' || input.authMethod === 'client_secret_basic' ? randomToken(SECRET_PREFIX, 32) : undefined;
    const k = keyColumns(input.authMethod, input);
    this.db
      .query('INSERT INTO oauth_clients (id, client_id, kind, name, redirect_uris, application_type, auth_method, secret_hash, jwks_uri, jwks, auth_alg, scope, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, clientId, 'dcr', input.name, JSON.stringify(input.redirectUris), input.applicationType, input.authMethod, secret ? sha256(secret) : null, k.jwksUri, k.jwks, k.alg, input.scope ? scopeText(input.scope) : null, this.now());
    return { client: this.client(id)!, ...(secret ? { secret } : {}) };
  }

  /** Save or refresh a client known by its metadata document URL. Each read of the document decides how it authenticates. */
  upsertDocumentClient(input: { url: string; name: string; redirectUris: string[]; applicationType: 'web' | 'native'; scope?: OAuthScope[]; authMethod?: 'none' | 'private_key_jwt' } & KeyFields): OAuthClient {
    const now = this.now();
    const method = input.authMethod ?? 'none';
    const k = keyColumns(method, input);
    const cur = this.byClientId(input.url);
    if (cur) {
      this.db
        .query('UPDATE oauth_clients SET name = ?, redirect_uris = ?, application_type = ?, auth_method = ?, jwks_uri = ?, jwks = ?, auth_alg = ?, scope = ?, fetched_at = ? WHERE id = ?')
        .run(input.name, JSON.stringify(input.redirectUris), input.applicationType, method, k.jwksUri, k.jwks, k.alg, input.scope ? scopeText(input.scope) : null, now, cur.id);
      return this.client(cur.id)!;
    }
    this.makeRoom();
    const id = newId('oac');
    this.db
      .query('INSERT INTO oauth_clients (id, client_id, kind, name, redirect_uris, application_type, auth_method, jwks_uri, jwks, auth_alg, scope, created_at, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.url, 'cimd', input.name, JSON.stringify(input.redirectUris), input.applicationType, method, k.jwksUri, k.jwks, k.alg, input.scope ? scopeText(input.scope) : null, now, now);
    return this.client(id)!;
  }

  /** Keep the pile of clients that never got consent small, registered or known by a document URL: drop the oldest. */
  private makeRoom(): void {
    const unused = (this.db.query('SELECT COUNT(*) AS n FROM oauth_clients WHERE consented_at IS NULL').get() as Row).n as number;
    if (unused < MAX_UNUSED_CLIENTS) return;
    this.db
      .query('DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE consented_at IS NULL ORDER BY created_at ASC LIMIT ?)')
      .run(unused - MAX_UNUSED_CLIENTS + 1);
  }

  client(id: string): OAuthClient | undefined {
    const r = this.db.query('SELECT * FROM oauth_clients WHERE id = ?').get(id) as Row | null;
    return r ? toClient(r) : undefined;
  }

  byClientId(clientId: string): OAuthClient | undefined {
    const r = this.db.query('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as Row | null;
    return r ? toClient(r) : undefined;
  }

  /**
   * Client authentication at the token and revocation endpoints, for public
   * clients and client secrets. A private_key_jwt client never passes here:
   * index.ts checks its client_assertion instead.
   */
  authenticate(clientId: string | undefined, secret: string | undefined): OAuthClient | undefined {
    if (!clientId) return undefined;
    const r = this.db.query('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as Row | null;
    if (!r) {
      safeEqual(sha256(secret ?? ''), sha256('x'));
      return undefined;
    }
    if (r.auth_method === 'none') return toClient(r);
    if (r.auth_method === 'private_key_jwt') return undefined;
    if (!secret || !r.secret_hash || !safeEqual(sha256(secret), r.secret_hash)) return undefined;
    return toClient(r);
  }

  /**
   * Remember a client assertion's jti until keepUntil (its exp plus the clock
   * skew). False when this client already used it: a replay. Only a hash of
   * client and jti is kept.
   */
  useAssertion(clientId: string, jti: string, keepUntil: number): boolean {
    const key = sha256(`${clientId}\n${jti}`);
    const now = this.now();
    this.db.query('DELETE FROM oauth_assertions WHERE key = ? AND expires_at <= ?').run(key, now);
    return this.db.query('INSERT OR IGNORE INTO oauth_assertions (key, expires_at) VALUES (?, ?)').run(key, Math.max(keepUntil, now + 1)).changes > 0;
  }

  // ----- pending requests and consent -------------------------------------------

  createRequest(input: Omit<PendingRequest, 'id' | 'createdAt' | 'expiresAt'>): PendingRequest {
    this.prune();
    const now = this.now();
    const id = randomToken('oar_', 18);
    this.db
      .query('INSERT INTO oauth_requests (id, client, redirect_uri, redirect_given, state, challenge, scope, resource, issuer, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.client, input.redirectUri, input.redirectGiven ? 1 : 0, input.state ?? null, input.challenge, scopeText(input.scope), input.resource, input.issuer, now, now + REQUEST_TTL_MS);
    return this.request(id)!;
  }

  /** A request that is still open. */
  request(id: string): PendingRequest | undefined {
    const r = this.db.query('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?').get(id, this.now()) as Row | null;
    return r ? toRequest(r) : undefined;
  }

  /** A new one time consent value for the page that shows this request. The last one stops working. */
  consentValue(id: string): string | undefined {
    const value = randomToken('', 24);
    const res = this.db.query('UPDATE oauth_requests SET consent_hash = ? WHERE id = ? AND expires_at > ?').run(sha256(value), id, this.now());
    return res.changes ? value : undefined;
  }

  /**
   * Close a request with its consent value: it can be decided once. Returns
   * the request, 'stale' when the value is wrong, or undefined when the
   * request is gone.
   */
  decide(id: string, consent: unknown): PendingRequest | 'stale' | undefined {
    const r = this.db.query('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?').get(id, this.now()) as Row | null;
    if (!r) return undefined;
    if (typeof consent !== 'string' || !r.consent_hash || !safeEqual(sha256(consent), r.consent_hash)) return 'stale';
    const res = this.db.query('DELETE FROM oauth_requests WHERE id = ? AND consent_hash = ?').run(id, r.consent_hash);
    return res.changes ? toRequest(r) : undefined;
  }

  // ----- codes ----------------------------------------------------------------------

  createCode(req: PendingRequest, scope: OAuthScope[], approvedBy: string, accountId: string = OWNER_ID): string {
    const code = randomToken(CODE_PREFIX, 32);
    const now = this.now();
    this.db
      .query('INSERT INTO oauth_codes (hash, client, redirect_uri, redirect_given, challenge, scope, resource, grant_id, approved_by, created_at, expires_at, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(sha256(code), req.client, req.redirectUri, req.redirectGiven ? 1 : 0, req.challenge, scopeText(scope), req.resource, newId('oag'), approvedBy, now, now + CODE_TTL_MS, accountId);
    this.db.query('UPDATE oauth_clients SET consented_at = COALESCE(consented_at, ?) WHERE id = ?').run(now, req.client);
    return code;
  }

  /**
   * Use a code. It is marked used before anything else is checked, so it
   * works once whatever happens next. A code used again revokes what it made.
   */
  useCode(code: string, clientRowId: string): Redeem<{ redirectUri: string; redirectGiven: boolean; challenge: string; scope: OAuthScope[]; resource: string; grantId: string; approvedBy: string; accountId: string }> {
    const hash = sha256(code);
    const r = this.db.query('SELECT * FROM oauth_codes WHERE hash = ?').get(hash) as Row | null;
    if (!r) return { ok: false, reason: 'unknown' };
    const now = this.now();
    const marked = this.db.query('UPDATE oauth_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(now, hash).changes > 0;
    if (!marked) {
      const grant = this.grant(r.grant_id);
      if (grant) this.revokeGrant(grant.id);
      return { ok: false, reason: 'replay', grant, client: this.client(r.client) };
    }
    if (r.expires_at <= now) return { ok: false, reason: 'expired' };
    if (r.client !== clientRowId) return { ok: false, reason: 'mismatch' };
    return {
      ok: true,
      value: { redirectUri: r.redirect_uri, redirectGiven: !!r.redirect_given, challenge: r.challenge, scope: parseScopes(r.scope), resource: r.resource, grantId: r.grant_id, approvedBy: r.approved_by, accountId: r.account_id ?? OWNER_ID },
    };
  }

  // ----- grants and tokens ------------------------------------------------------------

  createGrant(input: { id: string; client: string; scope: OAuthScope[]; resource: string; redirectUri: string; approvedBy: string; accountId?: string }): Grant {
    const now = this.now();
    this.db
      .query('INSERT INTO oauth_grants (id, client, scope, resource, redirect_uri, approved_by, created_at, last_used_at, last_audit_at, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(input.id, input.client, scopeText(input.scope), input.resource, input.redirectUri, input.approvedBy, now, now, now, input.accountId ?? OWNER_ID);
    this.db.query('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?').run(now, input.client);
    return this.grant(input.id)!;
  }

  grant(id: string): Grant | undefined {
    const r = this.db.query('SELECT * FROM oauth_grants WHERE id = ?').get(id) as Row | null;
    return r ? toGrant(r) : undefined;
  }

  issue(grantId: string, scope: OAuthScope[]): IssuedTokens {
    const now = this.now();
    const accessToken = randomToken(ACCESS_PREFIX, 32);
    const refreshToken = randomToken(REFRESH_PREFIX, 32);
    const add = this.db.query('INSERT INTO oauth_tokens (hash, grant_id, kind, scope, created_at, expires_at) VALUES (?,?,?,?,?,?)');
    this.db.transaction(() => {
      add.run(sha256(accessToken), grantId, 'access', scopeText(scope), now, now + ACCESS_TTL_MS);
      add.run(sha256(refreshToken), grantId, 'refresh', scopeText(scope), now, now + REFRESH_TTL_MS);
    })();
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope };
  }

  /**
   * Use a refresh token. It works once: the caller issues the next pair. A
   * refresh token used a second time revokes the whole grant, newest tokens
   * included, because one of the two users has a stolen copy.
   */
  useRefresh(token: string, clientRowId: string, ask: { scope?: OAuthScope[]; resource?: string } = {}): Redeem<{ grant: Grant; scope: OAuthScope[] }> {
    if (!token.startsWith(REFRESH_PREFIX)) return { ok: false, reason: 'unknown' };
    const hash = sha256(token);
    const r = this.db.query("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'").get(hash) as Row | null;
    if (!r) return { ok: false, reason: 'unknown' };
    const grant = this.grant(r.grant_id);
    if (!grant) return { ok: false, reason: 'unknown' };
    const now = this.now();
    if (grant.client !== clientRowId) return { ok: false, reason: 'mismatch' };
    const held = parseScopes(r.scope);
    // a refresh may keep or narrow the scope, never widen it; checked before the token is spent
    if (ask.scope && (!ask.scope.length || ask.scope.some((s) => !held.includes(s)))) return { ok: false, reason: 'scope' };
    if (ask.resource !== undefined && ask.resource !== grant.resource) return { ok: false, reason: 'target' };
    const marked = this.db.query('UPDATE oauth_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(now, hash).changes > 0;
    if (!marked) {
      this.revokeGrant(grant.id);
      return { ok: false, reason: 'replay', grant, client: this.client(grant.client) };
    }
    if (r.expires_at <= now) return { ok: false, reason: 'expired' };
    // the access tokens of the old pair end with it
    this.db.query("DELETE FROM oauth_tokens WHERE grant_id = ? AND kind = 'access'").run(grant.id);
    this.db.query('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(now, grant.id);
    this.db.query('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?').run(now, grant.client);
    return { ok: true, value: { grant, scope: ask.scope ?? held } };
  }

  /** A live access token, its grant and client. */
  access(token: string): AccessInfo | undefined {
    if (!token.startsWith(ACCESS_PREFIX)) return undefined;
    const r = this.db.query("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access' AND expires_at > ?").get(sha256(token), this.now()) as Row | null;
    if (!r) return undefined;
    const grant = this.grant(r.grant_id);
    const client = grant && this.client(grant.client);
    if (!grant || !client) return undefined;
    const now = this.now();
    // last used, at most once a minute per grant
    if (now - (this.touched.get(grant.id) ?? 0) > 60_000) {
      this.touched.set(grant.id, now);
      this.db.query('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(now, grant.id);
      this.db.query('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?').run(now, client.id);
    }
    return { grant, client, scope: parseScopes(r.scope), resource: grant.resource };
  }

  /** RFC 7009: a refresh token ends its grant, an access token ends itself. Other clients' tokens are left alone. */
  revokeToken(token: string, clientRowId: string): { grant: Grant; kind: 'access' | 'refresh' } | undefined {
    const r = this.db.query('SELECT * FROM oauth_tokens WHERE hash = ?').get(sha256(token)) as Row | null;
    if (!r) return undefined;
    const grant = this.grant(r.grant_id);
    if (!grant || grant.client !== clientRowId) return undefined;
    if (r.kind === 'refresh') this.revokeGrant(grant.id);
    else this.db.query('DELETE FROM oauth_tokens WHERE hash = ?').run(r.hash);
    return { grant, kind: r.kind };
  }

  /** Mark when the grant's refresh was last audited, so the log gets one line a day per app. */
  auditDue(grantId: string, everyMs: number): boolean {
    const now = this.now();
    return this.db.query('UPDATE oauth_grants SET last_audit_at = ? WHERE id = ? AND (last_audit_at IS NULL OR last_audit_at <= ?)').run(now, grantId, now - everyMs).changes > 0;
  }

  revokeGrant(grantId: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM oauth_tokens WHERE grant_id = ?').run(grantId);
      this.db.query('DELETE FROM oauth_grants WHERE id = ?').run(grantId);
    })();
  }

  // ----- Settings > Connected apps ---------------------------------------------------

  /** Clients with a grant of this account that can still be used, newest first. */
  connected(accountId: string = OWNER_ID): Array<{ client: OAuthClient; grants: Grant[] }> {
    this.prune();
    const rows = this.db
      .query(
        `SELECT DISTINCT g.* FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id = g.id
         WHERE g.account_id = ? AND t.kind = 'refresh' AND t.used_at IS NULL AND t.expires_at > ? ORDER BY g.created_at DESC`,
      )
      .all(accountId, this.now()) as Row[];
    const out = new Map<string, { client: OAuthClient; grants: Grant[] }>();
    for (const r of rows) {
      const g = toGrant(r);
      const entry = out.get(g.client) ?? (() => {
        const client = this.client(g.client);
        if (!client) return undefined;
        const e = { client, grants: [] as Grant[] };
        out.set(g.client, e);
        return e;
      })();
      entry?.grants.push(g);
    }
    return [...out.values()];
  }

  /**
   * Revoke everything a client holds for this account. When no account holds
   * a grant of it any more, its registration goes too. Undefined when the
   * account has nothing of that client.
   */
  removeClient(id: string, accountId: string = OWNER_ID): OAuthClient | undefined {
    const client = this.client(id);
    if (!client) return undefined;
    const mine = this.db.query('SELECT id FROM oauth_grants WHERE client = ? AND account_id = ?').all(id, accountId) as Row[];
    const others = (this.db.query('SELECT COUNT(*) AS n FROM oauth_grants WHERE client = ? AND account_id != ?').get(id, accountId) as { n: number }).n;
    if (!mine.length && others) return undefined;
    this.db.transaction(() => {
      for (const g of mine) this.db.query('DELETE FROM oauth_tokens WHERE grant_id = ?').run(g.id);
      this.db.query('DELETE FROM oauth_grants WHERE client = ? AND account_id = ?').run(id, accountId);
      this.db.query('DELETE FROM oauth_codes WHERE client = ? AND account_id = ?').run(id, accountId);
      if (others) return;
      this.db.query('DELETE FROM oauth_codes WHERE client = ?').run(id);
      this.db.query('DELETE FROM oauth_requests WHERE client = ?').run(id);
      this.db.query('DELETE FROM oauth_clients WHERE id = ?').run(id);
    })();
    return client;
  }

  /**
   * Clear what is past use, at most once a minute: open requests, codes a
   * day after they expired (until then a replay still revokes), dead tokens,
   * grants with no tokens left, and registrations that never got consent.
   */
  prune(force = false): void {
    const now = this.now();
    if (!force && now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    this.db.transaction(() => {
      this.db.query('DELETE FROM oauth_requests WHERE expires_at <= ?').run(now);
      this.db.query('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now - 24 * 3_600_000);
      this.db.query('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
      this.db.query('DELETE FROM oauth_assertions WHERE expires_at <= ?').run(now);
      this.db.query('DELETE FROM oauth_grants WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id) AND created_at <= ?').run(now - 60_000);
      this.db
        .query('DELETE FROM oauth_clients WHERE consented_at IS NULL AND created_at <= ? AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client = oauth_clients.id)')
        .run(now - UNUSED_CLIENT_TTL_MS);
      // an app whose grants all ran out and that has not been back for 90 days
      this.db
        .query('DELETE FROM oauth_clients WHERE consented_at IS NOT NULL AND COALESCE(last_used_at, created_at) <= ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client = oauth_clients.id)')
        .run(now - 90 * 24 * 3_600_000);
    })();
  }
}
