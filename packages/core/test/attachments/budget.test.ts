/**
 * Any file in a message (attachments/budget.ts, prepare.ts): what the model
 * gets inline under its budget, what is saved with one note, and what a
 * file is by its first bytes.
 *
 *   bun test packages/core/test/attachments/budget.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Attachment } from '../../src/client/index';
import { budgetFor, BUDGET_BYTES, IMAGE_TOKENS, sniffFile, splitBudget } from '../../src/attachments/budget';
import { prepareAttachments, SAVED_NOTE, SAVED_ON_HUB_NOTE, type ZipHost } from '../../src/attachments/prepare';
import { b64, PNG, unb64 } from './zipkit';

const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
const tar = () => {
  const b = new Uint8Array(1024);
  b.set(Buffer.from('ustar'), 257);
  return b;
};

describe('a file by its first bytes', () => {
  test('APK, JAR, zip, ELF, PE, SQLite, gzip, tar, PDF, PNG, text, binary', () => {
    const pk = bytes('PK\u0003\u0004', [20, 0], 'AndroidManifest.xml');
    expect(sniffFile(pk, 'app.bin', '')).toEqual({ label: 'APK' });
    expect(sniffFile(bytes('PK\u0003\u0004'), 'app.apk', '')).toEqual({ label: 'APK' });
    expect(sniffFile(bytes('PK\u0003\u0004'), 'lib.jar', '')).toEqual({ label: 'JAR' });
    expect(sniffFile(bytes('PK\u0003\u0004'), 'a.zip', '')).toEqual({ label: 'zip' });
    expect(sniffFile(bytes('\u007fELF', [2, 1, 1]), 'tool', '')).toEqual({ label: 'ELF' });
    expect(sniffFile(bytes('MZ', [0x90, 0]), 'setup.exe', '')).toEqual({ label: 'PE (.exe)' });
    expect(sniffFile(bytes('SQLite format 3\u0000'), 'app.db', '')).toEqual({ label: 'SQLite' });
    expect(sniffFile(bytes([0x1f, 0x8b, 8]), 'a.tar.gz', '')).toEqual({ label: 'gzip' });
    expect(sniffFile(tar(), 'a.tar', '')).toEqual({ label: 'tar' });
    expect(sniffFile(bytes('%PDF-1.7'), 'x', '')).toEqual({ label: 'PDF', part: 'pdf' });
    expect(sniffFile(PNG, 'p', '')).toEqual({ label: 'PNG', part: 'image' });
    expect(sniffFile(bytes('fn main() {}\n'), 'main.rs', '')).toEqual({ label: 'text', part: 'text' });
    expect(sniffFile(bytes([1, 2, 0, 0xff]), 'blob.dat', '')).toEqual({ label: '.dat file' });
  });
});

describe('the budget', () => {
  test('pictures and text first, then PDFs, each in the order picked; the same split every time', () => {
    const items = [
      { part: 'pdf' as const, size: 8 * 1024 * 1024 },
      { part: 'image' as const, size: 6 * 1024 * 1024 },
      { size: 1000 },
      { part: 'text' as const, size: 10_000 },
      { part: 'image' as const, size: 6 * 1024 * 1024 },
      { part: 'pdf' as const, size: 1024 * 1024 },
    ];
    const budget = { bytes: BUDGET_BYTES, tokens: 1_000_000 };
    // two 6 MB pictures are 16 MB as base64; the 8 MB PDF no longer fits, the 1 MB one does; the binary is never inline
    expect([...splitBudget(items, budget)].sort()).toEqual([1, 3, 4, 5]);
    expect([...splitBudget(items, budget)].sort()).toEqual([1, 3, 4, 5]);
  });

  test("a share of the model's context window, and text under the wire's own caps", () => {
    const small = budgetFor(8_000);
    expect(small.tokens).toBe(3_200);
    // two pictures fit 3,200 tokens, a third does not
    expect([...splitBudget([{ part: 'image', size: 10 }, { part: 'image', size: 10 }, { part: 'image', size: 10 }], small)]).toEqual([0, 1]);
    expect(IMAGE_TOKENS * 2).toBeLessThanOrEqual(small.tokens);
    // one text file over 200 KB is saved, not cut
    expect([...splitBudget([{ part: 'text', size: 300 * 1024 }, { part: 'text', size: 1024 }], budgetFor(1_000_000))]).toEqual([1]);
  });
});

const host = (tools: boolean, over: Partial<ZipHost> = {}): ZipHost & { kept: string[] } => {
  const kept: string[] = [];
  return {
    kept,
    fileTools: () => tools,
    save: async (name) => `/work/app/uploads/${name}`,
    read: async () => {
      throw new Error('no device');
    },
    keep: async (name) => {
      kept.push(name);
      return tools ? `/work/app/uploads/${name}` : `/hub/outputs/s1/uploads/${name}`;
    },
    ...over,
  };
};

const file = (name: string, data: Uint8Array, mediaType = 'application/octet-stream'): Attachment => ({ name, mediaType, data: b64(data) });

describe('saved files and the note', () => {
  test('a Code session: an APK, an ELF and a SQLite file are saved, and the model gets one note with path, type and size', async () => {
    const list = [file('notes.txt', bytes('hello'), 'text/plain'), file('app.apk', bytes('PK\u0003\u0004', new Array(100).fill(0))), file('tool', bytes('\u007fELF', new Array(60).fill(0))), file('app.db', bytes('SQLite format 3\u0000'))];
    const h = host(true);
    const out = await prepareAttachments(list, h);
    expect(h.kept).toEqual(['app.apk', 'tool', 'app.db']);
    expect(out.attachments!.length).toBe(2);
    expect(out.attachments![0]).toBe(list[0]);
    expect(unb64(out.attachments![1].data!)).toBe(`${SAVED_NOTE}\n- /work/app/uploads/app.apk (APK, 104 bytes)\n- /work/app/uploads/tool (ELF, 64 bytes)\n- /work/app/uploads/app.db (SQLite, 16 bytes)`);
    expect(out.receipts.map((r) => [r.name, r.saved ?? 'sent', r.savedOn])).toEqual([
      ['notes.txt', 'sent', undefined],
      ['app.apk', '/work/app/uploads/app.apk', 'session'],
      ['tool', '/work/app/uploads/tool', 'session'],
      ['app.db', '/work/app/uploads/app.db', 'session'],
    ]);
  });

  test('a chat: saved on the hub, and the note says Chat cannot open it', async () => {
    const out = await prepareAttachments([file('app.apk', bytes('PK\u0003\u0004'))], host(false));
    expect(unb64(out.attachments![0].data!)).toBe(`${SAVED_ON_HUB_NOTE}\n- app.apk (APK, 4 bytes)`);
    expect(out.receipts[0]).toMatchObject({ name: 'app.apk', saved: '/hub/outputs/s1/uploads/app.apk', savedOn: 'hub' });
  });

  test('past the budget: pictures go inline until it is spent, the rest is saved in order', async () => {
    const pics = Array.from({ length: 5 }, (_, i) => file(`p${i}.png`, PNG, 'image/png'));
    const h = host(true, { budget: () => ({ bytes: 1 << 30, tokens: IMAGE_TOKENS * 3 }) });
    const out = await prepareAttachments(pics, h);
    expect(out.receipts.map((r) => (r.saved ? 'saved' : 'sent'))).toEqual(['sent', 'sent', 'sent', 'saved', 'saved']);
    expect(h.kept).toEqual(['p3.png', 'p4.png']);
  });

  test('40 files in one message', async () => {
    const list = Array.from({ length: 40 }, (_, i) => file(i % 2 ? `f${i}.bin` : `f${i}.txt`, i % 2 ? bytes([0, 1, 2]) : bytes(`${i}`), i % 2 ? 'application/octet-stream' : 'text/plain'));
    const out = await prepareAttachments(list, host(true));
    expect(out.receipts.length).toBe(40);
    expect(out.receipts.filter((r) => r.saved).length).toBe(20);
    expect(out.attachments!.length).toBe(21);
  });

  test('a name with folder parts or control characters is refused, inline too', async () => {
    for (const name of ['../../.ssh/authorized_keys', '/etc/passwd', 'a\\b', '..', 'x\u0000y']) {
      await expect(prepareAttachments([file(name, bytes('x'), 'text/plain')], host(true))).rejects.toThrow();
    }
  });

  test('a device that cannot take a saved file loses it by name, so the sender chooses', async () => {
    const h = host(true, {
      keep: async () => {
        throw new Error('device offline');
      },
    });
    const out = await prepareAttachments([file('tool', bytes('\u007fELF'))], h);
    expect(out.lost).toEqual(['tool']);
    expect(out.receipts[0]).toMatchObject({ state: 'omitted', reason: 'could not be saved: device offline' });
  });
});
