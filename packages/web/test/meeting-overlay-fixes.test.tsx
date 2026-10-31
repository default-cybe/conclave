/**
 * Overlay fixes from the meeting-mode review: the recording dot follows the
 * capture, not a stale hub status (a hotkey resume), and level ticks that do
 * not move keep the same object so the live view does not render.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Live } from '../src/overlay/Live';
import { levelsOrSame } from '../src/overlay/frame';
import { meetingApi, HubError, type Req } from '../src/overlay/hub';
import { emptyView, loadDetail } from '../src/overlay/model';
import type { DesktopMeetingStatus, MeetingDetail } from '../src/overlay/wire';

const req: Req = async () => {
  throw new HubError(404, 'Not found');
};
const detail = (p: Partial<MeetingDetail> = {}): MeetingDetail => ({ id: 'mtg_1', accountId: 'owner', sessionId: 'ses_1', device: 'd', cwd: '/p', title: 'Sync', status: 'live', createdAt: 1, autoAnswer: 'questions', segments: [], answers: [], ...p });
const desk = (p: Partial<DesktopMeetingStatus>): DesktopMeetingStatus => ({
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

function render(status: MeetingDetail['status'], d?: DesktopMeetingStatus): string {
  const v = emptyView();
  loadDetail(v, detail({ status }));
  return renderToStaticMarkup(<Live api={meetingApi(req)} view={v} desktop={d} levels={{ me: 0, them: 0 }} ws="open" />);
}

describe('the recording dot', () => {
  test('hub paused but the capture resumed (hotkey): it says Listening', () => {
    const html = render('paused', desk({ paused: false }));
    expect(html).toContain('Listening');
    expect(html).not.toContain('ov-dot-paused');
  });

  test('capture paused: Paused, whatever the hub says', () => {
    expect(render('live', desk({ paused: true }))).toContain('ov-dot-paused');
  });

  test('no capture on this computer: the hub status decides', () => {
    expect(render('paused')).toContain('ov-dot-paused');
    expect(render('live')).not.toContain('ov-dot-paused');
  });
});

describe('levels', () => {
  test('a tick that moves less than 0.02 keeps the old object; a real change replaces it', () => {
    const a = { me: 0, them: 0 };
    expect(levelsOrSame(a, { me: 0.01, them: 0 })).toBe(a);
    const b = { me: 0.3, them: 0 };
    expect(levelsOrSame(a, b)).toBe(b);
  });
});
