/**
 * A device daemon's recent log, for the hub's logs export (the logTail RPC).
 * The daemon keeps its own status lines and logger lines of this run in a
 * ring in memory, and adds the end of ~/.conclave/logs/daemon.log when the
 * service writes one (Windows and macOS). Everything goes through the
 * secrets filter before it leaves the device.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { DaemonLogTail } from '../client/logs';
import type { LogTap } from '../util/log';
import { redactSecrets } from '../memory/secrets';

const MAX_LINE = 1000;
/** Lines kept in memory. */
export const RING_LINES = 1000;
/** Bytes read from the end of daemon.log. */
const FILE_TAIL_BYTES = 256 * 1024;

const ANSI = /\x1b\[[0-9;]*m/g;

export class LogRing {
  private lines: string[] = [];
  readonly startedAt = Date.now();

  constructor(private readonly max = RING_LINES) {}

  push(line: string): void {
    const clean = line.replace(ANSI, '').replace(/\s+$/, '');
    if (!clean) return;
    this.lines.push(clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE)}...` : clean);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  /** The last n lines, oldest first. */
  tail(n = this.max): string[] {
    return this.lines.slice(-Math.max(0, n));
  }

  /** A tap for util/log.ts: logger lines of this process, as text. */
  tap(minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'): LogTap {
    const order = { debug: 10, info: 20, warn: 30, error: 40 };
    return (level, scope, msg, extra) => {
      if (order[level] < order[minLevel]) return;
      let rest = '';
      if (extra instanceof Error) rest = ` ${extra.message}`;
      else if (extra && typeof extra === 'object') {
        try {
          rest = ` ${JSON.stringify(extra)}`;
        } catch {
          /* not JSON */
        }
      } else if (extra !== undefined) rest = ` ${String(extra)}`;
      this.push(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${rest}`);
    };
  }
}

/** This process's ring: the daemon's lines. */
export const processLog = new LogRing();

/** The last lines of a text file, read from its end. */
export function fileTail(path: string, lines: number, maxBytes = FILE_TAIL_BYTES): string[] | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (size > len) all.shift();
    return all
      .map((l) => l.replace(ANSI, ''))
      .filter((l) => l.trim())
      .slice(-lines);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What the logTail RPC answers: the ring, the file's end, secrets out. */
export function daemonLogTail(opts: { lines?: number; impl: string; version?: string; file?: string; ring?: LogRing }): DaemonLogTail {
  const n = Math.min(Math.max(1, Math.floor(opts.lines ?? 500)), RING_LINES);
  const ring = opts.ring ?? processLog;
  const file = opts.file ? fileTail(opts.file, n) : undefined;
  const clean = (l: string) => redactSecrets(l).slice(0, MAX_LINE + 40);
  return {
    impl: opts.impl,
    ...(opts.version ? { version: opts.version } : {}),
    startedAt: ring.startedAt,
    lines: ring.tail(n).map(clean),
    ...(file?.length ? { file: file.map(clean) } : {}),
  };
}
