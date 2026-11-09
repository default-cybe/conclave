/**
 * A file still uploading when the box moves to another chat or session is
 * dropped, not attached to the next one's draft (ComposerParts.tsx
 * readPickedFor; a big file or a paste through the desktop app can take a
 * while). Each file is uploaded on its own and comes back as an upload id.
 *
 *   bun test packages/web/test/composer-switch-read.test.ts
 */
import { beforeAll, expect, test } from 'bun:test';
import { api, connectClient } from '../src/lib/api';
import { readPickedFor } from '../src/features/conversation/ComposerParts';

let finish: () => void = () => {};
let finished = false;
const names: string[] = [];

beforeAll(async () => {
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  Object.assign(api(), {
    upload: (_f: Blob, name: string, type?: string) =>
      new Promise((resolve) => {
        names.push(name);
        const done = () => resolve({ id: `up_${String(names.length).padStart(24, '0')}`, name, mediaType: type ?? '', size: 2 });
        if (finished) done();
        else finish = done;
      }),
  });
});
const finishNow = () => {
  finished = true;
  finish();
};

const file = (name = 'a.txt', type = 'text/plain') => new File(['hi'], name, { type });

test('an upload that ends after a chat switch attaches nothing', async () => {
  const shown = { current: 's1' };
  const read = readPickedFor('s1', shown, [file()]);
  shown.current = 's2';
  await Bun.sleep(0);
  finishNow();
  expect(await read).toEqual([]);
});

test('an upload that ends in the same chat attaches the file by its id', async () => {
  const shown = { current: 's1' };
  const out = await readPickedFor('s1', shown, [file()]);
  expect(out.map((f) => [f.name, f.uploadId, f.mediaType])).toEqual([['a.txt', 'up_000000000000000000000002', 'text/plain;charset=utf-8']]);
  expect('data' in out[0]).toBe(false);
});

test('any type and any number: 40 files, an APK and an .exe among them, each uploaded on its own', async () => {
  names.length = 0;
  const files = [file('app.apk', 'application/vnd.android.package-archive'), file('setup.exe', 'application/x-msdownload'), ...Array.from({ length: 38 }, (_, i) => file(`f${i}.bin`, ''))];
  const out = await readPickedFor('s1', { current: 's1' }, files);
  expect(out.length).toBe(40);
  expect(names.length).toBe(40);
  expect(out[0].mediaType).toBe('application/vnd.android.package-archive');
});
