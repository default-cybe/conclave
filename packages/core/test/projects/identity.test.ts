import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aliasHosts, compareIdentity, identifyFolder, normalizeRemote, parseIdentify } from '../../src/projects/identity';
import { prefixesOf } from '../../src/projects/store';
import { parseSyncthingConfig, syncthingFolderFor, syncthingFolders } from '../../src/machine/syncthing';
import type { FolderIdentity, ProjectIdentity } from '../../src/client/projects';
import { HomeMachine, cloneRepo, makeRepo, writeSyncthing } from './machines';
import { mapOldPath } from '../../src/tools/util';

const base = mkdtempSync(join(tmpdir(), 'conclave-ident-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('normalizeRemote', () => {
  test('one shape for every way to write a remote', () => {
    const want = 'github.com/kai/portfolio';
    for (const r of [
      'git@github.com:kai/portfolio.git',
      'https://github.com/kai/portfolio.git',
      'https://kai@GitHub.com:443/kai/portfolio',
      'ssh://git@github.com:22/kai/portfolio.git',
      'ssh://git@github.com/kai/portfolio/',
      'git://github.com/kai/portfolio.git',
    ]) {
      expect(normalizeRemote(r)).toBe(want);
    }
  });
  test('local paths are not remotes, and aliases resolve', () => {
    expect(normalizeRemote('/srv/git/portfolio.git')).toBeUndefined();
    expect(normalizeRemote('file:///srv/git/portfolio.git')).toBeUndefined();
    expect(normalizeRemote('../portfolio')).toBeUndefined();
    expect(normalizeRemote('gh:kai/portfolio.git', { gh: 'github.com' })).toBe('github.com/kai/portfolio');
    expect(aliasHosts(['gh:kai/x.git', 'git@github.com:kai/y.git', 'https://gitlab.com/a/b', 'ssh://work/repo'])).toEqual(['gh', 'work']);
  });
});

describe('compareIdentity', () => {
  const known: ProjectIdentity = { gitRoots: ['r1'], remotes: ['github.com/kai/portfolio'], shallow: false, head: 'abc1234' };
  const cand = (o: Partial<FolderIdentity>): FolderIdentity => ({ path: '/x/portfolio', exists: true, isGit: true, roots: ['r1'], remotes: ['github.com/kai/portfolio'], shallow: false, name: 'portfolio', ...o });
  test('levels', () => {
    expect(compareIdentity(known, 'portfolio', cand({})).level).toBe('exact');
    expect(compareIdentity(known, 'portfolio', cand({ remotes: [] })).level).toBe('strong');
    expect(compareIdentity(known, 'portfolio', cand({ roots: ['shallow-boundary'], shallow: true }), { headOnTarget: true })).toMatchObject({ level: 'strong', reason: 'head' });
    expect(compareIdentity(known, 'portfolio', cand({ roots: ['shallow-boundary'], shallow: true })).level).toBe('weak');
    expect(compareIdentity(known, 'portfolio', cand({ roots: ['other'], remotes: ['github.com/kai/other'] })).level).toBe('mismatch');
    expect(compareIdentity({ gitRoots: [], remotes: [], shallow: false }, 'portfolio', cand({ isGit: false, roots: [], remotes: [] })).level).toBe('weak');
    expect(compareIdentity({ gitRoots: [], remotes: [], shallow: false }, 'site', cand({ isGit: false, roots: [], remotes: [] })).level).toBe('none');
  });
  test('a marker or the same Syncthing folder is exact; markers that differ are a mismatch', () => {
    expect(compareIdentity({ ...known, marker: 'm1' }, 'p', cand({ marker: 'm1', roots: ['zzz'] })).level).toBe('exact');
    expect(compareIdentity({ ...known, marker: 'm1' }, 'p', cand({ marker: 'm2' })).level).toBe('mismatch');
    const st = { folderId: 'code', rel: 'portfolio' };
    expect(compareIdentity({ gitRoots: [], remotes: [], shallow: false, syncthing: st }, 'p', cand({ isGit: false, roots: [], remotes: [], syncthing: st })).level).toBe('exact');
  });
});

describe('identifyFolder on a real repo', () => {
  test('roots, head, remotes, the folder inside the repo, Syncthing and a missing folder', async () => {
    const home = join(base, 'h1');
    const repo = join(home, 'code', 'portfolio');
    const head = makeRepo(repo);
    writeSyncthing(home, [{ id: 'code-xyz', label: 'code', path: '~/code' }]);
    const m = new HomeMachine('pc', 'pc', home);
    const probe = await identifyFolder(m, join(repo, 'src'), { syncthing: await m.syncthingFolders() });
    expect(probe.exists).toBe(true);
    expect(probe.isGit).toBe(true);
    expect(probe.head).toBe(head);
    expect(probe.roots).toHaveLength(1);
    expect(probe.remotes).toEqual(['github.com/kai/portfolio']);
    expect(probe.rel).toBe('src');
    expect(probe.name).toBe('portfolio');
    expect(probe.syncthing).toEqual({ folderId: 'code-xyz', rel: 'portfolio' });
    expect(probe.dirty).toBe(0);
    const missing = await identifyFolder(m, join(home, 'nope'));
    expect(missing.exists).toBe(false);
  });

  test('a shallow clone says so and keeps HEAD', async () => {
    const src = join(base, 'h2', 'src');
    makeRepo(src);
    const dest = join(base, 'h2', 'shallow');
    cloneRepo(src, dest, { shallow: true });
    const m = new HomeMachine('mac', 'mac', join(base, 'h2'));
    const probe = await identifyFolder(m, dest);
    expect(probe.shallow).toBe(true);
    expect(probe.remotes).toEqual(['github.com/kai/portfolio']);
  });

  test('parseIdentify reads the script output', () => {
    const p = parseIdentify('__CONCLAVE_ID__ok\npwd=/a/b/c\ntop=/a/b\nshallow=false\nhead=0123456789abcdef0123456789abcdef01234567\nbranch=main\nroot=r2\nroot=r1\nremote=git@x.org:a/b\ndirty=3\npkg=site', '/a/b/c');
    expect(p).toMatchObject({ exists: true, isGit: true, toplevel: '/a/b', rel: 'c', roots: ['r1', 'r2'], branch: 'main', dirty: 3, name: 'b', packageName: 'site' });
    expect(parseIdentify('__CONCLAVE_ID__missing', '/q').exists).toBe(false);
  });
});

describe('Syncthing config.xml', () => {
  test('keeps folder id, label, path and paused; finds the folder that holds a path', async () => {
    const home = join(base, 'h3');
    writeSyncthing(home, [
      { id: 'code', path: '~/code' },
      { id: 'notes', label: 'Notes', path: join(home, 'notes'), paused: true },
    ]);
    const folders = await syncthingFolders(home, {});
    expect(folders).toEqual([
      { id: 'code', label: 'code', path: join(home, 'code'), paused: false },
      { id: 'notes', label: 'Notes', path: join(home, 'notes'), paused: true },
    ]);
    // nothing that leaves the device carries the API key
    expect(JSON.stringify(folders)).not.toContain('SECRET');
    expect(syncthingFolderFor(folders, join(home, 'code', 'site', 'web'))).toMatchObject({ folder: { id: 'code' }, rel: 'site/web' });
    expect(syncthingFolderFor(folders, join(home, 'elsewhere'))).toBeUndefined();
  });
  test('attribute paused, entities and a missing config', async () => {
    const parsed = parseSyncthingConfig('<configuration><folder id="a&amp;b" label="A" path="/x/y/" paused="true"></folder></configuration>', '/home/k');
    expect(parsed.folders).toEqual([{ id: 'a&b', label: 'A', path: '/x/y', paused: true }]);
    expect(await syncthingFolders(join(base, 'no-such-home'), {})).toEqual([]);
  });
});

describe('path pairs and old paths', () => {
  test('one confirmed pair teaches the parent prefixes', () => {
    expect(prefixesOf('/home/kai/code/portfolio', '/Users/kai/Developer/portfolio')).toEqual({ from: '/home/kai/code', to: '/Users/kai/Developer' });
    expect(prefixesOf('/home/kai/code/site', '/home/kai/code/site')).toBeUndefined();
  });
  test('mapOldPath maps under an old root and records it', () => {
    const ctx = { pathMap: { roots: [{ from: '/home/kai/code/portfolio', to: '/Users/kai/Developer/portfolio' }], hits: [] as string[] } };
    expect(mapOldPath(ctx, '/home/kai/code/portfolio/src/a.ts')).toBe('/Users/kai/Developer/portfolio/src/a.ts');
    expect(mapOldPath(ctx, '/home/kai/code/portfolio-old/a.ts')).toBe('/home/kai/code/portfolio-old/a.ts');
    expect(ctx.pathMap.hits).toEqual(['/home/kai/code/portfolio']);
  });
});
