/**
 * The arithmetic of a model switch (docs/DESIGN.md 44), with no engine
 * imports, so the web app's mock hub uses the same numbers.
 *
 * Prompt caches belong to one model, so the first reply after a switch reads
 * the whole active chat again with no cache: Claude writes it to the cache
 * (2x input with the 1 hour lifetime of interactive sessions, 1.25x with the
 * 5 minute one of headless runs), other providers bill their cache write
 * price, or plain input. Staying would read the same history at the current
 * model's cache read price. The switch pays back once the cheaper replies on
 * the new model have covered that difference.
 */
import type { SwitchMath } from '../client';
import type { ModelInfo } from '../providers/types';

/** Default context.switchBriefAt: active tokens over which a switch shows its price and offers a short handover. */
export const SWITCH_BRIEF_AT = 50_000;
/** A full switch under this is cheap (a small model, about a cent): no short handover, no price step. */
export const CHEAP_SWITCH_USD = 0.05;
/** A short handover that saves at least this much on the switch is suggested in a quiet line. */
export const SUGGEST_BRIEF_USD = 0.2;
/** Tool output kept whole when a short handover clears old output, in tokens (the usual window is 50,000). */
export const SWITCH_CLEAR_PROTECT_TOKENS = 12_000;
/** One later reply, for the payback count: new input and output tokens. */
export const REPLY_INPUT_TOKENS = 3_000;
export const REPLY_OUTPUT_TOKENS = 2_000;
/** The summary model reads at most this much (compaction.ts SUMMARY_INPUT_CHARS / 4) and writes at most this much. */
export const SUMMARY_READ_TOKENS = 30_000;
export const SUMMARY_WRITE_TOKENS = 4_000;
/** A second opinion: the brief, the answer and the transcript (review.ts REVIEW_LIMITS, 44,000 chars), and its reply. */
export const ASK_INPUT_TOKENS = 11_000;
export const ASK_OUTPUT_TOKENS = 1_500;
export type PriceInfo = Pick<ModelInfo, 'id' | 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice' | 'cacheWrite1hPrice' | 'caching'> & Partial<Pick<ModelInfo, 'tier'>>;

/** Cache lifetime of the requests, or undefined with prompt caching off. */
export type CacheTtl = '5m' | '1h' | undefined;

/**
 * USD per million tokens to put history in front of a model with no cache of
 * it. Claude writes it to the cache (2x input at 1h, 1.25x at 5m); other
 * providers take the catalog's write price, or plain input when writes are free.
 */
export function firstTurnPrice(info: PriceInfo, ttl: CacheTtl): number {
  if (!ttl || info.caching === 'none') return info.inputPrice;
  if (info.caching === 'explicit' && /^claude-/.test(info.id)) return ttl === '1h' ? (info.cacheWrite1hPrice ?? info.inputPrice * 2) : info.cacheWritePrice;
  return info.cacheWritePrice > 0 ? info.cacheWritePrice : info.inputPrice;
}

/** USD per million tokens to read history the model has cached. */
export function warmReadPrice(info: PriceInfo, ttl: CacheTtl): number {
  if (!ttl || info.caching === 'none' || !info.cacheReadPrice) return info.inputPrice;
  return info.cacheReadPrice;
}

/** One later reply on a warm model: the history read from cache, the new input written, the output. */
export function replyUsd(info: PriceInfo, historyTokens: number, ttl: CacheTtl): number {
  return (historyTokens * warmReadPrice(info, ttl) + REPLY_INPUT_TOKENS * firstTurnPrice(info, ttl) + REPLY_OUTPUT_TOKENS * info.outputPrice) / 1e6;
}

/**
 * The switch against staying. stayTokens: what the current model reads now;
 * tokens: what the new model reads (less after a short handover); extraUsd:
 * the summary.
 */
export function switchMath(from: PriceInfo, to: PriceInfo, stayTokens: number, ttl: CacheTtl, opts: { tokens?: number; extraUsd?: number } = {}): SwitchMath {
  const tokens = opts.tokens ?? stayTokens;
  const onceUsd = (tokens * firstTurnPrice(to, ttl)) / 1e6 + (opts.extraUsd ?? 0);
  const stayUsd = (stayTokens * warmReadPrice(from, ttl)) / 1e6;
  const reply = replyUsd(to, tokens, ttl);
  const stayReply = replyUsd(from, stayTokens, ttl);
  const premium = onceUsd - stayUsd;
  const saving = stayReply - reply;
  const paybackReplies = premium <= 0 ? 0 : saving > 0 ? Math.max(1, Math.round(premium / saving)) : undefined;
  return { tokens, onceUsd, stayUsd, replyUsd: reply, stayReplyUsd: stayReply, ...(paybackReplies !== undefined ? { paybackReplies } : {}) };
}

/** The summary of a short handover: the small model reads the older part (capped) and writes the summary. */
export function summaryUsd(small: PriceInfo, summarizedTokens: number): number {
  return (Math.min(summarizedTokens, SUMMARY_READ_TOKENS) * small.inputPrice + SUMMARY_WRITE_TOKENS * small.outputPrice) / 1e6;
}

/** A second opinion from the target instead of a switch. */
export function askOnceUsd(to: PriceInfo): number {
  return (ASK_INPUT_TOKENS * to.inputPrice + ASK_OUTPUT_TOKENS * to.outputPrice) / 1e6;
}

/** A switch is cheap when a full replay costs under CHEAP_SWITCH_USD, or the target is a small (fast tier) model. */
export function isCheapTarget(to: PriceInfo, fullOnceUsd: number): boolean {
  return to.tier === 'fast' || fullOnceUsd < CHEAP_SWITCH_USD;
}
