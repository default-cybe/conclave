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
 *
 * Scheduled meetings and prep (11): Capstone defence next Monday 10:00 (not
 * prepared; its prep asks for an OK over 500k tokens, then streams progress),
 * a sync in 42 minutes that is prepared and edited, and one never held. The
 * folders, the day's calendar events and the steering presets are canned.
 */
import type { Desktop } from '@/overlay/desktop';
import { setDesktop } from '@/overlay/desktop';
import type { Req } from '@/overlay/hub';
import type { Channel, CreateMeetingInput, DesktopMeetingStatus, Meeting, MeetingAnswer, MeetingCalendarEvent, MeetingFolder, MeetingNotes, MeetingPatch, PrepProgress, PrepView, Segment, SegmentBatch, SteeringPreset } from '@/overlay/wire';
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

/** The text of STEERING_PRESETS (11.3.3); the hub serves core's copy. */
export const PRESETS: SteeringPreset[] = [
  {
    id: 'defence',
    label: 'Defence / viva',
    text: 'Panel members are examiners testing whether I did and understand the work.\n- Lead with the claim, then the evidence that backs it: the number, the experiment, the file or commit.\n- Confident, not defensive. Admit a limitation in one sentence, then say what I did about it or would do next.\n- Never overstate a result. If a result is preliminary, say "preliminary".\n- Stress: methodology, why I chose it over alternatives, and how I validated it.\n- Avoid: jargon the panel did not use first, apologising, and "I think" before facts.',
  },
  { id: 'status', label: 'Status update', text: '- What changed since last time, what is blocked, what I need from them. In that order.\n- Numbers and dates over adjectives. Name owners of blocked items when the context has them.\n- Avoid: implementation detail unless asked.' },
  { id: 'interview', label: 'Interview', text: '- Answer with a short situation, what I did, and the result with a number when there is one.\n- Tie answers to the role when the purpose names it. Keep each answer under 30 seconds spoken.\n- Avoid: talking down former teams, and claims the context cannot back.' },
  { id: 'demo', label: 'Demo', text: '- Say what the audience is looking at, then why it matters to them.\n- If something breaks, give a one-line recovery and move to the next step of the presenting order.\n- Avoid: reading code aloud; point to the file instead.' },
];

const CAPSTONE = '/home/kai/uni/capstone';

const FOLDERS: Omit<MeetingFolder, 'lastAt'>[] = [
  { device: 'arch-desktop', deviceName: 'arch-desktop', online: true, cwd: CAPSTONE, projectName: 'Capstone', chats: 214 },
  { device: 'arch-desktop', deviceName: 'arch-desktop', online: true, cwd: '/home/kai/code/conclave', projectId: 'prj_conclave', projectName: 'conclave', chats: 1380 },
  { device: 'macbook', deviceName: 'macbook', online: false, cwd: '/Users/kai/thesis', projectName: 'Thesis', chats: 57 },
  { device: 'kali-vm', deviceName: 'kali-vm', online: true, cwd: '/home/kali/ctf/heapnote', chats: 22 },
  { device: 'local', deviceName: 'madx', online: true, cwd: '/root/uni/os/a3', chats: 12 },
];

const PREP = `## Summary
A network intrusion detector for campus Wi-Fi, trained on 14 days of flow logs. The final model reaches F1 0.89 on the held-out week, up from a 0.71 baseline. The write-up and the evidence folder are done; the demo runs from the recorded capture.

## Timeline
- 2026-09-14: trained baseline, F1 0.71 (chat "Baseline run", 14 Sep)
- 2026-09-29: added flow-level features, F1 0.82 (commit 4be19a0)
- 2026-10-12: switched to gradient boosting, F1 0.89 (chat "Model comparison", 12 Oct)
- 2026-10-27: evidence folder and report frozen (task "Freeze evidence")

## Evidence and numbers
| Claim | Number | Source |
|---|---|---|
| Final F1 on the held-out week | 0.89 | chat "Model comparison", 12 Oct |
| Baseline F1 | 0.71 | chat "Baseline run", 14 Sep |
| False positives per day | 3.2 | evaluation/report.md |
| Flows in the training set | 41.6M | commit 9c03e11 |

## Likely questions and answers
- Why gradient boosting over a neural net? Say: it matched the net's F1 within 0.01, trains in 4 minutes, and the panel can read its feature importances.
- How did you validate it? Say: a whole held-out week, never seen in training, plus a replay of the red-team capture.
- What would you do next? Say: test on a second campus; the current numbers are from one network.

## Presenting order
1. The problem and the threat model (5 min)
2. Data and features (10 min)
3. Results and the evidence table (15 min)
4. Live demo from the recorded capture (12 min)

## Weak spots
- One network only. Say it first, then the plan to test on a second campus.
- Labels come from the IDS alerts. Say how the 300 hand-checked flows agreed (94%).

## Left out
- 12 chats before 2025-03-01 (cap 400)
- 2 chats failed to summarise: "Scratch", "Untitled"`;

export function registerMeetings(ctx: MockCtx) {
  const { on, db, emit, uid, sleep, fail } = ctx;
  const meetings = new Map<string, Meeting>();
  const preps = new Map<string, PrepView & { extra?: string[]; approved?: boolean; run?: number }>();
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

    // scheduled meetings (11)
    const monday = (() => {
      const d = new Date(now);
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      d.setHours(10, 0, 0, 0);
      return d.getTime();
    })();
    const sched = (m: Partial<Meeting> & Pick<Meeting, 'id' | 'title' | 'scheduledAt'>): Meeting =>
      base({ status: 'scheduled', device: 'arch-desktop', cwd: CAPSTONE, projectId: undefined, createdAt: now - 2 * 24 * 60 * MIN, reminders: [1440, 15], autoPrep: true, answerLength: 'short', prepState: 'none', ...m });
    const capstone = sched({ id: 'mtg_capstone', title: 'Capstone defence', scheduledAt: monday, durationMin: 60, calendarEventId: 'ev_capstone', calendarId: 'cal_uni', steeringPreset: 'defence', steering: PRESETS[0]!.text, agenda: 'Capstone defence: present all evidence, defend the findings, 10 min talk then questions.' });
    meetings.set(capstone.id, capstone);
    preps.set(capstone.id, { state: 'none' });
    const sync = sched({ id: 'mtg_sync', title: 'Capstone sync with Dr. Moore', scheduledAt: now + 42 * MIN, durationMin: 30, prepState: 'done', prepAt: now - 3 * 60 * MIN, prepEditedAt: now - 2 * 60 * MIN, steeringPreset: 'status', steering: PRESETS[1]!.text });
    meetings.set(sync.id, sync);
    preps.set(sync.id, { state: 'done', draft: PREP, edited: PREP.replace('## Summary\n', '## Summary\nMine: lead with the 0.89.\n\n'), at: sync.prepAt, editedAt: sync.prepEditedAt, sources: { sessions: 214, chunks: 260, workflows: 9, commits: 1204, files: 318, tokensIn: 1_400_000, tokensOut: 61_000, leftOut: ['12 chats before 2025-03-01 (cap 400)', '2 chats failed to summarise'] } });
    const missed = sched({ id: 'mtg_missed', title: 'Office hours, OS', scheduledAt: now - 3 * 24 * 60 * MIN, durationMin: 30, device: 'local', cwd: '/root/uni/os/a3' });
    meetings.set(missed.id, missed);
    preps.set(missed.id, { state: 'none' });
  }

  const prepOf = (id: string) => {
    let p = preps.get(id);
    if (!p) preps.set(id, (p = { state: 'none' }));
    return p;
  };
  const prepEvent = (m: Meeting) => {
    const p = prepOf(m.id);
    m.prepState = p.state;
    m.prepProgress = p.progress;
    m.prepAt = p.at;
    m.prepEditedAt = p.editedAt;
    m.prepError = p.error;
    emit({ type: 'meeting.prep', sessionId: m.sessionId, meetingId: m.id, state: p.state, progress: p.progress } as never);
    updated(m);
  };
  const view = (p: PrepView & { extra?: string[] }): PrepView => structuredClone({ state: p.state, progress: p.progress, draft: p.draft, edited: p.edited, at: p.at, editedAt: p.editedAt, sources: p.sources, error: p.error, estimate: p.estimate, extra: p.extra } as PrepView);

  /** inventory, then map with progress, then reduce. The first Capstone run stops for an OK (500k tokens). */
  async function runPrep(m: Meeting) {
    const p = prepOf(m.id);
    const run = (p.run = (p.run ?? 0) + 1);
    const alive = () => p.run === run && p.state !== 'cancelled';
    const total = m.cwd === CAPSTONE ? 48 : 12;
    p.state = 'running';
    p.error = undefined;
    p.progress = { phase: 'inventory', done: 0, total: 0, startedAt: Date.now(), leftOut: 0 };
    prepEvent(m);
    await sleep(600);
    if (!alive()) return;
    if (m.cwd === CAPSTONE && !p.approved) {
      p.state = 'waiting';
      p.estimate = { tokens: 1_400_000, sessions: 214, model: 'Gemini 3 Flash', usd: 0.4 };
      p.progress = { ...p.progress, phase: 'waiting-approval', estimate: p.estimate };
      prepEvent(m);
      return;
    }
    p.estimate = undefined;
    const prog: PrepProgress = { phase: 'map', done: 0, total, startedAt: Date.now(), leftOut: 0, medianMs: 8000 };
    for (let i = 0; i <= total; i++) {
      if (!alive()) return;
      p.progress = { ...prog, done: i };
      prepEvent(m);
      await sleep(160);
    }
    p.progress = { ...prog, phase: 'reduce', done: total };
    prepEvent(m);
    await sleep(1200);
    if (!alive()) return;
    p.state = 'done';
    p.progress = { ...prog, phase: 'done', done: total };
    p.draft = m.cwd === CAPSTONE ? PREP : PREP.replace('Capstone', m.title);
    p.at = Date.now();
    p.sources = { sessions: m.cwd === CAPSTONE ? 214 : 12, chunks: 260, workflows: 9, commits: 1204, files: 318, tokensIn: 1_400_000, tokensOut: 61_000, leftOut: ['12 chats before 2025-03-01 (cap 400)', '2 chats failed to summarise'] };
    prepEvent(m);
  }

  // the fixed routes go before /:id, as on the hub
  on('GET', '/api/meetings/folders', ({ query }) => {
    const q = (query.get('q') ?? '').toLowerCase();
    const list = FOLDERS.map((f, i) => ({ ...f, lastAt: now - (i + 1) * 2 * 24 * 60 * MIN })).filter((f) => !q || [f.cwd, f.projectName ?? '', f.deviceName].some((s) => s.toLowerCase().includes(q)));
    return { folders: ctx.FRESH ? [] : list };
  });

  on('GET', '/api/meetings/calendar', ({ query }) => {
    const from = Number(query.get('from'));
    const to = Number(query.get('to'));
    if (!(to > from) || to - from > 31 * 24 * 60 * MIN) fail(400, 'The range is at most 31 days.');
    if (ctx.FRESH) return { events: [], errors: ['No calendar connected'] };
    const cap = meetings.get('mtg_capstone')?.scheduledAt ?? now;
    const events: MeetingCalendarEvent[] = [
      { id: 'ev_capstone', calendarId: 'cal_uni', title: 'Capstone defence', start: cap, end: cap + 60 * MIN, location: 'Room 2.14' },
      { id: 'ev_lab', calendarId: 'cal_uni', title: 'Lab meeting', start: cap + 4 * 60 * MIN, end: cap + 5 * 60 * MIN },
      { id: 'ev_moore', calendarId: 'cal_uni', title: 'Capstone sync with Dr. Moore', start: now + 42 * MIN, end: now + 72 * MIN },
      { id: 'ev_gym', calendarId: 'cal_personal', title: 'Gym, lower', start: now + 26 * 60 * MIN, end: now + 27 * 60 * MIN },
    ];
    return { events: events.filter((e) => e.start < to && e.end > from), errors: [] };
  });

  on('GET', '/api/meetings/presets', () => ({ presets: PRESETS }));

  on('POST', '/api/meetings/:id/arm', ({ params }) => {
    const m = get(params[0]!);
    if (m.status !== 'scheduled') fail(409, `A meeting that is ${m.status} cannot be armed.`);
    if ([...meetings.values()].some((x) => x.status === 'live' || x.status === 'paused')) fail(409, 'End the meeting that is running first.');
    m.status = 'preparing';
    updated(m);
    void (async () => {
      await sleep(1500);
      if (m.status === 'preparing') m.status = 'ready';
      updated(m);
    })();
    return json(202, structuredClone(m));
  });

  on('GET', '/api/meetings/:id/prep', ({ params }) => view(prepOf(get(params[0]!).id)));

  on('POST', '/api/meetings/:id/prep', ({ params, body }) => {
    const m = get(params[0]!);
    const p = prepOf(m.id);
    if (p.state === 'queued' || p.state === 'running') fail(409, 'The prep is already running.');
    if ((body as { approve?: boolean })?.approve) p.approved = true;
    p.state = 'queued';
    prepEvent(m);
    void runPrep(m);
    return json(202, { state: 'queued' });
  });

  on('POST', '/api/meetings/:id/prep/cancel', ({ params }) => {
    const m = get(params[0]!);
    const p = prepOf(m.id);
    if (p.state !== 'queued' && p.state !== 'running' && p.state !== 'waiting') fail(409, 'The prep is not running.');
    p.state = p.draft ? 'done' : 'cancelled';
    p.progress = undefined;
    p.estimate = undefined;
    p.run = (p.run ?? 0) + 1;
    prepEvent(m);
    return json(204);
  });

  on('PUT', '/api/meetings/:id/prep', ({ params, body }) => {
    const m = get(params[0]!);
    const md = String((body as { markdown?: string })?.markdown ?? '');
    if (md.length > 60_000) fail(400, 'The prep is longer than 60,000 characters.');
    const p = prepOf(m.id);
    p.edited = md;
    p.editedAt = Date.now();
    if (p.state === 'none' || p.state === 'cancelled') p.state = 'done';
    prepEvent(m);
    return view(p);
  });

  on('DELETE', '/api/meetings/:id/prep/edit', ({ params }) => {
    const m = get(params[0]!);
    const p = prepOf(m.id);
    p.edited = undefined;
    p.editedAt = undefined;
    prepEvent(m);
    return json(204);
  });

  on('PUT', '/api/meetings/:id/prep/extra', ({ params, body }) => {
    const p = prepOf(get(params[0]!).id);
    const ids = (body as { sessionIds?: string[] })?.sessionIds ?? [];
    if (ids.length > 200) fail(400, 'At most 200 chats.');
    p.extra = ids;
    return json(204);
  });

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
    const v = query.get('view') ?? 'all';
    const limit = Number(query.get('limit') ?? 50);
    const before = Number(query.get('before') ?? Infinity);
    const t = Date.now();
    // the split of 11.2; the web sorts and places them again (features/meeting/time.ts)
    const stale = (m: Meeting) => (m.status === 'scheduled' || m.status === 'ready') && !m.startedAt && m.scheduledAt !== undefined && t > m.scheduledAt + (m.durationMin ?? 0) * MIN + 180 * MIN;
    const past = (m: Meeting) => m.status === 'ended' || m.status === 'failed' || stale(m);
    const key = (m: Meeting) => m.startedAt ?? m.scheduledAt ?? m.createdAt;
    let list = [...meetings.values()].filter((m) => !p || m.projectId === p);
    if (v === 'past') list = list.filter((m) => past(m) && key(m) < before).sort((a, b) => key(b) - key(a));
    else if (v === 'upcoming') list = list.filter((m) => !past(m) && (m.status === 'scheduled' || m.status === 'ready') && m.scheduledAt !== undefined).sort((a, b) => a.scheduledAt! - b.scheduledAt!);
    else if (v === 'now') list = list.filter((m) => !past(m) && m.status !== 'scheduled');
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return { meetings: list.slice(0, limit).map((m) => structuredClone(m)) };
  });

  on('POST', '/api/meetings', ({ body }) => {
    const b = (body ?? {}) as CreateMeetingInput;
    if (!b.sessionId && !b.projectId && !b.cwd) fail(400, 'Pick a project folder for the meeting.');
    if (b.agenda && b.agenda.length > 4000) fail(400, 'The agenda is longer than 4000 characters.');
    if (b.scheduledAt !== undefined) {
      if (b.scheduledAt < Date.now() || b.scheduledAt > Date.now() + 365 * 24 * 60 * MIN) return json(400, { field: 'scheduledAt', error: 'Pick a time from now to a year ahead.' });
      const m = base({ id: uid('mtg'), title: b.title?.trim() || `Meeting ${(b.cwd ?? '').split('/').pop() || 'project'}`, status: 'scheduled', createdAt: Date.now(), projectId: b.projectId, device: b.device ?? 'arch-desktop', cwd: b.cwd ?? '', agenda: b.agenda, ...schedFields(b), prepState: 'none' });
      meetings.set(m.id, m);
      segments.set(m.id, []);
      answers.set(m.id, []);
      preps.set(m.id, { state: 'none' });
      updated(m);
      return json(201, structuredClone(m));
    }
    const s = b.sessionId ? (db.sessions.get(b.sessionId) ?? fail(404, 'Session not found')) : undefined;
    if ([...meetings.values()].some((m) => m.status === 'live' || m.status === 'paused')) fail(409, 'End the meeting that is running first.');
    const cwd = s?.cwd ?? b.cwd ?? '';
    const name = cwd.split('/').pop() || 'project';
    const hm = new Date().toTimeString().slice(0, 5);
    const m = base({ id: uid('mtg'), title: b.title?.trim() || `Meeting ${name} ${hm}`, status: 'preparing', createdAt: Date.now(), projectId: b.projectId, device: s?.device ?? b.device ?? 'arch-desktop', cwd, agenda: b.agenda, ...schedFields(b) });
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
    const b = (body ?? {}) as MeetingPatch;
    if (b.scheduledAt !== undefined || b.durationMin !== undefined) {
      const movable = m.status === 'scheduled' || (m.status === 'ready' && !m.audioClientId);
      if (!movable) fail(409, `A meeting that is ${m.status} cannot be moved.`);
      if (m.status === 'ready') m.status = 'scheduled';
    }
    Object.assign(m, schedFields(b));
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

  function schedFields(b: CreateMeetingInput | MeetingPatch): Partial<Meeting> {
    const out: Partial<Meeting> = {};
    for (const k of ['scheduledAt', 'durationMin', 'tz', 'steering', 'steeringPreset', 'answerLength', 'calendarEventId', 'calendarId', 'reminders', 'autoPrep'] as const) if (b[k] !== undefined) (out as Record<string, unknown>)[k] = b[k];
    return out;
  }

  on('GET', '/api/meetings/:id/notes', ({ params }) => notes.get(get(params[0]!).id) ?? fail(404, 'The meeting has not been wrapped up yet.'));

  on('DELETE', '/api/meetings/:id', ({ params }) => {
    const m = get(params[0]!);
    if (m.status === 'live') fail(409, 'End the meeting before you delete it.');
    meetings.delete(m.id);
    db.messages.delete(m.sessionId);
    emit({ type: 'session.deleted', sessionId: m.sessionId });
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
}
