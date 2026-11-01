/**
 * The accounts migration (docs/design/ACCOUNTS.md 9). openDb runs it after
 * the shared migrations, and the people store runs it again on a database
 * opened another way. Every step checks before it acts, so a second run
 * changes nothing, and every row that was there is the owner's.
 */
import type { Database } from 'bun:sqlite';
import { OWNER_ID } from './context';
import { ACCOUNT_TABLES, ensureAccountColumn, ensureColumn, hasColumn } from './tables';

export const PEOPLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  email_key TEXT,
  role TEXT NOT NULL,
  password_hash TEXT,
  password_set_at INTEGER,
  invite_hash TEXT,
  invite_expires_at INTEGER,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_accounts_invite ON hub_accounts(invite_hash);
`;

/**
 * What an email is looked up by, as name_key is for a name: trimmed and in
 * lower case. Undefined for none.
 */
export function emailKey(email: string | null | undefined): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

/** The single hub password from before accounts (kv), which was the owner's. */
export const OLD_PASSWORD_KEY = 'auth.password';

export function migratePeople(db: Database, now = Date.now()): void {
  db.transaction(() => {
    db.exec(PEOPLE_SCHEMA);
    db.query('INSERT OR IGNORE INTO hub_accounts (id, name, name_key, role, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(OWNER_ID, 'owner', 'owner', 'owner', '{}', now, now);
    // display names: an account from before them starts with its sign-in name, the owner's default "owner" with none.
    // Only when the column is new, so a name cleared or set apart later is never filled in again.
    if (!hasColumn(db, 'hub_accounts', 'display_name')) {
      db.exec('ALTER TABLE hub_accounts ADD COLUMN display_name TEXT');
      db.query(`UPDATE hub_accounts SET display_name = name WHERE NOT (role = 'owner' AND name_key = 'owner')`).run();
    }
    // emails sign in too (ACCOUNTS.md 4): email_key is to email what name_key is to name.
    // Not unique in the table, so two old rows that share an email stay as they are; the store refuses a new one.
    if (!hasColumn(db, 'hub_accounts', 'email_key')) {
      db.exec('ALTER TABLE hub_accounts ADD COLUMN email_key TEXT');
      const set = db.query('UPDATE hub_accounts SET email_key = ? WHERE id = ?');
      for (const r of db.query('SELECT id, email FROM hub_accounts WHERE email IS NOT NULL').all() as Array<{ id: string; email: string }>) set.run(emailKey(r.email) ?? null, r.id);
    }
    db.exec('CREATE INDEX IF NOT EXISTS hub_accounts_email ON hub_accounts(email_key)');
    for (const t of ACCOUNT_TABLES) ensureAccountColumn(db, t);
    // whose key served a call: budgets count only the hub's
    ensureColumn(db, 'usage', 'paid_by', 'TEXT');
    const hasKv = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get();
    const old = hasKv ? (db.query('SELECT value FROM kv WHERE key = ?').get(OLD_PASSWORD_KEY) as { value: string } | null) : null;
    if (old) {
      let v: { hash?: string; setAt?: number } | null = null;
      try {
        v = JSON.parse(old.value);
      } catch {
        v = null;
      }
      const owner = db.query('SELECT password_hash FROM hub_accounts WHERE id = ?').get(OWNER_ID) as { password_hash: string | null };
      if (v?.hash && !owner.password_hash) db.query('UPDATE hub_accounts SET password_hash = ?, password_set_at = ? WHERE id = ?').run(v.hash, v.setAt ?? now, OWNER_ID);
      db.query('DELETE FROM kv WHERE key = ?').run(OLD_PASSWORD_KEY);
    }
  })();
}
