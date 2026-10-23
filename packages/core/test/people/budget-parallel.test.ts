/**
 * A member's monthly budget on the hub's key against calls started together
 * (docs/design/ACCOUNTS.md 6). Each call holds an estimate of its cost while
 * it runs, and the check counts what is held, so parallel calls overshoot the
 * budget by no more than one call, as calls one after another do. The
 * owner's calls and a member's calls on their own key hold nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { completeText } from '../../src/session/stream';
import { OWNER_ID } from '../../src/people/context';
import { startTestEngine, type TestEngine } from '../engine/harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// about 1,000 tokens of input; with about 1,000 of reply each call holds $0.20 at $100 a million
const PROMPT = `Summarize this. ${'a'.repeat(3983)}`;
const BUDGET = 0.5;
/** What each scripted call really costs: 1,000 tokens in and 1,000 out. */
const COST = 0.2;

async function hub(): Promise<TestEngine> {
  return startTestEngine({
    script: [[{ text: 'unused' }]],
    // every chore answers after a pause, so the calls are in flight together
    chore: (_body, text) => (text.includes('FAIL') ? 400 : { blocks: [{ text: 'ok' }], usage: { input: 1000, output: 1000 }, delayMs: 300 }),
    modelOverrides: { 'claude-sonnet-5-5': { inputPrice: 100, outputPrice: 100 } } as never,
  });
}

const together = (n: number, accountId: string, prompt = PROMPT) => Promise.allSettled(Array.from({ length: n }, () => completeText(t!.engine, { prompt, accountId, purpose: 'parallel test' })));

describe("a member's budget on the hub's key, calls in parallel", () => {
  test('six calls started together overshoot by one call at most, and the rest are refused before they are sent', async () => {
    t = await hub();
    const { engine } = t;
    const carol = engine.people.create({ name: 'carol', settings: { providers: { mock: { monthlyUsd: BUDGET } } } });
    const before = t.chores.length;
    const out = await together(6, carol.id);
    const sent = t.chores.length - before;
    const ok = out.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(sent);
    // one after another, three calls pass (0, 0.20 and 0.40 are under 0.50); together, the same three, not six
    expect(ok).toBe(3);
    for (const r of out) if (r.status === 'rejected') expect((r.reason as Error).message).toContain(`Calls running now use the rest of your $${BUDGET} monthly budget`);
    expect(engine.access.spent(carol.id, 'mock')).toBeLessThanOrEqual(BUDGET + COST + 1e-9);
    // nothing is held once they are done, and the next call meets the spent budget
    expect(engine.access.reserved(carol.id, 'mock')).toBe(0);
    const next = await together(1, carol.id);
    expect((next[0] as PromiseRejectedResult).reason.message).toContain(`You reached your $${BUDGET} monthly budget`);
  }, 30_000);

  test('a call that fails lets go of what it held', async () => {
    t = await hub();
    const { engine } = t;
    const dora = engine.people.create({ name: 'dora', settings: { providers: { mock: { monthlyUsd: BUDGET } } } });
    const out = await together(2, dora.id, `FAIL ${PROMPT}`);
    expect(out.every((r) => r.status === 'rejected')).toBe(true);
    expect(engine.access.reserved(dora.id, 'mock')).toBe(0);
    expect(engine.access.spent(dora.id, 'mock')).toBe(0);
  }, 30_000);

  test("the owner's calls and a member's calls on their own key hold nothing and are never refused", async () => {
    t = await hub();
    const { engine } = t;
    const owner = await together(6, OWNER_ID);
    expect(owner.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(engine.access.reserved(OWNER_ID, 'mock')).toBe(0);
    // a budget of nothing on the hub's key, and a key of her own: her calls are hers
    const erin = engine.people.create({ name: 'erin', settings: { providers: { mock: { monthlyUsd: 0 } } } });
    engine.accountSecrets.set(erin.id, 'providers', 'mock', 'sk-erin-own');
    const calls = together(6, erin.id);
    const held = engine.access.reserved(erin.id, 'mock');
    const own = await calls;
    expect(own.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(held).toBe(0);
    expect(engine.access.spent(erin.id, 'mock')).toBe(0);
  }, 30_000);
});
