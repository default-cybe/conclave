/**
 * Speech end to first paint: the overlay reports each answer's first paint
 * once (AnswerCard.tsx paintReporter, POST .../paint), and the meeting page
 * shows each answer's steps and the p50/p95 over the meeting (model.ts
 * stepTimes, latencyStats; MeetingPage.tsx answerSteps, latencyLine).
 *
 *   bun test packages/web/test/meeting-latency.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AnswerCard, paintReporter } from '../src/overlay/AnswerCard';
import { meetingApi, type Req } from '../src/overlay/hub';
import { answerLatency, latencyStats, stepTimes } from '../src/overlay/model';
import { answerSteps, latencyLine } from '../src/features/meeting/MeetingPage';
import type { AnswerPaintInput as AnswerPaint, MeetingAnswer } from '../src/overlay/wire';

const ans = (p: Partial<MeetingAnswer>): MeetingAnswer => ({ id: 'a', meetingId: 'm', messageId: 'x', trigger: 'question', question: '', state: 'done', createdAt: 10_000, ...p });

describe('latency stats', () => {
  test('p50 and p95 by nearest rank over answers with a paint and a speech end', () => {
    const list = [500, 1000, 1500, 2000, 4000].map((ms, i) => ans({ id: `a${i}`, speechEndAt: 1000, paintedAt: 1000 + ms }));
    expect(latencyStats(list)).toEqual({ p50: 1500, p95: 4000, n: 5 });
    // no paint, or no speech end (Answer now): left out
    expect(latencyStats([...list, ans({ paintedAt: 9_000 }), ans({ speechEndAt: 9_000, firstTokenAt: 9_500 })])).toEqual({ p50: 1500, p95: 4000, n: 5 });
    expect(latencyLine(list)).toBe('Speech end to first word: p50 1.5 s, p95 4.0 s (5)');
  });

  test('n = 0 renders nothing', () => {
    expect(latencyStats([])).toBeUndefined();
    expect(latencyLine([ans({ firstTokenAt: 10_500 })])).toBeUndefined();
  });

  test('steps from speech end, and the first word switches to the paint', () => {
    const a = ans({ speechEndAt: 9_000, segmentEndAt: 8_000, finalAt: 9_200, receivedAt: 9_300, requestAt: 9_310, firstTokenAt: 9_800, paintedAt: 9_870 });
    expect(stepTimes(a)).toEqual([
      { step: 'final', ms: 200 },
      { step: 'hub', ms: 300 },
      { step: 'request', ms: 310 },
      { step: 'first token', ms: 800 },
      { step: 'painted', ms: 870 },
    ]);
    expect(answerSteps(a)).toBe('Speech end, final 0.2 s, hub 0.3 s, request 0.3 s, first token 0.8 s, painted 0.9 s');
    expect(answerLatency(a)).toBe(870);
    // an older hub: no paint, the first token from segmentEndAt as before
    expect(answerLatency(ans({ segmentEndAt: 9_600, firstTokenAt: 10_400 }))).toBe(800);
    expect(answerSteps(ans({}))).toBeUndefined();
  });
});

describe('first paint report', () => {
  const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    const req = createRequire(join(import.meta.dir, '../../core/package.json'));
    const dom = req('linkedom').parseHTML('<!doctype html><html><body></body></html>');
    const g = globalThis as Record<string, unknown>;
    for (const k of GLOBALS) saved[k] = g[k];
    g.window = dom.window;
    g.document = dom.document;
    g.navigator = dom.window.navigator;
    g.HTMLElement = dom.window.HTMLElement;
    g.Node = dom.window.Node;
    g.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const k of GLOBALS) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  });

  test('posts once, after the first visible words, with finite numbers', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const posts: { method: string; path: string; body: AnswerPaint }[] = [];
    const req: Req = async <T,>(method: string, path: string, body?: unknown) => (posts.push({ method, path, body: body as AnswerPaint }), undefined as T);
    const api = meetingApi(req);
    const frames: (() => void)[] = [];
    const onPaint = paintReporter((id, b) => api.paint('mtg_1', id, b), (cb) => frames.push(cb));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const a = ans({ id: 'ans_1', state: 'streaming' });
    const show = (text: string, answer = a) => act(async () => root.render(<AnswerCard answer={answer} text={text} onPaint={onPaint} />));
    const flush = async () => {
      for (const f of frames.splice(0)) f();
      await Bun.sleep(0);
    };

    // "Say this:" alone, and a bullet marker still undecided: nothing on screen yet
    await show('Say this:');
    await show('Say this:\n-');
    await flush();
    expect(posts).toHaveLength(0);

    await show('Say this:\n- The export');
    expect(posts).toHaveLength(0); // waits for the frame
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe('POST');
    expect(posts[0]!.path).toBe('/api/meetings/mtg_1/answers/ans_1/paint');
    expect(Number.isFinite(posts[0]!.body.paintedAt)).toBe(true);
    expect(Number.isFinite(posts[0]!.body.sentAt)).toBe(true);

    // later deltas, and the card mounting again (stepping back to it), post no more
    await show('Say this:\n- The export is merged');
    await act(async () => root.render(<div />));
    await show('Say this:\n- The export is merged behind a flag.');
    await flush();
    expect(posts).toHaveLength(1);

    // an answer that was done before it showed is not a first paint
    await show('Say this:\n- Old answer', ans({ id: 'ans_0', state: 'done' }));
    await flush();
    expect(posts).toHaveLength(1);
    await act(async () => root.unmount());
  });
});
