/**
 * The cloudflared processes this hub started, in <home>/cloudflared/pids. A
 * hub that stops normally stops them itself. One that was killed or crashed
 * leaves them running, still forwarding to its port, so the next start reads
 * the file and stops what is left. A pid only counts when that process is
 * still a cloudflared, so a pid the system gave to something else is never
 * touched.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** True when pid runs and its command line passes `test`. Linux reads /proc, macOS asks ps; elsewhere it says no. */
export function processMatches(pid: number, test: (cmdline: string) => boolean): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // /proc separates arguments with NUL bytes
    if (process.platform === 'linux') return test(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
    if (process.platform === 'darwin') {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2_000 });
      return test(r.stdout ?? '');
    }
  } catch {
    /* gone, or not ours to read */
  }
  return false;
}

/** True when pid is a running cloudflared. */
export function isCloudflared(pid: number): boolean {
  return processMatches(pid, (cmd) => /cloudflared/.test(cmd));
}

export interface Reaper {
  isOurs?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export class PidFile {
  private pids = new Set<number>();

  constructor(private readonly path: string) {}

  private read(): number[] {
    try {
      if (!existsSync(this.path)) return [];
      return readFileSync(this.path, 'utf8')
        .split(/\s+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 1);
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, [...this.pids].join('\n') + (this.pids.size ? '\n' : ''));
    } catch {
      /* best effort: the worst case is a stray cloudflared after a crash */
    }
  }

  add(pid: number): void {
    this.pids.add(pid);
    this.write();
  }

  remove(pid: number): void {
    if (this.pids.delete(pid)) this.write();
  }

  /** Stop cloudflared processes a previous run left behind. Returns the pids it stopped. */
  reap(opts: Reaper = {}): number[] {
    const isOurs = opts.isOurs ?? isCloudflared;
    const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const stopped: number[] = [];
    for (const pid of this.read()) {
      if (this.pids.has(pid) || pid === process.pid || !isOurs(pid)) continue;
      try {
        kill(pid, 'SIGTERM');
        stopped.push(pid);
      } catch {
        /* already gone */
      }
    }
    this.write();
    return stopped;
  }
}
