/**
 * A message's attachments as the hub takes them (engine.send): any number,
 * of any type. Pictures the model reads, PDFs and text go inline up to the
 * model's budget (attachments/budget.ts); everything else, and everything
 * past the budget, is saved and the model gets one note with each path,
 * type and size: into the session's folder (uploads/) when it has file
 * tools, else on the hub (the chat's outputs folder, uploads/), where Chat
 * cannot open it and the person is offered a Code session. Each zip is
 * turned into what the session can use (attachments/zip.ts):
 *
 * - a session with file tools (Code, an agent with a shell, a harness): the
 *   zip is saved in its folder, under uploads/, and the model gets a note
 *   with the path and the listing, so it unzips it with its own tools;
 * - a chat, or an agent with no shell: the hub reads it. The model gets the
 *   listing and the text files, and the pictures as images, up to the cap.
 *
 * A zip the hub refuses (too many entries, too big unpacked, a path outside,
 * a link) refuses the whole message with the reason, before anything runs.
 * A file the hub cannot read (a device path that went away) is dropped from
 * the message instead, with a receipt saying so; engine.send asks for an
 * explicit choice before it goes on without one (ATTACHMENT_LOST).
 *
 * Every other file is checked by its bytes (attachments/image.ts): a declared
 * type the bytes contradict is corrected, and a picture no model reads (HEIC,
 * AVIF, TIFF, BMP) refuses the message with the reason, so it never lands in
 * the history where every later turn would resend it.
 */
import type { Attachment } from '../client/index';
import type { AttachmentReceipt } from '../types';
import { EngineError } from '../engine/errors';
import { checkPicture, isModelImage, SNIFF_BYTES } from './image';
import { base64Head } from '../providers/common';
import { ATTACHMENTS_MAX_TOTAL_BYTES, isZip, mediaTypeFor } from './limits';
import { checkAll, listingNote, openZip, readForChat, ZipRefused } from './zip';
import { budgetFor, sizeWord, sniffFile, splitBudget, type Budget, type Part } from './budget';
import { badFileName } from './uploads';
import { isTextMediaType } from '../providers/common';
import { open, readFile } from 'node:fs/promises';

/** Pictures a chat's zips may add to one message as images, all zips together. */
export const ZIP_PICTURES_MAX = 15;

export interface ZipHost {
  /** The session can unzip with its own tools: the zip goes into its folder. Asked only when a zip comes. */
  fileTools(): boolean;
  /** Save the zip in the session's folder (uploads/); the path it was saved at. */
  save(name: string, bytes: Uint8Array): Promise<string>;
  /** A file on the session's device, for a zip attached by path. */
  read(path: string): Promise<Uint8Array>;
  /** The sender's upload `id` (attachments/uploads.ts) with the hub path of its bytes, or undefined. */
  upload?(id: string): { path: string; name: string; mediaType: string; size: number } | undefined;
  /**
   * Save a file the model does not get inline (named by fileSaveName): in the
   * session's folder, uploads/, when fileTools(), else on the hub. From its
   * bytes, or the hub path of an upload (copied, never held whole). The path
   * it was saved at. Without it, `save` takes the bytes.
   */
  keep?(name: string, from: { bytes: Uint8Array } | { hubPath: string; size: number }): Promise<string>;
  /** What of the message the session's model gets inline; budgetFor(undefined) without it. */
  budget?(): Budget;
}

/** The note's first line when the session can open saved files itself. */
export const SAVED_NOTE = 'Saved to the session folder, open with your tools:';
/** The note's first line in a chat (no file tools): the files are on the hub. */
export const SAVED_ON_HUB_NOTE = 'Saved on the hub. These files cannot be opened in this chat; the person can start a Code session to work with them:';

/** Prefix of the 409 that names the files a send would lose; the apps offer to send without them. */
export const ATTACHMENT_LOST = 'Attachment not included: ';

export interface PreparedAttachments {
  /** The list to send on: the same list, or what its zips became. */
  attachments: Attachment[] | undefined;
  /** One row per picked file, under the name it was picked under. */
  receipts: AttachmentReceipt[];
  /** The picked names the hub could not read; empty when nothing is lost. */
  lost: string[];
}

/** A zip's name for the words: its file name, one line, not too long. */
export function zipLabel(a: Attachment): string {
  const raw = a.name ?? a.path?.split(/[\\/]/).pop() ?? 'archive.zip';
  const one = raw.replace(/[\r\n\t]+/g, ' ').trim() || 'archive.zip';
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

/** The name a file was picked under, for its receipt. */
export function pickedName(a: Attachment): string {
  return a.name ?? a.path?.split(/[\\/]/).pop() ?? 'attachment';
}

/** A name to save any file under: its last part with anything odd made plain, no leading dots, 100 characters at most. */
export function fileSaveName(label: string, fallback = 'file'): string {
  const base = label.split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 100) || fallback;
}

/** A name to save a zip under: fileSaveName, ending in .zip. */
export function saveName(label: string): string {
  const clean = fileSaveName(label, 'archive');
  return /\.zip$/i.test(clean) ? clean : `${clean}.zip`;
}

/** An inline file's bytes; a data: prefix some senders add is skipped. */
const bytesOf = (data: string) => new Uint8Array(Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64'));

/** The first SNIFF_BYTES of a hub file. */
async function headOf(path: string): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** A file of the message the hub has the bytes of (inline, or uploaded first), sniffed. */
interface Item {
  a: Attachment;
  name: string;
  mediaType: string;
  size: number;
  hubPath?: string;
  label: string;
  part?: Part;
}

function textDoc(name: string, text: string): Attachment {
  return { mediaType: 'text/plain', data: Buffer.from(text, 'utf8').toString('base64'), name };
}

type PartKind = 'image' | 'pdf' | 'text';

function partOf(a: Attachment): PartKind {
  if (isModelImage(a.mediaType)) return 'image';
  if (a.mediaType === 'application/pdf') return 'pdf';
  return 'text';
}

/**
 * The attachments to send on, with a receipt per picked file. The same list
 * when there is no zip; throws EngineError 400 for a
 * zip the hub refuses. A file whose bytes the hub cannot read is left out and
 * named in lost: the sender chooses whether the message goes without it.
 */
export async function prepareAttachments(list: Attachment[] | undefined, host: ZipHost): Promise<PreparedAttachments> {
  if (!list?.length) return { attachments: list, receipts: [], lost: [] };
  // a name that names a folder or carries control characters is refused before anything is read or saved
  for (const a of list) {
    if ((a.data === undefined && a.uploadId === undefined) || a.name === undefined) continue;
    const bad = badFileName(a.name);
    if (bad) throw new EngineError(400, bad);
  }
  const receipts: AttachmentReceipt[] = [];
  const lost: string[] = [];
  const unreadable = (name: string, reason = 'could not be read from the device'): AttachmentReceipt => {
    lost.push(name);
    return { name, state: 'omitted', reason };
  };
  // the file checked by its bytes: as it was, with its type corrected, or undefined when the device cannot give it; a picture no model reads throws
  const checked = async (a: Attachment): Promise<Attachment | undefined> => {
    if (!a.data && !a.path) return a;
    const head = a.data ? base64Head(a.data) : await host.read(a.path!).then((b) => b.subarray(0, SNIFF_BYTES), () => undefined);
    if (!head) return undefined;
    const r = checkPicture(head, mediaTypeFor(a.mediaType, a.name ?? a.path), pickedName(a));
    if ('refused' in r) throw new EngineError(400, r.refused);
    return r.mediaType === a.mediaType ? a : { ...a, mediaType: r.mediaType };
  };
  const take = (a: Attachment, as?: Attachment[]): AttachmentReceipt => ({ name: pickedName(a), state: 'prepared', ...(as?.length ? { as: as.map((x) => x.name ?? pickedName(x)) } : {}), ...(as?.length ? { parts: as.map(partOf) } : { parts: [partOf(a)] }) });
  // 1. what each picked file is: a file on the device (by path, read as before), a zip, or a file the budget places
  type Slot = { kind: 'path'; a: Attachment } | { kind: 'zip'; a: Attachment; bytes?: Uint8Array } | { kind: 'item'; item: Item };
  const slots: Slot[] = [];
  for (const picked of list) {
    if (picked.uploadId !== undefined) {
      // the sender's own uploads only (engine zipHost); one taken by an earlier message is gone
      const up = typeof picked.uploadId === 'string' ? host.upload?.(picked.uploadId) : undefined;
      if (!up) throw new EngineError(404, `${picked.name ?? 'A file'} is no longer on the hub. Attach it again.`);
      const name = picked.name ?? up.name;
      const head = await headOf(up.path);
      const r = checkPicture(head, mediaTypeFor(picked.mediaType || up.mediaType, name), name);
      if ('refused' in r) throw new EngineError(400, r.refused);
      const a: Attachment = { mediaType: r.mediaType, name };
      // a zip small enough to open as an inline one would be; a bigger one is saved unopened
      if (isZip(r.mediaType, name) && up.size <= ATTACHMENTS_MAX_TOTAL_BYTES) slots.push({ kind: 'zip', a, bytes: await readFile(up.path) });
      else slots.push({ kind: 'item', item: { a, name, mediaType: r.mediaType, size: up.size, hubPath: up.path, ...sniffFile(head, name, r.mediaType) } });
      continue;
    }
    if (isZip(picked.mediaType, picked.name ?? picked.path)) slots.push({ kind: 'zip', a: picked });
    else if (!picked.data) slots.push({ kind: 'path', a: picked });
    else {
      const a = (await checked(picked))!;
      const name = pickedName(a);
      slots.push({ kind: 'item', item: { a, name, mediaType: a.mediaType, size: bytesOf(a.data!).length, ...sniffFile(base64Head(a.data!), name, mediaTypeFor(a.mediaType, name)) } });
    }
  }
  // 2. what goes inline (attachments/budget.ts), the same split for the same list
  const items = slots.flatMap((s) => (s.kind === 'item' ? [s.item] : []));
  const inline = splitBudget(items, host.budget?.() ?? budgetFor(undefined));
  // 3. in the person's order; the saved files' note comes last
  let fileTools: boolean | undefined;
  const out: Attachment[] = [];
  const saved: Array<{ it: Item; where: string }> = [];
  let n = 0;
  // the pictures from a zip take what is left of the cap
  let room = ZIP_PICTURES_MAX;
  try {
    for (const s of slots) {
      if (s.kind === 'path') {
        const file = await checked(s.a);
        if (!file) {
          receipts.push(unreadable(pickedName(s.a)));
          continue;
        }
        out.push(file);
        receipts.push(take(file));
        continue;
      }
      if (s.kind === 'item') {
        const it = s.item;
        if (inline.has(n++)) {
          const data = it.hubPath ? Buffer.from(await readFile(it.hubPath)).toString('base64') : it.a.data!;
          // sniffed as text or a PDF under a type that says nothing (a .rs, a Dockerfile): sent as what it is
          const mediaType = it.part === 'pdf' ? 'application/pdf' : it.part === 'text' && !isTextMediaType(mediaTypeFor(it.mediaType, it.name)) ? 'text/plain' : it.mediaType;
          const a = !it.hubPath && mediaType === it.a.mediaType ? it.a : { ...it.a, mediaType, data };
          out.push(a);
          receipts.push(take(a));
          continue;
        }
        fileTools ??= host.fileTools();
        const name = fileSaveName(it.name);
        let why = '';
        const where = await (host.keep ? host.keep(name, it.hubPath ? { hubPath: it.hubPath, size: it.size } : { bytes: bytesOf(it.a.data!) }) : host.save(name, it.hubPath ? await readFile(it.hubPath) : bytesOf(it.a.data!))).catch((err: unknown) => {
          // a refusal (a member's disk cap) refuses the message; a device that went away loses the file, and the sender chooses
          if (err instanceof EngineError) throw err;
          why = err instanceof Error ? err.message : String(err);
          return undefined;
        });
        if (!where) {
          receipts.push(unreadable(it.name, `could not be saved${why ? `: ${why}` : ''}`));
          continue;
        }
        saved.push({ it, where });
        receipts.push({ name: it.name, state: 'prepared', parts: ['text'], saved: where, savedOn: fileTools ? 'session' : 'hub' });
        continue;
      }
      const a = s.a;
      const label = zipLabel(a);
      const bytes = s.bytes ?? (a.data ? new Uint8Array(Buffer.from(a.data, 'base64')) : a.path ? await host.read(a.path).catch(() => undefined) : undefined);
      if (!bytes) {
        receipts.push(unreadable(pickedName(a)));
        continue;
      }
      const zip = openZip(bytes, label);
      fileTools ??= host.fileTools();
      if (fileTools) {
        // every entry inflated once: one that lies about its size is refused before the model unzips it
        checkAll(zip);
        const where = a.path && !a.data ? a.path : await host.save(saveName(label), bytes).catch(() => undefined);
        if (where) {
          const note = textDoc(label, listingNote(zip, where));
          out.push(note);
          receipts.push({ name: pickedName(a), state: 'prepared', as: [note.name ?? label], parts: ['text'] });
          continue;
        }
        // the folder could not take it (the device went away): read it here, as for a chat
      }
      const read = readForChat(zip, room);
      room -= read.length - 1;
      out.push(...read);
      receipts.push(take(a, read));
    }
  } catch (err) {
    if (err instanceof ZipRefused) throw new EngineError(400, err.message);
    throw err;
  }
  if (saved.length) {
    const lines = saved.map(({ it, where }) => `- ${fileTools ? where : it.name} (${it.label}, ${sizeWord(it.size)})`);
    out.push(textDoc('Saved files', [fileTools ? SAVED_NOTE : SAVED_ON_HUB_NOTE, ...lines].join('\n')));
  }
  return { attachments: out.length ? out : undefined, receipts, lost };
}
