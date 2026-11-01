import { createECDH, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Db } from '../storage/db';
import type { Repos } from '../storage/repos';
import type { EventBus } from '../util/bus';
import type { ConfigStore } from '../config';
import type { Notice } from '../types';
import type { Notifier, NotifyChannel, NotifyDevice } from './types';
import { OWNER_ID } from '../people/context';
import { EngineError } from '../engine/errors';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import { defaultWebPush, WebPushChannel, type PushSubscriptionRow, type SignAction, type WebPushLib } from './channels';

const log = logger('notify');

const VAPID_KEY = 'vapid';
/** Browsers the hub keeps for Web Push. Past this the oldest go first. */
const MAX_SUBSCRIPTIONS = 50;
/** UnifiedPush endpoints from before notifications moved into the app. Removed on start. */
const RETIRED_KV = ['unifiedpush.endpoints'];

export interface NotifierOptions {
  db: Db;
  repos: Pick<Repos, 'kv'>;
  bus: EventBus;
  config: ConfigStore;
  /** Signs approve and deny links so a phone can act without the bearer token. */
  signAction?: SignAction;
  /** Overrides for tests. */
  webPush?: WebPushLib;
  now?: () => number;
}

/** True when the browser's keys can encrypt a push: a P-256 point and a 16 byte secret. */
export function validPushKeys(keys: { p256dh: string; auth: string }): boolean {
  try {
    const pub = Buffer.from(keys.p256dh, 'base64url');
    const auth = Buffer.from(keys.auth, 'base64url');
    if (pub.length !== 65 || pub[0] !== 4 || auth.length !== 16) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(pub); // throws when the point is not on the curve
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a push address on this machine or a private network. Browsers get
 * theirs from a public push service, so the hub never posts to one of these.
 */
export function privatePushHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(h) === 6) return h === '::' || h === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith('::ffff:');
  return false;
}

/** Short stable id for a push endpoint, so clients can name a browser without its endpoint. */
export function endpointId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

/**
 * Notifications stay inside Conclave. Every notice goes on the bus, so open
 * apps show it as a toast. The desktop app and the Android app keep their
 * own connection and show a system notification for notices with
 * `alert: true`. Browsers and the installed web app get Web Push.
 *
 * While some Conclave window is in use, notices are held: no push and no
 * `alert`. In use means a client touched within notifications.idleSeconds and
 * has not been released since (apps release when they go to the background).
 * Errors, approvals and forced sends always go out. send() never throws;
 * test() does, with a message that says what to do.
 */
export class NotifierService implements Notifier {
  private db: Db;
  private repos: Pick<Repos, 'kv'>;
  private bus: EventBus;
  private config: ConfigStore;
  private now: () => number;
  private lastTouch = new Map<string, number>();
  /** Which account each client is (for the hold, which is per account). */
  private clientAccount = new Map<string, string>();
  private list: NotifyChannel[];
  private webPushLib: WebPushLib;

  constructor(opts: NotifierOptions) {
    this.db = opts.db;
    this.repos = opts.repos;
    this.bus = opts.bus;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.webPushLib = opts.webPush ?? defaultWebPush;
    this.list = [
      new WebPushChannel({
        sign: opts.signAction,
        subscriptions: (accountId) => this.pushSubscriptions(accountId),
        remove: (endpoint) => this.removePushSubscription(endpoint),
        vapid: () => this.vapid(),
        lib: this.webPushLib,
        log: (m) => log.info(m),
      }),
    ];
    for (const key of RETIRED_KV) {
      try {
        if (this.repos.kv.get<unknown>(key, null) !== null) this.repos.kv.delete(key);
      } catch {
        /* an old database without the kv row */
      }
    }
  }

  private get publicUrl(): string | undefined {
    return this.config.get().server.publicUrl;
  }

  touch(clientId: string, accountId: string = OWNER_ID): void {
    this.lastTouch.set(clientId, this.now());
    this.clientAccount.set(clientId, accountId);
    if (this.lastTouch.size > 200) {
      const cutoff = this.now() - 3_600_000;
      for (const [k, t] of this.lastTouch) if (t < cutoff) this.lastTouch.delete(k);
    }
  }

  release(clientId: string): void {
    this.lastTouch.delete(clientId);
  }

  /** True when some client of the account was in use within notifications.idleSeconds. */
  someoneActive(accountId: string = OWNER_ID): boolean {
    const windowMs = (this.config.get().notifications.idleSeconds ?? 60) * 1000;
    if (windowMs <= 0) return false;
    const cutoff = this.now() - windowMs;
    for (const [client, t] of this.lastTouch) if (t >= cutoff && (this.clientAccount.get(client) ?? OWNER_ID) === accountId) return true;
    return false;
  }

  channels(): Array<{ id: string; enabled: boolean }> {
    return this.list.map((c) => ({ id: c.id, enabled: safeEnabled(c) }));
  }

  async send(input: Omit<Notice, 'id' | 'createdAt' | 'alert'>, opts: { force?: boolean } = {}): Promise<Notice> {
    const { alert: _ignored, ...rest } = input as Notice;
    const urgent = !!opts.force || rest.level === 'error' || !!rest.approvalId;
    // a notice is someone's: their apps get it, their browsers get the push, their presence holds it
    const accountId = rest.accountId ?? OWNER_ID;
    const held = !urgent && this.someoneActive(accountId);
    const notice: Notice = { ...rest, accountId, id: newId('ntc'), createdAt: this.now(), ...(held ? {} : { alert: true }) };
    try {
      this.bus.emit({ type: 'notice', notice });
      if (held) {
        log.debug(`notice "${notice.title}" held: a Conclave window is in use`);
        return notice;
      }
      const active = this.list.filter(safeEnabled);
      const results = await Promise.allSettled(active.map((c) => c.send(notice, { publicUrl: this.publicUrl, accountId })));
      results.forEach((r, i) => {
        if (r.status === 'rejected') log.warn(`${active[i].id} failed: ${(r.reason as Error)?.message ?? r.reason}`);
      });
    } catch (err) {
      log.error('notify failed', err);
    }
    return notice;
  }

  async test(channel: string, opts: { endpoint?: string; accountId?: string } = {}): Promise<void> {
    const c = this.list.find((x) => x.id === channel);
    if (!c) throw new EngineError(404, `There is no notification channel called ${channel}. Use webpush.`);
    const accountId = opts.accountId ?? OWNER_ID;
    if (opts.endpoint) {
      if (!this.pushSubscriptions(accountId).some((s) => s.endpoint === opts.endpoint)) {
        throw new EngineError(409, 'This browser is not set up for notifications yet. Turn on Notify this device, then send a test.');
      }
    } else if (!this.pushSubscriptions(accountId).length) {
      throw new EngineError(409, 'No browser is set up for notifications yet. Turn on Notify this device in Settings, then send a test.');
    }
    const notice: Notice = {
      id: newId('ntc'),
      title: 'Conclave test',
      body: opts.endpoint ? 'Notifications reach this device.' : 'Notifications reach your devices.',
      level: 'info',
      link: '/settings/notifications',
      createdAt: this.now(),
    };
    await c.send(notice, { publicUrl: this.publicUrl, only: opts.endpoint, accountId });
  }

  // -------------------------------------------------------------------------
  // Web Push
  // -------------------------------------------------------------------------

  private vapid(): { publicKey: string; privateKey: string; subject: string } {
    const cfg = this.config.get().notifications.webPush;
    const pub = this.publicUrl;
    const fallbackSubject = pub?.startsWith('https://') ? pub : 'mailto:conclave@example.com';
    if (cfg?.publicKey && cfg.privateKey) {
      return { publicKey: cfg.publicKey, privateKey: this.config.expand(cfg.privateKey), subject: cfg.subject || fallbackSubject };
    }
    let keys = this.repos.kv.get<{ publicKey: string; privateKey: string } | null>(VAPID_KEY, null);
    if (!keys?.publicKey || !keys.privateKey) {
      keys = this.webPushLib.generateVAPIDKeys();
      this.repos.kv.set(VAPID_KEY, keys);
      log.info('generated VAPID keys for Web Push');
    }
    return { ...keys, subject: fallbackSubject };
  }

  vapidPublicKey(): string | undefined {
    try {
      return this.vapid().publicKey;
    } catch (err) {
      log.warn(`no VAPID key: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** One account's browsers; every one when accountId is left out. */
  private pushSubscriptions(accountId?: string): PushSubscriptionRow[] {
    const rows = (
      accountId
        ? this.db.query('SELECT endpoint, keys, device, created_at FROM push_subscriptions WHERE account_id = ? ORDER BY created_at ASC').all(accountId)
        : this.db.query('SELECT endpoint, keys, device, created_at FROM push_subscriptions ORDER BY created_at ASC').all()
    ) as Array<{
      endpoint: string;
      keys: string;
      device: string | null;
      created_at: number | null;
    }>;
    const out: PushSubscriptionRow[] = [];
    for (const r of rows) {
      try {
        const keys = JSON.parse(r.keys);
        if (keys?.p256dh && keys?.auth) out.push({ endpoint: r.endpoint, keys, device: r.device ?? undefined, createdAt: r.created_at ?? undefined });
      } catch {
        /* skip broken rows */
      }
    }
    return out;
  }

  addPushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string, accountId: string = OWNER_ID): void {
    let url: URL | undefined;
    try {
      url = new URL(sub.endpoint);
    } catch {
      /* refused below */
    }
    if (!url || url.protocol !== 'https:' || sub.endpoint.length > 1000 || !sub.keys?.p256dh || !sub.keys?.auth || !validPushKeys(sub.keys)) {
      throw new EngineError(400, 'The browser sent an incomplete push subscription. Reload the page and turn Notify this device on again.');
    }
    if (privatePushHost(url.hostname)) {
      throw new EngineError(400, "This push address is on a private network. Conclave only sends to a browser's own push service. Turn Notify this device on in a regular browser.");
    }
    const name = device?.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
    this.db
      .query(
        // a browser that signs in as someone else now notifies them, not whoever had it before
        'INSERT INTO push_subscriptions (endpoint, keys, device, created_at, account_id) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys, device=excluded.device, account_id=excluded.account_id',
      )
      .run(sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), name, this.now(), accountId);
    // keep the newest; a browser that comes back subscribes again
    const all = this.pushSubscriptions(accountId);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_SUBSCRIPTIONS))) {
      if (old.endpoint !== sub.endpoint) this.removePushSubscription(old.endpoint);
    }
  }

  /** With an account, only its own subscription goes (the push service's 410 cleanup passes none). */
  removePushSubscription(endpoint: string, accountId?: string): void {
    if (accountId) this.db.query('DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ?').run(endpoint, accountId);
    else this.db.query('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  devices(accountId: string = OWNER_ID): NotifyDevice[] {
    return this.pushSubscriptions(accountId).map((s) => ({ id: endpointId(s.endpoint), name: s.device, kind: 'webpush' as const, createdAt: s.createdAt }));
  }

  removeDevice(id: string, accountId: string = OWNER_ID): boolean {
    const sub = this.pushSubscriptions(accountId).find((s) => endpointId(s.endpoint) === id);
    if (!sub) return false;
    this.removePushSubscription(sub.endpoint);
    return true;
  }
}

function safeEnabled(c: NotifyChannel): boolean {
  try {
    return c.enabled();
  } catch {
    return false;
  }
}
