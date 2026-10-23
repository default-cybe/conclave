/**
 * The daemon that ships inside the desktop app ("Let the hub use this computer").
 *
 *   POST /api/daemon/pairing   a device code for the computer a paired app runs on, made with the app's own token
 *   POST /api/daemon/unpair    a daemon removes itself, proved by its own device id and token
 *
 * A code made here remembers the app that asked. When the daemon registers
 * with it, the device is linked to that app: turning the switch on again
 * gives the same device a new token (so its sessions and folders keep
 * working), and revoking the app removes its device too. The link lives in
 * its own table, made here, outside the shared migrations.
 */
import type { Hono } from 'hono';
import type { Db } from '@conclave/core/storage/db.ts';
import type { HonoEnv, ServerContext } from './context';
import { notFound } from './http';
import type { AuditFn } from './routes-extensions';
import { DEVICE_TOKEN_PREFIX, bearerToken, randomToken, sha256 } from './auth';
import { OWNER_ID } from '@conclave/core/people/context.ts';

/** Short: the app uses it within a second. */
export const APP_PAIRING_TTL_MS = 2 * 60_000;

/** What /api/daemon/unpair says for a device it does not know. `conclave daemon unpair` matches it. */
export const NOT_PAIRED = 'This device is not paired with this hub.';

export class AppDevices {
  /** code -> the app (client id) that asked for it. Codes live two minutes, so memory is enough. */
  private codes = new Map<string, { clientId: string; expiresAt: number }>();

  constructor(private readonly db: Db) {
    db.exec('CREATE TABLE IF NOT EXISTS app_devices (client_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, linked_at INTEGER NOT NULL)');
  }

  remember(code: string, clientId: string, expiresAt: number): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    this.codes.set(code.trim().toUpperCase(), { clientId, expiresAt });
  }

  /** The app a code was made for, once. */
  take(code: string): string | undefined {
    const key = code.trim().toUpperCase();
    const hit = this.codes.get(key);
    this.codes.delete(key);
    return hit && hit.expiresAt > Date.now() ? hit.clientId : undefined;
  }

  deviceOf(clientId: string): string | undefined {
    const r = this.db.query('SELECT device_id FROM app_devices WHERE client_id = ?').get(clientId) as { device_id: string } | null;
    return r?.device_id;
  }

  link(clientId: string, deviceId: string): void {
    this.db.query('INSERT OR REPLACE INTO app_devices (client_id, device_id, linked_at) VALUES (?,?,?)').run(clientId, deviceId, Date.now());
  }

  forgetDevice(deviceId: string): void {
    this.db.query('DELETE FROM app_devices WHERE device_id = ?').run(deviceId);
  }

  forgetClient(clientId: string): void {
    this.db.query('DELETE FROM app_devices WHERE client_id = ?').run(clientId);
  }

  /** A new token for a device that already exists. The old one stops working; the name the owner gave it stays. */
  rekey(deviceId: string): string {
    const token = randomToken(DEVICE_TOKEN_PREFIX, 32);
    this.db.query('UPDATE devices SET token_hash = ? WHERE id = ?').run(sha256(token), deviceId);
    return token;
  }
}

const stores = new WeakMap<ServerContext, AppDevices>();

export function appDevices(ctx: ServerContext): AppDevices {
  let s = stores.get(ctx);
  if (!s) {
    s = new AppDevices(ctx.engine.repos.db);
    stores.set(ctx, s);
  }
  return s;
}

/** Remove a paired device: kick its daemon, forget it, tell the apps. */
export function removeDevice(ctx: ServerContext, id: string, reason: string): void {
  const accountId = ctx.engine.repos.devices.accountOf(id) ?? OWNER_ID;
  ctx.daemons.disconnect(id, reason);
  ctx.engine.devices.detach(id);
  ctx.engine.repos.devices.delete(id);
  appDevices(ctx).forgetDevice(id);
  ctx.engine.bus.emit({ type: 'device.deleted', deviceId: id, accountId });
}

/**
 * Register a device for a consumed device code. A code from /api/daemon/pairing
 * whose app already has a device that still exists re-keys that device.
 */
export function registerDevice(ctx: ServerContext, code: string, name: string, accountId: string = OWNER_ID): { deviceId: string; token: string; again: boolean } {
  const store = appDevices(ctx);
  const app = store.take(code);
  const known = app ? store.deviceOf(app) : undefined;
  // the same device again only for the same account: a device never changes hands
  if (app && known && ctx.engine.repos.devices.get(known) && ctx.engine.repos.devices.accountOf(known) === accountId) {
    const token = store.rekey(known);
    // a daemon still connected with the old token goes; the new one connects in a moment
    ctx.daemons.disconnect(known, 'paired again');
    return { deviceId: known, token, again: true };
  }
  const { deviceId, token } = ctx.auth.createDevice(name, accountId);
  if (app) store.link(app, deviceId);
  return { deviceId, token, again: false };
}

export function registerDaemonRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn, makeCode: (ttlMs: number, req: Request, accountId: string) => { code: string; expiresAt: number; addresses: string[] }): void {
  app.post('/api/daemon/pairing', (c) => {
    const who = c.get('auth');
    // the owner token can be pasted into more than one app, so only a paired app gets the link; the device is the caller's account's
    const { code, expiresAt, addresses } = makeCode(APP_PAIRING_TTL_MS, c.req.raw, who.accountId);
    if (who.kind === 'client') appDevices(ctx).remember(code, who.clientId, expiresAt);
    audit(c, 'pairing.create', `device for ${who.kind === 'client' ? `${who.name ?? 'app'} (${who.clientId})` : 'the owner token'}`);
    return c.json({ code, expiresAt, addresses });
  });

  // public route (app.ts): its own check, and a wrong token counts as a wrong token
  app.post('/api/daemon/unpair', (c) => {
    const url = new URL(c.req.url);
    const token = bearerToken(c.req.raw, url, false);
    const id = c.req.header('x-conclave-device') ?? undefined;
    const deviceId = ctx.auth.checkDevice(id, token);
    if (!deviceId) return c.json({ error: NOT_PAIRED }, 401);
    const row = ctx.engine.repos.devices.get(deviceId);
    if (!row) throw notFound(NOT_PAIRED);
    const accountId = ctx.engine.repos.devices.accountOf(deviceId);
    removeDevice(ctx, deviceId, 'device unpaired');
    audit(c, 'device.unpair', `${row.name} removed itself`, { device: deviceId, ...(accountId ? { accountId } : {}) });
    return c.json({ ok: true });
  });
}
