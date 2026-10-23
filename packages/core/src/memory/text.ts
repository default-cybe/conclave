import type { ContentBlock, Message } from '../types';
import { oneLine, truncateMiddle } from '../util/text';
import { redactSecrets } from './secrets';

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its ' +
    'just me my no not of on or our please so some than that the their them then there these they this those to ' +
    'too up us was we were what when where which while who why will with would you your yours about also any all ' +
    'should shall get got make made let lets want wants need needs like okay ok hey hi thanks thank yes yeah im ive ' +
    'dont cant whats hows user users the'
  ).split(/\s+/),
);

/** Words kept intact with inner dots, dashes and underscores (IPs, versions, snake_case). */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}._-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;

export function words(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** Crude stem so "deploys" and "deploying" meet. Only used for overlap math, FTS has its own stemmer. */
export function stem(w: string): string {
  if (/^\d/.test(w) || w.length <= 4) return w;
  return w.replace(/(?:ingly|edly|ings|ing|ed|es|s|ly)$/, '') || w;
}

export function termSet(text: string): Set<string> {
  return new Set(words(text).map(stem));
}

/** Query terms for FTS: stopwords removed, falls back to the raw text when nothing is left. */
export function queryText(text: string): string {
  const w = words(text);
  return w.length ? w.join(' ') : text;
}

/** Fraction of query terms (after stopwords) that appear in the text, with prefix matching. */
export function coverage(query: Set<string>, text: string): number {
  if (!query.size) return 0;
  const doc = termSet(text);
  let hit = 0;
  for (const q of query) {
    if (doc.has(q)) {
      hit++;
      continue;
    }
    for (const d of doc) {
      if ((q.length >= 3 && d.startsWith(q)) || (d.length >= 4 && q.startsWith(d))) {
        hit++;
        break;
      }
    }
  }
  return hit / query.size;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** |A and B| / min(|A|, |B|): high when one text contains the other. */
export function overlap(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (!min) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / min;
}

/**
 * Two texts say the same thing by their words: heavy overlap (Jaccard 0.75,
 * MEMORY_TUNING.dedupeJaccard), or one nearly inside the other. The store's
 * dedupe rule without embeddings.
 */
export function nearDuplicate(a: Set<string>, b: Set<string>, jaccardMin = 0.75): boolean {
  const j = jaccard(a, b);
  return j >= jaccardMin || (j >= 0.6 && Math.min(a.size, b.size) >= 3 && overlap(a, b) >= 0.9);
}

/**
 * Note markdown to plain text for recall and import: frontmatter, headings
 * and the Relations section go, "- [category] text #tag" becomes "text",
 * repeated lines are dropped (episode notes repeat the summary).
 */
export function noteText(md: string): string {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out: string[] = [];
  let inRelations = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inRelations = /^relations$/i.test(heading[1].trim());
      continue;
    }
    if (inRelations || !line || /^(?:Date|Session|Agent):\s/.test(line)) continue;
    const text = line
      .replace(/^[-*]\s+\[[^\]]+\]\s*/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/(?:\s+#[\w-]+)+\s*$/, '')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.join('\n');
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function toBlob(v: number[] | Float32Array): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
}

export function fromBlob(b: Uint8Array | ArrayBuffer | null | undefined): Float32Array | undefined {
  if (!b) return undefined;
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (!u8.byteLength || u8.byteLength % 4) return undefined;
  return new Float32Array(u8.slice().buffer);
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'tool_use':
      return `[used tool ${b.name}: ${oneLine(JSON.stringify(b.input ?? {}), 160)}]`;
    case 'tool_result': {
      const text = typeof b.content === 'string' ? b.content : b.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join(' ');
      return `[tool result${b.isError ? ' (error)' : ''}: ${oneLine(text, 240)}]`;
    }
    case 'image':
      return '[image]';
    case 'document':
      return `[document${b.title ? ` ${b.title}` : ''}]`;
    default:
      return '';
  }
}

/**
 * Plain text transcript for the small model. Notices and compaction summaries
 * are skipped, secrets are redacted before anything leaves the hub.
 */
export function renderTranscript(messages: Message[], maxChars = 24_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.kind === 'notice' || m.kind === 'summary') continue;
    const text = m.content.map(blockText).filter(Boolean).join('\n').trim();
    if (!text) continue;
    const who = m.role === 'user' ? (m.kind === 'aside' ? `Aside (${m.author ?? 'other model'})` : 'User') : m.kind === 'aside' ? `Aside (${m.author ?? m.model ?? 'other model'})` : 'Assistant';
    lines.push(`${who}: ${text}`);
  }
  return truncateMiddle(redactSecrets(lines.join('\n\n')), maxChars, 'omitted').text;
}

/** Text the user typed in these messages (for picking related memories). */
export function userText(messages: Message[], maxChars = 2000): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || m.kind !== 'normal') continue;
    for (const b of m.content) if (b.type === 'text') parts.push(b.text);
  }
  const s = parts.join('\n');
  return s.length > maxChars ? s.slice(-maxChars) : s;
}
