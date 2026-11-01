/**
 * Chat import state the screens share: recent batches (kept fresh by
 * import.batch events), how many imported chats are not learned yet, the
 * uploads made in this tab, and whether the import sheet is open. The job
 * itself runs on the hub, so it keeps going when the owner moves on.
 */
import { create } from 'zustand';
import type { ImportBatch, ImportUploadResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { onHubEvent } from '@/store/store';

interface ImportState {
  batches: ImportBatch[];
  notLearned: number;
  loaded: boolean;
  /** Exports uploaded in this tab, newest first. */
  uploads: Array<ImportUploadResult & { name?: string; at: number }>;
  sheet: { open: boolean; device?: string };
}

export const useImport = create<ImportState>(() => ({ batches: [], notLearned: 0, loaded: false, uploads: [], sheet: { open: false } }));

const set = useImport.setState;

export const LIVE: ReadonlySet<ImportBatch['status']> = new Set(['scanning', 'importing', 'learning', 'consolidating', 'waiting_reset']);

export function isLive(b: ImportBatch): boolean {
  return LIVE.has(b.status);
}

let loading: Promise<void> | undefined;

/** Load recent batches once per mount (and again after a change the events do not carry). */
export function loadBatches(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api()
    .importBatches()
    .then((r) => set({ batches: r.batches, notLearned: r.notLearned, loaded: true }))
    .catch(() => set({ loaded: true }))
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

/** Put one batch in the list (an event or a reply). */
export function upsertBatch(b: ImportBatch): void {
  set((s) => {
    const i = s.batches.findIndex((x) => x.id === b.id);
    const batches = i >= 0 ? s.batches.map((x) => (x.id === b.id ? b : x)) : [b, ...s.batches];
    return { batches: batches.sort((x, y) => y.createdAt - x.createdAt).slice(0, 20) };
  });
}

const wasLive = new Set<string>();

onHubEvent((e) => {
  if (e.type !== 'import.batch') return;
  upsertBatch(e.batch);
  // a batch that finished changes the "not learned yet" count
  const live = isLive(e.batch);
  if (wasLive.has(e.batch.id) && !live) void loadBatches(true);
  if (live) wasLive.add(e.batch.id);
  else wasLive.delete(e.batch.id);
});

export function openImportSheet(device?: string): void {
  set({ sheet: { open: true, device } });
}

export function closeImportSheet(): void {
  set({ sheet: { open: false } });
}

export function addUpload(u: ImportUploadResult, name?: string): void {
  set((s) => ({ uploads: [{ ...u, name, at: Date.now() }, ...s.uploads.filter((x) => x.uploadId !== u.uploadId)] }));
}
