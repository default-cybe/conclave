/**
 * PDFs a model API cannot open (attachments/pdf.ts): an encrypted one or a
 * file named .pdf that is something else is stored as its text, or a note,
 * when it is attached (attachments/prepare.ts), so it never lands in the
 * history as a PDF; the runner's recovery (session/bad-image.ts dropPdf)
 * replaces the one the API's error names.
 *
 *   bun test packages/core/test/attachments/pdf.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPdf, pdfAsText, pdfProblem, pdftotext } from '../../src/attachments/pdf';
import { prepareAttachments, type ZipHost } from '../../src/attachments/prepare';
import { dropPdf } from '../../src/session/bad-image';
import type { ContentBlock, Message } from '../../src/types';
import { b64, makePdf, unb64 } from './zipkit';

const host = (): ZipHost => ({ fileTools: () => false, save: async () => '', read: async () => Promise.reject(new Error('no device')) });
const VALID = makePdf('hello');
const LOCKED = makePdf('secret', ' /Encrypt 5 0 R');

describe('the cheap check', () => {
  test('a valid PDF passes, also with junk before its header; an encrypted one and a non-PDF do not', () => {
    expect(pdfProblem(VALID)).toBeUndefined();
    expect(pdfProblem(new Uint8Array([...Buffer.from('junk\n'), ...VALID]))).toBeUndefined();
    expect(pdfProblem(LOCKED)).toBe('encrypted');
    expect(pdfProblem(makePdf('x', ' /Encrypt << /Filter /Standard >>'))).toBe('encrypted');
    expect(pdfProblem(new Uint8Array(Buffer.from('<html><body>login</body></html>')))).toBe('not a PDF file');
    // the word in a text, not a dictionary entry
    expect(pdfProblem(makePdf('see /Encrypt docs'))).toBeUndefined();
  });
});

describe('at attach time', () => {
  test('an encrypted PDF and a non-PDF named .pdf are stored as text with a note; a valid PDF stays a PDF', async () => {
    const r = await prepareAttachments(
      [
        { mediaType: 'application/pdf', data: b64(LOCKED), name: 'locked.pdf' },
        { mediaType: 'application/pdf', data: b64(new Uint8Array([0, 1, 2, 3, 0xff, 0xfe, 0, 9])), name: 'fake.pdf' },
        { mediaType: 'application/pdf', data: b64(VALID), name: 'ok.pdf' },
      ],
      host(),
    );
    const [locked, fake, ok] = r.attachments!;
    expect(locked.mediaType).toBe('text/plain');
    expect(locked.name).toBe('locked.pdf');
    expect(unb64(locked.data!)).toStartWith('[locked.pdf could not be sent as a PDF (encrypted)');
    expect(fake.mediaType).toBe('text/plain');
    expect(unb64(fake.data!)).toBe('[fake.pdf could not be sent as a PDF (not a PDF file) and no text could be read from it]');
    expect(ok).toEqual({ mediaType: 'application/pdf', data: b64(VALID), name: 'ok.pdf' });
    expect(r.receipts.map((x) => x.parts)).toEqual([['text'], ['text'], ['pdf']]);
  });
});

describe('with pdftotext on the hub', () => {
  /** Runs `fn` with a fake pdftotext first on PATH that runs `script` after reading its stdin. */
  async function withFake<T>(script: string, fn: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'cv-pdftotext-'));
    writeFileSync(join(dir, 'pdftotext'), `#!/bin/sh\ncat >/dev/null\n${script}\n`);
    chmodSync(join(dir, 'pdftotext'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('an encrypted PDF it can read goes as its text after the note', async () => {
    const text = await withFake('echo "Invoice total 42"', () => pdfAsText('locked.pdf', LOCKED, 'encrypted'));
    expect(text).toBe('[locked.pdf could not be sent as a PDF (encrypted); its text follows]\nInvoice total 42');
  });

  test('a PDF it cannot open is damaged; output that never ends is cut, not held whole', async () => {
    expect(await withFake('exit 1', () => checkPdf(VALID))).toBe('damaged');
    expect(await withFake('exit 0', () => checkPdf(VALID))).toBeUndefined();
    const flood = await withFake('yes aaaaaaaaaaaaaaaaaaaa', () => pdftotext(VALID));
    expect(flood!.length).toBe(256 * 1024);
  });
});

describe('recovery picks the PDF the error names', () => {
  const doc = (title: string, data = VALID): ContentBlock => ({ type: 'document', mediaType: 'application/pdf', data: b64(data), title });
  const msg = (id: string, content: ContentBlock[]): Message => ({ id, role: 'user', content }) as Message;

  test('the PDF with the named bytes, not the newest; unknown bytes fall back to the newest; one per call, then none', async () => {
    const ONE = makePdf('one');
    const stored = [msg('a', [{ type: 'text', text: 'q' }, doc('one.pdf', ONE), doc('two.pdf')]), msg('b', [{ type: 'text', text: 'later' }])];
    const update = (id: string, content: ContentBlock[]) => {
      stored.find((m) => m.id === id)!.content = content;
    };
    expect(await dropPdf(stored, update, b64(ONE))).toBe('one.pdf');
    expect(stored[0].content[1].type).toBe('text');
    expect((stored[0].content[1] as { text: string }).text).toStartWith('[one.pdf could not be sent as a PDF (the model could not open it)');
    expect(stored[0].content[2]).toEqual(doc('two.pdf'));
    expect(await dropPdf(stored, update, b64(ONE))).toBe('two.pdf');
    expect(await dropPdf(stored, update)).toBeUndefined();
  });
});
