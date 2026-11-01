/**
 * Unified diffs as the approval card and tool rows draw them
 * (src/lib/text.ts parseDiff): a line whose text starts like a file
 * header is still a line while its hunk has room for it.
 *
 *   bun test packages/web/test/diff.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { makeDiff, parseDiff } from '../src/lib/text';

const rows = (diff: string) => parseDiff(diff)[0].lines.map((l) => `${l.type} ${l.text}`);

describe('lines that look like headers', () => {
  test('a removed SQL comment shows as removed', () => {
    const diff = makeDiff('-- keep the users table\nDROP TABLE users;', 'DROP TABLE users;', 'db/reset.sql');
    const f = parseDiff(diff)[0];
    expect(f.path).toBe('db/reset.sql');
    expect(f.removed).toBe(1);
    expect(rows(diff)).toContain('del -- keep the users table');
  });

  test('an added line starting with "++ " keeps the file and the line', () => {
    const diff = ['--- a/notes.md', '+++ b/notes.md', '@@ -1,1 +1,2 @@', ' one', '+++ two'].join('\n');
    const f = parseDiff(diff)[0];
    expect(f.path).toBe('notes.md');
    expect(f.added).toBe(1);
    expect(rows(diff)).toEqual(['hunk ', 'ctx one', 'add ++ two']);
  });

  test('the next file header after a full hunk is still a header', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' same',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -3 +3 @@',
      '-x',
      '+y',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(files.map((f) => [f.added, f.removed])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});
