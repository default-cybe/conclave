/**
 * Model lists from the account itself (a new Codex model): a harness reports
 * the models its account offers through its ACP model option; the hub keeps
 * them, lists them after the configured ones (the static fallback), and asks
 * again on Refresh models.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AcpAdapter, harnessModels } from '../../src/acp/adapter';
import type { HarnessEvent } from '../../src/acp/types';
import { startTestEngine } from './harness';
import { TestMachine } from '../acp/test-machine';

const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
const groupOf = async (t: Awaited<ReturnType<typeof startTestEngine>>, provider: string) => (await t.engine.listModels()).find((g) => g.provider === provider)!;

describe('model lists from the account', () => {
  test('harnessModels reads the model option, or the older models list', () => {
    expect(
      harnessModels({
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-5.5', options: [{ value: 'gpt-5.5', name: 'GPT-5.5' }, { group: 'New', name: 'New', options: [{ value: 'gpt-6.2-nova', name: 'GPT-6.2-Nova' }] }] },
        ] as never,
      }),
    ).toEqual([{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-6.2-nova', name: 'GPT-6.2-Nova' }]);
    expect(harnessModels({ models: { availableModels: [{ modelId: 'gpt-6.2-nova', name: 'gpt-6.2-nova' }] } })).toEqual([{ id: 'gpt-6.2-nova' }]);
    expect(harnessModels(undefined)).toEqual([]);
  });

  test('a harness turn reports its models, and listModels asks for them without a turn', async () => {
    const providers = { codex: { type: 'acp' as const, command: process.execPath, args: [AGENT], env: { FAKE_ACP_NEW_MODEL: 'gpt-6.2-nova', FAKE_ACP_NEW_MODEL_NAME: 'GPT-6.2-Nova' } } };
    const a = new AcpAdapter((id) => providers[id as 'codex']);
    try {
      const machine = new TestMachine();
      const evs: HarnessEvent[] = [];
      for await (const e of a.runTurn({ harness: 'codex', machine, cwd: machine.resolve('~', '/'), prompt: [{ type: 'text', text: 'echo' }], permission: 'ask', signal: new AbortController().signal, requestApproval: async () => ({ decision: 'allow' }) })) evs.push(e);
      const models = evs.find((e) => e.type === 'models') as Extract<HarnessEvent, { type: 'models' }>;
      expect(models.models.map((m) => m.id)).toEqual(['fake-default', 'fake-opus-1', 'fake-haiku-1', 'gpt-6.2-nova']);
      expect(models.models.at(-1)).toEqual({ id: 'gpt-6.2-nova', name: 'GPT-6.2-Nova' });
      expect((await a.listModels('codex', machine)).map((m) => m.id)).toContain('gpt-6.2-nova');
    } finally {
      await a.shutdown();
    }
  }, 30_000);

  test('reported models join the static list, are kept across a restart, and an unknown id shows by the harness name', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      t.engine.config.update({ providers: { codex: { type: 'acp', name: 'Codex', command: process.execPath, args: [AGENT], models: ['default'] } } } as never);
      // before the account was asked: the static entries only
      expect((await groupOf(t, 'codex')).models.map((m) => m.id)).toEqual(['default']);
      let updates = 0;
      const off = t.engine.bus.on((e) => {
        if (e.type === 'models.updated') updates++;
      });
      t.engine.noteHarnessModels('codex', [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-6.2-nova', name: 'GPT-6.2-Nova' }]);
      t.engine.noteHarnessModels('codex', [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-6.2-nova', name: 'GPT-6.2-Nova' }]);
      off();
      expect(updates).toBe(1);
      const g = await groupOf(t, 'codex');
      expect(g.models.map((m) => m.ref)).toEqual(['codex/default', 'codex/gpt-5.5', 'codex/gpt-6.2-nova']);
      expect(g.models.find((m) => m.id === 'gpt-6.2-nova')!.name).toBe('GPT-6.2-Nova');
      // the ref resolves to the harness, so a session can pick it
      expect(t.engine.providers.resolve('codex/gpt-6.2-nova')).toMatchObject({ provider: 'codex', model: 'gpt-6.2-nova', acp: true });
      // kept in the hub's store: a fresh read finds it
      expect(t.engine.repos.kv.get<Record<string, { models: Array<{ id: string }> }>>('harness.models', {}).codex.models.map((m) => m.id)).toContain('gpt-6.2-nova');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('Refresh models asks each harness that is on; one that cannot answer keeps its last list and says so', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      t.engine.config.update({
        providers: {
          // Codex is off by default (acp/harness-off.ts): Refresh models asks only the ones that are on
          codex: { type: 'acp', name: 'Codex', command: process.execPath, args: [AGENT], models: ['default'], enabled: true, env: { FAKE_ACP_NEW_MODEL: 'gpt-6.2-nova', FAKE_ACP_NEW_MODEL_NAME: 'GPT-6.2-Nova' } },
          broken: { type: 'acp', name: 'Broken', command: process.execPath, args: ['-e', 'process.exit(3)'], models: ['default'] },
        },
      } as never);
      t.engine.noteHarnessModels('broken', [{ id: 'older' }]);
      let readers = 0;
      t.engine.onRefreshModels(async () => void readers++);
      const { groups, failed } = await t.engine.refreshModels();
      expect(readers).toBe(1);
      const codex = groups.find((g) => g.provider === 'codex')!;
      expect(codex.models.map((m) => m.id)).toEqual(['default', 'fake-default', 'fake-opus-1', 'fake-haiku-1', 'gpt-6.2-nova']);
      expect(failed.some((f) => f.startsWith('Broken:'))).toBe(true);
      expect(groups.find((g) => g.provider === 'broken')!.models.map((m) => m.id)).toEqual(['default', 'older']);
    } finally {
      await t.close();
    }
  }, 60_000);
});
