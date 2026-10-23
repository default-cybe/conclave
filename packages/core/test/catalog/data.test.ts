/**
 * The shipped catalog data (recommended.ts) follows the rules in
 * docs/design/ECOSYSTEM.md 1.2 and 6: the checks of the research tool
 * spec-tools/check.ts, as tests.
 */
import { describe, expect, test } from 'bun:test';
import { CATALOG_FEEDS, GITHUB_TOPICS, KNOWN_MARKETPLACES, PINS, RECOMMENDED, type InstallSpec } from '../../src/catalog/recommended';
import { HOOK_RECIPES } from '../../src/extensions/hook-recipes';
import { ROUTINE_SUGGESTIONS } from '../../src/scheduler/suggestions';
import { secretsOutsideEnv, specPlaceholders } from '../../src/catalog/inspect';
import { recipeItem, suggestionItem } from '../../src/catalog/service';
import { installUnit } from '../../src/catalog/install';

const specsOf = (it: (typeof RECOMMENDED)[number]): InstallSpec[] => [it.install, ...(it.variants ?? [])];
// marketplaces named only in plugin sources of their own repo
const OWN_MARKETPLACES = ['karpathy-skills', 'context-mode', 'i-have-adhd', 'planning-with-files'];

describe('recommended catalog data', () => {
  test('ids are unique and prefixed by kind', () => {
    const ids = RECOMMENDED.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const it of RECOMMENDED) expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
  });

  test('ponytail and caveman are the only must-haves, and come first', () => {
    expect(RECOMMENDED.filter((i) => i.must).map((i) => i.id)).toEqual(['plugin:ponytail', 'plugin:caveman']);
    const ranked = RECOMMENDED.filter((i) => i.recommended).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    expect(ranked.slice(0, 2).map((i) => i.id)).toEqual(['plugin:ponytail', 'plugin:caveman']);
    for (const id of ['plugin:ponytail', 'plugin:caveman']) {
      const it = RECOMMENDED.find((i) => i.id === id)!;
      expect(it.install.type).toBe('plugin');
      expect(it.recommended).toBe(true);
    }
  });

  test('recommended ranks are unique and set', () => {
    const ranks = RECOMMENDED.filter((i) => i.recommended).map((i) => i.rank);
    expect(ranks.every((r) => typeof r === 'number')).toBe(true);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test('commits are full 40-character shas', () => {
    for (const [k, v] of Object.entries(PINS)) expect([k, /^[0-9a-f]{40}$/.test(v)]).toEqual([k, true]);
    for (const it of RECOMMENDED) {
      for (const s of specsOf(it)) {
        if (s.type === 'files') expect([it.id, /^[0-9a-f]{40}$/.test(s.sha)]).toEqual([it.id, true]);
        if (s.type === 'plugin' && s.sha) expect([it.id, /^[0-9a-f]{40}$/.test(s.sha)]).toEqual([it.id, true]);
      }
    }
  });

  test('every placeholder has an input and every input is used', () => {
    for (const it of RECOMMENDED) {
      const used = specPlaceholders(specsOf(it));
      const names = (it.inputs ?? []).map((i) => i.name);
      for (const p of used) expect([it.id, p, names.includes(p)]).toEqual([it.id, p, true]);
      for (const n of names) expect([it.id, n, used.includes(n)]).toEqual([it.id, n, true]);
      for (const i of it.inputs ?? []) if (i.secret) expect([it.id, i.name, !!i.secretKey]).toEqual([it.id, i.name, true]);
    }
  });

  test('no secret sits in command, args, url or cwd', () => {
    for (const it of RECOMMENDED) {
      const secrets = (it.inputs ?? []).filter((i) => i.secret).map((i) => i.name);
      for (const s of specsOf(it)) expect([it.id, secretsOutsideEnv(s, secrets)]).toEqual([it.id, []]);
    }
  });

  test('plugin sources name a known marketplace', () => {
    const known = new Set([...KNOWN_MARKETPLACES.map((k) => k.name), ...OWN_MARKETPLACES]);
    for (const it of RECOMMENDED) {
      for (const s of specsOf(it)) {
        if (s.type !== 'plugin') continue;
        for (const p of s.plugins) {
          const m = /^[^@/]+@(.+)$/.exec(p);
          if (m) expect([it.id, m[1], known.has(m[1])]).toEqual([it.id, m[1], true]);
          else expect([it.id, /^[\w.-]+\/[\w.-]+/.test(p)]).toEqual([it.id, true]);
        }
      }
    }
  });

  test('overlaps, recipes and suggestions resolve', () => {
    const ids = new Set([...RECOMMENDED.map((i) => i.id), ...HOOK_RECIPES.map((r) => `hook:${r.id}`)]);
    for (const it of RECOMMENDED) {
      for (const o of it.overlaps ?? []) expect([it.id, o, ids.has(o)]).toEqual([it.id, o, true]);
      for (const s of specsOf(it)) {
        if (s.type === 'hook') expect(HOOK_RECIPES.some((r) => r.id === s.recipe)).toBe(true);
        if (s.type === 'routine') expect(ROUTINE_SUGGESTIONS.some((r) => r.id === s.suggestion)).toBe(true);
      }
    }
  });

  test('files installs land under skills, agents or commands', () => {
    for (const it of RECOMMENDED) {
      for (const s of specsOf(it)) {
        if (s.type !== 'files') continue;
        for (const f of s.files) {
          expect(/^(skills|agents|commands)\/[^.]/.test(f.to)).toBe(true);
          expect(f.from.includes('..') || f.to.includes('..')).toBe(false);
        }
        // a file Conclave writes goes into a skill folder the same install fills
        const units = new Set(s.files.map((f) => installUnit(f.to)));
        for (const w of s.write ?? []) {
          expect([it.id, w.to, /^skills\/[^./][^/]*\/[^.]/.test(w.to) && !w.to.includes('..')]).toEqual([it.id, w.to, true]);
          expect([it.id, w.to, units.has(installUnit(w.to))]).toEqual([it.id, w.to, true]);
          expect(w.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('topics exist for every installable kind, and feeds are https', () => {
    for (const k of ['mcp', 'skill', 'plugin', 'subagent', 'command', 'hook'] as const) expect(GITHUB_TOPICS[k].length).toBeGreaterThan(0);
    for (const f of CATALOG_FEEDS) expect(f.url.startsWith('https://')).toBe(true);
  });

  test('recipes and suggestions map into catalog items', () => {
    const r = recipeItem(HOOK_RECIPES[0]);
    expect(r.id).toBe(`hook:${HOOK_RECIPES[0].id}`);
    expect(r.install).toEqual({ type: 'hook', recipe: HOOK_RECIPES[0].id });
    const s = suggestionItem(ROUTINE_SUGGESTIONS[0]);
    expect(s.kind).toBe('routine');
    expect(s.install).toEqual({ type: 'routine', suggestion: ROUTINE_SUGGESTIONS[0].id });
  });

  test('writing rules: no dashes and no banned words in catalog text', () => {
    const banned = /\b(seamless|robust|leverage|unlock|empower|delve|elevate|streamline)\w*/i;
    for (const it of RECOMMENDED) {
      const text = [it.description, it.fit, it.risk, ...(it.warnings ?? [])].filter(Boolean).join(' ');
      expect([it.id, /[\u2013\u2014]/.test(text), banned.test(text)]).toEqual([it.id, false, false]);
    }
  });
});
