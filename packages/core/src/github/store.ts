/**
 * Repo session storage (docs/DESIGN.md 30). The tables are made here with
 * CREATE TABLE IF NOT EXISTS, so this module owns them and needs no shared
 * migration. A row outlives its session until the hub cleaned up after it.
 */
import type { Db } from '../storage/db';
import type { CiState, PrState } from '../client/github';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repo_clones (
  device TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (device, repo)
);
CREATE TABLE IF NOT EXISTS repo_sessions (
  session_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  device TEXT NOT NULL,
  clone_path TEXT NOT NULL,
  worktree TEXT NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  url TEXT NOT NULL,
  pushed_sha TEXT,
  pushed_at INTEGER,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT,
  pr_title TEXT,
  pr_draft INTEGER,
  ci TEXT,
  ci_url TEXT,
  checked_at INTEGER,
  cleaned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS repo_sessions_open ON repo_sessions(pr_state, cleaned_at);
`;

type Row = Record<string, any>;

export interface RepoSessionRow {
  sessionId: string;
  /** owner/name as GitHub spells it. */
  repo: string;
  device: string;
  clonePath: string;
  worktree: string;
  branch: string;
  base: string;
  baseSha: string;
  defaultBranch: string;
  /** The repository's page. */
  url: string;
  pushedSha?: string;
  pushedAt?: number;
  prNumber?: number;
  prUrl?: string;
  prState?: PrState;
  prTitle?: string;
  prDraft?: boolean;
  ci?: CiState;
  ciUrl?: string;
  checkedAt?: number;
  cleanedAt?: number;
  createdAt: number;
  updatedAt: number;
}

function toRow(r: Row): RepoSessionRow {
  return {
    sessionId: r.session_id,
    repo: r.repo,
    device: r.device,
    clonePath: r.clone_path,
    worktree: r.worktree,
    branch: r.branch,
    base: r.base,
    baseSha: r.base_sha,
    defaultBranch: r.default_branch,
    url: r.url,
    ...(r.pushed_sha ? { pushedSha: r.pushed_sha } : {}),
    ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}),
    ...(r.pr_number ? { prNumber: r.pr_number } : {}),
    ...(r.pr_url ? { prUrl: r.pr_url } : {}),
    ...(r.pr_state ? { prState: r.pr_state } : {}),
    ...(r.pr_title ? { prTitle: r.pr_title } : {}),
    ...(r.pr_draft ? { prDraft: true } : {}),
    ...(r.ci ? { ci: r.ci } : {}),
    ...(r.ci_url ? { ciUrl: r.ci_url } : {}),
    ...(r.checked_at ? { checkedAt: r.checked_at } : {}),
    ...(r.cleaned_at ? { cleanedAt: r.cleaned_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class RepoStore {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
  }

  // ----- clones ---------------------------------------------------------------

  clone(device: string, repo: string): string | undefined {
    const r = this.db.query('SELECT path FROM repo_clones WHERE device = ? AND repo = ?').get(device, repo.toLowerCase()) as Row | null;
    return r?.path;
  }

  saveClone(device: string, repo: string, path: string): void {
    const now = Date.now();
    this.db
      .query('INSERT INTO repo_clones (device, repo, path, created_at, used_at) VALUES (?,?,?,?,?) ON CONFLICT(device, repo) DO UPDATE SET path = excluded.path, used_at = excluded.used_at')
      .run(device, repo.toLowerCase(), path, now, now);
  }

  forgetClone(device: string, repo: string): void {
    this.db.query('DELETE FROM repo_clones WHERE device = ? AND repo = ?').run(device, repo.toLowerCase());
  }

  // ----- sessions -------------------------------------------------------------

  get(sessionId: string): RepoSessionRow | undefined {
    const r = this.db.query('SELECT * FROM repo_sessions WHERE session_id = ?').get(sessionId) as Row | null;
    return r ? toRow(r) : undefined;
  }

  list(): RepoSessionRow[] {
    return (this.db.query('SELECT * FROM repo_sessions ORDER BY created_at DESC').all() as Row[]).map(toRow);
  }

  /** Rows whose pull request is open and whose worktree is still there: what the poll reads. */
  open(): RepoSessionRow[] {
    return (this.db.query("SELECT * FROM repo_sessions WHERE pr_state = 'open' AND cleaned_at IS NULL ORDER BY checked_at ASC").all() as Row[]).map(toRow);
  }

  /** Branch names in use for a repository on a device (worktrees cannot share one). */
  branches(device: string, repo: string): string[] {
    return (this.db.query('SELECT branch FROM repo_sessions WHERE device = ? AND lower(repo) = ?').all(device, repo.toLowerCase()) as Row[]).map((r) => r.branch);
  }

  insert(row: Omit<RepoSessionRow, 'createdAt' | 'updatedAt'>): RepoSessionRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO repo_sessions (session_id, repo, device, clone_path, worktree, branch, base, base_sha, default_branch, url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.sessionId, row.repo, row.device, row.clonePath, row.worktree, row.branch, row.base, row.baseSha, row.defaultBranch, row.url, now, now);
    return this.get(row.sessionId)!;
  }

  update(sessionId: string, patch: Partial<Omit<RepoSessionRow, 'sessionId' | 'createdAt' | 'updatedAt'>>): RepoSessionRow | undefined {
    const cols: Record<string, string> = {
      repo: 'repo',
      device: 'device',
      clonePath: 'clone_path',
      worktree: 'worktree',
      branch: 'branch',
      base: 'base',
      baseSha: 'base_sha',
      defaultBranch: 'default_branch',
      url: 'url',
      pushedSha: 'pushed_sha',
      pushedAt: 'pushed_at',
      prNumber: 'pr_number',
      prUrl: 'pr_url',
      prState: 'pr_state',
      prTitle: 'pr_title',
      prDraft: 'pr_draft',
      ci: 'ci',
      ciUrl: 'ci_url',
      checkedAt: 'checked_at',
      cleanedAt: 'cleaned_at',
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number));
    }
    if (!sets.length) return this.get(sessionId);
    sets.push('updated_at = ?');
    values.push(Date.now());
    this.db.query(`UPDATE repo_sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...values, sessionId);
    return this.get(sessionId);
  }

  delete(sessionId: string): void {
    this.db.query('DELETE FROM repo_sessions WHERE session_id = ?').run(sessionId);
  }
}
