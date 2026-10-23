/**
 * The sandbox is the security boundary for model-written scripts: no host
 * objects, no filesystem, process or network, CPU and memory limits, capped
 * logs and results. The meta block must be a pure literal.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { runScript, svcOf, noHarnesses } from './helpers';
import { parseScript, WorkflowLoadError } from '../../src/workflows/meta';
import { loadMeta } from '../../src/workflows/registry';

let t: TestEngine;
beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { limits: { maxRetries: 0 } } as never });
  noHarnesses(t.engine);
  svcOf(t.engine).sandboxLimits = { cpuMs: 1500 };
});
afterAll(async () => t?.close());

const meta = `export const meta = { name: 'sb', description: 'sandbox' }\n`;

test('no host globals reach the script, whatever the route', async () => {
  const run2 = await runScript(
    t,
    `${meta}
const probe = (f) => { try { return f() } catch (e) { return 'threw: ' + e.message } }
return {
  types: [typeof process, typeof require, typeof fetch, typeof Bun, typeof globalThis.__host, typeof globalThis.__hostSync, typeof setInterval, typeof WebAssembly, typeof XMLHttpRequest],
  ctor: probe(() => (function () {}).constructor('return typeof process + typeof require')()),
  globalFromEval: probe(() => { const g = (0, eval)('this'); return typeof g.process + typeof g.Bun }),
  proxy: probe(() => { const p = new Proxy({}, { get: (_, k) => k }); return typeof p.process }),
}`,
  );
  expect(run2.status).toBe('done');
  const r = run2.result as Record<string, unknown>;
  expect(r.types).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  expect(r.ctor).toBe('undefinedundefined');
  expect(r.globalFromEval).toBe('undefinedundefined');
  expect(r.proxy).toBe('string');
});

test('prototype changes inside the sandbox do not touch the hub', async () => {
  const run = await runScript(t, `${meta}Object.prototype.polluted = 'yes'; Array.prototype.map = () => 'evil'; JSON.stringify = () => 'evil'; return 'done'`);
  expect(run.status).toBe('done');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect([1].map((x) => x + 1)).toEqual([2]);
});

test('host objects never enter: a Proxy passed to agent() is read as JSON', async () => {
  const run = await runScript(
    t,
    `${meta}
let touched = 0
const opts = new Proxy({ label: 'x' }, { get: (o, k) => { touched++; return o[k] } })
const r = await agent('say ok', opts)
return { r, touched: touched > 0 }`,
  );
  expect(run.status).toBe('done');
  expect(run.result).toEqual({ r: 'ok', touched: true });
});

test('an infinite loop stops at the CPU limit', async () => {
  const started = Date.now();
  const run = await runScript(t, `${meta}while (true) {}`);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('CPU time');
  expect(Date.now() - started).toBeLessThan(10_000);
});

test('waiting on agents does not count as CPU time', async () => {
  const run = await runScript(t, `${meta}await new Promise((r) => setTimeout(r, 2000)); return 'waited'`);
  expect(run.status).toBe('done');
  expect(run.result).toBe('waited');
});

test('a memory bomb stops at the memory limit', async () => {
  const run = await runScript(t, `${meta}let s = 'x'; const keep = []; for (;;) { s = s + s; keep.push(s) }`);
  expect(run.status).toBe('failed');
  expect(run.error).toMatch(/memory|CPU time/);
});

test('logs are capped at 2000 lines with one cap line', async () => {
  const run = await runScript(t, `${meta}for (let i = 0; i < 2600; i++) log('line ' + i); return 'ok'`);
  expect(run.status).toBe('done');
  const logs = svcOf(t.engine).store.logs(run.id, 5000);
  expect(logs.length).toBe(2001);
  expect(logs[logs.length - 1].text).toContain('log cap reached');
});

test('a result over 4 MB is refused', async () => {
  const run = await runScript(t, `${meta}return 'x'.repeat(5 * 1024 * 1024)`);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('larger than 4 MB');
});

test('Date.now, Math.random and new Date() throw; dates from args work', async () => {
  const run = await runScript(
    t,
    `${meta}
const probe = (f) => { try { return f() } catch (e) { return 'threw' } }
return [probe(() => Date.now()), probe(() => Math.random()), probe(() => new Date()), new Date(args.ts).toISOString()]`,
    { args: { ts: 0 } },
  );
  expect(run.result).toEqual(['threw', 'threw', 'threw', '1970-01-01T00:00:00.000Z']);
});

test('a script that waits on a promise that never settles fails instead of hanging', async () => {
  const run = await runScript(t, `${meta}await new Promise(() => {}); return 'never'`);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('never settles');
});

test('meta must be first and a pure literal', async () => {
  const bad = [
    [`const x = 1\nexport const meta = { name: 'a', description: 'b' }`, 'must begin with'],
    [`export const meta = { name: x, description: 'b' }`, 'a variable or call'],
    [`export const meta = { name: 'a', description: 'b', ...more }`, 'spread'],
    [`export const meta = { name: \`a\${1}\`, description: 'b' }`, 'template interpolation'],
    [`export const meta = { name: String(1), description: 'b' }`, 'a variable or call'],
    [`export const meta = { name: 'a', description: 'b', [k]: 1 }`, 'computed key'],
    [`export const meta = { name: 'a', description: 'b', f() {} }`, 'shorthand or method'],
    [`export const meta = { name: 'a', description: 'b' }\nimport fs from 'node:fs'`, 'import is not available'],
    [`export const meta = { name: 'a', description: 'b' }\nconst m = await import('node:fs')`, 'import is not available'],
  ] as const;
  for (const [script, why] of bad) {
    expect(() => parseScript(script)).toThrow(WorkflowLoadError);
    try {
      parseScript(script);
    } catch (err) {
      expect((err as Error).message).toContain(why);
    }
  }
  // strings and comments that mention import are fine; minified meta parses
  const okScripts = [
    `export const meta = { name: 'a', description: 'import is fine in a string', phases: [{ title: 'X', detail: "it's" }], n: -1, ok: true, none: null }\n// import x from 'y'\nreturn 'import'`,
    `export const meta={name:"min",description:"minified"};const e="x";return e`,
  ];
  for (const s of okScripts) expect(() => parseScript(s)).not.toThrow();
  expect((await loadMeta(okScripts[0])).meta).toMatchObject({ name: 'a', n: -1, ok: true, none: null });
  await expect(loadMeta(`export const meta = { name: 'a' }\nreturn 1`)).rejects.toThrow('meta.description is required');
  const run = await runScript(t, `export const meta = { name: x, description: 'b' }`).catch((e) => e as Error);
  expect(String((run as Error).message)).toContain('pure literal');
});
