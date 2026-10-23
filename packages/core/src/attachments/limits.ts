/**
 * What one message may carry, the same on the web, Android and the hub
 * (docs/design/CHAT-AND-MOTION.md 2.5): at most 15 files, and together less
 * than the hub reads in one request. A zip counts as one file; the hub
 * unpacks it (attachments/zip.ts). Pure, so the web app imports it too.
 */

/** Files in one message. */
export const MAX_ATTACHMENTS = 15;

/** The line for files past MAX_ATTACHMENTS, in the apps and from the hub. */
export const TOO_MANY_FILES = 'Up to 15 files per message. Zip the rest.';

/**
 * The files of one message together, before base64. The hub reads a JSON
 * body of 64 MB at most (server/src/http.ts JSON_BODY_MAX) and base64 makes
 * three bytes four, so 45 MB leaves room for the words.
 */
export const ATTACHMENTS_MAX_TOTAL_BYTES = 45 * 1024 * 1024;

/** The line for files past ATTACHMENTS_MAX_TOTAL_BYTES. */
export const TOO_LARGE_TOGETHER = 'Files in one message come to 45 MB at most. Send the rest in another message.';

/** Media types a zip comes as (Windows says x-zip-compressed). */
export const ZIP_MEDIA_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip'];

/** A zip, by its media type, or by its name when the type says nothing (application/octet-stream, empty). */
export function isZip(mediaType: string | undefined, name?: string): boolean {
  const t = (mediaType ?? '').toLowerCase();
  if (ZIP_MEDIA_TYPES.includes(t)) return true;
  return (!t || t === 'application/octet-stream') && !!name && /\.zip$/i.test(name);
}

/**
 * What the file pickers offer: pictures, PDFs, text and code, and zips. The
 * web inputs' accept list; Android's picker asks for the same types.
 */
export const ACCEPT_FILES = 'image/*,application/pdf,.pdf,.txt,.md,.log,.json,.csv,.xml,.yaml,.yml,.toml,.ts,.tsx,.js,.py,.sh,.html,.css,.zip,application/zip,application/x-zip-compressed';

/**
 * Which of `incoming` files to take after `current` already attached: the
 * first ones that fit under MAX_ATTACHMENTS and ATTACHMENTS_MAX_TOTAL_BYTES.
 * `refused` is the line to show when some were left out, else undefined.
 */
export function takeFiles<T extends { size: number }>(current: Array<{ size: number }>, incoming: T[]): { take: T[]; refused?: string } {
  const take: T[] = [];
  let total = current.reduce((n, f) => n + f.size, 0);
  let refused: string | undefined;
  for (const f of incoming) {
    if (current.length + take.length >= MAX_ATTACHMENTS) {
      refused = TOO_MANY_FILES;
      break;
    }
    if (total + f.size > ATTACHMENTS_MAX_TOTAL_BYTES) {
      refused ??= TOO_LARGE_TOGETHER;
      continue;
    }
    total += f.size;
    take.push(f);
  }
  return { take, ...(refused ? { refused } : {}) };
}

/** "7 files", "1 file": the count the attachment row shows once it scrolls. */
export function filesWord(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}
