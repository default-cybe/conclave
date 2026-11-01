/**
 * The life assistant in the hub (docs/design/ROUND-LIFE-ASSISTANT.md): goals,
 * proactive preferences, day plans, Home's Today, Settings > Assistant, and
 * the built-in prechecks of the heartbeat and the nightly reflection.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { KvRepo, Repos } from '../storage/repos';
import type { MemoryEntry, Message, Routine, RoutineRun, Task } from '../types';
import type { MemoryService } from '../memory/types';
import type { ExternalMemory } from '../memory/external';
import type { RoutineService } from '../scheduler/types';
import { ROUTINE_TEMPLATES } from '../scheduler/templates';
import { templateFor } from '../scheduler/template-upgrade';
import { redactSecrets } from '../memory/secrets';
import { isUntrusted } from '../session/untrusted';
import { logger } from '../util/log';
import { GoalService, type GoalMemoryPort } from './goals';
import { ASSISTANT_AGENT, PrefsService } from './prefs';
import { buildDay, renderDay, type DayReport } from './day';
import { addDays, atLocal, cronHours, dayRange, daysBetween, insideHours, localDate, localHhmm, localLong } from './time';
import { QUIET_JOB } from './quiet';
import { OWNER_ID } from '../people/context';
import type { AssistantRoutineDto, AssistantSettingsDto, DayPlan, DayPlanItem, PrefsPatch, ProactivePrefs, ReflectDto, ReflectNowDto, ReflectPatch, ReflectRunDto, TodayDto, TodayGoal } from './types';

const log = logger('assistant');

const PLAN_PREFIX = 'assistant.plan.';
const PLAN_KEEP_DAYS = 14;
/** Tag on the notes the nightly reflection keeps. */
export const REFLECTION_TAG = 'reflection';
/** Agents whose chats the reflection reads. */
const REFLECT_AGENTS = new Set(['assistant', 'chat']);

export class AssistantError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the assistant needs from the engine, as closures so tests can fake it. */
export interface AssistantHost {
  db: Db;
  kv: KvRepo;
  repos: Pick<Repos, 'tasks' | 'messages' | 'routines' | 'jobs'>;
  memory: MemoryService & Partial<GoalMemoryPort> & { external?: ExternalMemory };
  routines: RoutineService;
  /** Create a task on the board (emits task.updated). */
  createTask(input: { title: string; description?: string; due?: number; labels?: string[] }): Task;
  /** Send a message into a session (the plan question's answer). */
  send?(sessionId: string, text: string): Promise<void>;
  /** True for an agent marked untrusted (it reads email or web pages): its sessions never feed the reflection or a goal entry. */
  untrustedAgent?(name: string, cwd?: string): boolean;
  now?: () => number;
  hubZone?: () => string;
  /** Whose assistant (docs/design/ACCOUNTS.md). Sessions it reads are this account's. Default: the owner's. */
  accountId?: string;
}

export class AssistantService {
  readonly goals: GoalService;
  readonly prefs: PrefsService;
  private host: AssistantHost;
  private now: () => number;

  constructor(host: AssistantHost) {
    this.host = host;
    this.now = host.now ?? Date.now;
    this.prefs = new PrefsService({ kv: host.kv, memory: host.memory, now: this.now, hubZone: host.hubZone });
    const memory = host.memory;
    this.goals = new GoalService({
      db: host.db,
      memory: typeof memory.upsertImported === 'function' ? { upsertImported: (s, items, o) => memory.upsertImported!(s, items, o) } : undefined,
      external: () => memory.external,
      tasks: { get: (id) => host.repos.tasks.get(id), create: (input) => host.createTask(input) },
      timezone: () => this.zone(),
      now: this.now,
      accountId: host.accountId,
    });
  }

  /** Bring derived state in line on hub start: the goal memories and the preferences memory. */
  async start(): Promise<void> {
    await this.goals.project();
    await this.prefs.ensureMemory().catch((err) => log.warn(`preferences memory: ${(err as Error).message}`));
  }

  zone(): string {
    return this.prefs.timezone().zone;
  }

  task(id: string): Task | undefined {
    return this.host.repos.tasks.get(id);
  }

  /** A due time in the owner's zone from "2026-10-24" (end of that day) or "2026-10-24T09:00". */
  dueAt(v: string | undefined): number | undefined {
    if (!v) return undefined;
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(v.trim());
    if (!m) return undefined;
    const t = atLocal(m[1], m[2] ?? '23:59', this.zone());
    return Number.isFinite(t) ? t : undefined;
  }

  today(): string {
    return localDate(this.now(), this.zone());
  }

  // -------------------------------------------------------------------------
  // day plans
  // -------------------------------------------------------------------------

  plan(date: string): DayPlan | undefined {
    return this.host.kv.get<DayPlan | null>(PLAN_PREFIX + date, null) ?? undefined;
  }

  /** Save today's plan. Checks the shape; keeps the last two weeks. */
  savePlan(input: { summary?: unknown; items?: unknown; focus?: unknown; question?: unknown; date?: unknown }, sessionId?: string): DayPlan {
    const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : this.today();
    const text = (v: unknown, max: number) => (typeof v === 'string' ? redactSecrets(v.replace(/\s+/g, ' ').trim()).slice(0, max) : '');
    const hhmm = (v: unknown) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : undefined);
    const summary = text(input.summary, 300);
    if (!summary) throw new AssistantError(400, 'A plan needs a one sentence summary.');
    if (input.items !== undefined && !Array.isArray(input.items)) throw new AssistantError(400, 'items must be a list.');
    const kinds = new Set(['event', 'task', 'goal', 'focus', 'reminder']);
    const items: DayPlanItem[] = ((input.items as unknown[]) ?? [])
      .slice(0, 20)
      .map((raw) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { text: raw }))
      .map((i) => ({ text: text(i.text, 200), ...(hhmm(i.time) ? { time: hhmm(i.time) } : {}), ...(typeof i.kind === 'string' && kinds.has(i.kind) ? { kind: i.kind as DayPlanItem['kind'] } : {}), ...(typeof i.ref === 'string' && i.ref ? { ref: i.ref.slice(0, 60) } : {}) }))
      .filter((i) => i.text)
      .sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'));
    const plan: DayPlan = { date, summary, items, savedAt: this.now(), ...(sessionId ? { sessionId } : {}) };
    const f = input.focus as Record<string, unknown> | undefined;
    if (f && typeof f === 'object' && text(f.text, 200) && hhmm(f.start) && hhmm(f.end)) {
      plan.focus = { text: text(f.text, 200), start: hhmm(f.start)!, end: hhmm(f.end)!, ...(typeof f.goalId === 'string' && f.goalId ? { goalId: f.goalId } : {}) };
    }
    const q = input.question as Record<string, unknown> | undefined;
    if (q && typeof q === 'object' && text(q.text, 200)) {
      const options = Array.isArray(q.options) ? q.options.map((o) => text(o, 60)).filter(Boolean).slice(0, 3) : [];
      if (options.length < 2) throw new AssistantError(400, 'A plan question needs two or three short options, so the owner can tap one.');
      plan.question = { text: text(q.text, 200), options };
    }
    this.host.kv.set(PLAN_PREFIX + date, plan);
    // keep two weeks
    const old = addDays(date, -PLAN_KEEP_DAYS);
    for (let i = 0; i < 7; i++) this.host.kv.delete(PLAN_PREFIX + addDays(old, -i));
    return plan;
  }

  /** The owner's day (or days), as data and as text for a model. */
  day(opts: { date?: string; days?: number } = {}): DayReport {
    const tz = this.zone();
    const report = buildDay(
      {
        db: this.host.db,
        accountId: this.host.accountId ?? OWNER_ID,
        tasks: this.host.repos.tasks.list(),
        goals: this.goals.all(),
        entries: (from, to) => this.goals.entriesBetween(from, to),
        routines: this.host.routines.list(),
        runs: (id) => this.host.repos.routines.runs(id, 400),
        plan: (d) => this.plan(d),
        prefs: this.prefs.get(),
        timezone: tz,
        now: this.now(),
      },
      opts,
    );
    // a session of an untrusted agent keeps only that it happened: its title and summary come from mail or web pages
    const host = this.host;
    report.sessions = report.sessions.map(({ summary, ...s }) => (s.untrusted || host.untrustedAgent?.(s.agent, s.cwd) ? { ...s, title: '', untrusted: true } : { ...s, ...(summary ? { summary } : {}) }));
    return report;
  }

  dayText(opts: { date?: string; days?: number } = {}): string {
    return renderDay(this.day(opts));
  }

  // -------------------------------------------------------------------------
  // routines the assistant owns
  // -------------------------------------------------------------------------

  routineFor(template: string): Routine | undefined {
    const list = this.host.routines.list();
    return list.find((r) => r.template === template) ?? list.find((r) => !r.template && !r.suggestion && templateFor(r)?.id === template);
  }

  private template(id: string) {
    const t = ROUTINE_TEMPLATES.find((x) => x.id === id);
    if (!t) throw new AssistantError(500, `The ${id} template is missing from this hub.`);
    return t;
  }

  /** Heartbeat schedule for the message hours: every 30 minutes inside them. */
  heartbeatSchedule(p: ProactivePrefs = this.prefs.get()): string {
    return `*/30 ${cronHours(p.hours)} * * *`;
  }

  private ensureRoutine(id: 'heartbeat' | 'nightly-reflection', enabled: boolean): Routine | undefined {
    const cur = this.routineFor(id);
    if (cur) return cur.enabled === enabled ? cur : this.host.routines.update(cur.id, { enabled });
    if (!enabled) return undefined;
    const { id: _id, description: _d, ...input } = this.template(id);
    return this.host.routines.create({ ...input, template: id, enabled: true, timezone: this.zone(), ...(id === 'heartbeat' ? { schedule: this.heartbeatSchedule() } : {}) });
  }

  async setHeartbeat(input: { enabled?: unknown; checklist?: unknown }): Promise<AssistantSettingsDto> {
    if (input.checklist !== undefined) {
      if (typeof input.checklist !== 'string') throw new AssistantError(400, 'checklist must be text, one check per line.');
      await this.prefs.setChecklist(input.checklist);
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new AssistantError(400, 'enabled must be true or false.');
      if (input.enabled && !this.prefs.checklist().id) await this.prefs.setChecklist(this.prefs.checklist().text);
      this.ensureRoutine('heartbeat', input.enabled);
    }
    return this.settings();
  }

  /**
   * The nightly reflection's switch, time and model. Settings > Assistant and
   * Settings > Reflect both come here, so they are one setting: the routine.
   * A time or model set while it is off makes the routine, paused.
   */
  setReflection(input: { enabled?: unknown; time?: unknown; model?: unknown }): AssistantSettingsDto {
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AssistantError(400, 'enabled must be true or false.');
    let schedule: string | undefined;
    if (input.time !== undefined) {
      const m = typeof input.time === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.time.trim()) : null;
      if (!m) throw new AssistantError(400, 'time must be HH:MM, such as 02:40.');
      schedule = `${Number(m[2])} ${Number(m[1])} * * *`;
    }
    let model: string | undefined;
    if (input.model !== undefined) {
      if (typeof input.model !== 'string' || input.model.length > 200 || (input.model.trim() && !/^[\w.:@/[\]-]+$/.test(input.model.trim()))) throw new AssistantError(400, 'model must be a model such as anthropic/claude-haiku-5-5, fast for the small model, or empty for the default model.');
      model = input.model.trim();
    }
    if (input.enabled !== undefined) this.ensureRoutine('nightly-reflection', input.enabled as boolean);
    if (schedule !== undefined || model !== undefined) {
      const r = this.reflectionRoutine();
      const patch: Partial<Pick<Routine, 'schedule' | 'model' | 'timezone'>> = {};
      if (schedule !== undefined && (schedule !== r.schedule || !r.timezone)) Object.assign(patch, { schedule, timezone: r.timezone ?? this.zone() });
      // "" is the default model (an empty model on a routine means the agent's or the hub's default)
      if (model !== undefined && model !== (r.model ?? '')) patch.model = model;
      if (Object.keys(patch).length) this.host.routines.update(r.id, patch);
    }
    return this.settings();
  }

  /** The reflection's routine; made paused when it is not there yet (a time, a model, or Reflect now with the switch off). */
  private reflectionRoutine(): Routine {
    const cur = this.routineFor('nightly-reflection');
    if (cur) return cur;
    const { id: _id, description: _d, ...input } = this.template('nightly-reflection');
    return this.host.routines.create({ ...input, template: 'nightly-reflection', enabled: false, timezone: this.zone() });
  }

  /** Settings > Reflect: the switch, the time, the model, the last run in words and the notes. */
  reflect(): ReflectDto {
    const r = this.routineFor('nightly-reflection');
    const t = this.template('nightly-reflection');
    const schedule = r?.schedule ?? t.schedule;
    const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule.trim());
    const time = m && Number(m[2]) < 24 && Number(m[1]) < 60 ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : undefined;
    const model = r ? r.model : t.model;
    const last = r ? this.host.repos.routines.runs(r.id, 1)[0] : undefined;
    return {
      enabled: !!r?.enabled,
      ...(time ? { time } : {}),
      schedule,
      timezone: r?.timezone ?? this.zone(),
      ...(model ? { model } : {}),
      ...(r ? { routineId: r.id } : {}),
      ...(r?.enabled && r.nextRunAt ? { nextRunAt: r.nextRunAt } : {}),
      ...(last ? { last: this.reflectRun(last) } : {}),
      notes: this.reflectionNotes().sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  /** A run in Reflect's words: how many notes it saved and retired, from the calls in its session that went through. */
  reflectRun(run: RoutineRun): ReflectRunDto {
    let saved = 0;
    let retired = 0;
    if (run.sessionId) {
      const msgs = this.host.repos.messages.list(run.sessionId);
      const ok = new Set<string>();
      for (const m of msgs) for (const b of m.content) if (b.type === 'tool_result' && !b.isError) ok.add(b.toolUseId);
      for (const m of msgs) {
        if (m.role !== 'assistant') continue;
        for (const b of m.content) {
          if (b.type !== 'tool_use' || !ok.has(b.id)) continue;
          if (b.name === 'MemorySave') saved++;
          else if (b.name === 'MemoryForget') retired++;
        }
      }
    }
    const reason = run.status === 'skipped' || run.status === 'error' ? run.error : undefined;
    return {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      saved,
      retired,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Reflect now: one reflection with the night's rules (the same digest of
   * owner and assistant text, untrusted chats left out, the same tools).
   * Nothing to read: no model call. Returns once the run started, or when it
   * finished with wait.
   */
  async reflectNow(opts: { wait?: boolean } = {}): Promise<ReflectNowDto> {
    const r = this.reflectionRoutine();
    const pre = this.reflectionCheck(r);
    if (pre.skipReason) return { skipped: pre.skipReason, reflect: this.reflect() };
    const run = await new Promise<RoutineRun>((resolve, reject) => {
      this.host.routines.runNow(r.id, 'manual', undefined, opts.wait ? {} : { onStart: resolve }).then(resolve, reject);
    });
    return { run: this.reflectRun(run), reflect: this.reflect() };
  }

  /** Save preferences; the heartbeat follows new hours and zone when its schedule is still the one it was made with. */
  async setPrefs(patch: PrefsPatch): Promise<AssistantSettingsDto> {
    const before = this.prefs.get();
    const beforeZone = this.zone();
    const next = await this.prefs.set(patch);
    const hb = this.routineFor('heartbeat');
    if (hb && (hb.schedule === this.heartbeatSchedule(before) || hb.schedule === this.template('heartbeat').schedule)) {
      const zone = this.zone();
      const schedule = this.heartbeatSchedule(next);
      if (schedule !== hb.schedule || (hb.timezone ?? beforeZone) !== zone) this.host.routines.update(hb.id, { schedule, timezone: zone });
    }
    return this.settings();
  }

  private routineDto(template: 'heartbeat' | 'nightly-reflection'): AssistantRoutineDto {
    const r = this.routineFor(template);
    const base: AssistantRoutineDto = { template, enabled: !!r?.enabled, today: { ran: 0, skipped: 0 } };
    if (template === 'heartbeat') {
      const c = this.prefs.checklist();
      base.checklist = c.text;
      if (c.id) base.checklistId = c.id;
    }
    if (!r) return { ...base, schedule: template === 'heartbeat' ? this.heartbeatSchedule() : this.template(template).schedule, model: this.template(template).model };
    const { start } = dayRange(this.today(), this.zone());
    const runs = this.host.repos.routines.runs(r.id, 100);
    const today = runs.filter((x) => x.startedAt >= start);
    return {
      ...base,
      routineId: r.id,
      schedule: r.schedule,
      ...(r.timezone ? { timezone: r.timezone } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.nextRunAt ? { nextRunAt: r.nextRunAt } : {}),
      ...(runs[0] ? { lastRun: runs[0] } : {}),
      today: { ran: today.filter((x) => x.status !== 'skipped').length, skipped: today.filter((x) => x.status === 'skipped').length },
    };
  }

  settings(): AssistantSettingsDto {
    const q = this.prefs.quiet(this.now());
    return {
      prefs: this.prefs.get(),
      timezone: this.prefs.timezone(),
      quiet: { now: q.now, ...(q.until ? { until: q.until } : {}) },
      waiting: this.waiting(),
      heartbeat: this.routineDto('heartbeat'),
      reflection: this.routineDto('nightly-reflection'),
    };
  }

  waiting(): number {
    try {
      return this.host.repos.jobs.pending(QUIET_JOB).length;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Home > Today
  // -------------------------------------------------------------------------

  todayDto(): TodayDto {
    const tz = this.zone();
    const date = this.today();
    const { start, end } = dayRange(date, tz);
    const planRoutine = this.routineFor('morning-brief');
    const lastRun = planRoutine ? this.host.repos.routines.runs(planRoutine.id, 10).find((r) => r.startedAt >= start && r.status !== 'skipped') : undefined;
    const tasks = this.host.repos.tasks.list().filter((t) => t.status !== 'done' && t.due !== undefined);
    const goals: TodayGoal[] = this.goals
      .all()
      .filter((g) => g.status === 'active' && (g.nextStep || g.targetDate))
      .sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999') || b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .map((g) => ({ id: g.id, title: g.title, area: g.area, ...(g.nextStep ? { nextStep: g.nextStep } : {}), ...(g.targetDate ? { targetDate: g.targetDate, daysLeft: daysBetween(date, g.targetDate) } : {}) }));
    const plan = this.plan(date);
    return {
      date,
      timezone: tz,
      ...(plan ? { plan } : {}),
      ...(lastRun ? { run: { id: lastRun.id, routineId: lastRun.routineId, status: lastRun.status, startedAt: lastRun.startedAt, ...(lastRun.finishedAt ? { finishedAt: lastRun.finishedAt } : {}), ...(lastRun.sessionId ? { sessionId: lastRun.sessionId } : {}), ...(lastRun.summary ? { summary: lastRun.summary } : {}), ...(lastRun.error ? { error: lastRun.error } : {}) } } : {}),
      ...(planRoutine ? { planRoutine: { id: planRoutine.id, enabled: planRoutine.enabled, ...(planRoutine.nextRunAt ? { nextRunAt: planRoutine.nextRunAt } : {}) } } : {}),
      goals,
      tasks: { dueToday: tasks.filter((t) => t.due! >= start && t.due! < end).length, overdue: tasks.filter((t) => t.due! < start).length },
    };
  }

  /** The owner tapped an option of the plan's question: note it and tell the plan's session. */
  async answerToday(option: unknown): Promise<{ plan: DayPlan; sessionId?: string }> {
    const date = this.today();
    const plan = this.plan(date);
    if (!plan?.question) throw new AssistantError(404, 'Today\'s plan has no question to answer.');
    if (typeof option !== 'string' || !plan.question.options.includes(option)) throw new AssistantError(400, `Pick one of: ${plan.question.options.join(', ')}.`);
    const next: DayPlan = { ...plan, question: { ...plan.question, answer: option } };
    this.host.kv.set(PLAN_PREFIX + date, next);
    if (plan.sessionId && this.host.send) {
      await this.host.send(plan.sessionId, `About today's plan, you asked: "${plan.question.text}" My answer: ${option}. If it changes the plan, update it and save it again with DayPlan. Reply in one or two lines.`);
      return { plan: next, sessionId: plan.sessionId };
    }
    return { plan: next };
  }

  // -------------------------------------------------------------------------
  // built-in prechecks
  // -------------------------------------------------------------------------

  /** Run a built-in precheck (@heartbeat, @reflection). */
  async precheck(routine: Routine, command: string): Promise<{ output: string; exitCode: number; skipReason?: string; context?: string }> {
    const name = command.trim().split(/\s+/)[0];
    if (name === '@heartbeat') return this.heartbeatCheck(routine);
    if (name === '@reflection') return this.reflectionCheck(routine);
    return { output: `unknown built-in precheck ${name}. Use @heartbeat or @reflection.`, exitCode: 1 };
  }

  /**
   * The heartbeat's digest: the local date, the checklist, open tasks overdue
   * or due within 2 hours, and active goals at or past their target date. The
   * same digest as the last run that went ahead means nothing changed.
   */
  heartbeatCheck(routine: Routine): { output: string; exitCode: number; skipReason?: string; context: string } {
    const now = this.now();
    const tz = this.zone();
    const prefs = this.prefs.get();
    const date = localDate(now, tz);
    const checklist = this.prefs.checklist().text.trim();
    const soon = this.host.repos.tasks
      .list()
      .filter((t) => t.status !== 'done' && t.due !== undefined && t.due <= now + 2 * 3_600_000)
      .sort((a, b) => a.due! - b.due!);
    const tomorrow = addDays(date, 1);
    const goals = this.goals.all().filter((g) => g.status === 'active' && g.targetDate && g.targetDate <= tomorrow);
    const digest = [
      `day ${date}`,
      `checklist ${createHash('sha256').update(checklist).digest('hex').slice(0, 12)}`,
      ...soon.map((t) => `task ${t.id} ${t.status} ${t.due! < now ? 'overdue' : 'soon'}`),
      ...goals.map((g) => `goal ${g.id} ${g.targetDate}`),
    ].join('\n');
    const runs = this.host.repos.routines.runs(routine.id, 50);
    const last = runs.find((r) => r.status === 'ok' || r.status === 'error');
    const when = (ts: number) => (localDate(ts, tz) === date ? localHhmm(ts, tz) : `${localDate(ts, tz)} ${localHhmm(ts, tz)}`);
    const context = [
      `Local time: ${localLong(now, tz)} (${tz}). Message hours ${prefs.hours.start} to ${prefs.hours.end}.`,
      '',
      'Checklist:',
      checklist || '(empty)',
      '',
      'Tasks overdue or due within 2 hours:',
      ...(soon.length ? soon.map((t) => `- ${t.title} [${t.id}] ${t.status}, due ${when(t.due!)}${t.due! < now ? ' (overdue)' : ''}`) : ['- None.']),
      '',
      'Active goals at or past their target date:',
      ...(goals.length ? goals.map((g) => `- ${g.title} [${g.id}] target ${g.targetDate}${g.nextStep ? `, next: ${g.nextStep}` : ''}`) : ['- None.']),
      '',
      last ? `The last heartbeat that ran was at ${when(last.startedAt)} and replied: ${(last.summary ?? last.error ?? '').replace(/\s+/g, ' ').slice(0, 400) || '(nothing)'}` : 'This is the first heartbeat that runs.',
    ].join('\n');
    if (!insideHours(now, prefs.hours, tz)) return { output: digest, exitCode: 0, skipReason: 'Outside message hours', context };
    if (!checklist) return { output: digest, exitCode: 0, skipReason: 'The checklist is empty', context };
    return { output: digest, exitCode: 0, context };
  }

  /**
   * The reflection's digest: chats and assistant sessions with owner messages
   * since the last reflection. Context: owner and assistant text only, never
   * tool results, plus the current reflection notes with their ids.
   */
  reflectionCheck(routine: Routine): { output: string; exitCode: number; skipReason?: string; context: string } {
    const now = this.now();
    const runs = this.host.repos.routines.runs(routine.id, 50);
    const lastOk = runs.find((r) => r.status === 'ok');
    const since = Math.max(lastOk?.startedAt ?? 0, now - 36 * 3_600_000);
    const rows = this.host.db
      .query(`SELECT id, title, agent, kind, cwd, meta FROM sessions WHERE account_id = ? AND updated_at >= ? AND archived = 0 AND parent_id IS NULL AND routine_id IS NULL ORDER BY updated_at DESC LIMIT 40`)
      .all(this.host.accountId ?? OWNER_ID, since) as Array<{ id: string; title: string; agent: string; kind: string | null; cwd: string | null; meta: string | null }>;
    const picked: Array<{ id: string; title: string; kind: string; lines: string[]; lastSeq: number }> = [];
    for (const s of rows) {
      if (!(REFLECT_AGENTS.has(s.agent) || s.kind === 'chat')) continue;
      // a chat with an untrusted agent, or a session marked untrusted: its replies relay mail, web pages or a webhook
      if (this.host.untrustedAgent?.(s.agent, s.cwd ?? undefined) || isUntrusted({ meta: json<Record<string, unknown>>(s.meta, {}) })) continue;
      const msgs = this.host.repos.messages.list(s.id).filter((m) => m.createdAt >= since);
      const owner = msgs.filter(isOwnerMessage);
      if (!owner.length) continue;
      const lines: string[] = [];
      for (const m of msgs) {
        if (m.kind !== 'normal') continue;
        if (m.role === 'user' && !isOwnerMessage(m)) continue;
        const t = messageText(m);
        if (!t) continue;
        lines.push(`${m.role === 'user' ? 'Owner' : 'Assistant'}: ${clip(t, m.role === 'user' ? 600 : 400)}`);
      }
      picked.push({ id: s.id, title: s.title, kind: s.kind === 'chat' ? 'Chat' : 'Session', lines, lastSeq: Math.max(...owner.map((m) => m.seq)) });
      if (picked.length >= 8) break;
    }
    const digest = picked.map((p) => `session ${p.id} ${p.lastSeq}`).sort().join('\n');
    const notes = this.reflectionNotes();
    let budget = 14_000;
    const blocks: string[] = [];
    for (const p of picked) {
      const head = `${p.kind}: ${p.title} [${p.id}]`;
      let body = p.lines.join('\n');
      if (body.length > 2_500) body = `${body.slice(0, 1_200)}\n...\n${body.slice(-1_200)}`;
      const block = `${head}\n${body}`;
      if (block.length > budget) break;
      budget -= block.length;
      blocks.push(block);
    }
    const context = [
      'Your current notes on working with the owner:',
      ...(notes.length ? notes.map((n) => `- [${n.id}] ${n.content.replace(/\s+/g, ' ')}`) : ['- None yet.']),
      '',
      `Chats since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} UTC (owner and assistant text only):`,
      '',
      redactSecrets(blocks.join('\n\n')) || '(none)',
    ].join('\n');
    if (!picked.length) return { output: '', exitCode: 0, skipReason: 'No chats since the last reflection', context };
    return { output: digest, exitCode: 0, context };
  }

  /** The procedure notes the reflection keeps for the assistant. */
  reflectionNotes(): MemoryEntry[] {
    return this.host.memory.list({ scope: 'agent', scopeKey: ASSISTANT_AGENT, kind: 'procedure', limit: 200 }).filter((m) => m.tags.includes(REFLECTION_TAG));
  }
}

function isOwnerMessage(m: Message): boolean {
  return m.role === 'user' && m.kind === 'normal' && !m.meta?.auto && m.content.some((b) => b.type === 'text' && stripReminders(b.text));
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** The text a person wrote or read: text blocks only, no tool calls or results, no reminders. */
function messageText(m: Message): string {
  return m.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => stripReminders(b.text))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

