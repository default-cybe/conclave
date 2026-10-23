/**
 * A model switch on a real engine (modes/handoff.ts): the default keeps the
 * full history; a short handover (opt-in) summarizes first when the chat is
 * over context.switchBriefAt and the target is not cheap, clears old tool
 * output down to 12K tokens in one batch, and keeps the stored messages.
 * The next request carries the switch marker.
 */
import { describe, expect, test } from 'bun:test';
import { SUMMARY_HEADINGS } from '../../src/session/prompt';
import { SWITCH_CLEAR_PROTECT_TOKENS } from '../../src/modes/switch-cost';
import type { Engine } from '../../src/engine/engine';
import type { ContentBlock, Message, TextBlock } from '../../src/types';
import { startTestEngine, type TestEngine } from './harness';

const SUMMARIZE = 'Conversation to summarize';
const OPUS = 'mock/claude-opus-5-5';
const SONNET = 'mock/claude-sonnet-5-5';
const HAIKU = 'mock/claude-haiku-5-5';
const shaped = `HANDOVER SUMMARY\n\n${SUMMARY_HEADINGS.map((h) => `## ${h}\nnone`).join('\n')}`;

async function start(): Promise<TestEngine> {
  return startTestEngine({
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    script: [[{ text: 'done' }]],
    chore: (_b, text) => (text.includes(SUMMARIZE) ? [{ text: shaped }] : undefined),
    overrides: { limits: { maxRetries: 0 } } as never,
  });
}

/**
 * A chat on Opus 5.5: `turns` rounds of an ask, a Bash call with `outChars`
 * of output and an answer. The newest answer was written by Sonnet 5.5 with
 * thinking, so a switch to Sonnet would keep that thinking unless the short
 * handover drops it.
 */
function seed(engine: Engine, id: string, turns: number, outChars: number): void {
  for (let i = 0; i < turns; i++) {
    const last = i === turns - 1;
    engine.addMessage(id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: `ask ${i}` }] });
    const think: ContentBlock[] = [{ type: 'thinking', thinking: `THINK-${i}`, signature: `sig${i}` }];
    engine.addMessage(id, { role: 'assistant', kind: 'normal', model: last ? SONNET : OPUS, content: [...think, { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `step ${i}` } }] });
    engine.addMessage(id, { role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: `toolu_${i}`, content: `OUT-${i} ${String(i % 10).repeat(outChars)}` }] });
    engine.addMessage(id, { role: 'assistant', kind: 'normal', model: last ? SONNET : OPUS, content: [...think, { type: 'text', text: `answer ${i}` }] });
  }
}

const summaries = (engine: Engine, id: string) => engine.getMessages(id).filter((m) => m.kind === 'summary');
const notices = (engine: Engine, id: string) => engine.getMessages(id).filter((m) => m.kind === 'notice');
const textOf = (m: Message) => (m.content[0] as TextBlock).text;

describe('switching models', () => {
  test('the default keeps the full history: no summary, no extra clearing, and the marker on the next request', async () => {
    const t = await start();
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      seed(t.engine, s.id, 24, 12_000);
      const before = t.engine.getMessages(s.id).length;
      const after = await t.engine.handoff(s.id, SONNET);
      expect(after.model).toBe(SONNET);
      expect(summaries(t.engine, s.id)).toHaveLength(0);
      expect(t.chores.filter((c) => c.includes(SUMMARIZE))).toHaveLength(0);
      const cleared = t.engine.getMessages(s.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.meta?.cleared);
      expect(cleared).toHaveLength(0);
      expect(t.engine.getMessages(s.id)).toHaveLength(before + 1);
      const n = notices(t.engine, s.id).at(-1)!;
      expect(textOf(n)).toBe('Switched from Claude Opus 5.5 to Claude Sonnet 5.5.');
      expect(n.meta).toMatchObject({ type: 'switch', from: OPUS, model: SONNET });
      expect(t.engine.getSession(s.id)!.meta?.switched).toEqual({ from: OPUS, to: SONNET });

      await t.run(s.id, 'carry on');
      const req = t.requests.at(-1)!;
      // the marker, once, hidden in a reminder on the new user message
      expect(req).toContain('You took over this conversation from Claude Opus 5.5.');
      expect(t.engine.getSession(s.id)!.meta?.switched).toBeUndefined();
      // the whole history goes, and Sonnet keeps the thinking it wrote itself
      expect(req).toContain('OUT-0 ');
      expect(req).toContain('THINK-23');
      expect(req).not.toContain('THINK-0');
      await t.run(s.id, 'and again');
      expect(t.requests.at(-1)!.match(/You took over this conversation/g)).toHaveLength(1);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a short handover over the threshold: summary, kept turns without thinking, one clearing batch at 12K tokens, messages kept', async () => {
    const t = await start();
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      seed(t.engine, s.id, 24, 12_000);
      const est = t.engine.switchEstimate(s.id, SONNET);
      expect(est.tokens).toBeGreaterThan(est.threshold);
      expect(est.threshold).toBe(50_000);
      expect(est.ttl).toBe('1h');
      expect(est.confirm).toBe(true);
      expect(est.brief!.tokens).toBeLessThan(est.full.tokens);
      expect(est.brief!.onceUsd).toBeLessThan(est.full.onceUsd);
      // 1h writes at $4/M on Sonnet 5.5
      expect(est.full.onceUsd).toBeCloseTo((est.tokens * 4) / 1e6, 9);

      const stored = t.engine.getMessages(s.id).length;
      await t.engine.handoff(s.id, SONNET, { brief: true });
      const [sum] = summaries(t.engine, s.id);
      expect(sum).toBeDefined();
      expect(sum.meta).toMatchObject({ trigger: 'manual', switch: { from: OPUS, to: SONNET } });
      expect(textOf(sum)).toStartWith('HANDOVER SUMMARY');
      // the summary was asked to keep what the next model needs
      const ask = t.chores.find((c) => c.includes(SUMMARIZE))!;
      expect(ask).toContain('This summary is a handover: Claude Sonnet 5.5 continues the work');
      expect(ask).toContain('the open asks, and the next step');
      // nothing stored was deleted: the summary and the notice were added
      expect(t.engine.getMessages(s.id)).toHaveLength(stored + 2);
      const n = notices(t.engine, s.id).at(-1)!;
      expect(textOf(n)).toMatch(/^Switched from Claude Opus 5\.5 to Claude Sonnet 5\.5 with a short handover: a \d+K token summary and the recent turns, \d+ old tool outputs? cleared\.$/);
      expect(n.meta).toMatchObject({ type: 'switch', brief: true });

      // one batch: in the turns after the summary, the newest 12K tokens of output stay and the older ones are cleared
      const msgs = t.engine.getMessages(s.id);
      const covers = sum.meta!.coversThroughSeq as number;
      const kept = msgs.filter((m) => m.seq > covers && m.seq < sum.seq).flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
      const cleared = kept.filter((b) => b.meta?.cleared);
      const whole = kept.filter((b) => !b.meta?.cleared);
      expect(cleared.length).toBeGreaterThan(0);
      expect(whole.length).toBeGreaterThan(0);
      const wholeChars = whole.reduce((n, b) => n + String(b.content).length, 0);
      expect(wholeChars).toBeLessThanOrEqual(SWITCH_CLEAR_PROTECT_TOKENS * 4 + 12_100);
      // the newest results are the ones kept
      const newest = (b: (typeof kept)[number]) => Number((b as { toolUseId: string }).toolUseId.split('_')[1]);
      expect(Math.min(...whole.map(newest))).toBeGreaterThan(Math.max(...cleared.map(newest)));

      await t.run(s.id, 'carry on');
      const req = t.requests.at(-1)!;
      expect(req).toContain('HANDOVER SUMMARY');
      expect(req).toContain('You took over this conversation from Claude Opus 5.5.');
      // the kept turns go without thinking, even Sonnet's own
      expect(req).not.toContain('THINK-');
      expect(req).toContain('Old tool result cleared to save context');
      expect(req).not.toContain('OUT-0 ');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('no short handover under the threshold or for a cheap target: the full history goes, and the notice says so', async () => {
    const t = await start();
    try {
      const small = await t.engine.createSession({ title: 'small', cwd: t.cwd, model: OPUS });
      seed(t.engine, small.id, 3, 2_000);
      expect(t.engine.switchEstimate(small.id, SONNET)).toMatchObject({ confirm: false });
      expect(t.engine.switchEstimate(small.id, SONNET).brief).toBeUndefined();
      await t.engine.handoff(small.id, SONNET, { brief: true });
      expect(summaries(t.engine, small.id)).toHaveLength(0);
      expect(textOf(notices(t.engine, small.id).at(-1)!)).toBe('Switched from Claude Opus 5.5 to Claude Sonnet 5.5 with the full history (the chat is small or the new model is cheap, so a short handover would save little).');

      const big = await t.engine.createSession({ title: 'big', cwd: t.cwd, model: OPUS });
      seed(t.engine, big.id, 24, 12_000);
      const toHaiku = t.engine.switchEstimate(big.id, HAIKU);
      expect(toHaiku.tokens).toBeGreaterThan(toHaiku.threshold);
      expect(toHaiku).toMatchObject({ confirm: false, suggestBrief: false });
      expect(toHaiku.full.onceUsd).toBeLessThan(0.05);
      await t.engine.handoff(big.id, HAIKU, { brief: true });
      expect(summaries(t.engine, big.id)).toHaveLength(0);
      expect(t.chores.filter((c) => c.includes(SUMMARIZE))).toHaveLength(0);
      expect(t.engine.getMessages(big.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.meta?.cleared)).toHaveLength(0);

      // a lower threshold in config offers it for the small chat too; 0 never does
      t.engine.config.update({ context: { switchBriefAt: 1_000 } } as never);
      expect(t.engine.switchEstimate(small.id, OPUS).confirm).toBe(true);
      t.engine.config.update({ context: { switchBriefAt: 0 } } as never);
      expect(t.engine.switchEstimate(big.id, OPUS).confirm).toBe(false);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a switch and a switch back before the next turn leave no marker; /usage counts cache writes', async () => {
    const t = await start();
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      seed(t.engine, s.id, 2, 100);
      await t.engine.handoff(s.id, SONNET);
      await t.engine.handoff(s.id, OPUS);
      expect(t.engine.getSession(s.id)!.meta?.switched).toBeUndefined();
      await t.run(s.id, 'hi');
      expect(t.requests.at(-1)!).not.toContain('You took over');
      t.engine.addStats(s.id, { cacheWriteTokens: 1234 });
      const out = await t.engine.command(s.id, '/usage');
      expect(out.output).toContain('1234 cache write');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('thinking after an ordinary compaction', () => {
  test('/compact on the same model: the kept turns go without thinking, and a reply written after the summary replays its own', async () => {
    const t = await start();
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: SONNET });
      // every turn by Sonnet itself: before this fix the kept turns replayed their thinking after the summary
      seed(t.engine, s.id, 24, 12_000);
      for (const m of t.engine.getMessages(s.id)) if (m.role === 'assistant') t.engine.updateMessage(m.id, { model: SONNET });
      await t.run(s.id, 'before');
      expect(t.requests.at(-1)!).toContain('THINK-23');

      expect(await t.engine.compact(s.id)).toBe(true);
      const [sum] = summaries(t.engine, s.id);
      expect(sum.meta?.switch).toBeUndefined();
      const kept = t.engine.getMessages(s.id).filter((m) => m.seq > (sum.meta!.coversThroughSeq as number) && m.seq < sum.seq);
      expect(kept.some((m) => m.content.some((b) => b.type === 'thinking'))).toBe(true);

      await t.run(s.id, 'carry on');
      const req = t.requests.at(-1)!;
      expect(req).toContain('HANDOVER SUMMARY');
      expect(req).not.toContain('THINK-');
      // the stored messages keep their thinking
      expect(t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'thinking' && b.thinking === 'THINK-23'))).toBe(true);

      // a reply produced after the summary keeps its thinking on the next request
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'one more' }] });
      t.engine.addMessage(s.id, { role: 'assistant', kind: 'normal', model: SONNET, content: [{ type: 'thinking', thinking: 'AFTER-SUMMARY', signature: 'sigA' }, { type: 'text', text: 'ok' }] });
      await t.run(s.id, 'and now');
      expect(t.requests.at(-1)!).toContain('AFTER-SUMMARY');
      expect(t.requests.at(-1)!).not.toContain('THINK-');
    } finally {
      await t.close();
    }
  }, 60_000);
});
