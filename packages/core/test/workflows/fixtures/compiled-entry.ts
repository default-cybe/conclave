/**
 * Entry for the compiled-binary test: runs one workflow script in the
 * sandbox from a `bun build --compile` binary, so the QuickJS wasm must be
 * embedded (workflows/sandbox.ts imports it as a file asset).
 */
import { Sandbox } from '../../../src/workflows/sandbox';
import { parseScript } from '../../../src/workflows/meta';
import { preludeSource } from '../../../src/workflows/prelude';

const script = `export const meta = { name: 'bin', description: 'compiled' }
phase('Double')
log('doubling', args.length)
return args.map((x) => x * 2)`;
const { body } = parseScript(script);
const logs: string[] = [];
const sb = await Sandbox.create({
  sync: { log: (p) => (logs.push(String(p)), null), phase: () => null, budget: () => ({ total: null, spent: 0, costUsd: 0 }), panel: () => null },
  async: {},
});
sb.evalGlobal(preludeSource({ argsJson: JSON.stringify([1, 2, 3]), nested: false }), 'prelude.js');
const result = await sb.runAsync(body, 'workflow.js');
sb.dispose();
console.log(JSON.stringify({ result, logs }));
