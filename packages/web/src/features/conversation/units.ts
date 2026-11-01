/**
 * How a chat transcript reads (docs/design/CHAT-AND-MOTION.md 2.6): your
 * messages, replies (every assistant message and tool result between two of
 * your messages), second opinions, notices, and a "Switched to" line when
 * the model changes. Also the pieces a reply is drawn from: its live phase,
 * its sources, and the rail's time groups.
 */
import type { ContentBlock, Message, QueuedMessage, ToolResultBlock } from '@conclave/core/types';
import type { ToolRun } from '@/store/store';
import { isContextOnly, isToolResultOnly, msgText, resultText } from '@/features/chat/util';

export type Unit =
  /** queued: sent while a reply ran; it waits after that reply until it ends. */
  | { kind: 'user'; key: string; message: Message; queued?: boolean }
  | { kind: 'reply'; key: string; messages: Message[]; user?: Message; model?: string }
  | { kind: 'aside'; key: string; message: Message; pending: boolean }
  | { kind: 'notice'; key: string; message: Message }
  | { kind: 'switch'; key: string; model: string }
  /** What you just sent, before the hub has it (added by the list, never by buildUnits). */
  | { kind: 'pending'; key: string }
  /** What you sent while a reply ran, waiting for its turn (added by the list from the hub's queue, CHAT-AND-MOTION 2.11). */
  | { kind: 'queued'; key: string; item: QueuedMessage };

export type ReplyUnit = Extract<Unit, { kind: 'reply' }>;

/** The hub's own line after a second opinion; the aside itself already says it. */
const ASIDE_ADDED = /^second opinion from .+ added\.?$/i;

/**
 * `asideFor` names the reply each second opinion answers when the hub did not
 * (the hub's aside carries no messageId; the page remembers which reply was asked about).
 */
export function buildUnits(messages: Message[], hide?: Set<string>, asideFor?: Record<string, string>): Unit[] {
  const units: Unit[] = [];
  let lastModel: string | undefined;
  let lastUser: Message | undefined;
  /** The reply being built: the last one after your last message. */
  let cur: ReplyUnit | undefined;
  /** Messages sent while `cur` was running. They follow it once it ends. */
  let deferred: Message[] = [];
  const ended = (r: ReplyUnit | undefined) => !r || replyEnded(r.messages);
  const flush = (queued: boolean) => {
    for (const d of deferred) {
      lastUser = d;
      units.push({ kind: 'user', key: d.id, message: d, queued });
    }
    if (deferred.length) cur = undefined;
    deferred = [];
  };
  for (const m of messages) {
    if (hide?.has(m.id)) continue;
    if (m.kind === 'notice' || m.kind === 'summary') {
      if (m.kind === 'notice' && ASIDE_ADDED.test(msgText(m).trim())) continue;
      units.push({ kind: 'notice', key: m.id, message: m });
      continue;
    }
    if (m.kind === 'aside') {
      units.push({ kind: 'aside', key: m.id, message: m, pending: true });
      continue;
    }
    if (m.role === 'user' && (isToolResultOnly(m) || isContextOnly(m))) {
      if (cur) cur.messages.push(m);
      continue;
    }
    if (m.role === 'user') {
      if (m.meta?.whenBusy === 'queue' && cur && !ended(cur)) {
        deferred.push(m);
        continue;
      }
      flush(false);
      lastUser = m;
      cur = undefined;
      units.push({ kind: 'user', key: m.id, message: m });
      continue;
    }
    if (cur && (!deferred.length || !ended(cur))) {
      cur.messages.push(m);
      continue;
    }
    flush(false);
    if (m.model && lastModel && m.model !== lastModel) units.push({ kind: 'switch', key: `sw:${m.id}`, model: m.model });
    if (m.model) lastModel = m.model;
    cur = { kind: 'reply', key: m.id, messages: [m], user: lastUser, model: m.model };
    units.push(cur);
  }
  flush(!ended(cur));

  // an aside that names its reply sits right under it
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (u.kind !== 'aside') continue;
    const target = u.message.meta?.messageId ?? asideFor?.[u.message.id];
    if (typeof target !== 'string') continue;
    const at = units.findIndex((x) => x.kind === 'reply' && x.messages.some((m) => m.id === target));
    if (at < 0 || at === i - 1) continue;
    units.splice(i, 1);
    let to = at + 1;
    while (units[to]?.kind === 'aside') to++;
    units.splice(to, 0, u);
  }

  // a second opinion offers Continue and Dismiss until something follows it
  let followed = false;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (u.kind === 'aside') u.pending = !followed;
    if (u.kind === 'user' || u.kind === 'reply') followed = true;
  }
  return units;
}

/**
 * The row that shows message `id`, for a #message link into a windowed chat
 * (chat/window.ts): a reply holds every message of its turn, so a message
 * without a row of its own (a tool result, a reminder) belongs to the row
 * before it in the chat's order. -1 when the chat has no such message.
 */
export function rowIndexOf(rows: readonly Unit[], messages: readonly Message[], id: string): number {
  const own = rows.findIndex((u) => u.key === id || (u.kind === 'reply' && u.messages.some((m) => m.id === id)));
  if (own >= 0) return own;
  const m = messages.find((x) => x.id === id);
  if (!m) return -1;
  const seqOf = new Map(messages.map((x) => [x.id, x.seq]));
  let best = -1;
  rows.forEach((u, i) => {
    const ids = u.kind === 'reply' ? u.messages : u.kind === 'user' || u.kind === 'aside' || u.kind === 'notice' ? [u.message] : [];
    const first = Math.min(...ids.map((x) => seqOf.get(x.id) ?? Infinity));
    if (first <= m.seq) best = i;
  });
  return best;
}

/** Text of a reply, every text block joined. */
/** The reply is over: its last assistant message stopped, and not for tool calls. */
export function replyEnded(messages: Message[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  return !!last?.stopReason && last.stopReason !== 'tool_use';
}

export function replyText(r: ReplyUnit): string {
  return r.messages
    .filter((m) => m.role === 'assistant')
    .map(msgText)
    .filter(Boolean)
    .join('\n\n');
}

/** The last assistant message of a reply (what Branch and Ask another model point at). */
export function replyLast(r: ReplyUnit): Message | undefined {
  for (let i = r.messages.length - 1; i >= 0; i--) if (r.messages[i].role === 'assistant') return r.messages[i];
  return r.messages[r.messages.length - 1];
}

export function lastSeq(r: ReplyUnit): number | undefined {
  return r.messages[r.messages.length - 1]?.seq;
}

// ---------------------------------------------------------------------------
// Live phase of the reply being written (spec 1.3, 3.3)
// ---------------------------------------------------------------------------

/**
 * waiting  sent, nothing back yet: the mark thinks at the reply's first line
 * thinking a thinking block streams: "Thinking 4s" and the last line of the thought
 * tool     a tool runs: its row says so
 * writing  text streams: the mark works at the foot of the reply
 * between  a step finished and the next has not started: the mark thinks at the foot
 */
export type Phase = 'waiting' | 'thinking' | 'tool' | 'writing' | 'between';

export function livePhase(messages: Message[], streaming: Record<string, true>, tools: Record<string, ToolRun>, results: Record<string, ToolResultBlock>): Phase {
  let last: { block: ContentBlock; msg: Message } | undefined;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'text' && !b.text) continue;
      if (b.type === 'tool_use' && !results[b.id] && tools[b.id]?.status !== 'ok' && tools[b.id]?.status !== 'error') return 'tool';
      last = { block: b, msg: m };
    }
  }
  if (!last) return 'waiting';
  if (last.block.type === 'thinking' && streaming[last.msg.id]) return 'thinking';
  if (last.block.type === 'text' && streaming[last.msg.id]) return 'writing';
  return 'between';
}

// ---------------------------------------------------------------------------
// Sources (spec 2.6)
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  date?: string;
}

export interface Source {
  n: number;
  url: string;
  host: string;
  title?: string;
}

export function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

function norm(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
}

/** Results of every WebSearch in a reply, and the pages WebFetch read. */
export function replyResults(messages: Message[], results: Record<string, ToolResultBlock>): SearchResult[] {
  const out: SearchResult[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      const r = results[b.id];
      if (!r || r.isError) continue;
      if (b.name === 'WebSearch' && Array.isArray(r.meta?.results)) out.push(...(r.meta.results as SearchResult[]));
      if (b.name === 'WebFetch') {
        const url = typeof r.meta?.url === 'string' ? r.meta.url : typeof b.input.url === 'string' ? b.input.url : undefined;
        if (url) out.push({ title: host(url), url });
      }
    }
  }
  return out;
}

/**
 * The numbered hosts after a reply: its links that match what it searched or
 * read, in the order it cites them; else every result. One per host.
 */
export function replySources(text: string, results: SearchResult[]): Source[] {
  if (!results.length) return [];
  const byUrl = new Map(results.map((r) => [norm(r.url), r]));
  const cited: SearchResult[] = [];
  for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>/g)) {
    const url = m[1] ?? m[2];
    const r = byUrl.get(norm(url));
    if (r) cited.push(r);
  }
  const list = cited.length ? cited : results;
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const r of list) {
    const h = host(r.url);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push({ n: out.length + 1, url: r.url, host: h, title: r.title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool rows (spec 2.6)
// ---------------------------------------------------------------------------

export interface Note {
  id: string;
  text: string;
}

/** Notes in a MemorySearch result: "[id] (kind, scope, date)\ntext" or "[id] text". */
export function parseNotes(r: ToolResultBlock | undefined): Note[] {
  if (!r) return [];
  const text = resultText(r);
  const out: Note[] = [];
  const re = /\[([^\]\s]+)\]\s*(?:\([^)\n]*\))?\s*\n?([\s\S]*?)(?=\n\s*\[[^\]\s]+\]|$)/g;
  for (const m of text.matchAll(re)) {
    const body = m[2].trim();
    if (body) out.push({ id: m[1], text: body });
  }
  return out;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** An old note's text, from a search earlier in the same reply. */
export function findNote(messages: Message[], results: Record<string, ToolResultBlock>, id: string | undefined): string | undefined {
  if (!id) return undefined;
  for (const m of messages)
    for (const b of m.content)
      if (b.type === 'tool_use' && b.name === 'MemorySearch') {
        const n = parseNotes(results[b.id]).find((x) => x.id === id);
        if (n) return n.text;
      }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rail groups (spec 2.3)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today, Yesterday, Previous 7 days, Previous 30 days, then one group per month. */
export function timeGroup(ts: number, now = Date.now()): { key: string; label: string } {
  const today = startOfDay(now);
  if (ts >= today) return { key: 'today', label: 'Today' };
  if (ts >= today - DAY) return { key: 'yesterday', label: 'Yesterday' };
  if (ts >= today - 7 * DAY) return { key: 'week', label: 'Previous 7 days' };
  if (ts >= today - 30 * DAY) return { key: 'month', label: 'Previous 30 days' };
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const label = d.toLocaleDateString(undefined, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
  return { key: `m:${d.getFullYear()}-${d.getMonth()}`, label };
}

/** "Good morning", "Good afternoon" or "Good evening" by the local time. */
export function greeting(name: string | undefined, now = new Date()): string {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : 'evening';
  return `Good ${part}${name ? `, ${name}.` : '.'}`;
}
