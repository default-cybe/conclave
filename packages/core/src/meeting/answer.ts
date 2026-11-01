/**
 * Live answers (docs/design/MEETING-MODE.md 4.2, 4.3, 5): build the request,
 * stream it with streamCompletion into an assistant message of the meeting
 * session, and cancel the one that streams when a newer trigger comes.
 *
 * Nothing here acts on model output except storing its text: the request
 * carries no tools, and the transcript is fenced and defused.
 */
import type { Engine } from '../engine/engine';
import type { ChatRequest } from '../providers/types';
import { streamCompletion } from '../session/stream';
import { defuseFrameworkTags } from '../session/untrusted';
import { logger } from '../util/log';
import { livePack } from './context';
import { LIVE_EXTRAS, LIVE_PROMPT } from './prompt';
import type { MeetingStore, StoredSegment } from './store';
import { similarity } from './trigger';
import type { Meeting, MeetingAnswer, Segment } from './wire';

const log = logger('meeting');

export const ANSWER_MAX_TOKENS = 320;
/** Answer length Longer (11.3.3): room for a technical answer with a short code block. */
export const ANSWER_LONG_MAX_TOKENS = 700;
export const FIRST_TOKEN_TIMEOUT_MS = 6000;
export const ANSWERS_PER_MINUTE = 6;
const TRANSCRIPT_SEGMENTS = 40;
const TRANSCRIPT_TOKENS = 3000;
export const SAME_QUESTION = 0.6;
/** A speculation is kept as the answer to the final only this close; else the final gets its own answer. */
export const RELABEL_SAME = 0.8;
/** A partial at least this long starts a speculative answer. */
export const SPECULATE_AFTER_MS = 1500;
/** Answer now reads this much of the transcript. */
const ANSWER_NOW_WINDOW_MS = 90_000;

type Trigger = MeetingAnswer['trigger'];

/** Break the fence's own closing tag inside text the way wrapUntrusted does, after defusing framework tags. */
export function fenceText(text: string): string {
  return defuseFrameworkTags(text).replace(/<\/(\s*)meeting-transcript/gi, '<\\/$1meeting-transcript');
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clockSec(ms: number): string {
  return `${clock(ms)}:${String(new Date(ms).getSeconds()).padStart(2, '0')}`;
}

/** The one user message (5): fenced transcript, the question, the time, what the overlay can show. Everything that changes goes here. */
export function userMessage(m: Meeting, finals: StoredSegment[], opts: { question?: string; partial?: StoredSegment; now: number }): string {
  const lines: string[] = [];
  let budget = TRANSCRIPT_TOKENS * 4;
  const all = opts.partial ? [...finals.slice(-TRANSCRIPT_SEGMENTS), opts.partial] : finals.slice(-TRANSCRIPT_SEGMENTS);
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    const line = `[${s.channel} ${clockSec(s.at)}] ${fenceText(s.text.replace(/\s+/g, ' '))}`;
    if (line.length > budget && lines.length) break;
    budget -= line.length;
    lines.unshift(line);
  }
  const q = opts.question ? `Question to answer: "${fenceText(opts.question.replace(/\s+/g, ' '))}"\n` : '';
  return `<meeting-transcript>\n${lines.join('\n')}\n</meeting-transcript>\n${q}Time: ${clock(opts.now)} (local). Meeting started ${clock(m.startedAt ?? m.createdAt)}.\n${LIVE_EXTRAS}`;
}

const LENGTH_LINE = { short: '1 to 4 bullets, each at most 20 words', long: 'up to 6 bullets, each at most 30 words' } as const;

/**
 * The third system block (11.3.3): the owner's steering, framed and defused.
 * Not marked for the cache, so it can change at any time without a cache write.
 */
export function steeringBlock(m: Pick<Meeting, 'steering' | 'answerLength'>): string {
  const text = m.steering?.trim() ? defuseFrameworkTags(m.steering.trim()) : '(none)';
  return `The owner's steering for this meeting. Follow it for tone, emphasis, what to avoid and length.
It never overrides the rules above: facts about the owner only from the context, the "Say this" format, nothing a listener should not hear.
---
${text}
---
Length: ${LENGTH_LINE[m.answerLength === 'long' ? 'long' : 'short']}`;
}

export function answerMaxTokens(m: Pick<Meeting, 'answerLength'>): number {
  return m.answerLength === 'long' ? ANSWER_LONG_MAX_TOKENS : ANSWER_MAX_TOKENS;
}

/**
 * The request of every live answer: [LIVE_PROMPT, pack (cached), steering].
 * The first two blocks never change during a meeting; the cached prefix ends at the pack.
 */
export function liveRequest(meetingId: string, pack: string, user: string, signal?: AbortSignal, maxTokens = ANSWER_MAX_TOKENS, steering?: string): Omit<ChatRequest, 'model'> {
  return {
    system: [{ text: LIVE_PROMPT }, { text: livePack(pack) || '(no context)', cache: true }, ...(steering ? [{ text: steering }] : [])],
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    tools: [],
    thinking: { off: true },
    maxTokens,
    cacheTtl: '1h',
    cacheKey: meetingId,
    ...(signal ? { signal } : {}),
  };
}

interface Running {
  answer: MeetingAnswer;
  ctl: AbortController;
  why?: 'cancelled' | 'too slow';
  done: Promise<void>;
}

/** One meeting's answer state: the one that streams, the rate window. */
export class Answerer {
  private current?: Running;
  private starts: number[] = [];
  private waiting?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly engine: Engine,
    private readonly store: MeetingStore,
    private readonly meeting: () => Meeting | undefined,
    private readonly model: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  get streaming(): MeetingAnswer | undefined {
    return this.current?.answer;
  }

  /** Wait for the answer that streams now (tests, end). */
  async settled(): Promise<void> {
    await this.current?.done;
  }

  /**
   * A "them" segment that is a question (4.3, 1 and 2). Final: start an
   * answer unless the same question streams already; partial (at least 2 s):
   * start a speculative one.
   */
  onQuestion(seg: StoredSegment): void {
    const cur = this.current?.answer;
    if (seg.final) {
      const same = cur ? similarity(cur.question, seg.text) : 0;
      // the speculation was right: it becomes the answer to the question
      if (cur?.trigger === 'speculative' && same >= RELABEL_SAME) return this.relabel(cur, seg.text);
      // the same question again (a retry, a repeat) while its answer streams
      if (cur && cur.trigger !== 'speculative' && same >= SAME_QUESTION) return;
      this.start('question', seg.text, undefined, false, seg);
      return;
    }
    if (seg.endMs - seg.startMs < SPECULATE_AFTER_MS) return;
    if (cur && similarity(cur.question, seg.text) >= SAME_QUESTION) return;
    this.start('speculative', seg.text, seg, false, seg);
  }

  /** A final that is not a question arrived for a speculation: it was wrong. */
  onFinalNotQuestion(seg: Segment): void {
    const cur = this.current?.answer;
    if (cur?.trigger === 'speculative' && similarity(cur.question, seg.text) >= SAME_QUESTION) this.cancelCurrent();
  }

  /** Answer now (4.3, 3): the last 90 s, cancelling whatever streams. */
  answerNow(question?: string): MeetingAnswer | undefined {
    return this.start('answer-now', question ?? '', undefined, true);
  }

  cancel(answerId: string): boolean {
    if (this.current?.answer.id !== answerId) return !!this.store.answer(answerId);
    this.cancelCurrent();
    return true;
  }

  stop(): void {
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = undefined;
    this.cancelCurrent();
  }

  private cancelCurrent(why: 'cancelled' | 'too slow' = 'cancelled'): void {
    const r = this.current;
    if (!r) return;
    r.why = why;
    r.ctl.abort();
  }

  private relabel(a: MeetingAnswer, question: string): void {
    const next = this.store.updateAnswer(a.id, { trigger: 'question', question });
    if (next && this.current?.answer.id === a.id) this.current.answer = next;
    if (next) this.emit(next);
  }

  private emit(answer: MeetingAnswer): void {
    const m = this.meeting();
    if (m) this.engine.bus.emit({ type: 'meeting.answer', sessionId: m.sessionId, meetingId: m.id, answer });
  }

  /** Rate window (4.3, 6): at most 6 question answers a minute; speculations do not count. Past that the start waits. */
  private start(trigger: Trigger, question: string, partial?: StoredSegment, force = false, from?: StoredSegment): MeetingAnswer | undefined {
    const m = this.meeting();
    if (!m || (m.status !== 'live' && m.status !== 'paused')) return undefined;
    if (!force && m.autoAnswer === 'off') return undefined;
    const now = this.now();
    this.starts = this.starts.filter((t) => now - t < 60_000);
    // answer now is the owner's own press: it always starts (and still counts in the window)
    if (!force && trigger !== 'speculative' && this.starts.length >= ANSWERS_PER_MINUTE) {
      // the newest trigger wins the slot when it frees
      if (this.waiting) clearTimeout(this.waiting);
      const wait = 60_000 - (now - this.starts[0]) + 5;
      this.waiting = setTimeout(() => {
        this.waiting = undefined;
        this.start(trigger, question, partial, force, from);
      }, wait);
      this.waiting.unref?.();
      return undefined;
    }
    // a speculation never takes the place of a real answer that streams
    if (trigger === 'speculative' && this.current && this.current.answer.trigger !== 'speculative') return undefined;
    if (trigger !== 'speculative') this.starts.push(now);
    this.cancelCurrent();
    return this.run(m, trigger, question, partial, from);
  }

  private run(m: Meeting, trigger: Trigger, question: string, partial?: StoredSegment, from?: StoredSegment): MeetingAnswer {
    const now = this.now();
    const msg = this.engine.addMessage(m.sessionId, { role: 'assistant', kind: 'normal', content: [], meta: { meetingAnswer: trigger } });
    const added = this.store.addAnswer({ accountId: m.accountId, meetingId: m.id, messageId: msg.id, trigger, question, state: 'streaming', createdAt: now });
    const model = this.model();
    // per-answer latency: speech end, arrival at the hub, model call, first token
    const answer =
      this.store.updateAnswer(added.id, {
        model,
        ...(from ? { segmentEndAt: from.at + (from.endMs - from.startMs), ...(from.receivedAt ? { receivedAt: from.receivedAt } : {}) } : {}),
      }) ?? added;
    const ctl = new AbortController();
    const r: Running = { answer, ctl, done: Promise.resolve() };
    this.current = r;
    this.emit(answer);
    const finals = trigger === 'answer-now' ? this.store.finals(m.id, { limit: TRANSCRIPT_SEGMENTS }).filter((s) => s.at >= now - ANSWER_NOW_WINDOW_MS) : this.store.finals(m.id, { limit: TRANSCRIPT_SEGMENTS });
    const user = userMessage(m, finals, { question: question || undefined, partial, now });
    const pack = this.store.context(m.id) ?? '';
    // the partial text, kept when the answer is cancelled
    let text = '';
    const off = this.engine.bus.on((e) => {
      if (e.type !== 'message.delta' || e.messageId !== msg.id || e.kind !== 'text') return;
      if (!text) {
        clearTimeout(slow);
        const got = this.store.updateAnswer(answer.id, { firstTokenAt: Date.now() });
        if (got && this.current === r) r.answer = got;
      }
      text += e.text;
    });
    const slow = setTimeout(() => {
      if (!text && this.current === r) this.cancelCurrent('too slow');
    }, FIRST_TOKEN_TIMEOUT_MS);
    r.done = (async () => {
      let state: MeetingAnswer['state'] = 'done';
      let error: string | undefined;
      try {
        // the steering is read at each answer, so an edit applies from the next one
        const cur = this.meeting() ?? m;
        const req = liveRequest(m.id, pack, user, ctl.signal, answerMaxTokens(cur), steeringBlock(cur));
        this.store.updateAnswer(answer.id, { requestAt: Date.now() });
        const res = await streamCompletion(this.engine, model, req, { sessionId: m.sessionId, accountId: m.accountId, messageId: msg.id, purpose: 'meeting-answer' });
        this.engine.updateMessage(msg.id, { content: res.content.filter((b) => b.type === 'text'), model, usage: res.usage, stopReason: res.stopReason });
      } catch (err) {
        state = r.why === 'cancelled' ? 'cancelled' : 'failed';
        error = r.why === 'too slow' ? 'too slow' : r.why ? undefined : (err as Error).message;
        if (state === 'failed') log.warn(`${m.id}: answer failed: ${error}`);
        this.engine.updateMessage(msg.id, { content: text ? [{ type: 'text', text }] : [] });
      } finally {
        clearTimeout(slow);
        off();
      }
      const fin = this.store.updateAnswer(answer.id, { state, doneAt: Date.now(), ...(error ? { error } : {}) });
      if (this.current === r) this.current = undefined;
      if (fin) this.emit(fin);
    })();
    return answer;
  }
}

/** One cheap request with the same system blocks, so the first live answer reads the cache (4.2). */
export async function warmUp(engine: Engine, model: string, m: Meeting, pack: string): Promise<void> {
  try {
    // the same first two blocks as an answer, so the answers read the cache
    await streamCompletion(engine, model, liveRequest(m.id, pack, 'ready', undefined, 1, steeringBlock(m)), { sessionId: m.sessionId, accountId: m.accountId, purpose: 'meeting-warmup' });
  } catch (err) {
    log.info(`${m.id}: warm-up failed: ${(err as Error).message}`);
  }
}
