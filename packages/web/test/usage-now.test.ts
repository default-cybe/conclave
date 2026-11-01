/**
 * The fallback sentence under Usage > Now (lib/accounts.ts limitFallbackRoute)
 * says what core session/limits.ts limitFallback does for the owner.
 */
import { describe, expect, test } from 'bun:test';
import { limitFallbackRoute } from '../src/lib/accounts';

describe('where a model at its limit on every account goes', () => {
  test('the usage fallback list when it is on and has models', () => {
    expect(limitFallbackRoute({ limitFallback: { enabled: true, models: ['cliproxy/claude-opus-5-5', 'zai/glm-5.3'] } })).toEqual({ kind: 'usage', models: ['cliproxy/claude-opus-5-5', 'zai/glm-5.3'] });
  });

  test('the refusal fallback entries when the usage list is off or empty, even with refusal fallback off', () => {
    const refusalFallback = { enabled: false, entries: [{ model: 'zai/glm-5.3' }] };
    expect(limitFallbackRoute({ limitFallback: { enabled: false, models: ['zai/glm-5.3'] }, refusalFallback })).toEqual({ kind: 'refusal' });
    expect(limitFallbackRoute({ limitFallback: { enabled: true, models: [] }, refusalFallback })).toEqual({ kind: 'refusal' });
  });

  test('none when neither list has a model', () => {
    expect(limitFallbackRoute(undefined)).toEqual({ kind: 'none' });
    expect(limitFallbackRoute({ refusalFallback: { enabled: true, entries: [] } })).toEqual({ kind: 'none' });
    expect(limitFallbackRoute({ limitFallback: { enabled: true, models: ['no-provider'] } })).toEqual({ kind: 'none' });
  });
});
