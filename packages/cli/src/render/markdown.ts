/**
 * Markdown to ANSI for the terminal. Covers what models write: headings,
 * bold, italics, strike, inline code, fenced code with highlighting, lists
 * (nested, ordered, tasks), quotes, tables, rules and links. Unclosed fences
 * render as code so partial streams look right.
 */
import { createPainter, padEnd, width as strWidth, type Painter } from '../ansi';
import { CODE_COLORS, highlightLine, normalizeLang } from './highlight';
import { wrapAnsi, indentLines } from './wrap';

export interface MarkdownOptions {
  /** Columns available. Paragraphs wrap to this. */
  width?: number;
  painter?: Painter;
  /** Background for code blocks. */
  codeBg?: string;
}

export const MD_COLORS = {
  inlineCode: '#B4A7F5',
  link: '#5FA8E8',
  heading: '#E5C07B',
  quote: '#808080',
  bullet: '#9CA3AF',
  codeBg: '#1E1E22',
};

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const p = opts.painter ?? createPainter({ enabled: false });
  const width = Math.max(20, opts.width ?? 80);
  return renderBlocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), width, p, 0, opts).join('\n');
}

function isBlockStart(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)![0].length;
}

function renderBlocks(lines: string[], width: number, p: Painter, depth: number, opts: MarkdownOptions): string[] {
  const out: string[] = [];
  let i = 0;
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      blank();
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const marker = fence[2];
      const lang = fence[3] ?? '';
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(l);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          i++;
          break;
        }
        code.push(indent ? l.replace(new RegExp(`^ {0,${indent}}`), '') : l);
        i++;
      }
      out.push(...renderCode(code, lang, width, p, opts));
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const text = renderInline(h[2], p);
      let styled: string;
      if (level === 1) styled = p.bold(p.underline(p.fg(MD_COLORS.heading)(text)));
      else if (level === 2) styled = p.bold(p.fg(MD_COLORS.heading)(text));
      else if (level === 3) styled = p.bold(text);
      else styled = p.bold(p.italic(text));
      if (!p.enabled) styled = text;
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(wrapAnsi(styled, width));
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push(p.dim('─'.repeat(Math.min(width, 48))));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && (QUOTE.test(lines[i]) || !isBlockStart(lines[i]))) {
        const m = QUOTE.exec(lines[i]);
        inner.push(m ? m[1] : lines[i]);
        i++;
      }
      const body = renderBlocks(inner, width - 2, p, depth, opts).join('\n');
      const bar = p.fg(MD_COLORS.quote)('│ ');
      out.push(indentLines(p.italic(body), bar, bar));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      i = renderList(lines, i, width, p, depth, opts, out);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows: string[] = [line];
      const sep = lines[i + 1];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') rows.push(lines[i++]);
      out.push(...renderTable(rows, sep, width, p));
      continue;
    }

    // paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !isBlockStart(lines[i]))) {
      if (para.length && lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) break;
      para.push(lines[i]);
      i++;
    }
    // Models put one item per line more often than they rely on soft wraps,
    // so line breaks inside a paragraph are kept.
    const text = para.map((raw) => raw.trim().replace(/\\$/, '')).join('\n');
    out.push(wrapAnsi(renderInline(text, p), width));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out;
}

const BULLETS = ['•', '◦', '▪', '‣'];

function renderList(lines: string[], start: number, width: number, p: Painter, depth: number, opts: MarkdownOptions, out: string[]): number {
  let i = start;
  const baseIndent = leadingSpaces(lines[start]);
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent !== baseIndent) break;
    const markerRaw = m[2];
    let body = m[3];
    const contentIndent = indent + markerRaw.length + 1;
    const itemLines: string[] = [];
    // task list
    let marker: string;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (/\d/.test(markerRaw)) marker = p.fg(MD_COLORS.bullet)(markerRaw.replace(')', '.'));
    else marker = p.fg(MD_COLORS.bullet)(BULLETS[depth % BULLETS.length]);
    if (task) {
      marker = task[1] === ' ' ? p.fg(MD_COLORS.bullet)('☐') : p.green('☑');
      body = task[2];
    }
    itemLines.push(body);
    i++;
    // body lines: deeper indented lines, lazy continuations, nested lists
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') {
        // blank: continue only if the next non-blank line is indented into this item
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && leadingSpaces(lines[j]) > indent && leadingSpaces(lines[j]) >= Math.min(contentIndent, indent + 2)) {
          itemLines.push('');
          i++;
          continue;
        }
        break;
      }
      const ind = leadingSpaces(l);
      if (ind > indent && (ind >= Math.min(contentIndent, indent + 2) || LIST_ITEM.test(l))) {
        itemLines.push(l.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (LIST_ITEM.test(l) || isBlockStart(l)) break;
      // lazy continuation of the paragraph
      itemLines.push(l.trim());
      i++;
    }
    const markerW = strWidth(marker);
    const inner = renderBlocks(itemLines, Math.max(10, width - markerW - 1), p, depth + 1, opts).join('\n');
    out.push(indentLines(inner, marker + ' ', ' '.repeat(markerW + 1)));
    // skip blank lines between items of the same list
    let j = i;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j < lines.length && j > i) {
      const nm = LIST_ITEM.exec(lines[j]);
      if (nm && nm[1].length === baseIndent) i = j;
    }
  }
  return i;
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i];
    if (ch === '\\' && r[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(rows: string[], sep: string, width: number, p: Painter): string[] {
  const aligns = splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
  const cells = rows.map((r) => splitRow(r).map((c) => renderInline(c, p)));
  const cols = Math.max(...cells.map((r) => r.length));
  for (const r of cells) while (r.length < cols) r.push('');
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...cells.map((r) => strWidth(r[c]))));
  const total = widths.reduce((a, b) => a + b, 0) + cols * 3 + 1;
  const line = (l: string, m: string, r: string) => p.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  if (total > width) {
    // Too wide: one block per row, "header: value".
    const header = cells[0];
    const out: string[] = [];
    for (let r = 1; r < cells.length; r++) {
      if (r > 1) out.push('');
      for (let c = 0; c < cols; c++) {
        if (!cells[r][c]) continue;
        out.push(wrapAnsi(`${p.bold(header[c] || `#${c + 1}`)}: ${cells[r][c]}`, width));
      }
    }
    return out;
  }
  const fmtRow = (r: string[], bold: boolean) =>
    p.dim('│') +
    r
      .map((cell, c) => {
        const w = widths[c];
        const cw = strWidth(cell);
        const padTotal = w - cw;
        const txt = bold ? p.bold(cell) : cell;
        if (aligns[c] === 'right') return ' ' + ' '.repeat(padTotal) + txt + ' ';
        if (aligns[c] === 'center') {
          const left = Math.floor(padTotal / 2);
          return ' ' + ' '.repeat(left) + txt + ' '.repeat(padTotal - left) + ' ';
        }
        return ' ' + txt + ' '.repeat(padTotal) + ' ';
      })
      .join(p.dim('│')) +
    p.dim('│');
  const out = [line('┌', '┬', '┐'), fmtRow(cells[0], true), line('├', '┼', '┤')];
  for (let r = 1; r < cells.length; r++) out.push(fmtRow(cells[r], false));
  out.push(line('└', '┴', '┘'));
  return out;
}

function renderCode(code: string[], lang: string, width: number, p: Painter, opts: MarkdownOptions): string[] {
  while (code.length && code[code.length - 1].trim() === '') code.pop();
  if (!p.enabled) return code.flatMap((l) => wrapAnsi(l, Math.max(10, width - 2)).split('\n').map((w) => '  ' + w));
  const l = normalizeLang(lang);
  const state: { inBlock?: boolean } = {};
  const bg = p.bg(opts.codeBg ?? MD_COLORS.codeBg);
  const fg = p.fg(CODE_COLORS.text);
  const inner = Math.max(10, width - 2);
  const widest = Math.max(0, ...code.map((c) => strWidth(c)));
  const boxW = Math.min(inner, Math.max(widest, Math.min(inner, 20)));
  const out: string[] = [];
  const label = l && l !== 'text' ? p.fg(CODE_COLORS.meta)(lang) : '';
  if (label) out.push(bg(' ' + padEnd('', Math.max(0, boxW - strWidth(lang))) + label + ' '));
  for (const raw of code) {
    const hl = highlightLine(raw, l, p, state);
    // Long lines are wrapped by character so the background stays a block.
    const wrapped = strWidth(raw) > boxW ? wrapAnsi(hl, boxW).split('\n') : [hl];
    for (const w of wrapped) out.push(bg(fg(' ' + padEnd(w, boxW) + ' ')));
  }
  if (code.length === 0) out.push(bg(' '.repeat(boxW + 2)));
  return out;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const PH = /\u0000(\d+)\u0000/g;

export function renderInline(text: string, p: Painter): string {
  const slots: string[] = [];
  const s = inline(text, p, slots);
  let out = s;
  for (let n = 0; n < 8 && /\u0000\d+\u0000/.test(out); n++) out = out.replace(PH, (_, k) => slots[Number(k)] ?? '');
  return out;
}

function inline(text: string, p: Painter, slots: string[]): string {
  const hold = (v: string) => {
    slots.push(v);
    return `\u0000${slots.length - 1}\u0000`;
  };
  let s = text;
  // code spans first so nothing inside them is formatted
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code: string) => {
    const c = code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code;
    return hold(p.enabled ? p.fg(MD_COLORS.inlineCode)(c) : c);
  });
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, (_, ch: string) => hold(ch));
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url: string) => hold(p.underline(p.fg(MD_COLORS.link)(url))));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt: string, url: string) =>
    hold(p.dim(`[image${alt ? ': ' + alt : ''}] `) + p.fg(MD_COLORS.link)(url)),
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => {
    const l = inline(label, p, slots);
    const same = label === url || label === url.replace(/^https?:\/\//, '');
    return hold(p.underline(p.fg(MD_COLORS.link)(l)) + (same ? '' : p.dim(` (${url})`)));
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()\u0000]*[^\s<>().,;:!?'"\u0000])/g, (_, pre: string, url: string) => pre + hold(p.underline(p.fg(MD_COLORS.link)(url))));
  return emphasis(s, p, hold);
}

function emphasis(s: string, p: Painter, hold: (v: string) => string): string {
  let r = s;
  r = r.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, t: string) => hold(p.bold(emphasis(t, p, hold))));
  r = r.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_, pre: string, t: string) => pre + hold(p.bold(emphasis(t, p, hold))));
  r = r.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])?\*(?![*\w])/g, (m: string, pre: string, t: string | undefined) => {
    if (t === undefined) {
      // single char like *a*
      const inner = m.slice(pre.length + 1, -1);
      return pre + hold(p.italic(inner));
    }
    return pre + hold(p.italic(emphasis(m.slice(pre.length + 1, -1), p, hold)));
  });
  r = r.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])?_(?!\w)/g, (m: string, pre: string) => pre + hold(p.italic(m.slice(pre.length + 1, -1))));
  r = r.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, t: string) => hold(p.strike(emphasis(t, p, hold))));
  return r;
}
