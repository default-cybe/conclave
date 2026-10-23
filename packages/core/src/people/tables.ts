/**
 * Which tables belong to an account, in one place (docs/design/ACCOUNTS.md 3
 * and 11). A test reads the live schema and fails when a table is in none of
 * these lists, so a new table has to say how it is scoped.
 *
 * - ACCOUNT_TABLES rows can be found on their own: they carry account_id,
 *   every insert sets it, every read filters on it.
 * - CHILD_TABLES rows are only reached through a parent row; a query that
 *   reads one on its own joins the parent and filters on its account.
 * - HUB_TABLES are the hub's: settings, caches, queues, the owner's friends.
 */
import type { Db } from '../storage/db';
import { OWNER_ID } from './context';

/** Tables with their own account_id column. */
export const ACCOUNT_TABLES = [
  // shared migration (storage/db.ts)
  'sessions',
  'tasks',
  'routines',
  'memories',
  'usage',
  'devices',
  'clients',
  'pairing_codes',
  'push_subscriptions',
  'gateway_keys',
  'audit',
  // module tables (each calls ensureAccountColumn after its CREATE TABLE)
  'projects',
  'goals',
  'import_sources',
  'import_batches',
  'maps_items',
  'oauth_grants',
  'oauth_codes',
  // calendar and mail proposals (pim/store.ts)
  'pim_proposals',
] as const;

/** Child table to the parent table whose account_id scopes it. */
export const CHILD_TABLES: Record<string, string> = {
  messages: 'sessions',
  messages_fts: 'sessions',
  sessions_fts: 'sessions',
  checkpoints: 'sessions',
  turns: 'sessions',
  approvals: 'sessions',
  tool_outputs: 'sessions',
  session_locations: 'sessions',
  location_state: 'sessions',
  repo_sessions: 'sessions',
  routine_runs: 'routines',
  memories_fts: 'memories',
  project_locations: 'projects',
  goal_entries: 'goals',
  goal_notes: 'goals',
  import_items: 'import_batches',
  import_scan: 'devices',
  repo_clones: 'devices',
  path_prefixes: 'devices',
  app_devices: 'clients',
  // a workflow run is its host session's; its calls, logs and findings are the run's
  workflow_runs: 'sessions',
  workflow_findings: 'workflow_runs',
  workflow_calls: 'workflow_runs',
  workflow_logs: 'workflow_runs',
  oauth_tokens: 'oauth_grants',
  // a watch's items and runs are its routine's (watches/service.ts)
  watch_items: 'routines',
  watch_runs: 'routines',
};

/** The hub's own tables: no account. */
export const HUB_TABLES = [
  'schema_version',
  'hub_accounts',
  'kv',
  'jobs',
  'limits',
  'response_cache',
  'catalog_http',
  'catalog_items',
  'catalog_items_fts',
  'catalog_installs',
  'oauth_clients',
  'oauth_requests',
  'oauth_assertions',
  // friends are the owner's (docs/design/ACCOUNTS.md 7)
  'friends',
  'friend_invites',
  'friend_shares_out',
  'friend_share_sends',
  'friend_shares_in',
  'friend_share_revoked',
  'peer_outbox',
  'peer_inbox',
  'peer_nonces',
  'peer_blobs',
  'friend_blocks',
  // shared projects are between the owner's hub and friends' hubs, like shares
  'shared_projects',
  'shared_project_members',
  'shared_project_items',
  'shared_project_versions',
];

function hasTable(db: Db, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

export function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

/**
 * Give a table its account_id column when it has none: every row it has now
 * is the owner's. Safe to call again and again; a table that does not exist
 * yet is left alone.
 */
export function ensureAccountColumn(db: Db, table: string): void {
  if (!/^[a-z_]+$/.test(table) || !hasTable(db, table)) return;
  if (!hasColumn(db, table, 'account_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT NOT NULL DEFAULT '${OWNER_ID}'`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ${table}_account ON ${table}(account_id)`);
}

/** Add a column when it is missing (the same check-then-act as ensureAccountColumn). */
export function ensureColumn(db: Db, table: string, column: string, type: string): void {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column) || !hasTable(db, table)) return;
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
