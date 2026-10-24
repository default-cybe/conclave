/**
 * Usage fallback in the web app (features/settings/usage-fallback.tsx):
 * where it lives in Settings, that "usage limit" finds it, and the up/down move.
 *
 *   cd packages/web && bun test test/usage-fallback.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { groupSections, searchSections } from '../src/features/settings/nav';
import { moveItem } from '../src/features/settings/usage-fallback';

describe('Usage fallback in Settings', () => {
  test('it sits under Models after Refusal fallback, and "usage limit" finds it', () => {
    const sections = [
      { id: 'refusal', label: 'Refusal fallback', desc: 'When a model refuses, the same messages go to the next model on your list.' },
      { id: 'usage', label: 'Usage fallback', desc: 'When a model is at its limit on every account, the next model here takes over, on its own account order.' },
    ];
    expect(groupSections(sections).find((g) => g.label === 'Models')!.items.map((s) => s.id)).toEqual(['refusal', 'usage']);
    expect(searchSections(sections, 'usage limit').map((s) => s.id)).toEqual(['usage']);
  });

  test('up and down move one step; off either end changes nothing', () => {
    const list = ['cliproxy/gemini-4-argon', 'cliproxy/claude-opus-5-5', 'zai/glm-5.3'];
    expect(moveItem(list, 1, 0)).toEqual(['cliproxy/claude-opus-5-5', 'cliproxy/gemini-4-argon', 'zai/glm-5.3']);
    expect(moveItem(list, 1, 2)).toEqual(['cliproxy/gemini-4-argon', 'zai/glm-5.3', 'cliproxy/claude-opus-5-5']);
    expect(moveItem(list, 0, -1)).toEqual(list);
    expect(moveItem(list, 2, 3)).toEqual(list);
  });
});
