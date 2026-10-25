/**
 * Keeps a composer's draft (draft.ts) in step with its state: the stored
 * draft comes back through `restore` when the chat opens, the text is saved
 * 400ms after typing stops (and at once on a chat switch, unmount, hidden
 * page), the files only when they change. Nothing is written before the load
 * has finished. A write that fails shows a toast.
 */
import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@conclave/core/client';
import { toast } from '@/store/store';
import { loadDraft, saveFiles, saveText, type Draft, type DraftKv } from './draft';

const kept = (p: Promise<unknown>) =>
  void p.catch(() => toast({ id: 'draft-not-kept', level: 'error', title: 'Draft not kept', body: 'This browser could not store it (too big, or storage is full). Send it before you close the app.' }));

export function useDraft<F extends Attachment>(id: string, text: string, files: F[], restore: (d: Draft<F>) => void, kv?: DraftKv) {
  const loaded = useRef<string | null>(null);
  const [loads, setLoads] = useState(0);
  const pending = useRef<{ id: string; text: string } | null>(null);
  // the files as they sit in storage, so the load itself does not write them back
  const stored = useRef<F[] | null>(null);
  const restoreNow = useRef(restore);
  restoreNow.current = restore;
  // flush only reads refs, so every render's copy does the same
  const flush = () => {
    const p = pending.current;
    pending.current = null;
    if (p) kept(saveText(p.id, p.text, kv));
  };

  useEffect(() => {
    loaded.current = null;
    stored.current = null;
    let live = true;
    void loadDraft<F>(id, kv).then((d) => {
      if (!live) return;
      if (d) {
        stored.current = d.files;
        restoreNow.current(d);
      }
      loaded.current = id;
      // what was typed while it loaded is saved too, even when the load changed nothing
      setLoads((n) => n + 1);
    });
    const hidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      live = false;
      flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [id]);

  useEffect(() => {
    if (loaded.current !== id) return;
    pending.current = { id, text };
    const t = setTimeout(flush, 400);
    return () => clearTimeout(t);
  }, [text, id, loads]);

  useEffect(() => {
    if (loaded.current !== id || files === stored.current || (!stored.current && !files.length)) return;
    stored.current = files;
    kept(saveFiles(id, files, kv));
  }, [files, id, loads]);
}
