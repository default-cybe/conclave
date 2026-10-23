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
import { buildPicker, groupNote, groupOf, makerRank, pickerItems, type Picker, type PickerInput } from '../src/components/pickers/ModelPicker';

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

  test('each model sits under its maker, whatever route reaches it; a merged copy shows once; an off harness is not offered', () => {
    const zai = p.groups.find((g) => g.key === 'zai')!;
    expect(zai.rows.map((r) => r.ref)).toEqual(['zai/glm-5', 'zai/glm-4.7', 'openrouter/z-ai/glm-5.3']);
    expect(zai.rows[2].model?.via).toBe('OpenRouter');
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

async function mount(props: { value?: string; values?: string[] }) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { useHub } = await import('../src/store/store');
  const { ModelList } = await import('../src/components/pickers/ModelPicker');
  useHub.setState({ models: MODELS, sessions: SESSIONS, devices: {}, limits: {} });
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
