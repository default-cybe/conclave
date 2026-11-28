/**
 * Your message in a session transcript (chat/Turn.tsx desktop, and
 * PhoneTranscript.tsx): an imported message's "[Attached x]" blocks fold into
 * file chips, as on the Chat page, and words past MARKDOWN_MAX show as plain
 * text. A 1.2 MB imported paste went through react-markdown and froze the
 * desktop app for minutes when the Code session opened.
 *
 *   bun test packages/web/test/user-bubble-size.test.tsx
 */
import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import type { Message, Session } from '@conclave/core/types';
import { MARKDOWN_MAX } from '../src/components/ui/Bubble';
import { userWords } from '../src/features/conversation/UserMessage';
import { UserMessage } from '../src/features/chat/Turn';
import { Bubble } from '../src/features/chat/PhoneTranscript';

const session = { id: 's1', title: 'x', agent: 'coder', cwd: 'D:\\Coding\\NihirShah', device: 'dev_win', status: 'idle', meta: {} } as unknown as Session;
// JSON-ish text with many links and emphasis marks, the shape of the scraped file that froze it
const big = Array.from({ length: 6000 }, (_, i) => `  { "url": "https://example.com/p/${i}#x", "text": "We *recognise* the _land_ ${i} ~~old~~ | a | b |" },`).join('\n');

function msg(content: Message['content'], meta?: Record<string, unknown>): Message {
  return { id: 'm1', sessionId: 's1', seq: 1, role: 'user', content, createdAt: 1, ...(meta ? { meta } : {}) } as Message;
}

test('an imported message: the attached file is a chip, only the typed words are in the bubble', () => {
  const m = msg([{ type: 'text', text: 'check' }, { type: 'text', text: `[Attached scraped.json]\n[\n${big}\n]` }], { external: { source: 'claude-ai', id: 'x' }, origin: 'human' });
  expect(big.length).toBeGreaterThan(400_000);
  expect(userWords(m)).toEqual({ text: 'check', files: ['scraped.json'] });
  for (const html of [renderToString(<UserMessage message={m} session={session} />), renderToString(<Bubble message={m} />)]) {
    expect(html).toContain('scraped.json');
    expect(html).not.toContain('example.com/p/1#x');
  }
});

test('a huge pasted message renders as plain text, fast; a short one is still markdown', () => {
  const m = msg([{ type: 'text', text: big }]);
  const t0 = performance.now();
  const html = renderToString(<UserMessage message={m} session={session} />);
  renderToString(<Bubble message={m} />);
  // markdown took seconds on 200 KB; plain text is milliseconds
  expect(performance.now() - t0).toBeLessThan(1500);
  expect(html).not.toContain('<em>');
  expect(html).toContain('example.com/p/5999#x');
  const short = renderToString(<UserMessage message={msg([{ type: 'text', text: 'a *b* c' }])} session={session} />);
  expect(short).toContain('<em>b</em>');
  expect(big.length).toBeGreaterThan(MARKDOWN_MAX);
});
