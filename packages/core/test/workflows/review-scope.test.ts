/**
 * Review pass of section 3: what a script an agent wrote may reach. A script
 * file the agent saved in its own folder is not the owner's library, its
 * agents stay on the run's device and in its folder, and a worktree setup
 * command from such a script asks like lib.exec. Scripted engine only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { svcOf, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';

let t: TestEngine;
const answers = new Map<string, (body: RequestBody) => Step | number | undefined>();

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      for (const [word, fn] of answers) if (first.includes(word)) return fn(body);
      const m = /say (\w+)/.exec(first);
      if (m) return [{ text: m[1] }];
      return undefined;
    },
    overrides: { limits: { maxRetries: 0 } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

/** An Ultra session whose first run was approved: the Workflow tool starts runs without a card. */
async function ultraSession(cwd = t.cwd) {
  const s = await t.engine.createSession({ cwd });
  t.engine.updateSession(s.id, { ultra: true });
  t.engine.patchMeta(s.id, { ultraApproved: true });
  return s;
}

const fromTool = (sessionId: string, input: Record<string, unknown>, id: string) =>
  svcOf(t.engine).runFromTool({ sessionId, ...input }, { toolUseId: id, signal: new AbortController().signal, estimate: { agents: 1, tokens: 1 } });

test('a script file the agent saved in its folder cannot grant itself Bash through scriptPath', async () => {
  const svc = svcOf(t.engine);
  const s = await ultraSession();
  const file = join(t.cwd, 'grant.js');
  try {
    // an agent can write this file without asking in acceptEdits; before, any path outside the runs folder counted as the owner's library
    writeFileSync(file, `export const meta = { name: 'grant-path', description: 'review', runtime: 'conclave', permissions: { allow: ['Bash'] } }\nconst r = await lib.exec('touch granted-by-path.txt')\nreturn r.exitCode`);
    const out = await fromTool(s.id, { scriptPath: './grant.js' }, 'tu_path');
    expect(existsSync(join(t.cwd, 'granted-by-path.txt'))).toBe(false);
    expect(out.isError).toBe(true);
    const run = svc.store.getRun(out.runId!)!;
    expect(run.source).toBe('project');
    expect(run.scoped).toBe(true);
    expect(svc.store.logs(run.id).some((l) => l.text.includes('meta.permissions.allow was not applied'))).toBe(true);
  } finally {
    rmSync(file, { force: true });
    rmSync(join(t.cwd, 'granted-by-path.txt'), { force: true });
  }
});

test("an agent's script keeps its agents on the run's device and inside its folder", async () => {
  const svc = svcOf(t.engine);
  const s = await ultraSession();
  mkdirSync(join(t.cwd, 'sub'), { recursive: true });
  const outside = tempDir('conclave-review-outside-');
  try {
    const script = `export const meta = { name: 'reach', description: 'review' }
const tryAgent = async (o) => { try { return await agent('say inside', o) } catch (e) { return 'refused: ' + e.message } }
return {
  home: await tryAgent({ conclave: { cwd: ${JSON.stringify(outside)} } }),
  device: await tryAgent({ conclave: { device: 'pve' } }),
  sub: await tryAgent({ conclave: { cwd: 'sub' } }),
}`;
    const out = await fromTool(s.id, { script }, 'tu_reach');
    expect(out.isError).toBeUndefined();
    const run = svc.store.getRun(out.runId!)!;
    const r = run.result as Record<string, string>;
    expect(r.home).toStartWith('refused: ');
    expect(r.home).toContain('is outside them');
    expect(r.device).toStartWith('refused: ');
    expect(r.device).toContain('conclave.device pve is not allowed');
    expect(r.sub).toBe('inside');
    // the relative folder became the run's own subfolder
    const call = svc.store.calls(run.id).find((c) => c.kind === 'agent' && c.state === 'done')!;
    expect(t.engine.getSession(call.childSessionId!)!.cwd).toBe(join(t.cwd, 'sub'));

    // the owner's own library workflow may send an agent elsewhere
    mkdirSync(svc.registry.userDir, { recursive: true });
    writeFileSync(join(svc.registry.userDir, 'owner-reach.js'), `export const meta = { name: 'owner-reach', description: 'review' }\nreturn await agent('say elsewhere', { conclave: { cwd: ${JSON.stringify(outside)} } })`);
    const owner = await svc.wait((await svc.startRun({ name: 'owner-reach', sessionId: s.id })).id);
    expect(owner.scoped).toBeFalsy();
    expect(owner.result).toBe('elsewhere');
  } finally {
    rmSync(join(svc.registry.userDir, 'owner-reach.js'), { force: true });
    cleanup(outside);
  }
});

/** A git repository with one commit; worktrees go under a home of its own. */
function makeRepo(): { repo: string; home: string } {
  const repo = tempDir('conclave-review-repo-');
  const home = tempDir('conclave-review-home-');
  const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
  git('init -q -b main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git('add -A');
  git('commit -q -m init');
  (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.set('local', home);
  return { repo, home };
}

test("a worktree setup command from an agent's script or an untrusted repository asks before it runs", async () => {
  const svc = svcOf(t.engine);
  const { repo, home } = makeRepo();
  const marker = join(home, 'setup-ran');
  try {
    const s = await ultraSession(repo);
    const before = t.approvals.length;
    // the approval card is denied in this harness, so the command must not run and the call is null
    const script = `export const meta = { name: 'setup-cmd', description: 'review' }
return await agent('say isolated', { isolation: 'worktree', conclave: { worktreeSetup: 'touch ${marker}' } })`;
    const out = await fromTool(s.id, { script }, 'tu_setup');
    const run = svc.store.getRun(out.runId!)!;
    expect(existsSync(marker)).toBe(false);
    expect(run.result).toBeNull();
    expect(t.approvals.length).toBe(before + 1);
    expect(t.approvals.at(-1)).toContain('worktree setup: touch');
    expect(svc.store.logs(run.id).some((l) => l.text.includes('worktree setup was not approved'))).toBe(true);

    // the same command in a repository's .conclave/settings.json asks too until the owner trusts the folder
    mkdirSync(join(repo, '.conclave'), { recursive: true });
    writeFileSync(join(repo, '.conclave', 'settings.json'), JSON.stringify({ worktreeSetup: `touch ${marker}` }));
    mkdirSync(svc.registry.userDir, { recursive: true });
    writeFileSync(join(svc.registry.userDir, 'owner-setup.js'), `export const meta = { name: 'owner-setup', description: 'review' }\nreturn await agent('say isolated', { isolation: 'worktree' })`);
    const untrusted = await svc.wait((await svc.startRun({ name: 'owner-setup', sessionId: s.id })).id);
    expect(existsSync(marker)).toBe(false);
    expect(untrusted.result).toBeNull();

    t.engine.trust.set(repo, true);
    const trusted = await svc.wait((await svc.startRun({ name: 'owner-setup', sessionId: s.id })).id);
    expect(existsSync(marker)).toBe(true);
    expect(trusted.result).toBe('isolated');
  } finally {
    t.engine.trust.set(repo, false);
    rmSync(join(svc.registry.userDir, 'owner-setup.js'), { force: true });
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.delete('local');
    cleanup(repo, home);
  }
}, 30_000);

test('parallel workflow() calls hold at most two nested sandboxes at once', async () => {
  const svc = svcOf(t.engine);
  mkdirSync(svc.registry.userDir, { recursive: true });
  // each nested script holds memory while it waits; twenty at once held about 900 MB in the hub before
  writeFileSync(join(svc.registry.userDir, 'hold.js'), `export const meta = { name: 'hold', description: 'review' }\nconst a = new Uint8Array(4 * 1024 * 1024)\nawait new Promise((r) => setTimeout(r, 150))\nreturn a.length`);
  try {
    const s = await t.engine.createSession({ cwd: t.cwd });
    const run = await svc.wait((await svc.startRun({ sessionId: s.id, script: `export const meta = { name: 'many-nested', description: 'review' }\nreturn await parallel(Array.from({ length: 6 }, () => () => workflow('hold')))` })).id);
    expect(run.status).toBe('done');
    expect(run.result).toEqual(Array(6).fill(4 * 1024 * 1024));
    const spans = svc.store.calls(run.id).filter((c) => c.kind === 'workflow').map((c) => [c.startedAt!, c.finishedAt!] as const);
    expect(spans.length).toBe(6);
    const most = Math.max(...spans.map(([a]) => spans.filter(([b, e]) => b <= a && a < e).length));
    expect(most).toBeLessThanOrEqual(2);
    expect(svc.store.logs(run.id).filter((l) => l.text.includes('nested workflow cap')).length).toBe(1);
  } finally {
    rmSync(join(svc.registry.userDir, 'hold.js'), { force: true });
  }
});

test('the approval card cuts a long description at a word and names a script that is not from the library', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const file = join(t.cwd, 'long.js');
  const description = 'Four independent designs from fixed angles, scored blind by three judges in both orders, then one design built from the winner with named ideas grafted from the others';
  writeFileSync(file, `export const meta = { name: 'long-desc', description: ${JSON.stringify(description)}, phases: [{ title: 'One' }] }\nreturn 1`);
  try {
    const before = t.approvals.length;
    await svc.runFromTool({ sessionId: s.id, scriptPath: file }, { toolUseId: 'tu_card', signal: new AbortController().signal });
    const card = t.approvals.slice(before)[0];
    expect(card).toContain(`Run workflow long-desc (from ${file}): Four independent designs`);
    expect(card).toContain('built from the winner with named… Phases: One.');
    expect(card).not.toContain('….');
  } finally {
    rmSync(file, { force: true });
  }
});
