/**
 * Query retrieval over a stored output (ReadToolOutput query): the text is
 * split into blocks, ranked by BM25 against the query, and the best blocks
 * come back in source order with a marker between blocks that are not next
 * to each other (caveman: ranked lines placed side by side read as one
 * passage and led to wrong answers).
 */

const BLOCK_LINES = 8;
const K1 = 1.2;
const B = 0.75;

export interface Block {
  /** 1-based first line. */
  start: number;
  lines: string[];
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

/** Paragraphs split at blank lines; a paragraph longer than 8 lines is split into windows of 8. */
export function blocksOf(lines: string[]): Block[] {
  const out: Block[] = [];
  let cur: Block | undefined;
  const close = () => {
    if (cur?.lines.length) out.push(cur);
    cur = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) {
      close();
      continue;
    }
    if (!cur || cur.lines.length >= BLOCK_LINES) {
      close();
      cur = { start: i + 1, lines: [] };
    }
    cur.lines.push(lines[i]);
  }
  close();
  return out;
}

/** The top blocks for a query by BM25, in source order. Empty when no block matches. */
export function retrieve(lines: string[], query: string, top = 20): Block[] {
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return [];
  const blocks = blocksOf(lines);
  const docs = blocks.map((b) => tokens(b.lines.join('\n')));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (terms.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const t of terms) {
      const n = df.get(t);
      if (!n) continue;
      const tf = d.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / (avg || 1)));
    }
    return { i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, top)
    .sort((a, b) => a.i - b.i)
    .map((s) => blocks[s.i]);
}
