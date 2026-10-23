import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '@conclave/core/storage/db.ts';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { GatewayKey } from '@conclave/core/storage/repos.ts';
import { newId } from '@conclave/core/util/ids.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import type { AccountRole } from '@conclave/core/people/store.ts';

export const GATEWAY_KEY_PREFIX = 'cgw_';
export const CLIENT_TOKEN_PREFIX = 'ccl_';
export const DEVICE_TOKEN_PREFIX = 'cdv_';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time string compare. Hashing first makes lengths equal and hides them. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function randomToken(prefix = '', bytes = 24): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

/**
 * Who made a request (docs/design/ACCOUNTS.md 4). kind: the hub token
 * ("owner") or a paired app ("client"). accountId and role: whose request it
 * is; the hub token is the owner's, a paired app is the account that paired it.
 */
export interface AuthInfo {
  kind: 'owner' | 'client';
  /** "owner" or the clients table id. Used for notifier.touch. */
  clientId: string;
  name?: string;
  accountId: string;
  role: AccountRole;
}

export interface ClientRow {
  id: string;
  name: string;
  platform?: string;
  createdAt: number;
  lastSeenAt?: number;
  revoked: boolean;
  /** The account the app signed in as. */
  accountId: string;
}

/**
 * Paired client tokens (phones, desktop app, TUI on another box). There is no
 * repo for the clients table in core yet, so this talks to the db directly.
 */
export class ClientStore {
  private lastTouch = new Map<string, number>();

  constructor(private readonly db: Db) {}

  create(input: { name: string; platform?: string; accountId?: string }): { id: string; token: string } {
    const id = newId('cli');
    const token = randomToken(CLIENT_TOKEN_PREFIX);
    this.db
      .query('INSERT INTO clients (id, name, platform, token_hash, created_at, last_seen_at, account_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.name.slice(0, 120), input.platform?.slice(0, 40) ?? null, sha256(token), Date.now(), Date.now(), input.accountId ?? OWNER_ID);
    return { id, token };
  }

  /** Look up a token. The hash lookup is indexed by value, so no timing leak on the secret. */
  find(token: string): ClientRow | undefined {
    const r = this.db.query('SELECT * FROM clients WHERE token_hash = ? AND revoked = 0').get(sha256(token)) as Record<string, any> | null;
    if (!r) return undefined;
    const now = Date.now();
    if (now - (this.lastTouch.get(r.id) ?? 0) > 60_000) {
      this.lastTouch.set(r.id, now);
      this.db.query('UPDATE clients SET last_seen_at = ? WHERE id = ?').run(now, r.id);
    }
    return toClient(r);
  }

  /** One account's apps (every app when left out). */
  list(accountId?: string): ClientRow[] {
    const rows = accountId ? this.db.query('SELECT * FROM clients WHERE account_id = ? ORDER BY created_at DESC').all(accountId) : this.db.query('SELECT * FROM clients ORDER BY created_at DESC').all();
    return (rows as Record<string, any>[]).map(toClient);
  }

  get(id: string): ClientRow | undefined {
    const r = this.db.query('SELECT * FROM clients WHERE id = ?').get(id) as Record<string, any> | null;
    return r ? toClient(r) : undefined;
  }

  revoke(id: string): boolean {
    return this.db.query('UPDATE clients SET revoked = 1 WHERE id = ?').run(id).changes > 0;
  }

  /** Revoke every app of an account (a removed person, a reset password). Returns their ids. */
  revokeAccount(accountId: string): string[] {
    const ids = (this.db.query('SELECT id FROM clients WHERE account_id = ? AND revoked = 0').all(accountId) as Array<{ id: string }>).map((r) => r.id);
    this.db.query('UPDATE clients SET revoked = 1 WHERE account_id = ?').run(accountId);
    return ids;
  }
}

function toClient(r: Record<string, any>): ClientRow {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform ?? undefined,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? undefined,
    revoked: !!r.revoked,
    accountId: r.account_id ?? OWNER_ID,
  };
}

/** Pull a bearer token from the Authorization header, or ?token= when allowed. */
export function bearerToken(req: Request, url: URL, allowQuery: boolean): string | undefined {
  const h = req.headers.get('authorization');
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (m) return m[1].trim();
  }
  if (allowQuery) return url.searchParams.get('token') ?? undefined;
  return undefined;
}

export class Auth {
  readonly clients: ClientStore;

  constructor(private readonly engine: EngineApi) {
    this.clients = new ClientStore(engine.repos.db);
  }

  /** Owner or paired client token, and whose it is. Device and gateway tokens never pass here. */
  check(token: string | undefined): AuthInfo | undefined {
    if (!token) return undefined;
    const owner = this.engine.config.get().server.token;
    if (owner && safeEqual(token, owner)) return { kind: 'owner', clientId: 'owner', accountId: OWNER_ID, role: 'owner' };
    if (!token.startsWith(CLIENT_TOKEN_PREFIX)) return undefined;
    const c = this.clients.find(token);
    if (!c) return undefined;
    // an app of a removed person stops working, even if its row was missed
    const account = this.engine.people.get(c.accountId);
    if (!account) return undefined;
    return { kind: 'client', clientId: c.id, name: c.name, accountId: account.id, role: account.role };
  }

  isOwner(token: string | undefined): boolean {
    const owner = this.engine.config.get().server.token;
    return !!token && !!owner && safeEqual(token, owner);
  }

  /** Daemon login. Returns the device id when the token matches the stored hash. */
  checkDevice(deviceId: string | undefined, token: string | undefined): string | undefined {
    if (!deviceId || !token) return undefined;
    const stored = this.engine.repos.devices.tokenHash(deviceId);
    if (!stored) {
      // burn the same time as a real compare so ids cannot be probed
      safeEqual(sha256(token), sha256(''));
      return undefined;
    }
    return safeEqual(sha256(token), stored) ? deviceId : undefined;
  }

  checkGatewayKey(key: string | undefined): GatewayKey | undefined {
    if (!key || !key.startsWith(GATEWAY_KEY_PREFIX)) return undefined;
    return this.engine.repos.gatewayKeys.findByHash(sha256(key));
  }

  createGatewayKey(input: { name: string; device?: string; agent?: string }): GatewayKey & { key: string } {
    const key = randomToken(GATEWAY_KEY_PREFIX, 30);
    const row: GatewayKey = {
      id: newId('gwk'),
      name: input.name.slice(0, 120),
      prefix: key.slice(0, GATEWAY_KEY_PREFIX.length + 6),
      device: input.device || undefined,
      agent: input.agent || undefined,
      createdAt: Date.now(),
      revoked: false,
    };
    this.engine.repos.gatewayKeys.insert({ ...row, keyHash: sha256(key) });
    return { ...row, key };
  }

  createDevice(name: string, accountId: string = OWNER_ID): { deviceId: string; token: string } {
    const deviceId = newId('dev');
    const token = randomToken(DEVICE_TOKEN_PREFIX, 32);
    this.engine.repos.devices.insert({ id: deviceId, name: name.slice(0, 120), tokenHash: sha256(token), accountId });
    return { deviceId, token };
  }
}

/** Fixed window counter per key. Good enough to stop pairing code guessing. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit. Returns false when the key is over the limit. */
  hit(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    e.count++;
    return e.count <= this.limit;
  }

  retryAfterSec(key: string, now = Date.now()): number {
    const e = this.hits.get(key);
    return e ? Math.max(1, Math.ceil((e.resetAt - now) / 1000)) : 0;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
