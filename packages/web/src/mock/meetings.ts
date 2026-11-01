/**
 * Mock meeting mode (docs/design/MEETING-MODE.md 3): the routes of 3.1 with
 * their rules (one meeting live at a time, segment idempotence by seq,
 * partial replacement, the first batch binds the client and goes live, a
 * question from "them" starts an answer that streams as message.delta, a new
 * one cancels the old), the brief and the wrap-up, and a fake desktop for the
 * overlay that "hears" a scripted stand-up and posts it as the app would.
 *
 * Seeds: a live stand-up in conclave (the overlay opens on it with
 * ?meeting=mtg_live) and an ended design review with notes.
 */
import type { Desktop } from '@/overlay/desktop';
import { setDesktop } from '@/overlay/desktop';
import type { Req } from '@/overlay/hub';
import type { Channel, DesktopMeetingStatus, Meeting, MeetingAnswer, MeetingNotes, Segment, SegmentBatch } from '@/overlay/wire';
import type { MockCtx } from './index';

const MIN = 60_000;
const QUESTION = /\?\s*$|^(what|why|how|when|where|who|which|can you|could you|would you|will you|do you|did you|does|is it|are you|have you|any updates?|tell us|walk us through|what about|thoughts on)\b|your (update|status)|where are we on|can you (share|show|present)/i;

/** The heuristic of 4.3, enough for the mock (core/src/meeting/trigger.ts is the real one). */
export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.split(/\s+/).length >= 3 && QUESTION.test(t);
}

const ANSWERS: [RegExp, string][] = [
  [/export/i, 'Say this:\n- The CSV export is merged; it shipped behind a flag on Tuesday.\n- PDF export is next. I expect a first version by Friday.\nSource: commit 1cefd80 "feat(export): csv behind a flag"'],
  [/block|risk/i, "Say this:\n- One blocker: the provider's rate limit on bulk calls.\n- I added a retry with backoff; I'll know tomorrow if that is enough.\nSource: session \"Fix 429s on bulk import\""],
  [/key|password|token/i, "Say this:\n- I can't share credentials on a call. I'll set you up with your own access after this.\nSource: none"],
];
// richer answers, for the overlay's screenshots and frame timing: code, a table and a chart, a diagram, ~2,000 tokens
ANSWERS.push(
  [/retry|code/i, 'Say this:\n- The retry waits **twice as long** after each 429, up to **8 seconds**.\n- It gives up after five tries and logs the batch id.\n\n```ts\nexport async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {\n  for (let i = 0; ; i++) {\n    try {\n      return await fn();\n    } catch (e) {\n      if (i >= tries - 1 || !isRateLimit(e)) throw e;\n      await sleep(Math.min(8000, 500 * 2 ** i)); // 0.5 s, 1 s, 2 s, 4 s, 8 s\n    }\n  }\n}\n```\nSource: commit 7d2a9b1 "fix(import): retry 429s with backoff"'],
  [/numbers|latency|how fast/i, 'Say this:\n- Imports are **3x faster** since the retry landed.\n- The p95 dropped from **4.2 s to 1.3 s** this week.\n\n| Day | p50 | p95 |\n|---|---|---|\n| Mon | 1.9 s | 4.2 s |\n| Wed | 0.8 s | 2.1 s |\n| Fri | 0.6 s | 1.3 s |\n\n```chart\n{"type":"bar","labels":["Mon","Tue","Wed","Thu","Fri"],"series":[{"name":"p50","values":[1.9,1.4,0.8,0.7,0.6]},{"name":"p95","values":[4.2,3.1,2.1,1.6,1.3]}]}\n```\nSource: session "Fix 429s on bulk import"'],
  [/flow|architecture|diagram/i, 'Say this:\n- An import goes **client, queue, worker, provider**.\n- Only the worker retries, so the client never waits on a 429.\n\n```mermaid\nflowchart LR\n  C[Client] --> Q[(Queue)]\n  Q --> W[Worker]\n  W -->|429| W\n  W --> P[Provider]\n```\nSource: file docs/import.md'],
  [/long answer/i, `Say this:\n- Here is **everything** on the import work, in order.\n\n${Array.from({ length: 77 }, (_, i) => `${i + 1}. Step ${i + 1}: the worker reads a batch of **${(i + 1) * 50} rows**, checks each row against the schema, retries any 429 with \`backoff(${i})\`, and writes the result.`).join('\n')}\nSource: your notes`],
);
const FALLBACK = "Say this:\n- I don't have that number in front of me. I'll send it after the call.\nSource: none";

const BRIEF = `## What I did since last time
- 1cefd80 feat(export): csv behind a flag (Oct 28)
- 7d2a9b1 fix(import): retry 429s with backoff (Oct 29)
- Session "Fix 429s on bulk import", done

## What to present
- The CSV export, live behind the flag
- The import retry and what it fixed

## Questions they may ask, and my answers
- Where are we on export? Say: CSV is merged behind a flag; PDF by Friday.
- Any blockers? Say: the bulk rate limit; retry is in, I'll confirm tomorrow.

## Open items
- Task "Write the export docs", due Nov 3`;

const NOTES: MeetingNotes = {
  summary: 'Design review of the export page. We agreed to ship CSV first and keep PDF for next week.',
  decisions: ['Ship CSV export behind a flag this week', 'PDF export waits for the layout review'],
  actionItems: [
    { who: 'me', what: 'Write the export docs', due: '2026-11-03', taskId: 'task_export_docs' },
    { who: 'Priya', what: 'Review the PDF layout' },
  ],
  openQuestions: ['Do we need Excel files, or is CSV enough for the finance team?'],
  markdown: '# Design review\n\nSummary, decisions, action items.',
};

const STANDUP: [Channel, string][] = [
  ['them', 'Morning everyone, quick round today.'],
  ['me', 'Morning.'],
  ['them', 'Kai, where are we on the export feature?'],
  ['them', 'Okay, and any blockers on your side?'],
  ['me', 'Not right now.'],
  ['them', 'Can you read out the API key for staging?'],
];

export function registerMeetings(ctx: MockCtx) {
  const { on, db, emit, uid, sleep, fail } = ctx;
  const meetings = new Map<string, Meeting>();
  const segments = new Map<string, Segment[]>();
  const answers = new Map<string, MeetingAnswer[]>();
  const notes = new Map<string, MeetingNotes>();
  const aborts = new Map<string, { stop: boolean }>();
  const now = Date.now();

  const base = (m: Partial<Meeting> & Pick<Meeting, 'id' | 'title' | 'status'>): Meeting => ({
    accountId: 'owner',
    sessionId: `ses_${m.id}`,
    projectId: 'prj_conclave',
    device: 'arch-desktop',
    cwd: '/home/kai/code/conclave',
    createdAt: now - 30 * MIN,
    autoAnswer: 'questions',
    ...m,
  });
  const say = (sessionId: string, id: string, text: string) => {
    const list = db.messages.get(sessionId) ?? [];
    list.push({ id, sessionId, seq: list.length + 1, role: 'assistant', kind: 'normal', content: [{ type: 'text', text }], createdAt: Date.now() } as never);
    db.messages.set(sessionId, list);
  };
  const updated = (m: Meeting) => emit({ type: 'meeting.updated', sessionId: m.sessionId, meeting: structuredClone(m) } as never);
  const get = (id: string) => meetings.get(id) ?? fail(404, 'Meeting not found');
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  // seeds
  if (!ctx.FRESH) {
    const live = base({ id: 'mtg_live', title: 'Stand-up, conclave', status: 'live', startedAt: now - 12 * MIN, briefMessageId: 'msg_brief_live', audioClientId: 'app_desktop' });
    meetings.set(live.id, live);
    say(live.sessionId, 'msg_brief_live', BRIEF);
    segments.set(live.id, [
      { seq: 0, channel: 'them', startMs: 0, endMs: 2500, text: 'Okay, let us start with the import work.', final: true },
      { seq: 0, channel: 'me', startMs: 2600, endMs: 6000, text: 'The retry is in. Bulk imports went through last night.', final: true },
      { seq: 1, channel: 'them', startMs: 6200, endMs: 9000, text: 'Nice. Where are we on the export feature?', final: true },
    ]);
    say(live.sessionId, 'msg_ans_1', ANSWERS[0]![1]);
    answers.set(live.id, [{ id: 'ans_1', meetingId: live.id, messageId: 'msg_ans_1', trigger: 'question', question: 'Nice. Where are we on the export feature?', state: 'done', createdAt: now - 2 * MIN, firstTokenAt: now - 2 * MIN + 900 }]);
    const ended = base({ id: 'mtg_review', title: 'Design review, export page', status: 'ended', createdAt: now - 26 * 60 * MIN, startedAt: now - 26 * 60 * MIN, endedAt: now - 25 * 60 * MIN, notesPath: '/home/kai/code/conclave/.conclave/meetings/2026-10-30-1000-design-review.md' });
    meetings.set(ended.id, ended);
    segments.set(ended.id, [
      { seq: 0, channel: 'them', startMs: 0, endMs: 3000, text: 'Can you walk us through the export page?', final: true },
      { seq: 0, channel: 'me', startMs: 3200, endMs: 9000, text: 'Sure. CSV is done, PDF needs the layout first.', final: true },
      { seq: 1, channel: 'them', startMs: 9500, endMs: 12000, text: 'Then ship CSV this week.', final: true },
    ]);
    answers.set(ended.id, []);
    notes.set(ended.id, NOTES);
  }

  async function brief(m: Meeting) {
    const id = uid('msg');
    m.briefMessageId = id;
    say(m.sessionId, id, '');
    updated(m);
    await streamInto(m, id, BRIEF);
    if (m.status === 'preparing') m.status = 'ready';
    updated(m);
  }

  async function streamInto(m: Meeting, messageId: string, text: string, abort?: { stop: boolean }) {
    const msg = db.messages.get(m.sessionId)?.find((x) => x.id === messageId);
    for (const part of text.match(/\S+\s*/g) ?? []) {
      if (abort?.stop) return false;
      const block = msg?.content[0] as { text: string } | undefined;
      if (block) block.text += part;
      emit({ type: 'message.delta', sessionId: m.sessionId, messageId, index: 0, kind: 'text', text: part });
      await sleep(25 + Math.random() * 35);
    }
    return true;
  }

  async function answer(m: Meeting, trigger: MeetingAnswer['trigger'], question: string): Promise<MeetingAnswer> {
    const list = answers.get(m.id) ?? [];
    answers.set(m.id, list);
    // one answer streams at a time: a new one stops the old (4.3)
    for (const a of list)
      if (a.state === 'streaming') {
        aborts.get(a.id)!.stop = true;
        a.state = 'cancelled';
        emit({ type: 'meeting.answer', sessionId: m.sessionId, meetingId: m.id, answer: { ...a } } as never);
      }
    const a: MeetingAnswer = { id: uid('ans'), meetingId: m.id, messageId: uid('msg'), trigger, question, state: 'streaming', createdAt: Date.now() };
    list.push(a);
    const abort = { stop: false };
    aborts.set(a.id, abort);
    say(m.sessionId, a.messageId, '');
    emit({ type: 'meeting.answer', sessionId: m.sessionId, meetingId: m.id, answer: { ...a } } as never);
    void (async () => {
      await sleep(450);
      if (abort.stop) return;
      a.firstTokenAt = Date.now();
      const text = ANSWERS.find(([re]) => re.test(question))?.[1] ?? FALLBACK;
      if (await streamInto(m, a.messageId, text, abort)) {
        a.state = 'done';
        emit({ type: 'meeting.answer', sessionId: m.sessionId, meetingId: m.id, answer: { ...a } } as never);
      }
    })();
    return a;
  }

  on('GET', '/api/meetings', ({ query }) => {
    const p = query.get('projectId');
    const limit = Number(query.get('limit') ?? 50);
    const list = [...meetings.values()].filter((m) => !p || m.projectId === p).sort((a, b) => b.createdAt - a.createdAt);
    return { meetings: list.slice(0, limit).map((m) => structuredClone(m)) };
  });

  on('POST', '/api/meetings', ({ body }) => {
    const b = (body ?? {}) as { sessionId?: string; projectId?: string; device?: string; cwd?: string; title?: string; agenda?: string };
    if (!b.sessionId && !b.projectId && !b.cwd) fail(400, 'Pick a project folder for the meeting.');
    if (b.agenda && b.agenda.length > 4000) fail(400, 'The agenda is longer than 4000 characters.');
    const s = b.sessionId ? (db.sessions.get(b.sessionId) ?? fail(404, 'Session not found')) : undefined;
    if ([...meetings.values()].some((m) => m.status === 'live' || m.status === 'paused')) fail(409, 'End the meeting that is running first.');
    const cwd = s?.cwd ?? b.cwd ?? '';
    const name = cwd.split('/').pop() || 'project';
    const hm = new Date().toTimeString().slice(0, 5);
    const m = base({ id: uid('mtg'), title: b.title?.trim() || `Meeting ${name} ${hm}`, status: 'preparing', createdAt: Date.now(), projectId: b.projectId, device: s?.device ?? b.device ?? 'arch-desktop', cwd, agenda: b.agenda });
    meetings.set(m.id, m);
    segments.set(m.id, []);
    answers.set(m.id, []);
    void brief(m);
    return json(201, structuredClone(m));
  });

  on('GET', '/api/meetings/:id', ({ params }) => {
    const m = get(params[0]!);
    return { ...structuredClone(m), segments: (segments.get(m.id) ?? []).filter((s) => s.final), answers: structuredClone(answers.get(m.id) ?? []) };
  });

  on('PATCH', '/api/meetings/:id', ({ params, body }) => {
    const m = get(params[0]!);
    const b = (body ?? {}) as Partial<Pick<Meeting, 'title' | 'agenda' | 'autoAnswer'>> & { status?: 'live' | 'paused' };
    if (b.status) {
      const ok = (b.status === 'paused' && m.status === 'live') || (b.status === 'live' && (m.status === 'paused' || m.status === 'ready'));
      if (!ok) fail(409, `A meeting that is ${m.status} cannot turn ${b.status}.`);
      m.status = b.status;
      m.startedAt ??= Date.now();
    }
    if (b.title !== undefined) m.title = b.title;
    if (b.agenda !== undefined) m.agenda = b.agenda;
    if (b.autoAnswer) m.autoAnswer = b.autoAnswer;
    updated(m);
    return structuredClone(m);
  });

  on('POST', '/api/meetings/:id/segments', ({ params, body }) => {
    const m = get(params[0]!);
    const b = body as SegmentBatch;
    if (!b || typeof b.clientId !== 'string' || !Array.isArray(b.segments) || b.segments.length < 1 || b.segments.length > 32) fail(400, 'A batch has 1 to 32 segments.');
    if (m.status !== 'ready' && m.status !== 'live' && m.status !== 'paused') fail(409, `The meeting is ${m.status}.`);
    if (m.audioClientId && m.audioClientId !== b.clientId) fail(409, 'Another app is listening to this meeting.');
    const list = segments.get(m.id)!;
    const fresh: Segment[] = [];
    for (const s of b.segments) {
      if ((s.channel !== 'me' && s.channel !== 'them') || !Number.isInteger(s.seq) || s.seq < 0 || typeof s.text !== 'string' || s.text.length > 2000) fail(400, 'Malformed segment.');
      const text = s.text.trim();
      if (!text) continue;
      const at = list.findIndex((x) => x.channel === s.channel && x.seq === s.seq);
      if (at >= 0 && list[at]!.final) continue;
      const seg = { ...s, text };
      if (at >= 0) list[at] = seg;
      else list.push(seg);
      fresh.push(seg);
    }
    if (!m.audioClientId) m.audioClientId = b.clientId;
    if (m.status === 'ready') {
      m.status = 'live';
      m.startedAt = Date.now();
      updated(m);
    }
    // the ack goes first; events and the trigger after (3.1)
    setTimeout(() => {
      for (const seg of fresh) {
        emit({ type: 'meeting.segment', sessionId: m.sessionId, meetingId: m.id, segment: seg } as never);
        if (seg.final && seg.channel === 'them' && m.autoAnswer === 'questions' && isQuestion(seg.text)) void answer(m, 'question', seg.text);
      }
    }, 0);
    const last = (c: Channel) => Math.max(-1, ...list.filter((x) => x.channel === c && x.final).map((x) => x.seq));
    return { accepted: fresh.length, lastSeq: { me: last('me'), them: last('them') } };
  });

  on('POST', '/api/meetings/:id/answer', async ({ params, body }) => {
    const m = get(params[0]!);
    if (m.status !== 'live' && m.status !== 'paused') fail(409, 'The meeting is not live.');
    const lastThem = [...(segments.get(m.id) ?? [])].reverse().find((s) => s.channel === 'them' && s.final)?.text ?? '';
    const a = await answer(m, 'answer-now', String((body as { question?: string })?.question ?? lastThem));
    return json(202, { answerId: a.id, messageId: a.messageId });
  });

  on('POST', '/api/meetings/:id/answers/:answer/cancel', ({ params }) => {
    const m = get(params[0]!);
    const a = answers.get(m.id)?.find((x) => x.id === params[1]) ?? fail(404, 'Answer not found');
    if (a.state === 'streaming') {
      aborts.get(a.id)!.stop = true;
      a.state = 'cancelled';
      emit({ type: 'meeting.answer', sessionId: m.sessionId, meetingId: m.id, answer: { ...a } } as never);
    }
    return json(204);
  });

  on('POST', '/api/meetings/:id/end', ({ params }) => {
    const m = get(params[0]!);
    if (m.status === 'ending' || m.status === 'ended') fail(409, 'The meeting already ended.');
    m.status = 'ending';
    updated(m);
    void (async () => {
      await sleep(1800);
      m.status = 'ended';
      m.endedAt = Date.now();
      m.notesPath = `${m.cwd}/.conclave/meetings/${new Date().toISOString().slice(0, 10)}-${m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`;
      const n = { ...NOTES, summary: `${m.title}: CSV export is merged behind a flag, PDF by Friday.` };
      notes.set(m.id, n);
      updated(m);
      emit({ type: 'meeting.notes', sessionId: m.sessionId, meetingId: m.id, notes: n } as never);
    })();
    return json(202, structuredClone(m));
  });

  on('GET', '/api/meetings/:id/notes', ({ params }) => notes.get(get(params[0]!).id) ?? fail(404, 'The meeting has not been wrapped up yet.'));

  on('DELETE', '/api/meetings/:id', ({ params }) => {
    const m = get(params[0]!);
    if (m.status === 'live') fail(409, 'End the meeting before you delete it.');
    meetings.delete(m.id);
    db.messages.delete(m.sessionId);
    return json(204);
  });
}

/**
 * The overlay's fake desktop: meeting_start "hears" the stand-up above and
 * posts it as the app's uploader would, a partial then the final for each
 * "them" line, and a level event as each line starts and ends.
 */
export function installMockDesktop(req: Req) {
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  const fire = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb({ payload });
  };
  const st: DesktopMeetingStatus = {
    live: false,
    paused: false,
    clickThrough: false,
    hiddenForShare: false,
    exclusion: /Linux/.test(navigator.userAgent) ? 'unsupported' : 'excluded',
    mic: { ok: true, device: 'Built-in microphone' },
    system: { ok: true, device: 'Speakers (loopback)' },
    stt: { state: 'ready' },
    queue: { stt: 0, upload: 0, dropped: 0 },
  };
  const q = new URLSearchParams(location.search);
  // ?meeting=mtg_live opens on the seeded live meeting as if this app listened to it
  if (q.get('meeting') === 'mtg_live') Object.assign(st, { live: true, meetingId: 'mtg_live' });
  const status = () => fire('meeting://status', structuredClone(st));
  let run = 0;
  let height = 0;
  const hear = async (meetingId: string, me: number) => {
    const seq = { me: 0, them: 0 };
    for (const [channel, text] of STANDUP) {
      await new Promise((r) => setTimeout(r, 2500));
      if (run !== me) return;
      while (st.paused) await new Promise((r) => setTimeout(r, 500));
      fire('meeting://level', channel === 'me' ? { me: 0.6, them: 0.05 } : { me: 0.05, them: 0.7 });
      const s: Segment = { seq: seq[channel]++, channel, startMs: 0, endMs: 2000, text, final: true };
      const post = (segs: Segment[]) => req('POST', `/api/meetings/${meetingId}/segments`, { clientId: 'app_desktop', t0: Date.now(), segments: segs });
      if (channel === 'them') await post([{ ...s, final: false, text: text.split(' ').slice(0, 4).join(' ') }]).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 600));
      const ok = await post([s]).then(
        () => true,
        () => false,
      );
      if (!ok) {
        st.live = false;
        status();
        return;
      }
      fire('meeting://level', { me: 0, them: 0 });
    }
  };
  const d: Desktop = {
    invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'meeting_status':
          return structuredClone(st) as T;
        case 'meeting_start':
          Object.assign(st, { live: true, paused: false, meetingId: String(args?.meetingId) });
          void hear(String(args?.meetingId), ++run);
          break;
        case 'meeting_pause':
          st.paused = !!args?.paused;
          break;
        case 'meeting_stop':
          run++;
          Object.assign(st, { live: false, paused: false });
          break;
        case 'meeting_click_through':
          st.clickThrough = !!args?.on;
          break;
        case 'meeting_set_height':
          // the height the app would give the window, for the screenshot script
          height = Number(args?.height);
          return undefined as T;
      }
      status();
      return undefined as T;
    },
    listen: async <T,>(event: string, cb: (e: { payload: T }) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(cb as (e: { payload: unknown }) => void);
      return () => set.delete(cb as (e: { payload: unknown }) => void);
    },
  };
  setDesktop(d);
  // screenshot and timing scripts ask a question and press the history hotkeys from the page
  Object.assign(window, {
    __overlayMock: {
      ask: (meetingId: string, question: string) => req('POST', `/api/meetings/${meetingId}/answer`, { question }),
      nav: (dir: -1 | 1) => fire('meeting://nav', dir),
      height: () => height,
    },
  });
}
