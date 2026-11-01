/**
 * Code in a share to a friend (session/share-code.ts): which files count as
 * credentials, the diff that goes (no untracked, credential or binary
 * files), the git bundle (refused when a commit touched a credential), and
 * the receiving side, which puts the code on a new branch without touching
 * the working tree and without running a hook.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine } from '../../src/machine/local';
import { applyCode, collectDiff, collectGitBundle, credentialReason, friendBranch, planApply, runsCode, slug } from '../../src/session/share-code';

describe('credentialReason', () => {
  const yes = [
    '.env',
    '.env.local',
    'config/.env.production',
    '.envrc',
    'id_rsa',
    'keys/id_ed25519',
    'server.pem',
    'tls/private.key',
    'certs/store.p12',
    'prod.tfvars',
    'infra/x.tfvars.json',
    'terraform.tfstate',
    'infra/terraform.tfstate.backup',
    '.ssh/config',
    'home/.ssh/known_hosts',
    '.npmrc',
    '.netrc',
    '.git-credentials',
    '.aws/credentials',
    'credentials',
    'client_secret_123.apps.json',
    'secrets.yaml',
    'deploy/service-account.json',
    '.docker/config.json',
    '.kube/config',
    'auth.json',
    'vault.kdbx',
    'win\\.env',
  ];
  const no = ['.env.example', '.env.sample', 'id_rsa.pub', 'src/secret.ts', 'src/secrets.go', 'README.md', 'docs/keys.md', 'package.json', 'key.ts', 'monkey', 'src/env.ts', 'certs/ca.crt', 'config.json'];
  for (const p of yes) test(`${p} is a credential file`, () => expect(credentialReason(p)).toBeString());
  for (const p of no) test(`${p} is not`, () => expect(credentialReason(p)).toBeUndefined());
});

describe('names', () => {
  test('slugs and branches', () => {
    expect(slug('Fix flaky auth test!')).toBe('fix-flaky-auth-test');
    expect(slug('')).toBe('share');
    expect(slug('Ünïcode / spaces ', 10)).toBe('unicode-sp');
    expect(friendBranch("Alice's hub", 'Fix flaky auth test')).toBe('from-alice-s-hub/fix-flaky-auth-test');
  });

  test('files that can run code', () => {
    for (const p of ['package.json', '.husky/pre-commit', '.github/workflows/ci.yml', 'scripts/x.sh', 'Makefile', '.vscode/tasks.json', '.gitattributes']) expect(runsCode(p)).toBe(true);
    for (const p of ['src/a.ts', 'README.md', 'docs/x.json']) expect(runsCode(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const machine = new LocalMachine({ id: 'local', name: 'test' });
let dir: string;

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(['sh', '-c', cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A repository with one commit: a.ts, .env (tracked by mistake), logo.png. */
function repo(name: string): string {
  const r = join(dir, name);
  mkdirSync(r, { recursive: true });
  sh(r, 'git init -q -b main');
  writeFileSync(join(r, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(r, '.env'), 'TOKEN=old\n');
  writeFileSync(join(r, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  sh(r, 'git add -A && git commit -q -m base');
  return r;
}

/** A hook that leaves a mark when it runs. */
function trap(r: string, hook: string): string {
  const mark = join(r, `${hook}.ran`);
  const file = join(r, '.git', 'hooks', hook);
  writeFileSync(file, `#!/bin/sh\ntouch '${mark}'\n`);
  chmodSync(file, 0o755);
  return mark;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'conclave-share-code-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sending', () => {
  test('the diff: tracked changes with relative paths, no untracked, credential or binary files', async () => {
    const r = repo('send');
    mkdirSync(join(r, 'src'));
    writeFileSync(join(r, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(r, 'src', 'b.ts'), 'export const b = 1;\n');
    sh(r, 'git add src/b.ts');
    writeFileSync(join(r, '.env'), 'TOKEN=new-secret\n');
    writeFileSync(join(r, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    writeFileSync(join(r, 'untracked.ts'), 'not added\n');
    writeFileSync(join(r, 'id_rsa'), 'PRIVATE');
    // from a subfolder: paths are still the repository's
    const code = await collectDiff(machine, join(r, 'src'));
    expect(code.kind).toBe('diff');
    expect(code.files.sort()).toEqual(['a.ts', 'src/b.ts']);
    expect(code.excluded).toEqual(expect.arrayContaining([{ path: '.env', reason: expect.stringContaining('credential file') }, { path: 'logo.png', reason: 'binary file' }]));
    expect(code.diff).toContain('+++ b/a.ts');
    expect(code.diff).toContain('+++ b/src/b.ts');
    for (const bad of ['new-secret', 'untracked', 'PRIVATE', r]) expect(code.diff).not.toContain(bad);
    // nothing left behind in .git
    expect(sh(r, 'ls .git').split('\n').some((f) => f.startsWith('conclave-share'))).toBe(false);
  });

  test('the git bundle: commits after the upstream, refused when a commit touched a credential file', async () => {
    const r = repo('bundle');
    sh(r, 'git checkout -q -b feature');
    writeFileSync(join(r, 'a.ts'), 'export const a = 3;\n');
    sh(r, 'git commit -q -am "a is 3"');
    // without an upstream the whole branch goes; its first commit added .env
    await expect(collectGitBundle(machine, r)).rejects.toThrow('credential files (.env)');

    const clean = join(dir, 'bundle-clean');
    sh(dir, `git clone -q ${r} ${clean}`);
    sh(clean, 'git checkout -q -b topic origin/main');
    writeFileSync(join(clean, 'c.ts'), 'export const c = 1;\n');
    sh(clean, 'git add c.ts && git commit -q -m "add c" && git branch -q --set-upstream-to=origin/main');
    const code = await collectGitBundle(machine, clean);
    expect(code).toMatchObject({ kind: 'git-bundle', branch: 'topic', files: ['c.ts'] });
    expect(code.base).toMatch(/^[0-9a-f]{40}$/);
    expect(Buffer.from(code.data!, 'base64').toString('latin1')).toStartWith('# v2 git bundle');
  });
});

describe('receiving', () => {
  test('a diff lands on a new branch: no checkout, no change to the working tree, no hook', async () => {
    const src = repo('from');
    writeFileSync(join(src, 'a.ts'), 'export const a = 42;\n');
    const code = await collectDiff(machine, src);

    const dst = join(dir, 'to');
    sh(dir, `git clone -q ${src} ${dst}`);
    sh(dst, 'git config user.name Owner && git config user.email owner@x');
    const marks = ['reference-transaction', 'post-checkout', 'pre-commit', 'post-commit', 'pre-applypatch'].map((h) => trap(dst, h));
    writeFileSync(join(dst, 'wip.txt'), 'owner work in progress\n');

    const plan = await planApply(machine, dst, code, friendBranch('Alice', 'Fix a'));
    expect(plan).toMatchObject({ branch: 'from-alice/fix-a', files: ['a.ts'], check: { ok: true } });
    const done = await applyCode(machine, plan, code, { name: 'Alice (friend)', email: 'friend@conclave.invalid', message: "Fix a\n\nFrom Alice's hub." });
    expect(done.branch).toBe('from-alice/fix-a');
    expect(sh(dst, 'git rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(readFileSync(join(dst, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(readFileSync(join(dst, 'wip.txt'), 'utf8')).toBe('owner work in progress\n');
    expect(sh(dst, 'git show from-alice/fix-a:a.ts')).toBe('export const a = 42;\n');
    expect(sh(dst, 'git log -1 --format=%an from-alice/fix-a').trim()).toBe('Alice (friend)');
    expect(sh(dst, 'git status --porcelain').trim()).toBe('?? wip.txt');
    for (const m of marks) expect(existsSync(m)).toBe(false);

    // the same branch name again gets a number
    const again = await planApply(machine, dst, code, 'from-alice/fix-a');
    expect(again.branch).toBe('from-alice/fix-a-2');
  });

  test('a diff that does not fit says so in the plan', async () => {
    const src = repo('misfit-src');
    writeFileSync(join(src, 'a.ts'), 'export const a = 7;\n');
    const code = await collectDiff(machine, src);
    const dst = repo('misfit-dst');
    writeFileSync(join(dst, 'a.ts'), 'something else entirely\n');
    sh(dst, 'git commit -q -am other');
    const plan = await planApply(machine, dst, code, 'from-bob/x');
    expect(plan.check.ok).toBe(false);
    await expect(applyCode(machine, plan, code, { name: 'Bob', email: 'b@x', message: 'x' })).rejects.toThrow();
    expect(sh(dst, 'git branch --list from-bob/x').trim()).toBe('');
  });

  test('a git bundle is fetched into a new branch, hooks off', async () => {
    const src = repo('bsrc');
    const clone = join(dir, 'bclone');
    sh(dir, `git clone -q ${src} ${clone}`);
    sh(clone, 'git checkout -q -b topic origin/main');
    writeFileSync(join(clone, 'c.ts'), 'export const c = 1;\n');
    sh(clone, 'git add c.ts && git commit -q -m "add c" && git branch -q --set-upstream-to=origin/main');
    const code = await collectGitBundle(machine, clone);

    const dst = join(dir, 'bdst');
    sh(dir, `git clone -q ${src} ${dst}`);
    const mark = trap(dst, 'reference-transaction');
    const plan = await planApply(machine, dst, code, 'from-carol/add-c');
    expect(plan.check).toEqual({ ok: true });
    const done = await applyCode(machine, plan, code, { name: 'Carol', email: 'c@x', message: 'x' });
    expect(sh(dst, `git show ${done.branch}:c.ts`)).toBe('export const c = 1;\n');
    expect(sh(dst, 'git rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(existsSync(join(dst, 'c.ts'))).toBe(false);
    expect(existsSync(mark)).toBe(false);
  });
});
