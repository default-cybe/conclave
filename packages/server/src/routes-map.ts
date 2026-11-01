/**
 * The Map (docs/DESIGN.md 29): GET /api/map is the hub, its devices,
 * projects and the last 24 hours of work; ?at=<time> rebuilds it from stored
 * rows at that time. The live deltas go out on /api/ws to sockets that sent
 * {type:'map', on:true} (ws/clients.ts). The work is in packages/core/src/map.
 */
import type { Hono } from 'hono';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { MapSnapshot } from '@conclave/core/client/map.ts';
import { MAP_WINDOW_MS, buildMapSnapshot, type MapLiveView } from '@conclave/core/map/snapshot.ts';
import { MapLive } from '@conclave/core/map/live.ts';
import { liveAlerts } from '@conclave/core/alerts/attached.ts';
import type { HonoEnv, ServerContext } from './context';
import { badRequest } from './http';
import { accountOf } from './scope';

/** One account's map (docs/design/ACCOUNTS.md): its sessions, runs, devices, approvals and questions. */
export function mapSnapshot(engine: EngineApi, live: MapLiveView | undefined, q: { at?: number; tz?: number } = {}, accountId = 'owner'): MapSnapshot {
  return withAlerts(engine, buildMapSnapshot(
    {
      repos: engine.repos,
      accountId,
      hubName: engine.info().name,
      devices: engine.devices.list(accountId),
      approvals: engine.pendingApprovals(accountId),
      questions: engine.pendingQuestions(accountId),
      live,
    },
    q,
  ));
}

/** A live map draws the stuck and file conflict alerts (docs/DESIGN.md 28). A replay has none: they live in memory. */
function withAlerts(engine: EngineApi, snap: MapSnapshot): MapSnapshot {
  if (!snap.live) return snap;
  const { stuck, conflicts } = liveAlerts(engine, snap.at);
  const ids = new Set(snap.nodes.map((n) => n.id));
  const nodes = snap.nodes.map((n) => (stuck[n.id] ? { ...n, stuckSince: stuck[n.id]!.stuckSince } : n));
  const pairs = conflicts.filter((c) => ids.has(c.sessions[0]) && ids.has(c.sessions[1])).map((c) => ({ a: c.sessions[0], b: c.sessions[1], file: c.file, since: c.since }));
  return { ...snap, nodes, ...(pairs.length ? { conflicts: pairs } : {}) };
}

/** The tracker behind map.delta. It sends nothing while wanted() is false. */
export function createMapLive(engine: EngineApi, wanted: () => boolean): MapLive {
  const usage = engine.repos.db.query(
    `SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw, SUM(cost_usd) AS c FROM usage WHERE session_id = ?`,
  );
  const live: MapLive = new MapLive({
    bus: engine.bus,
    wanted,
    snapshot: (accountId) => mapSnapshot(engine, live, {}, accountId),
    accountOf: (sessionId) => engine.sessionAccount(sessionId),
    usage: (sessionId) => {
      const r = usage.get(sessionId) as { i: number | null; o: number | null; cr: number | null; cw: number | null; c: number | null } | null;
      if (!r || r.i === null) return undefined;
      return { inputTokens: r.i ?? 0, outputTokens: r.o ?? 0, cacheReadTokens: r.cr ?? 0, cacheWriteTokens: r.cw ?? 0, costUsd: r.c ?? 0 };
    },
  });
  return live;
}

/** A time from the query: epoch ms, or anything Date.parse reads. */
function timeOf(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw badRequest(`at must be a time (epoch ms or ISO 8601), not ${v.slice(0, 40)}`);
  return n;
}

export function registerMapRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  app.get('/api/map', (c) => {
    const at = timeOf(c.req.query('at'));
    const tzText = c.req.query('tz');
    const tz = tzText === undefined || tzText === '' ? undefined : Number(tzText);
    if (tz !== undefined && (!Number.isFinite(tz) || Math.abs(tz) > 840)) throw badRequest('tz must be the minutes from Date#getTimezoneOffset, -840 to 840');
    const now = Date.now();
    if (at !== undefined && at < now - MAP_WINDOW_MS - 60_000) throw badRequest('A replay reaches back 24 hours.');
    return c.json(mapSnapshot(ctx.engine, ctx.map, { ...(at !== undefined ? { at } : {}), ...(tz !== undefined ? { tz } : {}) }, accountOf(c)));
  });
}
