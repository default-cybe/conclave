import { expect, test } from 'bun:test';
import { parseCsv } from '../src/importers/csv';
import { buildReport, monthsWithEntries, renderReport } from '../src/report';
import { SAMPLE } from './helpers';

test('buildReport totals a month by category', () => {
  const r = buildReport(parseCsv(SAMPLE), { month: '2026-03', currency: 'usd' });
  expect(r.currency).toBe('USD');
  expect(r.totalCents).toBe(-1450 - 95000 + 320000 - 8225 - 1275);
  expect(r.categories.map((c) => c.name)).toEqual(['food', 'fun', 'home', 'income']);
  expect(r.categories[0]).toEqual({ name: 'food', totalCents: -9675, count: 2 });
  expect(r.entries).toHaveLength(5);
});

test('category filter', () => {
  const r = buildReport(parseCsv(SAMPLE), { month: '2026-03', currency: 'USD', category: 'food' });
  expect(r.totalCents).toBe(-9675);
  expect(r.categories).toHaveLength(1);
});

test('renderReport text', () => {
  const text = renderReport(buildReport(parseCsv(SAMPLE), { month: '2026-03', currency: 'USD' }));
  expect(text).toBe(
    [
      'Report for 2026-03 (USD)',
      '',
      '  food             -$96.75  2 entries',
      '  fun              -$12.75  1 entry',
      '  home            -$950.00  1 entry',
      '  income         $3,200.00  1 entry',
      '',
      '  Total          $2,140.50  5 entries',
      '',
    ].join('\n'),
  );
});

test('monthsWithEntries', () => {
  expect(monthsWithEntries(parseCsv(SAMPLE))).toEqual(['2026-02', '2026-03']);
});
