import { expect, test } from 'bun:test';
import { expired } from './deadline';

test('a step that has run for 2 seconds is still within its time', () => {
  expect(expired(0, 2_000)).toBe(false);
});
