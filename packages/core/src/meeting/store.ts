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
import type { Channel, Meeting, MeetingAnswer, MeetingNotes, MeetingStatus, Segment } from './wire';

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
`;

/** Status changes the hub allows; anything else is a 409. */
const MOVES: Record<MeetingStatus, MeetingStatus[]> = {
  preparing: ['ready', 'ending', 'failed'],
  ready: ['live', 'ending', 'failed'],
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
  };
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
};

export class MeetingStore {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
  }

  create(input: { accountId: string; sessionId: string; projectId?: string; device: string; cwd: string; title: string; agenda?: string; now?: number }): Meeting {
    const id = newId('mtg');
    this.db
      .query(
        `INSERT INTO meetings (id, account_id, session_id, project_id, device, cwd, title, agenda, status, created_at, auto_answer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, 'questions')`,
      )
      .run(id, input.accountId, input.sessionId, input.projectId ?? null, input.device, input.cwd, input.title, input.agenda ?? null, input.now ?? Date.now());
    return this.get(id)!;
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
      vals.push((v as string | number | undefined) ?? null);
    }
    if (sets.length) this.db.query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  }

  /** Move to `to` when the machine allows it from the stored status; undefined when it does not. */
  move(id: string, to: MeetingStatus, extra: Partial<Meeting> = {}): Meeting | undefined {
    const m = this.get(id);
    if (!m || !canMove(m.status, to)) return undefined;
    // the status in the WHERE: two moves at once cannot both pass
    const res = this.db.query('UPDATE meetings SET status = ? WHERE id = ? AND status = ?').run(to, id, m.status);
    if (!res.changes) return undefined;
    return Object.keys(extra).length ? this.update(id, extra) : this.get(id);
  }

  context(id: string): string | undefined {
    return (this.db.query('SELECT context FROM meetings WHERE id = ?').get(id) as Row | null)?.context ?? undefined;
  }

  setContext(id: string, context: string): void {
    this.db.query('UPDATE meetings SET context = ? WHERE id = ?').run(context, id);
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
