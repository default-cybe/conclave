/**
 * Folders across devices on a real engine with two devices over the local
 * disk (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.14). The model is the scripted fake
 * from test/engine/harness.ts: no paid calls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, until, type Step, type TestEngine } from '../engine/harness';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import { attach, cloneRepo, commit, detach, makeRepo, sh, twoDevices, writeSyncthing, type TwoDevices } from './machines';
import { isOfflineMachine } from '../../src/projects/offline';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;

afterEach(async () => {
  // a checkpoint after a move lands on the device's disk in the background
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = undefined;
  d = undefined;
});

/** Model steps for the next requests, set by each test once its paths are known. */
let plan: Step[] = [];

async function setup(opts: Partial<Parameters<typeof startTestEngine>[0]> = {}) {
  plan = [];
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift(), ...opts });
  d = twoDevices(t.engine);
  const svc = projectsOf(t.engine) as ProjectsService;
  expect(svc).toBeDefined();
  return { t, d, svc };
}

/** A session on pc in the given folder, with its project known (as at the end of a turn). */
async function pcSession(t: TestEngine, svc: ProjectsService, cwd: string, extra: Record<string, unknown> = {}) {
  const s = await t.engine.createSession({ device: 'pc', cwd, ...extra });
  await svc.recordState(s);
  return t.engine.requireSession(s.id);
}

describe('resolution order', () => {
  test('same path on both devices', async () => {
    const { t, d, svc } = await setup();
    const shared = join(d.base, 'shared', 'portfolio');
    makeRepo(shared);
    const s = await pcSession(t, svc, shared);
    expect(s.projectId).toBeTruthy();
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r).toMatchObject({ resolved: true, via: 'same-path', level: 'exact', cwd: shared });
    expect(t.engine.requireSession(s.id)).toMatchObject({ device: 'mac', cwd: shared });
  });

  test('Syncthing maps the folder, the freshness line says the copy is behind, and an old path reads from the new copy', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.pc.home, [{ id: 'code-1', label: 'code', path: '~/code' }]);
    writeSyncthing(d.mac.home, [{ id: 'code-1', label: 'code', path: '~/Developer' }]);
    commit(pcRepo, 'NEW.md', 'new on pc');
    // the mac has fetched the new commit but not merged it: one behind
    sh(`git fetch -q ${pcRepo} main`, macRepo);
    const s = await pcSession(t, svc, pcRepo);
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r).toMatchObject({ via: 'syncthing', level: 'exact', cwd: macRepo });
    expect(r.line).toBe('Moved to macbook at ~/Developer/portfolio (Syncthing).');
    expect(r.freshness).toMatchObject({ stale: true, behind: 1 });
    expect(r.freshness?.line).toContain('The macbook copy is 1 commit behind');
    // the model reads an old path from earlier messages: it maps to the mac copy and says so once
    plan = [[{ tool: 'Read', input: { file_path: join(pcRepo, 'README.md') } }], [{ text: 'read it' }]];
    await t.run(s.id, 'read the readme');
    const res = toolResults(t.engine, s.id).find((x) => x.name === 'Read');
    expect(res?.isError).toBe(false);
    expect(res?.content).toContain('three');
    expect(res?.content).toContain(`Conclave mapped ${pcRepo} to ${macRepo}`);
    // the move note rides on the next user message
    expect(t.requests[0]).toContain('This session moved from arch-desktop');
  });

  test('Syncthing conflict files go to the details: not the move line, not the banner', async () => {
    // found in a real run: "Moved to ... (chosen folder). 2 Syncthing conflict files are in this folder." as a warning
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'cmu');
    const macRepo = join(d.mac.home, 'MadX', 'CMU');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    sh('touch "notes.sync-conflict-20261020-101010-ABCDEFG.md" "plan.sync-conflict-20261021-090909-HIJKLMN.md"', macRepo);
    const s = await pcSession(t, svc, pcRepo);
    const r = await svc.move(s.id, { device: 'mac', cwd: macRepo });
    expect(r).toMatchObject({ resolved: true, via: 'chosen', line: 'Moved to macbook at ~/MadX/CMU (chosen folder).' });
    if (!r.resolved) return;
    expect(r.freshness).toMatchObject({ stale: false, conflicts: 2 });
    const loc = await svc.location(s.id);
    expect(loc).toMatchObject({ state: 'ok', freshness: { conflicts: 2 } });
  });

  test('a confirmed folder teaches a path pair that the next project uses', async () => {
    const { t, d, svc } = await setup();
    const pcA = join(d.pc.home, 'code', 'portfolio');
    const macA = join(d.mac.home, 'Work', 'portfolio');
    makeRepo(pcA);
    cloneRepo(pcA, macA);
    const a = await pcSession(t, svc, pcA);
    // ~/Work is not searched, so nothing is found and the owner chooses
    const first = await svc.move(a.id, { device: 'mac' });
    expect(first).toMatchObject({ resolved: false, reason: 'not-found' });
    const chosen = await svc.move(a.id, { device: 'mac', cwd: macA });
    expect(chosen).toMatchObject({ resolved: true, via: 'chosen', level: 'exact' });
    expect(svc.store.prefixes()).toEqual([expect.objectContaining({ fromDevice: 'pc', fromPrefix: join(d.pc.home, 'code'), toDevice: 'mac', toPrefix: join(d.mac.home, 'Work') })]);

    const pcB = join(d.pc.home, 'code', 'site');
    const macB = join(d.mac.home, 'Work', 'site');
    makeRepo(pcB, 'git@github.com:kai/site.git');
    cloneRepo(pcB, macB, { remote: 'git@github.com:kai/site.git' });
    const b = await pcSession(t, svc, pcB);
    const second = await svc.move(b.id, { device: 'mac' });
    expect(second).toMatchObject({ resolved: true, via: 'prefix', level: 'exact', cwd: macB });
  });

  test('search finds the repo under the default roots; a shallow clone matches by HEAD', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'blog');
    const macRepo = join(d.mac.home, 'projects', 'blog');
    makeRepo(pcRepo, 'git@github.com:kai/blog.git');
    cloneRepo(pcRepo, macRepo, { shallow: true, remote: 'git@github.com:kai/blog.git' });
    const s = await pcSession(t, svc, pcRepo);
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r).toMatchObject({ resolved: true, via: 'search', level: 'strong', cwd: macRepo });
  });

  test('a pinned location wins, and moving to an offline device says so', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const pinned = join(d.mac.home, 'elsewhere', 'pf');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, pinned);
    const s = await pcSession(t, svc, pcRepo);
    const project = await svc.pin(s.projectId!, 'mac', pinned);
    expect(project.locations.find((l) => l.device === 'mac')).toMatchObject({ path: pinned, pinned: true, via: 'pinned' });
    detach(t.engine, 'mac');
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: false, reason: 'offline' });
    attach(t.engine, d.mac);
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, via: 'pinned', cwd: pinned });
  });
});

describe('safety', () => {
  test('a different repository asks first, and with Use once every write asks', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const other = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    makeRepo(other, 'git@github.com:someone/else.git');
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'acceptEdits' });
    const no = await svc.move(s.id, { device: 'mac', cwd: other });
    expect(no).toMatchObject({ resolved: false, reason: 'mismatch' });
    if (!no.resolved) expect(no.line).toContain('A different git repository from the arch-desktop copy');
    const yes = await svc.move(s.id, { device: 'mac', cwd: other, allowMismatch: true });
    expect(yes).toMatchObject({ resolved: true, level: 'mismatch' });
    const loc = await svc.location(s.id);
    expect(loc.state).toBe('mismatch');
    await runWrites(t, s.id, join(other, 'notes.md'));
    const asks = t.approvals.filter((a) => a.includes('since this session moved there'));
    expect(asks).toHaveLength(2);
    expect(asks[0]).toContain('Mismatch: a different git repository from the arch-desktop copy');
  });

  test('a strong match asks once before the first write, then not again', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'blog');
    const macRepo = join(d.mac.home, 'code', 'blog');
    makeRepo(pcRepo, 'git@github.com:kai/blog.git');
    cloneRepo(pcRepo, macRepo, { shallow: true, remote: 'git@github.com:kai/blog.git' });
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'acceptEdits' });
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r).toMatchObject({ resolved: true, level: 'strong' });
    await runWrites(t, s.id, join(macRepo, 'notes.md'));
    expect(t.approvals.filter((a) => a.includes('since this session moved there'))).toHaveLength(1);
    expect(readFileSync(join(macRepo, 'notes.md'), 'utf8')).toBe('two');
  });

  test('a checkpoint is taken on the new device, and restores only there', async () => {
    const { t, d, svc } = await setup();
    const shared = join(d.base, 'shared', 'portfolio');
    makeRepo(shared);
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    makeRepo(pcRepo);
    const s = await pcSession(t, svc, pcRepo);
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    cloneRepo(pcRepo, macRepo);
    await svc.move(s.id, { device: 'mac', cwd: macRepo });
    expect(await until(() => t.engine.checkpoints(s.id).some((c) => c.device === 'mac'), 10_000)).toBe(true);
    const ck = t.engine.checkpoints(s.id).find((c) => c.device === 'mac')!;
    expect(ck.root).toBe(macRepo);
    // the shadow repo lives on the mac, not on the hub
    expect(existsSync(join(d.mac.home, '.conclave', 'checkpoints'))).toBe(true);
    await svc.move(s.id, { device: 'pc', cwd: pcRepo });
    await expect(t.engine.restoreCheckpoint(s.id, ck.id)).rejects.toThrow('This checkpoint is on macbook');
  });
});

describe('the banner', () => {
  test('an offline device suggests the Syncthing copy elsewhere; a missing folder says so', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.pc.home, [{ id: 'code-1', path: '~/code' }]);
    writeSyncthing(d.mac.home, [{ id: 'code-1', path: '~/Developer' }]);
    const s = await pcSession(t, svc, pcRepo);
    expect((await svc.location(s.id)).state).toBe('ok');
    detach(t.engine, 'pc');
    expect(isOfflineMachine(t.engine.machineFor(t.engine.requireSession(s.id)))).toBe(true);
    const loc = await svc.location(s.id);
    expect(loc).toMatchObject({ state: 'offline', online: false, suggestion: { device: 'mac', cwd: macRepo, via: 'syncthing' } });
    expect(loc.line).toBe('arch-desktop is offline. Your folder is also on macbook at ~/Developer/portfolio (Syncthing).');
    attach(t.engine, d.pc);
    const gone = await t.engine.createSession({ device: 'mac', cwd: join(d.mac.home, 'nope') });
    expect(await svc.location(gone.id)).toMatchObject({ state: 'missing', line: '~/nope is not on macbook.' });
  });

  test('Devices > Folders lists locations, path pairs, a suggestion from an imported session, and Syncthing', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.mac.home, [{ id: 'dev', path: '~/Developer' }, { id: 'notes', path: '~/notes', paused: true }]);
    await pcSession(t, svc, pcRepo);
    await t.engine.createSession({ device: 'mac', cwd: macRepo, tags: ['imported'], title: 'portfolio' });
    const folders = await svc.deviceFolders('mac');
    expect(folders.suggestions).toEqual([expect.objectContaining({ fromDevice: 'pc', toDevice: 'mac', toPath: macRepo, reason: 'From the imported session "portfolio"' })]);
    expect(folders.syncthing).toMatchObject({ available: true, line: '2 folders, 1 paused.' });
    await svc.pin(folders.suggestions[0].projectId, 'mac', macRepo);
    const after = await svc.deviceFolders('mac');
    expect(after.suggestions).toEqual([]);
    expect(after.locations).toEqual([expect.objectContaining({ path: macRepo, pinned: true, projectName: 'portfolio' })]);
    expect(after.prefixes).toHaveLength(1);
    svc.deletePrefix(after.prefixes[0].id);
    expect((await svc.deviceFolders('mac')).prefixes).toEqual([]);
  });
});

describe('the resumed context', () => {
  test('an offline device parks the turn; it continues when the device is back', async () => {
    const { t, d, svc } = await setup();
    const macRepo = join(d.mac.home, 'code', 'portfolio');
    makeRepo(macRepo);
    const s = await t.engine.createSession({ device: 'mac', cwd: macRepo });
    void svc;
    detach(t.engine, 'mac');
    const runner = t.engine.runnerFor(s.id);
    await runner.enqueue({ text: 'go' });
    expect(await until(() => t.engine.requireSession(s.id).status === 'waiting_input')).toBe(true);
    expect(t.requests).toHaveLength(0);
    const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notices.some((n) => n.includes('macbook is offline. Wait, or run on another device.'))).toBe(true);
    attach(t.engine, d.mac);
    await Promise.race([runner.waitIdle(), Bun.sleep(10_000)]);
    expect(t.requests).toHaveLength(1);
    expect(t.engine.requireSession(s.id).status).toBe('idle');
  });

  test('moving a parked session to another device runs the turn there', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    plan = [[{ tool: 'Bash', input: { command: 'pwd' } }], [{ text: 'done' }]];
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.pc.home, [{ id: 'code-1', path: '~/code' }]);
    writeSyncthing(d.mac.home, [{ id: 'code-1', path: '~/Developer' }]);
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'bypass' });
    await svc.syncthing.folders('pc', d.pc);
    detach(t.engine, 'pc');
    const runner = t.engine.runnerFor(s.id);
    await runner.enqueue({ text: 'where am I' });
    expect(await until(() => t.engine.requireSession(s.id).status === 'waiting_input')).toBe(true);
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r).toMatchObject({ resolved: true, via: 'syncthing' });
    await Promise.race([runner.waitIdle(), Bun.sleep(10_000)]);
    const bash = toolResults(t.engine, s.id).find((x) => x.name === 'Bash');
    expect(bash?.content).toContain(macRepo);
  });

  test('a harness resume made on another device starts fresh with the conversation as context', async () => {
    const { t, d, svc } = await setup();
    const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
    const cfg = t.engine.config.get();
    t.engine.config.update({ providers: { ...cfg.providers, fake: { type: 'acp', command: process.execPath, args: [AGENT] } } });
    const shared = join(d.base, 'shared', 'portfolio');
    makeRepo(shared);
    const s = await t.engine.createSession({ device: 'pc', cwd: shared, model: 'fake/default' });
    await t.run(s.id, 'echo first turn on the pc');
    const first = t.engine.requireSession(s.id);
    expect(first.external?.fake).toBeTruthy();
    expect((first.meta?.externalAt as Record<string, unknown>)?.fake).toEqual({ device: 'pc', cwd: shared });
    await svc.move(s.id, { device: 'mac' });
    await t.run(s.id, 'echo second turn on the mac');
    const text = JSON.stringify(t.engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)?.content);
    expect(text).toContain('prior_conversation');
    expect(text).toContain('first turn on the pc');
    const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notices.some((n) => n.includes('could not resume here, so the conversation so far was passed as context'))).toBe(true);
    expect(t.engine.requireSession(s.id).external?.fake).not.toBe(first.external?.fake);
  });
});

describe('memory, Bash and compaction after a move', () => {
  test('a project note saved on the pc is recalled on the mac', async () => {
    const { t, d, svc } = await setup({ overrides: { memory: { enabled: true, autoExtract: false, autoInject: true, injectLimit: 5 } } as never });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.pc.home, [{ id: 'code-1', path: '~/code' }]);
    writeSyncthing(d.mac.home, [{ id: 'code-1', path: '~/Developer' }]);
    const s = await pcSession(t, svc, pcRepo);
    await t.engine.memory.save({ content: 'The portfolio site deploys with bun run deploy to Cloudflare Pages.', kind: 'procedure', scope: 'project', scopeKey: pcRepo });
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, cwd: macRepo });
    const moved = t.engine.requireSession(s.id);
    expect(t.engine.memoryProject(moved)).toEqual(expect.arrayContaining([macRepo, pcRepo, moved.projectId]));
    // the bare mac folder alone does not find it: the project keys do
    expect((await t.engine.memory.recall('how does the portfolio site deploy', { project: macRepo })).length).toBe(0);
    plan = [[{ text: 'noted' }]];
    await t.run(s.id, 'how does the portfolio site deploy');
    expect(t.requests.at(-1)).toContain('bun run deploy to Cloudflare Pages');
  });

  test('Bash that names the old folder gets a note; compaction lists files relative to the project', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.pc.home, [{ id: 'code-1', path: '~/code' }]);
    writeSyncthing(d.mac.home, [{ id: 'code-1', path: '~/Developer' }]);
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'bypass' });
    await svc.move(s.id, { device: 'mac' });
    plan = [[{ tool: 'Bash', input: { command: `ls ${pcRepo}` } }], [{ text: 'done' }]];
    await t.run(s.id, 'list the old folder');
    const bash = toolResults(t.engine, s.id).find((x) => x.name === 'Bash');
    expect(bash?.content).toContain(`Note: ${pcRepo} is where this session's folder was before it moved. On this device it is ${macRepo}.`);
    const moved = t.engine.requireSession(s.id);
    expect(svc.projectRoots(moved)).toEqual([macRepo, pcRepo]);
    const { filesTouched } = await import('../../src/session/compaction');
    const region = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: join(pcRepo, 'src', 'a.ts') } }, { type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: join(macRepo, 'README.md') } }, { type: 'tool_use', id: 'u3', name: 'Read', input: { file_path: '/etc/hosts' } }] }] as never;
    expect(filesTouched(region, [], svc.projectRoots(moved))).toEqual(['/etc/hosts', 'README.md', 'src/a.ts']);
  });
});

/** Run one user turn that writes `file` twice. */
async function runWrites(t: TestEngine, sessionId: string, file: string): Promise<void> {
  plan = [[{ tool: 'Write', input: { file_path: file, content: 'one' } }], [{ tool: 'Write', input: { file_path: file, content: 'two' } }], [{ text: 'done' }]];
  await t.run(sessionId, 'write it twice');
}
