import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { IMPORT_LIMITS, type FoundFile } from '../../src/importers/files';
import { MAX_READ_BYTES } from '../../src/machine/protocol';
import type { Machine } from '../../src/machine/types';
import { scanIncremental, scanKey, type FileState } from '../../src/usage/readers/common';

const CAP = 100;
const saved = IMPORT_LIMITS.scanChunkBytes;
beforeEach(() => void (IMPORT_LIMITS.scanChunkBytes = CAP));
afterEach(() => void (IMPORT_LIMITS.scanChunkBytes = saved));

const line = (i: number) => JSON.stringify({ n: i, pad: 'x'.repeat(20) }) + '\n';

/** A device holding one file in memory, recording every read it is asked for. */
function device(text: string, opts: { range?: boolean; failAt?: number[] } = {}) {
  const data = new TextEncoder().encode(text);
  const asks: number[] = [];
  const whole: string[] = [];
  const tries = { n: 0 };
  const m = {
    id: 'pc',
    name: 'PC',
    async readFile(path: string) {
      whole.push(path);
      return data;
    },
    ...(opts.range === false
      ? {}
      : {
          async readRange(_path: string, offset: number, length: number) {
            tries.n++;
            if (opts.failAt?.includes(tries.n)) throw new Error('EIO: i/o error, read');
            asks.push(length);
            return data.subarray(offset, offset + length);
          },
        }),
  } as unknown as Machine;
  const file: FoundFile = { path: '/home/u/.claude/projects/p/s.jsonl', mtimeMs: 1, size: data.byteLength };
  return { m, file, asks, whole, tries };
}

function run(m: Machine, file: FoundFile, kv: Repos['kv'], now: number) {
  const seen: number[] = [];
  return scanIncremental({ machine: m, kv, now }, 'test', [file], (_f, lines) => seen.push(...lines.map((l) => l.value.n))).then((files) => ({ files, seen }));
}

/** A device holding several files that drops (as RemoteMachine after dispose) at read number `dropAt`. */
function several(texts: string[], dropAt: number) {
  const data = texts.map((t) => new TextEncoder().encode(t));
  const files: FoundFile[] = data.map((d, i) => ({ path: `/f${i}.jsonl`, mtimeMs: 1, size: d.byteLength }));
  const tries = { n: 0 };
  const m = {
    id: 'pc',
    name: 'PC',
    online: true,
    async readRange(path: string, offset: number, length: number) {
      if (++tries.n >= dropAt) m.online = false;
      if (!m.online) throw new Error('PC: device disconnected');
      return data[Number(path.slice(2, -6))].subarray(offset, offset + length);
    },
  };
  return { m: m as unknown as Machine & { online: boolean }, files, tries };
}

const stateOf = (kv: Repos['kv'], path: string) => kv.get<Record<string, FileState>>(scanKey('test', 'pc'), {})[path];

describe('scanIncremental on a file larger than one read', () => {
  test('reads in pieces no bigger than the cap and finishes the file', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const text = Array.from({ length: 40 }, (_, i) => line(i)).join('');
    const { m, file, asks, whole } = device(text);
    const { files, seen } = await run(m, file, kv, 0);
    expect(files).toBe(1);
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(whole).toEqual([]);
    expect(asks.length).toBeGreaterThan(10);
    expect(Math.max(...asks)).toBeLessThanOrEqual(CAP);
    expect(stateOf(kv, file.path)).toMatchObject({ o: file.size, s: file.size, m: 1 });
    // nothing changed: nothing read again
    asks.length = 0;
    expect((await run(m, file, kv, 1)).files).toBe(0);
    expect(asks).toEqual([]);
  });

  test('a line longer than the cap is skipped, the lines around it are read', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const long = JSON.stringify({ n: 99, big: 'y'.repeat(CAP * 3) }) + '\n';
    const text = line(0) + line(1) + long + line(2) + line(3);
    const { m, file, asks } = device(text);
    const { seen } = await run(m, file, kv, 0);
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(Math.max(...asks)).toBeLessThanOrEqual(CAP);
    expect(stateOf(kv, file.path).o).toBe(file.size);
  });

  test('a long line still being written at the end stops the scan without looping', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const text = line(0) + '{"n":5,"big":"' + 'z'.repeat(CAP * 3);
    const { m, file, asks } = device(text);
    const { seen } = await run(m, file, kv, 0);
    expect(seen).toEqual([0]);
    expect(asks.length).toBeLessThan(10);
    const st = stateOf(kv, file.path);
    expect(st.o).toBe(line(0).length);
    // seen to the end, so the next refresh does not read it again until it changes
    expect(st).toMatchObject({ s: file.size, m: 1 });
  });

  test('a failure mid-file keeps the progress and resumes there', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const text = Array.from({ length: 20 }, (_, i) => line(i)).join('');
    const { m, file } = device(text, { failAt: [3] });
    const first = await run(m, file, kv, 0);
    expect(first.files).toBe(0);
    expect(first.seen.length).toBeGreaterThan(0);
    const st = stateOf(kv, file.path);
    expect(st.o).toBeGreaterThan(0);
    expect(st.e).toBe(1);
    const second = await run(m, file, kv, st.r!);
    expect(second.files).toBe(1);
    // every line once, none twice
    expect([...first.seen, ...second.seen]).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(stateOf(kv, file.path)).toMatchObject({ o: file.size, s: file.size, m: 1 });
    expect(stateOf(kv, file.path).e).toBeUndefined();
  });

  test('a file that keeps failing is not tried on every refresh', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const { m, file, tries } = device(line(0), { failAt: Array.from({ length: 50 }, (_, i) => i + 1) });
    await run(m, file, kv, 0);
    expect(stateOf(kv, file.path).e).toBe(1);
    const firstRetry = stateOf(kv, file.path).r!;
    // the usage refresh runs every 10 minutes
    await run(m, file, kv, 10 * 60_000);
    expect(stateOf(kv, file.path).e).toBe(1);
    await run(m, file, kv, firstRetry);
    expect(stateOf(kv, file.path).e).toBe(2);
    expect(stateOf(kv, file.path).r! - firstRetry).toBe(2 * firstRetry);
    expect(tries.n).toBe(2);
  });

  test('a device that drops mid-scan stops the scan without charging a failure to any file', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const texts = [0, 1, 2].map((k) => Array.from({ length: 10 }, (_, i) => line(k * 100 + i)).join(''));
    const { m, files, tries } = several(texts, 3);
    const seen: number[] = [];
    const scan = (now: number) => scanIncremental({ machine: m, kv, now }, 'test', files, (_f, lines) => seen.push(...lines.map((l) => l.value.n)));
    expect(await scan(0)).toBe(0);
    // the first failed read ends the scan: the other two files are not tried
    expect(tries.n).toBe(3);
    const st = kv.get<Record<string, FileState>>(scanKey('test', 'pc'), {});
    expect(st[files[0].path].o).toBeGreaterThan(0);
    for (const f of files) expect(st[f.path]?.e).toBeUndefined();
    expect(st[files[1].path]).toBeUndefined();
    // back online: the next refresh, not a backoff later, reads everything once
    m.online = true;
    tries.n = -1e9;
    expect(await scan(1)).toBe(3);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2].flatMap((k) => Array.from({ length: 10 }, (_, i) => k * 100 + i)));
  });

  test('a file that grew after the walk is read to the walked size, then resumed', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const text = Array.from({ length: 10 }, (_, i) => line(i)).join('');
    const { m, file } = device(text);
    // the walk saw it mid-line
    const walked = { ...file, size: line(0).length * 4 + 5 };
    expect((await run(m, walked, kv, 0)).seen).toEqual([0, 1, 2, 3]);
    expect(stateOf(kv, file.path)).toMatchObject({ o: line(0).length * 4, s: walked.size, m: 1 });
    expect((await run(m, { ...file, mtimeMs: 2 }, kv, 1)).seen).toEqual([4, 5, 6, 7, 8, 9]);
    expect(stateOf(kv, file.path)).toMatchObject({ o: file.size, s: file.size, m: 2 });
  });

  test('a file that shrank after the walk is marked for a rescan, and a rewrite starts over', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const text = Array.from({ length: 4 }, (_, i) => line(i)).join('');
    const { m, file } = device(text);
    const walked = { ...file, size: file.size + 50 };
    expect((await run(m, walked, kv, 0)).seen).toEqual([0, 1, 2, 3]);
    // a short read: what was seen, not the walked size, and an mtime that never matches
    expect(stateOf(kv, file.path)).toMatchObject({ o: file.size, s: file.size, m: -1 });
    // same content on the next walk: nothing read twice
    expect((await run(m, file, kv, 1)).seen).toEqual([]);
    expect(stateOf(kv, file.path)).toMatchObject({ o: file.size, m: 1 });
    // rewritten shorter than the offset: read from the start
    const re = device(line(7));
    expect((await run(re.m, { ...re.file, mtimeMs: 3 }, kv, 2)).seen).toEqual([7]);
    expect(stateOf(kv, file.path)).toMatchObject({ o: re.file.size, s: re.file.size, m: 3 });
  });

  test('a machine without readRange reads a small file whole and skips one over the reply limit', async () => {
    const kv = new Repos(openDb(':memory:')).kv;
    const small = device(line(0) + line(1), { range: false });
    expect((await run(small.m, small.file, kv, 0)).seen).toEqual([0, 1]);
    expect(small.whole).toEqual([small.file.path]);
    const big = device(line(0), { range: false });
    const huge = { ...big.file, path: '/big.jsonl', size: MAX_READ_BYTES + 1 };
    expect((await run(big.m, huge, kv, 0)).files).toBe(0);
    expect(big.whole).toEqual([]);
    expect(stateOf(kv, huge.path).e).toBe(1);
  });
});
