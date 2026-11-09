/**
 * What of a message's files the model gets inline, and what is saved for it
 * to open with its own tools (attachments/prepare.ts). Pure, so the split is
 * the same for the same list every time.
 *
 * Pictures the model reads, PDFs and text files go inline up to a budget:
 * BUDGET_BYTES of payload (as base64) and a share of the model's context
 * window (BUDGET_CONTEXT_SHARE), with text also under the wire's own text
 * caps (providers/common.ts DOC_TEXT_MAX_BYTES, MESSAGE_DOCS_MAX_BYTES).
 * Pictures and text are placed first, then PDFs, each group in the order the
 * person picked them. Everything else, and everything past the budget, is
 * saved.
 */
import { DOC_TEXT_MAX_BYTES, isTextMediaType, MESSAGE_DOCS_MAX_BYTES } from '../providers/common';
import { sniffImageType } from './image';

/** Inline payload of one message's files at most, as base64. */
export const BUDGET_BYTES = 20 * 1024 * 1024;
/** The share of the model's context window one message's files may take. */
export const BUDGET_CONTEXT_SHARE = 0.4;
/** Room left under MESSAGE_DOCS_MAX_BYTES for the notes the hub adds (saved files, zip listings). */
const NOTE_ROOM = 16 * 1024;
/** What a picture costs in tokens, about (a 1092 px square on Anthropic's sizing). */
export const IMAGE_TOKENS = 1_600;

export type Part = 'image' | 'pdf' | 'text';

export interface Budget {
  bytes: number;
  tokens: number;
}

/** The budget for a model with `contextWindow` tokens. */
export function budgetFor(contextWindow: number | undefined): Budget {
  const w = contextWindow && contextWindow > 0 ? contextWindow : 200_000;
  return { bytes: BUDGET_BYTES, tokens: Math.floor(w * BUDGET_CONTEXT_SHARE) };
}

const ascii = (b: Uint8Array, at: number, s: string) => s.split('').every((c, i) => b[at + i] === c.charCodeAt(0));
const has = (b: Uint8Array, s: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(s);

/**
 * What a file is, from its first bytes, then its name: a short label for the
 * note (APK, ELF, PE (.exe), SQLite, zip, gzip, tar, PDF, PNG, text...), and
 * the part the model can read it as, or undefined when it can only be saved.
 */
export function sniffFile(head: Uint8Array, name: string, mediaType: string): { label: string; part?: Part } {
  const ext = /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase() ?? '';
  if (ascii(head, 0, 'PK\u0003\u0004')) {
    if (ext === 'apk' || has(head, 'AndroidManifest.xml') || has(head, 'classes.dex')) return { label: 'APK' };
    if (ext === 'jar') return { label: 'JAR' };
    return { label: ext && ext !== 'zip' ? `zip (.${ext})` : 'zip' };
  }
  if (ascii(head, 0, '\u007fELF')) return { label: 'ELF' };
  if (ascii(head, 0, 'MZ')) return { label: 'PE (.exe)' };
  if (ascii(head, 0, 'SQLite format 3\u0000')) return { label: 'SQLite' };
  if (head[0] === 0x1f && head[1] === 0x8b) return { label: 'gzip' };
  if (ascii(head, 257, 'ustar')) return { label: 'tar' };
  if (ascii(head, 0, '7z\u00bc\u00af')) return { label: '7z' };
  if (ascii(head, 0, 'Rar!')) return { label: 'rar' };
  if (ascii(head, 0, '%PDF-')) return { label: 'PDF', part: 'pdf' };
  const image = sniffImageType(head);
  if (image === 'image/svg+xml') return { label: 'SVG', part: 'text' };
  if (image) return { label: image.replace(/^image\//, '').toUpperCase(), ...(/^image\/(jpeg|png|gif|webp)$/.test(image) ? { part: 'image' as const } : {}) };
  if (mediaType === 'application/pdf') return { label: 'PDF', part: 'pdf' };
  // text: no NUL and UTF-8 as far as the head goes (a character cut at its end is fine)
  if (!head.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
      return { label: isTextMediaType(mediaType) ? mediaType : 'text', part: 'text' };
    } catch {
      /* not UTF-8: a binary */
    }
  }
  return { label: ext ? `.${ext} file` : 'binary' };
}

export interface BudgetItem {
  part?: Part;
  /** Bytes of the file. */
  size: number;
}

/** What `item` costs in tokens, about. */
function tokensOf(i: BudgetItem): number {
  if (i.part === 'image') return IMAGE_TOKENS;
  if (i.part === 'pdf') return Math.ceil(i.size / 32);
  return Math.ceil(i.size / 4);
}

/** The indexes of `items` that go inline under `budget`; the rest are saved. */
export function splitBudget(items: BudgetItem[], budget: Budget): Set<number> {
  const inline = new Set<number>();
  let bytes = 0;
  let tokens = 0;
  let text = 0;
  const textRoom = MESSAGE_DOCS_MAX_BYTES - NOTE_ROOM;
  const place = (i: number) => {
    const it = items[i];
    const b64 = Math.ceil(it.size / 3) * 4;
    const t = tokensOf(it);
    if (bytes + b64 > budget.bytes || tokens + t > budget.tokens) return;
    if (it.part === 'text' && (it.size > DOC_TEXT_MAX_BYTES || text + it.size > textRoom)) return;
    inline.add(i);
    bytes += b64;
    tokens += t;
    if (it.part === 'text') text += it.size;
  };
  items.forEach((it, i) => (it.part === 'image' || it.part === 'text') && place(i));
  items.forEach((it, i) => it.part === 'pdf' && place(i));
  return inline;
}

/** A size for the note: 12.3 MB, 40 KB, 512 bytes. */
export function sizeWord(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
