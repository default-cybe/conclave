import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { main } from '../../src/cli';

const LEDGER = 'date,description,amount,category\n2026-03-05,Coffee,-14.50,food\n2026-03-06,Salary,100.00,income\n';

function folder(config?: object, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerkit-cfg-'));
  writeFileSync(join(dir, 'ledger.csv'), LEDGER);
  if (config) writeFileSync(join(dir, 'ledgerkit.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}

async function header(dir: string, argv: string[], env: Record<string, string> = {}): Promise<string> {
  let out = '';
  let err = '';
  const code = await main(['report', '--month', '2026-03', ...argv], { stdout: (s) => (out += s), stderr: (s) => (err += s), env, cwd: dir });
  expect(err).toBe('');
  expect(code).toBe(0);
  return out.split('\n')[0];
}

test('defaults with nothing set', async () => {
  expect(await header(folder(), [])).toBe('Report for 2026-03 (USD)');
});

test('the config file beats the default', async () => {
  expect(await header(folder({ currency: 'EUR' }), [])).toBe('Report for 2026-03 (EUR)');
});

test('a flag beats the config file', async () => {
  expect(await header(folder({ currency: 'EUR' }), ['--currency', 'GBP'])).toBe('Report for 2026-03 (GBP)');
  expect(await header(folder({ currency: 'USD' }), ['--currency=EUR'])).toBe('Report for 2026-03 (EUR)');
});

test('the environment beats the config file', async () => {
  expect(await header(folder({ currency: 'EUR' }), [], { LEDGERKIT_CURRENCY: 'JPY' })).toBe('Report for 2026-03 (JPY)');
});

test('a flag beats the environment', async () => {
  expect(await header(folder({ currency: 'EUR' }), ['--currency', 'GBP'], { LEDGERKIT_CURRENCY: 'JPY' })).toBe('Report for 2026-03 (GBP)');
  expect(await header(folder(), ['--currency', 'GBP'], { LEDGERKIT_CURRENCY: 'JPY' })).toBe('Report for 2026-03 (GBP)');
});

test('the environment beats the default', async () => {
  expect(await header(folder(), [], { LEDGERKIT_CURRENCY: 'EUR' })).toBe('Report for 2026-03 (EUR)');
});

test('the data file setting follows the same order', async () => {
  const other = 'date,description,amount,category\n2026-03-07,Other,-1.00,misc\n';
  const books = 'date,description,amount,category\n2026-03-07,Books,-2.00,misc\n';
  const dir = folder({ data: 'books.csv' }, { 'books.csv': books, 'other.csv': other });
  let out = '';
  const io = (env: Record<string, string> = {}) => ({ stdout: (s: string) => (out += s), stderr: () => {}, env, cwd: dir });
  expect(await main(['list'], io())).toBe(0);
  expect(out).toContain('Books');
  out = '';
  expect(await main(['list', '--data', 'other.csv'], io())).toBe(0);
  expect(out).toContain('Other');
  out = '';
  expect(await main(['list'], io({ LEDGERKIT_DATA: 'ledger.csv' }))).toBe(0);
  expect(out).toContain('Coffee');
});

test('unset flags do not hide the config file', async () => {
  const dir = folder({ currency: 'EUR', locale: 'en-GB' });
  expect(await header(dir, ['--category', 'food'])).toBe('Report for 2026-03 (EUR)');
});
