/**
 * Disk fairness (docs/design/ACCOUNTS.md 5): a member's files on the hub
 * (<home>/accounts/<id>/ and the outputs folders of their sessions) stay
 * under a cap the owner sets in People (settings.diskLimitGb, default
 * DEFAULT_DISK_GB). Checked before a write that can grow them: ReadPost
 * downloads, chat import uploads, browser profile launches, RenderFile and
 * Capture. The owner has no cap.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMember } from './context';

export const DEFAULT_DISK_GB = 5;
const GB = 1024 ** 3;
/** How long a measured size is trusted; du over a browser profile is not free on 2 cores. */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; bytes: number }>();

/** Bytes under a path, symlinks not followed. */
export function sizeOf(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  for (const n of names) total += sizeOf(join(path, n));
  return total;
}

export interface DiskInputs {
  home: string;
  accountId: string;
  /** The account's session ids, for their outputs folders. */
  sessionIds: () => string[];
  /** The owner's cap for this member in GB (AccountSettings.diskLimitGb). */
  limitGb?: number;
}

/** What the account's files on the hub take, in bytes (cached for a minute). */
export function accountDiskUse(i: DiskInputs, fresh = false): number {
  const hit = cache.get(i.accountId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.bytes;
  let bytes = sizeOf(join(i.home, 'accounts', i.accountId));
  for (const id of i.sessionIds()) if (/^[A-Za-z0-9_-]+$/.test(id)) bytes += sizeOf(join(i.home, 'outputs', id));
  cache.set(i.accountId, { at: Date.now(), bytes });
  return bytes;
}

/** Forget a measured size, after a write or a delete. */
export function forgetDiskUse(accountId: string): void {
  cache.delete(accountId);
}

/**
 * Why `more` bytes would not fit under the member's cap, or undefined when
 * they fit (or the account is the owner's).
 */
export function diskRefusal(i: DiskInputs, more = 0): string | undefined {
  if (!isMember(i.accountId)) return undefined;
  const limitGb = i.limitGb && i.limitGb > 0 ? i.limitGb : DEFAULT_DISK_GB;
  const used = accountDiskUse(i);
  if (used + more <= limitGb * GB) return undefined;
  const gb = (n: number) => (n / GB).toFixed(1);
  return `Your files on this hub use ${gb(used)} GB of your ${limitGb} GB${more ? `, and this needs ${gb(more)} GB more` : ''}. Delete some chats or files, or ask the hub's owner for more room in People.`;
}
