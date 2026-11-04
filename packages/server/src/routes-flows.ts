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
import type { HonoEnv, ServerContext } from './context';
import { badRequest, optString, readJson } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf } from './scope';

const OPS = ['set', 'connect', 'disconnect', 'insert', 'remove'];
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
}
