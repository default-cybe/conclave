/**
 * Side by side (/sessions/split, features/chat/split.ts): the account's list
 * of sessions, left to right, at most SPLIT_MAX; a deleted session or a chat
 * leaves the view.
 *
 *   cd packages/web && bun test test/split-view.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import { addToSplit, removeFromSplit, shownSplit, SPLIT_MAX } from '../src/features/chat/split';

const s = (id: string, p: Partial<Session> = {}) => ({ id, kind: 'session', ...p }) as Session;

describe('side by side', () => {
  test('adding goes to the right, moves one already there, and drops the leftmost past the limit', () => {
    expect(SPLIT_MAX).toBe(4);
    expect(addToSplit([], 'a')).toEqual(['a']);
    expect(addToSplit(['a', 'b'], 'a')).toEqual(['b', 'a']);
    expect(addToSplit(['a', 'b', 'c', 'd'], 'e')).toEqual(['b', 'c', 'd', 'e']);
    expect(removeFromSplit(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  test('only sessions that are still here show, never a chat', () => {
    const sessions = { a: s('a'), c: s('c', { kind: 'chat' }), d: s('d') };
    expect(shownSplit(['a', 'gone', 'c', 'd'], sessions)).toEqual(['a', 'd']);
    expect(shownSplit(undefined, sessions)).toEqual([]);
  });
});
