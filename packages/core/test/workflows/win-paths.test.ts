/**
 * A workflow run on a Windows device (docs/DESIGN.md 30, as PR #401 for repo
 * sessions): citations, the worktree an agent works in and lib.checkout name
 * D:\ and C:\ paths in path.win32, not path.posix. Scripted engine only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type TestEngine } from '../engine/harness';
import { sh, winDevice } from '../projects/machines';
import { afterToolResult, svcOf, workingDir, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';

const GIT = 'git -c user.email=agent@test -c user.name=Agent -c commit.gpgsign=false';
let t: TestEngine;
let base: string;

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    // the agent commits a note in its worktree, then answers with the folder it was started in
    route: (body) => {
      if (!firstUserText(body).includes('where are you')) return undefined;
      if (afterToolResult(body)) return [{ text: `cwd=${workingDir(body)}` }];
      return [{ tool: 'Bash', input: { command: `printf note > note.txt && git add -A && ${GIT} commit -qm note` } }];
    },
    approve: 'allow',
  });
  noHarnesses(t.engine);
  base = tempDir('conclave-wf-win-');
});
afterAll(async () => {
  await t?.close();
  cleanup(base);
});

test('a run on D:\\Coding\\app\\src: citations inside the repo pass, the worktree cwd keeps src, a checkout is under C:\\', async () => {
  const home = join(base, 'home');
  const repo = join(base, 'code', 'app');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'hello there\n');
  writeFileSync(join(repo, 'src', 'x.ts'), 'const a = 1;\nconst b = 2;\n');
  sh(`git init -q -b main && ${GIT} add -A && ${GIT} commit -qm first`, repo);
  winDevice(t, home, [['C:\\Users\\nihir', home], ['D:\\Coding', join(base, 'code')]]);

  const svc = svcOf(t.engine);
  const script = `export const meta = { name: 'win-paths', description: 'win', runtime: 'conclave' }
const here = await lib.checkCitation({ file: 'x.ts', line: 2, quote: 'const b = 2;' })
const up = await lib.checkCitation({ file: '..\\\\README.md', line: 1, quote: 'hello there' })
const out = await lib.checkCitation({ file: 'D:\\\\Coding\\\\other.md', line: 1, quote: 'nothing here' })
const wt = await agent('where are you', { isolation: 'worktree' })
const view = await lib.checkout(1)
return { here, up, out, wt, view }`;
  const run = await svc.wait((await svc.startRun({ device: 'win', cwd: 'D:\\Coding\\app\\src', script })).id);
  expect({ status: run.status, error: run.error }).toEqual({ status: 'done', error: undefined });
  const r = run.result as { here: { ok: boolean }; up: { ok: boolean }; out: { ok: boolean; reason?: string }; wt: unknown; view: string };
  expect(r.here).toMatchObject({ ok: true });
  expect(r.up).toMatchObject({ ok: true });
  // another folder of the drive is outside the repository, not a passed citation
  expect(r.out).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
  // the agent ran in the worktree's src, under the device's C:\ home
  expect(JSON.stringify(r.wt)).toMatch(/cwd=C:\\\\Users\\\\nihir\\\\\.conclave\\\\worktrees\\\\[0-9a-f]+\\\\[\w-]+\\\\src/);
  // lib.checkout of its kept commit: a C:\ folder beside the worktrees, at the run's src
  expect(r.view).toMatch(/^C:\\Users\\nihir\\\.conclave\\worktrees\\[0-9a-f]+\\[\w-]+-view-1\\src$/);
}, 60_000);
