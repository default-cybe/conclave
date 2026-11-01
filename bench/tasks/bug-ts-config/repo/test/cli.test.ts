import { expect, test } from 'bun:test';
import { main } from '../src/cli';
import { fakeIO, SAMPLE, tempDir } from './helpers';

test('report for a month', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['report', '--month', '2026-03'], io)).toBe(0);
  expect(io.out).toStartWith('Report for 2026-03 (USD)\n');
  expect(io.out).toContain('Total          $2,140.50  5 entries');
});

test('report defaults to the latest month', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['report'], io)).toBe(0);
  expect(io.out).toStartWith('Report for 2026-03');
});

test('list with search', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['list', '--search', 'COFFEE'], io)).toBe(0);
  expect(io.out).toBe('2026-03-02       -$14.50  food          Coffee beans\n');
});

test('export as markdown with --data', async () => {
  const dir = tempDir({ 'books.csv': SAMPLE });
  const io = fakeIO(dir);
  expect(await main(['export', '--month=2026-02', '--as', 'md', '--data', 'books.csv'], io)).toBe(0);
  expect(io.out).toContain('| 2026-02-14 | Flowers | gifts | -$25.00 |');
});

test('currency flag without a config file', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['report', '--month', '2026-03', '--currency', 'GBP'], io)).toBe(0);
  expect(io.out).toStartWith('Report for 2026-03 (GBP)');
  expect(io.out).toContain('£2,140.50');
});

test('usage errors exit 2', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['report', '--month', 'March'], io)).toBe(2);
  expect(io.err).toContain('invalid month');
  expect(await main(['report', '--colour', 'red'], io)).toBe(2);
  expect(await main(['frobnicate'], io)).toBe(2);
});

test('missing ledger exits 1', async () => {
  const io = fakeIO(tempDir());
  expect(await main(['report'], io)).toBe(1);
  expect(io.err).toContain('no ledger file');
});

test('help', async () => {
  const io = fakeIO(tempDir());
  expect(await main(['--help'], io)).toBe(0);
  expect(io.out).toContain('Usage:');
});
