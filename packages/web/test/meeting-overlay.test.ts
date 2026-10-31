/**
 * Meeting mode in the web app (docs/design/MEETING-MODE.md 2.3, 3.4, 9):
 * the one-flush-per-frame buffer, the overlay's WebSocket client
 * (subscribe, since after a reconnect, resync, backoff), the meeting view
 * (partials replaced by finals, idempotent segments, other meetings and
 * sessions ignored, deltas), the "Say this" parser, the status notes, the
 * project choices, the mock's question heuristic, and that the overlay's
 * import graph stays out of the app (store, App, Tailwind) and its entry
 * under 70 KB gzip when a build is there.
 *
 *   bun test packages/web/test/meeting-overlay.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { frameBuffer } from '../src/overlay/frame';
import { backoff, connectWs } from '../src/overlay/ws';
import { answerStack, applyEvent, emptyView, lastLines, loadDetail, parseAnswer } from '../src/overlay/model';
import { statusNotes } from '../src/overlay/Live';
import { folderChoices } from '../src/overlay/Setup';
import { isQuestion } from '../src/mock/meetings';
import { OLD_DESKTOP, openOverlay } from '../src/features/meeting/api';
import { setDesktop } from '../src/overlay/desktop';
import type { DesktopMeetingStatus, MeetingDetail, MeetingEvent, Segment } from '../src/overlay/wire';

const WEB = resolve(import.meta.dir, '..');

describe('frame buffer', () => {
  test('many pushes in one frame flush once, in order; nothing is scheduled while idle', () => {
    const frames: (() => void)[] = [];
    const flushed: number[][] = [];
    const b = frameBuffer<number>(
      (x) => flushed.push(x),
      (cb) => frames.push(cb),
      () => undefined,
    );
    expect(frames.length).toBe(0);
    for (let i = 0; i < 500; i++) b.push(i);
    expect(frames.length).toBe(1);
    frames.shift()!();
    expect(flushed).toEqual([Array.from({ length: 500 }, (_, i) => i)]);
    b.push(1);
    expect(frames.length).toBe(1);
  });

  test('cancel drops what waits', () => {
    let cancelled = 0;
    const flushed: number[][] = [];
    const b = frameBuffer<number>(
      (x) => flushed.push(x),
      () => 7,
      () => cancelled++,
    );
    b.push(1);
    b.cancel();
    expect(cancelled).toBe(1);
    expect(flushed).toEqual([]);
  });
});

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(d: unknown) {
    this.onmessage?.({ data: JSON.stringify(d) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('overlay websocket', () => {
  test('backoff doubles to 8 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  test('subscribes on open, asks since after a reconnect, resync refetches, and close stops retrying', () => {
    FakeWs.all = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const events: string[] = [];
    let resyncs = 0;
    const h = connectWs({
      baseUrl: 'https://hub.example',
      token: 't k',
      sessions: () => ['ses_1'],
      onEvent: (e) => events.push(e.type),
      onResync: () => resyncs++,
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => undefined,
    });
    const a = FakeWs.all[0]!;
    expect(a.url).toBe('wss://hub.example/api/ws?token=t%20k');
    a.open();
    expect(a.sent).toEqual([{ type: 'subscribe', sessions: ['ses_1'] }]);
    a.msg({ type: 'hello', seq: 10 });
    a.msg({ type: 'meeting.segment', seq: 11 });
    a.msg('not json at all');
    expect(events).toEqual(['meeting.segment']);
    a.close();
    const retry = timers.find((t) => t.ms === 500)!;
    retry.fn();
    const b = FakeWs.all[1]!;
    b.open();
    expect(b.sent).toEqual([
      { type: 'subscribe', sessions: ['ses_1'] },
      { type: 'since', seq: 11 },
    ]);
    b.msg({ type: 'resync', seq: 40 });
    expect(resyncs).toBe(1);
    // a hub that restarted counts from 0 again
    b.msg({ type: 'hello', seq: 2 });
    expect(resyncs).toBe(2);
    h.close();
    const before = FakeWs.all.length;
    b.onclose?.();
    expect(FakeWs.all.length).toBe(before);
  });
});

const seg = (channel: 'me' | 'them', seq: number, text: string, final = true): Segment => ({ seq, channel, startMs: 0, endMs: 1, text, final });
const detail = (p: Partial<MeetingDetail> = {}): MeetingDetail => ({
  id: 'mtg_1',
  accountId: 'owner',
  sessionId: 'ses_1',
  device: 'd',
  cwd: '/p',
  title: 'Sync',
  status: 'live',
  createdAt: 1,
  autoAnswer: 'questions',
  segments: [],
  answers: [],
  ...p,
});
const ev = (e: unknown) => e as MeetingEvent;

describe('meeting view', () => {
  test('a final replaces its partial; a repeated final and a late partial change nothing', () => {
    const v = emptyView();
    loadDetail(v, detail());
    applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_1', meetingId: 'mtg_1', segment: seg('them', 0, 'where are', false) }));
    applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_1', meetingId: 'mtg_1', segment: seg('them', 0, 'where are we', false) }));
    expect(lastLines(v).map((l) => [l.text, l.final])).toEqual([['where are we', false]]);
    applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_1', meetingId: 'mtg_1', segment: seg('them', 0, 'Where are we on export?') }));
    applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_1', meetingId: 'mtg_1', segment: seg('them', 0, 'Where are we on export?') }));
    applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_1', meetingId: 'mtg_1', segment: seg('them', 0, 'late', false) }));
    expect(lastLines(v).map((l) => l.text)).toEqual(['Where are we on export?']);
  });

  test('both channels merge in arrival order, last 6 only', () => {
    const v = emptyView();
    loadDetail(v, detail());
    for (let i = 0; i < 8; i++) applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_1', meetingId: 'mtg_1', segment: seg(i % 2 ? 'me' : 'them', i, `l${i}`) }));
    expect(lastLines(v).map((l) => l.text)).toEqual(['l2', 'l3', 'l4', 'l5', 'l6', 'l7']);
  });

  test('events of another meeting or session are ignored; deltas append to the answer', () => {
    const v = emptyView();
    loadDetail(v, detail(), [{ id: 'msg_a', content: [{ type: 'text', text: 'Say this:\n' }] }]);
    expect(applyEvent(v, ev({ type: 'meeting.segment', sessionId: 'ses_2', meetingId: 'mtg_2', segment: seg('them', 0, 'x') }))).toBe(false);
    expect(applyEvent(v, ev({ type: 'message.delta', sessionId: 'ses_2', messageId: 'msg_a', index: 0, kind: 'text', text: 'evil' }))).toBe(false);
    expect(applyEvent(v, ev({ type: 'message.delta', sessionId: 'ses_1', messageId: 'msg_a', index: 0, kind: 'thinking', text: 'hm' }))).toBe(false);
    applyEvent(v, ev({ type: 'meeting.answer', sessionId: 'ses_1', meetingId: 'mtg_1', answer: { id: 'a1', meetingId: 'mtg_1', messageId: 'msg_a', trigger: 'question', question: 'q', state: 'streaming', createdAt: 5 } }));
    applyEvent(v, ev({ type: 'message.delta', sessionId: 'ses_1', messageId: 'msg_a', index: 0, kind: 'text', text: '- CSV is merged' }));
    expect(v.text.msg_a).toBe('Say this:\n- CSV is merged');
    applyEvent(v, ev({ type: 'meeting.answer', sessionId: 'ses_1', meetingId: 'mtg_1', answer: { id: 'a2', meetingId: 'mtg_1', messageId: 'msg_b', trigger: 'answer-now', question: '', state: 'streaming', createdAt: 9 } }));
    const st = answerStack(v);
    expect(st.current?.id).toBe('a2');
    expect(st.previous.map((a) => a.id)).toEqual(['a1']);
  });
});

describe('say this', () => {
  test('bullets and the source line; half a bullet while streaming', () => {
    expect(parseAnswer('Say this:\n- One\n- Two and\nmore\nSource: commit 1cefd80')).toEqual({ bullets: ['One', 'Two and more'], source: 'commit 1cefd80', rest: '' });
    expect(parseAnswer('Say this:\n- Half a bul')).toEqual({ bullets: ['Half a bul'], source: undefined, rest: '' });
    expect(parseAnswer('I am not sure.')).toEqual({ bullets: [], source: undefined, rest: 'I am not sure.' });
  });
});

const status = (p: Partial<DesktopMeetingStatus> = {}): DesktopMeetingStatus => ({
  live: true,
  paused: false,
  clickThrough: false,
  hiddenForShare: false,
  exclusion: 'excluded',
  mic: { ok: true },
  system: { ok: true },
  stt: { state: 'ready' },
  queue: { stt: 0, upload: 0, dropped: 0 },
  ...p,
});

describe('status notes', () => {
  test('quiet when all is well', () => expect(statusNotes(status(), 'open')).toEqual([]));
  test('says what is wrong, in words', () => {
    expect(statusNotes(status({ exclusion: 'unsupported', mic: { ok: false }, queue: { stt: 3, upload: 4, dropped: 0 } }), 'closed')).toEqual(['Hub offline: transcript queued (4)', 'Visible in screen shares', 'no mic', '3 waiting for text']);
    expect(statusNotes(undefined, 'open')).toEqual(['Not listening on this computer']);
    expect(statusNotes(status({ exclusion: 'monitor-only' }), 'open')).toEqual(['Shows as a black box in shares']);
  });
});

test('project choices: one per folder, newest project first', () => {
  const p = (id: string, updatedAt: number, locs: [string, string][]) => ({ id, name: id, identity: {} as never, createdAt: 0, updatedAt, locations: locs.map(([device, path]) => ({ projectId: id, device, path, via: 'origin' as const, pinned: false })) });
  const c = folderChoices([p('old', 1, [['a', '/x']]), p('new', 2, [['a', '/y'], ['b', '/z']])]);
  expect(c.map((x) => `${x.projectId}:${x.device}:${x.cwd}`)).toEqual(['new:a:/y', 'new:b:/z', 'old:a:/x']);
});

test('an app from before meeting mode says to update, other errors pass through', async () => {
  const fails = (msg: string) => setDesktop({ invoke: async () => Promise.reject(msg), listen: async () => () => undefined });
  try {
    fails('Command meeting_open not allowed by ACL');
    await expect(openOverlay('mtg_1')).rejects.toThrow(OLD_DESKTOP);
    fails('the overlay window could not be built');
    await expect(openOverlay('mtg_1')).rejects.toThrow('the overlay window could not be built');
    setDesktop({ invoke: async () => undefined as never, listen: async () => () => undefined });
    expect(await openOverlay('mtg_1')).toBe(true);
  } finally {
    setDesktop(undefined);
  }
});

test('the mock answers questions only', () => {
  expect(isQuestion('Kai, where are we on the export feature?')).toBe(true);
  expect(isQuestion('Any updates on the import?')).toBe(true);
  expect(isQuestion('Morning everyone, quick round today.')).toBe(false);
  expect(isQuestion('Okay?')).toBe(false);
});

describe('the overlay stays its own small bundle', () => {
  /** Static imports from the overlay entry, followed through local files. The mock is loaded with import() under VITE_MOCK only. */
  function graph(entry: string): string[] {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^\s*import\s+(?!type\b)(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!;
        const base = spec.startsWith('@/') ? join(WEB, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(file), spec) : undefined;
        if (!base) {
          seen.add(spec);
          continue;
        }
        const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((f) => existsSync(f) && !f.endsWith('/'));
        if (hit && /\.(tsx?|css)$/.test(hit)) {
          if (hit.endsWith('.css')) seen.add(hit);
          else walk(hit);
        }
      }
    };
    walk(entry);
    return [...seen].map((f) => f.replace(`${WEB}/`, ''));
  }

  test('no store, App, app styles or Tailwind', () => {
    const files = graph(join(WEB, 'src/overlay/main.tsx'));
    expect(files).toContain('src/overlay/overlay.css');
    const bad = files.filter((f) => /src\/store\/|src\/App\.tsx|src\/styles\/|tailwind|src\/components\/|@conclave\/core\/client$|zustand|wouter/.test(f));
    expect(bad).toEqual([]);
  });

  const manifest = join(WEB, 'dist/.vite/manifest.json');
  test.skipIf(!existsSync(manifest))('built entry under 70 KB gzip (bun run --cwd packages/web build first)', () => {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, { file: string; imports?: string[] }>;
    const entry = m['overlay.html']!;
    const size = (f: string) => gzipSync(readFileSync(join(WEB, 'dist', f))).length;
    expect(size(entry.file)).toBeLessThan(70_000);
  });
});
