/** Settings > Providers > Custom provider: the id it is saved under and the form check before Find models. */
import { describe, expect, test } from 'bun:test';
import { customProviderId, customProviderProblem } from '../src/lib/providers';

describe('customProviderId', () => {
  test('lowercase a-z0-9 and dashes from the name', () => {
    expect(customProviderId('Experiential Labs', [])).toBe('experiential-labs');
    expect(customProviderId('  My_API (v2)!  ', [])).toBe('my-api-v2');
    expect(customProviderId('!!!', [])).toBe('custom');
  });

  test('never a taken id, a built-in, a harness or cliproxy', () => {
    expect(customProviderId('Experiential Labs', ['experiential-labs'])).toBe('experiential-labs-2');
    expect(customProviderId('Experiential Labs', ['experiential-labs', 'experiential-labs-2'])).toBe('experiential-labs-3');
    expect(customProviderId('OpenAI', [])).toBe('openai-2');
    expect(customProviderId('Codex', [])).toBe('codex-2');
    expect(customProviderId('CLIProxy', [])).toBe('cliproxy-2');
  });

  test('stays short', () => {
    expect(customProviderId('a'.repeat(80), []).length).toBeLessThanOrEqual(40);
  });
});

describe('customProviderProblem', () => {
  test('needs a name and an http(s) base URL', () => {
    expect(customProviderProblem({ name: '', baseUrl: 'https://api.experientiallabs.ai/v1' })).toBe('Give it a name.');
    expect(customProviderProblem({ name: 'X', baseUrl: 'api.example.com' })).toContain('Enter the base URL');
    expect(customProviderProblem({ name: 'X', baseUrl: 'file:///etc/passwd' })).toContain('http://');
    expect(customProviderProblem({ name: 'X', baseUrl: 'https://api.experientiallabs.ai/v1' })).toBeUndefined();
  });
});
