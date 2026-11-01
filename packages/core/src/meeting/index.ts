/**
 * MeetingService (docs/design/MEETING-MODE.md 2.2): one per engine. A
 * meeting is a row (store.ts) and one session of kind 'meeting' that holds
 * the brief, the live answers and the wrap-up as assistant messages, so the
 * delta stream, eventVisibleTo, usage rows and budgets work unchanged. The
 * session never runs a turn (engine.send refuses it).
 */
import { assistantFor } from '../assistant/registry';
import { addDays, atLocal, hubZone, localDate, validZone } from '../assistant/time';
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import { agentModelRef } from '../extensions/agent-model';
import { pimFor } from '../pim/registry';
import { projectsOf } from '../projects/attached';
import { streamCompletion } from '../session/stream';
import { defuseFrameworkTags } from '../session/untrusted';
import type { Session } from '../types';
import { logger } from '../util/log';
import { Answerer, warmUp } from './answer';
import { BRIEF_PROMPT, buildContextPack, type PackSession } from './context';
import { fileText } from './files';
import { defaultLiveModel, modelOptions, speedOf } from './models';
import { buildPrep } from './prep';
import { STT_SECRETS, SttError, mintSttToken, sttChoice } from './stt';
import { MeetingStore, NOW_WINDOW_MS, canMove, type MeetingView, type StoredSegment } from './store';
import { isQuestion, similarity } from './trigger';
import { chatContext, memoryText, wrapUp } from './wrapup';
import {
  AGENDA_MAX,
  BATCHES_PER_SECOND_MAX,
  MEETING_FILE_BYTES_MAX,
  MEETING_FILES_MAX,
  PREP_EXTRA_MAX,
  PREP_MAX,
  REMINDER_CHOICES,
  STEERING_MAX,
  STEERING_PRESETS,
  TITLE_MAX,
  type AnswerNowInput,
  type Channel,
  type CreateMeetingInput,
  type Meeting,
  type MeetingChatInput,
  type MeetingDetail,
  type MeetingFile,
  type MeetingFolder,
  type MeetingModelOption,
  type MeetingNotes,
  type MeetingPatch,
  type PrepProgress,
  type PrepView,
  type ScheduleFields,
  type SegmentAck,
  type SegmentBatch,
  type SttTestResult,
  type SttToken,
} from './wire';

const log = logger('meeting');

export const RUNNING_MSG = 'End the meeting that is running first.';
/** Keep the prompt cache warm while live: under the 5-minute TTL providers that ignore the 1 h one use. */
const WARM_EVERY_MS = 4 * 60_000;
const MODELS_TTL_MS = 5 * 60_000;
/** "them" finals within this long of each other may be one question split by the speech model. */
const JOIN_WINDOW_MS = 10_000;
const JOIN_MAX = 3;
/** A lead-in with no end punctuation this close before a question is part of it. */
const JOIN_GAP_MS = 2500;
const MODEL_REF_MAX = 200;
const SESSIONS_DAYS = 14;
const MIN = 60_000;
const DAY = 1440 * MIN;
/** Scheduled at least this far ahead, at most SCHEDULE_MAX_MS (11.3). */
const SCHEDULE_MIN_MS = 5 * MIN;
const SCHEDULE_MAX_MS = 365 * DAY;
const ARM_BEFORE_MS = 10 * MIN;
const STALE_AFTER_MS = 3 * 60 * MIN;
const AUTOPREP_AT = '19:00';
const FOLDERS_MAX = 300;

/** Durable job kinds (11.5, 11.4.3); each meeting's have dedupeKey meeting:<id>:<kind>, the prep meeting-prep:<id>. */
export const JOBS = { prep: 'meeting.prep', remind: 'meeting.remind', autoprep: 'meeting.autoprep', arm: 'meeting.arm', due: 'meeting.due', stale: 'meeting.stale' } as const;
const jobKey = (id: string, kind: string) => `meeting:${id}:${kind}`;
const prepKey = (id: string) => `meeting-prep:${id}`;
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
  /** "them" finals since the last answered question, for joining a split question. */
  fragments: StoredSegment[];
  batches: number[];
  warm?: ReturnType<typeof setInterval>;
}

export class MeetingService {
  readonly store: MeetingStore;
  private live = new Map<string, Live>();
  private work = new Set<Promise<unknown>>();
  /** Prep runs in this process, for cancel. */
  private preps = new Map<string, AbortController>();
  /** The answer model picker per account, for the default rule (liveModel stays sync). */
  private models = new Map<string, { at: number; list: MeetingModelOption[] }>();

  constructor(readonly engine: Engine) {
    this.store = new MeetingStore(engine.repos.db);
    // registered like scheduler/routines.ts: a hub restart runs what was due or half done
    const s = engine.scheduler;
    s.handle(JOBS.prep, (p) => this.runPrep(String(p.meetingId), p.approve === true, p.auto === true));
    s.handle(JOBS.remind, (p) => this.remind(String(p.meetingId), Number(p.minutes)));
    s.handle(JOBS.autoprep, (p) => this.autoPrep(String(p.meetingId)));
    s.handle(JOBS.arm, async (p) => this.armJob(String(p.meetingId)));
    s.handle(JOBS.due, async (p) => this.due(String(p.meetingId)));
    s.handle(JOBS.stale, async (p) => this.stale(String(p.meetingId)));
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

  /** GET /api/meetings/models: the models the account can use, fastest first. */
  async modelList(accountId: string): Promise<MeetingModelOption[]> {
    const hit = this.models.get(accountId);
    if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.list;
    const list = modelOptions(await this.engine.listModels(accountId), (r) => this.engine.isUsable(r, accountId));
    this.models.set(accountId, { at: Date.now(), list });
    return list;
  }

  /**
   * The model live answers use: the meeting's pick, else models.tiers.fast,
   * else the fastest usable Haiku or Gemini Flash; anything slower comes
   * with a note the meeting page shows (never silently a slow model).
   */
  liveModel(m: Meeting): { ref: string; note?: string } {
    const usable = (r: string) => this.engine.isUsable(r, m.accountId);
    if (m.answerModel && usable(m.answerModel)) return { ref: m.answerModel };
    const gone = m.answerModel ? `${m.answerModel} cannot be used now. ` : '';
    const pick = defaultLiveModel(this.models.get(m.accountId)?.list ?? [], this.engine.config.get().models?.tiers?.fast, usable);
    if (pick) return { ref: pick, ...(gone ? { note: `${gone}Using ${pick}.` } : {}) };
    const fb = this.fast(m.accountId);
    const speed = speedOf(fb.slice(fb.lastIndexOf('/') + 1));
    if (speed === 'fastest' || speed === 'fast') return { ref: fb, ...(gone ? { note: `${gone}Using ${fb}.` } : {}) };
    return { ref: fb, note: `${gone}No fast model (Haiku or Gemini Flash) is set up, so live answers use ${fb} and may be slow. Pick a faster answer model for this meeting.` };
  }

  /** Check an answerModel field: a ref the account can use; null or '' clears it. */
  private answerModelField(v: unknown, accountId: string): string | undefined {
    if (v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > MODEL_REF_MAX) throw Object.assign(err(400, 'answerModel must be a model ref'), { field: 'answerModel' });
    if (!this.engine.isUsable(v, accountId)) throw Object.assign(err(400, `You cannot use ${v.slice(0, MODEL_REF_MAX)}. Pick one from the list.`), { field: 'answerModel' });
    return v;
  }

  /** Warm the cache with the model and pack the answers will use. */
  private async warm(m: Meeting, pack?: string): Promise<void> {
    await this.modelList(m.accountId).catch(() => []);
    await warmUp(this.engine, this.liveModel(m).ref, m, pack ?? this.store.context(m.id) ?? '');
  }

  // ----- cloud speech to text -----

  /** The account's key for a speech service: its own value (a member's own file, the hub's for the owner). */
  private sttKey(accountId: string, p: keyof typeof STT_SECRETS): string | undefined {
    return this.engine.accountSecrets.value(accountId, STT_SECRETS[p]);
  }

  /** POST /:id/stt-token: a short-lived streaming credential; 409 when the service has no key. */
  async sttToken(id: string, accountId: string): Promise<SttToken> {
    const m = this.get(id, accountId);
    if (m.status === 'ending' || m.status === 'ended' || m.status === 'failed' || m.status === 'scheduled') throw err(409, `The meeting is ${m.status}.`);
    const choice = sttChoice(this.engine.config.get().meetings?.stt, (p) => this.sttKey(accountId, p));
    if (choice === 'local') throw err(409, 'Speech to text runs on this device: no AssemblyAI or Deepgram key is set (Settings > Meetings).');
    const key = this.sttKey(accountId, choice);
    if (!key) throw err(409, `No ${choice === 'assemblyai' ? 'AssemblyAI' : 'Deepgram'} key is set (Settings > Meetings). Using speech to text on this device.`);
    try {
      return await mintSttToken(choice, key);
    } catch (e) {
      // 502, not 409: the desktop app reads 409 as "no key" and falls back without saying why (upload.rs stt_token)
      if (e instanceof SttError) throw err(502, e.message);
      throw e;
    }
  }

  /** POST /stt-test: mint one token on the saved key, as the desktop app would; 409 without a key. */
  async sttTest(provider: unknown, accountId: string): Promise<SttTestResult> {
    if (provider !== 'assemblyai' && provider !== 'deepgram') throw err(400, 'provider is assemblyai or deepgram');
    const name = provider === 'assemblyai' ? 'AssemblyAI' : 'Deepgram';
    const key = this.sttKey(accountId, provider);
    if (!key) throw err(409, `No ${name} key is saved (Settings > Meetings).`);
    const t0 = Date.now();
    try {
      await mintSttToken(provider, key);
    } catch (e) {
      if (e instanceof SttError) return { ok: false, message: e.message, ms: Date.now() - t0 };
      throw e;
    }
    const ms = Date.now() - t0;
    return { ok: true, message: `Works. ${name} sent a streaming token in ${ms} ms.`, ms };
  }

  // ----- files attached to a meeting -----

  async addFile(id: string, file: { name: string; type?: string; bytes: Uint8Array }, accountId: string): Promise<MeetingFile> {
    const m = this.get(id, accountId);
    if (m.status === 'ending' || m.status === 'ended') throw err(409, `The meeting is ${m.status}.`);
    if (this.store.files(id).length >= MEETING_FILES_MAX) throw err(400, `A meeting holds at most ${MEETING_FILES_MAX} files.`);
    if (file.bytes.length > MEETING_FILE_BYTES_MAX) throw err(413, `A file is at most ${MEETING_FILE_BYTES_MAX / 1024 / 1024} MB.`);
    const name = file.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || 'file';
    const t = await fileText(name, file.type, file.bytes);
    const f = this.store.addFile({ meetingId: id, accountId, name, mediaType: t.mediaType, size: file.bytes.length, text: t.text, ...(t.note ? { note: t.note } : {}) });
    this.refreshPack(id, true);
    return f;
  }

  deleteFile(id: string, fileId: string, accountId: string): void {
    this.get(id, accountId);
    if (!this.store.deleteFile(id, fileId)) throw err(404, 'File not found');
    this.refreshPack(id, true);
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

  list(accountId: string, opts: { projectId?: string; limit?: number; view?: MeetingView; before?: number } = {}): Meeting[] {
    if (opts.view && !opts.projectId) return this.store.listView(accountId, opts.view, { limit: opts.limit, before: opts.before });
    return this.store.list(accountId, opts);
  }

  /** The owner's zone for an account (prefs.timezone), else the hub's. */
  zone(accountId: string): string {
    try {
      return assistantFor(this.engine, accountId)?.zone() ?? hubZone();
    } catch {
      return hubZone();
    }
  }

  /** Check the scheduling and steering fields of a create or patch; returns the columns to set. */
  private scheduleFields(input: ScheduleFields, accountId: string, now = Date.now()): Partial<Meeting> {
    const bad = (field: string, msg: string) => Object.assign(err(400, msg), { field });
    const set: Partial<Meeting> = {};
    if (input.scheduledAt !== undefined) {
      if (!Number.isSafeInteger(input.scheduledAt)) throw bad('scheduledAt', 'scheduledAt must be a time in epoch ms');
      if (input.scheduledAt < now + SCHEDULE_MIN_MS) throw bad('scheduledAt', 'Pick a time at least 5 minutes from now.');
      if (input.scheduledAt > now + SCHEDULE_MAX_MS) throw bad('scheduledAt', 'Pick a time within the next 365 days.');
      set.scheduledAt = input.scheduledAt;
    }
    if (input.durationMin !== undefined) {
      if (input.durationMin !== null && (!Number.isInteger(input.durationMin) || input.durationMin < 15 || input.durationMin > 480)) throw bad('durationMin', 'durationMin is 15 to 480 minutes');
      set.durationMin = input.durationMin ?? undefined;
    }
    if (input.tz !== undefined) {
      if (!validZone(input.tz)) throw bad('tz', `Unknown time zone: ${String(input.tz).slice(0, 60)}`);
      set.tz = input.tz;
    } else if (set.scheduledAt !== undefined) set.tz = this.zone(accountId);
    if (input.steering !== undefined) {
      if (typeof input.steering !== 'string' || input.steering.length > STEERING_MAX) throw bad('steering', `steering is at most ${STEERING_MAX} characters`);
      set.steering = input.steering.trim() || undefined;
    }
    if (input.steeringPreset !== undefined) {
      if (typeof input.steeringPreset !== 'string' || (input.steeringPreset !== 'custom' && !STEERING_PRESETS.some((p) => p.id === input.steeringPreset))) throw bad('steeringPreset', 'steeringPreset is a preset id or custom');
      set.steeringPreset = input.steeringPreset;
    }
    if (input.answerLength !== undefined) {
      if (input.answerLength !== 'short' && input.answerLength !== 'long') throw bad('answerLength', 'answerLength is short or long');
      set.answerLength = input.answerLength;
    }
    for (const k of ['calendarEventId', 'calendarId'] as const) {
      if (input[k] === undefined) continue;
      if (input[k] !== null && (typeof input[k] !== 'string' || input[k]!.length > 300)) throw bad(k, `${k} must be a string`);
      set[k] = input[k] || undefined;
    }
    if (input.reminders !== undefined) {
      if (!Array.isArray(input.reminders) || input.reminders.some((r) => !(REMINDER_CHOICES as readonly number[]).includes(r))) throw bad('reminders', `reminders are minutes, some of ${REMINDER_CHOICES.join(', ')}`);
      set.reminders = [...new Set(input.reminders)].sort((a, b) => b - a);
    }
    if (input.autoPrep !== undefined) {
      if (typeof input.autoPrep !== 'boolean') throw bad('autoPrep', 'autoPrep is true or false');
      set.autoPrep = input.autoPrep;
    }
    return set;
  }

  // ----- scheduled jobs (11.5) -----

  private cancelJobs(id: string): void {
    const s = this.engine.scheduler;
    for (const r of REMINDER_CHOICES) s.cancel(jobKey(id, `remind:${r}`));
    for (const k of ['autoprep', 'arm', 'due', 'stale']) s.cancel(jobKey(id, k));
  }

  /** Cancel the meeting's jobs and enqueue them again from its start time. */
  private scheduleJobs(m: Meeting, now = Date.now()): void {
    this.cancelJobs(m.id);
    if (m.status !== 'scheduled' || !m.scheduledAt) return;
    const s = this.engine.scheduler;
    const start = m.scheduledAt;
    const payload = { meetingId: m.id };
    for (const min of m.reminders ?? []) {
      const at = start - min * MIN;
      if (at > now) s.enqueue(JOBS.remind, at, { ...payload, minutes: min }, jobKey(m.id, `remind:${min}`));
    }
    if (m.autoPrep !== false) {
      const tz = m.tz ?? this.zone(m.accountId);
      const at = atLocal(addDays(localDate(start, tz), -1), AUTOPREP_AT, tz);
      // past 19:00 already: the 1-day reminder says "Not prepared" instead
      if (at > now) s.enqueue(JOBS.autoprep, at, payload, jobKey(m.id, 'autoprep'));
    }
    s.enqueue(JOBS.arm, Math.max(now, start - ARM_BEFORE_MS), payload, jobKey(m.id, 'arm'));
    s.enqueue(JOBS.due, start, payload, jobKey(m.id, 'due'));
    s.enqueue(JOBS.stale, start + (m.durationMin ?? 0) * MIN + STALE_AFTER_MS, payload, jobKey(m.id, 'stale'));
    s.poke();
  }

  private whenText(m: Meeting): string {
    if (!m.scheduledAt) return '';
    const tz = m.tz ?? this.zone(m.accountId);
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return f.format(new Date(m.scheduledAt)).replace(',', '');
  }

  private folderName(m: Meeting): string {
    if (!m.cwd && !m.projectId) return 'No folder';
    return (m.projectId ? projectsOf(this.engine)?.get(m.projectId)?.name : undefined) ?? m.cwd.split(/[\\/]/).filter(Boolean).pop() ?? m.cwd;
  }

  private async remind(id: string, minutes: number, now = Date.now()): Promise<void> {
    const m = this.store.get(id);
    if (!m || !m.scheduledAt || (m.status !== 'scheduled' && m.status !== 'ready')) return;
    const start = m.scheduledAt;
    // run late (the hub was down): nothing once it started, and only the newest of reminders that are all due
    if (now >= start) return;
    if ((m.reminders ?? []).some((r) => r < minutes && start - r * MIN <= now)) return;
    // no notices while another meeting of the account is live (7.6)
    const live = this.store.running(m.accountId);
    if (live && live.id !== id) return;
    const prepared = m.prepState === 'done' || !!this.store.prepInUse(id);
    // from the time actually left, so a late reminder never says "in 15 min" when it is 4
    const left = Math.max(1, Math.round((start - now) / MIN));
    const when = minutes >= 1440 && left >= 1380 ? 'tomorrow' : left >= 60 ? `in ${Math.round(left / 60)} h` : `in ${left} min`;
    let moved = '';
    if (minutes >= 1440 && m.calendarEventId) {
      const at = await this.calendarStart(m).catch(() => undefined);
      if (at !== undefined && at !== m.scheduledAt) moved = ` · The calendar event moved to ${this.whenText({ ...m, scheduledAt: at })}.`;
    }
    await this.engine.notifier.send({
      title: `${m.title} ${when}`,
      body: `${this.whenText(m)} · ${this.folderName(m)} · ${prepared ? 'Prepared' : 'Not prepared: tap to prepare'}${moved}`,
      level: 'info',
      link: `/meetings/${id}`,
      sessionId: m.sessionId,
      accountId: m.accountId,
      // forced: it reaches the phone even while a Conclave window is in use (11.5, alert: true)
    }, { force: true });
  }

  /** The linked calendar event's start now, or undefined when it cannot be read. */
  private async calendarStart(m: Meeting): Promise<number | undefined> {
    const pim = pimFor(this.engine, m.accountId);
    if (!pim || !m.scheduledAt || !m.calendarEventId) return undefined;
    const { events } = await pim.events({ start: m.scheduledAt - 7 * DAY, end: m.scheduledAt + 7 * DAY, ...(m.calendarId ? { calendars: [m.calendarId] } : {}) });
    return events.find((e) => e.id === m.calendarEventId)?.start;
  }

  private async autoPrep(id: string): Promise<void> {
    const m = this.store.get(id);
    if (!m || m.status !== 'scheduled' || m.autoPrep === false) return;
    if (m.prepState !== 'none' && m.prepState !== 'failed') return;
    this.queuePrep(m, { auto: true });
  }

  private armJob(id: string): void {
    const m = this.store.get(id);
    if (m?.status === 'scheduled') this.armNow(m);
  }

  private due(id: string, now = Date.now()): void {
    const m = this.store.get(id);
    if (!m || (m.status !== 'scheduled' && m.status !== 'ready' && m.status !== 'preparing')) return;
    // run late (the hub was down): "starts now" only within the Now window
    if (m.scheduledAt && now > m.scheduledAt + NOW_WINDOW_MS) return;
    void this.engine.notifier.send({ title: `${m.title} starts now`, body: `${this.folderName(m)}`, level: 'info', link: `/meetings/${id}?open=1`, sessionId: m.sessionId, accountId: m.accountId }, { force: true }).catch(() => {});
    this.engine.bus.emit({ type: 'meeting.due', sessionId: m.sessionId, meetingId: m.id });
  }

  /** Never held: the row stays (Past, "Not held"); the pack goes, the prep stays. */
  private stale(id: string): void {
    const m = this.store.get(id);
    if (!m || m.startedAt || (m.status !== 'scheduled' && m.status !== 'ready')) return;
    this.store.setContext(id, null);
  }

  /** scheduled -> preparing -> ready: the pack, then the warm-up (11.5 meeting.arm). */
  private armNow(m: Meeting): Meeting {
    const next = this.store.move(m.id, 'preparing');
    if (!next) throw err(409, 'The meeting changed; try again.');
    this.emit(next);
    this.track(this.prepare(next));
    return next;
  }

  /** POST /:id/arm: build the pack now, so the overlay can open it. */
  arm(id: string, accountId: string): Meeting {
    const m = this.get(id, accountId);
    if (m.status !== 'scheduled') throw err(409, `The meeting is ${m.status}, not scheduled.`);
    if (this.store.running(accountId)) throw err(409, RUNNING_MSG);
    this.engine.scheduler.cancel(jobKey(id, 'arm'));
    return this.armNow(m);
  }

  // ----- prep (11.4) -----

  private prepEvent(m: Meeting): void {
    this.engine.bus.emit({ type: 'meeting.prep', sessionId: m.sessionId, meetingId: m.id, state: m.prepState ?? 'none', ...(m.prepProgress ? { progress: m.prepProgress } : {}) });
  }

  private setPrep(id: string, patch: Partial<Meeting>): Meeting | undefined {
    const m = this.store.update(id, patch);
    if (m) {
      this.prepEvent(m);
      this.emit(m);
    }
    return m;
  }

  private queuePrep(m: Meeting, opts: { approve?: boolean; auto?: boolean } = {}): void {
    this.setPrep(m.id, { prepState: 'queued', prepError: undefined });
    this.engine.scheduler.enqueue(JOBS.prep, Date.now(), { meetingId: m.id, ...(opts.approve ? { approve: true } : {}), ...(opts.auto ? { auto: true } : {}) }, prepKey(m.id));
    this.engine.scheduler.poke();
  }

  prepView(id: string, accountId: string): PrepView {
    const m = this.get(id, accountId);
    const t = this.store.prepTexts(id);
    return {
      state: m.prepState ?? 'none',
      ...(m.prepProgress ? { progress: m.prepProgress } : {}),
      ...(t.draft ? { draft: t.draft } : {}),
      ...(t.edited !== undefined ? { edited: t.edited } : {}),
      ...(m.prepAt ? { at: m.prepAt } : {}),
      ...(m.prepEditedAt ? { editedAt: m.prepEditedAt } : {}),
      ...(t.sources ? { sources: t.sources } : {}),
      ...(m.prepError ? { error: m.prepError } : {}),
      ...(m.prepState === 'waiting' && m.prepProgress?.estimate ? { estimate: m.prepProgress.estimate } : {}),
      ...(t.extra.length ? { extra: t.extra } : {}),
    };
  }

  /** POST /:id/prep: queue a run (approve: the owner's OK for a big one). */
  startPrep(id: string, accountId: string, opts: { approve?: boolean } = {}): { state: 'queued' } {
    const m = this.get(id, accountId);
    if (m.prepState === 'queued' || m.prepState === 'running') throw err(409, 'The prep is already running.');
    if (opts.approve && m.prepState !== 'waiting') throw err(409, 'Nothing is waiting for your OK.');
    if (m.cwd && this.engine.repos.devices.accountOf(m.device) !== accountId) throw err(403, `Device ${m.device} is not yours.`);
    this.queuePrep(m, opts);
    return { state: 'queued' };
  }

  /** POST /:id/prep/cancel: stop the calls; the digests done so far stay. */
  cancelPrep(id: string, accountId: string): void {
    const m = this.get(id, accountId);
    if (m.prepState !== 'queued' && m.prepState !== 'running' && m.prepState !== 'waiting') throw err(409, 'No prep is running.');
    this.engine.scheduler.cancel(prepKey(id));
    this.preps.get(id)?.abort();
    this.setPrep(id, { prepState: 'cancelled', prepProgress: undefined });
  }

  /** PUT /:id/prep: the owner's version, used from now on (11.4.4). */
  editPrep(id: string, markdown: unknown, accountId: string): PrepView {
    this.get(id, accountId);
    if (typeof markdown !== 'string') throw Object.assign(err(400, 'markdown must be a string'), { field: 'markdown' });
    if (markdown.length > PREP_MAX) throw Object.assign(err(400, `The prep is at most ${PREP_MAX.toLocaleString('en-US')} characters.`), { field: 'markdown' });
    this.store.setPrepEdited(id, markdown, Date.now());
    const m = this.store.get(id)!;
    this.emit(m);
    this.refreshPack(id);
    return this.prepView(id, accountId);
  }

  /** DELETE /:id/prep/edit: back to the draft. */
  revertPrep(id: string, accountId: string): void {
    this.get(id, accountId);
    this.store.setPrepEdited(id, null, Date.now());
    this.emit(this.store.get(id)!);
    this.refreshPack(id);
  }

  /** PUT /:id/prep/extra: the ticked claude.ai and ChatGPT chats; each must be the account's chat. */
  setPrepExtra(id: string, sessionIds: unknown, accountId: string): void {
    this.get(id, accountId);
    if (!Array.isArray(sessionIds) || sessionIds.length > PREP_EXTRA_MAX || sessionIds.some((s) => typeof s !== 'string')) throw Object.assign(err(400, `sessionIds is a list of at most ${PREP_EXTRA_MAX} ids`), { field: 'sessionIds' });
    for (const sid of sessionIds as string[]) {
      const s = this.engine.repos.sessions.get(sid);
      if (!s || (s.accountId ?? 'owner') !== accountId || s.kind !== 'chat') throw err(404, 'Session not found');
    }
    this.store.setPrepExtra(id, [...new Set(sessionIds as string[])]);
  }

  /** The prep job (kind meeting.prep). Never throws: a failed prep is a state, not a retry. */
  private async runPrep(id: string, approve: boolean, auto: boolean): Promise<void> {
    const m = this.store.get(id);
    if (!m || m.prepState === 'cancelled') return;
    const session = this.engine.repos.sessions.get(m.sessionId);
    if (!session) return;
    // checked again here: a device can be removed after scheduling
    if (m.cwd && this.engine.repos.devices.accountOf(m.device) !== m.accountId) {
      this.setPrep(id, { prepState: 'failed', prepError: `Device ${m.device} is not yours.`, prepProgress: undefined });
      return;
    }
    const ctl = new AbortController();
    this.preps.set(id, ctl);
    this.setPrep(id, { prepState: 'running', prepError: undefined });
    const deviceName = this.engine.devices.list(m.accountId).find((d) => d.id === m.device)?.name ?? m.device;
    let last = 0;
    try {
      const res = await buildPrep({
        engine: this.engine,
        store: this.store,
        meeting: m,
        fast: this.fast(m.accountId),
        smart: this.smart(),
        approve,
        signal: ctl.signal,
        machine: m.cwd && this.engine.devices.isOnline(m.device) ? this.engine.machineFor(session) : undefined,
        deviceName,
        steering: m.steering,
        files: this.store.fileTexts(id),
        memory: () => this.memoryBlock(m, session, 20),
        price: (model) => {
          const info = this.engine.providersFor(m.accountId).resolve(model).info;
          return info.inputPrice ? { input: info.inputPrice, output: info.outputPrice } : undefined;
        },
        progress: (p: PrepProgress) => {
          last = Date.now();
          this.setPrep(id, { prepProgress: p });
        },
      });
      void last;
      if (res.state === 'waiting') {
        this.setPrep(id, { prepState: 'waiting', prepProgress: { phase: 'waiting-approval', done: 0, total: res.estimate.sessions, startedAt: Date.now(), leftOut: 0, estimate: res.estimate } });
        if (auto) {
          const tokens = res.estimate.tokens >= 1e6 ? `${(res.estimate.tokens / 1e6).toFixed(1)}M` : `${Math.round(res.estimate.tokens / 1000)}k`;
          void this.engine.notifier.send({ title: `Prep for ${m.title} needs your OK (${tokens} tokens)`, body: `${res.estimate.sessions} chats on ${this.folderName(m)}`, level: 'info', link: `/meetings/${id}`, sessionId: m.sessionId, accountId: m.accountId }).catch(() => {});
        }
        return;
      }
      if (this.store.get(id)?.prepState === 'cancelled') return;
      this.store.setPrepDraft(id, res.draft, res.sources, Date.now());
      this.setPrep(id, { prepProgress: undefined });
      this.refreshPack(id);
    } catch (e) {
      const msg = (e as Error).message;
      if (ctl.signal.aborted || msg === 'cancelled') this.setPrep(id, { prepState: 'cancelled', prepProgress: undefined });
      else this.setPrep(id, { prepState: 'failed', prepError: msg.slice(0, 500), prepProgress: undefined });
    } finally {
      this.preps.delete(id);
    }
  }

  // ----- pickers (11.3.1, 11.3.2) -----

  /** The account's device and folder pairs: project locations and the folders of its agent sessions. */
  folders(accountId: string, q = ''): MeetingFolder[] {
    const db = this.engine.repos.db;
    const groups = db
      .query(
        `SELECT COALESCE(device, 'local') AS device, cwd, COUNT(*) AS n, MAX(updated_at) AS last FROM sessions
         WHERE account_id = ? AND (kind IS NULL OR kind NOT IN ('chat', 'meeting')) GROUP BY COALESCE(device, 'local'), cwd`,
      )
      .all(accountId) as Array<{ device: string; cwd: string; n: number; last: number }>;
    const devices = new Map(this.engine.devices.list(accountId).map((d) => [d.id, d]));
    const out = new Map<string, MeetingFolder>();
    const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
    const add = (device: string, cwd: string, extra: Partial<MeetingFolder> = {}) => {
      const path = trim(cwd);
      if (!path || path === '~' || path === '/' || /^[A-Za-z]:\\?$/.test(path)) return;
      // a folder of another account's device never shows (8)
      if (this.engine.repos.devices.accountOf(device) !== accountId) return;
      const key = `${device}\n${path}`;
      const cur = out.get(key);
      if (cur) return void Object.assign(cur, extra);
      let chats = 0;
      let lastAt = 0;
      for (const g of groups) {
        if (g.device !== device) continue;
        const c = trim(g.cwd);
        if (c === path || c.startsWith(`${path}/`) || c.startsWith(`${path}\\`)) {
          chats += g.n;
          lastAt = Math.max(lastAt, g.last);
        }
      }
      const d = devices.get(device);
      out.set(key, { device, deviceName: d?.name ?? device, online: this.engine.devices.isOnline(device), cwd: path, chats, lastAt, ...extra });
    };
    for (const p of projectsOf(this.engine)?.list(accountId) ?? []) for (const l of p.locations) add(l.device, l.path, { projectId: p.id, projectName: p.name });
    for (const g of groups) add(g.device, g.cwd);
    const needle = q.trim().toLowerCase();
    return [...out.values()]
      .filter((f) => !needle || [f.cwd, f.projectName ?? '', f.deviceName].some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, FOLDERS_MAX);
  }

  /** The account's calendar events in a range, as the picker needs them (event text is shown, never prompted). */
  async calendar(accountId: string, range: { start: number; end: number }): Promise<{ events: Array<{ id: string; calendarId: string; title: string; start: number; end: number; location?: string }>; errors: string[]; connected: boolean }> {
    const pim = pimFor(this.engine, accountId);
    if (!pim) return { events: [], errors: [], connected: false };
    const { events, errors } = await pim.events(range);
    return { events: events.map((e) => ({ id: e.id, calendarId: e.calendarId, title: e.title, start: e.start, end: e.end, ...(e.location ? { location: e.location } : {}) })), errors, connected: true };
  }

  detail(id: string, accountId: string, opts: { before?: number } = {}): MeetingDetail {
    const m = this.get(id, accountId);
    return { ...m, segments: this.store.finals(id, { before: opts.before }).map(({ at: _at, ...s }) => s), answers: this.store.answers(id), files: this.store.files(id), liveModel: this.liveModel(m) };
  }

  // ----- create and brief -----

  async create(input: CreateMeetingInput, accountId: string): Promise<Meeting> {
    const sched = this.scheduleFields(input, accountId);
    if (input.agenda !== undefined && (typeof input.agenda !== 'string' || input.agenda.length > AGENDA_MAX)) throw err(400, `agenda is at most ${AGENDA_MAX} characters`);
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > TITLE_MAX)) throw err(400, `title is at most ${TITLE_MAX} characters`);
    const answerModel = input.answerModel !== undefined ? this.answerModelField(input.answerModel, accountId) : undefined;
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
    // no folder: the meeting runs on its agenda and attached files only, and reads no device
    cwd ||= '';
    device = cwd ? device || 'local' : 'local';
    if (cwd && this.engine.repos.devices.accountOf(device) !== accountId) throw err(403, `Device ${device} is not yours.`);
    // a scheduled meeting never blocks, nor is blocked by, the one that runs (11.5)
    if (sched.scheduledAt === undefined && this.store.running(accountId)) throw err(409, RUNNING_MSG);
    const project = projectId ? projectsOf(this.engine)?.get(projectId)?.name : undefined;
    const hm = new Date().toTimeString().slice(0, 5);
    const title = input.title?.trim() || `Meeting ${project ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''} ${hm}`.replace(/\s+/g, ' ');
    const session = await this.engine.createSession({ kind: 'meeting', title, ...(cwd ? { cwd } : {}), device, model: this.fast(accountId) }, accountId, { meeting: true });
    const scheduled = sched.scheduledAt !== undefined;
    const extra: Partial<Meeting> = { ...sched, ...(answerModel ? { answerModel } : {}) };
    const m = this.store.create({ accountId, sessionId: session.id, projectId, device, cwd, title, agenda: input.agenda?.trim() || undefined, status: scheduled ? 'scheduled' : 'preparing', ...(Object.keys(extra).length ? { extra } : {}) });
    this.emit(m);
    if (scheduled) this.scheduleJobs(m);
    else this.track(this.prepare(m));
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
  private async memoryBlock(m: Meeting, session: Session, limit = 8): Promise<string> {
    try {
      const hits = (await this.engine.memoryFor(m.accountId).recall(`${m.title} ${m.agenda ?? ''}`, { project: this.engine.memoryProject(session), limit })).filter((h) => h.scope === 'project');
      return hits.length ? `Recalled:\n${hits.map((h) => `- ${h.content.replace(/\s+/g, ' ')}`).join('\n')}` : '';
    } catch {
      return ''; // memory off, or no recall
    }
  }

  private async buildPack(m: Meeting, session: Session, prep: string | undefined): Promise<string> {
    return buildContextPack({
      machine: this.engine.machineFor(session),
      cwd: m.cwd,
      config: this.engine.config.get(),
      ownerName: this.ownerNames(m.accountId)[0],
      title: m.title,
      agenda: m.agenda,
      sessions: this.packSessions(m),
      tasks: this.engine.repos.tasks.list({ accountId: m.accountId }).filter((t) => t.status !== 'done' && (m.projectId ? t.project === m.projectId : !t.project)),
      memory: await this.memoryBlock(m, session),
      lastMeeting: this.store.previousNotes(m),
      ...(prep ? { prep } : {}),
      files: this.store.fileTexts(m.id),
    });
  }

  /**
   * The prep changed after arm (an edit, a revert, a new draft): build the
   * pack again while nothing listens yet, so the meeting uses what the page
   * shows (11.4.5). Once live the pack stays as it started, except for a
   * file the owner attached or removed (live: true): that is worth one cache write.
   */
  private refreshPack(id: string, live = false): void {
    // preparing: "Prepare and start" uploads the files right after create, while the brief is written
    const can = (x?: Meeting) => !!x && ((x.status === 'ready' && !x.audioClientId) || (live && (x.status === 'preparing' || x.status === 'ready' || x.status === 'live' || x.status === 'paused')));
    const m = this.store.get(id);
    if (!can(m)) return;
    const session = this.engine.repos.sessions.get(m!.sessionId);
    if (!session) return;
    this.track(
      (async () => {
        const pack = await this.buildPack(m!, session, this.store.prepInUse(id));
        const cur = this.store.get(id);
        if (!can(cur)) return;
        this.store.setContext(id, pack);
        this.track(this.warm(cur!, pack));
      })(),
    );
  }

  /** Build the pack, stream the brief, then ready and warm-up (1.2, 4.2). */
  private async prepare(m: Meeting): Promise<void> {
    const session = this.engine.repos.sessions.get(m.sessionId);
    if (!session) return;
    // with a prep, the prep is the brief (11.4.5)
    const prep = this.store.prepInUse(m.id);
    let pack: string;
    try {
      pack = await this.buildPack(m, session, prep);
    } catch (e) {
      const f = this.store.move(m.id, 'failed', { error: `Could not read the project: ${(e as Error).message}` });
      if (f) this.emit(f);
      return;
    }
    this.store.setContext(m.id, pack);
    if (prep) {
      const ready = this.store.move(m.id, 'ready');
      if (!ready) return;
      this.emit(ready);
      this.track(this.warm(ready, pack));
      return;
    }
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
    this.track(this.warm(ready, pack));
  }

  // ----- live -----

  private liveOf(m: Meeting): Live {
    let l = this.live.get(m.id);
    if (!l) {
      l = { answerer: new Answerer(this.engine, this.store, () => this.store.get(m.id), () => this.liveModel(this.store.get(m.id) ?? m).ref), base: Date.now(), recentThem: [], fragments: [], batches: [] };
      this.live.set(m.id, l);
    }
    return l;
  }

  private startWarm(m: Meeting, l: Live): void {
    if (l.warm) return;
    l.warm = setInterval(() => {
      const cur = this.store.get(m.id);
      if (cur?.status === 'live') this.track(this.warm(cur));
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
    // undefined clears the column (store.update): back to the hub default
    if (patch.answerModel !== undefined) set.answerModel = this.answerModelField(patch.answerModel, accountId);
    Object.assign(set, this.scheduleFields(patch, accountId));
    const moving = patch.scheduledAt !== undefined || patch.durationMin !== undefined;
    if (moving && !(m.status === 'scheduled' || (m.status === 'ready' && !m.audioClientId))) throw err(409, `A meeting that is ${m.status} cannot be rescheduled.`);
    let next = m;
    if (moving && m.status === 'ready') {
      // rescheduled before it started: back to scheduled; the pack is built again at arm time
      const back = this.store.move(id, 'scheduled');
      if (!back) throw err(409, 'The meeting changed; try again.');
      this.store.setContext(id, null);
      next = back;
    }
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
    // a new answer model reads a cold cache: warm it before the next question
    if ('answerModel' in set && (next.status === 'ready' || next.status === 'live' || next.status === 'paused')) this.track(this.warm(next));
    const jobsChange = moving || patch.reminders !== undefined || patch.autoPrep !== undefined || patch.tz !== undefined;
    if (jobsChange && next.status === 'scheduled') this.scheduleJobs(next);
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
      const seg: StoredSegment = { ...s, text, at: l.base + s.startMs, receivedAt: now };
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
      if (!s.final) {
        if (isQuestion(s.text, names)) l.answerer.onQuestion(s);
        continue;
      }
      const q = this.questionOf(s, l, names);
      if (q) l.answerer.onQuestion(q);
      else l.answerer.onFinalNotQuestion(s);
    }
  }

  /**
   * The question a "them" final ends, if any: the final itself, or it joined
   * with the 1 or 2 "them" finals just before it (the speech model splits one
   * question at short pauses). The fragments start over after each question.
   */
  private questionOf(s: StoredSegment, l: Live, names: string[]): StoredSegment | undefined {
    l.fragments = l.fragments.filter((f) => s.at - (f.at + (f.endMs - f.startMs)) <= JOIN_WINDOW_MS).slice(-(JOIN_MAX - 1));
    if (isQuestion(s.text, names)) {
      // "the cache layer you built" + "how did you handle invalidation": the lead-in that ran on into it
      const lead: StoredSegment[] = [];
      let end = s.at;
      for (let i = l.fragments.length - 1; i >= 0; i--) {
        const f = l.fragments[i];
        if (/[.!?]$/.test(f.text.trim()) || end - (f.at + (f.endMs - f.startMs)) > JOIN_GAP_MS) break;
        lead.unshift(f);
        end = f.at;
      }
      l.fragments = [];
      return lead.length ? { ...s, text: [...lead.map((f) => f.text), s.text].join(' ') } : s;
    }
    for (let i = 0; i < l.fragments.length; i++) {
      const text = [...l.fragments.slice(i).map((f) => f.text), s.text].join(' ');
      if (isQuestion(text, names)) {
        const first = l.fragments[i];
        l.fragments = [];
        return { ...s, text, startMs: first.startMs, at: first.at, endMs: s.endMs + (s.at - first.at) - (s.startMs - first.startMs) };
      }
    }
    l.fragments.push(s);
    return undefined;
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

  // ----- after the meeting: memory and chat -----

  /**
   * "Save to memory": the notes, decisions and action items as one memory
   * of the account, in the project's scope when the meeting has one. The
   * owner asked for it, so it is accepted (the wrap-up episode waits in To
   * review). A second call returns the meeting with the same memoryId.
   */
  saveToMemory(id: string, accountId: string): Meeting {
    const m = this.get(id, accountId);
    const n = this.store.notes(id);
    if (!n) throw err(409, 'This meeting is not wrapped up yet.');
    // an explicit click: saved even with memory off, and only ever into the caller's own memory
    const mem = this.engine.memoryFor(accountId);
    if (m.memoryId && mem.get(m.memoryId)) return m;
    const session = this.engine.repos.sessions.get(m.sessionId);
    const key = session ? [this.engine.memoryProject(session)].flat()[0] : undefined;
    // no sourceSessionId: deleting the meeting keeps what the owner chose to save
    const entry = mem.saveLearnedEpisode({
      content: memoryText(m, n),
      scope: key ? 'project' : 'global',
      ...(key ? { scopeKey: key } : {}),
      tags: ['meeting'],
      meta: { source: 'meeting', meetingId: m.id, review: 'accepted', basis: 'user_accepted', episodeKey: `meeting-saved:${m.id}`, observedAt: m.startedAt ?? m.createdAt },
    });
    return this.emit(this.store.update(id, { memoryId: entry.id })!);
  }

  /** The text "Open in chat" and "Add to chat" put in the chat. */
  chatText(id: string, accountId: string): string {
    const m = this.get(id, accountId);
    const brief = m.briefMessageId ? this.engine.repos.messages.get(m.briefMessageId)?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : undefined;
    return chatContext(m, { prep: this.store.prepInUse(id) ?? brief, notes: this.store.notes(id), segments: this.store.allFinals(id) });
  }

  /**
   * The meeting's context in a chat, as a user message and a short reply, so
   * the owner asks follow-ups and no model turn runs until then. A new chat
   * (Chat mode, or Code in the meeting's folder), or one of the account's chats.
   */
  async toChat(id: string, input: MeetingChatInput, accountId: string): Promise<Session> {
    const m = this.get(id, accountId);
    if (input.to !== undefined && input.to !== 'chat' && input.to !== 'code') throw err(400, 'to is chat or code');
    if (input.sessionId !== undefined && typeof input.sessionId !== 'string') throw err(400, 'sessionId must be a string');
    const text = this.chatText(id, accountId);
    let s: Session | undefined;
    if (input.sessionId) {
      s = this.engine.repos.sessions.get(input.sessionId);
      if (!s || (s.accountId ?? 'owner') !== accountId || s.kind === 'meeting') throw err(404, 'Chat not found');
      if (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input') throw err(409, 'That chat is answering. Add the meeting when the reply is done.');
    } else {
      const title = `Meeting: ${m.title}`.slice(0, TITLE_MAX);
      s = await this.engine.createSession(input.to === 'code' ? { kind: 'agent', title, device: m.device, cwd: m.cwd } : { kind: 'chat', title }, accountId, { byPerson: true });
    }
    this.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text }], meta: { meetingContext: m.id } });
    this.engine.addMessage(s.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `I have the prep, notes and transcript of **${m.title}**. Ask me anything about it.` }], meta: { meetingContext: m.id } });
    return this.engine.repos.sessions.get(s.id) ?? s;
  }

  /** Rows, the session, its messages and its memory episode; the notes file and the tasks stay. */
  async delete(id: string, accountId: string): Promise<void> {
    const m = this.get(id, accountId);
    // paused still captures on the desktop; ending still writes the notes, tasks and episode
    if (m.status === 'live' || m.status === 'paused') throw err(409, 'End the meeting before you delete it.');
    if (m.status === 'ending') throw err(409, 'The notes are still being written; delete the meeting when they are done.');
    this.cancelJobs(id);
    this.engine.scheduler.cancel(prepKey(id));
    this.preps.get(id)?.abort();
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
