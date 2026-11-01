/**
 * Chat app exports: claude.ai (Settings, Export data) and ChatGPT. Both are a
 * zip with conversations.json (ChatGPT may split it into
 * conversations-000.json and up). The service unpacks and splits them; this
 * file turns one conversation object into messages.
 */
import type { ContentBlock, TextBlock } from '../types';
import { sanitizeToolId } from '../util/ids';
import { parseTime, truncateTitle } from './files';
import { bump, type ConvertedSession, type ImportedMessage } from './types';

/** One claude.ai conversation: {uuid, name, created_at, chat_messages: [{uuid, sender, text, content, created_at}]}. */
export function convertClaudeAi(conv: Record<string, any>, opts: { projects?: Map<string, string> } = {}): ConvertedSession {
  const unknown: Record<string, number> = {};
  const out: ImportedMessage[] = [];
  const msgs = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
  let lastTs = parseTime(conv.created_at, 0);
  for (const m of msgs as Array<Record<string, any>>) {
    if (!m || typeof m !== 'object') {
      bump(unknown, 'message:unreadable');
      continue;
    }
    const ts = parseTime(m.created_at, lastTs);
    if (ts) lastTs = ts;
    const id = typeof m.uuid === 'string' ? m.uuid : `m${out.length}`;
    const blocks: ContentBlock[] = [];
    const results: ContentBlock[] = [];
    if (Array.isArray(m.content) && m.content.length) {
      for (const c of m.content as Array<Record<string, any>>) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          if (c.text.trim()) blocks.push({ type: 'text', text: c.text });
        } else if (c?.type === 'thinking' && typeof c.thinking === 'string') blocks.push({ type: 'thinking', thinking: c.thinking });
        else if (c?.type === 'tool_use') blocks.push({ type: 'tool_use', id: sanitizeToolId(String(c.id ?? `t${blocks.length}`)), name: String(c.name ?? 'tool'), input: c.input && typeof c.input === 'object' ? c.input : {} });
        else if (c?.type === 'tool_result') {
          const text = Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join('\n') : String(c.content ?? '');
          results.push({ type: 'tool_result', toolUseId: sanitizeToolId(String(c.tool_use_id ?? '')), content: text, ...(c.is_error ? { isError: true } : {}), meta: { external: true } });
        } else bump(unknown, `content:${String(c?.type)}`);
      }
    } else if (typeof m.text === 'string' && m.text.trim()) blocks.push({ type: 'text', text: m.text });
    for (const a of [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])]) {
      const name = a?.file_name ?? a?.name;
      if (typeof a?.extracted_content === 'string' && a.extracted_content.trim()) blocks.push({ type: 'text', text: `[Attached ${name ?? 'file'}]\n${a.extracted_content}` });
      else if (name) blocks.push({ type: 'text', text: `[Attached ${name}]` });
    }
    const external = { source: 'claude-ai', id };
    if (m.sender === 'human') {
      if (blocks.length) out.push({ role: 'user', kind: 'normal', content: blocks, createdAt: ts, meta: { external, origin: 'human' } });
    } else if (m.sender === 'assistant') {
      if (blocks.length) out.push({ role: 'assistant', kind: 'normal', content: blocks, createdAt: ts, meta: { external } });
      if (results.length) out.push({ role: 'user', kind: 'normal', content: results, createdAt: ts, meta: { external: { ...external, id: `${id}:r` }, origin: 'system' } });
    } else bump(unknown, `sender:${String(m.sender)}`);
  }
  const project = typeof conv.project_uuid === 'string' ? opts.projects?.get(conv.project_uuid) : undefined;
  const name = typeof conv.name === 'string' && conv.name.trim() ? conv.name : undefined;
  const firstText = (out.find((m) => m.role === 'user')?.content.find((b) => b.type === 'text') as TextBlock | undefined)?.text;
  return {
    source: 'claude-ai',
    nativeId: typeof conv.uuid === 'string' ? conv.uuid : undefined,
    nativeIdUnique: true,
    title: truncateTitle(name ?? firstText ?? 'Untitled claude.ai chat'),
    ...(project ? { repo: project } : {}),
    kind: 'main',
    messages: out,
    unknown,
    learnable: true,
  };
}

/**
 * One ChatGPT conversation: {id|conversation_id, title, mapping: {id: {message,
 * parent, children}}, current_node}. The live branch is current_node walked
 * up through parent; edited prompts and regenerated answers sit on others.
 */
export function convertChatGpt(conv: Record<string, any>): ConvertedSession {
  const unknown: Record<string, number> = {};
  const raw: Record<string, unknown> = conv.mapping && typeof conv.mapping === 'object' && !Array.isArray(conv.mapping) ? conv.mapping : {};
  // nodes that are not objects are counted and left out
  const mapping: Record<string, Record<string, any>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) mapping[k] = v as Record<string, any>;
    else bump(unknown, 'node:unreadable');
  }
  const chain: Array<Record<string, any>> = [];
  let cur: string | undefined = typeof conv.current_node === 'string' ? conv.current_node : undefined;
  if (!cur) {
    // no current node: the deepest node by following the last child from the root (a loop in children ends it)
    const rootKey = Object.keys(mapping).find((k) => !mapping[k].parent);
    let key = rootKey;
    const down = new Set<string>();
    while (key && mapping[key] && !down.has(key)) {
      down.add(key);
      const kids = mapping[key].children;
      const next = Array.isArray(kids) && kids.length ? String(kids[kids.length - 1]) : undefined;
      if (!next || !mapping[next] || down.has(next)) break;
      key = next;
    }
    cur = key;
  }
  const seen = new Set<string>();
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(mapping[cur]);
    const up = mapping[cur].parent;
    cur = typeof up === 'string' ? up : undefined;
  }
  chain.reverse();
  const out: ImportedMessage[] = [];
  let lastTs = parseTime(conv.create_time, 0);
  let model: string | undefined;
  for (const node of chain) {
    const msg = node.message;
    if (!msg) continue;
    const ts = parseTime(msg.create_time, lastTs);
    if (ts) lastTs = ts;
    const role = msg.author?.role;
    const c = msg.content ?? {};
    const ct = String(c.content_type ?? 'text');
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    const id = String(msg.id ?? node.id);
    const external = { source: 'chatgpt', id };
    const parts: string[] = [];
    switch (ct) {
      case 'text':
      case 'multimodal_text':
        for (const p of Array.isArray(c.parts) ? c.parts : []) {
          if (typeof p === 'string') parts.push(p);
          else if (p?.content_type === 'image_asset_pointer') parts.push('[image]');
          else if (p && typeof p === 'object') bump(unknown, `part:${String(p.content_type)}`);
        }
        break;
      case 'code':
        if (typeof c.text === 'string') parts.push('```' + (c.language && c.language !== 'unknown' ? c.language : '') + '\n' + c.text + '\n```');
        break;
      case 'execution_output':
      case 'tether_quote':
      case 'tether_browsing_display':
        if (typeof c.text === 'string') parts.push(c.text);
        else if (typeof c.result === 'string') parts.push(c.result);
        break;
      case 'thoughts':
      case 'reasoning_recap':
      case 'user_editable_context':
      case 'model_editable_context':
      case 'system_error':
        break;
      default:
        bump(unknown, `content:${ct}`);
    }
    const text = parts.join('\n').trim();
    if (!text) continue;
    if (role === 'user') out.push({ role: 'user', kind: 'normal', content: [{ type: 'text', text }], createdAt: ts, meta: { external, origin: 'human' } });
    else if (role === 'assistant') {
      if (typeof msg.metadata?.model_slug === 'string') model = `openai/${msg.metadata.model_slug}`;
      const prev = out[out.length - 1];
      if (prev && prev.role === 'assistant') prev.content.push({ type: 'text', text });
      else out.push({ role: 'assistant', kind: 'normal', content: [{ type: 'text', text }], createdAt: ts, meta: { external }, ...(model ? { model } : {}) });
    } else if (role === 'tool') {
      // tool output is not the owner: keep it as a quoted line under the answer
      const prev = out[out.length - 1];
      if (prev && prev.role === 'assistant') prev.content.push({ type: 'text', text: `> ${msg.author?.name ?? 'tool'}: ${text.slice(0, 2000)}` });
    } else if (role !== 'system') bump(unknown, `role:${String(role)}`);
  }
  const nativeId = String(conv.conversation_id ?? conv.id ?? '');
  const firstText = (out.find((m) => m.role === 'user')?.content[0] as TextBlock | undefined)?.text;
  return {
    source: 'chatgpt',
    nativeId: nativeId || undefined,
    nativeIdUnique: true,
    title: truncateTitle((typeof conv.title === 'string' && conv.title.trim()) || firstText || 'Untitled ChatGPT chat'),
    model,
    kind: 'main',
    messages: out,
    unknown,
    learnable: true,
  };
}
