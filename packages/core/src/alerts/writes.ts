/**
 * Who wrote which file and when, per device and absolute path, for the file
 * conflict alert (alerts/service.ts). Pure and in memory: it keeps only the
 * last CONFLICT_WINDOW_MS of writes, and a hub restart starts it empty.
 */
import { posix } from 'node:path';

/** A write conflicts with another chat's write in this window. Also the debounce of the Inbox item. */
export const CONFLICT_WINDOW_MS = 10 * 60_000;

export interface FileWrite {
  sessionId: string;
  at: number;
}

export class FileWrites {
  /** device + "\n" + path -> session id -> time of its last write. */
  private files = new Map<string, Map<string, number>>();

  constructor(private readonly windowMs = CONFLICT_WINDOW_MS) {}

  record(device: string, path: string, sessionId: string, at: number): void {
    const key = `${device}\n${path}`;
    let writers = this.files.get(key);
    if (!writers) this.files.set(key, (writers = new Map()));
    writers.set(sessionId, Math.max(at, writers.get(sessionId) ?? 0));
  }

  /** Sessions other than `sessionId` that wrote the file within the window before `now`, newest first. */
  others(device: string, path: string, sessionId: string, now: number): FileWrite[] {
    const writers = this.files.get(`${device}\n${path}`);
    if (!writers) return [];
    const out: FileWrite[] = [];
    for (const [id, at] of writers) if (id !== sessionId && now - at <= this.windowMs) out.push({ sessionId: id, at });
    return out.sort((a, b) => b.at - a.at);
  }

  /** A session that went away writes nothing any more. */
  forget(sessionId: string): void {
    for (const [key, writers] of this.files) {
      writers.delete(sessionId);
      if (!writers.size) this.files.delete(key);
    }
  }

  /** Drop writes older than the window. */
  prune(now: number): void {
    for (const [key, writers] of this.files) {
      for (const [id, at] of writers) if (now - at > this.windowMs) writers.delete(id);
      if (!writers.size) this.files.delete(key);
    }
  }

  get size(): number {
    return this.files.size;
  }
}

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;

/**
 * The absolute, normalized path a tool wrote: as given when it is absolute,
 * else relative to the session's folder. Undefined for anything that is not
 * a path.
 */
export function absolutePath(p: unknown, cwd: string): string | undefined {
  if (typeof p !== 'string' || !p.trim()) return undefined;
  const path = p.trim();
  if (WINDOWS_ABS.test(path)) return path.replace(/\//g, '\\');
  if (path.startsWith('/')) return posix.normalize(path);
  if (WINDOWS_ABS.test(cwd)) return `${cwd.replace(/[\\/]+$/, '')}\\${path.replace(/\//g, '\\')}`;
  if (!cwd.startsWith('/')) return undefined;
  return posix.normalize(posix.join(cwd, path));
}

/** The path as the Inbox shows it: relative to the first folder that holds it, else whole. */
export function shownPath(path: string, folders: Array<string | undefined>): string {
  for (const f of folders) {
    if (!f) continue;
    const root = f.replace(/[\\/]+$/, '');
    const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
    if (root && path.startsWith(root + sep)) return path.slice(root.length + 1);
  }
  return path;
}

/** The line the model gets on the result of a write that landed on another chat's file. */
export function conflictLine(title: string, at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  return `Another chat, '${title}', changed this file ${min < 1 ? 'less than a minute ago' : `${min} min ago`}.`;
}
