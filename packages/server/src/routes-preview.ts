/**
 * A Code session's Preview pane (core/browser/preview.ts): its state and
 * log, start and stop, and the toolbar's reload, address, size, theme and
 * element picker. Frames and input are the live view's routes
 * (/api/browser/sessions/:session/*). The owner only (route-policy.ts).
 */
import type { Hono } from 'hono';
import type { Machine } from '@conclave/core/machine/types.ts';
import type { Session } from '@conclave/core/types.ts';
import { PreviewConfirm, VIEW_WIDTHS, pickText, wrapUntrusted, type PreviewService } from '@conclave/core/browser/index.ts';
import type { HonoEnv, ServerContext } from './context';
import type { AuditFn } from './routes-extensions';
import { HttpError, readJson } from './http';

function previewOf(engine: object): PreviewService | undefined {
  return (engine as { preview?: PreviewService }).preview;
}

export function registerPreviewRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const engine = ctx.engine;
  const service = (): PreviewService => {
    const p = previewOf(engine);
    if (!p) throw new HttpError(501, 'This hub has no browser.');
    return p;
  };
  const session = (id: string): Session => {
    const s = engine.getSession(id);
    if (!s) throw new HttpError(404, 'There is no such session.');
    return s;
  };
  const fail = (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message);
  };

  app.get('/api/sessions/:id/preview', (c) => {
    const s = session(c.req.param('id'));
    return c.json(previewOf(engine)?.state(s.id) ?? { running: false, targets: [], logs: 0 }, 200, { 'cache-control': 'no-store' });
  });

  app.post('/api/sessions/:id/preview/start', async (c) => {
    const s = session(c.req.param('id'));
    const body = await readJson<{ name?: unknown; file?: unknown; command?: unknown }>(c);
    const name = typeof body.name === 'string' && body.name ? body.name : undefined;
    const file = typeof body.file === 'string' && body.file ? body.file : undefined;
    const command = typeof body.command === 'string' ? body.command : undefined;
    const machine = (engine as unknown as { machineFor(s: Session): Machine }).machineFor(s);
    // launch.json is code from the repo: it runs at once only in a trusted folder; elsewhere the owner sees the line first
    const trusted = engine.projectTrust(s.cwd).trusted;
    let st;
    try {
      st = await service().start(s.id, machine, s.cwd, { name, file, command, trusted });
    } catch (err) {
      if (err instanceof PreviewConfirm) return c.json({ running: false, targets: [], logs: 0, confirm: { name: err.config, command: err.line } });
      return fail(err);
    }
    audit(c, 'preview.start', `session ${s.id}: ${st.name}`);
    return c.json(st);
  });

  app.post('/api/sessions/:id/preview/stop', async (c) => {
    const s = session(c.req.param('id'));
    await service().stop(s.id);
    return c.json(service().state(s.id));
  });

  app.post('/api/sessions/:id/preview/reload', async (c) => {
    const s = session(c.req.param('id'));
    await service().reload(s.id).catch(fail);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/preview/navigate', async (c) => {
    const s = session(c.req.param('id'));
    const body = await readJson<{ url?: unknown }>(c);
    if (typeof body.url !== 'string') throw new HttpError(400, 'url must be a string');
    await service().navigate(s.id, body.url).catch(fail);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/preview/view', async (c) => {
    const s = session(c.req.param('id'));
    const body = await readJson<{ width?: unknown; colorScheme?: unknown }>(c);
    if (body.width !== undefined && !VIEW_WIDTHS.includes(body.width as never)) throw new HttpError(400, `width must be one of ${VIEW_WIDTHS.join(', ')}`);
    if (body.colorScheme !== undefined && body.colorScheme !== 'light' && body.colorScheme !== 'dark') throw new HttpError(400, 'colorScheme must be light or dark');
    await service()
      .view(s.id, { width: body.width as number | undefined, colorScheme: body.colorScheme as 'light' | 'dark' | undefined })
      .catch(fail);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/preview/pick', async (c) => {
    const s = session(c.req.param('id'));
    const body = await readJson<{ x?: unknown; y?: unknown }>(c);
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 20_000;
    if (!ok(body.x) || !ok(body.y)) throw new HttpError(400, 'x and y must be page coordinates');
    const r = await service().pick(s.id, body.x, body.y).catch(fail);
    // everything in a pick is page data: fenced before it can reach a prompt
    return c.json({ ...r, text: wrapUntrusted(r.pick.url || 'preview', pickText(r.pick)) }, 200, { 'cache-control': 'no-store' });
  });

  app.get('/api/sessions/:id/preview/logs', (c) => {
    const s = session(c.req.param('id'));
    const after = Number(c.req.query('after') ?? 0) || 0;
    return c.json({ entries: previewOf(engine)?.logs(s.id, after) ?? [] }, 200, { 'cache-control': 'no-store' });
  });
}
