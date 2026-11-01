/**
 * Facts, not orders (docs/MEMORY.md): a memory that reads as an order to the
 * model is rewritten as a fact when the rewrite is simple, and otherwise
 * dropped (extraction, the learning job) or sent back (MemorySave, the MCP
 * memory_save).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { asFact, orderIn } from '../../src/memory/facts';
import { parseExtraction, EXTRACT_SYSTEM, IMPORT_SYSTEM } from '../../src/memory/extract';
import { SqliteMemory } from '../../src/memory/store';
import { MemorySaveTool } from '../../src/tools/memory-save';
import { callHubTool, type HubMcpApi } from '../../src/engine/hub-mcp';
import { checkItems, LEARN_SYSTEM } from '../../src/import/learn';
import { renderWindows } from '../../src/import/render';
import { ROUTINE_TEMPLATES } from '../../src/scheduler/templates';
import { PREVIOUS_PROMPTS } from '../../src/scheduler/template-upgrade';
import { BASE_PROMPT } from '../../src/session/prompt';
import type { ImportedMessage } from '../../src/importers/types';
import type { MemoryEntry } from '../../src/types';
import { fakeHost, makeCtx } from '../tools/helpers';
import { msg, setup } from './helpers';

describe('orderIn: how a note starts decides', () => {
  test('orders are caught', () => {
    for (const t of [
      'Always answer short',
      'Never use npm',
      'Do not push to main without asking',
      "Don't add emojis",
      'You must run the tests before a commit',
      'The deploy is risky, so you should ask first',
      'Make sure to run make lint',
      'Use pnpm',
      'Keep answers under five lines',
      'Run the tests with pytest -n 4',
      'When deploying, run make release',
      'Remember: always use pnpm',
      '- Prefer tabs over spaces',
    ]) {
      expect({ t, order: !!orderIn(t) }).toEqual({ t, order: true });
    }
  });

  test('facts pass, including ones that say always or start with a noun that is also a verb', () => {
    for (const t of [
      'The owner prefers short answers',
      'The owner always uses pnpm, never npm',
      'Always-on VPN runs on pve',
      'Use of Docker is not allowed on madx',
      'Start date of the thesis is 2026-11-01',
      'Run 4 of the benchmark failed on the GPU box',
      'Deploys run with make release on the hub',
      'pve is the Proxmox host',
      'The homelab project runs its tests with pytest -n 4',
    ]) {
      expect({ t, order: orderIn(t) }).toEqual({ t, order: undefined });
    }
  });
});

describe('asFact: the simple orders become facts', () => {
  test('use, prefer, never use and avoid', () => {
    expect(asFact('Always use pnpm')).toBe('The owner uses pnpm.');
    expect(asFact('Never use npm!')).toBe('The owner does not use npm.');
    expect(asFact('Prefer short answers.')).toBe('The owner prefers short answers.');
    expect(asFact('Avoid Docker on madx')).toBe('The owner avoids Docker on madx.');
    expect(asFact('Remember: always use pnpm')).toBe('The owner uses pnpm.');
    expect(asFact('Always use pnpm', 'The user')).toBe('The user uses pnpm.');
  });

  test('anything else has no simple rewrite', () => {
    expect(asFact('Always answer short')).toBeUndefined();
    expect(asFact('Run the tests with pytest -n 4')).toBeUndefined();
    expect(asFact('Use pnpm, you must not use npm')).toBeUndefined();
  });
});

describe('extraction', () => {
  test('the prompts carry the rule with a good and a bad example', () => {
    for (const p of [EXTRACT_SYSTEM, LEARN_SYSTEM]) expect(p).toContain('The user prefers short answers');
    expect(EXTRACT_SYSTEM).toContain('Bad: "Always answer briefly."');
    expect(LEARN_SYSTEM).toContain('not "Always answer briefly"');
    expect(IMPORT_SYSTEM).toContain('Good: "The user uses pnpm, not npm." Bad: "Always use pnpm."');
    expect(BASE_PROMPT).toContain('Write memories as facts, not orders: "The owner prefers short answers", not "Always answer short".');
  });

  test('parseExtraction rewrites a simple order, drops the rest and counts both', () => {
    const reply = JSON.stringify({
      add: [
        { content: 'Always use pnpm in every repo', kind: 'fact', scope: 'global', tags: ['tools'] },
        { content: 'Always answer in one short line', kind: 'profile', scope: 'global' },
        { content: 'The user keeps backups on the Optiplex', kind: 'fact', scope: 'global' },
      ],
      update: [{ id: 'mem_1', content: 'Never use the old NAS for backups' }],
    });
    const out = parseExtraction(reply, new Set(['mem_1']))!;
    expect(out.add.map((a) => a.content)).toEqual(['The user uses pnpm in every repo.', 'The user keeps backups on the Optiplex']);
    expect(out.update).toEqual([{ id: 'mem_1', content: 'The user does not use the old NAS for backups.' }]);
    expect(out.orders).toEqual({ rewritten: 2, dropped: 1 });
  });

  let env: ReturnType<typeof setup> | undefined;
  afterEach(() => env?.cleanup());

  test('a session that ends with orders in the model reply saves only facts', async () => {
    env = setup();
    const mem = new SqliteMemory({
      db: env.db,
      bus: env.bus,
      config: env.config,
      complete: async () =>
        JSON.stringify({
          add: [
            { content: 'Always use pnpm, not npm', kind: 'fact', scope: 'global' },
            { content: 'You should always reply in German', kind: 'profile', scope: 'global' },
            { content: 'The user runs Arch Linux on the desktop', kind: 'fact', scope: 'global' },
          ],
          update: [],
        }),
    });
    const saved = await mem.extract('s1', [msg('user', 'remember: always use pnpm. I run Arch on my desktop.', 's1', 1), msg('assistant', 'Noted.', 's1', 2)], {});
    expect(saved.map((e) => e.content).sort()).toEqual(['The user runs Arch Linux on the desktop', 'The user uses pnpm, not npm.']);
    expect(mem.list().every((e) => !orderIn(e.content))).toBe(true);
  });
});

describe('explicit saves', () => {
  test('MemorySave rewrites "Always use pnpm" and says so', async () => {
    const host = fakeHost();
    const out = await MemorySaveTool.run({ content: 'Always use pnpm' }, makeCtx({ cwd: '/tmp', host }));
    expect(out.isError).toBeFalsy();
    expect(host.memories.map((m) => m.content)).toEqual(['The owner uses pnpm.']);
    expect(String(out.content)).toContain('Saved as a fact: "The owner uses pnpm."');
  });

  test('MemorySave sends back an order it cannot rewrite, and saves a fact as it is', async () => {
    const host = fakeHost();
    const ctx = makeCtx({ cwd: '/tmp', host });
    const bad = await MemorySaveTool.run({ content: 'Always answer in one line' }, ctx);
    expect(bad.isError).toBe(true);
    expect(String(bad.content)).toContain('reads as an order');
    expect(host.memories).toEqual([]);
    const good = await MemorySaveTool.run({ content: 'The owner prefers answers of one line' }, ctx);
    expect(good.isError).toBeFalsy();
    expect(host.memories.map((m) => m.content)).toEqual(['The owner prefers answers of one line']);
    expect(MemorySaveTool.description).toContain('Write a fact, not an order');
  });

  test('the MCP memory_save follows the same rule', async () => {
    const saved: string[] = [];
    const api = {
      version: 't',
      memory: { save: async (e: { content: string }) => (saved.push(e.content), { id: 'mem_x', content: e.content }) as unknown as MemoryEntry },
    } as unknown as HubMcpApi;
    expect(await callHubTool(api, 'memory_save', { content: 'Always use pnpm' })).toContain('The owner uses pnpm.');
    await expect(callHubTool(api, 'memory_save', { content: 'Keep every answer short' })).rejects.toThrow(/reads as an order/);
    expect(saved).toEqual(['The owner uses pnpm.']);
  });
});

describe('the learning job', () => {
  const messages: ImportedMessage[] = [
    { role: 'user', kind: 'normal', createdAt: 0, content: [{ type: 'text', text: 'From now on always use pnpm in this repo. And always reply in one line.' }], meta: { external: { source: 'claude-code', id: 'u1' }, origin: 'human' } },
    { role: 'assistant', kind: 'normal', createdAt: 0, content: [{ type: 'text', text: 'Got it.' }], meta: { external: { source: 'claude-code', id: 'a1' } } },
  ];
  const window = renderWindows(messages)[0];
  const item = (content: string, evidence: string) => ({ kind: 'preference', content, scope: 'global', subject: '', evidence, basis: 'user_said', supersedes: '' });

  test('an order with a simple rewrite is kept as a fact, any other is dropped as an order', () => {
    const dropped: Record<string, number> = {};
    const ok = checkItems([item('Always use pnpm in this repo', 'always use pnpm in this repo'), item('Always reply in one line', 'always reply in one line')], window, new Set(), new Set(), dropped);
    expect(ok.map((i) => i.content)).toEqual(['The user uses pnpm in this repo.']);
    expect(dropped.order).toBe(1);
  });
});

describe('the nightly reflection keeps facts', () => {
  test('its prompt asks for facts, and routines on the old prompt get the new one', () => {
    const t = ROUTINE_TEMPLATES.find((x) => x.id === 'nightly-reflection')!;
    expect(t.prompt).toContain('Each is one fact about how I like to work, not an order');
    expect(t.prompt).not.toContain('instruction for your future self');
    expect(PREVIOUS_PROMPTS['nightly-reflection']).toContain('99a6c6e2af8acdf0');
  });
});
