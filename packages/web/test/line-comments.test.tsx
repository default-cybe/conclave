/**
 * Comments on diff lines (src/features/chat/lineComments.ts, Code.tsx Diff):
 * a comment keeps its place and the quoted lines, the batch is one message
 * with file:line, the quote and the comment, the list is kept per session in
 * localStorage, and a Diff with onComment draws its line numbers as buttons.
 *
 *   bun test packages/web/test/line-comments.test.tsx
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeDiff, parseDiff } from '../src/lib/text';
import { addComment, clearComments, commentOn, commentPlace, dropAllComments, editComment, formatComments, removeComment, removeComments, COMMENTS_PREFIX } from '../src/features/chat/lineComments';
import { Diff } from '../src/components/ui/Code';

const store = new Map<string, string>();
const g = globalThis as { localStorage?: unknown };
const before = g.localStorage;
afterAll(() => {
  g.localStorage = before;
});
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const file = parseDiff(makeDiff('a\nold\nc\n', 'a\nnew\nc\nd\n', 'src/x.ts'))[0];
const body = file.lines.filter((l) => l.type !== 'hunk' && l.type !== 'meta');

describe('a comment', () => {
  test('one added line: the new number and the line with its sign', () => {
    const add = body.find((l) => l.type === 'add' && l.text === 'new')!;
    const c = commentOn('src/x.ts', [add], '  rename  ');
    expect(c).toEqual({ path: 'src/x.ts', line: 2, quote: '+new', text: 'rename' });
    expect(commentPlace(c)).toBe('src/x.ts:2');
  });

  test('removed lines use the old numbers and say so', () => {
    const del = body.filter((l) => l.type === 'del');
    const c = commentOn('src/x.ts', del, 'why');
    expect(c.removed).toBe(true);
    expect(commentPlace(c)).toBe('src/x.ts:2 (removed)');
  });

  test('a range spans its first and last numbers and leaves hunk rows out', () => {
    const c = commentOn('src/x.ts', file.lines, 'all of it');
    expect(c.line).toBe(1);
    expect(c.endLine).toBe(4);
    expect(c.quote.split('\n')[0]).toBe(' a');
    expect(c.quote).not.toContain('@@');
  });

  test('a range from a removed line to an added one takes the new numbers only', () => {
    // old 49 removed, new 50-51 added: "49-51" would point at other code
    const lines = parseDiff('--- a/x.ts\n+++ b/x.ts\n@@ -49,1 +50,2 @@\n-gone\n+one\n+two\n')[0].lines;
    const c = commentOn('x.ts', lines, 'why');
    expect(commentPlace(c)).toBe('x.ts:50-51');
    expect(c.quote).toBe('-gone\n+one\n+two');
  });

  test('a workflow branch is named in the place', () => {
    const add = body.find((l) => l.type === 'add' && l.text === 'new')!;
    expect(commentPlace(commentOn('src/x.ts', [add], 'x', 'conclave/wf-1'))).toBe('src/x.ts:2 on branch conclave/wf-1');
  });
});

describe('the batch', () => {
  test('one message: place, the lines in a diff block, the comment', () => {
    const add = body.find((l) => l.type === 'add' && l.text === 'new')!;
    const msg = formatComments([
      { id: '1', ...commentOn('src/x.ts', [add], 'rename') },
      { id: '2', path: 'b.md', line: 9, quote: ' ```js', text: 'fence' },
    ]);
    expect(msg).toBe(['2 comments on the diff:', '', 'src/x.ts:2', '```diff', '+new', '```', 'rename', '', 'b.md:9', '````diff', ' ```js', '````', 'fence'].join('\n'));
  });
});

describe('kept per session', () => {
  beforeEach(() => {
    dropAllComments();
    store.clear();
  });

  test('add, edit, remove and clear write through to storage', () => {
    addComment('s1', { path: 'a.ts', line: 1, quote: '+x', text: 'one' });
    addComment('s1', { path: 'a.ts', line: 2, quote: '+y', text: 'two' });
    addComment('s2', { path: 'b.ts', line: 1, quote: '+z', text: 'other' });
    let saved = JSON.parse(store.get(`${COMMENTS_PREFIX}s1`)!);
    expect(saved.map((c: { text: string }) => c.text)).toEqual(['one', 'two']);
    editComment('s1', saved[0].id, 'first');
    removeComment('s1', saved[1].id);
    saved = JSON.parse(store.get(`${COMMENTS_PREFIX}s1`)!);
    expect(saved.map((c: { text: string }) => c.text)).toEqual(['first']);
    clearComments('s1');
    expect(store.has(`${COMMENTS_PREFIX}s1`)).toBe(false);
    expect(store.has(`${COMMENTS_PREFIX}s2`)).toBe(true);
  });

  test('a send removes only what it sent', () => {
    addComment('s1', { path: 'a.ts', line: 1, quote: '+x', text: 'sent' });
    const sent = JSON.parse(store.get(`${COMMENTS_PREFIX}s1`)!).map((c: { id: string }) => c.id);
    addComment('s1', { path: 'a.ts', line: 2, quote: '+y', text: 'added meanwhile' });
    removeComments('s1', sent);
    expect(JSON.parse(store.get(`${COMMENTS_PREFIX}s1`)!).map((c: { text: string }) => c.text)).toEqual(['added meanwhile']);
  });

  test("another tab's write is taken before this tab writes", () => {
    addComment('s1', { path: 'a.ts', line: 1, quote: '+x', text: 'here' });
    const theirs = [...JSON.parse(store.get(`${COMMENTS_PREFIX}s1`)!), { id: 'b', path: 'a.ts', line: 3, quote: '+z', text: 'there' }];
    store.set(`${COMMENTS_PREFIX}s1`, JSON.stringify(theirs));
    dispatchEvent(Object.assign(new Event('storage'), { key: `${COMMENTS_PREFIX}s1` }));
    addComment('s1', { path: 'a.ts', line: 4, quote: '+w', text: 'again' });
    expect(JSON.parse(store.get(`${COMMENTS_PREFIX}s1`)!).map((c: { text: string }) => c.text)).toEqual(['here', 'there', 'again']);
  });

  test('a sign out drops every session', () => {
    addComment('s1', { path: 'a.ts', line: 1, quote: '+x', text: 'one' });
    store.set('other', 'stays');
    dropAllComments();
    expect([...store.keys()]).toEqual(['other']);
  });
});

describe('Diff', () => {
  test('line numbers are buttons only with onComment', () => {
    const plain = renderToStaticMarkup(<Diff file={file} header={false} />);
    expect(plain).not.toContain('<button');
    const html = renderToStaticMarkup(<Diff file={file} header={false} onComment={() => {}} />);
    expect(html).toContain('aria-label="Comment on line 2"');
    expect(html).toContain('aria-pressed="false"');
  });
});
