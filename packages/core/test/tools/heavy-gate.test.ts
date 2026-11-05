/**
 * Test suites and builds on the hub's own machine take turns (tools/heavy-gate.ts
 * through tools/bash.ts): FIFO, released on every path, an abort while waiting
 * leaves the line, background shells count but never wait, paired devices and
 * server.heavyCommands 0 are never gated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { BashTool } from '../../src/tools/bash';
import { HEAVY_WAIT_NOTE, heavyGate, isHeavyCommand } from '../../src/tools/heavy-gate';
import { shellRegistry } from '../../src/tools/shells';
import { LocalMachine } from '../../src/machine/local';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import { fakeHost, makeCtx, tempDir, text } from './helpers';

const { dir: rawDir, cleanup } = tempDir();
const dir = realpathSync(rawDir);
afterAll(async () => {
  await shellRegistry.disposeAll();
  cleanup();
});

// a shell function stands in for the real suite, so the classifier sees `bun test` and nothing heavy runs
const suite = (label: string, secs: number) => `bun() { sleep ${secs}; echo ${label}; }; bun test`;

async function timed(p: Promise<import('../../src/tools/types').ToolOutput>) {
  const out = await p;
  return { out, at: performance.now() };
}

describe('isHeavyCommand', () => {
  test('whole suites and builds, not single files or other commands', () => {
    for (const c of ['bun test', 'bun run test', 'cd /w && bun run test', 'FOO=1 bun test --timeout 5000', 'bun run test 1/4', 'cargo build --release', 'cargo test', './gradlew assembleDebug', 'git pull && bun test | tail -5']) expect([c, isHeavyCommand(c)]).toEqual([c, true]);
    for (const c of ['bun test packages/core/test/a.test.ts', 'bun run test packages/web', 'bun test -t name', 'bun run typecheck', 'cargo fmt', 'echo bun test is slow', 'ls']) expect([c, isHeavyCommand(c)]).toEqual([c, false]);
  });
});

describe('the gate on the hub', () => {
  test('a second suite waits for the first, and its output starts with the note', async () => {
    const a = timed(BashTool.run({ command: suite('A', 0.6) }, makeCtx({ cwd: dir })));
    await Bun.sleep(100);
    const bCtx = makeCtx({ cwd: dir });
    const startedB = performance.now();
    const b = timed(BashTool.run({ command: suite('B', 0) }, bCtx));
    const [ra, rb] = await Promise.all([a, b]);
    expect(text(ra.out)).toBe('A');
    expect(text(rb.out).split('\n')[0]).toBe(HEAVY_WAIT_NOTE);
    expect(text(rb.out)).toContain('B');
    expect(rb.at).toBeGreaterThanOrEqual(ra.at);
    expect(rb.at - startedB).toBeGreaterThan(300);
    expect(bCtx.progressLog[0]).toContain(HEAVY_WAIT_NOTE);
    expect(heavyGate.waiting).toBe(0);
  });

  test('a failing suite still releases its slot', async () => {
    const bad = await BashTool.run({ command: 'bun() { exit 3; }; bun test' }, makeCtx({ cwd: dir }));
    expect(bad.isError).toBe(true);
    const next = await BashTool.run({ command: suite('next', 0) }, makeCtx({ cwd: dir }));
    expect(text(next)).toBe('next');
  });

  test('an abort while waiting leaves the line and the next call still runs', async () => {
    const a = BashTool.run({ command: suite('A', 0.5) }, makeCtx({ cwd: dir }));
    await Bun.sleep(100);
    const ac = new AbortController();
    const b = BashTool.run({ command: suite('B', 0) }, makeCtx({ cwd: dir, signal: ac.signal }));
    await Bun.sleep(50);
    expect(heavyGate.waiting).toBe(1);
    ac.abort();
    const rb = await b;
    expect(rb.isError).toBe(true);
    expect(text(rb)).toContain('interrupted before it started');
    expect(text(rb)).not.toContain('B\n');
    expect(heavyGate.waiting).toBe(0);
    const c = BashTool.run({ command: suite('C', 0) }, makeCtx({ cwd: dir }));
    expect(text(await a)).toBe('A');
    expect(text(await c)).toContain('C');
  });

  test('a background suite counts while it runs but never waits itself', async () => {
    const fg = BashTool.run({ command: suite('fg', 0.4) }, makeCtx({ cwd: dir }));
    await Bun.sleep(100);
    const t0 = performance.now();
    const bg = await BashTool.run({ command: suite('bg', 0.6), run_in_background: true }, makeCtx({ cwd: dir }));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(bg.meta?.background).toBe(true);
    await fg;
    // the background shell still runs: the next foreground suite waits for it
    const after = await BashTool.run({ command: suite('after', 0) }, makeCtx({ cwd: dir }));
    expect(text(after).split('\n')[0]).toBe(HEAVY_WAIT_NOTE);
  });

  test('a paired device and heavyCommands 0 are never gated', async () => {
    const device = new LocalMachine({ id: 'dev_pc' });
    const a = BashTool.run({ command: suite('A', 0.4) }, makeCtx({ cwd: dir, machine: device }));
    await Bun.sleep(100);
    const b = await BashTool.run({ command: suite('B', 0) }, makeCtx({ cwd: dir, machine: device }));
    expect(text(b)).toBe('B');
    await a;
    const off = fakeHost({ cfg: { server: { ...DEFAULT_CONFIG.server, heavyCommands: 0 } } });
    const c = BashTool.run({ command: suite('C', 0.4) }, makeCtx({ cwd: dir, host: off }));
    await Bun.sleep(100);
    const d = await BashTool.run({ command: suite('D', 0) }, makeCtx({ cwd: dir, host: off }));
    expect(text(d)).toBe('D');
    await c;
  });
});
