/**
 * Pictures no model reads become PNG before upload (src/lib/pasteFiles.ts
 * asPng): a BMP, an AVIF the picker gave no type, by their bytes; a JPEG,
 * PNG, GIF or WebP and other files stay as they are; a HEIC the page cannot
 * draw stays a HEIC (the composer and the hub then refuse it by name).
 *
 *   bun test packages/web/test/image-convert.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { asPng, pictureType } from '../src/lib/pasteFiles';

const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, document: g.document };
afterEach(() => Object.assign(g, saved));

/** A canvas that "encodes" to a PNG blob; drawn counts the pictures it drew. */
function fakeCanvas() {
  const drawn: unknown[] = [];
  Object.assign(g, {
    createImageBitmap: async (f: File) => (drawn.push(f), { width: 2, height: 3 }),
    document: { createElement: () => ({ getContext: () => ({ drawImage: () => undefined }), toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(['PNG'], { type })) }) },
  });
  return drawn;
}

const file = (parts: Array<string | number[]>, name: string, type = '') => new File(parts.map((p) => (typeof p === 'string' ? p : new Uint8Array(p))), name, { type });
const BMP = file(['BM', [0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0]], 'scan.bmp', 'image/bmp');
const AVIF = file([[0, 0, 0, 24], 'ftypavif', [0, 0, 0, 0], 'mif1miaf'], 'photo.avif');
const HEIC = file([[0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic'], 'IMG_0042.HEIC', 'image/heic');
const JPEG = file([[0xff, 0xd8, 0xff, 0xe0]], 'a.jpg', 'image/jpeg');

describe('a picture no model reads becomes PNG', () => {
  test('a BMP', async () => {
    fakeCanvas();
    const out = await asPng(BMP);
    expect([out.name, out.type]).toEqual(['scan.png', 'image/png']);
  });

  test('an AVIF the picker gave no type, by its bytes', async () => {
    fakeCanvas();
    expect(await pictureType(AVIF)).toBe('image/avif');
    const out = await asPng(AVIF);
    expect([out.name, out.type]).toEqual(['photo.png', 'image/png']);
  });

  test('a JPEG, or a text file, is never drawn', async () => {
    const drawn = fakeCanvas();
    const txt = file(['hello'], 'a.txt', 'text/plain');
    expect(await asPng(JPEG)).toBe(JPEG);
    expect(await asPng(txt)).toBe(txt);
    expect(drawn).toEqual([]);
  });

  test('a HEIC the page cannot draw stays a HEIC', async () => {
    Object.assign(g, { createImageBitmap: async () => Promise.reject(new Error('cannot decode')) });
    expect(await asPng(HEIC)).toBe(HEIC);
    expect(await pictureType(HEIC)).toBe('image/heic');
  });
});
