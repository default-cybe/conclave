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
 */
import type { Attachment } from '../client/index';
import { EngineError } from '../engine/errors';
import { isZip, MAX_ATTACHMENTS, TOO_MANY_FILES } from './limits';
import { checkAll, listingNote, openZip, readForChat, ZipRefused } from './zip';

export interface ZipHost {
  /** The session can unzip with its own tools: the zip goes into its folder. Asked only when a zip comes. */
  fileTools(): boolean;
  /** Save the zip in the session's folder (uploads/); the path it was saved at. */
  save(name: string, bytes: Uint8Array): Promise<string>;
  /** A file on the session's device, for a zip attached by path. */
  read(path: string): Promise<Uint8Array>;
}

/** A zip's name for the words: its file name, one line, not too long. */
export function zipLabel(a: Attachment): string {
  const raw = a.name ?? a.path?.split(/[\\/]/).pop() ?? 'archive.zip';
  const one = raw.replace(/[\r\n\t]+/g, ' ').trim() || 'archive.zip';
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

/** A name to save under: the file name with anything odd made plain, ending in .zip. */
export function saveName(label: string): string {
  const base = label.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 100) || 'archive';
  return /\.zip$/i.test(clean) ? clean : `${clean}.zip`;
}

function textDoc(name: string, text: string): Attachment {
  return { mediaType: 'text/plain', data: Buffer.from(text, 'utf8').toString('base64'), name };
}

/**
 * The attachments to send on. The same list when there is no zip; throws
 * EngineError 400 past MAX_ATTACHMENTS or for a zip the hub refuses.
 */
export async function prepareAttachments(list: Attachment[] | undefined, host: ZipHost): Promise<Attachment[] | undefined> {
  if (!list?.length) return list;
  if (list.length > MAX_ATTACHMENTS) throw new EngineError(400, TOO_MANY_FILES);
  if (!list.some((a) => isZip(a.mediaType, a.name ?? a.path))) return list;
  let fileTools: boolean | undefined;
  const out: Attachment[] = [];
  // the pictures from a zip take what is left of the cap
  let room = MAX_ATTACHMENTS - list.length;
  try {
    for (const a of list) {
      if (!isZip(a.mediaType, a.name ?? a.path)) {
        out.push(a);
        continue;
      }
      const label = zipLabel(a);
      const bytes = a.data ? new Uint8Array(Buffer.from(a.data, 'base64')) : a.path ? await host.read(a.path).catch(() => undefined) : undefined;
      if (!bytes) {
        out.push(a);
        continue;
      }
      const zip = openZip(bytes, label);
      fileTools ??= host.fileTools();
      if (fileTools) {
        // every entry inflated once: one that lies about its size is refused before the model unzips it
        checkAll(zip);
        const where = a.path && !a.data ? a.path : await host.save(saveName(label), bytes).catch(() => undefined);
        if (where) {
          out.push(textDoc(label, listingNote(zip, where)));
          continue;
        }
        // the folder could not take it (the device went away): read it here, as for a chat
      }
      const read = readForChat(zip, room);
      room -= read.length - 1;
      out.push(...read);
    }
  } catch (err) {
    if (err instanceof ZipRefused) throw new EngineError(400, err.message);
    throw err;
  }
  return out;
}
