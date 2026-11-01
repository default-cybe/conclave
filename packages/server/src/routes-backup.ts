/**
 * Backup and restore routes (client: backup(), restore()).
 *
 *   GET  /api/backup?secrets=1&sessions=0   the hub's state as a JSON download
 *   POST /api/restore?config=0              body: the file GET /api/backup gave
 *
 * Keys leave the hub only with the owner token: a paired phone can download
 * a backup, but not one with secrets in it.
 */
import type { Hono } from 'hono';
import type { HonoEnv, ServerContext } from './context';
import type { AuditFn } from './routes-extensions';
import { HttpError, qBool } from './http';

function fileName(hub: string, at: number): string {
  const day = new Date(at).toISOString().slice(0, 10);
  const name = hub.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'hub';
  return `conclave-backup-${name}-${day}.json`;
}

export function registerBackupRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;

  app.get('/api/backup', (c) => {
    const secrets = qBool(c.req.query('secrets')) ?? false;
    const sessions = qBool(c.req.query('sessions')) ?? true;
    if (secrets && c.get('auth')?.kind !== 'owner') {
      throw new HttpError(403, 'Only the owner token can put keys in a backup. Connect with the token from conclave serve, or leave keys out.');
    }
    const backup = engine.backup({ secrets, sessions });
    audit(c, 'backup.download', `${backup.counts.sessions} sessions, ${backup.counts.memories} notes${secrets ? ', with keys' : ''}`);
    return c.json(backup, 200, {
      'content-disposition': `attachment; filename="${fileName(backup.hub.name, backup.createdAt)}"`,
      'cache-control': 'no-store',
    });
  });

  app.post('/api/restore', async (c) => {
    const text = await c.req.text();
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, 'The file is not valid JSON. Pick the .json file that Download a backup saved.');
    }
    const config = qBool(c.req.query('config')) ?? true;
    const result = await engine.restore(body, { config });
    const r = result.restored;
    audit(c, 'backup.restore', `${r.sessions} sessions, ${r.memories} notes, ${r.routines} routines, ${r.agents} agents${result.config ? ', settings' : ''}`);
    return c.json(result);
  });
}
