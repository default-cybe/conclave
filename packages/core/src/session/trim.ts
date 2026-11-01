/**
 * A transcript page an app asked to keep light (GET .../messages?trim=1):
 * every content block whose JSON is over BLOCK_CAP bytes loses its bulk
 * (text cut to BLOCK_CAP characters, image and document data dropped,
 * a tool_result's parts trimmed the same way), and the message lists it in
 * meta.trimmed with the full size. The app fetches the whole block on
 * demand: GET /api/sessions/:id/messages/:msgId/blocks/:index.
 */
import type { ContentBlock, DocumentBlock, ImageBlock, Message, TextBlock } from '../types';

export const BLOCK_CAP = 100_000;

/** One block a trimmed page cut: its index in content and its full JSON size in bytes. */
export interface TrimmedBlock {
  index: number;
  bytes: number;
}

type Part = TextBlock | ImageBlock | DocumentBlock;

function trimPart(p: Part): Part {
  if (p.type === 'text') return { ...p, text: p.text.slice(0, BLOCK_CAP) };
  const { data: _data, ...rest } = p;
  return rest;
}

function trimBlock(b: ContentBlock): ContentBlock {
  switch (b.type) {
    case 'text':
    case 'image':
    case 'document':
      return trimPart(b);
    case 'thinking':
      return { ...b, thinking: b.thinking.slice(0, BLOCK_CAP) };
    case 'tool_result':
      return { ...b, content: typeof b.content === 'string' ? b.content.slice(0, BLOCK_CAP) : b.content.map(trimPart) };
    default:
      return b;
  }
}

export function trimMessage(m: Message): Message {
  const trimmed: TrimmedBlock[] = [];
  const content = m.content.map((b, index) => {
    const bytes = Buffer.byteLength(JSON.stringify(b));
    if (bytes <= BLOCK_CAP) return b;
    trimmed.push({ index, bytes });
    return trimBlock(b);
  });
  return trimmed.length ? { ...m, content, meta: { ...m.meta, trimmed } } : m;
}
