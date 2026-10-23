/**
 * Your message as a bubble in every mode (src/components/ui/Bubble.tsx,
 * docs/design/CHAT-AND-MOTION.md 6.4): a session draws your words in the
 * same bubble as the Chat page, and a very long one (a paste) is cut with
 * "Show all N lines".
 *
 *   bun test packages/web/test/bubble.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { Message, Session } from '@conclave/core/types';
import { BUBBLE, BubbleText, isLongText } from '../src/components/ui/Bubble';
import { UserMessage } from '../src/features/chat/Turn';

describe('a long message', () => {
  test('is long past 18 lines or 1600 characters', () => {
    expect(isLongText('a\n'.repeat(18).trim())).toBe(false);
    expect(isLongText('a\n'.repeat(19).trim())).toBe(true);
    expect(isLongText('x'.repeat(1600))).toBe(false);
    expect(isLongText('x'.repeat(1601))).toBe(true);
  });

  test('shows its first lines and offers the rest', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const html = renderToStaticMarkup(<BubbleText text={text} />);
    expect(html).toContain('Show all 40 lines');
    expect(html).toContain('overflow-hidden');
    expect(renderToStaticMarkup(<BubbleText text="short" />)).not.toContain('Show all');
  });
});

describe('your message in a session', () => {
  test('is the Chat page bubble, at the right, with your markdown in it', () => {
    const session = { id: 's1', agent: 'coder', model: 'anthropic/claude-sonnet-5-5' } as Session;
    const message: Message = { id: 'u1', sessionId: 's1', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Switch it to **jose**.' }], createdAt: 1 };
    const html = renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <UserMessage message={message} session={session} />
      </Router>,
    );
    expect(html).toContain('data-author="you"');
    expect(html).toContain('items-end');
    for (const cls of BUBBLE.split(' ').slice(0, 4)) expect(html).toContain(cls);
    expect(html).toContain('<strong>jose</strong>');
    // no "You" author line: the bubble says whose words these are
    expect(html).not.toContain('>You<');
  });
});
