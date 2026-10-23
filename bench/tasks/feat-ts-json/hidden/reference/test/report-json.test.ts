import { expect, test } from 'bun:test';
import { main } from '../src/cli';
import { fakeIO, SAMPLE, tempDir } from './helpers';

test('report --format json', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['report', '--month', '2026-03', '--format', 'json', '--category', 'food'], io)).toBe(0);
  expect(JSON.parse(io.out)).toEqual({
    month: '2026-03',
    currency: 'USD',
    total_cents: -9675,
    categories: [{ name: 'food', total_cents: -9675, count: 2 }],
    entries: [
      { date: '2026-03-02', description: 'Coffee beans', amount_cents: -1450, category: 'food' },
      { date: '2026-03-12', description: 'Groceries', amount_cents: -8225, category: 'food' },
    ],
  });
});

test('report --format rejects other values', async () => {
  const io = fakeIO(tempDir({ 'ledger.csv': SAMPLE }));
  expect(await main(['report', '--format', 'xml'], io)).toBe(2);
  expect(io.err).toBe('unknown format: xml\n');
  expect(io.out).toBe('');
});
