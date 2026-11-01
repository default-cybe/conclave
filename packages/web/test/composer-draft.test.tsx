/**
 * A composer draft, text and attached files, comes back after a reload
 * (src/features/chat/draft.ts, useDraft.ts): nothing is written before the
 * stored draft has loaded, typing never rewrites the files, a chat switch or
 * a hidden page saves the last edit, an emptied draft is removed, and a
 * write that fails shows a toast.
 *
 *   bun test packages/web/test/composer-draft.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { useState } from 'react';
import type { Attachment } from '@conclave/core/client';
import { dropDraft, loadDraft, saveFiles, saveText, type DraftKv } from '../src/features/chat/draft';
import { useDraft } from '../src/features/chat/useDraft';
import { useHub } from '../src/store/store';

function memory(opts: { slowGet?: Promise<void>; fail?: boolean } = {}): DraftKv & { data: Map<string, unknown>; sets: string[] } {
  const data = new Map<string, unknown>();
  const sets: string[] = [];
  return {
    data,
    sets,
    get: async (k) => {
      await opts.slowGet;
      return data.get(k);
    },
    set: async (k, v) => {
      if (opts.fail) throw new Error('QuotaExceededError');
      sets.push(k);
      if (v === null) data.delete(k);
      else data.set(k, v);
    },
  };
}

const file: Attachment = { mediaType: 'application/pdf', data: 'JVBERi0=', name: 'a.pdf' };

describe('draft storage', () => {
  test('text and files sit under their own keys and come back per chat', async () => {
    const kv = memory();
    await saveText('s1', 'see these', kv);
    await saveFiles('s1', [file, { ...file, name: 'b.pdf' }], kv);
    expect([...kv.data.keys()].sort()).toEqual(['draft:s1', 'draft:s1:files']);
    expect(await loadDraft('s1', kv)).toEqual({ text: 'see these', files: [file, { ...file, name: 'b.pdf' }] });
    expect(await loadDraft('s2', kv)).toBeNull();
  });

  test('an emptied part, and a deleted chat, leave no key', async () => {
    const kv = memory();
    await saveText('s1', 'x', kv);
    await saveFiles('s1', [file], kv);
    await saveText('s1', '', kv);
    await saveFiles('s1', [], kv);
    expect(kv.data.size).toBe(0);
    await saveText('s2', 'x', kv);
    await saveFiles('s2', [file], kv);
    await dropDraft('s2', kv);
    expect(kv.data.size).toBe(0);
  });

  test('a damaged record is ignored, a file without data is dropped', async () => {
    const kv = memory();
    kv.data.set('draft:s1', 7);
    kv.data.set('draft:s1:files', 'junk');
    expect(await loadDraft('s1', kv)).toBeNull();
    kv.data.set('draft:s1:files', [file, { mediaType: 'x/y' }, null]);
    expect((await loadDraft('s1', kv))?.files).toEqual([file]);
  });
});

// ---------------------------------------------------------------------------
// The hook, in a DOM
// ---------------------------------------------------------------------------

const GLOBALS = ['window', 'document'];
const saved: Record<string, unknown> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;

beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  g.window = win;
  g.document = dom.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  delete g.IS_REACT_ACT_ENVIRONMENT;
});

interface Handle {
  text: string;
  files: Attachment[];
  setText: (t: string) => void;
  setFiles: (f: Attachment[]) => void;
}

async function mount(kv: DraftKv, firstId = 's1') {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const h = {} as Handle;
  const Probe = ({ id }: { id: string }) => {
    const [text, setText] = useState('');
    const [files, setFiles] = useState<Attachment[]>([]);
    useDraft(id, text, files, (d) => {
      setText((t) => t || d.text);
      setFiles((f) => (f.length ? f : d.files));
    }, kv);
    Object.assign(h, { text, files, setText, setFiles });
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const show = (id: string) => act(async () => root.render(<Probe id={id} />));
  await show(firstId);
  return {
    h,
    show,
    act,
    unmount: () => act(async () => root.unmount()),
  };
}

describe('the composer draft', () => {
  test('nothing is written before the stored draft has loaded, and what was typed wins the merge', async () => {
    let open!: () => void;
    const kv = memory({ slowGet: new Promise<void>((r) => (open = r)) });
    kv.data.set('draft:s1', 'old text');
    kv.data.set('draft:s1:files', [file]);
    const v = await mount(kv);
    await v.act(async () => v.h.setText('typed first'));
    await Bun.sleep(450);
    expect(kv.sets).toEqual([]);
    await v.act(async () => open());
    await Bun.sleep(450);
    expect(v.h.text).toBe('typed first');
    expect(v.h.files).toEqual([file]);
    expect(kv.data.get('draft:s1')).toBe('typed first');
    // the files came from storage: loading does not write them back
    expect(kv.sets).not.toContain('draft:s1:files');
    await v.unmount();
  });

  test('typing is debounced and never rewrites the files', async () => {
    const kv = memory();
    const v = await mount(kv);
    await Bun.sleep(10);
    await v.act(async () => v.h.setFiles([file]));
    for (const t of ['h', 'he', 'hel', 'hell', 'hello']) await v.act(async () => v.h.setText(t));
    await Bun.sleep(450);
    expect(kv.sets.filter((k) => k === 'draft:s1:files')).toHaveLength(1);
    expect(kv.sets.filter((k) => k === 'draft:s1')).toEqual(['draft:s1']);
    expect(kv.data.get('draft:s1')).toBe('hello');
    await v.unmount();
  });

  test('a chat switch within the delay saves the old chat, files included', async () => {
    const kv = memory();
    const v = await mount(kv);
    await Bun.sleep(10);
    await v.act(async () => v.h.setFiles([file]));
    await v.act(async () => v.h.setText('last words'));
    await v.show('s2');
    await Bun.sleep(10);
    expect(kv.data.get('draft:s1')).toBe('last words');
    expect(kv.data.get('draft:s1:files')).toEqual([file]);
    expect(kv.data.has('draft:s2')).toBe(false);
    await v.unmount();
  });

  test('a hidden page saves the last edit at once', async () => {
    const kv = memory();
    const v = await mount(kv);
    await Bun.sleep(10);
    await v.act(async () => v.h.setText('edit'));
    win.dispatchEvent(new win.Event('pagehide'));
    await Bun.sleep(10);
    expect(kv.data.get('draft:s1')).toBe('edit');
    await v.unmount();
  });

  test('a sent draft (text and files cleared) is removed; a failed send puts it back and it is kept again', async () => {
    const kv = memory();
    const v = await mount(kv);
    await Bun.sleep(10);
    await v.act(async () => {
      v.h.setText('hi');
      v.h.setFiles([file]);
    });
    await Bun.sleep(450);
    expect(kv.data.size).toBe(2);
    await v.act(async () => {
      v.h.setText('');
      v.h.setFiles([]);
    });
    await Bun.sleep(450);
    expect(kv.data.size).toBe(0);
    await v.act(async () => {
      v.h.setText('hi');
      v.h.setFiles([file]);
    });
    await Bun.sleep(450);
    expect(kv.data.size).toBe(2);
    await v.unmount();
  });

  test('a write that fails shows a toast', async () => {
    const kv = memory({ fail: true });
    const v = await mount(kv);
    await Bun.sleep(10);
    await v.act(async () => v.h.setFiles([file]));
    await Bun.sleep(10);
    expect(useHub.getState().toasts.some((t) => t.title === 'Draft not kept')).toBe(true);
    await v.unmount();
  });
});
