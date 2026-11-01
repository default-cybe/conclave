import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { main } from '../../src/cli';
import { parseCsv } from '../../src/importers/csv';
import { parseAmount } from '../../src/money';

const HEADER = 'date,description,amount,category\n';
const row = (amount: string) => `2026-03-10,x,"${amount}",misc\n`;
const imported = (amount: string) => parseCsv(HEADER + row(amount))[0].amountCents;

describe('importer keeps exact cents', () => {
  const exact: Array<[string, number]> = [
    ['0.29', 29],
    ['19.99', 1999],
    ['4.35', 435],
    ['8.20', 820],
    ['1005.10', 100510],
    ['0.07', 7],
    ['-4.35', -435],
    ['-0.29', -29],
  ];
  for (const [text, cents] of exact) {
    test(`"${text}" is ${cents} cents`, () => {
      expect(imported(text)).toBe(cents);
    });
  }
});

describe('importer accepts what the README promises', () => {
  const forms = ['12', '12.3', '+12.30', '1,234.56', '$12.30', '-€5', '(12.30)', '($1,234.56)', '£0.99'];
  for (const text of forms) {
    test(`"${text}" matches parseAmount`, () => {
      expect(imported(text)).toBe(parseAmount(text));
    });
  }
  test('accounting negative is negative', () => {
    expect(imported('(12.30)')).toBe(-1230);
  });
});

describe('importer still rejects bad amounts', () => {
  for (const text of ['12.345', 'abc', '1,23', '']) {
    test(`"${text}" is rejected with the line number`, () => {
      expect(() => parseCsv(HEADER + '2026-03-10,ok,1.00,misc\n' + row(text))).toThrow('line 3');
    });
  }
});

test('the March report total is exact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerkit-hidden-'));
  writeFileSync(
    join(dir, 'ledger.csv'),
    HEADER +
      ['2026-03-01,Salary,2450.00,income', '2026-03-04,Card cashback,19.99,income', '2026-03-09,Bakery,-4.35,food', '2026-03-11,Refund,8.20,food', '2026-03-12,Tip,0.29,food', '2026-03-13,Fee,(1.10),bank'].join('\n') +
      '\n',
  );
  let out = '';
  const code = await main(['report', '--month', '2026-03'], { stdout: (s) => (out += s), stderr: () => {}, env: {}, cwd: dir });
  expect(code).toBe(0);
  expect(out).toContain('$2,473.03');
  expect(out).toContain('$2,469.99');
});

test('report math stays integer cents', async () => {
  const entries = parseCsv(HEADER + ['0.10', '0.20', '0.70'].map((a) => `2026-03-05,x,${a},misc`).join('\n') + '\n');
  expect(entries.reduce((s, e) => s + e.amountCents, 0)).toBe(100);
});
