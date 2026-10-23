/**
 * Repo sessions in the web app (lib/github.ts, features/home/start.ts): the
 * words for a repository, branch, pull request and checks, which actions a
 * session offers, and the remembered repository pick on Home.
 *
 *   bun test packages/web/test/github.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { RepoSessionDto } from '@conclave/core/client';
import type { ApprovalRequest } from '@conclave/core/types';
import { approvalLine, approvalTitle } from '../src/components/inbox/ApprovalCard';
import { branchShort, ciTone, ciWords, prWords, repoActions, repoWhere, sessionRepo } from '../src/lib/github';
import { readPicks, savePicks, sessionSetup } from '../src/features/home/start';

function dto(p: Partial<RepoSessionDto> = {}): RepoSessionDto {
  return {
    repo: 'acme/widgets',
    branch: 'conclave/fix-login-ab12',
    base: 'main',
    sessionId: 'ses_1',
    device: 'local',
    deviceName: 'homelab',
    clonePath: '/home/sam/repos/acme/widgets',
    worktree: '/home/sam/.conclave/worktrees/gh/acme/widgets/fix-login-ab12',
    baseSha: 'a'.repeat(40),
    defaultBranch: 'main',
    url: 'https://github.com/acme/widgets',
    pushed: 'never',
    canCleanUp: false,
    online: true,
    line: '',
    commits: 0,
    dirty: 0,
    ...p,
  };
}

describe('words', () => {
  test('repository, branch, pull request and checks', () => {
    expect(branchShort('conclave/fix-login-ab12')).toBe('fix-login-ab12');
    expect(branchShort('feature/x')).toBe('feature/x');
    expect(repoWhere({ repo: 'acme/widgets', branch: 'conclave/fix-login-ab12' })).toBe('acme/widgets on fix-login-ab12');
    expect(prWords({ number: 12, url: 'u', state: 'open' })).toBe('Pull request #12, open');
    expect(prWords({ number: 12, url: 'u', state: 'open', draft: true }, true)).toBe('#12 draft');
    expect(prWords({ number: 12, url: 'u', state: 'merged' }, true)).toBe('#12 merged');
    expect(ciWords('pending')).toBe('Checks running');
    expect(ciWords('failure')).toBe('A check failed');
    expect(ciWords('none')).toBeUndefined();
    expect(ciTone('pending')).toBe('signal');
    expect(ciTone('failure')).toBe('fault');
    expect(ciTone('success')).toBe('ok');
  });

  test('a session is a repo session when its meta says so', () => {
    expect(sessionRepo({ meta: { repo: { repo: 'acme/widgets', branch: 'conclave/x', base: 'main' } } })).toMatchObject({ repo: 'acme/widgets' });
    expect(sessionRepo({ meta: {} })).toBeUndefined();
    expect(sessionRepo({ meta: { repo: 'acme/widgets' } })).toBeUndefined();
    expect(sessionRepo(undefined)).toBeUndefined();
  });
});

describe('actions', () => {
  test('nothing to do before the first commit', () => {
    expect(repoActions(dto())).toEqual({ push: false, openPr: false, viewPr: false, cleanUp: false });
  });
  test('commits not pushed: Push and Open pull request', () => {
    expect(repoActions(dto({ commits: 2 }))).toEqual({ push: true, openPr: true, viewPr: false, cleanUp: false });
  });
  test('uncommitted files count as work to push', () => {
    expect(repoActions(dto({ dirty: 3 }))).toMatchObject({ push: true, openPr: true });
  });
  test('pushed with no pull request: Open pull request only', () => {
    expect(repoActions(dto({ commits: 2, pushed: 'current' }))).toEqual({ push: false, openPr: true, viewPr: false, cleanUp: false });
  });
  test('an open pull request: new commits to push, and View', () => {
    const pr = { number: 3, url: 'u', state: 'open' as const };
    expect(repoActions(dto({ commits: 2, pushed: 'current', pr }))).toEqual({ push: false, openPr: false, viewPr: true, cleanUp: false });
    expect(repoActions(dto({ commits: 3, pushed: 'behind', pr }))).toEqual({ push: true, openPr: false, viewPr: true, cleanUp: false });
  });
  test('merged: Clean up; cleaned: only View', () => {
    const pr = { number: 3, url: 'u', state: 'merged' as const };
    expect(repoActions(dto({ commits: 2, pushed: 'current', pr, canCleanUp: true }))).toEqual({ push: false, openPr: false, viewPr: true, cleanUp: true });
    expect(repoActions(dto({ pr, cleaned: true }))).toEqual({ push: false, openPr: false, viewPr: true, cleanUp: false });
  });
  test('an offline device offers no git', () => {
    expect(repoActions(dto({ commits: 2, online: false }))).toMatchObject({ push: false, openPr: false });
  });
});

describe('the PullRequest tool asks in words', () => {
  const ask = (input: Record<string, unknown>, summary: string): ApprovalRequest => ({ id: 'a1', sessionId: 's1', toolUseId: 't1', tool: 'PullRequest', input, summary, createdAt: 1, noAlways: true });
  test('a push and a pull request', () => {
    const push = ask({ action: 'push', repo: 'acme/widgets', branch: 'conclave/fix-ab12', base: 'main' }, 'Push conclave/fix-ab12 to acme/widgets');
    expect(approvalTitle(push)).toBe('Push to acme/widgets?');
    expect(approvalLine(push)).toBe('Wants to push');
    const open = ask({ action: 'open', repo: 'acme/widgets', title: 'Fix login' }, 'Open a pull request on acme/widgets from conclave/fix-ab12 into main: Fix login');
    expect(approvalTitle(open)).toBe('Open a pull request on acme/widgets?');
    expect(approvalLine(open)).toBe('Wants to open a pull request');
  });
});

describe('a repo session on Home', () => {
  test('its worktree is not the folder of the next session', () => {
    const devices = { local: { id: 'local', online: true } };
    const agents = [{ name: 'coder' }];
    const last = { agent: 'coder', model: 'm/x', device: 'local', cwd: '/home/sam/.conclave/worktrees/gh/acme/widgets/fix-ab12', meta: { repo: { repo: 'acme/widgets', branch: 'conclave/fix-ab12', base: 'main' } } };
    expect(sessionSetup({ picks: {}, last, agents, devices }).cwd).toBeUndefined();
    expect(sessionSetup({ picks: {}, last: { ...last, cwd: '~/code/app', meta: undefined }, agents, devices }).cwd).toBe('~/code/app');
  });
});

describe('the repository pick on Home', () => {
  const g = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const before = g.localStorage;
  afterEach(() => {
    if (had) g.localStorage = before;
    else delete g.localStorage;
  });

  test('is remembered with its base branch', () => {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    savePicks({ agent: 'coder', device: 'local', repo: 'acme/widgets', base: 'release' });
    expect(readPicks()).toMatchObject({ agent: 'coder', device: 'local', repo: 'acme/widgets', base: 'release' });
    m.set('conclave.quickstart', JSON.stringify({ repo: 42, base: '' }));
    expect(readPicks().repo).toBeUndefined();
    expect(readPicks().base).toBeUndefined();
  });
});
