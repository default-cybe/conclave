import { describe, expect, test } from 'bun:test';
import { createPainter, stripAnsi } from '../src/ansi';
import { colorDiff, diffStats, simpleDiff } from '../src/render/diff';
import { toolPreview, toolTitle } from '../src/render/tools';

const color = createPainter({ enabled: true, truecolor: true });
const plain = createPainter({ enabled: false });

const DIFF = ['diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' keep', '-old line', '+new line', ' tail'].join('\n');

describe('colorDiff', () => {
  test('+ green, - red, @@ cyan, context dim, headers dropped', () => {
    const out = colorDiff(DIFF, { painter: color });
    const lines = out.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('\x1b[36m@@ -1,3 +1,3 @@\x1b[39m');
    expect(lines[1]).toBe('\x1b[2m keep\x1b[22m');
    expect(lines[2]).toBe('\x1b[31m-old line\x1b[39m');
    expect(lines[3]).toBe('\x1b[32m+new line\x1b[39m');
  });

  test('headers can be kept', () => {
    expect(stripAnsi(colorDiff(DIFF, { painter: color, headers: true })).split('\n')[2]).toBe('--- a/x.ts');
  });

  test('collapses to maxLines with a count of the rest', () => {
    const big = ['@@ -1,30 +1,30 @@', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join('\n');
    const out = colorDiff(big, { painter: plain, maxLines: 20 }).split('\n');
    expect(out.length).toBe(21);
    expect(out[20]).toBe('… +11 lines');
  });

  test('default limit is 20 lines', () => {
    const big = Array.from({ length: 25 }, (_, i) => `-x${i}`).join('\n');
    expect(colorDiff(big, { painter: plain }).split('\n').at(-1)).toBe('… +5 lines');
  });

  test('stats ignore file headers', () => {
    expect(diffStats(DIFF)).toEqual({ added: 1, removed: 1 });
  });

  test('a removed "-- note" line inside a hunk is a change, not a header', () => {
    const sql = ['--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,1 @@', '--- keep the users table', ' select 1;'].join('\n');
    expect(diffStats(sql)).toEqual({ added: 0, removed: 1 });
    expect(colorDiff(sql, { painter: plain }).split('\n')).toEqual(['@@ -1,2 +1,1 @@', '--- keep the users table', ' select 1;']);
    // the Edit approval preview has no hunks, so nothing in it is a header
    expect(colorDiff(simpleDiff('-- note\nx', 'x'), { painter: plain })).toBe('--- note\n x');
  });
});

describe('simpleDiff', () => {
  test('shows changed lines with one line of context', () => {
    expect(simpleDiff('a\nb\nc\nd', 'a\nB\nc\nd')).toBe(' a\n-b\n+B\n c');
  });
  test('pure insertion', () => {
    expect(simpleDiff('', 'new')).toBe('-\n+new');
  });
});

describe('tool lines', () => {
  test('titles are short and relative to cwd', () => {
    expect(toolTitle('Read', { file_path: '/p/src/app.ts' }, '/p')).toEqual({ name: 'Read', detail: 'src/app.ts' });
    expect(toolTitle('Bash', { command: 'npm test\nnpm run lint' })).toEqual({ name: 'Bash', detail: 'npm test …' });
    expect(toolTitle('Grep', { pattern: 'TODO', path: '/p/src' }, '/p')).toEqual({ name: 'Grep', detail: '"TODO" in src' });
    expect(toolTitle('mcp__github__create_issue', { title: 'Bug' })).toEqual({ name: 'github · create_issue', detail: 'Bug' });
  });

  test('Edit preview is a colored diff summary', () => {
    const lines = toolPreview('Edit', { type: 'tool_result', toolUseId: 't', content: 'ok', meta: { diff: DIFF } }, { painter: color, width: 80 });
    expect(stripAnsi(lines[0])).toBe('+1 -1');
    expect(lines).toContain('\x1b[32m+new line\x1b[39m');
  });

  test('Bash preview shows first lines and counts the rest', () => {
    const content = Array.from({ length: 10 }, (_, i) => `out ${i}`).join('\n');
    const lines = toolPreview('Bash', { type: 'tool_result', toolUseId: 't', content }, { painter: plain, width: 80 });
    expect(lines).toEqual(['out 0', 'out 1', 'out 2', '… +7 lines']);
  });

  test('Grep preview counts', () => {
    expect(toolPreview('Grep', { type: 'tool_result', toolUseId: 't', content: 'Found 4 files\na\nb\nc\nd' }, { painter: plain, width: 80 })).toEqual(['Found 4 files']);
    expect(toolPreview('Grep', { type: 'tool_result', toolUseId: 't', content: 'a:1:x\nb:2:y', meta: { total: 2 } }, { painter: plain, width: 80 })).toEqual(['Found 2 lines']);
  });

  test('errors are red', () => {
    const lines = toolPreview('Bash', { type: 'tool_result', toolUseId: 't', content: 'boom', isError: true }, { painter: color, width: 80 });
    expect(lines[0]).toBe('\x1b[31mboom\x1b[39m');
  });
});
