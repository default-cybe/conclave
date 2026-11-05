/**
 * Incognito sessions: a chat or Code session whose conversation is not kept.
 *
 * The row carries `incognito` (set on create, never changed; storage/repos.ts
 * insert). Every list, search and summary query leaves it out through
 * `notIncognito()`; its messages and title are never put in the full-text
 * indexes. When the owner closes it, after INCOGNITO_IDLE_MS without activity,
 * and at hub start (what a crash left), `purgeIncognitoRows` hard-deletes
 * every row about it in one transaction with secure_delete on, so the freed
 * pages are zeroed, then checkpoints the WAL. Usage keeps tokens and cost
 * only. Files and commands on a device stay: only the conversation goes.
 */
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '../storage/db';
import { outputsDir } from '../files/share';
import { EngineError } from '../engine/errors';
import type { Notice, Session } from '../types';

/** An incognito session idle this long is deleted. */
export const INCOGNITO_IDLE_MS = 12 * 60 * 60_000;
/** The idle sweep's job kind and period (engine/create.ts plans it, as db.optimize). */
export const INCOGNITO_SWEEP_JOB = 'incognito.sweep';
export const INCOGNITO_SWEEP_EVERY_MS = 30 * 60_000;

/** An incognito session is never copied out of itself: no fork, export, share or participants. */
export function refuseIncognito(s: Pick<Session, 'incognito'> | undefined, what: string): void {
  if (s?.incognito) throw new EngineError(409, `An incognito session cannot be ${what}. Its conversation is not kept.`);
}

/** What a push from an incognito session says: that it waits, never its title, command, question or error. */
export function incognitoNotice<T extends Pick<Notice, 'title' | 'body'>>(n: T): T {
  return { ...n, title: 'Incognito session', body: 'Open it to see more.' };
}

/** Tables whose rows about a session are deleted, by their session column. messages and the rest with ON DELETE CASCADE go with the row. */
const DELETE_BY: Array<[table: string, column: string]> = [
  ['messages', 'session_id'],
  ['messages_fts', 'session_id'],
  ['sessions_fts', 'session_id'],
  ['tool_outputs', 'session_id'],
  ['approvals', 'session_id'],
  ['audit', 'session_id'],
  ['turns', 'session_id'],
  ['checkpoints', 'session_id'],
  ['chat_participants', 'session_id'],
  ['session_locations', 'session_id'],
  ['location_state', 'session_id'],
  ['repo_sessions', 'session_id'],
  ['meeting_digests', 'session_id'],
  ['pim_proposals', 'session_id'],
  ['routine_runs', 'session_id'],
  ['friend_shares_out', 'session_id'],
  ['import_items', 'session_id'],
  ['workflow_calls', 'child_session_id'],
];

/** Rows that outlive the session with the link cut: what the owner chose to keep (a memory saved in "Use and save", a goal) and usage counts. */
const UNLINK: Array<[table: string, column: string, extra?: string]> = [
  // tokens and cost stay for billing; the folder goes with the session
  ['usage', 'session_id', 'cwd = NULL'],
  ['memories', 'source_session_id'],
  ['goals', 'source_session_id'],
  ['goal_entries', 'session_id'],
];

function columns(db: Db, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name));
}

/** The session and every session under it (subagents, workflow steps), children first. */
export function incognitoTree(db: Db, id: string): string[] {
  const rows = db
    .query(`WITH RECURSIVE tree(id, depth) AS (SELECT ?, 0 UNION SELECT s.id, t.depth + 1 FROM sessions s JOIN tree t ON s.parent_id = t.id WHERE t.depth < 16) SELECT id FROM tree ORDER BY depth DESC`)
    .all(id) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Hard-delete every row about these sessions and their outputs folders. The
 * caller stops runners and shells first (engine.deleteSession). Returns how
 * many rows went, for the tests.
 */
export function purgeIncognitoRows(db: Db, ids: string[], home?: string): number {
  if (!ids.length) return 0;
  let n = 0;
  const scripts: string[] = [];
  // zeroed free pages: a deleted transcript is not left readable in the file; on for this transaction only (cost measured in the PR)
  db.exec('PRAGMA secure_delete = ON');
  try {
    db.transaction(() => {
      const cols = new Map<string, Set<string>>();
      const has = (t: string, c: string) => {
        if (!cols.has(t)) cols.set(t, columns(db, t));
        return cols.get(t)!.has(c);
      };
      for (const id of ids) {
        // a workflow run hosted here: its calls, logs and findings are its prompts and results
        if (has('workflow_runs', 'session_id')) {
          const runs = db.query('SELECT id, script_path FROM workflow_runs WHERE session_id = ?').all(id) as Array<{ id: string; script_path: string | null }>;
          for (const run of runs) {
            for (const t of ['workflow_calls', 'workflow_logs', 'workflow_findings']) if (has(t, 'run_id')) n += db.query(`DELETE FROM ${t} WHERE run_id = ?`).run(run.id).changes;
            // the run's script (workflows/service.ts saveScript) holds its prompts; only the hub's own <runId>.js file
            if (run.script_path && basename(run.script_path) === `${run.id}.js`) scripts.push(run.script_path);
          }
          n += db.query('DELETE FROM workflow_runs WHERE session_id = ?').run(id).changes;
        }
        for (const [t, c] of DELETE_BY) if (has(t, c)) n += db.query(`DELETE FROM ${t} WHERE ${c} = ?`).run(id).changes;
        for (const [t, c, extra] of UNLINK) if (has(t, c)) db.query(`UPDATE ${t} SET ${c} = NULL${extra ? `, ${extra}` : ''} WHERE ${c} = ?`).run(id);
        // per-session hub state (design-ref:<id>, memory.extract.<id>, ...) and jobs that name it (resumes, retries)
        n += db.query('DELETE FROM kv WHERE instr(key, ?) > 0').run(id).changes;
        n += db.query("DELETE FROM jobs WHERE instr(payload, ?) > 0 OR instr(COALESCE(dedupe_key, ''), ?) > 0").run(id, id).changes;
        n += db.query('DELETE FROM sessions WHERE id = ?').run(id).changes;
      }
    })();
  } finally {
    db.exec('PRAGMA secure_delete = OFF');
  }
  // the old pages also sit in the WAL until a checkpoint; best effort, a reader can hold it back until the next one
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* not in WAL mode, or busy: the next checkpoint writes over them */
  }
  if (home) for (const id of ids) rmSync(outputsDir(home, id), { recursive: true, force: true });
  for (const p of scripts) rmSync(p, { force: true });
  return n;
}

/** Incognito sessions to delete now: every one at hub start, or those idle past INCOGNITO_IDLE_MS. Top-level only; the purge takes their children. */
export function staleIncognito(db: Db, opts: { all?: boolean; now?: number } = {}): string[] {
  const before = opts.all ? Number.MAX_SAFE_INTEGER : (opts.now ?? Date.now()) - INCOGNITO_IDLE_MS;
  return (
    db
      .query(`SELECT id FROM sessions WHERE incognito = 1 AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM sessions WHERE incognito = 1)) AND updated_at < ? ${opts.all ? '' : "AND status NOT IN ('running', 'waiting_approval', 'waiting_input')"}`)
      .all(before) as Array<{ id: string }>
  ).map((r) => r.id);
}
