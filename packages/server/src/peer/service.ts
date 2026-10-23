/**
 * Friends, phase 1 (docs/design/FRIENDS.md): invites, requests, accept,
 * safety codes, address records, the outbox and its pull path, remove and
 * key changes, and plain notes to try it all.
 *
 * Inbound: routes.ts hands each /peer/v1 request to verify() (or
 * friendRequest()), which checks the signed request against a friend's key;
 * receive() then checks the envelope, opens it and applies it once
 * (an id seen before answers "duplicate" and does nothing).
 *
 * Outbound: queue() signs and seals a message into peer_outbox and kicks
 * delivery. deliver() checks the friend's hub key at each of its addresses
 * in order and PUTs what is due; a hub that does not answer gets the next
 * try later (backoff with jitter, at most an hour apart) until 7 days pass,
 * then the item fails and the owner hears. Meanwhile the friend's hub can
 * pull it (GET /peer/v1/outbox), which this hub also does to its friends:
 * at start, every few minutes, and on Sync. Jobs reschedule themselves and
 * never throw, so the scheduler's own retry limit does not apply.
 *
 * Nothing a friend sends runs anything: a note lands in the inbox, emits
 * friend.message and may notify. That is all. Shares (share.offer, update,
 * revoke, ack) are handed to shares.ts, which keeps an offer in the Inbox and
 * fetches nothing before the owner accepts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { Scheduler } from '@conclave/core/scheduler/types.ts';
import type { AddFriendResult, FriendDto, FriendGrants, FriendInvite, FriendReachability, FriendSettings, InboxItemDto, MailInviteResult, OutboxItemDto } from '@conclave/core/client/friends.ts';
import type { HubAddress, Notice, RemoteStatus } from '@conclave/core/types.ts';
import type { BundleSigner } from '@conclave/core/session/share.ts';
import { formatFingerprint, newNonce, verifyIdentity, type IdentityProof } from '@conclave/core/client/index.ts';
import { logger } from '@conclave/core/util/log.ts';
import { BodyTooLarge, HttpError, readCapped, readJsonCapped } from '../http';
import { RateLimiter } from '../auth';
import { hostPort, isLoopbackName, machineAddresses, neverAHub, plainIp, systemLookup, type Lookup } from './address-check';
import {
  FINGERPRINT,
  fingerprintOf,
  inviteProof,
  inviteSecretHash,
  loadSubkey,
  safetyCode,
  sameText,
  sha256Hex,
  type PeerSubkey,
  type Signer,
} from './crypto';
import {
  MESSAGE_TYPES,
  buildEnvelope,
  cleanAddress,
  keyRotateBody,
  openEnvelope,
  parseEnvelope,
  signRecord,
  verifyEnvelope,
  verifyKeyRotate,
  verifyRecord,
  type AddressRecord,
  type PeerAddress,
  type PeerEnvelope,
} from './envelope';
import { SKEW_SEC, isRefusal, parseSignature, signRequest, verifySignature, type IncomingRequest } from './signing';
import { DEFAULT_GRANTS, PeerStore, type Friend, type InboxItem, type OutboxItem } from './store';
import { ShareService } from './shares';
import { SharedProjectService } from './projects';
import { ULID, ulid } from './ulid';

const log = logger('peer');

export const INVITE_TTL_MS = 24 * 3_600_000;
export const MAX_PENDING_REQUESTS = 3;
export const MAX_OPEN_INVITES = 20;
/** How long the outbox tries before it gives up. */
export const GIVE_UP_MS = 7 * 86_400_000;
/** friend.remove is best effort: a day. */
const REMOVE_TTL_MS = 86_400_000;
/** Rows of outbox messages that are done stay this long (a note's for good: it holds the thread's text). */
export const OUTBOX_KEEP_MS = 90 * 86_400_000;
/** Largest PUT /peer/v1/inbox body. */
export const INBOX_MAX_BYTES = 1024 * 1024;
/** Largest blob a friend may offer (a share's cap in FRIENDS.md). */
export const BLOB_MAX_BYTES = 100 * 1024 * 1024;
const BLOB_THRESHOLD = 256 * 1024;
export const NOTE_MAX_CHARS = 20_000;
/** What this hub reads of another hub's answer: an identity proof or a record, an error, one page of the pull path. */
const SMALL_ANSWER_BYTES = 64 * 1024;
const ERROR_ANSWER_BYTES = 16 * 1024;
const PULL_PAGE_BYTES = 64 * 1024 * 1024;
/**
 * Friend requests by address alone (FRIENDS.md, "Add a friend by address"):
 * at most this many wait for the owner, apart from the requests that came
 * with an invite, so strangers cannot crowd those out.
 */
export const MAX_ADDRESS_REQUESTS = 5;
/** Requests by address from one network address an hour, and for the whole hub a day. */
export const ADDRESS_PER_HOUR = 3;
export const ADDRESS_PER_DAY = 20;
/** A request by address holds a name, a key and an address record: this many bytes at most. */
export const ADDRESS_REQUEST_MAX_BYTES = 16 * 1024;
/** A declined request by address may ask again after this long. */
export const DECLINE_COOLOFF_MS = 30 * 86_400_000;
const KV_BY_ADDRESS = 'peer.byAddress';
/** What a hub that does not take a request by address says, whatever the reason (off, blocked, declined lately). */
const CLOSED = 'This hub takes friend requests by invite only. Ask its owner for an invite link.';
/** A refusal's code, as a pull names it back to the sender (GET /peer/v1/outbox?refused=<id>.<code>). */
const REFUSAL_CODE = /^[a-z][a-z-]{0,30}$/;

/** What the owner reads when a friend's hub refused a message it pulled, by the refusal's code. */
function refusedWords(name: string, code: string): string {
  const why: Record<string, string> = {
    grant: 'it does not take notes or shares from this hub now',
    'not-yet': 'the friend request is not accepted there yet',
    type: 'it does not take this kind of message',
    'too-large': 'it is too large',
  };
  return `${name}'s hub refused it: ${why[code] ?? `it could not take it (${code})`}.`;
}

const DELIVER_JOB = 'peer.deliver';
const PULL_JOB = 'peer.pull';
const FETCH_JOB = 'peer.fetch';
const SWEEP_JOB = 'peer.sweep';
const KV_RECORD = 'peer.record';
/** A friend's read mark: notes and share cards that came up to this time (the hub's clock) are read. */
const KV_READ = 'peer.read.';
const KV_NAME = 'peer.name';
const NOTICE_LINK = '/settings/friends';

/** A refused peer request: the status and words the other hub gets. */
export class PeerRefusal extends HttpError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(status, message);
    this.name = 'PeerRefusal';
  }
}

const refuse = (status: number, code: string, message: string) => new PeerRefusal(status, code, message);

export interface PeerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** The engine's scheduler unless given (tests pass a running one). */
  scheduler?: Scheduler;
  /** Delay before try n (1 based), before jitter. Default 30 s doubling, at most an hour. */
  backoff?: (attempt: number) => number;
  /** How long the outbox keeps trying. Default 7 days. */
  giveUpMs?: number;
  /** A sealed body larger than this many bytes goes as a blob. Default 256 KB. */
  blobThreshold?: number;
  /** How often to pull from friends while friends cannot reach this hub; four times as long while they can. Default 5 minutes. */
  pullEveryMs?: number;
  /** The first pull after start. Default 10 s. */
  firstPullMs?: number;
  /** Wait after an address change before telling friends (a tunnel settles). Default 5 s. */
  addressDelayMs?: number;
  /** Each request to another hub. Default 15 s. */
  timeoutMs?: number;
  /** Fetching a share's payload on Accept. Default 5 minutes. */
  fetchTimeoutMs?: number;
  /** A host name to its addresses, before they are checked. Default: the system's resolver. */
  lookup?: Lookup;
  /** Take loopback addresses for friends. Only tests, which run two hubs on one machine. */
  loopback?: boolean;
}

/** What the service needs from the server. */
export interface PeerHost {
  engine: EngineApi;
  /** The hub key: signs requests, envelopes and the bundles a share carries. */
  identity: Signer & { bundleSigner(name?: string): BundleSigner };
  /** The hub's addresses and, once it listens, its port. */
  remote: { addresses(): HubAddress[]; status(): RemoteStatus; listenPort?(): number };
}

/** A record's addresses this hub will call, and the ones it left out with why. */
interface Screened {
  addrs: PeerAddress[];
  refused: string[];
}

/** Messages that carry an address record: its names are looked up before the message is applied. */
const RECORD_TYPES = new Set(['friend.accept', 'address.update', 'key.rotate']);

/** A request this hub does not make: the address is never a friend's hub. */
class AddressRefused extends Error {}

const defaultBackoff = (n: number) => Math.min(30_000 * 2 ** (n - 1), 3_600_000);

function short(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await readJsonCapped<{ error?: unknown }>(res, ERROR_ANSWER_BYTES);
    if (typeof body?.error === 'string' && body.error) return body.error.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return res.statusText || `status ${res.status}`;
}

/** A name another hub sent: one line, 60 characters at most. */
export function cleanName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // control characters and the two Unicode line breaks (U+2028, U+2029)
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || undefined;
}

/** An email the owner typed for a friend: one address, 254 characters at most. Never sent to another hub. */
export function cleanEmail(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length <= 254 && /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(s) ? s : undefined;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/;

/**
 * A hub address the owner typed: https:// is added when there is no scheme
 * (http:// for a name on this network), and nothing after the path stays.
 */
export function hubAddress(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split('/')[0].replace(/:\d+$/, '').toLowerCase();
    s = `${LOCAL_HOST.test(host) || host.endsWith('.local') ? 'http' : 'https'}://${s}`;
  }
  return cleanAddress(s.replace(/[?#].*$/, ''));
}

/** A mailto: link with an invite in it, for an email the owner gave. */
export function inviteMailto(email: string, from: string, link: string, fingerprint: string): string {
  const subject = `${from} wants to be friends on Conclave`;
  const body = [
    `${from} wants to be friends on Conclave, hub to hub.`,
    '',
    "If a request did not reach your hub, use this invite instead. In Conclave open Settings, Friends, Use a friend's link, and paste it. It works once, for 24 hours:",
    '',
    link,
    '',
    `My hub's key: ${formatFingerprint(fingerprint)}`,
  ].join('\n');
  return `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sameAddrs(a: PeerAddress[], b: PeerAddress[]): boolean {
  return a.length === b.length && a.every((x, i) => x.url === b[i].url && x.kind === b[i].kind);
}

export interface InviteLink {
  fp: string;
  url: string;
  alts: string[];
  secret: string;
  expiresAt: number;
}

/** conclave://friend?fp=&url=&alt=&s=&exp= (exp in seconds). */
export function inviteLink(i: InviteLink): string {
  const alts = i.alts.map((a) => `&alt=${encodeURIComponent(a)}`).join('');
  return `conclave://friend?fp=${i.fp}&url=${encodeURIComponent(i.url)}${alts}&s=${i.secret}&exp=${Math.floor(i.expiresAt / 1000)}`;
}

export function parseInviteLink(link: string): InviteLink | undefined {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'conclave:' || u.hostname !== 'friend') return undefined;
  const q = u.searchParams;
  const fp = (q.get('fp') ?? '').toLowerCase();
  const url = cleanAddress(q.get('url'));
  const secret = q.get('s') ?? '';
  const exp = Number(q.get('exp'));
  if (!FINGERPRINT.test(fp) || !url || !/^[A-Za-z0-9_-]{22,64}$/.test(secret) || !Number.isSafeInteger(exp)) return undefined;
  const alts = q
    .getAll('alt')
    .map((a) => cleanAddress(a))
    .filter((a): a is string => !!a && a !== url)
    .slice(0, 8);
  return { fp, url, alts, secret, expiresAt: exp * 1000 };
}

export class PeerService {
  readonly store: PeerStore;
  readonly subkey: PeerSubkey;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly backoff: (n: number) => number;
  private readonly giveUpMs: number;
  private readonly blobThreshold: number;
  private readonly pullEveryMs: number;
  private readonly firstPullMs: number;
  private readonly addressDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly lookup: Lookup;
  private readonly loopback: boolean;
  private readonly blobDir: string;
  /** Shares to and from friends (shares.ts). */
  readonly shares: ShareService;
  /** Projects shared with friends (projects.ts). */
  readonly projects: SharedProjectService;
  /** Requests by address: per network address an hour, and the whole hub a day. */
  private readonly byAddressHour = new RateLimiter(ADDRESS_PER_HOUR, 3_600_000);
  private readonly byAddressDay = new RateLimiter(ADDRESS_PER_DAY, 86_400_000);
  private locks = new Map<string, Promise<unknown>>();
  private kicked = new Map<string, number>();
  private addressTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private closed = false;

  constructor(
    private readonly host: PeerHost,
    opts: PeerOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.scheduler = opts.scheduler ?? host.engine.scheduler;
    this.backoff = opts.backoff ?? defaultBackoff;
    this.giveUpMs = opts.giveUpMs ?? GIVE_UP_MS;
    this.blobThreshold = opts.blobThreshold ?? BLOB_THRESHOLD;
    this.pullEveryMs = opts.pullEveryMs ?? 5 * 60_000;
    this.firstPullMs = opts.firstPullMs ?? 10_000;
    this.addressDelayMs = opts.addressDelayMs ?? 5_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 300_000;
    this.lookup = opts.lookup ?? systemLookup;
    this.loopback = opts.loopback ?? false;
    this.store = new PeerStore(host.engine.repos.db, this.now);
    const home = host.engine.config.paths.home;
    this.subkey = loadSubkey(home);
    this.blobDir = join(home, 'peer', 'blobs');
    this.shares = new ShareService(this, { engine: host.engine, identity: host.identity, now: this.now, home });
    this.projects = new SharedProjectService(this, { engine: host.engine, identity: host.identity, now: this.now });
  }

  private get engine(): EngineApi {
    return this.host.engine;
  }

  private get identity(): Signer {
    return this.host.identity;
  }

  get fingerprint(): string {
    return this.host.identity.fingerprint;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Register the jobs and pick up what a restart left: queued messages, bodies to fetch, a first pull. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    const s = this.scheduler;
    s.handle(DELIVER_JOB, (p) => this.guard(() => this.deliver(String(p.friendId ?? ''))));
    s.handle(PULL_JOB, () => this.guard(() => this.pullAll()));
    s.handle(FETCH_JOB, (p) => this.guard(() => this.fetchBlob(String(p.friendId ?? ''), String(p.id ?? ''), Number(p.attempt ?? 1))));
    s.handle(SWEEP_JOB, () => this.guard(() => this.sweep()));
    const now = this.now();
    s.enqueue(SWEEP_JOB, now + 60_000, {}, SWEEP_JOB);
    s.enqueue(PULL_JOB, now + this.firstPullMs, {}, PULL_JOB);
    for (const id of this.store.friendsWithQueued()) this.schedule(id);
    for (const item of this.store.fetching()) s.enqueue(FETCH_JOB, now, { friendId: item.friendId, id: item.id, attempt: 1 }, `${FETCH_JOB}.${item.friendId}.${item.id}`);
    this.shares.start();
    this.projects.start();
    this.addressesChanged();
  }

  close(): void {
    this.closed = true;
    this.projects.stop();
    if (this.addressTimer) clearTimeout(this.addressTimer);
  }

  /** Run a job body; a job never throws, it reschedules itself. */
  private async guard(fn: () => Promise<unknown>): Promise<void> {
    if (this.closed) return;
    try {
      await fn();
    } catch (err) {
      log.warn(`friends job failed: ${short(err)}`);
    }
  }

  /** One at a time per key (a friend's outbox, its pull, a blob). */
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  audit(actor: string, action: string, detail: string): void {
    try {
      this.engine.repos.audit.add({ actor, action, detail });
    } catch {
      /* auditing must not break delivery */
    }
  }

  friendActor(f: Friend): string {
    return `friend:${f.fingerprint}`;
  }

  /** A notice for the owner's apps, when friend messages notify. */
  notify(title: string, body: string, level: Notice['level'] = 'info', link = NOTICE_LINK): void {
    if (this.engine.config.get().notifications?.on?.friendMessage === false) return;
    void this.engine.notifier.send({ title, body, level, link }).catch((err) => log.warn(`notify failed: ${short(err)}`));
  }

  emitFriend(id: string): void {
    const f = this.store.friend(id);
    if (f) this.engine.bus.emit({ type: 'friend.updated', friend: this.dto(f) });
  }

  /** The name this hub shows friends: the owner's choice, else the hub's name. */
  ourName(): string {
    return cleanName(this.engine.repos.kv.get<string>(KV_NAME, '')) ?? cleanName(this.engine.info().name) ?? 'Conclave';
  }

  setName(name: string): void {
    const clean = cleanName(name);
    if (clean) this.engine.repos.kv.set(KV_NAME, clean);
  }

  /** A refusal for the friend's hub (shares.ts throws these from receive). */
  refusal(status: number, code: string, message: string): PeerRefusal {
    return refuse(status, code, message);
  }

  require(id: string): Friend {
    const f = this.store.friend(id) ?? (FINGERPRINT.test(id) ? this.store.friendByFingerprint(id) : undefined);
    if (!f) throw new HttpError(404, `unknown friend ${id}`);
    return f;
  }

  dto(f: Friend): FriendDto {
    let pendingFingerprint: string | undefined;
    if (f.pendingKey) {
      try {
        pendingFingerprint = fingerprintOf(f.pendingKey);
      } catch {
        /* never stored unchecked */
      }
    }
    return {
      id: f.id,
      name: f.name,
      fingerprint: f.fingerprint,
      status: f.status,
      direction: f.direction,
      verified: f.verified,
      safetyCode: safetyCode(this.fingerprint, f.fingerprint),
      grants: { ...DEFAULT_GRANTS, ...f.grants },
      addresses: f.addresses.addrs,
      createdAt: f.createdAt,
      ...(f.lastSeen ? { lastSeen: f.lastSeen } : {}),
      ...(f.lastError ? { lastError: f.lastError } : {}),
      ...(f.blockedReason ? { blockedReason: f.blockedReason } : {}),
      ...(pendingFingerprint ? { pendingFingerprint } : {}),
      queued: this.store.countQueued(f.id),
      ...this.unread(f.id),
      ...(f.email ? { email: f.email } : {}),
      ...(f.via ? { via: f.via } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Read marks: one per friend, on the hub, so every device of the owner agrees
  // -------------------------------------------------------------------------

  /** Notes and share cards from this friend that came up to this time are read. */
  readMark(friendId: string): number {
    return this.engine.repos.kv.get<number>(`${KV_READ}${friendId}`, 0);
  }

  private unread(friendId: string): { unread: number; unreadNotes: number; unreadShares: number; readAt?: number } {
    const mark = this.readMark(friendId);
    const unreadNotes = this.store.unreadNotes(friendId, mark);
    const unreadShares = this.shares.store.unreadShares(friendId, mark);
    return { unread: unreadNotes + unreadShares, unreadNotes, unreadShares, ...(mark ? { readAt: mark } : {}) };
  }

  /**
   * The owner read a friend's notes and share cards up to `upTo`: a note's id
   * or a received share's id (the newest one seen). Without it, everything
   * that came so far. A mark never moves back.
   */
  markRead(id: string, upTo?: string): FriendDto {
    const f = this.require(id);
    let at = this.now();
    if (upTo) {
      const note = this.store.inboxItem(f.id, upTo);
      const share = note ? undefined : this.shares.store.in(upTo);
      if (note) at = note.receivedAt;
      else if (share && share.friendId === f.id) at = share.updatedAt;
      else throw new HttpError(404, `${f.name} sent nothing with the id ${upTo}.`);
    }
    if (at > this.readMark(f.id)) {
      this.engine.repos.kv.set(`${KV_READ}${f.id}`, at);
      this.emitFriend(f.id);
    }
    return this.dto(this.store.friend(f.id)!);
  }

  private outboxDto(i: OutboxItem): OutboxItemDto {
    return {
      id: i.id,
      friendId: i.friendId,
      type: i.type,
      state: i.state,
      attempts: i.attempts,
      ...(i.state === 'queued' ? { nextTry: i.nextTry } : {}),
      createdAt: i.createdAt,
      ...(i.deliveredAt ? { deliveredAt: i.deliveredAt } : {}),
      ...(i.via ? { via: i.via } : {}),
      ...(i.lastError ? { lastError: i.lastError } : {}),
      preview: i.preview,
      ...(i.text !== undefined ? { text: i.text } : {}),
    };
  }

  private inboxDto(i: InboxItem, name: string, mark = this.readMark(i.friendId)): InboxItemDto {
    const text = (i.body as { text?: unknown } | undefined)?.text;
    return { id: i.id, friendId: i.friendId, friendName: name, type: i.type, state: i.state, ...(typeof text === 'string' ? { text } : {}), receivedAt: i.receivedAt, read: i.receivedAt <= mark };
  }

  // -------------------------------------------------------------------------
  // This hub's address record
  // -------------------------------------------------------------------------

  /** Addresses for friends: the outside ones, or the same network when there are none. */
  private ownAddresses(): PeerAddress[] {
    const all = this.host.remote.addresses().map((a) => ({ url: a.url, kind: a.kind }));
    const outside = all.filter((a) => a.kind !== 'lan');
    return outside.length ? outside : all;
  }

  /** The signed record friends get. Signed again when the key or subkey changed or it nears expiry. */
  record(): AddressRecord {
    const stored = this.engine.repos.kv.get<AddressRecord | null>(KV_RECORD, null);
    const now = this.now();
    if (stored && stored.publicKey === this.identity.publicKey && stored.subkey === this.subkey.publicKey && stored.expiresAt - now > 7 * 86_400_000) return stored;
    const addrs = stored?.addrs?.length ? stored.addrs : this.ownAddresses();
    const next = signRecord(this.identity, this.subkey.publicKey, addrs, (stored?.seq ?? 0) + 1, now);
    this.engine.repos.kv.set(KV_RECORD, next);
    return next;
  }

  /** The address callback (app.ts): after things settle, tell friends where this hub is now. */
  addressesChanged(): void {
    if (this.closed) return;
    if (this.addressTimer) clearTimeout(this.addressTimer);
    this.addressTimer = setTimeout(() => {
      this.addressTimer = undefined;
      try {
        this.publishAddresses();
      } catch (err) {
        log.warn(`address update failed: ${short(err)}`);
      }
    }, this.addressDelayMs);
    (this.addressTimer as { unref?: () => void }).unref?.();
  }

  /**
   * A new record goes to every friend when the addresses changed. A list
   * with no outside address does not replace one that had it: a tunnel that
   * restarts comes back, and friends keep trying the old address meanwhile.
   */
  publishAddresses(): AddressRecord | undefined {
    if (this.closed) return undefined;
    const current = this.ownAddresses();
    const stored = this.record();
    if (sameAddrs(current, stored.addrs)) return undefined;
    const outside = (l: PeerAddress[]) => l.some((a) => a.kind !== 'lan');
    if (!outside(current) && outside(stored.addrs)) return undefined;
    const next = signRecord(this.identity, this.subkey.publicKey, current, stored.seq + 1, this.now());
    this.engine.repos.kv.set(KV_RECORD, next);
    this.audit('hub', 'friend.addresses', `${current.map((a) => a.url).join(', ') || 'none'} (record ${next.seq})`);
    for (const f of this.store.friends()) if (f.status === 'active' && f.subkey) this.queue(f, 'address.update', { record: next }, { preview: 'address update', actor: 'hub' });
    return next;
  }

  // -------------------------------------------------------------------------
  // Reachability and invites
  // -------------------------------------------------------------------------

  reachability(): FriendReachability {
    const st = this.host.remote.status();
    const outside = st.addresses.filter((a) => a.kind !== 'lan');
    const best = outside[0] ? { url: outside[0].url, kind: outside[0].kind } : undefined;
    const pulls = 'Until then your hub still fetches what friends hold for it.';
    if (st.mode === 'off') return { ok: false, mode: st.mode, reason: `Remote access is off, so a friend's hub cannot reach this one. Turn on a tunnel or add your own URL in Settings, Remote access (conclave remote quick). ${pulls}` };
    if (st.mode === 'tailscale') return { ok: false, mode: st.mode, ...(best ? { best } : {}), reason: `Tailscale serves only your tailnet, so a friend outside it cannot reach this hub. Turn on a tunnel or use your own URL in Settings, Remote access. ${pulls}` };
    if (!best) {
      const why = st.error ?? (st.state === 'starting' || st.state === 'installing' ? 'The tunnel is still starting.' : 'The hub has no outside address yet.');
      return { ok: false, mode: st.mode, reason: `${why} ${pulls}` };
    }
    if (best.kind === 'quick') return { ok: true, mode: st.mode, best, reason: "A quick tunnel gets a new address when it restarts. Your hub sends friends the new one." };
    return { ok: true, mode: st.mode, best };
  }

  async createInvite(opts: { includeLan?: boolean; name?: string } = {}, actor = 'owner'): Promise<FriendInvite> {
    this.store.pruneInvites();
    if (this.store.openInvites().length >= MAX_OPEN_INVITES) throw new HttpError(429, `${MAX_OPEN_INVITES} invites are open. Wait until some are used or expire (24 hours).`);
    const all = this.host.remote.addresses();
    const urls = all.filter((a) => opts.includeLan || a.kind !== 'lan').map((a) => a.url);
    const reach = this.reachability();
    if (!urls.length) {
      throw new HttpError(409, `A friend's hub could not reach this one: ${reach.reason ?? 'there is no outside address.'}${all.length ? ' To invite someone on this network, include its addresses.' : ''}`);
    }
    if (opts.name) this.setName(opts.name);
    const secret = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + INVITE_TTL_MS;
    this.store.createInvite(inviteSecretHash(secret), expiresAt);
    const link = inviteLink({ fp: this.fingerprint, url: urls[0], alts: urls.slice(1), secret, expiresAt });
    const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    this.audit(actor, 'friend.invite', `valid until ${new Date(expiresAt).toISOString()}, for ${urls.join(', ')}`);
    return { link, qrSvg, expiresAt, fingerprint: this.fingerprint, url: urls[0], addresses: urls, ...(reach.ok ? {} : { warning: reach.reason }) };
  }

  // -------------------------------------------------------------------------
  // Addresses a friend gives: records, invite links, an address the owner types
  // -------------------------------------------------------------------------

  /** host:port of this hub's own addresses: the ones friends get, and the owner's own URL. */
  private ownHosts(): Set<string> {
    const out = new Set<string>();
    for (const url of [...this.host.remote.addresses().map((a) => a.url), this.engine.config.get().server.publicUrl ?? '']) {
      const hp = hostPort(url);
      if (hp) out.add(`${hp.host}:${hp.port}`);
    }
    return out;
  }

  /**
   * Why this hub never calls a friend's hub at `url`, or undefined when it
   * may (address-check.ts). A name is resolved first and every address it
   * has is checked; one that does not resolve here goes on, since the
   * request fails the same way (or a proxy resolves it). This hub itself is
   * refused too: its own addresses, and its port on this machine.
   */
  async addressRefused(url: string): Promise<string | undefined> {
    const hp = hostPort(url);
    if (!hp) return 'not a web address';
    if (this.ownHosts().has(`${hp.host}:${hp.port}`)) return 'this hub';
    let ips: string[];
    if (isIP(hp.host)) ips = [hp.host];
    else if (isLoopbackName(hp.host)) ips = ['127.0.0.1', '::1'];
    else ips = await this.lookup(hp.host).catch(() => []);
    const machine = this.host.remote.listenPort?.() === hp.port ? machineAddresses() : undefined;
    for (const ip of ips) {
      const why = neverAHub(ip, { loopback: this.loopback });
      if (why) return why;
      if (machine?.has(plainIp(ip))) return 'this hub';
    }
    return undefined;
  }

  /** Which of `urls` this hub will call, in order, and the rest with why. */
  private async screen(urls: string[]): Promise<{ kept: string[]; refused: string[] }> {
    const why = await Promise.all(urls.map((u) => this.addressRefused(u)));
    return { kept: urls.filter((_, i) => !why[i]), refused: urls.flatMap((u, i) => (why[i] ? [`${u} (${why[i]})`] : [])) };
  }

  private async screenRecord(record: AddressRecord): Promise<Screened> {
    const s = await this.screen(record.addrs.map((a) => a.url));
    return { addrs: record.addrs.filter((a) => s.kept.includes(a.url)), refused: s.refused };
  }

  /** The record a message carries, checked as apply checks it, with its addresses screened. */
  private async screenIn(friend: Friend, type: string, body: unknown): Promise<Screened | undefined> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const record = type === 'key.rotate' ? verifyKeyRotate(friend.fingerprint, b)?.record : verifyRecord(b.record, friend.publicKey);
    return record ? this.screenRecord(record) : undefined;
  }

  /** One audit line for the addresses left out. They are kept nowhere. */
  private refusedAddresses(actor: string, from: string, refused: string[]): void {
    if (refused.length) this.audit(actor, 'friend.address.refused', `${from}: ${refused.join(', ')}, never a friend's hub`);
  }

  /** Every request to another hub: the address is checked again first, since a name may resolve elsewhere by now. */
  private async call(url: string, init: RequestInit): Promise<Response> {
    const why = await this.addressRefused(url);
    if (why) throw new AddressRefused(`${new URL(url).origin} is never a friend's hub (${why}).`);
    return this.fetchFn(url, init);
  }

  /** The hub key at an address, when a Conclave hub there proves it. */
  private async identityAt(url: string): Promise<{ publicKey: string } | { error: string }> {
    const nonce = newNonce();
    let res: Response;
    try {
      res = await this.call(`${url}/api/identity?nonce=${nonce}`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' });
    } catch (err) {
      return { error: err instanceof AddressRefused ? err.message : `${url} did not answer (${short(err)}).` };
    }
    if (!res.ok) return { error: `${url} answered ${res.status}.` };
    let proof: IdentityProof;
    try {
      proof = await readJsonCapped<IdentityProof>(res, SMALL_ANSWER_BYTES);
    } catch {
      return { error: `${url} is not a Conclave hub.` };
    }
    try {
      if (await verifyIdentity(proof, nonce)) return { publicKey: proof.publicKey };
    } catch {
      /* no Ed25519 here: cannot happen on the hub, but say so plainly */
    }
    return { error: `${url} did not prove a hub key.` };
  }

  /** A signed request to another hub. */
  private signed(base: string, to: string, method: string, path: string, body?: string, timeoutMs = this.timeoutMs): Promise<Response> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = signRequest(this.identity, { method, url, body: body ?? '', to }, { now: this.now() });
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.call(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  }

  /**
   * Use a friend's invite: check the hub at the link's addresses against its
   * fingerprint, then send the signed request. The friend shows as pending
   * until their owner accepts.
   */
  async acceptInvite(link: string, name: string | undefined, actor = 'owner'): Promise<FriendDto> {
    const inv = parseInviteLink(link);
    if (!inv) throw new HttpError(400, 'That is not a friend link. It starts with conclave://friend.');
    if (inv.expiresAt <= this.now()) throw new HttpError(400, 'This invite has expired. Ask your friend for a new one.');
    if (inv.fp === this.fingerprint) throw new HttpError(400, "This is your own hub's invite. Send it to a friend.");
    if (name) this.setName(name);
    const existing = this.store.friendByFingerprint(inv.fp);
    if (existing?.status === 'active') throw new HttpError(409, `You are friends with ${existing.name} already.`);
    if (existing?.status === 'blocked') throw new HttpError(409, `${existing.name}'s hub has a new key. Confirm or remove it in Friends first.`);
    if (existing?.status === 'pending' && existing.direction === 'in') return this.accept(existing.id, actor);

    // an address the link names that is never a friend's hub is not called, and not kept as a hint
    const { kept: urls, refused } = await this.screen([inv.url, ...inv.alts]);
    this.refusedAddresses(actor, `an invite link for ${inv.fp}`, refused);
    if (!urls.length) throw new HttpError(400, `This link names no address a friend's hub can have: ${refused.join(', ')}.`);
    let publicKey: string | undefined;
    let base: string | undefined;
    const problems: string[] = [];
    for (const url of urls) {
      const seen = await this.identityAt(url);
      if ('error' in seen) {
        problems.push(seen.error);
        continue;
      }
      if (fingerprintOf(seen.publicKey) !== inv.fp) {
        problems.push(`The hub at ${url} is not the one in the link: its key does not match.`);
        continue;
      }
      publicKey = seen.publicKey;
      base = url;
      break;
    }
    if (!publicKey || !base) throw new HttpError(502, `Could not check your friend's hub. ${problems.join(' ')}`);

    // until their record arrives, the link's addresses are hints that may move
    const hints: PeerAddress[] = [base, ...urls.filter((u) => u !== base)].map((url) => ({ url, kind: 'quick' }));
    const placeholder = `Hub ${formatFingerprint(inv.fp).slice(0, 9)}`;
    const friend = existing
      ? this.store.updateFriend(existing.id, { status: 'pending', direction: 'out', publicKey, addresses: { addrs: hints, seq: -1 }, verified: false, lastError: null, blockedReason: null, pendingKey: null })!
      : this.store.insertFriend({ name: placeholder, fingerprint: inv.fp, publicKey, addresses: { addrs: hints, seq: -1 }, status: 'pending', direction: 'out', verified: false, grants: { ...DEFAULT_GRANTS } });
    // the request did not arrive: leave things as they were
    const undo = () => {
      if (!existing) this.store.deleteFriend(friend.id);
      else this.store.updateFriend(existing.id, { status: existing.status, direction: existing.direction, publicKey: existing.publicKey, addresses: existing.addresses, verified: existing.verified });
    };

    const id = ulid(this.now());
    const body = { name: this.ourName(), publicKey: this.identity.publicKey, record: this.record(), invite: inviteProof(inviteSecretHash(inv.secret), this.fingerprint, inv.fp, id) };
    const { envelope } = buildEnvelope(this.identity, { id, type: 'friend.request', to: inv.fp, body, created: this.now() });
    let res: Response;
    try {
      res = await this.signed(base, inv.fp, 'POST', '/peer/v1/friend-request', JSON.stringify(envelope));
    } catch (err) {
      undo();
      throw new HttpError(502, `Could not reach your friend's hub (${short(err)}).`);
    }
    if (!res.ok) {
      undo();
      const said = await errorText(res);
      throw new HttpError(res.status === 429 ? 429 : 409, `Your friend's hub turned the request away: ${said}`);
    }
    this.audit(actor, 'friend.request', `to ${inv.fp} at ${base}`);
    this.emitFriend(friend.id);
    return this.dto(this.store.friend(friend.id)!);
  }

  // -------------------------------------------------------------------------
  // Add a friend by their hub's address
  // -------------------------------------------------------------------------

  /** Take friend requests from hubs that know only this hub's address. On unless the owner turned it off. */
  requestsByAddress(): boolean {
    return this.engine.repos.kv.get<boolean>(KV_BY_ADDRESS, true) !== false;
  }

  settings(): FriendSettings {
    const best = this.reachability().best;
    return { requestsByAddress: this.requestsByAddress(), ...(best ? { address: best.url } : {}), blocked: this.store.blocks() };
  }

  setSettings(input: { requestsByAddress?: boolean }, actor = 'owner'): FriendSettings {
    if (input.requestsByAddress !== undefined) {
      this.engine.repos.kv.set(KV_BY_ADDRESS, input.requestsByAddress);
      this.audit(actor, 'friend.settings', `requests by address ${input.requestsByAddress ? 'on' : 'off'}`);
    }
    return this.settings();
  }

  /** Turn a hub away for good: a request waiting is declined, a friend removed, and its requests refused until unblocked. */
  block(id: string, actor = 'owner'): FriendSettings {
    const f = this.require(id);
    if (f.status === 'pending') this.decline(f.id, actor);
    else if (f.status !== 'removed') this.remove(f.id, actor);
    this.store.block(f.fingerprint, f.name);
    this.audit(actor, 'friend.blocked', `${f.name} (${f.fingerprint})`);
    this.emitFriend(f.id);
    return this.settings();
  }

  unblock(fingerprint: string, actor = 'owner'): FriendSettings {
    const fp = fingerprint.toLowerCase();
    if (!this.store.unblock(fp)) throw new HttpError(404, 'That hub is not blocked.');
    this.audit(actor, 'friend.unblocked', fp);
    return this.settings();
  }

  /** A one time invite for an email: the link, and a mailto: link carrying it. */
  async mailInvite(email: string, actor = 'owner'): Promise<MailInviteResult> {
    const to = cleanEmail(email);
    if (!to) throw new HttpError(400, 'That is not an email address.');
    const inv = await this.createInvite({}, actor);
    return { link: inv.link, expiresAt: inv.expiresAt, mailto: inviteMailto(to, this.ourName(), inv.link, this.fingerprint) };
  }

  /**
   * Add a friend by their hub's address: check the hub there proves a key,
   * then send a signed request with no invite in it. Their hub keeps it
   * waiting for its owner, under the limits for requests by address. When it
   * does not go, the result says why, and with an email carries an invite in
   * a mailto: link they can use from their side instead.
   */
  async addByAddress(input: { address: string; email?: string; name?: string }, actor = 'owner'): Promise<AddFriendResult> {
    const url = hubAddress(input.address);
    if (!url) throw new HttpError(400, 'That is not a hub address. It looks like https://hub.example.com.');
    const email = input.email?.trim() ? cleanEmail(input.email) : undefined;
    if (input.email?.trim() && !email) throw new HttpError(400, 'That is not an email address.');
    const refused = await this.addressRefused(url);
    if (refused) {
      this.refusedAddresses(actor, 'an address to add a friend by', [`${url} (${refused})`]);
      throw new HttpError(400, refused === 'this hub' ? "That is your own hub's address. Give it to a friend instead." : `${url} is never a friend's hub (${refused}).`);
    }
    const label = cleanName(input.name);
    const fallback = async (reason: string): Promise<AddFriendResult> => {
      if (!email) return { sent: false, reason };
      try {
        const m = await this.mailInvite(email, actor);
        return { sent: false, reason, invite: { link: m.link, expiresAt: m.expiresAt }, mailto: m.mailto };
      } catch (err) {
        return { sent: false, reason: `${reason} An invite by email could not be made either: ${short(err)}` };
      }
    };

    const seen = await this.identityAt(url);
    if ('error' in seen) return fallback(`No Conclave hub answered there. ${seen.error}`);
    const fp = fingerprintOf(seen.publicKey);
    if (fp === this.fingerprint) throw new HttpError(400, "That is your own hub's address. Give it to a friend instead.");
    const existing = this.store.friendByFingerprint(fp);
    if (existing?.status === 'active') throw new HttpError(409, `You are friends with ${existing.name} already.`);
    if (existing?.status === 'blocked') throw new HttpError(409, `${existing.name}'s hub has a new key. Confirm or remove it in Friends first.`);
    // asking them yourself takes them off your block list
    if (this.store.isBlocked(fp)) this.store.unblock(fp);
    if (existing?.status === 'pending' && existing.direction === 'in') {
      if (email || label) this.store.updateFriend(existing.id, { ...(email ? { email } : {}), ...(label ? { name: label } : {}) });
      return { sent: true, friend: this.accept(existing.id, actor) };
    }

    const hints: PeerAddress[] = [{ url, kind: 'own' }];
    const friend = existing
      ? this.store.updateFriend(existing.id, { status: 'pending', direction: 'out', publicKey: seen.publicKey, addresses: { addrs: hints, seq: -1 }, verified: false, lastError: null, blockedReason: null, pendingKey: null, ...(email ? { email } : {}), ...(label ? { name: label } : {}) })!
      : this.store.insertFriend({ name: label ?? `Hub ${formatFingerprint(fp).slice(0, 9)}`, fingerprint: fp, publicKey: seen.publicKey, addresses: { addrs: hints, seq: -1 }, status: 'pending', direction: 'out', verified: false, grants: { ...DEFAULT_GRANTS }, ...(email ? { email } : {}) });
    const undo = () => {
      if (!existing) this.store.deleteFriend(friend.id);
      else this.store.updateFriend(existing.id, { status: existing.status, direction: existing.direction, publicKey: existing.publicKey, addresses: existing.addresses, verified: existing.verified });
    };

    const id = ulid(this.now());
    // a name, the hub key and the address record: nothing more until they accept
    const body = { name: this.ourName(), publicKey: this.identity.publicKey, record: this.record(), via: 'address' };
    const { envelope } = buildEnvelope(this.identity, { id, type: 'friend.request', to: fp, body, created: this.now() });
    let res: Response;
    try {
      res = await this.signed(url, fp, 'POST', '/peer/v1/friend-request', JSON.stringify(envelope));
    } catch (err) {
      undo();
      return fallback(`Could not reach the hub at ${url} (${short(err)}).`);
    }
    if (!res.ok) {
      undo();
      return fallback(`Their hub turned the request away: ${await errorText(res)}`);
    }
    this.audit(actor, 'friend.request', `to ${fp} at ${url}, by address`);
    this.emitFriend(friend.id);
    return { sent: true, friend: this.dto(this.store.friend(friend.id)!) };
  }

  // -------------------------------------------------------------------------
  // Owner actions
  // -------------------------------------------------------------------------

  list(): FriendDto[] {
    return this.store.friends().map((f) => this.dto(f));
  }

  get(id: string): FriendDto {
    return this.dto(this.require(id));
  }

  /** Accept a request another hub sent. */
  accept(id: string, actor = 'owner'): FriendDto {
    const f = this.require(id);
    if (f.status === 'active') return this.dto(f);
    if (f.status !== 'pending' || f.direction !== 'in') throw new HttpError(409, f.status === 'pending' ? `You asked ${f.name}; their owner accepts.` : `${f.name} has no request waiting.`);
    if (!f.subkey) throw new HttpError(409, `${f.name}'s request has no key to answer with. Ask for a new request.`);
    const updated = this.store.updateFriend(f.id, { status: 'active', lastError: null })!;
    this.queue(updated, 'friend.accept', { name: this.ourName(), record: this.record() }, { preview: 'friend request accepted', actor });
    this.audit(actor, 'friend.added', `${f.name} (${f.fingerprint})`);
    this.emitFriend(f.id);
    return this.dto(this.store.friend(f.id)!);
  }

  /** Turn a request down. Nothing is sent: the other hub sees it waiting. */
  decline(id: string, actor = 'owner'): void {
    const f = this.require(id);
    if (f.status !== 'pending') throw new HttpError(409, `${f.name} has no request waiting.`);
    this.store.updateFriend(f.id, { status: 'removed', ...(f.direction === 'in' ? { declinedAt: this.now() } : {}) });
    this.audit(actor, f.direction === 'in' ? 'friend.declined' : 'friend.withdrawn', `${f.name} (${f.fingerprint})`);
    this.emitFriend(f.id);
  }

  /** Stop being friends: cancel the outbox, tell their hub (best effort), refuse what comes later. */
  remove(id: string, actor = 'owner'): void {
    const f = this.require(id);
    if (f.status === 'removed') return;
    const told = f.status === 'active' && !!f.subkey;
    this.store.updateFriend(f.id, { status: 'removed' });
    this.store.cancelQueued(f.id);
    if (told) this.queue(this.store.friend(f.id)!, 'friend.remove', {}, { expiresInMs: REMOVE_TTL_MS, preview: 'removed as a friend', actor });
    this.audit(actor, 'friend.removed', `${f.name} (${f.fingerprint})${told ? ', their hub is told' : ''}`);
    this.projects.friendGone(f, 'us');
    this.emitFriend(f.id);
  }

  /** The owner compared the safety code with the friend (or takes the mark away). */
  markVerified(id: string, verified: boolean, actor = 'owner'): FriendDto {
    const f = this.require(id);
    this.store.updateFriend(f.id, { verified });
    this.audit(actor, verified ? 'friend.verified' : 'friend.unverified', `${f.name} (${f.fingerprint}), safety code ${safetyCode(this.fingerprint, f.fingerprint)}`);
    this.emitFriend(f.id);
    return this.dto(this.store.friend(f.id)!);
  }

  setGrants(id: string, grants: Partial<FriendGrants>, actor = 'owner'): FriendDto {
    const f = this.require(id);
    const next = { ...f.grants, ...grants };
    this.store.updateFriend(f.id, { grants: next });
    this.audit(actor, 'friend.grants', `${f.name}: ${JSON.stringify(next)}`);
    this.emitFriend(f.id);
    return this.dto(this.store.friend(f.id)!);
  }

  rename(id: string, name: string, actor = 'owner'): FriendDto {
    return this.updateFriend(id, { name }, actor);
  }

  /** The owner's name for a friend, and the email kept for them here (empty clears it). */
  updateFriend(id: string, patch: { name?: string; email?: string }, actor = 'owner'): FriendDto {
    const f = this.require(id);
    const name = patch.name === undefined ? undefined : cleanName(patch.name);
    if (patch.name !== undefined && !name) throw new HttpError(400, 'name is required');
    const email = patch.email === undefined ? undefined : cleanEmail(patch.email);
    if (patch.email !== undefined && patch.email.trim() && !email) throw new HttpError(400, 'That is not an email address.');
    if (name === undefined && patch.email === undefined) throw new HttpError(400, 'name or email is required');
    this.store.updateFriend(f.id, { ...(name ? { name } : {}), ...(patch.email !== undefined ? { email: email ?? null } : {}) });
    if (name) this.audit(actor, 'friend.rename', `${f.fingerprint}: ${name}`);
    if (patch.email !== undefined) this.audit(actor, 'friend.email', `${f.fingerprint}: ${email ? 'set' : 'cleared'}`);
    this.emitFriend(f.id);
    return this.dto(this.store.friend(f.id)!);
  }

  /** Take the new key a blocked friend's hub showed, then fetch its record for the new subkey. */
  async confirmKey(id: string, actor = 'owner'): Promise<FriendDto> {
    const f = this.require(id);
    if (f.status !== 'blocked' || !f.pendingKey) throw new HttpError(409, `${f.name} has no new key waiting.`);
    const fp = fingerprintOf(f.pendingKey);
    const other = this.store.friendByFingerprint(fp);
    if (other && other.id !== f.id) throw new HttpError(409, `That key belongs to ${other.name}, another friend here.`);
    this.store.updateFriend(f.id, {
      fingerprint: fp,
      publicKey: f.pendingKey,
      pendingKey: null,
      blockedReason: null,
      status: 'active',
      verified: false,
      subkey: null,
      subkeySig: null,
      addresses: { addrs: f.addresses.addrs, seq: -1 },
      lastError: null,
    });
    this.audit(actor, 'key.changed', `${f.name}: ${f.fingerprint} is now ${fp}, confirmed by the owner`);
    await this.refreshRecord(f.id).catch((err) => log.warn(`could not fetch ${f.name}'s record: ${short(err)}`));
    this.kick(f.id);
    this.emitFriend(f.id);
    return this.dto(this.store.friend(f.id)!);
  }

  /** Send what is due and fetch what the friend's hub holds for this one, now. */
  async sync(id: string): Promise<FriendDto> {
    const f = this.require(id);
    this.store.retryNow(f.id);
    await this.deliver(f.id);
    await this.pull(f.id);
    return this.dto(this.store.friend(f.id)!);
  }

  sendNote(id: string, text: unknown, actor = 'owner'): OutboxItemDto {
    const f = this.require(id);
    if (f.status === 'pending') throw new HttpError(409, f.direction === 'out' ? `${f.name} has not accepted yet.` : `Accept ${f.name}'s request first.`);
    if (f.status === 'blocked') throw new HttpError(409, `${f.name}'s hub has a new key. Confirm it in Friends first.`);
    if (f.status === 'removed') throw new HttpError(409, `You are not friends with ${f.name} any more.`);
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    if (text.length > NOTE_MAX_CHARS) throw new HttpError(400, `A note is ${NOTE_MAX_CHARS} characters at most.`);
    if (!f.subkey) throw new HttpError(409, `This hub does not have ${f.name}'s key for sealing yet. Try Sync.`);
    return this.outboxDto(this.queue(f, 'note', { text }, { preview: `note: ${oneLine(text, 80)}`, actor, text }));
  }

  outbox(friendId?: string): OutboxItemDto[] {
    const f = friendId ? this.require(friendId) : undefined;
    return this.store.outbox({ friendId: f?.id }).map((i) => this.outboxDto(i));
  }

  inbox(friendId?: string): InboxItemDto[] {
    const f = friendId ? this.require(friendId) : undefined;
    const names = new Map(this.store.friends({ removed: true }).map((x) => [x.id, x.name]));
    return this.store.inbox({ friendId: f?.id, types: ['note'] }).map((i) => this.inboxDto(i, names.get(i.friendId) ?? 'a friend'));
  }

  retry(msgId: string, actor = 'owner'): OutboxItemDto {
    const item = this.store.outboxItem(msgId);
    if (!item) throw new HttpError(404, `unknown message ${msgId}`);
    const f = this.store.friend(item.friendId);
    if (!f || (f.status === 'removed' && item.type !== 'friend.remove')) throw new HttpError(409, 'You are not friends any more.');
    if (item.state === 'delivered') throw new HttpError(409, 'That message was delivered.');
    // a cancelled message no longer keeps what it would send
    if (item.state === 'cancelled' || !item.envelope) throw new HttpError(409, 'That message was cancelled. Send it again instead.');
    const now = this.now();
    this.store.updateOutbox(item.id, { state: 'queued', attempts: 0, nextTry: now, expiresAt: now + (item.type === 'friend.remove' ? REMOVE_TTL_MS : this.giveUpMs), lastError: null });
    this.audit(actor, 'peer.message.retry', `${item.type} ${item.id} to ${f.name}`);
    this.kick(f.id);
    return this.outboxDto(this.store.outboxItem(item.id)!);
  }

  cancel(msgId: string, actor = 'owner'): OutboxItemDto {
    const item = this.store.outboxItem(msgId);
    if (!item) throw new HttpError(404, `unknown message ${msgId}`);
    if (item.state === 'delivered') throw new HttpError(409, 'That message was delivered; it cannot be called back.');
    if (item.state !== 'cancelled') this.store.updateOutbox(item.id, { state: 'cancelled' });
    this.audit(actor, 'peer.message.cancel', `${item.type} ${item.id}`);
    this.schedule(item.friendId);
    this.emitFriend(item.friendId);
    return this.outboxDto(this.store.outboxItem(item.id)!);
  }

  /**
   * key.rotate to every friend: the new key's record and proof, in an
   * envelope the current key signs. For a future hub key rotation; the hub
   * switches keys only after this went out.
   */
  announceRotation(next: Signer, actor = 'owner'): number {
    const current = this.record();
    const record = signRecord(next, this.subkey.publicKey, current.addrs, current.seq + 1, this.now());
    let n = 0;
    for (const f of this.store.friends()) {
      if (f.status !== 'active' || !f.subkey) continue;
      this.queue(f, 'key.rotate', keyRotateBody(this.fingerprint, next, record), { preview: 'new hub key', actor });
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // The outbox
  // -------------------------------------------------------------------------

  /**
   * Offer bytes to a friend as a content addressed blob they fetch with
   * GET /peer/v1/blobs/<sha256> (a share's sealed payload). Returns its hash.
   */
  offerBlob(friend: Friend, bytes: Buffer, msgId?: string): string {
    const sha256 = sha256Hex(bytes);
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    const path = join(this.blobDir, sha256);
    writeFileSync(path, bytes, { mode: 0o600 });
    this.store.putBlob({ sha256, friendId: friend.id, dir: 'out', ...(msgId ? { msgId } : {}), size: bytes.length, path });
    return sha256;
  }

  /** Take back a blob offered to a friend (an unsent share). */
  withdrawBlob(sha256: string, friendId: string): void {
    const row = this.store.blob(sha256, friendId, 'out');
    this.store.dropBlob(sha256, friendId, 'out');
    // another friend may have been offered the same bytes
    if (row && !this.store.db.query(`SELECT 1 FROM peer_blobs WHERE sha256 = ? AND dir = 'out'`).get(sha256)) rmSync(row.path, { force: true });
  }

  /** Fetch a blob a friend's hub offered this one (a share's payload, on Accept). Checks its size and hash. */
  async fetchOffered(friendId: string, sha256: string, size: number): Promise<Buffer> {
    const friend = this.store.friend(friendId);
    if (!friend || friend.status !== 'active') throw new HttpError(409, `You are not friends with ${friend?.name ?? 'them'} now.`);
    const conn = await this.connect(friend);
    if (!conn.base) throw new HttpError(502, conn.error);
    let res: Response;
    try {
      res = await this.signed(conn.base, friend.fingerprint, 'GET', `/peer/v1/blobs/${sha256}`, undefined, this.fetchTimeoutMs);
    } catch (err) {
      throw new HttpError(502, `Could not fetch it from ${friend.name}'s hub (${short(err)}).`);
    }
    if (res.status === 404 || res.status === 403) throw new HttpError(410, `${friend.name}'s hub no longer has it (${res.status}). They may have unsent or updated it.`);
    if (!res.ok) throw new HttpError(502, `${friend.name}'s hub answered ${res.status}: ${await errorText(res)}`);
    let bytes: Buffer;
    try {
      // never more than the offer said: a hub that keeps sending is cut off there
      bytes = Buffer.from(await readCapped(res.body, size));
    } catch (err) {
      if (err instanceof BodyTooLarge) throw new HttpError(502, `What ${friend.name}'s hub sent does not match the offer.`);
      throw new HttpError(502, `Could not fetch it from ${friend.name}'s hub (${short(err)}).`);
    }
    if (bytes.length !== size || sha256Hex(bytes) !== sha256) throw new HttpError(502, `What ${friend.name}'s hub sent does not match the offer.`);
    this.store.updateFriend(friend.id, { lastSeen: this.now(), lastError: null });
    return bytes;
  }

  /** Sign and seal a message for the friend's current key; a large body goes to a blob file offered to them. */
  private seal(friend: Friend, id: string, type: string, body: string, created: number): { envelope: string; blob?: string; size?: number } {
    const { envelope, blob } = buildEnvelope(this.identity, { id, type, to: friend.fingerprint, body: JSON.parse(body), recipientSubkey: friend.subkey, blobThreshold: this.blobThreshold, created });
    if (!blob) return { envelope: JSON.stringify(envelope) };
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    const path = join(this.blobDir, envelope.blob!.sha256);
    writeFileSync(path, blob, { mode: 0o600 });
    this.store.putBlob({ sha256: envelope.blob!.sha256, friendId: friend.id, dir: 'out', msgId: id, size: blob.length, path });
    return { envelope: JSON.stringify(envelope), blob: envelope.blob!.sha256, size: blob.length };
  }

  /** Sign and seal a message into the outbox and start delivering it. */
  queue(friend: Friend, type: string, body: unknown, opts: { expiresInMs?: number; preview?: string; actor?: string; id?: string; text?: string } = {}): OutboxItem {
    if (!friend.subkey) throw new HttpError(409, `This hub does not have ${friend.name}'s key for sealing yet.`);
    const now = this.now();
    const id = opts.id ?? ulid(now);
    const text = JSON.stringify(body ?? {});
    const sealed = this.seal(friend, id, type, text, now);
    const item = this.store.insertOutbox({
      id,
      friendId: friend.id,
      type,
      envelope: sealed.envelope,
      ...(sealed.blob ? { blob: sealed.blob } : {}),
      body: text,
      nextTry: now,
      expiresAt: now + (opts.expiresInMs ?? this.giveUpMs),
      createdAt: now,
      preview: opts.preview ?? type,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
    });
    this.audit(opts.actor ?? 'hub', 'peer.message.out', `${type} ${id} to ${friend.name} (${friend.fingerprint})${sealed.size ? `, body as a ${sealed.size} byte blob` : ''}`);
    // the hub's log files: the type and ids, never the body
    log.info('message out', { friendId: friend.id, type, id, ...(sealed.size ? { blobBytes: sealed.size } : {}) });
    this.kick(friend.id);
    return item;
  }

  /**
   * The friend's key or subkey changed: seal what still waits for them again,
   * with the same ids, so it opens on their hub and names their new key.
   */
  private reseal(friendId: string): number {
    const friend = this.store.friend(friendId);
    if (!friend?.subkey) return 0;
    let n = 0;
    for (const item of this.store.resealable(friendId)) {
      const sealed = this.seal(friend, item.id, item.type, item.body!, item.createdAt);
      this.store.setEnvelope(item.id, sealed.envelope, sealed.blob);
      n++;
    }
    // a share's payload sealed for the old key does not open on theirs: seal it again and offer the new one
    n += this.shares.resealFor(friend);
    return n;
  }

  /** What may go to a friend in its state. Nothing goes without their subkey. */
  private mayPush(f: Friend, type: string): boolean {
    if (!f.subkey) return false;
    if (f.status === 'active') return true;
    if (f.status === 'removed') return type === 'friend.remove';
    return false;
  }

  /** Will this go once the friend's subkey is fetched (an active friend after a key change)? */
  private willPush(f: Friend, type: string): boolean {
    return this.mayPush(f, type) || (f.status === 'active' && !f.subkey);
  }

  /** Arm the delivery job for the friend's next due item (or the next expiry). */
  private schedule(friendId: string): void {
    const key = `${DELIVER_JOB}.${friendId}`;
    const f = this.store.friend(friendId);
    let at: number | undefined;
    if (f) {
      for (const i of this.store.queued(friendId)) {
        const t = this.willPush(f, i.type) ? Math.min(i.nextTry, i.expiresAt) : i.expiresAt;
        at = at === undefined ? t : Math.min(at, t);
      }
    }
    if (at === undefined) this.scheduler.cancel(key);
    else this.scheduler.enqueue(DELIVER_JOB, at, { friendId }, key);
  }

  /** Schedule, and try right away without waiting for the scheduler. */
  private kick(friendId: string): void {
    this.schedule(friendId);
    void this.guard(() => this.deliver(friendId));
  }

  /** Deliver what is due for a friend. Never throws. */
  deliver(friendId: string): Promise<void> {
    return this.lock(`out:${friendId}`, () => this.deliverNow(friendId));
  }

  private async deliverNow(friendId: string): Promise<void> {
    if (this.closed) return;
    let friend = this.store.friend(friendId);
    if (!friend) return;
    this.expire(friend);
    if (friend.status === 'active' && !friend.subkey) {
      // after a key change: fetch the friend's record for its subkey, then seal again what waits
      const waiting = this.store.queued(friendId, { due: this.now() });
      if (waiting.length) {
        try {
          await this.refreshRecord(friendId);
        } catch (err) {
          const error = `Could not fetch ${friend.name}'s keys (${short(err)}).`;
          for (const item of waiting) this.retryLater(item, error);
          this.store.updateFriend(friendId, { lastError: error });
        }
        friend = this.store.friend(friendId)!;
      }
    }
    const due = this.store.queued(friendId, { due: this.now() }).filter((i) => this.mayPush(friend!, i.type));
    if (due.length) {
      const conn = await this.connect(friend);
      friend = this.store.friend(friendId)!;
      if (!conn.base) {
        for (const item of due) this.retryLater(item, conn.error);
        this.store.updateFriend(friendId, { lastError: conn.error });
        log.warn('delivery failed', { friendId, waiting: due.length, network: true, error: conn.error });
      } else {
        let lastError: string | null = null;
        for (let i = 0; i < due.length; i++) {
          // read it again: it may have been cancelled, pulled or sealed again meanwhile
          const item = this.store.outboxItem(due[i].id);
          if (item?.state !== 'queued') continue;
          const r = await this.push(conn.base, friend, item);
          if (r.ok) {
            this.store.updateOutbox(item.id, { state: 'delivered', deliveredAt: this.now(), via: 'push', lastError: null });
            log.info('message delivered', { friendId, type: item.type, id: item.id, via: 'push', attempts: item.attempts + 1 });
            continue;
          }
          lastError = r.error;
          log.warn('delivery failed', { friendId, type: item.type, id: item.id, attempts: item.attempts + 1, permanent: !!r.permanent, network: !!r.network, error: r.error });
          if (r.permanent) this.failItem(friend, item, r.error);
          else if (r.network) {
            for (const rest of due.slice(i)) this.retryLater(rest, r.error);
            break;
          } else this.retryLater(item, r.error);
        }
        this.store.updateFriend(friendId, lastError ? { lastError } : { lastSeen: this.now(), lastError: null });
      }
      this.emitFriend(friendId);
    }
    this.schedule(friendId);
  }

  private retryLater(item: OutboxItem, error: string): void {
    const attempts = item.attempts + 1;
    const delay = Math.round(this.backoff(attempts) * (0.8 + Math.random() * 0.4));
    this.store.updateOutbox(item.id, { attempts, nextTry: this.now() + delay, lastError: error });
  }

  private failItem(friend: Friend, item: OutboxItem, error: string): void {
    this.store.updateOutbox(item.id, { state: 'failed', attempts: item.attempts + 1, lastError: error });
    this.notify(`Not delivered to ${friend.name}`, `${item.preview}. ${error} Retry or cancel it in Friends.`, 'warning');
  }

  /** Items past their time: a best effort one lapses quietly, the rest fail and the owner hears. */
  private expire(friend: Friend): void {
    const now = this.now();
    for (const item of this.store.queued(friend.id)) {
      if (item.expiresAt > now) continue;
      if (item.type === 'friend.remove') {
        this.store.updateOutbox(item.id, { state: 'expired', lastError: item.lastError ?? 'Not delivered in a day.' });
        continue;
      }
      const days = Math.round(this.giveUpMs / 86_400_000);
      this.store.updateOutbox(item.id, { state: 'failed', lastError: `Not delivered in ${days} days. ${item.lastError ?? ''}`.trim() });
      this.notify(`Not delivered to ${friend.name}`, `${item.preview}. ${friend.name}'s hub was not reachable for ${days} days. Retry or cancel it in Friends.`, 'warning');
    }
  }

  /**
   * The first address of the friend's record where its hub proves its key,
   * checked on every run (one check covers all the messages of the run).
   * A different key at a stable or own address is a key change: the friend
   * is blocked until the owner confirms. Elsewhere it is an address that
   * moved to another hub, and the next address is tried.
   */
  private async connect(friend: Friend): Promise<{ base?: string; error: string }> {
    const addrs = friend.addresses.addrs;
    if (!addrs.length) return { error: `This hub knows no address for ${friend.name}'s hub. It can still fetch what waits here.` };
    const problems: string[] = [];
    for (const a of addrs) {
      const seen = await this.identityAt(a.url);
      if ('error' in seen) {
        problems.push(seen.error);
        continue;
      }
      if (seen.publicKey === friend.publicKey) return { base: a.url, error: '' };
      if ((a.kind === 'stable' || a.kind === 'own') && friend.status === 'active') {
        this.keyChanged(friend, seen.publicKey, a.url);
        return { error: `${friend.name}'s hub has a new key. Confirm it in Friends before anything more is sent.` };
      }
      problems.push(`A different hub answers at ${a.url}.`);
    }
    return { error: `Could not reach ${friend.name}'s hub. ${problems.join(' ')}`.trim() };
  }

  /** A key change without a rotation the old key signed: block until the owner confirms. */
  private keyChanged(friend: Friend, publicKey: string, url: string): void {
    const fp = fingerprintOf(publicKey);
    this.store.updateFriend(friend.id, {
      status: 'blocked',
      pendingKey: publicKey,
      blockedReason: `${friend.name}'s hub answers with a new key its old key did not sign. Nothing is sent or taken until you confirm it.`,
    });
    this.audit(this.friendActor(friend), 'key.changed', `${friend.fingerprint} now answers at ${url} as ${fp}, without a signed rotation; blocked until the owner confirms`);
    this.notify(`${friend.name}'s hub has a new key`, `Check with ${friend.name} that they set their hub up again, then confirm the new key in Friends. Until then nothing moves.`, 'warning');
    this.emitFriend(friend.id);
  }

  private async push(base: string, friend: Friend, item: OutboxItem): Promise<{ ok: true } | { ok: false; error: string; permanent?: boolean; network?: boolean }> {
    let res: Response;
    try {
      res = await this.signed(base, friend.fingerprint, 'PUT', `/peer/v1/inbox/${item.id}`, item.envelope);
    } catch (err) {
      return { ok: false, network: true, error: `Could not reach ${friend.name}'s hub (${short(err)}).` };
    }
    if (res.ok) return { ok: true };
    const error = `${friend.name}'s hub answered ${res.status}: ${await errorText(res)}`;
    return { ok: false, error, permanent: [400, 409, 413, 415, 422].includes(res.status) };
  }

  // -------------------------------------------------------------------------
  // The pull path: fetch what a friend's hub holds for this one
  // -------------------------------------------------------------------------

  private async pullAll(): Promise<void> {
    try {
      for (const f of this.store.friends()) {
        if (this.closed) return;
        if (f.status === 'active' || (f.status === 'pending' && f.direction === 'out')) await this.pull(f.id).catch(() => 0);
      }
    } finally {
      if (!this.closed) this.scheduler.enqueue(PULL_JOB, this.now() + (this.reachability().ok ? 4 : 1) * this.pullEveryMs, {}, PULL_JOB);
    }
  }

  /**
   * GET /peer/v1/outbox on the friend's hub, page by page. Each request acks
   * the ids of the page before it, so their outbox marks them delivered; the
   * last, empty page carries the last acks. A message this hub refused is
   * acked too (so it does not come first in every page again), and named in
   * `refused` with the refusal's code, so their outbox shows it as not
   * delivered and says why. Returns how many were new.
   */
  pull(friendId: string): Promise<number> {
    return this.lock(`in:${friendId}`, async () => {
      let friend = this.store.friend(friendId);
      if (!friend || this.closed) return 0;
      if (!(friend.status === 'active' || (friend.status === 'pending' && friend.direction === 'out'))) return 0;
      const conn = await this.connect(friend);
      if (!conn.base) {
        this.store.updateFriend(friendId, { lastError: conn.error });
        this.emitFriend(friendId);
        return 0;
      }
      const base = conn.base;
      const to = friend.fingerprint;
      const page = (ack: string[], refused: string[]) => {
        const q = [...(ack.length ? [`ack=${ack.join(',')}`] : []), ...(refused.length ? [`refused=${refused.join(',')}`] : [])];
        return this.signed(base, to, 'GET', `/peer/v1/outbox${q.length ? `?${q.join('&')}` : ''}`);
      };
      let ack: string[] = [];
      let refused: string[] = [];
      let got = 0;
      let error: string | null = null;
      for (let n = 0; ; n++) {
        let res: Response;
        try {
          res = await page(ack, refused);
        } catch (err) {
          error = `Could not fetch from ${friend.name}'s hub (${short(err)}).`;
          break;
        }
        if (!res.ok) {
          error = `${friend.name}'s hub answered ${res.status}: ${await errorText(res)}`;
          break;
        }
        const data = (await readJsonCapped<{ messages?: unknown }>(res, PULL_PAGE_BYTES).catch(() => undefined)) as { messages?: unknown } | undefined;
        const messages = Array.isArray(data?.messages) ? data.messages.slice(0, 100) : [];
        ack = [];
        refused = [];
        if (!messages.length) break;
        for (const m of messages) {
          const raw = (m as { id?: unknown })?.id;
          const id = typeof raw === 'string' && ULID.test(raw) ? raw : undefined;
          friend = this.store.friend(friendId)!;
          try {
            if ((await this.receive(friend, m, 'pull')) === 'accepted') got++;
          } catch (err) {
            log.warn(`refused a pulled message from ${friend.name}: ${short(err)}`);
            if (id) refused.push(`${id}.${err instanceof PeerRefusal && REFUSAL_CODE.test(err.code) ? err.code : 'error'}`);
          }
          if (id) ack.push(id);
        }
        // a message ended the friendship, or enough pages for one go: send the acks and stop
        const still = this.store.friend(friendId);
        if (n >= 20 || !still || !(still.status === 'active' || still.status === 'pending')) {
          if (ack.length) await page(ack, refused).catch(() => undefined);
          break;
        }
      }
      this.store.updateFriend(friendId, error ? { lastError: error } : { lastSeen: this.now(), lastError: null });
      this.emitFriend(friendId);
      return got;
    });
  }

  /** The friend's signed record from GET /peer/v1/addresses (after a key change, for the new subkey). */
  private async refreshRecord(friendId: string): Promise<void> {
    const friend = this.store.friend(friendId);
    if (!friend) return;
    const conn = await this.connect(friend);
    if (!conn.base) throw new Error(conn.error);
    const res = await this.signed(conn.base, friend.fingerprint, 'GET', '/peer/v1/addresses');
    if (!res.ok) throw new Error(`${res.status}: ${await errorText(res)}`);
    const record = verifyRecord(await readJsonCapped(res, SMALL_ANSWER_BYTES), friend.publicKey);
    if (!record) throw new Error('the record does not check out');
    if (record.seq > friend.addresses.seq || !friend.subkey) {
      const screened = await this.screenRecord(record);
      this.store.updateFriend(friend.id, this.recordPatch(record, screened));
      this.refusedAddresses(this.friendActor(friend), `${friend.name}'s address record`, screened.refused);
      if (record.subkey !== friend.subkey) this.reseal(friend.id);
    }
  }

  // -------------------------------------------------------------------------
  // Inbound: the verifier and the inbox
  // -------------------------------------------------------------------------

  /** The authorities a signature may name: the Host the request came with, and every address of this hub. */
  private authorities(req: IncomingRequest): string[] {
    const out = [new URL(req.url).host];
    const fwd = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (fwd) out.push(fwd);
    for (const a of this.host.remote.addresses()) {
      try {
        out.push(new URL(a.url).host);
      } catch {
        /* not a URL */
      }
    }
    const pub = this.engine.config.get().server.publicUrl;
    if (pub) {
      try {
        out.push(new URL(pub).host);
      } catch {
        /* bad publicUrl */
      }
    }
    return out;
  }

  /**
   * Check a signed request from a friend's hub: shape, clock and recipient,
   * a known key in one of `statuses`, the signature, then the nonce. Throws
   * PeerRefusal. Never consults the owner and client tokens.
   */
  verify(req: IncomingRequest, statuses: Friend['status'][]): Friend {
    const parsed = parseSignature(req, this.fingerprint, this.now());
    if (isRefusal(parsed)) throw refuse(parsed.status, parsed.code, parsed.message);
    const friend = this.store.friendByFingerprint(parsed.keyid);
    if (!friend) throw refuse(401, 'unknown-key', 'This hub does not know that key.');
    if (friend.status === 'removed' && !statuses.includes('removed')) throw refuse(403, 'not-friends', 'You are not friends with this hub.');
    if (friend.status === 'blocked') throw refuse(403, 'blocked', "This hub is waiting for its owner to confirm your hub's key.");
    if (!statuses.includes(friend.status)) throw refuse(403, 'not-yet', 'Not until the friend request is accepted.');
    if (!verifySignature(parsed, req, friend.publicKey, this.authorities(req))) throw refuse(401, 'signature', 'The request signature does not check out.');
    if (!this.store.useNonce(parsed.keyid, parsed.nonce, (parsed.expires + SKEW_SEC) * 1000)) throw refuse(401, 'replay', 'This request was seen before.');
    this.seen(friend);
    return this.store.friend(friend.id)!;
  }

  /** The friend's hub reached us: note it, and send what waits for it now. */
  private seen(friend: Friend): void {
    const now = this.now();
    this.store.updateFriend(friend.id, { lastSeen: now });
    if ((this.kicked.get(friend.id) ?? 0) > now - 30_000) return;
    if (!this.store.countQueued(friend.id)) return;
    this.kicked.set(friend.id, now);
    this.store.retryNow(friend.id);
    this.kick(friend.id);
  }

  /**
   * POST /peer/v1/friend-request: a stranger's hub with one of our invite
   * secrets, or with this hub's address alone. The request is signed by the
   * key it carries; an invite is proven with an HMAC bound to both keys and
   * the message id.
   *
   * A request by address (no invite, via "address") holds a name, a key and
   * an address record and nothing else, and only waits for the owner. It is
   * taken while the owner allows requests by address, from a key that is not
   * blocked and was not declined in the last 30 days, at most 3 an hour from
   * one network address and 20 a day for the hub, 16 KB at most, with at most
   * 5 of them waiting (apart from the requests with an invite). Every refusal
   * of that kind reads the same, so a stranger cannot tell a block from "off".
   * The record's addresses are screened like every friend's (names looked
   * up), and an address that is never a friend's hub is not kept.
   */
  async friendRequest(req: IncomingRequest, from: { ip?: string; local?: boolean } = {}): Promise<{ status: 'pending' | 'active'; friend: Friend }> {
    const parsed = parseSignature(req, this.fingerprint, this.now());
    if (isRefusal(parsed)) throw refuse(parsed.status, parsed.code, parsed.message);
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(req.body).toString('utf8'));
    } catch {
      throw refuse(400, 'malformed', 'The body is not JSON.');
    }
    const env = parseEnvelope(raw);
    if (!env || env.type !== 'friend.request' || env.plain === undefined) throw refuse(400, 'malformed', 'That is not a friend request.');
    if (env.to !== this.fingerprint) throw refuse(400, 'recipient', 'The request is for another hub.');
    let body: { name?: unknown; publicKey?: unknown; record?: unknown; invite?: unknown; via?: unknown };
    try {
      body = JSON.parse(env.plain);
    } catch {
      throw refuse(400, 'malformed', 'The request body is not JSON.');
    }
    const byAddress = body.invite === undefined && body.via === 'address';
    if (byAddress) {
      // counted before the keys are checked: a key costs a stranger nothing
      if (req.body.length > ADDRESS_REQUEST_MAX_BYTES) throw refuse(413, 'too-large', `A friend request is ${ADDRESS_REQUEST_MAX_BYTES / 1024} KB at most.`);
      if (!this.requestsByAddress()) throw refuse(403, 'closed', CLOSED);
      if (!from.local) {
        const ip = from.ip ?? 'unknown';
        if (!this.byAddressHour.hit(ip)) throw refuse(429, 'rate', `Too many friend requests by address from your network. Try again in ${this.byAddressHour.retryAfterSec(ip)} seconds.`);
        if (!this.byAddressDay.hit('all')) throw refuse(429, 'rate', 'This hub has had enough friend requests by address today. Try again tomorrow, or ask its owner for an invite link.');
      }
    }
    const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
    let fp: string;
    try {
      fp = fingerprintOf(publicKey);
    } catch {
      throw refuse(400, 'key', 'The request carries no hub key.');
    }
    if (fp !== parsed.keyid || fp !== env.from) throw refuse(401, 'key', 'The request is not signed by the key it carries.');
    if (fp === this.fingerprint) throw refuse(400, 'self', 'That is this hub.');
    if (!verifySignature(parsed, req, publicKey, this.authorities(req))) throw refuse(401, 'signature', 'The request signature does not check out.');
    if (!verifyEnvelope(env, publicKey)) throw refuse(400, 'envelope', 'The message signature does not check out.');
    if (!this.store.useNonce(fp, parsed.nonce, (parsed.expires + SKEW_SEC) * 1000)) throw refuse(401, 'replay', 'This request was seen before.');
    const record = verifyRecord(body.record, publicKey);
    if (!record) throw refuse(400, 'record', "The request's address record does not check out.");
    // names take a lookup; this is the only wait, so the checks below and the writes after them still go in one step
    const screened = await this.screenRecord(record);

    // an invite this hub already used counts only while its request still waits (a lost answer sent again)
    const existing = this.store.friendByFingerprint(fp);
    const waiting = existing?.status === 'pending' && existing.direction === 'in';
    const asked = existing?.status === 'pending' && existing.direction === 'out';
    let used: { id: string; secretHash: string } | undefined;
    let open: { id: string; secretHash: string } | undefined;
    if (byAddress) {
      // a request this hub asked for itself (we added them too) is never turned away
      const declined = existing?.status === 'removed' && !!existing.declinedAt && this.now() - existing.declinedAt < DECLINE_COOLOFF_MS;
      if (!asked && (this.store.isBlocked(fp) || declined)) throw refuse(403, 'closed', CLOSED);
    } else {
      const proof = typeof body.invite === 'string' ? body.invite : '';
      const matches = (i: { secretHash: string }) => sameText(inviteProof(i.secretHash, fp, this.fingerprint, env.id), proof);
      used = waiting ? this.store.usedInvites(fp).find(matches) : undefined;
      open = used ? undefined : this.store.openInvites().find(matches);
      if (!used && !open) throw refuse(403, 'invite', 'This invite is wrong, used or expired. Ask for a new one.');
    }

    const name = cleanName(body.name) ?? `Hub ${formatFingerprint(fp).slice(0, 9)}`;
    if (existing?.status === 'active') throw refuse(409, 'already', 'You are friends with this hub already.');
    if (existing?.status === 'blocked') throw refuse(403, 'blocked', "This hub is waiting for its owner to confirm your hub's key.");
    if (byAddress) {
      if (!waiting && !asked && this.store.pendingIn('address') >= MAX_ADDRESS_REQUESTS) throw refuse(429, 'pending', 'This hub has enough friend requests waiting. Try again once its owner has answered them, or ask for an invite link.');
    } else if (!waiting && this.store.pendingIn('invite') >= MAX_PENDING_REQUESTS) {
      throw refuse(429, 'pending', `This hub has ${MAX_PENDING_REQUESTS} friend requests waiting. Try again once its owner has answered them.`);
    }
    if (open && !this.store.useInvite(open.id, fp)) throw refuse(403, 'invite', 'This invite is wrong, used or expired. Ask for a new one.');

    const patch = { name, publicKey, ...this.recordPatch(record, screened), lastError: null, blockedReason: null, pendingKey: null };
    let friend: Friend;
    let status: 'pending' | 'active' = 'pending';
    if (asked) {
      // we asked them too: two requests crossed, so this is a yes on both sides. A name the owner gave them stays.
      const named = !existing!.name.startsWith('Hub ');
      friend = this.store.updateFriend(existing!.id, { ...patch, ...(named ? { name: existing!.name } : {}), status: 'active' })!;
      status = 'active';
      this.queue(friend, 'friend.accept', { name: this.ourName(), record: this.record() }, { preview: 'friend request accepted', actor: this.friendActor(friend) });
      this.audit(this.friendActor(friend), 'friend.added', `${name} (${fp}), both hubs asked`);
    } else if (existing) {
      const via = waiting ? (existing.via ?? 'invite') : byAddress ? 'address' : 'invite';
      friend = this.store.updateFriend(existing.id, { ...patch, status: 'pending', direction: 'in', verified: false, via, declinedAt: null })!;
    } else {
      friend = this.store.insertFriend({ name, fingerprint: fp, publicKey, ...this.recordPatch(record, screened), status: 'pending', direction: 'in', verified: false, grants: { ...DEFAULT_GRANTS }, via: byAddress ? 'address' : 'invite' });
    }
    this.store.insertInbox({ friendId: friend.id, id: env.id, type: env.type, state: 'received', body: { name } });
    this.refusedAddresses(this.friendActor(friend), `${name}'s friend request`, screened.refused);
    if (status === 'pending' && !used && !waiting) {
      this.audit(this.friendActor(friend), 'friend.request', `${name} (${fp}) wants to be friends${byAddress ? ', by address' : ''}`);
      const how = byAddress ? 'They added your hub by its address. Compare the safety code with them before you accept.' : 'Accept or decline it in Friends.';
      this.notify(`${name} wants to be friends`, `${name} (${formatFingerprint(fp).slice(0, 9)} …) sent a friend request. ${how}`);
    }
    this.store.updateFriend(friend.id, { lastSeen: this.now() });
    this.emitFriend(friend.id);
    return { status, friend: this.store.friend(friend.id)! };
  }

  /** A record's fields for a friend, with only the addresses this hub will call. The signed record is kept only when it holds no other. */
  private recordPatch(record: AddressRecord, screened: Screened): Pick<Friend, 'addresses' | 'subkey' | 'subkeySig'> {
    const whole = screened.addrs.length === record.addrs.length;
    return { addresses: { addrs: screened.addrs, seq: record.seq, ...(whole ? { record } : {}) }, subkey: record.subkey, subkeySig: record.subkeySig };
  }

  /** Which types a friend may send in its state. Throws PeerRefusal. */
  private allowed(friend: Friend, type: string): void {
    if (type === 'friend.request') throw refuse(400, 'type', 'Friend requests go to /peer/v1/friend-request.');
    if (!(MESSAGE_TYPES as readonly string[]).includes(type)) throw refuse(422, 'type', `This hub does not take ${type} messages yet.`);
    const ok =
      friend.status === 'active' ||
      (friend.status === 'pending' && (friend.direction === 'out' ? type === 'friend.accept' || type === 'friend.remove' : type === 'friend.remove'));
    if (!ok) throw refuse(403, 'not-yet', 'Not until the friend request is accepted.');
    if ((type === 'note' || type === 'share.offer' || type === 'share.update' || type === 'project.invite') && !friend.grants.receiveShares) throw refuse(403, 'grant', 'This hub does not take notes or shares from you now.');
  }

  /**
   * One message from a friend, pushed or pulled. An id seen before answers
   * "duplicate" and changes nothing. Throws PeerRefusal. Only a message
   * with an address record waits (its names are looked up); the rest go
   * through in one step.
   */
  async receive(friend: Friend, raw: unknown, via: 'push' | 'pull'): Promise<'accepted' | 'duplicate'> {
    const env = parseEnvelope(raw);
    if (!env) throw refuse(400, 'malformed', 'That is not a conclave-peer/1 message.');
    if (env.to !== this.fingerprint) throw refuse(400, 'recipient', 'The message is for another hub.');
    if (env.from !== friend.fingerprint) throw refuse(403, 'sender', 'The message names another sender.');
    if (!verifyEnvelope(env, friend.publicKey)) throw refuse(400, 'envelope', 'The message signature does not check out.');
    if (this.store.inboxItem(friend.id, env.id)) return 'duplicate';
    this.allowed(friend, env.type);
    if (env.blob) {
      if (env.blob.size > BLOB_MAX_BYTES) throw refuse(413, 'too-large', `A body is ${BLOB_MAX_BYTES / 1024 / 1024} MB at most.`);
      this.store.insertInbox({ friendId: friend.id, id: env.id, type: env.type, envelope: JSON.stringify(env), state: 'fetching' });
      this.audit(this.friendActor(friend), 'peer.message.in', `${env.type} ${env.id} via ${via}, its ${env.blob.size} byte body to fetch`);
      log.info('message body to fetch', { friendId: friend.id, type: env.type, id: env.id, via, blobBytes: env.blob.size });
      this.scheduler.enqueue(FETCH_JOB, this.now(), { friendId: friend.id, id: env.id, attempt: 1 }, `${FETCH_JOB}.${friend.id}.${env.id}`);
      void this.guard(() => this.fetchBlob(friend.id, env.id, 1));
      return 'accepted';
    }
    let body: unknown;
    try {
      body = openEnvelope(env, this.subkey);
    } catch (err) {
      throw refuse(400, 'seal', short(err));
    }
    let screened: Screened | undefined;
    if (RECORD_TYPES.has(env.type)) {
      screened = await this.screenIn(friend, env.type, body);
      // the same message may have come the other way meanwhile, or the friend changed
      if (this.store.inboxItem(friend.id, env.id)) return 'duplicate';
      friend = this.store.friend(friend.id) ?? friend;
      this.allowed(friend, env.type);
    }
    const stored = this.apply(friend, env, body, screened);
    this.store.insertInbox({ friendId: friend.id, id: env.id, type: env.type, body: stored, state: 'received' });
    this.received(friend, env, via);
    return 'accepted';
  }

  /** After a message is stored: audit it, and tell the owner's apps about a note. */
  private received(friend: Friend, env: PeerEnvelope, via: 'push' | 'pull'): void {
    this.audit(this.friendActor(friend), 'peer.message.in', `${env.type} ${env.id} via ${via}`);
    log.info('message in', { friendId: friend.id, type: env.type, id: env.id, via });
    const f = this.store.friend(friend.id) ?? friend;
    if (env.type === 'note') {
      const item = this.store.inboxItem(friend.id, env.id);
      if (item) {
        const dto = this.inboxDto(item, f.name);
        this.engine.bus.emit({ type: 'friend.message', message: dto });
        this.notify(f.name, oneLine(dto.text ?? '', 200));
      }
    }
    this.emitFriend(friend.id);
  }

  /**
   * Do what a message says. Returns what the inbox keeps. Throws PeerRefusal
   * when the body is wrong. A record's addresses come screened (screenIn);
   * without that, none of them is kept.
   */
  private apply(friend: Friend, env: PeerEnvelope, body: unknown, screened: Screened = { addrs: [], refused: [] }): unknown {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const from = `${friend.name}'s address record`;
    switch (env.type) {
      case 'note': {
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim() || text.length > NOTE_MAX_CHARS) throw refuse(400, 'body', `A note needs text, ${NOTE_MAX_CHARS} characters at most.`);
        return { text };
      }
      case 'friend.accept': {
        const record = verifyRecord(b.record, friend.publicKey);
        if (!record) throw refuse(400, 'record', "The accept's address record does not check out.");
        const name = cleanName(b.name) ?? friend.name;
        if (friend.status === 'active') return { name };
        this.store.updateFriend(friend.id, { status: 'active', name: friend.name.startsWith('Hub ') ? name : friend.name, ...this.recordPatch(record, screened), lastError: null });
        this.refusedAddresses(this.friendActor(friend), from, screened.refused);
        this.audit(this.friendActor(friend), 'friend.added', `${name} (${friend.fingerprint}) accepted`);
        this.notify(`${name} accepted`, `You and ${name} are friends now. Compare the safety code ${safetyCode(this.fingerprint, friend.fingerprint)} to be sure.`, 'success');
        return { name };
      }
      case 'friend.remove': {
        this.store.updateFriend(friend.id, { status: 'removed' });
        this.store.cancelQueued(friend.id);
        this.audit(this.friendActor(friend), 'friend.removed', friend.status === 'active' ? `${friend.name} asked to stop being friends` : `${friend.name} took back the request`);
        if (friend.status === 'active') this.notify(`${friend.name} removed you`, `${friend.name}'s hub asked to stop being friends. Nothing more goes either way.`);
        this.projects.friendGone(friend, 'them');
        return {};
      }
      case 'address.update': {
        const record = verifyRecord(b.record, friend.publicKey);
        if (!record) throw refuse(400, 'record', 'The address record does not check out.');
        if (record.seq > friend.addresses.seq) {
          this.store.updateFriend(friend.id, this.recordPatch(record, screened));
          this.refusedAddresses(this.friendActor(friend), from, screened.refused);
          if (record.subkey !== friend.subkey) this.reseal(friend.id);
          if (this.store.countQueued(friend.id)) {
            this.store.retryNow(friend.id);
            this.kick(friend.id);
          }
        }
        return { seq: record.seq };
      }
      case 'key.rotate': {
        const next = verifyKeyRotate(friend.fingerprint, b);
        if (!next) throw refuse(400, 'rotate', 'The key rotation does not check out.');
        const other = this.store.friendByFingerprint(next.fingerprint);
        if (other && other.id !== friend.id) throw refuse(409, 'rotate', 'That key belongs to another friend here.');
        this.store.updateFriend(friend.id, { fingerprint: next.fingerprint, publicKey: next.publicKey, verified: false, pendingKey: null, ...this.recordPatch(next.record, screened) });
        this.refusedAddresses(this.friendActor(friend), from, screened.refused);
        this.reseal(friend.id);
        this.audit(this.friendActor(friend), 'key.changed', `${friend.fingerprint} is now ${next.fingerprint}, signed by the old key`);
        this.notify(`${friend.name}'s hub has a new key`, `Its old key signed the change. The safety code is new: compare ${safetyCode(this.fingerprint, next.fingerprint)} with ${friend.name} again.`);
        return { fingerprint: next.fingerprint };
      }
      case 'share.offer':
      case 'share.update':
      case 'share.revoke':
      case 'share.ack':
        return this.shares.receive(friend, env.type, b);
      case 'project.invite':
      case 'project.join':
      case 'project.leave':
      case 'project.meta':
      case 'project.item':
      case 'project.state':
      case 'project.sync':
        return this.projects.receive(friend, env.type, b);
      default:
        throw refuse(422, 'type', `This hub does not take ${env.type} messages yet.`);
    }
  }

  /**
   * GET /peer/v1/outbox for a friend: mark the acked ids delivered and the
   * ones it refused (`<id>.<code>`) not delivered, with why, so a refused
   * message neither shows as delivered nor waits in front of the rest. An
   * older hub acks a refused message without saying; that one counts as
   * delivered. Returns what still waits.
   */
  outboxFor(friend: Friend, ack: string[], refused: string[] = []): { messages: PeerEnvelope[] } {
    const no = new Map<string, string>();
    for (const r of refused.slice(0, 200)) {
      const [id = '', code = ''] = r.split('.');
      if (ULID.test(id) && REFUSAL_CODE.test(code)) no.set(id, code);
    }
    let marked = this.store.markPulled(friend.id, ack.filter((id) => ULID.test(id) && !no.has(id)).slice(0, 200));
    for (const [id, code] of no) {
      const item = this.store.outboxItem(id);
      if (item?.friendId !== friend.id || item.state !== 'queued') continue;
      this.failItem(friend, item, refusedWords(friend.name, code));
      this.audit(this.friendActor(friend), 'peer.message.refused', `${item.type} ${item.id}, taken by a pull and refused (${code})`);
      marked++;
    }
    const items = this.store.queued(friend.id, { limit: 50 }).filter((i) => this.mayPush(friend, i.type));
    if (marked) {
      this.schedule(friend.id);
      this.emitFriend(friend.id);
    }
    return { messages: items.map((i) => JSON.parse(i.envelope) as PeerEnvelope) };
  }

  /** GET /peer/v1/blobs/<sha256>: only a blob offered to this friend. */
  blobFor(friend: Friend, sha256: string): Buffer {
    const row = /^[0-9a-f]{64}$/.test(sha256) ? this.store.blob(sha256, friend.id, 'out') : undefined;
    if (!row) throw refuse(404, 'blob', 'No such blob for you.');
    let bytes: Buffer;
    try {
      bytes = readFileSync(row.path);
    } catch {
      throw refuse(404, 'blob', 'That blob is gone.');
    }
    this.store.blobFetched(sha256, friend.id);
    return bytes;
  }

  /** Fetch and open a body that came as a blob, then apply the message. Retries with backoff until the give up time. */
  private fetchBlob(friendId: string, id: string, attempt: number): Promise<void> {
    return this.lock(`blob:${friendId}:${id}`, async () => {
      const item = this.store.inboxItem(friendId, id);
      const friend = this.store.friend(friendId);
      if (!item || item.state !== 'fetching' || !item.envelope || !friend || this.closed) return;
      const env = parseEnvelope(JSON.parse(item.envelope));
      if (!env?.blob) return this.store.updateInbox(friendId, id, { state: 'failed', error: 'the stored message is damaged' });
      const fail = (error: string) => this.store.updateInbox(friendId, id, { state: 'failed', error });
      try {
        this.allowed(friend, env.type);
      } catch (err) {
        return fail(short(err));
      }
      const later = (error: string) => {
        if (item.receivedAt + this.giveUpMs <= this.now()) return fail(`Not fetched in time. ${error}`);
        this.scheduler.enqueue(FETCH_JOB, this.now() + this.backoff(attempt), { friendId, id, attempt: attempt + 1 }, `${FETCH_JOB}.${friendId}.${id}`);
      };
      const conn = await this.connect(friend);
      if (!conn.base) return later(conn.error);
      let res: Response;
      try {
        res = await this.signed(conn.base, friend.fingerprint, 'GET', `/peer/v1/blobs/${env.blob.sha256}`);
      } catch (err) {
        return later(short(err));
      }
      if (res.status === 404 || res.status === 403) return fail(`${friend.name}'s hub no longer has it (${res.status}).`);
      if (!res.ok) return later(`${res.status}: ${await errorText(res)}`);
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > env.blob.size) return fail('The blob is larger than the message says.');
      let bytes: Buffer;
      try {
        // a body with no length is cut off at the size the message says too
        bytes = Buffer.from(await readCapped(res.body, env.blob.size));
      } catch (err) {
        if (err instanceof BodyTooLarge) return fail('The blob is larger than the message says.');
        return later(short(err));
      }
      let body: unknown;
      try {
        body = openEnvelope(env, this.subkey, bytes);
      } catch (err) {
        return fail(short(err));
      }
      const screened = RECORD_TYPES.has(env.type) ? await this.screenIn(friend, env.type, body) : undefined;
      let stored: unknown;
      try {
        stored = this.apply(friend, env, body, screened);
      } catch (err) {
        return fail(short(err));
      }
      this.store.updateInbox(friendId, id, { state: 'received', body: stored });
      this.received(friend, env, 'pull');
    });
  }

  /** Hourly: old nonces, invites and blobs go; overdue outbox items fail. */
  private async sweep(): Promise<void> {
    try {
      this.store.pruneNonces();
      this.store.pruneInvites();
      this.store.pruneOutbox(this.now() - OUTBOX_KEEP_MS);
      for (const b of this.store.staleBlobs()) {
        try {
          rmSync(b.path, { force: true });
        } catch {
          /* gone already */
        }
        this.store.dropBlob(b.sha256, b.friendId, b.dir);
      }
      for (const id of this.store.friendsWithQueued()) {
        const f = this.store.friend(id);
        if (f) this.expire(f);
        this.schedule(id);
      }
      this.shares.sweep();
    } finally {
      if (!this.closed) this.scheduler.enqueue(SWEEP_JOB, this.now() + 3_600_000, {}, SWEEP_JOB);
    }
  }
}
