import { describe, expect, test } from 'bun:test';
import { parseJsonc } from '../../src/config';

describe('parseJsonc', () => {
  test('drops comments and trailing commas but keeps a comma inside a string', () => {
    const text = `{
      // a rule with a bracket after a comma
      "allow": ["Bash(printf 'a, ]')", "Read", ],
      /* block */ "note": "x, }",
    }`;
    expect(parseJsonc(text)).toEqual({ allow: ["Bash(printf 'a, ]')", 'Read'], note: 'x, }' });
  });
});
