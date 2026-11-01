/**
 * The overlay's answer rendering (src/overlay): streamed markdown written a
 * slice at a time equals one write of the whole (StreamText.tsx), model output
 * never becomes HTML or script and images become links, the "Say this" split
 * only grows while it streams (model.ts splitAnswer), the ```chart spec and its
 * SVG (chart.ts), Glass's 10 px stick-to-bottom test (fit.ts), and stepping
 * through earlier answers (model.ts shownIndex, stepAnswer).
 *
 *   bun test packages/web/test/overlay-render.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mdStream, safeHref } from '../src/overlay/StreamText';
import { chartSvg, parseChart } from '../src/overlay/chart';
import { atBottom } from '../src/overlay/fit';
import { shownIndex, splitAnswer, stepAnswer } from '../src/overlay/model';

let doc: Document;
beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  doc = req('linkedom').parseHTML('<!doctype html><html><body></body></html>').document;
});

/** Render `text` in chunks of `n` characters (Infinity: one write). */
function render(text: string, n: number, hooks = {}): string {
  const root = doc.createElement('div');
  const s = mdStream(root, hooks);
  for (let i = Math.min(n, text.length); ; i = Math.min(i + n, text.length)) {
    expect(s.write(text.slice(0, i))).toBe(true);
    if (i === text.length) break;
  }
  s.end();
  return root.innerHTML;
}

const ANSWER = `Say this:
- **CSV export** is merged behind a flag.
- PDF is next, *by Friday*, see [the PR](https://github.com/x/y/pull/1).

| Format | Status |
|---|---|
| CSV | merged |
| PDF | next |

\`\`\`ts
const a = 1 < 2;
\`\`\`

1. first
2. second
Source: commit 1cefd80`;

describe('streaming markdown', () => {
  test('a slice at a time equals one write', () => {
    const once = render(ANSWER, Infinity);
    for (const n of [1, 2, 3, 7, 16]) expect(render(ANSWER, n)).toBe(once);
    expect(once).toContain('<strong>CSV export</strong>');
    expect(once).toContain('<table>');
    expect(once).toContain('<th>');
    expect(once).toContain('const a = 1 &lt; 2;');
  });

  test('a write that is not a continuation is refused, so the caller starts over', () => {
    const s = mdStream(doc.createElement('div'), {});
    expect(s.write('hello')).toBe(true);
    expect(s.write('help')).toBe(false);
  });

  test('raw HTML stays text and links are checked', () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.example/p) <b>b</b>\n', 3);
    const root = doc.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('script, img, b, [onerror]')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([null, 'https://a.example/p']);
    expect(links[1]!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('images become links with their alt text', () => {
    const root = doc.createElement('div');
    root.innerHTML = render('![chart of sales](https://a.example/s.png) ![](javascript:x)\n', 4);
    expect(root.querySelector('img')).toBeNull();
    const a = [...root.querySelectorAll('a.ov-img')];
    expect(a.map((x) => [x.getAttribute('href'), x.textContent])).toEqual([
      ['https://a.example/s.png', 'chart of sales'],
      [null, 'image'],
    ]);
  });

  test('only http, https and mailto', () => {
    expect(safeHref('https://x.example')).toBe('https://x.example/');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative', 'file:///etc/passwd']) expect(safeHref(u)).toBeUndefined();
  });

  test('a closed fence calls the code hook once with its language', () => {
    const seen: string[] = [];
    render('```Py\nprint(1)\n```\nafter\n', 2, { onCode: (_b: HTMLElement, c: HTMLElement, lang: string) => seen.push(`${lang}:${c.textContent}`) });
    expect(seen).toEqual(['py:print(1)']);
  });
});

describe('say this split', () => {
  test('bullets first, the rest after, the source apart', () => {
    expect(splitAnswer(ANSWER, true)).toEqual({
      say: '- **CSV export** is merged behind a flag.\n- PDF is next, *by Friday*, see [the PR](https://github.com/x/y/pull/1).',
      rest: '| Format | Status |\n|---|---|\n| CSV | merged |\n| PDF | next |\n\n```ts\nconst a = 1 < 2;\n```\n\n1. first\n2. second',
      source: 'commit 1cefd80',
    });
    expect(splitAnswer('Say this:\n- One\n- Two and\nmore\nSource: x', true).say).toBe('- One\n- Two and more');
    expect(splitAnswer('I am not sure.', true)).toEqual({ say: '', rest: 'I am not sure.', source: undefined });
  });

  test('a "source:" line inside a code fence is code', () => {
    expect(splitAnswer('- a\n\n```yaml\nsource: x\n```\nSource: y', true)).toMatchObject({ rest: '```yaml\nsource: x\n```', source: 'y' });
  });

  test('while it streams, say and rest only grow', () => {
    for (let i = 1; i <= ANSWER.length; i++) {
      const a = splitAnswer(ANSWER.slice(0, i - 1));
      const b = i === ANSWER.length ? splitAnswer(ANSWER, true) : splitAnswer(ANSWER.slice(0, i));
      expect(b.say.startsWith(a.say)).toBe(true);
      expect(b.rest.startsWith(a.rest)).toBe(true);
      expect(a.say).not.toMatch(/Sou|Say/);
    }
  });

  test('the split, streamed token by token into the renderer, equals the finished answer rendered once', () => {
    const tokens = ANSWER.match(/\S+\s*|\s+/g)!;
    const parts = { say: doc.createElement('div'), rest: doc.createElement('div') };
    const s = { say: mdStream(parts.say, {}), rest: mdStream(parts.rest, {}) };
    let text = '';
    for (const t of tokens) {
      text += t;
      const a = splitAnswer(text);
      expect(s.say.write(a.say)).toBe(true);
      expect(s.rest.write(a.rest)).toBe(true);
    }
    const fin = splitAnswer(text, true);
    expect(s.say.write(fin.say) && s.rest.write(fin.rest)).toBe(true);
    s.say.end();
    s.rest.end();
    expect(parts.say.innerHTML).toBe(render(fin.say, Infinity));
    expect(parts.rest.innerHTML).toBe(render(fin.rest, Infinity));
  });
});

describe('chart fence', () => {
  const spec = { type: 'bar', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', values: [3, 5, 4] }] };

  test('parses a valid spec and refuses the rest', () => {
    expect(parseChart(JSON.stringify(spec))).toEqual(spec as never);
    for (const bad of ['not json', '{}', JSON.stringify({ ...spec, type: 'pie' }), JSON.stringify({ ...spec, series: [{ name: 'x', values: [1, 2] }] }), JSON.stringify({ ...spec, series: [{ name: 'x', values: [1, 'a', 3] }] }), JSON.stringify({ ...spec, labels: [] })])
      expect(parseChart(bad)).toBeUndefined();
  });

  test('draws bars or a line, with escaped labels', () => {
    const bar = chartSvg(parseChart(JSON.stringify({ ...spec, labels: ['<b>', 'Q2', 'Q3'] }))!);
    expect(bar.startsWith('<svg')).toBe(true);
    expect(bar.match(/<rect class="ov-s0"/g)?.length).toBe(3);
    expect(bar).not.toContain('<b>');
    expect(bar).toContain('&#60;b&#62;');
    const line = chartSvg(parseChart(JSON.stringify({ type: 'line', labels: ['a', 'b'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [-1, 0] }] }))!);
    expect(line.match(/<polyline/g)?.length).toBe(2);
    expect(line).toContain('>B</text>');
    expect(line).not.toContain('NaN');
  });
});

test('sticks to the bottom only within 10 px of it', () => {
  expect(atBottom(490, 100, 600)).toBe(true);
  expect(atBottom(500, 100, 600)).toBe(true);
  expect(atBottom(489, 100, 600)).toBe(false);
  expect(atBottom(0, 600, 600)).toBe(true);
});

test('answer history: n of m, stops at the ends, back at the newest follows new answers', () => {
  const a = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  expect(shownIndex(a)).toBe(2);
  let p = stepAnswer(a, undefined, -1);
  expect(p).toBe('b');
  p = stepAnswer(a, p, -1);
  expect(p).toBe('a');
  expect(stepAnswer(a, p, -1)).toBe('a');
  expect(shownIndex(a, p)).toBe(0);
  expect(stepAnswer(a, 'b', 1)).toBeUndefined();
  expect(stepAnswer(a, undefined, 1)).toBeUndefined();
  expect(shownIndex(a, 'gone')).toBe(2);
  expect(shownIndex([], undefined)).toBe(-1);
});
