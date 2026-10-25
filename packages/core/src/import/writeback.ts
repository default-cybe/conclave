/**
 * Conclave to Claude Code, the other half of import sync (ledger.ts): turns
 * Conclave ran with its own models on an imported Claude Code chat are
 * appended to the chat's .jsonl in Claude Code's own row format, so
 * `claude --resume` shows them, and the next import finds them already there
 * (the service gives each written message the importer's id of its row).
 *
 * The hub reads the tail of the file and builds the rows (buildRows,
 * checkRows). The device that holds the file appends them (appendSession, the
 * importAppend RPC): never while a Claude Code process has the chat open,
 * never when the file is not the one the hub read, in one O_APPEND write.
 *
 * Thinking is never written, from any model. Another model's thinking must
 * not reach Claude Code, and Claude's own signed thinking is bound to the
 * account that signed it: one block Claude Code cannot replay makes the API
 * refuse the whole resumed chat.
 */
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ContentBlock, Message, ToolResultBlock } from '../types';
import type { Machine } from '../machine/types';
import { convertClaudeCode } from '../importers/claude-code';
import { externalId } from '../importers/types';
import { oneLine } from '../util/text';
import type { ImportAppendParams, ImportAppendResult } from './types';

/** Claude Code's own tools. A tool_use it does not know would break its resume, so other calls become a text line. */
const ALLOW = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit', 'Agent']);
const RENAME: Record<string, string> = { Task: 'Agent' };
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE = 5 * 1024 * 1024;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** How much of the file the hub reads to find the leaf. */
export const TAIL_WINDOW = 4 * 1024 * 1024;
/** The bytes whose hash says the file is still the one the hub read. */
export const TAIL_HASH_BYTES = 4096;

type Row = Record<string, any>;

const b62 = (n: number) => [...randomBytes(n)].map((b) => B62[b % 62]).join('');
const isMsg = (r: Row) => ['user', 'assistant', 'system', 'attachment'].includes(r.type) && typeof r.uuid === 'string';

export function tailHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes.subarray(Math.max(0, bytes.length - TAIL_HASH_BYTES))).digest('hex');
}

/** Whole lines of a tail window; the first one is cut when the window does not start the file. */
export function parseRows(text: string, cutHead: boolean): Row[] {
  const lines = text.split('\n');
  if (cutHead) lines.shift();
  lines.pop();
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Claude Code's rule: the last non-sidechain message row in file order. */
export function leafClaude(rows: Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (isMsg(rows[i]) && !rows[i].isSidechain) return rows[i].uuid;
}

/**
 * The importer's rule (importers/claude-code.ts activeLines): the last
 * last-prompt's leaf, then the newest child down to the end. Undefined when
 * that leaf is not in a window that does not start the file.
 */
export function leafImporter(rows: Row[], whole: boolean): string | undefined {
  const kids = new Map<string, Row[]>();
  const by = new Set<string>();
  const retracted = new Set<string>();
  let leaf: string | undefined;
  for (const r of rows) {
    if (typeof r.uuid === 'string') by.add(r.uuid);
    if (typeof r.parentUuid === 'string') kids.set(r.parentUuid, [...(kids.get(r.parentUuid) ?? []), r]);
    if (r.type === 'last-prompt' && typeof r.leafUuid === 'string') leaf = r.leafUuid;
    if ((r.type === 'model_refusal_fallback' || r.subtype === 'model_refusal_fallback') && Array.isArray(r.retractedMessageUuids)) for (const id of r.retractedMessageUuids) retracted.add(id);
  }
  if (!leaf || !by.has(leaf)) return whole ? leafClaude(rows) : undefined;
  for (let g = 0; g < 100_000; g++) {
    const k = (kids.get(leaf) ?? []).filter((c) => !retracted.has(c.uuid) && !c.isSidechain);
    if (!k.length) break;
    leaf = k[k.length - 1].uuid as string;
  }
  return leaf;
}

function resultText(c: ToolResultBlock['content']): string {
  if (typeof c === 'string') return c;
  return c.map((b) => (b.type === 'text' ? b.text : `[${b.type} not copied from Conclave]`)).join('\n');
}

function userContent(blocks: ContentBlock[]): Row[] {
  const out: Row[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text.trim()) out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.data && IMAGE_TYPES.test(b.mediaType) && (b.data.length * 3) / 4 <= MAX_IMAGE) {
      out.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } });
    } else if (b.type !== 'tool_result') out.push({ type: 'text', text: `[${b.type} not copied from Conclave]` });
  }
  return out;
}

/**
 * Rows for Conclave messages, chained after `leaf`. `base` holds the
 * session fields of the file's last row (sessionId, cwd, version, gitBranch,
 * entrypoint). Asides, summaries and notices stay in Conclave. Every
 * tool_use written gets its result in the next row ("interrupted" when
 * Conclave has none).
 */
export function buildRows(msgs: Message[], base: Row, leaf: string, after = 0): Row[] {
  const results = new Map<string, ToolResultBlock>();
  for (const m of msgs) for (const b of m.content) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  const ids = new Map<string, string>();
  const out: Row[] = [];
  let parent = leaf;
  let ts = Math.max(Date.now(), after + 1);
  let open: string[] = [];
  const push = (m: Message, type: 'user' | 'assistant', message: Row) => {
    const uuid = randomUUID();
    out.push({ parentUuid: parent, isSidechain: false, userType: 'external', ...base, type, message, uuid, timestamp: new Date(ts++).toISOString(), conclave: { v: 1, messageId: m.id } });
    parent = uuid;
  };
  const interrupted = () => {
    const rows = open.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'interrupted in Conclave', is_error: true }));
    open = [];
    return rows;
  };
  for (const m of msgs) {
    if (m.kind !== 'normal') continue;
    if (m.role === 'assistant') {
      if (open.length) push(m, 'user', { role: 'user', content: interrupted() });
      const content: Row[] = [];
      for (const b of m.content) {
        // thinking and redacted_thinking: never written, from any model (top of file)
        if (b.type === 'text' && b.text.trim()) content.push({ type: 'text', text: b.text });
        if (b.type !== 'tool_use') continue;
        const name = RENAME[b.name] ?? b.name;
        if (ALLOW.has(name)) {
          const id = `toolu_cv_${b62(20)}`;
          ids.set(b.id, id);
          open.push(id);
          content.push({ type: 'tool_use', id, name, input: b.input });
          continue;
        }
        const r = results.get(b.id);
        const res = r ? `${r.isError ? 'error: ' : ''}${oneLine(resultText(r.content), 200)}` : 'interrupted';
        content.push({ type: 'text', text: `[Conclave tool ${b.name}: ${oneLine(JSON.stringify(b.input), 200)} → ${res}]` });
      }
      if (!content.length) continue;
      const model = m.model || 'conclave';
      push(m, 'assistant', { id: `msg_cv_${Date.now().toString(36)}${b62(16)}`, type: 'message', role: 'assistant', model, content, stop_reason: open.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
      continue;
    }
    const content: Row[] = [];
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const id = ids.get(b.toolUseId);
      if (!id || !open.includes(id)) continue;
      open = open.filter((x) => x !== id);
      content.push({ type: 'tool_result', tool_use_id: id, content: resultText(b.content), ...(b.isError ? { is_error: true } : {}) });
    }
    // the API wants tool results first in a user turn
    content.push(...interrupted(), ...userContent(m.content));
    if (content.length) push(m, 'user', { role: 'user', content });
  }
  if (open.length && msgs.length) push(msgs[msgs.length - 1], 'user', { role: 'user', content: interrupted() });
  return out;
}

/** What Claude Code needs of the new rows. Returns the failures; the rows are written only without any. */
export function checkRows(added: Row[], leaf: string, sessionId: string): string[] {
  const f: string[] = [];
  const seen = new Set<string>();
  added.forEach((r, i) => {
    const s = JSON.stringify(r);
    if (/"type":"(redacted_)?thinking"/.test(s)) f.push(`row ${i} has a thinking block`);
    if (/"signature"\s*:/.test(s)) f.push(`row ${i} has a signature`);
    if (r.parentUuid !== (i === 0 ? leaf : added[i - 1].uuid)) f.push(`row ${i} breaks the parentUuid chain`);
    if (seen.has(r.uuid)) f.push(`row ${i} reuses a uuid`);
    seen.add(r.uuid);
    if (r.sessionId !== sessionId) f.push(`row ${i} has another sessionId`);
    if (typeof r.cwd !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(r.cwd)) f.push(`row ${i} has no absolute cwd`);
    if (r.isSidechain !== false) f.push(`row ${i} is a sidechain`);
    if (r.type === 'assistant' && (!r.message.model || String(r.message.model).startsWith('<'))) f.push(`row ${i} has no model`);
    const content: Row[] = Array.isArray(r.message?.content) ? r.message.content : [];
    for (const b of content) {
      if (b.type === 'tool_use') {
        if (!ALLOW.has(b.name) || !NAME_RE.test(b.id) || seen.has(b.id)) f.push(`row ${i} tool ${b.name} ${b.id}`);
        seen.add(b.id);
        const next = added[i + 1];
        if (!(next?.type === 'user' && next.message.content.some((x: Row) => x.type === 'tool_result' && x.tool_use_id === b.id))) f.push(`row ${i} tool_use ${b.id} has no result in the next row`);
      }
      if (b.type === 'image' && (b.source?.type !== 'base64' || !IMAGE_TYPES.test(b.source?.media_type) || (String(b.source?.data ?? '').length * 3) / 4 > MAX_IMAGE)) f.push(`row ${i} has a bad image`);
    }
  });
  return f;
}

// ---------------------------------------------------------------------------
// the device: busy check and append (the importAppend RPC)
// ---------------------------------------------------------------------------

const CLAUDE_BIN = /(^|[/\\])claude(\.exe)?$|claude-code[/\\]cli\.m?js$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * A live Claude Code process with this chat open: its entry in
 * <claude dir>/sessions (the file sits in <claude dir>/projects/<project>/),
 * or on Linux a claude process with the chat id in its arguments or running
 * in the chat's folder (a resume picks a chat after it started).
 */
export function busySession(path: string, sessionId: string, cwd?: string): string | undefined {
  const dir = join(dirname(dirname(dirname(path))), 'sessions');
  if (existsSync(dir)) {
    for (const n of readdirSync(dir)) {
      try {
        const s = JSON.parse(readFileSync(join(dir, n), 'utf8'));
        if (s?.sessionId === sessionId && Number.isInteger(s.pid) && s.pid !== process.pid && alive(s.pid)) return `sessions/${n} pid ${s.pid}`;
      } catch {}
    }
  }
  // shortcut: no /proc on macOS or Windows, so only the sessions entry counts there; add a ps scan if a device shows the gap
  if (!existsSync('/proc')) return undefined;
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      if (!argv.slice(0, 2).some((a) => CLAUDE_BIN.test(a))) continue;
      if (argv.some((a) => a.includes(sessionId))) return `pid ${p} has the chat in its arguments`;
      if (cwd && readlinkSync(`/proc/${p}/cwd`) === cwd) return `pid ${p} runs in ${cwd}`;
    } catch {}
  }
  return undefined;
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'EINVAL' });
}

/** importAppend on this machine: busy, changed, partialTail, else one append and fsync. */
export function appendSession(p: ImportAppendParams): ImportAppendResult {
  if (!SESSION_RE.test(p.sessionId) || basename(p.path) !== `${p.sessionId}.jsonl`) throw invalid('importAppend needs a Claude Code session file named after its session id.');
  if (typeof p.text !== 'string' || !p.text.endsWith('\n') || typeof p.expect?.size !== 'number' || typeof p.expect.tail !== 'string') throw invalid('importAppend needs whole lines and the file the hub read.');
  const busy = busySession(p.path, p.sessionId, p.cwd);
  if (busy) return { ok: false, reason: 'busy', detail: busy };
  // read and append through one descriptor; no O_CREAT, so a file that is gone stays gone
  const fd = openSync(p.path, constants.O_RDWR | constants.O_APPEND);
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(TAIL_HASH_BYTES, size);
    const buf = Buffer.alloc(n);
    if (n) readSync(fd, buf, 0, n, size - n);
    if (size !== p.expect.size || tailHash(buf) !== p.expect.tail) return { ok: false, reason: 'changed' };
    if (n && buf[n - 1] !== 0x0a) return { ok: false, reason: 'partialTail' };
    writeSync(fd, p.text);
    fsyncSync(fd);
    const st = fstatSync(fd);
    return { ok: true, size: st.size, mtime: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// the hub
// ---------------------------------------------------------------------------

/** ids: the importer's id of each new message, in file order, with the Conclave message its row came from. */
export type WriteBackResult = { ok: true; ids: Array<{ id: string; messageId: string }>; size: number; mtime: number } | { ok: false; reason: string };

/**
 * Write Conclave messages into the Claude Code chat at `path` on `machine`.
 * `size` is the file's size at the last import: a file that grew since has
 * Claude Code turns Conclave has not seen, and a sync handles it. On success
 * `ids` are the message ids the importer gives the new rows.
 */
export async function writeBack(machine: Machine, path: string, msgs: Message[], size: number | undefined): Promise<WriteBackResult> {
  if (!machine.importAppend || !machine.readRange) return { ok: false, reason: 'the device runs a daemon without importAppend' };
  const st = await machine.stat(path);
  if (!st || st.type !== 'file') return { ok: false, reason: 'the file is gone' };
  if (size !== undefined && st.size !== size) return { ok: false, reason: 'the file changed since the last import' };
  const offset = Math.max(0, st.size - TAIL_WINDOW);
  const bytes = await machine.readRange(path, offset, st.size - offset);
  if (bytes.length !== st.size - offset) return { ok: false, reason: 'the file changed while it was read' };
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) return { ok: false, reason: 'its last line is cut' };
  const text = new TextDecoder().decode(bytes);
  let rows: Row[];
  try {
    rows = parseRows(text, offset > 0);
  } catch {
    return { ok: false, reason: 'a line in its tail is not JSON' };
  }
  const leaf = leafClaude(rows);
  if (!leaf || leaf !== leafImporter(rows, offset === 0)) return { ok: false, reason: 'Claude Code and the importer would continue from different rows' };
  const sessionId = basename(path, '.jsonl');
  const last = rows.findLast((r) => isMsg(r) && r.sessionId === sessionId);
  if (!last) return { ok: false, reason: 'no row of this chat to copy its fields from' };
  const base = { cwd: last.cwd, sessionId, version: last.version, gitBranch: last.gitBranch, entrypoint: last.entrypoint };
  const latest = Math.max(0, ...rows.map((r) => Date.parse(r.timestamp) || 0));
  const added = buildRows(msgs, base, leaf, latest);
  if (!added.length) return { ok: false, reason: 'nothing to write' };
  const fails = checkRows(added, leaf, sessionId);
  if (fails.length) return { ok: false, reason: fails.join('; ') };
  const lines = added.map((r) => JSON.stringify(r) + '\n').join('');
  const res = await machine.importAppend({ path, sessionId, ...(typeof base.cwd === 'string' ? { cwd: base.cwd } : {}), text: lines, expect: { size: st.size, tail: tailHash(bytes) } });
  if (!res.ok) return { ok: false, reason: res.detail ? `${res.reason} (${res.detail})` : res.reason };
  // the ids the next import gives these rows: convert them after the tail, so a merge with the row before shows
  const mine = new Map(added.map((r) => [r.uuid as string, r.conclave.messageId as string]));
  const ids = convertClaudeCode(text.slice(offset > 0 ? text.indexOf('\n') + 1 : 0) + lines)
    .messages.map((m) => externalId(m))
    .filter((id): id is string => !!id && mine.has(id))
    .map((id) => ({ id, messageId: mine.get(id)! }));
  return { ok: true, ids, size: res.size, mtime: Math.round(res.mtime) };
}
