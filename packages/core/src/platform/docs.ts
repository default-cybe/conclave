/// <reference path="../agents-defaults/markdown.d.ts" />
/**
 * The Conclave docs that ship with the hub, for ConclaveHelp
 * (tools/conclave-help.ts). Each file is a text import from the repository's
 * docs folder, so `bun build --compile` embeds it in the binary and the hub
 * needs nothing on disk. Run from source, the files are read from docs/; a
 * copy made without that folder leaves them out and ConclaveHelp says so
 * instead of failing.
 *
 * The files are split into sections at their ## and ### headings and ranked
 * with BM25 over stemmed words, a section's heading counting three times.
 */
import { stem, words } from '../memory/text';

type Loader = () => Promise<{ default: string }>;

/** A shipped doc: its loader and how much its matches count (the guides first, then the design log, then the round specs). */
interface DocSource {
  load: Loader;
  weight: number;
}

const GUIDE = 1.15;
const LOG = 1;
const SPEC = 0.85;

/** The docs ConclaveHelp reads, by their path under docs/. Motion, brand and component specs are left out: they answer nothing about using Conclave. */
export const HELP_DOCS: Record<string, DocSource> = {
  'INSTALL.md': { load: () => import('../../../../docs/INSTALL.md', { with: { type: 'text' } }), weight: GUIDE },
  'EXTENSIONS.md': { load: () => import('../../../../docs/EXTENSIONS.md', { with: { type: 'text' } }), weight: GUIDE },
  'MEMORY.md': { load: () => import('../../../../docs/MEMORY.md', { with: { type: 'text' } }), weight: GUIDE },
  'ASSISTANT.md': { load: () => import('../../../../docs/ASSISTANT.md', { with: { type: 'text' } }), weight: GUIDE },
  'WORKFLOWS.md': { load: () => import('../../../../docs/WORKFLOWS.md', { with: { type: 'text' } }), weight: GUIDE },
  'DESIGN.md': { load: () => import('../../../../docs/DESIGN.md', { with: { type: 'text' } }), weight: LOG },
  'design/ACCOUNTS.md': { load: () => import('../../../../docs/design/ACCOUNTS.md', { with: { type: 'text' } }), weight: SPEC },
  'design/FRIENDS.md': { load: () => import('../../../../docs/design/FRIENDS.md', { with: { type: 'text' } }), weight: SPEC },
  'design/ECOSYSTEM.md': { load: () => import('../../../../docs/design/ECOSYSTEM.md', { with: { type: 'text' } }), weight: SPEC },
  'design/MCP-OAUTH.md': { load: () => import('../../../../docs/design/MCP-OAUTH.md', { with: { type: 'text' } }), weight: SPEC },
  'design/OAUTH-APPS.md': { load: () => import('../../../../docs/design/OAUTH-APPS.md', { with: { type: 'text' } }), weight: SPEC },
  'design/HUB-LOGIN-AND-IDENTITY.md': { load: () => import('../../../../docs/design/HUB-LOGIN-AND-IDENTITY.md', { with: { type: 'text' } }), weight: SPEC },
  'design/DAEMON-SIDECAR.md': { load: () => import('../../../../docs/design/DAEMON-SIDECAR.md', { with: { type: 'text' } }), weight: SPEC },
  'design/DAEMON-RUST.md': { load: () => import('../../../../docs/design/DAEMON-RUST.md', { with: { type: 'text' } }), weight: SPEC },
  'design/MOBILE-V2.md': { load: () => import('../../../../docs/design/MOBILE-V2.md', { with: { type: 'text' } }), weight: SPEC },
  'design/ROUND-LIFE-ASSISTANT.md': { load: () => import('../../../../docs/design/ROUND-LIFE-ASSISTANT.md', { with: { type: 'text' } }), weight: SPEC },
  'design/ROUND-REMOTE-NOTIFY-HOME.md': { load: () => import('../../../../docs/design/ROUND-REMOTE-NOTIFY-HOME.md', { with: { type: 'text' } }), weight: SPEC },
  'design/ROUND-IMPORT-PATHS-WORKFLOWS.md': { load: () => import('../../../../docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md', { with: { type: 'text' } }), weight: SPEC },
  'design/CHAT-AND-MOTION.md': { load: () => import('../../../../docs/design/CHAT-AND-MOTION.md', { with: { type: 'text' } }), weight: SPEC },
  'design/SPEC.md': { load: () => import('../../../../docs/design/SPEC.md', { with: { type: 'text' } }), weight: SPEC },
};

/** One part of a doc, from a ## or ### heading to the next one. */
export interface DocSection {
  /** "INSTALL.md#accounts-and-their-order": what ConclaveHelp's `section` takes. */
  id: string;
  file: string;
  title: string;
  /** "INSTALL.md > 4. Subscriptions ... > Accounts and their order". */
  path: string;
  /** The section's text, heading line first. */
  text: string;
}

export interface DocHit {
  section: DocSection;
  score: number;
  /** The paragraphs that match best, in their order, or the whole section when it is short. */
  snippet: string;
  /** True when the snippet leaves part of the section out. */
  partial: boolean;
}

/** The docs as they were read: the sections, and the files that could not be read. */
export interface DocsIndex {
  sections: DocSection[];
  missing: string[];
  search(query: string, limit?: number): DocHit[];
  get(ref: string): DocSection | undefined;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_"'()[\]{}:;,.!?/\\]+/g, ' ')
      .trim()
      .split(/\s+/)
      .join('-')
      .slice(0, 60)
      .replace(/-+$/, '') || 'section'
  );
}

/**
 * The sections of one doc. Headings inside fenced code blocks are not
 * headings (INSTALL.md has `# Docker: ...` comments in its shell blocks).
 * Text before the first ## is the doc's opening section, under its # title.
 */
export function splitSections(file: string, text: string): DocSection[] {
  const lines = text.split('\n');
  const out: Array<{ level: number; title: string; lines: string[] }> = [];
  let doc = file;
  let cur: { level: number; title: string; lines: string[] } | undefined;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,3})[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (m && m[1].length === 1 && !cur) {
      doc = m[2].trim();
      cur = { level: 1, title: doc, lines: [line] };
      continue;
    }
    if (m && m[1].length >= 2) {
      if (cur) out.push(cur);
      cur = { level: m[1].length, title: m[2].trim(), lines: [line] };
      continue;
    }
    (cur ??= { level: 1, title: doc, lines: [] }).lines.push(line);
  }
  if (cur) out.push(cur);

  const seen = new Map<string, number>();
  let parent = '';
  const sections: DocSection[] = [];
  for (const s of out) {
    const body = s.lines.join('\n').trim();
    if (s.level === 2) parent = s.title;
    if (!body || body.split('\n').length < 2) continue;
    const base = `${file}#${slug(s.title)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const trail = s.level === 1 ? [file] : s.level === 3 && parent ? [file, parent, s.title] : [file, s.title];
    sections.push({ id: n > 1 ? `${base}-${n}` : base, file, title: s.title, path: trail.join(' > '), text: body });
  }
  return sections;
}

/** Stemmed search words, stopwords out. */
export function terms(text: string): string[] {
  return words(text)
    .map((w) => stem(w.replace(/[._-]+$/, '')))
    .filter((w) => w.length > 1);
}

const K1 = 1.2;
const B = 0.75;
/** Heading words count this many times. */
const TITLE_WEIGHT = 3;
/** A snippet stops growing past this many characters. */
const SNIPPET_CHARS = 1_600;
/** A section this short comes back whole. */
const WHOLE_CHARS = 1_900;

interface Entry {
  section: DocSection;
  weight: number;
  tf: Map<string, number>;
  length: number;
}

function paragraphs(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) {
      if (cur.length) out.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/** The heading and the paragraphs that hold the most query words, in their order, up to SNIPPET_CHARS. */
function snippetOf(section: DocSection, query: Set<string>): { snippet: string; partial: boolean } {
  if (section.text.length <= WHOLE_CHARS) return { snippet: section.text, partial: false };
  const paras = paragraphs(section.text);
  const head = paras.shift() ?? '';
  const scored = paras.map((p, i) => {
    const t = terms(p);
    const distinct = new Set(t.filter((w) => query.has(w))).size;
    const count = t.filter((w) => query.has(w)).length;
    return { i, p, score: distinct * 10 + Math.min(count, 10) };
  });
  const picked: typeof scored = [];
  let size = head.length;
  for (const s of [...scored].filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (picked.length && size + s.p.length > SNIPPET_CHARS) continue;
    picked.push(s);
    size += s.p.length;
    if (size >= SNIPPET_CHARS) break;
  }
  // nothing matched below the heading: the section's opening
  if (!picked.length && scored.length) picked.push(scored[0]);
  picked.sort((a, b) => a.i - b.i);
  const parts: string[] = [head];
  let last = -1;
  for (const s of picked) {
    if (last >= 0 && s.i > last + 1) parts.push('[...]');
    let p = s.p;
    if (p.length > SNIPPET_CHARS) p = `${p.slice(0, SNIPPET_CHARS).replace(/\s+\S*$/, '')} [...]`;
    parts.push(p);
    last = s.i;
  }
  return { snippet: parts.join('\n\n'), partial: true };
}

/** An index over sections already split (tests build one from text). */
export function indexSections(docs: Array<{ file: string; text: string; weight?: number }>, missing: string[] = []): DocsIndex {
  const entries: Entry[] = [];
  for (const d of docs) {
    for (const section of splitSections(d.file, d.text)) {
      const tf = new Map<string, number>();
      const body = terms(section.text);
      const title = terms(section.title);
      for (const t of body) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of title) tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT - 1);
      entries.push({ section, weight: d.weight ?? 1, tf, length: body.length + title.length * (TITLE_WEIGHT - 1) });
    }
  }
  const df = new Map<string, number>();
  for (const e of entries) for (const t of e.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = entries.reduce((n, e) => n + e.length, 0) / Math.max(1, entries.length);
  const byId = new Map(entries.map((e) => [e.section.id.toLowerCase(), e.section]));

  return {
    sections: entries.map((e) => e.section),
    missing,
    search(query: string, limit = 3): DocHit[] {
      const q = [...new Set(terms(query))];
      if (!q.length) return [];
      // a long question has to share more than one word with a section
      const need = Math.max(1, Math.ceil(q.length / 3));
      const qset = new Set(q);
      const hits: Array<{ e: Entry; score: number }> = [];
      for (const e of entries) {
        let score = 0;
        let matched = 0;
        for (const t of q) {
          const tf = e.tf.get(t);
          if (!tf) continue;
          matched++;
          const n = df.get(t) ?? 0;
          const idf = Math.log(1 + (entries.length - n + 0.5) / (n + 0.5));
          score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * e.length) / (avg || 1)));
        }
        if (matched < need || score <= 0) continue;
        // sections that hold more of the question rank above ones that repeat one word
        hits.push({ e, score: score * e.weight * (0.5 + (0.5 * matched) / q.length) });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.e.section.id.localeCompare(b.e.section.id))
        .slice(0, Math.max(1, limit))
        .map(({ e, score }) => ({ section: e.section, score, ...snippetOf(e.section, qset) }));
    },
    get(ref: string): DocSection | undefined {
      const want = ref.trim().replace(/^docs\//, '');
      if (!want) return undefined;
      const exact = byId.get(want.toLowerCase());
      if (exact) return exact;
      // a heading or a path as shown: the one section whose title or path ends with it
      const lower = want.toLowerCase();
      const near = entries.filter((e) => e.section.title.toLowerCase() === lower || e.section.path.toLowerCase() === lower);
      return near.length === 1 ? near[0].section : undefined;
    },
  };
}

let loaded: Promise<DocsIndex> | undefined;

/** The shipped docs, read and indexed once per process. */
export function helpDocs(): Promise<DocsIndex> {
  loaded ??= (async () => {
    const docs: Array<{ file: string; text: string; weight: number }> = [];
    const missing: string[] = [];
    await Promise.all(
      Object.entries(HELP_DOCS).map(async ([file, src]) => {
        try {
          docs.push({ file, text: (await src.load()).default, weight: src.weight });
        } catch {
          missing.push(file);
        }
      }),
    );
    // the order of HELP_DOCS, whatever order the loads finished in
    const order = Object.keys(HELP_DOCS);
    docs.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
    return indexSections(docs, missing.sort());
  })();
  return loaded;
}
