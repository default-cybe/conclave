/**
 * Output cap per call (session/stream.ts outputCap): the model's own limit by
 * default, a caller's smaller cap kept, modelOverrides.maxOutput as the
 * override, and never more than the context window has left.
 */
import { describe, expect, test } from 'bun:test';
import { outputCap } from '../../src/session/stream';
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

describe('max_tokens on the wire', () => {
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
