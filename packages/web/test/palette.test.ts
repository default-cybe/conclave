/** The command palette's ranking (lib/palette.ts): words in any order, recent commands first. */
import { describe, expect, test } from 'bun:test';
import { fuzzyWords, pushRecent, rankItems } from '../src/lib/palette';
import { openedSessionId } from '../src/lib/seen';

const items = ['Switch to dark theme', 'Open inbox', 'New jury session mode', 'Theme settings appearance'];
const rank = (q: string, recent: string[] = []) => rankItems(items, q, (x) => x, (x) => x, recent);

describe('palette ranking', () => {
  test('words match in any order; a word with no match drops the item', () => {
    expect(fuzzyWords('theme dark', 'Switch to dark theme')).toBeGreaterThan(0);
    expect(fuzzyWords('theme zebra', 'Switch to dark theme')).toBe(-1);
    expect(rank('dark theme')[0]).toBe('Switch to dark theme');
    expect(rank('jury new')).toEqual(['New jury session mode']);
  });

  test('a command used lately comes first among matches, and no query keeps the order', () => {
    expect(rank('theme')[0]).toBe('Theme settings appearance');
    expect(rank('theme', ['Switch to dark theme'])[0]).toBe('Switch to dark theme');
    expect(rank('')).toEqual(items);
  });

  test('recent: newest first, once, capped', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });
});

describe('opening clears unread', () => {
  test('the conversation an address opens', () => {
    expect(openedSessionId('/s/ses_1')).toBe('ses_1');
    expect(openedSessionId('/chat/ses_2#m_1')).toBe('ses_2');
    expect(openedSessionId('/chat')).toBeUndefined();
    expect(openedSessionId('/sessions')).toBeUndefined();
  });
});
