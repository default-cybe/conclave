/**
 * Discover QA checks: the saved-list fallback when live search fails, README
 * cleanup before it is rendered, and the hook starter set staying in step
 * with the hub's list.
 *
 *   bun test packages/web/test/discover-qa.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { RECOMMENDED } from '@conclave/core/catalog/recommended';
import { HOOK_RECIPES, RECIPE_STARTER } from '@conclave/core/extensions/hook-recipes';
import { cleanReadme, loadedCounts, localMatches } from '../src/features/extensions/discover/words';
import { STARTER } from '../src/features/extensions/hooks/recipe-words';

describe('saved-list matches when live search fails', () => {
  test('every word must match name, description, repo, category or tags', () => {
    const hits = localMatches(RECOMMENDED, 'ghidra');
    expect(hits.map((x) => x.id)).toContain('mcp:ghidra');
    expect(localMatches(RECOMMENDED, 'GHIDRA mcp').every((x) => /ghidra/i.test(JSON.stringify(x)))).toBe(true);
    expect(localMatches(RECOMMENDED, 'ponytail').map((x) => x.id)).toContain('plugin:ponytail');
    expect(localMatches(RECOMMENDED, 'zzqqxx')).toEqual([]);
    expect(localMatches(RECOMMENDED, '   ')).toEqual([]);
  });
  test('the kind filter applies', () => {
    const plugins = localMatches(RECOMMENDED, 'caveman', 'plugin');
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins.every((x) => x.kind === 'plugin')).toBe(true);
    expect(localMatches(RECOMMENDED, 'ponytail', 'mcp')).toEqual([]);
  });
});

describe('README cleanup', () => {
  test('drops inline and reference images and the links that wrapped them', () => {
    const md = '# pyghidra-lite\n\n[![PyPI][pypi-badge]][pypi]\n[![CI](https://img.shields.io/x.svg)](https://ci)\n![shot](https://t.example/p.gif)\n\nText [docs](https://example.com).\n\n[pypi-badge]: https://img.shields.io/pypi/v/x\n[pypi]: https://pypi.org/project/x';
    const out = cleanReadme(md);
    expect(out).not.toContain('![');
    expect(out).not.toContain('[]');
    expect(out).not.toContain('t.example');
    expect(out).toContain('Text [docs](https://example.com).');
    expect(out.startsWith('# pyghidra-lite')).toBe(true);
  });
  test('drops raw HTML tags and comments, keeps the text', () => {
    const out = cleanReadme('<p align="center"><img src="https://x/logo.png"></p>\n<!-- hidden -->\n<h1>Title</h1>\n\n\n\nBody');
    expect(out).toBe('Title\n\nBody');
  });
});

describe('hook starter set', () => {
  test('matches RECIPE_STARTER and names shipped recipes', () => {
    expect(STARTER).toEqual(RECIPE_STARTER);
    for (const id of STARTER) expect(HOOK_RECIPES.some((r) => r.id === id)).toBe(true);
  });
});

describe('what an install loads', () => {
  // paths from a real caveman preview at 81958ad: it also carries a nested plugin copy and OpenCode commands
  const P = '~/.conclave/plugins/caveman/';
  const caveman = [
    'skills/caveman/SKILL.md',
    'skills/caveman-compress/SKILL.md',
    'skills/verify-and-stop/SKILL.md',
    'skills/caveman/README.md',
    'plugins/caveman/skills/caveman/SKILL.md',
    'agents/cavecrew-builder.md',
    'plugins/caveman/agents/cavecrew-builder.md',
    'commands/caveman-init.md',
    'src/plugins/opencode/commands/caveman.md',
  ].map((x) => P + x);
  test('counts only the root skills, agents and commands of the plugin', () => {
    expect(loadedCounts(caveman)).toEqual({ skills: 3, agents: 1, commands: 1 });
  });
  test('works for files copied straight into ~/.conclave', () => {
    expect(loadedCounts(['~/.conclave/skills/ctf-web/SKILL.md', '~/.conclave/skills/ctf-web/ref/x.md', '~/.conclave/agents/re.md', '~/.conclave/commands/ns/run.md'])).toEqual({ skills: 1, agents: 1, commands: 1 });
  });
});
