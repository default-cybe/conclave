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
import { fileNotes, modelOptions } from '../src/features/meeting/MeetingForm';
import { memberStt, SttBody, sttInUse } from '../src/features/settings/meetings';
import type { DesktopMeetingStatus, MeetingAnswer, MeetingDetail } from '../src/overlay/wire';
import { readOpacity } from '../src/overlay/opacity';

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
    expect(answerLatency(ans({ segmentEndAt: 9_600, firstTokenAt: 10_400 }))).toBe(800);
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
    expect(answerTimings(ans({ segmentEndAt: 9_600, firstTokenAt: 10_400, doneAt: 12_000, model: 'cliproxy/claude-haiku-5-5' }))).toBe('First word 0.8 s after they stopped, done in 2.4 s, claude-haiku-5-5');
    expect(answerTimings(ans({}))).toBeUndefined();
  });
});

describe('overlay header', () => {
  const req: Req = async () => {
    throw new HubError(404, 'Not found');
  };
  const detail = (p: Partial<MeetingDetail> = {}): MeetingDetail => ({ id: 'mtg_1', accountId: 'owner', sessionId: 'ses_1', device: 'd', cwd: '/p', title: 'Sync', status: 'live', createdAt: 1, autoAnswer: 'questions', segments: [], answers: [], files: [], liveModel: { ref: 'a/fast' }, ...p });
  test('shows the provider and the last first word', () => {
    const v = emptyView();
    loadDetail(v, detail({ answers: [ans({ segmentEndAt: 9_000, firstTokenAt: 9_600 })] }));
    const html = renderToStaticMarkup(<Live api={meetingApi(req)} view={v} desktop={desk({ stt: { state: 'ready', provider: 'deepgram' } })} levels={levelSource()} ws="open" />);
    expect(html).toContain('Deepgram');
    expect(html).toContain('first word 0.6 s');
  });
});

describe('status notes', () => {
  test('a cloud failure, channel errors and the upload queue show; no fallback note', () => {
    const failed = desk({ stt: { state: 'failed', provider: 'deepgram', error: 'Mic: deepgram unreachable: refused' }, mic: { ok: false, error: 'permission denied' }, queue: { stt: 0, upload: 3, dropped: 0 } });
    expect(statusNotes(failed, 'open')).toEqual(['Speech to text failed, retrying. Mic: deepgram unreachable: refused', 'no mic: permission denied', '3 waiting to upload']);
    // the local model's own failure (Local chosen) keeps its words
    expect(statusNotes(desk({ stt: { state: 'failed', provider: 'local', error: 'bad file' } }), 'open')).toEqual(['Speech model failed: bad file']);
  });

  test('a cloud failure shows a Retry in the overlay', () => {
    const v = emptyView();
    v.meeting = { id: 'mtg_1', title: 'Sync', status: 'live', startedAt: Date.now() } as never;
    const html = renderToStaticMarkup(<Live api={meetingApi(async () => ({}) as never)} view={v} desktop={desk({ stt: { state: 'failed', provider: 'deepgram', error: 'Mic: 412 No Deepgram key is set.' } })} levels={levelSource()} ws="open" />);
    expect(html).toContain('Retry');
    expect(html).toContain('No Deepgram key is set');
    expect(html).not.toContain('this computer');
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
  test('a cloud choice with no key never turns into local', () => {
    expect(sttInUse('deepgram', () => false)).toMatchObject({ provider: 'deepgram', missing: true });
    expect(sttInUse('deepgram', () => true).provider).toBe('deepgram');
    expect(sttInUse('local', () => false).words).toContain('slower, uses your computer');
  });

  test('a member: their own first key, and no "Use" button (PATCH /api/config is admin only)', () => {
    expect(memberStt([])).toBe('deepgram');
    expect(memberStt(['stt.deepgram'])).toBe('deepgram');
    expect(memberStt(['stt.assemblyai'])).toBe('assemblyai');
    expect(memberStt(['stt.assemblyai', 'stt.deepgram'])).toBe('deepgram');
    const reload = async () => {};
    const asOwner = renderToStaticMarkup(<SttBody chosen="deepgram" values={['stt.deepgram']} reload={reload} first="local" />);
    expect(asOwner).toContain('Use Local');
    const asMember = renderToStaticMarkup(<SttBody chosen="deepgram" values={['stt.deepgram']} reload={reload} member first="local" />);
    expect(asMember).not.toContain('Use Local');
    expect(asMember).toContain('your first saved key');
  });

  test('Deepgram is listed first, marked Recommended, with its free credit', () => {
    const html = renderToStaticMarkup(<SttBody chosen="local" values={[]} reload={async () => {}} />);
    const names = [...html.matchAll(/<button[^>]*aria-pressed[^>]*><span[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(['Deepgram', 'AssemblyAI', 'Local']);
    expect(html.indexOf('Recommended')).toBeGreaterThan(html.indexOf('Deepgram'));
    expect(html.indexOf('Recommended')).toBeLessThan(html.indexOf('AssemblyAI'));
    expect(html).toContain('$200 free credit');
  });
});

describe('overlay opacity', () => {
  const store = (v: string | null) => ({ getItem: () => v });
  test('60 to 100 is kept; nothing, junk or out of range reads as 80', () => {
    expect(readOpacity(store('60'))).toBe(60);
    expect(readOpacity(store('100'))).toBe(100);
    for (const v of [null, '', 'abc', '59', '101', '-5']) expect(readOpacity(store(v))).toBe(80);
    expect(readOpacity(undefined)).toBe(80);
    expect(readOpacity({ getItem: () => { throw new Error('denied'); } })).toBe(80);
  });
});

describe('file notes', () => {
  test('a file the hub could not read is named with the reason', () => {
    expect(fileNotes([{ name: 'a.txt' }])).toBe('');
    expect(fileNotes([{ name: 'a.txt' }, { name: 'cv.pdf', note: 'PDF text could not be read (pdftotext is not on the hub).' }])).toBe('cv.pdf: PDF text could not be read (pdftotext is not on the hub).');
  });
});
