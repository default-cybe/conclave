/**
 * Files a session hands to the owner (tools/share-file.ts). ShareFile checks
 * a path here and stores { path, device, name, mediaType, size } in its
 * result's meta.file; GET /api/sessions/:id/files/:toolUseId finds that
 * result and checks the path again before it sends a byte. A file may come
 * from the session's folder, its outputs folder on the hub
 * (<home>/outputs/<sessionId>), or the folder of one of its subagent or
 * delegated sessions. Nothing else under the hub home is ever served.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { Session } from '../types';
import type { Machine } from '../machine/types';
import { isHubPrivatePath, privateRefusal } from '../machine/private';

export const SHARE_MAX_BYTES = 30 * 1024 * 1024;

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
};

/** Types a download may show in the browser (?inline=1); everything else is an attachment. */
export const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The media type for a file name, from the extension allowlist; application/octet-stream otherwise. */
export function mediaTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/** The folder on the hub where a session without a project folder saves files for the owner. */
export function outputsDir(home: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('bad session id');
  return join(home, 'outputs', sessionId);
}

/** A hub path with a leading ~ expanded and resolved, so "~/", "~" and "/home/x/" compare equal. */
export function expandHome(p: string, userHome = homedir()): string {
  return clean(resolve(p === '~' || p.startsWith('~/') ? join(userHome, p.slice(1)) : p));
}

/** True for a hub folder that may never be a share root: /, /home, the hub user's home or any folder above it. */
export function tooWide(dir: string, userHome = homedir()): boolean {
  const d = expandHome(dir, userHome);
  return d === sep || d === '/home' || within(clean(resolve(userHome)), d);
}

/** True when a session runs on the hub without a project folder of its own (a chat, the assistant in the hub user's home, a cwd of / or /home): its files go to the outputs folder. */
export function usesOutputs(s: Pick<Session, 'cwd' | 'device' | 'kind'>, userHome = homedir()): boolean {
  if (s.device && s.device !== 'local') return false;
  return !s.cwd || s.kind === 'chat' || tooWide(s.cwd, userHome);
}

/** A folder files may be shared from. `outputs` marks a session's outputs folder, the only place under the hub home that is served. */
export interface ShareRoot {
  device: string;
  dir: string;
  machine: Machine;
  outputs?: boolean;
}

/** What meta.file holds. */
export interface SharedFileMeta {
  path: string;
  device: string;
  name: string;
  mediaType: string;
  size: number;
}

/** `ident` is the checked hub file's dev and ino, so a download reads that same file (engine sharedFile). */
export type ShareCheck = { ok: true; file: SharedFileMeta; machine: Machine; ident?: { dev: number; ino: number } } | { ok: false; code: 'missing' | 'too_big' | 'refused'; message: string };

function clean(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * True when a hub path lies in dir with symlinks followed: the deepest part of
 * the path that exists is resolved to its real place, so a link cannot lead
 * out. A link that resolves nowhere counts as outside.
 */
export function insideFolder(dir: string, path: string): boolean {
  let p = clean(resolve(path));
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(p);
      break;
    } catch {
      const up = dirname(p);
      if (up === p) return false;
      rest.unshift(basename(p));
      p = up;
    }
  }
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return false;
  }
  return within(clean(join(real, ...rest)), clean(realOr(resolve(dir))));
}

const refused = (message: string): ShareCheck => ({ ok: false, code: 'refused', message });
const OUTSIDE = 'Refused: only files in this session\'s folder, its outputs folder or the folder of a session it started can be shared.';

/**
 * Check that an absolute path may be shared. It must be inside one of the
 * roots; on the hub its real path must be too (a symlink cannot lead out),
 * it may not be a private hub file, and nothing under the hub home but an
 * outputs root counts. Under the hub user's home only a root that is a real
 * subfolder of it counts (never the home, /home or /). It must be a regular
 * file of at most 30 MB with one link (a hard link could name a private file).
 * shortcut: on a paired device the check is the path prefix and a stat (no realpath there); that device is the owner's own machine.
 */
export async function checkShareable(path: string, roots: ShareRoot[], hubHome: string, userHome = homedir()): Promise<ShareCheck> {
  if (!path || !isAbsolute(path)) return refused('Refused: give an absolute path, or one relative to the session folder.');
  const abs = clean(resolve(path));
  const home = clean(resolve(hubHome));
  const allowed = (p: string, real: boolean) =>
    roots.find((r) => {
      if (r.device !== 'local') return !real && within(p, clean(r.dir));
      const named = expandHome(r.dir, userHome);
      const dir = real ? clean(realOr(named)) : named;
      // the hub user's home, or a folder above it, would serve ~/.ssh
      if (tooWide(named, userHome) || tooWide(dir, userHome) || (real && tooWide(dir, realOr(userHome)))) return false;
      if (!within(p, dir)) return false;
      // under the hub home only an outputs folder is served
      const h = real ? clean(realOr(home)) : home;
      return !within(p, h) || r.outputs === true;
    });
  const root = allowed(abs, false);
  if (!root) return refused(OUTSIDE);
  let target = abs;
  let ident: { dev: number; ino: number } | undefined;
  if (root.device === 'local') {
    if (isHubPrivatePath(abs)) return refused(privateRefusal(abs));
    try {
      target = realpathSync(abs);
    } catch {
      return { ok: false, code: 'missing', message: `No file at ${abs}.` };
    }
    if (isHubPrivatePath(target)) return refused(privateRefusal(target));
    const again = allowed(target, true);
    if (!again || again.device !== 'local') return refused(OUTSIDE);
    try {
      const s = statSync(target);
      if (s.isFile() && s.nlink > 1) return refused(`Refused: ${abs} has more than one hard link.`);
      ident = { dev: s.dev, ino: s.ino };
    } catch {
      return { ok: false, code: 'missing', message: `No file at ${abs}.` };
    }
  }
  let st;
  try {
    st = await root.machine.stat(target);
  } catch {
    st = null;
  }
  if (!st) return { ok: false, code: 'missing', message: `No file at ${abs}.` };
  if (st.type !== 'file') return refused(`Refused: ${abs} is not a regular file.`);
  if (st.size > SHARE_MAX_BYTES) return { ok: false, code: 'too_big', message: `Refused: ${abs} is ${(st.size / 1024 / 1024).toFixed(1)} MB; the limit is 30 MB.` };
  const name = basename(abs);
  return { ok: true, machine: root.machine, file: { path: target, device: root.device, name, mediaType: mediaTypeOf(name), size: st.size }, ...(ident ? { ident } : {}) };
}
