/**
 * Dedupe, update and merge for imported sessions (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.6).
 *
 * A re-read source is compared with the Conclave session it was imported
 * into by message ids (meta.external.id). If the source only grew, the rest
 * is appended (Codex's own appender model). If the owner also kept going in
 * Conclave, both sides grew past the shared prefix: the side with more new
 * messages stays in the session and the other becomes a branch (the service
 * decides, from `both`); history is never interleaved. Turns Conclave ran through
 * the same harness session (ACP) appear in the source too, without a source
 * id on the Conclave side: they count as present when the owner's prompts
 * match by role and normalized text.
 */
import type { Message, TextBlock } from '../types';
import { externalId, originOf, type ImportedMessage } from '../importers/types';
import { sha256Hex } from '../importers/files';
import type { LedgerCursor } from './store';

export type SyncPlan =
  | { state: 'unchanged'; absorbed: string[]; claims?: Claim[]; grownLast?: { messageId: string; message: ImportedMessage } }
  | { state: 'append'; append: ImportedMessage[]; absorbed: string[]; claims?: Claim[]; grownLast?: { messageId: string; message: ImportedMessage } }
  | { state: 'diverged'; reason: string; both?: BothGrew };

/**
 * Both sides grew past the last imported message: what the source has after
 * it, and how many messages Conclave wrote after it (seq above afterSeq).
 */
export interface BothGrew {
  append: ImportedMessage[];
  native: number;
  afterSeq: number;
}

/** A Conclave message that matched a source message: it gets that source id, so later syncs line up. */
export interface Claim {
  messageId: string;
  id: string;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function textOf(m: Pick<Message, 'content'>): string {
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as TextBlock).text)
    .join('\n');
}

export function prefixHash(ids: string[]): string {
  return sha256Hex(ids.join('\n')).slice(0, 32);
}

/** External ids of a Conclave session's imported messages, in order. */
export function importedIds(session: Message[]): string[] {
  const out: string[] = [];
  for (const m of session) {
    const id = externalId(m);
    if (id) out.push(id);
  }
  return out;
}

/**
 * Compare a converted source with the session it was imported into.
 * `cursor.absorbed` holds source ids that earlier syncs matched to Conclave's
 * own harness turns.
 */
export function planSync(source: ImportedMessage[], session: Message[], cursor: Pick<LedgerCursor, 'absorbed'> = {}): SyncPlan {
  const have = new Map<string, Message>();
  let lastImportedSeq = -1;
  for (const m of session) {
    const id = externalId(m);
    if (!id) continue;
    have.set(id, m);
    lastImportedSeq = Math.max(lastImportedSeq, m.seq);
  }
  const absorbed = new Set(cursor.absorbed ?? []);
  let k = 0;
  while (k < source.length) {
    const id = externalId(source[k]);
    if (id && (have.has(id) || absorbed.has(id))) k++;
    else break;
  }
  // the whole source is already here: a copy that is behind (a Syncthing copy not synced yet) has nothing to add
  if (k === source.length) return { state: 'unchanged', absorbed: [...absorbed] };
  const prefix = new Set(source.slice(0, k).map((m) => externalId(m)!));
  const lost = [...have.keys(), ...absorbed].filter((id) => !prefix.has(id));
  // new messages there, and some imported ones gone (a rewind in the tool): never interleave
  if (lost.length) return { state: 'diverged', reason: `the source no longer has ${lost.length} message${lost.length === 1 ? '' : 's'} that were imported` };

  const native = session.filter((m) => m.seq > lastImportedSeq && !externalId(m) && m.kind !== 'notice');
  const rest = source.slice(k);

  // the last imported message can grow in place (a turn still running when it was imported)
  let grownLast: { messageId: string; message: ImportedMessage } | undefined;
  if (k > 0 && !native.length) {
    const last = source[k - 1];
    const mine = have.get(externalId(last)!);
    // a message Conclave wrote into the file (writeback.ts) is Conclave's own: never replaced from it
    const written = (mine?.meta?.external as { written?: boolean } | undefined)?.written;
    if (mine && !written && mine.seq === lastImportedSeq && last.content.length > mine.content.length) grownLast = { messageId: mine.id, message: last };
  }

  if (!rest.length) return { state: 'unchanged', absorbed: [...absorbed], ...(grownLast ? { grownLast } : {}) };
  if (!native.length) return { state: 'append', append: rest, absorbed: [...absorbed], ...(grownLast ? { grownLast } : {}) };

  // Conclave also grew. Its own harness turns are in the source as well: match the owner's prompts in order.
  const prompts = native.filter((m) => m.role === 'user' && m.kind === 'normal' && norm(textOf(m)));
  const both: BothGrew = { append: rest, native: native.length, afterSeq: lastImportedSeq };
  if (!prompts.length) return { state: 'diverged', reason: 'both Conclave and the source have new messages', both };
  let j = 0;
  let matched = -1;
  const claims: Claim[] = [];
  for (const p of prompts) {
    const want = norm(textOf(p));
    let found = -1;
    for (let i = j; i < rest.length; i++) {
      const r = rest[i];
      if (r.role === 'user' && r.kind === 'normal' && originOf(r) === 'human' && norm(textOf(r)) === want) {
        found = i;
        break;
      }
    }
    if (found < 0) return { state: 'diverged', reason: 'both Conclave and the source have new messages', both };
    const id = externalId(rest[found]);
    if (id) claims.push({ messageId: p.id, id });
    matched = found;
    j = found + 1;
  }
  // the reply the harness wrote to the last matched prompt is present in Conclave too, if Conclave has one
  const repliedHere = native[native.length - 1].role === 'assistant';
  let end = matched;
  if (repliedHere) {
    end = rest.length - 1;
    for (let i = matched + 1; i < rest.length; i++) {
      const r = rest[i];
      if (r.role === 'user' && r.kind === 'normal' && originOf(r) === 'human') {
        end = i - 1;
        break;
      }
    }
  }
  const newlyAbsorbed = rest.slice(0, end + 1).map((m) => externalId(m)).filter((x): x is string => !!x);
  // the last Conclave message takes the last absorbed id, so the next sync starts after it
  const lastNative = native[native.length - 1];
  const lastId = newlyAbsorbed[newlyAbsorbed.length - 1];
  if (lastId && !claims.some((c) => c.messageId === lastNative.id)) claims.push({ messageId: lastNative.id, id: lastId });
  const append = rest.slice(end + 1);
  const all = [...absorbed, ...newlyAbsorbed];
  return append.length ? { state: 'append', append, absorbed: all, claims } : { state: 'unchanged', absorbed: all, claims };
}
