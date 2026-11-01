/**
 * Cache-stable context editing (HARNESS-REVIEW item 12).
 *
 * Old tool output is cleared in one batch, not a little more on every turn:
 * the newest CLEAR_PROTECT_TOKENS of tool output stay, and only when the
 * prunable output older than that passes CLEAR_BATCH_TOKENS is all of it
 * cleared in one pass. Each decision is stored on the message
 * (`meta.cleared` on the tool_result, `meta.inputCleared` for an old Write or
 * Edit payload), and buildProviderMessages reads only those marks, so every
 * later request sends the same bytes and the prompt cache misses once per
 * batch instead of once per turn. The stored content never changes: the app
 * still shows the full output, and ReadToolOutput reads it back by id.
 */
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '../types';
import type { Engine } from '../engine/engine';
import { activeMessages } from './transcript';

/** Tool output kept as it is, newest first, in tokens. */
export const CLEAR_PROTECT_TOKENS = 50_000;
/** Prunable output older than the protected part that starts a batch, in tokens. */
export const CLEAR_BATCH_TOKENS = 30_000;
/** Results and payloads at most this long are never cleared. */
export const CLEAR_MIN_CHARS = 2_000;
/** Results the model needs whole for as long as they are in context. */
export const CLEAR_EXEMPT = new Set(['TodoWrite', 'Skill', 'MemorySearch', 'SessionSearch', 'Task', 'Delegate', 'ToolSearch', 'TaskResult', 'StructuredOutput']);

/** Tools whose old payloads are stubbed once a later call on the same path succeeded. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit']);

export interface ClearMark {
  at: number;
  chars: number;
}

export interface ClearOptions {
  protectTokens?: number;
  batchTokens?: number;
  minChars?: number;
}

/** What one batch clears: tool_result ids, and tool_use ids whose input is stubbed. */
export interface ClearPlan {
  results: Map<string, number>;
  inputs: Map<string, number>;
}

function resultChars(r: ToolResultBlock): number {
  if (typeof r.content === 'string') return r.content.length;
  // an image counts like ~1,500 tokens, as in the request estimate
  return r.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 6_000), 0);
}

/** Size of the strings a Write, Edit or MultiEdit sends, the part a stub replaces. */
export function payloadChars(input: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (k === 'file_path') continue;
    if (typeof v === 'string') n += v.length;
    else if (Array.isArray(v)) for (const e of v) if (e && typeof e === 'object') n += payloadChars(e as Record<string, unknown>);
  }
  return n;
}

/** The input sent for a call whose payload was cleared: the path stays, long strings become a note. */
export function stubInput(input: Record<string, unknown>, chars: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && k !== 'file_path' && v.length > 200) out[k] = `[${v.length} chars cleared to save context]`;
    else if (Array.isArray(v)) out[k] = v.map((e) => (e && typeof e === 'object' ? stubInput(e as Record<string, unknown>, 0) : e));
    else out[k] = v;
  }
  if (chars && !Object.values(out).some((v) => typeof v === 'string' && v.startsWith('['))) out._cleared = `${chars} chars cleared to save context`;
  return out;
}

/** The text a cleared result is sent as. */
export function clearedText(chars: number, outputId: string): string {
  return `[Old tool result cleared to save context (${chars} chars). Full output id: ${outputId}, readable with ReadToolOutput.]`;
}

/**
 * Which results and payloads one batch clears, or an empty plan when the old
 * prunable output is still under the batch threshold. Pure: it reads the
 * active messages and the marks already on them.
 */
export function planClearing(active: Message[], opts: ClearOptions = {}): ClearPlan {
  const protect = (opts.protectTokens ?? CLEAR_PROTECT_TOKENS) * 4;
  const batch = (opts.batchTokens ?? CLEAR_BATCH_TOKENS) * 4;
  const minChars = opts.minChars ?? CLEAR_MIN_CHARS;
  const plan: ClearPlan = { results: new Map(), inputs: new Map() };

  const uses = new Map<string, ToolUseBlock>();
  const results = new Map<string, ToolResultBlock>();
  for (const m of active) {
    for (const b of m.content) {
      if (b.type === 'tool_use') uses.set(b.id, b);
      else if (b.type === 'tool_result') results.set(b.toolUseId, b);
    }
  }

  // newest successful call per path, by position, so an older write knows a later one replaced what it sent
  type Item = { kind: 'result' | 'input'; id: string; chars: number; prunable: boolean };
  const items: Item[] = [];
  const lastTouch = new Map<string, number>();
  let pos = 0;
  const order: Array<{ use: ToolUseBlock; pos: number }> = [];
  for (const m of active) {
    if (m.kind === 'summary') continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'tool_use') {
        pos++;
        order.push({ use: b, pos });
        const r = results.get(b.id);
        const path = typeof b.input?.file_path === 'string' ? b.input.file_path : undefined;
        if (path && PATH_TOOLS.has(b.name) && r && !r.isError) lastTouch.set(path, pos);
        if (WRITE_TOOLS.has(b.name) && r?.meta?.inputCleared === undefined) {
          const chars = payloadChars(b.input ?? {});
          items.push({ kind: 'input', id: b.id, chars, prunable: false });
        }
      } else if (b.type === 'tool_result') {
        const name = uses.get(b.toolUseId)?.name ?? '';
        if (b.meta?.cleared !== undefined || b.meta?.external === true) continue;
        const chars = resultChars(b);
        items.push({ kind: 'result', id: b.toolUseId, chars, prunable: chars > minChars && !CLEAR_EXEMPT.has(name) });
      }
    }
  }
  // an old payload is prunable once a later Read or write of its path succeeded
  const posOf = new Map(order.map((o) => [o.use.id, o.pos]));
  for (const it of items) {
    if (it.kind !== 'input' || it.chars <= minChars) continue;
    const use = uses.get(it.id)!;
    const path = typeof use.input?.file_path === 'string' ? use.input.file_path : undefined;
    const later = path ? lastTouch.get(path) : undefined;
    it.prunable = later !== undefined && later > (posOf.get(it.id) ?? 0);
  }

  // newest first: the first `protect` chars of tool output stay; the prunable output past them is the candidate batch
  let seen = 0;
  let old = 0;
  const candidates: Item[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (seen < protect) {
      seen += it.chars;
      continue;
    }
    if (!it.prunable) continue;
    old += it.chars;
    candidates.push(it);
  }
  if (old <= batch) return plan;
  for (const it of candidates) (it.kind === 'result' ? plan.results : plan.inputs).set(it.id, it.chars);
  return plan;
}

/** Messages that hold a result the plan clears, with the marks set (the content itself stays). */
export function markCleared(all: Message[], plan: ClearPlan, at: number): Message[] {
  const out: Message[] = [];
  for (const m of all) {
    if (m.role !== 'user' || !m.content.some((b) => b.type === 'tool_result' && (plan.results.has(b.toolUseId) || plan.inputs.has(b.toolUseId)))) continue;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result') return b;
      const r = plan.results.get(b.toolUseId);
      const i = plan.inputs.get(b.toolUseId);
      if (r === undefined && i === undefined) return b;
      const meta = { ...(b.meta ?? {}) };
      if (r !== undefined) meta.cleared = { at, chars: r } satisfies ClearMark;
      if (i !== undefined) meta.inputCleared = { at, chars: i } satisfies ClearMark;
      return { ...b, meta };
    });
    out.push({ ...m, content });
  }
  return out;
}

/**
 * Plan and store one clearing batch for a session. Returns how many results
 * and payloads it cleared (0 when the threshold was not reached). `all` is the
 * caller's already-read active list (transcript.ts activeStored), so a step
 * shares one transcript read with this pass; without it the full list is read.
 */
export function applyClearing(engine: Engine, sessionId: string, opts: ClearOptions = {}, all: Message[] = engine.repos.messages.list(sessionId)): number {
  const plan = planClearing(activeMessages(all), opts);
  const n = plan.results.size + plan.inputs.size;
  if (!n) return 0;
  for (const m of markCleared(all, plan, Date.now())) engine.updateMessage(m.id, { content: m.content });
  engine.audit(sessionId, 'context:clear', `${plan.results.size} results and ${plan.inputs.size} write payloads cleared`);
  return n;
}
