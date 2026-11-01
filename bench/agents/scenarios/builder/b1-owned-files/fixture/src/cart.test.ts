import { expect, test } from 'bun:test';
import { cartTotal } from './cart';

test('multiplies by quantity', () => {
  expect(cartTotal([{ cents: 250, qty: 2 }, { cents: 100, qty: 1 }])).toBe(600);
});
