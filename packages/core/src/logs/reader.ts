/**
 * Reading the log files back: the counts Settings shows, a tail (and a
 * follow from a cursor), errors grouped, and the counts summary.md is made
 * of. Files are read in pieces, never whole, so a big day does not fill the
 * hub's memory.
 */
import type { LogErrorGroup, LogErrorsReport, LogLevel, LogLine, LogsTailQuery, LogsTailResult } from '../client/logs';
import { LEVELS, dayOf, listLogFiles, type LogFileInfo } from './sink';
import { EV } from './names';
import { cleanString, recleanLine } from './redact';

const DAY_MS = 86_400_000;
/** At most this much is read for one tail call. */
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_TAIL_LINES = 1000;

/** Each whole line between start and end (bytes), with the offset just after it. A half line at the end is left out. */
export async function* readLines(path: string, start: number, end: number): AsyncIterable<{ line: string; next: number }> {
  if (end <= start) return;
  const decoder = new TextDecoder();
  let rest = '';
  let consumed = start;
  const reader = Bun.file(path).slice(start, end).stream().getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    const text = rest + decoder.decode(chunk, { stream: true });
    const lines = text.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      consumed += Buffer.byteLength(line) + 1;
      yield { line, next: consumed };
    }
  }
}

/**
 * Call fn for each whole line between start and end (bytes). Returns the
 * offset after the last whole line, so a half-written line at the end is
 * read next time.
 */
export async function forEachLine(path: string, start: number, end: number, fn: (line: string) => void): Promise<number> {
  let consumed = start;
  for await (const { line, next } of readLines(path, start, end)) {
    consumed = next;
    if (line) fn(line);
  }
  return consumed;
}

export function parseLine(text: string): LogLine | undefined {
  try {
    const v = JSON.parse(text) as LogLine;
    return v && typeof v === 'object' && typeof v.msg === 'string' && typeof v.level === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Fold ids, numbers and times so the same error groups whatever it was about. */
export function foldMessage(s: string): string {
  return s
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[a-z]{2,10}_[A-Za-z0-9]{6,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** What an error line says: its message, and the error it carries. */
export function errorText(l: LogLine): string {
  const f = l.fields ?? {};
  const err = typeof f.error === 'string' ? f.error : typeof f.title === 'string' ? f.title : '';
  return err && !l.msg.includes(err) ? `${l.msg}: ${err}` : l.msg;
}

function matches(l: LogLine, q: { level?: LogLevel; component?: string }): boolean {
  if (q.level && (LEVELS[l.level] ?? 0) < LEVELS[q.level]) return false;
  if (q.component && l.component !== q.component && !l.component.startsWith(`${q.component}.`)) return false;
  return true;
}

/** A line read back goes through the secrets filter again: it may come from an older hub or a file edited by hand. */
function reclean(l: LogLine): LogLine {
  return recleanLine(l as unknown as Record<string, unknown>) as unknown as LogLine;
}

/** "2026-10-21:1234": a day and a byte offset in its file. */
export function parseCursor(c: string | undefined): { day: string; offset: number } | undefined {
  const m = c ? /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(c) : null;
  return m ? { day: m[1], offset: Number(m[2]) } : undefined;
}

/** Counts over a range of days: the summary and the errors report are made of these. */
export interface LogStats {
  from: string;
  to: string;
  lines: number;
  byLevel: Record<LogLevel, number>;
  /** Per day: lines, errors, warnings, turns. */
  days: Array<{ day: string; lines: number; errors: number; warnings: number; turns: number }>;
  turns: { total: number; byStop: Record<string, number>; durationMs: number; costUsd: number; inputTokens: number; outputTokens: number };
  /** Turns per model ref. */
  models: Record<string, { turns: number; errors: number }>;
  tools: { total: number; failed: number; byTool: Record<string, { calls: number; failed: number }> };
  approvals: { asked: number; answered: number; byDecision: Record<string, number> };
  questions: { asked: number; answered: number };
  routines: { runs: number; byStatus: Record<string, number> };
  devices: { connects: number; disconnects: number; byDevice: Record<string, { connects: number; disconnects: number }> };
  peer: { in: number; out: number; delivered: number; failed: number };
  imports: number;
  ws: { connects: number; disconnects: number };
  http5xx: number;
  hubStarts: Array<{ time: string; version?: string }>;
  hubStops: number;
  crashes: number;
  clients: { lines: number; errors: number; byApp: Record<string, { lines: number; errors: number }> };
  byComponent: Record<string, { errors: number; warnings: number }>;
  errorGroups: LogErrorGroup[];
  /** The last 30 errors and warnings, oldest first: time, level, component and what they said. */
  recent: Array<{ time: string; level: LogLevel; component: string; text: string }>;
}

function emptyStats(from: string, to: string): LogStats {
  return {
    from,
    to,
    lines: 0,
    byLevel: { debug: 0, info: 0, warn: 0, error: 0 },
    days: [],
    turns: { total: 0, byStop: {}, durationMs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    models: {},
    tools: { total: 0, failed: 0, byTool: {} },
    approvals: { asked: 0, answered: 0, byDecision: {} },
    questions: { asked: 0, answered: 0 },
    routines: { runs: 0, byStatus: {} },
    devices: { connects: 0, disconnects: 0, byDevice: {} },
    peer: { in: 0, out: 0, delivered: 0, failed: 0 },
    imports: 0,
    ws: { connects: 0, disconnects: 0 },
    http5xx: 0,
    hubStarts: [],
    hubStops: 0,
    crashes: 0,
    clients: { lines: 0, errors: 0, byApp: {} },
    byComponent: {},
    errorGroups: [],
    recent: [],
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bump = (rec: Record<string, number>, k: string, n = 1) => (rec[k] = (rec[k] ?? 0) + n);

export class LogReader {
  /** Per file: how far it was counted, and its errors and warnings up to there. */
  private counted = new Map<string, { offset: number; errors: number; warnings: number }>();

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  files(): LogFileInfo[] {
    return listLogFiles(this.dir);
  }

  /** The files of the last `days` days, today included, oldest first. */
  filesFor(days: number): LogFileInfo[] {
    const first = dayOf(this.now() - (Math.max(1, days) - 1) * DAY_MS);
    return this.files().filter((f) => f.day >= first);
  }

  /** Errors and warnings in one file; only what was added since the last call is read. */
  async levelCounts(f: LogFileInfo): Promise<{ errors: number; warnings: number }> {
    let c = this.counted.get(f.name);
    if (!c || c.offset > f.bytes) c = { offset: 0, errors: 0, warnings: 0 };
    if (c.offset < f.bytes) {
      const next = { ...c };
      next.offset = await forEachLine(f.path, c.offset, f.bytes, (line) => {
        if (line.includes('"level":"error"')) next.errors++;
        else if (line.includes('"level":"warn"')) next.warnings++;
      });
      c = next;
      this.counted.set(f.name, c);
    }
    return { errors: c.errors, warnings: c.warnings };
  }

  async counts(): Promise<{ errorsToday: number; warningsToday: number; errorsWeek: number }> {
    const today = dayOf(this.now());
    let errorsToday = 0;
    let warningsToday = 0;
    let errorsWeek = 0;
    for (const f of this.filesFor(7)) {
      const c = await this.levelCounts(f);
      errorsWeek += c.errors;
      if (f.day === today) {
        errorsToday = c.errors;
        warningsToday = c.warnings;
      }
    }
    // files of days that are gone need no counts
    const names = new Set(this.files().map((f) => f.name));
    for (const k of this.counted.keys()) if (!names.has(k)) this.counted.delete(k);
    return { errorsToday, warningsToday, errorsWeek };
  }

  /** The last lines, or (with after) the lines written since a cursor. */
  async tail(q: LogsTailQuery = {}): Promise<LogsTailResult> {
    const want = Math.min(Math.max(1, Math.floor(q.lines ?? 100)), MAX_TAIL_LINES);
    const files = this.files();
    const last = files[files.length - 1];
    const end = last ? `${last.day}:${last.bytes}` : `${dayOf(this.now())}:0`;
    const after = parseCursor(q.after);
    if (after) {
      const out: LogLine[] = [];
      let cursor = q.after!;
      let budget = TAIL_BYTES;
      for (const f of files) {
        if (f.day < after.day) continue;
        const from = f.day === after.day ? Math.min(after.offset, f.bytes) : 0;
        const to = Math.min(f.bytes, from + budget);
        const offset = await forEachLine(f.path, from, to, (text) => {
          const l = parseLine(text);
          if (l && matches(l, q)) out.push(reclean(l));
        });
        budget -= offset - from;
        cursor = `${f.day}:${offset}`;
        if (budget <= 0 || offset < f.bytes) break;
      }
      return { lines: out.slice(-MAX_TAIL_LINES), cursor };
    }
    // newest file first, reading back until enough lines match
    const found: LogLine[][] = [];
    let count = 0;
    let budget = TAIL_BYTES;
    for (let i = files.length - 1; i >= 0 && count < want && budget > 0; i--) {
      const f = files[i];
      const from = Math.max(0, f.bytes - budget);
      const lines: LogLine[] = [];
      let skipFirst = from > 0;
      await forEachLine(f.path, from, f.bytes, (text) => {
        // starting in the middle of the file: the first piece is half a line
        if (skipFirst) {
          skipFirst = false;
          return;
        }
        const l = parseLine(text);
        if (l && matches(l, q)) lines.push(reclean(l));
      });
      budget -= f.bytes - from;
      found.unshift(lines);
      count += lines.length;
    }
    return { lines: found.flat().slice(-want), cursor: end };
  }

  /** Every count over the last `days` days (today included). */
  async stats(days: number): Promise<LogStats> {
    const files = this.filesFor(days);
    const from = dayOf(this.now() - (Math.max(1, days) - 1) * DAY_MS);
    const s = emptyStats(from, dayOf(this.now()));
    const groups = new Map<string, LogErrorGroup>();
    for (const f of files) {
      const day = { day: f.day, lines: 0, errors: 0, warnings: 0, turns: 0 };
      await forEachLine(f.path, 0, f.bytes, (text) => {
        const l = parseLine(text);
        if (!l) return;
        s.lines++;
        day.lines++;
        if (l.level in s.byLevel) s.byLevel[l.level]++;
        const fl = l.fields ?? {};
        const comp = l.component;
        if (l.level === 'error' || l.level === 'warn') {
          s.recent.push({ time: l.time, level: l.level, component: comp, text: cleanString(errorText(l), 300) });
          if (s.recent.length > 30) s.recent.shift();
          const c = (s.byComponent[comp] ??= { errors: 0, warnings: 0 });
          if (l.level === 'error') {
            c.errors++;
            day.errors++;
            const sample = cleanString(errorText(l), 400);
            const key = `${comp}\u0000${foldMessage(sample)}`;
            const g = groups.get(key);
            if (g) {
              g.count++;
              g.last = l.time;
            } else groups.set(key, { component: comp, msg: foldMessage(sample), sample: sample.slice(0, 400), count: 1, first: l.time, last: l.time });
          } else {
            c.warnings++;
            day.warnings++;
          }
        }
        if (l.client) {
          s.clients.lines++;
          const a = (s.clients.byApp[l.client.app || 'app'] ??= { lines: 0, errors: 0 });
          a.lines++;
          if (l.level === 'error') {
            s.clients.errors++;
            a.errors++;
          }
          return;
        }
        switch (`${comp} ${l.msg}`) {
          case EV.turn: {
            s.turns.total++;
            day.turns++;
            bump(s.turns.byStop, String(fl.stop ?? 'unknown'));
            s.turns.durationMs += num(fl.durationMs);
            s.turns.costUsd += num(fl.costUsd);
            s.turns.inputTokens += num(fl.inputTokens);
            s.turns.outputTokens += num(fl.outputTokens);
            const m = (s.models[String(fl.model ?? 'unknown')] ??= { turns: 0, errors: 0 });
            m.turns++;
            if (fl.stop === 'error') m.errors++;
            break;
          }
          case EV.tool: {
            s.tools.total++;
            const t = (s.tools.byTool[String(fl.tool ?? 'unknown')] ??= { calls: 0, failed: 0 });
            t.calls++;
            if (fl.ok === false) {
              s.tools.failed++;
              t.failed++;
            }
            break;
          }
          case EV.approvalAsked:
            s.approvals.asked++;
            break;
          case EV.approvalAnswered:
            s.approvals.answered++;
            bump(s.approvals.byDecision, String(fl.decision ?? 'unknown'));
            break;
          case EV.questionAsked:
            s.questions.asked++;
            break;
          case EV.questionAnswered:
            s.questions.answered++;
            break;
          case EV.routineRun:
            s.routines.runs++;
            bump(s.routines.byStatus, String(fl.status ?? 'unknown'));
            break;
          case EV.deviceConnected:
          case EV.deviceDisconnected: {
            const connected = `${comp} ${l.msg}` === EV.deviceConnected;
            const d = (s.devices.byDevice[String(fl.name ?? fl.deviceId ?? 'unknown')] ??= { connects: 0, disconnects: 0 });
            if (connected) {
              s.devices.connects++;
              d.connects++;
            } else {
              s.devices.disconnects++;
              d.disconnects++;
            }
            break;
          }
          case EV.peerIn:
            s.peer.in++;
            break;
          case EV.peerOut:
            s.peer.out++;
            break;
          case EV.peerDelivered:
            s.peer.delivered++;
            break;
          case EV.peerFailed:
            s.peer.failed++;
            break;
          case EV.importBatch:
            s.imports++;
            break;
          case EV.wsConnected:
            s.ws.connects++;
            break;
          case EV.wsDisconnected:
            s.ws.disconnects++;
            break;
          case EV.http5xx:
            s.http5xx++;
            break;
          case EV.hubStarted:
            s.hubStarts.push({ time: l.time, ...(typeof fl.version === 'string' ? { version: fl.version } : {}) });
            break;
          case EV.hubStopped:
            s.hubStops++;
            break;
          case EV.crash:
            s.crashes++;
            break;
        }
      });
      s.days.push(day);
    }
    s.errorGroups = [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
    return s;
  }

  async errors(days: number): Promise<LogErrorsReport> {
    const s = await this.stats(days);
    return {
      days,
      from: s.from,
      to: s.to,
      errors: s.byLevel.error,
      warnings: s.byLevel.warn,
      byComponent: Object.entries(s.byComponent)
        .map(([component, c]) => ({ component, ...c }))
        .sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || a.component.localeCompare(b.component)),
      top: s.errorGroups.slice(0, 20),
    };
  }
}
