/**
 * `conclave logs`: the hub's log files (docs/DESIGN.md 33).
 *
 *   conclave logs                       where they are, size, errors today and this week
 *   conclave logs tail [-f]             the last lines; -f keeps following
 *   conclave logs errors [--days 7]     errors grouped by message
 *   conclave logs export [--days 7] [-o file.zip]
 *   conclave logs debug <hours|off>     debug lines for a while
 *
 * With the hub on this machine stopped, tail, errors and export read the
 * files in ~/.conclave/logs directly, so a crash can still be looked at.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { ConclaveClient, LogErrorsReport, LogLevel, LogLine, LogsStatus, LogsTailQuery, LogsTailResult } from '@conclave/core/client/index.ts';
import { parseJsonc } from '@conclave/core/config/index.ts';
import { out as p } from '../ansi';
import { bool, num, str, type ParsedArgs } from '../args';
import { cliPaths } from '../files';
import { currentHub } from '../hub';
import { CliError, describeError, getClient, json, print, table } from './shared';
import { VERSION } from '../version';

const USAGE = `conclave logs                         where the hub's logs are, their size and today's errors
conclave logs tail [-f] [--lines N] [--level warn] [--component session] [--json]
conclave logs errors [--days 7] [--json]
conclave logs export [--days 1|7|28] [-o file.zip] [--no-devices]
conclave logs debug <hours|off>       write debug lines for a while (up to 168 hours)`;

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** The hub, or the files on this machine when the local hub is not running. */
type Source = { kind: 'hub'; client: ConclaveClient } | { kind: 'files'; dir: string };

async function source(args: ParsedArgs, needHub = false): Promise<Source> {
  try {
    const { client } = await getClient(args, { autostart: false, quiet: true });
    return { kind: 'hub', client };
  } catch (err) {
    const target = currentHub({ hub: str(args, 'hub'), token: str(args, 'token') });
    const dir = cliPaths().logs;
    if (!needHub && target.local && existsSync(dir)) {
      process.stderr.write(p.dim(`The hub at ${target.url} is not running; reading ${dir}.\n`));
      return { kind: 'files', dir };
    }
    throw err instanceof CliError ? err : new CliError(describeError(err));
  }
}

async function reader(dir: string) {
  const { LogReader } = await import('@conclave/core/logs/reader.ts');
  return new LogReader(dir);
}

function level(args: ParsedArgs): LogLevel | undefined {
  const v = str(args, 'level');
  if (!v) return undefined;
  if (!LEVELS.includes(v as LogLevel)) throw new CliError(`--level is one of ${LEVELS.join(', ')}.`, 2);
  return v as LogLevel;
}

function days(args: ParsedArgs, def: number): number {
  const n = num(args, 'days') ?? def;
  if (!Number.isInteger(n) || n < 1 || n > 28) throw new CliError('--days is a whole number from 1 to 28.', 2);
  return n;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One line for a terminal: time, level, component, message, then the fields. */
export function formatLine(l: LogLine, painter = p): string {
  const time = l.time.slice(11, 19);
  const lv = l.level.toUpperCase().padEnd(5);
  const tint = l.level === 'error' ? painter.red : l.level === 'warn' ? painter.yellow : l.level === 'debug' ? painter.dim : (s: string) => s;
  const who = l.client ? painter.cyan(`[${[l.client.app, l.client.platform, l.client.device].filter(Boolean).join(' ')}] `) : '';
  const fields = Object.entries(l.fields ?? {})
    .filter(([k]) => k !== 'stack')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? (/[\s"]/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
    .join(' ');
  const stack = typeof l.fields?.stack === 'string' ? `\n${painter.dim(l.fields.stack)}` : '';
  return `${painter.dim(time)} ${tint(lv)} ${painter.bold(l.component)} ${who}${l.msg}${fields ? ` ${painter.dim(fields)}` : ''}${stack}`;
}

async function status(args: ParsedArgs): Promise<number> {
  const src = await source(args);
  let s: LogsStatus;
  if (src.kind === 'hub') s = await src.client.logs();
  else {
    const r = await reader(src.dir);
    const files = r.files();
    s = { dir: src.dir, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), oldest: files[0]?.day, newest: files[files.length - 1]?.day, keepDays: 28, maxMB: 500, ...(await r.counts()) };
  }
  if (bool(args, 'json')) return json(s), 0;
  print(p.bold('Hub logs'));
  print(
    table(
      [
        ['Folder', s.dir],
        ['Files', `${s.files} (${size(s.bytes)})${s.oldest ? `, ${s.oldest} to ${s.newest}` : ''}`],
        ['Kept', `${s.keepDays} days, at most ${s.maxMB} MB`],
        ['Errors', `${s.errorsToday} today, ${s.errorsWeek} this week (${s.warningsToday} warnings today)`],
        ['Debug', s.debugUntil ? `on until ${new Date(s.debugUntil).toLocaleString()}` : 'off'],
        ...(s.problem ? [['Problem', p.red(s.problem)]] : []),
      ].map(([a, b]) => [p.dim(a), b]),
    ),
  );
  print(p.dim('\nconclave logs tail -f   conclave logs errors   conclave logs export -o logs.zip'));
  return 0;
}

async function tail(args: ParsedArgs): Promise<number> {
  const src = await source(args);
  const q: LogsTailQuery = { lines: num(args, 'lines') ?? num(args, 'limit') ?? 50, level: level(args), component: str(args, 'component') };
  const get = async (after?: string): Promise<LogsTailResult> => {
    const query = { ...q, ...(after ? { after } : {}) };
    return src.kind === 'hub' ? src.client.logsTail(query) : (await reader(src.dir)).tail(query);
  };
  const show = (lines: LogLine[]) => {
    for (const l of lines) print(bool(args, 'json') ? JSON.stringify(l) : formatLine(l));
  };
  let r = await get();
  show(r.lines);
  if (!(bool(args, 'f') || bool(args, 'follow'))) return 0;
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((res) => setTimeout(res, 1000));
    try {
      r = await get(r.cursor);
      show(r.lines);
    } catch (err) {
      process.stderr.write(p.dim(`(${describeError(err)}; trying again)\n`));
    }
  }
  return 0;
}

export function printErrors(rep: LogErrorsReport): void {
  print(p.bold(`Errors, the last ${rep.days} day${rep.days === 1 ? '' : 's'} (${rep.from} to ${rep.to})`));
  print(`  ${rep.errors ? p.red(`${rep.errors} errors`) : '0 errors'}, ${rep.warnings} warnings`);
  if (rep.byComponent.length) {
    print('');
    print(table(rep.byComponent.map((c) => [c.component, String(c.errors), String(c.warnings)]), { header: ['COMPONENT', 'ERRORS', 'WARNINGS'] }));
  }
  if (rep.top.length) {
    print('');
    print(
      table(
        rep.top.map((g) => [String(g.count), g.component, g.sample.length > 110 ? `${g.sample.slice(0, 107)}...` : g.sample, g.last.slice(0, 16).replace('T', ' ')]),
        { header: ['COUNT', 'COMPONENT', 'MESSAGE', 'LAST (UTC)'] },
      ),
    );
  }
}

async function errors(args: ParsedArgs): Promise<number> {
  const n = days(args, 7);
  const src = await source(args);
  const rep = src.kind === 'hub' ? await src.client.logErrors(n) : await (await reader(src.dir)).errors(n);
  if (bool(args, 'json')) return json(rep), 0;
  printErrors(rep);
  return 0;
}

/** config.json of this machine's hub, for an export made from the files. */
function localConfig(): Record<string, unknown> | undefined {
  try {
    return parseJsonc<Record<string, unknown>>(readFileSync(cliPaths().config, 'utf8'));
  } catch {
    return undefined;
  }
}

async function exportLogs(args: ParsedArgs): Promise<number> {
  const n = days(args, 7);
  const src = await source(args);
  const outArg = str(args, 'out');
  let file: string;
  if (src.kind === 'hub') {
    const res = await src.client.logsExportResponse({ days: n, devices: args.flags.devices === false ? false : undefined });
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'conclave-logs.zip';
    file = resolve(outArg ?? name);
    await Bun.write(file, res);
  } else {
    const { logsExport } = await import('@conclave/core/logs/export.ts');
    const r = await reader(src.dir);
    const cfg = localConfig();
    const logsCfg = (cfg?.logs ?? {}) as { keepDays?: number; maxMB?: number; debugUntil?: number };
    const made = await logsExport({
      reader: r,
      days: n,
      hub: { name: hostname(), version: VERSION },
      status: { dir: src.dir, keepDays: logsCfg.keepDays ?? 28, maxMB: logsCfg.maxMB ?? 500, ...(logsCfg.debugUntil ? { debugUntil: logsCfg.debugUntil } : {}) },
      devices: [],
      providers: [],
      ...(cfg ? { config: cfg } : {}),
      daemons: [],
      offline: true,
    });
    file = resolve(outArg ?? made.name);
    await Bun.write(file, new Response(made.stream));
  }
  const bytes = Bun.file(file).size;
  print(`${p.green('✓')} Saved ${p.bold(file)} ${p.dim(`(${size(bytes)}, the last ${n} day${n === 1 ? '' : 's'})`)}`);
  print(p.dim('  It holds the log files, summary.md and the settings with secrets removed. No chat text, keys or passwords.'));
  return 0;
}

async function debug(args: ParsedArgs): Promise<number> {
  const v = args._[2];
  if (!v) throw new CliError(`Usage: conclave logs debug <hours|off>`, 2);
  const hours = v === 'off' ? 0 : Number(v);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) throw new CliError('Give hours from 1 to 168, or off.', 2);
  const src = await source(args, true);
  if (src.kind !== 'hub') throw new CliError('The hub is not running.');
  const s = await src.client.setLogsDebug(hours);
  print(s.debugUntil ? `${p.green('✓')} Debug lines until ${new Date(s.debugUntil).toLocaleString()}.` : `${p.green('✓')} Debug lines off.`);
  return 0;
}

export async function logsCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1];
  switch (sub) {
    case undefined:
    case 'status':
      return status(args);
    case 'tail':
      return tail(args);
    case 'errors':
      return errors(args);
    case 'export':
      return exportLogs(args);
    case 'debug':
      return debug(args);
    default:
      throw new CliError(`Unknown logs command "${sub}".\n${USAGE}`, 2);
  }
}
