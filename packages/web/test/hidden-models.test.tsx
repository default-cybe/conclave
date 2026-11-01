/**
 * Settings > Models > Defaults, Hidden models (features/settings/defaults.tsx):
 * one ref or glob per line, saved as models.hidden.
 *
 *   cd packages/web && bun test test/hidden-models.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HiddenModels, hiddenList } from '../src/features/settings/defaults';

describe('Hidden models', () => {
  test('the field shows the saved list one per line', () => {
    const html = renderToStaticMarkup(<HiddenModels value={['cliproxy/glm-*', 'openai/gpt-4o']} />);
    expect(html).toContain('aria-label="Hidden models"');
    expect(html).toContain('cliproxy/glm-*\nopenai/gpt-4o');
    expect(html).toContain('placeholder="cliproxy/glm-*"');
    // nothing changed yet: no Save button
    expect(html).not.toContain('Save');
  });

  test('lines become the saved list: trimmed, blanks and repeats dropped', () => {
    expect(hiddenList(' cliproxy/glm-* \n\nzai/glm-4.5-air\ncliproxy/glm-*\n')).toEqual(['cliproxy/glm-*', 'zai/glm-4.5-air']);
    expect(hiddenList('')).toEqual([]);
  });
});
