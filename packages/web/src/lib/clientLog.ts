/**
 * What this app tells the hub's log files about itself (docs/DESIGN.md 33):
 * connects and reconnects, failed requests with their status, render errors,
 * script errors, and push and notification failures. The web app, the
 * desktop app and the iPhone app are the same code, so all three send it.
 *
 * Events wait in a queue and go in batches (POST /api/logs/client): every
 * 30 seconds, soon after 20 are waiting, and when the app goes to the
 * background. At most 200 wait and 60 are taken a minute; the same event
 * again within 10 seconds counts on the one before. Only event names,
 * statuses, paths with their ids folded and short error messages go, never
 * text from a chat.
 */
import type { ClientLogBatch, ClientLogEvent, LogLevel } from '@conclave/core/client';
import { version as CLIENT_VERSION } from '../../package.json';

const MAX_QUEUE = 200;
const PER_MINUTE = 60;
const BATCH = 50;
const FLUSH_MS = 30_000;
const SOON_AT = 20;
const SAME_WITHIN_MS = 10_000;

type Sender = (batch: ClientLogBatch) => Promise<unknown>;

let queue: ClientLogEvent[] = [];
let send: Sender | undefined;
let started = false;
let sending = false;
let off = false;
let soon: ReturnType<typeof setTimeout> | undefined;
let minute = 0;
let inMinute = 0;
let dropped = 0;

/** web, desktop or iphone: which build of the app this is. */
export function appName(): string {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'web';
  const w = window as unknown as Record<string, unknown>;
  const tauri = '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
  if (tauri) return /iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : 'desktop';
  return 'web';
}

/** The operating system in one word. */
export function platformName(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  return /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : 'unknown';
}

/** /api/sessions/ses_0abc12/messages -> /api/sessions/:id/messages. Query strings never go. */
export function foldPath(path: string): string {
  return path
    .split('?')[0]
    .split('/')
    .map((seg) => (/^[a-z]{1,8}_[A-Za-z0-9]{6,}$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || (seg.length > 24 && /\d/.test(seg)) ? ':id' : seg))
    .join('/')
    .slice(0, 160);
}

/** A short error message: one line, cut. */
function short(msg: unknown): string | undefined {
  if (msg === undefined || msg === null || msg === '') return undefined;
  const s = msg instanceof Error ? msg.message || msg.name : String(msg);
  return s.replace(/\s+/g, ' ').trim().slice(0, 240) || undefined;
}

/** Report one event. Safe to call anywhere, any time; it never throws. */
export function clientLog(level: LogLevel, event: string, fields?: ClientLogEvent['fields'], msg?: unknown): void {
  try {
    if (off) return;
    const now = Date.now();
    const text = short(msg);
    const last = queue[queue.length - 1];
    if (last && last.event === event && last.msg === text && now - (last.ts ?? 0) < SAME_WITHIN_MS) {
      const f = (last.fields ??= {});
      f.repeats = (typeof f.repeats === 'number' ? f.repeats : 1) + 1;
      return;
    }
    const m = Math.floor(now / 60_000);
    if (m !== minute) {
      minute = m;
      inMinute = 0;
    }
    if (inMinute >= PER_MINUTE || queue.length >= MAX_QUEUE) {
      dropped++;
      return;
    }
    inMinute++;
    queue.push({ ts: now, level, event, ...(text ? { msg: text } : {}), ...(fields && Object.keys(fields).length ? { fields: { ...fields } } : {}) });
    if (queue.length >= SOON_AT && !soon) soon = setTimeout(() => void flush(), 1000);
  } catch {
    /* logging never breaks the app */
  }
}

/** Send what waits. A refusal that will not change (an older hub) stops sending for this run. */
export async function flush(): Promise<void> {
  if (soon) clearTimeout(soon);
  soon = undefined;
  if (!send || sending || off) return;
  if (dropped) {
    queue.push({ ts: Date.now(), level: 'warn', event: 'log.dropped', fields: { dropped } });
    dropped = 0;
  }
  if (!queue.length) return;
  const batch = queue.slice(0, BATCH);
  sending = true;
  try {
    await send({ app: appName(), version: CLIENT_VERSION, platform: platformName(), events: batch });
    queue = queue.slice(batch.length);
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (status === 404) {
      // a hub from before logs: nothing to send to
      off = true;
      queue = [];
    } else if (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 429) queue = queue.slice(batch.length);
    // offline, 401, 429 or 5xx: keep them for the next try
  } finally {
    sending = false;
  }
}

/**
 * Start sending through `sender` (the paired client's sendClientLogs). Called
 * again when the client changes; the timers and listeners start once.
 */
export function startClientLog(sender: Sender): void {
  send = sender;
  // no window: a test or a worker, which only sends
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return;
  started = true;
  clientLog('info', 'app.start', { standalone: !!window.matchMedia?.('(display-mode: standalone)').matches, width: window.innerWidth, height: window.innerHeight });
  setInterval(() => void flush(), FLUSH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('error', (e) => {
    const file = typeof e.filename === 'string' ? e.filename.split('/').pop()?.split('?')[0] : undefined;
    clientLog('error', 'js.error', { ...(file ? { file } : {}), ...(e.lineno ? { line: e.lineno } : {}) }, e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => clientLog('error', 'js.rejection', undefined, e.reason));
}

/** For tests: the queue and a fresh start. */
export function _clientLogState(): { queue: ClientLogEvent[]; dropped: number; off: boolean } {
  return { queue, dropped, off };
}

export function _resetClientLog(): void {
  queue = [];
  send = undefined;
  sending = false;
  off = false;
  dropped = 0;
  inMinute = 0;
  minute = 0;
  if (soon) clearTimeout(soon);
  soon = undefined;
}

/** For the request wrapper: a failed call, with its status (0: no answer). */
export function logRequestFailure(method: string, path: string, err: unknown): void {
  if (path.startsWith('/api/logs/client')) return;
  const status = typeof (err as { status?: unknown })?.status === 'number' ? ((err as { status: number }).status as number) : 0;
  // a 404 is often a hub that does not have a feature yet; it still counts, quietly
  const level: LogLevel = status === 0 || status >= 500 || status === 401 || status === 403 ? 'warn' : 'info';
  clientLog(level, 'request.failed', { method, path: foldPath(path), status }, err);
}
