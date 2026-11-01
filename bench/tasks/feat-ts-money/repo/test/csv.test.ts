import { expect, test } from 'bun:test';
import { formatDate } from '../src/dates';
import { parseCsv, splitCsvLine } from '../src/importers/csv';
import { SAMPLE } from './helpers';

test('splitCsvLine handles quotes', () => {
  expect(splitCsvLine('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"']);
  expect(() => splitCsvLine('"open')).toThrow('unterminated');
});

test('parseCsv reads the sample', () => {
  const entries = parseCsv(SAMPLE);
  expect(entries).toHaveLength(6);
  expect(formatDate(entries[1].date)).toBe('2026-03-02');
  expect(entries[1].amountCents).toBe(-1450);
  expect(entries[2].description).toBe('Rent, March');
  expect(entries[5].description).toBe('Book "Dune"');
  expect(entries[3].amountCents).toBe(320000);
});

test('columns may be reordered and category may be empty', () => {
  const entries = parseCsv('amount,category,date,description\n7.25,,2026-01-09,Bus\n');
  expect(entries[0].amountCents).toBe(725);
  expect(entries[0].category).toBe('uncategorized');
});

test('errors name the line', () => {
  expect(() => parseCsv('date,description,amount,category\n2026-01-01,x,abc,y\n')).toThrow('line 2');
  expect(() => parseCsv('date,description,amount\n')).toThrow('missing column: category');
});
