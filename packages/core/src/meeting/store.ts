/**
 * Meeting rows (docs/design/MEETING-MODE.md 2.2, 3.1). The tables are made
 * here with CREATE TABLE IF NOT EXISTS, so this module owns them, as
 * workflows/store.ts does. Every row carries account_id (8, Members).
 *
 * Audio is never stored: segments hold text only.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import { newId } from '../util/ids';
import { DEFAULT_REMINDERS, type Channel, type Meeting, type MeetingAnswer, type MeetingNotes, type MeetingStatus, type PrepSources, type Segment } from './wire';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT,
  device TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  agenda TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  audio_client_id TEXT,
  brief_message_id TEXT,
  notes_path TEXT,
  auto_answer TEXT NOT NULL DEFAULT 'questions',
  error TEXT,
  context TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS meetings_account ON meetings(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS meetings_project ON meetings(account_id, project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS meeting_segments (
  meeting_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  final INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, channel, seq)
);
CREATE INDEX IF NOT EXISTS meeting_segments_at ON meeting_segments(meeting_id, at);
CREATE TABLE IF NOT EXISTS meeting_answers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  question TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  first_token_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS meeting_answers_meeting ON meeting_answers(meeting_id, created_at);
CREATE TABLE IF NOT EXISTS meeting_digests (
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, session_id)
);
`;

/** Columns of scheduled meetings (11.6), added to databases made before them. */
const ADDED: Array<[string, string]> = [
  ['scheduled_at', 'INTEGER'],
  ['duration_min', 'INTEGER'],
  ['tz', 'TEXT'],
  ['steering', 'TEXT'],
  ['steering_preset', 'TEXT'],
  ['answer_length', "TEXT DEFAULT 'short'"],
  ['calendar_event_id', 'TEXT'],
  ['calendar_id', 'TEXT'],
  ['reminders', "TEXT DEFAULT '[1440,15]'"],
  ['auto_prep', 'INTEGER DEFAULT 1'],
  ['prep_state', "TEXT DEFAULT 'none'"],
  ['prep_progress', 'TEXT'],
  ['prep_draft', 'TEXT'],
  ['prep_edited', 'TEXT'],
  ['prep_at', 'INTEGER'],
  ['prep_edited_at', 'INTEGER'],
  ['prep_error', 'TEXT'],
  ['prep_sources', 'TEXT'],
  ['prep_extra', 'TEXT'],
];

const MIN = 60_000;
/** A ready meeting this close to its start (either way) is under Now (11.2). */
export const NOW_WINDOW_MS = 15 * MIN;
/** A meeting never started this long after its start is under Past as "Not held" (11.2). */
export const NOT_HELD_MS = 3 * 60 * MIN;

export type MeetingView = 'upcoming' | 'now' | 'past' | 'all';

/** Status changes the hub allows; anything else is a 409. */
const MOVES: Record<MeetingStatus, MeetingStatus[]> = {
  scheduled: ['preparing', 'failed'],
  preparing: ['ready', 'ending', 'failed'],
  // 'scheduled': rescheduled before it started (no audioClientId; move() checks)
  ready: ['live', 'ending', 'failed', 'scheduled'],
  live: ['paused', 'ending', 'failed'],
  paused: ['live', 'ending', 'failed'],
  ending: ['ended', 'failed'],
  // a failed brief or wrap-up can still be ended (the wrap-up runs again)
  failed: ['ending'],
  ended: [],
};

export function canMove(from: MeetingStatus, to: MeetingStatus): boolean {
  return MOVES[from].includes(to);
}

/** A stored final or partial segment with the hub-clock time it started (t0 + startMs). */
export interface StoredSegment extends Segment {
  at: number;
}

type Row = Record<string, any>;

function rowToMeeting(r: Row): Meeting {
  return {
    id: r.id,
    accountId: r.account_id,
    sessionId: r.session_id,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    device: r.device,
    cwd: r.cwd,
    title: r.title,
    ...(r.agenda ? { agenda: r.agenda } : {}),
    status: r.status,
    createdAt: r.created_at,
    ...(r.started_at ? { startedAt: r.started_at } : {}),
    ...(r.ended_at ? { endedAt: r.ended_at } : {}),
    ...(r.audio_client_id ? { audioClientId: r.audio_client_id } : {}),
    ...(r.brief_message_id ? { briefMessageId: r.brief_message_id } : {}),
    ...(r.notes_path ? { notesPath: r.notes_path } : {}),
    autoAnswer: r.auto_answer === 'off' ? 'off' : 'questions',
    ...(r.error ? { error: r.error } : {}),
    ...(r.scheduled_at != null ? { scheduledAt: r.scheduled_at } : {}),
    ...(r.duration_min != null ? { durationMin: r.duration_min } : {}),
    ...(r.tz ? { tz: r.tz } : {}),
    ...(r.steering ? { steering: r.steering } : {}),
    ...(r.steering_preset ? { steeringPreset: r.steering_preset } : {}),
    answerLength: r.answer_length === 'long' ? 'long' : 'short',
    ...(r.calendar_event_id ? { calendarEventId: r.calendar_event_id } : {}),
    ...(r.calendar_id ? { calendarId: r.calendar_id } : {}),
    reminders: json<number[]>(r.reminders, DEFAULT_REMINDERS),
    autoPrep: r.auto_prep == null ? true : !!r.auto_prep,
    prepState: r.prep_state ?? 'none',
    ...(r.prep_progress ? { prepProgress: json(r.prep_progress, undefined) } : {}),
    ...(r.prep_at ? { prepAt: r.prep_at } : {}),
    ...(r.prep_edited_at ? { prepEditedAt: r.prep_edited_at } : {}),
    ...(r.prep_error ? { prepError: r.prep_error } : {}),
  };
}

/** Stored form of a field: JSON for lists and objects, 0/1 for booleans. */
function toColumn(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}

function rowToSegment(r: Row): StoredSegment {
  return { seq: r.seq, channel: r.channel, startMs: r.start_ms, endMs: r.end_ms, text: r.text, final: !!r.final, at: r.at };
}

function rowToAnswer(r: Row): MeetingAnswer {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    messageId: r.message_id,
    trigger: r.trigger,
    question: r.question,
    state: r.state,
    createdAt: r.created_at,
    ...(r.first_token_at ? { firstTokenAt: r.first_token_at } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Columns a meeting patch may set, by field. */
const COLUMNS: Partial<Record<keyof Meeting, string>> = {
  title: 'title',
  agenda: 'agenda',
  status: 'status',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  audioClientId: 'audio_client_id',
  briefMessageId: 'brief_message_id',
  notesPath: 'notes_path',
  autoAnswer: 'auto_answer',
  error: 'error',
  scheduledAt: 'scheduled_at',
  durationMin: 'duration_min',
  tz: 'tz',
  steering: 'steering',
  steeringPreset: 'steering_preset',
  answerLength: 'answer_length',
  calendarEventId: 'calendar_event_id',
  calendarId: 'calendar_id',
  reminders: 'reminders',
  autoPrep: 'auto_prep',
  prepState: 'prep_state',
  prepProgress: 'prep_progress',
  prepAt: 'prep_at',
  prepEditedAt: 'prep_edited_at',
  prepError: 'prep_error',
};

export class MeetingStore {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
    // columns of scheduled meetings, on a database made by 0.4.51 (the projects/store.ts pattern)
    const cols = new Set((db.query('PRAGMA table_info(meetings)').all() as Row[]).map((r) => r.name));
    for (const [name, type] of ADDED) if (!cols.has(name)) db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`);
    db.exec('CREATE INDEX IF NOT EXISTS meetings_upcoming ON meetings(account_id, status, scheduled_at)');
  }

  create(input: { accountId: string; sessionId: string; projectId?: string; device: string; cwd: string; title: string; agenda?: string; now?: number; status?: 'preparing' | 'scheduled'; extra?: Partial<Meeting> }): Meeting {
    const id = newId('mtg');
    this.db
      .query(
        `INSERT INTO meetings (id, account_id, session_id, project_id, device, cwd, title, agenda, status, created_at, auto_answer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'questions')`,
      )
      .run(id, input.accountId, input.sessionId, input.projectId ?? null, input.device, input.cwd, input.title, input.agenda ?? null, input.status ?? 'preparing', input.now ?? Date.now());
    return (input.extra ? this.update(id, input.extra) : this.get(id))!;
  }

  get(id: string): Meeting | undefined {
    const r = this.db.query('SELECT * FROM meetings WHERE id = ?').get(id) as Row | null;
    return r ? rowToMeeting(r) : undefined;
  }

  accountOf(id: string): string | undefined {
    return (this.db.query('SELECT account_id FROM meetings WHERE id = ?').get(id) as Row | null)?.account_id ?? undefined;
  }

  /** The account's meetings, newest first. */
  list(accountId: string, opts: { projectId?: string; limit?: number } = {}): Meeting[] {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    const rows = opts.projectId
      ? this.db.query('SELECT * FROM meetings WHERE account_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, opts.projectId, limit)
      : this.db.query('SELECT * FROM meetings WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit);
    return (rows as Row[]).map(rowToMeeting);
  }

  /**
   * The sections of the Meetings page (11.2). upcoming: soonest first;
   * past: newest first by startedAt ?? scheduledAt ?? createdAt, paged with
   * `before` on that time; now and all: newest first.
   */
  listView(accountId: string, view: MeetingView, opts: { now?: number; limit?: number; before?: number } = {}): Meeting[] {
    const now = opts.now ?? Date.now();
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    // 3 h after it should have ended (start + duration), as web time.ts staleAt and the meeting.stale job
    const notHeld = `(status IN ('scheduled', 'ready') AND audio_client_id IS NULL AND scheduled_at IS NOT NULL AND scheduled_at + COALESCE(duration_min, 0) * 60000 < $held)`;
    const p = { acct: accountId, held: now - NOT_HELD_MS, soon: now + NOW_WINDOW_MS, limit, before: opts.before ?? Number.MAX_SAFE_INTEGER };
    const key = 'COALESCE(started_at, scheduled_at, created_at)';
    let sql: string;
    if (view === 'upcoming') {
      sql = `SELECT * FROM meetings WHERE account_id = $acct AND NOT ${notHeld} AND (status = 'scheduled' OR (status = 'ready' AND scheduled_at > $soon)) ORDER BY scheduled_at ASC, created_at ASC LIMIT $limit`;
    } else if (view === 'now') {
      // a ready meeting that is late but not yet "not held" stays under Now, so it can still be opened
      sql = `SELECT * FROM meetings WHERE account_id = $acct AND NOT ${notHeld} AND (status IN ('live', 'paused', 'ending', 'preparing') OR (status = 'ready' AND (scheduled_at IS NULL OR scheduled_at <= $soon))) ORDER BY created_at DESC LIMIT $limit`;
    } else if (view === 'past') {
      sql = `SELECT * FROM meetings WHERE account_id = $acct AND (status IN ('ended', 'failed') OR ${notHeld}) AND ${key} < $before ORDER BY ${key} DESC, id DESC LIMIT $limit`;
    } else {
      sql = `SELECT * FROM meetings WHERE account_id = $acct AND created_at < $before ORDER BY created_at DESC LIMIT $limit`;
    }
    return (this.db.query(sql).all(p as never) as Row[]).map(rowToMeeting);
  }

  /** The account's meeting that is live or paused, if any. */
  running(accountId: string): Meeting | undefined {
    const r = this.db.query(`SELECT * FROM meetings WHERE account_id = ? AND status IN ('live', 'paused') LIMIT 1`).get(accountId) as Row | null;
    return r ? rowToMeeting(r) : undefined;
  }

  /** Meetings in one of these states, on every account (start-up recovery). */
  withStatus(statuses: MeetingStatus[]): Meeting[] {
    const marks = statuses.map(() => '?').join(',');
    return (this.db.query(`SELECT * FROM meetings WHERE status IN (${marks})`).all(...statuses) as Row[]).map(rowToMeeting);
  }

  /** Set fields; undefined clears a column. Returns the row after. */
  update(id: string, patch: Partial<Meeting>): Meeting | undefined {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLUMNS[k as keyof Meeting];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(toColumn(v));
    }
    if (sets.length) this.db.query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  }

  /** Move to `to` when the machine allows it from the stored status; undefined when it does not. */
  move(id: string, to: MeetingStatus, extra: Partial<Meeting> = {}): Meeting | undefined {
    const m = this.get(id);
    if (!m || !canMove(m.status, to)) return undefined;
    // back to scheduled only before any app listened
    if (to === 'scheduled' && m.audioClientId) return undefined;
    // the status in the WHERE: two moves at once cannot both pass
    const res = this.db.query('UPDATE meetings SET status = ? WHERE id = ? AND status = ?').run(to, id, m.status);
    if (!res.changes) return undefined;
    return Object.keys(extra).length ? this.update(id, extra) : this.get(id);
  }

  context(id: string): string | undefined {
    return (this.db.query('SELECT context FROM meetings WHERE id = ?').get(id) as Row | null)?.context ?? undefined;
  }

  setContext(id: string, context: string | null): void {
    this.db.query('UPDATE meetings SET context = ? WHERE id = ?').run(context, id);
  }

  // ----- prep (11.4) -----

  prepTexts(id: string): { draft?: string; edited?: string; sources?: PrepSources; extra: string[] } {
    const r = this.db.query('SELECT prep_draft, prep_edited, prep_sources, prep_extra FROM meetings WHERE id = ?').get(id) as Row | null;
    return {
      ...(r?.prep_draft ? { draft: r.prep_draft } : {}),
      ...(r?.prep_edited != null ? { edited: r.prep_edited } : {}),
      ...(r?.prep_sources ? { sources: json<PrepSources | undefined>(r.prep_sources, undefined) } : {}),
      extra: json<string[]>(r?.prep_extra, []),
    };
  }

  /** The prep the meeting uses: the owner's edit, else the newest draft. */
  prepInUse(id: string): string | undefined {
    const t = this.prepTexts(id);
    return t.edited ?? t.draft;
  }

  /** A new generated draft; the owner's edit is never touched (11.4.4). */
  setPrepDraft(id: string, draft: string, sources: PrepSources, at: number): void {
    this.db.query(`UPDATE meetings SET prep_draft = ?, prep_sources = ?, prep_at = ?, prep_state = 'done', prep_error = NULL WHERE id = ?`).run(draft, JSON.stringify(sources), at, id);
  }

  /** The owner's edit, or null to go back to the draft. */
  setPrepEdited(id: string, text: string | null, at: number): void {
    this.db.query('UPDATE meetings SET prep_edited = ?, prep_edited_at = ? WHERE id = ?').run(text, text === null ? null : at, id);
  }

  setPrepExtra(id: string, ids: string[]): void {
    this.db.query('UPDATE meetings SET prep_extra = ? WHERE id = ?').run(ids.length ? JSON.stringify(ids) : null, id);
  }

  // ----- digests (11.4.2, 3): shared by every meeting of the account -----

  digest(accountId: string, sessionId: string): { version: number; digest: string; tokensIn: number; model: string } | undefined {
    const r = this.db.query('SELECT * FROM meeting_digests WHERE account_id = ? AND session_id = ?').get(accountId, sessionId) as Row | null;
    return r ? { version: r.version, digest: r.digest, tokensIn: r.tokens_in, model: r.model } : undefined;
  }

  putDigest(accountId: string, sessionId: string, d: { version: number; digest: string; tokensIn: number; model: string }, at = Date.now()): void {
    this.db
      .query(
        `INSERT INTO meeting_digests (account_id, session_id, version, digest, tokens_in, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, session_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, tokens_in = excluded.tokens_in, model = excluded.model, created_at = excluded.created_at`,
      )
      .run(accountId, sessionId, d.version, d.digest, d.tokensIn, d.model, at);
  }

  /** A deleted session's digests (engine.deleteSession). */
  deleteDigests(sessionId: string): void {
    this.db.query('DELETE FROM meeting_digests WHERE session_id = ?').run(sessionId);
  }

  /** Digests of the account's sessions that are gone (each prep run). */
  pruneDigests(accountId: string): void {
    this.db.query('DELETE FROM meeting_digests WHERE account_id = ? AND session_id NOT IN (SELECT id FROM sessions)').run(accountId);
  }

  notes(id: string): MeetingNotes | undefined {
    return json<MeetingNotes | undefined>((this.db.query('SELECT notes FROM meetings WHERE id = ?').get(id) as Row | null)?.notes, undefined);
  }

  setNotes(id: string, notes: MeetingNotes): void {
    this.db.query('UPDATE meetings SET notes = ? WHERE id = ?').run(JSON.stringify(notes), id);
  }

  /** The newest earlier meeting of the account in the same project (projectId, else the folder) that has notes. */
  previousNotes(m: Meeting): MeetingNotes | undefined {
    const r = (
      m.projectId
        ? this.db.query('SELECT notes FROM meetings WHERE account_id = ? AND project_id = ? AND id <> ? AND notes IS NOT NULL AND created_at <= ? ORDER BY created_at DESC LIMIT 1').get(m.accountId, m.projectId, m.id, m.createdAt)
        : this.db.query('SELECT notes FROM meetings WHERE account_id = ? AND device = ? AND cwd = ? AND id <> ? AND notes IS NOT NULL AND created_at <= ? ORDER BY created_at DESC LIMIT 1').get(m.accountId, m.device, m.cwd, m.id, m.createdAt)
    ) as Row | null;
    return json<MeetingNotes | undefined>(r?.notes, undefined);
  }

  /** The notes of the account's other meetings in the same project (else folder), newest first. */
  notesOf(m: Meeting, limit: number): MeetingNotes[] {
    const rows = (
      m.projectId
        ? this.db.query('SELECT notes FROM meetings WHERE account_id = ? AND project_id = ? AND id <> ? AND notes IS NOT NULL ORDER BY created_at DESC LIMIT ?').all(m.accountId, m.projectId, m.id, limit)
        : this.db.query('SELECT notes FROM meetings WHERE account_id = ? AND device = ? AND cwd = ? AND id <> ? AND notes IS NOT NULL ORDER BY created_at DESC LIMIT ?').all(m.accountId, m.device, m.cwd, m.id, limit)
    ) as Row[];
    return rows.map((r) => json<MeetingNotes | undefined>(r.notes, undefined)).filter((n): n is MeetingNotes => !!n);
  }

  // ----- segments -----

  /**
   * Store one segment. A seq already stored as final is ignored (a retry); a
   * partial replaces the partial of its seq; a final replaces a partial.
   * Returns true when the row changed.
   */
  putSegment(meetingId: string, accountId: string, s: Segment, at: number): boolean {
    const res = this.db
      .query(
        `INSERT INTO meeting_segments (meeting_id, account_id, channel, seq, start_ms, end_ms, at, text, final)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meeting_id, channel, seq) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, at = excluded.at, text = excluded.text, final = excluded.final
         WHERE meeting_segments.final = 0`,
      )
      .run(meetingId, accountId, s.channel, s.seq, Math.round(s.startMs), Math.round(s.endMs), Math.round(at), s.text, s.final ? 1 : 0);
    return res.changes > 0;
  }

  deleteSegment(meetingId: string, channel: Channel, seq: number): void {
    this.db.query('DELETE FROM meeting_segments WHERE meeting_id = ? AND channel = ? AND seq = ?').run(meetingId, channel, seq);
  }

  /** Highest final seq per channel, -1 when none. */
  lastSeq(meetingId: string): Record<Channel, number> {
    const out: Record<Channel, number> = { me: -1, them: -1 };
    for (const r of this.db.query('SELECT channel, MAX(seq) AS m FROM meeting_segments WHERE meeting_id = ? AND final = 1 GROUP BY channel').all(meetingId) as Row[]) {
      if (r.channel === 'me' || r.channel === 'them') out[r.channel as Channel] = r.m;
    }
    return out;
  }

  /** Final segments, oldest first: the newest `limit` before `before` (hub-clock ms) when given. */
  finals(meetingId: string, opts: { before?: number; limit?: number } = {}): StoredSegment[] {
    const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 2000)));
    const rows = this.db
      .query('SELECT * FROM meeting_segments WHERE meeting_id = ? AND final = 1 AND at < ? ORDER BY at DESC, channel, seq DESC LIMIT ?')
      .all(meetingId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as Row[];
    return rows.map(rowToSegment).reverse();
  }

  /** Every final segment, oldest first (the wrap-up). */
  allFinals(meetingId: string): StoredSegment[] {
    return (this.db.query('SELECT * FROM meeting_segments WHERE meeting_id = ? AND final = 1 ORDER BY at, channel, seq').all(meetingId) as Row[]).map(rowToSegment);
  }

  // ----- answers -----

  addAnswer(a: Omit<MeetingAnswer, 'id'> & { accountId: string }): MeetingAnswer {
    const id = newId('ans');
    this.db
      .query('INSERT INTO meeting_answers (id, meeting_id, account_id, message_id, trigger, question, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.meetingId, a.accountId, a.messageId, a.trigger, a.question, a.state, a.createdAt);
    return { id, meetingId: a.meetingId, messageId: a.messageId, trigger: a.trigger, question: a.question, state: a.state, createdAt: a.createdAt };
  }

  updateAnswer(id: string, patch: Partial<Pick<MeetingAnswer, 'trigger' | 'question' | 'state' | 'firstTokenAt' | 'error'>>): MeetingAnswer | undefined {
    const cols: Record<string, string> = { trigger: 'trigger', question: 'question', state: 'state', firstTokenAt: 'first_token_at', error: 'error' };
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push((v as string | number | undefined) ?? null);
    }
    if (sets.length) this.db.query(`UPDATE meeting_answers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.answer(id);
  }

  answer(id: string): MeetingAnswer | undefined {
    const r = this.db.query('SELECT * FROM meeting_answers WHERE id = ?').get(id) as Row | null;
    return r ? rowToAnswer(r) : undefined;
  }

  answers(meetingId: string): MeetingAnswer[] {
    return (this.db.query('SELECT * FROM meeting_answers WHERE meeting_id = ? ORDER BY created_at, rowid').all(meetingId) as Row[]).map(rowToAnswer);
  }

  /** Answers left streaming by a restart: they can never finish. */
  failStreaming(meetingId: string, why: string): void {
    this.db.query(`UPDATE meeting_answers SET state = 'failed', error = ? WHERE meeting_id = ? AND state = 'streaming'`).run(why, meetingId);
  }

  /** The meeting's rows, all three tables. */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM meeting_segments WHERE meeting_id = ?').run(id);
      this.db.query('DELETE FROM meeting_answers WHERE meeting_id = ?').run(id);
      this.db.query('DELETE FROM meetings WHERE id = ?').run(id);
    })();
  }
}
