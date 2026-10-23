import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { main } from '../../src/cli';
import { formatDate, monthKey, parseDate } from '../../src/dates';
import { toCsv } from '../../src/export';
import { filterEntries } from '../../src/filter';
import { parseCsv } from '../../src/importers/csv';
import { buildReport, monthsWithEntries } from '../../src/report';

// This file runs once per time zone (see task.json). Say which one in the test names.
const TZ = process.env.TZ ?? 'unset';

const LEDGER = `date,description,amount,category
2026-02-28,Groceries,-41.20,food
2026-03-01,Salary,2450.00,income
2026-03-08,Brunch,-30.00,food
2026-03-29,Cinema,-12.00,fun
2026-03-31,Rent,-950.00,home
2026-04-01,Phone bill,-29.00,home
2026-10-25,Train,-18.00,transport
2026-11-01,Gym,-35.00,fun
2026-12-31,Party,-60.00,fun
2027-01-01,Coffee,-3.50,food
`;

const entries = () => parseCsv(LEDGER);
const days = (list: { date: Date }[]) => list.map((e) => formatDate(e.date));

test(`[${TZ}] dates read back as the same day`, () => {
  for (const d of ['2026-02-28', '2026-03-01', '2026-03-08', '2026-03-29', '2026-03-31', '2026-04-01', '2026-10-25', '2026-11-01', '2026-12-31', '2027-01-01']) {
    expect(formatDate(parseDate(d))).toBe(d);
  }
});

test(`[${TZ}] month of a day`, () => {
  expect(monthKey(parseDate('2026-03-01'))).toBe('2026-03');
  expect(monthKey(parseDate('2026-03-31'))).toBe('2026-03');
  expect(monthKey(parseDate('2026-04-01'))).toBe('2026-04');
  expect(monthKey(parseDate('2027-01-01'))).toBe('2027-01');
});

test(`[${TZ}] March holds its first and last day and nothing else`, () => {
  expect(days(filterEntries(entries(), { month: '2026-03' }))).toEqual(['2026-03-01', '2026-03-08', '2026-03-29', '2026-03-31']);
});

test(`[${TZ}] month edges around the year end`, () => {
  expect(days(filterEntries(entries(), { month: '2026-12' }))).toEqual(['2026-12-31']);
  expect(days(filterEntries(entries(), { month: '2027-01' }))).toEqual(['2027-01-01']);
  expect(days(filterEntries(entries(), { month: '2026-10' }))).toEqual(['2026-10-25']);
  expect(days(filterEntries(entries(), { month: '2026-11' }))).toEqual(['2026-11-01']);
});

test(`[${TZ}] report total for March`, () => {
  const r = buildReport(entries(), { month: '2026-03', currency: 'USD' });
  expect(r.totalCents).toBe(245000 - 3000 - 1200 - 95000);
  expect(r.entries).toHaveLength(4);
});

test(`[${TZ}] months with entries`, () => {
  expect(monthsWithEntries(entries())).toEqual(['2026-02', '2026-03', '2026-04', '2026-10', '2026-11', '2026-12', '2027-01']);
});

test(`[${TZ}] CSV export keeps the days`, () => {
  expect(toCsv(entries())).toBe(LEDGER);
});

test(`[${TZ}] the command line shows March 31`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerkit-tz-'));
  writeFileSync(join(dir, 'ledger.csv'), LEDGER);
  let out = '';
  const io = { stdout: (s: string) => (out += s), stderr: () => {}, env: {}, cwd: dir };
  expect(await main(['list', '--month', '2026-03'], io)).toBe(0);
  const lines = out.trim().split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[0]).toStartWith('2026-03-01');
  expect(lines[3]).toStartWith('2026-03-31');
  out = '';
  expect(await main(['report', '--month', '2026-03'], io)).toBe(0);
  expect(out).toContain('$1,458.00');
  expect(out).toContain('4 entries');
});
