import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { main } from '../../src/cli';
import { toMarkdown } from '../../src/export';
import { parseCsv } from '../../src/importers/csv';
import * as money from '../../src/money';
import { buildReport, renderEntryLine, renderReport } from '../../src/report';

const formatMoney = (money as Record<string, unknown>).formatMoney as (c: number, cur: string, locale?: string) => string;

const USD_LEDGER = `date,description,amount,category
2026-03-02,Coffee beans,-14.50,food
2026-03-03,"Rent, March",-950.00,home
2026-03-05,Salary,3200.00,income
2026-03-12,Groceries,-82.25,food
2026-03-20,"Book ""Dune""",-12.75,fun
2026-03-21,Lottery,1234567.89,income
`;

const JPY_LEDGER = `date,description,amount,category
2026-03-02,Ramen,-1200,food
2026-03-03,Rent,"-85,000",home
2026-03-05,Salary,"310,000",income
2026-03-07,Snack,-5,food
`;

describe('formatMoney', () => {
  test('is exported from src/money.ts', () => {
    expect(typeof formatMoney).toBe('function');
  });
  test('two-decimal currencies', () => {
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(-123456, 'USD')).toBe('-$1,234.56');
    expect(formatMoney(0, 'EUR')).toBe('€0.00');
    expect(formatMoney(5, 'GBP')).toBe('£0.05');
    expect(formatMoney(-7, 'EUR')).toBe('-€0.07');
    expect(formatMoney(100000000, 'USD')).toBe('$1,000,000.00');
  });
  test('zero-decimal currencies', () => {
    expect(formatMoney(120000, 'JPY')).toBe('¥1,200');
    expect(formatMoney(-120000, 'JPY')).toBe('-¥1,200');
    expect(formatMoney(0, 'JPY')).toBe('¥0');
    expect(formatMoney(31000000, 'JPY')).toBe('¥310,000');
  });
  test('currency codes in any case', () => {
    expect(formatMoney(150, 'usd')).toBe('$1.50');
  });
  test('locale defaults to en-US', () => {
    expect(formatMoney(123456, 'EUR', 'en-US')).toBe(formatMoney(123456, 'EUR'));
  });
  test('another locale changes the separators', () => {
    expect(formatMoney(123456, 'EUR', 'de-DE')).toContain('1.234,56');
  });
});

describe('output stays byte for byte for two-decimal currencies', () => {
  const entries = () => parseCsv(USD_LEDGER);
  test('report text', () => {
    expect(renderReport(buildReport(entries(), { month: '2026-03', currency: 'USD' }))).toBe(
      [
        'Report for 2026-03 (USD)',
        '',
        '  food             -$96.75  2 entries',
        '  fun              -$12.75  1 entry',
        '  home            -$950.00  1 entry',
        '  income     $1,237,767.89  2 entries',
        '',
        '  Total      $1,236,708.39  6 entries',
        '',
      ].join('\n'),
    );
  });
  test('list lines', () => {
    expect(renderEntryLine(entries()[0], 'USD')).toBe('2026-03-02       -$14.50  food          Coffee beans');
    expect(renderEntryLine(entries()[5], 'EUR')).toBe('2026-03-21  €1,234,567.89  income        Lottery');
  });
  test('markdown export', () => {
    expect(toMarkdown(entries().slice(0, 3), 'GBP')).toBe(
      ['| Date | Description | Category | Amount |', '|---|---|---|---:|', '| 2026-03-02 | Coffee beans | food | -£14.50 |', '| 2026-03-03 | Rent, March | home | -£950.00 |', '| 2026-03-05 | Salary | income | £3,200.00 |', ''].join('\n'),
    );
  });
});

describe('JPY prints without decimals everywhere', () => {
  const entries = () => parseCsv(JPY_LEDGER);
  test('report', () => {
    const text = renderReport(buildReport(entries(), { month: '2026-03', currency: 'JPY' }));
    expect(text).toContain('-¥1,205');
    expect(text).toContain('¥310,000');
    expect(text).toContain('¥223,795');
    expect(text).not.toMatch(/¥[\d,]+\.\d/);
  });
  test('markdown export', () => {
    const md = toMarkdown(entries(), 'JPY');
    expect(md).toContain('| 2026-03-02 | Ramen | food | -¥1,200 |');
    expect(md).toContain('| 2026-03-07 | Snack | food | -¥5 |');
  });
  test('report and export agree', () => {
    const md = toMarkdown(entries(), 'JPY');
    const line = renderEntryLine(entries()[1], 'JPY');
    expect(line).toContain('-¥85,000');
    expect(md).toContain('-¥85,000');
  });
  test('the command line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledgerkit-jpy-'));
    writeFileSync(join(dir, 'ledger.csv'), JPY_LEDGER);
    let out = '';
    expect(await main(['report', '--month', '2026-03', '--currency', 'JPY'], { stdout: (s) => (out += s), stderr: () => {}, env: {}, cwd: dir })).toBe(0);
    expect(out).toContain('Total');
    expect(out).toContain('¥223,795');
    expect(out).not.toContain('.00');
  });
});

test('report.ts and export.ts both use formatMoney', () => {
  for (const file of ['src/report.ts', 'src/export.ts']) {
    const src = readFileSync(join(import.meta.dir, '..', '..', file), 'utf8');
    expect(src).toContain('formatMoney');
  }
});
