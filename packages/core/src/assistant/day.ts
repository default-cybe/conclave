/**
 * The owner's day (or the last few days) in one place, for the DayPlan tool,
 * the evening review, the weekly check and Home's Today section: local time,
 * message hours, tasks, goals, sessions with their summaries, routine runs
 * and the saved plan.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { Routine, RoutineRun, Task } from '../types';
import type { Goal, GoalEntry, DayPlan, ProactivePrefs } from './types';
import { GOAL_AREA_LABEL } from './types';
import { addDays, dayRange, daysBetween, insideHours, localDate, localHhmm, localLong } from './time';

export interface DaySession {
  id: string;
  title: string;
  agent: string;
  kind: 'chat' | 'agent';
  cwd?: string;
  updatedAt: number;
  summary?: string;
  /** The agent reads untrusted input (email, web): title and summary are left out. */
  untrusted?: boolean;
}

export interface DayRoutine {
  routine: Pick<Routine, 'id' | 'name' | 'schedule'>;
  runs: RoutineRun[];
}

export interface DayReport {
  date: string;
  /** First day of the range, when it is longer than one day. */
  from: string;
  days: number;
  timezone: string;
  now: number;
  prefs: ProactivePrefs;
  tasks: { overdue: Task[]; due: Task[]; doing: Task[]; done: Task[] };
  goals: Array<{ goal: Goal; parentTitle?: string; entries: GoalEntry[] }>;
  sessions: DaySession[];
  routines: DayRoutine[];
  plan?: DayPlan;
}

export interface DayInputs {
  db: Db;
  tasks: Task[];
  goals: Goal[];
  entries: (from: string, to: string) => GoalEntry[];
  routines: Routine[];
  runs: (routineId: string) => RoutineRun[];
  plan: (date: string) => DayPlan | undefined;
  prefs: ProactivePrefs;
  timezone: string;
  now: number;
  /** Whose day: sessions are this account's only. Default: the owner's. */
  accountId?: string;
}

type Row = Record<string, any>;

/** Sessions touched in a time range: chats and sessions the owner started, not routine runs or subagents. */
export function sessionsBetween(db: Db, start: number, end: number, limit = 30, accountId = 'owner'): DaySession[] {
  const rows = db
    .query(
      `SELECT id, title, agent, kind, cwd, updated_at, meta FROM sessions
       WHERE account_id = ? AND updated_at >= ? AND created_at < ? AND archived = 0 AND parent_id IS NULL AND routine_id IS NULL
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(accountId, start, end, limit) as Row[];
  const ep = db.query(`SELECT content FROM memories WHERE kind = 'episode' AND source_session_id = ? ORDER BY updated_at DESC LIMIT 1`);
  return rows.map((r) => {
    // a session marked untrusted keeps only that it happened, like one of an untrusted agent
    if (json<Record<string, unknown>>(r.meta ?? null, {}).untrusted === true) return { id: r.id, title: '', agent: r.agent, kind: r.kind === 'chat' ? 'chat' : 'agent', ...(r.cwd ? { cwd: r.cwd } : {}), updatedAt: r.updated_at, untrusted: true };
    const e = ep.get(r.id) as Row | null;
    return { id: r.id, title: r.title, agent: r.agent, kind: r.kind === 'chat' ? 'chat' : 'agent', ...(r.cwd ? { cwd: r.cwd } : {}), updatedAt: r.updated_at, ...(e?.content ? { summary: String(e.content) } : {}) };
  });
}

export function buildDay(input: DayInputs, opts: { date?: string; days?: number } = {}): DayReport {
  const tz = input.timezone;
  const date = opts.date ?? localDate(input.now, tz);
  const days = Math.max(1, Math.min(14, Math.floor(opts.days ?? 1)));
  const from = addDays(date, -(days - 1));
  const { start } = dayRange(from, tz, days);
  const { end } = dayRange(date, tz, 1);
  const today = dayRange(date, tz, 1);

  const open = input.tasks.filter((t) => t.status !== 'done');
  const tasks = {
    overdue: open.filter((t) => t.due !== undefined && t.due < today.start).sort(byDue),
    due: open.filter((t) => t.due !== undefined && t.due >= today.start && t.due < today.end).sort(byDue),
    doing: open.filter((t) => t.status === 'doing' && !(t.due !== undefined && t.due < today.end)),
    done: input.tasks.filter((t) => t.status === 'done' && t.updatedAt >= start && t.updatedAt < end).sort((a, b) => a.updatedAt - b.updatedAt),
  };

  const entries = input.entries(from, date);
  const titleOf = new Map(input.goals.map((g) => [g.id, g.title]));
  const goals = input.goals
    .filter((g) => g.status === 'active' || entries.some((e) => e.goalId === g.id) || (g.completedAt !== undefined && g.completedAt >= start && g.completedAt < end))
    .map((g) => ({ goal: g, ...(g.parentId ? { parentTitle: titleOf.get(g.parentId) } : {}), entries: entries.filter((e) => e.goalId === g.id) }));

  const routines = input.routines
    .map((r) => ({ routine: { id: r.id, name: r.name, schedule: r.schedule }, runs: input.runs(r.id).filter((x) => x.startedAt >= start && x.startedAt < end).sort((a, b) => a.startedAt - b.startedAt) }))
    .filter((r) => r.runs.length);

  return {
    date,
    from,
    days,
    timezone: tz,
    now: input.now,
    prefs: input.prefs,
    tasks,
    goals,
    sessions: sessionsBetween(input.db, start, end, days > 1 ? 40 : 20, input.accountId ?? 'owner'),
    routines,
    ...(input.plan(date) ? { plan: input.plan(date) } : {}),
  };
}

function byDue(a: Task, b: Task): number {
  return (a.due ?? 0) - (b.due ?? 0);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

/** The report as plain text for a model. */
export function renderDay(d: DayReport): string {
  const tz = d.timezone;
  const when = (ts: number) => (localDate(ts, tz) === d.date ? localHhmm(ts, tz) : `${localDate(ts, tz)} ${localHhmm(ts, tz)}`);
  const taskLine = (t: Task) => `- ${t.title} [${t.id}] ${t.status}${t.due !== undefined ? `, due ${when(t.due)}` : ''}${t.priority >= 2 ? ', high priority' : ''}${t.labels.length ? `, ${t.labels.join(', ')}` : ''}`;
  const out: string[] = [];
  const range = d.days > 1 ? `${d.from} to ${d.date} (${d.days} days)` : d.date;
  out.push(`Now: ${localLong(d.now, tz)} (${tz}). Range: ${range}.`);
  out.push(`Message hours ${d.prefs.hours.start} to ${d.prefs.hours.end}, ${insideHours(d.now, d.prefs.hours, tz) ? 'inside them now' : 'quiet hours now'}.`);

  if (d.plan) {
    const p = d.plan;
    out.push('', `Saved plan for ${p.date}: ${p.summary}`);
    for (const i of p.items) out.push(`- ${i.time ? `${i.time} ` : ''}${i.text}`);
    if (p.focus) out.push(`Focus ${p.focus.start} to ${p.focus.end}: ${p.focus.text}`);
    if (p.question) out.push(`Question: ${p.question.text} Options: ${p.question.options.join(' / ')}.${p.question.answer ? ` Answered: ${p.question.answer}.` : ' Not answered yet.'}`);
  }

  out.push('', 'Tasks');
  if (d.tasks.overdue.length) out.push('Overdue:', ...d.tasks.overdue.map(taskLine));
  if (d.tasks.due.length) out.push(`Due ${d.date}:`, ...d.tasks.due.map(taskLine));
  if (d.tasks.doing.length) out.push('In progress:', ...d.tasks.doing.map(taskLine));
  if (d.tasks.done.length) out.push(d.days > 1 ? 'Finished in the range:' : 'Finished today:', ...d.tasks.done.map((t) => `- ${t.title} [${t.id}] at ${when(t.updatedAt)}`));
  if (!d.tasks.overdue.length && !d.tasks.due.length && !d.tasks.doing.length && !d.tasks.done.length) out.push('- None due, in progress or finished.');

  out.push('', 'Goals');
  if (!d.goals.length) out.push('- No goals yet.');
  for (const g of d.goals) {
    const x = g.goal;
    const days = x.targetDate ? daysBetween(d.date, x.targetDate) : undefined;
    const target = x.targetDate ? `, target ${x.targetDate} (${days! < 0 ? `${-days!} days ago` : days === 0 ? 'today' : `in ${days} days`})` : '';
    out.push(`- ${g.parentTitle ? `${g.parentTitle} > ` : ''}${x.title} [${x.id}] ${GOAL_AREA_LABEL[x.area].toLowerCase()}, ${x.status}${target}${x.nextStep && x.status === 'active' ? `. Next: ${x.nextStep}` : ''}${x.taskIds.length ? `. Tasks: ${x.taskIds.join(', ')}` : ''}`);
    for (const e of g.entries) out.push(`  - progress ${e.date}: ${clip(e.text, 200)}`);
  }

  out.push('', d.days > 1 ? 'Sessions and chats in the range' : 'Sessions and chats today');
  if (!d.sessions.length) out.push('- None.');
  for (const s of d.sessions) {
    if (s.untrusted) out.push(`- ${s.kind === 'chat' ? 'Chat' : 'Session'} with ${s.agent} (reads untrusted input, so no title or summary) [${s.id}], last at ${when(s.updatedAt)}`);
    else out.push(`- ${s.kind === 'chat' ? 'Chat' : `Session (${s.agent})`}: ${s.title} [${s.id}], last at ${when(s.updatedAt)}${s.summary ? `. Summary: ${clip(s.summary, 300)}` : ''}`);
  }

  out.push('', 'Routine runs (run history, the truth about what ran)');
  if (!d.routines.length) out.push('- None ran.');
  for (const r of d.routines) out.push(`- ${r.routine.name}: ${runWords(r.runs, when)}`);
  return out.join('\n');
}

/** "07:30 ok", or for a frequent routine "14 checks: 2 ran, 12 skipped (nothing new), last 14:00 ok". */
export function runWords(runs: RoutineRun[], when: (ts: number) => string): string {
  const state = (r: RoutineRun) => (r.status === 'skipped' ? `skipped (${r.error ?? 'precheck'})` : r.status === 'error' ? `failed: ${clip(r.error ?? 'error', 120)}` : r.status === 'running' ? 'running' : r.outcome && r.outcome !== 'ok' ? `ok, ${r.outcome}` : 'ok');
  if (runs.length <= 4) return runs.map((r) => `${when(r.startedAt)} ${state(r)}`).join('; ');
  const ran = runs.filter((r) => r.status !== 'skipped').length;
  const last = runs[runs.length - 1];
  const reasons = [...new Set(runs.filter((r) => r.status === 'skipped').map((r) => r.error ?? 'precheck'))];
  return `${runs.length} checks: ${ran} ran, ${runs.length - ran} skipped${reasons.length ? ` (${reasons.join(', ').toLowerCase()})` : ''}, last ${when(last.startedAt)} ${state(last)}`;
}
