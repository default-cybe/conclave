/**
 * Offers to import a computer's past chats (docs/DESIGN.md 38). A computer
 * that pairs for the first time (a new device from POST /api/daemon/register)
 * is marked. The first time it comes online the import scan reads it, and when
 * it finds chats the import would bring (new ones, not too short, not
 * automation), one offer waits in the Inbox and on the device's row in
 * Devices, with a notification: "Found 12 chats from Claude Code and Codex on
 * studio. Import them?". Nothing is imported here: the offer opens the import
 * sheet with the device picked, which shows the cost estimate first.
 *
 * Once per device: the offer stays until the owner imports from that device
 * or dismisses it, and a device that was dismissed, imported, or had nothing
 * to bring is never asked again. A device paired again from its app keeps its
 * id and is not new. A member's device is offered to that member only.
 */
import type { ImportOffer, ImportSource } from '../client/import';
import type { Notice } from '../types';
import type { EventBus } from '../util/bus';
import { logger } from '../util/log';
import { DEVICE_SOURCES, sourceName } from './sources';

const log = logger('import');

const PREFIX = 'import.offer.';
/** Scans of a new device that may fail (a daemon still starting) before it is left alone. */
const MAX_TRIES = 3;

/** pending: paired, not scanned yet. open: offered. empty: nothing to bring. dismissed, imported: answered. */
export type OfferState = 'pending' | 'open' | 'empty' | 'dismissed' | 'imported';

export interface OfferRow {
  state: OfferState;
  accountId: string;
  pairedAt: number;
  chats?: number;
  sources?: Partial<Record<ImportSource, number>>;
  offeredAt?: number;
  tries?: number;
}

export interface ImportOffersDeps {
  kv: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void; delete(key: string): void; keys(prefix: string): string[] };
  bus: EventBus;
  /** A notification to the device's account (its apps and browsers). */
  notify?: (notice: Omit<Notice, 'id' | 'createdAt'>) => void;
  deviceName(id: string): string;
  /** Chats on a device the import would bring by default, per tool, read as the device's account. */
  count(device: string, accountId: string): Promise<Partial<Record<ImportSource, number>>>;
}

/** "Found 12 chats from Claude Code and Codex on studio. Import them?" */
export function offerText(chats: number, sources: Partial<Record<ImportSource, number>>, deviceName: string): string {
  const names = DEVICE_SOURCES.filter((s) => sources[s]).map(sourceName);
  const from = names.length ? ` from ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}` : '';
  return `Found ${chats} ${chats === 1 ? 'chat' : 'chats'}${from} on ${deviceName}. ${chats === 1 ? 'Import it?' : 'Import them?'}`;
}

export class ImportOffers {
  private scanning = new Set<string>();
  private off?: () => void;

  constructor(private readonly deps: ImportOffersDeps) {}

  /** Scan new devices when they come online; forget removed ones. */
  start(): this {
    this.off = this.deps.bus.on((e) => {
      if (e.type === 'device.updated' && e.device.online && e.device.id !== 'local') void this.check(e.device.id);
      else if (e.type === 'device.deleted') this.forget(e.deviceId);
    });
    return this;
  }

  stop(): void {
    this.off?.();
  }

  private row(device: string): OfferRow | undefined {
    return this.deps.kv.get<OfferRow | null>(PREFIX + device, null) ?? undefined;
  }

  private put(device: string, row: OfferRow): void {
    this.deps.kv.set(PREFIX + device, row);
  }

  /** A computer paired for the first time: offer its chats once it is online. */
  paired(device: string, accountId: string): void {
    if (device === 'local' || this.row(device)) return;
    this.put(device, { state: 'pending', accountId, pairedAt: Date.now() });
  }

  /** Read a pending device and open its offer when it has chats to bring. Runs once at a time per device. */
  async check(device: string): Promise<void> {
    const row = this.row(device);
    if (row?.state !== 'pending' || this.scanning.has(device)) return;
    this.scanning.add(device);
    try {
      let sources: Partial<Record<ImportSource, number>>;
      try {
        sources = await this.deps.count(device, row.accountId);
      } catch (err) {
        // dismissed, imported or removed while the scan ran: never write the old row back
        const cur = this.row(device);
        if (cur?.state !== 'pending') return;
        const tries = (cur.tries ?? 0) + 1;
        log.warn(`scan of the new device ${device} for the import offer failed (${tries} of ${MAX_TRIES}): ${(err as Error).message}`);
        this.put(device, { ...cur, tries, ...(tries >= MAX_TRIES ? { state: 'empty' as const } : {}) });
        return;
      }
      // dismissed, imported or removed while the scan ran
      const now = this.row(device);
      if (now?.state !== 'pending') return;
      const chats = Object.values(sources).reduce((a, b) => a + (b ?? 0), 0);
      if (!chats) {
        this.put(device, { ...now, state: 'empty' });
        return;
      }
      const next: OfferRow = { ...now, state: 'open', chats, sources, offeredAt: Date.now() };
      this.put(device, next);
      const offer = this.dto(device, next);
      this.deps.bus.emit({ type: 'import.offer', accountId: next.accountId, device, offer });
      this.deps.notify?.({ title: 'Past chats found', body: offer.text, level: 'info', link: `/sessions?import=${encodeURIComponent(device)}`, accountId: next.accountId });
    } finally {
      this.scanning.delete(device);
    }
  }

  private dto(device: string, row: OfferRow): ImportOffer {
    const deviceName = this.deps.deviceName(device);
    const chats = row.chats ?? 0;
    const sources = row.sources ?? {};
    return { device, deviceName, chats, sources, text: offerText(chats, sources, deviceName), createdAt: row.offeredAt ?? row.pairedAt };
  }

  /** Open offers of an account, newest first. */
  list(accountId: string): ImportOffer[] {
    const out: ImportOffer[] = [];
    for (const key of this.deps.kv.keys(PREFIX)) {
      const device = key.slice(PREFIX.length);
      const row = this.row(device);
      if (row?.state === 'open' && row.accountId === accountId) out.push(this.dto(device, row));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The state of a device's offer, for tests and the audit. */
  state(device: string): OfferState | undefined {
    return this.row(device)?.state;
  }

  private close(device: string, row: OfferRow, state: 'dismissed' | 'imported'): void {
    this.put(device, { ...row, state });
    if (row.state === 'open') this.deps.bus.emit({ type: 'import.offer', accountId: row.accountId, device });
  }

  /** Not now: the device is not offered again. False when the account has no open offer for it. */
  dismiss(device: string, accountId: string): boolean {
    const row = this.row(device);
    if (row?.state !== 'open' || row.accountId !== accountId) return false;
    this.close(device, row, 'dismissed');
    return true;
  }

  /** An import from the device started: its offer is answered, and a pending one is never made. */
  imported(device: string): void {
    const row = this.row(device);
    if (row?.state === 'open' || row?.state === 'pending') this.close(device, row, 'imported');
  }

  /** The device was removed. */
  forget(device: string): void {
    const row = this.row(device);
    if (!row) return;
    this.deps.kv.delete(PREFIX + device);
    if (row.state === 'open') this.deps.bus.emit({ type: 'import.offer', accountId: row.accountId, device });
  }
}
