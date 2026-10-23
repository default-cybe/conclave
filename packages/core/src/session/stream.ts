import type { ContentBlock, StopReason, Usage } from '../types';
import type { ChatRequest } from '../providers/types';
import { ProviderError, parseModelRef } from '../providers/types';
import type { Engine } from '../engine/engine';
import { accountsOf } from '../accounts/attached';
import { sleep } from '../util/text';
import { logger } from '../util/log';
import { guardTranscript } from './pairing';
import { OWNER_ID, currentAccount, isMember } from '../people/context';
import { AccessError } from '../people/access';
import { catalogCost } from '../usage/value';
import { servedNotice, type CyberProgram } from '../providers/access-programs';

/** "session asked served" pairs already told: a served program the plan cannot change is said once. */
const servedNoted = new Set<string>();

const log = logger('stream');

export interface StreamResult {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  latencyMs: number;
  /** Who answered: the provider and model id on the wire, and the account when the hub knows it (the usage row's). */
  served?: Served;
}

/** The provider and model id a call went to, and its account (accounts/service.ts) when known. */
export interface Served {
  provider: string;
  model: string;
  account?: string;
  /** The Cyber access program the call asked for: a refusal retries on the same plan with Daybreak only when it was not asked already. */
  cyber?: CyberProgram;
}

/**
 * Keep a call on one provider, model id and account: a refusal fallback entry
 * the owner named (session/refusal-fallback.ts). The owner's account order
 * does not move it, and a limit or a refused sign in is not passed to the
 * next account: the caller moves to its next entry instead.
 */
export interface StreamPin {
  provider: string;
  /** The model id on the wire, with a CLIProxyAPI account prefix when the plan has one ("neu/claude-opus-5-5"). */
  model: string;
  /** The account the usage row names, when the pin reaches exactly that one. */
  account?: string;
}

export interface StreamTarget {
  sessionId?: string;
  /** Whose call: its keys, budget and usage row (docs/design/ACCOUNTS.md 6). Left out, the session's account, then the account the work runs for, then the owner's. */
  accountId?: string;
  /** Message receiving live deltas. When omitted nothing is streamed to clients. */
  messageId?: string;
  purpose: string;
  /** Run on exactly this provider and account (a refusal fallback entry). */
  pin?: StreamPin;
}

/** Output tokens a call holds on a member's budget on top of its input while it runs: about one reply. */
const HELD_OUTPUT_TOKENS = 1000;

/**
 * One model call with streaming to clients, usage accounting, rate-limit
 * capture and retries for transient failures. Long limits (quota windows)
 * are thrown as ProviderError so the caller can wait or fall back.
 */
export async function streamCompletion(
  engine: Engine,
  modelRef: string,
  req: Omit<ChatRequest, 'model'>,
  target: StreamTarget,
): Promise<StreamResult> {
  // a member's call on the hub's key holds its estimated cost on their budget until it ends (people/access.ts)
  const held: { release?: () => void } = {};
  try {
    return await streamCall(engine, modelRef, req, target, held);
  } finally {
    held.release?.();
  }
}

async function streamCall(
  engine: Engine,
  modelRef: string,
  req: Omit<ChatRequest, 'model'>,
  target: StreamTarget,
  held: { release?: () => void },
): Promise<StreamResult> {
  const session = target.sessionId ? engine.repos.sessions.get(target.sessionId) : undefined;
  // the one path to a model API: whose keys, whose budget, whose usage row
  const accountId = target.accountId ?? session?.accountId ?? currentAccount() ?? OWNER_ID;
  const member = isMember(accountId);
  const registry = engine.providersFor(accountId);
  // a pinned call skips the owner's account order: the entry names its provider and account
  let resolved = target.pin ? registry.resolveAt(target.pin.provider, target.pin.model) : registry.resolve(modelRef);
  if (resolved.acp) throw new ProviderError('bad_request', `${modelRef} is an agent harness, not a model API`);
  /** Whose key pays: the hub's, or the member's own (a key, or a plan of theirs that lists the model). Throws when the member may not call this provider now. */
  const payer = (provider: string): 'hub' | 'own' => {
    if (!member) return 'hub';
    try {
      return engine.access.check(accountId, provider, resolved.model) === 'own' ? 'own' : 'hub';
    } catch (err) {
      if (err instanceof AccessError) throw new ProviderError('auth', err.message, { provider, code: err.kind === 'budget' ? 'budget' : 'access', ...(err.resetAt ? { resetAt: err.resetAt } : {}) });
      throw err;
    }
  };
  /**
   * Right after payer() passed, with nothing awaited between: hold an estimate
   * of this call (its input and about one reply) on a member's budget for the
   * hub's key, so parallel calls see it in their check. Released when the
   * usage row is written or the call ends.
   */
  const hold = () => {
    held.release?.();
    held.release = undefined;
    if (!member || paidBy !== 'hub') return;
    const maxOut = req.maxTokens ?? Math.min(resolved.info.maxOutput, 32_000);
    const usd = engine.providers.costOf(resolved.info, { inputTokens: estimateInput(req), outputTokens: Math.min(maxOut, HELD_OUTPUT_TOKENS), cacheReadTokens: 0, cacheWriteTokens: 0 });
    held.release = engine.access.reserve(accountId, resolved.provider, usd);
  };
  let paidBy = payer(resolved.provider);
  hold();
  let provider = registry.get(resolved.provider);
  if (!provider) throw new ProviderError('auth', `Provider "${resolved.provider}" is not configured. Add an API key in Settings.`);
  // the owner's account order and its limits are about the hub's keys; a member's own key stays out of them
  const accounts = paidBy === 'own' ? undefined : accountsOf(engine);
  /** Providers this call already tried and that refused it for a limit. */
  const tried = new Set<string>();

  /** The next provider in the owner's account order after `from` refused, or undefined. */
  const fallback = (from: string, why: string): boolean => {
    // a pinned call stays on its account: the refusal fallback moves to its next entry instead
    if (target.pin) return false;
    const next = accounts?.fallbackFor(from, resolved.model, tried);
    const p = next ? registry.get(next) : undefined;
    if (!next || !p) return false;
    // a member falls back only to a provider they may use, and pays as that one says
    if (member) {
      try {
        paidBy = payer(next);
      } catch {
        return false;
      }
    }
    tried.add(from);
    if (target.sessionId) engine.notice(target.sessionId, `${why} Using ${engine.providerLabel(next)} for this call.`, 'warning');
    if (target.messageId) {
      // reset a partly streamed reply on clients
      const msg = engine.repos.messages.get(target.messageId);
      if (msg) engine.bus.emit({ type: 'message.updated', message: { ...msg, content: [] } });
    }
    log.info(`${from}/${resolved.model}: ${why} falling back to ${next}`);
    resolved = registry.resolveAt(next, resolved.model);
    provider = p;
    hold();
    return true;
  };

  // the owner's budget for an API key stops calls on it until the reset; another account may take the call
  const stop = accounts?.budgetStop(resolved.provider);
  if (stop && !fallback(resolved.provider, `${stop.label} has spent its $${stop.usd} budget.`)) {
    throw new ProviderError('quota', `${stop.label} has spent its $${stop.usd} budget. It resets ${new Date(stop.until).toLocaleString()}.`, { provider: resolved.provider, resetAt: stop.until, code: 'budget' });
  }

  const maxRetries = engine.config.get().limits.maxRetries;
  let fullRef = `${resolved.provider}/${resolved.model}`;
  let attempt = 0;
  // last line before the wire: ends with a user turn, every tool_use paired with its result
  const guarded = guardTranscript(req.messages);
  if (guarded.repairs.length) {
    log.warn(`${fullRef} ${target.purpose}: repaired the transcript before sending: ${[...new Set(guarded.repairs)].join('; ')}`);
    req = { ...req, messages: guarded.messages };
  }

  for (;;) {
    const started = Date.now();
    // what this attempt got before it ended: the model began (its input is billed) and wrote this much
    let begun = false;
    let written = 0;
    try {
      let final: StreamResult | undefined;
      // when each block began, so a thinking block can say how long it took ("Thought for 12s")
      const blockStart = new Map<number, number>();
      // the session id rides along, so a gateway with session affinity keeps this conversation on one account
      for await (const ev of provider!.stream({ ...req, model: resolved.model, maxTokens: req.maxTokens ?? Math.min(resolved.info.maxOutput, 32_000), session: req.session ?? target.sessionId })) {
        if (req.signal?.aborted) throw new ProviderError('aborted', 'aborted');
        begun = true;
        if (ev.type === 'text_delta' || ev.type === 'thinking_delta') written += ev.text.length;
        else if (ev.type === 'tool_use_delta') written += ev.partialJson.length;
        if ((ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'tool_use_start') && !blockStart.has(ev.index)) blockStart.set(ev.index, Date.now());
        if (target.messageId && target.sessionId) {
          if (ev.type === 'text_delta') engine.bus.emit({ type: 'message.delta', sessionId: target.sessionId, messageId: target.messageId, index: ev.index, kind: 'text', text: ev.text });
          else if (ev.type === 'thinking_delta') engine.bus.emit({ type: 'message.delta', sessionId: target.sessionId, messageId: target.messageId, index: ev.index, kind: 'thinking', text: ev.text });
          else if (ev.type === 'tool_use_start') engine.bus.emit({ type: 'message.delta', sessionId: target.sessionId, messageId: target.messageId, index: ev.index, kind: 'tool_input', text: JSON.stringify({ start: true, id: ev.id, name: ev.name }) });
          else if (ev.type === 'tool_use_delta') engine.bus.emit({ type: 'message.delta', sessionId: target.sessionId, messageId: target.messageId, index: ev.index, kind: 'tool_input', text: ev.partialJson });
        }
        if (ev.type === 'rate_limit' && ev.windows.length && paidBy === 'hub') {
          // a gateway's headers belong to whichever account served the call: the accounts read them per account from CLIProxyAPI instead
          if (accounts?.hasAccounts(resolved.provider)) {
            // nothing to store here
          } else if (!accounts?.observeHeaders(resolved.provider, ev.windows)) {
            engine.usage.setLimit({ provider: resolved.provider, label: engine.providerLabel(resolved.provider), windows: ev.windows, updatedAt: Date.now(), source: 'headers' });
          }
        }
        if (ev.type === 'done') {
          final = { content: ev.content, stopReason: ev.stopReason, usage: ev.usage, latencyMs: Date.now() - started };
          // asked for a Cyber access program and served another (no approval on this plan): one notice per session and pair
          const asked = req.accessPrograms?.cyber;
          const served = ev.accessPrograms?.cyber;
          if (asked && served && served !== asked && target.sessionId && !servedNoted.has(`${target.sessionId} ${asked} ${served}`)) {
            servedNoted.add(`${target.sessionId} ${asked} ${served}`);
            engine.notice(target.sessionId, servedNotice(asked, served), 'info');
          }
        }
      }
      if (!final) throw new ProviderError('network', 'Stream ended without a final event');
      timeThinking(final.content, blockStart, started);
      const costUsd = engine.providers.costOf(resolved.info, final.usage);
      final.usage.costUsd = costUsd;
      const account = (target.pin?.provider === resolved.provider ? target.pin.account : undefined) ?? accounts?.accountFor(resolved.provider, resolved.model, target.sessionId);
      // a member's own plan bills nothing per token, as the hub's plans: its row shows what the call is worth at API prices
      const ownPlan = member && paidBy === 'own' && engine.access.ownPlan(accountId, resolved.provider, resolved.model);
      const row = engine.usage.record({
        sessionId: target.sessionId,
        // calls for a chat (its turns, its title) count under their own source on the Usage page
        source: session?.kind === 'chat' ? 'chat' : 'api',
        provider: resolved.provider,
        model: resolved.model,
        inputTokens: final.usage.inputTokens,
        outputTokens: final.usage.outputTokens,
        cacheReadTokens: final.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: final.usage.cacheWriteTokens ?? 0,
        ...(final.usage.cacheWrite1hTokens ? { cacheWrite1hTokens: final.usage.cacheWrite1hTokens } : {}),
        reasoningTokens: final.usage.reasoningTokens ?? 0,
        costUsd,
        latencyMs: final.latencyMs,
        purpose: target.purpose,
        ...(account ? { account } : {}),
        ...(session ? { device: session.device, cwd: session.cwd } : {}),
        accountId,
        paidBy,
        ...(ownPlan ? { apiValueUsd: catalogCost(resolved.provider, resolved.model, final.usage, 'openai') } : {}),
      });
      // what the call is worth at API prices: the session's stats show it beside the bill
      if (row?.apiValueUsd !== undefined) final.usage.apiValueUsd = row.apiValueUsd;
      // the row counts now: the estimate goes
      held.release?.();
      held.release = undefined;
      final.served = { provider: resolved.provider, model: resolved.model, ...(account ? { account } : {}), ...(req.accessPrograms?.cyber ? { cyber: req.accessPrograms.cyber } : {}) };
      return final;
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError('network', (err as Error)?.message ?? String(err));
      // a member's call on the hub's key that ended mid-answer (Stop, a dropped connection) still cost the hub its
      // input and what was written: count an estimate, so Stop is no way around the budget (docs/design/ACCOUNTS.md 6)
      if (begun && member && paidBy === 'hub') {
        const usage: Usage = { inputTokens: estimateInput(req), outputTokens: Math.ceil(written / 4), cacheReadTokens: 0, cacheWriteTokens: 0 };
        try {
          engine.usage.record({
            sessionId: target.sessionId,
            source: session?.kind === 'chat' ? 'chat' : 'api',
            provider: resolved.provider,
            model: resolved.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costUsd: engine.providers.costOf(resolved.info, usage),
            latencyMs: Date.now() - started,
            purpose: `${target.purpose} (stopped, estimated)`,
            ...(session ? { device: session.device, cwd: session.cwd } : {}),
            accountId,
            paidBy,
          });
        } catch (recordErr) {
          log.warn('could not count a stopped call', recordErr);
        }
      }
      if (req.signal?.aborted || e.kind === 'aborted') throw new ProviderError('aborted', 'aborted');
      e.provider ??= resolved.provider;
      if (e.retryable && attempt < maxRetries) {
        const wait = e.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        attempt++;
        log.warn(`${fullRef} ${e.kind}: retry ${attempt}/${maxRetries} in ${wait}ms`);
        if (target.messageId && target.sessionId) {
          // reset the partially streamed message on clients
          const msg = engine.repos.messages.get(target.messageId);
          if (msg) engine.bus.emit({ type: 'message.updated', message: { ...msg, content: [] } });
        }
        await sleep(wait, req.signal);
        if (member) {
          // a member's call pays on one side: a plan signed out (or in) since the last attempt refuses the retry instead of paying on the wrong side
          held.release?.();
          held.release = undefined;
          if (payer(resolved.provider) !== paidBy) throw new ProviderError('auth', 'Your plans changed during this call. Send it again.', { provider: resolved.provider, code: 'access' });
          hold();
        }
        continue;
      }
      // a plan signed out, or a key refused: the next route in the owner's order takes the call (providers/merge.ts)
      if (e.kind === 'auth' && paidBy === 'hub' && accounts && !begun && fallback(resolved.provider, `${engine.providerLabel(resolved.provider)} refused the sign in.`)) {
        fullRef = `${resolved.provider}/${resolved.model}`;
        attempt = 0;
        continue;
      }
      // a member's own plan at its limit: their CLIProxyAPI is read again soon, so their Accounts page shows why
      if ((e.kind === 'rate_limit' || e.kind === 'quota') && paidBy === 'own' && engine.access.ownPlan(accountId, resolved.provider, resolved.model)) engine.access.plans?.noteLimit?.(accountId);
      // a member's own key at its limit is the member's business: the hub's limits stay as they are
      if ((e.kind === 'rate_limit' || e.kind === 'quota') && paidBy === 'hub') {
        const resetAt = e.resetAt ?? (e.retryAfterMs ? Date.now() + e.retryAfterMs : undefined);
        if (accounts && (accounts.hasAccounts(resolved.provider) || accounts.accountFor(resolved.provider, resolved.model))) {
          // the accounts block it until the reset and read CLIProxyAPI again; the next account in the order takes the call
          accounts.noteLimit(resolved.provider, resolved.model, { resetAt, spendCap: e.code === 'spend_cap' });
          const why = e.code === 'spend_cap' ? `${engine.providerLabel(resolved.provider)} reached its spend limit.` : accounts.hasAccounts(resolved.provider) ? 'Your signed in plans are at their limit.' : `${engine.providerLabel(resolved.provider)} is at its limit.`;
          if (fallback(resolved.provider, why)) {
            fullRef = `${resolved.provider}/${resolved.model}`;
            attempt = 0;
            continue;
          }
          // an API key with nowhere to go: its account shows the block until the reset
          if (resetAt && !accounts.hasAccounts(resolved.provider)) accounts.observeHeaders(resolved.provider, [{ name: 'limit', usedPercent: 100, resetsAt: resetAt }]);
        } else {
          engine.usage.setLimit({
            provider: resolved.provider,
            label: engine.providerLabel(resolved.provider),
            windows: [{ name: 'limit', usedPercent: 100, resetsAt: resetAt }],
            updatedAt: Date.now(),
            blocked: true,
            source: 'error',
          });
        }
      }
      throw e;
    }
  }
}

/** About how many tokens a request's input is (4 characters a token, a picture as 1500 characters), for a call that ended before its usage came. */
function estimateInput(req: Omit<ChatRequest, 'model'>): number {
  let chars = 0;
  for (const b of req.system ?? []) chars += b.text.length;
  for (const t of req.tools ?? []) chars += t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema ?? {}).length;
  for (const m of req.messages) {
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

/**
 * Stamp each thinking block with how long it ran: from the request (for a
 * first block) or its first delta, to the start of the block after it.
 */
export function timeThinking(content: ContentBlock[], blockStart: Map<number, number>, requestStart: number, now = Date.now()): void {
  const starts = [...blockStart.entries()].sort((a, b) => a[0] - b[0]);
  content.forEach((b, i) => {
    if (b.type !== 'thinking') return;
    const at = starts.findIndex(([idx]) => idx === i);
    const begin = i === 0 || at <= 0 ? requestStart : starts[at][1];
    const next = at >= 0 ? starts[at + 1]?.[1] : undefined;
    b.durationMs = Math.max(0, (next ?? now) - begin);
  });
}

/** Simple non-streaming text completion used for chores (titles, summaries, memory). */
export async function completeText(
  engine: Engine,
  opts: { model?: string; system?: string; prompt: string; maxTokens?: number; stopSequences?: string[]; signal?: AbortSignal; purpose?: string; sessionId?: string; accountId?: string },
): Promise<string> {
  const cfg = engine.config.get();
  const accountId = opts.accountId ?? (opts.sessionId ? engine.sessionAccount(opts.sessionId) : undefined) ?? currentAccount() ?? OWNER_ID;
  const prefs = isMember(accountId) ? engine.accountPrefs(accountId) : {};
  const small = prefs.smallModel ?? cfg.smallModel;
  const main = prefs.defaultModel ?? cfg.defaultModel;
  let model = opts.model ?? small;
  // fall back to the default model when the small model's provider has no key (for this account)
  if (!engine.isUsable(model, accountId)) model = engine.isUsable(main, accountId) ? main : engine.firstUsableModel(accountId) ?? model;
  const res = await streamCompletion(
    engine,
    model,
    {
      system: opts.system ? [{ text: opts.system }] : [],
      messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }],
      maxTokens: opts.maxTokens ?? 2000,
      ...(opts.stopSequences?.length ? { stopSequences: opts.stopSequences } : {}),
      signal: opts.signal,
    },
    { purpose: opts.purpose ?? 'chore', sessionId: opts.sessionId, accountId },
  );
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
}

export function providerOf(modelRef: string): string {
  return parseModelRef(modelRef).provider;
}
