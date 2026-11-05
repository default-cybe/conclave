/**
 * Files dropped on the page (src/lib/fileDrop.ts): a drop with files and one
 * with file items only both attach, dragenter accepts a file drag (WebKit asks
 * only dragenter when the pointer moves onto a new element), and in the Linux
 * desktop app a drop the app took is read through read_dropped and dropped
 * on the page where the pointer was.
 *
 *   bun test packages/web/test/file-drop.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { acceptFileDrag, carriesFiles, droppedFiles, installDesktopDrop, readDropped } from '../src/lib/fileDrop';
import type { Desktop } from '../src/overlay/desktop';

const note = new File(['hello'], 'note.txt', { type: 'text/plain' });
const item = (f: File | null, kind = 'file') => ({ kind, type: f?.type ?? 'text/uri-list', getAsFile: () => f }) as unknown as DataTransferItem;
const transfer = (o: { types?: string[]; files?: File[]; items?: DataTransferItem[] }) => ({ types: o.types ?? [], files: o.files ?? [], items: o.items ?? [] }) as unknown as DataTransfer;

describe('a drop with files', () => {
  test('dataTransfer.files', () => {
    const dt = transfer({ types: ['Files'], files: [note] });
    expect(carriesFiles(dt)).toBe(true);
    expect(droppedFiles(dt)).toEqual([note]);
  });

  test('file items only, with files empty', () => {
    const dt = transfer({ items: [item(note), item(null, 'string')] });
    expect(carriesFiles(dt)).toBe(true);
    expect(droppedFiles(dt).map((f) => f.name)).toEqual(['note.txt']);
  });

  test('a link or text is not a file drag', () => {
    const dt = transfer({ types: ['text/uri-list', 'text/plain'], items: [item(null, 'string')] });
    expect(carriesFiles(dt)).toBe(false);
    expect(droppedFiles(dt)).toEqual([]);
    expect(droppedFiles(null)).toEqual([]);
  });

  test('dragenter and dragover accept a file drag, and only that', () => {
    let prevented = 0;
    const e = (dt: DataTransfer) => ({ dataTransfer: dt, preventDefault: () => void prevented++ });
    expect(acceptFileDrag(e(transfer({ types: ['Files'] })))).toBe(true);
    expect(acceptFileDrag(e(transfer({ items: [item(note)] })))).toBe(true);
    expect(acceptFileDrag(e(transfer({ types: ['text/plain'] })))).toBe(false);
    expect(prevented).toBe(2);
  });
});

describe('the desktop app takes the drop (Linux)', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { DataTransfer: g.DataTransfer, DragEvent: g.DragEvent, document: g.document };
  afterEach(() => Object.assign(g, saved));

  const app = (files: Record<string, string>, listeners: Record<string, (e: { payload: unknown }) => void> = {}): Desktop & { asked: unknown[] } => {
    const asked: unknown[] = [];
    return {
      asked,
      invoke: (async (cmd: string, args?: Record<string, unknown>) => {
        asked.push([cmd, args]);
        const path = String(args?.path);
        if (!(path in files)) throw `${path.split('/').pop()} was not dropped`;
        return new TextEncoder().encode(files[path]).buffer;
      }) as Desktop['invoke'],
      listen: (async (event: string, cb: (e: { payload: unknown }) => void) => {
        listeners[event] = cb;
        return () => undefined;
      }) as Desktop['listen'],
    };
  };

  test('reads each path through read_dropped, with its name and type', async () => {
    const a = app({ '/home/me/shot.png': 'png', '/home/me/notes.md': '# hi' });
    const files = await readDropped(['/home/me/shot.png', '/home/me/notes.md', '/home/me/gone.txt'], a);
    expect(a.asked).toEqual([
      ['read_dropped', { path: '/home/me/shot.png' }],
      ['read_dropped', { path: '/home/me/notes.md' }],
      ['read_dropped', { path: '/home/me/gone.txt' }],
    ]);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['shot.png', 'image/png', 3],
      ['notes.md', 'text/markdown', 4],
    ]);
  });

  test('tauri://drag-drop becomes a drop event at the pointer with the files', async () => {
    class FakeTransfer {
      list: File[] = [];
      items = { add: (f: File) => void this.list.push(f) };
    }
    class FakeDrag {
      constructor(
        public type: string,
        public init: { dataTransfer: FakeTransfer; bubbles: boolean },
      ) {}
    }
    const got: FakeDrag[] = [];
    const at: number[][] = [];
    const zone = { dispatchEvent: (e: FakeDrag) => void got.push(e) };
    Object.assign(g, { DataTransfer: FakeTransfer, DragEvent: FakeDrag, document: { body: {}, elementFromPoint: (x: number, y: number) => (at.push([x, y]), zone) } });
    const listeners: Record<string, (e: { payload: unknown }) => void> = {};
    await installDesktopDrop(app({ '/tmp/a.txt': 'abc' }, listeners));
    listeners['tauri://drag-drop']({ payload: { paths: ['/tmp/a.txt'], position: { x: 40, y: 300 } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(at).toEqual([[40, 300]]);
    expect(got.length).toBe(1);
    expect(got[0].type).toBe('drop');
    expect(got[0].init.bubbles).toBe(true);
    expect(got[0].init.dataTransfer.list.map((f) => f.name)).toEqual(['a.txt']);
  });

  test('no desktop app: nothing listens', async () => {
    await installDesktopDrop(undefined);
  });
});
