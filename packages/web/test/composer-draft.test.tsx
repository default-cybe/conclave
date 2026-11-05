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
import { readFileSync } from 'node:fs';
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
  /** What a composer's send does: drop the stored draft, empty the box. */
  send: () => void;
}

async function mount(kv: DraftKv, firstId = 's1') {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const h = {} as Handle;
  const Probe = ({ id }: { id: string }) => {
    const [text, setText] = useState('');
    const [files, setFiles] = useState<Attachment[]>([]);
    const clear = useDraft(id, text, files, (d) => {
      setText((t) => t || d.text);
      setFiles((f) => (f.length ? f : d.files));
    }, kv);
    const send = () => {
      clear();
      setText('');
      setFiles([]);
    };
    Object.assign(h, { text, files, setText, setFiles, send });
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
    /** The first send of a new chat from Home: the box clears and the page swaps it out in the same commit. */
    sendAndLeave: () =>
      act(async () => {
        h.send();
        root.render(null);
      }),
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

  test('a send that unmounts the composer in the same commit leaves no draft: the next new chat opens empty', async () => {
    const kv = memory();
    const v = await mount(kv, 'new');
    await Bun.sleep(10);
    await v.act(async () => {
      v.h.setText('first prompt');
      v.h.setFiles([file]);
    });
    await Bun.sleep(450);
    expect(kv.data.get('draft:new')).toBe('first prompt');
    // typed again within the delay, so a save is still waiting when the send goes
    await v.act(async () => v.h.setText('first prompt, edited'));
    await v.sendAndLeave();
    await Bun.sleep(450);
    expect(kv.data.has('draft:new')).toBe(false);
    expect(kv.data.has('draft:new:files')).toBe(false);
    expect(await loadDraft('new', kv)).toBeNull();
    await v.show('new');
    await Bun.sleep(10);
    expect(v.h.text).toBe('');
    expect(v.h.files).toEqual([]);
    await v.unmount();
  });

  test('a send that keeps the composer clears the draft, and a refused send that puts the text back keeps it again', async () => {
    const kv = memory();
    const v = await mount(kv, 'new');
    await Bun.sleep(10);
    await v.act(async () => v.h.setText('hello'));
    await v.act(async () => v.h.send());
    await Bun.sleep(450);
    expect(kv.data.has('draft:new')).toBe(false);
    await v.act(async () => v.h.setText('hello'));
    await Bun.sleep(450);
    expect(kv.data.get('draft:new')).toBe('hello');
    await v.unmount();
  });

  test("the chat composer's send drops the stored draft before it awaits the hub", () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/conversation/ChatComposer.tsx'), 'utf8');
    const send = src.slice(src.indexOf('const send = async'), src.indexOf('const stop = '));
    expect(src.includes('const clearDraft = useDraft(chatId,')).toBe(true);
    expect(send.indexOf('clearDraft();')).toBeGreaterThan(-1);
    expect(send.indexOf('clearDraft();')).toBeLessThan(send.indexOf('await '));
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
