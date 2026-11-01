/**
 * What plan use is worth at API prices, in the Usage page's words
 * (features/usage/value.ts): a plan row bills $0 and is worth its API price,
 * a key row is worth what it billed, and the month's line says what the plans
 * saved.
 */
import { describe, expect, test } from 'bun:test';
import { billedWords, planServed, saved, savedDetail, savedSentence, worth, worthLine } from '../src/features/usage/value';

describe('API value words', () => {
  test('a plan row: billed $0, worth its API price', () => {
    const plan = { costUsd: 0, apiValueUsd: 41.2 };
    expect(planServed(plan)).toBe(true);
    expect(worth(plan)).toBe(41.2);
    expect(saved(plan)).toBe(41.2);
    expect(billedWords(plan)).toEqual({ billed: 'Billed $0', worth: 'Worth $41.20 at API prices' });
    expect(worthLine(plan)).toBe('worth $41.20 at API prices');
  });

  test('a key row is worth what it billed, and says nothing more', () => {
    const key = { costUsd: 12.5, apiValueUsd: 12.5 };
    expect(planServed(key)).toBe(false);
    expect(billedWords(key)).toEqual({ billed: 'Billed $12.50' });
    expect(worthLine(key)).toBeUndefined();
    // a hub from before values were kept sends none: the value is the bill
    expect(worth({ costUsd: 3 })).toBe(3);
    expect(planServed({ costUsd: 0 })).toBe(false);
  });

  test('the month line', () => {
    expect(savedSentence({ costUsd: 128.4, apiValueUsd: 340.15 })).toBe('Your plans saved you about $211.75 this month');
    expect(savedSentence({ costUsd: 5, apiValueUsd: 5 })).toBeUndefined();
    expect(savedSentence(undefined)).toBeUndefined();
    expect(savedDetail({ costUsd: 128.4, apiValueUsd: 340.15 })).toBe('Worth $340.15 at API prices, billed $128.40.');
    expect(savedDetail({ costUsd: 0, apiValueUsd: 20, estimatedUsd: 4 })).toContain("priced from today's list prices");
    // never in em dashes
    expect(savedDetail({ costUsd: 0, apiValueUsd: 20, estimatedUsd: 4 })).not.toContain('\u2014');
  });

  test('a value below the bill reads as the bill', () => {
    expect(worth({ costUsd: 2, apiValueUsd: 1 })).toBe(2);
    expect(saved({ costUsd: 2, apiValueUsd: 1 })).toBe(0);
  });
});
