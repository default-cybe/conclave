/**
 * What a picture really is, by its first bytes, and whether a model can read
 * it. The model APIs take JPEG, PNG, GIF and WebP only; anything else (a
 * phone's HEIC, an AVIF, a TIFF, a BMP, or bytes that do not match the type
 * a client declared) makes Anthropic answer 400 "Could not process image",
 * and every later turn that resends it fails the same way. So the hub checks
 * the bytes when a file is attached (attachments/prepare.ts) and again before
 * a request (providers/common.ts documentsForWire). Pure, so the web app
 * imports it too.
 */

/** The picture types every model API reads. */
export const MODEL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ModelImageType = (typeof MODEL_IMAGE_TYPES)[number];

export function isModelImage(type: string | undefined): type is ModelImageType {
  return !!type && (MODEL_IMAGE_TYPES as readonly string[]).includes(type);
}

/** Bytes to read for sniffImageType: enough for an ftyp box's brands and an SVG's prolog. */
export const SNIFF_BYTES = 768;

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'];
const BMP_HEADER_SIZES = [12, 40, 52, 56, 64, 108, 124];

/** An ISO media file's picture type from its ftyp box: AVIF, HEIC or HEIF, else undefined. */
function ftypImage(b: Uint8Array): string | undefined {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return undefined;
  const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  const major = ascii(b, 8, 12);
  const compatible: string[] = [];
  for (let i = 16; i + 4 <= size; i += 4) compatible.push(ascii(b, i, i + 4));
  // the major brand decides; a generic one (mif1, msf1) leaves it to the compatible brands
  for (const brands of [[major], compatible]) {
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'image/avif';
    if (brands.some((x) => HEIC_BRANDS.includes(x))) return 'image/heic';
  }
  return major === 'mif1' || major === 'msf1' || compatible.includes('mif1') || compatible.includes('msf1') ? 'image/heif' : undefined;
}

/**
 * A picture's type by its magic bytes: JPEG, PNG, GIF, WebP, TIFF, BMP,
 * HEIC/HEIF, AVIF or SVG. Undefined for anything else, including text and a
 * file too short to tell.
 */
export function sniffImageType(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 4 && (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*')) return 'image/tiff';
  // "BM" alone starts plenty of text: the DIB header's size must be one BMP knows
  if (b.length >= 18 && ascii(b, 0, 2) === 'BM' && BMP_HEADER_SIZES.includes(b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24))) return 'image/bmp';
  const iso = ftypImage(b);
  if (iso) return iso;
  // SVG: markup whose first element (after a prolog, comments or a doctype) is <svg
  let head = new TextDecoder('utf-8').decode(b.subarray(0, SNIFF_BYTES)).replace(/^\uFEFF/, '').trimStart();
  // skipped with indexOf, not one regex: a prolog regex backtracks badly on crafted input (CodeQL js/redos)
  for (;;) {
    const lower = head.slice(0, 9).toLowerCase();
    let end: number;
    if (lower.startsWith('<?xml') || lower === '<!doctype') end = head.indexOf('>') + 1;
    else if (head.startsWith('<!--')) end = head.indexOf('-->', 4) + 3;
    else break;
    if (end < 3) return undefined;
    head = head.slice(end).trimStart();
  }
  return /^<svg[\s>]/i.test(head) ? 'image/svg+xml' : undefined;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => le16(b, i) | (b[i + 2] << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/**
 * A PNG's, JPEG's, GIF's or WebP's pixel size from its header, without
 * decoding it. Undefined for any other type, a header cut short, or a size of
 * zero. A JPEG needs its bytes up to the frame header (SOFn), past any EXIF.
 */
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  switch (sniffImageType(b.subarray(0, SNIFF_BYTES))) {
    case 'image/png':
      return b.length >= 24 && ascii(b, 12, 16) === 'IHDR' ? size(be32(b, 16), be32(b, 20)) : undefined;
    case 'image/gif':
      return b.length >= 10 ? size(le16(b, 6), le16(b, 8)) : undefined;
    case 'image/webp': {
      const chunk = ascii(b, 12, 16);
      if (chunk === 'VP8 ' && b.length >= 30) return size(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
      if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
        const bits = (le24(b, 21) | (b[24] << 24)) >>> 0;
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === 'VP8X' && b.length >= 30) return size(le24(b, 24) + 1, le24(b, 27) + 1);
      return undefined;
    }
    case 'image/jpeg':
      for (let i = 2; i + 9 <= b.length; ) {
        if (b[i] !== 0xff) return undefined;
        const m = b[i + 1];
        if (m === 0xff) i++; // fill byte
        else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2; // markers with no length
        else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return size(be16(b, i + 7), be16(b, i + 5));
        else if (m === 0xd9 || m === 0xda) return undefined; // image end or scan start before any frame header
        else i += 2 + be16(b, i + 2);
      }
      return undefined;
  }
  return undefined;
}

/** "HEIC", "AVIF", "SVG": a picture type's name for the words. */
export function imageFormatName(type: string): string {
  const sub = type.replace(/^image\//, '').replace(/^x-/, '');
  return sub === 'svg+xml' ? 'SVG' : sub.toUpperCase();
}

/** The line for a picture the hub refuses: "photo.heic is a HEIC picture, which models can't read. ..." */
export function unreadablePicture(name: string, type: string | undefined): string {
  const tail = "Save it as PNG or JPEG and attach it again.";
  if (!type) return `${name} is not a PNG, JPEG, GIF or WebP picture, so models can't read it. ${tail}`;
  const fmt = imageFormatName(type);
  return `${name} is ${/^(A|E|I|O|SVG)/.test(fmt) ? 'an' : 'a'} ${fmt} picture, which models can't read. ${tail}`;
}

/** What a request carries in place of a picture the model cannot read. */
export function imageLeftOutNote(name: string, why = 'not a format the model can read'): string {
  return `[image ${name} left out: ${why}]`;
}

/**
 * An attached file checked by its bytes: the media type to send it under (a
 * declared type the bytes contradict is corrected), or the line refusing it.
 * A picture models cannot read is refused; an SVG goes as its text; a file
 * whose bytes are no picture keeps its type, unless it claimed to be one.
 */
export function checkPicture(head: Uint8Array, declared: string, name: string): { mediaType: string } | { refused: string } {
  const sniffed = sniffImageType(head);
  const claimed = declared.toLowerCase().startsWith('image/');
  if (isModelImage(sniffed)) return { mediaType: sniffed };
  if (sniffed === 'image/svg+xml' || declared.toLowerCase() === 'image/svg+xml') return { mediaType: claimed ? 'image/svg+xml' : declared };
  if (sniffed) return { refused: unreadablePicture(name, sniffed) };
  if (claimed) return { refused: unreadablePicture(name, isModelImage(declared.toLowerCase()) ? undefined : declared.toLowerCase()) };
  return { mediaType: declared };
}
