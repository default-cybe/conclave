/**
 * claude.ai and ChatGPT exports, uploaded to the hub
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.12).
 *
 * The body is the export zip or its conversations.json. Zips are read with
 * node:zlib (stored and deflated entries, the two methods the exports use),
 * and conversations.json is split with a streaming array reader, so one
 * conversation is parsed at a time. Each upload is stored under
 * <home>/imports/<uploadId>/ as conversations.jsonl (one per line) and
 * meta.json, and shows up as device "upload:<uploadId>". Uploads older than
 * 30 days are deleted.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { ImportUploadResult } from '../client/import';
import { convertChatGpt, convertClaudeAi } from '../importers/exports';
import type { ConvertedSession } from '../importers/types';
import { newId } from '../util/ids';

export const UPLOAD_PREFIX = 'upload:';
export const UPLOAD_MAX_AGE_MS = 30 * 86_400_000;
/** Hard cap on one upload (the zip of a big account is a few hundred MB). */
export const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * Hard cap on what an upload holds once unzipped, per entry and in total. A
 * zip's own size fields are not trusted: inflating stops at this many bytes,
 * so a small zip that would expand to many GB cannot take the hub down.
 */
export const UPLOAD_MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  size: number;
  read(): Uint8Array;
}

function tooBig(name: string, max: number): UploadError {
  return new UploadError(413, `${name} is over ${Math.round(max / 1048576)} MB once unzipped. Split the export and upload the parts.`);
}

/** Entries of a zip file from its central directory. Each read stops at `maxEntryBytes`, whatever the zip claims. */
export function readZip(buf: Uint8Array, opts: { maxEntryBytes?: number } = {}): ZipEntry[] {
  const maxEntry = opts.maxEntryBytes ?? UPLOAD_MAX_INFLATED_BYTES;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // end of central directory: last 22 bytes plus up to 64 KiB of comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UploadError(400, 'This is not a zip file the hub can read.');
  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  // zip64
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(view.getBigUint64(loc + 8, true));
      if (view.getUint32(z64, true) === 0x06064b50) {
        count = Number(view.getBigUint64(z64 + 32, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
      }
    }
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    let compSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let local = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // zip64 extra field
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = view.getUint16(x, true);
      const len = view.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) (size = Number(view.getBigUint64(q, true))), (q += 8);
        if (compSize === 0xffffffff) (compSize = Number(view.getBigUint64(q, true))), (q += 8);
        if (local === 0xffffffff) local = Number(view.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    p = xEnd + commentLen;
    if (name.endsWith('/')) continue;
    const at = local;
    const cs = compSize;
    entries.push({
      name,
      size,
      read: () => {
        if (view.getUint32(at, true) !== 0x04034b50) throw new UploadError(400, `The zip entry ${name} is damaged.`);
        const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
        const data = buf.subarray(start, start + cs);
        if (method === 0) {
          if (data.length > maxEntry) throw tooBig(name, maxEntry);
          return data;
        }
        if (method === 8) {
          if (size > maxEntry) throw tooBig(name, maxEntry);
          try {
            return new Uint8Array(inflateRawSync(data, { maxOutputLength: maxEntry }));
          } catch (err) {
            if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw tooBig(name, maxEntry);
            throw new UploadError(400, `The zip entry ${name} is damaged.`);
          }
        }
        throw new UploadError(400, `The zip entry ${name} uses compression method ${method}, which the hub cannot read.`);
      },
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// streaming JSON array
// ---------------------------------------------------------------------------

/** Yield each top-level element of a JSON array as text, without parsing the whole array. */
export function* jsonArrayItems(buf: Uint8Array): Generator<string> {
  let i = 0;
  const n = buf.length;
  while (i < n && buf[i] !== 0x5b) i++; // [
  if (i >= n) throw new UploadError(400, 'conversations.json is not a JSON list.');
  i++;
  const dec = new TextDecoder();
  for (;;) {
    while (i < n && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09 || buf[i] === 0x2c)) i++;
    if (i >= n || buf[i] === 0x5d) return;
    const start = i;
    let depth = 0;
    let inStr = false;
    for (; i < n; i++) {
      const c = buf[i];
      if (inStr) {
        if (c === 0x5c) i++;
        else if (c === 0x22) inStr = false;
        continue;
      }
      if (c === 0x22) inStr = true;
      else if (c === 0x7b || c === 0x5b) depth++;
      else if (c === 0x7d || c === 0x5d) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (depth === 0 && c === 0x2c) break;
    }
    yield dec.decode(buf.subarray(start, i));
  }
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

export interface UploadMeta {
  id: string;
  source: 'claude-ai' | 'chatgpt';
  name?: string;
  createdAt: number;
  items: number;
  unknownContentTypes: Record<string, number>;
  projects?: Record<string, string>;
}

function looksZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** The conversation files of an export, in order (conversations.json, or conversations-000.json and up). */
function conversationFiles(entries: ZipEntry[]): ZipEntry[] {
  const base = (e: ZipEntry) => e.name.split('/').pop() ?? e.name;
  return entries.filter((e) => /^conversations(-\d+)?\.json$/i.test(base(e))).sort((a, b) => base(a).localeCompare(base(b)));
}

export function convertUploaded(source: 'claude-ai' | 'chatgpt', conv: Record<string, any>, projects?: Map<string, string>): ConvertedSession {
  return source === 'claude-ai' ? convertClaudeAi(conv, { projects }) : convertChatGpt(conv);
}

/** The conversation id an export uses, read without converting the whole conversation. */
function rawId(source: 'claude-ai' | 'chatgpt', conv: Record<string, any>): string | undefined {
  const v = source === 'claude-ai' ? conv.uuid : (conv.conversation_id ?? conv.id);
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
}

/** Where each stored conversation is in conversations.jsonl: path to [byte offset, byte length]. */
type UploadIndex = Record<string, [number, number]>;

export class Uploads {
  private readonly maxInflated: number;

  constructor(
    readonly dir: string,
    opts: { maxInflatedBytes?: number } = {},
  ) {
    this.maxInflated = opts.maxInflatedBytes ?? UPLOAD_MAX_INFLATED_BYTES;
  }

  private path(id: string, file: string): string {
    if (!/^upl_[A-Za-z0-9_-]+$/.test(id)) throw new UploadError(404, `Unknown upload ${id}.`);
    return join(this.dir, id, file);
  }

  /** Store an export. Returns what it holds. */
  save(source: 'claude-ai' | 'chatgpt', body: Uint8Array, name?: string, now = Date.now()): ImportUploadResult {
    if (!body.length) throw new UploadError(400, 'The upload is empty.');
    if (body.length > UPLOAD_MAX_BYTES) throw new UploadError(413, 'The upload is over 1 GB. Split the export and upload the parts.');
    const parts: Uint8Array[] = [];
    let projects: Map<string, string> | undefined;
    if (looksZip(body)) {
      const entries = readZip(body, { maxEntryBytes: this.maxInflated });
      const files = conversationFiles(entries);
      if (!files.length) throw new UploadError(400, 'The zip has no conversations.json. Upload the export zip as it came, or its conversations.json.');
      let total = 0;
      for (const f of files) {
        const part = f.read();
        total += part.length;
        if (total > this.maxInflated) throw tooBig('The export', this.maxInflated);
        parts.push(part);
      }
      const proj = entries.find((e) => /(^|\/)projects\.json$/i.test(e.name));
      if (proj) {
        try {
          const list = JSON.parse(new TextDecoder().decode(proj.read())) as Array<{ uuid?: string; name?: string }>;
          projects = new Map(list.filter((p) => p?.uuid && p?.name).map((p) => [p.uuid!, p.name!]));
        } catch {
          // projects are only names
        }
      }
    } else parts.push(body);

    const id = newId('upl');
    const folder = join(this.dir, id);
    const lines: string[] = [];
    const index: UploadIndex = {};
    const unknown: Record<string, number> = {};
    const unreadable = () => void (unknown['conversation:unreadable'] = (unknown['conversation:unreadable'] ?? 0) + 1);
    let items = 0;
    let withMessages = 0;
    let offset = 0;
    for (const part of parts) {
      for (const text of jsonArrayItems(part)) {
        let conv: Record<string, any>;
        try {
          conv = JSON.parse(text);
        } catch {
          unreadable();
          continue;
        }
        if (!conv || typeof conv !== 'object' || Array.isArray(conv)) {
          unreadable();
          continue;
        }
        // one damaged conversation is counted and left out; the rest of the export still imports
        let c: ConvertedSession;
        try {
          c = convertUploaded(source, conv, projects);
        } catch {
          unreadable();
          continue;
        }
        for (const [k, v] of Object.entries(c.unknown)) unknown[k] = (unknown[k] ?? 0) + v;
        if (c.messages.length) withMessages++;
        const line = JSON.stringify(conv);
        const path = `${UPLOAD_PREFIX}${id}#${c.nativeId ?? `n${items}`}`;
        const len = Buffer.byteLength(line);
        // a conversation id that repeats keeps its first copy, as reading by path always did
        if (!index[path]) index[path] = [offset, len];
        lines.push(line);
        offset += len + 1;
        items++;
      }
    }
    const app = source === 'claude-ai' ? 'claude.ai' : 'ChatGPT';
    if (!items) throw new UploadError(400, `No ${app} conversations were found in the upload.`);
    // conversations but not one message: most often the other app's export, picked under the wrong name
    if (!withMessages) {
      const other = source === 'claude-ai' ? 'ChatGPT' : 'claude.ai';
      throw new UploadError(400, `None of the ${items} conversations has a message ${app} would write. If this is a ${other} export, upload it as ${other}.`);
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'conversations.jsonl'), lines.join('\n') + '\n');
    writeFileSync(join(folder, 'index.json'), JSON.stringify(index));
    const meta: UploadMeta = { id, source, ...(name ? { name } : {}), createdAt: now, items, unknownContentTypes: unknown, ...(projects?.size ? { projects: Object.fromEntries(projects) } : {}) };
    writeFileSync(join(folder, 'meta.json'), JSON.stringify(meta));
    return { uploadId: id, source, items, unknownContentTypes: unknown };
  }

  meta(id: string): UploadMeta | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id, 'meta.json'), 'utf8')) as UploadMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Every conversation of an upload, converted, with a stable path:
   * upload:<id>#<conversation id>. A line that no longer parses (a damaged
   * file) is skipped; the numbering of conversations without an id follows
   * the stored order, as at upload time.
   */
  *conversations(id: string): Generator<{ path: string; conv: ConvertedSession }> {
    const meta = this.meta(id);
    if (!meta) throw new UploadError(404, `Unknown upload ${id}. Uploads are kept for 30 days.`);
    const projects = meta.projects ? new Map(Object.entries(meta.projects)) : undefined;
    const text = readFileSync(this.path(id, 'conversations.jsonl'), 'utf8');
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let conv: ConvertedSession;
      try {
        conv = convertUploaded(meta.source, JSON.parse(line) as Record<string, any>, projects);
      } catch {
        continue;
      }
      yield { path: `${UPLOAD_PREFIX}${id}#${conv.nativeId ?? `n${n}`}`, conv };
      n++;
    }
  }

  /**
   * One conversation by path. The index written at upload time says where its
   * line is, so importing N conversations reads and converts N lines, not N
   * times the whole export. Older uploads without an index are scanned.
   */
  read(id: string, path: string): ConvertedSession | undefined {
    const meta = this.meta(id);
    if (!meta) throw new UploadError(404, `Unknown upload ${id}. Uploads are kept for 30 days.`);
    let index: UploadIndex | undefined;
    try {
      index = JSON.parse(readFileSync(this.path(id, 'index.json'), 'utf8')) as UploadIndex;
    } catch {
      index = undefined;
    }
    const at = index?.[path];
    if (at) {
      const [offset, len] = at;
      const buf = Buffer.alloc(len);
      const fd = openSync(this.path(id, 'conversations.jsonl'), 'r');
      try {
        readSync(fd, buf, 0, len, offset);
      } finally {
        closeSync(fd);
      }
      try {
        const raw = JSON.parse(buf.toString('utf8')) as Record<string, any>;
        if (rawId(meta.source, raw) === undefined || path.endsWith(`#${rawId(meta.source, raw)}`)) {
          return convertUploaded(meta.source, raw, meta.projects ? new Map(Object.entries(meta.projects)) : undefined);
        }
      } catch {
        // a damaged index or line: fall back to the scan
      }
    }
    if (index && !at) return undefined;
    for (const c of this.conversations(id)) if (c.path === path) return c.conv;
    return undefined;
  }

  /** Delete uploads older than 30 days. Returns how many went. */
  prune(now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    for (const name of readdirSync(this.dir)) {
      const meta = this.meta(name);
      const at = meta?.createdAt ?? statSync(join(this.dir, name)).mtimeMs;
      if (now - at > UPLOAD_MAX_AGE_MS) {
        rmSync(join(this.dir, name), { recursive: true, force: true });
        n++;
      }
    }
    return n;
  }
}

export function uploadIdOf(device: string): string | undefined {
  return device.startsWith(UPLOAD_PREFIX) ? device.slice(UPLOAD_PREFIX.length) : undefined;
}
