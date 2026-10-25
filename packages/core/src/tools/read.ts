import type { DocumentBlock, ImageBlock, TextBlock } from '../types';
import type { Tool, ToolContext, ToolOutput } from './types';
import { parseNotebook, renderNotebook } from './notebook';
import { LEGACY_OFFICE, OFFICE_EXT, officeToMarkdown } from './office';
import { DOCLING_EXT, doclingConvert, doclingFor } from './docling';
import { basename, dirname, extname, fail, formatBytes, joinPath, numberLines, outputBudget, readMarkOf, resolveAbsolute, shellQuote, splitLines, pathRule } from './util';

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

const DEFAULT_LIMIT = 2000;
/** Output budget (~25k tokens). Longer reads stop early and say so. */
const MAX_OUTPUT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_DOC_BYTES = 5 * 1024 * 1024;
/** Above this size text files are read through sed instead of loading them whole. */
const LARGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PDF_PAGES = 20;
const PDF_DEFAULT_PAGES = 10;
/** Office files and documents for Docling are loaded whole on the hub. */
const MAX_OFFICE_BYTES = 64 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const BINARY_EXT = new Set([
  'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'zst', '7z', 'rar', 'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'lib', 'class',
  'jar', 'war', 'pyc', 'pyo', 'wasm', 'bin', 'iso', 'dmg', 'img', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'wav', 'flac',
  'ogg', 'webm', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'ico', 'bmp', 'tif', 'tiff', 'psd', 'heic', 'avif', 'sqlite',
  'sqlite3', 'db', 'doc', 'xls', 'ppt', 'deb', 'rpm', 'apk', 'ipa', 'pak',
  'node', 'parquet', 'arrow', 'pt', 'pth', 'onnx', 'safetensors', 'npy', 'npz', 'pkl',
]);

const DESCRIPTION = `Read a file from the machine this session runs on.

- file_path is absolute or relative to the working directory.
- Reads up to ${DEFAULT_LIMIT} lines from the start. Read a file whole unless it is longer than that; then pass offset (1-based start line) and limit.
- Output is cat -n style: a line number and a tab start each line. They are not part of the file; never put them in an Edit old_string. Lines over 2000 characters are cut.
- Images (png, jpg, gif, webp) come back as images. PDFs come back as text; past ${PDF_DEFAULT_PAGES} pages pass pages (for example "1-5"), at most ${MAX_PDF_PAGES} per call. Notebooks (.ipynb) come back with every cell and its outputs.
- Word, Excel and PowerPoint files (docx, xlsx, pptx) and OpenDocument files (odt, ods, odp) come back as Markdown text with line numbers; use offset and limit for long ones. Legacy .doc, .xls and .ppt are not read.
- To list a directory use Glob or Bash ls. Read several files in parallel in one turn.
- Read a file before you Edit or Write over it.`;

export const ReadTool: Tool<ReadInput> = {
  name: 'Read',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to read, absolute or relative to the working directory' },
      offset: { type: 'integer', description: '1-based line number to start reading from. Use only for files too long to read at once.', minimum: 1 },
      limit: { type: 'integer', description: 'Number of lines to read. Use only for files too long to read at once.', minimum: 1 },
      pages: { type: 'string', description: 'Page range for PDF files, e.g. "1-5", "3" or "10-". At most 20 pages per call.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input, ctx) => pathRule(ctx, input.file_path),
  summarize: (input) => `Read ${input.file_path}`,
  async run(input, ctx) {
    const r = resolveAbsolute(ctx, input.file_path);
    if ('error' in r) return fail(r.error);
    const path = r.path;

    const st = await ctx.machine.stat(path);
    if (!st) return fail(await notFoundMessage(ctx, path));
    if (st.type === 'dir') return fail(`${path} is a directory, not a file. Use Glob or Bash (ls) to list it.`);

    const ext = extname(path);
    if (IMAGE_EXT[ext]) return readImage(ctx, path, st.size, st.mtimeMs, IMAGE_EXT[ext]);
    if (ext === 'pdf') return readPdf(ctx, path, st.size, st.mtimeMs, input.pages);
    const offset = Math.max(1, Math.floor(input.offset ?? 1));
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
    if (OFFICE_EXT.has(ext)) return readOffice(ctx, path, ext, st.size, offset, limit);
    const to = LEGACY_OFFICE.get(ext);
    if (to) {
      return fail(`${path} is a legacy binary Office file (.${ext}), which Read does not open. Convert it with Bash (soffice --headless --convert-to ${to} --outdir /tmp ${shellQuote(path)}) and Read the .${to} copy.`);
    }
    if (ext === 'ipynb') {
      try {
        const raw = await ctx.machine.readText(path);
        const nb = parseNotebook(raw);
        ctx.readState.set(path, st.mtimeMs);
        const blocks = renderNotebook(nb, path);
        return { content: blocks.length === 1 ? (blocks[0] as TextBlock).text : blocks, meta: { path, readMark: readMarkOf(path, st.mtimeMs, raw) } };
      } catch (err) {
        return fail(`Could not parse notebook ${path}: ${(err as Error).message}`);
      }
    }
    if (BINARY_EXT.has(ext)) {
      return fail(`${path} is a binary file (.${ext}, ${formatBytes(st.size)}) and cannot be read as text. Use Bash with a suitable tool (file, unzip -l, xxd | head, sqlite3, ffprobe...) to inspect it.`);
    }

    if (st.size > LARGE_FILE_BYTES) return readLargeText(ctx, path, st.size, st.mtimeMs, offset, limit);

    const bytes = await ctx.machine.readFile(path);
    const text = decodeText(bytes);
    if (text === null) {
      return fail(`${path} looks like a binary file (${formatBytes(st.size)}) and cannot be read as text. Use Bash (file, xxd | head, strings) to inspect it.`);
    }
    ctx.readState.set(path, st.mtimeMs);
    // the result records what was read, so Edit and Write can tell a change even when the mtime stayed (item 17)
    const readMark = readMarkOf(path, st.mtimeMs, Buffer.from(bytes).toString('utf8'));

    if (text.length === 0) {
      return { content: `(The file ${path} exists but is empty.)`, meta: { path, readMark } };
    }
    const lines = splitLines(text);
    const out = formatLines(path, lines, offset, limit, lines.length, false, outputBudget(ctx, MAX_OUTPUT_CHARS));
    return { ...out, meta: { ...out.meta, readMark } };
  },
};

function formatLines(path: string, window: string[] | undefined, offset: number, limit: number, total: number, preSliced = false, budget = MAX_OUTPUT_CHARS): ToolOutput {
  if (!window) return fail(`Could not read ${path}`);
  if (offset > total) {
    return { content: `(File ${path} has ${total} lines; offset ${offset} is past the end. Use a smaller offset.)`, meta: { path } };
  }
  let slice = preSliced ? window : window.slice(offset - 1, offset - 1 + limit);
  let text = numberLines(slice, offset);
  let cutForSize = false;
  if (text.length > budget) {
    // Keep whole lines within budget.
    let size = 0;
    let n = 0;
    for (const line of slice) {
      size += Math.min(line.length, 2050) + 8;
      if (size > budget) break;
      n++;
    }
    slice = slice.slice(0, Math.max(1, n));
    text = numberLines(slice, offset);
    cutForSize = true;
  }
  const last = offset + slice.length - 1;
  const notes: string[] = [];
  if (cutForSize) notes.push(`Output stopped at line ${last} to stay within the size budget. The file has ${total} lines; continue with offset=${last + 1}.`);
  else if (last < total) notes.push(`Showing lines ${offset}-${last} of ${total}. Use offset and limit to read more.`);
  return {
    content: notes.length ? `${text}\n\n(${notes.join(' ')})` : text,
    meta: { path, truncated: last < total || undefined, lines: total },
  };
}

async function readOffice(ctx: ToolContext, path: string, ext: string, size: number, offset: number, limit: number): Promise<ToolOutput> {
  if (size > MAX_OFFICE_BYTES) {
    return fail(`${path} is ${formatBytes(size)}, over the ${formatBytes(MAX_OFFICE_BYTES)} limit for Office files. Convert it with Bash (soffice --headless --convert-to pdf) or split it first.`);
  }
  const bytes = await ctx.machine.readFile(path);
  let md: string | undefined;
  let note = '';
  const docling = DOCLING_EXT.has(ext) ? doclingFor(ctx) : undefined;
  if (docling) {
    try {
      md = await doclingConvert(docling, bytes, basename(path), { signal: ctx.signal });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      note = `Docling failed (${(err as Error).message}); this is the built-in reader's text.`;
    }
  }
  if (md === undefined) {
    try {
      md = officeToMarkdown(ext, bytes);
    } catch (err) {
      return fail(`Could not read ${path} as a .${ext} file: ${(err as Error).message}`);
    }
  }
  // no read mark: Edit and Write work on text, and writing text over the zip would destroy the file
  if (!md.trim()) return { content: `(The file ${path} has no text.)${note ? ` (${note})` : ''}`, meta: { path } };
  const lines = splitLines(md);
  const out = formatLines(path, lines, offset, limit, lines.length, false, outputBudget(ctx, MAX_OUTPUT_CHARS));
  return note && typeof out.content === 'string' ? { ...out, content: `${out.content}\n\n(${note})` } : out;
}

/** pdftotext -layout output with a run of 3 or more lines in 3 or more columns. */
function looksTabular(text: string): boolean {
  let run = 0;
  for (const line of text.split('\n')) {
    run = (line.trim().match(/\S\s{2,}(?=\S)/g)?.length ?? 0) >= 2 ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

/** UTF-8 (or UTF-16 with BOM) text, or null for binary data. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const sniff = bytes.subarray(0, 8192);
  let suspicious = 0;
  for (const b of sniff) {
    if (b === 0) return null;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  if (sniff.length && suspicious / sniff.length > 0.1) return null;
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

async function readLargeText(ctx: ToolContext, path: string, size: number, mtimeMs: number, offset: number, limit: number): Promise<ToolOutput> {
  const q = shellQuote(path);
  const head = await ctx.machine.exec(`head -c 8192 ${q}`, { cwd: ctx.cwd, timeoutMs: 15_000, signal: ctx.signal });
  if (head.stdout.includes('\u0000')) return fail(`${path} looks like a binary file (${formatBytes(size)}) and cannot be read as text.`);
  const end = offset + limit - 1;
  const [count, body] = await Promise.all([
    ctx.machine.exec(`wc -l < ${q}`, { cwd: ctx.cwd, timeoutMs: 60_000, signal: ctx.signal }),
    ctx.machine.exec(`sed -n '${offset},${end}p;${end}q' ${q}`, { cwd: ctx.cwd, timeoutMs: 60_000, signal: ctx.signal, maxOutputBytes: 16 * 1024 * 1024 }),
  ]);
  if (body.exitCode !== 0) return fail(`Could not read ${path}: ${body.stderr.trim() || 'sed failed'}`);
  ctx.readState.set(path, mtimeMs);
  const total = Number(count.stdout.trim()) || offset + splitLines(body.stdout).length - 1;
  const lines = body.stdout ? splitLines(body.stdout) : [];
  const out = formatLines(path, lines, offset, limit, Math.max(total, offset - 1 + lines.length), true, outputBudget(ctx, MAX_OUTPUT_CHARS));
  // too large to hash: marked by mtime only
  return { ...out, meta: { ...out.meta, readMark: readMarkOf(path, mtimeMs) } };
}

function sniffImageType(bytes: Uint8Array, fallback: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return fallback;
}

async function readImage(ctx: ToolContext, path: string, size: number, mtimeMs: number, fallbackType: string): Promise<ToolOutput> {
  if (size > MAX_IMAGE_BYTES) {
    return fail(`Image ${path} is ${formatBytes(size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} limit. Make a smaller copy first (for example with Bash: convert in.png -resize 50% /tmp/small.png) and read that.`);
  }
  const bytes = await ctx.machine.readFile(path);
  ctx.readState.set(path, mtimeMs);
  const mediaType = sniffImageType(bytes, fallbackType);
  const image: ImageBlock = { type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') };
  return { content: [{ type: 'text', text: `Image ${path} (${mediaType}, ${formatBytes(size)})` }, image], meta: { path, readMark: readMarkOf(path, mtimeMs, Buffer.from(bytes).toString('utf8')) } };
}

function parsePages(spec: string): { first: number; last?: number } | undefined {
  const m = spec.trim().match(/^(\d+)\s*(?:-\s*(\d*))?$/);
  if (!m) return undefined;
  const first = Number(m[1]);
  if (first < 1) return undefined;
  if (m[2] === undefined) return { first, last: first };
  if (m[2] === '') return { first };
  const last = Number(m[2]);
  return last >= first ? { first, last } : undefined;
}

async function readPdf(ctx: ToolContext, path: string, size: number, mtimeMs: number, pages?: string): Promise<ToolOutput> {
  const q = shellQuote(path);
  let total: number | undefined;
  const info = await ctx.machine.exec(`pdfinfo ${q}`, { cwd: ctx.cwd, timeoutMs: 20_000, signal: ctx.signal }).catch(() => undefined);
  const pm = info?.stdout.match(/^Pages:\s+(\d+)/m);
  if (pm) total = Number(pm[1]);

  let first = 1;
  let last: number | undefined;
  let note = '';
  if (pages) {
    const parsed = parsePages(pages);
    if (!parsed) return fail(`Invalid pages value "${pages}". Use a page number like "3" or a range like "1-5".`);
    first = parsed.first;
    last = parsed.last ?? (total ? Math.min(total, first + MAX_PDF_PAGES - 1) : first + MAX_PDF_PAGES - 1);
    if (last - first + 1 > MAX_PDF_PAGES) return fail(`Page range ${pages} covers ${last - first + 1} pages; the maximum per call is ${MAX_PDF_PAGES}.`);
    if (total && first > total) return fail(`${path} has ${total} pages; page ${first} does not exist.`);
    if (total) last = Math.min(last, total);
  } else if (total && total > PDF_DEFAULT_PAGES) {
    last = PDF_DEFAULT_PAGES;
    note = `This PDF has ${total} pages; showing 1-${PDF_DEFAULT_PAGES}. Pass pages (for example "${PDF_DEFAULT_PAGES + 1}-${Math.min(total, PDF_DEFAULT_PAGES + MAX_PDF_PAGES)}") to read more.`;
  } else if (!total) {
    last = MAX_PDF_PAGES;
  }

  const range = `-f ${first}${last ? ` -l ${last}` : ''}`;
  const res = await ctx.machine
    .exec(`pdftotext -layout ${range} ${q} -`, { cwd: ctx.cwd, timeoutMs: 60_000, signal: ctx.signal, maxOutputBytes: 4 * 1024 * 1024 })
    .catch(() => undefined);
  const hasText = !!(res && res.exitCode === 0 && res.stdout.trim());
  const docling = doclingFor(ctx);
  let doclingNote = '';
  if (docling && size <= MAX_OFFICE_BYTES && (!hasText || looksTabular(res!.stdout))) {
    try {
      const range: [number, number] | undefined = last ? [first, last] : undefined;
      const md = await doclingConvert(docling, await ctx.machine.readFile(path), basename(path), { pages: range, signal: ctx.signal });
      ctx.readState.set(path, mtimeMs);
      const budget = outputBudget(ctx, MAX_OUTPUT_CHARS);
      const cut = md.length > budget ? `\n\n(Output stopped at ${budget} characters to stay within the size budget. Pass a smaller pages range.)` : '';
      const header = `PDF ${path}${total ? ` (${total} pages)` : ''}, pages ${first}-${last ?? total ?? '?'}, converted by Docling`;
      return { content: `${header}\n\n${md.slice(0, budget)}${cut}${note ? `\n\n(${note})` : ''}`, meta: { path, readMark: readMarkOf(path, mtimeMs) } };
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      doclingNote = ` Docling failed (${(err as Error).message}).`;
    }
  }
  if (hasText && res) {
    ctx.readState.set(path, mtimeMs);
    const chunks = res.stdout.split('\f');
    const body = chunks
      .map((c, i) => (c.trim() ? `--- page ${first + i} ---\n${c.replace(/\s+$/, '')}` : ''))
      .filter(Boolean)
      .join('\n\n');
    const header = `PDF ${path}${total ? ` (${total} pages)` : ''}, pages ${first}-${last ?? first + chunks.length - 1}`;
    return { content: `${header}\n\n${body}${note ? `\n\n(${note})` : ''}${doclingNote ? `\n\n(${doclingNote.trim()})` : ''}`, meta: { path, readMark: readMarkOf(path, mtimeMs) } };
  }

  // No text layer or no pdftotext: hand over the document itself when small.
  if (size <= MAX_PDF_DOC_BYTES) {
    const bytes = await ctx.machine.readFile(path);
    ctx.readState.set(path, mtimeMs);
    const doc: DocumentBlock = { type: 'document', mediaType: 'application/pdf', data: Buffer.from(bytes).toString('base64'), title: basename(path) };
    const why = res && res.exitCode === 0 ? 'The PDF has no extractable text (probably scanned).' : 'pdftotext is not available on this machine.';
    return {
      content: [
        { type: 'text', text: `PDF ${path} (${formatBytes(size)}). ${why}${doclingNote} The document is attached.` },
        // ToolOutput content is typed as text and image blocks; providers that support documents in tool results accept this block.
        doc as unknown as ImageBlock,
      ],
      meta: { path },
    };
  }
  const why = res && res.exitCode === 0 ? 'it has no extractable text' : 'pdftotext (poppler-utils) is not installed';
  return fail(`Cannot read PDF ${path} (${formatBytes(size)}): ${why}, and it is too large to attach. Install poppler-utils or use an OCR tool via Bash.`);
}

async function notFoundMessage(ctx: ToolContext, path: string): Promise<string> {
  let msg = `File does not exist: ${path}. Current working directory: ${ctx.cwd}.`;
  // a path that dropped part of the working directory (".../run/src/a.ts" for ".../run/repo/src/a.ts")
  const cwd = ctx.cwd.replace(/\/+$/, '');
  if (!path.startsWith(`${cwd}/`)) {
    const parts = path.split('/').filter(Boolean);
    for (let k = Math.min(4, parts.length - 1); k >= 1; k--) {
      const guess = joinPath(cwd, parts.slice(-k).join('/'));
      if (await ctx.machine.stat(guess).then((s) => s?.type === 'file', () => false)) return `${msg} Did you mean ${guess}?`;
    }
  }
  try {
    const dir = dirname(path);
    const name = basename(path).toLowerCase();
    const stem = name.replace(/\.[^.]+$/, '');
    const entries = await ctx.machine.readdir(dir);
    const similar = entries
      .filter((e) => {
        const n = e.name.toLowerCase();
        // The exact name is missing, so an equal lowercase name differs only in case.
        return n === name || n.replace(/\.[^.]+$/, '') === stem || (stem.length >= 3 && n.startsWith(stem));
      })
      .slice(0, 3)
      .map((e) => joinPath(dir, e.name));
    if (similar.length) msg += ` Did you mean ${similar.join(' or ')}?`;
  } catch {
    /* parent missing too */
  }
  return msg;
}
