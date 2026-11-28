/**
 * The "Use the template's prompt" line on a routine page shows only when the
 * routine's prompt is not its template's current one (same trim as the hub).
 *
 *   bun test packages/web/test/routine-template-line.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { differsFromTemplate } from '../src/features/routines/RoutineDetail';

describe('differsFromTemplate', () => {
  test('no template: never differs', () => {
    expect(differsFromTemplate({ prompt: 'x' }, undefined)).toBe(false);
  });
  test('same text up to line endings and outer space: no line', () => {
    expect(differsFromTemplate({ prompt: 'a\r\nb\n' }, { prompt: '  a\nb' })).toBe(false);
  });
  test('an edited prompt: the line shows', () => {
    expect(differsFromTemplate({ prompt: 'a\nb, my edit' }, { prompt: 'a\nb' })).toBe(true);
  });
});
