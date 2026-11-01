/**
 * Discover catalog routes (docs/design/ECOSYSTEM.md 2.1): the merged list,
 * live search, detail, preview and install, installed items with update,
 * rollback and remove, status and refresh, plus the agentic-tools task
 * import. The service is built on first use from the engine.
 *
 * Hook recipes install through the hook recipe routes (section 2.2) when
 * this hub has them, called in-process with the caller's own credentials.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, Hono } from 'hono';
import type { McpServerConfig } from '@conclave/core/config/schema.ts';
import type { CatalogHost } from '@conclave/core/catalog/install.ts';
import { CatalogError } from '@conclave/core/catalog/install.ts';
import { CatalogService } from '@conclave/core/catalog/service.ts';
import { importAgenticTools } from '@conclave/core/catalog/tasks-import.ts';
import type { CatalogInstallRequest, CatalogKind, CatalogPreviewRequest, CatalogQuery, CatalogSetupRequest, TaskImportRequest } from '@conclave/core/catalog/types.ts';
import { logger } from '@conclave/core/util/log.ts';
import type { HonoEnv, ServerContext } from './context';
import { actorOf, badRequest, qBool, qNum, readJson, requireString } from './http';
import type { AuditFn } from './routes-extensions';

const log = logger('catalog');

const KINDS: CatalogKind[] = ['mcp', 'skill', 'plugin', 'subagent', 'command', 'hook', 'routine'];
const REFRESH_JOB = 'catalog.refresh';
const offline = () => process.env.CONCLAVE_CATALOG_OFFLINE === '1';
const DAY = 24 * 3_600_000;

interface Call {
  authorization?: string;
  actor: string;
}

/** Catalog errors answer with their extra fields too (missing, retryAfter), which the shared error handler would drop. */
function answer(c: Context<HonoEnv>, err: unknown): Response {
  if (!(err instanceof CatalogError)) throw err;
  const headers: Record<string, string> = {};
  const retry = err.data?.retryAfter;
  if (typeof retry === 'number') headers['retry-after'] = String(retry);
  if (err.status >= 500) log.warn(`${c.req.method} ${new URL(c.req.url).pathname}: ${err.message}`);
  return c.json({ error: err.message, ...(err.data ?? {}) }, err.status as 400, headers);
}

export function registerCatalogRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;
  const calls = new AsyncLocalStorage<Call>();
  let svc: CatalogService | undefined;

  const callRecipeRoute = async (method: 'POST' | 'DELETE', path: string, body?: unknown) => {
    const call = calls.getStore();
    const res = await app.request(path, {
      method,
      headers: { ...(call?.authorization ? { authorization: call.authorization } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new CatalogError(res.status, String(data.error ?? `hook recipe call failed (${res.status})`));
    return data;
  };
  const hasRecipeRoutes = () => app.routes.some((r) => r.method === 'POST' && r.path === '/api/hooks/recipes/:id/install');

  const host: CatalogHost = {
    memoryConnections: () => {
      const m = engine.config.get().memory;
      // the legacy external entry is the connection "external"
      const legacy = m.external?.mcpServer ? [{ id: 'external', type: 'mcp', options: { server: m.external.mcpServer } }] : [];
      return [...(m.connections ?? []), ...legacy];
    },
    secrets: {
      set: (key, value) => engine.config.setSecret('values', key, value),
      has: (key) => engine.config.secretNames().values.includes(key),
      remove: (key) => engine.config.setSecret('values', key, undefined),
      get: (key) => (engine.config.secretNames().values.includes(key) ? engine.config.expand(`\${secret:${key}}`) : undefined),
    },
    mcp: {
      get: (name) => engine.config.getUser().mcpServers?.[name],
      add: (name, config) => void engine.addMcpServer(name, config),
      update: (name, config: McpServerConfig) => void engine.updateMcpServer(name, { config }),
      remove: (name) => engine.removeMcpServer(name),
      test: (name) => engine.testMcp(name),
    },
    plugins: {
      list: () => engine.extensions.plugins(),
      installFrom: async (dir, opts) => {
        if (!engine.extensions.installPluginFrom) throw new CatalogError(501, 'This hub cannot install staged plugins.');
        const p = await engine.extensions.installPluginFrom(dir, opts);
        engine.bus.emit({ type: 'config.updated' });
        return p;
      },
      remove: (name) => engine.extensions.removePlugin(name),
      marketplaces: () => engine.extensions.marketplaceSources?.() ?? [],
      addMarketplace: (source) => engine.extensions.addMarketplace(source),
      removeMarketplace: async (source) => {
        const m = (engine.extensions.marketplaceSources?.() ?? []).find((x) => x.source.toLowerCase() === source.toLowerCase());
        return !!m && !!engine.extensions.removeMarketplace && (await engine.extensions.removeMarketplace(m.name));
      },
    },
    reloadExtensions: () => engine.reload(),
    hooks: () => engine.config.get().hooks ?? {},
    routines: () => engine.routines.list().map((r) => ({ id: r.id, name: r.name, suggestion: (r as { suggestion?: string }).suggestion })),
    syncClis: (device, clis) => engine.syncToClis(device, { only: clis as Array<'claude' | 'codex' | 'opencode' | 'gemini'> }),
    deviceHas: async (device, bin) => {
      const m = engine.devices.get(device);
      if (!m || !/^[\w.+-]+$/.test(bin)) return null;
      try {
        const r = await m.exec(`command -v ${bin} >/dev/null 2>&1`, { cwd: '/', timeoutMs: 10_000 });
        return r.exitCode === 0;
      } catch {
        return null;
      }
    },
    audit: (action, detail) => {
      try {
        engine.repos.audit.add({ actor: calls.getStore()?.actor ?? 'conclave', action, detail });
      } catch {
        /* auditing must not break the request */
      }
    },
  };
  Object.defineProperty(host, 'recipes', {
    enumerable: true,
    get: () =>
      hasRecipeRoutes()
        ? {
            install: async (id: string, req: unknown) => {
              const data = await callRecipeRoute('POST', `/api/hooks/recipes/${encodeURIComponent(id)}/install`, req);
              return { tests: (data.tests as never) ?? [] };
            },
            remove: async (id: string, where: { scope?: string; cwd?: string; cli?: string; device?: string }) => {
              const q = new URLSearchParams(Object.entries(where).filter(([, v]) => !!v) as Array<[string, string]>);
              await callRecipeRoute('DELETE', `/api/hooks/recipes/${encodeURIComponent(id)}${q.size ? `?${q}` : ''}`);
            },
          }
        : undefined,
  });

  const service = (): CatalogService => {
    if (svc) return svc;
    const paths = engine.config.paths;
    svc = new CatalogService({
      db: engine.repos.db,
      paths: { home: paths.home, skills: paths.skills, agents: paths.agents, commands: paths.commands, hooks: paths.hooks, cache: paths.cache, plugins: paths.plugins },
      host,
      githubToken: () => {
        const t = engine.config.expand('${secret:catalog.github-token}') || engine.config.expand('${secret:github-pat}');
        return t || undefined;
      },
      kv: engine.repos.kv,
      // "Install on the hub" runs on the hub's own machine, the shell the hub uses for its own work
      hubShell: {
        exec: (command, opts) => {
          const m = engine.devices.get('local');
          if (!m) throw new CatalogError(503, 'The hub machine is not available.');
          return m.exec(command, opts);
        },
      },
      // CONCLAVE_GITHUB_API: GitHub Enterprise, or a local server that replays recorded responses
      githubApi: process.env.CONCLAVE_GITHUB_API?.replace(/\/+$/, '') || undefined,
      // CONCLAVE_CATALOG_OFFLINE=1: shipped data and the cache only, no network at all (air-gapped hubs and tests)
      ...(offline()
        ? {
            fetch: () => Promise.reject(new TypeError('the catalog is offline (CONCLAVE_CATALOG_OFFLINE)')),
            sources: { github: false, 'mcp-registry': false, marketplaces: false, feeds: false },
          }
        : {}),
    });
    return svc;
  };

  const run = <T>(c: Context<HonoEnv>, fn: () => Promise<T> | T): Promise<T | Response> => {
    const call: Call = { authorization: c.req.header('authorization'), actor: actorOf(c) };
    return calls.run(call, async () => {
      try {
        return await fn();
      } catch (err) {
        return answer(c, err);
      }
    });
  };

  const kindQ = (v: string | undefined): CatalogKind | undefined => {
    if (!v) return undefined;
    if (!KINDS.includes(v as CatalogKind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    return v as CatalogKind;
  };

  // ----- daily refresh job (a hub job, not a routine) -------------------------
  if (!offline()) try {
    engine.scheduler.handle(REFRESH_JOB, async () => {
      try {
        const { archived } = await service().runRefresh();
        for (const id of archived) {
          const item = service().itemFor(id);
          void engine.notifier
            .send({ title: `${item?.name ?? id} is archived upstream`, body: 'It gets no more fixes. Discover has the details.', level: 'warning', link: `/extensions/discover?q=${encodeURIComponent(item?.name ?? id)}` })
            .catch(() => undefined);
        }
      } catch (err) {
        log.warn(`catalog refresh failed: ${(err as Error).message}`);
      } finally {
        engine.scheduler.enqueue(REFRESH_JOB, Date.now() + DAY, {}, REFRESH_JOB);
      }
    });
    // daily from the last refresh, and never sooner than a few minutes after start; the dedupe key keeps one pending
    const last = engine.repos.kv.get<number>('catalog.lastRefresh', 0);
    engine.scheduler.enqueue(REFRESH_JOB, Math.max(Date.now() + 5 * 60_000, last + DAY), {}, REFRESH_JOB);
  } catch (err) {
    log.warn(`could not schedule the catalog refresh: ${(err as Error).message}`);
  }

  // ----- list, search, detail -------------------------------------------------

  app.get('/api/catalog', (c) =>
    run(c, async () => {
      const q = c.req.query();
      const query: CatalogQuery = {
        kind: kindQ(q.kind),
        q: q.q || undefined,
        category: (q.category || undefined) as CatalogQuery['category'],
        recommended: qBool(q.recommended),
        installed: qBool(q.installed),
        cursor: q.cursor || undefined,
        limit: qNum(q.limit),
      };
      return c.json(await service().list(query));
    }),
  );

  app.get('/api/catalog/search', (c) =>
    run(c, async () => {
      const q = c.req.query();
      const sort = q.sort === 'updated' ? 'updated' : q.sort === undefined || q.sort === '' || q.sort === 'stars' ? 'stars' : undefined;
      if (!sort) throw badRequest('sort must be stars or updated');
      return c.json(await service().search({ q: requireString(q.q, 'q'), kind: kindQ(q.kind), sort, page: qNum(q.page) }));
    }),
  );

  app.get('/api/catalog/items/:id', (c) => run(c, async () => c.json(await service().detail(c.req.param('id')))));

  app.get('/api/catalog/status', (c) => run(c, () => c.json(service().status())));

  app.post('/api/catalog/refresh', (c) =>
    run(c, async () => {
      const body = await readJson<{ source?: unknown }>(c);
      const source = body.source === undefined || body.source === null || body.source === '' ? undefined : String(body.source);
      if (source && !['github', 'mcp-registry', 'marketplaces', 'feeds', 'installed'].includes(source)) throw badRequest('source must be github, mcp-registry, marketplaces, feeds or installed');
      const st = await service().refresh(source);
      audit(c, 'catalog.refresh', source ?? 'all');
      return c.json(st);
    }),
  );

  // ----- preview and install --------------------------------------------------

  app.post('/api/catalog/preview', (c) =>
    run(c, async () => {
      const body = await readJson<CatalogPreviewRequest>(c);
      requireString(body.id, 'id');
      if (body.variant !== undefined && (!Number.isInteger(body.variant) || body.variant < 0)) throw badRequest('variant must be a whole number');
      if (body.kind !== undefined) kindQ(body.kind);
      if (body.options !== undefined && (typeof body.options !== 'object' || body.options === null)) throw badRequest('options must be an object');
      const o = body.options ?? {};
      if (o.scope !== undefined && o.scope !== 'user' && o.scope !== 'project') throw badRequest('options.scope must be user or project');
      if (o.plugins !== undefined && (!Array.isArray(o.plugins) || o.plugins.some((p) => typeof p !== 'string'))) throw badRequest('options.plugins must be a list of strings');
      return c.json(await service().preview(body));
    }),
  );

  app.post('/api/catalog/install', (c) =>
    run(c, async () => {
      const body = await readJson<CatalogInstallRequest>(c);
      requireString(body.planId, 'planId');
      if (body.values !== undefined && (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values) || Object.values(body.values).some((v) => typeof v !== 'string')))
        throw badRequest('values must map input names to strings');
      if (body.syncClis !== undefined && (typeof body.syncClis?.device !== 'string' || !Array.isArray(body.syncClis?.clis))) throw badRequest('syncClis needs device and clis');
      const res = await service().installer.install(body);
      engine.bus.emit({ type: 'config.updated' });
      return c.json(res);
    }),
  );

  // ----- install on the hub (catalog/hub-setup.ts) -----------------------------
  // The owner's only (route-policy.ts). Runs a shipped item's hub setup step, or
  // the user-level installer for a missing need, as the hub's own user; the
  // service audits the command line before it runs and the result after.

  app.post('/api/catalog/items/:id/setup', (c) =>
    run(c, async () => {
      const body = await readJson<CatalogSetupRequest>(c);
      const whole = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
      if (!whole(body.step)) throw badRequest('step must be a whole number');
      if (!whole(body.variant)) throw badRequest('variant must be a whole number');
      if (body.bin !== undefined && typeof body.bin !== 'string') throw badRequest('bin must be a program name');
      if (body.step !== undefined && body.bin !== undefined) throw badRequest('send step or bin, not both');
      if (body.commands !== undefined && (!Array.isArray(body.commands) || body.commands.some((x) => typeof x !== 'string'))) throw badRequest('commands must be a list of strings');
      return c.json(await service().runSetup(c.req.param('id'), { step: body.step, variant: body.variant, bin: body.bin, commands: body.commands }));
    }),
  );

  // ----- installed items ------------------------------------------------------

  app.get('/api/catalog/installed', (c) => run(c, () => c.json(service().installer.installed())));

  app.post('/api/catalog/updates/check', (c) => run(c, async () => c.json(await service().installer.checkUpdates())));

  app.post('/api/catalog/installed/:id/update-preview', (c) => run(c, async () => c.json(await service().installer.updatePreview(c.req.param('id')))));

  app.post('/api/catalog/installed/:id/update', (c) =>
    run(c, async () => {
      const body = await readJson<{ planId?: unknown }>(c);
      const res = await service().installer.update(c.req.param('id'), requireString(body.planId, 'planId'));
      engine.bus.emit({ type: 'config.updated' });
      return c.json(res);
    }),
  );

  app.post('/api/catalog/installed/:id/rollback', (c) =>
    run(c, async () => {
      const res = await service().installer.rollback(c.req.param('id'));
      engine.bus.emit({ type: 'config.updated' });
      return c.json(res);
    }),
  );

  app.delete('/api/catalog/installed/:id', (c) =>
    run(c, async () => {
      const q = c.req.query();
      const res = await service().installer.remove(c.req.param('id'), { secrets: qBool(q.secrets) === true, scope: q.scope || undefined, cwd: q.cwd || undefined });
      engine.bus.emit({ type: 'config.updated' });
      return c.json(res);
    }),
  );

  // ----- agentic-tools import -------------------------------------------------

  app.post('/api/tasks/import', (c) =>
    run(c, async () => {
      const body = await readJson<TaskImportRequest>(c);
      if (body.from !== 'agentic-tools-mcp') throw badRequest('from must be agentic-tools-mcp');
      requireString(body.path, 'path');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw badRequest('dryRun must be a boolean');
      const res = await importAgenticTools(
        {
          machine: (d) => engine.devices.get(d),
          tasks: () => engine.listTasks(),
          createTask: (t) => engine.createTask(t),
          saveMemory: (m) => engine.memory.save(m),
          importedMemories: () => new Set(engine.repos.kv.get<string[]>('catalog.import.agentic.memories', [])),
          rememberImported: (ids) => engine.repos.kv.set('catalog.import.agentic.memories', [...new Set([...engine.repos.kv.get<string[]>('catalog.import.agentic.memories', []), ...ids])]),
        },
        body,
      );
      if (!body.dryRun) {
        audit(c, 'tasks.import', `agentic-tools-mcp from ${body.device ?? 'local'}:${body.path}: ${res.tasks} tasks, ${res.memories} memories`);
      }
      return c.json(res);
    }),
  );
}
