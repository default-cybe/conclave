/**
 * The model switch step (features/chat/SwitchChoice.tsx, switch.ts): the
 * price line, Full history as the default, Short handover remembered on this
 * device only once picked, the quiet suggestion, and Ask once. Numbers are
 * the research report's worked example: 100K tokens moved from Opus 5.5 to
 * Sonnet 5.5 with the 1 hour cache.
 *
 *   cd packages/web && bun test test/switch.test.tsx
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@conclave/core/types';
import type { SwitchEstimate } from '@conclave/core/client';
import { askOnceUsd, summaryUsd, switchMath, type PriceInfo } from '@conclave/core/modes/switch-math';
import { BRIEF_KEY, briefSaving, priceLine, rememberBrief, rememberedBrief, usdWords } from '../src/features/chat/switch';
import { SwitchChoice } from '../src/features/chat/SwitchChoice';

const price = (id: string, inputPrice: number, outputPrice: number, cacheReadPrice: number, tier: PriceInfo['tier']): PriceInfo => ({
  id,
  inputPrice,
  outputPrice,
  cacheReadPrice,
  cacheWritePrice: inputPrice * 1.25,
  cacheWrite1hPrice: inputPrice * 2,
  caching: 'explicit',
  tier,
});
const opus = price('claude-opus-5-5', 4, 20, 0.2, 'deep');
const sonnet = price('claude-sonnet-5-5', 2, 10, 0.1, 'smart');
const haiku = price('claude-haiku-5-5', 0.1, 0.5, 0.01, 'fast');

const sUsd = summaryUsd(haiku, 100_000);
const estimate: SwitchEstimate = {
  from: 'anthropic/claude-opus-5-5',
  to: 'anthropic/claude-sonnet-5-5',
  tokens: 100_000,
  threshold: 50_000,
  ttl: '1h',
  full: switchMath(opus, sonnet, 100_000, '1h'),
  brief: { ...switchMath(opus, sonnet, 100_000, '1h', { tokens: 35_000, extraUsd: sUsd }), summaryUsd: sUsd },
  askUsd: askOnceUsd(sonnet),
  confirm: true,
  suggestBrief: true,
  priced: true,
};
const session = { id: 's1', model: 'anthropic/claude-opus-5-5', title: 't' } as Session;

describe('the price line', () => {
  test('About $0.40 once, pays back after about 9 replies; the short handover about $0.15 and 3 replies', () => {
    expect(priceLine(estimate.full)).toBe('About $0.40 once, pays back after about 9 replies');
    expect(priceLine(estimate.brief!)).toBe('About $0.15 once, pays back after about 3 replies');
    expect(usdWords(briefSaving(estimate))).toBe('$0.26');
  });

  test('a dearer model never pays back; a cheaper first reply pays back at once; tiny sums read under a cent', () => {
    expect(priceLine(switchMath(sonnet, opus, 100_000, '1h'))).toBe('About $0.80 once, and each reply costs more than staying');
    expect(priceLine({ ...estimate.full, onceUsd: 0.01, paybackReplies: 0 })).toBe('About $0.01 once, cheaper than staying from the first reply');
    expect(priceLine({ ...estimate.full, paybackReplies: 1 })).toBe('About $0.40 once, pays back after about 1 reply');
    expect(usdWords(0.004)).toBe('under a cent');
  });
});

describe('the switch step', () => {
  const g = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const before = g.localStorage;
  afterEach(() => {
    if (had) g.localStorage = before;
    else delete g.localStorage;
  });
  function fakeStorage() {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    return m;
  }
  const html = (e: SwitchEstimate = estimate) => renderToStaticMarkup(<SwitchChoice session={session} model={e.to} estimate={e} onDone={() => undefined} onBack={() => undefined} />);
  const checked = (out: string) => [...out.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => / checked=""/.test(m[0]));

  test('Full history is the default; both choices carry their price, and Ask once its own', () => {
    fakeStorage();
    const out = html();
    expect(out).toContain('Switch to Sonnet 5.5');
    expect(out).toContain('This chat holds about 100K tokens.');
    expect(out).toContain('Full history');
    expect(out).toContain('About $0.40 once, pays back after about 9 replies.');
    expect(out).toContain('Short handover');
    expect(out).toContain('About $0.15 once, pays back after about 3 replies.');
    expect(checked(out)).toEqual([true, false]);
    // the saving is large, so a quiet line suggests the short handover
    expect(out).toContain('A short handover would save about $0.26 here.');
    expect(out).toContain('Ask once');
    expect(out).toContain('One answer from Sonnet 5.5, about $0.04');
    // house words: switch, never hand off, and no long dashes
    expect(out).not.toMatch(/hand off|handed off/i);
    expect(out).not.toMatch(/[\u2013\u2014]/);
  });

  test('Short handover is remembered on this device only once picked; Full history forgets it', () => {
    const m = fakeStorage();
    expect(rememberedBrief()).toBe(false);
    rememberBrief(true);
    expect(m.get(BRIEF_KEY)).toBe('1');
    const out = html();
    expect(checked(out)).toEqual([false, true]);
    // picked, there is nothing to suggest
    expect(out).not.toContain('would save about');
    rememberBrief(false);
    expect(m.has(BRIEF_KEY)).toBe(false);
    expect(checked(html())).toEqual([true, false]);
  });

  test('with no short handover on offer (a cheap model or a small chat), only Full history shows', () => {
    fakeStorage();
    rememberBrief(true);
    const out = html({ ...estimate, brief: undefined, suggestBrief: false });
    expect(out).toContain('Full history');
    expect(out).not.toContain('Short handover');
    expect(checked(out)).toEqual([true]);
  });
});
