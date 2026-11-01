import { expect, test } from 'bun:test';
import { reportLine } from './report';

test('report line rounds to cents', () => {
  expect(reportLine('food', [1.005, 2])).toBe('food: 3.01');
});
