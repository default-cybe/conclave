/**
 * Folders across devices, adversarial cases (QA of ROUND-IMPORT-PATHS-WORKFLOWS.md 2):
 * identity mismatches that must not merge into a project, secrets in remote
 * URLs, a pinned folder that changed, moves without files, offline path maps,
 * busy sessions, folders inside a repo, and where hub checkpoints live.
 * Real git repos on two devices over the local disk, and the scripted fake
 * model (no paid calls).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, until, type Step, type TestEngine } from '../engine/harness';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import { shadowDir } from '../../src/session/checkpoints';
import { parseSyncthingConfig } from '../../src/machine/syncthing';
import { cleanRemote, parseIdentify } from '../../src/projects/identity';
import { attach, cloneRepo, detach, makeRepo, sh, twoDevices, writeSyncthing, type TwoDevices } from './machines';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;

afterEach(async () => {
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = undefined;
  d = undefined;
});

let plan: Step[] = [];

async function setup(opts: Partial<Parameters<typeof startTestEngine>[0]> = {}) {
  plan = [];
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift(), ...opts });
  d = twoDevices(t.engine);
  const svc = projectsOf(t.engine) as ProjectsService;
  return { t, d, svc };
}

async function pcSession(t: TestEngine, svc: ProjectsService, cwd: string, extra: Record<string, unknown> = {}) {
  const s = await t.engine.createSession({ device: 'pc', cwd, ...extra });
  await svc.recordState(s);
  return t.engine.requireSession(s.id);
}

async function runWrites(t: TestEngine, sessionId: string, file: string): Promise<void> {
  plan = [[{ tool: 'Write', input: { file_path: file, content: 'one' } }], [{ tool: 'Write', input: { file_path: file, content: 'two' } }], [{ text: 'done' }]];
  await t.run(sessionId, 'write it twice');
}

const gateAsks = (t: TestEngine) => t.approvals.filter((a) => a.includes('since this session moved there'));

describe('identity is never merged from another repository', () => {
  test('Use once on a different repository leaves the project and its locations alone after a turn', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const other = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    makeRepo(other, 'git@github.com:someone/else.git');
    const s = await pcSession(t, svc, pcRepo);
    const before = structuredClone(svc.store.get(s.projectId!)!.identity);
    expect(await svc.move(s.id, { device: 'mac', cwd: other, allowMismatch: true })).toMatchObject({ resolved: true, level: 'mismatch' });
    plan = [[{ text: 'hello there' }]];
    await t.run(s.id, 'hi');
    await svc.settled();
    const after = svc.store.get(s.projectId!)!;
    expect(after.identity.gitRoots).toEqual(before.gitRoots);
    expect(after.identity.remotes).toEqual(before.remotes);
    expect(after.identity.head).toBe(before.head);
    expect(svc.store.locations(s.projectId!).map((l) => l.device)).toEqual(['pc']);
    expect(t.engine.requireSession(s.id).projectId).toBe(s.projectId);
  });

  test('freshness never compares the project with a folder of another history', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const other = join(d.mac.home, 'Developer', 'other');
    makeRepo(pcRepo);
    makeRepo(other, 'git@github.com:someone/else.git');
    const s = await pcSession(t, svc, pcRepo);
    const there = await svc.move(s.id, { device: 'mac', cwd: other, allowMismatch: true });
    expect(there).toMatchObject({ resolved: true, level: 'mismatch' });
    if (there.resolved) expect(there.freshness?.missingCommit).toBeUndefined();
    await svc.recordState(s.id);
    // back on the pc copy, which did not change: nothing to warn about
    const back = await svc.move(s.id, { device: 'pc' });
    expect(back).toMatchObject({ resolved: true, cwd: pcRepo, level: 'exact' });
    if (back.resolved) expect(back.freshness?.stale ?? false).toBe(false);
    const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notices.some((n) => n.includes('does not have the last commit'))).toBe(false);
  });

  test('a new working folder in another repository gets its own project at the end of a turn', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const site = join(d.pc.home, 'code', 'site');
    makeRepo(pcRepo);
    makeRepo(site, 'git@github.com:kai/site.git');
    const s = await pcSession(t, svc, pcRepo);
    const before = structuredClone(svc.store.get(s.projectId!)!.identity);
    t.engine.updateSession(s.id, { cwd: site });
    await svc.recordState(s.id);
    const now = t.engine.requireSession(s.id);
    expect(now.projectId).toBeTruthy();
    expect(now.projectId).not.toBe(s.projectId);
    expect(svc.store.get(s.projectId!)!.identity).toEqual(before);
    expect(svc.store.locations(s.projectId!).map((l) => l.path)).toEqual([pcRepo]);
    expect(svc.store.get(now.projectId!)!.identity.remotes).toEqual(['github.com/kai/site']);
  });

  test('a shallow copy does not replace the root commits the project knows', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'blog');
    const macRepo = join(d.mac.home, 'code', 'blog');
    makeRepo(pcRepo, 'git@github.com:kai/blog.git');
    cloneRepo(pcRepo, macRepo, { shallow: true, remote: 'git@github.com:kai/blog.git' });
    const s = await pcSession(t, svc, pcRepo);
    const roots = [...svc.store.get(s.projectId!)!.identity.gitRoots];
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, level: 'strong' });
    await svc.recordState(s.id);
    expect(svc.store.get(s.projectId!)!.identity).toMatchObject({ gitRoots: roots, shallow: false });
    // back on the full clone it is the same project, at exact
    expect(await svc.move(s.id, { device: 'pc' })).toMatchObject({ resolved: true, cwd: pcRepo, level: 'exact' });
  });
});

describe('secrets in remote URLs', () => {
  test('a token in an https remote is never stored, shown or sent', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    makeRepo(pcRepo, 'https://kai:ghp_SECRETTOKEN123@github.com/kai/portfolio.git');
    const s = await pcSession(t, svc, pcRepo);
    const p = svc.store.get(s.projectId!)!;
    expect(p.identity.remotes).toEqual(['github.com/kai/portfolio']);
    expect(p.identity.cloneUrl).toBe('https://github.com/kai/portfolio.git');
    const moved = await svc.move(s.id, { device: 'mac' });
    expect(moved).toMatchObject({ resolved: false, reason: 'not-found', cloneUrl: 'https://github.com/kai/portfolio.git' });
    const id = await svc.identify('pc', pcRepo);
    const all = JSON.stringify([svc.store.list(), svc.list(), moved, id, await svc.location(s.id)]);
    expect(all).not.toContain('SECRETTOKEN');
    expect(all).not.toContain('kai:ghp');
  });
});

describe('cleanRemote', () => {
  test('drops passwords and tokens, keeps an ssh user', () => {
    expect(cleanRemote('https://x-access-token:ghs_abc@github.com/kai/a.git')).toBe('https://github.com/kai/a.git');
    expect(cleanRemote('https://kai@gitlab.com/kai/a')).toBe('https://gitlab.com/kai/a');
    expect(cleanRemote('ssh://git:pw@host.lan:2222/kai/a.git')).toBe('ssh://git@host.lan:2222/kai/a.git');
    expect(cleanRemote('git@github.com:kai/a.git')).toBe('git@github.com:kai/a.git');
    expect(cleanRemote('/srv/git/a.git')).toBe('/srv/git/a.git');
    expect(parseIdentify('__CONCLAVE_ID__ok\ntop=/a\nremote=https://u:tok@h.io/a/b.git', '/a').rawRemotes).toEqual(['https://h.io/a/b.git']);
  });
});

describe('the write gate', () => {
  test('a pinned folder that now holds another repository asks before every write', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const pinned = join(d.mac.home, 'elsewhere', 'pf');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, pinned);
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'acceptEdits' });
    await svc.pin(s.projectId!, 'mac', pinned);
    // the folder is replaced by a different repository
    rmSync(pinned, { recursive: true, force: true });
    makeRepo(pinned, 'git@github.com:someone/else.git');
    // the pin still wins, but the banner says so and nothing is written without a yes
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r).toMatchObject({ resolved: true, via: 'pinned', level: 'mismatch', cwd: pinned });
    expect((await svc.location(s.id)).state).toBe('mismatch');
    await runWrites(t, s.id, join(pinned, 'notes.md'));
    expect(gateAsks(t)).toHaveLength(2);
  });

  test('a harness session in bypass mode still asks once after a move below exact', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
    const cfg = t.engine.config.get();
    t.engine.config.update({ providers: { ...cfg.providers, fake: { type: 'acp', command: process.execPath, args: [AGENT] } } });
    const pcRepo = join(d.pc.home, 'code', 'blog');
    const macRepo = join(d.mac.home, 'code', 'blog');
    makeRepo(pcRepo, 'git@github.com:kai/blog.git');
    cloneRepo(pcRepo, macRepo, { shallow: true, remote: 'git@github.com:kai/blog.git' });
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'bypass', model: 'fake/default' });
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, level: 'strong' });
    await t.run(s.id, 'ask-exec now');
    expect(gateAsks(t)).toHaveLength(1);
    const text = (n: number) => JSON.stringify(t.engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(n)?.content);
    expect(text(-1)).toContain('outcome:yes');
    // one yes covers the folder: the next turn runs in bypass again
    await t.run(s.id, 'ask-exec again');
    expect(gateAsks(t)).toHaveLength(1);
    expect(t.approvals).toHaveLength(1);
    expect(text(-1)).toContain('outcome:yes');
  });

  test('after the working folder changes, the gate of the last move does not ask for another folder', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'blog');
    const macRepo = join(d.mac.home, 'code', 'blog');
    const scratch = join(d.mac.home, 'scratch');
    makeRepo(pcRepo, 'git@github.com:kai/blog.git');
    cloneRepo(pcRepo, macRepo, { shallow: true, remote: 'git@github.com:kai/blog.git' });
    sh(`mkdir -p ${scratch}`);
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'acceptEdits' });
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, level: 'strong' });
    t.engine.updateSession(s.id, { cwd: scratch });
    await runWrites(t, s.id, join(scratch, 'notes.md'));
    expect(gateAsks(t)).toHaveLength(0);
  });
});

describe('moves without files and offline path maps', () => {
  test('Continue without files does not map old project paths into the home folder', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    makeRepo(pcRepo);
    writeFileSync(join(d.mac.home, 'README.md'), 'the mac home readme\n');
    const s = await pcSession(t, svc, pcRepo);
    expect(await svc.move(s.id, { device: 'mac', withoutFiles: true })).toMatchObject({ resolved: true, cwd: d.mac.home });
    plan = [[{ tool: 'Read', input: { file_path: join(pcRepo, 'README.md') } }], [{ text: 'done' }]];
    await t.run(s.id, 'read the readme');
    const res = toolResults(t.engine, s.id).find((x) => x.name === 'Read');
    expect(res?.content).not.toContain('the mac home readme');
    expect(res?.content).not.toContain('Conclave mapped');
  });

  test('after Continue without files, the same device can look for the folder again', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    const s = await pcSession(t, svc, pcRepo);
    expect(await svc.move(s.id, { device: 'mac', withoutFiles: true })).toMatchObject({ resolved: true, cwd: d.mac.home });
    // the banner keeps saying so, with a way back to the project's folder
    expect(await svc.location(s.id)).toMatchObject({ state: 'missing', exists: true, line: 'macbook has no folder for portfolio yet. This session works in ~ without the project files.' });
    // the owner clones it by hand, then picks the macbook again
    cloneRepo(pcRepo, macRepo);
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, cwd: macRepo, via: 'search', level: 'exact' });
  });

  test('the Syncthing line of an offline device says it is the last known state', async () => {
    const { t, d, svc } = await setup();
    writeSyncthing(d.mac.home, [{ id: 'dev', path: '~/Developer' }, { id: 'notes', path: '~/notes', paused: true }]);
    await svc.syncthing.folders('mac', d.mac, { refresh: true });
    detach(t.engine, 'mac');
    const f = await svc.deviceFolders('mac');
    expect(f.syncthing).toMatchObject({ available: true, line: '2 folders, 1 paused. Last known while macbook was online.' });
  });

  test('a path map read while the device is offline is read again once it is back', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, pcRepo);
    await svc.move(s.id, { device: 'mac', cwd: macRepo });
    const moved = t.engine.requireSession(s.id);
    expect(svc.pathMap(moved)).toEqual([expect.objectContaining({ from: pcRepo, to: macRepo })]);
    // a hub restart forgets the maps; the mac is offline at the first step
    (svc as unknown as { maps: Map<string, unknown> }).maps.clear();
    detach(t.engine, 'mac');
    await svc.refreshPathMap(moved);
    expect(svc.hasPathMap(moved)).toBe(false);
    attach(t.engine, d.mac);
    plan = [[{ tool: 'Read', input: { file_path: join(pcRepo, 'README.md') } }], [{ text: 'done' }]];
    await t.run(s.id, 'read it');
    expect(toolResults(t.engine, s.id).find((x) => x.name === 'Read')?.content).toContain(`Conclave mapped ${pcRepo} to ${macRepo}`);
  });
});

describe('what can be moved', () => {
  test('a session in the middle of a turn is not moved; a subagent session is not moved on its own', async () => {
    const { t, d, svc } = await setup({ approve: 'allow' });
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, pcRepo, { permissionMode: 'bypass' });
    plan = [[{ tool: 'Bash', input: { command: 'sleep 2' } }], [{ text: 'done' }]];
    const runner = t.engine.runnerFor(s.id);
    await runner.enqueue({ text: 'wait a bit' });
    expect(await until(() => t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_use' && b.name === 'Bash')))).toBe(true);
    await expect(svc.move(s.id, { device: 'mac', cwd: macRepo })).rejects.toThrow(/turn/i);
    await Promise.race([runner.waitIdle(), Bun.sleep(10_000)]);
    expect(t.engine.requireSession(s.id).device).toBe('pc');
    const child = await t.engine.createSession({ device: 'pc', cwd: pcRepo, parentId: s.id });
    await expect(svc.move(child.id, { device: 'mac', cwd: macRepo })).rejects.toThrow(/subagent/i);
  });
});

describe('path pairs from search', () => {
  test('a folder found by search under another name teaches no path pair', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio-v2');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, pcRepo);
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, via: 'search', cwd: macRepo });
    expect(svc.store.prefixes()).toEqual([]);
  });

  test('the same name found by search teaches the parent pair', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, pcRepo);
    expect(await svc.move(s.id, { device: 'mac' })).toMatchObject({ resolved: true, via: 'search', cwd: macRepo });
    expect(svc.store.prefixes()).toEqual([expect.objectContaining({ fromPrefix: join(d.pc.home, 'code'), toPrefix: join(d.mac.home, 'Developer') })]);
  });
});

describe('two moves at once', () => {
  test('a second move of the same session waits its turn', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, pcRepo);
    const both = await Promise.allSettled([svc.move(s.id, { device: 'mac', cwd: macRepo }), svc.move(s.id, { device: 'mac', cwd: macRepo })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const no = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(no.reason)).toContain('already moving');
    // one move row after the origin, one note
    expect(svc.store.moves(s.id)).toHaveLength(2);
    expect(t.engine.runnerFor(s.id).pendingNoteCount).toBe(1);
  });
});

describe('folders inside a repository', () => {
  test('a chosen folder inside the repo saves the repo root and learns the right path pair', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Work', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, join(pcRepo, 'src'));
    const r = await svc.move(s.id, { device: 'mac', cwd: join(macRepo, 'src') });
    expect(r).toMatchObject({ resolved: true, cwd: join(macRepo, 'src'), level: 'exact' });
    expect(svc.store.locations(s.projectId!).find((l) => l.device === 'mac')?.path).toBe(macRepo);
    expect(svc.store.prefixes()).toEqual([expect.objectContaining({ fromPrefix: join(d.pc.home, 'code'), toPrefix: join(d.mac.home, 'Work') })]);
    // pinning a folder inside the repo pins the repo
    const p = await svc.pin(s.projectId!, 'mac', join(macRepo, 'src'));
    expect(p.locations.filter((l) => l.device === 'mac').map((l) => l.path)).toEqual([macRepo]);
  });
});

describe('the banner and Syncthing', () => {
  test('a missing folder suggests another online device that has the project', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    const s = await pcSession(t, svc, pcRepo);
    await svc.pin(s.projectId!, 'mac', macRepo);
    rmSync(pcRepo, { recursive: true, force: true });
    const loc = await svc.location(s.id);
    expect(loc).toMatchObject({ state: 'missing', suggestion: { device: 'mac', cwd: macRepo } });
  });

  test('a session in the home folder ("~") is there; a folder that is gone is missing', async () => {
    const { t, d, svc } = await setup();
    makeRepo(d.pc.home);
    writeFileSync(join(d.pc.home, 'CLAUDE.md'), 'home rules\n');
    writeFileSync(join(d.pc.home, 'Cargo.toml'), '[package]\nname = "home"\n');
    const home = await t.engine.createSession({ device: 'pc', cwd: '~' });
    const s = t.engine.requireSession(home.id);
    expect(s.cwd).toBe('~');
    expect(await svc.location(home.id)).toMatchObject({ state: 'ok', exists: true });
    const parts = await t.engine.systemPromptParts(s, t.engine.agentFor(s), s.model, s.mode, ['Bash']);
    expect(parts.isGitRepo).toBe(true);
    expect(parts.testCommand).toBe('cargo test');
    expect(parts.projectInstructions.map((f) => f.path)).toContain(join(d.pc.home, 'CLAUDE.md'));
    const gone = await t.engine.createSession({ device: 'pc', cwd: '~/no-such-folder' });
    expect((await svc.location(gone.id)).state).toBe('missing');
  });

  test('a paused Syncthing folder on the target is part of the freshness line', async () => {
    const { t, d, svc } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'portfolio');
    const macRepo = join(d.mac.home, 'Developer', 'portfolio');
    makeRepo(pcRepo);
    cloneRepo(pcRepo, macRepo);
    writeSyncthing(d.pc.home, [{ id: 'code-1', path: '~/code' }]);
    writeSyncthing(d.mac.home, [{ id: 'code-1', path: '~/Developer', paused: true }]);
    const s = await pcSession(t, svc, pcRepo);
    const r = await svc.move(s.id, { device: 'mac' });
    expect(r).toMatchObject({ resolved: true, via: 'syncthing', freshness: { stale: true } });
    if (r.resolved) expect(r.freshness?.line).toContain('paused');
  });
});

describe('checkpoints on the hub', () => {
  test('live under the engine home, not the process home', async () => {
    const { t } = await setup();
    const s = await t.engine.createSession({ cwd: t.cwd });
    const dir = shadowDir(t.engine, s, t.engine.localMachine);
    expect(dir.startsWith(t.home)).toBe(true);
    expect(existsSync(join(t.home))).toBe(true);
  });
});

describe('a malformed config.xml', () => {
  test('thousands of folder tags that never close parse in linear time', () => {
    const bad = '<configuration>' + Array.from({ length: 4000 }, (_, i) => `<folder id="f${i}" path="/p${i}">` + 'x'.repeat(300)).join('');
    const t0 = performance.now();
    const parsed = parseSyncthingConfig(bad, '/home/k');
    expect(performance.now() - t0).toBeLessThan(300);
    // an unclosed tag still names its folder
    expect(parsed.folders).toHaveLength(4000);
    expect(parsed.folders[1]).toEqual({ id: 'f1', label: 'f1', path: '/p1', paused: false });
  });

  test('a config cut off halfway keeps the folders before the cut', () => {
    const xml = `<configuration><folder id="a" path="/a"><paused>true</paused></folder><folder id="b" path="/b"><pau`;
    expect(parseSyncthingConfig(xml, '/h').folders).toEqual([
      { id: 'a', label: 'a', path: '/a', paused: true },
      { id: 'b', label: 'b', path: '/b', paused: false },
    ]);
  });
});
