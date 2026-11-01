/**
 * Where calendar and mail state lives: accounts and the short ids the tools
 * use in kv, proposals in their own table (made here with CREATE TABLE IF
 * NOT EXISTS, like goals) until 30 days after they are decided. Passwords
 * and refresh tokens are hub secrets, never here.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../storage/db';
import type { KvRepo } from '../storage/repos';
import { newId } from '../util/ids';
import { OWNER_ID } from '../people/context';
import { ensureAccountColumn } from '../people/tables';
import type { PimAccount, ProposalDto, ProposalStatus } from './types';
import type { RecurrenceRef } from '../calendar/ical';
import type { EventDraft } from '../calendar/types';

const ACCOUNTS = 'pim.accounts';
const REFS = 'pim.refs';
/** Short ids kept: the newest ones win. */
const MAX_REFS = 3_000;
/** Decided proposals (applied, declined, failed) are kept this long after the decision; pending ones until decided. */
export const PROPOSAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** The daily job that deletes them (engine/create.ts). */
export const PROPOSALS_PRUNE_JOB = 'pim.proposals.prune';

/** Where an event lives, behind its short id. */
export interface EventLocator {
  k: 'ev';
  a: string;
  /** Calendar remote id (CalDAV collection URL or Google calendar id). */
  c: string;
  /** CalDAV object URL. */
  h?: string;
  uid: string;
  r?: RecurrenceRef;
  /** Google event id (an instance id for one occurrence). */
  g?: string;
  /** Google series id, for a change to the whole series. */
  gs?: string;
  recurring?: boolean;
}

/** Where a message lives, behind its short id. */
export interface MailLocator {
  k: 'm';
  a: string;
  ref: string;
}

export type Locator = EventLocator | MailLocator;

/** What a proposal stores to apply itself later: the card's content and where it goes. */
export interface ProposalPayload {
  dto: Omit<ProposalDto, 'id' | 'status' | 'createdAt' | 'decidedAt' | 'sessionId' | 'result' | 'error'>;
  /** Event writes: the account, calendar and draft, and for changes the event's locator. */
  accountId?: string;
  calendarRemote?: string;
  draft?: EventDraft;
  target?: EventLocator;
  /** Change only this occurrence of a series, or the whole series. */
  scope?: 'occurrence' | 'series';
  /** Mail: the message being answered. */
  replyTo?: MailLocator;
}

export function shortId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, prefix === 'cal' ? 8 : 10)}`;
}

export class PimStore {
  constructor(
    private db: Db,
    private kv: KvRepo,
    private now: () => number = Date.now,
    /** Whose proposals (docs/design/ACCOUNTS.md); the kv the service passes is that account's already. */
    private accountId: string = OWNER_ID,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS pim_proposals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      payload TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS pim_proposals_status ON pim_proposals(status, created_at)');
    ensureAccountColumn(db, 'pim_proposals');
    // a write the hub stopped in the middle of (a crash, a restart) may or may not have landed: never try it
    // again, but do not leave it claimed for ever either, where it is neither pending nor decided
    db.query("UPDATE pim_proposals SET status = 'failed', error = ?, decided_at = ? WHERE status = 'applying'").run('The hub stopped while writing this. Check the calendar or the drafts before asking again.', this.now());
    this.prune();
  }

  /**
   * Delete proposals decided more than PROPOSAL_RETENTION_MS ago, every
   * account's (a member's store may not be made in this run). Pending ones
   * stay, and so does one being written. Returns how many went.
   */
  prune(now = this.now()): number {
    const r = this.db.query("DELETE FROM pim_proposals WHERE status NOT IN ('pending', 'applying') AND COALESCE(decided_at, created_at) < ?").run(now - PROPOSAL_RETENTION_MS);
    return (r as { changes?: number }).changes ?? 0;
  }

  // ----- accounts --------------------------------------------------------------

  accounts(): PimAccount[] {
    return this.kv.get<PimAccount[]>(ACCOUNTS, []);
  }

  account(id: string): PimAccount | undefined {
    return this.accounts().find((a) => a.id === id);
  }

  saveAccount(a: PimAccount): PimAccount {
    const list = this.accounts();
    const i = list.findIndex((x) => x.id === a.id);
    const next = { ...a, updatedAt: this.now() };
    if (i === -1) list.push(next);
    else list[i] = next;
    this.kv.set(ACCOUNTS, list);
    return next;
  }

  removeAccount(id: string): boolean {
    const list = this.accounts();
    const next = list.filter((a) => a.id !== id);
    this.kv.set(ACCOUNTS, next);
    // its short ids go with it
    const refs = this.refs();
    for (const [k, v] of Object.entries(refs)) if (v.a === id) delete refs[k];
    this.kv.set(REFS, refs);
    return next.length !== list.length;
  }

  newAccountId(): string {
    return newId('acct');
  }

  // ----- short ids ---------------------------------------------------------------

  private refs(): Record<string, Locator> {
    return this.kv.get<Record<string, Locator>>(REFS, {});
  }

  /** Register locators under their short ids, in one write. */
  remember(entries: Array<[string, Locator]>): void {
    if (!entries.length) return;
    const refs = this.refs();
    for (const [id, loc] of entries) {
      delete refs[id];
      refs[id] = loc;
    }
    const keys = Object.keys(refs);
    if (keys.length > MAX_REFS) for (const k of keys.slice(0, keys.length - MAX_REFS)) delete refs[k];
    this.kv.set(REFS, refs);
  }

  locate(id: string): Locator | undefined {
    return this.refs()[id.trim()];
  }

  // ----- proposals ---------------------------------------------------------------

  addProposal(p: { kind: 'event' | 'mail'; sessionId?: string; payload: ProposalPayload }): ProposalDto {
    const id = newId('prop');
    const at = this.now();
    this.db.query('INSERT INTO pim_proposals (id, kind, status, session_id, payload, created_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, p.kind, 'pending', p.sessionId ?? null, JSON.stringify(p.payload), at, this.accountId);
    return this.proposal(id)!;
  }

  private row(id: string): Record<string, any> | undefined {
    return (this.db.query('SELECT * FROM pim_proposals WHERE id = ? AND account_id = ?').get(id, this.accountId) as Record<string, any> | null) ?? undefined;
  }

  payload(id: string): ProposalPayload | undefined {
    const r = this.row(id);
    return r ? (JSON.parse(r.payload) as ProposalPayload) : undefined;
  }

  private dto(r: Record<string, any>): ProposalDto {
    const p = JSON.parse(r.payload) as ProposalPayload;
    return {
      ...p.dto,
      id: r.id,
      status: r.status as ProposalStatus,
      createdAt: r.created_at,
      ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.result ? { result: r.result } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  proposal(id: string): ProposalDto | undefined {
    const r = this.row(id);
    return r ? this.dto(r) : undefined;
  }

  proposals(opts: { status?: ProposalStatus | 'all'; limit?: number; since?: number } = {}): ProposalDto[] {
    const status = opts.status ?? 'pending';
    const rows = (status === 'all'
      ? this.db.query('SELECT * FROM pim_proposals WHERE account_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?').all(this.accountId, opts.since ?? 0, opts.limit ?? 50)
      : this.db.query('SELECT * FROM pim_proposals WHERE account_id = ? AND status = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?').all(this.accountId, status, opts.since ?? 0, opts.limit ?? 50)) as Array<Record<string, any>>;
    return rows.map((r) => this.dto(r));
  }

  /** Move a pending proposal on. False when it was not pending any more (a second tap). */
  decide(id: string, status: Exclude<ProposalStatus, 'pending'>, out: { result?: string; error?: string } = {}): boolean {
    const r = this.db.query("UPDATE pim_proposals SET status = ?, result = ?, error = ?, decided_at = ? WHERE id = ? AND account_id = ? AND status IN ('pending', 'applying')").run(status, out.result ?? null, out.error ?? null, this.now(), id, this.accountId);
    return (r as { changes?: number }).changes === 1;
  }

  /** Claim a pending proposal for applying, so two taps cannot write twice. */
  claim(id: string): boolean {
    const r = this.db.query("UPDATE pim_proposals SET status = 'applying' WHERE id = ? AND account_id = ? AND status = 'pending'").run(id, this.accountId);
    return (r as { changes?: number }).changes === 1;
  }

  /** Put a claimed proposal back (the write failed in a way worth another try). */
  release(id: string): void {
    this.db.query("UPDATE pim_proposals SET status = 'pending' WHERE id = ? AND account_id = ? AND status = 'applying'").run(id, this.accountId);
  }
}
