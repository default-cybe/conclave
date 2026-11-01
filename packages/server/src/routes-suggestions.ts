/**
 * Routine suggestion routes (docs/design/ECOSYSTEM.md 2.3): the Suggested
 * section of the Routines tab. Add creates the suggested agent at user scope
 * when no agent of that name exists, then one routine per picked device.
 * Registered before the other routine routes so "suggestions" is never read
 * as a routine id.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import type { Hono } from 'hono';
import { parseAgentMarkdown } from '@conclave/core/extensions/builtin-agents.ts';
import { RoutineSuggestions, SuggestionError, type AddSuggestionRequest, type SuggestionHost } from '@conclave/core/scheduler/suggest.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, readJson } from './http';
import type { AuditFn } from './routes-extensions';

/**
 * A repo in ~/code on the hub's own machine, at most three levels down, as
 * the librarian's precheck finds them (find ~/code -maxdepth 3 -name .git).
 * Hidden folders are skipped, and a big tree stops after a few thousand
 * folders.
 */
export function hasCodeRepos(home: string = homedir()): boolean {
  let budget = 4000;
  const walk = (dir: string, depth: number): boolean => {
    if (--budget < 0) return false;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.some((e) => e.name === '.git')) return true;
    if (depth >= 3) return false;
    return entries.some((e) => e.isDirectory() && !e.name.startsWith('.') && walk(join(dir, e.name), depth + 1));
  };
  return walk(join(home, 'code'), 1);
}

function service(ctx: ServerContext): RoutineSuggestions {
  const { engine } = ctx;
  const host: SuggestionHost = {
    // suggestions are the owner's (route-policy.ts: admin): they install agents and MCP servers on the hub
    routines: () => engine.routines.list(OWNER_ID),
    createRoutine: (input) => engine.routines.create(input, OWNER_ID),
    removeRoutine: (id) => engine.routines.remove(id),
    agentExists: (name) => !!engine.extensions.agent(name),
    createAgent: async (name, markdown) => {
      // saveAgent writes the frontmatter from the parsed fields; source is set from the scope
      await engine.extensions.saveAgent({ ...parseAgentMarkdown(name, markdown), source: 'user' }, 'user');
    },
    mcpServers: () => {
      const cfg = engine.config.get().mcpServers ?? {};
      const own = Object.entries(cfg)
        .filter(([, s]) => s?.enabled !== false)
        .map(([n]) => n);
      let fromPlugins: string[] = [];
      try {
        fromPlugins = Object.keys(engine.extensions.pluginMcpServers());
      } catch {
        // plugins not loaded yet
      }
      return [...own, ...fromPlugins];
    },
    secrets: () => engine.config.secretNames().values,
    devices: () => engine.devices.list(OWNER_ID),
    // preview parses the schedule the same way create does, and throws the same sentence
    checkSchedule: (schedule, timezone) => void engine.routines.preview(schedule, timezone, 1),
    hubHome: () => engine.config.paths.home,
    // the librarian's deep pass is offered on the hub only when the hub holds code
    hubHasRepos: () => hasCodeRepos(),
  };
  return new RoutineSuggestions(host);
}

function body(raw: Record<string, unknown>): AddSuggestionRequest {
  const out: AddSuggestionRequest = {};
  if (raw.devices !== undefined) {
    if (!Array.isArray(raw.devices) || raw.devices.some((d) => typeof d !== 'string')) throw badRequest('devices must be a list of device ids');
    out.devices = raw.devices as string[];
  }
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (typeof raw.cwd !== 'string') throw badRequest('cwd must be a folder path');
    out.cwd = raw.cwd;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    out.enabled = raw.enabled;
  }
  if (raw.overrides !== undefined && raw.overrides !== null) {
    if (typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) throw badRequest('overrides must be an object');
    out.overrides = raw.overrides as AddSuggestionRequest['overrides'];
  }
  return out;
}

export function registerRoutineSuggestionRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  app.get('/api/routines/suggestions', (c) => c.json(service(ctx).list()));

  app.post('/api/routines/suggestions/:id/add', async (c) => {
    const id = c.req.param('id');
    const req = body(await readJson<Record<string, unknown>>(c));
    try {
      const res = await service(ctx).add(id, req);
      if (res.agentCreated) audit(c, 'agent.create', `${res.agentCreated} (for suggestion ${id})`);
      for (const r of res.routines) audit(c, 'routine.create', `${r.name} (suggestion ${id})`);
      return c.json(res);
    } catch (err) {
      if (err instanceof SuggestionError) throw new HttpError(err.status, err.message);
      throw err;
    }
  });
}
