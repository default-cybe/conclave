/**
 * A zip attached to a message (docs/design/CHAT-AND-MOTION.md 2.5).
 *
 * The hub never writes a zip's entries anywhere. It reads the central
 * directory and inflates each entry in memory with node:zlib, as the export
 * import does (import/upload.ts), and refuses a zip that could hurt:
 *
 * - more than ZIP_MAX_ENTRIES entries, or more than ZIP_MAX_UNPACKED_BYTES
 *   once unpacked. The sizes the zip claims are checked first, then each
 *   entry is inflated with the claimed size as its hard limit
 *   (maxOutputLength), so a zip that lies about its sizes stops there;
 * - a path outside the zip's own folder (an absolute path, a drive letter,
 *   a ".." part) or a link (a Unix symlink in the entry's mode).
 *
 * What the model gets depends on the session (attachments/prepare.ts): a
 * session with file tools gets the zip saved in its folder and a listing
 * (`listingNote`); a chat reads it here (`readForChat`): the listing, the
 * text files up to ZIP_TEXT_MAX_BYTES, and the pictures as images.
 */
import { inflateRawSync } from 'node:zlib';
import type { Attachment } from '../client/index';
import { formatBytes } from '../tools/util';

/** Entries in one zip, files and folders. */
export const ZIP_MAX_ENTRIES = 1000;
/** What one zip holds once unpacked. */
export const ZIP_MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
/** Text a chat gets from one zip, whole files only, so the model's context keeps room to answer. */
export const ZIP_TEXT_MAX_BYTES = 512 * 1024;
/** One picture from a zip (the size a provider takes for an image). */
export const ZIP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The pictures from one zip together. */
export const ZIP_IMAGES_MAX_BYTES = 20 * 1024 * 1024;
/** Lines of the listing the model reads; "and N more files" after. */
export const ZIP_LIST_MAX = 200;

/** A zip the hub will not open, with the reason in words. */
export class ZipRefused extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ZipRefused';
  }
}

export interface ZipEntry {
  /** The path inside the zip, with forward slashes. */
  name: string;
  /** What it claims to unpack to. */
  size: number;
  dir: boolean;
  encrypted: boolean;
  /** 0 stored, 8 deflated; anything else the hub cannot read. */
  method: number;
  /** Junk a Mac adds (__MACOSX/, .DS_Store): checked, never listed or read. */
  junk: boolean;
  /** Local header offset and compressed size. */
  at: number;
  packed: number;
}

export interface OpenedZip {
  /** The zip's name, for the words. */
  label: string;
  entries: ZipEntry[];
  /** Files that count: not folders, not junk. */
  files: ZipEntry[];
  /** What the files claim to unpack to. */
  unpacked: number;
  buf: Uint8Array;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A path that stays inside the zip's folder: relative, no "..", no drive, no NUL. */
export function safeEntryName(name: string): boolean {
  if (!name || name.includes('\0')) return false;
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((part) => part === '..');
}

function isJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name);
}

/**
 * The zip's entries from its central directory, every one checked: a bad
 * name, a link, too many entries or too much once unpacked throws ZipRefused.
 */
export function openZip(buf: Uint8Array, label: string): OpenedZip {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const notZip = () => new ZipRefused(`${label} is not a zip file the hub can read.`);
  if (buf.length < 22) throw notZip();
  // end of central directory: the last 22 bytes and up to 64 KB of comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notZip();
  let count = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);
  if (cd === 0xffffffff || count === 0xffff) {
    // zip64: the real count and offset are in its own end record
    const loc = eocd - 20;
    if (loc < 0 || view.getUint32(loc, true) !== 0x07064b50) throw notZip();
    const z64 = Number(view.getBigUint64(loc + 8, true));
    if (z64 < 0 || z64 + 56 > buf.length || view.getUint32(z64, true) !== 0x06064b50) throw notZip();
    count = Number(view.getBigUint64(z64 + 32, true));
    cd = Number(view.getBigUint64(z64 + 48, true));
  }
  if (count > ZIP_MAX_ENTRIES) throw new ZipRefused(`${label} holds more than ${ZIP_MAX_ENTRIES.toLocaleString('en-US')} files. Zip fewer.`);
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let unpacked = 0;
  let p = cd;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipRefused(`${label} is damaged.`);
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let packed = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const attrs = view.getUint32(p + 38, true);
    let at = view.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw new ZipRefused(`${label} is damaged.`);
    const raw = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // zip64 sizes and offset in the extra field
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = view.getUint16(x, true);
      const len = view.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        const end = Math.min(x + 4 + len, xEnd);
        if (size === 0xffffffff && q + 8 <= end) (size = Number(view.getBigUint64(q, true))), (q += 8);
        if (packed === 0xffffffff && q + 8 <= end) (packed = Number(view.getBigUint64(q, true))), (q += 8);
        if (at === 0xffffffff && q + 8 <= end) at = Number(view.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    p = xEnd + commentLen;
    if (!safeEntryName(raw)) throw new ZipRefused(`${label} has a file outside its folder (${raw.slice(0, 120)}). The hub does not open it.`);
    // a symlink: the Unix mode in the upper half of the external attributes
    if ((madeBy === 3 || madeBy === 19) && ((attrs >>> 16) & S_IFMT) === S_IFLNK) throw new ZipRefused(`${label} holds a link (${raw.slice(0, 120)}). The hub does not open zips with links.`);
    const name = raw.replace(/\\/g, '/');
    const dir = name.endsWith('/');
    if (!dir) {
      unpacked += size;
      if (unpacked > ZIP_MAX_UNPACKED_BYTES) throw new ZipRefused(`${label} unpacks to more than ${ZIP_MAX_UNPACKED_BYTES / 1024 / 1024} MB.`);
    }
    entries.push({ name, size, dir, encrypted: (flags & 1) === 1, method, junk: isJunk(name), at, packed });
  }
  return { label, entries, files: entries.filter((e) => !e.dir && !e.junk), unpacked, buf };
}

/**
 * One entry's bytes, inflated with its claimed size as the hard limit. A
 * zip whose entry unpacks to more or less than it claims is refused.
 * Undefined for an encrypted entry or a method the hub cannot read.
 */
export function readEntry(zip: OpenedZip, e: ZipEntry): Uint8Array | undefined {
  if (e.dir || e.encrypted || (e.method !== 0 && e.method !== 8)) return undefined;
  const { buf } = zip;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const damaged = () => new ZipRefused(`${zip.label} is damaged (${e.name.slice(0, 120)}).`);
  if (e.at + 30 > buf.length || view.getUint32(e.at, true) !== 0x04034b50) throw damaged();
  const start = e.at + 30 + view.getUint16(e.at + 26, true) + view.getUint16(e.at + 28, true);
  if (start + e.packed > buf.length) throw damaged();
  const data = buf.subarray(start, start + e.packed);
  let out: Uint8Array;
  if (e.method === 0) out = data;
  else {
    try {
      out = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) }));
    } catch {
      // more than it claimed (a bomb that lies), or not deflate at all
      throw damaged();
    }
  }
  if (out.length !== e.size) throw damaged();
  return out;
}

/** Every entry the hub can read, inflated once, so a zip that lies about its sizes is refused before anyone unzips it. */
export function checkAll(zip: OpenedZip, onFile?: (e: ZipEntry, bytes: Uint8Array) => void): void {
  for (const e of zip.entries) {
    const bytes = readEntry(zip, e);
    if (bytes && onFile && !e.junk) onFile(e, bytes);
  }
}

function fileLine(e: ZipEntry): string {
  return `${e.name}  ${formatBytes(e.size)}${e.encrypted ? ', encrypted' : ''}`;
}

/** "archive.zip holds 12 files, 340.0 KB unpacked." and the files, ZIP_LIST_MAX at most, then "and N more files". */
export function listing(zip: OpenedZip): string {
  const n = zip.files.length;
  const head = `${zip.label} holds ${n} ${n === 1 ? 'file' : 'files'}, ${formatBytes(zip.unpacked)} unpacked.`;
  if (!n) return head;
  const lines = zip.files.slice(0, ZIP_LIST_MAX).map(fileLine);
  if (n > ZIP_LIST_MAX) lines.push(`and ${n - ZIP_LIST_MAX} more files`);
  return `${head}\n\n${lines.join('\n')}`;
}

/** The note a session with file tools gets: where the zip is, and what it holds. */
export function listingNote(zip: OpenedZip, path: string): string {
  return `${zip.label} is saved at ${path}. Unzip it there with your tools to work on it.\n\n${listing(zip)}`;
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A picture's media type when its name and its first bytes agree. */
function imageType(name: string, b: Uint8Array): string | undefined {
  const t = IMAGE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
  if (!t || b.length < 12) return undefined;
  const sig = (...xs: number[]) => xs.every((x, i) => b[i] === x);
  if (t === 'image/png' && sig(0x89, 0x50, 0x4e, 0x47)) return t;
  if (t === 'image/jpeg' && sig(0xff, 0xd8, 0xff)) return t;
  if (t === 'image/gif' && sig(0x47, 0x49, 0x46, 0x38)) return t;
  if (t === 'image/webp' && sig(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return t;
  return undefined;
}

const fatal = new TextDecoder('utf-8', { fatal: true });

/** Its text, when it is UTF-8 with no NUL bytes; else undefined (a binary file). */
function textOf(b: Uint8Array): string | undefined {
  if (b.includes(0)) return undefined;
  try {
    return fatal.decode(b);
  } catch {
    return undefined;
  }
}

const b64 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

/**
 * A chat's zip, read by the hub: one text document (named as the zip) with
 * the listing and the text files, whole, up to ZIP_TEXT_MAX_BYTES together,
 * and "and N more files" for those it cut; then the pictures as images,
 * `room` at most (what is left of MAX_ATTACHMENTS).
 */
export function readForChat(zip: OpenedZip, room: number): Attachment[] {
  const texts: Array<{ name: string; text: string }> = [];
  const images: Attachment[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  let textsLeft = 0;
  let imagesLeft = 0;
  checkAll(zip, (e, bytes) => {
    const img = imageType(e.name, bytes);
    if (img) {
      if (images.length < room && bytes.length <= ZIP_IMAGE_MAX_BYTES && imageBytes + bytes.length <= ZIP_IMAGES_MAX_BYTES) {
        imageBytes += bytes.length;
        images.push({ mediaType: img, data: b64(bytes), name: `${zip.label}: ${e.name}` });
      } else imagesLeft++;
      return;
    }
    const text = textOf(bytes);
    if (text === undefined) return;
    // whole files only: one too big for what is left is cut, the smaller ones after it still go
    if (textBytes + bytes.length <= ZIP_TEXT_MAX_BYTES) {
      textBytes += bytes.length;
      texts.push({ name: e.name, text });
    } else textsLeft++;
  });
  const parts = [listing(zip)];
  if (texts.length) {
    parts.push(texts.map((t) => `--- ${t.name} ---\n${t.text.replace(/\s+$/, '')}`).join('\n\n'));
  }
  if (textsLeft) parts.push(`and ${textsLeft} more ${textsLeft === 1 ? 'file' : 'files'} of text, not included here.`);
  if (images.length) parts.push(`${images.length === 1 ? 'The picture follows' : `The ${images.length} pictures follow`} as ${images.length === 1 ? 'an image' : 'images'}${imagesLeft ? `, and ${imagesLeft} more ${imagesLeft === 1 ? 'is' : 'are'} not included` : ''}.`);
  else if (imagesLeft) parts.push(`and ${imagesLeft} more ${imagesLeft === 1 ? 'picture' : 'pictures'}, not included here.`);
  const doc: Attachment = { mediaType: 'text/plain', data: Buffer.from(parts.join('\n\n'), 'utf8').toString('base64'), name: zip.label };
  return [doc, ...images];
}
