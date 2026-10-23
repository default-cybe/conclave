/**
 * Hub logs (docs/DESIGN.md 33). HubLogs ties the parts together for a
 * running hub: the daily files (sink.ts) fed by every logger() line and by
 * engine events (events.ts), reading them back (reader.ts), what the apps
 * send about themselves (ingestClient, capped per client), the debug switch
 * with its timer, and the export (export.ts).
 */
import { platform, arch } from 'node:os';
import type { ConfigStore } from '../config';
import type { EventBus } from '../util/bus';
import { currentLogTap, logger, setLogTap, type LogTap } from '../util/log';
import { redactSecrets } from '../memory/secrets';
import type { ClientLogResult, LogClientTag, LogLevel, LogsStatus } from '../client/logs';
import { LogSink, LEVELS } from './sink';
import { LogReader } from './reader';
import { attachLogEvents } from './events';
import { EV, ev } from './names';

export * from './sink';
export * from './reader';
export * from './events';
export * from './names';
export { cleanFields, cleanString, errorFields, recleanLine } from './redact';

/** Events in one batch from an app. */
export const CLIENT_BATCH_MAX = 50;
/** Events per app per minute, and per hour. */
export const CLIENT_PER_MINUTE = 120;
export const CLIENT_PER_HOUR = 1000;
/**
 * Events per member per hour, all their apps together (docs/design/ACCOUNTS.md 2):
 * the log is the owner's, so a member's apps get a small part of it, and the
 * sink keeps their lines to a share of the size cap (sink.ts).
 */
export const MEMBER_PER_HOUR = 100;
/** Bytes of one batch body. */
export const CLIENT_BODY_MAX = 64 * 1024;
/** The debug switch runs a week at most. */
export const DEBUG_MAX_HOURS = 168;

type LogsConfig = { keepDays?: number; maxMB?: number; debugUntil?: number };

export interface HubLogsOptions {
  config: Pick<ConfigStore, 'get' | 'update' | 'paths'>;
  version: string;
  now?: () => number;
}

interface ClientWindow {
  minute: number;
  inMinute: number;
  hour: number;
  inHour: number;
  dropped: number;
  droppedNotedAt: number;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export class HubLogs {
  readonly sink: LogSink;
  readonly reader: LogReader;
  readonly dir: string;
  private readonly now: () => number;
  private prevTap?: LogTap;
  private offBus?: () => void;
  private startedAt = 0;
  private clients = new Map<string, ClientWindow>();
  /** Per member account, across their apps. */
  private members = new Map<string, ClientWindow>();

  constructor(private readonly opts: HubLogsOptions) {
    this.now = opts.now ?? Date.now;
    this.dir = opts.config.paths.logs;
    const cfg = (): LogsConfig => opts.config.get().logs ?? {};
    this.sink = new LogSink({
      dir: this.dir,
      keepDays: () => cfg().keepDays,
      maxMB: () => cfg().maxMB,
      debugUntil: () => cfg().debugUntil,
      now: this.now,
    });
    this.reader = new LogReader(this.dir, this.now);
  }

  private cfg(): LogsConfig {
    return this.opts.config.get().logs ?? {};
  }

  /** Every logger() line and engine event goes to the files from now on, and a line says the hub started. */
  start(info: { bus?: EventBus; host?: string; port?: number } = {}): void {
    if (this.startedAt) return;
    this.startedAt = this.now();
    this.prevTap = setLogTap(this.sink.tap);
    if (info.bus) this.offBus = attachLogEvents(info.bus, this.now);
    this.sink.prune();
    const [component, msg] = ev(EV.hubStarted);
    const envNames = Object.keys(process.env)
      .filter((k) => k.startsWith('CONCLAVE_'))
      .sort();
    logger(component).info(msg, {
      version: this.opts.version,
      pid: process.pid,
      bun: typeof Bun !== 'undefined' ? Bun.version : undefined,
      os: platform(),
      arch: arch(),
      ...(info.host ? { host: info.host } : {}),
      ...(info.port ? { port: info.port } : {}),
      home: this.opts.config.paths.home,
      keepDays: this.sink.keepDays(),
      maxMB: this.sink.maxMB(),
      ...(envNames.length ? { env: envNames.join(',') } : {}),
    });
  }

  /** A line says the hub stopped; the files close. */
  stop(reason?: string): void {
    if (!this.startedAt) return;
    const [component, msg] = ev(EV.hubStopped);
    logger(component).info(msg, { version: this.opts.version, uptimeMs: this.now() - this.startedAt, ...(reason ? { reason } : {}) });
    this.offBus?.();
    this.offBus = undefined;
    if (currentLogTap() === this.sink.tap) setLogTap(this.prevTap);
    this.prevTap = undefined;
    this.startedAt = 0;
    this.sink.close();
  }

  async status(): Promise<LogsStatus> {
    const files = this.reader.files();
    const counts = await this.reader.counts();
    const until = this.cfg().debugUntil;
    return {
      dir: this.dir,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      ...(files.length ? { oldest: files[0].day, newest: files[files.length - 1].day } : {}),
      // what the sink uses: a value out of range in config.json falls back to the default
      keepDays: this.sink.keepDays(),
      maxMB: this.sink.maxMB(),
      ...counts,
      ...(until && until > this.now() ? { debugUntil: until } : {}),
      ...(this.sink.problem ? { problem: this.sink.problem } : {}),
    };
  }

  /** Debug lines for the next `hours` (0 turns them off). Returns when it ends. */
  setDebug(hours: number, actor?: string): number | undefined {
    if (!Number.isFinite(hours) || hours < 0 || hours > DEBUG_MAX_HOURS) throw Object.assign(new Error(`hours must be 0 to ${DEBUG_MAX_HOURS}`), { status: 400 });
    const until = hours > 0 ? this.now() + Math.round(hours * 3_600_000) : 0;
    const was = this.cfg().debugUntil;
    this.opts.config.update({ logs: { ...this.cfg(), debugUntil: until } });
    const [component, msg] = ev(until ? EV.debugOn : EV.debugOff);
    // written after the switch, so "on" lands even at debug level and "off" lands at info
    if (until) logger(component).info(msg, { until: new Date(until).toISOString(), hours, ...(actor ? { by: actor } : {}) });
    else if (was && was > this.now()) logger(component).info(msg, actor ? { by: actor } : {});
    return until || undefined;
  }

  /**
   * Lines an app sent about itself: at most CLIENT_BATCH_MAX a batch,
   * CLIENT_PER_MINUTE a minute and CLIENT_PER_HOUR an hour per client, and
   * MEMBER_PER_HOUR an hour for all of a member's apps. What is over is
   * dropped and counted in one line a minute.
   */
  ingestClient(tag: LogClientTag, body: unknown): ClientLogResult {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const events = Array.isArray(b.events) ? b.events : [];
    const client: LogClientTag = {
      id: tag.id,
      ...(tag.device ? { device: tag.device.slice(0, 80) } : {}),
      app: str(b.app, 24)?.toLowerCase().replace(/[^a-z0-9._-]/g, '') || tag.app || 'app',
      ...(str(b.version, 40) ? { version: str(b.version, 40) } : {}),
      ...(str(b.platform, 40) ? { platform: str(b.platform, 40) } : {}),
      ...(tag.account && tag.account !== 'owner' ? { account: tag.account } : {}),
    };
    const now = this.now();
    const w = this.window(this.clients, tag.id, now);
    const m = client.account ? this.window(this.members, client.account, now) : undefined;
    let accepted = 0;
    let dropped = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (i >= CLIENT_BATCH_MAX || w.inMinute >= CLIENT_PER_MINUTE || w.inHour >= CLIENT_PER_HOUR || (m && m.inHour >= MEMBER_PER_HOUR) || !e || typeof e !== 'object') {
        dropped++;
        continue;
      }
      w.inMinute++;
      w.inHour++;
      if (m) m.inHour++;
      const ev = e as Record<string, unknown>;
      const level: LogLevel = typeof ev.level === 'string' && ev.level in LEVELS ? (ev.level as LogLevel) : 'info';
      const name = str(ev.event, 64)?.replace(/[^A-Za-z0-9._:-]/g, '_') || 'event';
      const fields: Record<string, unknown> = {};
      if (ev.fields && typeof ev.fields === 'object' && !Array.isArray(ev.fields)) {
        let n = 0;
        for (const [k, v] of Object.entries(ev.fields as Record<string, unknown>)) {
          if (n >= 12) break;
          const key = k.slice(0, 40);
          if (typeof v === 'string') fields[key] = v.slice(0, 200);
          else if (typeof v === 'number' || typeof v === 'boolean' || v === null) fields[key] = v;
          else continue;
          n++;
        }
      }
      const msg = str(ev.msg, 300);
      if (msg) fields.error = msg;
      if (typeof ev.ts === 'number' && Math.abs(now - ev.ts) < 7 * 86_400_000) fields.clientTime = new Date(ev.ts).toISOString();
      // the debug switch counts here too: an app's debug lines are kept only while it is on
      if (this.sink.write(level, 'client', name, fields, client)) accepted++;
    }
    if (dropped) {
      w.dropped += dropped;
      if (now - w.droppedNotedAt > 60_000) {
        this.sink.write('warn', 'client', 'client lines dropped', { dropped: w.dropped, perMinute: CLIENT_PER_MINUTE, perHour: m ? MEMBER_PER_HOUR : CLIENT_PER_HOUR, perBatch: CLIENT_BATCH_MAX }, client);
        w.dropped = 0;
        w.droppedNotedAt = now;
      }
    }
    return { accepted, dropped };
  }

  private window(windows: Map<string, ClientWindow>, id: string, now: number): ClientWindow {
    const minute = Math.floor(now / 60_000);
    const hour = Math.floor(now / 3_600_000);
    let w = windows.get(id);
    if (!w) {
      w = { minute, inMinute: 0, hour, inHour: 0, dropped: 0, droppedNotedAt: 0 };
      windows.set(id, w);
      if (windows.size > 500) windows.delete(windows.keys().next().value as string);
    }
    if (w.minute !== minute) {
      w.minute = minute;
      w.inMinute = 0;
    }
    if (w.hour !== hour) {
      w.hour = hour;
      w.inHour = 0;
    }
    return w;
  }
}

/**
 * Log an uncaught exception or unhandled rejection with its stack, then exit
 * as Bun would have (code 1). For the hub's own process only.
 */
export function installCrashLogging(exit: (code: number) => void = (c) => process.exit(c)): () => void {
  const [component, msg] = ev(EV.crash);
  const log = logger(component);
  const handler = (kind: string) => (err: unknown) => {
    try {
      log.error(msg, { kind, error: err instanceof Error ? err : new Error(String(err)) });
    } catch {
      /* still exit */
    }
    // the stack for stdout too, through the same secrets filter as every other line there
    try {
      console.error(redactSecrets(err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err)));
    } catch {
      /* still exit */
    }
    exit(1);
  };
  const onException = handler('uncaughtException');
  const onRejection = handler('unhandledRejection');
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}
