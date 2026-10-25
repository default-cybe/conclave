/**
 * Chat import and memory learning (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13):
 * scanning devices for past Claude Code, Codex and Gemini CLI sessions,
 * uploads of claude.ai and ChatGPT exports, the cost estimate, batches
 * (with pause, resume, cancel and undo), re-syncing one imported session,
 * and the vendor cleanup settings that delete old chats. The work is in
 * packages/core/src/import; these handlers validate and call it.
 *
 * The two older routes (GET /api/import/sessions, POST /api/import) live
 * here too and go through the same ledger, so a session is never imported twice.
 *
 * The offer made when a computer pairs (import/offers.ts, docs/DESIGN.md 38):
 *   GET  /api/import/offers                 the caller's open offers
 *   POST /api/import/offers/:device/dismiss Not now: the device is not offered again
 */
import type { Context, Hono } from 'hono';
import type { ImportBatchInput, ImportEstimateInput, ImportMode, ImportScanQuery, ImportSelection, ImportSessionKind, ImportSource } from '@conclave/core/client/import.ts';
import { importOf, importOffersOf } from '@conclave/core/import/registry.ts';
import type { ImportService } from '@conclave/core/import/service.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, notFound, optBool, optString, qBool, qNum, readJson, requireString } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf } from './scope';

const SOURCES: readonly ImportSource[] = ['claude-code', 'codex', 'gemini', 'opencode', 'claude-ai', 'chatgpt'];
const KINDS: readonly ImportSessionKind[] = ['main', 'subagent', 'automation', 'internal'];
const MODES: readonly ImportMode[] = ['chats', 'chats-learn', 'learn'];

function list<T extends string>(v: unknown, allowed: readonly T[], name: string): T[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : undefined;
  if (!items || items.some((x) => typeof x !== 'string' || !allowed.includes(x.trim() as T))) throw badRequest(`${name} must be a list of ${allowed.join(', ')}`);
  return items.map((x) => (x as string).trim() as T);
}

function strings(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${name} must be a list of strings`);
  return v as string[];
}

function time(v: unknown, name: string): number | string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && (Number.isFinite(Number(v)) || !Number.isNaN(Date.parse(v)))) return v;
  throw badRequest(`${name} must be a date or epoch ms`);
}

type QueryPart = Omit<ImportScanQuery, 'cursor' | 'limit' | 'refresh' | 'device'>;

/** The filter part of a scan query, from a JSON object or URL query values. */
function queryOf(q: Record<string, unknown>): QueryPart {
  return {
    ...(list(q.sources, SOURCES, 'sources') ? { sources: list(q.sources, SOURCES, 'sources') } : {}),
    ...(time(q.since, 'since') !== undefined ? { since: time(q.since, 'since') } : {}),
    ...(time(q.until, 'until') !== undefined ? { until: time(q.until, 'until') } : {}),
    ...(optString(q.project, 'project') ? { project: optString(q.project, 'project') } : {}),
    ...(list(q.kinds, KINDS, 'kinds') ? { kinds: list(q.kinds, KINDS, 'kinds') } : {}),
    ...(typeof q.includeImported === 'boolean' ? { includeImported: q.includeImported } : {}),
    ...(typeof q.includeSkipped === 'boolean' ? { includeSkipped: q.includeSkipped } : {}),
    ...(optString(q.q, 'q') ? { q: optString(q.q, 'q') } : {}),
  };
}

export function registerImportRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;
  const svc = (): ImportService => {
    const s = importOf(engine);
    if (!s) throw new HttpError(501, 'Chat import is not available on this hub.');
    return s;
  };

  /** A device the hub knows (online or not), "local", or an upload. */
  const knownDevice = (v: unknown): string => {
    const id = typeof v === 'string' && v ? v : 'local';
    if (id === 'local' || id.startsWith('upload:') || engine.devices.get(id) || engine.repos.devices.get(id)) return id;
    throw notFound(`unknown device ${id}`);
  };
  const onlineDevice = (v: unknown): string => {
    const id = knownDevice(v);
    if (!id.startsWith('upload:') && !engine.devices.get(id)) throw new HttpError(409, `device ${id} is offline`);
    return id;
  };

  const selection = (body: Record<string, unknown>): ImportSelection => {
    const device = knownDevice(body.device);
    if (body.query !== undefined && (typeof body.query !== 'object' || body.query === null || Array.isArray(body.query))) throw badRequest('query must be an object');
    return {
      device,
      ...(strings(body.keys, 'keys') ? { keys: strings(body.keys, 'keys') } : {}),
      ...(body.query ? { query: queryOf(body.query as Record<string, unknown>) } : {}),
      ...(strings(body.exclude, 'exclude') ? { exclude: strings(body.exclude, 'exclude') } : {}),
      ...(strings(body.sessionIds, 'sessionIds') ? { sessionIds: strings(body.sessionIds, 'sessionIds') } : {}),
      ...(optBool(body.notLearned, 'notLearned') ? { notLearned: true } : {}),
    };
  };
  const modeOf = (v: unknown): ImportMode => {
    if (typeof v !== 'string' || !MODES.includes(v as ImportMode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);
    return v as ImportMode;
  };
  const batchId = (c: Context) => c.req.param('id') ?? '';

  // ----- scan and estimate ---------------------------------------------------

  app.get('/api/import/scan', async (c) => {
    const q = c.req.query();
    const query: ImportScanQuery = {
      device: knownDevice(q.device),
      ...queryOf({ ...q, includeImported: qBool(q.includeImported), includeSkipped: qBool(q.includeSkipped) }),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(qNum(q.limit) !== undefined ? { limit: qNum(q.limit) } : {}),
      ...(qBool(q.refresh) ? { refresh: true } : {}),
    };
    return c.json(await svc().scan(query));
  });

  app.post('/api/import/estimate', async (c) => {
    const body = await readJson(c);
    const input: ImportEstimateInput = {
      ...selection(body),
      mode: modeOf(body.mode),
      ...(optString(body.model, 'model') ? { model: optString(body.model, 'model') } : {}),
      ...(optBool(body.includeSkipped, 'includeSkipped') ? { includeSkipped: true } : {}),
    };
    return c.json(await svc().estimate(input));
  });

  // ----- batches -------------------------------------------------------------

  app.get('/api/import/batches', (c) => c.json(svc().batches()));

  app.post('/api/import/batches', async (c) => {
    const body = await readJson(c);
    const input: ImportBatchInput = {
      ...selection(body),
      mode: modeOf(body.mode),
      ...(optString(body.model, 'model') ? { model: optString(body.model, 'model') } : {}),
      ...(optBool(body.includeSkipped, 'includeSkipped') ? { includeSkipped: true } : {}),
      ...(optBool(body.episodeNotes, 'episodeNotes') ? { episodeNotes: true } : {}),
    };
    const b = await svc().startBatch(input);
    // an import from a newly paired computer answers its offer
    importOffersOf(engine)?.imported(b.device);
    audit(c, 'import.start', `${b.mode}, ${b.total} sessions`, { device: b.device.startsWith('upload:') ? undefined : b.device });
    return c.json(b);
  });

  // ----- the offer made when a computer pairs (import/offers.ts) -------------

  app.get('/api/import/offers', (c) => c.json(importOffersOf(engine)?.list(accountOf(c)) ?? []));

  app.post('/api/import/offers/:device/dismiss', (c) => {
    const device = c.req.param('device') ?? '';
    if (!importOffersOf(engine)?.dismiss(device, accountOf(c))) throw notFound('There is no import offer for this device.');
    audit(c, 'import.offer.dismiss', device, { device });
    return c.json({ ok: true as const });
  });

  app.get('/api/import/batches/:id', (c) => c.json(svc().batch(batchId(c), c.req.query('cursor') || undefined)));

  app.post('/api/import/batches/:id/pause', (c) => {
    const b = svc().pause(batchId(c));
    audit(c, 'import.pause', b.id);
    return c.json(b);
  });

  app.post('/api/import/batches/:id/resume', (c) => {
    const b = svc().resume(batchId(c));
    audit(c, 'import.resume', b.id);
    return c.json(b);
  });

  app.post('/api/import/batches/:id/cancel', (c) => {
    const b = svc().cancel(batchId(c));
    audit(c, 'import.cancel', b.id);
    return c.json(b);
  });

  app.post('/api/import/batches/:id/undo', async (c) => {
    const r = await svc().undo(batchId(c));
    audit(c, 'import.undo', `${batchId(c)}: ${r.sessionsRemoved} sessions, ${r.messagesRemoved} messages, ${r.memoriesRemoved} memories removed, ${r.kept.length} kept`);
    return c.json(r);
  });

  // ----- uploads of claude.ai and ChatGPT exports ----------------------------

  app.post('/api/import/upload', async (c) => {
    const source = c.req.query('source');
    if (source !== 'claude-ai' && source !== 'chatgpt') throw badRequest('source must be claude-ai or chatgpt');
    const body = new Uint8Array(await c.req.arrayBuffer());
    const name = c.req.query('name') || undefined;
    const r = svc().upload(source, body, name ? name.slice(0, 200) : undefined);
    audit(c, 'import.upload', `${source}: ${r.items} conversations`);
    return c.json(r);
  });

  // ----- one imported session ------------------------------------------------

  app.post('/api/import/sessions/:sessionId/sync', async (c) => {
    const id = c.req.param('sessionId') ?? '';
    if (!engine.repos.sessions.get(id)) throw notFound(`unknown session ${id}`);
    const r = await svc().syncSession(id);
    if (r.state !== 'unchanged') audit(c, 'import.sync', `${r.state}, ${r.added} messages`, { sessionId: id });
    return c.json(r);
  });

  // one session per Claude Code chat: a dry run unless apply is true
  app.post('/api/import/merge-duplicates', async (c) => {
    const body = await readJson<{ apply?: unknown }>(c);
    const r = svc().mergeDuplicates({ apply: body.apply === true });
    if (!r.dryRun) audit(c, 'import.merge', `${r.groups.length} chats merged`, {});
    return c.json(r);
  });

  // ----- vendor cleanup settings ---------------------------------------------

  app.get('/api/import/retention', async (c) => c.json(await svc().retention(onlineDevice(c.req.query('device')))));

  app.post('/api/import/retention', async (c) => {
    const body = await readJson<{ device?: unknown; tool?: unknown }>(c);
    const device = onlineDevice(body.device);
    const tool = requireString(body.tool, 'tool');
    if (tool !== 'claude-code' && tool !== 'gemini') throw badRequest('tool must be claude-code or gemini');
    const r = await svc().fixRetention(device, tool);
    audit(c, 'import.retention', `${tool} keeps chats for 10 years`, { device });
    return c.json(r);
  });

  // ----- older routes, kept for old clients and the CLI ----------------------

  app.get('/api/import/sessions', async (c) => {
    const device = onlineDevice(c.req.query('device'));
    return c.json(await engine.externalSessions(device));
  });

  app.post('/api/import', async (c) => {
    const body = await readJson<{ source?: unknown; id?: unknown; device?: unknown }>(c);
    if (body.source !== 'claude-code' && body.source !== 'codex') throw badRequest('source must be one of claude-code, codex');
    const device = onlineDevice(body.device);
    return c.json(await engine.importSession(body.source, requireString(body.id, 'id'), device));
  });
}
