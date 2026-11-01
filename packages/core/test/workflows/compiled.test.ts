/**
 * The compiled hub binary must carry the QuickJS wasm: a binary built with
 * `bun build --compile` runs a workflow script from a folder with no
 * node_modules. Set CONCLAVE_SKIP_COMPILE=1 to skip it on a slow machine.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tempDir, cleanup } from '../extensions/_helpers';

test.skipIf(process.env.CONCLAVE_SKIP_COMPILE === '1')(
  'a compiled binary runs a workflow script in the sandbox',
  async () => {
    const out = tempDir('conclave-wfbin-');
    const elsewhere = tempDir('conclave-wfbin-cwd-');
    try {
      const bin = join(out, 'wf');
      const build = Bun.spawnSync(['bun', 'build', '--compile', join(import.meta.dir, 'fixtures', 'compiled-entry.ts'), '--outfile', bin], { cwd: join(import.meta.dir, '..', '..') });
      expect(build.exitCode).toBe(0);
      const run = Bun.spawnSync([bin], { cwd: elsewhere });
      expect(run.stderr.toString()).toBe('');
      expect(JSON.parse(run.stdout.toString().trim())).toEqual({ result: [2, 4, 6], logs: ['doubling 3'] });
    } finally {
      cleanup(out, elsewhere);
    }
  },
  120_000,
);
