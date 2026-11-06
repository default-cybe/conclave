/**
 * Security mode approval grants (docs/design/SECURITY-MODE.md 4.3), owner only:
 *
 *   GET  /api/sessions/:id/grants                  the hunt's grants, newest first
 *   POST /api/sessions/:id/grants/:grant/revoke    revoke one now (the lane chip menu)
 *
 * Grants are issued only through a SecurityGrant approval (core session/grants.ts);
 * no route adds one. The id is the hunt's session (the topmost scope-guard session).
 */
import type { Hono } from 'hono';
import { grantsOf, revokeGrant } from '@conclave/core/security/grants.ts';
import type { HonoEnv, ServerContext } from './context';
import { notFound } from './http';

export function registerGrantRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;

  app.get('/api/sessions/:id/grants', (c) => c.json(grantsOf(engine.repos.kv, c.req.param('id')).map(({ scope: _pinned, ...g }) => g).reverse()));

  app.post('/api/sessions/:id/grants/:grant/revoke', (c) => {
    const id = c.req.param('id');
    const g = revokeGrant(engine.repos.kv, id, c.req.param('grant'));
    if (!g) throw notFound('This session has no such grant.');
    engine.repos.audit.add({ actor: 'owner', action: 'security.grant.revoke', detail: `${g.id} ${g.hosts.join(',')}`, sessionId: id });
    const { scope: _pinned, ...out } = g;
    return c.json(out);
  });
}
