/**
 * Codex session reader.
 *
 * Rollouts live in ~/.codex/sessions/YYYY/MM/DD/ and ~/.codex/archived_sessions/
 * as rollout-<time>-<threadId>.jsonl or rollout-<time>-<threadId>_<rolloutId>.jsonl,
 * optionally zstd compressed (.jsonl.zst). Each line is {timestamp, type,
 * payload}: session_meta (thread id, cwd, source, thread_source, git,
 * history_base), turn_context (model), response_item (the model-visible
 * history) and event_msg (UI events, mostly duplicates). Titles are in
 * ~/.codex/session_index.jsonl, where the last entry for a thread wins.
 */
import type { ContentBlock, ImageBlock, TextBlock } from '../types';
import type { ImportSessionKind } from '../client/import';
import type { Machine } from '../machine/types';
import { sanitizeToolId } from '../util/ids';
import { baseName, codexRootOn, joinPath, parseJsonl, parseTime, truncateTitle, walkFiles, type FoundFile } from './files';
import { bump, type ConvertedSession, type ImportedMessage, type MessageOrigin } from './types';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_NAME = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_([A-Za-z0-9-]+))?\\.jsonl(?:\\.zst)?$`, 'i');
const ROLLOUT_ID = new RegExp(`(${UUID})(?:_[A-Za-z0-9-]+)?\\.jsonl(?:\\.zst)?$`, 'i');

/** Text Codex injects as user messages that the user never typed. Dropped. */
const META_PREFIXES = ['<environment_context>', '<user_instructions>', '<permissions instructions>', '# AGENTS.md instructions', '<INSTRUCTIONS>', '<user_shell_command>', '<turn_aborted>'];

const KNOWN_LINES = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted']);
const KNOWN_ITEMS = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call', 'ghost_snapshot', 'compaction']);
/** Codex's own memory and review threads: never learned from. */
const NOT_LEARNED = new Set(['memory_consolidation', 'guardian_review']);

export function isCodexMetaText(text: string): boolean {
  const t = text.trimStart();
  return META_PREFIXES.some((p) => t.startsWith(p));
}

/** A user message one agent sent another, not the owner. */
function codexOrigin(text: string): MessageOrigin {
  const t = text.trimStart();
  if (t.startsWith('<subagent_notification>')) return 'task';
  if (/^Message Type:.*\n(?:.*\n)*?Task name:.*\n(?:.*\n)*?Sender:.*\n(?:.*\n)*?Payload:/m.test(t)) return 'peer';
  return 'human';
}

export function codexIdFromPath(path: string): string | undefined {
  return ROLLOUT_ID.exec(baseName(path))?.[1];
}

/** Thread id and the optional rollout id from a file name. */
export function parseRolloutName(path: string): { time: string; threadId: string; rolloutId?: string } | undefined {
  const m = ROLLOUT_NAME.exec(baseName(path));
  return m ? { time: m[1], threadId: m[2].toLowerCase(), ...(m[3] ? { rolloutId: m[3] } : {}) } : undefined;
}

/** Rollouts under sessions/ and archived_sessions/. */
export async function codexFiles(machine: Machine, root?: string): Promise<Array<FoundFile & { archived: boolean }>> {
  const base = root ?? codexRootOn(machine);
  const match = (n: string) => n.startsWith('rollout-') && (n.endsWith('.jsonl') || n.endsWith('.jsonl.zst'));
  const [live, archived] = await Promise.all([
    walkFiles(machine, joinPath(base, 'sessions'), { match, maxDepth: 3 }),
    walkFiles(machine, joinPath(base, 'archived_sessions'), { match, maxDepth: 3 }),
  ]);
  return [...live.map((f) => ({ ...f, archived: false })), ...archived.map((f) => ({ ...f, archived: true }))];
}

/** Titles from ~/.codex/session_index.jsonl: the last entry for a thread wins. */
export async function codexTitles(machine: Machine, root?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = await machine.readText(joinPath(root ?? codexRootOn(machine), 'session_index.jsonl'));
  } catch {
    return out;
  }
  for (const { value: l } of parseJsonl(text, { includePartialTail: true })) {
    const id = l.id ?? l.thread_id ?? l.threadId;
    const name = l.thread_name ?? l.title ?? l.name;
    if (typeof id === 'string' && typeof name === 'string' && name.trim()) out.set(id.toLowerCase(), name.trim());
  }
  return out;
}

/** The thread a paginated fork starts from, and how many of its items it shares. */
export interface CodexHistoryBase {
  threadId: string;
  items: number;
}

function historyBaseOf(p: Record<string, any>): CodexHistoryBase | undefined {
  const h = p.history_base;
  if (!h || typeof h !== 'object') return undefined;
  const threadId = h.thread_id ?? h.threadId ?? h.id;
  const items = h.items ?? h.item_count ?? h.upto ?? h.ordinal ?? h.count;
  if (typeof threadId !== 'string' || typeof items !== 'number' || items < 0) return undefined;
  return { threadId: threadId.toLowerCase(), items: Math.floor(items) };
}

/** session_meta of a rollout, read from its first lines. */
export function codexMeta(text: string | Uint8Array): Record<string, any> | undefined {
  const head = typeof text === 'string' ? text.slice(0, 65_536) : Buffer.from(text.subarray(0, 65_536)).toString('utf8');
  for (const { value: l } of parseJsonl(head, { includePartialTail: true })) if (l.type === 'session_meta') return l.payload ?? {};
  return undefined;
}

export function codexHistoryBase(text: string | Uint8Array): CodexHistoryBase | undefined {
  const meta = codexMeta(text);
  return meta ? historyBaseOf(meta) : undefined;
}

function kindOf(meta: Record<string, any> | undefined): { kind: ImportSessionKind; parent?: string; learnable: boolean; entrypoint?: string } {
  if (!meta) return { kind: 'main', learnable: true };
  const src = meta.source;
  const threadSource = typeof meta.thread_source === 'string' ? meta.thread_source : undefined;
  const learnable = !(threadSource && NOT_LEARNED.has(threadSource)) && !(typeof src === 'string' && NOT_LEARNED.has(src));
  const parent = (src && typeof src === 'object' ? (src.subagent?.parent_thread_id ?? src.subagent?.thread_id) : undefined) ?? meta.parent_thread_id ?? meta.forked_from_id;
  const entrypoint = typeof src === 'string' ? src : src && typeof src === 'object' ? Object.keys(src)[0] : undefined;
  let kind: ImportSessionKind = 'main';
  if ((src && typeof src === 'object' && 'subagent' in src) || src === 'subagent' || threadSource === 'subagent') kind = 'subagent';
  else if (src === 'internal' || (threadSource && threadSource !== 'user')) kind = 'internal';
  else if (src === 'exec' || src === 'mcp') kind = 'automation';
  return { kind, parent: typeof parent === 'string' ? parent.toLowerCase() : undefined, learnable, entrypoint };
}

/**
 * Convert a Codex rollout. Every message carries meta.external.id: the
 * ordinal of its first response item in the thread's whole history, so a
 * paginated fork (history_base) lines up with the thread it started from.
 * Pass the converted base thread as `base` to put its shared items first.
 */
export function convertCodex(text: string | Uint8Array, opts: { title?: string; base?: ConvertedSession; path?: string } = {}): ConvertedSession {
  const unknown: Record<string, number> = {};
  const lines = parseJsonl(text, { includePartialTail: true }).map((l) => l.value);
  const hasItems = lines.some((l) => l.type === 'response_item' && l.payload?.type === 'message');
  let meta: Record<string, any> | undefined;
  for (const l of lines) {
    if (l.type === 'session_meta') {
      meta = l.payload ?? {};
      break;
    }
  }
  const hb = meta ? historyBaseOf(meta) : undefined;
  const out: ImportedMessage[] = [];
  let ordinal = 0;
  if (hb && opts.base) {
    for (const m of opts.base.messages) {
      const id = (m.meta?.external as { id?: string } | undefined)?.id;
      const n = id && /^i\d+$/.test(id) ? Number(id.slice(1)) : Infinity;
      if (n < hb.items) out.push(structuredClone(m));
    }
    ordinal = hb.items;
  } else if (hb) bump(unknown, 'history_base:missing');

  let model: string | undefined;
  let cwd: string | undefined = typeof meta?.cwd === 'string' ? meta.cwd : undefined;
  let lastTs = 0;
  const ext = (id: string) => ({ source: 'codex', id });

  const last = () => out[out.length - 1];
  const assistant = (ts: number, id: string): ImportedMessage => {
    const m = last();
    if (m && m.role === 'assistant' && m.kind === 'normal') return m;
    const n: ImportedMessage = { role: 'assistant', kind: 'normal', content: [], createdAt: ts, meta: { external: ext(id) } };
    if (model) n.model = `openai/${model}`;
    out.push(n);
    return n;
  };
  const toolResults = (ts: number, id: string): ImportedMessage => {
    const m = last();
    if (m && m.role === 'user' && m.kind === 'normal' && m.meta?.origin === 'system' && m.content.every((b) => b.type === 'tool_result')) return m;
    const n: ImportedMessage = { role: 'user', kind: 'normal', content: [], createdAt: ts, meta: { external: ext(id), origin: 'system' } };
    out.push(n);
    return n;
  };
  const userText = (ts: number, id: string, blocks: ContentBlock[]) => {
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as TextBlock).text)
      .join('\n');
    const origin = codexOrigin(text);
    const m = last();
    // one user turn can be several input items
    if (m && m.role === 'user' && m.kind === 'normal' && m.meta?.origin === 'human' && origin === 'human') {
      m.content.push(...blocks);
      return;
    }
    if (origin === 'human') out.push({ role: 'user', kind: 'normal', content: blocks, createdAt: ts, meta: { external: ext(id), origin } });
    else out.push({ role: 'user', kind: 'aside', author: origin === 'task' ? 'Background task' : 'Peer agent', content: blocks, createdAt: ts, meta: { external: ext(id), origin } });
  };

  for (const l of lines) {
    const ts = parseTime(l.timestamp, lastTs || 0);
    if (ts) lastTs = ts;
    const p = l.payload ?? {};
    if (typeof l.type !== 'string' || !KNOWN_LINES.has(l.type)) {
      bump(unknown, `line:${String(l.type ?? 'none')}`);
      continue;
    }
    if (l.type === 'turn_context') {
      if (typeof p.model === 'string') model = p.model;
      if (typeof p.cwd === 'string') cwd ??= p.cwd;
      continue;
    }
    if (l.type === 'compacted' && typeof p.message === 'string' && p.message.trim()) {
      out.push({ role: 'user', kind: 'summary', content: [{ type: 'text', text: p.message }], createdAt: ts, meta: { external: ext(`c${ordinal}`), origin: 'system' } });
      continue;
    }
    if (!hasItems && l.type === 'event_msg') {
      // very old rollouts: fall back to UI events
      const id = `e${ordinal++}`;
      if (p.type === 'user_message' && typeof p.message === 'string' && !isCodexMetaText(p.message)) userText(ts, id, [{ type: 'text', text: p.message }]);
      else if (p.type === 'agent_message' && typeof p.message === 'string') assistant(ts, id).content.push({ type: 'text', text: p.message });
      continue;
    }
    if (l.type !== 'response_item') continue;
    const id = `i${ordinal++}`;
    if (!KNOWN_ITEMS.has(p.type)) bump(unknown, `item:${String(p.type)}`);

    switch (p.type) {
      case 'message': {
        if (p.role === 'user') {
          const blocks = userContent(p.content);
          if (blocks.length) userText(ts, id, blocks);
        } else if (p.role === 'assistant') {
          const t = messageText(p.content, false);
          if (t) assistant(ts, id).content.push({ type: 'text', text: t });
        }
        break;
      }
      case 'reasoning': {
        const parts = [...(Array.isArray(p.summary) ? p.summary : []), ...(Array.isArray(p.content) ? p.content : [])]
          .filter((s: any) => typeof s?.text === 'string')
          .map((s: any) => s.text as string);
        if (parts.length) assistant(ts, id).content.push({ type: 'thinking', thinking: parts.join('\n\n') });
        break;
      }
      case 'function_call':
        assistant(ts, id).content.push({ type: 'tool_use', id: sanitizeToolId(String(p.call_id ?? p.id ?? '')), name: String(p.name ?? 'function'), input: parseArgs(p.arguments) });
        break;
      case 'custom_tool_call':
        assistant(ts, id).content.push({ type: 'tool_use', id: sanitizeToolId(String(p.call_id ?? p.id ?? '')), name: String(p.name ?? 'tool'), input: { input: p.input } });
        break;
      case 'local_shell_call':
        assistant(ts, id).content.push({ type: 'tool_use', id: sanitizeToolId(String(p.call_id ?? p.id ?? '')), name: 'shell', input: isObj(p.action) ? p.action : {} });
        break;
      case 'web_search_call':
        assistant(ts, id).content.push({ type: 'tool_use', id: sanitizeToolId(String(p.call_id ?? p.id ?? '')), name: 'web_search', input: isObj(p.action) ? p.action : {} });
        // no output item follows a web search; close it so transcripts stay valid
        toolResults(ts, id).content.push({ type: 'tool_result', toolUseId: sanitizeToolId(String(p.call_id ?? p.id ?? '')), content: String(p.status ?? 'completed'), meta: { external: true } });
        break;
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const { text: content, exitCode } = outputText(p.output);
        toolResults(ts, id).content.push({
          type: 'tool_result',
          toolUseId: sanitizeToolId(String(p.call_id ?? '')),
          content,
          ...(exitCode !== undefined && exitCode !== 0 ? { isError: true } : {}),
          meta: { external: true, ...(exitCode !== undefined ? { exitCode } : {}) },
        });
        break;
      }
      default:
        break;
    }
  }

  const k = kindOf(meta);
  const nativeId = (typeof meta?.id === 'string' ? meta.id : undefined)?.toLowerCase() ?? (opts.path ? parseRolloutName(opts.path)?.threadId : undefined);
  const messages = out.filter((m) => m.content.length);
  const firstHuman = messages.find((m) => m.role === 'user' && m.kind === 'normal' && m.meta?.origin === 'human');
  const firstText = (firstHuman?.content.find((b) => b.type === 'text') as TextBlock | undefined)?.text;
  const title = opts.title ?? firstText;
  const git = meta?.git && typeof meta.git === 'object' ? meta.git : undefined;
  return {
    source: 'codex',
    nativeId,
    nativeIdUnique: true,
    title: title ? truncateTitle(title) : undefined,
    cwd,
    gitBranch: typeof git?.branch === 'string' ? git.branch : undefined,
    repo: typeof git?.repository_url === 'string' ? git.repository_url : undefined,
    model: model ? `openai/${model}` : undefined,
    kind: k.kind,
    parentNativeId: k.parent,
    entrypoint: k.entrypoint,
    messages,
    unknown,
    learnable: k.learnable,
  };
}

/** Join text parts of a Codex message; user meta blocks are dropped when `user` is set. */
function messageText(content: unknown, user: boolean): string {
  if (typeof content === 'string') return user && isCodexMetaText(content) ? '' : content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string')
    .map((c) => c.text as string)
    .filter((t) => !(user && isCodexMetaText(t)))
    .join('\n')
    .trim();
}

function userContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return isCodexMetaText(content) || !content.trim() ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const c of content) {
    if ((c?.type === 'input_text' || c?.type === 'text') && typeof c.text === 'string') {
      if (!isCodexMetaText(c.text) && c.text.trim()) out.push({ type: 'text', text: c.text });
    } else if (c?.type === 'input_image' && typeof c.image_url === 'string') {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(c.image_url);
      out.push(m ? { type: 'image', mediaType: m[1], data: m[2] } : { type: 'image', mediaType: 'image/png', url: c.image_url });
    }
  }
  return out;
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (isObj(args)) return args;
  if (typeof args === 'string') {
    try {
      const v = JSON.parse(args);
      return isObj(v) ? v : { arguments: v };
    } catch {
      return { arguments: args };
    }
  }
  return {};
}

/** Function outputs are a string, a JSON string {output, metadata}, or content items. */
function outputText(output: unknown): { text: string | Array<TextBlock | ImageBlock>; exitCode?: number } {
  if (typeof output === 'string') {
    if (output.startsWith('{')) {
      try {
        const v = JSON.parse(output);
        if (isObj(v) && typeof v.output === 'string') {
          const code = (v.metadata as { exit_code?: unknown } | undefined)?.exit_code;
          return { text: v.output, ...(typeof code === 'number' ? { exitCode: code } : {}) };
        }
      } catch {
        // plain text that looks like JSON
      }
    }
    return { text: output };
  }
  if (Array.isArray(output)) {
    const parts: Array<TextBlock | ImageBlock> = [];
    for (const c of output) {
      if (typeof c?.text === 'string') parts.push({ type: 'text', text: c.text });
      else if (c?.type === 'input_image' && typeof c.image_url === 'string') {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(c.image_url);
        if (m) parts.push({ type: 'image', mediaType: m[1], data: m[2] });
      }
    }
    return { text: parts.every((x) => x.type === 'text') ? parts.map((x) => (x as TextBlock).text).join('\n') : parts };
  }
  if (isObj(output)) {
    if (typeof output.content === 'string') return { text: output.content };
    return { text: JSON.stringify(output) };
  }
  return { text: output == null ? '' : String(output) };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
