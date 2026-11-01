/**
 * Syncthing folders per device, as the hub knows them (2.5). Asked through
 * the device's Machine (the syncthingFolders RPC on daemons of protocol 2),
 * cached for 10 minutes and kept in kv, so a device that is offline still
 * helps resolve a path from its last answer. An older daemon has no such RPC
 * and the resolver skips the Syncthing step for it.
 */
import type { Machine } from '../machine/types';
import type { SyncthingFolder, SyncthingStatus } from '../machine/syncthing';
import type { KvRepo } from '../storage/repos';
import { logger } from '../util/log';

const log = logger('projects');
const KEY = 'projects.syncthing';
export const SYNCTHING_TTL_MS = 10 * 60_000;

interface Entry {
  at: number;
  folders: SyncthingFolder[];
}

export class SyncthingCache {
  constructor(
    private readonly kv: KvRepo,
    private readonly ttlMs = SYNCTHING_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private all(): Record<string, Entry> {
    return this.kv.get<Record<string, Entry>>(KEY, {});
  }

  /** The last answer for a device, however old. */
  cached(device: string): Entry | undefined {
    return this.all()[device];
  }

  /**
   * Folders on a device. undefined means unknown: the device cannot say
   * (old daemon) and nothing is cached. An offline device (no machine) gets
   * its cached list.
   */
  async folders(device: string, machine: Machine | undefined, opts: { refresh?: boolean } = {}): Promise<SyncthingFolder[] | undefined> {
    const hit = this.cached(device);
    if (hit && !opts.refresh && this.now() - hit.at < this.ttlMs) return hit.folders;
    if (!machine?.syncthingFolders) return hit?.folders;
    try {
      const folders = (await machine.syncthingFolders()).map((f) => ({ id: String(f.id), label: String(f.label ?? f.id), path: String(f.path), paused: !!f.paused }));
      this.kv.set(KEY, { ...this.all(), [device]: { at: this.now(), folders } });
      return folders;
    } catch (err) {
      log.debug(`syncthing folders on ${device} failed`, err);
      return hit?.folders;
    }
  }

  /** One folder's state on a device, or undefined when it cannot say. */
  async status(machine: Machine | undefined, folderId: string): Promise<SyncthingStatus | undefined> {
    if (!machine?.syncthingStatus) return undefined;
    try {
      return await machine.syncthingStatus(folderId);
    } catch (err) {
      log.debug(`syncthing status of ${folderId} on ${machine.id} failed`, err);
      return undefined;
    }
  }

  forget(device: string): void {
    const all = { ...this.all() };
    delete all[device];
    this.kv.set(KEY, all);
  }
}

/** "12 folders, all up to date", "12 folders, 2 syncing", "No Syncthing on this device". */
export function syncthingLine(folders: SyncthingFolder[] | undefined, statuses: Array<SyncthingStatus | undefined>, offlineName?: string): string {
  if (!folders) return 'This device cannot report Syncthing folders (its daemon is older, or it has never been online).';
  if (!folders.length) return offlineName ? `No Syncthing folders, as last known while ${offlineName} was online.` : 'No Syncthing folders on this device.';
  const n = `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}`;
  const known = statuses.filter((s): s is SyncthingStatus => !!s);
  const paused = folders.filter((f) => f.paused).length;
  // an offline device: the folder list is the cached one and nothing can be asked
  if (offlineName) return `${n}${paused ? `, ${paused} paused` : ''}. Last known while ${offlineName} was online.`;
  if (!known.length) return `${n}${paused ? `, ${paused} paused` : ''}. Syncthing is not answering here, so their sync state is unknown.`;
  const syncing = known.filter((s) => s.state !== 'idle' || s.needFiles > 0).length;
  const errors = known.filter((s) => s.pullErrors > 0).length;
  const parts: string[] = [];
  if (syncing) parts.push(`${syncing} syncing`);
  if (errors) parts.push(`${errors} with errors`);
  if (paused) parts.push(`${paused} paused`);
  return parts.length ? `${n}, ${parts.join(', ')}.` : `${n}, all up to date.`;
}
