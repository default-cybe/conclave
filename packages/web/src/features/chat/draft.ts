/**
 * A chat's composer draft, text and attached files, kept in IndexedDB so it
 * survives a reload or the OS killing the app. Files are base64 and too big
 * for localStorage; they sit under their own key, so typing never rewrites
 * them. A key is removed when its part empties (sent or cleared), when the
 * chat is deleted and at sign out (`DRAFT_PREFIX`). Keys are not per hub: a
 * sign out is the boundary.
 */
import type { Attachment } from '@conclave/core/client';
import { idbDropPrefix, idbGet, idbSet } from '@/lib/api';

export interface Draft<F extends Attachment = Attachment> {
  text: string;
  files: F[];
}

export interface DraftKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const DRAFT_PREFIX = 'draft:';
const hub: DraftKv = { get: idbGet, set: idbSet };
const textKey = (id: string) => `${DRAFT_PREFIX}${id}`;
const filesKey = (id: string) => `${DRAFT_PREFIX}${id}:files`;

export const saveText = (id: string, text: string, kv: DraftKv = hub) => kv.set(textKey(id), text || null);
export const saveFiles = (id: string, files: Attachment[], kv: DraftKv = hub) => kv.set(filesKey(id), files.length ? files : null);

export async function loadDraft<F extends Attachment = Attachment>(id: string, kv: DraftKv = hub): Promise<Draft<F> | null> {
  const text = await kv.get(textKey(id));
  const files = await kv.get(filesKey(id));
  const keep = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.mediaType === 'string' && typeof f.data === 'string') as F[];
  const t = typeof text === 'string' ? text : '';
  return t || keep.length ? { text: t, files: keep } : null;
}

/** A deleted chat leaves nothing behind. */
export function dropDraft(id: string, kv: DraftKv = hub): Promise<unknown> {
  return Promise.all([kv.set(textKey(id), null), kv.set(filesKey(id), null)]).catch(() => {});
}

/** Sign out: every chat's draft goes. */
export const dropAllDrafts = () => idbDropPrefix(DRAFT_PREFIX).catch(() => {});
