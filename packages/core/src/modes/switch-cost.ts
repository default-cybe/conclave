/**
 * What a model switch costs, before it happens (docs/DESIGN.md 44): the
 * session's active context measured, and the arithmetic of switch-math.ts.
 *
 * A short handover (handoff.ts) shrinks what the new model reads: a summary
 * from the small model plus the recent turns, with old tool output cleared.
 * It is offered only over context.switchBriefAt and never for a cheap target,
 * where a full replay costs about a cent.
 */
import type { Message, Session } from '../types';
import type { SwitchEstimate, SwitchMath } from '../client';
import type { Engine } from '../engine/engine';
import { activeMessages, buildProviderMessages } from '../session/transcript';
import { estimateRequestTokens, recentToKeep, regionTokens, verbatimUserMessages } from '../session/compaction';
import { planClearing } from '../session/context-edit';
import { cacheTtlFor, isHeadless } from '../session/runner';
import { askOnceUsd, isCheapTarget, summaryUsd, SUGGEST_BRIEF_USD, SWITCH_BRIEF_AT, SWITCH_CLEAR_PROTECT_TOKENS, switchMath, type CacheTtl, type PriceInfo } from './switch-math';

export * from './switch-math';
export type { SwitchEstimate, SwitchMath };

/** The model's own part of a summary, before the quoted user messages and files. */
const SUMMARY_BODY_TOKENS = 3_000;
/** The system prompt when nothing measured it, in tokens. */
const SYSTEM_TOKENS_GUESS = 3_000;

/**
 * What the new model reads after a short handover: the part the summary does
 * not shrink (system prompt, tools), the summary with its quoted user
 * messages, and the kept turns with old tool output cleared to a
 * SWITCH_CLEAR_PROTECT_TOKENS window. summarized: what the summary model reads.
 */
export function briefSize(active: Message[], overheadTokens: number, contextWindow: number): { tokens: number; summarized: number } {
  const tail = recentToKeep(active, contextWindow);
  const region = active.filter((m) => !tail.includes(m));
  const quoted = verbatimUserMessages(region.filter((m) => m.kind !== 'summary')).quoted.reduce((n, q) => n + q.length, 0);
  const summary = SUMMARY_BODY_TOKENS + Math.ceil(quoted / 4);
  const plan = planClearing(tail, { protectTokens: SWITCH_CLEAR_PROTECT_TOKENS, batchTokens: 0 });
  let cleared = 0;
  for (const chars of [...plan.results.values(), ...plan.inputs.values()]) cleared += chars;
  const kept = Math.max(0, regionTokens(tail) - Math.ceil(cleared / 4));
  return { tokens: overheadTokens + summary + kept, summarized: regionTokens(region) };
}

function priceInfo(engine: Engine, session: Session, ref: string): (PriceInfo & { contextWindow: number }) | undefined {
  try {
    const r = engine.registryFor(session).resolve(ref);
    if (r.acp) return undefined;
    return r.info;
  } catch {
    return undefined;
  }
}

/**
 * Tokens the next request would carry for a model: the stored messages as
 * buildProviderMessages sends them to it (cleared output stubbed, other
 * models' thinking dropped), the tools, and the system prompt. When the last
 * reply in the active window reported usage, its count (less its thinking,
 * which another model never reads) is the floor, since chars / 4 undercounts
 * code.
 */
export function activeTokens(engine: Engine, session: Session, modelRef: string): { tokens: number; messages: number; active: Message[] } {
  const all = engine.repos.messages.list(session.id);
  const active = activeMessages(all);
  const agent = engine.agentFor(session);
  const tools = engine.toolsFor(session, agent, session.mode, 0);
  const specs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const built = buildProviderMessages(all, { modelRef, toolNames: new Set(tools.map((t) => t.name)), cache: false });
  const messages = estimateRequestTokens([], built, []);
  const estimate = SYSTEM_TOKENS_GUESS + estimateRequestTokens([], built, specs);
  const summarySeq = active[0]?.kind === 'summary' ? active[0].seq : -1;
  let measured = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const m = active[i];
    if (m.seq <= summarySeq) break;
    if (m.role !== 'assistant' || !m.usage) continue;
    const u = m.usage;
    const thinking = regionTokens(active.filter((x) => x.seq <= m.seq).map((x) => ({ ...x, content: x.content.filter((b) => b.type === 'thinking') })));
    const after = regionTokens(active.filter((x) => x.seq > m.seq));
    measured = Math.max(0, u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + u.outputTokens - thinking) + after;
    break;
  }
  return { tokens: Math.max(estimate, measured), messages, active };
}

/** The price of switching a session to another model, against staying, with and without a short handover. */
export function estimateSwitch(engine: Engine, session: Session, to: string): SwitchEstimate {
  const cfg = engine.config.get();
  const threshold = cfg.context.switchBriefAt ?? SWITCH_BRIEF_AT;
  const ttl: CacheTtl = cfg.context.promptCaching ? cacheTtlFor(cfg.cache?.ttl, isHeadless(session, session.mode, 0)) : undefined;
  const fromInfo = priceInfo(engine, session, session.model);
  const toInfo = priceInfo(engine, session, to);
  const { tokens, messages, active } = activeTokens(engine, session, to);
  const zero: SwitchMath = { tokens, onceUsd: 0, stayUsd: 0, replyUsd: 0, stayReplyUsd: 0 };
  if (!fromInfo || !toInfo || to === session.model) {
    return { from: session.model, to, tokens, threshold, ...(ttl ? { ttl } : {}), full: zero, askUsd: 0, confirm: false, suggestBrief: false, priced: false };
  }
  const full = switchMath(fromInfo, toInfo, tokens, ttl);
  const priced = full.onceUsd > 0 || full.stayUsd > 0;
  const over = threshold > 0 && tokens >= threshold;
  const offered = priced && over && !isCheapTarget(toInfo, full.onceUsd);
  let brief: SwitchEstimate['brief'];
  if (offered) {
    const small = priceInfo(engine, session, engine.isUsable(cfg.smallModel) ? cfg.smallModel : to) ?? toInfo;
    const size = briefSize(active, Math.max(0, tokens - messages), toInfo.contextWindow);
    if (size.tokens < tokens) {
      const sUsd = summaryUsd(small, size.summarized);
      brief = { ...switchMath(fromInfo, toInfo, tokens, ttl, { tokens: size.tokens, extraUsd: sUsd }), summaryUsd: sUsd };
    }
  }
  return {
    from: session.model,
    to,
    tokens,
    threshold,
    ...(ttl ? { ttl } : {}),
    full,
    ...(brief ? { brief } : {}),
    askUsd: askOnceUsd(toInfo),
    confirm: offered,
    suggestBrief: !!brief && full.onceUsd - brief.onceUsd >= SUGGEST_BRIEF_USD,
    priced,
  };
}
