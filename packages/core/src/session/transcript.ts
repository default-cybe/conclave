import { createHash } from 'node:crypto';
import type { ContentBlock, ImageBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../types';
import type { ProviderMessage } from '../providers/types';
import { sanitizeToolId } from '../util/ids';
import { oneLine, truncateMiddle } from '../util/text';
import { guardTranscript } from './pairing';
import { CLEAR_MIN_CHARS, clearedText, payloadChars, stubInput, type ClearMark } from './context-edit';
import { quotedBlock, quotedOf } from './quoted';

export const REMINDER_OPEN = '<system-reminder>';

/** Heads a compaction summary in requests: it comes from the framework, not from the user. */
export const SUMMARY_PREAMBLE =
  'Earlier parts of this conversation were compacted. The text below is a summary written by the Conclave framework, not a message from the user. The full messages stay stored.';

export function isReminder(block: ContentBlock): boolean {
  return block.type === 'text' && block.text.startsWith(REMINDER_OPEN);
}

export function reminder(text: string): TextBlock {
  return { type: 'text', text: `${REMINDER_OPEN}\n${text}\n</system-reminder>` };
}

export interface BuildOptions {
  /** "provider/model" the request is for. Thinking blocks from other models are dropped. */
  modelRef: string;
  /** Tool names available in this request. Tool calls to anything else are flattened to text. */
  toolNames: Set<string>;
  /** Put cache breakpoints on the last two user messages. */
  cache: boolean;
  /** The model has no vision: images with a stored transcription (meta.imageText, session/image-text.ts) go as that text. */
  imageText?: boolean;
}

/** An image's key in meta.imageText: a hash of its bytes (or its URL). */
export function imageKey(b: ImageBlock): string {
  return createHash('sha256').update(b.data ?? b.url ?? '').digest('hex').slice(0, 32);
}

/** Messages that are logically part of the conversation the model sees (after the last compaction). */
export function activeMessages(all: Message[]): Message[] {
  let start = 0;
  let summary: Message | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].kind === 'summary') {
      summary = all[i];
      start = i;
      break;
    }
  }
  if (!summary) return all.filter((m) => m.kind !== 'notice');
  const covers = (summary.meta?.coversThroughSeq as number | undefined) ?? summary.seq - 1;
  const rest = all.filter((m) => m.kind !== 'notice' && m.kind !== 'summary' && m.seq > covers);
  void start;
  return [summary, ...rest];
}

/**
 * The first seq whose thinking may be replayed, for the active messages of a
 * request: the summary's own seq after any compaction, -1 without one.
 *
 * A compaction keeps the newest turns word for word after a summary the hub
 * wrote. Their thinking was produced with the full history before them, so
 * Anthropic's conversation check (accounts created on or after 2026-08-31,
 * shared/model-migration.md "Breaking change 3") rejects it once the summary
 * replaces that history. Those turns go without thinking, text and tool calls
 * stay. Turns written after the summary keep theirs: they were produced with
 * the summary in front of them. The rule reads only the stored summary, so
 * every later request and a restart send the same bytes; removing a leading
 * run of thinking blocks is what the check allows. This holds for every
 * compaction: a switch's short handover (modes/handoff.ts), auto compaction
 * and /compact. Older summaries carry meta.dropTailThinking; it is no longer
 * needed.
 */
export function thinkingAfterSummary(active: Message[]): number {
  return active[0]?.kind === 'summary' ? active[0].seq : -1;
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text' && !isReminder(b))
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function resultText(r: ToolResultBlock): string {
  if (typeof r.content === 'string') return r.content;
  return r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
}

function inputSummary(input: Record<string, unknown>): string {
  const keys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
  for (const k of keys) if (typeof input[k] === 'string') return oneLine(input[k] as string, 160);
  return oneLine(JSON.stringify(input), 160);
}

/**
 * Convert stored messages into a provider request transcript.
 *
 * - asides become quoted user-side context, so the model never mistakes them for its own words
 * - thinking is kept only for the same model (signatures are model-bound), and never in the
 *   turns a compaction kept word for word after its summary (thinkingAfterSummary)
 * - tool calls the current request cannot express (external harness calls, tools not offered now)
 *   are flattened into text with a short result
 * - tool results and Write or Edit payloads that a clearing batch marked (context-edit.ts)
 *   go as a stub that points at the stored output; only stored marks count, so the bytes
 *   of a message never change between requests
 * - consecutive same-role messages are merged, the transcript starts with a user turn,
 *   and every tool_use gets a tool_result
 */
export function buildProviderMessages(all: Message[], opts: BuildOptions): ProviderMessage[] {
  const msgs = activeMessages(all);
  const noThinkingBefore = thinkingAfterSummary(msgs);

  // map tool_use id -> result, and mark external ones (quoted messages from a friend's hub are text, never calls)
  const results = new Map<string, ToolResultBlock>();
  for (const m of msgs) if (!quotedOf(m)) for (const b of m.content) if (b.type === 'tool_result') results.set(b.toolUseId, b);

  const flattened = new Set<string>();
  const out: ProviderMessage[] = [];

  const push = (role: 'user' | 'assistant', content: ContentBlock[]) => {
    if (!content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content: [...content] });
  };

  // a run of messages quoted from a friend's hub goes as one block of data (session/quoted.ts)
  let quoted: Message[] = [];
  const flushQuoted = () => {
    if (quoted.length) push('user', [{ type: 'text', text: quotedBlock(quoted) }]);
    quoted = [];
  };

  for (const m of msgs) {
    if (quotedOf(m)) {
      if (quoted.length && quotedOf(quoted[0])?.fingerprint !== quotedOf(m)?.fingerprint) flushQuoted();
      quoted.push(m);
      continue;
    }
    flushQuoted();
    if (m.kind === 'summary') {
      push('user', [{ type: 'text', text: `<conversation_summary>\n${SUMMARY_PREAMBLE}\n\n${textOf(m.content)}\n</conversation_summary>` }]);
      continue;
    }
    if (m.kind === 'aside') {
      const who = [m.author, m.model].filter(Boolean).join(', ');
      const body = textOf(m.content) || '(no text)';
      push('user', [{ type: 'text', text: `<aside from="${who}">\n${body}\n</aside>` }]);
      continue;
    }
    if (m.role === 'assistant') {
      const content: ContentBlock[] = [];
      // flattened calls go in front of the calls that stay: text after a tool_use reads as a prefill to the API
      const flatText: TextBlock[] = [];
      for (const b of m.content) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          if (m.model === opts.modelRef && m.seq >= noThinkingBefore) content.push(b);
          continue;
        }
        if (b.type === 'tool_use') {
          const res = results.get(b.id);
          const external = res?.meta?.external === true;
          // a call the loop answered itself (unknown name, or a name matched without case) stays a call
          const answered = !!res && (res.meta?.unknownTool === true || typeof res.meta?.resolvedTool === 'string');
          if (external || !res || !opts.toolNames.size || (!opts.toolNames.has(b.name) && !answered)) {
            flattened.add(b.id);
            const resText = res ? truncateMiddle(resultText(res), 1500, 'omitted').text : 'no result';
            flatText.push({ type: 'text', text: `[${b.name}: ${inputSummary(b.input)}]\n[result${res?.isError ? ' (error)' : ''}: ${resText}]` });
            continue;
          }
          // a refused Write or Edit (not read, or changed since) sends its payload once only (HARNESS-REVIEW item 17)
          const refused = res?.meta?.writeRefused === true && payloadChars(b.input) > CLEAR_MIN_CHARS ? { at: 0, chars: payloadChars(b.input) } : undefined;
          const cleared = (res?.meta?.inputCleared as ClearMark | undefined) ?? refused;
          content.push({ ...b, id: sanitizeToolId(b.id), ...(cleared ? { input: stubInput(b.input, cleared.chars) } : {}) } as ToolUseBlock);
          continue;
        }
        if (b.type === 'text' && !b.text.trim()) continue;
        content.push(b);
      }
      const firstUse = content.findIndex((b) => b.type === 'tool_use');
      if (firstUse < 0) content.push(...flatText);
      else content.splice(firstUse, 0, ...flatText);
      push('assistant', content);
      continue;
    }
    // user
    const content: ContentBlock[] = [];
    const texts = opts.imageText ? (m.meta?.imageText as Record<string, string> | undefined) : undefined;
    const asText = <B extends ContentBlock>(b: B): B | TextBlock => (texts && b.type === 'image' && texts[imageKey(b)] ? { type: 'text', text: texts[imageKey(b)] } : b);
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        if (flattened.has(b.toolUseId)) continue;
        const cleared = b.meta?.cleared as ClearMark | undefined;
        const id = typeof b.meta?.outputId === 'string' ? b.meta.outputId : b.toolUseId;
        const body = cleared ? clearedText(cleared.chars, id) : texts && typeof b.content !== 'string' ? (b.content.map(asText) as ToolResultBlock['content']) : b.content;
        content.push({ type: 'tool_result', toolUseId: sanitizeToolId(b.toolUseId), content: body, isError: b.isError });
        continue;
      }
      content.push(asText(b));
    }
    push('user', content);
  }
  flushQuoted();

  // transcript must start with a user turn
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] });

  // every tool_use gets one tool_result in the next user message, in order; stray results become text;
  // the transcript ends with a user turn (pairing.ts, also run on every request in streamCompletion)
  const guarded = guardTranscript(out).messages;

  const final = guarded;

  if (opts.cache) {
    let marked = 0;
    for (let i = final.length - 1; i >= 0 && marked < 2; i--) {
      if (final[i].role === 'user') {
        final[i].cache = true;
        marked++;
      }
    }
  }
  return final;
}

/** Plain-text rendering of a conversation, for handoffs, second opinions and exports. */
export function renderTranscript(
  msgs: Message[],
  opts: { maxChars?: number; includeTools?: boolean; includeThinking?: boolean } = {},
): string {
  const lines: string[] = [];
  const results = new Map<string, ToolResultBlock>();
  for (const m of msgs) for (const b of m.content) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  for (const m of activeMessages(msgs)) {
    if (m.kind === 'summary') {
      lines.push(`## Summary of earlier conversation\n\n${textOf(m.content)}`);
      continue;
    }
    const q = quotedOf(m);
    const role = m.kind === 'aside' ? `${m.author ?? 'Aside'} (${m.model ?? 'unknown'})` : m.role === 'user' ? 'User' : `Assistant (${m.model ?? 'unknown'})`;
    // a message quoted from a friend's hub says so, so a summary or a handoff keeps where it came from
    const who = q ? `Quoted from ${q.from}: ${m.role === 'user' ? 'User' : `Assistant (${m.model ?? 'unknown'})`}` : role;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && !isReminder(b)) parts.push(b.text);
      else if (b.type === 'thinking' && opts.includeThinking) parts.push(`(thinking) ${b.thinking}`);
      else if (b.type === 'image') parts.push('[image]');
      else if (b.type === 'tool_use' && opts.includeTools !== false) {
        const r = results.get(b.id);
        parts.push(`[tool ${b.name}: ${inputSummary(b.input)}]${r ? `\n[result: ${truncateMiddle(resultText(r), 800, 'omitted').text}]` : ''}`);
      }
    }
    const text = parts.join('\n\n').trim();
    if (text) lines.push(`### ${who}\n\n${text}`);
  }
  let out = lines.join('\n\n');
  if (opts.maxChars && out.length > opts.maxChars) out = truncateMiddle(out, opts.maxChars, 'of earlier conversation omitted').text;
  return out;
}

/** Final assistant text of a turn (last assistant message's text). */
export function lastAssistantText(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.kind === 'normal' && !quotedOf(m)) {
      const t = textOf(m.content);
      if (t) return t;
    }
  }
  return '';
}

export function messageText(m: Message): string {
  return textOf(m.content);
}

/** User-authored text of a message, ignoring system reminders. */
export function userText(m: Message): string {
  return textOf(m.content);
}

/** The text of the newest normal user message: the question a jury or a debate takes up. */
export function lastQuestion(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && msgs[i].kind === 'normal' && !quotedOf(msgs[i])) return userText(msgs[i]);
  return '';
}
