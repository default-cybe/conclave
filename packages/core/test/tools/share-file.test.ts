/**
 * ShareFile (tools/share-file.ts) with a fake host: relative paths, the
 * meta.file card, the one line the model sees, and a refusal as an error.
 *
 *   bun test packages/core/test/tools/share-file.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkShareable, type ShareRoot } from '../../src/files/share';
import { LocalMachine } from '../../src/machine/local';
import { ShareFileTool } from '../../src/tools/share-file';
import { UNTRUSTED_DENY, builtinTools } from '../../src/tools';
import { fakeHost, makeCtx, makeSession, tempDir } from './helpers';

const t = tempDir('conclave-sharefile-');
const home = join(t.dir, 'home');
const cwd = join(t.dir, 'proj');
const out = join(home, 'outputs', 'sess_test');
mkdirSync(cwd, { recursive: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(cwd, 'notes.md'), '# hi');
writeFileSync(join(out, 'plot.png'), 'png!');
const m = new LocalMachine();
const roots: ShareRoot[] = [
  { device: 'local', dir: out, machine: m, outputs: true },
  { device: 'local', dir: cwd, machine: m },
];
const host = fakeHost({ shareCheck: (p) => checkShareable(p, roots, home), outputsDir: () => out });

afterAll(() => t.cleanup());

describe('ShareFile', () => {
  test('a relative path resolves against the session folder; meta.file is the card, the model gets one line', async () => {
    const ctx = makeCtx({ cwd, host });
    const r = await ShareFileTool.run({ path: 'notes.md', title: 'My notes' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.meta?.file).toEqual({ path: join(cwd, 'notes.md'), device: 'local', name: 'notes.md', mediaType: 'text/markdown', size: 4, title: 'My notes' });
    expect(r.content).toBe('Shared notes.md (4 B) with the owner as a file card.');
    expect(String(r.content)).not.toContain(cwd);
  });

  test('with no project folder a relative path resolves against the outputs folder', async () => {
    const ctx = { ...makeCtx({ cwd: '~', host }), session: makeSession('~', { kind: 'chat' }) };
    const r = await ShareFileTool.run({ path: 'plot.png' }, ctx);
    expect(r.meta?.file).toMatchObject({ path: join(out, 'plot.png'), mediaType: 'image/png' });
  });

  test('a refusal is an error with no card', async () => {
    const r = await ShareFileTool.run({ path: '../outside.txt' }, makeCtx({ cwd, host }));
    expect(r.isError).toBe(true);
    expect(r.meta?.file).toBeUndefined();
    expect(r.meta?.code).toBe('SHARE_REFUSED');
  });

  test('a built-in, and never for an untrusted agent', () => {
    expect(builtinTools().some((x) => x.name === 'ShareFile')).toBe(true);
    expect(UNTRUSTED_DENY).toContain('ShareFile');
  });
});
