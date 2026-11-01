/**
 * The hub's log files: one JSON line per event in
 * <home>/logs/hub-YYYY-MM-DD.jsonl (the UTC day), next to stdout.
 *
 * Files older than logs.keepDays (28) go when a day starts. All files
 * together stay under logs.maxMB (500): the oldest days go first; when
 * today's file alone fills the cap, info and debug lines are dropped (one
 * line says so) and warnings and errors still go until 10% past it.
 *
 * Lines a member's app sent (docs/design/ACCOUNTS.md 2) never make room:
 * past the cap they are dropped, whatever their level, and together they
 * take at most MEMBER_SHARE of the cap over the kept days, so they cannot
 * push the owner's older days out.
 *
 * Writes are synchronous, so a line logged just before a crash is on disk.
 * A failure to write (a full disk, no permission) never reaches the caller:
 * it is reported once and tried again a minute later.
 */
import { OWNER_ID, currentAccount } from '../people/context';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LogTap } from '../util/log';
import type { LogClientTag, LogLevel, LogLine } from '../client/logs';
import { cleanFields, cleanString, errorFields } from './redact';

export const DEFAULT_KEEP_DAYS = 28;
export const DEFAULT_MAX_MB = 500;
export const LOG_FILE_RE = /^hub-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** A line longer than this loses its fields. */
export const MAX_LINE = 16 * 1024;
/** Past the cap, warnings and errors still go until this share over it. */
const OVER_CAP = 1.1;
/** Members' app lines together, as a share of the size cap over the kept days: a day gets its part of it. */
export const MEMBER_SHARE = 0.1;
const RETRY_MS = 60_000;
const DAY_MS = 86_400_000;

/** YYYY-MM-DD of a time, UTC. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function logFileName(day: string): string {
  return `hub-${day}.jsonl`;
}

export interface LogFileInfo {
  name: string;
  day: string;
  bytes: number;
  path: string;
}

/** The hub-*.jsonl files in a folder, oldest first. */
export function listLogFiles(dir: string): LogFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogFileInfo[] = [];
  for (const name of names) {
    const m = LOG_FILE_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ name, day: m[1], bytes: st.size, path });
    } catch {
      /* gone meanwhile */
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export interface LogSinkOptions {
  dir: string;
  /** Read on each new day, so a change in config applies. */
  keepDays?: () => number | undefined;
  maxMB?: () => number | undefined;
  /** Debug lines are kept until then (epoch ms). */
  debugUntil?: () => number | undefined;
  /** The lowest level kept while debug is off. Default info. */
  minLevel?: LogLevel;
  now?: () => number;
  /** Told once when writing fails (stderr by default). */
  onProblem?: (message: string) => void;
}

/** Fields from a logger call's second argument: an Error, an object of fields, or anything else. */
export function fieldsOf(level: LogLevel, extra: unknown): Record<string, unknown> | undefined {
  if (extra === undefined || extra === null) return undefined;
  const stack = level === 'error';
  if (extra instanceof Error) return errorFields(extra, stack);
  if (typeof extra === 'object' && !Array.isArray(extra)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (v instanceof Error) Object.assign(out, errorFields(v, stack));
      else out[k] = v;
    }
    return out;
  }
  return { detail: typeof extra === 'string' ? extra : String(extra) };
}

export class LogSink {
  readonly dir: string;
  private day?: string;
  private fd?: number;
  /** Bytes of every hub-*.jsonl file in dir. */
  private total = 0;
  /** Lines dropped at the size cap on the current day. */
  private dropped = 0;
  /** Bytes of members' app lines written on the current day, since the hub started. */
  private memberBytes = 0;
  /** Members' app lines dropped on the current day: over their share, or past the cap. */
  private memberDropped = 0;
  private capNoted = false;
  /** Only today's file is left and it fills the cap: no older day to delete until tomorrow. */
  private capFull = false;
  private failedAt = 0;
  private reportedAt = 0;
  /** Why the last write failed; cleared when one works again. */
  problem?: string;

  constructor(private readonly opts: LogSinkOptions) {
    this.dir = opts.dir;
    this.total = listLogFiles(this.dir).reduce((n, f) => n + f.bytes, 0);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  keepDays(): number {
    const v = this.opts.keepDays?.();
    return typeof v === 'number' && v >= 1 ? Math.min(Math.floor(v), 3650) : DEFAULT_KEEP_DAYS;
  }

  maxMB(): number {
    const v = this.opts.maxMB?.();
    return typeof v === 'number' && v > 0 ? v : DEFAULT_MAX_MB;
  }

  private maxBytes(): number {
    return Math.floor(this.maxMB() * 1024 * 1024);
  }

  /** Bytes members' app lines may take in a day: MEMBER_SHARE of the cap spread over the kept days. */
  memberDayBytes(): number {
    return Math.floor((this.maxBytes() * MEMBER_SHARE) / this.keepDays());
  }

  /** Debug lines are kept now. */
  debugOn(): boolean {
    const until = this.opts.debugUntil?.();
    return typeof until === 'number' && until > this.now();
  }

  accepts(level: LogLevel): boolean {
    const min = this.debugOn() ? 'debug' : (this.opts.minLevel ?? 'info');
    return LEVELS[level] >= LEVELS[min];
  }

  /** For util/log.ts setLogTap: every logger() line, filtered here. */
  readonly tap: LogTap = (level, scope, msg, extra) => {
    if (!this.accepts(level)) return;
    // a line written while a member's work runs says whose it is (docs/design/ACCOUNTS.md); the owner's carry nothing new
    const acct = currentAccount();
    const fields = fieldsOf(level, extra);
    this.write(level, scope, msg, acct && acct !== OWNER_ID ? { ...(fields ?? {}), account: acct } : fields);
  };

  /** Write one line. False when it was not written (level, cap, a failing disk). */
  write(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>, client?: LogClientTag): boolean {
    if (!this.accepts(level)) return false;
    const now = this.now();
    const rec: LogLine = { time: new Date(now).toISOString(), level, component: cleanString(component, 64), msg: cleanString(msg) };
    const clean = fields ? (cleanFields(fields) as Record<string, unknown>) : undefined;
    if (clean && Object.keys(clean).length) rec.fields = clean;
    if (client) rec.client = cleanFields(client) as LogClientTag;
    let text = JSON.stringify(rec);
    if (text.length > MAX_LINE) {
      rec.fields = { truncated: text.length, ...(typeof clean?.error === 'string' ? { error: clean.error } : {}) };
      text = JSON.stringify(rec);
      if (text.length > MAX_LINE) {
        rec.msg = rec.msg.slice(0, 200);
        delete rec.client;
        text = JSON.stringify(rec);
      }
    }
    return this.append(level, `${text}\n`, now, !!client?.account && client.account !== OWNER_ID);
  }

  private append(level: LogLevel, text: string, now: number, member = false): boolean {
    const day = dayOf(now);
    if (day !== this.day) this.rotate(day, now);
    if (this.fd === undefined && !this.open(now)) return false;
    const bytes = Buffer.byteLength(text);
    const cap = this.maxBytes();
    // a member's app line never deletes a day to fit, and keeps to its share
    if (member) {
      if (this.memberBytes + bytes > this.memberDayBytes() || this.total + bytes > cap) {
        this.memberDropped++;
        return false;
      }
      if (!this.raw(text)) return false;
      this.memberBytes += bytes;
      return true;
    }
    if (this.total + bytes > cap) {
      if (!this.capFull) {
        this.pruneSize(cap - bytes);
        this.capFull = this.total + bytes > cap;
      }
      if (this.total + bytes > cap) {
        const severe = LEVELS[level] >= LEVELS.warn;
        if (!this.capNoted) {
          this.capNoted = true;
          this.raw(
            JSON.stringify({ time: new Date(now).toISOString(), level: 'warn', component: 'logs', msg: 'size cap reached: dropping info and debug lines for the rest of the day', fields: { maxMB: this.maxMB() } }) + '\n',
          );
        }
        if (!severe || this.total + bytes > cap * OVER_CAP) {
          this.dropped++;
          return false;
        }
      }
    }
    return this.raw(text);
  }

  private raw(text: string): boolean {
    if (this.fd === undefined) return false;
    try {
      writeSync(this.fd, text);
      this.total += Buffer.byteLength(text);
      if (this.problem) this.problem = undefined;
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private path(day: string): string {
    return join(this.dir, logFileName(day));
  }

  private open(now: number): boolean {
    if (this.failedAt && now - this.failedAt < RETRY_MS) return false;
    try {
      // this user's only (the desktop app also writes hub.log here): the folder 0700, each file 0600
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        /* Windows, or a folder the hub does not own: its rights hold */
      }
      this.fd = openSync(this.path(this.day ?? dayOf(now)), 'a', 0o600);
      this.failedAt = 0;
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private fail(err: unknown): void {
    const now = this.now();
    this.failedAt = now;
    this.problem = `Could not write the log file: ${(err as Error)?.message ?? String(err)}`;
    this.closeFd();
    if (now - this.reportedAt > 10 * 60_000) {
      this.reportedAt = now;
      (this.opts.onProblem ?? ((m: string) => console.error(`[logs] ${m}`)))(this.problem);
    }
  }

  private closeFd(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
    this.fd = undefined;
  }

  /** A new day: a new file, old days go, and a word about what the cap dropped yesterday. */
  private rotate(day: string, now: number): void {
    const was = this.day;
    const dropped = this.dropped;
    const memberDropped = this.memberDropped;
    this.closeFd();
    this.day = day;
    this.dropped = 0;
    this.memberBytes = 0;
    this.memberDropped = 0;
    this.capNoted = false;
    this.capFull = false;
    this.pruneDays(now);
    if (was && dropped && this.open(now)) {
      this.raw(JSON.stringify({ time: new Date(now).toISOString(), level: 'warn', component: 'logs', msg: 'lines dropped at the size cap', fields: { day: was, dropped, maxMB: this.maxMB() } }) + '\n');
    }
    if (was && memberDropped && this.open(now)) {
      this.raw(JSON.stringify({ time: new Date(now).toISOString(), level: 'warn', component: 'logs', msg: "members' app lines dropped at their share", fields: { day: was, dropped: memberDropped, share: MEMBER_SHARE } }) + '\n');
    }
  }

  /** Delete files of days before the kept window (today counts as one of the days). */
  pruneDays(now = this.now()): string[] {
    const first = dayOf(now - (this.keepDays() - 1) * DAY_MS);
    const removed: string[] = [];
    for (const f of listLogFiles(this.dir)) {
      if (f.day >= first) continue;
      if (this.remove(f)) removed.push(f.name);
    }
    return removed;
  }

  /** Delete the oldest files (never today's) until all of them fit in target bytes. */
  pruneSize(target = this.maxBytes()): string[] {
    const today = this.day ?? dayOf(this.now());
    const files = listLogFiles(this.dir);
    this.total = files.reduce((n, f) => n + f.bytes, 0);
    const removed: string[] = [];
    for (const f of files) {
      if (this.total <= target) break;
      if (f.day >= today) continue;
      if (this.remove(f)) removed.push(f.name);
    }
    return removed;
  }

  /** Both: by day, then by size. */
  prune(): string[] {
    return [...this.pruneDays(), ...this.pruneSize()];
  }

  private remove(f: LogFileInfo): boolean {
    try {
      unlinkSync(f.path);
      this.total -= f.bytes;
      return true;
    } catch {
      return false;
    }
  }

  /** Bytes of all files, as this sink counts them. */
  get bytes(): number {
    return this.total;
  }

  close(): void {
    this.closeFd();
    this.day = undefined;
  }
}
