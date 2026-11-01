/**
 * Storage for shares between friends (docs/design/FRIENDS.md, phases 2 and
 * 3), next to the friends tables (store.ts) and made the same way.
 *
 *   friend_shares_out   a chat or session this hub sent, one row per share
 *   friend_share_sends  one row per friend it went to, with the offer's
 *                       outbox id and the sealed payload's blob
 *   friend_shares_in    a share a friend's hub offered this one
 *   friend_share_revoked  a share a friend unsent before its offer came here,
 *                       so an offer that comes later is dropped
 *
 * The payload itself is a file: the signed bundle as JSON, under
 * <home>/peer/shares (mode 0600). Out: kept to seal again for a friend whose
 * key changed, until the share is unsent or 30 days pass. In: written only
 * on Accept, after the signature checked out.
 */
import type { Db } from '@conclave/core/storage/db.ts';
import type { ReceivedShareState, ShareContentOptions, ShareSummary } from '@conclave/core/client/friends.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS friend_shares_out (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  options TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_share_sends (
  share_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  msg_id TEXT,
  blob TEXT,
  state TEXT NOT NULL,
  accepted_revision INTEGER,
  accepted_at INTEGER,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_shares_in (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  blob TEXT NOT NULL,
  state TEXT NOT NULL,
  accepted_revision INTEGER,
  payload TEXT,
  error TEXT,
  sessions TEXT NOT NULL DEFAULT '[]',
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  UNIQUE (friend_id, share_id)
);
CREATE INDEX IF NOT EXISTS friend_shares_in_state ON friend_shares_in(state, expires_at);
CREATE TABLE IF NOT EXISTS friend_share_revoked (
  friend_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (friend_id, share_id)
);
`;

type Row = Record<string, any>;

function parse<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export interface OutShare {
  id: string;
  sessionId: string;
  kind: 'chat' | 'session';
  title: string;
  note?: string;
  options: ShareContentOptions;
  revision: number;
  state: 'active' | 'revoked';
  summary: ShareSummary;
  /** The signed bundle's file. */
  payload?: string;
  createdAt: number;
  updatedAt: number;
}

/** sent: offered at this revision; accepted: they fetched a revision; revoked; expired: not accepted in 30 days. */
export interface ShareSend {
  shareId: string;
  friendId: string;
  revision: number;
  /** The outbox id of the last offer or update. */
  msgId?: string;
  /** The sealed payload's blob for this friend. */
  blob?: string;
  state: 'sent' | 'accepted' | 'revoked' | 'expired';
  acceptedRevision?: number;
  acceptedAt?: number;
  sentAt: number;
}

export interface InShare {
  id: string;
  friendId: string;
  shareId: string;
  fingerprint: string;
  kind: 'chat' | 'session';
  title: string;
  note?: string;
  revision: number;
  summary: ShareSummary;
  /** The newest revision's sealed payload on the friend's hub. */
  blob: { sha256: string; size: number };
  state: ReceivedShareState;
  acceptedRevision?: number;
  /** The verified bundle's file, once accepted. */
  payload?: string;
  error?: string;
  sessions: Array<{ id: string; role: 'fork' | 'handoff' | 'reference' }>;
  receivedAt: number;
  updatedAt: number;
  expiresAt: number;
  acceptedAt?: number;
}

const toOut = (r: Row): OutShare => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind === 'chat' ? 'chat' : 'session',
  title: r.title,
  ...(r.note ? { note: r.note } : {}),
  options: parse<ShareContentOptions>(r.options, {}),
  revision: r.revision,
  state: r.state === 'revoked' ? 'revoked' : 'active',
  summary: parse<ShareSummary>(r.summary, { messages: 0, sessions: 0, bytes: 0 }),
  ...(r.payload ? { payload: r.payload } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSend = (r: Row): ShareSend => ({
  shareId: r.share_id,
  friendId: r.friend_id,
  revision: r.revision,
  ...(r.msg_id ? { msgId: r.msg_id } : {}),
  ...(r.blob ? { blob: r.blob } : {}),
  state: r.state,
  ...(r.accepted_revision ? { acceptedRevision: r.accepted_revision } : {}),
  ...(r.accepted_at ? { acceptedAt: r.accepted_at } : {}),
  sentAt: r.sent_at,
});

const toIn = (r: Row): InShare => ({
  id: r.id,
  friendId: r.friend_id,
  shareId: r.share_id,
  fingerprint: r.fingerprint,
  kind: r.kind === 'chat' ? 'chat' : 'session',
  title: r.title,
  ...(r.note ? { note: r.note } : {}),
  revision: r.revision,
  summary: parse<ShareSummary>(r.summary, { messages: 0, sessions: 0, bytes: 0 }),
  blob: parse<{ sha256: string; size: number }>(r.blob, { sha256: '', size: 0 }),
  state: r.state,
  ...(r.accepted_revision ? { acceptedRevision: r.accepted_revision } : {}),
  ...(r.payload ? { payload: r.payload } : {}),
  ...(r.error ? { error: r.error } : {}),
  sessions: parse<InShare['sessions']>(r.sessions, []),
  receivedAt: r.received_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
  ...(r.accepted_at ? { acceptedAt: r.accepted_at } : {}),
});

export class ShareStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  // ----- sent -----

  insertOut(s: Omit<OutShare, 'createdAt' | 'updatedAt'>): OutShare {
    const at = this.now();
    this.db
      .query('INSERT INTO friend_shares_out (id, session_id, kind, title, note, options, revision, state, summary, payload, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, s.sessionId, s.kind, s.title, s.note ?? null, JSON.stringify(s.options), s.revision, s.state, JSON.stringify(s.summary), s.payload ?? null, at, at);
    return this.out(s.id)!;
  }

  out(id: string): OutShare | undefined {
    const r = this.db.query('SELECT * FROM friend_shares_out WHERE id = ?').get(id) as Row | null;
    return r ? toOut(r) : undefined;
  }

  outs(limit = 200): OutShare[] {
    return (this.db.query('SELECT * FROM friend_shares_out ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit) as Row[]).map(toOut);
  }

  updateOut(id: string, patch: Partial<Pick<OutShare, 'title' | 'options' | 'revision' | 'state' | 'summary'>> & { payload?: string | null; note?: string | null }): OutShare | undefined {
    const cols: Record<string, string> = { title: 'title', note: 'note', options: 'options', revision: 'revision', state: 'state', summary: 'summary', payload: 'payload' };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k] || v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(v === null ? null : k === 'options' || k === 'summary' ? JSON.stringify(v) : (v as string | number));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(this.now());
      this.db.query(`UPDATE friend_shares_out SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.out(id);
  }

  /** Shares last changed before `before` that still keep their payload file. */
  oldPayloads(before: number): OutShare[] {
    return (this.db.query('SELECT * FROM friend_shares_out WHERE payload IS NOT NULL AND updated_at < ?').all(before) as Row[]).map(toOut);
  }

  putSend(s: ShareSend): void {
    this.db
      .query(
        `INSERT INTO friend_share_sends (share_id, friend_id, revision, msg_id, blob, state, accepted_revision, accepted_at, sent_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(share_id, friend_id) DO UPDATE SET revision = excluded.revision, msg_id = excluded.msg_id, blob = excluded.blob, state = excluded.state,
           accepted_revision = excluded.accepted_revision, accepted_at = excluded.accepted_at, sent_at = excluded.sent_at`,
      )
      .run(s.shareId, s.friendId, s.revision, s.msgId ?? null, s.blob ?? null, s.state, s.acceptedRevision ?? null, s.acceptedAt ?? null, s.sentAt);
  }

  sends(shareId: string): ShareSend[] {
    return (this.db.query('SELECT * FROM friend_share_sends WHERE share_id = ? ORDER BY sent_at').all(shareId) as Row[]).map(toSend);
  }

  send(shareId: string, friendId: string): ShareSend | undefined {
    const r = this.db.query('SELECT * FROM friend_share_sends WHERE share_id = ? AND friend_id = ?').get(shareId, friendId) as Row | null;
    return r ? toSend(r) : undefined;
  }

  /** What went to a friend and may still be fetched: for sealing again after their key changed. */
  openSendsTo(friendId: string): ShareSend[] {
    return (this.db.query(`SELECT * FROM friend_share_sends WHERE friend_id = ? AND state = 'sent'`).all(friendId) as Row[]).map(toSend);
  }

  /** Offers not accepted in time. */
  staleSends(before: number): ShareSend[] {
    return (this.db.query(`SELECT * FROM friend_share_sends WHERE state = 'sent' AND sent_at < ?`).all(before) as Row[]).map(toSend);
  }

  // ----- received -----

  insertIn(s: Omit<InShare, 'updatedAt'>): InShare {
    this.db
      .query(
        `INSERT INTO friend_shares_in (id, friend_id, share_id, fingerprint, kind, title, note, revision, summary, blob, state, accepted_revision, payload, error, sessions, received_at, updated_at, expires_at, accepted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.friendId,
        s.shareId,
        s.fingerprint,
        s.kind,
        s.title,
        s.note ?? null,
        s.revision,
        JSON.stringify(s.summary),
        JSON.stringify(s.blob),
        s.state,
        s.acceptedRevision ?? null,
        s.payload ?? null,
        s.error ?? null,
        JSON.stringify(s.sessions),
        s.receivedAt,
        this.now(),
        s.expiresAt,
        s.acceptedAt ?? null,
      );
    return this.in(s.id)!;
  }

  in(id: string): InShare | undefined {
    const r = this.db.query('SELECT * FROM friend_shares_in WHERE id = ?').get(id) as Row | null;
    return r ? toIn(r) : undefined;
  }

  inByShare(friendId: string, shareId: string): InShare | undefined {
    const r = this.db.query('SELECT * FROM friend_shares_in WHERE friend_id = ? AND share_id = ?').get(friendId, shareId) as Row | null;
    return r ? toIn(r) : undefined;
  }

  ins(opts: { friendId?: string; limit?: number } = {}): InShare[] {
    const rows = opts.friendId
      ? this.db.query('SELECT * FROM friend_shares_in WHERE friend_id = ? ORDER BY received_at DESC, id DESC LIMIT ?').all(opts.friendId, opts.limit ?? 200)
      : this.db.query('SELECT * FROM friend_shares_in ORDER BY received_at DESC, id DESC LIMIT ?').all(opts.limit ?? 200);
    return (rows as Row[]).map(toIn);
  }

  updateIn(
    id: string,
    patch: Partial<Pick<InShare, 'kind' | 'title' | 'revision' | 'summary' | 'blob' | 'state' | 'acceptedRevision' | 'sessions' | 'expiresAt' | 'acceptedAt' | 'fingerprint'>> & { payload?: string | null; error?: string | null; note?: string | null },
  ): InShare | undefined {
    const cols: Record<string, string> = {
      kind: 'kind',
      title: 'title',
      note: 'note',
      revision: 'revision',
      summary: 'summary',
      blob: 'blob',
      state: 'state',
      acceptedRevision: 'accepted_revision',
      sessions: 'sessions',
      expiresAt: 'expires_at',
      acceptedAt: 'accepted_at',
      fingerprint: 'fingerprint',
      payload: 'payload',
      error: 'error',
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k] || v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(v === null ? null : k === 'summary' || k === 'blob' || k === 'sessions' ? JSON.stringify(v) : (v as string | number));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(this.now());
      this.db.query(`UPDATE friend_shares_in SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.in(id);
  }

  /** Cards from a friend waiting for the owner (an offer, or a revision after an Accept) that came after `since`. */
  unreadShares(friendId: string, since: number): number {
    return (
      this.db
        .query(`SELECT COUNT(*) AS n FROM friend_shares_in WHERE friend_id = ? AND updated_at > ? AND (state = 'offered' OR (state = 'accepted' AND COALESCE(accepted_revision, 0) < revision))`)
        .get(friendId, since) as { n: number }
    ).n;
  }

  /** Shares an Accept was fetching (when the hub stopped). */
  fetchingIns(): InShare[] {
    return (this.db.query(`SELECT * FROM friend_shares_in WHERE state = 'fetching'`).all() as Row[]).map(toIn);
  }

  /** Offers past their time. */
  expiredOffers(now: number): InShare[] {
    return (this.db.query(`SELECT * FROM friend_shares_in WHERE state = 'offered' AND expires_at < ?`).all(now) as Row[]).map(toIn);
  }

  // ----- unsent before the offer came -----

  /** Remember a share the friend unsent before its offer came. Each friend has at most `max`; the oldest go first. */
  tombstone(friendId: string, shareId: string, max: number): void {
    this.db.transaction(() => {
      this.db.query('INSERT OR REPLACE INTO friend_share_revoked (friend_id, share_id, revoked_at) VALUES (?,?,?)').run(friendId, shareId, this.now());
      this.db
        .query('DELETE FROM friend_share_revoked WHERE friend_id = ? AND share_id NOT IN (SELECT share_id FROM friend_share_revoked WHERE friend_id = ? ORDER BY revoked_at DESC, share_id DESC LIMIT ?)')
        .run(friendId, friendId, max);
    })();
  }

  /** Did the friend unsend this share after `since`, before its offer came? */
  unsentEarly(friendId: string, shareId: string, since: number): boolean {
    return !!this.db.query('SELECT 1 FROM friend_share_revoked WHERE friend_id = ? AND share_id = ? AND revoked_at > ?').get(friendId, shareId, since);
  }

  /** Tombstones older than `before` go. */
  pruneTombstones(before: number): number {
    return this.db.query('DELETE FROM friend_share_revoked WHERE revoked_at < ?').run(before).changes;
  }
}
