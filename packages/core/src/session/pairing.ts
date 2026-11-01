import type { ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../types';
import type { ProviderMessage } from '../providers/types';
import { ProviderError } from '../providers/types';
import { oneLine, truncateMiddle } from '../util/text';

/**
 * The last check before a model request. The Messages API rejects a
 * transcript that ends with an assistant turn ("does not support assistant
 * message prefill") or that leaves a tool_use without its tool_result, and a
 * 400 there used to end the run. This repairs the shape instead:
 *
 * - no empty messages, no two messages of the same role in a row, a user turn first
 * - in an assistant message, no text after the first tool_use (it is moved in
 *   front of the calls; thinking keeps its place)
 * - every tool_use gets exactly one tool_result in the next user message, in
 *   the same order and before any other block; a missing one gets an error result
 * - a tool_result that answers no call in the turn before becomes text
 * - the transcript ends with a user turn
 */

export const MISSING_RESULT = 'No result was recorded for this call. It did not run, or its result was lost. Check the current state before you retry it.';
export const CONTINUE_NOTE = 'Continue.';

export interface GuardResult {
  messages: ProviderMessage[];
  /** What was changed, for the log. Empty when the transcript was already valid. */
  repairs: string[];
}

function resultText(r: ToolResultBlock): string {
  if (typeof r.content === 'string') return r.content;
  return r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
}

function asText(r: ToolResultBlock): TextBlock {
  return { type: 'text', text: `[tool result${r.isError ? ' (error)' : ''}: ${truncateMiddle(resultText(r), 1500, 'omitted').text}]` };
}

export function guardTranscript(input: ProviderMessage[]): GuardResult {
  const repairs: string[] = [];
  // copy, dropping empty messages and merging runs of one role
  const out: ProviderMessage[] = [];
  for (const m of input) {
    if (!m.content.length) {
      repairs.push('dropped an empty message');
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
      if (m.cache) last.cache = true;
      repairs.push(`merged two ${m.role} messages`);
    } else {
      out.push({ ...m, content: [...m.content] });
    }
  }
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] });
    repairs.push('added a user turn at the start');
  }

  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'assistant') continue;
    // one tool_use per id; text after the first call moves in front of the calls (thinking keeps its place)
    const seen = new Set<string>();
    const kept: ContentBlock[] = [];
    const uses: ToolUseBlock[] = [];
    const moved: TextBlock[] = [];
    const firstCall = m.content.findIndex((b) => b.type === 'tool_use');
    // Interleaved signed thinking binds the surrounding block sequence too.
    const interleaved = firstCall >= 0 && m.content.slice(firstCall + 1).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    let firstUse = -1;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        if (seen.has(b.id)) {
          repairs.push(`dropped a second tool_use with id ${b.id}`);
          continue;
        }
        seen.add(b.id);
        uses.push(b);
        if (firstUse < 0) firstUse = kept.length;
      } else if (!interleaved && firstUse >= 0 && b.type === 'text') {
        moved.push(b);
        continue;
      }
      kept.push(b);
    }
    if (moved.length) {
      kept.splice(firstUse, 0, ...moved);
      repairs.push('moved text that followed tool calls in front of them');
    }
    m.content = kept;
    if (!uses.length) continue;

    let next = out[i + 1];
    if (!next || next.role !== 'user') {
      next = { role: 'user', content: [] };
      out.splice(i + 1, 0, next);
    }
    const pool = new Map<string, ToolResultBlock>();
    const rest: ContentBlock[] = [];
    for (const b of next.content) {
      if (b.type !== 'tool_result') rest.push(b);
      else if (!seen.has(b.toolUseId) || pool.has(b.toolUseId)) {
        rest.push(asText(b));
        repairs.push(`turned a stray tool_result (${b.toolUseId}) into text`);
      } else pool.set(b.toolUseId, b);
    }
    const ordered: ToolResultBlock[] = uses.map((u) => {
      const r = pool.get(u.id);
      if (r) return r;
      repairs.push(`added an error result for ${u.name} (${u.id})`);
      return { type: 'tool_result', toolUseId: u.id, content: MISSING_RESULT, isError: true };
    });
    next.content = [...ordered, ...rest];
  }

  // results that answer no call in the turn before
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'user') continue;
    const prev = out[i - 1];
    const ids = new Set(prev?.role === 'assistant' ? prev.content.filter((b): b is ToolUseBlock => b.type === 'tool_use').map((b) => b.id) : []);
    if (!m.content.some((b) => b.type === 'tool_result' && !ids.has(b.toolUseId))) continue;
    m.content = m.content.map((b) => (b.type === 'tool_result' && !ids.has(b.toolUseId) ? asText(b) : b));
    repairs.push('turned a tool_result with no call before it into text');
  }

  if (out.length && out[out.length - 1].role === 'assistant') {
    out.push({ role: 'user', content: [{ type: 'text', text: CONTINUE_NOTE }] });
    repairs.push('the transcript ended with an assistant turn; added a user turn');
  }
  return { messages: out, repairs };
}

/**
 * A stronger repair for the one retry after the API still rejected the shape:
 * the calls of the last assistant turn that made any become text, with their
 * results, and that turn's thinking is dropped (it no longer matches).
 */
export function flattenLastToolTurn(input: ProviderMessage[]): ProviderMessage[] {
  const msgs = input.map((m) => ({ ...m, content: [...m.content] }));
  let i = msgs.length - 1;
  while (i >= 0 && !(msgs[i].role === 'assistant' && msgs[i].content.some((b) => b.type === 'tool_use'))) i--;
  if (i < 0) return guardTranscript(msgs).messages;
  const results = new Map<string, ToolResultBlock>();
  const next = msgs[i + 1];
  if (next?.role === 'user') {
    for (const b of next.content) if (b.type === 'tool_result') results.set(b.toolUseId, b);
    next.content = next.content.filter((b) => b.type !== 'tool_result');
  }
  const text: ContentBlock[] = [];
  for (const b of msgs[i].content) {
    if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
    if (b.type !== 'tool_use') {
      text.push(b);
      continue;
    }
    const r = results.get(b.id);
    const res = r ? truncateMiddle(resultText(r), 1500, 'omitted').text : 'no result';
    text.push({ type: 'text', text: `[${b.name}: ${oneLine(JSON.stringify(b.input ?? {}), 160)}]\n[result${r?.isError ? ' (error)' : ''}: ${res}]` });
  }
  msgs[i].content = text.length ? text : [{ type: 'text', text: '(no text)' }];
  if (next?.role === 'user' && !next.content.length) next.content = [{ type: 'text', text: CONTINUE_NOTE }];
  return guardTranscript(msgs).messages;
}

/** A 400 that says the transcript shape is wrong: it ends with an assistant turn, or a call and its result do not pair. */
export function isTranscriptShapeError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.kind !== 'bad_request' && err.status !== 400) return false;
  const text = `${err.message} ${err.body ?? ''}`;
  return /prefill|must end with a user message|tool_use.{0,80}(without|tool_result)|tool_result.{0,80}(tool_use|corresponding)|tool_use_id/i.test(text);
}
