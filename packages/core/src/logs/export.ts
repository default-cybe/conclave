/**
 * The logs export: one .zip a developer can read without the hub.
 *
 *   conclave-logs-<hub>-<day>/
 *     summary.md          version, uptime, devices, providers, counts, errors
 *     config.json         the settings with every secret removed
 *     logs/hub-<day>.jsonl  the days asked for, filtered again on the way out
 *     devices/<name>.log  each paired device's recent daemon log
 */
import { redactSecrets } from '../memory/secrets';
import { isReference, redactConfig } from '../engine/backup';
import type { DaemonLogTail, LogsStatus } from '../client/logs';
import { LogReader, parseLine, readLines, type LogStats } from './reader';
import { recleanLine } from './redact';
import { zipStream, type ZipEntry } from './zip';
import type { LogFileInfo } from './sink';

export interface ExportDevice {
  id: string;
  name: string;
  online: boolean;
  platform?: string;
  /** "rust 0.2.0", "ts 0.1.0". */
  daemon?: string;
  lastSeenAt?: number;
}

export interface ExportDaemonLog {
  deviceId: string;
  name: string;
  tail?: DaemonLogTail;
  /** Why there is no tail: offline, too old, it did not answer. */
  error?: string;
}

export interface LogsExportInput {
  reader: LogReader;
  /** 1 to 28. */
  days: number;
  now?: number;
  hub: { name: string; version: string; startedAt?: number };
  status: Pick<LogsStatus, 'dir' | 'keepDays' | 'maxMB' | 'debugUntil' | 'problem'>;
  devices: ExportDevice[];
  /** Names of the providers that are set up, never their keys. */
  providers: string[];
  /** The config as the hub reads it; secrets come out here. */
  config?: Record<string, unknown>;
  daemons: ExportDaemonLog[];
  /** Made by the CLI from the files alone, with no hub running. */
  offline?: boolean;
}

/** conclave-logs-<hub>-<day>.zip */
export function exportFileName(hub: string, now = Date.now()): string {
  return `${exportRoot(hub, now)}.zip`;
}

function exportRoot(hub: string, now: number): string {
  const name = hub.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'hub';
  return `conclave-logs-${name}-${new Date(now).toISOString().slice(0, 10)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The config with every secret out: fields named like secrets (backup's
 * redactConfig), the values of every env and headers map (names stay, as
 * "[set]"), and anything the secrets filter catches in what is left.
 */
export function exportConfig(config: Record<string, unknown>): { config: Record<string, unknown>; removed: number } {
  const first = redactConfig(structuredClone(config));
  let removed = first.redacted.length;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      if (r !== v) removed++;
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if ((key === 'env' || key === 'headers') && typeof val === 'string' && !isReference(val)) {
        out[k] = '[set]';
        removed++;
        continue;
      }
      out[k] = walk(val, k);
    }
    return out;
  };
  return { config: walk(first.config, '') as Record<string, unknown>, removed };
}

const KB = 1024;
function size(n: number): string {
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(1)} KB`;
  return `${(n / KB / KB).toFixed(1)} MB`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** A table cell: no pipes or line breaks. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const list = (rec: Record<string, number>) =>
  Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'device';
}

/** The daemon log file name for a device inside the zip. */
export function deviceLogName(d: { deviceId: string; name: string }): string {
  return `devices/${slug(d.name)}-${d.deviceId.slice(-6)}.log`;
}

/** summary.md: what a developer reads first. */
export function buildSummary(input: LogsExportInput, s: LogStats, files: LogFileInfo[]): string {
  const now = input.now ?? Date.now();
  const out: string[] = [];
  const st = input.status;
  out.push(`# Conclave logs: ${input.hub.name}`, '');
  out.push(`- Version: ${input.hub.version}`);
  out.push(`- Exported: ${utc(now)}, the last ${input.days} day${input.days === 1 ? '' : 's'} (${s.from} to ${s.to}, UTC days)`);
  if (input.offline) out.push('- Made from the files alone: the hub was not running, so devices, providers and daemon logs are missing.');
  else if (input.hub.startedAt) out.push(`- Up for: ${duration(now - input.hub.startedAt)} (since ${utc(input.hub.startedAt)})`);
  const debugOn = st.debugUntil && st.debugUntil > now;
  out.push(`- Logs: ${files.length} file${files.length === 1 ? '' : 's'}, ${size(files.reduce((n, f) => n + f.bytes, 0))}, kept ${st.keepDays} days, cap ${st.maxMB} MB, debug ${debugOn ? `on until ${utc(st.debugUntil!)}` : 'off'}`);
  if (st.problem) out.push(`- Problem writing logs: ${st.problem}`);
  out.push(`- Hub starts in this period: ${s.hubStarts.length}${s.hubStarts.length ? ` (${s.hubStarts.map((h) => `${h.time.slice(0, 16).replace('T', ' ')}${h.version ? ` v${h.version}` : ''}`).join(', ')})` : ''}`);
  out.push(`- Clean stops: ${s.hubStops}. Crashes logged: ${s.crashes}.`);
  out.push('');

  out.push('## Devices', '');
  if (input.devices.length) {
    out.push('| Device | Id | Online | Platform | Daemon | Last seen |', '| --- | --- | --- | --- | --- | --- |');
    for (const d of input.devices) {
      out.push(`| ${cell(d.name)} | ${d.id} | ${d.online ? 'yes' : 'no'} | ${cell(d.platform ?? '')} | ${cell(d.daemon ?? '')} | ${d.lastSeenAt ? utc(d.lastSeenAt) : ''} |`);
    }
  } else out.push('None known.');
  out.push('');

  out.push('## Providers set up', '', input.providers.length ? input.providers.join(', ') : 'None known.', '');

  out.push('## Activity', '');
  const t = s.turns;
  out.push('| What | Count |', '| --- | --- |');
  out.push(`| Turns | ${t.total}${t.total ? ` (${list(t.byStop)})` : ''} |`);
  if (t.total) out.push(`| Turn time, tokens, cost | ${duration(t.durationMs)} total, ${t.inputTokens} in, ${t.outputTokens} out, $${t.costUsd.toFixed(4)} |`);
  out.push(`| Tool calls | ${s.tools.total}${s.tools.failed ? ` (${s.tools.failed} failed)` : ''} |`);
  out.push(`| Approvals | ${s.approvals.asked} asked, ${s.approvals.answered} answered${Object.keys(s.approvals.byDecision).length ? ` (${list(s.approvals.byDecision)})` : ''} |`);
  out.push(`| Questions | ${s.questions.asked} asked, ${s.questions.answered} answered |`);
  out.push(`| Routine runs | ${s.routines.runs}${s.routines.runs ? ` (${list(s.routines.byStatus)})` : ''} |`);
  out.push(`| Device connects | ${s.devices.connects} connects, ${s.devices.disconnects} disconnects |`);
  out.push(`| Friends messages | ${s.peer.in} in, ${s.peer.out} out, ${s.peer.delivered} delivered, ${s.peer.failed} failed |`);
  out.push(`| Imports | ${s.imports} batch changes |`);
  out.push(`| App connections | ${s.ws.connects} connects, ${s.ws.disconnects} disconnects |`);
  out.push(`| HTTP 5xx | ${s.http5xx} |`);
  out.push(`| App lines | ${s.clients.lines}${s.clients.lines ? ` (${Object.entries(s.clients.byApp).map(([a, c]) => `${a} ${c.lines}, ${c.errors} errors`).join('; ')})` : ''} |`);
  out.push(`| All lines | ${s.lines} (error ${s.byLevel.error}, warn ${s.byLevel.warn}, info ${s.byLevel.info}, debug ${s.byLevel.debug}) |`);
  out.push('');

  if (Object.keys(t.byStop).length) {
    const models = Object.entries(s.models).sort((a, b) => b[1].turns - a[1].turns);
    out.push('### Turns by model', '', '| Model | Turns | Errors |', '| --- | --- | --- |');
    for (const [m, c] of models) out.push(`| ${cell(m)} | ${c.turns} | ${c.errors} |`);
    out.push('');
  }
  const failing = Object.entries(s.tools.byTool)
    .filter(([, c]) => c.failed)
    .sort((a, b) => b[1].failed - a[1].failed)
    .slice(0, 10);
  if (failing.length) {
    out.push('### Tools that failed most', '', '| Tool | Calls | Failed |', '| --- | --- | --- |');
    for (const [name, c] of failing) out.push(`| ${cell(name)} | ${c.calls} | ${c.failed} |`);
    out.push('');
  }

  out.push('## Per day', '', '| Day | Lines | Turns | Errors | Warnings |', '| --- | --- | --- | --- | --- |');
  for (const d of s.days) out.push(`| ${d.day} | ${d.lines} | ${d.turns} | ${d.errors} | ${d.warnings} |`);
  if (!s.days.length) out.push('| (no files) | | | | |');
  out.push('');

  out.push('## Errors by component', '');
  const comps = Object.entries(s.byComponent).sort((a, b) => b[1].errors - a[1].errors || b[1].warnings - a[1].warnings);
  if (comps.length) {
    out.push('| Component | Errors | Warnings |', '| --- | --- | --- |');
    for (const [c, n] of comps) out.push(`| ${cell(c)} | ${n.errors} | ${n.warnings} |`);
  } else out.push('No errors or warnings.');
  out.push('');

  out.push('## Top 20 errors', '');
  const top = s.errorGroups.slice(0, 20);
  if (top.length) {
    out.push('| Count | Component | Message | First | Last |', '| --- | --- | --- | --- | --- |');
    for (const g of top) out.push(`| ${g.count} | ${cell(g.component)} | ${cell(g.sample.slice(0, 300))} | ${g.first.slice(0, 16).replace('T', ' ')} | ${g.last.slice(0, 16).replace('T', ' ')} |`);
  } else out.push('No errors.');
  out.push('');

  out.push('## Last errors and warnings', '');
  if (s.recent.length) {
    out.push('| Time (UTC) | Level | Component | Message |', '| --- | --- | --- | --- |');
    for (const r of s.recent) out.push(`| ${r.time.slice(5, 19).replace('T', ' ')} | ${r.level} | ${cell(r.component)} | ${cell(r.text)} |`);
  } else out.push('None.');
  out.push('');

  out.push('## Device daemon logs', '');
  if (input.daemons.length) {
    for (const d of input.daemons) {
      if (d.tail) {
        const what = `${d.tail.lines.length} lines of this run${d.tail.file?.length ? `, ${d.tail.file.length} from its log file` : ''}`;
        out.push(`- ${d.name} (${d.deviceId}): ${d.tail.impl}${d.tail.version ? ` ${d.tail.version}` : ''}, ${what}, in ${deviceLogName(d)}`);
      } else out.push(`- ${d.name} (${d.deviceId}): no log, ${d.error ?? 'unknown'}`);
    }
  } else out.push(input.offline ? 'Not asked: the hub was not running.' : 'No paired devices.');
  out.push('');

  out.push('## Files', '');
  for (const f of files) out.push(`- logs/${f.name}: ${size(f.bytes)}`);
  if (input.config) out.push('- config.json: the settings, with every secret replaced by [redacted] or [set]');
  out.push('');
  out.push('## Reading the files', '');
  out.push('Each line of a .jsonl file is one JSON object: time (UTC), level, component, msg, and fields. Lines an app sent carry client (its id, device, app, version and platform).');
  out.push('Useful messages: "session turn" (one per turn: model, provider, durationMs, tokens, costUsd, stop, error), "tool tool call" (tool, durationMs, ok), "approval approval asked" and "approval approval answered", "routine routine run", "device device connected" and "device device disconnected", "peer message in" and "peer message out", "http server error", "hub unhandled error" (with a stack).');
  out.push('No line holds message text, file contents, tool input or output, tokens, keys or passwords.');
  out.push('With jq: `jq -c \'select(.level=="error")\' logs/*.jsonl`.');
  out.push('');
  // the backstop again: names and messages above come from the files and the devices
  return redactSecrets(out.join('\n'));
}

/** A log file filtered again on the way out, line by line. */
async function* recleanFile(f: LogFileInfo): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  let buf: string[] = [];
  let len = 0;
  for await (const { line } of readLines(f.path, 0, f.bytes)) {
    if (!line) continue;
    // lines were filtered when written; every one is filtered again, as tail does, so a line an older hub or a hand
    // edit left (a field named like a secret or like chat text, a key in a new shape) does not leave in the zip
    const parsed = parseLine(line);
    const text = parsed ? JSON.stringify(recleanLine(parsed as unknown as Record<string, unknown>)) : redactSecrets(line);
    buf.push(text);
    len += text.length + 1;
    if (len > 64 * 1024) {
      yield enc.encode(buf.join('\n') + '\n');
      buf = [];
      len = 0;
    }
  }
  if (buf.length) yield enc.encode(buf.join('\n') + '\n');
}

function daemonLogText(d: ExportDaemonLog): string {
  const t = d.tail!;
  const head = [`# ${d.name} (${d.deviceId}): ${t.impl}${t.version ? ` ${t.version}` : ''}${t.startedAt ? `, running since ${utc(t.startedAt)}` : ''}`];
  const parts = [...head, '', '## This run', ...t.lines.map((l) => redactSecrets(l))];
  if (t.file?.length) parts.push('', '## The end of its log file', ...t.file.map((l) => redactSecrets(l)));
  return parts.join('\n') + '\n';
}

/** The export as a zip stream, with its file name and the summary it holds. */
export async function logsExport(input: LogsExportInput): Promise<{ name: string; summary: string; stream: ReadableStream<Uint8Array> }> {
  const now = input.now ?? Date.now();
  const days = Math.min(Math.max(1, Math.floor(input.days)), 28);
  const files = input.reader.filesFor(days);
  const stats = await input.reader.stats(days);
  const summary = buildSummary({ ...input, days, now }, stats, files);
  const root = exportRoot(input.hub.name, now);
  const entries: ZipEntry[] = [{ name: `${root}/summary.md`, data: summary, mtime: now }];
  if (input.config) entries.push({ name: `${root}/config.json`, data: JSON.stringify(exportConfig(input.config).config, null, 2) + '\n', mtime: now });
  for (const f of files) entries.push({ name: `${root}/logs/${f.name}`, data: () => recleanFile(f), mtime: now });
  for (const d of input.daemons) if (d.tail) entries.push({ name: `${root}/${deviceLogName(d)}`, data: daemonLogText(d), mtime: now });
  return { name: `${root}.zip`, summary, stream: zipStream(entries) };
}
