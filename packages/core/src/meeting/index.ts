/**
 * MeetingService (docs/design/MEETING-MODE.md 2.2): one per engine. A
 * meeting is a row (store.ts) and one session of kind 'meeting' that holds
 * the brief, the live answers and the wrap-up as assistant messages, so the
 * delta stream, eventVisibleTo, usage rows and budgets work unchanged. The
 * session never runs a turn (engine.send refuses it).
 */
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import { agentModelRef } from '../extensions/agent-model';
import { projectsOf } from '../projects/attached';
import { streamCompletion } from '../session/stream';
import { defuseFrameworkTags } from '../session/untrusted';
import type { Session } from '../types';
import { logger } from '../util/log';
import { Answerer, warmUp } from './answer';
import { BRIEF_PROMPT, buildContextPack, type PackSession } from './context';
import { MeetingStore, canMove, type StoredSegment } from './store';
import { isQuestion, similarity } from './trigger';
import { wrapUp } from './wrapup';
import { AGENDA_MAX, BATCHES_PER_SECOND_MAX, TITLE_MAX, type AnswerNowInput, type Channel, type CreateMeetingInput, type Meeting, type MeetingDetail, type MeetingNotes, type MeetingPatch, type SegmentAck, type SegmentBatch } from './wire';

const log = logger('meeting');

export const RUNNING_MSG = 'End the meeting that is running first.';
const WARM_EVERY_MS = 50 * 60_000;
const SESSIONS_DAYS = 14;
/** "me" echo of "them" (4.4): overlap and similarity. */
const ECHO_OVERLAP = 0.5;
const ECHO_SIMILAR = 0.7;

const attached = new WeakMap<object, MeetingService>();

export function meetingsOf(engine: object): MeetingService | undefined {
  return attached.get(engine);
}

export function attachMeetings(engine: Engine): MeetingService {
  const svc = new MeetingService(engine);
  attached.set(engine, svc);
  return svc;
}

const err = (status: number, msg: string) => new EngineError(status, msg);

/** Live state of one meeting, in memory only. */
interface Live {
  answerer: Answerer;
  /** Hub-clock start of each audio stream (batch t0 is the desktop's, display only). */
  base: number;
  recentThem: StoredSegment[];
  batches: number[];
  warm?: ReturnType<typeof setInterval>;
}

export class MeetingService {
  readonly store: MeetingStore;
  private live = new Map<string, Live>();
  private work = new Set<Promise<unknown>>();

  constructor(readonly engine: Engine) {
    this.store = new MeetingStore(engine.repos.db);
    // after a restart: nothing can still stream, and work that was half done runs again
    for (const m of this.store.withStatus(['preparing', 'ready', 'live', 'paused', 'ending'])) {
      this.store.failStreaming(m.id, 'the hub restarted');
      if (m.status === 'preparing') this.track(this.prepare(m));
      if (m.status === 'ending') this.track(this.runWrapUp(m));
    }
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => log.warn(`meeting work failed: ${(e as Error).message}`)).finally(() => this.work.delete(q));
    this.work.add(q);
  }

  /** Wait for background work (brief, wrap-up, answers): tests and shutdown. */
  async settled(): Promise<void> {
    while (this.work.size) await Promise.all([...this.work]);
    for (const l of this.live.values()) await l.answerer.settled();
  }

  stop(): void {
    for (const l of this.live.values()) {
      l.answerer.stop();
      if (l.warm) clearInterval(l.warm);
    }
    this.live.clear();
  }

  private fast(acct: string): string {
    return agentModelRef(this.engine, 'fast', this.engine.config.get().defaultModel).model;
  }

  private smart(): string {
    return agentModelRef(this.engine, 'smart', this.engine.config.get().defaultModel).model;
  }

  private emit(m: Meeting): Meeting {
    this.engine.bus.emit({ type: 'meeting.updated', sessionId: m.sessionId, meeting: m });
    return m;
  }

  /** The meeting when it is this account's; another account's reads as unknown (404). */
  get(id: string, accountId: string): Meeting {
    const m = this.store.get(id);
    if (!m || m.accountId !== accountId) throw err(404, 'Meeting not found');
    return m;
  }

  list(accountId: string, opts: { projectId?: string; limit?: number } = {}): Meeting[] {
    return this.store.list(accountId, opts);
  }

  detail(id: string, accountId: string, opts: { before?: number } = {}): MeetingDetail {
    const m = this.get(id, accountId);
    return { ...m, segments: this.store.finals(id, { before: opts.before }).map(({ at: _at, ...s }) => s), answers: this.store.answers(id) };
  }

  // ----- create and brief -----

  async create(input: CreateMeetingInput, accountId: string): Promise<Meeting> {
    if (input.agenda !== undefined && (typeof input.agenda !== 'string' || input.agenda.length > AGENDA_MAX)) throw err(400, `agenda is at most ${AGENDA_MAX} characters`);
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > TITLE_MAX)) throw err(400, `title is at most ${TITLE_MAX} characters`);
    let device = input.device;
    let cwd = input.cwd;
    let projectId = input.projectId;
    if (input.sessionId) {
      const s = this.engine.repos.sessions.get(input.sessionId);
      if (!s || (s.accountId ?? 'owner') !== accountId) throw err(404, 'Session not found');
      device = s.device ?? 'local';
      cwd = s.cwd;
      projectId = s.projectId ?? projectId;
    } else if (projectId && !cwd) {
      const p = projectsOf(this.engine)?.get(projectId);
      if (!p || (p.accountId ?? 'owner') !== accountId) throw err(404, 'Project not found');
      const loc = p.locations.find((l) => !device || l.device === device) ?? p.locations[0];
      if (!loc) throw err(400, 'This project has no folder on any device.');
      device = loc.device;
      cwd = loc.path;
    }
    if (!cwd) throw err(400, 'Give a sessionId, a projectId or a cwd: a meeting runs in a project folder.');
    device ||= 'local';
    if (this.engine.repos.devices.accountOf(device) !== accountId) throw err(403, `Device ${device} is not yours.`);
    if (this.store.running(accountId)) throw err(409, RUNNING_MSG);
    const project = projectId ? projectsOf(this.engine)?.get(projectId)?.name : undefined;
    const hm = new Date().toTimeString().slice(0, 5);
    const title = input.title?.trim() || `Meeting ${project ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''} ${hm}`.replace(/\s+/g, ' ');
    const session = await this.engine.createSession({ kind: 'meeting', title, cwd, device, model: this.fast(accountId) }, accountId, { meeting: true });
    const m = this.store.create({ accountId, sessionId: session.id, projectId, device, cwd, title, agenda: input.agenda?.trim() || undefined });
    this.emit(m);
    this.track(this.prepare(m));
    return m;
  }

  private ownerNames(accountId: string): string[] {
    const a = this.engine.people.get(accountId);
    return [a?.displayName, a?.name].filter((x): x is string => !!x);
  }

  private packSessions(m: Meeting): PackSession[] {
    const since = Date.now() - SESSIONS_DAYS * 86_400_000;
    const db = this.engine.repos.db;
    return this.engine.repos.sessions
      .list({ accountId: m.accountId, kind: 'agent', limit: 200 })
      .filter((s: Session) => s.updatedAt >= since && (m.projectId ? s.projectId === m.projectId : s.cwd === m.cwd && (s.device ?? 'local') === m.device) && s.meta?.untrusted !== true)
      .slice(0, 20)
      .map((s) => {
        const r = db.query(`SELECT content FROM memories WHERE kind = 'episode' AND source_session_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 1`).get(s.id, m.accountId) as { content?: string } | null;
        return { title: s.title, updatedAt: s.updatedAt, ...(r?.content ? { summary: r.content } : {}) };
      });
  }

  /** This project's memory only: the room may hear any of it, so no global profile or facts (8). */
  private async memoryBlock(m: Meeting, session: Session): Promise<string> {
    try {
      const hits = (await this.engine.memoryFor(m.accountId).recall(`${m.title} ${m.agenda ?? ''}`, { project: this.engine.memoryProject(session), limit: 8 })).filter((h) => h.scope === 'project');
      return hits.length ? `Recalled:\n${hits.map((h) => `- ${h.content.replace(/\s+/g, ' ')}`).join('\n')}` : '';
    } catch {
      return ''; // memory off, or no recall
    }
  }

  /** Build the pack, stream the brief, then ready and warm-up (1.2, 4.2). */
  private async prepare(m: Meeting): Promise<void> {
    const session = this.engine.repos.sessions.get(m.sessionId);
    if (!session) return;
    let pack: string;
    try {
      const machine = this.engine.machineFor(session);
      pack = await buildContextPack({
        machine,
        cwd: m.cwd,
        config: this.engine.config.get(),
        ownerName: this.ownerNames(m.accountId)[0],
        title: m.title,
        agenda: m.agenda,
        sessions: this.packSessions(m),
        tasks: this.engine.repos.tasks.list({ accountId: m.accountId }).filter((t) => t.status !== 'done' && (m.projectId ? t.project === m.projectId : !t.project)),
        memory: await this.memoryBlock(m, session),
        lastMeeting: this.store.previousNotes(m),
      });
    } catch (e) {
      const f = this.store.move(m.id, 'failed', { error: `Could not read the project: ${(e as Error).message}` });
      if (f) this.emit(f);
      return;
    }
    this.store.setContext(m.id, pack);
    const msg = this.engine.addMessage(m.sessionId, { role: 'assistant', kind: 'normal', content: [], meta: { meetingBrief: true } });
    this.store.update(m.id, { briefMessageId: msg.id });
    try {
      const res = await streamCompletion(
        this.engine,
        this.smart(),
        { system: [{ text: BRIEF_PROMPT }, { text: pack, cache: true }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Write the brief.' }] }], tools: [], thinking: { off: true }, maxTokens: 1500, cacheTtl: '1h', cacheKey: m.id },
        { sessionId: m.sessionId, accountId: m.accountId, messageId: msg.id, purpose: 'meeting-brief' },
      );
      this.engine.updateMessage(msg.id, { content: res.content.filter((b) => b.type === 'text'), usage: res.usage, stopReason: res.stopReason });
    } catch (e) {
      // a brief that failed does not stop the meeting: the pack still answers
      this.engine.updateMessage(msg.id, { content: [{ type: 'text', text: `No brief: ${(e as Error).message}` }] });
    }
    const ready = this.store.move(m.id, 'ready');
    if (!ready) return;
    this.emit(ready);
    this.track(warmUp(this.engine, this.fast(m.accountId), ready, pack));
  }

  // ----- live -----

  private liveOf(m: Meeting): Live {
    let l = this.live.get(m.id);
    if (!l) {
      l = { answerer: new Answerer(this.engine, this.store, () => this.store.get(m.id), () => this.fast(m.accountId)), base: Date.now(), recentThem: [], batches: [] };
      this.live.set(m.id, l);
    }
    return l;
  }

  private startWarm(m: Meeting, l: Live): void {
    if (l.warm) return;
    l.warm = setInterval(() => {
      const cur = this.store.get(m.id);
      if (cur?.status === 'live') this.track(warmUp(this.engine, this.fast(m.accountId), cur, this.store.context(m.id) ?? ''));
    }, WARM_EVERY_MS);
    l.warm.unref?.();
  }

  patch(id: string, patch: MeetingPatch, accountId: string): Meeting {
    const m = this.get(id, accountId);
    const set: Partial<Meeting> = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > TITLE_MAX) throw err(400, `title is 1 to ${TITLE_MAX} characters`);
      set.title = patch.title.trim();
    }
    if (patch.agenda !== undefined) {
      if (typeof patch.agenda !== 'string' || patch.agenda.length > AGENDA_MAX) throw err(400, `agenda is at most ${AGENDA_MAX} characters`);
      set.agenda = patch.agenda.trim() || undefined;
    }
    if (patch.autoAnswer !== undefined) {
      if (patch.autoAnswer !== 'questions' && patch.autoAnswer !== 'off') throw err(400, 'autoAnswer is questions or off');
      set.autoAnswer = patch.autoAnswer;
    }
    let next = m;
    if (patch.status !== undefined) {
      if (patch.status !== 'live' && patch.status !== 'paused') throw err(400, 'status is live or paused');
      if (patch.status !== m.status) {
        if (!canMove(m.status, patch.status)) throw err(409, `A meeting that is ${m.status} cannot become ${patch.status}.`);
        if (patch.status === 'live' && m.status === 'ready' && this.store.running(accountId)) throw err(409, RUNNING_MSG);
        const moved = this.store.move(id, patch.status, patch.status === 'live' && !m.startedAt ? { startedAt: Date.now() } : {});
        if (!moved) throw err(409, 'The meeting changed; try again.');
        next = moved;
        if (patch.status === 'live') this.startWarm(next, this.liveOf(next));
      }
    }
    if (Object.keys(set).length) next = this.store.update(id, set)!;
    return this.emit(next);
  }

  /**
   * Store a batch and answer at once (3.1): the trigger and the events run
   * after the ack, so the ack never waits on a model.
   */
  ingest(id: string, batch: SegmentBatch, accountId: string): SegmentAck {
    let m = this.get(id, accountId);
    if (m.status !== 'ready' && m.status !== 'live' && m.status !== 'paused') throw err(409, `The meeting is ${m.status}.`);
    if (m.audioClientId && m.audioClientId !== batch.clientId) throw err(409, 'Another app is listening to this meeting.');
    const l = this.liveOf(m);
    const now = Date.now();
    l.batches = l.batches.filter((t) => now - t < 1000);
    if (l.batches.length >= BATCHES_PER_SECOND_MAX) throw Object.assign(err(429, 'Too many batches; slow down.'), { retryAfter: 1 });
    l.batches.push(now);
    if (!m.audioClientId) {
      // the first batch binds the app, and from ready starts the meeting
      if (m.status === 'ready' && this.store.running(accountId)) throw err(409, RUNNING_MSG);
      m = (m.status === 'ready' ? this.store.move(id, 'live', { audioClientId: batch.clientId, startedAt: now }) : this.store.update(id, { audioClientId: batch.clientId })) ?? m;
      l.base = now;
      this.startWarm(m, l);
      this.emit(m);
    }
    const stored: StoredSegment[] = [];
    for (const s of batch.segments) {
      const text = defuseFrameworkTags(s.text.trim());
      if (!text) continue;
      const seg: StoredSegment = { ...s, text, at: l.base + s.startMs };
      if (seg.channel === 'me' && seg.final && this.isEcho(seg, l)) continue;
      if (!this.store.putSegment(id, m.accountId, seg, seg.at)) continue;
      stored.push(seg);
      if (seg.channel === 'them' && seg.final) {
        l.recentThem.push(seg);
        if (l.recentThem.length > 20) l.recentThem.shift();
      }
    }
    const ack: SegmentAck = { accepted: stored.length, lastSeq: this.store.lastSeq(id) };
    if (stored.length) {
      const meeting = m;
      setImmediate(() => this.afterIngest(meeting, stored, l));
    }
    return ack;
  }

  /** A "me" final that is "them" from the speakers (4.4). */
  private isEcho(me: StoredSegment, l: Live): boolean {
    const a0 = me.at;
    const a1 = me.at + (me.endMs - me.startMs);
    return l.recentThem.some((t) => {
      const b1 = t.at + (t.endMs - t.startMs);
      const overlap = Math.min(a1, b1) - Math.max(a0, t.at);
      return overlap > 0 && overlap / Math.max(1, a1 - a0) >= ECHO_OVERLAP && similarity(me.text, t.text) >= ECHO_SIMILAR;
    });
  }

  private afterIngest(m: Meeting, segs: StoredSegment[], l: Live): void {
    const names = this.ownerNames(m.accountId);
    for (const s of segs) {
      const { at: _at, ...segment } = s;
      this.engine.bus.emit({ type: 'meeting.segment', sessionId: m.sessionId, meetingId: m.id, segment });
      // trigger only on "them", never on "me" (4.3)
      if (s.channel !== 'them') continue;
      if (isQuestion(s.text, names)) l.answerer.onQuestion(s);
      else if (s.final) l.answerer.onFinalNotQuestion(s);
    }
  }

  answerNow(id: string, input: AnswerNowInput, accountId: string): { answerId: string; messageId: string } {
    const m = this.get(id, accountId);
    if (m.status !== 'live' && m.status !== 'paused') throw err(409, `The meeting is ${m.status}.`);
    if (input.question !== undefined && (typeof input.question !== 'string' || input.question.length > 2000)) throw err(400, 'question is at most 2000 characters');
    const a = this.liveOf(m).answerer.answerNow(input.question?.trim() || undefined);
    if (!a) throw err(409, 'The meeting is not live.');
    return { answerId: a.id, messageId: a.messageId };
  }

  cancelAnswer(id: string, answerId: string, accountId: string): void {
    const m = this.get(id, accountId);
    const a = this.store.answer(answerId);
    if (!a || a.meetingId !== m.id) throw err(404, 'Answer not found');
    this.live.get(m.id)?.answerer.cancel(answerId);
  }

  // ----- end -----

  end(id: string, accountId: string): Meeting {
    const m = this.get(id, accountId);
    if (m.status === 'ending' || m.status === 'ended') throw err(409, `The meeting is already ${m.status}.`);
    const next = this.store.move(id, 'ending', { endedAt: Date.now() });
    if (!next) throw err(409, `A meeting that is ${m.status} cannot end.`);
    const l = this.live.get(id);
    if (l) {
      l.answerer.stop();
      if (l.warm) clearInterval(l.warm);
      this.live.delete(id);
    }
    this.emit(next);
    this.track(this.runWrapUp(next));
    return next;
  }

  private async runWrapUp(m: Meeting): Promise<void> {
    const session = this.engine.repos.sessions.get(m.sessionId);
    if (!session) return;
    try {
      const res = await wrapUp(this.engine, m, this.store.allFinals(m.id), { model: this.smart(), machine: this.engine.machineFor(session), memoryKey: [this.engine.memoryProject(session)].flat()[0] });
      this.store.setNotes(m.id, res.notes);
      this.engine.addMessage(m.sessionId, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: res.notes.markdown }], meta: { meetingNotes: true } });
      const ended = this.store.move(m.id, 'ended', res.notesPath ? { notesPath: res.notesPath } : {});
      this.engine.bus.emit({ type: 'meeting.notes', sessionId: m.sessionId, meetingId: m.id, notes: res.notes });
      if (ended) this.emit(ended);
    } catch (e) {
      const f = this.store.move(m.id, 'failed', { error: `Wrap-up failed: ${(e as Error).message}` });
      if (f) this.emit(f);
    }
  }

  notes(id: string, accountId: string): MeetingNotes {
    this.get(id, accountId);
    const n = this.store.notes(id);
    if (!n) throw err(404, 'This meeting is not wrapped up yet.');
    return n;
  }

  /** Rows, the session, its messages and its memory episode; the notes file and the tasks stay. */
  async delete(id: string, accountId: string): Promise<void> {
    const m = this.get(id, accountId);
    // paused still captures on the desktop; ending still writes the notes, tasks and episode
    if (m.status === 'live' || m.status === 'paused') throw err(409, 'End the meeting before you delete it.');
    if (m.status === 'ending') throw err(409, 'The notes are still being written; delete the meeting when they are done.');
    const l = this.live.get(id);
    l?.answerer.stop();
    if (l?.warm) clearInterval(l.warm);
    this.live.delete(id);
    this.store.delete(id);
    const mem = this.engine.memoryFor(m.accountId);
    const eps = this.engine.repos.db.query(`SELECT id FROM memories WHERE account_id = ? AND source_session_id = ?`).all(m.accountId, m.sessionId) as { id: string }[];
    for (const e of eps) await mem.remove(e.id);
    await this.engine.deleteSession(m.sessionId).catch(() => {});
  }

  /** Whose meeting (route-policy OWNERS). */
  accountOf(id: string): string | undefined {
    return this.store.accountOf(id);
  }

  lastSeqs(id: string): Record<Channel, number> {
    return this.store.lastSeq(id);
  }
}
