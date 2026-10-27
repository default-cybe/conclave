/**
 * The style lint (scripts/check-styles.ts) on fixtures: every rule fires on
 * bad.tsx and styles.css, nothing fires on clean.tsx, and the allowlist
 * needs a reason and a match.
 *
 *   bun test scripts/check-styles.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RULES, run, type Allow } from './check-styles';

const root = join(import.meta.dir, '..');
const dir = 'scripts/check-styles-fixtures';
const at = (f: { file: string; line: number; rule: string }) => `${f.file.split('/').pop()}:${f.line} ${f.rule}`;

describe('check-styles', () => {
  test('flags each banned style on its line and nothing in clean code or comments', () => {
    const { files, left } = run(root, dir, []);
    expect(files).toBe(3);
    expect(left.map(at).sort()).toEqual(
      [
        'bad.tsx:2 pill',
        'bad.tsx:3 uppercase',
        'bad.tsx:4 gradient',
        'bad.tsx:5 glass',
        'bad.tsx:6 glow',
        'bad.tsx:7 spinner',
        'bad.tsx:8 glyph',
        'bad.tsx:9 hex',
        'bad.tsx:10 sparkline',
        'bad.tsx:11 gradient',
        'bad.tsx:11 hex',
        'bad.tsx:12 uppercase',
        'bad.tsx:13 glow',
        'styles.css:6 uppercase',
        'styles.css:9 gradient',
        'styles.css:12 hex',
      ].sort(),
    );
  });

  test('every rule has a fixture that trips it', () => {
    const hit = new Set(run(root, dir, []).left.map((f) => f.rule));
    expect(RULES.filter((r) => !hit.has(r.id)).map((r) => r.id)).toEqual([]);
  });

  test('an allowlist entry with a reason and a match clears only that line', () => {
    const allow: Allow[] = [{ file: `${dir}/bad.tsx`, rule: 'hex', match: "'#ff00aa'", reason: 'fixture' }];
    const { left, allowed, problems } = run(root, dir, allow);
    expect(allowed).toBe(1);
    expect(problems).toEqual([]);
    expect(left.map(at)).not.toContain('bad.tsx:9 hex');
    expect(left.map(at)).toContain('styles.css:12 hex');
  });

  test('entries without a reason or a match, with an unknown rule or matching nothing are reported', () => {
    const allow = [
      { file: `${dir}/bad.tsx`, rule: 'glass', match: 'backdrop-blur', reason: ' ' },
      { file: `${dir}/bad.tsx`, rule: 'shadow', match: 'x', reason: 'x' },
      { file: `${dir}/clean.tsx`, rule: 'pill', match: 'rounded-full', reason: 'gone' },
      { file: `${dir}/bad.tsx`, rule: 'spinner', reason: 'no match would clear the whole file' },
    ] as Allow[];
    const { left, problems } = run(root, dir, allow);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('needs a reason');
    expect(problems[1]).toContain('unknown rule');
    expect(problems[2]).toContain('matches nothing');
    expect(problems[3]).toContain('needs a match');
    expect(left.map(at)).toContain('bad.tsx:7 spinner');
  });

  test('the web app passes with the checked-in allowlist', async () => {
    const allow = (await Bun.file(join(import.meta.dir, 'check-styles.allow.json')).json()) as Allow[];
    const { left, problems } = run(root, 'packages/web/src', allow);
    expect(left).toEqual([]);
    expect(problems).toEqual([]);
  });
});
