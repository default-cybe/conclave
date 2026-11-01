import { json, type Db } from '../storage/db';
import type { Job, JobRepo } from '../storage/repos';
import type { Scheduler } from './types';
import { logger } from '../util/log';

const log = logger('scheduler');

type Handler = (payload: Record<string, unknown>) => Promise<void>;

export interface JobSchedulerOptions {
  /** Repos (or anything with db + jobs). The db is used for atomic claims and crash recovery. */
  repos: { db: Db; jobs: JobRepo };
  /** Attempts before a job is marked failed. Default 5. */
  maxAttempts?: number;
  /** Delay before retry number `attempt` (1-based). Default 30s doubling, capped at 1h. */
  backoff?: (attempt: number) => number;
  /** Jobs run in parallel up to this many. Default 4. */
  concurrency?: number;
  /** Longest sleep between checks, so jobs added by another process and clock jumps are noticed. Default 60s. */
  maxSleepMs?: number;
  now?: () => number;
}

const MAX_TIMEOUT = 2 ** 31 - 1;
/** shortcut: finished jobs older than this go when the scheduler starts, so a hub that never restarts keeps them. */
const KEEP_FINISHED_MS = 30 * 86_400_000;
/** A scheduler beats at least every maxSleepMs (60s by default); one silent this long is gone. */
const LIVE_MS = 5 * 60_000;
const BEAT_PREFIX = 'scheduler:live:';

/**
 * Durable job runner over the jobs table. One timer is armed for the next due
 * job of a kind that has a handler; enqueue/poke/handle re-arm it. A job is
 * claimed with a conditional UPDATE so it never runs twice, even across
 * processes sharing the database. Each scheduler keeps a heartbeat row in kv;
 * jobs left 'running' are reset only while no other scheduler beats, so a
 * second live process never has its running jobs taken away (a crashed one's
 * jobs come back once its heartbeat is LIVE_MS old).
 */
export class JobScheduler implements Scheduler {
  private db: Db;
  private jobs: JobRepo;
  private handlers = new Map<string, Handler>();
  private running = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt?: number;
  private started = false;
  private ticking = false;
  private retick = false;
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly concurrency: number;
  private readonly maxSleepMs: number;
  private readonly now: () => number;
  private readonly beatKey = `${BEAT_PREFIX}${crypto.randomUUID()}`;

  constructor(opts: JobSchedulerOptions) {
    this.db = opts.repos.db;
    this.jobs = opts.repos.jobs;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoff = opts.backoff ?? ((n) => Math.min(30_000 * 2 ** (n - 1), 3_600_000));
    this.concurrency = opts.concurrency ?? 4;
    this.maxSleepMs = opts.maxSleepMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.beat();
    this.recover();
    // finished jobs are history nothing reads; without this every routine fire stays a row for good
    this.db.query(`DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND run_at < ?`).run(this.now() - KEEP_FINISHED_MS);
    this.arm();
  }

  stop(): void {
    this.started = false;
    // a clean stop: the next start (here or elsewhere) recovers at once
    try {
      this.db.query(`DELETE FROM kv WHERE key = ?`).run(this.beatKey);
    } catch {
      // the database closed first: the beat goes stale on its own
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  /** Resolves when every job that is currently executing has finished. */
  async idle(): Promise<void> {
    while (this.running.size || this.ticking) {
      await Promise.allSettled([...this.running.values()]);
      if (this.ticking) await new Promise((r) => setTimeout(r, 1));
    }
  }

  enqueue(kind: string, runAt: number, payload: Record<string, unknown> = {}, dedupeKey?: string): string {
    const job = this.jobs.enqueue(kind, runAt, payload, dedupeKey);
    this.arm();
    return job.id;
  }

  cancel(dedupeKey: string): void {
    this.jobs.cancel(dedupeKey);
    this.arm();
  }

  handle(kind: string, fn: Handler): void {
    this.handlers.set(kind, fn);
    this.arm();
  }

  poke(): void {
    this.arm();
  }

  /** Pending jobs, for diagnostics. */
  pending(kind?: string): Job[] {
    return this.jobs.pending(kind);
  }

  private beat(): void {
    this.db.query(`INSERT INTO kv (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`).run(this.beatKey, this.now());
  }

  /**
   * Jobs left 'running' by a crash go back to pending, unless another scheduler
   * on this database is alive (its jobs are running, not interrupted). If a newer
   * pending job holds the same dedupe key (a rescheduled routine), the stale one is dropped.
   * shortcut: while any other scheduler beats, a third crashed one's jobs wait; per-job owners would fix that.
   */
  private recover(): void {
    const other = this.db.query(`SELECT 1 FROM kv WHERE key LIKE ? AND key != ? AND updated_at > ? LIMIT 1`).get(`${BEAT_PREFIX}%`, this.beatKey, this.now() - LIVE_MS);
    if (other) return;
    this.db.query(`DELETE FROM kv WHERE key LIKE ? AND key != ?`).run(`${BEAT_PREFIX}%`, this.beatKey);
    const rows = this.db.query(`SELECT id, dedupe_key, attempts FROM jobs WHERE status = 'running'`).all() as Array<{ id: string; dedupe_key: string | null; attempts: number }>;
    if (!rows.length) return;
    const claimedHere = new Set(this.running.keys());
    const lost = rows.filter((r) => !claimedHere.has(r.id));
    if (!lost.length) return;
    this.db.transaction(() => {
      for (const r of lost) {
        const clash = r.dedupe_key
          ? this.db.query(`SELECT 1 FROM jobs WHERE dedupe_key = ? AND status = 'pending' AND id != ?`).get(r.dedupe_key, r.id)
          : null;
        if (clash) this.db.query(`UPDATE jobs SET status = 'cancelled', last_error = 'superseded after restart' WHERE id = ?`).run(r.id);
        else if (r.attempts >= this.maxAttempts) this.db.query(`UPDATE jobs SET status = 'failed', last_error = 'interrupted by restart' WHERE id = ?`).run(r.id);
        else this.db.query(`UPDATE jobs SET status = 'pending', last_error = 'interrupted by restart' WHERE id = ?`).run(r.id);
      }
    })();
    log.info(`recovered ${lost.length} interrupted job(s)`);
  }

  /** Earliest pending job of a kind we can run. */
  private nextDue(): number | undefined {
    if (!this.handlers.size) return undefined;
    const kinds = [...this.handlers.keys()];
    const r = this.db
      .query(`SELECT MIN(run_at) AS t FROM jobs WHERE status = 'pending' AND kind IN (${kinds.map(() => '?').join(',')})`)
      .get(...kinds) as { t: number | null } | null;
    return r?.t ?? undefined;
  }

  private arm(): void {
    if (!this.started) return;
    const next = this.nextDue();
    const now = this.now();
    const at = next === undefined ? now + this.maxSleepMs : Math.min(next, now + this.maxSleepMs);
    if (this.timer && this.timerAt !== undefined && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = undefined;
      void this.tick();
    }, Math.min(Math.max(0, at - now), MAX_TIMEOUT));
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    if (this.ticking) {
      this.retick = true;
      return;
    }
    this.ticking = true;
    try {
      // every wake beats, and picks up jobs of a scheduler that died since
      this.beat();
      this.recover();
      do {
        this.retick = false;
        for (const job of this.dueJobs()) {
          if (this.running.size >= this.concurrency) break;
          if (this.running.has(job.id)) continue;
          if (!this.claim(job.id)) continue;
          const p = this.execute({ ...job, attempts: job.attempts + 1 }).finally(() => {
            this.running.delete(job.id);
            this.arm();
          });
          this.running.set(job.id, p);
        }
      } while (this.retick && this.started);
    } catch (err) {
      log.error('tick failed', err);
    } finally {
      this.ticking = false;
      // when the pool is full the finally() above re-arms; otherwise arm now
      if (this.running.size < this.concurrency) this.arm();
    }
  }

  /** Due pending jobs of kinds that have a handler. */
  private dueJobs(): Job[] {
    const kinds = [...this.handlers.keys()];
    if (!kinds.length) return [];
    const rows = this.db
      .query(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY run_at LIMIT 50`)
      .all(this.now(), ...kinds) as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      runAt: r.run_at,
      payload: json<Record<string, unknown>>(r.payload, {}),
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error ?? undefined,
      dedupeKey: r.dedupe_key ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** pending -> running, only if nobody else got there first. */
  private claim(id: string): boolean {
    const res = this.db.query(`UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`).run(id);
    return res.changes === 1;
  }

  private async execute(job: Job): Promise<void> {
    const fn = this.handlers.get(job.kind)!;
    try {
      await fn(job.payload);
      this.db.query(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ? AND status = 'running'`).run(job.id);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (job.attempts >= this.maxAttempts) {
        log.error(`job ${job.kind} ${job.id} failed for good after ${job.attempts} attempts: ${msg}`);
        this.db.query(`UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?`).run(msg, job.id);
      } else {
        const delay = this.backoff(job.attempts);
        log.warn(`job ${job.kind} ${job.id} failed (attempt ${job.attempts}), retrying in ${Math.round(delay / 1000)}s: ${msg}`);
        this.retryLater(job, this.now() + delay, msg);
      }
    }
  }

  /** Back to pending. A newer pending job with the same dedupe key wins over the retry. */
  private retryLater(job: Job, runAt: number, error: string): void {
    if (job.dedupeKey) {
      const clash = this.db.query(`SELECT 1 FROM jobs WHERE dedupe_key = ? AND status = 'pending' AND id != ?`).get(job.dedupeKey, job.id);
      if (clash) {
        this.db.query(`UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?`).run(`${error} (superseded)`, job.id);
        return;
      }
    }
    this.jobs.reschedule(job.id, runAt, error);
  }
}
