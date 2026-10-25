import { inflateRawSync } from 'node:zlib';
import { DOMParser } from 'linkedom';

/**
 * Office documents as Markdown for the Read tool. OOXML (docx, xlsx, pptx)
 * and OpenDocument (odt, ods, odp) files are zip archives of XML, so they are
 * unzipped in-process (node:zlib) and walked with linkedom's XML parser.
 */

export const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
/** Legacy binary formats, and the format to convert each to. */
export const LEGACY_OFFICE = new Map([['doc', 'docx'], ['xls', 'xlsx'], ['ppt', 'pptx']]);
/** One XML part above this is refused (a zip bomb, or a sheet too large to parse on the hub). */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_SHEET_ROWS = 500;
export const MAX_SHEET_COLS = 200;
/** Excel's last column (XFD); a cell reference past it is malformed. */
const MAX_XLSX_COL = 16383;

/** The rendered slice of a sheet: at most MAX_SHEET_ROWS x MAX_SHEET_COLS, with the real extent counted. */
type Grid = { rows: string[][]; total: number; wide: boolean };

type Zip = Map<string, () => Uint8Array>;
type El = Element;

/** The entries of a zip archive, each inflated on demand. Stored and deflated entries only; no ZIP64. */
export function unzip(bytes: Uint8Array): Zip {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const out: Zip = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('broken zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    out.set(name, () => {
      if (local + 30 > bytes.length || dv.getUint32(local, true) !== 0x04034b50) throw new Error(`broken zip entry ${name}`);
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + csize);
      if (usize > MAX_ENTRY_BYTES) throw new Error(`${name} is too large to read (${usize} bytes)`);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(1, usize) });
      throw new Error(`${name} uses zip compression method ${method}, which is not supported`);
    });
  }
  return out;
}

function xml(zip: Zip, name: string): Document | undefined {
  const read = zip.get(name);
  if (!read) return undefined;
  return new DOMParser().parseFromString(new TextDecoder().decode(read()), 'text/xml') as unknown as Document;
}

const kids = (el: Element, tag: string): El[] => [...el.children].filter((c) => c.tagName === tag);
const all = (el: Element | Document, tag: string): El[] => [...el.getElementsByTagName(tag)];

/** A Markdown table; the first row is the header. */
export function mdTable(rows: string[][]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length || !width) return [];
  const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)];
}

/** Drop empty cells at the end of each row and empty rows at the end. */
function trimGrid(rows: string[][]): string[][] {
  const out = rows.map((r) => {
    let n = r.length;
    while (n && !r[n - 1]) n--;
    return r.slice(0, n);
  });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

/** Blocks joined by blank lines; list items stay together. */
class Md {
  lines: string[] = [];
  block(...ls: string[]) {
    if (!ls.length) return;
    if (this.lines.length) this.lines.push('');
    this.lines.push(...ls);
  }
  item(l: string) {
    const prev = this.lines[this.lines.length - 1];
    if (this.lines.length && !/^\s*- /.test(prev ?? '')) this.lines.push('');
    this.lines.push(l);
  }
  toString() {
    return this.lines.join('\n');
  }
}

/** Resolve a relationship target against the folder of the part that names it. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Relationship id -> { target part, type } for a part (word/document.xml -> word/_rels/document.xml.rels). */
function rels(zip: Zip, part: string): Map<string, { target: string; type: string }> {
  const dir = part.split('/').slice(0, -1).join('/');
  const doc = xml(zip, `${dir ? `${dir}/` : ''}_rels/${part.split('/').pop()}.rels`);
  const out = new Map<string, { target: string; type: string }>();
  for (const r of doc ? all(doc, 'Relationship') : []) {
    out.set(r.getAttribute('Id') ?? '', { target: resolvePart(part, r.getAttribute('Target') ?? ''), type: r.getAttribute('Type') ?? '' });
  }
  return out;
}

// ---------- docx ----------

function wText(el: Element): string {
  let s = '';
  for (const c of el.children) {
    const t = c.tagName;
    if (t === 'w:t') s += c.textContent ?? '';
    else if (t === 'w:tab') s += '\t';
    else if (t === 'w:br' || t === 'w:cr') s += '\n';
    else if (t === 'w:delText' || t === 'w:instrText' || t === 'w:pPr' || t === 'w:rPr' || t === 'w:del') continue;
    else s += wText(c);
  }
  return s;
}

function docx(zip: Zip): string {
  const doc = xml(zip, 'word/document.xml');
  const body = doc && all(doc, 'w:body')[0];
  if (!body) throw new Error('word/document.xml is missing');
  // heading levels come from the style names, which stay English when the ids are localized
  const level = new Map<string, number>();
  const styles = xml(zip, 'word/styles.xml');
  for (const s of styles ? all(styles, 'w:style') : []) {
    const name = (kids(s, 'w:name')[0]?.getAttribute('w:val') ?? '').toLowerCase();
    const m = name.match(/^heading (\d)$/);
    if (m || name === 'title') level.set(s.getAttribute('w:styleId') ?? '', m ? Number(m[1]) : 1);
  }
  const md = new Md();
  const para = (p: Element) => {
    const text = wText(p).trim();
    if (!text) return;
    const pPr = kids(p, 'w:pPr')[0];
    const style = pPr && kids(pPr, 'w:pStyle')[0]?.getAttribute('w:val');
    const numPr = pPr && kids(pPr, 'w:numPr')[0];
    const h = style ? level.get(style) : undefined;
    // shortcut: every list item is a bullet; numbered lists need word/numbering.xml, add it when someone needs the numbers
    if (h) md.block(`${'#'.repeat(h)} ${text.replace(/\n/g, ' ')}`);
    else if (numPr) md.item(`${'  '.repeat(Number(kids(numPr, 'w:ilvl')[0]?.getAttribute('w:val') ?? 0))}- ${text}`);
    else md.block(text);
  };
  const table = (tbl: Element) => {
    const rows = kids(tbl, 'w:tr').map((tr) => kids(tr, 'w:tc').map((tc) => all(tc, 'w:p').map((p) => wText(p).trim()).filter(Boolean).join('\n')));
    md.block(...mdTable(rows));
  };
  const walk = (el: Element) => {
    for (const c of el.children) {
      if (c.tagName === 'w:p') para(c);
      else if (c.tagName === 'w:tbl') table(c);
      else if (c.tagName === 'w:sdt' || c.tagName === 'w:sdtContent' || c.tagName === 'w:customXml') walk(c);
    }
  };
  walk(body);
  return md.toString();
}

// ---------- xlsx ----------

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Text of a shared or inline string, without phonetic runs. */
const siText = (si: Element) => all(si, 't').filter((t) => t.parentElement?.tagName !== 'rPh').map((t) => t.textContent ?? '').join('');

function xlsx(zip: Zip): string {
  const wb = xml(zip, 'xl/workbook.xml');
  if (!wb) throw new Error('xl/workbook.xml is missing');
  const sst = xml(zip, 'xl/sharedStrings.xml');
  const shared = sst ? all(sst, 'si').map(siText) : [];
  const links = rels(zip, 'xl/workbook.xml');
  const md = new Md();
  for (const sh of all(wb, 'sheet')) {
    const name = sh.getAttribute('name') ?? '';
    const part = links.get(sh.getAttribute('r:id') ?? '')?.target;
    const doc = part ? xml(zip, part) : undefined;
    md.block(`## Sheet: ${name}`);
    if (!doc) {
      md.block('(No cells: a chart sheet or a missing part.)');
      continue;
    }
    // the `r` column comes from the file: keep cells sparse and build only the rendered slice, so a huge column costs nothing
    const rows: string[][] = [];
    let seen = 0;
    let total = 0;
    let wide = false;
    for (const row of all(doc, 'row')) {
      seen++;
      // past the cap only count rows that hold a value
      if (rows.length >= MAX_SHEET_ROWS) {
        if (kids(row, 'c').some((c) => kids(c, 'v')[0]?.textContent || kids(c, 'is').length)) total = seen;
        continue;
      }
      const cells = new Map<number, string>();
      let i = -1;
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r');
        i = ref ? colIndex(ref) : i + 1;
        if (!(i >= 0 && i <= MAX_XLSX_COL)) continue;
        const t = c.getAttribute('t');
        const v = kids(c, 'v')[0]?.textContent ?? '';
        // shortcut: numbers print as stored, so dates show as serial numbers; read styles.xml number formats if that matters
        const text = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? siText(kids(c, 'is')[0] ?? c) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
        if (!text) continue;
        total = seen;
        if (i >= MAX_SHEET_COLS) wide = true;
        else cells.set(i, text);
      }
      const width = cells.size ? Math.max(...cells.keys()) + 1 : 0;
      rows.push(Array.from({ length: width }, (_, k) => cells.get(k) ?? ''));
    }
    sheetTable(md, { rows: trimGrid(rows), total, wide });
  }
  return md.toString();
}

function sheetTable(md: Md, { rows, total, wide }: Grid) {
  if (!rows.length && !total) return md.block('(Empty sheet.)');
  md.block(...mdTable(rows));
  if (total > MAX_SHEET_ROWS) md.block(`(This sheet has ${total} rows; only the first ${MAX_SHEET_ROWS} are shown. Export the sheet to CSV with Bash to read the rest.)`);
  if (wide) md.block(`(This sheet has cells past column ${MAX_SHEET_COLS}; only the first ${MAX_SHEET_COLS} columns are shown.)`);
}

// ---------- pptx ----------

const PH_SKIP = new Set(['sldNum', 'sldImg', 'dt']);

/** Paragraphs and tables of a slide or notes part, in document order. */
function drawingText(root: Element, md: Md) {
  const walk = (el: Element) => {
    for (const c of el.children) {
      const t = c.tagName;
      if (t === 'p:sp') {
        const ph = all(c, 'p:ph')[0];
        const type = ph?.getAttribute('type') ?? '';
        if (PH_SKIP.has(type)) continue;
        const paras = all(c, 'a:p').map(aText).filter((s) => s.trim());
        if (!paras.length) continue;
        if (type === 'title' || type === 'ctrTitle') md.block(`### ${paras.join(' ').replace(/\n/g, ' ')}`);
        else md.block(...paras);
      } else if (t === 'a:tbl') {
        md.block(...mdTable(kids(c, 'a:tr').map((tr) => kids(tr, 'a:tc').map((tc) => all(tc, 'a:p').map(aText).filter(Boolean).join('\n')))));
      } else walk(c);
    }
  };
  walk(root);
}

function aText(p: Element): string {
  let s = '';
  for (const c of p.children) {
    if (c.tagName === 'a:r' || c.tagName === 'a:fld') s += kids(c, 'a:t').map((t) => t.textContent ?? '').join('');
    else if (c.tagName === 'a:br') s += '\n';
  }
  return s;
}

function pptx(zip: Zip): string {
  const pres = xml(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('ppt/presentation.xml is missing');
  const links = rels(zip, 'ppt/presentation.xml');
  const md = new Md();
  all(pres, 'p:sldId').forEach((s, i) => {
    const part = links.get(s.getAttribute('r:id') ?? '')?.target;
    const slide = part ? xml(zip, part) : undefined;
    md.block(`## Slide ${i + 1}`);
    if (!slide || !part) return;
    drawingText(slide.documentElement as unknown as Element, md);
    const notesPart = [...rels(zip, part).values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notes = notesPart ? xml(zip, notesPart) : undefined;
    if (notes) {
      const n = new Md();
      drawingText(notes.documentElement as unknown as Element, n);
      if (n.lines.length) md.block('Notes:', ...n.lines);
    }
  });
  return md.toString();
}

// ---------- OpenDocument (odt, ods, odp) ----------

function odfText(el: Element): string {
  let s = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      s += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== 1) continue;
    const c = node as Element;
    const t = c.tagName;
    if (t === 'text:s') s += ' '.repeat(Number(c.getAttribute('text:c') ?? 1));
    else if (t === 'text:tab') s += '\t';
    else if (t === 'text:line-break') s += '\n';
    else if (t === 'text:note' || t === 'office:annotation') continue;
    else s += odfText(c);
  }
  return s;
}

function odfTable(tbl: Element): Grid {
  // repeats come from the file (a sheet pads with one empty cell or row repeated to 16384 or 1M): count them, build only the rendered slice
  const repeat = (el: Element, attr: string) => Math.max(1, Math.floor(Number(el.getAttribute(attr) ?? 1)) || 1);
  const rows: string[][] = [];
  let seen = 0;
  let total = 0;
  let wide = false;
  for (const row of all(tbl, 'table:table-row')) {
    const r: string[] = [];
    let col = 0;
    let filled = false;
    for (const c of [...row.children].filter((c) => c.tagName === 'table:table-cell' || c.tagName === 'table:covered-table-cell')) {
      const v = all(c, 'text:p').map(odfText).join('\n');
      const n = repeat(c, 'table:number-columns-repeated');
      if (v) filled = true;
      if (v && col + n > MAX_SHEET_COLS) wide = true;
      for (let k = col; k < Math.min(col + n, MAX_SHEET_COLS); k++) r.push(v);
      col += n;
    }
    const n = repeat(row, 'table:number-rows-repeated');
    if (filled) total = seen + n;
    seen += n;
    for (let k = 0; k < n && rows.length < MAX_SHEET_ROWS; k++) rows.push(r);
  }
  return { rows: trimGrid(rows), total, wide };
}

function odf(zip: Zip): string {
  const doc = xml(zip, 'content.xml');
  const body = doc && all(doc, 'office:body')[0];
  if (!body) throw new Error('content.xml is missing');
  const md = new Md();
  let slide = 0;
  const list = (l: Element, depth: number) => {
    for (const li of kids(l, 'text:list-item')) {
      for (const x of li.children) {
        if (x.tagName === 'text:list') list(x, depth + 1);
        else if (x.tagName === 'text:p' || x.tagName === 'text:h') {
          const s = odfText(x).trim();
          if (s) md.item(`${'  '.repeat(depth)}- ${s}`);
        }
      }
    }
  };
  const walk = (el: Element) => {
    for (const c of el.children) {
      const t = c.tagName;
      if (t === 'text:h') {
        const s = odfText(c).trim();
        if (s) md.block(`${'#'.repeat(Math.min(6, Number(c.getAttribute('text:outline-level') ?? 1)))} ${s}`);
      } else if (t === 'text:p') {
        const s = odfText(c).trim();
        if (s) md.block(s);
      } else if (t === 'text:list') list(c, 0);
      else if (t === 'table:table') {
        if (el.tagName === 'office:spreadsheet') {
          md.block(`## Sheet: ${c.getAttribute('table:name') ?? ''}`);
          sheetTable(md, odfTable(c));
        } else md.block(...mdTable(odfTable(c).rows));
      } else if (t === 'draw:page') {
        md.block(`## Slide ${++slide}`);
        walk(c);
      } else if (t === 'presentation:notes') {
        const n = new Md();
        for (const p of all(c, 'text:p')) {
          const s = odfText(p).trim();
          if (s) n.lines.push(s);
        }
        if (n.lines.length) md.block('Notes:', ...n.lines);
      } else if (t !== 'office:forms' && t !== 'text:sequence-decls' && t !== 'table:named-expressions') walk(c);
    }
  };
  walk(body);
  return md.toString();
}

/** Markdown text of a docx, xlsx, pptx, odt, ods or odp file. Throws on a broken or foreign archive. */
export function officeToMarkdown(ext: string, bytes: Uint8Array): string {
  const zip = unzip(bytes);
  if (ext === 'docx') return docx(zip);
  if (ext === 'xlsx') return xlsx(zip);
  if (ext === 'pptx') return pptx(zip);
  return odf(zip);
}
