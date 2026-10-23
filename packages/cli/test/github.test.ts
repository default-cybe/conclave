/**
 * `conclave github` and the repo session commands of `conclave sessions`
 * against a real hub with a fake GitHub (docs/DESIGN.md 30).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, type Step, type TestEngine } from '../../core/test/engine/harness';
import { twoDevices, type TwoDevices } from '../../core/test/projects/machines';
import { FakeGithub } from '../../core/test/github/fake-github';
import { startServer, type RunningServer } from '../../server/src/app';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
const OWNER = 'owner-token-cli-github-0123456789';
const TOKEN = 'github_pat_11CLI0never0printed0x7';

let home: string;
let fake: FakeGithub;
let t: TestEngine;
let d: TwoDevices;
let running: RunningServer;
let plan: Step[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-github-cli-'));
  fake = new FakeGithub(TOKEN).start();
  fake.addRepo('acme', 'widgets', { description: 'Widgets for everyone' });
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift(), approve: 'allow', overrides: { github: { apiUrl: fake.apiUrl, gitUrl: fake.fileGitUrl, pollSeconds: 0 } } as never });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  d = twoDevices(t.engine);
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
  d?.cleanup();
  fake?.stop();
  rmSync(home, { recursive: true, force: true });
});

async function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { CONCLAVE_HUB: _hub, CONCLAVE_TOKEN: _token, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, ENTRY, ...args, '--hub', running.url, '--token', OWNER], {
    env: { ...env, CONCLAVE_HOME: home, NO_COLOR: '1' },
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe('conclave github and repo sessions', () => {
  test('login from stdin, status, repos, new, push, pr, cleanup', async () => {
    const before = await cli(['github', 'status']);
    expect(before.stdout).toContain('Not connected.');
    const login = await cli(['github', 'login'], `${TOKEN}\n`);
    expect(login.stderr).not.toContain(TOKEN);
    expect(login.stdout).toContain('Connected as @sam-rivera (Sam Rivera). It can see 1 repository.');
    expect(login.stdout).not.toContain(TOKEN);
    expect((await cli(['github', 'status'])).stdout).toContain('Connected as @sam-rivera');
    const repos = await cli(['github', 'repos', 'widgets']);
    expect(repos.stdout).toContain('acme/widgets');
    expect(repos.stdout).toContain('Widgets for everyone');

    const started = await cli(['sessions', 'new', '--repo', 'acme/widgets', '--device', 'pc', '--title', 'Answer', '--json']);
    expect(started.stderr).toBe('');
    const s = JSON.parse(started.stdout) as { id: string; cwd: string; meta: { repo: { branch: string } } };
    const branch = s.meta.repo.branch;
    expect(branch).toMatch(/^conclave\/answer-/);
    const ls = await cli(['sessions', 'ls']);
    expect(ls.stdout).toContain(`acme/widgets ${branch}`);

    plan = [[{ tool: 'Bash', input: { command: `printf 'export const answer = 42;\\n' > src/app.ts && git add -A && git -c user.email=a@b -c user.name=A commit -qm 'Make the answer 42'` } }], [{ text: 'Done.' }]];
    await t.run(s.id, 'make the answer 42');

    const pushed = await cli(['sessions', 'push', s.id]);
    expect(pushed.stdout).toContain(`Pushed 1 commit to ${branch} on acme/widgets.`);
    expect(fake.branchSha('acme/widgets', branch)).toBeTruthy();

    const refused = await cli(['sessions', 'pr', s.id]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Pass --yes');
    const pr = await cli(['sessions', 'pr', s.id, '--yes']);
    expect(pr.stdout).toContain('Make the answer 42');
    expect(pr.stdout).toContain('Opened pull request #1: https://github.com/acme/widgets/pull/1');
    const show = await cli(['sessions', 'repo', s.id]);
    expect(show.stdout).toContain(`acme/widgets on ${branch}. Pull request #1 is open.`);

    const early = await cli(['sessions', 'cleanup', s.id]);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('still open');
    fake.merge(1);
    // clean up reads the merge itself
    const cleaned = await cli(['sessions', 'cleanup', s.id]);
    expect(cleaned.stdout).toContain('Cleaned up. The branch stays on GitHub.');
    expect(existsSync(s.cwd)).toBe(false);

    expect((await cli(['github', 'logout'])).stdout).toContain('Removed the GitHub token');
    expect((await cli(['help', 'github'])).stdout).toContain('Contents read and write, Pull requests read and write, Metadata read');
  }, 60_000);
});
