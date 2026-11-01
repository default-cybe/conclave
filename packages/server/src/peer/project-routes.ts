/**
 * Shared projects with friends (projects.ts), for the owner's apps:
 *
 *   GET    /api/shared-projects                       the list
 *   POST   /api/shared-projects                       make one and invite friends
 *   GET    /api/shared-projects/:id                   one, with its items
 *   PATCH  /api/shared-projects/:id                   name, description, repo (owner); link, share new sessions (anyone)
 *   DELETE /api/shared-projects/:id[?forget=1]        leave (member), end (owner), forget a copy
 *   POST   /api/shared-projects/:id/accept|decline    an invite
 *   POST   /api/shared-projects/:id/members           invite more friends (owner)
 *   DELETE /api/shared-projects/:id/members/:fp       take a member out (owner)
 *   POST   /api/shared-projects/:id/notes             a note
 *   PATCH  /api/shared-projects/:id/items/:item       edit your own item (a new version)
 *   DELETE /api/shared-projects/:id/items/:item       delete your own item
 *   GET    /api/shared-projects/:id/items/:item/history
 *   GET    /api/shared-projects/:id/memory-candidates the project's memories here
 *   POST   /api/shared-projects/:id/memories          share memories you picked
 *   POST   /api/shared-projects/:id/chats             share chats and sessions
 *   GET    /api/shared-projects/:id/code              the repository on GitHub, each member's branches and pull requests
 *   POST   /api/shared-projects/:id/sync|read
 */
import type { Context, Hono } from 'hono';
import type { CreateSharedProjectInput, UpdateSharedProjectInput } from '@conclave/core/client/shared-projects.ts';
import type { HonoEnv, ServerContext } from '../context';
import { actorOf, badRequest, optBool, optString, qBool, readJson } from '../http';

function strings(v: unknown, name: string, max = 200): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length > 200)) throw badRequest(`${name} must be a list of ids`);
  return v as string[];
}

/** A nullable string: null or "" clears it. */
function nullable(v: unknown, name: string, max: number): string | null | undefined {
  if (v === null || v === '') return null;
  return optString(v, name, max);
}

export function registerSharedProjectRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const svc = ctx.peer.projects;
  const id = (c: Context) => c.req.param('id') ?? '';
  const item = (c: Context) => c.req.param('item') ?? '';

  app.get('/api/shared-projects', (c) => c.json(svc.list()));
  app.post('/api/shared-projects', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    const input: CreateSharedProjectInput = {
      name: optString(b.name, 'name', 1000) ?? '',
      ...(b.description !== undefined ? { description: optString(b.description, 'description', 10_000) } : {}),
      ...(b.repo !== undefined ? { repo: optString(b.repo, 'repo', 500) } : {}),
      ...(b.localProjectId !== undefined ? { localProjectId: optString(b.localProjectId, 'localProjectId', 100) } : {}),
      ...(b.members !== undefined ? { members: strings(b.members, 'members', 50) } : {}),
      ...(b.notes !== undefined ? { notes: optString(b.notes, 'notes', 100_000) } : {}),
      ...(b.memoryIds !== undefined ? { memoryIds: strings(b.memoryIds, 'memoryIds') } : {}),
      ...(b.sessionIds !== undefined ? { sessionIds: strings(b.sessionIds, 'sessionIds', 50) } : {}),
      ...(b.shareNewSessions !== undefined ? { shareNewSessions: optBool(b.shareNewSessions, 'shareNewSessions') } : {}),
    };
    return c.json(await svc.create(input, actorOf(c)));
  });

  app.get('/api/shared-projects/:id', (c) => c.json(svc.view(id(c))));
  app.patch('/api/shared-projects/:id', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    const input: UpdateSharedProjectInput = {
      ...(b.name !== undefined ? { name: optString(b.name, 'name', 1000) ?? '' } : {}),
      ...(b.description !== undefined ? { description: nullable(b.description, 'description', 10_000) ?? '' } : {}),
      ...(b.repo !== undefined ? { repo: nullable(b.repo, 'repo', 500) } : {}),
      ...(b.localProjectId !== undefined ? { localProjectId: nullable(b.localProjectId, 'localProjectId', 100) } : {}),
      ...(b.shareNewSessions !== undefined ? { shareNewSessions: optBool(b.shareNewSessions, 'shareNewSessions') } : {}),
    };
    return c.json(svc.update(id(c), input, actorOf(c)));
  });
  app.delete('/api/shared-projects/:id', (c) => c.json(svc.leave(id(c), { forget: !!qBool(c.req.query('forget')) }, actorOf(c))));

  app.post('/api/shared-projects/:id/accept', async (c) => c.json(await svc.accept(id(c), actorOf(c))));
  app.post('/api/shared-projects/:id/decline', (c) => c.json(svc.decline(id(c), actorOf(c))));

  app.post('/api/shared-projects/:id/members', async (c) => {
    const b = await readJson<{ friends?: unknown }>(c);
    return c.json(svc.invite(id(c), strings(b.friends, 'friends', 50) ?? [], actorOf(c)));
  });
  app.delete('/api/shared-projects/:id/members/:fp', (c) => c.json(svc.removeMember(id(c), c.req.param('fp') ?? '', actorOf(c))));

  app.post('/api/shared-projects/:id/notes', async (c) => {
    const b = await readJson<{ title?: unknown; text?: unknown }>(c);
    return c.json(svc.addNote(id(c), b));
  });
  app.patch('/api/shared-projects/:id/items/:item', async (c) => {
    const b = await readJson<{ title?: unknown; text?: unknown }>(c);
    return c.json(svc.editItem(id(c), item(c), b));
  });
  app.delete('/api/shared-projects/:id/items/:item', (c) => c.json(svc.deleteItem(id(c), item(c), actorOf(c))));
  app.get('/api/shared-projects/:id/items/:item/history', (c) => c.json(svc.history(id(c), item(c))));

  app.get('/api/shared-projects/:id/memory-candidates', (c) => c.json(svc.memoryCandidates(id(c))));
  app.post('/api/shared-projects/:id/memories', async (c) => {
    const b = await readJson<{ memoryIds?: unknown }>(c);
    return c.json(svc.shareMemories(id(c), b.memoryIds));
  });
  app.post('/api/shared-projects/:id/chats', async (c) => {
    const b = await readJson<{ sessionIds?: unknown }>(c);
    return c.json(await svc.shareChats(id(c), b.sessionIds, actorOf(c)));
  });

  app.get('/api/shared-projects/:id/code', async (c) => c.json(await svc.code(id(c))));
  app.post('/api/shared-projects/:id/sync', async (c) => c.json(await svc.sync(id(c))));
  app.post('/api/shared-projects/:id/read', (c) => c.json(svc.markRead(id(c))));
}
