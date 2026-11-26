/**
 * A member's own Settings > Defaults (people/member-defaults.ts): checked
 * against the models they can call, kept in their account, used for their
 * sessions and memory, and never written to the hub's config. The owner's
 * sessions keep the hub's defaults.
 *
 *   bun test packages/core/test/people/member-defaults.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { OWNER_ID } from '../../src/people/context';
import { PeopleError } from '../../src/people/store';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const SONNET = 'mock/claude-sonnet-5-5';
const HAIKU = 'mock/claude-haiku-5';

async function setup(overrides?: Record<string, unknown>) {
  t = await startTestEngine({ script: [[{ text: 'ok' }]], models: ['claude-sonnet-5-5', 'claude-haiku-5'], ...(overrides ? { overrides: overrides as never } : {}) });
  const { engine } = t;
  const dan = engine.people.create({ name: 'dan' });
  // his own key: he can call the mock models, nothing else
  engine.accountSecrets.set(dan.id, 'providers', 'mock', 'sk-dan-own');
  const save = (patch: Record<string, unknown>) => engine.people.update(dan.id, { settings: engine.checkMemberDefaults(dan.id, patch) });
  return { engine, dan, save };
}

describe("a member's defaults", () => {
  test('a model they cannot call, an agent they cannot start, a device not theirs: refused', async () => {
    const { engine, dan } = await setup();
    for (const patch of [{ defaultModel: 'zai/glm-5' }, { smallModel: 'nope/x' }, { reviewer: 'openai/gpt-5' }, { defaultAgent: 'no-such-agent' }, { defaultDevice: 'someone-elses' }, { memory: { injectLimit: 0 } }, { memory: { external: {} } }, { hiddenModels: 'mock/*' }]) {
      expect(() => engine.checkMemberDefaults(dan.id, patch)).toThrow(PeopleError);
    }
  });

  test("apply to the member's new sessions and memory; the hub's config and the owner's sessions stay", async () => {
    const { engine, dan, save } = await setup();
    const before = JSON.stringify(engine.config.get());
    save({ defaultModel: HAIKU, smallModel: HAIKU, reviewer: HAIKU, memory: { enabled: false, injectLimit: 3 } });
    expect(JSON.stringify(engine.config.get())).toBe(before);

    const mine = await engine.createSession({} as never, dan.id);
    expect(mine.model).toBe(HAIKU);
    const owners = await engine.createSession({} as never, OWNER_ID);
    expect(owners.model).toBe(SONNET);

    expect(engine.reviewerFor(dan.id)).toBe(HAIKU);
    expect(engine.reviewerFor(OWNER_ID)).toBe(engine.config.get().modes.reviewer);
    expect(engine.memorySettings(dan.id)).toMatchObject({ enabled: false, injectLimit: 3 });
    expect(engine.memorySettings(OWNER_ID)).toEqual(engine.config.get().memory);

    // null clears: back to the hub's
    save({ defaultModel: null, memory: null });
    expect((await engine.createSession({} as never, dan.id)).model).toBe(SONNET);
    expect(engine.memorySettings(dan.id)).toEqual(engine.config.get().memory);
  });

  test('memory off for him: his turns get no recalled notes, the owner\'s still do', async () => {
    // the harness hub has memory off; on here, so recall runs for whoever did not turn it off
    const { engine, dan, save } = await setup({ memory: { enabled: true, autoExtract: false, autoInject: true, injectLimit: 5 } });
    await engine.memoryFor(dan.id).save({ content: 'Dan keeps the zebra router in the attic.', kind: 'fact' } as never);
    await engine.memory.save({ content: 'The owner keeps the zebra router in the attic.', kind: 'fact' } as never);
    const recalledIn = async (accountId: string) => {
      const s = await engine.createSession({ kind: 'chat', title: 'x' } as never, accountId);
      const from = t!.requests.length;
      await t!.run(s.id, 'where is the zebra router');
      return t!.requests.slice(from).join('\n').includes('Relevant memories (from earlier sessions');
    };
    expect(await recalledIn(dan.id)).toBe(true);
    save({ memory: { enabled: false } });
    expect(await recalledIn(dan.id)).toBe(false);
    expect(await recalledIn(OWNER_ID)).toBe(true);
  }, 60_000);

  test('hidden models leave his pickers and calls only', async () => {
    const { engine, dan, save } = await setup();
    save({ hiddenModels: ['mock/*haiku*'] });
    expect(engine.isUsable(HAIKU, dan.id)).toBe(false);
    expect(engine.isUsable(HAIKU, OWNER_ID)).toBe(true);
    const refs = (accountId: string) => engine.listModels(accountId).then((gs) => gs.flatMap((g) => g.models.map((m) => m.ref)));
    expect(await refs(dan.id)).not.toContain(HAIKU);
    expect(await refs(OWNER_ID)).toContain(HAIKU);
    // a hidden model is not his to pick as a default
    expect(() => engine.checkMemberDefaults(dan.id, { defaultModel: HAIKU })).toThrow(PeopleError);
    await expect(engine.createSession({ model: HAIKU } as never, dan.id)).rejects.toThrow('hidden');
  });
});
