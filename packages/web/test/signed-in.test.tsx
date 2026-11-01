/**
 * Signed in (Settings, Your account): the apps a person is signed in with,
 * which are not devices (lib/apps.ts). Plain names and kinds, online or last
 * seen, This browser marked, and Sign out on each: the hub lets any of a
 * person's apps sign out the others (DELETE /api/clients/:id).
 *
 *   bun test packages/web/test/signed-in.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { AppDto } from '@conclave/core/client';
import { appKind, isThisBrowser, signedIn, signedInWords } from '../src/lib/apps';
import { SignedInView, appLine } from '../src/features/settings/signedin';

const app = (p: Partial<AppDto>): AppDto => ({ id: 'cli_x', name: 'Chrome on Mac', platform: 'web', createdAt: 1, revoked: false, accountId: 'owner', ...p });

describe('the list', () => {
  const pixel = app({ id: 'cli_pixel', name: 'Pixel 8', platform: 'android', lastSeenAt: 50 });
  const chrome = app({ id: 'cli_chrome', name: 'Chrome on Mac', online: true, lastSeenAt: 10 });
  const old = app({ id: 'cli_old', name: 'Safari on iOS', platform: 'ios', lastSeenAt: 90, revoked: true });
  const cli = app({ id: 'cli_term', name: 'studio', platform: 'linux', createdAt: 70 });

  test('signed in apps only, the connected ones first, then the last seen', () => {
    expect(signedIn([pixel, chrome, old, cli]).map((a) => a.name)).toEqual(['Chrome on Mac', 'studio', 'Pixel 8']);
    expect(signedIn({ a: pixel, b: old }).map((a) => a.id)).toEqual(['cli_pixel']);
  });

  test('each says what it is in plain words', () => {
    expect(appKind({ platform: 'android' })).toBe('Android');
    expect(appKind({ platform: 'ios' })).toBe('iPhone');
    expect(appKind({ platform: 'web' })).toBe('Browser');
    expect(appKind({ platform: 'desktop' })).toBe('Desktop app');
    expect(appKind({ platform: 'darwin' })).toBe('Terminal on macOS');
    expect(appKind({ platform: undefined })).toBe('App');
    expect(appLine(chrome, 100)).toEqual({ kind: 'Browser', seen: 'online', online: true });
    expect(appLine(pixel, 50 + 3 * 3_600_000).seen).toBe('last seen 3h ago');
    expect(appLine(app({ lastSeenAt: undefined }), 100).seen).toBe('not seen yet');
  });

  test('the Devices foot line counts them', () => {
    expect(signedInWords(1)).toBe('1 phone or browser signed in');
    expect(signedInWords(3)).toBe('3 phones and browsers signed in');
  });
});

describe('Sign out', () => {
  const pixel = app({ id: 'cli_pixel' });
  test('this browser is the app it signed in as', () => {
    expect(isThisBrowser(pixel, { clientId: 'cli_pixel' })).toBe(true);
    expect(isThisBrowser(pixel, { clientId: 'cli_other' })).toBe(false);
    // the hub token is no app
    expect(isThisBrowser(pixel, {})).toBe(false);
    expect(isThisBrowser(pixel, null)).toBe(false);
  });
});

describe('Settings, Your account', () => {
  const apps = signedIn([
    app({ id: 'cli_pixel', name: 'Pixel 8', platform: 'android', online: true }),
    app({ id: 'cli_chrome', name: 'Chrome on Mac', lastSeenAt: Date.now() - 2 * 3_600_000 }),
    app({ id: 'cli_gone', name: 'Old phone', revoked: true }),
  ]);
  const render = (conn: { clientId?: string } | null) =>
    renderToStaticMarkup(
      <Router>
        <SignedInView apps={apps} conn={conn} onEnd={() => {}} />
      </Router>,
    );

  test('lists the apps with Sign out, and no dashes in its words', () => {
    const html = render({});
    expect(html).toContain('id="signed-in"');
    expect(html).toContain('Signed in');
    expect(html).toContain('Pixel 8');
    expect(html).toContain('Android, <span class="text-ok">online</span>');
    expect(html).toContain('Chrome on Mac');
    expect(html).toContain('last seen 2h ago');
    expect(html).not.toContain('Old phone');
    expect(html).not.toContain('This browser');
    // the hub token (no app of its own here): Sign out on each
    expect(html.match(/>Sign out</g)?.length).toBe(2);
    expect(html).toContain('Browser, <span>last seen 2h ago</span>');
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });

  test('this browser is marked, and every app has Sign out', () => {
    const html = render({ clientId: 'cli_chrome' });
    expect(html.match(/This browser/g)?.length).toBe(1);
    expect(html.match(/>Sign out</g)?.length).toBe(2);
    expect(html).not.toContain('hub token');
  });

  test('with no apps it says how to add one', () => {
    const html = renderToStaticMarkup(
      <Router>
        <SignedInView apps={[]} conn={null} onEnd={() => {}} />
      </Router>,
    );
    expect(html).toContain('No apps yet');
  });
});
