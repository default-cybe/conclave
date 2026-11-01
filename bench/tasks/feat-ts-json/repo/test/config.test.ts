import { expect, test } from 'bun:test';
import { DEFAULTS, loadConfig } from '../src/config';
import { tempDir } from './helpers';

const none = { currency: undefined, data: undefined, locale: undefined };

test('defaults', () => {
  expect(loadConfig({ cwd: tempDir(), env: {}, flags: none })).toEqual(DEFAULTS);
});

test('a flag sets the currency', () => {
  expect(loadConfig({ cwd: tempDir(), env: {}, flags: { ...none, currency: 'eur' } }).currency).toBe('EUR');
});

test('the environment sets the data file', () => {
  expect(loadConfig({ cwd: tempDir(), env: { LEDGERKIT_DATA: 'x.csv' }, flags: none }).data).toBe('x.csv');
});

test('unknown currency is an error', () => {
  expect(() => loadConfig({ cwd: tempDir(), env: {}, flags: { ...none, currency: 'XYZ' } })).toThrow('unknown currency');
});

test('a broken config file is an error', () => {
  expect(() => loadConfig({ cwd: tempDir({ 'ledgerkit.json': '{oops' }), env: {}, flags: none })).toThrow('ledgerkit.json');
});
