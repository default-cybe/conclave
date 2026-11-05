/**
 * A file still being read when the box moves to another chat or session is
 * dropped, not attached to the next one's draft (ComposerParts.tsx
 * readPickedFor; a paste through the desktop app can take a while).
 *
 *   bun test packages/web/test/composer-switch-read.test.ts
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readPickedFor } from '../src/features/conversation/ComposerParts';

const g = globalThis as Record<string, unknown>;
const saved = g.FileReader;
let finish: () => void = () => {};

beforeAll(() => {
  // a FileReader that finishes when the test says so
  g.FileReader = class {
    result = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(f: File) {
      this.result = `data:${f.type};base64,aGk=`;
      finish = () => this.onload?.();
    }
  };
});
afterAll(() => {
  g.FileReader = saved;
});

const file = () => new File(['hi'], 'a.txt', { type: 'text/plain' });

test('a read that ends after a chat switch attaches nothing', async () => {
  const shown = { current: 's1' };
  const read = readPickedFor('s1', shown, [], [file()], 1024);
  shown.current = 's2';
  finish();
  expect(await read).toEqual([]);
});

test('a read that ends in the same chat attaches the file', async () => {
  const shown = { current: 's1' };
  const read = readPickedFor('s1', shown, [], [file()], 1024);
  finish();
  expect((await read).map((f) => f.name)).toEqual(['a.txt']);
});
