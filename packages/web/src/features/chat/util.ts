/** Helpers for the chat feature: text extraction, verdict parsing, live rate, exports. */
import { useEffect, useState } from 'react';
import type { ContentBlock, Message, Session, ToolResultBlock } from '@conclave/core/types';
import type { ModelGroup } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, useHub, type HubConfig } from '@/store/store';
import { HARNESSES, harnessId, splitRef } from '@/lib/models';
import { companyLogo } from '@/components/logo';

/** Put words in a session's composer and focus it (Edit on your message, Ask a follow-up). */
export const COMPOSE_EVENT = 'conclave:compose';
export interface ComposeDetail {
  text?: string;
  /** Side by side has a composer per session: only this session's takes it. */
  sessionId: string;
}

/**
 * Context the hub adds to a user message for the model only: recalled notes
 * and hook output, in a <system-reminder> text block (core session/transcript.ts).
 * It is not the owner's words, so it is never shown, copied or sent again.
 */
export function isReminder(b: ContentBlock): boolean {
  return b.type === 'text' && b.text.startsWith('<system-reminder>');
}

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && !isReminder(b))
    .map((b) => b.text)
    .join('\n\n');
}

/** Something of the owner's in a user message: words that are not hub context, a picture or a document. */
function ownBlock(b: ContentBlock): boolean {
  return (b.type === 'text' && !isReminder(b) && b.text.trim() !== '') || b.type === 'image' || b.type === 'document';
}

/**
 * A user message the owner never wrote: only hub context for the model (a
 * Stop hook's feedback, a background task's report), maybe after tool
 * results, or nothing at all. It draws no bubble: an empty one is never shown.
 */
export function isContextOnly(m: Message): boolean {
  return m.role === 'user' && !m.content.some(ownBlock);
}

export function msgText(m: Message): string {
  return textOf(m.content);
}

export function resultText(r?: ToolResultBlock): string {
  if (!r) return '';
  if (typeof r.content === 'string') return r.content;
  return r.content.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
}

/** A chat from the Chat page (kind "chat"). Chats stay out of Sessions, Home's Running and the session counts. */
export function isChat(s: Pick<Session, 'kind'> | undefined): boolean {
  return s?.kind === 'chat';
}

export function isToolResultOnly(m: Message) {
  return m.role === 'user' && m.content.length > 0 && m.content.every((b) => b.type === 'tool_result');
}

/** Strip markdown down to plain words for one line summaries. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentences(s: string, max = 180): string {
  const parts = s.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const p of parts) {
    if (out && (out + ' ' + p).length > max) break;
    out = out ? `${out} ${p}` : p;
    if (out.length > max * 0.6) break;
  }
  out = out.trim().replace(/:$/, '.');
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
}

/**
 * The verdict as a sentence (spec 10.24): the first bold run ("**Use Caddy.**")
 * or the first sentence. `rest` is the rationale that follows.
 */
export function splitVerdict(text: string): { sentence: string; rest: string } {
  const t = text.trim();
  const bold = /^\*\*(.+?)\*\*\s*/.exec(t);
  if (bold && !/^verdict\.?$/i.test(bold[1].trim())) {
    const s = bold[1].trim();
    return { sentence: /[.!?]$/.test(s) ? s : `${s}.`, rest: t.slice(bold[0].length) };
  }
  const body = bold ? t.slice(bold[0].length) : t;
  const m = /^([^.!?\n]{4,140}[.!?])\s*/.exec(body);
  if (m) return { sentence: plain(m[1]), rest: body.slice(m[0].length) };
  return { sentence: '', rest: body };
}

/** "Use Caddy." -> "Caddy" (list rows: "Jury of 4, verdict Caddy"). Empty when the verdict is not a short phrase. */
export function verdictWord(sentence: string): string {
  const w = sentence
    .replace(/^(use|go with|pick|choose|keep|run)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return w.length > 28 ? '' : w;
}

/** A juror's pick and the main reason, one or two sentences of plain text. */
export function jurorSummary(m: Message): { pick?: string; reason: string } {
  const meta = (m.meta ?? {}) as { vote?: string; reason?: string };
  const text = msgText(m).trim();
  const bold = /^\*\*(.+?)\*\*\s*/.exec(text);
  const pick = meta.vote ?? (bold ? bold[1].replace(/[.!?]+$/, '') : undefined);
  if (meta.reason) return { pick, reason: meta.reason };
  // "**Caddy.** One..." and "**Caddy**. Simplest..." drop the pick; "**Traefik** if you..." keeps it as the sentence start
  let body = text;
  if (bold) {
    const after = text.slice(bold[0].length);
    if (/[.!?]$/.test(bold[1].trim())) body = after;
    else if (/^[.!?]\s/.test(after)) body = after.slice(2);
  }
  // the first paragraph, before any list or code block
  const para = body.split(/\n\s*\n|```|\n\s*[-*\d]+[.)]?\s/)[0] || body;
  return { pick, reason: firstSentences(plain(para)) };
}

/** Last fenced code block in a session's assistant messages (for the copy shortcut). */
export function lastCodeBlock(messages: Message[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const all = [...msgText(m).matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (all.length) return all[all.length - 1][1].replace(/\n$/, '');
  }
  return undefined;
}

/** When the current run started: the last message the owner wrote, else the session start. */
export function turnStartedAt(messages: Message[] | undefined, s: Session): number {
  if (messages)
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      // the hub's own notes mid turn (output limit, Stop hook feedback) do not start a new run
      if (m.role === 'user' && !isToolResultOnly(m) && !isContextOnly(m)) return m.createdAt;
    }
  return s.createdAt;
}

/** Total assistant characters written so far in a session. */
function outputChars(sessionId: string): number {
  const list = useHub.getState().messages[sessionId] ?? [];
  let n = 0;
  for (const m of list) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) n += b.type === 'text' ? b.text.length : b.type === 'thinking' ? b.thinking.length : 0;
  }
  return n;
}

/**
 * Live tokens per second, estimated from how fast assistant text grows
 * (4 characters per token), smoothed over a few seconds.
 */
export function useTps(sessionId: string, active: boolean): number {
  const [tps, setTps] = useState(0);
  useEffect(() => {
    if (!active) {
      setTps(0);
      return;
    }
    let last = outputChars(sessionId);
    let lastT = performance.now();
    let ema = 0;
    const id = setInterval(() => {
      const c = outputChars(sessionId);
      const t = performance.now();
      const rate = Math.max(0, (c - last) / 4 / Math.max(0.25, (t - lastT) / 1000));
      ema = ema ? ema * 0.55 + rate * 0.45 : rate;
      last = c;
      lastT = t;
      setTps(Math.round(ema));
    }, 1000);
    return () => clearInterval(id);
  }, [sessionId, active]);
  return tps;
}

/**
 * The model to switch to when this session's provider is limited: the
 * configured fallback (limits.fallbacks), else the first enabled model from
 * another company.
 */
export function fallbackModel(session: Session, groups: ModelGroup[], config?: HubConfig): string | undefined {
  const limits = (config?.limits ?? {}) as { fallbacks?: Record<string, string[]> };
  const configured = limits.fallbacks?.[session.model]?.[0];
  if (configured) return configured;
  const mine = companyLogo(harnessId(session.model) ?? splitRef(session.model).provider);
  for (const g of groups) {
    if (!g.enabled || HARNESSES[g.provider] || g.provider === 'ollama') continue;
    if (companyLogo(g.provider) === mine) continue;
    const pick = g.models.find((m) => /gpt-5|sonnet|gemini-3-pro|glm-5/.test(m.ref)) ?? g.models[0];
    if (pick) return pick.ref;
  }
  return undefined;
}

export async function downloadExport(session: Session, format: 'md' | 'json') {
  const r = await attempt(() => api().exportSession(session.id, format));
  if (!r) return;
  const blob = new Blob([r.content], { type: format === 'json' ? 'application/json' : 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = r.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Host of a URL, or the raw value. */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/** "just now", "2m ago", "3h ago", "on Tue", "on 16 Oct". */
export function agoText(rel: string): string {
  if (rel === 'now') return 'just now';
  return /^\d+[mhd]$/.test(rel) ? `${rel} ago` : `on ${rel}`;
}

// ---------------------------------------------------------------------------
// Second opinions dismissed on this device, shared by the chat page and the session log
// ---------------------------------------------------------------------------

const DISMISSED_KEY = 'conclave.chat.dismissed';

export function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function writeDismissed(id: string, on: boolean) {
  try {
    const s = readDismissed();
    if (on) s.add(id);
    else s.delete(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    /* private mode */
  }
}
