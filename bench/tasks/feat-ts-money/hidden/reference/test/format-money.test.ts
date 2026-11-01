import { expect, test } from 'bun:test';
import { formatMoney } from '../src/money';

test('formatMoney', () => {
  expect(formatMoney(-123456, 'USD')).toBe('-$1,234.56');
  expect(formatMoney(5, 'GBP')).toBe('£0.05');
  expect(formatMoney(120000, 'JPY')).toBe('¥1,200');
  expect(formatMoney(123456, 'EUR', 'de-DE')).toContain('1.234,56');
});
