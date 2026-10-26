/**
 * The model picker in two levels (components/pickers/ModelPicker.tsx):
 * Recent and one row per maker first (Anthropic, OpenAI, Google, Z.ai, then
 * the others, coding agents last), a maker's models behind its row with a
 * back row, one flat list while searching, and the keys. The list is
 * mounted on linkedom for the clicks and keys.
 *
 *   cd packages/web && bun test test/model-picker.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ModelEntry, ModelGroup } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { buildPicker, compareModels, familyHead, groupNote, groupOf, makerRank, pickerItems, routeLabel, rowName, type Picker, type PickerInput } from '../src/components/pickers/ModelPicker';
import { registerModelNames } from '../src/lib/models';

function model(provider: string, id: string, name: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return { id, ref: `${provider}/${id}`, provider, name, contextWindow: 200_000, maxOutput: 64_000, vision: true, tools: true, thinking: true, caching: 'explicit', inputPrice: 1, outputPrice: 5, cacheReadPrice: 0.1, cacheWritePrice: 1.25, ...extra } as ModelEntry;
}
const group = (provider: string, models: ModelEntry[], extra: Partial<ModelGroup> = {}): ModelGroup => ({ provider, name: provider, type: 'openai', configured: true, enabled: true, models, ...extra }) as ModelGroup;

// the hub's list in the order it sends it: Z.ai before Google, GLM also through OpenRouter, a revoked DeepSeek key, harnesses last
const MODELS: ModelGroup[] = [
  group('anthropic', [model('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5'), model('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5'), model('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5')]),
  group('openai', [model('openai', 'gpt-5.5', 'GPT-5.5'), model('openai', 'gpt-5.5-mini', 'GPT-5.5 mini')]),
  group('zai', [model('zai', 'glm-5', 'GLM-5'), model('zai', 'glm-4.7', 'GLM-4.7')]),
  group('google', [model('google', 'gemini-3-pro', 'Gemini 3 Pro')]),
  group('openrouter', [model('openrouter', 'z-ai/glm-5.3', 'GLM-5.3'), model('openrouter', 'anthropic/claude-opus-5-5', 'Claude Opus 5.5', { sameAs: 'anthropic/claude-opus-5-5' })]),
  group('deepseek', [model('deepseek', 'deepseek-chat', 'DeepSeek V3.2')], { enabled: false, error: 'Rejected with 401.' }),
  group('ollama', [model('ollama', 'llama-4-local', 'Llama 4')]),
  group('claude-code', [model('claude-code', 'default', 'Claude Code'), model('claude-code', 'opus', 'Claude Code, Opus')], { type: 'acp' }),
  group('opencode', [model('opencode', 'default', 'OpenCode')], { type: 'acp', enabled: false }),
];

const session = (id: string, model: string, updatedAt: number) => ({ id, model, updatedAt }) as unknown as Session;
const SESSIONS: Record<string, Session> = {
  a: session('a', 'openai/gpt-5.5', 3),
  b: session('b', 'anthropic/claude-sonnet-5-5', 2),
};

const input = (over: Partial<PickerInput> = {}): PickerInput => ({ models: MODELS, sessions: SESSIONS, devices: {}, limits: {}, harnesses: true, ...over });

describe('the first level', () => {
  const p = buildPicker(input());

  test('one row per maker: Anthropic, OpenAI, Google, Z.ai, then the others, coding agents last', () => {
    expect(p.groups.map((g) => g.key)).toEqual(['anthropic', 'openai', 'google', 'zai', 'deepseek', 'ollama', 'harness']);
    expect(p.groups.map((g) => g.name)).toEqual(['Anthropic', 'OpenAI', 'Google', 'Z.ai', 'DeepSeek', 'Ollama', 'Coding agents']);
    expect(makerRank('anthropic')).toBeLessThan(makerRank('openai'));
    expect(makerRank('google')).toBeLessThan(makerRank('zai'));
    expect(makerRank('zai')).toBeLessThan(makerRank('deepseek'));
    expect(makerRank('cliproxy')).toBeLessThan(makerRank('harness'));
  });

  test('each model sits under its maker, whatever route reaches it, newest first; a merged copy shows once; an off harness is not offered', () => {
    const zai = p.groups.find((g) => g.key === 'zai')!;
    expect(zai.rows.map((r) => r.ref)).toEqual(['openrouter/z-ai/glm-5.3', 'zai/glm-5', 'zai/glm-4.7']);
    // the row is the model's name, not the route
    expect(rowName(zai.rows[0])).toBe('GLM-5.3');
    // fed by another provider, the maker says no account word; one of its own does
    expect(zai.word).toBeUndefined();
    expect(p.groups.find((g) => g.key === 'deepseek')!.word).toBe('rejected');
    expect(p.groups.find((g) => g.key === 'anthropic')!.rows.map((r) => r.ref)).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5']);
    expect(p.groups.find((g) => g.key === 'harness')!.rows.map((r) => r.ref)).toEqual(['claude-code/default', 'claude-code/opus']);
    // the same models as the flat list had: every row of every maker, nothing more
    const all = p.groups.flatMap((g) => g.rows.map((r) => r.ref));
    expect(all.length).toBe(new Set(all).size);
    expect(all).not.toContain('openrouter/anthropic/claude-opus-5-5');
    expect(all).not.toContain('opencode/default');
  });

  test('without coding agents there is no such row', () => {
    expect(buildPicker(input({ harnesses: false })).groups.map((g) => g.key)).not.toContain('harness');
  });

  test('Recent stays at the top, newest first, then the makers', () => {
    const items = pickerItems(p, '', null);
    expect(items.slice(0, 2).map((it) => (it.kind === 'model' ? it.row.ref : it.kind))).toEqual(['openai/gpt-5.5', 'anthropic/claude-sonnet-5-5']);
    expect(items.slice(2).every((it) => it.kind === 'group')).toBe(true);
  });

  test("a maker's row says the current model's name there, else how many models it has", () => {
    const anthropic = p.groups[0];
    expect(groupNote(anthropic, 'anthropic/claude-opus-5-5')).toBe('Opus 5.5');
    expect(groupNote(anthropic, 'openai/gpt-5.5')).toBe('3');
    expect(groupNote(anthropic, undefined)).toBe('3');
    expect(groupNote(p.groups.at(-1)!, 'claude-code/opus')).toBe('Claude Code, Opus');
    // jurors: one picked names it, more count them
    expect(groupNote(anthropic, undefined, ['anthropic/claude-haiku-5-5'])).toBe('Haiku 5.5');
    expect(groupNote(anthropic, undefined, ['anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5', 'openai/gpt-5.5'])).toBe('2 selected');
  });
});

// a custom provider serving fine-tunes on catalog names, next to the Z.ai plan's own GLM-5.3
const CUSTOM: ModelGroup[] = [
  group('zai', [model('zai', 'glm-5.3', 'GLM-5.3'), model('zai', 'glm-5.3-flash', 'GLM-5.3 Flash')]),
  group(
    'experientiallabs',
    [
      model('experientiallabs', 'glm-5.3-uncensored', 'GLM-5.3 Uncensored', { inputPrice: 0, outputPrice: 0 }),
      model('experientiallabs', 'glm-5.3-flash-uncensored', 'GLM-5.3 Flash Uncensored', { inputPrice: 0, outputPrice: 0 }),
      model('experientiallabs', 'deepseek-v4.1-flash-uncensored', 'deepseek-v4.1-flash-uncensored', { inputPrice: 0, outputPrice: 0 }),
    ],
    { name: 'Experiential Labs' },
  ),
];

describe('a custom provider', () => {
  test('its models are rows of their own under the maker, by their own names, saying whose they are', () => {
    registerModelNames(CUSTOM.flatMap((g) => g.models));
    const zai = buildPicker(input({ models: CUSTOM, sessions: {} })).groups.find((g) => g.key === 'zai')!;
    expect(zai.rows.map((r) => [r.ref, rowName(r), r.source])).toEqual([
      ['zai/glm-5.3', 'GLM-5.3', undefined],
      ['zai/glm-5.3-flash', 'GLM-5.3 Flash', undefined],
      ['experientiallabs/glm-5.3-uncensored', 'GLM-5.3 Uncensored', 'Experiential Labs'],
      ['experientiallabs/glm-5.3-flash-uncensored', 'GLM-5.3 Flash Uncensored', 'Experiential Labs'],
    ]);
    const deepseek = buildPicker(input({ models: [group('experientiallabs', CUSTOM[1].models)], sessions: {} })).groups.find((g) => g.key === 'deepseek')!;
    // no config name: its id
    expect(deepseek.rows.map((r) => [rowName(r), r.source])).toEqual([['DeepSeek V4.1 Flash Uncensored', 'Experientiallabs']]);
  });

  test('a plan row that says its own "via", with no other routes, names no source', () => {
    const p = buildPicker(input({ models: [group('cliproxy', [plan('claude-sonnet-5-5', 'Claude Sonnet 5.5', { via: 'your Claude plans' })], { name: 'CLIProxyAPI' })], sessions: {} }));
    const row = p.groups.find((g) => g.key === 'anthropic')!.rows[0];
    expect(row.ref).toBe('cliproxy/claude-sonnet-5-5');
    expect(row.routes).toBeUndefined();
    expect(row.source).toBeUndefined();
  });

  test('the row says "via" the provider', async () => {
    const v = await mount({ value: 'experientiallabs/glm-5.3-uncensored', models: CUSTOM });
    try {
      const row = v.options().find((o) => o.getAttribute('aria-selected') === 'true')!;
      expect(row.textContent).toContain('GLM-5.3 Uncensoredvia Experiential Labs');
      // the two custom rows say it, Z.ai's own do not
      const vias = v.options().filter((o) => o.textContent?.includes('via Experiential Labs'));
      expect(vias.map((o) => o.textContent?.split('via')[0])).toEqual(expect.arrayContaining(['GLM-5.3 Uncensored', 'GLM-5.3 Flash Uncensored']));
      expect(vias.length).toBe(2);
    } finally {
      await v.unmount();
    }
  });
});

describe('inside a maker, and searching', () => {
  const p: Picker = buildPicker(input());

  test('a maker opens to a back row and its models', () => {
    const items = pickerItems(p, '', 'openai');
    expect(items[0]).toMatchObject({ kind: 'back', group: { key: 'openai' } });
    expect(items.slice(1).map((it) => (it.kind === 'model' ? it.row.ref : it.kind))).toEqual(['openai/gpt-5.5', 'openai/gpt-5.5-mini']);
  });

  test('the picker opens on the maker of the current model, and on the makers with none', () => {
    expect(groupOf(p.groups, 'zai/glm-5')).toBe('zai');
    expect(groupOf(p.groups, 'openrouter/z-ai/glm-5.3')).toBe('zai');
    expect(groupOf(p.groups, 'claude-code/opus')).toBe('harness');
    expect(groupOf(p.groups, undefined)).toBeNull();
    expect(groupOf(p.groups, 'nowhere/some-model')).toBeNull();
  });

  test('a search is one flat list of models from every maker, Recent not twice', () => {
    for (const open of [null, 'anthropic']) {
      const items = pickerItems(p, '5.5', open);
      expect(items.every((it) => it.kind === 'model')).toBe(true);
      const refs = items.map((it) => (it.kind === 'model' ? it.row.ref : ''));
      expect(refs).toContain('anthropic/claude-opus-5-5');
      expect(refs).toContain('openai/gpt-5.5');
      expect(refs.length).toBe(new Set(refs).size);
    }
    expect(pickerItems(p, 'zzzz', null)).toEqual([]);
  });
});

// The hub's list as core merges it (providers/merge.ts): Claude through the plans first, the key and a plan's prefix hidden
// behind the row; effort variants, image and review models and Meta's Muse as the live CLIProxyAPI list has them
const plan = (id: string, name: string, extra: Partial<ModelEntry> = {}) => model('cliproxy', id, name, { inputPrice: 0, outputPrice: 0, ...extra });
const HUB: ModelGroup[] = [
  group('anthropic', [
    model('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', { sameAs: 'cliproxy/claude-opus-5-5' }),
    model('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', { via: 'API key' }),
    model('anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5'),
  ]),
  group('openai', [model('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', { sameAs: 'cliproxy/gpt-6.1-sol' })]),
  group('cliproxy', [
    plan('claude-sonnet-5-5', 'Claude Sonnet 5.5', { via: 'your Claude plans' }),
    plan('claude-opus-5-5', 'Claude Opus 5.5', {
      via: 'your Claude plans, then API key',
      refs: ['cliproxy/claude-opus-5-5', 'anthropic/claude-opus-5-5', 'cliproxy/neu-claude/claude-opus-5-5', 'openrouter/anthropic/claude-opus-5.5'],
      choices: ['cliproxy/neu-claude/claude-opus-5-5', 'openrouter/anthropic/claude-opus-5.5'],
    }),
    plan('gpt-6.1-sol', 'GPT-6.1 Sol', { via: 'your ChatGPT plan, then API key', refs: ['cliproxy/gpt-6.1-sol', 'openai/gpt-6.1-sol', 'cliproxy/neu/gpt-6.1-sol'], choices: ['cliproxy/neu/gpt-6.1-sol'] }),
    plan('claude-opus-5-5-high', 'claude-opus-5-5-high'),
    plan('claude-opus-4-6-thinking', 'claude-opus-4-6-thinking'),
    plan('gpt-image-2', 'gpt-image-2'),
    plan('codex-auto-review', 'codex-auto-review'),
    plan('muse-spark-1', 'muse-spark-1'),
    plan('neu-claude/claude-opus-5-5', 'Claude Opus 5.5, neu-claude', { sameAs: 'cliproxy/claude-opus-5-5' }),
    plan('neu/gpt-6.1-sol', 'GPT-6.1 Sol, neu', { sameAs: 'cliproxy/gpt-6.1-sol' }),
    plan('neu/gpt-6-astra', 'GPT-6 Astra, neu'),
  ]),
  group('openrouter', [model('openrouter', 'anthropic/claude-opus-5.5', 'Claude Opus 5.5', { sameAs: 'cliproxy/claude-opus-5-5' })]),
  group('codex', [model('codex', 'default', 'Codex'), model('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol')], { type: 'acp' }),
];

describe('one row per model, by its name, the routes behind it', () => {
  registerModelNames(HUB.flatMap((g) => g.models.map((m) => ({ ref: m.ref, name: m.name }))));
  const p = buildPicker({ models: HUB, sessions: {}, devices: {}, limits: {}, harnesses: true });
  const rows = (key: string) => p.groups.find((g) => g.key === key)!.rows;

  test('no repeats: every copy of a model is one row, under its maker, by family and newest first', () => {
    expect(rows('anthropic').map((r) => r.ref)).toEqual(['cliproxy/claude-opus-5-5', 'cliproxy/claude-opus-4-6-thinking', 'anthropic/claude-opus-4-5-20251101', 'cliproxy/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5']);
    // a dated snapshot reads without its date; a variant alone stands as its model
    expect(rows('anthropic').map(rowName)).toEqual(['Opus 5.5', 'Opus 4.6', 'Opus 4.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(rows('anthropic').map((_, i) => familyHead(rows('anthropic'), i))).toEqual(['Opus', null, null, 'Sonnet', 'Haiku']);
    const all = p.groups.flatMap((g) => g.rows.map((r) => r.ref));
    expect(all.length).toBe(new Set(all).size);
    expect(p.groups.map((g) => g.key)).toEqual(['anthropic', 'openai', 'meta', 'harness']);
  });

  test('an effort variant folds behind its model; image and review models are not chat models', () => {
    expect(rows('anthropic')[0].routes?.map((r) => r.label)).toEqual(['Main accounts', 'neu-claude', 'OpenRouter', 'High']);
    expect(rows('anthropic')[1].routes).toEqual([{ ref: 'cliproxy/claude-opus-4-6-thinking', label: 'Thinking', first: true }]);
    expect(rows('openai').map((r) => r.ref)).toEqual(['cliproxy/gpt-6.1-sol', 'cliproxy/neu/gpt-6-astra']);
    expect(rows('meta').map((r) => r.ref)).toEqual(['cliproxy/muse-spark-1']);
    expect(pickerItems(p, 'image', null).filter((it) => it.kind === 'model')).toEqual([]);
  });

  test('a row names no provider or plan; the other routes are a choice under it, the owner\'s first route first', () => {
    const opus = rows('anthropic')[0];
    expect(opus.routes).toEqual([
      { ref: 'cliproxy/claude-opus-5-5', label: 'Main accounts', first: true },
      { ref: 'cliproxy/neu-claude/claude-opus-5-5', label: 'neu-claude' },
      { ref: 'openrouter/anthropic/claude-opus-5.5', label: 'OpenRouter' },
      { ref: 'cliproxy/claude-opus-5-5-high', label: 'High' },
    ]);
    expect(rows('anthropic')[2].routes).toBeUndefined();
    const items = pickerItems(p, '', 'anthropic', 'anthropic:cliproxy/claude-opus-5-5');
    expect(items.slice(1, 5).map((it) => it.kind + ':' + (it.kind === 'route' ? it.route.ref : it.kind === 'model' ? it.row.ref : ''))).toEqual([
      'model:cliproxy/claude-opus-5-5',
      'route:cliproxy/claude-opus-5-5',
      'route:cliproxy/neu-claude/claude-opus-5-5',
      'route:openrouter/anthropic/claude-opus-5.5',
    ]);
    expect(routeLabel('anthropic/claude-opus-5-5')).toBe('Anthropic');
  });

  test('a plan approved for Daybreak: a "Daybreak Blue" row under OpenAI, beside the GPT-6 rows', () => {
    const blue = plan('kai/gpt-daybreak-blue-latest', 'Daybreak Blue, kai');
    const models = HUB.map((g) => (g.provider === 'cliproxy' ? { ...g, models: [...g.models, blue] } : g));
    registerModelNames([{ ref: blue.ref, name: blue.name }]);
    const openai = buildPicker({ models, sessions: {}, devices: {}, limits: {}, harnesses: false }).groups.find((g) => g.key === 'openai')!.rows;
    expect(openai.map((r) => [r.ref, rowName(r)])).toContainEqual(['cliproxy/kai/gpt-daybreak-blue-latest', 'Daybreak Blue']);
    expect(openai.map((r) => r.ref)).toContain('cliproxy/gpt-6.1-sol');
  });

  test('a plan of another vendor that lists only a variant (Antigravity) is a "via" route under the model, by its own prefixed id', () => {
    const ag = 'cliproxy/backup-gemini/claude-opus-5-5-high';
    const accounts = [
      { prefix: 'backup-gemini', vendor: 'gemini', vendorName: 'Gemini', credential: 'antigravity-me@example.test.json' },
      { prefix: 'neu-claude', vendor: 'anthropic', vendorName: 'Claude', credential: 'claude-neu.json' },
    ];
    const opus = (models: ModelEntry[]) => {
      const hub = HUB.map((g) => (g.provider === 'cliproxy' ? { ...g, models } : g));
      const rows = buildPicker({ models: hub, sessions: {}, devices: {}, limits: {}, harnesses: false, accounts }).groups.find((g) => g.key === 'anthropic')!.rows;
      // still one Opus 5.5 row
      expect(rows.filter((r) => rowName(r) === 'Opus 5.5').length).toBe(1);
      return rows[0];
    };
    const cliproxy = HUB.find((g) => g.provider === 'cliproxy')!.models;
    // the main accounts list the variant too: merged, the plan is a choice of it
    const merged = cliproxy.map((m) => (m.id === 'claude-opus-5-5-high' ? { ...m, refs: [m.ref, ag], choices: [ag] } : m));
    expect(opus([...merged, plan('backup-gemini/claude-opus-5-5-high', 'Claude Opus 5.5 (High), backup-gemini', { sameAs: 'cliproxy/claude-opus-5-5-high' })]).routes?.slice(3)).toEqual([
      { ref: 'cliproxy/claude-opus-5-5-high', label: 'High' },
      { ref: ag, label: 'backup-gemini (Antigravity)' },
    ]);
    // only the plan lists it
    const alone = cliproxy.filter((m) => m.id !== 'claude-opus-5-5-high');
    expect(opus([...alone, plan('backup-gemini/claude-opus-5-5-high', 'Claude Opus 5.5 (High), backup-gemini')]).routes?.map((r) => [r.ref, r.label])).toEqual([
      ['cliproxy/claude-opus-5-5', 'Main accounts'],
      ['cliproxy/neu-claude/claude-opus-5-5', 'neu-claude'],
      ['openrouter/anthropic/claude-opus-5.5', 'OpenRouter'],
      [ag, 'backup-gemini (Antigravity)'],
    ]);
  });

  test('versions sort newest first, a plain id before its variants and snapshots', () => {
    const ids = ['gpt-5.5-mini', 'o4', 'gpt-6.1-sol', 'gpt-5.5', 'codex-mini', 'gpt-6'];
    expect([...ids].sort(compareModels)).toEqual(['gpt-6.1-sol', 'gpt-6', 'gpt-5.5', 'gpt-5.5-mini', 'o4', 'codex-mini']);
    expect(['claude-opus-4-5-20251101', 'claude-opus-4-5'].sort(compareModels)).toEqual(['claude-opus-4-5', 'claude-opus-4-5-20251101']);
    expect(['gemini-3-flash', 'gemini-3-pro', 'gemini-2.5-pro'].sort(compareModels)).toEqual(['gemini-3-pro', 'gemini-2.5-pro', 'gemini-3-flash']);
  });
});

// ---------------------------------------------------------------------------
// The list on a page: clicks and keys
// ---------------------------------------------------------------------------

class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;

beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  win = dom.window;
  // a browser has an input event; linkedom's document lacks the property React looks for
  dom.document.oninput = null;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  g.window = win;
  g.document = dom.document;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.matchMedia = win.matchMedia;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.MutationObserver = Quiet;
  g.ResizeObserver = Quiet;
  g.IntersectionObserver = Quiet;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await Bun.sleep(50);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

async function mount(props: { value?: string; values?: string[]; models?: ModelGroup[] }) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { useHub } = await import('../src/store/store');
  const { ModelList } = await import('../src/components/pickers/ModelPicker');
  useHub.setState({ models: props.models ?? MODELS, sessions: props.models ? {} : SESSIONS, devices: {}, limits: {} });
  const picks: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/' }).hook}>{<ModelList value={props.value} onChange={(r) => picks.push(r)} />}</Router>));
  const input = host.querySelector('input') as HTMLInputElement;
  // a browser reads a field with no type as text; linkedom says null, and React then listens for no typing
  Object.defineProperty(input, 'type', { configurable: true, get: () => input.getAttribute('type') ?? 'text' });
  // the field has the focus, as autoFocus gives it in a browser. Where React found no input event (react-dom loaded
  // under another test's linkedom), it follows typing from the focused field with the old IE calls, here stand-ins
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  await act(async () => {
    input.dispatchEvent(new win.Event('focusin', { bubbles: true }));
  });
  const options = () => [...host.querySelectorAll('[role="option"]')] as HTMLElement[];
  const texts = () => options().map((o) => o.getAttribute('aria-label') ?? o.textContent ?? '');
  /** The highlighted line: the one with the hover fill. */
  const highlighted = () => options().find((o) => o.className.split(/\s+/).includes('bg-hover'));
  const key = async (k: string) =>
    act(async () => {
      const e = new win.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(e, { key: k });
      input.dispatchEvent(e);
    });
  const click = async (el: Element) =>
    act(async () => {
      el.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
    });
  const type = async (v: string) =>
    act(async () => {
      // past React's own record of the value, as a browser's typing is
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, v);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(new win.Event('keyup', { bubbles: true }));
    });
  return {
    host,
    picks,
    options,
    texts,
    highlighted,
    key,
    click,
    type,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('the list, clicked and keyed', () => {
  test('it opens on the current model: the back row to the makers, its models, the current one checked and highlighted', async () => {
    const v = await mount({ value: 'anthropic/claude-sonnet-5-5' });
    try {
      expect(v.texts()[0]).toBe('Back from Anthropic');
      expect(v.options().length).toBe(4);
      const checked = v.options().filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(checked.map((o) => o.textContent)).toEqual([expect.stringContaining('Sonnet 5.5')]);
      expect(v.highlighted()?.textContent).toContain('Sonnet 5.5');
      expect(v.host.textContent).not.toContain('Recent');
    } finally {
      await v.unmount();
    }
  });

  test('with no model it opens on Recent and the makers; a maker opens in place and its back row comes back', async () => {
    const v = await mount({});
    try {
      expect(v.host.textContent).toContain('Recent');
      expect(v.texts().slice(2).map((t) => t.replace(/\d+$/, ''))).toEqual(['Anthropic', 'OpenAI', 'Google', 'Z.ai', 'DeepSeek', 'Ollama', 'Coding agents']);
      // drill in with a click
      const google = v.options().find((o) => o.textContent?.startsWith('Google'))!;
      await v.click(google);
      expect(v.texts()).toEqual(['Back from Google', expect.stringContaining('Gemini 3 Pro')]);
      expect(v.host.textContent).not.toContain('Recent');
      // and out with the back row: the makers again, Google highlighted
      await v.click(v.options()[0]);
      expect(v.host.textContent).toContain('Recent');
      expect(v.highlighted()?.textContent).toStartWith('Google');
    } finally {
      await v.unmount();
    }
  });

  test('keys: arrows move, Enter opens a maker and picks a model, Left and Backspace on an empty search go back', async () => {
    const v = await mount({});
    try {
      // Recent GPT-5.5 first, then Sonnet, then Anthropic's row
      expect(v.highlighted()?.textContent).toContain('GPT-5.5');
      await v.key('ArrowDown');
      await v.key('ArrowDown');
      expect(v.highlighted()?.textContent).toStartWith('Anthropic');
      await v.key('Enter');
      expect(v.texts()[0]).toBe('Back from Anthropic');
      expect(v.highlighted()?.textContent).toContain('Opus 5.5');
      // Backspace on the empty search goes back, onto the maker it left
      await v.key('Backspace');
      expect(v.highlighted()?.textContent).toStartWith('Anthropic');
      // Right opens it too, Left goes back
      await v.key('ArrowRight');
      expect(v.texts()[0]).toBe('Back from Anthropic');
      await v.key('ArrowLeft');
      expect(v.texts()[0]).not.toBe('Back from Anthropic');
      expect(v.highlighted()?.textContent).toStartWith('Anthropic');
      // in again, down to Haiku, Enter picks it
      await v.key('Enter');
      await v.key('ArrowDown');
      await v.key('ArrowDown');
      expect(v.highlighted()?.textContent).toContain('Haiku 5.5');
      await v.key('Enter');
      expect(v.picks).toEqual(['anthropic/claude-haiku-5-5']);
    } finally {
      await v.unmount();
    }
  });

  test('a disabled model is passed over by the arrows, and the back row is one of the lines', async () => {
    const v = await mount({ value: 'zai/glm-5' });
    try {
      expect(v.highlighted()?.textContent).toContain('GLM-5');
      await v.key('ArrowUp');
      expect(v.highlighted()?.textContent).toContain('GLM-5.3');
      await v.key('ArrowUp');
      expect(v.highlighted()?.getAttribute('aria-label')).toBe('Back from Z.ai');
      await v.key('Enter');
      expect(v.host.textContent).toContain('Recent');
      expect(v.highlighted()?.textContent).toStartWith('Z.ai');
      // DeepSeek's key was refused: its one model is there, and cannot be picked
      await v.key('ArrowDown');
      await v.key('Enter');
      expect(v.texts()[0]).toBe('Back from DeepSeek');
      expect(v.options()[1].getAttribute('aria-disabled')).toBe('true');
      expect(v.highlighted()?.getAttribute('aria-label')).toBe('Back from DeepSeek');
    } finally {
      await v.unmount();
    }
  });

  test('the via button opens the routes; picking one stores its own ref, and the row then says which', async () => {
    const v = await mount({ value: 'cliproxy/claude-opus-5-5', models: HUB });
    try {
      expect(v.texts()[0]).toBe('Back from Anthropic');
      expect(v.texts().some((t) => /neu|cliproxy|OpenRouter/.test(t))).toBe(false);
      const via = v.host.querySelector('[aria-label="Choose a route"]')!;
      await v.click(via);
      expect(v.texts().slice(1, 5)).toEqual([expect.stringContaining('Opus 5.5'), 'Main accounts, the first route', 'via neu-claude', 'via OpenRouter']);
      await v.click(v.options().find((o) => o.getAttribute('aria-label') === 'via neu-claude')!);
      expect(v.picks).toEqual(['cliproxy/neu-claude/claude-opus-5-5']);
    } finally {
      await v.unmount();
    }
    // a saved ref on the plan's prefix checks the one row, and says the plan
    const w = await mount({ value: 'cliproxy/neu-claude/claude-opus-5-5', models: HUB });
    try {
      const checked = w.options().filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(checked.map((o) => o.textContent)).toEqual([expect.stringContaining('Opus 5.5via neu-claude')]);
      // Right opens the routes from the keys, Left closes them
      await w.key('ArrowRight');
      expect(w.texts()).toContain('via OpenRouter');
      await w.key('ArrowLeft');
      expect(w.texts()).not.toContain('via OpenRouter');
      expect(w.texts()[0]).toBe('Back from Anthropic');
    } finally {
      await w.unmount();
    }
  });

  test('Opus via the Antigravity plan stores that plan\'s own prefixed variant id', async () => {
    const { useHub } = await import('../src/store/store');
    const ag = 'cliproxy/backup-gemini/claude-opus-5-5-high';
    const models = HUB.map((g) => (g.provider === 'cliproxy' ? { ...g, models: [...g.models.filter((m) => m.id !== 'claude-opus-5-5-high'), plan('backup-gemini/claude-opus-5-5-high', 'Claude Opus 5.5 (High), backup-gemini')] } : g));
    useHub.setState({ accounts: { accounts: [{ prefix: 'backup-gemini', vendor: 'gemini', vendorName: 'Gemini', credential: 'antigravity-me@example.test.json' }] } as never });
    const v = await mount({ value: 'cliproxy/claude-opus-5-5', models });
    try {
      await v.click(v.host.querySelector('[aria-label="Choose a route"]')!);
      expect(v.texts()).toContain('via backup-gemini (Antigravity)');
      await v.click(v.options().find((o) => o.getAttribute('aria-label') === 'via backup-gemini (Antigravity)')!);
      expect(v.picks).toEqual([ag]);
    } finally {
      await v.unmount();
      useHub.setState({ accounts: undefined });
    }
  });

  test('typing searches every maker as one flat list; clearing it goes back to the makers', async () => {
    const v = await mount({ value: 'anthropic/claude-opus-5-5' });
    try {
      expect(v.texts()[0]).toBe('Back from Anthropic');
      // opened inside Anthropic, a search still finds the Coding agents' Opus: one list, no back row, no makers' rows
      await v.type('opus');
      const found = v.texts();
      expect(found.slice(0, 2).some((t) => t.includes('Claude Code, Opus'))).toBe(true);
      // the maker's name says where each one sits
      expect(found.slice(0, 2).find((t) => t.includes('Opus 5.5'))).toContain('Anthropic');
      expect(v.options().every((o) => !o.getAttribute('aria-label') && !o.textContent?.match(/^(Anthropic|OpenAI|Google|Z\.ai)\d/))).toBe(true);
      expect(v.host.querySelectorAll('.lucide-chevron-right').length).toBe(0);
      await v.type('glm');
      expect(v.texts().slice(0, 3).every((t) => t.includes('GLM') && t.includes('Z.ai'))).toBe(true);
      // Backspace in a search edits the search: no going back
      const before = v.texts().length;
      await v.key('Backspace');
      expect(v.texts().length).toBe(before);
      await v.type('');
      expect(v.host.textContent).toContain('Recent');
      expect(v.texts().some((t) => t.startsWith('Anthropic'))).toBe(true);
      // Enter on the first line picks the newest recent model
      await v.key('Enter');
      expect(v.picks).toEqual(['openai/gpt-5.5']);
    } finally {
      await v.unmount();
    }
  });
});
