import { describe, expect, test } from 'bun:test';
import { centsToDecimal, parseAmount, sumCents } from '../src/money';

describe('parseAmount', () => {
  test('plain decimals', () => {
    expect(parseAmount('12')).toBe(1200);
    expect(parseAmount('12.3')).toBe(1230);
    expect(parseAmount('12.30')).toBe(1230);
    expect(parseAmount('0.29')).toBe(29);
  });

  test('signs and accounting negatives', () => {
    expect(parseAmount('-12.30')).toBe(-1230);
    expect(parseAmount('+4')).toBe(400);
    expect(parseAmount('(12.30)')).toBe(-1230);
  });

  test('grouping and symbols', () => {
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('$12.30')).toBe(1230);
    expect(parseAmount('-€5')).toBe(-500);
  });

  test('rejects junk', () => {
    expect(() => parseAmount('12.345')).toThrow('invalid amount');
    expect(() => parseAmount('abc')).toThrow('invalid amount');
    expect(() => parseAmount('1,23')).toThrow('invalid amount');
  });
});

test('sumCents adds whole cents', () => {
  expect(sumCents([100, -25, 3])).toBe(78);
  expect(() => sumCents([1.5])).toThrow();
});

test('centsToDecimal', () => {
  expect(centsToDecimal(123456)).toBe('1234.56');
  expect(centsToDecimal(-5)).toBe('-0.05');
  expect(centsToDecimal(0)).toBe('0.00');
});
