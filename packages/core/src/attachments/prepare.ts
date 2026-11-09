/**
 * A message's attachments as the hub takes them (engine.send): 15 at most
 * (attachments/limits.ts), and each zip turned into what the session can use
 * (attachments/zip.ts):
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
import { isZip, mediaTypeFor } from './limits';
import { checkAll, listingNote, openZip, readForChat, ZipRefused } from './zip';

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
}

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

/** A name to save under: the file name with anything odd made plain, ending in .zip. */
export function saveName(label: string): string {
  const base = label.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 100) || 'archive';
  return /\.zip$/i.test(clean) ? clean : `${clean}.zip`;
}

/** An uploaded file as the inline file it stands for; one the hub does not have is refused. */
async function fromUpload(a: Attachment, host: ZipHost): Promise<Attachment> {
  if (a.uploadId === undefined) return a;
  const up = typeof a.uploadId === 'string' ? host.upload?.(a.uploadId) : undefined;
  if (!up) throw new EngineError(400, `${a.name ?? 'A file'} is no longer on the hub. Attach it again.`);
  const { uploadId: _u, ...rest } = a;
  return { ...rest, name: a.name ?? up.name, mediaType: a.mediaType || up.mediaType, data: Buffer.from(await Bun.file(up.path).arrayBuffer()).toString('base64') };
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
  list = await Promise.all(list.map((a) => fromUpload(a, host)));
  const receipts: AttachmentReceipt[] = [];
  const lost: string[] = [];
  const unreadable = (name: string): AttachmentReceipt => {
    lost.push(name);
    return { name, state: 'omitted', reason: 'could not be read from the device' };
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
  if (!list.some((a) => isZip(a.mediaType, a.name ?? a.path))) {
    // no zip to open; a file by path the hub cannot read is dropped now, so the sender chooses
    const out: Attachment[] = [];
    for (const picked of list) {
      const a = await checked(picked);
      if (!a) {
        receipts.push(unreadable(pickedName(picked)));
        continue;
      }
      out.push(a);
      receipts.push(take(a));
    }
    return { attachments: out.length ? out : undefined, receipts, lost };
  }
  let fileTools: boolean | undefined;
  const out: Attachment[] = [];
  // the pictures from a zip take what is left of the cap
  let room = ZIP_PICTURES_MAX;
  try {
    for (const a of list) {
      if (!isZip(a.mediaType, a.name ?? a.path)) {
        const file = await checked(a);
        if (!file) {
          receipts.push(unreadable(pickedName(a)));
          continue;
        }
        out.push(file);
        receipts.push(take(file));
        continue;
      }
      const label = zipLabel(a);
      const bytes = a.data ? new Uint8Array(Buffer.from(a.data, 'base64')) : a.path ? await host.read(a.path).catch(() => undefined) : undefined;
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
  return { attachments: out.length ? out : undefined, receipts, lost };
}
