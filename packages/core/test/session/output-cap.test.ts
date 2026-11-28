/**
 * Output cap per call (session/stream.ts outputCap): the model's own limit by
 * default, a caller's smaller cap kept, modelOverrides.maxOutput as the
 * override, and never more than the context window has left.
 */
import { describe, expect, test } from 'bun:test';
import { outputCap } from '../../src/session/stream';
import { statedOutputLimit } from '../../src/providers/errors';
import { startTestEngine } from '../engine/harness';

const opus = { maxOutput: 128_000, contextWindow: 1_000_000 };

describe('outputCap', () => {
  test('default is the model maxOutput, not 32K', () => {
    expect(outputCap(opus, undefined, 10_000)).toBe(128_000);
  });

  test('a caller cap is kept, and never above the model limit', () => {
    expect(outputCap(opus, 1500, 10_000)).toBe(1500);
    expect(outputCap(opus, 500_000, 10_000)).toBe(128_000);
  });

  test('a fuller window lowers it to what fits, never below 32K', () => {
    const sonnet = { maxOutput: 64_000, contextWindow: 200_000 };
    // 120K estimated input counts as 160K: 200K - 160K - 1K = 39K left
    expect(outputCap(sonnet, undefined, 120_000)).toBe(38_976);
    // a nearly full window keeps the old 32K and lets compaction make room
    expect(outputCap(sonnet, undefined, 190_000)).toBe(32_000);
    // a caller's smaller cap stays as it is
    expect(outputCap(sonnet, 2000, 190_000)).toBe(2000);
  });
});

describe('statedOutputLimit', () => {
  test('reads the limit each vendor states in its max_tokens 400', () => {
    expect(statedOutputLimit('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-opus-4-5-20251101')).toBe(64_000);
    expect(statedOutputLimit("max_tokens is too large: 128000. This model supports at most 32768 completion tokens, whereas you provided 128000.")).toBe(32_768);
    expect(statedOutputLimit('Unable to submit request because it has a maxOutputTokens value of 128000 but the supported range is from 1 (inclusive) to 65537 (exclusive).')).toBe(65_536);
    expect(statedOutputLimit('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]')).toBe(8192);
  });

  test('no number named: the old 32K; another 400 or a full context window: none', () => {
    expect(statedOutputLimit('max_tokens exceeds the model maximum')).toBe(32_000);
    expect(statedOutputLimit('messages: text content blocks must be non-empty')).toBeUndefined();
    expect(statedOutputLimit('input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000')).toBeUndefined();
  });
});

describe('max_tokens on the wire', () => {
  test('a 400 saying max_tokens is too large is retried once at the stated limit', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'fits' }]],
      route: (body) => ((body as { max_tokens?: number }).max_tokens! > 64_000 ? { status: 400, error: `max_tokens: ${(body as { max_tokens?: number }).max_tokens} > 64000, which is the maximum allowed number of output tokens for claude-sonnet-5-5` } : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(t.requests.map((r) => JSON.parse(r).max_tokens)).toEqual([128_000, 64_000]);
      expect(t.engine.getMessages(s.id).some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('fits'))).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('only once: a second refusal at the smaller size stands', async () => {
    const t = await startTestEngine({ script: [[{ text: 'never' }]], route: () => ({ status: 400, error: 'max_tokens is too large: 128000. This model supports at most 32768 completion tokens' }) });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(t.requests.map((r) => JSON.parse(r).max_tokens)).toEqual([128_000, 32_768]);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a session turn asks for the model limit; modelOverrides.maxOutput overrides it', async () => {
    const t = await startTestEngine({ script: [[{ text: 'one' }], [{ text: 'two' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(JSON.parse(t.requests[0]).max_tokens).toBe(128_000);
    } finally {
      await t.close();
    }
    const o = await startTestEngine({ script: [[{ text: 'one' }]], modelOverrides: { 'claude-sonnet-5-5': { maxOutput: 50_000 } } });
    try {
      const s = await o.engine.createSession({ title: 't', cwd: o.cwd });
      await o.run(s.id, 'hi');
      expect(JSON.parse(o.requests[0]).max_tokens).toBe(50_000);
    } finally {
      await o.close();
    }
  }, 30_000);
});
