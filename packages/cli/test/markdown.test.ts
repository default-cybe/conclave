import { describe, expect, test } from 'bun:test';
import { createPainter, stripAnsi } from '../src/ansi';
import { renderInline, renderMarkdown } from '../src/render/markdown';
import { highlightLine } from '../src/render/highlight';
import { wrapAnsi } from '../src/render/wrap';

const plain = createPainter({ enabled: false });
const color = createPainter({ enabled: true, truecolor: true });

const md = (s: string, width = 80) => renderMarkdown(s, { painter: plain, width });
const mdc = (s: string, width = 80) => renderMarkdown(s, { painter: color, width });

describe('inline', () => {
  test('bold, italic, strike, code are styled and markers removed', () => {
    const out = renderInline('a **bold** and *it* and _it2_ and ~~gone~~ and `x*y*z`', color);
    expect(out).toContain('\x1b[1mbold\x1b[22m');
    expect(out).toContain('\x1b[3mit\x1b[23m');
    expect(out).toContain('\x1b[3mit2\x1b[23m');
    expect(out).toContain('\x1b[9mgone\x1b[29m');
    // code span keeps its stars and is not italicized
    expect(stripAnsi(out)).toBe('a bold and it and it2 and gone and x*y*z');
    expect(out).not.toContain('\x1b[3my');
  });

  test('snake_case is not italic', () => {
    expect(renderInline('call my_func_name now', color)).toBe('call my_func_name now');
  });

  test('links show the url after the label', () => {
    expect(stripAnsi(renderInline('see [docs](https://x.dev/a) now', color))).toBe('see docs (https://x.dev/a) now');
    expect(stripAnsi(renderInline('<https://x.dev>', color))).toBe('https://x.dev');
    expect(renderInline('go to https://x.dev/path.', color)).toContain('\x1b[4m');
  });

  test('escaped markers stay literal', () => {
    expect(renderInline('2 \\* 3 \\* 4', plain)).toBe('2 * 3 * 4');
  });

  test('nested bold inside a link label', () => {
    expect(stripAnsi(renderInline('[**big** link](https://a.b)', color))).toBe('big link (https://a.b)');
  });
});

describe('blocks', () => {
  test('headings', () => {
    const out = mdc('# Title\n\n## Sub');
    expect(stripAnsi(out)).toBe('Title\n\nSub');
    expect(out).toContain('\x1b[1m');
    expect(out).toContain('\x1b[4m');
  });

  test('unordered and nested lists', () => {
    expect(md('- one\n- two\n  - inner\n- three')).toBe('• one\n• two\n  ◦ inner\n• three');
  });

  test('ordered and task lists', () => {
    expect(md('1. a\n2. b')).toBe('1. a\n2. b');
    expect(md('- [ ] todo\n- [x] done')).toBe('☐ todo\n☑ done');
  });

  test('loose list items stay together', () => {
    expect(md('1. first\n\n2. second')).toBe('1. first\n2. second');
  });

  test('paragraphs keep line breaks and wrap to width', () => {
    const out = md('one two three\nfour five six seven eight nine ten', 20);
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(20);
    expect(out.split('\n')[0]).toBe('one two three');
    expect(out.replace(/\n/g, ' ')).toBe('one two three four five six seven eight nine ten');
  });

  test('fenced code keeps lines, gets a background and highlighting', () => {
    const src = '```ts\nconst x = "hi"; // note\nreturn x;\n```';
    const out = mdc(src, 60);
    expect(out).toContain('\x1b[48;2;'); // background
    expect(out).toContain('const');
    const lines = stripAnsi(out).split('\n');
    expect(lines[0].trim()).toBe('ts');
    expect(lines[1]).toContain('const x = "hi"; // note');
    // every code line is padded to the same width
    expect(new Set(lines.slice(1).map((l) => l.length)).size).toBe(1);
  });

  test('plain mode indents code instead of coloring', () => {
    expect(md('```\nls -la\n```')).toBe('  ls -la');
  });

  test('unclosed fence (mid-stream) still renders as code', () => {
    const out = md('text\n\n```py\ndef f():\n    pass');
    expect(out).toBe('text\n\n  def f():\n      pass');
  });

  test('markdown inside code is not formatted', () => {
    expect(md('```\n**not bold** # nope\n```')).toBe('  **not bold** # nope');
  });

  test('tables are boxed and aligned', () => {
    const out = md('| a | b |\n|---|--:|\n| x | 10 |\n| yy | 2 |');
    // columns are at least 3 wide
    expect(out.split('\n')).toEqual(['┌─────┬─────┐', '│ a   │   b │', '├─────┼─────┤', '│ x   │  10 │', '│ yy  │   2 │', '└─────┴─────┘']);
  });

  test('tables too wide for the width become key: value rows', () => {
    const out = md('| name | description |\n|---|---|\n| x | ' + 'long '.repeat(20) + '|', 30);
    expect(out.startsWith('name: x')).toBe(true);
  });

  test('quotes get a bar', () => {
    expect(md('> quoted\n> more')).toBe('│ quoted\n│ more');
  });

  test('horizontal rule', () => {
    expect(md('a\n\n---\n\nb')).toBe('a\n\n' + '─'.repeat(48) + '\n\nb');
  });
});

describe('highlight', () => {
  test('keywords, strings, comments and numbers get colors', () => {
    const out = highlightLine('const n = 42; // answer', 'ts', color);
    expect(out).toContain('\x1b[38;2;86;156;214mconst'); // keyword blue
    expect(out).toContain('42');
    expect(out).toContain('\x1b[38;2;106;153;85m// answer'); // comment green
  });

  test('python comments use #', () => {
    expect(highlightLine('x = 1  # hi', 'python', color)).toContain('\x1b[38;2;106;153;85m# hi');
  });

  test('block comments continue across lines', () => {
    const st = {};
    highlightLine('/* start', 'js', color, st);
    expect(highlightLine('still comment */ code', 'js', color, st)).toContain('\x1b[38;2;106;153;85mstill comment */');
  });
});

describe('wrapAnsi', () => {
  test('styles do not start on the space before a word', () => {
    const out = wrapAnsi('a \x1b[4mlink\x1b[24m b', 80);
    expect(out).toBe('a \x1b[4mlink\x1b[24m b');
  });

  test('open styles are closed and reopened across wrapped lines', () => {
    const out = wrapAnsi('\x1b[1mone two three\x1b[22m', 8);
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0].endsWith('\x1b[0m')).toBe(true);
    expect(lines[1].startsWith('\x1b[1m')).toBe(true);
  });

  test('long words are broken', () => {
    expect(wrapAnsi('abcdefghij', 4)).toBe('abcd\nefgh\nij');
  });
});
