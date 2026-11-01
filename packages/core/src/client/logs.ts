/**
 * Hub logs (docs/DESIGN.md 33): JSON lines in <home>/logs/hub-YYYY-MM-DD.jsonl,
 * kept for logs.keepDays (28) under logs.maxMB (500), with what the apps send
 * about themselves. Only type declarations live here (see client/index.ts).
 *
 * What a line never holds: message text, file contents, tool input or output,
 * tokens, keys or passwords. Every line goes through the secrets filter
 * (memory/secrets.ts) before it is written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Who sent a client line: the paired app, its version and its platform. */
export interface LogClientTag {
  /** The paired client id ("owner" for the owner token). */
  id: string;
  /** Its name on the hub ("Chrome on macOS", "Pixel 9"). */
  device?: string;
  /** web, desktop, iphone, android. */
  app: string;
  version?: string;
  /** The operating system: macOS, Windows, iOS, Android, Linux. */
  platform?: string;
  /** Whose app it is on a hub with several people (docs/design/ACCOUNTS.md); missing is the owner's. */
  account?: string;
}

/** One line of a log file. */
export interface LogLine {
  /** ISO time, UTC. */
  time: string;
  level: LogLevel;
  /** session, tool, approval, routine, device, peer, http, ws, hub, client, github, ... */
  component: string;
  msg: string;
  fields?: Record<string, unknown>;
  /** Set on lines an app sent (POST /api/logs/client). */
  client?: LogClientTag;
}

/** GET /api/logs: what Settings, Logs shows. */
export interface LogsStatus {
  /** Where the files are on the hub. */
  dir: string;
  files: number;
  bytes: number;
  /** The oldest and newest day with a file (YYYY-MM-DD, UTC). */
  oldest?: string;
  newest?: string;
  keepDays: number;
  maxMB: number;
  errorsToday: number;
  errorsWeek: number;
  warningsToday: number;
  /** Debug lines are written until then (epoch ms). Unset or past: off. */
  debugUntil?: number;
  /** Writing failed (a full disk, no permission); lines go to stdout only. */
  problem?: string;
}

export interface LogsTailQuery {
  /** Lines from the end. Default 100, at most 1000. */
  lines?: number;
  /** From a cursor a tail call returned: only lines written after it. */
  after?: string;
  /** This level and above. */
  level?: LogLevel;
  /** Only this component (or its children: "peer" matches "peer.shares"). */
  component?: string;
}

export interface LogsTailResult {
  lines: LogLine[];
  /** Pass as after to get what comes next. */
  cursor: string;
}

export interface LogErrorGroup {
  component: string;
  /** The message with ids and numbers folded, so repeats group. */
  msg: string;
  /** One real message of the group. */
  sample: string;
  count: number;
  first: string;
  last: string;
}

/** GET /api/logs/errors: errors of the last days, grouped. */
export interface LogErrorsReport {
  days: number;
  from: string;
  to: string;
  errors: number;
  warnings: number;
  /** Errors per component, most first. */
  byComponent: Array<{ component: string; errors: number; warnings: number }>;
  /** The 20 most frequent error messages. */
  top: LogErrorGroup[];
}

/** One thing an app reports about itself. */
export interface ClientLogEvent {
  /** Epoch ms on the app's clock. Default: when the hub got it. */
  ts?: number;
  level: LogLevel;
  /** A short name: connect, reconnect, request.failed, render.error, push.failed... */
  event: string;
  /** A short error message, never text from a chat. */
  msg?: string;
  /** Small flat facts: status, path, attempt, ms. */
  fields?: Record<string, string | number | boolean | null>;
}

/** POST /api/logs/client. */
export interface ClientLogBatch {
  /** web, desktop, iphone, android. */
  app: string;
  version?: string;
  platform?: string;
  events: ClientLogEvent[];
}

export interface ClientLogResult {
  accepted: number;
  /** Over the per-client caps (count or size): dropped, and counted in one line. */
  dropped: number;
}

/** PUT /api/logs/debug. hours 0 turns it off. */
export interface LogsDebugInput {
  hours: number;
}

/** What GET /api/logs/export puts in the zip: the last days of files, summary.md, the config without secrets, device logs. */
export interface LogsExportQuery {
  /** 1, 7 or 28 (any 1 to 28). Default 7. */
  days?: number;
  /** Ask paired devices for their recent daemon log. Default true. */
  devices?: boolean;
}

/** A device daemon's recent log (the logTail RPC). */
export interface DaemonLogTail {
  /** ts or rust. */
  impl: string;
  version?: string;
  /** When this daemon process started (epoch ms). */
  startedAt?: number;
  /** Its own status lines since it started, newest last. */
  lines: string[];
  /** The end of its log file (~/.conclave/logs/daemon.log) when it has one. */
  file?: string[];
}
