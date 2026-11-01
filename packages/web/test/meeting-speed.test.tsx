/**
 * Meeting speed work in the web app: the level source and status dedupe that
 * keep the overlay from rendering on every tick, the latency readout and the
 * per-answer timings, the answer model menu, the STT choice words, and the
 * new status notes (fallback, channel errors, upload queue).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Live, statusNotes } from '../src/overlay/Live';
import { levelSource, statusOrSame } from '../src/overlay/frame';
import { meetingApi, HubError, type Req } from '../src/overlay/hub';
import { answerLatency, emptyView, lastLatency, loadDetail, seconds } from '../src/overlay/model';
import { answerTimings } from '../src/features/meeting/MeetingPage';
import { modelOptions } from '../src/features/meeting/MeetingForm';
import { sttInUse } from '../src/features/settings/meetings';
import type { DesktopMeetingStatus, MeetingAnswer, MeetingDetail } from '../src/overlay/wire';

const desk = (p: Partial<DesktopMeetingStatus> = {}): DesktopMeetingStatus => ({
  meetingId: 'mtg_1',
  live: true,
  paused: false,
  clickThrough: false,
  hiddenForShare: false,
  exclusion: 'full',
  mic: { ok: true },
  system: { ok: true },
  stt: { state: 'ready' },
  queue: { stt: 0, upload: 0, dropped: 0 },
  ...p,
});
const ans = (p: Partial<MeetingAnswer>): MeetingAnswer => ({ id: 'a', meetingId: 'm', messageId: 'x', trigger: 'question', state: 'done', createdAt: 10_000, ...p });

describe('level source', () => {
  test('tells subscribers only about real moves', () => {
    const s = levelSource();
    const got: number[] = [];
    const off = s.subscribe((l) => got.push(l.me));
    s.set({ me: 0.01, them: 0 });
    s.set({ me: 0.5, them: 0 });
    s.set({ me: 0.51, them: 0 });
    off();
    s.set({ me: 0.9, them: 0 });
    expect(got).toEqual([0.5]);
    expect(s.get().me).toBe(0.9);
  });

  test('an unchanged status keeps the old object', () => {
    const a = desk();
    expect(statusOrSame(a, desk())).toBe(a);
    const b = desk({ paused: true });
    expect(statusOrSame(a, b)).toBe(b);
    expect(statusOrSame(undefined, a)).toBe(a);
  });
});

describe('latency', () => {
  test('from speech end, or from the ask for Answer now', () => {
    expect(answerLatency(ans({ speechEndAt: 9_600, firstTokenAt: 10_400 }))).toBe(800);
    expect(answerLatency(ans({ firstTokenAt: 10_700 }))).toBe(700);
    expect(answerLatency(ans({}))).toBeUndefined();
    expect(seconds(800)).toBe('0.8 s');
    expect(seconds(12_400)).toBe('12 s');
  });

  test('the readout is the newest answer that has a first word', () => {
    expect(lastLatency([ans({ firstTokenAt: 11_000 }), ans({ id: 'b', firstTokenAt: 10_500 }), ans({ id: 'c', state: 'streaming' })])).toBe(500);
    expect(lastLatency([])).toBeUndefined();
  });

  test('timings line on the meeting page', () => {
    expect(answerTimings(ans({ speechEndAt: 9_600, firstTokenAt: 10_400, doneAt: 12_000, model: 'cliproxy/claude-haiku-5-5' }))).toBe('First word 0.8 s after they stopped, done in 2.4 s, claude-haiku-5-5');
    expect(answerTimings(ans({}))).toBeUndefined();
  });
});

describe('overlay header', () => {
  const req: Req = async () => {
    throw new HubError(404, 'Not found');
  };
  const detail = (p: Partial<MeetingDetail> = {}): MeetingDetail => ({ id: 'mtg_1', accountId: 'owner', sessionId: 'ses_1', device: 'd', cwd: '/p', title: 'Sync', status: 'live', createdAt: 1, autoAnswer: 'questions', segments: [], answers: [], ...p });
  test('shows the provider and the last first word', () => {
    const v = emptyView();
    loadDetail(v, detail({ answers: [ans({ speechEndAt: 9_000, firstTokenAt: 9_600 })] }));
    const html = renderToStaticMarkup(<Live api={meetingApi(req)} view={v} desktop={desk({ sttProvider: 'deepgram' })} levels={levelSource()} ws="open" />);
    expect(html).toContain('Deepgram');
    expect(html).toContain('first word 0.6 s');
  });
});

describe('status notes', () => {
  test('fallback, channel errors and the upload queue show', () => {
    expect(statusNotes(desk({ sttFallback: 'Deepgram refused the token', mic: { ok: false, error: 'permission denied' }, queue: { stt: 0, upload: 3, dropped: 0 } }), 'open')).toEqual(['On local speech to text: Deepgram refused the token', 'no mic: permission denied', '3 waiting to upload']);
  });
});

describe('answer model menu', () => {
  test('hub default first, the list after, a saved ref the list lacks kept', () => {
    const o = modelOptions([{ ref: 'a/fast', label: 'Fast one', speed: 'fastest' }], 'gone/model');
    expect(o.map((x) => x.value)).toEqual(['', 'a/fast', 'gone/model']);
    expect(o[1]!.hint).toBe('Fastest');
  });
});

describe('speech to text in use', () => {
  test('a cloud choice with no key stays local', () => {
    expect(sttInUse('deepgram', () => false).provider).toBe('local');
    expect(sttInUse('deepgram', () => true).provider).toBe('deepgram');
    expect(sttInUse('local', () => false).words).toContain('Local');
  });
});
