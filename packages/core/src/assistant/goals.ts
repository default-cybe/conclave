/**
 * Goals (docs/design/ROUND-LIFE-ASSISTANT.md 2): two small tables, a memory
 * projection so every agent recalls them, and one Basic Memory note per goal
 * when a memory connection writes.
 *
 * The tables are created here with IF NOT EXISTS instead of in the shared
 * migration list, so another branch adding a migration cannot collide.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { Task } from '../types';
import type { ExternalMemory, ExternalNote } from '../memory/external';
import type { ImportItem, ImportOutcome } from '../memory/store';
import { redactSecrets } from '../memory/secrets';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import { GOAL_AREA_LABEL, GOAL_AREAS, type Goal, type GoalArea, type GoalDetail, type GoalEntry, type GoalEntrySource, type GoalInput, type GoalPatch, type GoalStatus, type GoalSummary } from './types';
import { localDate } from './time';
import { OWNER_ID } from '../people/context';
import { ensureAccountColumn } from '../people/tables';

const log = logger('goals');

/** Source id of the memory projection. Not a valid connection id, so no connection can claim it. */
export const GOALS_SOURCE = '@goals';
/** Tag on the projected memories, besides imported and source:@goals. */
export const GOAL_TAG = 'goal';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  next_step TEXT,
  target_date TEXT,
  status TEXT NOT NULL,
  task_ids TEXT NOT NULL DEFAULT '[]',
  source_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS goals_parent ON goals(parent_id);
CREATE TABLE IF NOT EXISTS goal_entries (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_entries_goal ON goal_entries(goal_id, date);
CREATE INDEX IF NOT EXISTS goal_entries_date ON goal_entries(date);
CREATE TABLE IF NOT EXISTS goal_notes (
  goal_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_notes_key ON goal_notes(key);
`;

const LIMITS = { title: 200, description: 2000, nextStep: 300, entry: 1000, tasks: 50 };

/** A goal input the hub refuses, with a sentence that says why. */
export class GoalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, any>;

function rowToGoal(r: Row): Goal {
  return {
    id: r.id,
    title: r.title,
    area: r.area,
    description: r.description ?? '',
    ...(r.next_step ? { nextStep: r.next_step } : {}),
    ...(r.target_date ? { targetDate: r.target_date } : {}),
    status: r.status === 'done' ? 'done' : 'active',
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
    taskIds: json<string[]>(r.task_ids, []),
    ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.completed_at ? { completedAt: r.completed_at } : {}),
  };
}

function rowToEntry(r: Row): GoalEntry {
  return { id: r.id, goalId: r.goal_id, date: r.date, text: r.text, source: r.source, ...(r.session_id ? { sessionId: r.session_id } : {}), createdAt: r.created_at };
}

export function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function clean(s: unknown, max: number, field: string): string {
  if (typeof s !== 'string') throw new GoalError(400, `${field} must be text.`);
  const t = redactSecrets(s.replace(/\s+/g, ' ').trim());
  if (t.length > max) throw new GoalError(400, `${field} is longer than ${max} characters. Keep it short.`);
  return t;
}

function cleanBlock(s: unknown, max: number, field: string): string {
  if (typeof s !== 'string') throw new GoalError(400, `${field} must be text.`);
  const t = redactSecrets(s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (t.length > max) throw new GoalError(400, `${field} is longer than ${max} characters. Keep it short.`);
  return t;
}

function areaOf(v: unknown): GoalArea {
  if (v === undefined || v === null || v === '') return 'other';
  if (typeof v !== 'string' || !GOAL_AREAS.includes(v as GoalArea)) throw new GoalError(400, `area must be one of ${GOAL_AREAS.join(', ')}.`);
  return v as GoalArea;
}

function taskList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new GoalError(400, 'taskIds must be a list of task ids.');
  const out = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
  if (out.length > LIMITS.tasks) throw new GoalError(400, `A goal links at most ${LIMITS.tasks} tasks.`);
  return out;
}

/** What the goals need from the task board. */
export interface GoalTasks {
  get(id: string): Task | undefined;
  create(input: { title: string; description?: string; due?: number; labels?: string[] }): Task;
}

/** The memory side: SqliteMemory's import path, which never mirrors, dedupes or lets extraction rewrite. */
export interface GoalMemoryPort {
  upsertImported(source: string, items: ImportItem[], opts?: { removeMissing?: boolean }): Promise<ImportOutcome>;
}

export interface GoalServiceOptions {
  db: Db;
  memory?: GoalMemoryPort;
  /** The memory connections, when Conclave writes to one (mirror or external mode). */
  external?: () => ExternalMemory | undefined;
  tasks?: GoalTasks;
  /** The owner's zone, for dates. */
  timezone: () => string;
  now?: () => number;
  /** Wait this long after the last change before writing the Basic Memory note. Default 1500. */
  mirrorDebounceMs?: number;
  /** Whose goals (docs/design/ACCOUNTS.md). Every read and write stays inside it. Default: the owner's. */
  accountId?: string;
}

export class GoalService {
  private db: Db;
  private memory?: GoalMemoryPort;
  private external?: () => ExternalMemory | undefined;
  private tasks?: GoalTasks;
  private tz: () => string;
  private now: () => number;
  private debounceMs: number;
  private projecting: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; renames: Array<{ note: string; title: string }>; farewell?: ExternalNote[] }>();
  private writes = new Set<Promise<void>>();
  readonly accountId: string;

  constructor(opts: GoalServiceOptions) {
    this.accountId = opts.accountId ?? OWNER_ID;
    this.db = opts.db;
    this.memory = opts.memory;
    this.external = opts.external;
    this.tasks = opts.tasks;
    this.tz = opts.timezone;
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.mirrorDebounceMs ?? 1500;
    this.db.exec(SCHEMA);
    ensureAccountColumn(this.db, 'goals');
  }

  today(): string {
    return localDate(this.now(), this.tz());
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  get(id: string): Goal | undefined {
    const r = this.db.query('SELECT * FROM goals WHERE id = ? AND account_id = ?').get(id, this.accountId) as Row | null;
    return r ? rowToGoal(r) : undefined;
  }

  all(): Goal[] {
    return (this.db.query('SELECT * FROM goals WHERE account_id = ? ORDER BY created_at ASC').all(this.accountId) as Row[]).map(rowToGoal);
  }

  subgoals(parentId: string): Goal[] {
    return (this.db.query('SELECT * FROM goals WHERE parent_id = ? AND account_id = ? ORDER BY created_at ASC').all(parentId, this.accountId) as Row[]).map(rowToGoal);
  }

  entries(goalIds: string[], limit = 500): GoalEntry[] {
    if (!goalIds.length) return [];
    const marks = goalIds.map(() => '?').join(',');
    return (
      this.db
        .query(`SELECT * FROM goal_entries WHERE goal_id IN (${marks}) AND goal_id IN (SELECT id FROM goals WHERE account_id = ?) ORDER BY date DESC, created_at DESC LIMIT ?`)
        .all(...goalIds, this.accountId, limit) as Row[]
    ).map(rowToEntry);
  }

  /** Entries dated from..to (inclusive), with the title of their goal. */
  entriesBetween(from: string, to: string): Array<GoalEntry & { goalTitle: string }> {
    const rows = this.db
      .query('SELECT e.*, g.title AS goal_title FROM goal_entries e JOIN goals g ON g.id = e.goal_id WHERE g.account_id = ? AND e.date >= ? AND e.date <= ? ORDER BY e.date ASC, e.created_at ASC')
      .all(this.accountId, from, to) as Row[];
    return rows.map((r) => ({ ...rowToEntry(r), goalTitle: r.goal_title }));
  }

  /** Top-level goals with their subgoals, newest activity first within each status. */
  list(opts: { status?: GoalStatus | 'all'; area?: GoalArea } = {}): GoalSummary[] {
    const all = this.all();
    const byParent = new Map<string, Goal[]>();
    for (const g of all) if (g.parentId) byParent.set(g.parentId, [...(byParent.get(g.parentId) ?? []), g]);
    const top = all.filter((g) => !g.parentId && (!opts.status || opts.status === 'all' || g.status === opts.status) && (!opts.area || g.area === opts.area));
    return top
      .map((g) => {
        const subgoals = byParent.get(g.id) ?? [];
        const ids = [g.id, ...subgoals.map((s) => s.id)];
        const marks = ids.map(() => '?').join(',');
        const count = (this.db.query(`SELECT COUNT(*) AS n FROM goal_entries WHERE goal_id IN (${marks})`).get(...ids) as Row).n as number;
        const last = this.entries(ids, 1)[0];
        const taskIds = [...new Set([g, ...subgoals].flatMap((x) => x.taskIds))];
        const openTasks = taskIds.map((t) => this.tasks?.get(t)).filter((t) => t && t.status !== 'done').length;
        return { ...g, subgoals, entryCount: count, openTasks, ...(last ? { lastEntry: last } : {}) };
      })
      .sort((a, b) => (a.status === b.status ? Math.max(b.updatedAt, b.lastEntry?.createdAt ?? 0) - Math.max(a.updatedAt, a.lastEntry?.createdAt ?? 0) : a.status === 'active' ? -1 : 1));
  }

  detail(id: string): GoalDetail | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    const parent = goal.parentId ? this.get(goal.parentId) : undefined;
    const subgoals = goal.parentId ? [] : this.subgoals(goal.id);
    const ids = [goal.id, ...subgoals.map((s) => s.id)];
    const tasks = [...new Set([goal, ...subgoals].flatMap((g) => g.taskIds))].map((t) => this.tasks?.get(t)).filter((t): t is Task => !!t);
    return { goal, ...(parent ? { parent } : {}), subgoals, entries: this.entries(ids), tasks };
  }

  // -------------------------------------------------------------------------
  // writes
  // -------------------------------------------------------------------------

  create(input: GoalInput): Goal {
    const title = clean(input?.title ?? '', LIMITS.title, 'title');
    if (!title) throw new GoalError(400, 'A goal needs a title, in the owner\'s own words.');
    let area = areaOf(input.area);
    let parentId: string | undefined;
    if (input.parentId) {
      const parent = this.get(input.parentId);
      if (!parent) throw new GoalError(404, `There is no goal ${input.parentId}.`);
      if (parent.parentId) throw new GoalError(400, 'Goals nest one level only. Add this as a subgoal of the top goal instead.');
      parentId = parent.id;
      area = parent.area;
    }
    const twin = this.all().find((g) => g.status === 'active' && (g.parentId ?? '') === (parentId ?? '') && g.area === area && g.title.toLowerCase() === title.toLowerCase());
    if (twin) throw new GoalError(409, `An active goal "${twin.title}" already exists (${twin.id}). Update that goal instead of making a second one.`);
    const targetDate = this.date(input.targetDate, 'targetDate');
    const taskIds = taskList(input.taskIds);
    const unknown = this.tasks ? taskIds.filter((t) => !this.tasks!.get(t)) : [];
    if (unknown.length) throw new GoalError(400, `No task with id ${unknown.join(', ')} on the board.`);
    const now = this.now();
    const goal: Goal = {
      id: newId('goal'),
      title,
      area,
      description: input.description ? cleanBlock(input.description, LIMITS.description, 'description') : '',
      ...(input.nextStep ? { nextStep: clean(input.nextStep, LIMITS.nextStep, 'nextStep') } : {}),
      ...(targetDate ? { targetDate } : {}),
      status: 'active',
      ...(parentId ? { parentId } : {}),
      taskIds,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.write(goal, true);
    this.changed(goal);
    return goal;
  }

  update(id: string, patch: GoalPatch): Goal {
    const cur = this.get(id);
    if (!cur) throw new GoalError(404, `There is no goal ${id}.`);
    const next: Goal = { ...cur, updatedAt: this.now() };
    if (patch.title !== undefined) {
      next.title = clean(patch.title, LIMITS.title, 'title');
      if (!next.title) throw new GoalError(400, 'A goal needs a title.');
    }
    if (patch.area !== undefined) {
      if (cur.parentId) throw new GoalError(400, 'A subgoal has the area of its goal. Change the top goal instead.');
      next.area = areaOf(patch.area);
    }
    if (patch.description !== undefined) next.description = cleanBlock(patch.description ?? '', LIMITS.description, 'description');
    if (patch.nextStep !== undefined) {
      const v = patch.nextStep === null ? '' : clean(patch.nextStep, LIMITS.nextStep, 'nextStep');
      if (v) next.nextStep = v;
      else delete next.nextStep;
    }
    if (patch.targetDate !== undefined) {
      const v = patch.targetDate === null || patch.targetDate === '' ? undefined : this.date(patch.targetDate, 'targetDate');
      if (v) next.targetDate = v;
      else delete next.targetDate;
    }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'done') throw new GoalError(400, 'status must be active or done. There is no pause: log a progress entry for a break.');
      if (patch.status !== cur.status) {
        next.status = patch.status;
        if (patch.status === 'done') next.completedAt = this.now();
        else delete next.completedAt;
      }
    }
    // a task deleted from the board leaves the goal too
    if (patch.taskIds !== undefined) next.taskIds = taskList(patch.taskIds).filter((t) => !this.tasks || !!this.tasks.get(t));
    // renaming or reopening into a second active goal with the same title in the area is refused, like create
    if (next.status === 'active' && (next.title !== cur.title || next.area !== cur.area || cur.status !== 'active')) {
      const twin = this.all().find((g) => g.id !== cur.id && g.status === 'active' && (g.parentId ?? '') === (cur.parentId ?? '') && g.area === next.area && g.title.toLowerCase() === next.title.toLowerCase());
      if (twin) throw new GoalError(409, `An active goal "${twin.title}" already exists (${twin.id}). Update that goal instead of making a second one.`);
    }
    this.write(next, false);
    this.changed(next, cur.title !== next.title && !cur.parentId ? cur.title : undefined);
    return next;
  }

  /** Remove a goal, its subgoals and every entry they had. */
  remove(id: string): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    const topId = cur.parentId ?? cur.id;
    // a top goal's note keeps its history, marked deleted; a subgoal leaves its goal's note
    const farewell = cur.parentId || !this.mirrorTarget() ? undefined : this.notesFor(cur.id, { deleted: true });
    const ids = [cur.id, ...(cur.parentId ? [] : this.subgoals(cur.id).map((s) => s.id))];
    const marks = ids.map(() => '?').join(',');
    this.db.transaction(() => {
      this.db.query(`DELETE FROM goal_entries WHERE goal_id IN (${marks})`).run(...ids);
      this.db.query(`DELETE FROM goals WHERE id IN (${marks}) AND account_id = ?`).run(...ids, this.accountId);
    })();
    this.project();
    if (farewell) this.queueMirror(topId, { farewell });
    else this.queueMirror(topId);
    return true;
  }

  addEntry(goalId: string, input: { text: string; date?: string; source?: GoalEntrySource; sessionId?: string }): GoalEntry {
    const goal = this.get(goalId);
    if (!goal) throw new GoalError(404, `There is no goal ${goalId}.`);
    const text = cleanBlock(input?.text ?? '', LIMITS.entry, 'text');
    if (!text) throw new GoalError(400, 'A progress entry needs text: one plain sentence of what happened.');
    const date = this.date(input.date, 'date') ?? this.today();
    const source: GoalEntrySource = input.source === 'owner' || input.source === 'routine' ? input.source : 'assistant';
    const entry: GoalEntry = { id: newId('gent'), goalId, date, text, source, ...(input.sessionId ? { sessionId: input.sessionId } : {}), createdAt: this.now() };
    this.db
      .query('INSERT INTO goal_entries (id, goal_id, date, text, source, session_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(entry.id, entry.goalId, entry.date, entry.text, entry.source, entry.sessionId ?? null, entry.createdAt);
    this.db.query('UPDATE goals SET updated_at = ? WHERE id = ? AND account_id = ?').run(entry.createdAt, goalId, this.accountId);
    this.changed(goal);
    return entry;
  }

  removeEntry(goalId: string, entryId: string): boolean {
    const goal = this.get(goalId);
    if (!goal) return false;
    const res = this.db.query('DELETE FROM goal_entries WHERE id = ? AND goal_id = ?').run(entryId, goalId);
    if (!res.changes) return false;
    this.changed(goal);
    return true;
  }

  /** Make a task on the board and link it to the goal. */
  addTask(goalId: string, input: { title: string; due?: number }): { goal: Goal; task: Task } {
    if (!this.tasks) throw new GoalError(501, 'The task board is not available here.');
    const goal = this.get(goalId);
    if (!goal) throw new GoalError(404, `There is no goal ${goalId}.`);
    const title = clean(input.title ?? '', LIMITS.title, 'task title');
    if (!title) throw new GoalError(400, 'A task needs a title.');
    if (goal.taskIds.length >= LIMITS.tasks) throw new GoalError(400, `A goal links at most ${LIMITS.tasks} tasks.`);
    const task = this.tasks.create({ title, due: input.due, labels: ['goal', goal.area], description: `For the goal: ${goal.title}` });
    return { goal: this.update(goalId, { taskIds: [...goal.taskIds, task.id] }), task };
  }

  private date(v: unknown, field: string): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (!validDate(v)) throw new GoalError(400, `${field} must be a date like 2026-12-01.`);
    return v;
  }

  private write(g: Goal, insert: boolean): void {
    const args = [g.parentId ?? null, g.title, g.area, g.description, g.nextStep ?? null, g.targetDate ?? null, g.status, JSON.stringify(g.taskIds), g.sourceSessionId ?? null, g.updatedAt, g.completedAt ?? null];
    if (insert) {
      this.db
        .query('INSERT INTO goals (id, parent_id, title, area, description, next_step, target_date, status, task_ids, source_session_id, updated_at, completed_at, created_at, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(g.id, ...args, g.createdAt, this.accountId);
    } else {
      this.db
        .query('UPDATE goals SET parent_id=?, title=?, area=?, description=?, next_step=?, target_date=?, status=?, task_ids=?, source_session_id=?, updated_at=?, completed_at=? WHERE id=? AND account_id=?')
        .run(...args, g.id, this.accountId);
    }
    // a top goal's area is its subgoals' area
    if (!insert && !g.parentId) this.db.query('UPDATE goals SET area = ? WHERE parent_id = ? AND account_id = ?').run(g.area, g.id, this.accountId);
  }

  private changed(g: Goal, renamedFrom?: string): void {
    this.project();
    const topId = g.parentId ?? g.id;
    if (renamedFrom && this.mirrorTarget()) {
      // the old note stays where it was and points to the new one
      const note = this.noteTitle({ ...g, title: renamedFrom });
      this.db.query('DELETE FROM goal_notes WHERE goal_id = ?').run(topId);
      this.queueMirror(topId, { rename: { note, title: renamedFrom } });
    } else this.queueMirror(topId);
  }

  // -------------------------------------------------------------------------
  // memory projection
  // -------------------------------------------------------------------------

  /** Bring the goal memories in line with the tables. Runs after every change; await whenSynced() to wait for it. */
  project(): Promise<unknown> {
    if (!this.memory) return this.projecting;
    const memory = this.memory;
    this.projecting = this.projecting
      .catch(() => undefined)
      .then(() => memory.upsertImported(GOALS_SOURCE, this.memoryItems(), { removeMissing: true }))
      .catch((err) => log.warn(`goal memory sync failed: ${(err as Error).message}`));
    return this.projecting;
  }

  whenSynced(): Promise<unknown> {
    return this.projecting;
  }

  /** One memory per top-level goal. */
  memoryItems(): ImportItem[] {
    const all = this.all();
    return all
      .filter((g) => !g.parentId)
      .map((g) => {
        const subs = all.filter((s) => s.parentId === g.id);
        const last = this.entries([g.id, ...subs.map((s) => s.id)], 1)[0];
        const open = [...new Set([g, ...subs].flatMap((x) => x.taskIds))].map((t) => this.tasks?.get(t)).filter((t) => t && t.status !== 'done').length;
        return { id: g.id, content: goalMemoryText(g, subs, last, open), tags: [GOAL_TAG, g.area, g.status] };
      });
  }

  // -------------------------------------------------------------------------
  // Basic Memory mirror
  // -------------------------------------------------------------------------

  private mirrorTarget(): ExternalMemory | undefined {
    const ext = this.external?.();
    if (!ext) return undefined;
    const mode = ext.writeMode ? ext.writeMode() : 'mirror';
    return mode ? ext : undefined;
  }

  /** The notes for a top goal right now. */
  notesFor(topId: string, opts: { deleted?: boolean } = {}): ExternalNote[] {
    const goal = this.get(topId);
    if (!goal) return [];
    const subs = this.subgoals(topId);
    const entries = this.entries([topId, ...subs.map((s) => s.id)]);
    return [goalNote(goal, subs, entries, { deleted: opts.deleted ? this.today() : undefined, title: this.noteTitle(goal) })];
  }

  /**
   * The note a top goal writes to. Claimed on first use and kept, so two
   * goals with the same title (a done one and a new one, or titles that
   * differ only in case or punctuation) never write over each other.
   */
  private noteTitle(g: Pick<Goal, 'id' | 'title'>): string {
    const row = this.db.query('SELECT title FROM goal_notes WHERE goal_id = ?').get(g.id) as Row | null;
    if (row) return row.title as string;
    const base = slug(g.title) || 'Goal';
    const taken = !!this.db.query('SELECT 1 FROM goal_notes WHERE key = ? AND goal_id != ?').get(noteKey(base), g.id);
    const title = taken ? `${base} ${g.id.slice(-6)}` : base;
    this.db.query('INSERT OR REPLACE INTO goal_notes (goal_id, title, key) VALUES (?,?,?)').run(g.id, title, noteKey(title));
    return title;
  }

  private queueMirror(topId: string, extra: { rename?: { note: string; title: string }; farewell?: ExternalNote[] } = {}): void {
    if (!this.mirrorTarget()) return;
    const cur = this.pending.get(topId);
    if (cur) clearTimeout(cur.timer);
    const timer = setTimeout(() => this.runMirror(topId), this.debounceMs);
    (timer as { unref?: () => void }).unref?.();
    // renames in one burst each leave a pointer to where the note ends up
    const renames = [...(cur?.renames ?? []), ...(extra.rename ? [extra.rename] : [])];
    this.pending.set(topId, { timer, renames, farewell: extra.farewell ?? cur?.farewell });
  }

  private runMirror(topId: string): void {
    const p = this.pending.get(topId);
    this.pending.delete(topId);
    const ext = this.mirrorTarget();
    if (!ext) return;
    const main = p?.farewell ?? this.notesFor(topId);
    const to = main[0];
    const goalTitle = this.get(topId)?.title ?? to?.content.match(/^# (.+)$/m)?.[1] ?? '';
    const seen = new Set(to ? [noteKey(to.title)] : []);
    const pointers: ExternalNote[] = [];
    for (const r of p?.renames ?? []) {
      // a rename that only changed case or punctuation keeps the same note
      if (!to || seen.has(noteKey(r.note))) continue;
      seen.add(noteKey(r.note));
      pointers.push(renameNote(r.title, goalTitle, this.today(), { from: r.note, to: to.title }));
    }
    const notes = [...pointers, ...main];
    if (!notes.length) return;
    const job = (async () => {
      for (const n of notes) {
        try {
          await ext.write(n);
        } catch (err) {
          log.warn(`goal note "${n.title}" to ${ext.name} failed: ${(err as Error).message}`);
        }
      }
    })();
    this.writes.add(job);
    void job.finally(() => this.writes.delete(job));
  }

  /** Write every queued note now and wait for the writes. */
  async flushMirror(): Promise<void> {
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.runMirror(id);
    }
    await Promise.all([...this.writes]);
  }

  /** Write every top goal's note (after a connection is added). */
  async mirrorAll(): Promise<number> {
    const ext = this.mirrorTarget();
    if (!ext) return 0;
    let n = 0;
    for (const g of this.all().filter((x) => !x.parentId)) {
      for (const note of this.notesFor(g.id)) {
        await ext.write(note).then(
          () => n++,
          (err) => log.warn(`goal note to ${ext.name} failed: ${(err as Error).message}`),
        );
      }
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/** The memory text of a top goal: what recall shows every agent. */
export function goalMemoryText(g: Goal, subs: Goal[], last: GoalEntry | undefined, openTasks: number): string {
  const head = g.status === 'done' ? `done ${g.completedAt ? new Date(g.completedAt).toISOString().slice(0, 10) : ''}`.trim() : `active${g.targetDate ? `, target ${g.targetDate}` : ''}`;
  const parts = [`Goal (${GOAL_AREA_LABEL[g.area].toLowerCase()}, ${head}): ${g.title}.`];
  if (g.description) parts.push(g.description.replace(/\s+/g, ' '));
  if (g.nextStep && g.status === 'active') parts.push(`Next step: ${g.nextStep.replace(/\.$/, '')}.`);
  if (subs.length) parts.push(`Subgoals: ${subs.map((s) => `${s.title} (${s.status === 'done' ? 'done' : s.targetDate ? `target ${s.targetDate}` : 'active'})`).join('; ')}.`);
  if (openTasks) parts.push(`Linked tasks: ${openTasks} open.`);
  if (last) parts.push(`Latest progress ${last.date}: ${last.text.replace(/\s+/g, ' ').replace(/\.$/, '')}.`);
  parts.push(`Goal id ${g.id}.`);
  return parts.join(' ');
}

/** Two note titles that Basic Memory files under the same permalink have the same key. */
function noteKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function slug(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** One Basic Memory note per top goal: the goal, its subgoals and the progress log. */
export function goalNote(g: Goal, subs: Goal[], entries: GoalEntry[], opts: { deleted?: string; title?: string } = {}): ExternalNote {
  const area = GOAL_AREA_LABEL[g.area];
  const titleOf = new Map([g, ...subs].map((x) => [x.id, x.title]));
  const status = opts.deleted ? `deleted on ${opts.deleted}` : g.status === 'done' ? `done${g.completedAt ? ` on ${new Date(g.completedAt).toISOString().slice(0, 10)}` : ''}` : 'active';
  const progress = [...entries].sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));
  const tag = g.area.replace(/\s+/g, '-');
  const lines = [
    `# ${g.title}`,
    '',
    `Area: ${area}`,
    `Status: ${status}`,
    ...(g.targetDate ? [`Target: ${g.targetDate}`] : []),
    ...(g.nextStep && g.status === 'active' && !opts.deleted ? [`Next step: ${g.nextStep}`] : []),
    `Goal id: ${g.id}`,
    ...(g.description ? ['', '## Why', '', g.description] : []),
    ...(subs.length ? ['', '## Subgoals', '', ...subs.map((s) => `- [${s.status === 'done' ? 'x' : ' '}] ${s.title}${s.targetDate ? `, target ${s.targetDate}` : ''}${s.nextStep && s.status === 'active' ? `, next: ${s.nextStep}` : ''}`)] : []),
    '',
    '## Progress',
    '',
    ...(progress.length ? progress.map((e) => `- ${e.date}${e.goalId !== g.id ? ` (${titleOf.get(e.goalId) ?? 'subgoal'})` : ''}: ${e.text.replace(/\n+/g, ' ')}`) : ['- No progress logged yet.']),
    '',
    '## Observations',
    '',
    `- [goal] ${g.title} (${g.area}, ${status}${g.targetDate ? `, target ${g.targetDate}` : ''}) #goal #${tag}`,
    ...progress.slice(0, 20).map((e) => `- [progress] ${e.date} ${e.text.replace(/\n+/g, ' ')} #progress`),
    '',
    '## Relations',
    '',
    '- part_of [[Goals]]',
  ];
  const text = goalMemoryText(g, subs, progress[0], 0);
  return { title: opts.title ?? slug(g.title), content: lines.join('\n'), folder: 'conclave/goals', tags: ['conclave', GOAL_TAG, tag], kind: 'fact', text };
}

/** The old note of a renamed goal: a pointer to the new one. */
export function renameNote(oldTitle: string, newTitle: string, date: string, notes: { from?: string; to?: string } = {}): ExternalNote {
  const to = notes.to ?? slug(newTitle);
  return {
    title: notes.from ?? slug(oldTitle),
    content: `# ${oldTitle}\n\nRenamed to [[${to}]] on ${date}.\n\n## Relations\n\n- renamed_to [[${to}]]`,
    folder: 'conclave/goals',
    tags: ['conclave', GOAL_TAG],
    kind: 'fact',
    text: `The goal "${oldTitle}" was renamed to "${newTitle}" on ${date}.`,
  };
}
