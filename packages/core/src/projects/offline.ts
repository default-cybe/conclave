import type { Device, MachineInfo } from '../types';
import type { DirEntry, ExecResult, FileStat, Machine, MachineProcess } from '../machine/types';
import type { EventBus } from '../util/bus';

/** Error code of every call on an OfflineMachine. */
export const OFFLINE_CODE = 'EOFFLINE';

export function offlineError(name: string): Error & { code: string; status: number } {
  return Object.assign(new Error(`${name} is offline. Wait, or run on another device.`), { code: OFFLINE_CODE, status: 409 });
}

export function isOfflineError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === OFFLINE_CODE;
}

/** A call on a device that dropped in the last `recentMs` waits up to `ms` for it to reconnect (daemons are back in a second or two). */
export const RECONNECT_WAIT = { ms: 20_000, recentMs: 60_000 };

/**
 * The device's machine once it is connected again, or undefined: at once for
 * a device away longer than RECONNECT_WAIT.recentMs, else after RECONNECT_WAIT.ms.
 */
export async function waitForReturn(devices: { get(id: string): Machine | undefined; list(): Device[] }, bus: EventBus, id: string): Promise<Machine | undefined> {
  const now = devices.get(id);
  if (now) return now;
  const seen = devices.list().find((d) => d.id === id)?.lastSeenAt ?? 0;
  if (Date.now() - seen > RECONNECT_WAIT.recentMs) return undefined;
  return bus.once('device.updated', (e) => e.device.id === id && !!e.device.online, RECONNECT_WAIT.ms).then(
    () => devices.get(id),
    () => undefined,
  );
}

/**
 * Stands in for a paired device that is not connected. Every call fails with
 * "<name> is offline", so nothing runs on the hub's disk by mistake
 * (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.1 bug 1). The runner parks the turn
 * before it gets here (projects/service.ts). With `back`, a call first waits
 * for a device that just dropped (waitForReturn) and runs there once it is back.
 */
export class OfflineMachine implements Machine {
  readonly offline = true;
  /** The device's machine after a call found it back; spawn, which cannot wait, uses it. */
  private returned: Machine | undefined;
  /** One wait per OfflineMachine: later calls of the same turn reuse its outcome instead of waiting again. */
  private waiting: Promise<Machine | undefined> | undefined;
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly lastInfo?: MachineInfo,
    private readonly back?: () => Promise<Machine | undefined>,
  ) {}

  private fail(): never {
    throw offlineError(this.name);
  }

  private async live(): Promise<Machine> {
    this.waiting ??= this.back ? this.back() : Promise.resolve(undefined);
    const m = await this.waiting;
    if (!m) this.fail();
    return (this.returned = m);
  }

  async info(): Promise<MachineInfo> {
    return (await this.live()).info();
  }
  async stat(path: string): Promise<FileStat | null> {
    return (await this.live()).stat(path);
  }
  async readFile(path: string): Promise<Uint8Array> {
    return (await this.live()).readFile(path);
  }
  async readText(path: string): Promise<string> {
    return (await this.live()).readText(path);
  }
  async writeFile(...a: Parameters<Machine['writeFile']>): Promise<void> {
    return (await this.live()).writeFile(...a);
  }
  async readdir(path: string): Promise<DirEntry[]> {
    return (await this.live()).readdir(path);
  }
  async mkdir(path: string): Promise<void> {
    return (await this.live()).mkdir(path);
  }
  async remove(...a: Parameters<Machine['remove']>): Promise<void> {
    return (await this.live()).remove(...a);
  }
  async rename(from: string, to: string): Promise<void> {
    return (await this.live()).rename(from, to);
  }
  async glob(...a: Parameters<Machine['glob']>): Promise<string[]> {
    return (await this.live()).glob(...a);
  }
  async grep(...a: Parameters<Machine['grep']>): Promise<{ output: string; total: number; truncated: boolean }> {
    return (await this.live()).grep(...a);
  }
  async exec(...a: Parameters<Machine['exec']>): Promise<ExecResult> {
    const signal = a[1].signal;
    // Stop during the wait ends the call; it does not run later when the device comes back
    const stopped = new Promise<'stopped'>((resolve) => {
      if (signal?.aborted) resolve('stopped');
      signal?.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    const m = await Promise.race([this.live(), stopped]);
    if (m === 'stopped') return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, durationMs: 0 };
    return m.exec(...a);
  }
  spawn(...a: Parameters<Machine['spawn']>): MachineProcess {
    if (this.returned) return this.returned.spawn(...a);
    return this.fail();
  }
  /** Paths still resolve from the last known home, so prompts and UI keep showing them. */
  resolve(path: string, cwd: string): string {
    const home = this.lastInfo?.home ?? '~';
    if (path === '~') return home;
    if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
    return `${cwd.replace(/\/+$/, '')}/${path}`;
  }
}

export function isOfflineMachine(m: Machine): m is OfflineMachine {
  return (m as { offline?: unknown }).offline === true;
}
