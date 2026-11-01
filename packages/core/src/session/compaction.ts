import type { ProviderMessage, SystemBlock, ToolSpec } from '../providers/types';
import type { Message, Session, TextBlock, ToolResultBlock } from '../types';
import type { Engine } from '../engine/engine';
import { activeMessages, isReminder, lastAssistantText } from './transcript';
import { COMPACT_PROMPT, COMPACT_UPDATE_RULES, SUMMARY_HEADINGS } from './prompt';
import { estimateTokens, oneLine, truncateMiddle } from '../util/text';
import { streamCompletion } from './stream';
import { logger } from '../util/log';
import { projectsOf } from '../projects/attached';

const log = logger('compaction');

export function estimateRequestTokens(system: SystemBlock[], messages: ProviderMessage[], tools: ToolSpec[]): number {
  let chars = 0;
  for (const s of system) chars += s.text.length;
  for (const t of tools) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'thinking') chars += b.thinking.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length;
      else if (b.type === 'tool_result') chars += typeof b.content === 'string' ? b.content.length : 2000;
      else chars += 1500; // images
    }
  }
  return Math.ceil(chars / 4);
}

/** What the last provider call of a runner reported, to anchor the next estimate on (HARNESS-REVIEW item 8). */
export interface TokenMeter {
  model: string;
  systemHash: string;
  toolsHash: string;
  /** Input (uncached, cache reads and cache writes) plus output tokens of the last call. */
  baseTokens: number;
  /** Seq of the reply that call wrote; messages after it are counted by chars. */
  throughSeq: number;
}

/** A stable hash of a request part (system blocks, tool specs) for the meter. */
export function partHash(v: unknown): string {
  return Bun.hash(JSON.stringify(v)).toString(36);
}

/**
 * Request size anchored on the last real usage: what the provider counted
 * for the last request and its reply, plus chars/4 of the messages stored
 * after that reply. Undefined when the meter does not apply: another model,
 * system prompt or tool set, or no usage reported.
 */
export function meteredTokens(meter: TokenMeter | undefined, now: Pick<TokenMeter, 'model' | 'systemHash' | 'toolsHash'>, stored: Message[]): number | undefined {
  if (!meter || meter.baseTokens <= 0) return undefined;
  if (meter.model !== now.model || meter.systemHash !== now.systemHash || meter.toolsHash !== now.toolsHash) return undefined;
  return meter.baseTokens + regionTokens(activeMessages(stored).filter((m) => m.seq > meter.throughSeq));
}

/** Verbatim user messages kept with every summary: total and per-message caps, in chars. */
export const VERBATIM_TOTAL_CHARS = 24_000;
export const VERBATIM_MESSAGE_CHARS = 4_000;
/** Paths listed under "Files touched". */
export const FILES_TOUCHED_MAX = 40;
/** After a failed model summary, auto compaction skips the model for this long. */
export const COMPACTION_LATCH_MS = 30 * 60_000;
/** Longest wait for the summary model. */
export const COMPACTION_TIMEOUT_MS = 120_000;

export const FALLBACK_NOTE =
  '[Context reduced without a new summary. Earlier messages are excluded, not deleted. Check the real state before repeating actions whose outcome is missing.]';

const FILE_TOOLS: Record<string, string> = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** What maybeCompact stores in a summary message's meta. */
export interface SummaryMeta {
  coversThroughSeq: number;
  trigger: 'auto' | 'manual';
  compactedAt: number;
  /** The summary was written without the model (fallback) or failed a check. */
  qualityDegraded?: boolean;
  fallback?: 'no_llm';
  /** What the audit found missing in the model summary that was kept (after one retry). */
  audit?: string[];
  /** Real user messages quoted in the verbatim section. */
  userMessages: number;
  /** The quoted messages and touched files, carried into the next compaction. */
  verbatim?: string[];
  files?: string[];
  /**
   * Where the summary proper sits in the text: the model's summary, or the
   * earlier one a fallback carries. The next compaction carries only this
   * part, so repeated fallbacks do not nest the sections again and again.
   */
  summaryRange?: [number, number];
  /** A switch's short handover (modes/handoff.ts): the models it went from and to. */
  switch?: { from: string; to: string };
  /**
   * Set by a switch's short handover before v0.4.13. The turns kept after
   * every summary now go without thinking (transcript.ts thinkingAfterSummary),
   * so it is no longer read.
   */
  dropTailThinking?: boolean;
}

/**
 * Text of a user message without reminders, or undefined for tool results
 * and reminder-only messages. Generated nudges (Stop hook feedback, wake
 * turns, continuation notes) are reminders, so they drop out; auto turns
 * with plain text (a routine's prompt) are the user's words and stay.
 */
function realUserText(m: Message): string | undefined {
  if (m.role !== 'user' || m.kind !== 'normal') return undefined;
  const text = m.content
    .filter((b): b is TextBlock => b.type === 'text' && !isReminder(b))
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || undefined;
}

/**
 * The user's own messages in a region, newest first, each cut to
 * VERBATIM_MESSAGE_CHARS, until VERBATIM_TOTAL_CHARS is used. Messages
 * quoted by an earlier summary follow the region's own.
 */
export function verbatimUserMessages(region: Message[], carried: string[] = []): { quoted: string[]; omitted: number } {
  const cutText = (text: string) =>
    text.length > VERBATIM_MESSAGE_CHARS ? `${text.slice(0, VERBATIM_MESSAGE_CHARS)} [... ${text.length - VERBATIM_MESSAGE_CHARS} chars cut]` : text;
  // carried messages were cut when first quoted; cutting them again would count the marker as message text
  const all = [
    ...region
      .map(realUserText)
      .filter((t): t is string => !!t)
      .reverse()
      .map(cutText),
    ...carried.filter((t): t is string => typeof t === 'string').map((t) => (t.length > VERBATIM_MESSAGE_CHARS + 64 ? cutText(t) : t)),
  ];
  const quoted: string[] = [];
  let used = 0;
  for (const cut of all) {
    if (used + cut.length > VERBATIM_TOTAL_CHARS) break;
    quoted.push(cut);
    used += cut.length;
  }
  return { quoted, omitted: all.length - quoted.length };
}

/**
 * Paths that Read, Edit, Write, MultiEdit and NotebookEdit touched in a
 * region, newest first, then carried ones. With the roots of the session's
 * project, paths under them are listed relative to the project, so they stay
 * right after the session moves to another device (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.7).
 */
export function filesTouched(region: Message[], carried: string[] = [], roots: string[] = []): string[] {
  const rel = (p: string): string => {
    for (const r of roots) {
      if (p === r) return '.';
      if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
    }
    return p;
  };
  const out: string[] = [];
  for (let i = region.length - 1; i >= 0; i--) {
    const blocks = region[i].content;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type !== 'tool_use' || !FILE_TOOLS[b.name]) continue;
      const raw = b.input?.[FILE_TOOLS[b.name]];
      const p = typeof raw === 'string' && raw ? rel(raw) : undefined;
      if (p && !out.includes(p)) out.push(p);
    }
  }
  for (const c of carried) {
    const p = typeof c === 'string' ? rel(c) : c;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, FILES_TOUCHED_MAX);
}

/** Summarizer input budget in chars (about 30k tokens, within any small model's window). */
export const SUMMARY_INPUT_CHARS = 120_000;
/** One entry (a message) is cut to this many chars before the budget is filled. */
const ENTRY_MAX_CHARS = 12_000;
/** Kept tail: this share of the window, clamped, in tokens (Hermes). */
const TAIL_SHARE = 0.025;
const TAIL_MIN_TOKENS = 10_000;
const TAIL_MAX_TOKENS = 25_000;

function resultText(r: ToolResultBlock): string {
  if (typeof r.content === 'string') return r.content;
  return r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}

function inputLine(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) if (typeof input[k] === 'string') return oneLine(input[k] as string, 200);
  return oneLine(JSON.stringify(input), 200);
}

/** One message as summarizer text, or '' when it carries nothing to read (a tool-results-only message). */
function renderEntry(m: Message, results: Map<string, ToolResultBlock>): string {
  const who = m.kind === 'aside' ? `${m.author ?? 'Aside'} (${m.model ?? 'unknown'})` : m.role === 'user' ? 'User' : `Assistant (${m.model ?? 'unknown'})`;
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === 'text' && !isReminder(b)) parts.push(b.text);
    else if (b.type === 'image') parts.push('[image]');
    else if (b.type === 'tool_use') {
      const r = results.get(b.id);
      parts.push(`[tool ${b.name}: ${inputLine(b.input)}]${r ? `\n[result${r.isError ? ' (error)' : ''}: ${truncateMiddle(resultText(r), 800, 'omitted').text}]` : ''}`);
    }
  }
  const text = parts.join('\n\n').trim();
  return text ? truncateMiddle(`### ${who}\n\n${text}`, ENTRY_MAX_CHARS, 'of this message omitted').text : '';
}

/**
 * The region as summarizer input, filled by priority instead of cut in the
 * middle (OpenClaw): the newest entries up to half the budget, older user
 * messages a quarter, the oldest entries a tenth, and the rest in 8 runs
 * spread over what is left. Entries stay in source order, with a marker
 * that counts each gap.
 */
export function summarizerInput(region: Message[], budget = SUMMARY_INPUT_CHARS): string {
  const results = new Map<string, ToolResultBlock>();
  for (const m of region) for (const b of m.content) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  const entries = region.map((m) => ({ m, text: renderEntry(m, results) })).filter((e) => e.text);
  const total = entries.reduce((n, e) => n + e.text.length + 2, 0);
  if (total <= budget) return entries.map((e) => e.text).join('\n\n');

  const picked = new Set<number>();
  const take = (indices: number[], share: number) => {
    let used = 0;
    for (const i of indices) {
      if (picked.has(i)) continue;
      const len = entries[i].text.length + 2;
      if (used + len > share) {
        if (used === 0) continue;
        break;
      }
      picked.add(i);
      used += len;
    }
  };
  const all = entries.map((_, i) => i);
  take([...all].reverse(), budget * 0.5);
  take(all.filter((i) => entries[i].m.role === 'user' && entries[i].m.kind === 'normal').reverse(), budget * 0.25);
  take(all, budget * 0.1);
  // 8 runs spread evenly over the entries not picked yet
  const rest = all.filter((i) => !picked.has(i));
  const runs = 8;
  for (let r = 0; r < runs && rest.length; r++) take(rest.slice(Math.floor((r * rest.length) / runs)), (budget * 0.15) / runs);

  const out: string[] = [];
  let gap = 0;
  let gapUsers = 0;
  const marker = () => `[... ${gap} messages omitted here, ${gapUsers} of them from the user ...]`;
  for (let i = 0; i < entries.length; i++) {
    if (!picked.has(i)) {
      gap++;
      if (entries[i].m.role === 'user') gapUsers++;
      continue;
    }
    if (gap) out.push(marker());
    gap = 0;
    gapUsers = 0;
    out.push(entries[i].text);
  }
  if (gap) out.push(marker());
  return out.join('\n\n');
}

/** Identifier kinds the anchor index keeps, with a cap per kind. */
const ANCHOR_KINDS: Array<{ kind: string; cap: number; re: RegExp; ok?: (s: string) => boolean }> = [
  { kind: 'issues and PRs', cap: 10, re: /(?:^|[\s(])(#\d{1,6})\b|\/(?:pull|issues)\/(\d{1,6})\b/g },
  { kind: 'commits', cap: 10, re: /\b([0-9a-f]{7,40})\b/g, ok: (s) => /\d/.test(s) && /[a-f]/.test(s) },
  { kind: 'branches', cap: 8, re: /(?:\bbranch\s+|\bcheckout\s+-b\s+|\bswitch\s+-c\s+|\borigin\/)(\w[\w./-]*\w)/g },
  { kind: 'urls', cap: 10, re: /(https?:\/\/[^\s)'"<>\]`]+)/g },
  { kind: 'paths', cap: 20, re: /(?:^|[\s'"`(=])((?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+)/g },
  { kind: 'errors', cap: 10, re: /\b([A-Z][A-Za-z]+(?:Error|Exception)|E[A-Z]{3,9})\b/g },
];

function messageTexts(m: Message, withResults: boolean): string[] {
  const out: string[] = [];
  for (const b of m.content) {
    if (b.type === 'text' && !isReminder(b)) out.push(b.text);
    else if (b.type === 'tool_use') out.push(Object.values(b.input ?? {}).filter((v): v is string => typeof v === 'string').join(' '));
    else if (b.type === 'tool_result' && withResults) out.push(resultText(b).slice(0, 20_000));
  }
  return out;
}

/**
 * Exact identifiers in a region, newest first, capped per kind (Hermes):
 * issue and PR numbers, commit SHAs, branches, URLs, paths, error names.
 * withResults: also scan tool output (the index does; the audit does not).
 */
export function anchorIndex(region: Message[], withResults = true): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { kind } of ANCHOR_KINDS) out[kind] = [];
  for (let i = region.length - 1; i >= 0; i--) {
    for (const text of messageTexts(region[i], withResults)) {
      for (const { kind, cap, re, ok } of ANCHOR_KINDS) {
        const list = out[kind];
        if (list.length >= cap) continue;
        for (const m of text.matchAll(re)) {
          const v = (m[1] ?? (m[2] ? `#${m[2]}` : '')).replace(/[.,:;]+$/, '');
          if (!v || (ok && !ok(v)) || list.includes(v)) continue;
          list.push(v);
          if (list.length >= cap) break;
        }
      }
    }
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

/**
 * What a model summary misses (OpenClaw audit): a template heading, or one
 * of up to 12 identifiers from the region's last 10 messages (said or sent,
 * not tool output). Empty when it passes.
 */
export function auditSummary(summary: string, region: Message[]): string[] {
  const problems: string[] = [];
  const lower = summary.toLowerCase();
  for (const h of SUMMARY_HEADINGS) if (!lower.includes(`## ${h.toLowerCase()}`)) problems.push(`missing heading "## ${h}"`);
  const ids = Object.values(anchorIndex(region.slice(-10), false)).flat().slice(0, 12);
  for (const id of ids) if (!summary.includes(id)) problems.push(`missing identifier ${id}`);
  return problems;
}

/** The anchor index as a summary section. */
export function anchorSection(index: Record<string, string[]>): string {
  const lines = Object.entries(index).map(([kind, list]) => `- ${kind}: ${list.join(', ')}`);
  return lines.length ? `## Anchor index (exact identifiers in the compacted messages)\n\n${lines.join('\n')}` : '';
}

/** The sections every summary ends with, built without the model. root: the project folder relative paths start at. */
export function deterministicSections(quoted: string[], omitted: number, files: string[], root?: string): string {
  const parts: string[] = [];
  if (quoted.length) {
    parts.push(
      `## User messages (verbatim, newest first)\n\n${quoted.map((q, i) => `${i + 1}. ${q.replace(/\n/g, '\n   ')}`).join('\n')}${omitted ? `\n\n(${omitted} older user messages not quoted.)` : ''}`,
    );
  }
  if (files.length) parts.push(`## Files touched${root ? ` (relative paths are inside the project folder, now ${root})` : ''}\n\n${files.map((f) => `- ${f}`).join('\n')}`);
  return parts.join('\n\n');
}

/** Rough size of stored messages in tokens, counted like a request. */
export function regionTokens(msgs: Message[]): number {
  let chars = 0;
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'thinking') chars += b.thinking.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length;
      else if (b.type === 'tool_result') chars += typeof b.content === 'string' ? b.content.length : 2000;
      else chars += 1500;
    }
  }
  return Math.ceil(chars / 4);
}

function latchedUntil(meta: Record<string, unknown> | undefined): number {
  const c = meta?.compaction as { latchedUntil?: unknown } | undefined;
  return typeof c?.latchedUntil === 'number' ? c.latchedUntil : 0;
}

function isLatched(meta: Record<string, unknown> | undefined, now: number, modelRef: string): boolean {
  const c = meta?.compaction as { latchedUntil?: unknown; model?: unknown } | undefined;
  if (typeof c?.latchedUntil !== 'number' || c.latchedUntil <= now) return false;
  return !c.model || c.model === modelRef;
}

async function summaryCandidates(engine: Engine, modelRef: string, session: Session): Promise<string[]> {
  const cfg = engine.config.get();
  const accountId = session.accountId;
  const out: string[] = [];
  const add = (m?: string) => {
    if (!m || out.includes(m) || !engine.isUsable(m, accountId)) return;
    try {
      if (engine.providersFor(accountId).resolve(m).acp) return;
    } catch {
      return;
    }
    out.push(m);
  };
  add(cfg.smallModel);
  add(modelRef);
  // limits imports regionTokens from this module; load its policy after module initialization.
  const { limitFallback } = await import('./limits');
  const tried = [...out];
  const agent = engine.agentFor(session);
  for (;;) {
    const next = limitFallback(engine, accountId, modelRef, tried, agent);
    if (!next || tried.includes(next)) break;
    tried.push(next);
    add(next);
  }
  return out;
}

/**
 * Summarize the conversation and replace it with a summary message. Everything
 * before the summary is skipped when building later requests (the rows stay).
 * A PreCompact hook runs first and can add custom instructions or block it.
 *
 * This cannot fail the turn: when the summary model errors, times out,
 * returns nothing or returns a summary no smaller than what it replaces, a
 * summary is written without the model (FALLBACK_NOTE, the previous summary,
 * then the deterministic sections) and flagged qualityDegraded. A failed
 * model summary latches auto compaction onto the fallback for
 * COMPACTION_LATCH_MS; manual compaction always tries the model. One
 * compaction runs at a time per session.
 *
 * Returns false only when nothing was compacted (too little history, a hook
 * blocked it, another compaction is running, or the user aborted).
 */
export async function maybeCompact(
  engine: Engine,
  sessionId: string,
  modelRef: string,
  signal: AbortSignal,
  trigger: 'auto' | 'manual',
  instructions?: string,
  opts: CompactOptions = {},
): Promise<boolean> {
  if (engine.compacting.has(sessionId)) return false;
  engine.compacting.add(sessionId);
  try {
    return await compact(engine, sessionId, modelRef, signal, trigger, instructions?.trim() || undefined, opts);
  } finally {
    engine.compacting.delete(sessionId);
  }
}

export interface CompactOptions {
  /**
   * More for the summary message's meta. A switch's short handover sets
   * `switch` ({ from, to }). The kept turns go without thinking after every
   * summary (transcript.ts thinkingAfterSummary), since thinking kept after a
   * summary the hub wrote fails Anthropic's prefix check.
   */
  meta?: Record<string, unknown>;
  /** No "Compacted N messages" notice: the caller writes its own (a switch). A summary written without the model still warns. */
  quiet?: boolean;
}

async function compact(engine: Engine, sessionId: string, modelRef: string, signal: AbortSignal, trigger: 'auto' | 'manual', instructions?: string, opts: CompactOptions = {}): Promise<boolean> {
  const all = engine.turnMessages(sessionId);
  const active = activeMessages(all);
  if (active.length < 4) return false;

  const session = engine.repos.sessions.get(sessionId);
  if (!session) return false;

  // /compact <instructions>: what the owner wants kept, as Claude Code passes it to PreCompact hooks
  const hook = await engine.runHook(session, 'PreCompact', { trigger, custom_instructions: instructions ?? '' }, trigger);
  if (hook.blocked) {
    log.info(`compaction blocked by hook in ${sessionId}`);
    return false;
  }

  const lastSeq = all[all.length - 1]?.seq ?? 0;
  // keep the most recent turns verbatim, sized from the window, summarize the rest
  let window = 200_000;
  try {
    window = engine.providers.resolve(modelRef).info.contextWindow || window;
  } catch {
    /* an unknown model keeps the default */
  }
  const keep = recentToKeep(active, window);
  const toSummarize = active.filter((m) => !keep.includes(m));
  if (toSummarize.length < 2) return false;

  const previous = toSummarize[0]?.kind === 'summary' ? toSummarize[0] : undefined;
  const prevMeta = previous?.meta as Partial<SummaryMeta> | undefined;
  const region = previous ? toSummarize.slice(1) : toSummarize;
  const firstSeq = region[0]?.seq ?? toSummarize[0].seq;
  const coversThroughSeq = toSummarize[toSummarize.length - 1].seq;
  const beforeTokens = regionTokens(toSummarize);

  const { quoted, omitted } = verbatimUserMessages(region, Array.isArray(prevMeta?.verbatim) ? prevMeta.verbatim : []);
  // once the session has a project, files are listed relative to it (projects/service.ts)
  const roots = projectsOf(engine)?.projectRoots(session) ?? [];
  const files = filesTouched(region, Array.isArray(prevMeta?.files) ? prevMeta.files : [], roots);
  const sections = [deterministicSections(quoted, omitted, files, roots[0]), anchorSection(anchorIndex(region))].filter(Boolean).join('\n\n');

  const candidates = await summaryCandidates(engine, modelRef, session);
  let usedModel: string | undefined;
  const now = Date.now();
  const latched = trigger === 'auto' && isLatched(session.meta, now, modelRef);
  engine.audit(sessionId, 'compaction:start', `${trigger} seq ${firstSeq}..${coversThroughSeq}, ${toSummarize.length} messages, ~${beforeTokens} tokens${latched ? ', latched (no model)' : `, model ${candidates[0] ?? 'none'}`}`);

  let summary: string | undefined;
  let failure: string | undefined;
  /** What the audit found missing in the summary that was kept. */
  let audited: string[] = [];
  if (latched) {
    failure = 'the summary model failed recently';
  } else {
    const extra = [instructions, ...hook.additionalContext].filter(Boolean).join('\n');
    // update mode: the earlier summary is merged, not summarized again as transcript
    const earlier = previous ? carriedSummary(previous) : '';
    const anchor = lastAssistantText(keep);
    const request = [
      earlier ? `<previous-summary>\n${earlier}\n</previous-summary>\n\n${COMPACT_UPDATE_RULES}` : '',
      `Conversation to summarize:\n\n${summarizerInput(region)}`,
      anchor ? `<recent-state-anchor>\n${truncateMiddle(anchor, 4_000, 'omitted').text}\n</recent-state-anchor>\nThis is the latest state of the work; it stays in context after the summary. Make the Next step agree with it.` : '',
    ].filter(Boolean).join('\n\n');
    let candidateIdx = 0;
    const ask = async (problems?: string[]): Promise<{ text: string; model: string }> => {
      const retry = problems?.length ? `\n\nYour last summary missed: ${problems.join('; ')}. Write the whole summary again with every heading and these identifiers.` : '';
      let lastErr: unknown = new Error('no usable summary model');
      for (let i = candidateIdx; i < candidates.length; i++) {
        const candidate = candidates[i];
        try {
          const res = await streamCompletion(
            engine,
            candidate,
            {
              system: [{ text: COMPACT_PROMPT + (extra ? `\n\nAlso keep these details:\n${extra}` : '') }],
              messages: [{ role: 'user', content: [{ type: 'text', text: request + retry }] }],
              maxTokens: 4000,
              signal: AbortSignal.any([signal, AbortSignal.timeout(COMPACTION_TIMEOUT_MS)]),
            },
            { sessionId, purpose: 'compaction' },
          );
          candidateIdx = i;
          return { text: res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim(), model: candidate };
        } catch (err) {
          if (signal.aborted) throw err;
          lastErr = err;
          log.warn(`compaction summary model ${candidate} failed in ${sessionId}: ${(err as Error)?.message ?? String(err)}`);
        }
      }
      throw lastErr;
    };
    const tooBig = (text: string) => estimateTokens(text) >= beforeTokens;
    try {
      const first = await ask();
      summary = first.text;
      usedModel = first.model;
      if (!summary) failure = 'the summary model returned nothing';
      else if (tooBig(summary)) failure = `the summary (~${estimateTokens(summary)} tokens) was not smaller than what it replaces (~${beforeTokens} tokens)`;
      else {
        // the audit: one retry that lists what is missing, then the better of the two is kept
        audited = auditSummary(summary, region);
        if (audited.length) {
          const again = await ask(audited).catch(() => undefined);
          const problems = again?.text && !tooBig(again.text) ? auditSummary(again.text, region) : undefined;
          if (again && problems && problems.length < audited.length) {
            summary = again.text;
            usedModel = again.model;
            audited = problems;
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return false;
      failure = `the summary model failed: ${(err as Error)?.message ?? String(err)}`;
      log.warn(`compaction summary failed in ${sessionId}: ${failure}`);
    }
    if (failure) {
      // latch: the next auto compactions skip the model for a while
      engine.patchMeta(sessionId, { compaction: { latchedUntil: now + COMPACTION_LATCH_MS, reason: failure, model: modelRef } });
    } else if (latchedUntil(session.meta)) {
      engine.patchMeta(sessionId, { compaction: undefined });
    }
  }
  if (signal.aborted) return false;

  const degraded = !!failure;
  // the summary proper comes first in the text, so its range is known before the sections are added
  let lead: string;
  let proper: string;
  if (!degraded) {
    lead = '';
    proper = summary!;
  } else {
    proper = previous ? carriedSummary(previous) : '';
    lead = proper ? `${FALLBACK_NOTE}\n\n## Earlier summary\n\n` : FALLBACK_NOTE;
  }
  const body = [lead + proper, sections].filter(Boolean).join('\n\n');
  const meta: SummaryMeta = {
    coversThroughSeq,
    trigger,
    compactedAt: lastSeq,
    userMessages: quoted.length,
    verbatim: quoted,
    files,
    ...(proper ? { summaryRange: [lead.length, lead.length + proper.length] as [number, number] } : {}),
    ...(degraded ? { qualityDegraded: true, fallback: 'no_llm' as const } : {}),
    ...(!degraded && audited.length ? { qualityDegraded: true, audit: audited } : {}),
  };
  engine.addMessage(sessionId, {
    role: 'user',
    kind: 'summary',
    content: [{ type: 'text', text: body }],
    model: degraded ? undefined : usedModel,
    meta: { ...opts.meta, ...(meta as unknown as Record<string, unknown>) },
  });
  const afterTokens = estimateTokens(body);
  engine.audit(sessionId, 'compaction:end', `${degraded ? 'fallback' : 'summary'} seq ${firstSeq}..${coversThroughSeq}, ~${beforeTokens} -> ~${afterTokens} tokens${failure ? ` (${failure})` : audited.length ? ` (audit: ${oneLine(audited.join('; '), 300)})` : ''}`);
  if (degraded) {
    engine.notice(sessionId, `Compacted ${toSummarize.length} messages without a summary (${truncateMiddle(failure!, 200).text}). Earlier messages are excluded from context but kept in the session.`, 'warning');
  } else if (!opts.quiet) {
    engine.notice(sessionId, `Compacted ${toSummarize.length} messages to save context.`, 'info');
  }
  return true;
}

/**
 * The summary proper of an earlier summary message, without its
 * deterministic sections (those are carried through meta). Summaries from
 * before summaryRange existed have no sections, so all of their text counts.
 */
function carriedSummary(m: Message): string {
  const text = m.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const meta = m.meta as Partial<SummaryMeta> | undefined;
  const r = meta?.summaryRange;
  if (Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[0] <= r[1] && r[1] <= text.length) return text.slice(r[0], r[1]).trim();
  // a fallback without an earlier summary has none to pass on
  if (meta?.fallback === 'no_llm') return '';
  return text.trim();
}

/**
 * The newest messages kept as they are: 2.5 percent of the window, clamped
 * to 10k..25k tokens (Hermes). The cut lands on a real user message, so a
 * tool call and its result are never split; a long tool loop with no user
 * message in that span is cut before an assistant message instead.
 */
export function recentToKeep(active: Message[], contextWindow: number): Message[] {
  const budget = Math.min(TAIL_MAX_TOKENS, Math.max(TAIL_MIN_TOKENS, Math.floor(contextWindow * TAIL_SHARE))) * 4;
  let start = active.length;
  let chars = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const size = JSON.stringify(active[i].content).length;
    if (chars + size > budget && active.length - i > 2) break;
    start = i;
    chars += size;
  }
  const realUser = (m: Message) => m.role === 'user' && m.kind === 'normal' && m.content.some((b) => b.type === 'text' && !isReminder(b));
  let cut = active.findIndex((m, i) => i >= start && realUser(m));
  if (cut < 0) cut = active.findIndex((m, i) => i >= start && m.role === 'assistant' && m.kind !== 'summary');
  if (cut < 0) return [];
  return active.slice(cut).filter((m) => m.kind !== 'summary');
}
