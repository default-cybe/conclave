/**
 * Gemini CLI session reader.
 *
 * Chats live in ~/.gemini/tmp/<project>/chats/ (the macOS sandbox uses
 * ~/.cache/.gemini). A session-*.jsonl file starts with one metadata line,
 * then one line per message, plus control records replayed in order:
 * {"$rewindTo": id} drops that message and everything after it, {"$patch":
 * {id, ...}} changes one message, {"$set": {...}} changes the metadata.
 * Older builds wrote one session-*.json object with a messages array, and
 * /chat save writes checkpoint-<tag>.json as a list of API contents.
 * <project> is a short name from ~/.gemini/projects.json, or on older builds
 * sha256 of the project root.
 */
import type { ContentBlock, TextBlock } from '../types';
import type { Machine } from '../machine/types';
import { sanitizeToolId } from '../util/ids';
import { baseName, geminiRootOn, joinPath, parseJsonl, parseTime, sha256Hex, truncateTitle, walkFiles, type FoundFile } from './files';
import { bump, type ConvertedSession, type ImportedMessage } from './types';

const KNOWN_TYPES = new Set(['user', 'gemini', 'info', 'error', 'warning']);

/** Session and checkpoint files under ~/.gemini/tmp/<project>/chats, with the project dir name. */
export async function geminiFiles(machine: Machine, root?: string): Promise<Array<FoundFile & { project: string }>> {
  const tmp = joinPath(root ?? geminiRootOn(machine), 'tmp');
  const files = await walkFiles(machine, tmp, {
    match: (n) => /^(session-.*\.jsonl?|checkpoint-.*\.json)$/.test(n),
    maxDepth: 2,
    skipDir: (name, depth) => depth === 1 && name !== 'chats',
  });
  return files.map((f) => ({ ...f, project: f.path.slice(tmp.length + 1).split('/')[0] }));
}

/** Project dir name to project root, from projects.json and the legacy sha256 names. */
export async function geminiProjects(machine: Machine, root?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let raw: unknown;
  try {
    raw = JSON.parse(await machine.readText(joinPath(root ?? geminiRootOn(machine), 'projects.json')));
  } catch {
    return out;
  }
  const add = (path: unknown, name: unknown) => {
    if (typeof path !== 'string' || !path.startsWith('/')) return;
    if (typeof name === 'string' && name) out.set(name, path);
    out.set(sha256Hex(path), path);
  };
  const obj = raw && typeof raw === 'object' ? ((raw as { projects?: unknown }).projects ?? raw) : undefined;
  if (Array.isArray(obj)) for (const p of obj) add(p?.path ?? p?.root, p?.name ?? p?.id);
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) add(k.startsWith('/') ? k : v, k.startsWith('/') ? v : k);
  return out;
}

interface GeminiRecord extends Record<string, any> {
  id?: string;
}

/** Replay a JSONL chat (or read a legacy object) into metadata and live messages. */
function records(text: string, unknown: Record<string, number>): { meta: Record<string, any>; messages: GeminiRecord[] } {
  const t = text.trimStart();
  if (t.startsWith('[')) {
    // checkpoint: API contents
    const arr = JSON.parse(t) as Array<{ role?: string; parts?: unknown[] }>;
    return { meta: {}, messages: arr.map((c, i) => ({ id: `c${i}`, type: c.role === 'model' ? 'gemini' : 'user', content: c.parts ?? [] })) };
  }
  if (t.startsWith('{') && !t.includes('\n{')) {
    try {
      const obj = JSON.parse(t) as Record<string, any>;
      if (Array.isArray(obj.messages)) {
        const { messages, ...meta } = obj;
        return { meta, messages: messages as GeminiRecord[] };
      }
    } catch {
      // fall through to JSONL
    }
  }
  let meta: Record<string, any> = {};
  const messages: GeminiRecord[] = [];
  let first = true;
  for (const { value: l } of parseJsonl(text, { includePartialTail: true })) {
    if (typeof l.$rewindTo === 'string') {
      const i = messages.findIndex((m) => m.id === l.$rewindTo);
      if (i >= 0) messages.splice(i);
      continue;
    }
    if (l.$patch && typeof l.$patch === 'object') {
      const m = messages.find((x) => x.id === l.$patch.id);
      if (m) Object.assign(m, l.$patch);
      continue;
    }
    if (l.$set && typeof l.$set === 'object') {
      meta = { ...meta, ...l.$set };
      continue;
    }
    if (first && !('type' in l)) {
      meta = { ...meta, ...l };
      first = false;
      continue;
    }
    first = false;
    if (typeof l.type === 'string' && !KNOWN_TYPES.has(l.type)) bump(unknown, `line:${l.type}`);
    messages.push(l);
  }
  return { meta, messages };
}

function partsToBlocks(content: unknown, role: 'user' | 'assistant', unknown: Record<string, number>): { blocks: ContentBlock[]; calls: ContentBlock[]; results: ContentBlock[] } {
  const blocks: ContentBlock[] = [];
  const calls: ContentBlock[] = [];
  const results: ContentBlock[] = [];
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ type: 'text', text: content });
    return { blocks, calls, results };
  }
  const list = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
  for (const p of list as Array<any>) {
    if (typeof p === 'string') {
      if (p.trim()) blocks.push({ type: 'text', text: p });
    } else if (typeof p?.text === 'string') {
      if (p.thought) blocks.push({ type: 'thinking', thinking: p.text });
      else if (p.text.trim()) blocks.push({ type: 'text', text: p.text });
    } else if (p?.functionCall) {
      const id = sanitizeToolId(String(p.functionCall.id ?? `${p.functionCall.name}_${calls.length}`));
      calls.push({ type: 'tool_use', id, name: String(p.functionCall.name ?? 'tool'), input: p.functionCall.args ?? {} });
    } else if (p?.functionResponse) {
      const id = sanitizeToolId(String(p.functionResponse.id ?? `${p.functionResponse.name}_${results.length}`));
      const r = p.functionResponse.response;
      results.push({ type: 'tool_result', toolUseId: id, content: typeof r?.output === 'string' ? r.output : JSON.stringify(r ?? ''), meta: { external: true } });
    } else if (p?.inlineData?.data) {
      if (role === 'user') blocks.push({ type: 'image', mediaType: p.inlineData.mimeType ?? 'image/png', data: p.inlineData.data });
    } else bump(unknown, `part:${Object.keys(p ?? {})[0] ?? 'none'}`);
  }
  return { blocks, calls, results };
}

/** Convert one Gemini CLI chat. cwd comes from the project map when the caller knows it. */
export function convertGemini(text: string, opts: { cwd?: string; path?: string } = {}): ConvertedSession {
  const unknown: Record<string, number> = {};
  const { meta, messages: recs } = records(text, unknown);
  const out: ImportedMessage[] = [];
  let model: string | undefined;
  let lastTs = parseTime(meta.startTime, 0);
  for (const r of recs) {
    const ts = parseTime(r.timestamp, lastTs);
    if (ts) lastTs = ts;
    const id = typeof r.id === 'string' ? r.id : `m${out.length}`;
    const external = { source: 'gemini', id };
    if (r.type === 'user') {
      const { blocks, results } = partsToBlocks(r.content, 'user', unknown);
      if (results.length) out.push({ role: 'user', kind: 'normal', content: results, createdAt: ts, meta: { external: { ...external, id: `${id}:r` }, origin: 'system' } });
      const text = blocks.filter((b) => b.type === 'text').map((b) => (b as TextBlock).text).join('\n');
      // shell passthrough and slash commands are still the owner's words
      if (blocks.length && text.trim()) out.push({ role: 'user', kind: 'normal', content: blocks, createdAt: ts, meta: { external, origin: 'human' } });
    } else if (r.type === 'gemini') {
      if (typeof r.model === 'string') model = `google/${r.model}`;
      const { blocks, calls } = partsToBlocks(r.content, 'assistant', unknown);
      const thinking: ContentBlock[] = Array.isArray(r.thoughts)
        ? r.thoughts.filter((t: any) => t?.subject || t?.description).map((t: any) => ({ type: 'thinking' as const, thinking: [t.subject, t.description].filter(Boolean).join(': ') }))
        : [];
      const toolUses: ContentBlock[] = [...calls];
      const results: ContentBlock[] = [];
      if (Array.isArray(r.toolCalls)) {
        for (const c of r.toolCalls) {
          const tid = sanitizeToolId(String(c?.id ?? `${c?.name}_${toolUses.length}`));
          toolUses.push({ type: 'tool_use', id: tid, name: String(c?.name ?? 'tool'), input: c?.args && typeof c.args === 'object' ? c.args : {} });
          const res = Array.isArray(c?.result) ? c.result.map((x: any) => x?.functionResponse?.response?.output ?? x?.text ?? '').join('\n') : typeof c?.resultDisplay === 'string' ? c.resultDisplay : JSON.stringify(c?.result ?? '');
          results.push({ type: 'tool_result', toolUseId: tid, content: String(res ?? ''), ...(c?.status === 'error' ? { isError: true } : {}), meta: { external: true } });
        }
      }
      const content = [...thinking, ...blocks, ...toolUses];
      if (!content.length) continue;
      out.push({ role: 'assistant', kind: 'normal', content, createdAt: ts, meta: { external }, ...(model ? { model } : {}) });
      if (results.length) out.push({ role: 'user', kind: 'normal', content: results, createdAt: ts, meta: { external: { ...external, id: `${id}:r` }, origin: 'system' } });
    }
  }
  const nativeId = typeof meta.sessionId === 'string' ? meta.sessionId : opts.path ? baseName(opts.path).replace(/\.jsonl?$/, '') : undefined;
  const firstHuman = out.find((m) => m.meta?.origin === 'human');
  const title = (typeof meta.summary === 'string' && meta.summary) || (firstHuman?.content.find((b) => b.type === 'text') as TextBlock | undefined)?.text;
  return {
    source: 'gemini',
    nativeId,
    nativeIdUnique: true,
    title: title ? truncateTitle(title) : undefined,
    cwd: opts.cwd,
    model,
    kind: meta.kind === 'subagent' ? 'subagent' : 'main',
    messages: out,
    unknown,
    learnable: true,
  };
}
