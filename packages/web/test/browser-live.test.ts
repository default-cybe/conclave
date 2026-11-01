/**
 * The live browser line above the composer (features/chat/liveBrowser.ts):
 * it shows while a browser call runs, while the session's page is open, or
 * while the owner holds the browser; never for a session that never browsed.
 *
 *   cd packages/web && bun test test/browser-live.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Message } from '@conclave/core/types';
import { browserCalls, isBrowserTool, liveWords, showLive } from '../src/features/chat/liveBrowser';

const call = (id: string, name: string): Message => ({ id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }], createdAt: 0 }) as unknown as Message;

describe('browser live line', () => {
  test('browser tools, also handed on by a server', () => {
    expect(isBrowserTool('browser_navigate')).toBe(true);
    expect(isBrowserTool('mcp__conclave__browser_click')).toBe(true);
    expect(isBrowserTool('Bash')).toBe(false);
    expect(isBrowserTool('mcp__browser__navigate')).toBe(false);
  });

  test('used and running come from the transcript and the runs', () => {
    const msgs = [call('a', 'Bash'), call('b', 'browser_navigate'), call('c', 'browser_snapshot')];
    expect(browserCalls(msgs, () => false)).toEqual({ used: true, running: false });
    expect(browserCalls(msgs, (id) => id === 'c')).toEqual({ used: true, running: true });
    // a running Bash is not a browser call
    expect(browserCalls([call('a', 'Bash')], () => true)).toEqual({ used: false, running: false });
    expect(browserCalls(undefined, () => true)).toEqual({ used: false, running: false });
  });

  test('when it shows', () => {
    const never = { used: false, running: false };
    expect(showLive(never, undefined)).toBe(false);
    expect(showLive(never, { open: true, held: false })).toBe(false);
    expect(showLive({ used: true, running: true }, undefined)).toBe(true);
    expect(showLive({ used: true, running: false }, { open: true, held: false })).toBe(true);
    expect(showLive({ used: true, running: false }, { open: false, held: false })).toBe(false);
    // the owner holds it: always in view, so Give back is in reach
    expect(showLive(never, { open: false, held: true })).toBe(true);
  });

  test('its words', () => {
    expect(liveWords({ open: true, held: true, url: 'https://www.example.com/x' }, true)).toBe('Browser: you have it, the assistant waits');
    expect(liveWords({ open: true, held: false, url: 'https://www.example.com/x' }, true)).toBe('Browser, working on example.com');
    expect(liveWords(undefined, true)).toBe('Browser, working');
    expect(liveWords({ open: true, held: false, url: 'about:blank' }, false)).toBe('Browser open');
    expect(liveWords({ open: true, held: false, url: 'https://shop.example/' }, false)).toBe('Browser open on shop.example');
  });
});
