/**
 * What ShareFile may hand the owner (files/share.ts): files in a session's
 * folder, its outputs folder and a child session's folder; never a symlink
 * out, the hub's private files, anything else under the hub home, a
 * directory, a FIFO, a file over 30 MB or another session's outputs.
 *
 *   bun test packages/core/test/files
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine } from '../../src/machine/local';
import { markHubHome } from '../../src/machine/private';
import { checkShareable, mediaTypeOf, outputsDir, usesOutputs, SHARE_MAX_BYTES, type ShareRoot } from '../../src/files/share';

const base = mkdtempSync(join(tmpdir(), 'conclave-share-'));
const home = join(base, 'hub-home');
const cwd = join(base, 'project');
const childCwd = join(base, 'child');
mkdirSync(join(home, 'cliproxy'), { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(childCwd, { recursive: true });
markHubHome(home);
writeFileSync(join(home, 'secrets.json'), '{"k":"secret"}');
writeFileSync(join(home, 'config.json'), '{}');
writeFileSync(join(home, 'cliproxy', 'config.yaml'), 'key: x');
const out = outputsDir(home, 'ses_a');
const other = outputsDir(home, 'ses_b');
mkdirSync(out, { recursive: true });
mkdirSync(other, { recursive: true });

const m = new LocalMachine();
const roots: ShareRoot[] = [
  { device: 'local', dir: out, machine: m, outputs: true },
  { device: 'local', dir: cwd, machine: m },
  { device: 'local', dir: childCwd, machine: m },
];
const check = (p: string, r = roots) => checkShareable(p, r, home);

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('allowed', () => {
  test('a file in the session folder, with its type and size', async () => {
    writeFileSync(join(cwd, 'report.pdf'), '%PDF-1.4 hello');
    const r = await check(join(cwd, 'report.pdf'));
    expect(r).toMatchObject({ ok: true, file: { device: 'local', name: 'report.pdf', mediaType: 'application/pdf', size: 14 } });
  });

  test('a file in the outputs folder, under the hub home', async () => {
    writeFileSync(join(out, 'chart.png'), 'png');
    expect(await check(join(out, 'chart.png'))).toMatchObject({ ok: true, ident: { dev: expect.any(Number), ino: expect.any(Number) } });
  });

  test("a file in a child session's folder", async () => {
    writeFileSync(join(childCwd, 'data.csv'), 'a,b');
    expect(await check(join(childCwd, 'data.csv'))).toMatchObject({ ok: true, file: { mediaType: 'text/csv' } });
  });
});

describe('refused', () => {
  test('../ out of the folder', async () => {
    writeFileSync(join(base, 'outside.txt'), 'x');
    expect(await check(join(cwd, '..', 'outside.txt'))).toMatchObject({ ok: false, code: 'refused' });
    expect(await check('report.pdf')).toMatchObject({ ok: false, code: 'refused' });
  });

  test('a symlink in the folder pointing at the secrets file', async () => {
    symlinkSync(join(home, 'secrets.json'), join(cwd, 'innocent.txt'));
    expect(await check(join(cwd, 'innocent.txt'))).toMatchObject({ ok: false, code: 'refused' });
    symlinkSync(join(base, 'outside.txt'), join(out, 'link.txt'));
    expect(await check(join(out, 'link.txt'))).toMatchObject({ ok: false, code: 'refused' });
  });

  test('the hub home itself: secrets.json, config.json, cliproxy', async () => {
    const wide: ShareRoot[] = [...roots, { device: 'local', dir: base, machine: m }];
    for (const p of [join(home, 'secrets.json'), join(home, 'config.json'), join(home, 'cliproxy', 'config.yaml')]) {
      expect(await check(p, wide)).toMatchObject({ ok: false, code: 'refused' });
    }
  });

  test("another session's outputs folder", async () => {
    writeFileSync(join(other, 'theirs.txt'), 'x');
    const wide: ShareRoot[] = [...roots, { device: 'local', dir: base, machine: m }];
    expect(await check(join(other, 'theirs.txt'), wide)).toMatchObject({ ok: false, code: 'refused' });
  });

  test('a directory and a FIFO', async () => {
    mkdirSync(join(cwd, 'sub'));
    expect(await check(join(cwd, 'sub'))).toMatchObject({ ok: false, code: 'refused' });
    const fifo = join(cwd, 'pipe');
    if (Bun.spawnSync(['mkfifo', fifo]).exitCode === 0) expect(await check(fifo)).toMatchObject({ ok: false, code: 'refused' });
  });

  test('a file over 30 MB', async () => {
    const big = join(cwd, 'big.zip');
    const fd = openSync(big, 'w');
    ftruncateSync(fd, 31 * 1024 * 1024);
    closeSync(fd);
    expect(await check(big)).toMatchObject({ ok: false, code: 'too_big' });
    expect(31 * 1024 * 1024).toBeGreaterThan(SHARE_MAX_BYTES);
  });

  test('a file that is not there', async () => {
    expect(await check(join(cwd, 'nope.pdf'))).toMatchObject({ ok: false, code: 'missing' });
  });

  test("the hub user's home: a root of ~/, the home, /home, / or a folder above the home never serves ~/.ssh", async () => {
    const user = join(base, 'user');
    mkdirSync(join(user, '.ssh'), { recursive: true });
    mkdirSync(join(user, 'proj'), { recursive: true });
    writeFileSync(join(user, '.ssh', 'id_ed25519'), 'KEY');
    writeFileSync(join(user, 'proj', 'ok.txt'), 'x');
    const key = join(user, '.ssh', 'id_ed25519');
    for (const dir of ['~/', '~', user, `${user}/`, '/home', '/', base]) {
      const r = await checkShareable(key, [{ device: 'local', dir, machine: m }], home, user);
      expect([dir, r.ok]).toEqual([dir, false]);
    }
    expect((await checkShareable(join(user, 'proj', 'ok.txt'), [{ device: 'local', dir: '~/proj', machine: m }], home, user)).ok).toBe(true);
    expect((await checkShareable(join(user, 'proj', 'ok.txt'), [{ device: 'local', dir: '~/', machine: m }], home, user)).ok).toBe(false);
  });

  test('a hard link in the outputs folder to the hub config', async () => {
    linkSync(join(home, 'config.json'), join(out, 'harmless.json'));
    expect(await check(join(out, 'harmless.json'))).toMatchObject({ ok: false, code: 'refused' });
  });

  test('a root on another device does not cover a hub path', async () => {
    writeFileSync(join(cwd, 'x.txt'), 'x');
    expect(await check(join(cwd, 'x.txt'), [{ device: 'dev_laptop', dir: cwd, machine: m }])).toMatchObject({ ok: true, file: { device: 'dev_laptop' } });
    expect(await check(join(cwd, 'x.txt'), [{ device: 'local', dir: childCwd, machine: m }])).toMatchObject({ ok: false, code: 'refused' });
  });
});

describe('media types', () => {
  test('the allowlist, and octet-stream for anything else', () => {
    expect(mediaTypeOf('a.PDF')).toBe('application/pdf');
    expect(mediaTypeOf('a.jpg')).toBe('image/jpeg');
    expect(mediaTypeOf('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mediaTypeOf('a.svg')).toBe('image/svg+xml');
    expect(mediaTypeOf('a.html')).toBe('text/html');
    expect(mediaTypeOf('a.exe')).toBe('application/octet-stream');
    expect(mediaTypeOf('Makefile')).toBe('application/octet-stream');
  });
});

describe('outputs', () => {
  test('a bad session id never makes a path', () => {
    expect(() => outputsDir(home, '../x')).toThrow();
  });

  test('a chat and a session in the hub user home use the outputs folder; a project or a device does not', () => {
    expect(usesOutputs({ kind: 'chat', cwd: '/home/x', device: 'local' })).toBe(true);
    expect(usesOutputs({ cwd: '~', device: 'local' })).toBe(true);
    expect(usesOutputs({ cwd: '', device: 'local' })).toBe(true);
    for (const cwd of ['~/', '/', '/home', base]) expect([cwd, usesOutputs({ cwd, device: 'local' }, join(base, 'user'))]).toEqual([cwd, true]);
    expect(usesOutputs({ cwd: cwd, device: 'local' })).toBe(false);
    expect(usesOutputs({ cwd: '', device: 'dev_laptop' })).toBe(false);
  });
});
