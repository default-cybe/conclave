/**
 * Repo sessions through the real server and a paired device (docs/DESIGN.md
 * 30): the real engine with a scripted model, a TypeScript daemon over the
 * hub's WebSocket whose machine records every command, and a fake GitHub
 * that serves git over smart HTTP behind the token. The token reaches the
 * device only on the stdin of the git commands that talk to GitHub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonHandle } from '@conclave/core/machine/daemon.ts';
import type { ExecOptions, ExecResult } from '@conclave/core/machine/types.ts';
import type { GithubStatusDto, RepoSessionDto } from '@conclave/core/client/github.ts';
import type { Session } from '@conclave/core/types.ts';
import { startTestEngine, toolResults, type Step, type TestEngine } from '../../core/test/engine/harness';
import { waitFor } from '../../core/test/machine/fake-machine';
import { HomeMachine } from '../../core/test/projects/machines';
import { FakeGithub } from '../../core/test/github/fake-github';
import { startServer, type RunningServer } from '../src/app';
import { repoSessionInput } from '../src/routes-github';

const OWNER = 'owner-token-github-0123456789abcdef';
const TOKEN = 'github_pat_11ROUTES0never0on0the0wire0x1';

/** A device that keeps every command, its environment and its stdin. */
class RecordingMachine extends HomeMachine {
  calls: Array<{ command: string; env?: Record<string, string>; stdin?: string }> = [];
  override async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, env: opts.env, stdin: opts.stdin });
    return super.exec(command, opts);
  }
}

let root: string;
let fake: FakeGithub;
let t: TestEngine;
let running: RunningServer;
let daemon: DaemonHandle;
let device: RecordingMachine;
let deviceId: string;
let plan: Step[] = [];

async function api<T = any>(path: string, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${running.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${OWNER}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, text };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'conclave-github-routes-'));
  fake = new FakeGithub(TOKEN).start();
  fake.addRepo('acme', 'widgets', { description: 'Widgets for everyone' });
  t = await startTestEngine({
    script: [[{ text: 'ok' }]],
    route: () => plan.shift(),
    approve: 'allow',
    overrides: { github: { apiUrl: fake.apiUrl, gitUrl: fake.httpGitUrl, pollSeconds: 0 } } as never,
  });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const pairing = (await api('/api/pairing', { method: 'POST', json: { kind: 'device' } })).body;
  const reg = await fetch(`${running.url}/api/daemon/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'workbox' }) }).then((r) => r.json());
  deviceId = reg.deviceId;
  device = new RecordingMachine(deviceId, 'workbox', join(root, 'home'));
  daemon = runDaemon({ hubUrl: running.url, deviceId, token: reg.token, machine: device, name: 'workbox', maxBackoffMs: 200 });
  await waitFor(() => t.engine.devices.isOnline(deviceId), 5000, 'device online');
});

afterAll(async () => {
  daemon?.stop();
  await running?.stop();
  await t?.close();
  fake?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('input checks', () => {
  test('a repo session body', () => {
    expect(repoSessionInput({ repo: 'acme/widgets', base: 'main', device: 'pc', prompt: 'go', permissionMode: 'plan', extra: 1 })).toEqual({ repo: 'acme/widgets', base: 'main', device: 'pc', prompt: 'go', permissionMode: 'plan' });
    expect(() => repoSessionInput({})).toThrow(/repo is required/);
    expect(() => repoSessionInput({ repo: 'acme widgets' })).toThrow(/owner\/name/);
    expect(() => repoSessionInput({ repo: 'a/b', base: 'x y' })).toThrow(/not a branch name/);
    expect(() => repoSessionInput({ repo: 'a/b', permissionMode: 'yolo' })).toThrow(/permissionMode/);
    expect(repoSessionInput({ repo: 'a/b', issue: 12 })).toEqual({ repo: 'a/b', issue: 12 });
    for (const issue of [0, -1, 1.5, '12']) expect(() => repoSessionInput({ repo: 'a/b', issue })).toThrow(/issue number/);
  });
});

describe('a repo session on a paired device, through the API', () => {
  test('connect, start, push, open the pull request, follow it to the merge and clean up', async () => {
    expect((await api<GithubStatusDto>('/api/github')).body).toEqual({ connected: false, apiUrl: fake.apiUrl });
    expect((await api('/api/github/repos')).status).toBe(409);
    const bad = await api('/api/github/token', { method: 'PUT', json: { token: 'ghp_nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('did not accept');
    const conn = await api<GithubStatusDto>('/api/github/token', { method: 'PUT', json: { token: TOKEN } });
    expect(conn.status).toBe(200);
    expect(conn.body).toMatchObject({ connected: true, source: 'secret', login: 'sam-rivera', repos: 1 });
    expect(conn.text).not.toContain(TOKEN);
    // the config answer lists the secret by name only
    const cfg = await api('/api/config');
    expect(cfg.body.secrets.values).toContain('github');
    expect(cfg.text).not.toContain(TOKEN);
    expect((await api('/api/github/repos?q=everyone')).body.map((r: { fullName: string }) => r.fullName)).toEqual(['acme/widgets']);
    expect((await api('/api/github/repos/acme/widgets/branches')).body).toEqual({ defaultBranch: 'main', branches: ['main'] });
    fake.addIssue('acme/widgets', { number: 3, title: 'Crash on save', body: 'Steps.', labels: ['bug'] });
    expect((await api('/api/github/repos/acme/widgets/issues?q=crash')).body.map((i: { number: number }) => i.number)).toEqual([3]);
    expect((await api('/api/github/repos/acme/widgets/issues')).body[0]).not.toHaveProperty('body');
    expect((await api('/api/github/repos/acme/nope/issues')).status).toBe(404);
    expect((await api(`/api/github/repos/acme/widgets/issues?q=${'x'.repeat(201)}`)).status).toBe(400);

    expect((await api('/api/github/sessions', { method: 'POST', json: { repo: 'acme/widgets', device: 'nope' } })).status).toBe(404);
    const started = await api<Session>('/api/github/sessions', { method: 'POST', json: { repo: 'acme/widgets', device: deviceId, title: 'Answer' } });
    expect(started.status).toBe(200);
    const s = started.body;
    expect(s.device).toBe(deviceId);
    expect(s.cwd.startsWith(join(root, 'home', '.conclave', 'worktrees', 'gh', 'acme', 'widgets'))).toBe(true);
    expect(s.meta?.repo).toMatchObject({ repo: 'acme/widgets', base: 'main' });
    const branch = (s.meta!.repo as { branch: string }).branch;
    expect(branch).toMatch(/^conclave\/answer-[a-z2-9]{4}$/);

    // the model edits and commits on the device
    plan = [[{ tool: 'Bash', input: { command: `printf 'export const answer = 42;\\n' > src/app.ts && git add -A && git -c user.email=a@b -c user.name=A commit -qm 'Make the answer 42'` } }], [{ tool: 'Bash', input: { command: 'env' } }], [{ text: 'Done.' }]];
    await t.run(s.id, 'make the answer 42');
    const results = toolResults(t.engine, s.id);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results[1].content).not.toContain(TOKEN);

    let repo = (await api<RepoSessionDto>(`/api/sessions/${s.id}/repo`)).body;
    expect(repo).toMatchObject({ commits: 1, pushed: 'never', online: true, deviceName: 'workbox' });
    const pushed = await api(`/api/sessions/${s.id}/repo/push`, { method: 'POST', json: {} });
    expect(pushed.status).toBe(200);
    expect(pushed.body).toMatchObject({ pushed: true, branch, commits: 1 });
    expect(fake.branchSha('acme/widgets', branch)).toBe(pushed.body.sha);

    const draft = (await api(`/api/sessions/${s.id}/repo/pr-draft`)).body;
    expect(draft).toMatchObject({ title: 'Make the answer 42', base: 'main', head: branch });
    expect((await api(`/api/sessions/${s.id}/repo/pr`, { method: 'POST', json: { body: 'x' } })).status).toBe(400);
    const opened = await api<RepoSessionDto>(`/api/sessions/${s.id}/repo/pr`, { method: 'POST', json: { title: 'Make the answer 42', body: draft.body } });
    expect(opened.status).toBe(200);
    expect(opened.body.pr).toEqual({ number: 1, url: 'https://github.com/acme/widgets/pull/1', state: 'open' });

    // Fix failing checks: nothing failed yet, then one failed Actions job goes to the agent
    const none = await api(`/api/sessions/${s.id}/repo/fix-checks`, { method: 'POST', json: {} });
    expect(none.status).toBe(409);
    expect(none.body.error).toContain('No check has failed');
    fake.setChecks(pushed.body.sha, [{ name: 'test', status: 'completed', conclusion: 'failure', log: 'expected 42, got 41' }]);
    plan = [[{ text: 'Fixing.' }]];
    const fixed = await api(`/api/sessions/${s.id}/repo/fix-checks`, { method: 'POST', json: {} });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toEqual({ checks: 1 });
    await waitFor(() => t.engine.requireSession(s.id).status !== 'running', 5000, 'fix turn done');
    fake.setChecks(pushed.body.sha, []);

    expect((await api(`/api/sessions/${s.id}/repo/cleanup`, { method: 'POST', json: {} })).status).toBe(409);
    fake.merge(1);
    repo = (await api<RepoSessionDto>(`/api/sessions/${s.id}/repo?refresh=1`)).body;
    expect(repo).toMatchObject({ pr: { state: 'merged' }, canCleanUp: true });
    const cleaned = await api<RepoSessionDto>(`/api/sessions/${s.id}/repo/cleanup`, { method: 'POST', json: {} });
    expect(cleaned.body).toMatchObject({ cleaned: true });
    expect(existsSync(s.cwd)).toBe(false);
    expect(fake.branchSha('acme/widgets', branch)).toBe(pushed.body.sha);

    // a session that is not a repo session, and one that is not there
    const plainSession = await t.engine.createSession({ device: deviceId });
    expect((await api(`/api/sessions/${plainSession.id}/repo`)).status).toBe(404);
    expect((await api('/api/sessions/ses_nope/repo')).status).toBe(404);

    // the token went to the device only on stdin, and only to the commands that reach GitHub
    const holding = device.calls.filter((c) => c.stdin?.includes(TOKEN));
    expect(holding.length).toBeGreaterThanOrEqual(3);
    for (const c of holding) {
      expect(c.stdin).toBe(`${TOKEN}\n`);
      expect(c.command.startsWith('exec 3<&0 </dev/null')).toBe(true);
      expect(c.command).toMatch(/ (clone|fetch|push) /);
    }
    for (const c of device.calls) {
      expect(c.command).not.toContain(TOKEN);
      expect(JSON.stringify(c.env ?? {})).not.toContain(TOKEN);
      if (!c.command.startsWith('exec 3<&0')) expect(c.stdin ?? '').not.toContain(TOKEN);
    }
    expect(fake.requests.some((r) => r.path.includes('git-receive-pack') && r.auth?.startsWith('Basic '))).toBe(true);
    expect(fake.tokenOutsideAuth()).toEqual([]);

    const off = await api<GithubStatusDto>('/api/github/token', { method: 'DELETE' });
    expect(off.body.connected).toBe(false);
  });
});
