import { expect, test } from 'bun:test';
import { formatDate, isMonth, monthKey, parseDate } from '../src/dates';
import { filterEntries } from '../src/filter';
import { parseCsv } from '../src/importers/csv';
import { SAMPLE } from './helpers';

test('parseDate and formatDate round trip', () => {
  expect(formatDate(parseDate('2026-03-15'))).toBe('2026-03-15');
  expect(monthKey(parseDate('2026-11-15'))).toBe('2026-11');
});

test('parseDate rejects bad days', () => {
  expect(() => parseDate('2026-02-30')).toThrow('invalid date');
  expect(() => parseDate('15/03/2026')).toThrow('invalid date');
});

test('isMonth', () => {
  expect(isMonth('2026-03')).toBe(true);
  expect(isMonth('2026-13')).toBe(false);
  expect(isMonth('2026-3')).toBe(false);
});

test('filter by month', () => {
  const march = filterEntries(parseCsv(SAMPLE), { month: '2026-03' });
  expect(march.map((e) => e.description)).toEqual(['Coffee beans', 'Rent, March', 'Salary', 'Groceries', 'Book "Dune"']);
});
