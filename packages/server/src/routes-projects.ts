/**
 * Folders across devices (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.12):
 * moving a session to another device, the session's location for the
 * banner, project identity and locations, and each device's folders, path
 * pairs, suggestions and Syncthing state. The work is in
 * packages/core/src/projects; these handlers validate and call it.
 */
import type { Context, Hono } from 'hono';
import type { MoveInput, MoveResult } from '@conclave/core/client/projects.ts';
import type { SessionPatch } from '@conclave/core/client/index.ts';
import type { Session } from '@conclave/core/types.ts';
import { projectsOf } from '@conclave/core/projects/attached.ts';
import type { ProjectsService } from '@conclave/core/projects/service.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, notFound, optBool, optString, qBool, readJson, requireString } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf, ownDevice } from './scope';

/** Longest folder path or clone URL a route takes. */
const MAX_PATH = 4096;

/** A folder path from a body or query: a string of sane length with no NUL or line break (it goes into a shell on the device). */
function pathString(v: unknown, name: string): string {
  const s = requireString(v, name);
  if (s.length > MAX_PATH) throw badRequest(`${name} is longer than ${MAX_PATH} characters`);
  if (/[\u0000\r\n]/.test(s)) throw badRequest(`${name} has a NUL or line break in it`);
  return s;
}

/** Validate a move body. */
export function moveInput(body: Record<string, unknown>): MoveInput {
  const device = requireString(body.device, 'device');
  const clone = body.clone;
  let cloneInput: MoveInput['clone'];
  if (clone !== undefined && clone !== null) {
    if (typeof clone !== 'object' || Array.isArray(clone)) throw badRequest('clone must be an object with url and into');
    const c = clone as Record<string, unknown>;
    cloneInput = { url: pathString(c.url, 'clone.url'), into: pathString(c.into, 'clone.into') };
  }
  const cwd = optString(body.cwd, 'cwd');
  return {
    device,
    ...(cwd ? { cwd: pathString(cwd, 'cwd') } : {}),
    ...(optBool(body.remember, 'remember') ? { remember: true } : {}),
    ...(optBool(body.allowMismatch, 'allowMismatch') ? { allowMismatch: true } : {}),
    ...(optBool(body.withoutFiles, 'withoutFiles') ? { withoutFiles: true } : {}),
    ...(cloneInput ? { clone: cloneInput } : {}),
    ...(optBool(body.copy, 'copy') ? { copy: true } : {}),
  };
}

/**
 * PATCH /api/sessions/:id with a new device goes through the same resolution
 * as a move. It answers 409 with the move result when no folder was found.
 */
export async function patchSession(ctx: ServerContext, id: string, patch: SessionPatch): Promise<{ status: 200; session: Session } | { status: 409; result: MoveResult }> {
  const { engine } = ctx;
  const s = engine.getSession(id);
  const svc = projectsOf(engine);
  if (!s || !svc || patch.device === undefined || patch.device === s.device || s.kind === 'chat') return { status: 200, session: engine.updateSession(id, patch) };
  const result = await svc.move(id, { device: patch.device, ...(patch.cwd ? { cwd: patch.cwd } : {}) });
  if (!result.resolved) return { status: 409, result };
  const { device: _d, cwd: _c, ...rest } = patch;
  const session = Object.keys(rest).length ? engine.updateSession(id, rest) : result.session;
  return { status: 200, session };
}

export function registerProjectRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;
  const svc = (): ProjectsService => {
    const s = projectsOf(engine);
    if (!s) throw new HttpError(501, 'Folders across devices are not available on this hub.');
    return s;
  };
  const sid = (c: Context): string => {
    const id = c.req.param('id') ?? '';
    if (!engine.getSession(id)) throw notFound(`unknown session ${id}`);
    return id;
  };
  /** A device of the caller's own ("local", the hub, is the owner's). */
  const known = (c: Context<HonoEnv>, device: string): void => {
    ownDevice(engine, c, device);
  };

  // ----- sessions ------------------------------------------------------------

  app.post('/api/sessions/:id/move', async (c) => {
    const id = sid(c);
    const input = moveInput(await readJson<Record<string, unknown>>(c));
    known(c, input.device);
    // Move to hub copies for minutes: it runs in the background and reports in the session (hubcopy.progress)
    if (input.copy) {
      if (input.device !== 'local') throw badRequest('copy moves a session to the hub only (device "local")');
      audit(c, 'session.move-to-hub', id, { sessionId: id });
      return c.json(svc().copies.start(id), 202);
    }
    const result = await svc().move(id, input);
    if (result.resolved) audit(c, 'session.move', `${result.session.device} ${result.cwd} (${result.via}, ${result.level})`, { sessionId: id, device: result.session.device });
    return c.json(result);
  });

  app.get('/api/sessions/:id/location', async (c) => c.json(await svc().location(sid(c), { refresh: !!qBool(c.req.query('refresh')) })));

  // ----- Move to hub and Move back (core projects/hubcopy.ts) -----------------

  app.get('/api/sessions/:id/hub-copy', async (c) => c.json(await svc().copies.preview(sid(c))));

  app.delete('/api/sessions/:id/hub-copy', (c) => c.json({ cancelled: svc().copies.cancel(sid(c)) }));

  app.get('/api/sessions/:id/hub-copy/back', async (c) => c.json(await svc().copies.backPreview(sid(c))));

  app.post('/api/sessions/:id/hub-copy/back', async (c) => {
    const id = sid(c);
    const body = await readJson<Record<string, unknown>>(c);
    const input = { skipConflicts: !!optBool(body.skipConflicts, 'skipConflicts'), deleteRemoved: !!optBool(body.deleteRemoved, 'deleteRemoved') };
    audit(c, 'session.move-back', `${id} ${JSON.stringify(input)}`, { sessionId: id });
    return c.json(svc().copies.startBack(id, input), 202);
  });

  // ----- projects ------------------------------------------------------------

  app.post('/api/projects/identify', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const device = requireString(body.device, 'device');
    known(c, device);
    const path = pathString(body.path, 'path');
    const sessionId = optString(body.sessionId, 'sessionId');
    const projectId = optString(body.projectId, 'projectId');
    // a session or project named in the body must be the caller's own
    if (sessionId && engine.sessionAccount(sessionId) !== accountOf(c)) throw notFound(`unknown session ${sessionId}`);
    if (projectId && svc().get(projectId)?.accountId !== accountOf(c)) throw notFound(`unknown project ${projectId}`);
    return c.json(await svc().identify(device, path, { sessionId, projectId }));
  });

  app.get('/api/projects', (c) => c.json(svc().list(accountOf(c))));

  app.get('/api/projects/:id', (c) => {
    const p = svc().get(c.req.param('id'));
    if (!p) throw notFound(`unknown project ${c.req.param('id')}`);
    return c.json(p);
  });

  app.put('/api/projects/:id/locations', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const device = requireString(body.device, 'device');
    known(c, device);
    const project = await svc().pin(c.req.param('id'), device, pathString(body.path, 'path'));
    audit(c, 'project.pin', `${project.name} ${device} ${String(body.path)}`, { device });
    return c.json(project);
  });

  app.delete('/api/projects/:id/locations', (c) => {
    const device = requireString(c.req.query('device'), 'device');
    known(c, device);
    const path = requireString(c.req.query('path'), 'path');
    const project = svc().unpin(c.req.param('id'), device, path);
    audit(c, 'project.unpin', `${project.name} ${device} ${path}`, { device });
    return c.json(project);
  });

  // ----- devices -------------------------------------------------------------

  app.get('/api/devices/:id/folders', async (c) => {
    const device = c.req.param('id');
    known(c, device);
    return c.json(await svc().deviceFolders(device));
  });

  app.delete('/api/path-prefixes/:id', (c) => {
    if (!svc().deletePrefix(c.req.param('id'))) throw notFound(`unknown path pair ${c.req.param('id')}`);
    audit(c, 'path-prefix.delete', c.req.param('id'));
    return c.json({ ok: true as const });
  });
}
