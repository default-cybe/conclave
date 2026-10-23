/**
 * The price of a model switch (modes/switch-cost.ts), the switch marker
 * (modes/switch-marker.ts), the turns kept after a short handover's summary
 * (transcript.ts), the one-batch clearing window, and the rule that waits for
 * a short rate limit reset instead of falling back (session/limits.ts).
 *
 * The worked example is the research report's (switch-research.json): a
 * 100K token chat on Opus 5.5 in an interactive session (1 hour cache),
 * switched to Sonnet 5.5, with prices from the Claude pricing page of
 * 2026-10-22.
 */
import { describe, expect, test } from 'bun:test';
import { lookupModel } from '../../src/providers/catalog';
import {
  askOnceUsd,
  CHEAP_SWITCH_USD,
  firstTurnPrice,
  isCheapTarget,
  summaryUsd,
  SWITCH_CLEAR_PROTECT_TOKENS,
  switchMath,
  warmReadPrice,
} from '../../src/modes/switch-cost';
import { nextSwitch, pendingSwitch, switchNote } from '../../src/modes/switch-marker';
import { planClearing } from '../../src/session/context-edit';
import { buildProviderMessages } from '../../src/session/transcript';
import { handleLimit, SHORT_RESET_MS, waitInsteadOfFallback } from '../../src/session/limits';
import { ProviderError } from '../../src/providers/types';
import type { ContentBlock, Message } from '../../src/types';

const opus = lookupModel('anthropic', 'claude-opus-5-5');
const sonnet = lookupModel('anthropic', 'claude-sonnet-5-5');
const haiku = lookupModel('anthropic', 'claude-haiku-5-5');

describe('switch math: the worked example', () => {
  test('100K tokens, Opus 5.5 to Sonnet 5.5, full history: about $0.40 once against $0.02 to stay, pays back after about 9 replies', () => {
    const full = switchMath(opus, sonnet, 100_000, '1h');
    expect(full.onceUsd).toBeCloseTo(0.4, 9);
    expect(full.stayUsd).toBeCloseTo(0.02, 9);
    // each later reply: history read, 3K new input written at 1h, 2K output
    expect(full.replyUsd).toBeCloseTo(0.01 + 0.012 + 0.02, 9);
    expect(full.stayReplyUsd).toBeCloseTo(0.02 + 0.024 + 0.04, 9);
    expect(full.paybackReplies).toBe(9);
  });

  test('a short handover: the Haiku summary (about $0.005) plus about 35K tokens at $4/M is about $0.145, paying back after about 3 replies', () => {
    const sUsd = summaryUsd(haiku, 100_000);
    expect(sUsd).toBeCloseTo(0.005, 9);
    const brief = switchMath(opus, sonnet, 100_000, '1h', { tokens: 35_000, extraUsd: sUsd });
    expect(brief.onceUsd).toBeCloseTo(0.145, 9);
    expect(brief.replyUsd).toBeCloseTo(0.0035 + 0.012 + 0.02, 9);
    expect(brief.paybackReplies).toBe(3);
    // about 64 percent less than the full switch
    expect(1 - brief.onceUsd / switchMath(opus, sonnet, 100_000, '1h').onceUsd).toBeCloseTo(0.6375, 4);
  });

  test('to Opus 5.5 the full switch is $0.80; an 800K chat is $6.40', () => {
    expect(switchMath(sonnet, opus, 100_000, '1h').onceUsd).toBeCloseTo(0.8, 9);
    expect(switchMath(sonnet, opus, 800_000, '1h').onceUsd).toBeCloseTo(6.4, 9);
    // a switch to a dearer model never pays back
    expect(switchMath(sonnet, opus, 100_000, '1h').paybackReplies).toBeUndefined();
  });

  test('first turn prices: 2x input at 1h, 1.25x at 5m (headless), the write price on GPT-5.6, input where writes are free', () => {
    expect(firstTurnPrice(sonnet, '1h')).toBe(4);
    expect(firstTurnPrice(sonnet, '5m')).toBe(2.5);
    expect(switchMath(opus, sonnet, 100_000, '5m').onceUsd).toBeCloseTo(0.25, 9);
    const gpt56 = lookupModel('openai', 'gpt-5.6');
    expect(firstTurnPrice(gpt56, '1h')).toBe(5);
    expect(switchMath(opus, gpt56, 100_000, '1h').onceUsd).toBeCloseTo(0.5, 9);
    const gemini = lookupModel('google', 'gemini-3.1-pro-preview');
    expect(firstTurnPrice(gemini, '1h')).toBe(2);
    expect(switchMath(opus, gemini, 100_000, '1h').onceUsd).toBeCloseTo(0.2, 9);
    // caching off: everything is plain input
    expect(firstTurnPrice(sonnet, undefined)).toBe(2);
    expect(warmReadPrice(opus, undefined)).toBe(4);
    expect(warmReadPrice(opus, '1h')).toBe(0.2);
  });

  test('cheap targets: Haiku 5.5 (a fast model) or a full replay under 5 cents get no short handover', () => {
    const toHaiku = switchMath(opus, haiku, 100_000, '1h');
    expect(toHaiku.onceUsd).toBeCloseTo(0.02, 9);
    expect(isCheapTarget(haiku, toHaiku.onceUsd)).toBe(true);
    expect(isCheapTarget(sonnet, switchMath(opus, sonnet, 100_000, '1h').onceUsd)).toBe(false);
    expect(isCheapTarget(sonnet, CHEAP_SWITCH_USD - 0.001)).toBe(true);
  });

  test('ask once: one second opinion from Sonnet 5.5 costs a few cents', () => {
    const usd = askOnceUsd(sonnet);
    expect(usd).toBeGreaterThan(0.015);
    expect(usd).toBeLessThan(0.05);
  });
});

describe('switch marker', () => {
  test('the first model is kept across switches, and switching back clears it', () => {
    expect(nextSwitch(undefined, 'a/opus', 'a/sonnet')).toEqual({ from: 'a/opus', to: 'a/sonnet' });
    expect(nextSwitch({ from: 'a/opus', to: 'a/sonnet' }, 'a/sonnet', 'b/gpt')).toEqual({ from: 'a/opus', to: 'b/gpt' });
    expect(nextSwitch({ from: 'a/opus', to: 'a/sonnet' }, 'a/sonnet', 'a/opus')).toBeUndefined();
    expect(pendingSwitch({ switched: { from: 'a/opus', to: 'a/sonnet' } })).toEqual({ from: 'a/opus', to: 'a/sonnet' });
    expect(pendingSwitch({ switched: 'x' })).toBeUndefined();
  });

  test('one short line that names the old model', () => {
    const line = switchNote('Claude Opus 5.5');
    expect(line).toStartWith('You took over this conversation from Claude Opus 5.5.');
    expect(line.split('\n')).toHaveLength(1);
    expect(line.length).toBeLessThan(260);
  });
});

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, sessionId: 's', seq, role, kind: 'normal', content, createdAt: seq, ...extra };
}

describe('turns kept after a short handover', () => {
  const thinking: ContentBlock = { type: 'thinking', thinking: 'plan', signature: 'sig' };
  const build = (summaryMeta: Record<string, unknown>) => {
    const old = msg('user', [{ type: 'text', text: 'old ask' }]);
    const kept = [msg('user', [{ type: 'text', text: 'recent ask' }]), msg('assistant', [thinking, { type: 'text', text: 'recent answer' }], { model: 'p/sonnet' })];
    const summary = msg('user', [{ type: 'text', text: 'the summary' }], { kind: 'summary', meta: { coversThroughSeq: old.seq, ...summaryMeta } });
    const after = [msg('user', [{ type: 'text', text: 'next ask' }]), msg('assistant', [thinking, { type: 'text', text: 'next answer' }], { model: 'p/sonnet' })];
    const out = buildProviderMessages([old, ...kept, summary, ...after, msg('user', [{ type: 'text', text: 'go on' }])], { modelRef: 'p/sonnet', toolNames: new Set(), cache: false });
    return out.flatMap((m) => m.content).filter((b) => b.type === 'thinking').length;
  };

  test('the kept turns go without thinking; the new model keeps its own thinking after the summary', () => {
    expect(build({ switch: { from: 'p/opus', to: 'p/sonnet' } })).toBe(1);
  });

  test('an ordinary compaction drops same-model thinking in the kept turns too (Anthropic prefix check)', () => {
    expect(build({})).toBe(1);
    // a summary written before v0.4.13 with the old flag reads the same
    expect(build({ dropTailThinking: true })).toBe(1);
  });
});

describe('clearing at a short handover', () => {
  test('one batch with a 12K token window: everything prunable older than the newest 12K tokens of output is cleared', () => {
    const active: Message[] = [];
    // ten tool results of 4,000 tokens (16,000 chars) each, oldest first
    for (let i = 0; i < 10; i++) {
      active.push(msg('assistant', [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `step ${i}` } }]));
      active.push(msg('user', [{ type: 'tool_result', toolUseId: `t${i}`, content: String(i).repeat(16_000) }]));
    }
    // the usual rule (50K kept, 30K batches) clears nothing yet
    expect(planClearing(active).results.size).toBe(0);
    const plan = planClearing(active, { protectTokens: SWITCH_CLEAR_PROTECT_TOKENS, batchTokens: 0 });
    // the newest three (12K tokens) stay, the other seven go in one batch
    expect([...plan.results.keys()].sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
    // an exempt tool's output stays whole
    active.push(msg('assistant', [{ type: 'tool_use', id: 'todo', name: 'TodoWrite', input: {} }]));
    active.unshift(msg('user', [{ type: 'tool_result', toolUseId: 'todo', content: 'x'.repeat(16_000) }]));
    expect(planClearing(active, { protectTokens: SWITCH_CLEAR_PROTECT_TOKENS, batchTokens: 0 }).results.has('todo')).toBe(false);
  });
});

describe('rate limit fallbacks: wait for a short reset', () => {
  const base = { enabled: true as boolean | undefined, autoResume: true, resetInMs: 3 * 60_000 as number | undefined, chatTokens: 120_000, bigTokens: 50_000 as number | undefined };

  test('a big chat whose limit resets within 5 minutes waits; anything else falls back as before', () => {
    expect(waitInsteadOfFallback(base)).toBe(true);
    expect(waitInsteadOfFallback({ ...base, resetInMs: SHORT_RESET_MS })).toBe(true);
    expect(waitInsteadOfFallback({ ...base, resetInMs: SHORT_RESET_MS + 1 })).toBe(false);
    expect(waitInsteadOfFallback({ ...base, resetInMs: undefined })).toBe(false);
    expect(waitInsteadOfFallback({ ...base, chatTokens: 20_000 })).toBe(false);
    expect(waitInsteadOfFallback({ ...base, enabled: false })).toBe(false);
    expect(waitInsteadOfFallback({ ...base, autoResume: false })).toBe(false);
    // default on, with the default size
    expect(waitInsteadOfFallback({ ...base, enabled: undefined, bigTokens: undefined })).toBe(true);
  });

  function fakeEngine(over: { resetMs: number; chars: number; wait?: boolean }) {
    const notices: string[] = [];
    const parked: number[] = [];
    const big = [msg('user', [{ type: 'text', text: 'x'.repeat(over.chars) }])];
    const engine = {
      config: { get: () => ({ limits: { fallbacks: { 'a/opus': ['b/gpt'] }, autoResume: true, waitShortResets: over.wait }, context: { switchBriefAt: 50_000 } }) },
      providers: { resolve: (ref: string) => ({ provider: ref.split('/')[0], acp: false }) },
      isUsable: () => true,
      repos: { messages: { list: () => big } },
      notice: (_id: string, body: string) => void notices.push(body),
      parkForReset: (_id: string, at: number) => void parked.push(at),
      scheduler: { enqueue: () => undefined },
      notifyEvent: () => undefined,
      providerLabel: (id: string) => id,
    };
    const err = new ProviderError('rate_limit', 'limited', { retryAfterMs: over.resetMs });
    return { run: () => handleLimit(engine as never, { id: 's', turnCheckpoint: undefined } as never, 'a/opus', err), notices, parked };
  }

  test('handleLimit parks a big chat whose limit resets in 2 minutes, and says why it did not switch', async () => {
    const t = fakeEngine({ resetMs: 120_000, chars: 400_000 });
    expect(await t.run()).toEqual({ parked: true });
    expect(t.parked).toHaveLength(1);
    expect(t.notices.at(-1)).toContain('It waits instead of switching to b/gpt');
  });

  test('handleLimit falls back for a small chat, a long reset, or with the rule off', async () => {
    expect(await fakeEngine({ resetMs: 120_000, chars: 4_000 }).run()).toEqual({ fallback: 'b/gpt' });
    expect(await fakeEngine({ resetMs: 3_600_000, chars: 400_000 }).run()).toEqual({ fallback: 'b/gpt' });
    expect(await fakeEngine({ resetMs: 120_000, chars: 400_000, wait: false }).run()).toEqual({ fallback: 'b/gpt' });
  });
});
