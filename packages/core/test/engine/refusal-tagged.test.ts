/**
 * Plans and keys marked "Use when a model refuses" (AccountConfig.refusal,
 * session/refusal-fallback.ts): after a refusal the same model runs on each
 * marked one of its vendor first, in the owner's account order, skipping the
 * one that refused and any that is paused or at a limit. Then the Refusal
 * fallback list runs as before.
 */
import { describe, expect, test } from 'bun:test';
import type { Message, TextBlock } from '../../src/types';
import type { AccountConfig, RefusalFallbackConfig } from '../../src/config/schema';
import { accountsOf } from '../../src/accounts/attached';
import { refusalPlan } from '../../src/session/refusal-fallback';
import { startTestEngine, type Step, type TestEngine } from './harness';

const OPUS = 'mock/claude-opus-5-5';
const REFUSE: Step = { blocks: [{ text: 'I can not help with that.' }], stop: 'refusal' };
const answer = (text: string): Step => [{ text }];

/** Four Claude API keys in this order (neu, personal, work, spare) and GLM; `marked` says which are marked. */
async function start(marked: Partial<Record<string, Partial<AccountConfig>>>, fallback: RefusalFallbackConfig | undefined, route: (provider: string) => Step | number | undefined): Promise<TestEngine> {
  const acct = (id: string): AccountConfig => ({ id, label: id, vendor: 'anthropic', kind: 'api', provider: id, ...(marked[id] ?? {}) });
  return startTestEngine({
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    extraProviders: { neu: ['claude-opus-5-5'], personal: ['claude-opus-5-5'], work: ['claude-opus-5-5'], spare: ['claude-opus-5-5'], glm: ['glm-5.3'] },
    script: [answer('script')],
    route: (_b, _t, provider) => route(provider),
    overrides: {
      limits: { maxRetries: 0 },
      models: {
        tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'mock/claude-sonnet-5-5' },
        accounts: ['neu', 'personal', 'work', 'spare'].map(acct),
        ...(fallback ? { refusalFallback: fallback } : {}),
      },
    } as never,
  });
}

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);
const replies = (msgs: Message[]) => msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal');
const bodyOf = (req: string) => JSON.parse(req) as { messages: unknown[]; model: string };

describe('Use when a model refuses', () => {
  test('a mark alone makes a plan: no list needed', () => {
    const cfg = (accounts: unknown[], entries?: unknown[]) => ({ models: { accounts, ...(entries ? { refusalFallback: { entries } } : {}) } }) as never;
    expect(refusalPlan(cfg([{ id: 'a', vendor: 'anthropic', kind: 'api' }]))).toBeUndefined();
    expect(refusalPlan(cfg([{ id: 'a', vendor: 'anthropic', kind: 'api', refusal: true }]))).toMatchObject({ entries: [], auto: false, tagged: true });
    // a paused one does not count
    expect(refusalPlan(cfg([{ id: 'a', vendor: 'anthropic', kind: 'api', refusal: true, enabled: false }]))).toBeUndefined();
    // an agent with refusalFallback: off has none either way
    expect(refusalPlan(cfg([{ id: 'a', vendor: 'anthropic', kind: 'api', refusal: true }]), { refusalFallback: false })).toBeUndefined();
  });

  test('marked ones first, same model, in account order; the one that refused, a paused one and one at a limit are skipped; then the list', async () => {
    const t = await start({ neu: { refusal: true }, personal: { refusal: true }, work: { refusal: true, enabled: false }, spare: { refusal: true } }, { enabled: true, entries: [{ model: 'glm/glm-5.3' }] }, (p) => (p === 'glm' ? answer('GLM answers.') : REFUSE));
    try {
      // spare is at its limit (a 429 the hub saw)
      accountsOf(t.engine)!.noteLimit('spare', 'claude-opus-5-5');
      expect(accountsOf(t.engine)!.refusalAccounts('claude-opus-5-5').map((a) => a.id)).toEqual(['neu', 'personal']);
      // the chat runs on neu itself
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'neu/claude-opus-5-5' });
      await t.run(s.id, 'Explain this exploit mitigation.');
      // neu refused; personal (marked) is next with the same model; work is paused and spare at its limit; then GLM from the list
      expect(t.requestProviders).toEqual(['neu', 'personal', 'glm']);
      const bodies = t.requests.map(bodyOf);
      expect(bodies.map((b) => b.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'glm-5.3']);
      expect(JSON.stringify(bodies[1].messages)).toBe(JSON.stringify(bodies[0].messages));
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs)[0]).toBe('Opus 5.5 (neu) declined. Trying Opus 5.5 (personal).');
      expect(notices(msgs)[1]).toMatch(/^Opus 5\.5 \(personal\) declined\. Answered by GLM/);
      expect(replies(msgs).map((m) => m.model)).toEqual(['glm/glm-5.3']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('the reply shows which marked plan answered, and the usage row names it', async () => {
    // "Try the next model on its own" on, with an empty list: the mark is enough
    const t = await start({ personal: { refusal: true } }, { enabled: true }, (p) => (p === 'personal' ? answer('Here it is.') : REFUSE));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['mock', 'personal']);
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs)).toEqual(['Opus 5.5 declined. Answered by Opus 5.5 (personal).']);
      expect(replies(msgs).map((m) => m.model)).toEqual(['personal/claude-opus-5-5']);
      expect(t.engine.repos.usage.lastAccount(s.id, 0)).toBe('personal');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('switch off: Try the next model takes the same order, marked ones first, then the list', async () => {
    const t = await start({ neu: { refusal: true }, personal: { refusal: true } }, { enabled: false, entries: [{ model: 'glm/glm-5.3' }] }, (p) => (p === 'glm' ? answer('GLM answers.') : REFUSE));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'please');
      // the switch is off: the refusal stands, with the button
      expect(t.requestProviders).toEqual(['mock']);
      const msgs = t.engine.getMessages(s.id);
      expect(msgs.filter((m) => m.kind === 'notice').at(-1)!.meta).toMatchObject({ type: 'refusal', canTryNext: true });
      expect(await t.engine.tryNextModel(s.id)).toEqual({ model: 'neu/claude-opus-5-5', label: 'Opus 5.5 (neu)' });
      await t.engine.runnerFor(s.id).waitIdle();
      expect(t.requestProviders).toEqual(['mock', 'neu', 'personal', 'glm']);
      expect(replies(t.engine.getMessages(s.id)).map((m) => m.model)).toEqual(['glm/glm-5.3']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('Try the next model on a reply a marked plan refused goes on after it, not back to the first', async () => {
    const t = await start({ neu: { refusal: true }, personal: { refusal: true } }, { enabled: true, entries: [] }, () => REFUSE);
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: OPUS });
      await t.run(s.id, 'go');
      // every one refused: personal's refusal stands, marked as that step
      expect(t.requestProviders).toEqual(['mock', 'neu', 'personal']);
      const last = replies(t.engine.getMessages(s.id)).at(-1)!;
      expect(last.model).toBe('personal/claude-opus-5-5');
      expect(last.meta?.refusalStep).toBe('tagged');
      await expect(t.engine.tryNextModel(s.id)).rejects.toThrow('No model is left');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('another vendor\'s marked plans are not asked', async () => {
    const t = await start({ personal: { refusal: true } }, { enabled: true, entries: [{ model: 'neu/claude-opus-5-5' }] }, (p) => (p === 'neu' ? answer('neu') : REFUSE));
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'glm/glm-5.3' });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['glm', 'neu']);
    } finally {
      await t.close();
    }
  }, 30_000);
});
