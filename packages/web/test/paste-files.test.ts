/**
 * Files pasted into a message box (src/lib/pasteFiles.ts): files, file items
 * only, a TIFF turned into a PNG, and in the macOS desktop app a paste the
 * webview handed over empty, read through paste_files (a picture, or a file
 * copied in Finder read through read_dropped). Plain text still pastes.
 *
 *   bun test packages/web/test/paste-files.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { asPng, mayHoldFiles, onPasteFiles, pasteApp } from '../src/lib/pasteFiles';
import type { Desktop } from '../src/overlay/desktop';

const png = new File(['png'], 'image.png', { type: 'image/png' });
const tiff = new File(['tiff'], 'image.tiff', { type: 'image/tiff' });
const item = (f: File | null, kind = 'file') => ({ kind, type: f?.type ?? 'text/plain', getAsFile: () => f }) as unknown as DataTransferItem;
const clip = (o: { types?: string[]; files?: File[]; items?: DataTransferItem[]; text?: string }) =>
  ({ types: o.types ?? [], files: o.files ?? [], items: o.items ?? [], getData: (t: string) => (t === 'text/plain' ? (o.text ?? '') : '') }) as unknown as DataTransfer;

const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, document: g.document };
afterEach(() => Object.assign(g, saved));

/** A canvas that "encodes" to a PNG blob, and records insertText. */
function fakeDom() {
  const inserted: string[] = [];
  Object.assign(g, {
    createImageBitmap: async () => ({ width: 2, height: 3 }),
    document: {
      createElement: () => ({ getContext: () => ({ drawImage: () => undefined }), toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(['PNG'], { type })) }),
      execCommand: (_: string, __: boolean, text: string) => void inserted.push(text),
    },
  });
  return inserted;
}

function paste(dt: DataTransfer, app?: Desktop) {
  let prevented = false;
  const got: File[][] = [];
  onPasteFiles({ clipboardData: dt, preventDefault: () => void (prevented = true), currentTarget: { focus: () => undefined } as unknown as EventTarget }, (f) => void got.push(f), app);
  return { prevented: () => prevented, got, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

function app(answer: unknown, files: Record<string, string> = {}): Desktop & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      asked.push(cmd);
      if (cmd === 'paste_files') return answer;
      return new TextEncoder().encode(files[String(args?.path)]).buffer;
    }) as Desktop['invoke'],
    listen: (async () => () => undefined) as Desktop['listen'],
  };
}

describe('the paste carries the file', () => {
  test('clipboardData.files', async () => {
    const p = paste(clip({ types: ['Files'], files: [png] }));
    expect(p.prevented()).toBe(true);
    await p.settle();
    expect(p.got).toEqual([[png]]);
  });

  test('items only, with files empty (WKWebView)', async () => {
    const p = paste(clip({ types: ['image/png'], items: [item(png)] }));
    expect(p.prevented()).toBe(true);
    await p.settle();
    expect(p.got[0].map((f) => f.name)).toEqual(['image.png']);
  });

  test('a TIFF (Preview, Photos) becomes a PNG', async () => {
    fakeDom();
    const p = paste(clip({ types: ['image/tiff'], items: [item(tiff)] }));
    await p.settle();
    expect(p.got[0].map((f) => [f.name, f.type])).toEqual([['image.png', 'image/png']]);
  });

  test('a TIFF the page cannot draw stays a TIFF', async () => {
    Object.assign(g, { createImageBitmap: async () => Promise.reject(new Error('no')) });
    expect(await asPng(tiff)).toBe(tiff);
    expect(await asPng(png)).toBe(png);
  });

  test('plain text pastes as text and asks the app nothing', () => {
    const a = app({});
    const p = paste(clip({ types: ['text/plain'], items: [item(null, 'string')], text: 'hi' }), a);
    expect(p.prevented()).toBe(false);
    expect(a.asked).toEqual([]);
    expect(mayHoldFiles(clip({ types: ['text/plain', 'text/uri-list'] }))).toBe(true);
  });

  test('no desktop app: an empty paste is left alone', () => {
    const p = paste(clip({ types: [] }));
    expect(p.prevented()).toBe(false);
  });
});

describe('the paste came empty: the macOS app reads the clipboard', () => {
  test('a screenshot comes back as a picture', async () => {
    const a = app({ paths: [], image: btoa('PNGDATA'), mime: 'image/png' });
    const p = paste(clip({ types: [] }), a);
    expect(p.prevented()).toBe(true);
    await p.settle();
    await p.settle();
    expect(a.asked).toEqual(['paste_files']);
    expect(p.got[0].map((f) => [f.name, f.type, f.size])).toEqual([['pasted.png', 'image/png', 7]]);
  });

  test('a file copied in Finder is read through read_dropped, and its name is not pasted as text', async () => {
    const inserted = fakeDom();
    const a = app({ paths: ['/Users/me/report.pdf'], image: null, mime: null }, { '/Users/me/report.pdf': '%PDF' });
    const p = paste(clip({ types: ['text/plain', 'Files'], text: 'report.pdf' }), a);
    expect(p.prevented()).toBe(true);
    await p.settle();
    await p.settle();
    expect(a.asked).toEqual(['paste_files', 'read_dropped']);
    expect(p.got[0].map((f) => [f.name, f.type])).toEqual([['report.pdf', 'application/pdf']]);
    expect(inserted).toEqual([]);
  });

  test('nothing on the clipboard to attach: the text is pasted after all', async () => {
    const inserted = fakeDom();
    const p = paste(clip({ types: ['text/plain', 'text/uri-list'], text: 'https://x.dev' }), app({ paths: [], image: null, mime: null }));
    await p.settle();
    await p.settle();
    expect(p.got).toEqual([]);
    expect(inserted).toEqual(['https://x.dev']);
  });

  test('the Linux app is asked too (WebKitGTK hands a screenshot over empty); Windows and Android are not', () => {
    const invoke = (async () => undefined) as Desktop['invoke'];
    const before = g.window;
    g.window = { __TAURI_INTERNALS__: { invoke } };
    try {
      expect(pasteApp('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')?.invoke).toBe(invoke);
      expect(pasteApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15')?.invoke).toBe(invoke);
      expect(pasteApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130.0')).toBeUndefined();
      expect(pasteApp('Mozilla/5.0 (Linux; Android 15; Pixel 8a) Chrome/130.0')).toBeUndefined();
    } finally {
      g.window = before;
    }
  });

  test('an older app without paste_files: the text is pasted', async () => {
    const inserted = fakeDom();
    const old = { invoke: (async () => Promise.reject('unknown command')) as Desktop['invoke'], listen: (async () => () => undefined) as Desktop['listen'] };
    const p = paste(clip({ types: ['text/plain', 'Files'], text: 'a.txt' }), old);
    await p.settle();
    await p.settle();
    expect(inserted).toEqual(['a.txt']);
  });
});
