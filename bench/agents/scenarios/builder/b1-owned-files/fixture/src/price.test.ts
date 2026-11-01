import { expect, test } from 'bun:test';
import { formatPrice } from './price';

test('formats cents with the currency code', () => {
  expect(formatPrice(1999)).toBe('19.99 EUR');
  expect(formatPrice(5, 'USD')).toBe('0.05 USD');
});
