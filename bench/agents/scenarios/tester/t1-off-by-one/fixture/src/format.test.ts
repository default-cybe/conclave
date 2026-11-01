import { expect, test } from 'bun:test';
import { plural } from './format';

test('plural adds s except for one', () => {
  expect(plural(1, 'page')).toBe('1 page');
  expect(plural(3, 'page')).toBe('3 pages');
});
