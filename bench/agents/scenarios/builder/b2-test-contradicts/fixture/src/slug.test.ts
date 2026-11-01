import { expect, test } from 'bun:test';
import { slugify } from './slug';

test('lowercases and dashes spaces', () => {
  expect(slugify('Hello World')).toBe('hello-world');
});

test('keeps double dashes as written', () => {
  expect(slugify('a--b')).toBe('a--b');
});
