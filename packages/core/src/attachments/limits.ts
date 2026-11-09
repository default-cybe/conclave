/**
 * What one message may carry, the same on the web, Android and the hub
 * (docs/design/CHAT-AND-MOTION.md 2.5): any number of files of any type.
 * The web app uploads each file on its own (POST /api/uploads, up to
 * UPLOAD_MAX_BYTES each); a client that sends files inline as base64 keeps
 * them under ATTACHMENTS_MAX_TOTAL_BYTES together. What the model gets is
 * decided on the hub (attachments/budget.ts). Pure, so the web app imports it too.
 */

/** One uploaded file at most, by default (config server.uploadMaxMb changes it). */
export const UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

/**
 * The files of one message together, before base64, for a client that sends
 * them inline. The hub reads a JSON body of 64 MB at most
 * (server/src/http.ts JSON_BODY_MAX) and base64 makes three bytes four, so
 * 45 MB leaves room for the words.
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

const EXT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  py: 'text/x-python',
  sh: 'application/x-sh',
};

/**
 * A file's media type: the one given, or the one its extension names when
 * the given one says nothing (empty, application/octet-stream), and for a
 * .ts file browsers call video/mp2t.
 */
export function mediaTypeFor(mediaType: string | undefined, name?: string): string {
  const t = (mediaType ?? '').toLowerCase();
  const ext = /\.([^./\\]+)$/.exec(name ?? '')?.[1].toLowerCase() ?? '';
  const guess = Object.hasOwn(EXT_TYPES, ext) ? EXT_TYPES[ext] : undefined;
  if (guess && (!t || t === 'application/octet-stream' || (t === 'video/mp2t' && guess === 'text/x-typescript'))) return guess;
  return mediaType || 'application/octet-stream';
}

/**
 * Which of `incoming` files to take after `current` already attached, for a
 * client that sends them inline: the ones that fit under
 * ATTACHMENTS_MAX_TOTAL_BYTES. There is no count cap. `refused` is the line
 * to show when some were left out, else undefined.
 */
export function takeFiles<T extends { size: number }>(current: Array<{ size: number }>, incoming: T[]): { take: T[]; refused?: string } {
  const take: T[] = [];
  let total = current.reduce((n, f) => n + f.size, 0);
  let refused: string | undefined;
  for (const f of incoming) {
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
