/**
 * A picture the model API could not decode ("Could not process image",
 * OpenAI's "Invalid image"): every request resends the history, so one bad
 * picture fails every later turn. The runner (runner.ts) takes the newest
 * picture in the request (a user's attachment or a tool result's image) out
 * of the stored history, puts a note in its place and retries once. Each
 * send of a chat that is stuck this way drops one more, so it frees itself.
 */
import { basename } from 'node:path';
import type { AttachmentReceipt, ContentBlock, Message } from '../types';
import { imageLeftOutNote } from '../attachments/image';

/** The picked names of a message's pictures, in the order its image blocks come. */
function attachedImageNames(m: Message): string[] {
  const receipts = (m.meta?.attachments as AttachmentReceipt[] | undefined) ?? [];
  const out: string[] = [];
  for (const r of receipts) {
    if (r.state !== 'prepared') continue;
    const parts = r.parts ?? [];
    if (r.as?.length) r.as.forEach((n, i) => parts[i] === 'image' && out.push(n));
    else if (parts[0] === 'image') out.push(r.name);
  }
  return out;
}

/**
 * Replace the newest picture in `messages` (the active ones, oldest first)
 * with a note, in the stored message. Its name, or undefined when there is
 * no picture left to drop.
 */
export function dropNewestImage(messages: Message[], update: (id: string, content: ContentBlock[]) => void): string | undefined {
  const toolFiles = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      const p = b.input?.file_path ?? b.input?.path;
      toolFiles.set(b.id, typeof p === 'string' ? basename(p) : `from ${b.name}`);
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const names = attachedImageNames(m);
    const imageAt = m.content.map((b, at) => (b.type === 'image' ? at : -1)).filter((at) => at >= 0);
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b.type === 'image') {
        const name = names[imageAt.indexOf(j)] ?? 'attached';
        update(m.id, m.content.map((x, at) => (at === j ? { type: 'text', text: imageLeftOutNote(name) } : x)));
        return name;
      }
      if (b.type === 'tool_result' && typeof b.content !== 'string' && !b.meta?.cleared) {
        const k = b.content.map((c) => c.type).lastIndexOf('image');
        if (k < 0) continue;
        const name = toolFiles.get(b.toolUseId) ?? 'from a tool result';
        const content = b.content.map((c, at) => (at === k ? { type: 'text' as const, text: imageLeftOutNote(name) } : c));
        update(m.id, m.content.map((x, at) => (at === j ? { ...b, content } : x)) as ContentBlock[]);
        return name;
      }
    }
  }
  return undefined;
}
