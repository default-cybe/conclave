import { expect, test } from 'bun:test';
import { startTestEngine } from './harness';

const zai = async (t: Awaited<ReturnType<typeof startTestEngine>>, accountId?: string) =>
  (await t.engine.listModels(accountId)).flatMap((g) => g.models).find((m) => m.ref === 'zai/glm-5.3');

test("a member's model list marks the owner's models they cannot use, and follows a grant", async () => {
  const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3'] }, script: [[{ text: 'ok' }]] });
  try {
    const alice = t.engine.people.create({ name: 'alice' });
    // the owner sees it as usable
    expect((await zai(t))?.unavailable).toBeUndefined();
    // alice has no grant: Not available, so PATCH /api/me cannot be offered it
    expect((await zai(t, alice.id))?.unavailable).toContain('Not allowed for you');
    // the owner grants zai: the next list follows
    t.engine.people.update(alice.id, { settings: { providers: { zai: {} } } });
    expect((await zai(t, alice.id))?.unavailable).toBeUndefined();
    t.engine.people.update(alice.id, { settings: { providers: {} } });
    expect((await zai(t, alice.id))?.unavailable).toContain('Not allowed for you');
  } finally {
    await t.close();
  }
});
