/**
 * Canvas's run queue on the hub (docs/design/CANVAS-MODE.md 3, "Queue run"):
 * one run per file at a time. A run queued while one goes on waits here, per
 * account and per file, and the hub starts it when the last run ends, with or
 * without an app open. A file is a workflow (`workflow:<id>`) or a program
 * (`program:<sessionId>:<name>`, the session whose folder holds the flow).
 *
 * The rows live in canvas_queue, so a restart keeps what waits. A program
 * run lives in the hub's memory only (flows/service.ts), so each one going
 * is a `running` row too: a restart finds it, marks that program's last run
 * failed with the reason, and starts the next queued one. A workflow run that
 * a restart stops is the workflow service's (interrupted, resumed once).
 */
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import type { CanvasQueuedRun, CanvasQueueInput } from '../client/flows';
import type { WorkflowRun } from '../client/workflows';
import type { Db } from '../storage/db';
import { flowsOf } from '../flows/service';
import { FLOW_NAME_RE } from '../flows/lib';
import { workflowsOf } from '../workflows/attached';
import { OWNER_ID, runAs } from '../people/context';
import { ensureAccountColumn } from '../people/tables';
import { newId } from '../util/ids';
import { logger } from '../util/log';

const log = logger('canvas-queue');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS canvas_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  file TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  session_id TEXT,
  args TEXT,
  state TEXT NOT NULL,
  started_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS canvas_queue_file ON canvas_queue(account_id, file, state, created_at);
`;

/** At most this many runs wait per file. */
export const MAX_QUEUED = 10;
const MAX_ARGS_CHARS = 64 * 1024;
/** What a program run's last run says when the hub restarted under it. */
export const RESTART_ERROR = 'The hub restarted while this run was going, so it did not finish. Run it again.';
/** Workflow run states that are over (as the workflow service counts them). */
const ENDED = new Set(['done', 'failed', 'stopped', 'budget', 'interrupted']);

type Row = { id: string; account_id: string; file: string; kind: 'workflow' | 'program'; target: string; session_id: string | null; args: string | null; state: 'queued' | 'running'; started_at: number | null; created_at: number };

export const workflowFile = (id: string) => `workflow:${id}`;
export const programFile = (sessionId: string, name: string) => `program:${sessionId}:${name}`;

function dto(r: Row): CanvasQueuedRun {
  let args: Record<string, unknown> | undefined;
  try {
    args = r.args ? (JSON.parse(r.args) as Record<string, unknown>) : undefined;
  } catch {
    args = undefined;
  }
  return {
    id: r.id,
    file: r.file,
    kind: r.kind,
    ...(r.kind === 'workflow' ? { workflow: r.target } : { sessionId: r.session_id ?? '', flow: r.target }),
    ...(args ? { args } : {}),
    createdAt: r.created_at,
  };
}

export class CanvasQueue {
  private readonly db: Db;
  /** Files whose next run is being started now: a second end event must not start two. */
  private readonly starting = new Set<string>();
  /** Files an end event reached while their next run was starting: weighed again after. */
  private readonly again = new Set<string>();
  private offBus?: () => void;
  private offFlows?: () => void;

  constructor(private readonly engine: Engine) {
    this.db = engine.repos.db;
    this.db.exec(SCHEMA);
    ensureAccountColumn(this.db, 'canvas_queue');
  }

  /** Boot: program runs the last hub left are failed now, then each file's next run starts. */
  start(): void {
    const flows = flowsOf(this.engine);
    for (const r of this.db.query("SELECT * FROM canvas_queue WHERE state = 'running'").all() as Row[]) {
      if (r.session_id) flows.interrupted(r.session_id, r.target, r.id, r.started_at ?? r.created_at, RESTART_ERROR);
      this.db.query('DELETE FROM canvas_queue WHERE id = ?').run(r.id);
    }
    const onFlow = (e: { sessionId: string; name: string; view: { runId: string; startedAt: number }; ended: boolean }) => {
      const file = programFile(e.sessionId, e.name);
      if (!e.ended) {
        const acct = this.engine.getSession(e.sessionId)?.accountId ?? OWNER_ID;
        this.db
          .query("INSERT OR REPLACE INTO canvas_queue (id, account_id, file, kind, target, session_id, args, state, started_at, created_at) VALUES (?,?,?,'program',?,?,NULL,'running',?,?)")
          .run(e.view.runId, acct, file, e.name, e.sessionId, e.view.startedAt, e.view.startedAt);
        return;
      }
      // a run the shutdown ends keeps its row: the next boot reads it as cut by the restart
      if (this.engine.stopSignal.aborted) return;
      this.db.query('DELETE FROM canvas_queue WHERE id = ?').run(e.view.runId);
      void this.pump(this.engine.getSession(e.sessionId)?.accountId ?? OWNER_ID, file);
    };
    flows.watchers.add(onFlow);
    this.offFlows = () => flows.watchers.delete(onFlow);
    this.offBus = this.engine.bus.on((e) => {
      if (e.type !== 'workflow.run' || e.run.parentRunId || !ENDED.has(e.run.status)) return;
      this.onWorkflowEnd(e.run);
    });
    for (const r of this.db.query("SELECT DISTINCT account_id, file FROM canvas_queue WHERE state = 'queued'").all() as Array<{ account_id: string; file: string }>) void this.pump(r.account_id, r.file);
  }

  stop(): void {
    this.offBus?.();
    this.offFlows?.();
  }

  /** The caller's queued runs, oldest first; one file's with file. */
  list(accountId: string, file?: string): CanvasQueuedRun[] {
    const rows = file
      ? (this.db.query("SELECT * FROM canvas_queue WHERE account_id = ? AND file = ? AND state = 'queued' ORDER BY created_at, rowid").all(accountId, file) as Row[])
      : (this.db.query("SELECT * FROM canvas_queue WHERE account_id = ? AND state = 'queued' ORDER BY created_at, rowid").all(accountId) as Row[]);
    return rows.map(dto);
  }

  /**
   * Queue run. The caller checked the session is its own; a workflow the
   * caller cannot see is 404 here. When the file is not running, it starts now.
   */
  async add(accountId: string, input: CanvasQueueInput): Promise<CanvasQueuedRun> {
    let file: string;
    let row: Omit<Row, 'id' | 'state' | 'started_at' | 'created_at'>;
    if ('workflow' in input) {
      const wf = workflowsOf(this.engine);
      if (!wf) throw new EngineError(501, 'Workflows are not available on this hub.');
      // the same 404 as a missing one for a workflow the caller may not see
      await runAs(accountId, () => wf.detail(input.workflow));
      let args: string | null = null;
      if (input.args !== undefined) {
        args = JSON.stringify(input.args);
        if (args.length > MAX_ARGS_CHARS) throw new EngineError(400, `args are larger than ${MAX_ARGS_CHARS / 1024} KB of JSON`);
      }
      file = workflowFile(input.workflow);
      row = { account_id: accountId, file, kind: 'workflow', target: input.workflow, session_id: null, args };
    } else {
      if (!FLOW_NAME_RE.test(input.flow)) throw new EngineError(400, 'a flow name is lowercase letters, digits and dashes, up to 64');
      const s = this.engine.getSession(input.sessionId);
      if (!s || (s.accountId ?? OWNER_ID) !== accountId) throw new EngineError(404, `session ${input.sessionId} not found`);
      file = programFile(input.sessionId, input.flow);
      row = { account_id: accountId, file, kind: 'program', target: input.flow, session_id: input.sessionId, args: null };
    }
    const n = (this.db.query("SELECT COUNT(*) AS n FROM canvas_queue WHERE account_id = ? AND file = ? AND state = 'queued'").get(accountId, file) as { n: number }).n;
    if (n >= MAX_QUEUED) throw new EngineError(409, `${MAX_QUEUED} runs already wait for this file`);
    const id = newId('cvq');
    const now = Date.now();
    this.db
      .query("INSERT INTO canvas_queue (id, account_id, file, kind, target, session_id, args, state, started_at, created_at) VALUES (?,?,?,?,?,?,?,'queued',NULL,?)")
      .run(id, row.account_id, row.file, row.kind, row.target, row.session_id, row.args, now);
    const item = dto({ ...row, id, state: 'queued', started_at: null, created_at: now });
    await this.pump(accountId, file);
    return item;
  }

  /** Cancel one queued run of the caller's; someone else's is 404, as a missing one. */
  cancel(accountId: string, id: string): void {
    const res = this.db.query("DELETE FROM canvas_queue WHERE id = ? AND account_id = ? AND state = 'queued'").run(id, accountId);
    if (!res.changes) throw new EngineError(404, `queued run ${id} not found`);
  }

  private onWorkflowEnd(run: WorkflowRun): void {
    const acct = (run.sessionId ? this.engine.getSession(run.sessionId)?.accountId : undefined) ?? OWNER_ID;
    // the run's name is the workflow's meta name; a queued item names the workflow by id, so pump each of the account's workflow files
    const files = this.db.query("SELECT DISTINCT file FROM canvas_queue WHERE account_id = ? AND kind = 'workflow' AND state = 'queued'").all(acct) as Array<{ file: string }>;
    for (const f of files) void this.pump(acct, f.file);
  }

  /** Whether a file has a run going now. */
  private async busy(r: Row): Promise<boolean> {
    if (r.kind === 'program') {
      const st = flowsOf(this.engine).runState(r.session_id ?? '', r.target)?.status;
      return st === 'running' || st === 'approval';
    }
    const wf = workflowsOf(this.engine);
    if (!wf) return false;
    const name = (await runAs(r.account_id, () => wf.detail(r.target)).catch(() => undefined))?.name ?? r.target;
    const last = wf.store.lastRuns(r.account_id).get(name);
    return !!last && !ENDED.has(last.status);
  }

  /** Start the file's next queued run when nothing of it runs. A start that fails is dropped with a notice, and the next one is tried. */
  async pump(accountId: string, file: string): Promise<void> {
    // the shutdown interrupts runs; what waits behind them stays queued for the next boot
    if (this.engine.stopSignal.aborted) return;
    // per account: two accounts' same workflow id (a built-in) are two files, neither waits on the other
    const key = `${accountId}\0${file}`;
    if (this.starting.has(key)) return void this.again.add(key);
    this.starting.add(key);
    try {
      for (;;) {
        const next = this.db.query("SELECT * FROM canvas_queue WHERE account_id = ? AND file = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT 1").get(accountId, file) as Row | null;
        if (!next || (await this.busy(next)) || this.engine.stopSignal.aborted) return;
        try {
          await runAs(next.account_id, async () => {
            if (next.kind === 'program') {
              const s = this.engine.getSession(next.session_id ?? '');
              if (!s || (s.accountId ?? OWNER_ID) !== next.account_id) throw new EngineError(404, 'its session is gone');
              await flowsOf(this.engine).run(s.id, next.target);
            } else {
              const args = next.args ? (JSON.parse(next.args) as Record<string, unknown>) : undefined;
              await workflowsOf(this.engine)!.startRun({ name: next.target, ...(args ? { args } : {}) }, { accountId: next.account_id });
            }
          });
          return;
        } catch (err) {
          log.warn(`queued run ${next.id} of ${file} did not start`, err);
          runAs(next.account_id, () => this.engine.notice(next.kind === 'program' ? (next.session_id ?? undefined) : undefined, `A queued run of ${next.target} did not start: ${(err as Error).message}`, 'warning', 'Canvas'));
        } finally {
          // off the queue once its run exists, so a reader never sees it gone before the run it became
          this.db.query('DELETE FROM canvas_queue WHERE id = ?').run(next.id);
        }
      }
    } finally {
      this.starting.delete(key);
      if (this.again.delete(key)) void this.pump(accountId, file);
    }
  }
}

const attached = new WeakMap<object, CanvasQueue>();

export function attachCanvasQueue(engine: Engine): CanvasQueue {
  const q = new CanvasQueue(engine);
  attached.set(engine, q);
  q.start();
  return q;
}

/** The engine's Canvas queue, made (and started) on first use. */
export function canvasQueueOf(engine: Engine): CanvasQueue {
  return attached.get(engine) ?? attachCanvasQueue(engine);
}
