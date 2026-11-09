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
  const head = new TextDecoder('utf-8').decode(b.subarray(0, SNIFF_BYTES)).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<') && /^(?:<\?xml[^>]*>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
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
export function imageLeftOutNote(name: string): string {
  return `[image ${name} left out: not a format the model can read]`;
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
