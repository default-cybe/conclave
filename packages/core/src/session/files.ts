/**
 * Every file of a conversation, for the Files tab of the session panel (web
 * features/chat/FilesTab.tsx) and GET /api/sessions/:id/files: metadata only,
 * newest first, in three groups.
 *
 *   generated    a ShareFile card (RenderFile output comes through one), a
 *                GenerateImage picture, a picture in a reply, an HTML or SVG
 *                page in a reply
 *   screenshot   a picture a tool returned (browser_screenshot, a Read of a PNG)
 *   uploaded     a picture or document the owner attached to a message
 *
 * Each names where its bytes are: a shared file by its tool call (GET .../files/:toolUseId),
 * anything else by its message, block and part (GET .../messages/:msgId/blocks/:index).
 * The web app and the hub run the same code, so a key means the same file on both.
 */
import type { ContentBlock, Message } from '../types';

export type FileGroup = 'generated' | 'screenshot' | 'uploaded';

export interface SessionFile {
  /** The same file has the same key in the app's list and the hub's. */
  key: string;
  group: FileGroup;
  name: string;
  mediaType: string;
  /** Bytes, when known (a card's, or decoded base64). */
  size?: number;
  at: number;
  messageId: string;
  /** The block in the message's content. */
  index: number;
  /** The part inside a tool_result block. */
  part?: number;
  /** An HTML or SVG page in a reply: the nth one in that text block. */
  page?: number;
  /** A shared file, served by GET /api/sessions/:id/files/:toolUseId; with image, picture N of a GenerateImage call. */
  toolUseId?: string;
  image?: number;
  /** The tool call it came from, for Jump to message (a screenshot's; a shared file's is toolUseId). */
  call?: string;
  /** A picture or document stored as a URL instead of bytes. */
  url?: string;
}

/** What a tool call was, kept across pages so a result finds its call. */
export type ToolNames = Map<string, { name: string; path?: string }>;

const FENCE = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;

/** The HTML and SVG pages in a reply's text, as conversation/ChatMarkdown.tsx previews them. */
export function pagesIn(text: string): Array<{ lang: 'html' | 'svg'; code: string; title?: string }> {
  const out: Array<{ lang: 'html' | 'svg'; code: string; title?: string }> = [];
  if (!text.includes('```')) return out;
  for (const f of text.matchAll(FENCE)) {
    const lang = f[1]?.toLowerCase();
    const code = f[2]!;
    const kind = lang === 'html' || lang === 'htm' ? 'html' : lang === 'svg' || (lang === 'xml' && startsSvg(code)) ? 'svg' : undefined;
    if (!kind) continue;
    const title = /<title>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim();
    out.push({ lang: kind, code, ...(title ? { title } : {}) });
  }
  return out;
}

/** XML whose first element is <svg>, past an <?xml?> line and comments; a linear scan, no backtracking regex. */
function startsSvg(code: string): boolean {
  let s = code.trimStart().replace(/^<\?xml[^>]*>/, '').trimStart();
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->', 4);
    if (end < 0) return false;
    s = s.slice(end + 3).trimStart();
  }
  return /^<svg[\s>]/i.test(s);
}

const ext = (mediaType: string) => mediaType.split('/')[1]?.split(/[+;]/)[0]?.replace('jpeg', 'jpg') ?? 'bin';
const bytesOf = (data?: string) => (data ? Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : undefined);
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** A picture or document a request can carry: web, data or blob URLs only, never a local path. */
function safeUrl(url?: string): string | undefined {
  return url && /^(https?:|data:|blob:|\/api\/)/i.test(url) ? url : undefined;
}

/** Bytes, a usable URL, or neither: a block a light transcript page cut (session/trim.ts), fetched later. Not a local path. */
const usable = (b: { data?: string; url?: string }) => !!b.data || !b.url || !!safeUrl(b.url);

/**
 * The files of these messages, oldest first. `tools` remembers each call's name
 * and path; pass the same map to each page of one transcript, in order.
 */
export function filesOf(messages: readonly Message[], tools: ToolNames = new Map()): SessionFile[] {
  const out: SessionFile[] = [];
  // a GenerateImage picture shared again at the turn's end is one file (files/words.ts generatedNames)
  const generated = new Set<string>();
  for (const m of messages) {
    const at = m.createdAt;
    m.content.forEach((b: ContentBlock, index) => {
      if (b.type === 'tool_use') {
        tools.set(b.id, { name: b.name, path: str(b.input?.file_path) ?? str(b.input?.path) ?? str(b.input?.notebook_path) });
      } else if (b.type === 'tool_result') {
        if (b.isError) return;
        const call = tools.get(b.toolUseId);
        const meta = b.meta ?? {};
        if (call?.name === 'ShareFile') {
          const f = meta.file as { name?: unknown; mediaType?: unknown; size?: unknown } | undefined;
          if (f && typeof f.name === 'string' && typeof f.mediaType === 'string' && !generated.has(f.name))
            out.push({ key: `share:${b.toolUseId}`, group: 'generated', name: f.name, mediaType: f.mediaType, ...(typeof f.size === 'number' ? { size: f.size } : {}), at, messageId: m.id, index, toolUseId: b.toolUseId });
          return;
        }
        if (call?.name === 'GenerateImage' && Array.isArray(meta.files)) {
          (meta.files as Array<{ name?: unknown; mediaType?: unknown; size?: unknown }>).forEach((f, image) => {
            if (typeof f?.name !== 'string' || typeof f.mediaType !== 'string') return;
            generated.add(f.name);
            out.push({ key: `gen:${b.toolUseId}:${image}`, group: 'generated', name: f.name, mediaType: f.mediaType, ...(typeof f.size === 'number' ? { size: f.size } : {}), at, messageId: m.id, index, toolUseId: b.toolUseId, image });
          });
          return;
        }
        if (typeof b.content === 'string') return;
        const pics = b.content.map((c, part) => ({ c, part })).filter(({ c }) => c.type === 'image' && usable(c));
        const stem = call?.path ? base(call.path) : (call?.name ?? 'tool').replace(/^mcp__/, '').replace(/__/g, '-');
        pics.forEach(({ c, part }, i) => {
          if (c.type !== 'image') return;
          const name = /\.\w+$/.test(stem) && pics.length === 1 ? stem : `${stem.replace(/\.\w+$/, '')}-${i + 1}.${ext(c.mediaType)}`;
          out.push({ key: `${m.id}:${index}:${part}`, group: 'screenshot', name, mediaType: c.mediaType, ...(c.data ? { size: bytesOf(c.data) } : {}), at, messageId: m.id, index, part, call: b.toolUseId, ...(safeUrl(c.url) ? { url: c.url } : {}) });
        });
      } else if (b.type === 'image' || b.type === 'document') {
        const url = safeUrl(b.url);
        if (!usable(b)) return;
        const group: FileGroup = m.role === 'user' ? 'uploaded' : 'generated';
        const name = b.type === 'document' && b.title ? b.title : `${b.type === 'image' ? 'image' : 'document'}-${m.seq}-${index + 1}.${ext(b.mediaType)}`;
        out.push({ key: `${m.id}:${index}`, group, name, mediaType: b.mediaType, ...(b.data ? { size: bytesOf(b.data) } : {}), at, messageId: m.id, index, ...(url ? { url } : {}) });
      } else if (b.type === 'text' && m.role === 'assistant' && m.kind !== 'summary') {
        pagesIn(b.text).forEach((p, page) => {
          const name = `${(p.title ?? (p.lang === 'svg' ? 'drawing' : 'page')).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'page'}.${p.lang}`;
          out.push({ key: `page:${m.id}:${index}:${page}`, group: 'generated', name, mediaType: p.lang === 'svg' ? 'image/svg+xml' : 'text/html', size: new TextEncoder().encode(p.code).length, at, messageId: m.id, index, page });
        });
      }
    });
  }
  return out;
}

/** Newest first; the later of two at the same time first. */
export function newestFirst(list: SessionFile[]): SessionFile[] {
  return list.map((f, i) => ({ f, i })).sort((a, b) => b.f.at - a.f.at || b.i - a.i).map((x) => x.f);
}
