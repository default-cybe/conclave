import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { HELP, main } from '../../src/cli';

const LEDGER = `date,description,amount,category
2026-02-14,Flowers,-25.00,gifts
2026-03-02,Coffee beans,-14.50,food
2026-03-03,"Rent, March",-950.00,home
2026-03-05,Salary,3200.00,income
2026-03-12,Groceries,-82.25,food
2026-03-20,"Book ""Dune""",-12.75,fun
`;

async function run(argv: string[], files: Record<string, string> = { 'ledger.csv': LEDGER }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerkit-json-'));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s), env, cwd: dir });
  return { code, out, err };
}

const MARCH = {
  month: '2026-03',
  currency: 'USD',
  total_cents: 214050,
  categories: [
    { name: 'food', total_cents: -9675, count: 2 },
    { name: 'fun', total_cents: -1275, count: 1 },
    { name: 'home', total_cents: -95000, count: 1 },
    { name: 'income', total_cents: 320000, count: 1 },
  ],
  entries: [
    { date: '2026-03-02', description: 'Coffee beans', amount_cents: -1450, category: 'food' },
    { date: '2026-03-03', description: 'Rent, March', amount_cents: -95000, category: 'home' },
    { date: '2026-03-05', description: 'Salary', amount_cents: 320000, category: 'income' },
    { date: '2026-03-12', description: 'Groceries', amount_cents: -8225, category: 'food' },
    { date: '2026-03-20', description: 'Book "Dune"', amount_cents: -1275, category: 'fun' },
  ],
};

const TEXT = [
  'Report for 2026-03 (USD)',
  '',
  '  food             -$96.75  2 entries',
  '  fun              -$12.75  1 entry',
  '  home            -$950.00  1 entry',
  '  income         $3,200.00  1 entry',
  '',
  '  Total          $2,140.50  5 entries',
  '',
].join('\n');

test('json report has the documented shape', async () => {
  const r = await run(['report', '--month', '2026-03', '--format', 'json']);
  expect(r.code).toBe(0);
  expect(r.err).toBe('');
  expect(JSON.parse(r.out)).toEqual(MARCH);
});

test('--format=json works too', async () => {
  const r = await run(['report', '--format=json', '--month=2026-03']);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual(MARCH);
});

test('json keys are exactly the documented ones', async () => {
  const data = JSON.parse((await run(['report', '--month', '2026-03', '--format', 'json'])).out);
  expect(Object.keys(data).sort()).toEqual(['categories', 'currency', 'entries', 'month', 'total_cents']);
  expect(Object.keys(data.categories[0]).sort()).toEqual(['count', 'name', 'total_cents']);
  expect(Object.keys(data.entries[0]).sort()).toEqual(['amount_cents', 'category', 'date', 'description']);
});

test('json follows --category and the currency settings', async () => {
  const r = await run(['report', '--month', '2026-03', '--format', 'json', '--category', 'food'], { 'ledger.csv': LEDGER, 'ledgerkit.json': '{"currency":"EUR"}' });
  const data = JSON.parse(r.out);
  expect(data.currency).toBe('EUR');
  expect(data.total_cents).toBe(-9675);
  expect(data.categories).toEqual([{ name: 'food', total_cents: -9675, count: 2 }]);
  expect(data.entries.map((e: { description: string }) => e.description)).toEqual(['Coffee beans', 'Groceries']);
});

test('json for a month without entries', async () => {
  const data = JSON.parse((await run(['report', '--month', '2026-01', '--format', 'json'])).out);
  expect(data).toEqual({ month: '2026-01', currency: 'USD', total_cents: 0, categories: [], entries: [] });
});

test('text stays the default, byte for byte', async () => {
  expect((await run(['report', '--month', '2026-03'])).out).toBe(TEXT);
  expect((await run(['report', '--month', '2026-03', '--format', 'text'])).out).toBe(TEXT);
});

test('unknown format exits 2 with a message', async () => {
  const r = await run(['report', '--month', '2026-03', '--format', 'xml']);
  expect(r.code).toBe(2);
  expect(r.err.trim()).toBe('unknown format: xml');
  expect(r.out).toBe('');
  const r2 = await run(['report', '--format', 'JSON5']);
  expect(r2.code).toBe(2);
  expect(r2.err).toContain('unknown format: JSON5');
});

test('help mentions the format option', async () => {
  expect(HELP).toContain('--format');
  const r = await run(['--help']);
  expect(r.out).toContain('json');
});

test('other commands are unchanged', async () => {
  const r = await run(['list', '--month', '2026-02']);
  expect(r.out).toBe('2026-02-14       -$25.00  gifts         Flowers\n');
});
