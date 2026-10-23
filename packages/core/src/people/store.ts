/**
 * Accounts on one hub (docs/design/ACCOUNTS.md 1): the owner and members.
 * The table is made and migrated here (migratePeople, called by openDb), so
 * the shared migration list does not change.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import { newId } from '../util/ids';
import { OWNER_ID } from './context';
import { ACCOUNT_TABLES, CHILD_TABLES } from './tables';
import { emailKey, migratePeople } from './migrate';
import { DISPLAY_NAME_MAX, displayNameProblem, tidyDisplayName } from '../client/people';

export { migratePeople };

export type AccountRole = 'owner' | 'member';

/** The hub's keys a member may use, per provider id; monthlyUsd null or missing is no cap. */
export type ProviderGrants = Record<string, { monthlyUsd?: number | null }>;

export interface AccountSettings {
  /** Set by the owner: which of the hub's provider keys this member may use, and the monthly budget. */
  providers?: ProviderGrants;
  /** The person's own defaults. */
  defaultModel?: string;
  smallModel?: string;
  defaultAgent?: string;
  /** Watch this person's devices for new chats to import (when the hub's import watch is on). */
  importWatch?: boolean;
}

export interface HubAccount {
  id: string;
  /** What the person types to sign in (NAME_RE). */
  name: string;
  /** What the apps show and greet them by ("Kai Ahir"). Missing: none, as on the owner's account until the owner gives one. */
  displayName?: string;
  /** Signs in too, like the name. One account's only, case aside (rows from before that may share one). */
  email?: string;
  role: AccountRole;
  passwordSet: boolean;
  passwordSetAt?: number;
  /** An invite link waits until this time. */
  inviteExpiresAt?: number;
  settings: AccountSettings;
  createdAt: number;
  updatedAt: number;
}

/** What a name may be: what a person types to sign in. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export { DISPLAY_NAME_MAX };

export const EMAIL_TAKEN = 'Another person already has that email.';

export class PeopleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PeopleError';
  }
}

type Row = Record<string, any>;

function toAccount(r: Row): HubAccount {
  return {
    id: r.id,
    name: r.name,
    ...(r.display_name ? { displayName: r.display_name } : {}),
    ...(r.email ? { email: r.email } : {}),
    role: r.role === 'owner' ? 'owner' : 'member',
    passwordSet: !!r.password_hash,
    ...(r.password_set_at ? { passwordSetAt: r.password_set_at } : {}),
    ...(r.invite_hash && r.invite_expires_at > Date.now() ? { inviteExpiresAt: r.invite_expires_at } : {}),
    settings: json<AccountSettings>(r.settings, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function checkName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!NAME_RE.test(n)) throw new PeopleError(400, 'A name has 1 to 40 letters, digits, dots, dashes or underscores, and starts with a letter or digit.');
  return n;
}

/**
 * A display name, trimmed with each run of spaces one space: letters of any
 * script, digits, spaces and common punctuation, 1 to 60 characters
 * (client/people.ts displayNameProblem, which the apps check with too).
 * Missing, null, or empty once trimmed is none (undefined).
 */
export function checkDisplayName(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new PeopleError(400, 'A display name is text.');
  const bad = displayNameProblem(v);
  if (bad) throw new PeopleError(400, bad);
  return tidyDisplayName(v) || undefined;
}

function checkEmail(email: unknown): string | undefined {
  if (email === undefined || email === null || email === '') return undefined;
  if (typeof email !== 'string' || email.length > 200 || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new PeopleError(400, 'That email does not look right.');
  return email.trim();
}

export class PeopleStore {
  private cache = new Map<string, HubAccount>();

  constructor(private readonly db: Db) {
    // openDb migrates; a db opened another way (tests) is migrated here
    migratePeople(db);
  }

  private fresh(): void {
    this.cache.clear();
  }

  list(): HubAccount[] {
    return (this.db.query("SELECT * FROM hub_accounts ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name_key").all() as Row[]).map(toAccount);
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM hub_accounts').get() as { n: number }).n;
  }

  get(id: string): HubAccount | undefined {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const r = this.db.query('SELECT * FROM hub_accounts WHERE id = ?').get(id) as Row | null;
    if (!r) return undefined;
    const a = toAccount(r);
    this.cache.set(id, a);
    return a;
  }

  /** The account with this sign-in name (case does not matter). */
  byName(name: string): HubAccount | undefined {
    const r = this.db.query('SELECT * FROM hub_accounts WHERE name_key = ?').get(name.trim().toLowerCase()) as Row | null;
    return r ? toAccount(r) : undefined;
  }

  /** Up to two accounts with this email (case and spaces around it do not matter). Two: rows from before emails were one account's. */
  private withEmail(email: string): Row[] {
    const key = emailKey(email);
    return key ? (this.db.query('SELECT * FROM hub_accounts WHERE email_key = ? LIMIT 2').all(key) as Row[]) : [];
  }

  /**
   * The account a login names (docs/design/ACCOUNTS.md 4): a sign-in name,
   * else an email. Case and spaces around it do not matter, and a name has
   * no @, so the two never meet. An email two old accounts share is nobody's.
   */
  bySignIn(account: string): HubAccount | undefined {
    const named = this.byName(account);
    if (named) return named;
    const rows = this.withEmail(account);
    return rows.length === 1 ? toAccount(rows[0]) : undefined;
  }

  owner(): HubAccount {
    return this.get(OWNER_ID)!;
  }

  /** A member. Their display name starts as their sign-in name unless one is given. */
  create(input: { name: unknown; displayName?: unknown; email?: unknown; role?: AccountRole; settings?: AccountSettings }): HubAccount {
    const name = checkName(input.name);
    const displayName = checkDisplayName(input.displayName) ?? name;
    const email = checkEmail(input.email);
    if (this.byName(name)) throw new PeopleError(409, `There is already someone called ${name} on this hub.`);
    if (email && this.withEmail(email).length) throw new PeopleError(409, EMAIL_TAKEN);
    if (input.role === 'owner') throw new PeopleError(400, 'A hub has one owner.');
    const id = newId('acc');
    const now = Date.now();
    this.db
      .query('INSERT INTO hub_accounts (id, name, name_key, display_name, email, email_key, role, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, name.toLowerCase(), displayName, email ?? null, emailKey(email) ?? null, 'member', JSON.stringify(input.settings ?? {}), now, now);
    this.fresh();
    return this.get(id)!;
  }

  /**
   * Change a sign-in name, display name, email or settings. A display name
   * that was none or the old sign-in name follows a new sign-in name, so an
   * app that only knows sign-in names (an older one) still renames the
   * person everywhere; one set apart stays. displayName null clears it.
   * Only a new email is checked against everyone else's, so two old rows
   * that share one can still change the rest.
   */
  update(id: string, patch: { name?: unknown; displayName?: unknown; email?: unknown; settings?: AccountSettings }): HubAccount {
    const a = this.get(id);
    if (!a) throw new PeopleError(404, 'There is nobody with that id on this hub.');
    const name = patch.name !== undefined ? checkName(patch.name) : a.name;
    if (name.toLowerCase() !== a.name.toLowerCase() && this.byName(name)) throw new PeopleError(409, `There is already someone called ${name} on this hub.`);
    const follows = name !== a.name && (a.displayName === undefined || a.displayName === a.name);
    const displayName = patch.displayName !== undefined ? checkDisplayName(patch.displayName) : follows ? name : a.displayName;
    const email = patch.email !== undefined ? checkEmail(patch.email) : a.email;
    if (email && emailKey(email) !== emailKey(a.email) && this.withEmail(email).some((r) => r.id !== id)) throw new PeopleError(409, EMAIL_TAKEN);
    const settings = patch.settings ?? a.settings;
    this.db
      .query('UPDATE hub_accounts SET name = ?, name_key = ?, display_name = ?, email = ?, email_key = ?, settings = ?, updated_at = ? WHERE id = ?')
      .run(name, name.toLowerCase(), displayName ?? null, email ?? null, emailKey(email) ?? null, JSON.stringify(settings), Date.now(), id);
    this.fresh();
    return this.get(id)!;
  }

  passwordHash(id: string): string | undefined {
    const r = this.db.query('SELECT password_hash FROM hub_accounts WHERE id = ?').get(id) as { password_hash: string | null } | null;
    return r?.password_hash ?? undefined;
  }

  setPasswordHash(id: string, hash: string | undefined): void {
    this.db.query('UPDATE hub_accounts SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?').run(hash ?? null, hash ? Date.now() : null, Date.now(), id);
    this.fresh();
  }

  /** Keep the SHA-256 of an invite secret until expiresAt. */
  setInvite(id: string, hash: string | undefined, expiresAt?: number): void {
    this.db.query('UPDATE hub_accounts SET invite_hash = ?, invite_expires_at = ?, updated_at = ? WHERE id = ?').run(hash ?? null, hash ? (expiresAt ?? null) : null, Date.now(), id);
    this.fresh();
  }

  /** The account a live invite belongs to. */
  byInvite(hash: string): HubAccount | undefined {
    const r = this.db.query('SELECT * FROM hub_accounts WHERE invite_hash = ? AND invite_expires_at > ?').get(hash, Date.now()) as Row | null;
    return r ? toAccount(r) : undefined;
  }

  /**
   * Use up a live invite: it is cleared in the same step it is checked, so of
   * two answers to one link only the first gets the account. Undefined when
   * the invite is gone, expired or already used.
   */
  claimInvite(hash: string): HubAccount | undefined {
    const now = Date.now();
    const r = this.db.query('SELECT * FROM hub_accounts WHERE invite_hash = ? AND invite_expires_at > ?').get(hash, now) as Row | null;
    if (!r) return undefined;
    const done = this.db.query('UPDATE hub_accounts SET invite_hash = NULL, invite_expires_at = NULL, updated_at = ? WHERE id = ? AND invite_hash = ?').run(now, r.id, hash);
    this.fresh();
    return done.changes ? this.get(r.id) : undefined;
  }

  /**
   * Remove a member and everything that is theirs: sessions and messages,
   * memory, routines, tasks, usage, devices, apps and the rest. The owner
   * cannot be removed.
   */
  remove(id: string): void {
    if (id === OWNER_ID) throw new PeopleError(400, 'The owner cannot be removed.');
    if (!this.get(id)) throw new PeopleError(404, 'There is nobody with that id on this hub.');
    purgeAccount(this.db, id);
    this.db.query('DELETE FROM hub_accounts WHERE id = ?').run(id);
    this.fresh();
  }
}

function tableExists(db: Db, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table')").get(table);
}

function columns(db: Db, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** Child key column per parent table, for the purge below. */
const PARENT_KEY: Record<string, string[]> = {
  sessions: ['session_id'],
  routines: ['routine_id'],
  memories: ['memory_id'],
  projects: ['project_id'],
  goals: ['goal_id'],
  import_batches: ['batch_id'],
  devices: ['device', 'from_device'],
  workflow_runs: ['run_id'],
  oauth_grants: ['grant_id'],
  clients: ['client_id'],
};

/**
 * SQL for the ids an account owns in a table: its own rows, or for a child
 * table the rows under its parent's (a workflow finding under a run under a
 * session). Undefined when the table cannot be placed.
 */
function ownedIds(db: Db, table: string, depth = 0): string | undefined {
  if (depth > 4 || !tableExists(db, table)) return undefined;
  const cols = columns(db, table);
  if (cols.includes('account_id')) return `SELECT id FROM ${table} WHERE account_id = $acct`;
  const parent = CHILD_TABLES[table];
  const key = parent ? (PARENT_KEY[parent] ?? []).find((k) => cols.includes(k)) : undefined;
  const up = parent && key ? ownedIds(db, parent, depth + 1) : undefined;
  return up && cols.includes('id') ? `SELECT id FROM ${table} WHERE ${key} IN (${up})` : undefined;
}

function depthOf(table: string): number {
  let d = 0;
  for (let t: string | undefined = table; t && CHILD_TABLES[t] && d < 6; t = CHILD_TABLES[t]) d++;
  return d;
}

/** Delete every row of an account: grandchildren first, then children, then its own rows. */
export function purgeAccount(db: Db, id: string): void {
  db.transaction(() => {
    const children = Object.keys(CHILD_TABLES).sort((a, b) => depthOf(b) - depthOf(a));
    for (const child of children) {
      // full-text indexes are virtual tables, listed as tables too
      if (!tableExists(db, child)) continue;
      const parent = CHILD_TABLES[child];
      const cols = columns(db, child);
      const key = (PARENT_KEY[parent] ?? []).find((k) => cols.includes(k));
      const owned = key ? ownedIds(db, parent) : undefined;
      if (key && owned) db.query(`DELETE FROM ${child} WHERE ${key} IN (${owned})`).run({ acct: id } as never);
    }
    for (const t of ACCOUNT_TABLES) {
      if (tableExists(db, t) && columns(db, t).includes('account_id')) db.query(`DELETE FROM ${t} WHERE account_id = ?`).run(id);
    }
    // per-account keys in the hub's key-value store
    db.query('DELETE FROM kv WHERE key LIKE ?').run(`acct:${id}:%`);
  })();
}

/** A kv key that belongs to one account: the owner keeps the old key, so nothing moves. */
export function accountKey(accountId: string, key: string): string {
  return accountId === OWNER_ID ? key : `acct:${accountId}:${key}`;
}
