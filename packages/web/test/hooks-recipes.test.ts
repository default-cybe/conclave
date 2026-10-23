/**
 * Hooks > Recipes helpers (src/features/extensions/hooks/recipe-words.ts) against
 * the shipped recipe data: the starter set the tab adds matches the hub's
 * RECIPE_STARTER, every recipe sits under a goal, and install records read as
 * words.
 *
 *   bun test packages/web/test/hooks-recipes.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { HOOK_RECIPES, RECIPE_STARTER } from '@conclave/core/extensions/hook-recipes';
import { GOALS, STARTER, eventsWords, handlerWords, inGoal, installWords } from '../src/features/extensions/hooks/recipe-words.ts';

describe('hook recipe helpers', () => {
  test('the starter set is the hub one', () => {
    expect(STARTER).toEqual(RECIPE_STARTER);
  });

  test('every recipe is under exactly one goal besides All', () => {
    for (const r of HOOK_RECIPES) {
      const goals = GOALS.filter((g) => g.value !== 'all' && inGoal(r, g.value)).map((g) => g.value);
      expect(goals.length).toBe(1);
    }
  });

  test('install records and handlers read as words', () => {
    expect(installWords({ scope: 'user', env: {}, installedAt: 0 })).toBe('this hub');
    expect(installWords({ scope: 'project', cwd: '/home/kai/code/app', env: {}, installedAt: 0 })).toBe('project ~/code/app');
    expect(installWords({ scope: 'codex', device: 'arch', env: {}, installedAt: 0 }, (id) => (id === 'arch' ? 'arch-desktop' : id))).toBe('Codex on arch-desktop');
    const gate = HOOK_RECIPES.find((r) => r.id === 'mcp-write-gate')!;
    expect(handlerWords(gate.handlers[0]).length).toBeLessThanOrEqual('PreToolUse '.length + 40);
    expect(eventsWords(HOOK_RECIPES.find((r) => r.id === 'git-work-saver')!.handlers)).toBe('PreToolUse Bash');
  });
});
