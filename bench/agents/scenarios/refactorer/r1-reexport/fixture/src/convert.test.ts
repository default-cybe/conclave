import { expect, test } from 'bun:test';
import { toCelsius } from './index';
import { converter } from './registry';

test('converts and rounds to one decimal', () => {
  expect(toCelsius(100)).toBe(37.8);
  expect(converter('c')(32)).toBe(0);
});
