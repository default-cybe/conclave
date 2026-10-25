/**
 * Move to hub and Move back (projects/hubcopy.ts) on a real engine with two
 * devices over the local disk. The hub's projects folder is a temp folder.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import { hubChanges, hubRoot, manifestOf } from '../../src/projects/hubcopy';
import type { HubCopyRecord } from '../../src/client/projects';
import type { EngineEventEnvelope } from '../../src/types';
import { makeRepo, twoDevices, type TwoDevices } from './machines';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;

afterEach(async () => {
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = undefined;
  d = undefined;
});

async function setup() {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  d = twoDevices(t.engine);
  const hub = join(d.base, 'hub-projects');
  t.engine.config.update({ projects: { hubRoot: hub } });
  const svc = projectsOf(t.engine) as ProjectsService;
  return { t, d, svc, hub };
}

/** A repo on pc with dotfiles, node_modules, a symlink, an executable and an old mtime. */
function makeProject(root: string): void {
  makeRepo(root);
  writeFileSync(join(root, '.env'), 'TOKEN=x\n');
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'app.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  symlinkSync('src/a.ts', join(root, 'link.ts'));
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(root, 'run.sh'), 0o755);
  utimesSync(join(root, 'README.md'), 1_600_000_000, 1_600_000_000);
}

async function pcSession(t: TestEngine, svc: ProjectsService, cwd: string) {
  const s = await t.engine.createSession({ device: 'pc', cwd });
  await svc.recordState(s);
  return t.engine.requireSession(s.id);
}

function record(t: TestEngine, id: string): HubCopyRecord | undefined {
  return t.engine.requireSession(id).meta?.hubCopy as HubCopyRecord | undefined;
}

describe('Move to hub', () => {
  test('copies the whole folder (dotfiles, node_modules, .git, symlinks, modes, mtimes) and runs the session there', async () => {
    const { t, d, svc, hub } = await setup();
    const root = join(d.pc.home, 'code', 'portfolio');
    makeProject(root);
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    const s = await pcSession(t, svc, join(root, 'src'));
    const r = await svc.move(s.id, { device: 'local', copy: true });
    expect(r.resolved).toBe(true);
    const target = join(hub, 'arch-desktop', 'portfolio');
    const now = t.engine.requireSession(s.id);
    expect(now).toMatchObject({ device: 'local', cwd: join(target, 'src') });
    for (const f of ['.env', '.git/HEAD', 'node_modules/left-pad/index.js', 'dist/app.bin', 'src/a.ts', 'README.md']) expect(readFileSync(join(target, f))).toEqual(readFileSync(join(root, f)));
    expect(existsSync(join(target, 'src', 'deep'))).toBe(true);
    expect(lstatSync(join(target, 'link.ts')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target, 'link.ts'))).toBe('src/a.ts');
    expect(statSync(join(target, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(Math.floor(statSync(join(target, 'README.md')).mtimeMs / 1000)).toBe(1_600_000_000);
    // the device folder is left as it was
    expect(existsSync(join(root, '.env'))).toBe(true);
    const rec = record(t, s.id)!;
    expect(rec).toMatchObject({ device: 'pc', deviceName: 'arch-desktop', root, rel: 'src', hubPath: target });
    const manifest = JSON.parse(readFileSync(rec.manifest, 'utf8')) as Array<{ p: string; h?: string; l?: string }>;
    expect(manifest.find((e) => e.p === '.env')?.h).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.find((e) => e.p === 'link.ts')?.l).toBe('src/a.ts');
    expect(manifest.some((e) => e.p === 'node_modules/left-pad/index.js')).toBe(true);
    // a second copy gets its own folder
    const s2 = await pcSession(t, svc, root);
    await svc.move(s2.id, { device: 'local', copy: true });
    expect(t.engine.requireSession(s2.id).cwd).toBe(`${target}-2`);
  });

  test('refuses when the hub has no room, and copies nothing', async () => {
    const { t, d, svc, hub } = await setup();
    const root = join(d.pc.home, 'code', 'portfolio');
    makeProject(root);
    const s = await pcSession(t, svc, root);
    svc.copies.freeSpace = () => 1024;
    await expect(svc.move(s.id, { device: 'local', copy: true })).rejects.toThrow(/has 1\.0 KB free\. Nothing was copied/);
    expect(existsSync(join(hub, 'arch-desktop', 'portfolio'))).toBe(false);
    expect(t.engine.requireSession(s.id).device).toBe('pc');
    expect((await svc.copies.preview(s.id)).fits).toBe(false);
  });

  test('cancel stops the copy and removes the partial copy', async () => {
    const { t, d, svc, hub } = await setup();
    const root = join(d.pc.home, 'big');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'a');
    // sparse on the source, real bytes in the stream
    writeFileSync(join(root, 'huge.bin'), '');
    truncateSync(join(root, 'huge.bin'), 4 * 1024 * 1024 * 1024);
    const s = await pcSession(t, svc, root);
    const off = t.engine.bus.on((e: EngineEventEnvelope) => {
      if (e.type === 'hubcopy.progress' && e.phase === 'copying') svc.copies.cancel(s.id);
    });
    const phases: string[] = [];
    const off2 = t.engine.bus.on((e: EngineEventEnvelope) => void (e.type === 'hubcopy.progress' && phases.push(e.phase)));
    await expect(svc.move(s.id, { device: 'local', copy: true })).rejects.toThrow(/cancelled/);
    off();
    off2();
    expect(phases.at(-1)).toBe('cancelled');
    expect(readdirSync(join(hub, 'arch-desktop'))).toEqual([]);
    expect(t.engine.requireSession(s.id).device).toBe('pc');
  });
});

describe('Move back', () => {
  test('the manifest finds added, changed and deleted files; a file only touched is unchanged', async () => {
    const { d } = await setup();
    const dir = join(d.base, 'm');
    mkdirSync(dir);
    for (const f of ['keep', 'edit', 'gone', 'touch']) writeFileSync(join(dir, f), f);
    const manifest = await manifestOf(dir);
    writeFileSync(join(dir, 'edit'), 'edited');
    rmSync(join(dir, 'gone'));
    writeFileSync(join(dir, 'new'), 'new');
    utimesSync(join(dir, 'touch'), 1_700_000_000, 1_700_000_000);
    expect(Object.fromEntries(await hubChanges(dir, manifest))).toEqual({ edit: 'changed', gone: 'deleted', new: 'added' });
  });

  test('marks conflicts, copies back only the chosen files and never deletes by default', async () => {
    const { t, d, svc } = await setup();
    const root = join(d.pc.home, 'code', 'portfolio');
    makeProject(root);
    const s = await pcSession(t, svc, root);
    await svc.move(s.id, { device: 'local', copy: true });
    const target = record(t, s.id)!.hubPath;
    // the hub's work
    writeFileSync(join(target, 'README.md'), 'hub readme\n');
    writeFileSync(join(target, 'src', 'a.ts'), 'hub a\n');
    writeFileSync(join(target, 'NEW.md'), 'new on hub\n');
    rmSync(join(target, 'run.sh'));
    // meanwhile on the device
    writeFileSync(join(root, 'src', 'a.ts'), 'device a, longer\n');

    const pre = await svc.copies.backPreview(s.id);
    expect(pre.online).toBe(true);
    const byPath = Object.fromEntries(pre.files.map((f) => [f.path, f]));
    expect(byPath['src/a.ts']).toMatchObject({ change: 'changed', conflict: true });
    expect(byPath['README.md']).toMatchObject({ change: 'changed', conflict: false });
    expect(byPath['README.md']!.diff).toContain('+hub readme');
    expect(byPath['NEW.md']).toMatchObject({ change: 'added', conflict: false });
    expect(byPath['run.sh']).toMatchObject({ change: 'deleted', conflict: false });
    expect(pre.conflicts).toBe(1);
    expect(pre.files[0]!.path).toBe('src/a.ts');

    const r = await svc.withMoveLock(s.id, () => svc.copies.back(s.id, { skipConflicts: true }));
    expect(r.resolved).toBe(true);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hub readme\n');
    expect(readFileSync(join(root, 'NEW.md'), 'utf8')).toBe('new on hub\n');
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('device a, longer\n');
    expect(existsSync(join(root, 'run.sh'))).toBe(true);
    expect(t.engine.requireSession(s.id)).toMatchObject({ device: 'pc', cwd: root });
    expect(record(t, s.id)).toBeUndefined();
  });

  test('copy back all overwrites conflicts and deletes only when asked', async () => {
    const { t, d, svc } = await setup();
    const root = join(d.pc.home, 'code', 'portfolio');
    makeProject(root);
    const s = await pcSession(t, svc, root);
    await svc.move(s.id, { device: 'local', copy: true });
    const target = record(t, s.id)!.hubPath;
    writeFileSync(join(target, 'src', 'a.ts'), 'hub a\n');
    rmSync(join(target, 'run.sh'));
    writeFileSync(join(root, 'src', 'a.ts'), 'device a, longer\n');
    await svc.withMoveLock(s.id, () => svc.copies.back(s.id, { deleteRemoved: true }));
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('hub a\n');
    expect(existsSync(join(root, 'run.sh'))).toBe(false);
  });
});

test('hubRoot: the configured folder, ~ expanded, else a folder under home', () => {
  expect(hubRoot('~/big', '/home/k')).toBe('/home/k/big');
  expect(hubRoot('/mnt/x/', '/home/k')).toBe('/mnt/x');
  if (!existsSync('/srv/conclave-projects')) expect(hubRoot(undefined, '/home/k')).toBe('/home/k/conclave-projects');
});
