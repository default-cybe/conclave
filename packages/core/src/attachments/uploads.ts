/**
 * Files uploaded one at a time before a message (POST /api/uploads), so a
 * message can carry any number of files of any size without one huge JSON
 * body. Each upload is streamed to disk on the hub, never held in memory
 * whole, under the account's own folder:
 *
 *   owner   <home>/uploads/<id> and <id>.json
 *   member  <home>/accounts/<accountId>/uploads/<id> and <id>.json
 *
 * so a member's uploads count toward their disk cap (people/disk.ts) and one
 * account never reads another's (the id is looked up in the caller's folder
 * only). A message references uploads by id (Attachment.uploadId); once a
 * message takes one it is removed. One no message took within UPLOAD_TTL_MS
 * is deleted by the sweep. Uploaded bytes are only ever copied, read or
 * deleted, never run.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMember } from '../people/context';
import { UPLOAD_MAX_BYTES } from './limits';

/** An upload no message took is deleted after a day. */
export const UPLOAD_TTL_MS = 24 * 60 * 60_000;
export const UPLOADS_SWEEP_JOB = 'uploads.sweep';
export const UPLOADS_SWEEP_EVERY_MS = 60 * 60_000;

export interface UploadMeta {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: number;
}

export class UploadRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** One upload at most, in bytes: config server.uploadMaxMb (1 to 10000), else UPLOAD_MAX_BYTES. */
export function uploadMaxBytes(uploadMaxMb: number | undefined): number {
  const mb = Number(uploadMaxMb);
  return Number.isFinite(mb) && mb >= 1 ? Math.min(mb, 10_000) * 1024 * 1024 : UPLOAD_MAX_BYTES;
}

const ID = /^up_[a-f0-9]{24}$/;
const ACCOUNT = /^[A-Za-z0-9_-]+$/;

/**
 * Why `name` is not a plain file name, or undefined when it is: no folder
 * parts (/ or \), no . or .., no control characters, 255 characters at most.
 */
export function badFileName(name: string | undefined): string | undefined {
  if (typeof name !== 'string' || !name.trim()) return 'A file name is required.';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A file name cannot have control characters.';
  if (/[\\/]/.test(name) || name === '.' || name === '..' || /^[A-Za-z]:/.test(name)) return `${name} is not a plain file name: it names a folder.`;
  if (name.length > 255) return 'A file name is 255 characters at most.';
  return undefined;
}

/** The folder an account's uploads live in. */
export function uploadsDir(home: string, accountId: string | undefined): string {
  if (!isMember(accountId)) return join(home, 'uploads');
  if (!ACCOUNT.test(accountId!)) throw new UploadRefused('unknown account');
  return join(home, 'accounts', accountId!, 'uploads');
}

/**
 * Stream `body` into a new upload of the account, `max` bytes at most: past
 * it the partial file is deleted and UploadRefused 413 thrown. The metadata
 * is written last, so a half-written upload is never found by id.
 */
export async function putUpload(home: string, accountId: string | undefined, input: { name: string; mediaType?: string; body: ReadableStream<Uint8Array> | null; max: number }): Promise<UploadMeta> {
  const bad = badFileName(input.name);
  if (bad) throw new UploadRefused(bad);
  const dir = uploadsDir(home, accountId);
  await mkdir(dir, { recursive: true });
  const id = `up_${randomBytes(12).toString('hex')}`;
  const part = join(dir, `${id}.part`);
  const fh = await open(part, 'wx');
  let size = 0;
  try {
    const reader = input.body?.getReader();
    for (;;) {
      if (!reader) break;
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > input.max) {
        await reader.cancel().catch(() => {});
        throw new UploadRefused(`${input.name} is over ${Math.round(input.max / 1024 / 1024)} MB, the most one file can be.`, 413);
      }
      await fh.write(value);
    }
    await fh.close();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(part, { force: true });
    throw err;
  }
  await rename(part, join(dir, id));
  const meta: UploadMeta = { id, name: input.name, mediaType: input.mediaType || 'application/octet-stream', size, createdAt: Date.now() };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(meta));
  return meta;
}

/** The account's upload `id` with the path of its bytes, or undefined (unknown, another account's, or a bad id). */
export function getUpload(home: string, accountId: string | undefined, id: unknown): (UploadMeta & { path: string }) | undefined {
  if (typeof id !== 'string' || !ID.test(id)) return undefined;
  const dir = uploadsDir(home, accountId);
  const path = join(dir, id);
  try {
    if (!existsSync(path)) return undefined;
    const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as UploadMeta;
    return meta.id === id ? { ...meta, path } : undefined;
  } catch {
    return undefined;
  }
}

/** Delete one upload (taken by a message, or removed from the box). */
export async function removeUpload(home: string, accountId: string | undefined, id: string): Promise<void> {
  if (!ID.test(id)) return;
  const dir = uploadsDir(home, accountId);
  await Promise.all([rm(join(dir, id), { force: true }), rm(join(dir, `${id}.json`), { force: true })]);
}

/** Delete every upload, of every account, older than UPLOAD_TTL_MS: one no message took. The number of files removed. */
export async function sweepUploads(home: string, now = Date.now()): Promise<number> {
  const dirs = [join(home, 'uploads')];
  const accounts = await readdir(join(home, 'accounts')).catch(() => [] as string[]);
  for (const a of accounts) if (ACCOUNT.test(a)) dirs.push(join(home, 'accounts', a, 'uploads'));
  let removed = 0;
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (!/^up_[a-f0-9]{24}(\.json|\.part)?$/.test(n)) continue;
      const st = await stat(join(dir, n)).catch(() => undefined);
      if (!st || now - st.mtimeMs < UPLOAD_TTL_MS) continue;
      await rm(join(dir, n), { force: true });
      removed++;
    }
  }
  return removed;
}
