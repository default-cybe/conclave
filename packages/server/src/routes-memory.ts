/**
 * Memory connections, file import and export (docs/MEMORY.md). Thin
 * handlers over engine.memoryAdmin (memory/connections/service.ts). The
 * service throws EngineError with a status (400, 404, 409, 502), which the
 * error handler maps.
 */
import type { Context, Hono } from 'hono';
import type { MemoryConnectionInputDto, MemoryConnectionConfigDto } from '@conclave/core/client/index.ts';
import type { HonoEnv, ServerContext } from './context';
import type { AuditFn } from './routes-extensions';
import { HttpError, badRequest, notFound, qBool, readJson, requireString } from './http';
import { importOf } from '@conclave/core/import/registry.ts';
import { DigestError, digestOf, type DailyDigest } from '@conclave/core/memory/digest.ts';
import { isMember } from '@conclave/core/people/context.ts';
import { MEMBER_STDIO_REFUSED } from '@conclave/core/people/memory.ts';
import { accountOf, ownDevice } from './scope';

export function registerMemoryRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;
  // every handler works on the caller's own memory and connections (docs/design/ACCOUNTS.md 2)
  const admin = (c: Context<HonoEnv>) => engine.memoryAdminFor(accountOf(c));
  const changed = () => engine.bus.emit({ type: 'config.updated' });

  /**
   * A member's connection is Basic Memory as the hub runs it, or a server at a
   * public address: no program of their own, no hub MCP server by name. The
   * client factory refuses the same at connect time; this says so up front.
   */
  const checkMemberConnection = (c: Context<HonoEnv>, body: { options?: unknown }): void => {
    if (!isMember(accountOf(c))) return;
    const o = body.options && typeof body.options === 'object' ? (body.options as Record<string, unknown>) : {};
    if (o.command !== undefined || o.args !== undefined || o.env !== undefined || o.server !== undefined) throw badRequest(MEMBER_STDIO_REFUSED);
  };

  const machineFor = (c: Context<HonoEnv>, device: unknown) => {
    const id = ownDevice(engine, c, device);
    const m = engine.devices.get(id);
    if (m) return m;
    if (engine.repos.devices.get(id)) throw new HttpError(409, `device ${id} is offline`);
    throw notFound(`unknown device ${id}`);
  };

  const id = (c: Context) => c.req.param('id') ?? '';

  // the daily digest switch (Settings, Memory): on installs the routine, off disables it
  const digest = (): DailyDigest => {
    const d = digestOf(engine);
    if (!d) throw new HttpError(503, 'the daily digest is not available on this hub');
    return d;
  };
  app.get('/api/memory/digest', (c) => c.json(digest().settings()));
  app.put('/api/memory/digest', async (c) => {
    const body = await readJson<{ enabled?: unknown; time?: unknown }>(c);
    try {
      const out = digest().set(body);
      audit(c, 'memory.digest', `${out.enabled ? 'on' : 'off'}, ${out.time}`);
      return c.json(out);
    } catch (err) {
      if (err instanceof DigestError) throw new HttpError(err.status, err.message);
      throw err;
    }
  });

  // fixed paths first, then /:id
  app.get('/api/memory/connections', (c) => c.json(admin(c).listConnections()));
  app.get('/api/memory/connections/presets', (c) => c.json(admin(c).presets()));

  app.post('/api/memory/connections/test', async (c) => {
    const body = await readJson<MemoryConnectionInputDto>(c);
    if (typeof body.type !== 'string') throw badRequest('type is required');
    checkMemberConnection(c, body);
    return c.json(await admin(c).testConnection(body as never));
  });

  app.post('/api/memory/connections', async (c) => {
    const body = await readJson<MemoryConnectionInputDto>(c);
    if (typeof body.type !== 'string') throw badRequest('type is required');
    checkMemberConnection(c, body);
    const conn = admin(c).addConnection(body as never);
    audit(c, 'memory.connection.add', `${conn.id} (${conn.type}, ${conn.mode})`);
    changed();
    return c.json(conn);
  });

  app.get('/api/memory/connections/:id', (c) => c.json(admin(c).getConnection(id(c))));

  app.patch('/api/memory/connections/:id', async (c) => {
    const body = await readJson<Partial<MemoryConnectionConfigDto>>(c);
    checkMemberConnection(c, body);
    const conn = admin(c).updateConnection(id(c), body as never);
    audit(c, 'memory.connection.update', `${conn.id} (${conn.type}, ${conn.mode}${conn.enabled ? '' : ', disabled'})`);
    changed();
    return c.json(conn);
  });

  app.delete('/api/memory/connections/:id', async (c) => {
    const keepImported = qBool(c.req.query('keepImported')) ?? false;
    if (!(await admin(c).removeConnection(id(c), { keepImported }))) throw notFound(`unknown memory connection ${id(c)}`);
    audit(c, 'memory.connection.remove', `${id(c)}${keepImported ? ' (kept imported notes)' : ''}`);
    changed();
    return c.json({ ok: true as const });
  });

  app.post('/api/memory/connections/:id/test', async (c) => c.json(await admin(c).testConnection(id(c))));

  app.post('/api/memory/connections/:id/sync', async (c) => {
    const res = await admin(c).syncConnection(id(c));
    audit(c, 'memory.connection.sync', `${id(c)}: +${res.added} ~${res.updated} -${res.removed} of ${res.total}`);
    return c.json(res);
  });

  app.delete('/api/memory/connections/:id/imported', async (c) => {
    admin(c).getConnection(id(c));
    const removed = await admin(c).clearImported(id(c));
    audit(c, 'memory.connection.clear', `${id(c)}: ${removed} notes`);
    return c.json({ ok: true as const, removed });
  });

  app.get('/api/memory/connections/:id/connect', (c) => c.json(engine.memoryConnectPlan(id(c), accountOf(c))));

  // Basic Memory: switch to a few grouped notes, then optionally delete the per-fact notes Conclave wrote before
  app.post('/api/memory/connections/:id/group', async (c) => {
    const body = await readJson<{ deletePerFact?: unknown }>(c);
    if (body.deletePerFact !== undefined && typeof body.deletePerFact !== 'boolean') throw badRequest('deletePerFact must be true or false');
    const r = await admin(c).groupNotes(id(c), { deletePerFact: body.deletePerFact === true });
    audit(c, 'memory.connection.group', `${id(c)}: ${r.notes} grouped notes${body.deletePerFact ? `, ${r.deleted} per-fact notes deleted` : ''}`);
    changed();
    return c.json(r);
  });

  // ----- import from other tools' memory files ------------------------------

  app.post('/api/memory/import', async (c) => {
    const body = await readJson<{ device?: unknown; paths?: unknown; cwd?: unknown; force?: unknown; dryRun?: unknown }>(c);
    const machine = machineFor(c, body.device);
    if (body.paths !== undefined && (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string'))) throw badRequest('paths must be a list of strings');
    if (body.cwd !== undefined && typeof body.cwd !== 'string') throw badRequest('cwd must be a string');
    const res = await admin(c).importFromFiles(machine, body.paths as string[] | undefined, {
      cwd: (body.cwd as string | undefined) || undefined,
      force: body.force === true,
      dryRun: body.dryRun === true,
    });
    if (body.dryRun !== true) audit(c, 'memory.import', `${res.added.length} added, ${res.updated.length} updated from ${res.files.filter((f) => f.status === 'imported').length} files`, { device: machine.id });
    return c.json(res);
  });

  // ----- export as markdown ---------------------------------------------------

  app.get('/api/memory/export', (c) => {
    const q = c.req.query();
    const layout = q.layout || undefined;
    if (layout && layout !== 'single' && layout !== 'folder') throw badRequest('layout must be single or folder');
    const out = admin(c).exportMarkdown({ layout: layout as 'single' | 'folder' | undefined, includeImported: qBool(q.includeImported) ?? false, root: q.root || undefined });
    if (q.format === 'md') {
      if (out.layout !== 'single') throw badRequest('format=md needs layout=single');
      return new Response(out.files[0]?.content ?? '', {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename=conclave-memory.md', 'cache-control': 'no-store' },
      });
    }
    return c.json(out);
  });

  app.post('/api/memory/export', async (c) => {
    const body = await readJson<{ device?: unknown; dir?: unknown; layout?: unknown; includeImported?: unknown; root?: unknown }>(c);
    const machine = machineFor(c, body.device);
    const dir = requireString(body.dir, 'dir');
    if (body.layout !== undefined && body.layout !== 'single' && body.layout !== 'folder') throw badRequest('layout must be single or folder');
    const res = await admin(c).exportMarkdownTo(machine, dir, {
      layout: body.layout as 'single' | 'folder' | undefined,
      includeImported: body.includeImported === true,
      root: typeof body.root === 'string' && body.root ? body.root : undefined,
    });
    audit(c, 'memory.export', `${res.count} memories to ${res.dir}`, { device: machine.id });
    return c.json(res);
  });

  // ----- review queue: learned preferences seen in one session (chat import, 1.7) -----

  const importer = () => {
    const s = importOf(engine);
    if (!s) throw new HttpError(501, 'Chat import is not available on this hub.');
    return s;
  };

  app.get('/api/memory/review', (c) => c.json(importer().reviewQueue()));

  app.post('/api/memory/review', async (c) => {
    const body = await readJson<{ accept?: unknown; reject?: unknown }>(c);
    const ids = (v: unknown, name: string): string[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${name} must be a list of memory ids`);
      return v as string[];
    };
    const accept = ids(body.accept, 'accept');
    const reject = ids(body.reject, 'reject');
    if (!accept.length && !reject.length) throw badRequest('accept or reject is required');
    const r = await importer().answerReview({ accept, reject });
    audit(c, 'memory.review', `${r.accepted} accepted, ${r.rejected} rejected`);
    return c.json(r);
  });

  // ----- stats (replaces the old handler: reports connections) --------------

  app.get('/api/memory/stats', (c) => {
    let connections: Array<{ id: string; type: string; mode: string; state: string }> = [];
    try {
      connections = admin(c).listConnections().map((x) => ({ id: x.id, type: x.type, mode: x.mode, state: x.status.state }));
    } catch {
      connections = [];
    }
    const stats = engine.memoryFor(accountOf(c)).stats();
    // external keeps its old meaning (a store type such as "basic-memory"); clients read its first word
    const types = [...new Set(connections.map((x) => x.type))];
    return c.json({ ...stats, external: types.length ? types.join(' ') : undefined, connections });
  });
}
