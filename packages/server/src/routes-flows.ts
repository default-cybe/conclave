/**
 * Flows in a Code session (docs/design/VISUAL-PROGRAMMING.md 4 to 6): list,
 * create, the graph, edit ops, undo, layout, Run and Stop. route-policy.ts
 * checks the session is the caller's own; the device is always the
 * session's. The work is in packages/core/src/flows.
 */
import type { Hono } from 'hono';
import type { Engine } from '@conclave/core/engine/engine.ts';
import { isMember } from '@conclave/core/people/context.ts';
import type { FlowOp } from '@conclave/core/client/flows.ts';
import { FLOW_BLOCKS } from '@conclave/core/flows/plugins.ts';
import { flowsOf } from '@conclave/core/flows/service.ts';
import { canvasQueueOf } from '@conclave/core/canvas/queue.ts';
import { newProgram } from '@conclave/core/canvas/new.ts';
import type { HonoEnv, ServerContext } from './context';
import { badRequest, optString, readJson } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf, ownSession } from './scope';

const OPS = ['set', 'connect', 'disconnect', 'insert', 'remove', 'rename'];
const short = (v: unknown, name: string) => {
  const s = optString(v, name, 100);
  if (!s) throw badRequest(`${name} is required`);
  return s;
};

/** Validate an op body; the core checks names against the flow. */
function opOf(b: Record<string, unknown>): FlowOp {
  switch (b.op) {
    case 'set': {
      const v = b.value;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw badRequest('value is text, a number or true/false');
      if (typeof v === 'string' && v.length > 20_000) throw badRequest('value is at most 20,000 characters');
      return { op: 'set', nodeId: short(b.nodeId, 'nodeId'), input: short(b.input, 'input'), value: v };
    }
    case 'connect': {
      const field = optString(b.field, 'field', 200);
      return { op: 'connect', nodeId: short(b.nodeId, 'nodeId'), input: short(b.input, 'input'), from: short(b.from, 'from'), ...(field ? { field } : {}) };
    }
    case 'disconnect':
      return { op: 'disconnect', nodeId: short(b.nodeId, 'nodeId'), input: short(b.input, 'input') };
    case 'insert': {
      const after = optString(b.after, 'after', 100);
      return { op: 'insert', block: short(b.block, 'block'), ...(after ? { after } : {}) };
    }
    case 'remove':
      return { op: 'remove', nodeId: short(b.nodeId, 'nodeId') };
    case 'rename':
      return { op: 'rename', nodeId: short(b.nodeId, 'nodeId'), name: short(b.name, 'name') };
    default:
      throw badRequest(`op must be one of ${OPS.join(', ')}`);
  }
}

export function registerFlowRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const svc = () => flowsOf(ctx.engine as unknown as Engine);

  // the block catalog for the canvas's search; Call AI bills a gateway key, so members do not see it
  app.get('/api/graph/nodes', (c) => {
    if (c.req.query('use') !== 'program') throw badRequest('use=program is the only catalog');
    const member = isMember(accountOf(c));
    return c.json(FLOW_BLOCKS.filter((b) => !member || !b.ownerOnly));
  });

  app.get('/api/sessions/:id/flows', async (c) => c.json(await svc().list(c.req.param('id'))));

  app.post('/api/sessions/:id/flows/:name', async (c) => {
    const v = await svc().create(c.req.param('id'), c.req.param('name'));
    audit(c, 'flow.create', `${c.req.param('id')} ${v.path}`);
    return c.json(v, 201);
  });

  // Canvas's title: the file (and its layout) under a new name
  app.post('/api/sessions/:id/flows/:name/rename', async (c) => {
    const body = await readJson<{ to?: unknown }>(c);
    const v = await svc().rename(c.req.param('id'), c.req.param('name'), short(body.to, 'to'));
    audit(c, 'flow.rename', `${c.req.param('id')} ${c.req.param('name')} to ${v.name}`);
    return c.json(v);
  });

  // Canvas's New: a blank program in the folder named, else the caller's Canvas folder on the hub (core canvas/new.ts); members name a folder on their own device
  app.post('/api/canvas/programs', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    const name = optString(b.name, 'name', 64);
    const made = await newProgram(ctx.engine as unknown as Engine, accountOf(c), { device: optString(b.device, 'device', 512), cwd: optString(b.cwd, 'cwd', 4096), ...(name ? { name } : {}) });
    audit(c, 'flow.create', `${made.sessionId} ${made.cwd}/${made.view.path}`);
    return c.json(made, 201);
  });

  app.get('/api/sessions/:id/flows/:name/graph', async (c) => c.json(await svc().view(c.req.param('id'), c.req.param('name'))));

  app.post('/api/sessions/:id/flows/:name/graph/op', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const op = opOf(body);
    const res = await svc().edit(c.req.param('id'), c.req.param('name'), op, short(body.baseSha, 'baseSha'), { member: isMember(accountOf(c)) });
    audit(c, 'flow.edit', `${c.req.param('id')} ${c.req.param('name')} ${op.op}`);
    return c.json(res);
  });

  app.post('/api/sessions/:id/flows/:name/graph/restore', async (c) => {
    const body = await readJson<{ sha?: unknown; baseSha?: unknown }>(c);
    return c.json(await svc().restore(c.req.param('id'), c.req.param('name'), short(body.sha, 'sha'), short(body.baseSha, 'baseSha')));
  });

  app.put('/api/sessions/:id/flows/:name/graph/layout', async (c) => {
    const body = await readJson<{ nodes?: unknown }>(c);
    if (!body.nodes || typeof body.nodes !== 'object' || Array.isArray(body.nodes)) throw badRequest('nodes must be an object of { x, y } by node id');
    return c.json({ nodes: await svc().saveLayout(c.req.param('id'), c.req.param('name'), body.nodes) });
  });

  // Run asks like an agent's Bash call would, then runs in the background; the page polls the run
  app.post('/api/sessions/:id/flows/:name/run', async (c) => c.json(await svc().run(c.req.param('id'), c.req.param('name'))));
  app.get('/api/sessions/:id/flows/:name/run', (c) => c.json(svc().runState(c.req.param('id'), c.req.param('name')) ?? null, 200, { 'cache-control': 'no-store' }));
  app.post('/api/sessions/:id/flows/:name/stop', (c) => c.json(svc().stop(c.req.param('id'), c.req.param('name')) ?? null));

  // Canvas's run queue (core/canvas/queue.ts): the caller's own queued runs; the hub starts each when its file's last run ends
  const queue = () => canvasQueueOf(ctx.engine as unknown as Engine);
  app.get('/api/canvas/queue', (c) => c.json(queue().list(accountOf(c), optString(c.req.query('file'), 'file', 400)), 200, { 'cache-control': 'no-store' }));
  app.post('/api/canvas/queue', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    const workflow = optString(b.workflow, 'workflow', 512);
    let item;
    if (workflow) {
      if (b.args !== undefined && (typeof b.args !== 'object' || b.args === null || Array.isArray(b.args))) throw badRequest('args must be a JSON object');
      item = await queue().add(accountOf(c), { workflow, ...(b.args ? { args: b.args as Record<string, unknown> } : {}) });
    } else {
      const sessionId = short(b.sessionId, 'sessionId');
      // someone else's session answers 404, as a missing one
      ownSession(ctx.engine, c, sessionId);
      item = await queue().add(accountOf(c), { sessionId, flow: short(b.flow, 'flow') });
    }
    audit(c, 'canvas.queue', `${item.file} ${item.id}`);
    return c.json(item, 201);
  });
  app.delete('/api/canvas/queue/:id', (c) => {
    queue().cancel(accountOf(c), c.req.param('id'));
    audit(c, 'canvas.queue.cancel', c.req.param('id'));
    return c.body(null, 204);
  });
}
