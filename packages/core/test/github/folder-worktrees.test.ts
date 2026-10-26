/**
 * "Run in a worktree" on any git folder (docs/DESIGN.md 30): the same repo
 * session code as GitHub, on a temp repository of a device over the local
 * disk. Merge, its refusals, Discard and the status line; Open pull request
 * through the fake GitHub when the folder's origin is on GitHub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type Step, type TestEngine } from '../engine/harness';
import { sh, twoDevices, type TwoDevices } from '../projects/machines';
import { githubOf } from '../../src/github';
import { githubName, type GithubService } from '../../src/github/service';
import { projectsOf } from '../../src/projects/registry';
import { FakeGithub } from './fake-github';

const TOKEN = 'github_pat_11FAKE0TOKEN0never0leaks0x9Qz';
const GIT = 'git -c user.email=agent@test -c user.name=Agent -c commit.gpgsign=false';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;
let fake: FakeGithub | undefined;
let plan: Step[] = [];

afterEach(async () => {
  await (t && githubOf(t.engine))?.settled();
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  fake?.stop();
  t = undefined;
  d = undefined;
  fake = undefined;
});

async function setup() {
  plan = [];
  fake = new FakeGithub(TOKEN).start();
  fake.addRepo('acme', 'widgets');
  t = await startTestEngine({
    script: [[{ text: 'ok' }]],
    route: () => plan.shift(),
    approve: 'allow',
    overrides: { github: { apiUrl: fake.apiUrl, gitUrl: fake.fileGitUrl, pollSeconds: 0 } } as never,
  });
  d = twoDevices(t.engine);
  const svc = githubOf(t.engine) as GithubService;
  // a repository of the owner's on pc, with no remote
  const repo = join(d.pc.home, 'code', 'app');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  sh(`git init -q -b main && ${GIT} add -A && ${GIT} commit -qm first`, repo);
  return { t, d, fake, svc, repo };
}

/** The scripted model writes a file in its worktree and commits it. */
function commitStep(file: string, text: string, message: string): Step[] {
  return [[{ tool: 'Bash', input: { command: `printf '%s' ${JSON.stringify(text)} > ${file} && git add -A && ${GIT} commit -qm ${JSON.stringify(message)}` } }], [{ text: 'Committed.' }]];
}

describe('Run in a worktree on a git folder', () => {
  test('a worktree per session outside the repository, from the current branch; the folder is left alone', async () => {
    const { t, d, svc, repo } = await setup();
    expect(await svc.folderGit('pc', '~/code/app/src')).toEqual({ git: true, root: repo, branch: 'main' });
    expect(await svc.folderGit('pc', '~')).toEqual({ git: false });
    await expect(svc.startFolderSession({ folder: '~', device: 'pc' })).rejects.toThrow(/not in a git repository/);

    const s1 = await svc.startFolderSession({ folder: '~/code/app/src', device: 'pc', title: 'Fix login' });
    const s2 = await svc.startFolderSession({ folder: repo, device: 'pc' });
    const r1 = svc.row(s1.id)!;
    const r2 = svc.row(s2.id)!;
    expect(r1).toMatchObject({ source: 'folder', clonePath: repo, base: 'main', baseSha: sh('git rev-parse HEAD', repo), repo: 'app', url: '' });
    expect(r1.branch).toMatch(/^conclave\/fix-login-[a-z2-9]{4}$/);
    expect(r1.worktree.startsWith(join(d.pc.home, '.conclave', 'worktrees', 'dir') + '/')).toBe(true);
    expect(r1.worktree.startsWith(repo + '/')).toBe(false);
    expect(r2.worktree).not.toBe(r1.worktree);
    expect(s1).toMatchObject({ device: 'pc', cwd: r1.worktree });
    expect(sh('git symbolic-ref --short HEAD', r1.worktree)).toBe(r1.branch);
    expect(t.engine.requireSession(s1.id).meta?.repo).toEqual({ repo: 'app', branch: r1.branch, base: 'main', folder: true });
    // the main checkout keeps its branch and has nothing new
    expect(sh('git symbolic-ref --short HEAD', repo)).toBe('main');
    expect(sh('git status --porcelain', repo)).toBe('');
    // no GitHub remote: no PullRequest tool, no pull requests
    expect(t.engine.runnerExtensions.toolList(t.engine.requireSession(s1.id), [], 0).map((x) => x.name)).toEqual([]);
    expect(await svc.dto(s1.id)).toMatchObject({ pullRequests: false, canMerge: false, commits: 0, dirty: 0, line: 'No commits yet.' });
    await expect(svc.push(s1.id)).rejects.toThrow(/no origin on GitHub/);
  });

  test('status counts, then a clean merge refused while anything is uncommitted, then Clean up', async () => {
    const { t, svc, repo } = await setup();
    const s = await svc.startFolderSession({ folder: repo, device: 'pc' });
    const row = svc.row(s.id)!;
    plan = commitStep('app.ts', 'export const answer = 42;\n', 'Make the answer 42');
    await t.run(s.id, 'make the answer 42');
    expect(await svc.dto(s.id)).toMatchObject({ commits: 1, dirty: 0, canMerge: true, canCleanUp: false, line: '1 commit ahead of main.' });

    // uncommitted in the worktree: counted, and the merge waits for it
    writeFileSync(join(row.worktree, 'notes.txt'), 'wip\n');
    writeFileSync(join(row.worktree, 'README.md'), 'changed\n');
    expect((await svc.dto(s.id)).line).toBe('1 commit ahead of main. 2 files are not committed.');
    await expect(svc.merge(s.id)).rejects.toThrow(/2 files in the worktree are not committed/);
    sh('git checkout -q -- README.md && rm notes.txt', row.worktree);

    // uncommitted in the main checkout: refused, and nothing there moves
    writeFileSync(join(repo, 'README.md'), 'mine\n');
    const before = sh('git rev-parse HEAD', repo);
    await expect(svc.merge(s.id)).rejects.toThrow(/main checkout at .* has 1 uncommitted change/);
    expect(sh('git rev-parse HEAD', repo)).toBe(before);
    sh('git checkout -q -- README.md', repo);
    // nor on another branch there
    sh('git checkout -q -b other', repo);
    await expect(svc.merge(s.id)).rejects.toThrow(/is on other, not on main/);
    sh('git checkout -q main', repo);

    const dto = await svc.merge(s.id);
    expect(dto).toMatchObject({ merged: true, canMerge: false, canCleanUp: true });
    expect(dto.line).toBe(`Merged into main. Clean up removes the worktree and ${row.branch}.`);
    expect(sh('cat app.ts', repo)).toContain('42');
    expect(sh('git log -1 --format=%s', repo)).toBe('Make the answer 42');
    await expect(svc.merge(s.id)).rejects.toThrow(/already merged/);

    const done = await svc.cleanup(s.id);
    expect(done).toMatchObject({ cleaned: true, line: 'Merged into main and cleaned up.' });
    expect(existsSync(row.worktree)).toBe(false);
    expect(() => sh(`git rev-parse --verify -q refs/heads/${row.branch}`, repo)).toThrow();
  }, 30_000);

  test('a squash merge makes one commit; a conflicting merge is refused and undone', async () => {
    const { t, svc, repo } = await setup();
    const a = await svc.startFolderSession({ folder: repo, device: 'pc', title: 'Two commits' });
    plan = [...commitStep('a.txt', 'a\n', 'Add a').slice(0, 1), ...commitStep('b.txt', 'b\n', 'Add b')];
    await t.run(a.id, 'two commits');
    const before = Number(sh('git rev-list --count HEAD', repo));
    await svc.merge(a.id, { squash: true });
    expect(Number(sh('git rev-list --count HEAD', repo))).toBe(before + 1);
    expect(sh('git log -1 --format=%B', repo)).toMatch(/^Two commits\n\nCommitted-by: Conclave/);
    expect(sh('ls', repo)).toContain('b.txt');

    // the main checkout and the branch change the same line
    const b = await svc.startFolderSession({ folder: repo, device: 'pc' });
    plan = commitStep('README.md', 'from the session\n', 'Session readme');
    await t.run(b.id, 'edit readme');
    sh(`printf 'from the owner\\n' > README.md && ${GIT} commit -qam 'Owner readme'`, repo);
    const head = sh('git rev-parse HEAD', repo);
    await expect(svc.merge(b.id)).rejects.toThrow(/conflicts with main .* Nothing was merged/);
    expect(sh('git rev-parse HEAD', repo)).toBe(head);
    expect(sh('git status --porcelain', repo)).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    await expect(svc.merge(b.id, { squash: true })).rejects.toThrow(/conflicts with main/);
    expect(sh('git status --porcelain', repo)).toBe('');
    expect((await svc.dto(b.id)).merged).toBeUndefined();
  }, 30_000);

  test('Discard asks first when files are not committed, then drops the worktree and the branch', async () => {
    const { t, svc, repo } = await setup();
    const s = await svc.startFolderSession({ folder: repo, device: 'pc' });
    const row = svc.row(s.id)!;
    plan = commitStep('x.txt', 'x\n', 'Add x');
    await t.run(s.id, 'x');
    writeFileSync(join(row.worktree, 'wip.txt'), 'wip\n');
    // Clean up before a merge is refused; Discard without force asks about the file
    await expect(svc.cleanup(s.id)).rejects.toThrow(/not merged into main yet/);
    await expect(svc.cleanup(s.id, { discard: true })).rejects.toThrow(/1 file in the worktree is not committed.*discard with force/);
    expect(existsSync(join(row.worktree, 'wip.txt'))).toBe(true);
    const done = await svc.cleanup(s.id, { discard: true, force: true });
    expect(done).toMatchObject({ cleaned: true, line: 'Discarded. The worktree is gone.' });
    expect(existsSync(row.worktree)).toBe(false);
    expect(() => sh(`git rev-parse --verify -q refs/heads/${row.branch}`, repo)).toThrow();
    // the main checkout never saw the work
    expect(existsSync(join(repo, 'x.txt'))).toBe(false);
  }, 30_000);

  test('Discard still finishes when git removed the folder but not its .git/worktrees entry', async () => {
    const { t, d, svc, repo } = await setup();
    const s = await svc.startFolderSession({ folder: repo, device: 'pc' });
    const row = svc.row(s.id)!;
    plan = commitStep('x.txt', 'x\n', 'Add x');
    await t.run(s.id, 'x');
    // as on CI: a detached auto-maintenance writes into the entry while git deletes it
    const exec = d.pc.exec.bind(d.pc);
    d.pc.exec = (async (cmd: string, opts: never) => {
      if (!cmd.includes('worktree remove')) return exec(cmd, opts);
      sh(`rm -rf ${row.worktree}`, repo);
      return { exitCode: 255, stdout: '', stderr: `error: failed to delete '.git/worktrees/x': Directory not empty` };
    }) as typeof d.pc.exec;
    const done = await svc.cleanup(s.id, { discard: true });
    expect(done).toMatchObject({ cleaned: true });
    expect(sh('git worktree list --porcelain', repo)).not.toContain(row.worktree);
    expect(() => sh(`git rev-parse --verify -q refs/heads/${row.branch}`, repo)).toThrow();
  }, 30_000);

  test('a folder whose origin is on GitHub opens a pull request through the same code', async () => {
    const { t, d, fake, svc } = await setup();
    await svc.connect(TOKEN);
    const mine = join(d.pc.home, 'code', 'widgets');
    sh(`git clone -q ${fake.bare('acme/widgets')} ${mine} && git -C ${mine} remote set-url origin git@github.com:acme/widgets.git`, '/');
    expect(githubName('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(githubName('https://gitlab.com/acme/widgets')).toBeUndefined();
    const s = await svc.startFolderSession({ folder: mine, device: 'pc' });
    const row = svc.row(s.id)!;
    expect(row).toMatchObject({ repo: 'acme/widgets', url: 'https://github.com/acme/widgets', source: 'folder' });
    expect(t.engine.runnerExtensions.toolList(t.engine.requireSession(s.id), [], 0).map((x) => x.name)).toEqual(['PullRequest']);
    plan = commitStep('src/app.ts', 'export const answer = 42;\n', 'Make the answer 42');
    await t.run(s.id, 'edit');
    expect(await svc.dto(s.id)).toMatchObject({ pullRequests: true, canMerge: true });
    const dto = await svc.openPr(s.id, { title: 'Answer' });
    expect(dto.pr).toMatchObject({ number: 1, state: 'open' });
    expect(fake.pulls[0]).toMatchObject({ head: row.branch, base: 'main' });
  }, 30_000);
});
