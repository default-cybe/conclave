/**
 * A picture the model API could not decode ("Could not process image",
 * OpenAI's "Invalid image"): every request resends the history, so one bad
 * picture fails every later turn. The runner (runner.ts) takes the newest
 * picture in the request (a user's attachment or a tool result's image) out
 * of the stored history, puts a note in its place and retries once. Each
 * send of a chat that is stuck this way drops one more, so it frees itself.
 *
 * A PDF the API could not open ("The PDF specified was not valid") is the same:
 * dropPdf replaces the one the error names (found by its bytes), else the
 * newest, with its text or a note (attachments/pdf.ts), one per failed send.
 */
import { basename } from 'node:path';
import type { AttachmentReceipt, ContentBlock, DocumentBlock, Message } from '../types';
import { imageLeftOutNote } from '../attachments/image';
import { mediaTypeFor } from '../attachments/limits';
import { pdfAsText, pdfProblem } from '../attachments/pdf';

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

const isPdf = (b: ContentBlock): b is DocumentBlock => b.type === 'document' && !!b.data && mediaTypeFor(b.mediaType, b.title) === 'application/pdf';

/**
 * Replace one PDF in `messages` (the active ones, oldest first) with its text
 * or a note, in the stored message: the newest whose data is `data` (the
 * block the error named, ProviderError.pdfData; wire indexes do not match the
 * stored history, which the wire merges and reorders), else the newest PDF,
 * attached or in a tool result. Its name, or undefined when none is left.
 */
export async function dropPdf(messages: Message[], update: (id: string, content: ContentBlock[]) => void, data?: string): Promise<string | undefined> {
  const text = async (b: DocumentBlock): Promise<{ name: string; block: ContentBlock }> => {
    const name = b.title?.trim() || 'attached PDF';
    const bytes = Buffer.from(b.data!.replace(/^data:[^,]*,/, ''), 'base64');
    return { name, block: { type: 'text', text: await pdfAsText(name, bytes, pdfProblem(bytes) ?? 'the model could not open it') } };
  };
  const users = messages.filter((m) => m.role === 'user').reverse();
  const replace = async (wanted: (b: ContentBlock) => boolean): Promise<string | undefined> => {
    for (const m of users) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (wanted(b)) {
          const { name, block } = await text(b as DocumentBlock);
          update(m.id, m.content.map((x, i) => (i === j ? block : x)));
          return name;
        }
        if (b.type === 'tool_result' && typeof b.content !== 'string' && !b.meta?.cleared) {
          const k = b.content.findLastIndex((c) => wanted(c as ContentBlock));
          if (k < 0) continue;
          const { name, block } = await text(b.content[k] as DocumentBlock);
          const content = b.content.map((c, i) => (i === k ? block : c));
          update(m.id, m.content.map((x, i) => (i === j ? { ...b, content } : x)) as ContentBlock[]);
          return name;
        }
      }
    }
    return undefined;
  };
  return (data !== undefined ? await replace((b) => isPdf(b) && b.data === data) : undefined) ?? replace(isPdf);
}
