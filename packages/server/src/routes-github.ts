/**
 * Repo sessions (docs/DESIGN.md 30): the GitHub connection, repositories
 * and branches, starting a session in a fresh worktree, and Push, Open pull
 * request and Clean up on a session. The work is in
 * packages/core/src/github; these handlers validate and call it. No answer
 * here ever carries the token.
 */
import type { Context, Hono } from 'hono';
import type { OpenPrInput, PushInput, RepoSessionInput, WorktreeSessionInput } from '@conclave/core/client/github.ts';
import type { PermissionMode } from '@conclave/core/types.ts';
import { githubOf } from '@conclave/core/github/attached.ts';
import type { GithubService } from '@conclave/core/github/service.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, notFound, optBool, optString, qBool, readJson, requireString } from './http';
import { accountOf, ownDevice } from './scope';
import { isMember } from '@conclave/core/people/context.ts';
import { CODE_NEEDS_DEVICE } from '@conclave/core/people/guard.ts';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

/** Validate a POST /api/github/sessions body. */
export function repoSessionInput(body: Record<string, unknown>): RepoSessionInput {
  const repo = requireString(body.repo, 'repo').trim();
  if (repo.length > 200 || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw badRequest('repo must be owner/name');
  const base = optString(body.base, 'base', 200);
  if (base && /[\s\u0000~^:?*[\\]/.test(base)) throw badRequest('base is not a branch name');
  return { repo, ...(base ? { base } : {}), ...sessionOptions(body) };
}

/** Validate a POST /api/worktrees/sessions body. */
export function worktreeSessionInput(body: Record<string, unknown>): WorktreeSessionInput {
  const folder = requireString(body.folder, 'folder').trim();
  if (folder.length > 4096 || folder.includes('\u0000')) throw badRequest('folder is not a path');
  return { folder, ...sessionOptions(body) };
}

/** The session options both kinds of worktree session take. */
function sessionOptions(body: Record<string, unknown>): Omit<WorktreeSessionInput, 'folder'> {
  const mode = optString(body.permissionMode, 'permissionMode');
  if (mode && !MODES.includes(mode as PermissionMode)) throw badRequest(`permissionMode must be one of ${MODES.join(', ')}`);
  if (body.chat !== undefined && (typeof body.chat !== 'object' || body.chat === null || Array.isArray(body.chat))) throw badRequest('chat must be an object');
  const str = (k: string, max: number) => optString(body[k], k, max);
  return {
    ...(str('device', 200) ? { device: str('device', 200) } : {}),
    ...(str('agent', 200) ? { agent: str('agent', 200) } : {}),
    ...(str('model', 300) ? { model: str('model', 300) } : {}),
    ...(str('title', 300) ? { title: str('title', 300) } : {}),
    ...(str('prompt', 200_000) ? { prompt: str('prompt', 200_000) } : {}),
    ...(mode ? { permissionMode: mode as PermissionMode } : {}),
    ...(body.chat ? { chat: body.chat as RepoSessionInput['chat'] } : {}),
  };
}

/** The hub's own audit entries come from the service, so a push the model asked for is logged the same way. */
export function registerGithubRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;
  const svc = (): GithubService => {
    const s = githubOf(engine);
    if (!s) throw new HttpError(501, 'Repo sessions are not available on this hub.');
    return s;
  };
  const sid = (c: Context): string => {
    const id = c.req.param('id') ?? '';
    if (!engine.getSession(id)) throw notFound(`unknown session ${id}`);
    return id;
  };

  // ----- the connection ------------------------------------------------------

  app.get('/api/github', async (c) => c.json(await svc().status()));

  app.put('/api/github/token', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const token = requireString(body.token, 'token');
    if (token.length > 512) throw badRequest('token is too long');
    return c.json(await svc().connect(token));
  });

  app.delete('/api/github/token', (c) => {
    return c.json(svc().disconnect());
  });

  app.get('/api/github/repos', async (c) => {
    const q = optString(c.req.query('q'), 'q', 200);
    return c.json(await svc().repos(q, { refresh: !!qBool(c.req.query('refresh')) }));
  });

  app.get('/api/github/repos/:owner/:name/branches', async (c) => c.json(await svc().branches(`${c.req.param('owner')}/${c.req.param('name')}`)));

  // ----- repo sessions -------------------------------------------------------

  app.post('/api/github/sessions', async (c) => {
    const input = repoSessionInput(await readJson<Record<string, unknown>>(c));
    const device = input.device || 'local';
    // a member's repo session runs on a device of theirs: the hub's disk is the owner's
    if (isMember(accountOf(c)) && device === 'local') throw badRequest(CODE_NEEDS_DEVICE);
    ownDevice(engine, c, device);
    return c.json(await svc().startSession(input));
  });

  // ----- "Run in a worktree" on any git folder of a device ---------------------

  app.get('/api/worktrees/folder', async (c) => {
    const device = optString(c.req.query('device'), 'device', 200) || 'local';
    const path = requireString(c.req.query('path'), 'path');
    if (path.length > 4096) throw badRequest('path is too long');
    ownDevice(engine, c, device);
    return c.json(await svc().folderGit(device, path));
  });

  app.post('/api/worktrees/sessions', async (c) => {
    const input = worktreeSessionInput(await readJson<Record<string, unknown>>(c));
    const device = input.device || 'local';
    if (isMember(accountOf(c)) && device === 'local') throw badRequest(CODE_NEEDS_DEVICE);
    ownDevice(engine, c, device);
    return c.json(await svc().startFolderSession(input));
  });

  app.post('/api/sessions/:id/repo/merge', async (c) => {
    const id = sid(c);
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await svc().merge(id, { ...(optBool(body.squash, 'squash') ? { squash: true } : {}) }));
  });

  app.get('/api/sessions/:id/repo', async (c) => c.json(await svc().dto(sid(c), { refresh: !!qBool(c.req.query('refresh')) })));

  app.post('/api/sessions/:id/repo/push', async (c) => {
    const id = sid(c);
    const body = await readJson<Record<string, unknown>>(c);
    const message = optString(body.commitMessage, 'commitMessage', 5_000);
    const input: PushInput = message?.trim() ? { commitMessage: message } : {};
    return c.json(await svc().push(id, input));
  });

  app.get('/api/sessions/:id/repo/pr-draft', async (c) => c.json(await svc().draft(sid(c))));

  app.post('/api/sessions/:id/repo/pr', async (c) => {
    const id = sid(c);
    const body = await readJson<Record<string, unknown>>(c);
    const title = requireString(body.title, 'title').trim();
    if (title.length > 256) throw badRequest('title is too long');
    const input: OpenPrInput = { title, ...(optString(body.body, 'body', 60_000) ? { body: body.body as string } : {}), ...(optBool(body.draft, 'draft') ? { draft: true } : {}) };
    return c.json(await svc().openPr(id, input));
  });

  app.post('/api/sessions/:id/repo/cleanup', async (c) => {
    const id = sid(c);
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await svc().cleanup(id, { ...(optBool(body.force, 'force') ? { force: true } : {}), ...(optBool(body.discard, 'discard') ? { discard: true } : {}) }));
  });
}
