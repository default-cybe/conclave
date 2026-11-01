/**
 * A plan's short name (accounts/prefix.ts): the check the hub and the web
 * app share, and the names the page offers.
 *
 *   bun test packages/core/test/accounts/prefix.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { prefixProblem, slugPrefix, suggestPrefixes } from '../../src/accounts/prefix';

describe('the check', () => {
  test('1 to 24 lowercase letters, digits and dashes; empty removes it', () => {
    for (const ok of ['neu', 'personal', 'work-2', 'a', '0', 'a'.repeat(24), '']) expect([ok, prefixProblem(ok)]).toEqual([ok, undefined]);
    for (const bad of ['Neu', 'neu/x', 'two words', 'kai_neu', 'ü', ' neu', 'a'.repeat(25)]) expect([bad, prefixProblem(bad)?.reason]).toEqual([bad, 'format']);
    expect(prefixProblem('NEU')?.message).toBe('Use 1 to 24 lowercase letters, digits and dashes.');
  });

  test("each plan's is its own", () => {
    expect(prefixProblem('neu', ['personal', 'neu'])).toEqual({ reason: 'taken', message: 'Another plan already has the short name neu.' });
    // a name another tool wrote in capitals is the same name
    expect(prefixProblem('neu', ['NEU'])?.reason).toBe('taken');
    expect(prefixProblem('neu', ['personal'])).toBeUndefined();
    expect(prefixProblem('', ['neu'])).toBeUndefined();
  });
});

describe('suggestions', () => {
  test('slugs: lowercase, accents dropped, runs of anything else one dash, 24 at most', () => {
    expect(slugPrefix('Kai Müller')).toBe('kai-muller');
    expect(slugPrefix('  --Work_Plan!! ')).toBe('work-plan');
    expect(slugPrefix('a'.repeat(23) + '-bc')).toBe('a'.repeat(23));
    expect(slugPrefix(undefined)).toBe('');
  });

  test('the part before @, the name the owner gave the plan, else its label', () => {
    const s = suggestPrefixes([
      { id: 'a', label: 'jane.doe@example.com', email: 'jane.doe@example.com' },
      { id: 'b', label: 'personal', email: 'kai@kaivalya.dev' },
      { id: 'c', label: 'Claude 3' },
    ]);
    expect([...s]).toEqual([
      ['a', 'jane-doe'],
      ['b', 'personal'],
      ['c', 'claude-3'],
    ]);
  });

  test('two plans with one name before @ get their domains; a name still taken gets a number', () => {
    const s = suggestPrefixes(
      [
        { id: 'neu', label: 'kai@neu.edu', email: 'kai@neu.edu' },
        { id: 'own', label: 'kai@kaivalya.dev', email: 'kai@kaivalya.dev' },
      ],
      [],
    );
    expect([...s.values()]).toEqual(['neu', 'kaivalya']);
    expect([...suggestPrefixes([{ id: 'x', label: 'kai@neu.edu', email: 'kai@neu.edu' }], ['kai', 'neu']).values()]).toEqual(['kai-2']);
    // every suggestion passes the check
    for (const v of s.values()) expect(prefixProblem(v)).toBeUndefined();
  });
});
