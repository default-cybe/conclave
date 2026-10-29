/**
 * util/ffmpeg.ts without running ffmpeg: the contact sheet arguments, PATH
 * first, and a download that does not match its pinned sha256 is refused.
 *
 *   bun test packages/core/test/util/ffmpeg.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG_BUILDS, contactSheetArgs, findFfmpeg, hubFfmpegPath, resetFfmpegCache } from '../../src/util/ffmpeg';

const dirs: string[] = [];
afterEach(() => {
  resetFfmpegCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('contactSheetArgs', () => {
  test('tiles numbered frames into enough sheets, each frame scaled', () => {
    const a = contactSheetArgs({ input: '/t/f%03d.png', output: '/t/sheet-%02d.png', frames: 14 });
    expect(a).toEqual(['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-start_number', '0', '-i', '/t/f%03d.png', '-vf', 'scale=360:-2,tile=4x3:padding=6:margin=6:color=gray', '-frames:v', '2', '/t/sheet-%02d.png']);
  });

  test('one sheet for a few frames, and the grid and width given', () => {
    const a = contactSheetArgs({ input: 'i', output: 'o', frames: 3, cols: 2, rows: 2, width: 200 });
    expect(a[a.indexOf('-vf') + 1]).toBe('scale=200:-2,tile=2x2:padding=6:margin=6:color=gray');
    expect(a[a.indexOf('-frames:v') + 1]).toBe('1');
    expect(contactSheetArgs({ input: 'i', output: 'o', frames: 0 })[13]).toBe('1');
    // five frames need two rows of four, not three
    expect(contactSheetArgs({ input: 'i', output: 'o', frames: 5 })[11]).toContain('tile=4x2:');
  });
});

describe('findFfmpeg', () => {
  test('PATH wins and nothing is fetched', async () => {
    const r = await findFfmpeg('/nowhere', { which: () => '/usr/bin/ffmpeg', fetch: (() => { throw new Error('no fetch'); }) as never });
    expect(r).toEqual({ path: '/usr/bin/ffmpeg' });
  });

  test('a download that does not match the pinned sha256 is refused and nothing is put in place', async () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-ffmpeg-'));
    dirs.push(home);
    const fake = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const r = await findFfmpeg(home, { which: () => null, fetch: fake });
    if (!FFMPEG_BUILDS[`${process.platform}-${process.arch}`]) expect('error' in r && r.error).toContain('no pinned build');
    else expect('error' in r && r.error).toContain('does not match its pinned sha256');
    expect(existsSync(hubFfmpegPath(home))).toBe(false);
    // the failure is remembered: the next call does not download again
    const again = await findFfmpeg(home, { which: () => null, fetch: (() => { throw new Error('fetched twice'); }) as never });
    expect('error' in again).toBe(true);
  });
});
