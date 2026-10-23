import type { MachineInfo } from '../types';
import type { DirEntry, ExecResult, FileStat, Machine, MachineProcess } from '../machine/types';

/** Error code of every call on an OfflineMachine. */
export const OFFLINE_CODE = 'EOFFLINE';

export function offlineError(name: string): Error & { code: string; status: number } {
  return Object.assign(new Error(`${name} is offline. Wait, or run on another device.`), { code: OFFLINE_CODE, status: 409 });
}

export function isOfflineError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === OFFLINE_CODE;
}

/**
 * Stands in for a paired device that is not connected. Every call fails with
 * "<name> is offline", so nothing runs on the hub's disk by mistake
 * (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.1 bug 1). The runner parks the turn
 * before it gets here (projects/service.ts).
 */
export class OfflineMachine implements Machine {
  readonly offline = true;
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly lastInfo?: MachineInfo,
  ) {}

  private fail(): never {
    throw offlineError(this.name);
  }

  async info(): Promise<MachineInfo> {
    return this.fail();
  }
  async stat(): Promise<FileStat | null> {
    return this.fail();
  }
  async readFile(): Promise<Uint8Array> {
    return this.fail();
  }
  async readText(): Promise<string> {
    return this.fail();
  }
  async writeFile(): Promise<void> {
    return this.fail();
  }
  async readdir(): Promise<DirEntry[]> {
    return this.fail();
  }
  async mkdir(): Promise<void> {
    return this.fail();
  }
  async remove(): Promise<void> {
    return this.fail();
  }
  async rename(): Promise<void> {
    return this.fail();
  }
  async glob(): Promise<string[]> {
    return this.fail();
  }
  async grep(): Promise<{ output: string; total: number; truncated: boolean }> {
    return this.fail();
  }
  async exec(): Promise<ExecResult> {
    return this.fail();
  }
  spawn(): MachineProcess {
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
