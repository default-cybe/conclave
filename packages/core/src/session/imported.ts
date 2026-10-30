/**
 * Imported chats (docs/IMPORT.md): a chat copied in from claude.ai, ChatGPT,
 * Claude Code, Codex or Gemini CLI is stored archived and tagged `imported`
 * plus its source, with `meta.import` saying where it came from. Until the
 * owner writes in it, it lives in an "Imported" place of its own in the
 * sidebar, the Chats list and the phone's drawer, by its original date, so
 * an export of hundreds of chats never floods Today.
 *
 * The first message the owner sends in one unarchives it and stamps
 * `meta.import.continuedAt` (engine.send): from then on it is a normal
 * conversation in its date group, and archiving it later puts it in the
 * archive like any other, not back under Imported. A merge's duplicate copy
 * (`meta.import.duplicateOf`) is never listed.
 *
 * Pure, so the hub, the web app and the tests share it.
 */
import type { ContentBlock, Message, Session } from '../types';
import type { ImportSource } from '../client/import';

type Marked = Pick<Session, 'tags' | 'archived' | 'meta'>;

interface ImportMeta {
  source?: ImportSource;
  createdAt?: number;
  continuedAt?: number;
  duplicateOf?: string;
}

/** The tag every imported session carries. */
export const IMPORTED_TAG = 'imported';

/** The group's name, and its key in the folded groups. */
export const IMPORTED_WORDS = 'Imported';
export const IMPORTED_KEY = 'imported';

export const SOURCE_WORDS: Record<ImportSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', 'claude-ai': 'claude.ai', chatgpt: 'ChatGPT' };

function importMeta(s: Pick<Session, 'meta'>): ImportMeta | undefined {
  const v = s.meta?.import;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ImportMeta) : undefined;
}

/** A copy made by an import, continued or not. */
export function isImported(s: Pick<Session, 'tags'>): boolean {
  return (s.tags ?? []).includes(IMPORTED_TAG);
}

/** Still in the Imported place: imported, archived as the import left it, never written in here, not a merge's duplicate. */
export function inImported(s: Marked): boolean {
  if (!isImported(s) || !s.archived) return false;
  const m = importMeta(s);
  return !m?.continuedAt && !m?.duplicateOf;
}

/** Where it came from, by name: "claude.ai", "Claude Code". Undefined for a session with no import record. */
export function importedSourceName(s: Pick<Session, 'meta' | 'tags'>): string | undefined {
  const src = importMeta(s)?.source ?? (s.tags ?? []).find((t): t is ImportSource => t in SOURCE_WORDS);
  return src ? (SOURCE_WORDS[src] ?? src) : undefined;
}

/** When the chat started at its source (falls back to the session's own times). */
export function importedDate(s: Pick<Session, 'meta' | 'createdAt' | 'updatedAt'>): number {
  return importMeta(s)?.createdAt || s.createdAt || s.updatedAt;
}

/** Sort order of the Imported place: newest first by the date its row shows, not its last activity. */
export function byImportedDate(a: Pick<Session, 'meta' | 'createdAt' | 'updatedAt'>, b: Pick<Session, 'meta' | 'createdAt' | 'updatedAt'>): number {
  return importedDate(b) - importedDate(a);
}

/** The quiet label of an Imported row: "claude.ai, 2 May" this year, "ChatGPT, Sept 2025" before (short enough for the sidebar's column). */
export function importedLabel(s: Pick<Session, 'meta' | 'tags' | 'createdAt' | 'updatedAt'>, now = Date.now()): string {
  const d = new Date(importedDate(s));
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const day = d.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' });
  const src = importedSourceName(s);
  return src ? `${src}, ${day}` : day;
}

/** A message copied in by an import (it carries the source's own id). */
export function isImportedMessage(m: Pick<Message, 'meta'>): boolean {
  const e = m.meta?.external;
  return !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string';
}

/**
 * An imported message's text and its attached files apart: the importers
 * write each attachment as a text block "[Attached name]" with the file's
 * extracted text under it (importers/exports.ts). The model gets all of it;
 * the bubble shows the typed words and a chip per file.
 */
export function splitAttached(content: ContentBlock[]): { text: string; files: string[] } {
  const texts: string[] = [];
  const files: string[] = [];
  for (const b of content) {
    if (b.type !== 'text') continue;
    const m = /^\[Attached ([^\]\n]+)\](?:\n|$)/.exec(b.text);
    if (m) files.push(m[1]);
    else texts.push(b.text);
  }
  return { text: texts.join('\n\n').trim(), files };
}

/** The patch that takes a chat out of Imported on its first message here: unarchived, continuedAt stamped. */
export function continuedPatch(s: Pick<Session, 'meta'>, at = Date.now()): { archived: false; meta: Record<string, unknown> } {
  return { archived: false, meta: { ...(s.meta ?? {}), import: { ...(importMeta(s) ?? {}), continuedAt: at } } };
}
