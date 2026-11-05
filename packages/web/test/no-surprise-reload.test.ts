/**
 * The app does not load itself again behind the owner's back: the desktop
 * app's hidden window moves inside the page (lib/desktopNav.ts), and
 * app.start says why a page loaded, so a browser's discard or the owner's
 * reload is told apart in the hub's logs (lib/clientLog.ts).
 *
 *   bun test packages/web/test/no-surprise-reload.test.ts
 */
import { expect, test } from 'bun:test';
import { DESKTOP_NAVIGATE, listenDesktopNavigate } from '../src/lib/desktopNav';
import { loadKind } from '../src/lib/clientLog';

test('the desktop app moves the page to a hub path without loading it, and only to a path', () => {
  const target = new EventTarget();
  const went: string[] = [];
  const stop = listenDesktopNavigate(target, (to) => went.push(to));
  for (const detail of ['/', '/s/ses_1?new=1', '//evil.example/x', 'https://evil.example/', 42, undefined]) target.dispatchEvent(new CustomEvent(DESKTOP_NAVIGATE, { detail }));
  expect(went).toEqual(['/', '/s/ses_1?new=1']);
  stop();
  target.dispatchEvent(new CustomEvent(DESKTOP_NAVIGATE, { detail: '/chats' }));
  expect(went).toEqual(['/', '/s/ses_1?new=1']);
});

test('app.start says how the page loaded and whether the browser had discarded it', () => {
  const perf = (type?: string) => ({ getEntriesByType: () => (type ? [{ type }] : []) }) as unknown as Pick<Performance, 'getEntriesByType'>;
  expect(loadKind(perf('reload'), {})).toEqual({ load: 'reload' });
  expect(loadKind(perf('navigate'), { wasDiscarded: true })).toEqual({ load: 'navigate', discarded: true });
  // WebKit without navigation timing, or no performance at all: nothing to say
  expect(loadKind(perf(), { wasDiscarded: false })).toEqual({});
  expect(loadKind(undefined, {})).toEqual({});
});
