/**
 * Effort in the web app (lib/effort.ts, ChatComposer's EffortMenu, Home's
 * session start, the import offer card): the menu lists only the levels the
 * selected model has with its default marked, a stored level the next model
 * lacks becomes the nearest one it has, the session start keeps every level
 * and sends it clamped, and the words have no em or en dashes.
 *
 *   bun test packages/web/test/effort.test.tsx
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { claudeEffort, modelEffort } from '@conclave/core/providers/effort';
import type { ImportOffer } from '@conclave/core/client';
import { effortForModel, effortMenu, effortOf, shownEffort, type ModelEffort } from '../src/lib/effort';
import { EffortMenu, EffortSegments } from '../src/features/conversation/ChatComposer';
import { readPicks, savePicks, startEffort } from '../src/features/home/start';
import { readDefaults, saveDefaults } from '../src/features/conversation/state';
import { ImportOfferCard, importOfferHref } from '../src/features/import/OfferCard';

const opus55 = claudeEffort('claude-opus-5-5')!;
const opus46 = claudeEffort('claude-opus-4-6')!;
const sonnet55 = claudeEffort('claude-sonnet-5-5')!;
const gpt5 = modelEffort('gpt-5', true, 'openai')!;

const values = (e: ModelEffort) => effortMenu(e).map((o) => o.value);
const defaults = (e: ModelEffort) => effortMenu(e).filter((o) => o.hint === 'default').map((o) => o.value);

describe('the menu', () => {
  test("lists only the selected model's levels, with its default marked", () => {
    // Opus 5.5: five levels, no Off, medium by default
    expect(values(opus55)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(defaults(opus55)).toEqual(['medium']);
    // Opus 4.6: Off, and no xhigh
    expect(values(opus46)).toEqual(['off', 'low', 'medium', 'high', 'max']);
    expect(defaults(opus46)).toEqual(['high']);
    expect(values(sonnet55)).toContain('off');
    // OpenAI GPT-5: what reasoning effort takes
    expect(values(gpt5)).toEqual(['low', 'medium', 'high']);
    // a follow row first (the session start's Agent)
    expect(effortMenu(opus55, { value: 'agent', label: 'Agent' })[0]).toMatchObject({ value: 'agent', label: 'Agent' });
    // labels read plainly
    expect(effortMenu(opus55).map((o) => o.text)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  test('a stored level the model lacks shows, and moves, to the nearest one it has', () => {
    expect(shownEffort('xhigh', opus46)).toBe('high');
    expect(shownEffort('off', opus55)).toBe('low');
    expect(shownEffort(undefined, opus55)).toBe('medium');
    expect(shownEffort('max', gpt5)).toBe('high');
    // switching models in the composer
    expect(effortForModel('xhigh', opus46)).toBe('high');
    expect(effortForModel('max', opus55)).toBe('max');
    expect(effortForModel('high', undefined)).toBeUndefined();
  });

  test('the model list says what a model offers', () => {
    const groups = [{ models: [{ ref: 'anthropic/claude-opus-5-5', effort: opus55 }, { ref: 'claude-code/default', effort: { levels: [], off: false } }, { ref: 'openai/gpt-4.1' }] }];
    expect(effortOf(groups, 'anthropic/claude-opus-5-5')).toBe(opus55);
    // a harness that offered nothing, and a model without Effort: no control
    expect(effortOf(groups, 'claude-code/default')).toBeUndefined();
    expect(effortOf(groups, 'openai/gpt-4.1')).toBeUndefined();
  });

  test('the bar chip says Effort and the level; unset shows the default or the agent', () => {
    const chip = renderToStaticMarkup(<EffortMenu effort={opus55} value={undefined} onChange={() => {}} />);
    expect(chip).toContain('Effort');
    expect(chip).toContain('Medium');
    expect(chip).not.toContain('Thinking');
    const clamped = renderToStaticMarkup(<EffortMenu effort={opus46} value="xhigh" onChange={() => {}} />);
    expect(clamped).toContain('High');
    expect(clamped).not.toContain('Extra high');
    const agent = renderToStaticMarkup(<EffortMenu effort={opus55} value={undefined} follow={{ value: 'agent', label: 'Agent' }} onChange={() => {}} />);
    expect(agent).toContain('Agent');
    const phone = renderToStaticMarkup(<EffortSegments effort={opus46} value="off" onChange={() => {}} />);
    for (const w of ['Off', 'Low', 'Medium', 'High', 'Max']) expect(phone).toContain(`>${w}<`);
    expect(phone).not.toContain('Extra high');
    expect(chip + clamped + agent + phone).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('stored settings', () => {
  const g = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const before = g.localStorage;
  afterEach(() => {
    if (had) g.localStorage = before;
    else delete g.localStorage;
  });
  function fakeStorage() {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    return m;
  }

  test('session start picks keep every level, old ones too, and send what the model takes', () => {
    fakeStorage();
    savePicks({ thinking: 'max' });
    expect(readPicks().thinking).toBe('max');
    savePicks({ thinking: 'low' });
    expect(readPicks().thinking).toBe('low');
    // ultra is a ChatGPT plan's level: kept like the others; a level no model has is dropped
    savePicks({ thinking: 'ultra' });
    expect(readPicks().thinking).toBe('ultra');
    savePicks({ thinking: 'extreme' as never });
    expect(readPicks().thinking).toBeUndefined();
    expect(startEffort('xhigh', opus46)).toBe('high');
    expect(startEffort('off', opus55)).toBe('low');
    expect(startEffort(undefined, opus55)).toBeUndefined();
    // a harness that offers no levels: nothing is sent
    expect(startEffort('high', undefined)).toBeUndefined();
  });

  test("a new chat's switches keep the wider levels", () => {
    fakeStorage();
    saveDefaults({ thinking: 'xhigh' });
    expect(readDefaults().thinking).toBe('xhigh');
    saveDefaults({ thinking: 'off' });
    expect(readDefaults().thinking).toBe('off');
  });
});

describe('the import offer', () => {
  test('its sentence, Import to the sheet with the device picked, and Not now', () => {
    const offer: ImportOffer = { device: 'dev_1', deviceName: 'studio', chats: 12, sources: { 'claude-code': 9, codex: 3 }, text: 'Found 12 chats from Claude Code and Codex on studio. Import them?', createdAt: 1 };
    const html = renderToStaticMarkup(
      <Router ssrPath="/inbox">
        <ImportOfferCard offer={offer} />
      </Router>,
    );
    expect(html).toContain(offer.text);
    expect(html).toContain('Import');
    expect(html).toContain('Not now');
    expect(html).toContain('You see the cost first.');
    expect(importOfferHref('dev_1')).toBe('/sessions?import=dev_1');
  });
});
