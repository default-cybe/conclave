import { OWNER_ID, currentAccount, runAs } from '../people/context';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Repos } from '../storage/repos';
import type { EventBus } from '../util/bus';
import type { Routine, RoutineRun } from '../types';
import type { RoutineInput, RoutineService, RunNowOptions, Scheduler } from './types';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import { nextRun, parseSchedule, previewRuns, previousRun, type ParsedSchedule } from './schedule';
import { ROUTINE_TEMPLATES, type RoutineTemplate } from './templates';
import { applyUpgrade, planUpgrades, templateFor, type TemplateUpgrade } from './template-upgrade';
import { cleanWatchSpec } from '../watches/spec';
import { syncWatchAllow } from '../watches/rules';

const log = logger('routines');

export const ROUTINE_JOB = 'routine.fire';
/** A run missed while the hub was down is made up only if it is at most this late. */
export const MISSED_RUN_GRACE_MS = 6 * 3_600_000;

export type RoutineRunner = (
  routine: Routine,
  run: RoutineRun,
  extra?: string,
  /** started: called once the run has its session, before the model works. context: data a built-in precheck gathered for the run. */
  hooks?: { started?: (sessionId: string) => void; context?: string },
) => Promise<{ sessionId: string; summary?: string; error?: string; denied?: RoutineRun['denied'] }>;


/**
 * Runs a routine's precheck command on its device. A built-in precheck (one
 * starting with @, run in the hub) may also say why to skip and hand the run
 * a block of data.
 */
export type PrecheckRunner = (routine: Routine, command: string) => Promise<{ output: string; exitCode: number | null; timedOut?: boolean; skipReason?: string; context?: string }>;

export interface RoutinesOptions {
  repos: Pick<Repos, 'routines' | 'jobs'> & Partial<Pick<Repos, 'devices'>>;
  bus: EventBus;
  scheduler: Scheduler;
  run: RoutineRunner;
  /** Runs Routine.precheck before scheduled and webhook runs. Without it prechecks are not run. */
  precheck?: PrecheckRunner;
  /** Agent for routines created without one. Default "assistant". */
  defaultAgent?: string;
  now?: () => number;
}

const NOTIFY = new Set<Routine['notify']>(['always', 'on_error', 'on_attention', 'never']);
const PRECHECK_KEEP = 2000;

/**
 * The status contract (ECOSYSTEM.md 5.3 item 9): a reply whose first line is
 * "STATUS: ok", "STATUS: attention" or "STATUS: problem". Markdown around the
 * word (bold, a heading, backticks) is ignored.
 */
export function parseOutcome(text: string | undefined): RoutineRun['outcome'] {
  if (!text) return undefined;
  const first = text.split('\n').find((l) => l.trim());
  const m = first?.replace(/[*_`#>]/g, '').trim().match(/^status\s*:\s*(ok|attention|problem)\b/i);
  return m ? (m[1].toLowerCase() as RoutineRun['outcome']) : undefined;
}

/** Whether a finished run should notify under the routine's notify setting. */
export function shouldNotify(notify: Routine['notify'], run: Pick<RoutineRun, 'status' | 'outcome'>): boolean {
  if (notify === 'never') return false;
  if (notify === 'always') return true;
  if (run.status === 'error') return true;
  return notify === 'on_attention' && (run.outcome === 'attention' || run.outcome === 'problem');
}

function ruleList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${field} must be a list of permission rules`);
  const out = [...new Set(v.map((x: string) => x.trim()).filter(Boolean))];
  if (out.length > 60) throw new Error(`${field} has more than 60 rules`);
  for (const r of out) if (r.length > 400) throw new Error(`A rule in ${field} is longer than 400 characters`);
  return out;
}

/**
 * Check and tidy the fields routines got in ECOSYSTEM.md 2.3. Keys that are
 * absent stay absent; null or "" clears a field on update.
 */
/** Watches browse with the hub's Chromium, which is the owner's (docs/design/ACCOUNTS.md 5). */
export const MEMBER_WATCH_REFUSED = "Watches use the hub's browser, which is the owner's on this hub.";

function checkWatch(input: Partial<RoutineInput>, accountId: string): void {
  if (accountId !== OWNER_ID && input.watch) throw new Error(MEMBER_WATCH_REFUSED);
}

function cleanExtra(input: Partial<RoutineInput>): Partial<RoutineInput> {
  const out: Record<string, unknown> = {};
  const has = (k: keyof RoutineInput) => Object.prototype.hasOwnProperty.call(input, k);
  const blank = (v: unknown) => v === null || v === '';
  if (has('notify') && input.notify !== undefined && !NOTIFY.has(input.notify)) throw new Error(`notify must be one of ${[...NOTIFY].join(', ')}`);
  for (const k of ['allow', 'deny'] as const) if (has(k)) out[k] = blank(input[k]) ? null : ruleList(input[k], k);
  if (has('onApproval')) {
    const v = input.onApproval as unknown;
    if (!blank(v) && v !== undefined && v !== 'deny' && v !== 'wait') throw new Error('onApproval must be deny or wait');
    out.onApproval = blank(v) ? null : v;
  }
  if (has('precheck') && input.precheck !== undefined) {
    const v = input.precheck as unknown;
    if (!blank(v) && typeof v !== 'string') throw new Error('precheck must be a shell command');
    const t = typeof v === 'string' ? v.trim() : '';
    if (t.length > 4000) throw new Error('precheck is longer than 4000 characters');
    out.precheck = t || null;
  }
  if (has('env')) {
    const v = input.env as unknown;
    if (blank(v)) out.env = null;
    else if (v !== undefined) {
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error('env must be an object of names and values');
      const e = Object.entries(v as Record<string, unknown>);
      if (e.length > 30) throw new Error('env has more than 30 names');
      for (const [k, val] of e) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`env name ${k} is not a valid variable name`);
        if (typeof val !== 'string') throw new Error(`env ${k} must be text`);
      }
      out.env = e.length ? Object.fromEntries(e) : null;
    }
  }
  const num = (k: 'timeoutMin' | 'maxCostUsd', max: number) => {
    if (!has(k)) return;
    const v = input[k] as unknown;
    if (blank(v) || v === undefined) {
      out[k] = blank(v) ? null : undefined;
      return;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) throw new Error(`${k} must be a number above 0 and at most ${max}`);
    out[k] = v;
  };
  num('timeoutMin', 1440);
  num('maxCostUsd', 1000);
  if (has('suggestion')) {
    const v = input.suggestion as unknown;
    if (!blank(v) && v !== undefined && (typeof v !== 'string' || v.length > 100)) throw new Error('suggestion must be a suggestion id');
    out.suggestion = blank(v) ? null : v;
  }
  if (has('template')) {
    const v = input.template as unknown;
    if (!blank(v) && v !== undefined && (typeof v !== 'string' || v.length > 100)) throw new Error('template must be a template id');
    out.template = blank(v) ? null : v;
  }
  if (has('builtin')) {
    const v = input.builtin as unknown;
    if (!blank(v) && v !== undefined && v !== 'daily-digest') throw new Error('builtin must be daily-digest');
    out.builtin = blank(v) ? null : v;
  }
  // a watch's spec (watches/spec.ts): its url, profile, fields, filters and how it notifies
  if (has('watch') && input.watch !== undefined) out.watch = blank(input.watch) ? null : cleanWatchSpec(input.watch);
  return out as Partial<RoutineInput>;
}

/** Apply cleaned extra fields: null removes the key. */
function applyExtra(r: Routine, extra: Partial<RoutineInput>): Routine {
  const next = { ...r } as Record<string, unknown>;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as unknown as Routine;
}

/** RoutineInput fields update() copies as they are; cleanExtra checks the others. */
const PLAIN_FIELDS = ['name', 'schedule', 'prompt', 'agent', 'model', 'mode', 'cwd', 'device', 'timezone', 'enabled', 'sessionPolicy', 'notify'] as const;

function jobKey(id: string): string {
  return `routine:${id}`;
}

/**
 * Routines on top of the durable scheduler. Every enabled routine owns exactly
 * one pending "routine.fire" job (dedupe key routine:<id>) at its next run time.
 * The next job is queued when a run starts, so cadence does not depend on how
 * long the run takes.
 */
export class Routines implements RoutineService {
  private repos: RoutinesOptions['repos'];
  private bus: EventBus;
  private scheduler: Scheduler;
  private runner: RoutineRunner;
  private defaultAgent: string;
  private now: () => number;
  private inflight = new Set<string>();
  private precheckRunner?: PrecheckRunner;

  constructor(opts: RoutinesOptions) {
    this.repos = opts.repos;
    this.bus = opts.bus;
    this.scheduler = opts.scheduler;
    this.runner = opts.run;
    this.precheckRunner = opts.precheck;
    this.defaultAgent = opts.defaultAgent ?? 'assistant';
    this.now = opts.now ?? Date.now;
    this.scheduler.handle(ROUTINE_JOB, (payload) => this.fire(payload));
    this.sync();
    this.upgradeTemplates();
  }

  /** Bring routines made from a template up to its current prompt, unless the owner edited the prompt (template-upgrade.ts). */
  upgradeTemplates(): TemplateUpgrade[] {
    const out = planUpgrades(this.repos.routines.list());
    for (const u of out) {
      const cur = this.repos.routines.get(u.routineId);
      if (!cur) continue;
      if (u.state === 'link') this.save({ ...cur, template: u.template.id }, false);
      if (u.state !== 'upgrade') continue;
      this.save(applyUpgrade(cur, u.template, this.now()), true);
      log.info(`routine ${cur.name} now uses the current ${u.template.name} template`);
    }
    for (const u of out) if (u.state === 'edited') log.info(`routine ${u.name} was edited, so the new ${u.template.name} template was not applied (POST /api/routines/${u.routineId}/upgrade applies it)`);
    return out;
  }

  /** Replace a routine's prompt with its template's current one, even when the owner edited it. */
  upgrade(id: string): Routine {
    const cur = this.repos.routines.get(id);
    if (!cur) throw new Error(`Routine not found: ${id}`);
    const t = templateFor(cur);
    if (!t) throw new Error(`${cur.name} was not made from a template`);
    return this.save(applyUpgrade(cur, t, this.now()), true);
  }

  /** One account's routines; every account's when left out (the scheduler, upgrades). */
  list(accountId?: string): Routine[] {
    return this.repos.routines.list(accountId);
  }

  get(id: string): Routine | undefined {
    return this.repos.routines.get(id);
  }

  runs(id: string, limit = 50): RoutineRun[] {
    return this.repos.routines.runs(id, limit);
  }

  running(): Routine[] {
    return [...this.inflight].flatMap((id) => this.repos.routines.get(id) ?? []);
  }

  preview(schedule: string, timezone?: string, count = 5): number[] {
    return previewRuns(schedule, timezone, count, this.now());
  }

  templates(): RoutineTemplate[] {
    return ROUTINE_TEMPLATES.map((t) => ({ ...t }));
  }

  /** A routine of an account (the one the work runs for when left out, else the owner's). Its device must be that account's. */
  create(input: RoutineInput, accountId?: string): Routine {
    const acct = accountId ?? currentAccount() ?? OWNER_ID;
    this.checkDevice(input.device, acct);
    checkWatch(input, acct);
    const name = input.name?.trim();
    if (!name) throw new Error('Routine name is required');
    if (!input.prompt?.trim()) throw new Error('Routine prompt is required');
    parseSchedule(input.schedule, input.timezone);
    const extra = cleanExtra(input);
    const now = this.now();
    const base: Routine = {
      id: newId('rt'),
      accountId: acct,
      name,
      schedule: input.schedule.trim(),
      timezone: input.timezone || undefined,
      agent: input.agent || this.defaultAgent,
      model: input.model || undefined,
      mode: input.mode ?? 'agent',
      prompt: input.prompt,
      cwd: input.cwd || undefined,
      device: input.device || undefined,
      enabled: input.enabled ?? true,
      sessionPolicy: input.sessionPolicy ?? 'new',
      notify: input.notify ?? 'always',
      webhookSecret: randomBytes(24).toString('base64url'),
      createdAt: now,
      updatedAt: now,
    };
    const r = applyExtra(base, extra);
    this.repos.routines.upsert(r);
    return this.reschedule(r);
  }

  update(id: string, patch: Partial<RoutineInput>): Routine {
    const cur = this.repos.routines.get(id);
    if (!cur) throw new Error(`Routine not found: ${id}`);
    if (patch.device !== undefined) this.checkDevice(patch.device, cur.accountId ?? OWNER_ID);
    checkWatch(patch, cur.accountId ?? OWNER_ID);
    const extra = cleanExtra(patch);
    // only these fields: a PATCH body with "id" would write this routine over another one
    const clean = Object.fromEntries(PLAIN_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) as Partial<RoutineInput>;
    for (const k of ['name', 'prompt'] as const) if (k in clean && (typeof clean[k] !== 'string' || !clean[k].trim())) throw new Error(`Routine ${k} is required`);
    if (clean.name) clean.name = clean.name.trim();
    const next: Routine = applyExtra({ ...cur, ...clean, updatedAt: this.now() } as Routine, extra);
    // a watch that moved to another site browses only that site (watches/rules.ts)
    if (extra.watch && next.allow) next.allow = syncWatchAllow(next.allow, extra.watch);
    if ('timezone' in clean && !clean.timezone) next.timezone = undefined;
    if (clean.schedule !== undefined) next.schedule = clean.schedule.trim();
    const timing = clean.schedule !== undefined || 'timezone' in clean || clean.enabled !== undefined;
    if (timing) parseSchedule(next.schedule, next.timezone);
    // switching away from a reused session starts fresh next time
    if (clean.sessionPolicy === 'new') next.sessionId = undefined;
    this.repos.routines.upsert(next);
    if (timing) return this.reschedule(next);
    this.bus.emit({ type: 'routine.updated', routine: next });
    return next;
  }

  remove(id: string): void {
    const r = this.repos.routines.get(id);
    this.scheduler.cancel(jobKey(id));
    this.repos.routines.delete(id);
    this.bus.emit({ type: 'routine.deleted', routineId: id, accountId: r?.accountId ?? OWNER_ID });
  }

  /** A routine runs on its account's own device, or on the hub (a member's then has no shell or files there). */
  private checkDevice(device: string | undefined, accountId: string): void {
    if (!device || device === 'local' || !this.repos.devices) return;
    if (this.repos.devices.accountOf(device) !== accountId) throw new Error(`Device ${device} not found`);
  }

  /** Make sure every enabled routine has one pending job and disabled ones have none. Runs on construction. */
  sync(): void {
    const pending = new Map(this.repos.jobs.pending(ROUTINE_JOB).map((j) => [j.dedupeKey, j]));
    const now = this.now();
    for (const r of this.repos.routines.list()) {
      const key = jobKey(r.id);
      const job = pending.get(key);
      if (!r.enabled) {
        if (job) this.scheduler.cancel(key);
        if (r.nextRunAt !== undefined) this.save({ ...r, nextRunAt: undefined }, false);
        continue;
      }
      if (job) {
        if (r.nextRunAt !== job.runAt) this.save({ ...r, nextRunAt: job.runAt }, false);
        continue;
      }
      let p: ParsedSchedule;
      try {
        p = parseSchedule(r.schedule, r.timezone);
      } catch (err) {
        log.warn(`routine ${r.name} has an invalid schedule: ${(err as Error).message}`);
        continue;
      }
      const anchor = r.lastRunAt ?? r.createdAt;
      const missed = previousRun(p, { before: now, timezone: r.timezone, anchor });
      if (missed !== undefined && missed > anchor && now - missed <= MISSED_RUN_GRACE_MS) {
        log.info(`routine ${r.name} missed a run at ${new Date(missed).toISOString()}, running it now`);
        this.scheduler.enqueue(ROUTINE_JOB, now, { routineId: r.id, scheduledAt: missed }, key);
        this.save({ ...r, nextRunAt: now }, true);
        continue;
      }
      this.reschedule(r, anchor);
    }
  }

  /** Recompute the next fire time from now and (re)place the job. */
  private reschedule(r: Routine, anchor?: number): Routine {
    const key = jobKey(r.id);
    if (!r.enabled) {
      this.scheduler.cancel(key);
      return this.save({ ...r, nextRunAt: undefined }, true);
    }
    const now = this.now();
    const p = parseSchedule(r.schedule, r.timezone);
    const at = nextRun(p, { after: now, timezone: r.timezone, anchor: p.kind === 'every' ? (anchor ?? r.lastRunAt) : undefined });
    if (at === undefined) {
      this.scheduler.cancel(key);
      return this.save({ ...r, nextRunAt: undefined }, true);
    }
    this.scheduler.enqueue(ROUTINE_JOB, at, { routineId: r.id, scheduledAt: at }, key);
    return this.save({ ...r, nextRunAt: at }, true);
  }

  private save(r: Routine, emit: boolean): Routine {
    this.repos.routines.upsert(r);
    if (emit) this.bus.emit({ type: 'routine.updated', routine: r });
    return r;
  }

  /** Job handler for routine.fire. */
  private async fire(payload: Record<string, unknown>): Promise<void> {
    const id = String(payload.routineId ?? '');
    const r = this.repos.routines.get(id);
    if (!r || !r.enabled) return;
    const now = this.now();
    const scheduledAt = typeof payload.scheduledAt === 'number' ? payload.scheduledAt : now;

    let p: ParsedSchedule;
    try {
      p = parseSchedule(r.schedule, r.timezone);
    } catch (err) {
      log.warn(`routine ${r.name} has an invalid schedule, not firing: ${(err as Error).message}`);
      return;
    }

    // queue the next run first so a slow or crashing run cannot stop the cadence
    let next: number | undefined;
    if (p.kind === 'every') next = nextRun(p, { after: now, anchor: scheduledAt });
    else next = nextRun(p, { after: Math.max(now, scheduledAt), timezone: r.timezone });
    const latest = this.repos.routines.get(id) ?? r;
    if (next === undefined) {
      // @once: done after this run
      this.save({ ...latest, nextRunAt: undefined, enabled: p.kind === 'once' ? false : latest.enabled }, true);
    } else {
      this.scheduler.enqueue(ROUTINE_JOB, next, { routineId: id, scheduledAt: next }, jobKey(id));
      this.save({ ...latest, nextRunAt: next }, true);
    }

    // the most recent occurrence we are standing in for (a late job may cover a newer missed slot)
    const effective = Math.max(scheduledAt, previousRun(p, { before: now, timezone: r.timezone, anchor: scheduledAt }) ?? scheduledAt);
    if (now - effective > MISSED_RUN_GRACE_MS) {
      const hours = Math.round((now - effective) / 3_600_000);
      log.info(`routine ${r.name} skipped: missed by ${hours}h`);
      this.recordSkipped(r, 'schedule', `Missed by ${hours}h while the hub was offline`);
      return;
    }
    await this.runNow(id, 'schedule');
  }

  private recordSkipped(r: Routine, trigger: RoutineRun['trigger'], reason: string, precheckOutput?: string): RoutineRun {
    const now = this.now();
    const run: RoutineRun = { id: newId('run'), routineId: r.id, status: 'skipped', trigger, startedAt: now, finishedAt: now, error: reason, ...(precheckOutput !== undefined ? { precheckOutput } : {}) };
    this.repos.routines.insertRun(run);
    this.bus.emit({ type: 'routine.run', run });
    return run;
  }

  /**
   * Run the precheck. The run is skipped when it prints nothing, or the same
   * text it printed before the last run that went ahead. A precheck that
   * fails or times out does not skip the run; its error goes on the run.
   */
  private async precheck(r: Routine): Promise<{ skip: boolean; output: string; reason?: string; context?: string }> {
    let res: Awaited<ReturnType<PrecheckRunner>>;
    try {
      res = await this.precheckRunner!(r, r.precheck!);
    } catch (err) {
      return { skip: false, output: `precheck failed: ${(err as Error)?.message ?? String(err)}`.slice(0, PRECHECK_KEEP) };
    }
    const output = (res.output ?? '').trim().slice(0, PRECHECK_KEEP);
    if (res.skipReason) return { skip: true, output, reason: res.skipReason };
    if (res.context && output) {
      const last = this.repos.routines.runs(r.id, 50).find((x) => (x.status === 'ok' || x.status === 'error') && x.precheckOutput !== undefined);
      return { skip: last?.precheckOutput === output, output, context: res.context };
    }
    if (res.timedOut) return { skip: false, output: `precheck timed out${output ? `: ${output}` : ''}`.slice(0, PRECHECK_KEEP) };
    if (res.exitCode !== 0 && res.exitCode !== null) return { skip: false, output: `precheck exited ${res.exitCode}${output ? `: ${output}` : ''}`.slice(0, PRECHECK_KEEP) };
    if (!output) return { skip: true, output };
    const last = this.repos.routines.runs(r.id, 50).find((x) => (x.status === 'ok' || x.status === 'error') && x.precheckOutput !== undefined);
    return { skip: last?.precheckOutput === output, output };
  }

  async runNow(id: string, trigger: RoutineRun['trigger'] = 'manual', extra?: string, opts: RunNowOptions = {}): Promise<RoutineRun> {
    const r = this.repos.routines.get(id);
    if (!r) throw new Error(`Routine not found: ${id}`);
    // a run, its precheck and its session are the routine's account's work, wherever it was started from
    return runAs(r.accountId ?? OWNER_ID, () => this.runFor(r, id, trigger, extra, opts));
  }

  private async runFor(r: Routine, id: string, trigger: RoutineRun['trigger'], extra: string | undefined, opts: RunNowOptions): Promise<RoutineRun> {
    let told = false;
    const start = (run: RoutineRun) => {
      if (told) return;
      told = true;
      opts.onStart?.({ ...run });
    };
    const done = (run: RoutineRun) => {
      start(run);
      return run;
    };
    if (this.inflight.has(id)) return done(this.recordSkipped(r, trigger, 'Previous run is still going'));

    this.inflight.add(id);
    try {
      // the owner pressed Run now: skip the precheck and run the model
      let precheckOutput: string | undefined;
      let context: string | undefined;
      if (r.precheck && trigger !== 'manual' && this.precheckRunner) {
        const pre = await this.precheck(r);
        if (pre.skip) {
          const skipped = this.recordSkipped(r, trigger, pre.reason ?? 'Nothing new since the last run', pre.output);
          const latest = this.repos.routines.get(id);
          if (latest) this.save({ ...latest, lastRunAt: skipped.startedAt, updatedAt: this.now() }, true);
          return done(skipped);
        }
        precheckOutput = pre.output;
        context = pre.context;
      }
      // Run now skips a built-in precheck's test but still hands the run its data
      if (r.precheck?.startsWith('@') && trigger === 'manual' && this.precheckRunner) {
        const res = await this.precheckRunner(r, r.precheck).catch(() => undefined);
        context = res?.context;
      }
      return done(await this.execute(r, trigger, extra, precheckOutput, start, context));
    } finally {
      this.inflight.delete(id);
    }
  }

  private async execute(
    r: Routine,
    trigger: RoutineRun['trigger'],
    extra: string | undefined,
    precheckOutput: string | undefined,
    onStart: (run: RoutineRun) => void,
    context?: string,
  ): Promise<RoutineRun> {
    const id = r.id;
    const run: RoutineRun = { id: newId('run'), routineId: id, status: 'running', trigger, startedAt: this.now(), ...(precheckOutput !== undefined ? { precheckOutput } : {}) };
    this.repos.routines.insertRun(run);
    this.bus.emit({ type: 'routine.run', run: { ...run } });

    // the run links to its session while it is still going
    const started = (sessionId: string) => {
      if (run.status !== 'running' || run.sessionId || !sessionId) return;
      run.sessionId = sessionId;
      this.repos.routines.updateRun(run);
      this.bus.emit({ type: 'routine.run', run: { ...run } });
      onStart(run);
    };

    let res: { sessionId?: string; summary?: string; error?: string; denied?: RoutineRun['denied'] };
    try {
      res = await this.runner(r, run, extra, { started, ...(context ? { context } : {}) });
    } catch (err) {
      res = { error: (err as Error)?.message ?? String(err) };
    }
    run.sessionId = res.sessionId || run.sessionId;
    run.summary = res.summary;
    run.error = res.error;
    run.status = res.error ? 'error' : 'ok';
    const outcome = parseOutcome(res.summary);
    if (outcome) run.outcome = outcome;
    if (res.denied?.length) run.denied = res.denied.slice(0, 50);
    run.finishedAt = this.now();
    this.repos.routines.updateRun(run);
    this.bus.emit({ type: 'routine.run', run: { ...run } });

    const latest = this.repos.routines.get(id);
    if (latest) {
      const updated: Routine = { ...latest, lastRunAt: run.startedAt, updatedAt: this.now() };
      if (latest.sessionPolicy === 'reuse' && run.sessionId) updated.sessionId = run.sessionId;
      this.save(updated, true);
    }
    return run;
  }

  /** Check a webhook secret in constant time. */
  verifyWebhook(id: string, secret: string): boolean {
    const r = this.repos.routines.get(id);
    if (!r?.webhookSecret || !secret) return false;
    const a = Buffer.from(r.webhookSecret);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Replace the webhook secret (old webhook URLs stop working). */
  rotateWebhookSecret(id: string): Routine {
    const r = this.repos.routines.get(id);
    if (!r) throw new Error(`Routine not found: ${id}`);
    return this.save({ ...r, webhookSecret: randomBytes(24).toString('base64url'), updatedAt: this.now() }, true);
  }
}
