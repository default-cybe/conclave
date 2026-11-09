/**
 * Pictures checked by their bytes (attachments/image.ts): each format's magic
 * bytes, a declared type the bytes contradict corrected on attach, a HEIC
 * refused with the reason, an unreadable picture left out of a request
 * (providers/common.ts documentsForWire), and the API's "Could not process
 * image" classified so the runner can recover (providers/errors.ts).
 *
 *   bun test packages/core/test/attachments/image.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { checkPicture, sniffImageType, unreadablePicture } from '../../src/attachments/image';
import { prepareAttachments, type ZipHost } from '../../src/attachments/prepare';
import { documentsForWire } from '../../src/providers/common';
import { classifyHttpError, classifyStreamError, isUnreadableImageError } from '../../src/providers/errors';
import type { ContentBlock } from '../../src/types';
import { PNG, b64 } from './zipkit';

const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
/** An ISO media file's first box: size, ftyp, major brand, minor version, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => bytes([0, 0, 0, 16 + 4 * compatible.length], 'ftyp', major, [0, 0, 0, 0], compatible.join(''), [0, 0, 0, 8], 'meta');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], 'JFIF');
const HEIC = ftyp('heic', 'mif1', 'heic');

const host = (): ZipHost => ({ fileTools: () => false, save: async () => '', read: async () => Promise.reject(new Error('no device')) });

describe('sniffing', () => {
  test.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF87a', bytes('GIF87a', [1, 0, 1, 0]), 'image/gif'],
    ['GIF89a', bytes('GIF89a', [1, 0, 1, 0]), 'image/gif'],
    ['WebP', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
    ['TIFF little-endian', bytes('II*', [0, 8, 0, 0, 0]), 'image/tiff'],
    ['TIFF big-endian', bytes('MM', [0, 0x2a, 0, 0, 0, 8]), 'image/tiff'],
    ['BMP', bytes('BM', [0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0]), 'image/bmp'],
    ['HEIC', HEIC, 'image/heic'],
    ['HEIC heix', ftyp('heix', 'mif1'), 'image/heic'],
    ['HEIF mif1', ftyp('mif1', 'miaf'), 'image/heif'],
    ['HEIF msf1', ftyp('msf1'), 'image/heif'],
    ['HEIC behind mif1', ftyp('mif1', 'heic'), 'image/heic'],
    ['AVIF', ftyp('avif', 'mif1', 'miaf'), 'image/avif'],
    ['AVIF behind mif1', ftyp('mif1', 'avif'), 'image/avif'],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    ['SVG with a prolog', bytes([0xef, 0xbb, 0xbf], '<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg width="1">'), 'image/svg+xml'],
  ] as Array<[string, Uint8Array, string]>)('%s', (_, b, type) => {
    expect(sniffImageType(b)).toBe(type);
  });

  test('not pictures: text, a video ftyp, "BM" text, a short file, HTML', () => {
    for (const b of [bytes('hello'), ftyp('isom', 'mp41'), bytes('BMW is a car maker, not a bitmap at all'), bytes([0x89, 0x50]), bytes('<!doctype html><html>'), bytes('<!--' + '--><!--'.repeat(100)), bytes('<?xml version="1.0"'), new Uint8Array()]) expect(sniffImageType(b)).toBeUndefined();
  });
});

describe('on attach', () => {
  test('a declared type the bytes contradict is corrected', async () => {
    expect(checkPicture(JPEG, 'image/png', 'a.png')).toEqual({ mediaType: 'image/jpeg' });
    expect(checkPicture(PNG, 'application/octet-stream', 'shot')).toEqual({ mediaType: 'image/png' });
    expect(checkPicture(bytes('# notes'), 'text/markdown', 'a.md')).toEqual({ mediaType: 'text/markdown' });
    const r = await prepareAttachments([{ mediaType: 'image/png', data: b64(JPEG), name: 'photo.png' }], host());
    expect(r.attachments?.[0].mediaType).toBe('image/jpeg');
    expect(r.receipts[0].parts).toEqual(['image']);
  });

  test('a HEIC is refused with the reason, even sent as image/jpeg or with no type', async () => {
    const line = "IMG_0042.heic is a HEIC picture, which models can't read. Save it as PNG or JPEG and attach it again.";
    expect(unreadablePicture('IMG_0042.heic', 'image/heic')).toBe(line);
    for (const mediaType of ['image/heic', 'image/jpeg', '']) {
      const err = await prepareAttachments([{ mediaType, data: b64(HEIC), name: 'IMG_0042.heic' }], host()).catch((e: Error & { status?: number }) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(line);
      expect((err as { status?: number }).status).toBe(400);
    }
    expect(unreadablePicture('a.avif', 'image/avif')).toStartWith('a.avif is an AVIF picture');
  });

  test('a file that claims to be a picture but is none is refused; an SVG goes as its text', async () => {
    expect(checkPicture(bytes('<!doctype html>'), 'image/png', 'x.png')).toEqual({ refused: "x.png is not a PNG, JPEG, GIF or WebP picture, so models can't read it. Save it as PNG or JPEG and attach it again." });
    expect(checkPicture(bytes('<svg>'), 'image/svg+xml', 'logo.svg')).toEqual({ mediaType: 'image/svg+xml' });
    const r = await prepareAttachments([{ mediaType: 'image/svg+xml', data: b64(bytes('<svg/>')), name: 'logo.svg' }], host());
    expect(r.receipts[0].parts).toEqual(['text']);
  });
});

describe('before sending', () => {
  test('an image whose bytes no model reads becomes a note, in a message and in a tool result; a wrong type is corrected', () => {
    const content: ContentBlock[] = [
      { type: 'image', mediaType: 'image/jpeg', data: b64(HEIC) },
      { type: 'image', mediaType: 'image/png', data: b64(JPEG) },
      { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'Image a.bmp' }, { type: 'image', mediaType: 'image/png', data: b64(bytes('<html>oops</html>')) }] },
    ];
    const out = documentsForWire(content, true);
    expect(out[0]).toEqual({ type: 'text', text: '[image (image/heic) left out: not a format the model can read]' });
    expect(out[1]).toEqual({ type: 'image', mediaType: 'image/jpeg', data: b64(JPEG) });
    expect((out[2] as { content: ContentBlock[] }).content[1]).toEqual({ type: 'text', text: '[image (image/png) left out: not a format the model can read]' });
    // a good image is passed through as it was
    const good: ContentBlock = { type: 'image', mediaType: 'image/png', data: b64(PNG) };
    expect(documentsForWire([good], true)[0]).toBe(good);
  });
});

describe('the API could not read a picture', () => {
  test('Anthropic and OpenAI say so: a bad request marked image_unreadable, not a limit or a server error', () => {
    const anthropic = classifyHttpError('cliproxy', 400, undefined, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Could not process image' } }));
    expect(anthropic.kind).toBe('bad_request');
    expect(isUnreadableImageError(anthropic)).toBe(true);
    const openai = classifyHttpError('openai', 400, undefined, JSON.stringify({ error: { message: 'Invalid image.', type: 'invalid_request_error', code: 'invalid_image' } }));
    expect(isUnreadableImageError(openai)).toBe(true);
    // mid-stream, an unknown code would map to 500 (a server error, retried): this one is the request's fault
    const stream = classifyStreamError('openai', { code: 'image_parse_error', message: 'Unable to parse image' });
    expect(stream.kind).toBe('bad_request');
    expect(isUnreadableImageError(stream)).toBe(true);
    expect(isUnreadableImageError(classifyHttpError('cliproxy', 400, undefined, JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens too large' } })))).toBe(false);
  });
});
