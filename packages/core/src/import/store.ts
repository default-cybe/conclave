/**
 * The import service's tables (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.12).
 * Created here with IF NOT EXISTS, outside the shared migration list.
 *
 * import_sources: the ledger, one row per source location (source, device, path).
 * import_scan: the scan cache, one row per file a device has, keyed by size and mtime.
 * import_batches and import_items: a batch's state, so the job resumes after a restart.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { ImportBatch, ImportBatchItem, ImportBatchStatus, ImportItemState, ImportMode, ImportSource } from '../client/import';
import type { RowInfo } from './sources';
import { OWNER_ID } from '../people/context';
import { ensureAccountColumn } from '../people/tables';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_sources (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  device TEXT NOT NULL,
  path TEXT NOT NULL,
  native_id TEXT,
  fingerprint TEXT,
  size INTEGER,
  mtime INTEGER,
  cursor TEXT,
  prefix_hash TEXT,
  session_id TEXT,
  batch_id TEXT,
  learn_state TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  title TEXT,
  cwd TEXT,
  git_branch TEXT,
  repo TEXT,
  first_at INTEGER,
  last_at INTEGER,
  imported_at INTEGER,
  updated_at INTEGER,
  UNIQUE (source, device, path)
);
CREATE INDEX IF NOT EXISTS import_sources_fp ON import_sources(fingerprint);
CREATE INDEX IF NOT EXISTS import_sources_session ON import_sources(session_id);
CREATE TABLE IF NOT EXISTS import_scan (
  device TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  info TEXT,
  error TEXT,
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY (device, path)
);
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  counts TEXT NOT NULL DEFAULT '{}',
  dropped TEXT NOT NULL DEFAULT '{}',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  options TEXT,
  error TEXT,
  resume_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS import_batches_created ON import_batches(created_at DESC);
CREATE TABLE IF NOT EXISTS import_items (
  batch_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ord INTEGER NOT NULL,
  state TEXT NOT NULL,
  learned INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  source TEXT,
  path TEXT,
  title TEXT,
  memories TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, key)
);
`;

type Row = Record<string, any>;

/** Where the last import stopped, and source ids that Conclave's own harness turns already cover. */
export interface LedgerCursor {
  lastId?: string;
  count: number;
  /** Source message ids that match turns Conclave ran through the same harness (ACP): present, not copied. */
  absorbed?: string[];
}

export interface LedgerRow {
  id: string;
  /** Whose import (docs/design/ACCOUNTS.md). */
  accountId?: string;
  source: ImportSource;
  device: string;
  path: string;
  nativeId?: string;
  fingerprint?: string;
  size?: number;
  mtime?: number;
  cursor: LedgerCursor;
  prefixHash?: string;
  sessionId?: string;
  batchId?: string;
  learnState?: 'learned' | 'pending';
  /** ok, importing (written before the session), failed, ambiguous, missing. */
  status: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  repo?: string;
  firstAt?: number;
  lastAt?: number;
  importedAt?: number;
  updatedAt?: number;
}

export interface ScanCacheRow {
  device: string;
  path: string;
  source: ImportSource;
  size: number;
  mtime: number;
  info?: RowInfo;
  error?: string;
  scannedAt: number;
}

export interface BatchOptions {
  includeSkipped?: boolean;
  episodeNotes?: boolean;
  /** For mode learn with Conclave sessions. */
  sessionIds?: string[];
}

export interface BatchCounts {
  total: number;
  imported: number;
  updated: number;
  forked: number;
  unchanged: number;
  skipped: number;
  failed: number;
  learnedSessions: number;
  memoriesAdded: number;
  memoriesMerged: number;
  memoriesReview: number;
  /** Learned facts not saved because the owner's own notes already state them. */
  memoriesInNotes: number;
}

export const EMPTY_COUNTS: BatchCounts = { total: 0, imported: 0, updated: 0, forked: 0, unchanged: 0, skipped: 0, failed: 0, learnedSessions: 0, memoriesAdded: 0, memoriesMerged: 0, memoriesReview: 0, memoriesInNotes: 0 };

export interface BatchRow {
  id: string;
  /** Whose batch (docs/design/ACCOUNTS.md). */
  accountId?: string;
  device: string;
  mode: ImportMode;
  model?: string;
  status: ImportBatchStatus;
  counts: BatchCounts;
  dropped: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  options: BatchOptions;
  error?: string;
  resumeAt?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface ItemRow extends ImportBatchItem {
  batchId: string;
  ord: number;
  learned: boolean;
  /** The batch made this session (Undo deletes it). */
  created: boolean;
  memoryIds: string[];
  /** The source file on the batch's device. */
  path?: string;
}

export const UNDO_DAYS = 30;

function rowToLedger(r: Row): LedgerRow {
  return {
    id: r.id,
    accountId: r.account_id ?? OWNER_ID,
    source: r.source,
    device: r.device,
    path: r.path,
    nativeId: r.native_id ?? undefined,
    fingerprint: r.fingerprint ?? undefined,
    size: r.size ?? undefined,
    mtime: r.mtime ?? undefined,
    cursor: json<LedgerCursor>(r.cursor, { count: 0 }),
    prefixHash: r.prefix_hash ?? undefined,
    sessionId: r.session_id ?? undefined,
    batchId: r.batch_id ?? undefined,
    learnState: r.learn_state ?? undefined,
    status: r.status,
    title: r.title ?? undefined,
    cwd: r.cwd ?? undefined,
    gitBranch: r.git_branch ?? undefined,
    repo: r.repo ?? undefined,
    firstAt: r.first_at ?? undefined,
    lastAt: r.last_at ?? undefined,
    importedAt: r.imported_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  };
}

function rowToScan(r: Row): ScanCacheRow {
  return {
    device: r.device,
    path: r.path,
    source: r.source,
    size: r.size,
    mtime: r.mtime,
    info: json<RowInfo | undefined>(r.info, undefined),
    error: r.error ?? undefined,
    scannedAt: r.scanned_at,
  };
}

function rowToBatch(r: Row): BatchRow {
  return {
    id: r.id,
    accountId: r.account_id ?? OWNER_ID,
    device: r.device,
    mode: r.mode,
    model: r.model ?? undefined,
    status: r.status,
    counts: { ...EMPTY_COUNTS, ...json<Partial<BatchCounts>>(r.counts, {}) },
    dropped: json<Record<string, number>>(r.dropped, {}),
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
    options: json<BatchOptions>(r.options, {}),
    error: r.error ?? undefined,
    resumeAt: r.resume_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at ?? undefined,
  };
}

function rowToItem(r: Row): ItemRow {
  return {
    batchId: r.batch_id,
    key: r.key,
    ord: r.ord,
    state: r.state,
    learned: !!r.learned,
    created: !!r.created,
    sessionId: r.session_id ?? undefined,
    source: r.source ?? undefined,
    path: r.path ?? undefined,
    title: r.title ?? undefined,
    memoryIds: json<string[]>(r.memories, []),
    memories: json<string[]>(r.memories, []).length,
    reason: r.reason ?? undefined,
    updatedAt: r.updated_at,
  };
}

export function batchDto(b: BatchRow): ImportBatch {
  return {
    id: b.id,
    ...(b.accountId ? { accountId: b.accountId } : {}),
    device: b.device,
    mode: b.mode,
    ...(b.model ? { model: b.model } : {}),
    status: b.status,
    ...b.counts,
    dropped: b.dropped,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    costUsd: Math.round(b.costUsd * 1e6) / 1e6,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    ...(b.finishedAt ? { finishedAt: b.finishedAt } : {}),
    ...(b.resumeAt ? { resumeAt: b.resumeAt } : {}),
    ...(b.error ? { error: b.error } : {}),
    ...(b.status !== 'undone' ? { undoUntil: b.createdAt + UNDO_DAYS * 86_400_000 } : {}),
  };
}

export class ImportStore {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
    // an import is one account's (docs/design/ACCOUNTS.md); the scan cache follows its device
    ensureAccountColumn(db, 'import_sources');
    ensureAccountColumn(db, 'import_batches');
  }

  // ----- ledger --------------------------------------------------------------

  ledgerAt(source: string, device: string, path: string): LedgerRow | undefined {
    const r = this.db.query('SELECT * FROM import_sources WHERE source = ? AND device = ? AND path = ?').get(source, device, path) as Row | null;
    return r ? rowToLedger(r) : undefined;
  }

  /** The same chat file found before, by this account only: someone else's copy of a file is their session. */
  ledgerByFingerprint(fp: string, accountId: string = OWNER_ID): LedgerRow[] {
    return (this.db.query('SELECT * FROM import_sources WHERE fingerprint = ? AND account_id = ?').all(fp, accountId) as Row[]).map(rowToLedger);
  }

  ledgerBySession(sessionId: string): LedgerRow[] {
    return (this.db.query('SELECT * FROM import_sources WHERE session_id = ? ORDER BY updated_at DESC').all(sessionId) as Row[]).map(rowToLedger);
  }

  ledgerForDevice(device: string): LedgerRow[] {
    return (this.db.query('SELECT * FROM import_sources WHERE device = ?').all(device) as Row[]).map(rowToLedger);
  }

  ledgerByBatch(batchId: string): LedgerRow[] {
    return (this.db.query('SELECT * FROM import_sources WHERE batch_id = ?').all(batchId) as Row[]).map(rowToLedger);
  }

  /**
   * Imported sessions the learning job has not read yet. Session.meta.import
   * is the record (a fork after "continued in both places" takes the ledger
   * row of its location, and the session it forked from stays importable).
   */
  notLearned(accountId: string = OWNER_ID): string[] {
    return (
      this.db
        .query(
          `SELECT id FROM sessions WHERE account_id = ? AND json_extract(meta, '$.import.source') IS NOT NULL AND COALESCE(json_extract(meta, '$.import.learned'), 0) = 0 AND COALESCE(json_extract(meta, '$.import.learnable'), 1) != 0 ORDER BY created_at`,
        )
        .all(accountId) as Row[]
    ).map((r) => r.id as string);
  }

  putLedger(l: LedgerRow): void {
    this.db
      .query(
        `INSERT INTO import_sources (id,source,device,path,native_id,fingerprint,size,mtime,cursor,prefix_hash,session_id,batch_id,learn_state,status,title,cwd,git_branch,repo,first_at,last_at,imported_at,updated_at,account_id)
         VALUES ($id,$source,$device,$path,$native,$fp,$size,$mtime,$cursor,$prefix,$session,$batch,$learn,$status,$title,$cwd,$branch,$repo,$first,$last,$imported,$updated,$account)
         ON CONFLICT(source, device, path) DO UPDATE SET native_id=$native, fingerprint=$fp, size=$size, mtime=$mtime, cursor=$cursor, prefix_hash=$prefix, session_id=$session,
           batch_id=$batch, learn_state=$learn, status=$status, title=$title, cwd=$cwd, git_branch=$branch, repo=$repo, first_at=$first, last_at=$last, imported_at=$imported, updated_at=$updated`,
      )
      .run({
        id: l.id,
        source: l.source,
        device: l.device,
        path: l.path,
        native: l.nativeId ?? null,
        fp: l.fingerprint ?? null,
        size: l.size ?? null,
        mtime: l.mtime ?? null,
        cursor: JSON.stringify(l.cursor),
        prefix: l.prefixHash ?? null,
        session: l.sessionId ?? null,
        batch: l.batchId ?? null,
        learn: l.learnState ?? null,
        status: l.status,
        title: l.title ?? null,
        cwd: l.cwd ?? null,
        branch: l.gitBranch ?? null,
        repo: l.repo ?? null,
        first: l.firstAt ?? null,
        last: l.lastAt ?? null,
        imported: l.importedAt ?? null,
        updated: l.updatedAt ?? Date.now(),
        account: l.accountId ?? OWNER_ID,
      } as never);
  }

  deleteLedger(id: string): void {
    this.db.query('DELETE FROM import_sources WHERE id = ?').run(id);
  }

  setLearned(sessionId: string, state: 'learned' | 'pending' | null): void {
    this.db.query('UPDATE import_sources SET learn_state = ? WHERE session_id = ?').run(state, sessionId);
  }

  // ----- scan cache ----------------------------------------------------------

  scanRows(device: string): ScanCacheRow[] {
    return (this.db.query('SELECT * FROM import_scan WHERE device = ?').all(device) as Row[]).map(rowToScan);
  }

  scanRow(device: string, path: string): ScanCacheRow | undefined {
    const r = this.db.query('SELECT * FROM import_scan WHERE device = ? AND path = ?').get(device, path) as Row | null;
    return r ? rowToScan(r) : undefined;
  }

  putScan(rows: ScanCacheRow[]): void {
    const q = this.db.query(
      `INSERT INTO import_scan (device,path,source,size,mtime,info,error,scanned_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(device, path) DO UPDATE SET source=excluded.source, size=excluded.size, mtime=excluded.mtime, info=excluded.info, error=excluded.error, scanned_at=excluded.scanned_at`,
    );
    this.db.transaction(() => {
      for (const r of rows) q.run(r.device, r.path, r.source, r.size, r.mtime, r.info ? JSON.stringify(r.info) : null, r.error ?? null, r.scannedAt);
    })();
  }

  dropScan(device: string, paths: string[]): void {
    const q = this.db.query('DELETE FROM import_scan WHERE device = ? AND path = ?');
    this.db.transaction(() => {
      for (const p of paths) q.run(device, p);
    })();
  }

  // ----- batches -------------------------------------------------------------

  batch(id: string): BatchRow | undefined {
    const r = this.db.query('SELECT * FROM import_batches WHERE id = ?').get(id) as Row | null;
    return r ? rowToBatch(r) : undefined;
  }

  /** One account's batches, newest first. */
  batches(limit = 20, accountId: string = OWNER_ID): BatchRow[] {
    return (this.db.query('SELECT * FROM import_batches WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit) as Row[]).map(rowToBatch);
  }

  /** Batches a restart left in a working state. */
  unfinished(): BatchRow[] {
    return (this.db.query(`SELECT * FROM import_batches WHERE status IN ('scanning','importing','learning','consolidating','waiting_reset')`).all() as Row[]).map(rowToBatch);
  }

  putBatch(b: BatchRow): void {
    this.db
      .query(
        `INSERT INTO import_batches (id,device,mode,model,status,counts,dropped,input_tokens,output_tokens,cost_usd,options,error,resume_at,created_at,updated_at,finished_at,account_id)
         VALUES ($id,$device,$mode,$model,$status,$counts,$dropped,$in,$out,$cost,$options,$error,$resume,$created,$updated,$finished,$account)
         ON CONFLICT(id) DO UPDATE SET status=$status, model=$model, counts=$counts, dropped=$dropped, input_tokens=$in, output_tokens=$out, cost_usd=$cost, options=$options,
           error=$error, resume_at=$resume, updated_at=$updated, finished_at=$finished`,
      )
      .run({
        id: b.id,
        device: b.device,
        mode: b.mode,
        model: b.model ?? null,
        status: b.status,
        counts: JSON.stringify(b.counts),
        dropped: JSON.stringify(b.dropped),
        in: b.inputTokens,
        out: b.outputTokens,
        cost: b.costUsd,
        options: JSON.stringify(b.options),
        error: b.error ?? null,
        resume: b.resumeAt ?? null,
        created: b.createdAt,
        updated: b.updatedAt,
        finished: b.finishedAt ?? null,
        account: b.accountId ?? OWNER_ID,
      } as never);
  }

  /** Status only, read back fresh: pause and cancel come from another request while the job runs. */
  batchStatus(id: string): ImportBatchStatus | undefined {
    return (this.db.query('SELECT status FROM import_batches WHERE id = ?').get(id) as Row | null)?.status;
  }

  setBatchStatus(id: string, status: ImportBatchStatus, extra: { error?: string | null; resumeAt?: number | null; finishedAt?: number | null } = {}): void {
    const sets = ['status = $status', 'updated_at = $now'];
    const params: Record<string, unknown> = { id, status, now: Date.now() };
    if ('error' in extra) (sets.push('error = $error'), (params.error = extra.error ?? null));
    if ('resumeAt' in extra) (sets.push('resume_at = $resume'), (params.resume = extra.resumeAt ?? null));
    if ('finishedAt' in extra) (sets.push('finished_at = $fin'), (params.fin = extra.finishedAt ?? null));
    this.db.query(`UPDATE import_batches SET ${sets.join(', ')} WHERE id = $id`).run(params as never);
  }

  // ----- items ---------------------------------------------------------------

  addItems(batchId: string, items: Array<{ key: string; source?: ImportSource; path?: string; title?: string; sessionId?: string; state?: ImportItemState; reason?: string }>): void {
    const q = this.db.query(`INSERT OR IGNORE INTO import_items (batch_id,key,ord,state,session_id,source,path,title,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    this.db.transaction(() => {
      items.forEach((it, i) => q.run(batchId, it.key, i, it.state ?? 'queued', it.sessionId ?? null, it.source ?? null, it.path ?? null, it.title ?? null, it.reason ?? null, now));
    })();
  }

  items(batchId: string, opts: { offset?: number; limit?: number } = {}): ItemRow[] {
    return (this.db.query('SELECT * FROM import_items WHERE batch_id = ? ORDER BY ord LIMIT ? OFFSET ?').all(batchId, opts.limit ?? 100_000, opts.offset ?? 0) as Row[]).map(rowToItem);
  }

  itemCount(batchId: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM import_items WHERE batch_id = ?').get(batchId) as Row).n;
  }

  updateItem(batchId: string, key: string, patch: { state?: ImportItemState; sessionId?: string; reason?: string | null; learned?: boolean; created?: boolean; memoryIds?: string[]; title?: string }): void {
    const sets = ['updated_at = $now'];
    const params: Record<string, unknown> = { b: batchId, k: key, now: Date.now() };
    if (patch.state) (sets.push('state = $state'), (params.state = patch.state));
    if (patch.sessionId !== undefined) (sets.push('session_id = $sid'), (params.sid = patch.sessionId));
    if (patch.reason !== undefined) (sets.push('reason = $reason'), (params.reason = patch.reason));
    if (patch.learned !== undefined) (sets.push('learned = $learned'), (params.learned = patch.learned ? 1 : 0));
    if (patch.created !== undefined) (sets.push('created = $created'), (params.created = patch.created ? 1 : 0));
    if (patch.memoryIds) (sets.push('memories = $mem'), (params.mem = JSON.stringify(patch.memoryIds)));
    if (patch.title !== undefined) (sets.push('title = $title'), (params.title = patch.title));
    this.db.query(`UPDATE import_items SET ${sets.join(', ')} WHERE batch_id = $b AND key = $k`).run(params as never);
  }
}
