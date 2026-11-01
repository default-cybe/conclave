import { Database } from 'bun:sqlite';
import { migratePeople } from '../people/migrate';
import { migrateSharedChats } from '../people/shared-chats';
import { ensureColumn } from '../people/tables';

/**
 * One SQLite file holds everything: sessions, messages, tasks, routines,
 * memory (with FTS5), usage and the job queue. WAL mode keeps the server,
 * TUI and routines from blocking each other.
 */
const MIGRATIONS: string[] = [
  // 1: base schema
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    cwd TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT 'local',
    status TEXT NOT NULL,
    parent_id TEXT,
    task_id TEXT,
    routine_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    external TEXT,
    mode_config TEXT,
    stats TEXT NOT NULL DEFAULT '{}',
    resume_at INTEGER,
    error TEXT,
    meta TEXT
  );
  CREATE INDEX sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX sessions_agent ON sessions(agent, updated_at DESC);
  CREATE INDEX sessions_task ON sessions(task_id);
  CREATE INDEX sessions_parent ON sessions(parent_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    agent TEXT,
    author TEXT,
    grp TEXT,
    usage TEXT,
    stop_reason TEXT,
    created_at INTEGER NOT NULL,
    meta TEXT
  );
  CREATE UNIQUE INDEX messages_session_seq ON messages(session_id, seq);

  CREATE VIRTUAL TABLE messages_fts USING fts5(text, session_id UNINDEXED, message_id UNINDEXED, tokenize='porter unicode61');

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    agent TEXT,
    project TEXT,
    due INTEGER,
    labels TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    meta TEXT
  );

  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    timezone TEXT,
    agent TEXT NOT NULL,
    model TEXT,
    mode TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT,
    device TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    session_policy TEXT NOT NULL DEFAULT 'new',
    session_id TEXT,
    notify TEXT NOT NULL DEFAULT 'always',
    webhook_secret TEXT,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    session_id TEXT,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    summary TEXT
  );
  CREATE INDEX routine_runs_routine ON routine_runs(routine_id, started_at DESC);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    dedupe_key TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(status, run_at);
  CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending';

  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scope_key TEXT,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source_session_id TEXT,
    importance REAL NOT NULL DEFAULT 0.5,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    embedding_model TEXT
  );
  CREATE INDEX memories_scope ON memories(scope, scope_key, kind);
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, memory_id UNINDEXED, tokenize='porter unicode61');

  CREATE TABLE usage (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    session_id TEXT,
    source TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    purpose TEXT,
    ext_key TEXT
  );
  CREATE INDEX usage_ts ON usage(ts);
  CREATE UNIQUE INDEX usage_ext ON usage(source, ext_key) WHERE ext_key IS NOT NULL;

  CREATE TABLE limits (
    provider TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE tool_outputs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    tool TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX tool_outputs_session ON tool_outputs(session_id);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    device TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    info TEXT,
    roots TEXT NOT NULL DEFAULT '[]',
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE pairing_codes (
    code TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE audit (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    session_id TEXT,
    device TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX audit_ts ON audit(ts DESC);

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX checkpoints_session ON checkpoints(session_id, seq);

  CREATE TABLE gateway_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    prefix TEXT NOT NULL,
    device TEXT,
    agent TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE response_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 2: chat mode. kind is NULL for agent sessions made before it existed.
  `
  ALTER TABLE sessions ADD COLUMN kind TEXT;
  ALTER TABLE sessions ADD COLUMN chat TEXT;
  CREATE INDEX sessions_kind ON sessions(kind, updated_at DESC);
  `,
  // 3: Discover catalog (docs/design/ECOSYSTEM.md 1.4). IF NOT EXISTS so a
  // migration added by another branch at the same index cannot break it.
  `
  CREATE TABLE IF NOT EXISTS catalog_http (
    url TEXT PRIMARY KEY,
    etag TEXT,
    last_modified TEXT,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS catalog_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    repo TEXT,
    json TEXT NOT NULL,
    stars INTEGER,
    stars_at TEXT,
    updated_at TEXT,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS catalog_items_kind ON catalog_items(kind, stars DESC);
  CREATE INDEX IF NOT EXISTS catalog_items_repo ON catalog_items(repo);
  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_items_fts USING fts5(name, description, tags, item_id UNINDEXED, tokenize='porter unicode61');
  CREATE TABLE IF NOT EXISTS catalog_installs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    source TEXT NOT NULL,
    sha TEXT,
    version TEXT,
    files_hash TEXT,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    previous_json TEXT,
    upstream_sha TEXT,
    checked_at INTEGER,
    meta TEXT
  );
  `,
  // 4: routine fields from ECOSYSTEM.md 2.3 (allow, deny, onApproval, precheck,
  // env, timeoutMin, maxCostUsd, suggestion) and run fields (outcome, denied,
  // precheckOutput), each kept as one JSON object.
  `
  ALTER TABLE routines ADD COLUMN extra TEXT;
  ALTER TABLE routine_runs ADD COLUMN extra TEXT;
  `,
  // 5: the import, folders and workflows round (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 6.1).
  // memories.meta holds MemoryMeta as JSON (where an imported or learned memory came from).
  `
  ALTER TABLE memories ADD COLUMN meta TEXT;
  ALTER TABLE checkpoints ADD COLUMN device TEXT;
  ALTER TABLE checkpoints ADD COLUMN root TEXT;
  ALTER TABLE sessions ADD COLUMN project_id TEXT;
  ALTER TABLE sessions ADD COLUMN ultra INTEGER;
  `,
  // 6: search over past chats (session/search.ts). Titles get a full-text
  // index of their own, kept by triggers so every write path follows; a
  // status change does not touch it. IF NOT EXISTS as in 3.
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title, session_id UNINDEXED, tokenize='porter unicode61');
  INSERT INTO sessions_fts (title, session_id) SELECT title, id FROM sessions WHERE id NOT IN (SELECT session_id FROM sessions_fts);
  CREATE TRIGGER IF NOT EXISTS sessions_fts_insert AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts (title, session_id) VALUES (new.title, new.id);
  END;
  CREATE TRIGGER IF NOT EXISTS sessions_fts_title AFTER UPDATE OF title ON sessions WHEN old.title IS NOT new.title BEGIN
    DELETE FROM sessions_fts WHERE session_id = old.id;
    INSERT INTO sessions_fts (title, session_id) VALUES (new.title, new.id);
  END;
  CREATE TRIGGER IF NOT EXISTS sessions_fts_delete AFTER DELETE ON sessions BEGIN
    DELETE FROM sessions_fts WHERE session_id = old.id;
  END;
  `,
  // 7: accounts (docs/research/2026-10-20-next-features.md 1) and Recap data
  // (same doc, 2, phase 0). Usage rows say which account served them, on
  // which device and in which folder; approvals keep when they were asked
  // and answered; turns keep one row per user turn. limits rows are keyed
  // provider:account for per-account states (accounts/windows.ts limitKey).
  `
  ALTER TABLE usage ADD COLUMN account TEXT;
  ALTER TABLE usage ADD COLUMN device TEXT;
  ALTER TABLE usage ADD COLUMN cwd TEXT;
  CREATE INDEX IF NOT EXISTS usage_account ON usage(account, ts);
  CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    harness TEXT,
    requested_at INTEGER NOT NULL,
    resolved_at INTEGER,
    decision TEXT
  );
  CREATE INDEX IF NOT EXISTS approvals_requested ON approvals(requested_at);
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    model TEXT,
    account TEXT,
    tools INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    harness_session TEXT
  );
  CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, started_at);
  CREATE INDEX IF NOT EXISTS turns_started ON turns(started_at);
  `,
];

export type Db = Database;

export function openDb(file: string): Db {
  const db = new Database(file, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  // accounts (docs/design/ACCOUNTS.md 9): every owned table gets account_id, every old row is the owner's
  migratePeople(db);
  migrateSharedChats(db);
  // what a call is worth at API prices, kept from the day it is recorded (usage/value.ts); older rows have none
  ensureColumn(db, 'usage', 'api_value_usd', 'REAL');
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.query<{ version: number }, []>('SELECT version FROM schema_version LIMIT 1').get();
  let version = row?.version ?? 0;
  if (!row) db.exec('INSERT INTO schema_version (version) VALUES (0)');
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    db.transaction(() => {
      db.exec(sql);
      db.query('UPDATE schema_version SET version = ?').run(version + 1);
    })();
    version++;
  }
}

export function json<T>(v: string | null | undefined, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
