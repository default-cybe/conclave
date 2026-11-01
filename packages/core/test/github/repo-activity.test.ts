/**
 * A shared project's code view (docs/design/FRIENDS.md, "Shared projects as
 * built"): the repository, its open pull requests with who opened them, and
 * its branches, read with the hub's token from the GitHub API only.
 */
import { afterEach, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { githubOf } from '../../src/github';
import type { GithubService } from '../../src/github/service';
import { FakeGithub } from './fake-github';

const TOKEN = 'github_pat_11FAKE0TOKEN0never0leaks0x9Qz';
let t: TestEngine | undefined;
let fake: FakeGithub | undefined;

afterEach(async () => {
  await t?.close();
  fake?.stop();
  t = undefined;
  fake = undefined;
});

test('repoActivity lists open pull requests by author, and the branches', async () => {
  fake = new FakeGithub(TOKEN).start();
  fake.addRepo('acme', 'site');
  fake.pulls.push({ number: 1, title: 'Footer', body: '', head: 'alice/footer', base: 'main', state: 'open', merged: false, draft: true, createdAt: 1_790_000_000_000, author: 'alice-k' });
  fake.pulls.push({ number: 2, title: 'Old', body: '', head: 'old', base: 'main', state: 'closed', merged: false, draft: false, createdAt: 1_780_000_000_000 });
  fake.pulls.push({ number: 3, title: 'Timeout', body: '', head: 'conclave/timeout-abcd', base: 'main', state: 'open', merged: false, draft: false, createdAt: 1_790_000_100_000 });
  t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { github: { apiUrl: fake.apiUrl, gitUrl: fake.fileGitUrl, pollSeconds: 0 } } as never });
  const svc = githubOf(t.engine) as GithubService;
  expect(await svc.login()).toBeUndefined();
  await expect(svc.repoActivity('acme/site')).rejects.toThrow('Connect GitHub first');
  await svc.connect(TOKEN);
  const a = await svc.repoActivity('acme/site');
  expect(a).toMatchObject({ fullName: 'acme/site', defaultBranch: 'main', private: false, login: 'sam-rivera' });
  expect(a.pulls.map((p) => [p.number, p.author, p.branch, p.draft])).toEqual([
    [3, 'sam-rivera', 'conclave/timeout-abcd', false],
    [1, 'alice-k', 'alice/footer', true],
  ]);
  expect(a.branches).toContain('main');
  await expect(svc.repoActivity('acme/nothing')).rejects.toThrow('no repository acme/nothing');
  // only API calls, each with the token in the header
  expect(fake.requests.filter((r) => r.path.includes('/pulls')).every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
});
