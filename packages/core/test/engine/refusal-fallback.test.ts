/**
 * Refusal fallback on a real engine (session/refusal-fallback.ts): a refusal
 * the provider signals runs the same request on the owner's next listed
 * model and account, until one answers or the list ends.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Message, TextBlock } from '../../src/types';
import type { RefusalFallbackConfig } from '../../src/config/schema';
import { startTestEngine, type Step, type TestEngine } from './harness';

const OPUS = 'mock/claude-opus-5-5';
const REFUSE: Step = { blocks: [{ text: 'I can not help with that.' }], stop: 'refusal' };
const answer = (text: string): Step => [{ text }];

/** Two Claude API accounts (neu and personal) and a GLM provider, beside the session's own mock provider. */
async function start(fallback: RefusalFallbackConfig | undefined, route: (provider: string, n: number) => Step | number | undefined, extra: Record<string, unknown> = {}): Promise<TestEngine> {
  const seen = new Map<string, number>();
  return startTestEngine({
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    extraProviders: { neu: ['claude-opus-5-5'], personal: ['claude-opus-5-5'], glm: ['glm-5.3'] },
    script: [answer('script')],
    route: (_b, _t, provider) => {
      const n = (seen.get(provider) ?? 0) + 1;
      seen.set(provider, n);
      return route(provider, n);
    },
    overrides: {
      limits: { maxRetries: 0 },
      models: {
        tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'mock/claude-sonnet-5-5' },
        accounts: [
          { id: 'neu', label: 'neu', vendor: 'anthropic', kind: 'api', provider: 'neu' },
          { id: 'personal', label: 'personal', vendor: 'anthropic', kind: 'api', provider: 'personal' },
        ],
        ...(fallback ? { refusalFallback: fallback } : {}),
      },
      ...extra,
    } as never,
  });
}

const LIST = [
  { model: 'anthropic/claude-opus-5-5', account: 'neu' },
  { model: 'anthropic/claude-opus-5-5', account: 'personal' },
  { model: 'glm/glm-5.3' },
];

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);
const replies = (msgs: Message[]) => msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal');
const bodyOf = (req: string) => JSON.parse(req) as { messages: unknown[]; model: string };

describe('refusal fallback', () => {
  test('off: a refusal stands and nothing else is asked; the notice offers the button', async () => {
    const t = await start({ enabled: false, entries: LIST }, (p) => (p === 'mock' ? REFUSE : answer('never')));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'help me with this');
      expect(t.requestProviders).toEqual(['mock']);
      const msgs = t.engine.getMessages(s.id);
      expect(replies(msgs)).toHaveLength(1);
      expect(replies(msgs)[0].stopReason).toBe('refusal');
      const n = msgs.filter((m) => m.kind === 'notice').at(-1)!;
      expect((n.content[0] as TextBlock).text).toBe('The model refused to continue.');
      expect(n.meta).toMatchObject({ type: 'refusal', canTryNext: true });
    } finally {
      await t.close();
    }
  }, 30_000);

  test('no list: a refusal stands and the notice offers nothing', async () => {
    const t = await start(undefined, () => REFUSE);
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['mock']);
      expect(t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').at(-1)!.meta).toMatchObject({ type: 'refusal', canTryNext: false });
      await expect(t.engine.tryNextModel(s.id)).rejects.toThrow('Refusal fallback has no models');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('on: walks the list in order on the right accounts, stops at the first answer, and never changes the message', async () => {
    const t = await start({ enabled: true, entries: LIST }, (p) => (p === 'personal' ? answer('Here is the answer.') : p === 'glm' ? answer('never') : REFUSE));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'Explain how this exploit mitigation works.');
      // the session's own model, then neu, then personal: GLM is never asked
      expect(t.requestProviders).toEqual(['mock', 'neu', 'personal']);
      // the same request each time: the refused replies were dropped, nothing was added or reworded
      const bodies = t.requests.map(bodyOf);
      expect(JSON.stringify(bodies[1].messages)).toBe(JSON.stringify(bodies[0].messages));
      expect(JSON.stringify(bodies[2].messages)).toBe(JSON.stringify(bodies[0].messages));
      expect(bodies.map((b) => b.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
      const firstUser = JSON.stringify(bodies[2].messages[0]);
      expect(firstUser).toContain('Explain how this exploit mitigation works.');

      const msgs = t.engine.getMessages(s.id);
      // one reply: the answer, by the personal account's model; the refusals are gone
      const r = replies(msgs);
      expect(r).toHaveLength(1);
      expect(r[0].model).toBe('personal/claude-opus-5-5');
      expect((r[0].content[0] as TextBlock).text).toBe('Here is the answer.');
      // the user's message is stored as it was sent
      const users = msgs.filter((m) => m.role === 'user' && m.kind === 'normal');
      expect(users).toHaveLength(1);
      expect((users[0].content[0] as TextBlock).text).toBe('Explain how this exploit mitigation works.');
      // a notice per step
      expect(notices(msgs)).toEqual(['Opus 5.5 declined. Trying Opus 5.5 (neu).', 'Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).']);
      expect(msgs.filter((m) => m.kind === 'notice').map((m) => m.meta?.outcome)).toEqual(['declined', 'answered']);
      // the usage rows say which account answered
      expect(t.engine.repos.usage.lastAccount(s.id, 0)).toBe('personal');
      // the session keeps its own model for the next turn
      expect(t.engine.getSession(s.id)!.model).toBe(OPUS);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('every entry refuses: the last refusal stands with one notice that says so', async () => {
    const t = await start({ enabled: true, entries: LIST }, () => REFUSE);
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['mock', 'neu', 'personal', 'glm']);
      const msgs = t.engine.getMessages(s.id);
      const r = replies(msgs);
      expect(r).toHaveLength(1);
      expect(r[0].model).toBe('glm/glm-5.3');
      expect(r[0].stopReason).toBe('refusal');
      const words = notices(msgs);
      expect(words).toHaveLength(4);
      expect(words.at(-1)).toMatch(/^GLM.* declined\. No model is left in Refusal fallback\.$/);
      expect(msgs.filter((m) => m.kind === 'notice').at(-1)!.meta).toMatchObject({ type: 'refusal', outcome: 'exhausted', canTryNext: false });
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a refusal on a listed model starts after it; stay keeps the model that answered', async () => {
    const t = await start({ enabled: true, stay: true, entries: LIST }, (p) => (p === 'glm' ? answer('GLM answers.') : REFUSE));
    try {
      // the session runs on the neu account itself: the walk goes on with personal, then GLM
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'neu/claude-opus-5-5' });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['neu', 'personal', 'glm']);
      expect(notices(t.engine.getMessages(s.id)).at(-1)).toMatch(/^Opus 5\.5 \(personal\) declined\. Answered by GLM.*\. This chat now uses GLM.*\.$/);
      expect(t.engine.getSession(s.id)!.model).toBe('glm/glm-5.3');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an entry that cannot answer is skipped with a notice; when none is left the last refusal stands again', async () => {
    const t = await start({ enabled: true, entries: LIST }, (p) => (p === 'mock' || p === 'neu' ? REFUSE : 500));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['mock', 'neu', 'personal', 'glm']);
      const msgs = t.engine.getMessages(s.id);
      const words = notices(msgs);
      expect(words[0]).toBe('Opus 5.5 declined. Trying Opus 5.5 (neu).');
      expect(words[1]).toBe('Opus 5.5 (neu) declined. Trying Opus 5.5 (personal).');
      expect(words[2]).toStartWith('Opus 5.5 (personal) could not answer:');
      expect(words.at(-1)).toBe('No model is left in Refusal fallback.');
      // the neu refusal stands
      const r = replies(msgs);
      expect(r).toHaveLength(1);
      expect(r[0].model).toBe('neu/claude-opus-5-5');
      expect(r[0].stopReason).toBe('refusal');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('"Try the next model" walks the same list when the switch is off, from the model that refused', async () => {
    const t = await start({ enabled: false, entries: LIST }, (p) => (p === 'neu' ? answer('neu answers.') : REFUSE));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'please');
      expect(t.requestProviders).toEqual(['mock']);
      const refused = replies(t.engine.getMessages(s.id))[0];
      await expect(t.engine.tryNextModel(s.id, 'msg_other')).rejects.toThrow('Only the last reply');
      const next = await t.engine.tryNextModel(s.id, refused.id);
      expect(next).toEqual({ model: 'neu/claude-opus-5-5', label: 'Opus 5.5 (neu)' });
      await t.engine.runnerFor(s.id).waitIdle();
      expect(t.requestProviders).toEqual(['mock', 'neu']);
      expect(JSON.stringify(bodyOf(t.requests[1]).messages)).toBe(JSON.stringify(bodyOf(t.requests[0]).messages));
      const msgs = t.engine.getMessages(s.id);
      expect(replies(msgs).map((m) => m.model)).toEqual(['neu/claude-opus-5-5']);
      expect(msgs.filter((m) => m.role === 'user' && m.kind === 'normal')).toHaveLength(1);
      expect(notices(msgs).at(-1)).toBe('Opus 5.5 declined. Answered by Opus 5.5 (neu).');
      // an answered reply has no next model to try
      await expect(t.engine.tryNextModel(s.id)).rejects.toThrow('The last reply was not refused.');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('refused tool calls never run, and the next model gets the request without them', async () => {
    const t = await start({ enabled: true, entries: LIST }, (p) =>
      p === 'mock' ? { blocks: [{ text: 'No.' }, { tool: 'Write', input: { file_path: 'x.txt', content: 'x' } }], stop: 'refusal' } : answer('fine'),
    );
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'write x');
      expect(t.requestProviders).toEqual(['mock', 'neu']);
      const sent = JSON.stringify(bodyOf(t.requests[1]).messages);
      expect(sent).not.toContain('tool_use');
      expect(sent).toBe(JSON.stringify(bodyOf(t.requests[0]).messages));
      expect(t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(false);
    } finally {
      await t.close();
    }
  }, 30_000);

  test("an agent's own list replaces the owner's, and refusalFallback: off turns it off", async () => {
    const t = await start({ enabled: true, entries: LIST }, (p) => (p === 'glm' ? answer('glm') : REFUSE));
    try {
      const base = t.engine.agentFor(await t.engine.createSession({ title: 'x', cwd: t.cwd }));
      await t.engine.extensions.saveAgent({ ...base, name: 'own-list', refusalFallback: [{ model: 'glm/glm-5.3' }] }, 'user');
      await t.engine.extensions.saveAgent({ ...base, name: 'no-fallback', refusalFallback: false }, 'user');
      // read back from the files: the frontmatter keeps both forms
      expect(t.engine.extensions.agent('own-list')?.refusalFallback).toEqual([{ model: 'glm/glm-5.3' }]);
      expect(t.engine.extensions.agent('no-fallback')?.refusalFallback).toBe(false);
      const own = await t.engine.createSession({ title: 'a', cwd: t.cwd, model: OPUS, agent: 'own-list' });
      await t.run(own.id, 'go');
      expect(t.requestProviders).toEqual(['mock', 'glm']);
      const off = await t.engine.createSession({ title: 'b', cwd: t.cwd, model: OPUS, agent: 'no-fallback' });
      await t.run(off.id, 'go');
      expect(t.requestProviders).toEqual(['mock', 'glm', 'mock']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a harness turn the ACP agent ends with stopReason refusal moves to the next entry in the hub loop', async () => {
    const t = await start({ enabled: true, entries: LIST }, (p) => (p === 'neu' ? answer('neu takes it from here.') : REFUSE));
    try {
      const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
      const cfg = t.engine.config.get();
      t.engine.config.update({ providers: { ...cfg.providers, fake: { type: 'acp', name: 'Fake Agent', command: process.execPath, args: [AGENT] } } } as never);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'fake/default' });
      await t.run(s.id, 'refuse');
      expect(t.requestProviders).toEqual(['neu']);
      const msgs = t.engine.getMessages(s.id);
      // the harness's refused reply only spoke, so it went; the answer is neu's
      expect(replies(msgs).map((m) => m.model)).toEqual(['neu/claude-opus-5-5']);
      expect(notices(msgs)).toEqual(['Fake Agent declined. Answered by Opus 5.5 (neu).']);
      expect(JSON.stringify(bodyOf(t.requests[0]).messages)).toContain('refuse');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a refused harness turn with the switch off offers the button, and the button runs the hub loop on the first entry', async () => {
    const t = await start({ enabled: false, entries: LIST }, (p) => (p === 'neu' ? answer('neu answers.') : REFUSE));
    try {
      const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
      const cfg = t.engine.config.get();
      t.engine.config.update({ providers: { ...cfg.providers, fake: { type: 'acp', name: 'Fake Agent', command: process.execPath, args: [AGENT] } } } as never);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'fake/default' });
      await t.run(s.id, 'refuse');
      expect(t.requestProviders).toEqual([]);
      const before = t.engine.getMessages(s.id);
      expect(replies(before).map((m) => [m.model, m.stopReason])).toEqual([['fake/default', 'refusal']]);
      expect(before.filter((m) => m.kind === 'notice').map((m) => [(m.content[0] as TextBlock).text, m.meta?.canTryNext])).toEqual([['Fake Agent declined to continue.', true]]);
      expect(await t.engine.tryNextModel(s.id)).toEqual({ model: 'neu/claude-opus-5-5', label: 'Opus 5.5 (neu)' });
      await t.engine.runnerFor(s.id).waitIdle();
      expect(t.requestProviders).toEqual(['neu']);
      const after = t.engine.getMessages(s.id);
      expect(replies(after).map((m) => m.model)).toEqual(['neu/claude-opus-5-5']);
      expect(notices(after).at(-1)).toBe('Fake Agent declined. Answered by Opus 5.5 (neu).');
    } finally {
      await t.close();
    }
  }, 60_000);
});
