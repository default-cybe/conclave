/**
 * Hub logs (docs/DESIGN.md 33; client: logs(), logsTail(), logErrors(),
 * setLogsDebug(), sendClientLogs(), exportLogs()).
 *
 *   GET  /api/logs                 size, days kept, errors today and this week, debug switch
 *   GET  /api/logs/tail            ?lines&after&level&component
 *   GET  /api/logs/errors          ?days: errors grouped by message
 *   PUT  /api/logs/debug           {hours}: debug lines for that long (0 is off)
 *   POST /api/logs/client          {app, version, platform, events}: what an app reports about itself
 *   GET  /api/logs/export          ?days=1|7|28&devices=0: a zip with the files, summary.md and the config without secrets
 *
 * The hub's owner reads them (docs/design/ACCOUNTS.md: hub wide, owner only);
 * no line holds a secret or message text. Any app may send its own lines.
 */
import type { Context, Hono } from 'hono';
import type { DaemonLogTail, LogLevel, LogsTailQuery } from '@conclave/core/client/index.ts';
import { CLIENT_BODY_MAX, DEBUG_MAX_HOURS, LEVELS } from '@conclave/core/logs/index.ts';
import { logsExport, type ExportDaemonLog, type ExportDevice } from '@conclave/core/logs/export.ts';
import { logger } from '@conclave/core/util/log.ts';
import type { HonoEnv, ServerContext } from './context';
import { BodyTooLarge, HttpError, auditFor, badRequest, qBool, qNum, readCapped, readJson } from './http';

const log = logger('logs');

/** How long the export waits for each device's log. */
const DEVICE_LOG_TIMEOUT_MS = 8_000;

function days(v: string | undefined, def: number): number {
  const n = qNum(v) ?? def;
  if (!Number.isInteger(n) || n < 1 || n > 28) throw badRequest('days must be a whole number from 1 to 28');
  return n;
}

function level(v: string | undefined): LogLevel | undefined {
  if (!v) return undefined;
  if (!(v in LEVELS)) throw badRequest('level must be debug, info, warn or error');
  return v as LogLevel;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Each paired device's recent daemon log; offline and old daemons say why there is none. */
async function deviceLogs(ctx: ServerContext): Promise<ExportDaemonLog[]> {
  const { engine } = ctx;
  // the owner's devices: a member's daemon logs are theirs (docs/design/ACCOUNTS.md)
  const devices = engine.devices.list('owner').filter((d) => d.id !== 'local');
  return Promise.all(
    devices.map(async (d): Promise<ExportDaemonLog> => {
      const base = { deviceId: d.id, name: d.name };
      const m = d.online ? engine.devices.get(d.id) : undefined;
      if (!m) return { ...base, error: 'offline' };
      if (!m.logTail) return { ...base, error: `its daemon is too old to send its log (protocol ${(m as { protocol?: number }).protocol ?? 'unknown'}); update it` };
      try {
        const tail: DaemonLogTail = await withTimeout(m.logTail(500), DEVICE_LOG_TIMEOUT_MS);
        return { ...base, tail };
      } catch (err) {
        return { ...base, error: `it did not send its log: ${(err as Error).message}` };
      }
    }),
  );
}

/** Providers that are set up: enabled, with a key, or a harness whose command is on the hub's PATH. Names only, never keys. */
function providerNames(ctx: ServerContext): string[] {
  const cfg = ctx.engine.config.get();
  const out: string[] = [];
  for (const [id, p] of Object.entries(cfg.providers)) {
    if (p.enabled === false) continue;
    if (p.type !== 'acp') {
      if (ctx.engine.config.hasProviderKey(id)) out.push(id);
      continue;
    }
    const found = p.command ? !!Bun.which(p.command) : false;
    out.push(`${id} (harness${found ? '' : `, ${p.command ?? 'no command'} not found on the hub`})`);
  }
  return out.sort();
}

/** The paired app behind a request, as client lines name it. */
function clientTag(ctx: ServerContext, c: Context<HonoEnv>): { id: string; device?: string; app: string } {
  const who = c.get('auth');
  if (!who || who.kind === 'owner') return { id: 'owner', device: 'owner token', app: 'app' };
  // each line says whose app sent it (docs/design/ACCOUNTS.md); the owner's apps carry nothing new
  return { id: who.clientId, ...(who.name ? { device: who.name } : {}), app: 'app', ...(who.accountId && who.accountId !== 'owner' ? { account: who.accountId } : {}) };
}

export function registerLogRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;
  const audit = auditFor(engine);

  app.get('/api/logs', async (c) => c.json(await ctx.logs.status()));

  app.get('/api/logs/tail', async (c) => {
    const q: LogsTailQuery = {
      lines: qNum(c.req.query('lines')),
      after: c.req.query('after') || undefined,
      level: level(c.req.query('level')),
      component: c.req.query('component') || undefined,
    };
    return c.json(await ctx.logs.reader.tail(q));
  });

  app.get('/api/logs/errors', async (c) => c.json(await ctx.logs.reader.errors(days(c.req.query('days'), 7))));

  app.put('/api/logs/debug', async (c) => {
    const body = await readJson<{ hours?: unknown }>(c);
    const hours = body.hours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > DEBUG_MAX_HOURS) throw badRequest(`hours must be a number from 0 to ${DEBUG_MAX_HOURS}`);
    const who = c.get('auth');
    const until = ctx.logs.setDebug(hours, who?.kind === 'owner' ? 'owner' : `client:${who?.clientId}`);
    audit(c, 'logs.debug', until ? `debug lines until ${new Date(until).toISOString()}` : 'debug lines off');
    return c.json(await ctx.logs.status());
  });

  app.post('/api/logs/client', async (c) => {
    const tooLarge = () => new HttpError(413, `A batch is ${CLIENT_BODY_MAX / 1024} KB at most.`);
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > CLIENT_BODY_MAX) throw tooLarge();
    // read up to the cap: a batch sent without a length is not held whole before it is measured
    let text: string;
    try {
      text = Buffer.from(await readCapped(c.req.raw.body, CLIENT_BODY_MAX)).toString('utf8');
    } catch (err) {
      if (err instanceof BodyTooLarge) throw tooLarge();
      throw err;
    }
    let body: unknown = {};
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw badRequest('invalid JSON body');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON body must be an object');
    return c.json(ctx.logs.ingestClient(clientTag(ctx, c), body));
  });

  app.get('/api/logs/export', async (c) => {
    const n = days(c.req.query('days'), 7);
    const withDevices = qBool(c.req.query('devices')) ?? true;
    const info = engine.info();
    const status = await ctx.logs.status();
    const devices: ExportDevice[] = engine.devices.list('owner').map((d) => ({
      id: d.id,
      name: d.name,
      online: d.online,
      ...(d.info?.platform ? { platform: `${d.info.platform}${d.info.arch ? ` ${d.info.arch}` : ''}` } : {}),
      ...(d.info?.daemon ? { daemon: `${d.info.daemon.impl} ${d.info.daemon.version}` } : d.id === 'local' ? { daemon: 'the hub itself' } : {}),
      ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
    }));
    const daemons = withDevices ? await deviceLogs(ctx) : [];
    // a TypeScript daemon does not name itself in its hello; its log does
    for (const d of daemons) {
      const dev = devices.find((x) => x.id === d.deviceId);
      if (dev && !dev.daemon && d.tail) dev.daemon = `${d.tail.impl}${d.tail.version ? ` ${d.tail.version}` : ''}`;
    }
    const out = await logsExport({
      reader: ctx.logs.reader,
      days: n,
      hub: { name: info.name, version: info.version, startedAt: info.startedAt },
      status,
      devices,
      providers: providerNames(ctx),
      config: engine.config.get() as unknown as Record<string, unknown>,
      daemons,
    });
    audit(c, 'logs.export', `${n} day${n === 1 ? '' : 's'}${withDevices ? `, ${daemons.filter((d) => d.tail).length} device logs` : ''}`);
    log.info('logs exported', { days: n, files: status.files, devices: daemons.filter((d) => d.tail).length });
    return new Response(out.stream, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${out.name}"`,
        'cache-control': 'no-store',
      },
    });
  });
}
