/**
 * Friends storage (docs/design/FRIENDS.md): friends, one time invites, the
 * outbox and inbox of peer messages, the nonce cache for signed requests,
 * and blobs offered to friends. The tables are made here with CREATE TABLE
 * IF NOT EXISTS, like the OAuth tables, so the shared migration list stays
 * as it is. Invites keep only SHA-256 of their secret.
 */
import type { Db } from '@conclave/core/storage/db.ts';
import type { FriendGrants, FriendStatus, OutboxState } from '@conclave/core/client/friends.ts';
import { newId } from '@conclave/core/util/ids.ts';
import type { AddressRecord, PeerAddress } from './envelope';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS friends (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  subkey TEXT,
  subkey_sig TEXT,
  addresses TEXT NOT NULL DEFAULT '{"addrs":[],"seq":-1}',
  status TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out',
  verified INTEGER NOT NULL DEFAULT 0,
  grants TEXT NOT NULL DEFAULT '{"receiveShares":true}',
  pending_key TEXT,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS friend_invites (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);
CREATE TABLE IF NOT EXISTS peer_outbox (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL,
  type TEXT NOT NULL,
  envelope TEXT NOT NULL,
  blob TEXT,
  body TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  via TEXT,
  last_error TEXT,
  preview TEXT NOT NULL DEFAULT '',
  text TEXT
);
CREATE INDEX IF NOT EXISTS peer_outbox_friend ON peer_outbox(friend_id, state, next_try);
CREATE TABLE IF NOT EXISTS peer_inbox (
  friend_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  envelope TEXT,
  state TEXT NOT NULL,
  error TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (friend_id, id)
);
CREATE INDEX IF NOT EXISTS peer_inbox_received ON peer_inbox(received_at DESC);
CREATE TABLE IF NOT EXISTS peer_nonces (
  nonce TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS peer_nonces_expiry ON peer_nonces(expires_at);
CREATE TABLE IF NOT EXISTS friend_blocks (
  fingerprint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_blobs (
  sha256 TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  msg_id TEXT,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER,
  PRIMARY KEY (sha256, friend_id, dir)
);
`;

type Row = Record<string, any>;

/** Where a friend's hub answers: its signed record, or the hints from an invite link until one arrives. */
export interface KnownAddresses {
  addrs: PeerAddress[];
  /** The record's seq; -1 for hints. */
  seq: number;
  record?: AddressRecord;
}

export interface Friend {
  id: string;
  name: string;
  fingerprint: string;
  publicKey: string;
  subkey?: string;
  subkeySig?: string;
  addresses: KnownAddresses;
  status: FriendStatus;
  direction: 'in' | 'out';
  verified: boolean;
  grants: FriendGrants;
  /** A new hub key seen for this friend, waiting for the owner. */
  pendingKey?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
  lastSeen?: number;
  lastError?: string;
  /** The owner's email for this friend: a label and a contact, never sent. */
  email?: string;
  /** How their request came (a pending request in): an invite, or this hub's address alone. */
  via?: 'invite' | 'address';
  /** When the owner declined their request: an address request waits 30 days before it may ask again. */
  declinedAt?: number;
}

export const DEFAULT_GRANTS: FriendGrants = { receiveShares: true };

function parse<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toFriend(r: Row): Friend {
  return {
    id: r.id,
    name: r.name,
    fingerprint: r.fingerprint,
    publicKey: r.public_key,
    ...(r.subkey ? { subkey: r.subkey, subkeySig: r.subkey_sig ?? undefined } : {}),
    addresses: parse<KnownAddresses>(r.addresses, { addrs: [], seq: -1 }),
    status: r.status,
    direction: r.direction === 'in' ? 'in' : 'out',
    verified: !!r.verified,
    grants: { ...DEFAULT_GRANTS, ...parse<Partial<FriendGrants>>(r.grants, {}) },
    ...(r.pending_key ? { pendingKey: r.pending_key } : {}),
    ...(r.blocked_reason ? { blockedReason: r.blocked_reason } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.last_seen ? { lastSeen: r.last_seen } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    ...(r.email ? { email: r.email } : {}),
    ...(r.request_via === 'address' || r.request_via === 'invite' ? { via: r.request_via } : {}),
    ...(r.declined_at ? { declinedAt: r.declined_at } : {}),
  };
}

export interface OutboxItem {
  id: string;
  friendId: string;
  type: string;
  /** The signed envelope as JSON text, exactly as it goes out. */
  envelope: string;
  /** The blob's hash when the body went into one. */
  blob?: string;
  /** The body as JSON, kept until delivery so the message can be sealed again after the friend's key changes. */
  body?: string;
  state: OutboxState;
  attempts: number;
  nextTry: number;
  expiresAt: number;
  createdAt: number;
  deliveredAt?: number;
  via?: 'push' | 'pull';
  lastError?: string;
  preview: string;
  /** A note's whole text, kept after delivery (the body is not), so every device of the owner shows it. */
  text?: string;
}

function toOutbox(r: Row): OutboxItem {
  return {
    id: r.id,
    friendId: r.friend_id,
    type: r.type,
    envelope: r.envelope,
    ...(r.blob ? { blob: r.blob } : {}),
    ...(r.body ? { body: r.body } : {}),
    state: r.state,
    attempts: r.attempts,
    nextTry: r.next_try,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    ...(r.delivered_at ? { deliveredAt: r.delivered_at } : {}),
    ...(r.via ? { via: r.via } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    preview: r.preview ?? '',
    ...(r.text ? { text: r.text } : {}),
  };
}

export interface InboxItem {
  friendId: string;
  id: string;
  type: string;
  body?: unknown;
  /** Kept while a blob is fetched. */
  envelope?: string;
  state: 'received' | 'fetching' | 'failed';
  error?: string;
  receivedAt: number;
}

function toInbox(r: Row): InboxItem {
  return {
    friendId: r.friend_id,
    id: r.id,
    type: r.type,
    ...(r.body ? { body: parse<unknown>(r.body, undefined) } : {}),
    ...(r.envelope ? { envelope: r.envelope } : {}),
    state: r.state,
    ...(r.error ? { error: r.error } : {}),
    receivedAt: r.received_at,
  };
}

export interface BlobRow {
  sha256: string;
  friendId: string;
  dir: 'out' | 'in';
  msgId?: string;
  size: number;
  path: string;
  createdAt: number;
  fetchedAt?: number;
}

export class PeerStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
    // a hub from before notes kept their whole text in the outbox
    const cols = db.query('PRAGMA table_info(peer_outbox)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'text')) db.exec('ALTER TABLE peer_outbox ADD COLUMN text TEXT');
    // a hub from before requests by address: the email, how a request came, when it was declined
    const fcols = new Set((db.query('PRAGMA table_info(friends)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!fcols.has('email')) db.exec('ALTER TABLE friends ADD COLUMN email TEXT');
    if (!fcols.has('request_via')) db.exec('ALTER TABLE friends ADD COLUMN request_via TEXT');
    if (!fcols.has('declined_at')) db.exec('ALTER TABLE friends ADD COLUMN declined_at INTEGER');
  }

  // ----- friends -----------------------------------------------------------

  insertFriend(f: Omit<Friend, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Friend {
    const id = f.id ?? newId('frd');
    const at = this.now();
    this.db
      .query(
        `INSERT INTO friends (id, name, fingerprint, public_key, subkey, subkey_sig, addresses, status, direction, verified, grants, pending_key, blocked_reason, created_at, updated_at, last_seen, last_error, email, request_via)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        f.name,
        f.fingerprint,
        f.publicKey,
        f.subkey ?? null,
        f.subkeySig ?? null,
        JSON.stringify(f.addresses),
        f.status,
        f.direction,
        f.verified ? 1 : 0,
        JSON.stringify(f.grants),
        f.pendingKey ?? null,
        f.blockedReason ?? null,
        at,
        at,
        f.lastSeen ?? null,
        f.lastError ?? null,
        f.email ?? null,
        f.via ?? null,
      );
    return this.friend(id)!;
  }

  friend(id: string): Friend | undefined {
    const r = this.db.query('SELECT * FROM friends WHERE id = ?').get(id) as Row | null;
    return r ? toFriend(r) : undefined;
  }

  friendByFingerprint(fp: string): Friend | undefined {
    const r = this.db.query('SELECT * FROM friends WHERE fingerprint = ?').get(fp) as Row | null;
    return r ? toFriend(r) : undefined;
  }

  /** Everyone but removed friends, unless asked. */
  friends(opts: { removed?: boolean } = {}): Friend[] {
    const rows = opts.removed ? this.db.query('SELECT * FROM friends ORDER BY created_at').all() : this.db.query(`SELECT * FROM friends WHERE status != 'removed' ORDER BY created_at`).all();
    return (rows as Row[]).map(toFriend);
  }

  /** Requests waiting for the owner; with via, only those that came that way (an invite counts a request from before requests by address). */
  pendingIn(via?: 'invite' | 'address'): number {
    const how = via === 'address' ? `AND request_via = 'address'` : via === 'invite' ? `AND (request_via IS NULL OR request_via = 'invite')` : '';
    return (this.db.query(`SELECT COUNT(*) AS n FROM friends WHERE status = 'pending' AND direction = 'in' ${how}`).get() as { n: number }).n;
  }

  /** Change some fields. Undefined leaves a field; null clears it. */
  updateFriend(id: string, patch: { [K in keyof Friend]?: Friend[K] | null }): Friend | undefined {
    const cols: Record<string, string> = {
      name: 'name',
      fingerprint: 'fingerprint',
      publicKey: 'public_key',
      subkey: 'subkey',
      subkeySig: 'subkey_sig',
      addresses: 'addresses',
      status: 'status',
      direction: 'direction',
      verified: 'verified',
      grants: 'grants',
      pendingKey: 'pending_key',
      blockedReason: 'blocked_reason',
      lastSeen: 'last_seen',
      lastError: 'last_error',
      email: 'email',
      via: 'request_via',
      declinedAt: 'declined_at',
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      if (v === null) values.push(null);
      else if (k === 'addresses' || k === 'grants') values.push(JSON.stringify(v));
      else if (k === 'verified') values.push(v ? 1 : 0);
      else values.push(v as string | number);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(this.now());
      this.db.query(`UPDATE friends SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.friend(id);
  }

  /** Only for a request that never left: a friend we told about ourselves stays as removed. */
  deleteFriend(id: string): void {
    this.db.query('DELETE FROM friends WHERE id = ?').run(id);
  }

  // ----- the block list: hubs whose requests are turned away ----------------

  block(fingerprint: string, name: string): void {
    this.db.query('INSERT OR REPLACE INTO friend_blocks (fingerprint, name, created_at) VALUES (?,?,?)').run(fingerprint, name, this.now());
  }

  unblock(fingerprint: string): boolean {
    return this.db.query('DELETE FROM friend_blocks WHERE fingerprint = ?').run(fingerprint).changes === 1;
  }

  isBlocked(fingerprint: string): boolean {
    return !!this.db.query('SELECT 1 FROM friend_blocks WHERE fingerprint = ?').get(fingerprint);
  }

  blocks(): Array<{ fingerprint: string; name: string; at: number }> {
    return (this.db.query('SELECT * FROM friend_blocks ORDER BY created_at DESC').all() as Row[]).map((r) => ({ fingerprint: r.fingerprint, name: r.name, at: r.created_at }));
  }

  // ----- invites -----------------------------------------------------------

  createInvite(secretHash: string, expiresAt: number): string {
    const id = newId('inv');
    this.db.query('INSERT INTO friend_invites (id, secret_hash, created_at, expires_at) VALUES (?,?,?,?)').run(id, secretHash, this.now(), expiresAt);
    return id;
  }

  /** Invites that can still be used. */
  openInvites(): Array<{ id: string; secretHash: string; expiresAt: number }> {
    return (this.db.query('SELECT id, secret_hash, expires_at FROM friend_invites WHERE used_at IS NULL AND expires_at > ?').all(this.now()) as Row[]).map((r) => ({ id: r.id, secretHash: r.secret_hash, expiresAt: r.expires_at }));
  }

  /** Invites a friend used, with who used them (a request sent again finds its own). */
  usedInvites(fp: string): Array<{ id: string; secretHash: string }> {
    return (this.db.query('SELECT id, secret_hash FROM friend_invites WHERE used_by = ?').all(fp) as Row[]).map((r) => ({ id: r.id, secretHash: r.secret_hash }));
  }

  /** Mark an invite used. False when someone used it first. */
  useInvite(id: string, fp: string): boolean {
    return this.db.query('UPDATE friend_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL').run(this.now(), fp, id).changes === 1;
  }

  /** Expired invites go a day after they expire. */
  pruneInvites(): void {
    this.db.query('DELETE FROM friend_invites WHERE expires_at < ?').run(this.now() - 86_400_000);
  }

  // ----- outbox ------------------------------------------------------------

  insertOutbox(item: Omit<OutboxItem, 'attempts' | 'state'> & { state?: OutboxState }): OutboxItem {
    this.db
      .query('INSERT INTO peer_outbox (id, friend_id, type, envelope, blob, body, state, attempts, next_try, expires_at, created_at, preview, text) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)')
      .run(item.id, item.friendId, item.type, item.envelope, item.blob ?? null, item.body ?? null, item.state ?? 'queued', item.nextTry, item.expiresAt, item.createdAt, item.preview, item.text ?? null);
    return this.outboxItem(item.id)!;
  }

  /** A message sealed again (same id) for the friend's new key. */
  setEnvelope(id: string, envelope: string, blob: string | undefined): void {
    this.db.query('UPDATE peer_outbox SET envelope = ?, blob = ? WHERE id = ?').run(envelope, blob ?? null, id);
  }

  /** Items that may still go out (queued or failed) and keep their body. */
  resealable(friendId: string): OutboxItem[] {
    return (this.db.query(`SELECT * FROM peer_outbox WHERE friend_id = ? AND state IN ('queued', 'failed') AND body IS NOT NULL ORDER BY id`).all(friendId) as Row[]).map(toOutbox);
  }

  outboxItem(id: string): OutboxItem | undefined {
    const r = this.db.query('SELECT * FROM peer_outbox WHERE id = ?').get(id) as Row | null;
    return r ? toOutbox(r) : undefined;
  }

  outbox(opts: { friendId?: string; limit?: number } = {}): OutboxItem[] {
    const rows = opts.friendId
      ? this.db.query('SELECT * FROM peer_outbox WHERE friend_id = ? ORDER BY id DESC LIMIT ?').all(opts.friendId, opts.limit ?? 200)
      : this.db.query('SELECT * FROM peer_outbox ORDER BY id DESC LIMIT ?').all(opts.limit ?? 200);
    return (rows as Row[]).map(toOutbox);
  }

  /** Queued items for a friend, oldest first. With `due`, only those whose time has come. */
  queued(friendId: string, opts: { due?: number; after?: string; limit?: number } = {}): OutboxItem[] {
    const rows = this.db
      .query(`SELECT * FROM peer_outbox WHERE friend_id = ? AND state = 'queued' AND next_try <= ? AND id > ? ORDER BY id LIMIT ?`)
      .all(friendId, opts.due ?? Number.MAX_SAFE_INTEGER, opts.after ?? '', opts.limit ?? 500) as Row[];
    return rows.map(toOutbox);
  }

  countQueued(friendId: string): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM peer_outbox WHERE friend_id = ? AND state = 'queued'`).get(friendId) as { n: number }).n;
  }

  /** The next time something for this friend should go. */
  nextTry(friendId: string): number | undefined {
    const r = this.db.query(`SELECT MIN(next_try) AS t FROM peer_outbox WHERE friend_id = ? AND state = 'queued'`).get(friendId) as { t: number | null };
    return r.t ?? undefined;
  }

  /** Try everything queued for a friend now (its hub just reached us). Returns how many waited. */
  retryNow(friendId: string): number {
    const now = this.now();
    return this.db.query(`UPDATE peer_outbox SET next_try = ? WHERE friend_id = ? AND state = 'queued' AND next_try > ?`).run(now, friendId, now).changes;
  }

  /** Friends with something queued. */
  friendsWithQueued(): string[] {
    return (this.db.query(`SELECT DISTINCT friend_id FROM peer_outbox WHERE state = 'queued'`).all() as Row[]).map((r) => r.friend_id);
  }

  updateOutbox(id: string, patch: Partial<Pick<OutboxItem, 'state' | 'attempts' | 'nextTry' | 'expiresAt' | 'deliveredAt' | 'via'>> & { lastError?: string | null }): OutboxItem | undefined {
    const cols: Record<string, string> = { state: 'state', attempts: 'attempts', nextTry: 'next_try', expiresAt: 'expires_at', deliveredAt: 'delivered_at', via: 'via', lastError: 'last_error' };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k] || v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(v as string | number | null);
    }
    // a delivered or cancelled message keeps neither its plain body nor its sealed envelope: only its row (and a note its text)
    if (patch.state === 'delivered' || patch.state === 'cancelled') sets.push('body = NULL', `envelope = ''`);
    if (sets.length) this.db.query(`UPDATE peer_outbox SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.outboxItem(id);
  }

  /** The friend's hub took these in a pull (GET /peer/v1/outbox?ack=). Returns how many were marked. */
  markPulled(friendId: string, ids: string[]): number {
    if (!ids.length) return 0;
    return this.db
      .query(`UPDATE peer_outbox SET state = 'delivered', delivered_at = ?, via = 'pull', last_error = NULL, body = NULL, envelope = '' WHERE friend_id = ? AND state = 'queued' AND id IN (${ids.map(() => '?').join(',')})`)
      .run(this.now(), friendId, ...ids).changes;
  }

  /**
   * Versions of a shared project's item that fell out of its history
   * (project-store.ts HISTORY_KEEP): project.item messages carrying one at
   * or below `upTo` that still wait, for any friend, are cancelled and never
   * go. Returns how many.
   */
  cancelItemVersions(projectId: string, itemId: string, upTo: number): number {
    return this.db
      .query(
        `UPDATE peer_outbox SET state = 'cancelled', body = NULL, envelope = '' WHERE type = 'project.item' AND state IN ('queued', 'failed') AND body IS NOT NULL
           AND json_extract(body, '$.projectId') = ? AND json_extract(body, '$.item.id') = ? AND json_extract(body, '$.item.version') <= ?`,
      )
      .run(projectId, itemId, upTo).changes;
  }

  /** Cancel what waits for a friend, except these types. */
  cancelQueued(friendId: string, except: string[] = []): number {
    const keep = except.length ? `AND type NOT IN (${except.map(() => '?').join(',')})` : '';
    return this.db.query(`UPDATE peer_outbox SET state = 'cancelled', body = NULL, envelope = '' WHERE friend_id = ? AND state IN ('queued', 'failed') ${keep}`).run(friendId, ...except).changes;
  }

  /**
   * The outbox does not grow without end: rows of messages that are done
   * (delivered, cancelled or lapsed) go once they are older than `before`,
   * and the envelopes of done ones from before this was kept (an older hub's
   * rows). A note's row stays, since it holds the text both owners' threads
   * show. Returns how many rows went.
   */
  pruneOutbox(before: number): number {
    this.db.query(`UPDATE peer_outbox SET envelope = '', body = NULL WHERE state IN ('delivered', 'cancelled') AND envelope != ''`).run();
    return this.db.query(`DELETE FROM peer_outbox WHERE type != 'note' AND state IN ('delivered', 'cancelled', 'expired') AND created_at < ?`).run(before).changes;
  }

  // ----- inbox -------------------------------------------------------------

  inboxItem(friendId: string, id: string): InboxItem | undefined {
    const r = this.db.query('SELECT * FROM peer_inbox WHERE friend_id = ? AND id = ?').get(friendId, id) as Row | null;
    return r ? toInbox(r) : undefined;
  }

  /** Record a message. False when it is there already (a message sent again). */
  insertInbox(item: Omit<InboxItem, 'receivedAt'>): boolean {
    return (
      this.db
        .query('INSERT OR IGNORE INTO peer_inbox (friend_id, id, type, body, envelope, state, error, received_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(item.friendId, item.id, item.type, item.body === undefined ? null : JSON.stringify(item.body), item.envelope ?? null, item.state, item.error ?? null, this.now()).changes === 1
    );
  }

  updateInbox(friendId: string, id: string, patch: { state: InboxItem['state']; body?: unknown; error?: string }): void {
    this.db
      .query('UPDATE peer_inbox SET state = ?, body = COALESCE(?, body), error = ?, envelope = CASE WHEN ? = \'fetching\' THEN envelope ELSE NULL END WHERE friend_id = ? AND id = ?')
      .run(patch.state, patch.body === undefined ? null : JSON.stringify(patch.body), patch.error ?? null, patch.state, friendId, id);
  }

  inbox(opts: { friendId?: string; types?: string[]; limit?: number } = {}): InboxItem[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (opts.friendId) (where.push('friend_id = ?'), values.push(opts.friendId));
    if (opts.types?.length) (where.push(`type IN (${opts.types.map(() => '?').join(',')})`), values.push(...opts.types));
    const rows = this.db.query(`SELECT * FROM peer_inbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC, id DESC LIMIT ?`).all(...values, opts.limit ?? 200) as Row[];
    return rows.map(toInbox);
  }

  /** Notes from a friend that came after `since` (the hub's own clock): the unread ones. */
  unreadNotes(friendId: string, since: number): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM peer_inbox WHERE friend_id = ? AND type = 'note' AND state != 'failed' AND received_at > ?`).get(friendId, since) as { n: number }).n;
  }

  fetching(): InboxItem[] {
    return (this.db.query(`SELECT * FROM peer_inbox WHERE state = 'fetching'`).all() as Row[]).map(toInbox);
  }

  // ----- nonces ------------------------------------------------------------

  /** Record a nonce. False when it was seen before: a replay. */
  useNonce(fp: string, nonce: string, expiresAt: number): boolean {
    return this.db.query('INSERT OR IGNORE INTO peer_nonces (nonce, fingerprint, expires_at) VALUES (?,?,?)').run(`${fp}:${nonce}`, fp, expiresAt).changes === 1;
  }

  pruneNonces(): void {
    this.db.query('DELETE FROM peer_nonces WHERE expires_at < ?').run(this.now());
  }

  // ----- blobs -------------------------------------------------------------

  putBlob(b: Omit<BlobRow, 'createdAt'>): void {
    this.db
      .query('INSERT OR REPLACE INTO peer_blobs (sha256, friend_id, dir, msg_id, size, path, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(b.sha256, b.friendId, b.dir, b.msgId ?? null, b.size, b.path, this.now());
  }

  blob(sha256: string, friendId: string, dir: 'out' | 'in'): BlobRow | undefined {
    const r = this.db.query('SELECT * FROM peer_blobs WHERE sha256 = ? AND friend_id = ? AND dir = ?').get(sha256, friendId, dir) as Row | null;
    return r
      ? { sha256: r.sha256, friendId: r.friend_id, dir: r.dir, ...(r.msg_id ? { msgId: r.msg_id } : {}), size: r.size, path: r.path, createdAt: r.created_at, ...(r.fetched_at ? { fetchedAt: r.fetched_at } : {}) }
      : undefined;
  }

  blobFetched(sha256: string, friendId: string): void {
    this.db.query(`UPDATE peer_blobs SET fetched_at = ? WHERE sha256 = ? AND friend_id = ? AND dir = 'out'`).run(this.now(), sha256, friendId);
  }

  /** Blobs no outbox item still needs: fetched ones after a day, the rest after 30 days. Returns their files. */
  staleBlobs(): Array<{ sha256: string; friendId: string; dir: string; path: string }> {
    const now = this.now();
    const rows = this.db
      .query(
        `SELECT sha256, friend_id, dir, path FROM peer_blobs WHERE
           (fetched_at IS NOT NULL AND fetched_at < ?) OR created_at < ?
           OR (dir = 'out' AND msg_id IS NOT NULL AND msg_id IN (SELECT id FROM peer_outbox WHERE state IN ('cancelled', 'expired')))`,
      )
      .all(now - 86_400_000, now - 30 * 86_400_000) as Row[];
    return rows.map((r) => ({ sha256: r.sha256, friendId: r.friend_id, dir: r.dir, path: r.path }));
  }

  dropBlob(sha256: string, friendId: string, dir: string): void {
    this.db.query('DELETE FROM peer_blobs WHERE sha256 = ? AND friend_id = ? AND dir = ?').run(sha256, friendId, dir);
  }
}
