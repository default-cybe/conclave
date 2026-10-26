/**
 * Repo sessions on a real engine (docs/DESIGN.md 30): a fake GitHub (local
 * bare repositories and a small API, fake-github.ts), two devices over the
 * local disk, and the scripted model. Nothing reaches the real GitHub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, until, type Step, type TestEngine } from '../engine/harness';
import { sh, twoDevices, type TwoDevices } from '../projects/machines';
import { githubOf } from '../../src/github';
import type { GithubService } from '../../src/github/service';
import { projectsOf } from '../../src/projects/registry';
import { pushScript, fetchScript, cloneScript, remoteFor, secureConfig, validBranch, committedBy, withCommittedBy } from '../../src/github/git';
import { slugify } from '../../src/github/service';
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

async function setup(opts: { http?: boolean; approve?: 'allow' | 'deny' } = {}) {
  plan = [];
  fake = new FakeGithub(TOKEN).start();
  fake.addRepo('acme', 'widgets', { description: 'Widgets for everyone' });
  fake.addRepo('acme', 'gadgets', { private: true, defaultBranch: 'trunk' });
  t = await startTestEngine({
    script: [[{ text: 'ok' }]],
    route: () => plan.shift(),
    approve: opts.approve ?? 'allow',
    overrides: { github: { apiUrl: fake.apiUrl, gitUrl: opts.http ? fake.httpGitUrl : fake.fileGitUrl, pollSeconds: 0 } } as never,
  });
  d = twoDevices(t.engine);
  const svc = githubOf(t.engine) as GithubService;
  expect(svc).toBeDefined();
  await svc.connect(TOKEN);
  return { t, d, fake, svc };
}

function gitIn(path: string, args: string): string {
  return sh(`git ${args}`, path);
}

/** Every file under a folder, .git included, as text. */
function allText(dir: string): string {
  let out = '';
  const walk = (p: string) => {
    for (const name of readdirSync(p)) {
      const f = join(p, name);
      const st = statSync(f);
      if (st.isDirectory()) walk(f);
      else if (st.size < 2_000_000) out += readFileSync(f, 'latin1');
    }
  };
  walk(dir);
  return out;
}

describe('the GitHub connection', () => {
  test('status says who the token is, repositories list and search, and a refused token is not saved', async () => {
    const { t, svc } = await setup();
    const st = await svc.status();
    expect(st).toMatchObject({ connected: true, source: 'secret', login: 'sam-rivera', name: 'Sam Rivera', repos: 2 });
    expect(JSON.stringify(st)).not.toContain(TOKEN);
    const all = await svc.repos();
    expect(all.map((r) => r.fullName).sort()).toEqual(['acme/gadgets', 'acme/widgets']);
    expect(all.find((r) => r.fullName === 'acme/gadgets')).toMatchObject({ private: true, defaultBranch: 'trunk', canPush: true });
    expect((await svc.repos('everyone')).map((r) => r.fullName)).toEqual(['acme/widgets']);
    expect(await svc.branches('acme/widgets')).toEqual({ defaultBranch: 'main', branches: ['main'] });
    await expect(svc.connect('ghp_wrong')).rejects.toThrow(/did not accept/);
    expect(t.engine.config.secretValue('github')).toBe(TOKEN);
    svc.disconnect();
    expect((await svc.status()).connected).toBe(false);
    await expect(svc.repos()).rejects.toThrow(/Connect GitHub first/);
  });

  test('the GitHub MCP server token (github-pat) connects too; disconnect leaves it; a saved "github" token wins', async () => {
    const { t, svc } = await setup();
    svc.disconnect();
    t.engine.config.setSecret('values', 'github-pat', TOKEN);
    expect(await svc.status()).toMatchObject({ connected: true, source: 'mcp', login: 'sam-rivera' });
    expect(svc.disconnect()).toEqual({ connected: false, source: 'mcp' });
    expect(t.engine.config.secretValue('github-pat')).toBe(TOKEN);
    await svc.connect(TOKEN);
    expect(await svc.status()).toMatchObject({ connected: true, source: 'secret' });
  });
});

describe('clones and worktrees', () => {
  test('one clone per repository per device, a worktree and branch per session, from a fresh base', async () => {
    const { t, d, fake, svc } = await setup();
    const s1 = await svc.startSession({ repo: 'acme/widgets', device: 'pc' });
    const r1 = svc.row(s1.id)!;
    expect(r1.clonePath).toBe(join(d.pc.home, 'repos', 'acme', 'widgets'));
    expect(r1.worktree.startsWith(join(d.pc.home, '.conclave', 'worktrees', 'gh', 'acme', 'widgets') + '/')).toBe(true);
    expect(r1.branch).toMatch(/^conclave\/session-[a-z2-9]{4}$/);
    expect(validBranch(r1.branch)).toBe(true);
    expect(s1).toMatchObject({ device: 'pc', cwd: r1.worktree });
    expect(gitIn(r1.worktree, 'symbolic-ref --short HEAD')).toBe(r1.branch);
    expect(gitIn(r1.worktree, 'rev-parse HEAD')).toBe(fake.branchSha('acme/widgets', 'main')!);
    expect(readFileSync(join(r1.worktree, 'src', 'app.ts'), 'utf8')).toContain('41');
    // the main clone has its default branch checked out
    expect(existsSync(join(r1.clonePath, 'README.md'))).toBe(true);
    expect(s1.meta?.repo).toEqual({ repo: 'acme/widgets', branch: r1.branch, base: 'main' });
    expect(t.engine.getMessages(s1.id).some((m) => JSON.stringify(m.content).includes('Working in a new worktree of acme/widgets'))).toBe(true);

    // someone pushes to main: the next session starts from the new commit, in the same clone
    const fresh = fake.commit('acme/widgets', 'main', 'NEW.md', 'new on GitHub');
    const s2 = await svc.startSession({ repo: 'acme/widgets', device: 'pc', title: 'Fix the login redirect!' });
    const r2 = svc.row(s2.id)!;
    expect(r2.clonePath).toBe(r1.clonePath);
    expect(r2.baseSha).toBe(fresh);
    expect(r2.branch).toMatch(/^conclave\/fix-the-login-redirect-[a-z2-9]{4}$/);
    expect(r2.worktree).not.toBe(r1.worktree);
    expect(existsSync(join(r2.worktree, 'NEW.md'))).toBe(true);
    expect(existsSync(join(r1.worktree, 'NEW.md'))).toBe(false);
    expect(readdirSync(join(d.pc.home, 'repos', 'acme'))).toEqual(['widgets']);
    // the worktree is a folder of the repository's project, as any session folder is
    const projects = projectsOf(t.engine)!;
    const s2now = t.engine.requireSession(s2.id);
    expect(s2now.projectId).toBeTruthy();
    expect(projects.store.locations(s2now.projectId!).some((l) => l.device === 'pc' && l.path === r2.worktree)).toBe(true);
    expect(t.engine.requireSession(s1.id).projectId).toBe(s2now.projectId);

    // another device keeps its own clone
    const s3 = await svc.startSession({ repo: 'acme/widgets', device: 'mac', base: 'main' });
    expect(svc.row(s3.id)!.clonePath).toBe(join(d.mac.home, 'repos', 'acme', 'widgets'));

    // a base the owner picks, and one that is not there
    sh(`git --git-dir=${fake.bare('acme/widgets')} branch release main`, '/');
    const s4 = await svc.startSession({ repo: 'acme/widgets', device: 'pc', base: 'release' });
    expect(svc.row(s4.id)).toMatchObject({ base: 'release', baseSha: fresh });
    await expect(svc.startSession({ repo: 'acme/widgets', device: 'pc', base: 'nope' })).rejects.toThrow(/has no branch nope/);
    await expect(svc.startSession({ repo: 'acme/nothing', device: 'pc' })).rejects.toThrow(/no repository acme\/nothing/);
    await expect(svc.startSession({ repo: 'not a repo' })).rejects.toThrow(/owner\/name/);
  });

  test('a folder the projects service knows for the repository is reused instead of a new clone', async () => {
    const { t, d, fake, svc } = await setup();
    const mine = join(d.pc.home, 'code', 'widgets');
    mkdirSync(join(d.pc.home, 'code'), { recursive: true });
    sh(`git clone -q ${fake.bare('acme/widgets')} ${mine} && git -C ${mine} remote set-url origin git@github.com:acme/widgets.git`, '/');
    const plain = await t.engine.createSession({ device: 'pc', cwd: mine });
    await projectsOf(t.engine)!.recordState(plain);
    const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc' });
    expect(svc.row(s.id)!.clonePath).toBe(mine);
    expect(existsSync(join(d.pc.home, 'repos'))).toBe(false);
    // the owner's folder keeps its branch and remote; the base sits under refs/conclave
    expect(gitIn(mine, 'symbolic-ref --short HEAD')).toBe('main');
    expect(gitIn(mine, 'config remote.origin.url')).toBe('git@github.com:acme/widgets.git');
    expect(gitIn(mine, 'rev-parse refs/conclave/base/main')).toBe(fake.branchSha('acme/widgets', 'main')!);
    // ~/repos/<owner>/<repo> that holds something else is refused, not overwritten
    const other = join(d.mac.home, 'repos', 'acme', 'widgets');
    mkdirSync(other, { recursive: true });
    await expect(svc.startSession({ repo: 'acme/widgets', device: 'mac' })).rejects.toThrow(/not a clone of acme\/widgets/);
  });
});

/** The scripted model edits a file in the worktree and commits it. */
function editAndCommit(file = 'src/app.ts', text = 'export const answer = 42;\n', message = 'Make the answer 42'): Step[] {
  return [[{ tool: 'Bash', input: { command: `printf '%s' ${JSON.stringify(text)} > ${file} && git add -A && ${GIT} commit -qm ${JSON.stringify(message)}` } }], [{ text: 'Committed.' }]];
}

describe('push, pull request, state and clean up', () => {
  // dozens of real git commands: a busy machine takes longer than the 5 s default
  test('push, open the pull request, follow its checks, and clean up after the merge', async () => {
    const { t, fake, svc } = await setup();
    const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc', title: 'Answer' });
    const row = svc.row(s.id)!;
    plan = editAndCommit();
    await t.run(s.id, 'make the answer 42');
    let dto = await svc.dto(s.id);
    expect(dto).toMatchObject({ commits: 1, dirty: 0, pushed: 'never', canCleanUp: false });
    expect(dto.line).toBe('1 commit, not pushed yet.');

    const pushed = await svc.push(s.id);
    expect(pushed).toMatchObject({ pushed: true, branch: row.branch, commits: 1 });
    expect(fake.branchSha('acme/widgets', row.branch)).toBe(pushed.sha);
    expect(fake.branchSha('acme/widgets', 'main')).toBe(row.baseSha);
    expect((await svc.push(s.id)).pushed).toBe(false);
    dto = await svc.dto(s.id);
    expect(dto).toMatchObject({ pushed: 'current', pushedSha: pushed.sha });

    const draft = await svc.draft(s.id);
    expect(draft).toMatchObject({ title: 'Make the answer 42', base: 'main', head: row.branch });
    expect(draft.body).toContain('Committed.');
    expect(draft.body).toContain('- Make the answer 42');

    dto = await svc.openPr(s.id, { title: draft.title, body: draft.body });
    expect(dto.pr).toEqual({ number: 1, url: 'https://github.com/acme/widgets/pull/1', state: 'open' });
    expect(fake.pulls[0]).toMatchObject({ head: row.branch, base: 'main', title: 'Make the answer 42', state: 'open' });
    await expect(svc.openPr(s.id, { title: 'again' })).rejects.toThrow(/already open/);

    fake.setChecks(pushed.sha, [{ name: 'test', status: 'in_progress' }]);
    await svc.refresh(s.id);
    expect((await svc.dto(s.id)).line).toBe('Pull request #1 is open. Checks are running.');
    fake.setChecks(pushed.sha, [{ name: 'test', status: 'completed', conclusion: 'success' }]);
    await svc.poll();
    expect(t.engine.requireSession(s.id).meta?.repo).toMatchObject({ pr: { number: 1, state: 'open' }, ci: 'success' });

    await expect(svc.cleanup(s.id)).rejects.toThrow(/still open/);
    fake.merge(1);
    await svc.poll();
    dto = await svc.dto(s.id);
    expect(dto).toMatchObject({ canCleanUp: true, pr: { state: 'merged' } });
    expect(t.engine.getMessages(s.id).some((m) => JSON.stringify(m.content).includes('Pull request #1 was merged'))).toBe(true);

    dto = await svc.cleanup(s.id);
    expect(dto).toMatchObject({ cleaned: true, canCleanUp: false, line: 'Cleaned up. The branch stays on GitHub.' });
    expect(existsSync(row.worktree)).toBe(false);
    expect(fake.branchSha('acme/widgets', row.branch)).toBe(pushed.sha);
    // the local branch went too: GitHub has it as it was
    expect(() => gitIn(row.clonePath, `rev-parse --verify -q refs/heads/${row.branch}`)).toThrow();
    expect(gitIn(row.clonePath, 'worktree list')).not.toContain(row.worktree);
    expect(t.engine.requireSession(s.id).meta?.repo).toMatchObject({ cleaned: true });
    // the worktree is no longer a folder of the project
    const pid = t.engine.requireSession(s.id).projectId!;
    expect(projectsOf(t.engine)!.store.locations(pid).some((l) => l.path === row.worktree)).toBe(false);
    // and the session no longer offers the tool
    const tools = t.engine.runnerExtensions.toolList(t.engine.requireSession(s.id), [], 0);
    expect(tools.map((x) => x.name)).not.toContain('PullRequest');
  }, 30_000);

  test('the model asks through PullRequest, and the owner approves every call, even in bypass mode', async () => {
    const { t, fake, svc } = await setup();
    const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc', permissionMode: 'bypass' });
    const row = svc.row(s.id)!;
    expect(t.engine.runnerExtensions.toolList(t.engine.requireSession(s.id), [], 0).map((x) => x.name)).toEqual(['PullRequest']);
    plan = [
      ...editAndCommit().slice(0, 1),
      [{ tool: 'PullRequest', input: { action: 'open', title: 'Make the answer 42', body: 'It was 41.' } }],
      [{ tool: 'PullRequest', input: { action: 'status' } }],
      [{ text: 'Opened.' }],
    ];
    await t.run(s.id, 'make the answer 42 and open a pull request');
    expect(t.approvals.filter((a) => a.startsWith('Open a pull request on acme/widgets'))).toHaveLength(1);
    expect(t.approvals.some((a) => a.includes(`from ${row.branch} into main: Make the answer 42`))).toBe(true);
    const results = toolResults(t.engine, s.id).filter((r) => r.name === 'PullRequest');
    expect(results[0].content).toContain('Opened pull request #1: https://github.com/acme/widgets/pull/1');
    expect(results[1].content).toContain('Pull request #1 is open.');
    expect(fake.pulls).toHaveLength(1);
    // the worktree line before the first message does not keep the session from its title
    await until(() => t.engine.requireSession(s.id).title !== 'New chat');
    expect(t.engine.requireSession(s.id).title).toBe('ok');
    // subagents never get the tool
    expect(t.engine.runnerExtensions.toolList(t.engine.requireSession(s.id), [], 1).map((x) => x.name)).toEqual([]);
  });

  test('a no from the owner pushes nothing', async () => {
    const { t, fake, svc } = await setup({ approve: 'deny' });
    const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc', permissionMode: 'bypass' });
    const row = svc.row(s.id)!;
    plan = [...editAndCommit().slice(0, 1), [{ tool: 'PullRequest', input: { action: 'push' } }], [{ text: 'ok' }]];
    await t.run(s.id, 'push it');
    expect(toolResults(t.engine, s.id).find((r) => r.name === 'PullRequest')).toMatchObject({ isError: true });
    expect(toolResults(t.engine, s.id).find((r) => r.name === 'PullRequest')!.content).toContain('The owner said no');
    expect(fake.branchSha('acme/widgets', row.branch)).toBeUndefined();
  });

  // dozens of real git commands: a busy machine takes longer than the 5 s default
  test('refusals: nothing to push, the default branch, no force push, another branch, uncommitted files', async () => {
    const { t, fake, svc } = await setup();
    const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc' });
    const row = svc.row(s.id)!;
    await expect(svc.push(s.id)).rejects.toThrow(/no commits on conclave\/.* beyond main yet/);

    // the hub pushes only to the session's own branch: a row that names the default branch is refused
    svc.store.update(s.id, { branch: 'main' });
    await expect(svc.push(s.id)).rejects.toThrow(/never pushes to the default branch \(main\)/);
    svc.store.update(s.id, { branch: row.branch });

    plan = editAndCommit();
    await t.run(s.id, 'edit');
    const first = await svc.push(s.id);
    // a rewritten branch would need a force push: refused, and GitHub keeps what it had
    sh(`${GIT} commit -q --amend -m 'Rewritten'`, row.worktree);
    await expect(svc.push(s.id)).rejects.toThrow(/never force pushes/);
    expect(fake.branchSha('acme/widgets', row.branch)).toBe(first.sha);

    // the worktree moved to another branch
    sh('git checkout -q -b elsewhere', row.worktree);
    await expect(svc.push(s.id)).rejects.toThrow(/on elsewhere, not on conclave\//);
    sh(`git checkout -q ${row.branch} && git reset -q --hard ${first.sha}`, row.worktree);

    // uncommitted files: a push says so; with a message the hub commits them first
    sh('echo more >> README.md', row.worktree);
    const dto = await svc.dto(s.id);
    expect(dto.line).toContain('1 file is not committed.');
    const second = await svc.push(s.id, { commitMessage: 'Add more' });
    expect(second).toMatchObject({ pushed: true, committed: 1, commits: 2 });
    expect(gitIn(row.worktree, 'log -1 --format=%an')).toBe('Sam Rivera');
    // the person is the only author; the message names Conclave and the session's model, no AI co-author
    const body = gitIn(row.worktree, 'log -1 --format=%B');
    expect(body).toBe(`Add more\n\nCommitted-by: Conclave (${t!.engine.requireSession(s.id).model})`);
    expect(body).not.toMatch(/co-authored-by/i);

    // clean up keeps uncommitted work unless forced
    const pr = (await svc.openPr(s.id, { title: 'More' })).pr!.number;
    fake.close(pr);
    await svc.refresh(s.id);
    expect((await svc.dto(s.id)).line).toBe('Pull request #1 was closed without a merge. Clean up removes the worktree.');
    sh(`echo later >> README.md && git add -A && ${GIT} commit -qm Later && echo dirty >> README.md`, row.worktree);
    const later = gitIn(row.worktree, 'rev-parse HEAD');
    await expect(svc.cleanup(s.id)).rejects.toThrow(/1 file in the worktree is not committed/);
    const done = await svc.cleanup(s.id, { force: true });
    expect(done.cleaned).toBe(true);
    expect(existsSync(row.worktree)).toBe(false);
    // a commit GitHub does not have keeps the local branch
    expect(gitIn(row.clonePath, `rev-parse refs/heads/${row.branch}`)).toBe(later);
    expect(fake.branchSha('acme/widgets', row.branch)).toBe(second.sha);
  }, 30_000);

  test('deleting a session removes a clean worktree', async () => {
    const { t, svc } = await setup();
    const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc' });
    const row = svc.row(s.id)!;
    await t.engine.deleteSession(s.id);
    await svc.settled();
    expect(existsSync(row.worktree)).toBe(false);
    expect(svc.row(s.id)).toBeUndefined();
  });
});

describe('the token stays out of reach', () => {
  test('git over https gets it from the hub for one command; the shell, files, transcripts and logs never see it', async () => {
    const lines: string[] = [];
    const saved = { log: console.log, error: console.error, warn: console.warn };
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' '));
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    process.env.CONCLAVE_GITHUB_TOKEN = `${TOKEN}-env`;
    try {
      const { t, fake, svc } = await setup({ http: true });
      const s = await svc.startSession({ repo: 'acme/widgets', device: 'pc', permissionMode: 'bypass' });
      const row = svc.row(s.id)!;
      const secrets = join(t.home, 'secrets.json');
      plan = [
        [{ tool: 'Bash', input: { command: 'env; git config --list --show-origin; cat .git; git remote -v' } }],
        [{ tool: 'Bash', input: { command: `cat ${secrets}` } }],
        [{ tool: 'Read', input: { file_path: secrets } }],
        [{ tool: 'Grep', input: { pattern: 'github', path: t.home, output_mode: 'content' } }],
        ...editAndCommit().slice(0, 1),
        [{ tool: 'PullRequest', input: { action: 'open', title: 'Answer', body: 'Done.' } }],
        [{ tool: 'Bash', input: { command: 'git log --oneline -3; env | grep -i -e token -e github || true' } }],
        [{ text: 'done' }],
      ];
      await t.run(s.id, 'look around, then ship it');
      const results = toolResults(t.engine, s.id);
      expect(results.find((r) => r.name === 'PullRequest')!.content).toContain('Opened pull request #1');
      // the clone, the push and the pull request went through with the token
      expect(fake.requests.some((r) => r.path.includes('git-receive-pack') && r.auth?.startsWith('Basic '))).toBe(true);
      expect(fake.branchSha('acme/widgets', row.branch)).toBeTruthy();
      // the shell never had it, and reading the secrets file is refused
      const env = results[0].content;
      expect(env).toContain('HOME=');
      expect(env).not.toContain(TOKEN);
      expect(results[1].content).toContain('Refused');
      expect(results[2].content).toContain('Refused');
      for (const r of results) expect(r.content).not.toContain(TOKEN);
      // not in the transcript, what the model was sent, the session or its audit
      expect(JSON.stringify(t.engine.getMessages(s.id))).not.toContain(TOKEN);
      expect(t.requests.join('\n')).not.toContain(TOKEN);
      expect(JSON.stringify(t.engine.requireSession(s.id))).not.toContain(TOKEN);
      expect(JSON.stringify(t.engine.repos.db.query('SELECT * FROM audit').all())).not.toContain(TOKEN);
      // not in any file of the clone or the worktree, .git included
      expect(allText(row.clonePath)).not.toContain(TOKEN);
      expect(allText(row.worktree)).not.toContain(TOKEN);
      // not in a URL or a body GitHub saw, and not in the hub's log
      expect(fake.tokenOutsideAuth()).toEqual([]);
      expect(lines.join('\n')).not.toContain(TOKEN);
    } finally {
      console.log = saved.log;
      console.error = saved.error;
      console.warn = saved.warn;
      delete process.env.CONCLAVE_GITHUB_TOKEN;
    }
  });

  test('the git scripts carry no token, push without force, and hold the helper to one host', () => {
    const remote = remoteFor('https://github.com', 'acme', 'widgets');
    const sha = 'a'.repeat(40);
    const scripts = [cloneScript(remote, '/home/k/repos/acme/widgets'), fetchScript(remote, '/x/objects', 'main', [sha]), pushScript(remote, '/x/objects', sha, 'conclave/fix-ab12')];
    for (const s of scripts) {
      expect(s).not.toContain(TOKEN);
      expect(s.startsWith('exec 3<&0 </dev/null')).toBe(true);
      expect(s).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    }
    const push = scripts[2];
    expect(push).toContain("'refs/heads/out:refs/heads/conclave/fix-ab12'");
    expect(push).not.toMatch(/--force|\+refs|--mirror|--delete/);
    expect(secureConfig(remote)).toContain('host=github.com');
    expect(secureConfig(remote)).toContain('-c credential.helper= ');
    expect(secureConfig(remote)).toContain('-c protocol.https.allow=always');
    expect(() => remoteFor('https://kai:ghp_x@github.com', 'acme', 'widgets')).toThrow(/user or password/);
    expect(validBranch('conclave/fix-ab12')).toBe(true);
    for (const bad of ['-x', 'a..b', 'a b', 'a/.b', 'x.lock', 'a//b', "a'b"]) expect(validBranch(bad)).toBe(false);
    expect(slugify('Fix the login redirect, please!')).toBe('fix-the-login-redirect-please');
    expect(slugify('Café ❤ 日本 déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('')).toBe('session');
  });
});

describe('commit trailers', () => {
  test('Committed-by names Conclave and the model, once, at the end of the message', () => {
    expect(committedBy('cliproxy/claude-opus-5-5')).toBe('Committed-by: Conclave (cliproxy/claude-opus-5-5)');
    expect(committedBy()).toBe('Committed-by: Conclave');
    expect(committedBy('  ')).toBe('Committed-by: Conclave');
    expect(withCommittedBy('Fix the login\n', 'openai/gpt-6')).toBe('Fix the login\n\nCommitted-by: Conclave (openai/gpt-6)');
    expect(withCommittedBy('Fix it\n\nWhy it broke.', 'a/b')).toBe('Fix it\n\nWhy it broke.\n\nCommitted-by: Conclave (a/b)');
    // an existing trailer block keeps one block, so git still reads every trailer in it
    expect(withCommittedBy('Fix it\n\nSigned-off-by: Sam <s@x>', 'a/b')).toBe('Fix it\n\nSigned-off-by: Sam <s@x>\nCommitted-by: Conclave (a/b)');
    // a message that has it already is left alone
    const done = 'Fix it\n\nCommitted-by: Conclave (a/b)';
    expect(withCommittedBy(done, 'c/d')).toBe(done);
    expect(withCommittedBy('Subject: with a colon', 'a/b')).toBe('Subject: with a colon\n\nCommitted-by: Conclave (a/b)');
  });
});
