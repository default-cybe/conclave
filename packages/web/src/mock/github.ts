/**
 * Mock routes for repo sessions (docs/DESIGN.md 30): the GitHub connection,
 * three repositories, starting a session in a new worktree, and Push, Open
 * pull request and Clean up. A session made here walks the same states the
 * hub's does: the first checks fail, Fix failing checks makes them pass, and
 * Merge happens on its own a minute after that.
 */
import type { Session } from '@conclave/core/types';
import type { GithubRepoDto, GithubStatusDto, RepoSessionDto, SessionRepoMeta } from '@conclave/core/client';
import type { MockCtx } from './index';

const HOUR = 3_600_000;

interface Row {
  meta: SessionRepoMeta;
  baseSha: string;
  commits: number;
  pushed: number;
  worktree: string;
}

export function registerGithub(ctx: MockCtx) {
  const { on, db, emit, uid, fail, FRESH } = ctx;
  const now = Date.now();
  let status: GithubStatusDto = FRESH ? { connected: false } : { connected: true, source: 'secret', login: 'sam-rivera', name: 'Sam Rivera', repos: 3 };
  const repos: GithubRepoDto[] = [
    { fullName: 'sam-rivera/portfolio', owner: 'sam-rivera', name: 'portfolio', private: false, defaultBranch: 'main', description: 'My site', pushedAt: now - 2 * HOUR, url: 'https://github.com/sam-rivera/portfolio', canPush: true },
    { fullName: 'acme/widgets', owner: 'acme', name: 'widgets', private: true, defaultBranch: 'main', description: 'Widgets for everyone', pushedAt: now - 26 * HOUR, url: 'https://github.com/acme/widgets', canPush: true },
    { fullName: 'acme/docs', owner: 'acme', name: 'docs', private: false, defaultBranch: 'trunk', description: 'The handbook', pushedAt: now - 9 * 24 * HOUR, url: 'https://github.com/acme/docs', canPush: false },
  ];
  const rows = new Map<string, Row>();

  const setMeta = (id: string) => {
    const s = db.sessions.get(id);
    const r = rows.get(id);
    if (!s || !r) return;
    const next: Session = { ...s, meta: { ...(s.meta ?? {}), repo: structuredClone(r.meta) } };
    db.sessions.set(id, next);
    emit({ type: 'session.updated', session: structuredClone(next) });
  };
  const dto = (id: string): RepoSessionDto => {
    const r = rows.get(id);
    const s = db.sessions.get(id);
    if (!r || !s) return fail(404, 'This session is not a repo session.');
    const pushed = !r.pushed ? 'never' : r.pushed < r.commits ? 'behind' : 'current';
    const pr = r.meta.pr;
    const line = r.meta.cleaned
      ? 'Cleaned up. The branch stays on GitHub.'
      : pr?.state === 'merged'
        ? `Pull request #${pr.number} was merged. Clean up removes the worktree.`
        : pr
          ? `Pull request #${pr.number} is open.${r.meta.ci === 'success' ? ' Checks passed.' : r.meta.ci === 'pending' ? ' Checks are running.' : r.meta.ci === 'failure' ? ' A check failed.' : ''}`
          : pushed === 'current'
            ? `Pushed. No pull request yet.`
            : r.commits
              ? `${r.commits} commit${r.commits === 1 ? '' : 's'}, not pushed yet.`
              : `No commits yet.`;
    return {
      ...structuredClone(r.meta),
      sessionId: id,
      device: s.device,
      deviceName: db.devices.get(s.device)?.name ?? s.device,
      clonePath: `~/repos/${r.meta.repo}`,
      worktree: r.worktree,
      baseSha: r.baseSha,
      defaultBranch: r.meta.base,
      url: `https://github.com/${r.meta.repo}`,
      ...(r.pushed ? { branchUrl: `https://github.com/${r.meta.repo}/tree/${r.meta.branch}` } : {}),
      commits: r.commits,
      dirty: 0,
      pushed,
      canCleanUp: !r.meta.cleaned && (pr?.state === 'merged' || pr?.state === 'closed'),
      online: true,
      line,
    };
  };

  on('GET', '/api/github', () => status);
  on('PUT', '/api/github/token', ({ body }) => {
    if (!String(body.token ?? '').startsWith('github_pat_') && !String(body.token ?? '').startsWith('ghp_')) fail(400, 'GitHub did not accept that token. Check that you copied all of it and that it has not expired.');
    status = { connected: true, source: 'secret', login: 'sam-rivera', name: 'Sam Rivera', repos: repos.length };
    return status;
  });
  on('DELETE', '/api/github/token', () => (status = { connected: false }));
  on('GET', '/api/github/repos', ({ query }) => {
    if (!status.connected) fail(409, 'Connect GitHub first: Settings, GitHub, or conclave github login.');
    const words = (query.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return repos.filter((r) => words.every((w) => r.fullName.includes(w) || (r.description ?? '').toLowerCase().includes(w)));
  });
  on('GET', '/api/github/repos/:owner/:name/branches', ({ params }) => {
    const r = repos.find((x) => x.fullName === `${params[0]}/${params[1]}`);
    if (!r) fail(404, 'GitHub has no such repository.');
    return { defaultBranch: r!.defaultBranch, branches: [r!.defaultBranch, 'release', 'next'] };
  });
  on('POST', '/api/github/sessions', async ({ body }) => {
    const repo = repos.find((x) => x.fullName === body.repo);
    if (!repo) fail(404, `GitHub has no repository ${body.repo} that this token can see.`);
    const slug = String(body.title || body.prompt || 'session')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    const branch = `conclave/${slug || 'session'}-${uid('b').slice(-4)}`;
    const worktree = `~/.conclave/worktrees/gh/${repo!.fullName}/${branch.slice(9)}`;
    const s = (await ctx.request('/api/sessions', { method: 'POST', body: JSON.stringify({ ...body, cwd: worktree, repo: undefined, base: undefined }) }).then((r) => r.json())) as Session;
    rows.set(s.id, { meta: { repo: repo!.fullName, branch, base: body.base || repo!.defaultBranch }, baseSha: '4f2a9c1e'.padEnd(40, '0'), commits: body.prompt ? 1 : 0, pushed: 0, worktree });
    setMeta(s.id);
    return db.sessions.get(s.id);
  });
  on('GET', '/api/sessions/:id/repo', ({ params }) => dto(params[0]));
  on('POST', '/api/sessions/:id/repo/push', ({ params }) => {
    const r = rows.get(params[0]);
    if (!r) fail(404, 'This session is not a repo session.');
    if (!r!.commits) fail(409, `There are no commits on ${r!.meta.branch} beyond ${r!.meta.base} yet. Commit the work first.`);
    const moved = r!.pushed < r!.commits;
    r!.pushed = r!.commits;
    return { pushed: moved, branch: r!.meta.branch, sha: 'a1b2c3d4'.padEnd(40, '0'), commits: r!.commits, line: moved ? `Pushed ${r!.commits} commit${r!.commits === 1 ? '' : 's'} to ${r!.meta.branch} on ${r!.meta.repo}.` : `${r!.meta.branch} on ${r!.meta.repo} is already up to date.` };
  });
  on('GET', '/api/sessions/:id/repo/pr-draft', ({ params }) => {
    const r = rows.get(params[0]);
    const s = db.sessions.get(params[0]);
    if (!r || !s) return fail(404, 'This session is not a repo session.');
    return { title: s.title, body: `What changed and how it was checked.\n\n## Commits\n\n- ${s.title} (a1b2c3d)\n\nMade in the Conclave session "${s.title}".`, base: r.meta.base, head: r.meta.branch, commits: [{ sha: 'a1b2c3d4'.padEnd(40, '0'), subject: s.title }] };
  });
  on('POST', '/api/sessions/:id/repo/pr', ({ params, body }) => {
    const r = rows.get(params[0]);
    if (!r) return fail(404, 'This session is not a repo session.');
    if (!body.title) fail(400, 'title is required');
    r.pushed = r.commits;
    const n = 40 + rows.size;
    r.meta.pr = { number: n, url: `https://github.com/${r.meta.repo}/pull/${n}`, state: 'open', ...(body.draft ? { draft: true } : {}) };
    r.meta.ci = 'pending';
    setMeta(params[0]);
    setTimeout(() => {
      r.meta.ci = 'failure';
      setMeta(params[0]);
    }, 8_000);
    return dto(params[0]);
  });
  on('POST', '/api/sessions/:id/repo/fix-checks', ({ params }) => {
    const r = rows.get(params[0]);
    if (!r) return fail(404, 'This session is not a repo session.');
    if (r.meta.ci !== 'failure') fail(409, 'No check has failed on GitHub now.');
    r.meta.ci = 'pending';
    setMeta(params[0]);
    setTimeout(() => {
      r.meta.ci = 'success';
      setMeta(params[0]);
    }, 8_000);
    setTimeout(() => {
      if (r.meta.pr) r.meta.pr.state = 'merged';
      setMeta(params[0]);
    }, 60_000);
    return { checks: 2 };
  });
  on('POST', '/api/sessions/:id/repo/cleanup', ({ params }) => {
    const r = rows.get(params[0]);
    if (!r) return fail(404, 'This session is not a repo session.');
    r.meta.cleaned = true;
    setMeta(params[0]);
    return dto(params[0]);
  });
}
