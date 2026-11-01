import { expect, test } from 'bun:test';
import { toCsv, toMarkdown } from '../src/export';
import { parseCsv } from '../src/importers/csv';
import { SAMPLE } from './helpers';

test('toCsv round trips', () => {
  const entries = parseCsv(SAMPLE);
  const csv = toCsv(entries);
  expect(csv.split('\n')[3]).toBe('2026-03-03,"Rent, March",-950.00,home');
  expect(parseCsv(csv)).toEqual(entries);
});

test('toMarkdown formats money', () => {
  const md = toMarkdown(parseCsv(SAMPLE).slice(2, 4), 'USD');
  expect(md).toBe(
    ['| Date | Description | Category | Amount |', '|---|---|---|---:|', '| 2026-03-03 | Rent, March | home | -$950.00 |', '| 2026-03-05 | Salary | income | $3,200.00 |', ''].join('\n'),
  );
});

test('toMarkdown escapes pipes', () => {
  const md = toMarkdown(parseCsv('date,description,amount,category\n2026-03-10,a|b,1.00,x\n'), 'EUR');
  expect(md).toContain('| a\\|b | x | €1.00 |');
});
