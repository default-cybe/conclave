/**
 * The Canvas node search order (src/features/canvas/fixture.ts): a title
 * that starts with the term beats one whose later word does (graph audit 10).
 *
 *   bun test packages/web/test/canvas-search.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { searchLibrary } from '../src/features/canvas/fixture';

describe('canvas node search', () => {
  test('"fil" picks Filter before Read files', () => {
    expect(searchLibrary('program', 'fil').map((x) => x.title).slice(0, 2)).toEqual(['Filter', 'Read files']);
  });
  test('help text matches last, kind filters the library', () => {
    expect(searchLibrary('program', 'csv')[0].title).toBe('Write CSV');
    expect(searchLibrary('program', 'agent').some((x) => x.kind === 'agent')).toBe(false);
    expect(searchLibrary('workflow', 'agent')[0].title).toBe('Agent');
  });
  test('nothing typed lists by family', () => {
    expect(searchLibrary('workflow', '')[0].family).toBe('Inputs');
    expect(searchLibrary('workflow', '').at(-1)?.family).toBe('Flow');
  });
});
