/**
 * The big, simple overlay (Live.tsx): one top bar with four controls, the
 * transcript strip, the answer region, the calm empty line, the share icon only
 * when the overlay shows in shares, Space answers now, and the text size that
 * is kept on the device (textsize.ts).
 *   bun test packages/web/test/meeting-overlay-layout.test.tsx
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { clickKeyLabel, isAnswerKey, Live, Menu, statusNotes } from '../src/overlay/Live';
import { levelSource } from '../src/overlay/frame';
import { HubError, meetingApi, type Req } from '../src/overlay/hub';
import { emptyView, loadDetail } from '../src/overlay/model';
import { readTextSize, stepTextSize, TEXT_DEFAULT, TEXT_MAX, TEXT_MIN } from '../src/overlay/textsize';
import type { DesktopMeetingStatus, MeetingDetail } from '../src/overlay/wire';

let parse: (html: string) => Document;
beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom') as { parseHTML: (h: string) => { document: Document } };
  parse = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
});

const req: Req = async () => {
  throw new HubError(404, 'Not found');
};
const detail = (p: Partial<MeetingDetail> = {}): MeetingDetail => ({ id: 'mtg_1', accountId: 'owner', sessionId: 'ses_1', device: 'd', cwd: '/p', title: 'Sync', status: 'live', createdAt: 1, autoAnswer: 'questions', segments: [], answers: [], ...p });
const desk = (p: Partial<DesktopMeetingStatus> = {}): DesktopMeetingStatus => ({
  meetingId: 'mtg_1',
  live: true,
  paused: false,
  clickThrough: false,
  hiddenForShare: false,
  exclusion: 'full',
  mic: { ok: true },
  system: { ok: true },
  stt: { state: 'ready', provider: 'deepgram' },
  queue: { stt: 0, upload: 0, dropped: 0 },
  ...p,
});

function live(d: DesktopMeetingStatus = desk(), p: Partial<MeetingDetail> = {}): Document {
  const v = emptyView();
  loadDetail(v, detail(p));
  return parse(renderToStaticMarkup(<Live api={meetingApi(req)} view={v} desktop={d} levels={levelSource()} ws="open" />));
}

describe('layout', () => {
  test('one top bar, the transcript strip and the answer region, in that order', () => {
    const doc = live();
    const kids = [...doc.querySelector('.ov-live')!.children].map((e) => e.className);
    expect(kids).toEqual(['ov-top', 'ov-strip', 'ov-answer']);
  });

  test('the top bar has four controls: Answer now, Pause, Hide and More', () => {
    const buttons = [...live().querySelectorAll('.ov-top button')];
    expect(buttons.length).toBe(4);
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent!.replace('Space', '').trim())).toEqual(['Answer now', 'Pause', 'Hide', 'More']);
    // nothing else visible: no meters, no link buttons, no menu until it is opened
    expect(live().querySelectorAll('button').length).toBe(4);
  });

  test('listening with no answer: one calm line', () => {
    expect(live().querySelector('.ov-answer')!.textContent).toBe('Listening. Answers appear here when someone asks you something.');
  });

  test('the share icon shows only when the overlay is visible in shares', () => {
    expect(live().querySelector('.ov-share')).toBeNull();
    expect(live(desk({ exclusion: 'unsupported' })).querySelector('.ov-share')!.getAttribute('aria-label')).toBe('Visible in screen shares');
  });

  test('the menu holds the rest: text size, opacity, click-through, auto answers, end meeting', () => {
    const noop = () => undefined;
    const text = parse(renderToStaticMarkup(<Menu autoAnswer onAutoAnswer={noop} onClickThrough={noop} onEnd={noop} />)).body.textContent!;
    for (const w of ['Text size', 'A-', 'A+', 'Opacity', 'Click-through', 'Auto answers: on', 'End meeting']) expect(text).toContain(w);
  });

  test('click-through on: a pill that takes no clicks says how to turn it off; the menu names the key that works', () => {
    expect(live().querySelector('.ov-ct-pill')).toBeNull();
    const pill = live(desk({ clickThrough: true, clickKey: 'CommandOrControl+Alt+T' })).querySelector('.ov-ct-pill')!;
    expect(pill.tagName).toBe('P');
    expect(pill.querySelector('button, a')).toBeNull();
    expect(pill.textContent).toMatch(/^Click-through on · (⌘⌥T|Ctrl\+Alt\+T) to turn off$/);
    expect(clickKeyLabel('CommandOrControl+Alt+T', true)).toBe('⌘⌥T');
    expect(clickKeyLabel('CommandOrControl+Alt+T', false)).toBe('Ctrl+Alt+T');
    expect(clickKeyLabel('CommandOrControl+Alt+Shift+T', true)).toBe('⌘⌥⇧T');
    expect(clickKeyLabel('CommandOrControl+Alt+Shift+T', false)).toBe('Ctrl+Alt+Shift+T');
    const noop = () => undefined;
    const menu = parse(renderToStaticMarkup(<Menu autoAnswer clickKey="CommandOrControl+Alt+Shift+T" onAutoAnswer={noop} onClickThrough={noop} onEnd={noop} />)).body.textContent!;
    expect(menu).toMatch(/Click-through \((⌘⌥⇧T|Ctrl\+Alt\+Shift\+T) turns it off\)/);
  });

  test('the system sound note shows while capture runs', () => {
    const note = "Not hearing the meeting. Check the meeting app's speaker.";
    expect(statusNotes(desk({ system: { ok: true, device: 'global tap (all apps)', error: note } }), 'open')).toEqual([note]);
    expect(statusNotes(desk(), 'open')).toEqual([]);
  });
});

test('Space answers now, except in a field or on a button', () => {
  const key = (k: string, p = {}) => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...p });
  expect(isAnswerKey(key(' '), null)).toBe(true);
  expect(isAnswerKey(key(' '), { tagName: 'DIV' } as unknown as EventTarget)).toBe(true);
  expect(isAnswerKey(key(' '), { tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
  expect(isAnswerKey(key(' '), { tagName: 'INPUT' } as unknown as EventTarget)).toBe(false);
  expect(isAnswerKey(key(' ', { repeat: true }), null)).toBe(false);
  expect(isAnswerKey(key(' ', { ctrlKey: true }), null)).toBe(false);
  expect(isAnswerKey(key('a'), null)).toBe(false);
});

describe('text size', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  test('19 px at first; A- and A+ step by one and are kept', () => {
    const s = mem();
    expect(readTextSize(s)).toBe(TEXT_DEFAULT);
    expect(stepTextSize(readTextSize(s), 1, s)).toBe(20);
    expect(readTextSize(s)).toBe(20);
    expect(stepTextSize(TEXT_MAX, 1, s)).toBe(TEXT_MAX);
    expect(stepTextSize(TEXT_MIN, -1, s)).toBe(TEXT_MIN);
    expect(readTextSize(s)).toBe(TEXT_MIN);
  });
  test('junk or out of range reads as 19', () => {
    for (const v of [null, '', 'x', '15', '27', '19.5']) expect(readTextSize({ getItem: () => v })).toBe(TEXT_DEFAULT);
    expect(readTextSize({ getItem: () => { throw new Error('denied'); } })).toBe(TEXT_DEFAULT);
  });
});
