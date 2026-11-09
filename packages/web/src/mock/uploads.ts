/**
 * Per-file uploads as the hub takes them (core attachments/uploads.ts):
 * POST /api/uploads keeps the file and answers its id, and a message names it
 * by uploadId. receiptsFor splits a message's files the way core
 * attachments/budget.ts does, roughly: pictures, PDFs and text go inline up
 * to 20 MB, the rest is saved to uploads/ (the session's folder for a Code
 * session, the chat's outputs folder on the hub for a chat).
 */
import type { AttachmentReceipt, ContentBlock } from '@conclave/core/types';
import type { MockCtx } from './index';

/** core attachments/budget.ts BUDGET_BYTES; not imported, it pulls Node's Buffer into the page. */
const BUDGET_BYTES = 20 * 1024 * 1024;
const isText = (t: string) => t.startsWith('text/') || /json|xml|yaml|toml|javascript|typescript|x-sh/.test(t);

type Upload = { name: string; mediaType: string; size: number; data?: string };
type Picked = { uploadId?: string; mediaType?: string; data?: string; name?: string };

const uploads = new Map<string, Upload>();

const base64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function registerUploads(ctx: MockCtx) {
  ctx.on('POST', '/api/uploads', async ({ query, raw }) => {
    const blob = raw instanceof Blob ? raw : new Blob([]);
    const name = query.get('name') || 'file';
    const mediaType = query.get('type') || blob.type || 'application/octet-stream';
    const id = ctx.uid('up');
    // pictures keep their bytes so the bubble can show them
    uploads.set(id, { name, mediaType, size: blob.size, ...(mediaType.startsWith('image/') ? { data: await base64(blob) } : {}) });
    return { id, name, mediaType, size: blob.size };
  });
}

/**
 * The content blocks and receipts for a message's files. `savedIn` is the
 * folder saved files go to: the session's cwd, or the chat's outputs folder.
 * shortcut: one size budget in pick order, no context-window share or sniffing; enough for the mock's shots.
 */
export function receiptsFor(files: Picked[], savedIn: string, savedOn: 'session' | 'hub'): { content: ContentBlock[]; receipts: AttachmentReceipt[] } {
  const content: ContentBlock[] = [];
  const receipts: AttachmentReceipt[] = [];
  let left = BUDGET_BYTES;
  for (const a of files) {
    const up = a.uploadId ? uploads.get(a.uploadId) : undefined;
    const name = up?.name ?? a.name ?? 'file';
    const mediaType = up?.mediaType ?? a.mediaType ?? 'application/octet-stream';
    const data = up?.data ?? a.data;
    const size = up?.size ?? Math.floor(((a.data?.length ?? 0) * 3) / 4);
    // the hub sniffs code under a type that says nothing (a .rs) as text; the mock goes by the name
    const part = mediaType.startsWith('image/') ? 'image' : mediaType === 'application/pdf' ? 'pdf' : isText(mediaType) || /\.(rs|go|c|h|py|sh|toml|md|txt|json|ya?ml|[jt]sx?)$/i.test(name) ? 'text' : undefined;
    const cost = Math.ceil(size / 3) * 4;
    if (part && cost <= left) {
      left -= cost;
      content.push(part === 'image' ? { type: 'image', mediaType, data } : { type: 'document', mediaType, data, title: name });
      receipts.push({ name, state: 'prepared', parts: [part], included: true });
      continue;
    }
    receipts.push({ name, state: 'prepared', parts: ['text'], saved: `${savedIn.replace(/\/$/, '')}/uploads/${name}`, savedOn });
  }
  return { content, receipts };
}
