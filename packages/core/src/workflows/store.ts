/**
 * Workflow runs, their calls (the journal), log lines and findings. The
 * tables are made here with CREATE TABLE IF NOT EXISTS, so this module owns
 * them (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.16).
 *
 * A call's key is 'v2:' + sha256 of the canonical JSON of what decides its
 * answer (prompt, schema, model, effort, agentType, isolation, conclave),
 * and occurrence counts calls with the same key in one run. label and phase
 * are left out, so renaming a label keeps the cache.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type {
  FindingVerdict,
  WorkflowCall,
  WorkflowCallKind,
  WorkflowCallState,
  WorkflowFinding,
  WorkflowLogLine,
  WorkflowMetaDto,
  WorkflowPhaseDto,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowSource,
  WorktreeState,
} from '../client/workflows';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,
  script TEXT NOT NULL,
  script_sha TEXT NOT NULL,
  script_path TEXT,
  meta TEXT,
  args TEXT,
  session_id TEXT,
  host_session INTEGER NOT NULL DEFAULT 0,
  device TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  phase_index INTEGER NOT NULL DEFAULT -1,
  phases TEXT,
  result TEXT,
  error TEXT,
  budget TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  agent_count INTEGER NOT NULL DEFAULT 0,
  background INTEGER NOT NULL DEFAULT 0,
  unattended INTEGER NOT NULL DEFAULT 0,
  scoped INTEGER NOT NULL DEFAULT 0,
  tool_use_id TEXT,
  parent_run_id TEXT,
  resumed_from TEXT,
  auto_resumes INTEGER NOT NULL DEFAULT 0,
  resume_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS workflow_runs_created ON workflow_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_session ON workflow_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status);
CREATE TABLE IF NOT EXISTS workflow_calls (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  phase TEXT,
  agent_type TEXT,
  model TEXT,
  effort TEXT,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  parent_seq INTEGER,
  child_session_id TEXT,
  prompt TEXT,
  result TEXT,
  has_result INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  last_tool TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  worktree_path TEXT,
  worktree_branch TEXT,
  worktree_base TEXT,
  worktree_commit TEXT,
  worktree_state TEXT,
  worktree_files INTEGER,
  queued_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS workflow_calls_key ON workflow_calls(run_id, key, occurrence);
CREATE TABLE IF NOT EXISTS workflow_logs (
  run_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (run_id, n)
);
CREATE TABLE IF NOT EXISTS workflow_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  project TEXT,
  finding_key TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  title TEXT NOT NULL,
  priority TEXT,
  proven INTEGER NOT NULL DEFAULT 0,
  votes TEXT,
  verdict TEXT,
  reason TEXT,
  data TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS workflow_findings_run ON workflow_findings(run_id);
CREATE INDEX IF NOT EXISTS workflow_findings_dismissed ON workflow_findings(workflow, project, verdict);
`;

type Row = Record<string, any>;

/** JSON with sorted keys, so equal values hash the same. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The journal key of an agent() call or a host call. */
export function callKey(parts: Record<string, unknown>): string {
  return `v2:${sha256(canonicalJson(parts))}`;
}

export interface RunRow {
  id: string;
  name: string;
  description?: string;
  source: WorkflowSource;
  script: string;
  scriptSha: string;
  scriptPath?: string;
  meta?: WorkflowMetaDto;
  args?: unknown;
  sessionId?: string;
  hostSession: boolean;
  device: string;
  cwd: string;
  status: WorkflowRunStatus;
  phaseIndex: number;
  phases: WorkflowPhaseDto[];
  result?: unknown;
  error?: string;
  /** The run's limits, and what earlier attempts of this run spent (kept across resumes; not sent to clients). */
  budget?: { tokens?: number; costUsd?: number; priorTokens?: number; priorCostUsd?: number };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  agentCount: number;
  background: boolean;
  unattended: boolean;
  /**
   * The script came from an agent (the Workflow tool) or a repository: its
   * agents stay on the run's device and in its folder or its own worktrees,
   * and a worktree setup command asks like lib.exec (run.ts scopeOf).
   */
  scoped?: boolean;
  /** The Workflow tool call that started the run, so a session's live card finds its run before the call returns. */
  toolUseId?: string;
  parentRunId?: string;
  resumedFrom?: string;
  autoResumes: number;
  resumeAt?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface CallRow {
  runId: string;
  seq: number;
  key: string;
  occurrence: number;
  kind: WorkflowCallKind;
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  effort?: string;
  state: WorkflowCallState;
  attempt: number;
  parentSeq?: number;
  childSessionId?: string;
  prompt?: string;
  /** The journaled answer, present when hasResult. */
  result?: unknown;
  hasResult: boolean;
  error?: string;
  lastTool?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBase?: string;
  worktreeCommit?: string;
  worktreeState?: WorktreeState;
  worktreeFiles?: number;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

const PREVIEW = 400;

function preview(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}...` : s;
}

export function callDto(c: CallRow): WorkflowCall {
  return {
    seq: c.seq,
    kind: c.kind,
    ...(c.label ? { label: c.label } : {}),
    ...(c.phase ? { phase: c.phase } : {}),
    ...(c.agentType ? { agentType: c.agentType } : {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effort ? { effort: c.effort } : {}),
    state: c.state,
    attempt: c.attempt,
    ...(c.childSessionId ? { childSessionId: c.childSessionId } : {}),
    ...(c.parentSeq !== undefined ? { parentSeq: c.parentSeq } : {}),
    ...(c.lastTool ? { lastTool: c.lastTool } : {}),
    ...(c.prompt ? { promptPreview: preview(c.prompt) } : {}),
    ...(c.hasResult && c.result !== null && c.result !== undefined ? { resultPreview: preview(c.result) } : {}),
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    costUsd: c.costUsd,
    ...(c.worktreeBranch
      ? { worktree: { branch: c.worktreeBranch, ...(c.worktreePath ? { path: c.worktreePath } : {}), ...(c.worktreeCommit ? { commit: c.worktreeCommit } : {}), state: c.worktreeState ?? 'live', ...(c.worktreeFiles !== undefined ? { files: c.worktreeFiles } : {}) } }
      : {}),
    ...(c.error ? { error: c.error } : {}),
    ...(c.queuedAt ? { queuedAt: c.queuedAt } : {}),
    ...(c.startedAt ? { startedAt: c.startedAt } : {}),
    ...(c.finishedAt ? { finishedAt: c.finishedAt } : {}),
  };
}

function rowToRun(r: Row): RunRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    source: r.source,
    script: r.script,
    scriptSha: r.script_sha,
    scriptPath: r.script_path ?? undefined,
    meta: json<WorkflowMetaDto | undefined>(r.meta, undefined),
    args: r.args === null || r.args === undefined ? undefined : json<unknown>(r.args, undefined),
    sessionId: r.session_id ?? undefined,
    hostSession: !!r.host_session,
    device: r.device,
    cwd: r.cwd,
    status: r.status,
    phaseIndex: r.phase_index,
    phases: json<WorkflowPhaseDto[]>(r.phases, []),
    result: r.result === null || r.result === undefined ? undefined : json<unknown>(r.result, undefined),
    error: r.error ?? undefined,
    budget: json<RunRow['budget']>(r.budget, undefined),
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    agentCount: r.agent_count,
    background: !!r.background,
    unattended: !!r.unattended,
    scoped: !!r.scoped,
    toolUseId: r.tool_use_id ?? undefined,
    parentRunId: r.parent_run_id ?? undefined,
    resumedFrom: r.resumed_from ?? undefined,
    autoResumes: r.auto_resumes ?? 0,
    resumeAt: r.resume_at ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
  };
}

function rowToCall(r: Row): CallRow {
  return {
    runId: r.run_id,
    seq: r.seq,
    key: r.key,
    occurrence: r.occurrence,
    kind: r.kind,
    label: r.label ?? undefined,
    phase: r.phase ?? undefined,
    agentType: r.agent_type ?? undefined,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    state: r.state,
    attempt: r.attempt,
    parentSeq: r.parent_seq ?? undefined,
    childSessionId: r.child_session_id ?? undefined,
    prompt: r.prompt ?? undefined,
    result: r.has_result ? json<unknown>(r.result, null) : undefined,
    hasResult: !!r.has_result,
    error: r.error ?? undefined,
    lastTool: r.last_tool ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    worktreePath: r.worktree_path ?? undefined,
    worktreeBranch: r.worktree_branch ?? undefined,
    worktreeBase: r.worktree_base ?? undefined,
    worktreeCommit: r.worktree_commit ?? undefined,
    worktreeState: r.worktree_state ?? undefined,
    worktreeFiles: r.worktree_files ?? undefined,
    queuedAt: r.queued_at ?? undefined,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
  };
}

function rowToFinding(r: Row): WorkflowFinding {
  return {
    id: r.id,
    runId: r.run_id,
    workflow: r.workflow,
    ...(r.project ? { project: r.project } : {}),
    findingKey: r.finding_key,
    ...(r.file ? { file: r.file } : {}),
    ...(r.line ? { line: r.line } : {}),
    title: r.title,
    ...(r.priority ? { priority: r.priority } : {}),
    proven: !!r.proven,
    ...(r.votes ? { votes: json(r.votes, undefined) } : {}),
    ...(r.verdict ? { verdict: r.verdict as FindingVerdict } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.data ? { data: json<Record<string, unknown>>(r.data, {}) } : {}),
    createdAt: r.created_at,
    ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  };
}

export class WorkflowStore {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
    // a table made by an earlier build of this module
    const cols = new Set((db.query('PRAGMA table_info(workflow_runs)').all() as Row[]).map((r) => r.name));
    if (!cols.has('scoped')) db.exec('ALTER TABLE workflow_runs ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('tool_use_id')) db.exec('ALTER TABLE workflow_runs ADD COLUMN tool_use_id TEXT');
  }

  // ----- runs -----
  insertRun(r: RunRow): void {
    this.db
      .query(
        `INSERT INTO workflow_runs (id,name,description,source,script,script_sha,script_path,meta,args,session_id,host_session,device,cwd,status,phase_index,phases,result,error,budget,input_tokens,output_tokens,cost_usd,agent_count,background,unattended,scoped,tool_use_id,parent_run_id,resumed_from,auto_resumes,resume_at,created_at,started_at,finished_at)
         VALUES ($id,$name,$description,$source,$script,$sha,$path,$meta,$args,$session,$host,$device,$cwd,$status,$phase,$phases,$result,$error,$budget,$in,$out,$cost,$agents,$bg,$unattended,$scoped,$toolUse,$parent,$resumed,$autoResumes,$resumeAt,$created,$started,$finished)`,
      )
      .run(this.runParams(r));
  }

  updateRun(r: RunRow): void {
    this.db
      .query(
        `UPDATE workflow_runs SET name=$name,description=$description,source=$source,script=$script,script_sha=$sha,script_path=$path,meta=$meta,args=$args,session_id=$session,host_session=$host,device=$device,cwd=$cwd,status=$status,phase_index=$phase,phases=$phases,result=$result,error=$error,budget=$budget,input_tokens=$in,output_tokens=$out,cost_usd=$cost,agent_count=$agents,background=$bg,unattended=$unattended,scoped=$scoped,tool_use_id=$toolUse,parent_run_id=$parent,resumed_from=$resumed,auto_resumes=$autoResumes,resume_at=$resumeAt,created_at=$created,started_at=$started,finished_at=$finished WHERE id=$id`,
      )
      .run(this.runParams(r));
  }

  private runParams(r: RunRow) {
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      source: r.source,
      script: r.script,
      sha: r.scriptSha,
      path: r.scriptPath ?? null,
      meta: r.meta ? JSON.stringify(r.meta) : null,
      args: r.args === undefined ? null : JSON.stringify(r.args),
      session: r.sessionId ?? null,
      host: r.hostSession ? 1 : 0,
      device: r.device,
      cwd: r.cwd,
      status: r.status,
      phase: r.phaseIndex,
      phases: JSON.stringify(r.phases ?? []),
      result: r.result === undefined ? null : JSON.stringify(r.result),
      error: r.error ?? null,
      budget: r.budget ? JSON.stringify(r.budget) : null,
      in: r.inputTokens,
      out: r.outputTokens,
      cost: r.costUsd,
      agents: r.agentCount,
      bg: r.background ? 1 : 0,
      unattended: r.unattended ? 1 : 0,
      scoped: r.scoped ? 1 : 0,
      toolUse: r.toolUseId ?? null,
      parent: r.parentRunId ?? null,
      resumed: r.resumedFrom ?? null,
      autoResumes: r.autoResumes,
      resumeAt: r.resumeAt ?? null,
      created: r.createdAt,
      started: r.startedAt ?? null,
      finished: r.finishedAt ?? null,
    };
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.query('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Row | null;
    return r ? rowToRun(r) : undefined;
  }

  listRuns(q: { sessionId?: string; status?: WorkflowRunStatus; statuses?: WorkflowRunStatus[]; name?: string; limit?: number; accountId?: string } = {}): RunRow[] {
    const where: string[] = ['parent_run_id IS NULL'];
    const params: Record<string, string | number> = {};
    // a run is its host session's account's (docs/design/ACCOUNTS.md)
    if (q.accountId) (where.push('session_id IN (SELECT id FROM sessions WHERE account_id = $acct)'), (params.acct = q.accountId));
    if (q.sessionId) (where.push('session_id = $session'), (params.session = q.sessionId));
    if (q.status) (where.push('status = $status'), (params.status = q.status));
    if (q.statuses?.length) where.push(`status IN (${q.statuses.map((s) => `'${s.replace(/[^a-z_]/g, '')}'`).join(',')})`);
    if (q.name) (where.push('name = $name'), (params.name = q.name));
    params.limit = Math.min(Math.max(1, q.limit ?? 50), 500);
    return (this.db.query(`SELECT * FROM workflow_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $limit`).all(params) as Row[]).map(rowToRun);
  }

  /** The newest run per workflow name, for the library's last-run column. */
  lastRuns(accountId = 'owner'): Map<string, RunRow> {
    const mine = `session_id IN (SELECT id FROM sessions WHERE account_id = $acct)`;
    const rows = this.db
      .query(`SELECT * FROM workflow_runs w WHERE parent_run_id IS NULL AND ${mine} AND created_at = (SELECT MAX(created_at) FROM workflow_runs v WHERE v.name = w.name AND v.parent_run_id IS NULL AND v.${mine})`)
      .all({ acct: accountId } as never) as Row[];
    return new Map(rows.map((r) => [r.name as string, rowToRun(r)]));
  }

  // ----- calls -----
  insertCall(c: CallRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO workflow_calls (run_id,seq,key,occurrence,kind,label,phase,agent_type,model,effort,state,attempt,parent_seq,child_session_id,prompt,result,has_result,error,last_tool,input_tokens,output_tokens,cost_usd,worktree_path,worktree_branch,worktree_base,worktree_commit,worktree_state,worktree_files,queued_at,started_at,finished_at)
         VALUES ($run,$seq,$key,$occ,$kind,$label,$phase,$agentType,$model,$effort,$state,$attempt,$parentSeq,$child,$prompt,$result,$hasResult,$error,$lastTool,$in,$out,$cost,$wtPath,$wtBranch,$wtBase,$wtCommit,$wtState,$wtFiles,$queued,$started,$finished)`,
      )
      .run(this.callParams(c));
  }

  updateCall(c: CallRow): void {
    this.insertCall(c);
  }

  private callParams(c: CallRow) {
    return {
      run: c.runId,
      seq: c.seq,
      key: c.key,
      occ: c.occurrence,
      kind: c.kind,
      label: c.label ?? null,
      phase: c.phase ?? null,
      agentType: c.agentType ?? null,
      model: c.model ?? null,
      effort: c.effort ?? null,
      state: c.state,
      attempt: c.attempt,
      parentSeq: c.parentSeq ?? null,
      child: c.childSessionId ?? null,
      prompt: c.prompt ?? null,
      result: c.hasResult ? JSON.stringify(c.result ?? null) : null,
      hasResult: c.hasResult ? 1 : 0,
      error: c.error ?? null,
      lastTool: c.lastTool ?? null,
      in: c.inputTokens,
      out: c.outputTokens,
      cost: c.costUsd,
      wtPath: c.worktreePath ?? null,
      wtBranch: c.worktreeBranch ?? null,
      wtBase: c.worktreeBase ?? null,
      wtCommit: c.worktreeCommit ?? null,
      wtState: c.worktreeState ?? null,
      wtFiles: c.worktreeFiles ?? null,
      queued: c.queuedAt ?? null,
      started: c.startedAt ?? null,
      finished: c.finishedAt ?? null,
    };
  }

  calls(runId: string): CallRow[] {
    return (this.db.query('SELECT * FROM workflow_calls WHERE run_id = ? ORDER BY seq').all(runId) as Row[]).map(rowToCall);
  }

  getCall(runId: string, seq: number): CallRow | undefined {
    const r = this.db.query('SELECT * FROM workflow_calls WHERE run_id = ? AND seq = ?').get(runId, seq) as Row | null;
    return r ? rowToCall(r) : undefined;
  }

  deleteCalls(runId: string): void {
    this.db.query('DELETE FROM workflow_calls WHERE run_id = ?').run(runId);
  }

  /** Runs that used a child session, to find the run behind a workflow agent's session. */
  callForChild(childSessionId: string): CallRow | undefined {
    const r = this.db.query('SELECT * FROM workflow_calls WHERE child_session_id = ? ORDER BY seq DESC LIMIT 1').get(childSessionId) as Row | null;
    return r ? rowToCall(r) : undefined;
  }

  // ----- logs -----
  addLog(runId: string, n: number, ts: number, text: string): void {
    this.db.query('INSERT OR REPLACE INTO workflow_logs (run_id, n, ts, text) VALUES (?,?,?,?)').run(runId, n, ts, text);
  }

  logs(runId: string, limit = 2100): WorkflowLogLine[] {
    return (this.db.query('SELECT n, ts, text FROM workflow_logs WHERE run_id = ? ORDER BY n LIMIT ?').all(runId, limit) as Row[]).map((r) => ({ n: r.n, ts: r.ts, text: r.text }));
  }

  /** The last n log lines, oldest first. */
  lastLogs(runId: string, n: number): WorkflowLogLine[] {
    const rows = this.db.query('SELECT n, ts, text FROM workflow_logs WHERE run_id = ? ORDER BY n DESC LIMIT ?').all(runId, Math.max(0, Math.floor(n))) as Row[];
    return rows.reverse().map((r) => ({ n: r.n, ts: r.ts, text: r.text }));
  }

  logCount(runId: string): number {
    return ((this.db.query('SELECT MAX(n) AS n FROM workflow_logs WHERE run_id = ?').get(runId) as Row | null)?.n as number | null) ?? 0;
  }

  // ----- findings -----
  addFinding(f: WorkflowFinding): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO workflow_findings (id,run_id,workflow,project,finding_key,file,line,title,priority,proven,votes,verdict,reason,data,created_at,decided_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.id,
        f.runId,
        f.workflow,
        f.project ?? null,
        f.findingKey,
        f.file ?? null,
        f.line ?? null,
        f.title,
        f.priority ?? null,
        f.proven ? 1 : 0,
        f.votes === undefined ? null : JSON.stringify(f.votes),
        f.verdict ?? null,
        f.reason ?? null,
        f.data ? JSON.stringify(f.data) : null,
        f.createdAt,
        f.decidedAt ?? null,
      );
  }

  findings(runId: string): WorkflowFinding[] {
    return (this.db.query('SELECT * FROM workflow_findings WHERE run_id = ? ORDER BY priority, created_at').all(runId) as Row[]).map(rowToFinding);
  }

  /** The finding keys a run already recorded (a resumed run does not record them again). */
  findingKeys(runId: string): Set<string> {
    return new Set((this.db.query('SELECT finding_key FROM workflow_findings WHERE run_id = ?').all(runId) as Row[]).map((r) => r.finding_key as string));
  }

  getFinding(id: string): WorkflowFinding | undefined {
    const r = this.db.query('SELECT * FROM workflow_findings WHERE id = ?').get(id) as Row | null;
    return r ? rowToFinding(r) : undefined;
  }

  /** Findings the owner dismissed for a workflow and project. */
  dismissed(workflow: string, project: string | undefined, accountId = 'owner'): WorkflowFinding[] {
    // what this account dismissed only
    // a finding whose run is gone is the owner's, as everything from before accounts
    const mine = `(run_id IN (SELECT w.id FROM workflow_runs w JOIN sessions s ON s.id = w.session_id WHERE s.account_id = $acct) OR ($acct = 'owner' AND run_id NOT IN (SELECT id FROM workflow_runs)))`;
    const rows = project
      ? this.db.query(`SELECT * FROM workflow_findings WHERE workflow = $wf AND project = $project AND verdict = 'dismissed' AND ${mine} ORDER BY decided_at DESC LIMIT 500`).all({ wf: workflow, project, acct: accountId } as never)
      : this.db.query(`SELECT * FROM workflow_findings WHERE workflow = $wf AND project IS NULL AND verdict = 'dismissed' AND ${mine} ORDER BY decided_at DESC LIMIT 500`).all({ wf: workflow, acct: accountId } as never);
    return (rows as Row[]).map(rowToFinding);
  }

  setVerdict(id: string, verdict: FindingVerdict, reason: string | undefined, at: number): void {
    this.db.query('UPDATE workflow_findings SET verdict = ?, reason = ?, decided_at = ? WHERE id = ?').run(verdict, reason ?? null, at, id);
  }
}

export function runDto(r: RunRow, calls: CallRow[]): WorkflowRun {
  const counts = { agents: 0, queued: 0, running: 0, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 };
  for (const c of calls) {
    if (c.kind !== 'agent') continue;
    counts.agents++;
    counts[c.state]++;
  }
  const phaseTitle = r.phaseIndex >= 0 ? r.phases[r.phaseIndex]?.title : undefined;
  return {
    id: r.id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    source: r.source,
    status: r.status,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    device: r.device,
    cwd: r.cwd,
    phases: r.phases,
    phaseIndex: r.phaseIndex,
    ...(phaseTitle ? { phaseTitle } : {}),
    ...(r.budget && (r.budget.tokens || r.budget.costUsd) ? { budget: { ...(r.budget.tokens ? { tokens: r.budget.tokens } : {}), ...(r.budget.costUsd ? { costUsd: r.budget.costUsd } : {}) } } : {}),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    counts,
    ...(r.scriptPath ? { scriptPath: r.scriptPath } : {}),
    portable: r.meta?.runtime !== 'conclave',
    ...(r.background ? { background: true } : {}),
    ...(r.toolUseId ? { toolUseId: r.toolUseId } : {}),
    ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}),
    ...(r.resumedFrom ? { resumedFrom: r.resumedFrom } : {}),
    ...(r.resumeAt ? { resumeAt: r.resumeAt } : {}),
    ...(r.error ? { error: r.error } : {}),
    createdAt: r.createdAt,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
  };
}
