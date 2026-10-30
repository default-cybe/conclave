/**
 * The desktop start page when the saved hub does not open (src/start.js):
 * a late network at login retries, only a refused token asks to sign in.
 *
 *   bun test packages/desktop/test
 */
import { expect, test } from 'bun:test';
import { afterOpenFailed, retryDelay } from '../src/start.js';

const saved = { hubUrl: 'https://hub.example.com/', hasToken: true };

test('a saved hub and token keep trying when the hub cannot be reached', () => {
  expect(afterOpenFailed(saved, 'Cannot reach https://hub.example.com: Dns Failed: failed to lookup address information')).toBe('retry');
  expect(afterOpenFailed(saved, 'The hub answered HTTP 502.')).toBe('retry');
});

test('the hub turning the token away (401/403) shows the sign-in form', () => {
  expect(afterOpenFailed(saved, 'The hub rejected this token or code. Sign in again.')).toBe('form');
});

test('no saved hub or no token shows the sign-in form', () => {
  expect(afterOpenFailed({ hubUrl: null, hasToken: false }, 'No hub is set up yet.')).toBe('form');
  expect(afterOpenFailed({ hubUrl: 'https://hub.example.com/', hasToken: false }, 'Cannot reach')).toBe('form');
});

test('backoff: 1, 2, 4, 8 s, then every 15 s', () => {
  expect([0, 1, 2, 3, 4, 5, 50].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
});
