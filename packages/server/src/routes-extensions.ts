/**
 * Extensions area routes (docs/extensions/IA.md): overview, inventory,
 * sources, tools, hooks, project trust, plugin detail and update,
 * marketplace search, MCP server admin and "connect to my CLIs", agent
 * defaults, hook recipes, hook lint and built-in hooks (ECOSYSTEM.md 2.2).
 * Thin handlers over EngineApi.
 */
import type { Context, Hono } from 'hono';
import type { HookEvent, HooksConfig, McpServerConfig } from '@conclave/core/config/schema.ts';
import type { CliName, HookTestInput, McpImportFormat, RecipeInstallRequest, RecipeRemoveWhere, ToolCheckInput } from '@conclave/core/client/index.ts';
import { lintHooks } from '@conclave/core/extensions/hook-lint.ts';
import { LearnedSkillError, type LearnedSkills, type LearnedSkill } from '@conclave/core/extensions/learned.ts';
import { accountOf } from './scope';
import type { LearnedSkillDto } from '@conclave/core/client/index.ts';
import { MCP_OAUTH_CALLBACK } from '@conclave/core/extensions/mcp-oauth.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, notFound, optString, readJson, requireString } from './http';
import { callbackPage } from './routes-pim';

const CLIS: CliName[] = ['claude', 'codex', 'opencode', 'gemini'];
const KINDS = ['agent', 'skill', 'command'] as const;

/** extra.accountId: whose entry it is when the request has no account of its own (a device registering with its code). */
export type AuditFn = (c: Context<HonoEnv>, action: string, detail: string, extra?: { sessionId?: string; device?: string; accountId?: string }) => void;

function cliList(v: unknown, name: string): CliName[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => !CLIS.includes(x as CliName))) throw badRequest(`${name} must be a list of ${CLIS.join(', ')}`);
  return v as CliName[];
}

export function registerExtensionRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;
  const changed = () => engine.bus.emit({ type: 'config.updated' });
  const cwdQ = (c: Context) => c.req.query('cwd') || undefined;

  // ----- agent defaults ------------------------------------------------------

  app.get('/api/agents/:name/default', (c) => {
    const d = engine.agentDefault(c.req.param('name'));
    if (!d) throw notFound(`${c.req.param('name')} is not a built-in agent`);
    return c.json(d);
  });

  // ----- skills agents wrote (core/extensions/learned.ts) --------------------

  // each account's own: a member's live under <home>/accounts/<id>/learned-skills
  const learned = (c: Context<HonoEnv>): LearnedSkills => engine.learnedSkillsFor(accountOf(c));
  const learnedDto = (s: LearnedSkill, withBody = false): LearnedSkillDto => {
    const { dir: _d, body, ...rest } = s;
    const title = s.sessionId ? engine.getSession(s.sessionId)?.title : undefined;
    return { ...rest, ...(title ? { sessionTitle: title } : {}), ...(withBody ? { body } : {}) };
  };
  const learnedCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof LearnedSkillError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  const requireLearned = (c: Context<HonoEnv>, name: string): LearnedSkill => {
    const s = learned(c).get(name);
    if (!s) throw notFound(`no learned skill named ${name}`);
    return s;
  };

  app.get('/api/skills/learned', (c) => c.json(learned(c).list().map((s) => learnedDto(s))));

  app.get('/api/skills/learned/:name', (c) => c.json(learnedDto(requireLearned(c, c.req.param('name')), true)));

  app.patch('/api/skills/learned/:name', async (c) => {
    const name = c.req.param('name');
    requireLearned(c, name);
    const body = await readJson<{ description?: unknown; body?: unknown; enabled?: unknown }>(c);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    const description = optString(body.description, 'description');
    const text = optString(body.body, 'body');
    const store = learned(c);
    if (text !== undefined) {
      const no = engine.diskRefusal(accountOf(c), Buffer.byteLength(text));
      if (no) throw new HttpError(413, no);
    }
    let s = learnedCall(() => (description !== undefined || text !== undefined ? store.edit(name, { description, body: text }) : store.get(name)!));
    if (typeof body.enabled === 'boolean') s = learnedCall(() => store.setEnabled(name, body.enabled as boolean));
    await engine.extensions.reload();
    audit(c, 'skill.learned.update', `${name}${typeof body.enabled === 'boolean' ? (body.enabled ? ' on' : ' off') : ' edited'}`);
    changed();
    return c.json(learnedDto(s, true));
  });

  app.delete('/api/skills/learned/:name', async (c) => {
    const name = c.req.param('name');
    if (!learned(c).remove(name)) throw notFound(`no learned skill named ${name}`);
    await engine.extensions.reload();
    audit(c, 'skill.learned.delete', name);
    changed();
    return c.json({ ok: true as const });
  });

  // ----- overview, inventory, sources ---------------------------------------

  app.get('/api/extensions/overview', async (c) => c.json(await engine.extensionsOverview(cwdQ(c), c.req.query('device') || undefined)));

  app.get('/api/extensions/inventory', (c) => {
    const kind = c.req.query('kind') || undefined;
    if (kind && !(KINDS as readonly string[]).includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    return c.json(engine.extensionsInventory(cwdQ(c), kind as (typeof KINDS)[number] | undefined));
  });

  app.get('/api/extensions/sources', (c) => c.json(engine.extensionSources(cwdQ(c))));

  // ----- tools ---------------------------------------------------------------

  app.get('/api/tools', async (c) => c.json(await engine.toolsDetail({ cwd: cwdQ(c), agent: c.req.query('agent') || undefined })));

  app.post('/api/tools/check', async (c) => {
    const body = await readJson<ToolCheckInput>(c);
    requireString(body.tool, 'tool');
    if (body.input !== undefined && (typeof body.input !== 'object' || body.input === null || Array.isArray(body.input))) throw badRequest('input must be an object');
    if (body.mode !== undefined && !['default', 'acceptEdits', 'plan', 'bypass'].includes(body.mode)) throw badRequest('mode must be default, acceptEdits, plan or bypass');
    return c.json(await engine.checkTool({ tool: body.tool, input: body.input, agent: optString(body.agent, 'agent'), mode: body.mode, cwd: optString(body.cwd, 'cwd') }));
  });

  // ----- hooks ---------------------------------------------------------------

  app.get('/api/hooks', (c) => c.json(engine.hooksOverview(cwdQ(c))));

  app.post('/api/hooks/test', async (c) => {
    const body = await readJson<HookTestInput>(c);
    requireString(body.event, 'event');
    if (body.input !== undefined && (typeof body.input !== 'object' || body.input === null || Array.isArray(body.input))) throw badRequest('input must be an object');
    const res = await engine.testHook({
      event: body.event as HookEvent,
      input: body.input,
      matcherValue: optString(body.matcherValue, 'matcherValue'),
      cwd: optString(body.cwd, 'cwd'),
      only: body.only && typeof body.only === 'object' ? body.only : undefined,
    });
    audit(c, 'hooks.test', body.event);
    return c.json(res);
  });

  app.put('/api/hooks', async (c) => {
    const body = await readJson<{ scope?: unknown; cwd?: unknown; hooks?: unknown }>(c);
    if (body.scope !== 'user' && body.scope !== 'project') throw badRequest('scope must be user or project');
    if (!body.hooks || typeof body.hooks !== 'object') throw badRequest('hooks is required');
    const lint = engine.saveHooks({ scope: body.scope, cwd: optString(body.cwd, 'cwd'), hooks: body.hooks as HooksConfig });
    changed();
    return c.json({ ok: true as const, ...(lint.length ? { lint } : {}) });
  });

  app.post('/api/hooks/lint', async (c) => {
    const body = await readJson<{ hooks?: unknown }>(c);
    if (body.hooks === undefined) throw badRequest('hooks is required');
    // config.json servers and plugin servers, so mcp__plugin_<plugin>_<server>__ matchers are not flagged
    const servers = [...Object.keys(engine.config.get().mcpServers ?? {}), ...Object.keys(engine.extensions.pluginMcpServers?.() ?? {})];
    return c.json(lintHooks(body.hooks, { mcpServers: servers }).issues);
  });

  // ----- hook recipes (ECOSYSTEM.md 4.2) ------------------------------------

  const recipeService = () => engine.hookRecipes();

  app.get('/api/hooks/recipes', (c) => c.json(recipeService().list(cwdQ(c))));

  app.get('/api/hooks/recipes/:id', (c) => c.json(recipeService().get(c.req.param('id'), cwdQ(c))));

  app.post('/api/hooks/recipes/:id/test', async (c) => {
    const id = c.req.param('id');
    const res = await recipeService().test(id);
    audit(c, 'hooks.recipe.test', `${id}: ${res.filter((r) => r.ok).length} of ${res.length} passed`);
    return c.json(res);
  });

  app.post('/api/hooks/recipes/:id/install', async (c) => {
    const id = c.req.param('id');
    const body = await readJson<RecipeInstallRequest>(c);
    if (body.env !== undefined && (!body.env || typeof body.env !== 'object' || Array.isArray(body.env) || Object.values(body.env).some((v) => typeof v !== 'string'))) {
      throw badRequest('env must be an object of strings');
    }
    if (body.target !== undefined) {
      const t = body.target as { cli?: unknown; device?: unknown };
      if (!t || typeof t !== 'object' || typeof t.cli !== 'string' || typeof t.device !== 'string') throw badRequest('target must be {cli, device}');
      if (!engine.devices.get(t.device) && engine.repos.devices.get(t.device)) throw new HttpError(409, `device ${t.device} is offline`);
    }
    const res = await recipeService().install(id, {
      scope: body.scope,
      cwd: optString(body.cwd, 'cwd'),
      env: body.env,
      target: body.target,
      skipTests: body.skipTests === true,
      force: body.force === true,
    });
    const passed = res.tests.filter((t) => t.ok).length;
    audit(c, 'hooks.recipe.install', `${id} to ${res.file}${res.tests.length ? `, ${passed} of ${res.tests.length} tests passed` : ''}`);
    return c.json(res);
  });

  app.delete('/api/hooks/recipes/:id', async (c) => {
    const id = c.req.param('id');
    const q = c.req.query();
    const scope = q.scope || undefined;
    if (scope !== undefined && scope !== 'user' && scope !== 'project') throw badRequest('scope must be user or project');
    const cli = q.cli || undefined;
    if (cli !== undefined && !['claude-code', 'codex', 'gemini'].includes(cli)) throw badRequest('cli must be claude-code, codex or gemini');
    const where: RecipeRemoveWhere = { scope: scope as RecipeRemoveWhere['scope'], cwd: q.cwd || undefined, cli: cli as RecipeRemoveWhere['cli'], device: q.device || undefined };
    const res = await recipeService().remove(id, where);
    audit(c, 'hooks.recipe.remove', `${id}${cli ? ` ${cli} on ${where.device ?? 'local'}` : ` ${scope ?? 'user'}`}: ${res.removed} handler${res.removed === 1 ? '' : 's'}`);
    return c.json(res);
  });

  // ----- built-in hooks ------------------------------------------------------

  app.get('/api/hooks/builtin', (c) => c.json(engine.builtinHooks()));

  app.patch('/api/hooks/builtin/:id', async (c) => {
    const body = await readJson<{ enabled?: unknown; budgetChars?: unknown }>(c);
    const res = engine.setBuiltinHook(c.req.param('id'), body);
    audit(c, 'hooks.builtin', `${res.id} ${res.enabled ? 'on' : 'off'}${res.budgetChars ? `, budget ${res.budgetChars}` : ''}`);
    changed();
    return c.json(res);
  });

  app.post('/api/hooks/import', async (c) => {
    const body = await readJson<{ from?: unknown; cwd?: unknown }>(c);
    if (body.from !== 'gemini' && body.from !== 'codex') throw badRequest('from must be gemini or codex');
    return c.json(engine.importHooks(body.from, optString(body.cwd, 'cwd')));
  });

  // ----- project trust -------------------------------------------------------

  app.get('/api/trust', (c) => c.json(engine.projectTrust(requireString(c.req.query('cwd'), 'cwd'))));

  app.post('/api/trust', async (c) => {
    const body = await readJson<{ cwd?: unknown; trusted?: unknown }>(c);
    const cwd = requireString(body.cwd, 'cwd');
    if (typeof body.trusted !== 'boolean') throw badRequest('trusted must be a boolean');
    const info = engine.setProjectTrust(cwd, body.trusted);
    audit(c, body.trusted ? 'trust.add' : 'trust.remove', cwd);
    changed();
    return c.json(info);
  });

  // ----- plugins and marketplace --------------------------------------------

  app.get('/api/marketplace/search', async (c) => {
    const q = c.req.query();
    return c.json(await engine.searchMarketplace({ q: q.q || undefined, category: q.category || undefined, marketplace: q.marketplace || undefined }));
  });

  app.get('/api/plugins/:name', (c) => {
    const d = engine.pluginDetail(c.req.param('name'));
    if (!d) throw notFound(`unknown plugin ${c.req.param('name')}`);
    return c.json(d);
  });

  app.post('/api/plugins/:name/update', async (c) => {
    const p = await engine.updatePlugin(c.req.param('name'));
    audit(c, 'plugin.update', `${p.name} from ${p.source}`);
    changed();
    return c.json(p);
  });

  // ----- MCP servers ---------------------------------------------------------

  app.post('/api/mcp', async (c) => {
    const body = await readJson<{ name?: unknown; config?: unknown; scope?: unknown }>(c);
    const name = requireString(body.name, 'name');
    if (body.scope !== undefined && body.scope !== 'user') {
      throw badRequest('only scope "user" is supported; Conclave does not start servers from a project .mcp.json yet');
    }
    const st = engine.addMcpServer(name, body.config as McpServerConfig);
    audit(c, 'mcp.add', name);
    changed();
    return c.json(st);
  });

  app.post('/api/mcp/import', async (c) => {
    const body = await readJson<{ from?: unknown; text?: unknown }>(c);
    const from = body.from as McpImportFormat;
    if (!['claude', 'codex', 'opencode', 'gemini'].includes(from)) throw badRequest('from must be claude, codex, opencode or gemini');
    return c.json(engine.importMcp(from, requireString(body.text, 'text')));
  });

  app.patch('/api/mcp/:name', async (c) => {
    const name = c.req.param('name');
    const body = await readJson<{ enabled?: unknown; config?: unknown }>(c);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
    const st = engine.updateMcpServer(name, { enabled: body.enabled as boolean | undefined, config: body.config as McpServerConfig | undefined });
    audit(c, 'mcp.update', name);
    changed();
    return c.json(st);
  });

  app.delete('/api/mcp/:name', (c) => {
    const name = c.req.param('name');
    if (!engine.removeMcpServer(name)) throw notFound(`unknown mcp server ${name}`);
    audit(c, 'mcp.remove', name);
    changed();
    return c.json({ ok: true as const });
  });

  // ----- MCP OAuth: Connect, its public callback, Disconnect ------------------

  app.post('/api/mcp/:name/oauth/start', async (c) => {
    const name = c.req.param('name');
    const base = engine.config.get().server.publicUrl;
    // the callback must be an address the owner's browser reaches the hub at and that the app server accepts
    if (!base || !URL.canParse(base)) throw new HttpError(409, 'Connect needs the hub\'s public address. Set up remote access (a tunnel, Tailscale or your own domain) in Settings first.');
    const res = await engine.startMcpOAuth(name, `${new URL(base).origin}${MCP_OAUTH_CALLBACK}`);
    audit(c, 'mcp.oauth.start', name);
    return c.json(res);
  });

  app.get(MCP_OAUTH_CALLBACK, async (c) => {
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code');
    const error = c.req.query('error');
    if (!state) return c.html(callbackPage(false, 'This address only finishes a sign-in started in Conclave.'), 400);
    try {
      const st = await engine.finishMcpOAuth({ state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      audit(c, 'mcp.oauth.connect', st.name, { accountId: OWNER_ID });
      changed();
      return c.html(callbackPage(true, `${st.name} is connected to Conclave. Return to Conclave; its tools reach new sessions.`));
    } catch (err) {
      return c.html(callbackPage(false, (err as Error).message), 400);
    }
  });

  app.delete('/api/mcp/:name/oauth', async (c) => {
    const name = c.req.param('name');
    const st = await engine.disconnectMcpOAuth(name);
    audit(c, 'mcp.oauth.disconnect', name);
    changed();
    return c.json(st);
  });

  app.post('/api/mcp/:name/restart', async (c) => c.json(await engine.restartMcp(c.req.param('name'))));
  app.post('/api/mcp/:name/test', async (c) => c.json(await engine.testMcp(c.req.param('name'))));
  app.get('/api/mcp/:name/tools', async (c) => c.json(await engine.mcpServerTools(c.req.param('name'))));

  app.post('/api/mcp/:name/call', async (c) => {
    const name = c.req.param('name');
    const body = await readJson<{ tool?: unknown; args?: unknown }>(c);
    const tool = requireString(body.tool, 'tool');
    if (body.args !== undefined && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) throw badRequest('args must be an object');
    audit(c, 'mcp.call', `${name} ${tool}`);
    return c.json(await engine.callMcpTool(name, tool, (body.args as Record<string, unknown>) ?? {}));
  });

  app.get('/api/mcp/:name/connect', (c) => c.json(engine.mcpConnectPlan(c.req.param('name'))));

  app.post('/api/mcp/:name/connect', async (c) => {
    const body = await readJson<{ device?: unknown; clis?: unknown }>(c);
    const clis = cliList(body.clis, 'clis');
    if (!clis?.length) throw badRequest(`clis must list some of ${CLIS.join(', ')}`);
    const device = optString(body.device, 'device') ?? 'local';
    if (!engine.devices.get(device)) {
      if (engine.repos.devices.get(device)) throw new HttpError(409, `device ${device} is offline`);
      throw notFound(`unknown device ${device}`);
    }
    return c.json(await engine.connectMcp(c.req.param('name'), device, clis));
  });

  // ----- sync to other CLIs (extends the old route) --------------------------

  app.post('/api/sync-clis', async (c) => {
    const body = await readJson<{ device?: unknown; only?: unknown; dryRun?: unknown }>(c);
    const device = optString(body.device, 'device');
    const only = cliList(body.only, 'only');
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw badRequest('dryRun must be a boolean');
    const dryRun = body.dryRun === true;
    // a known device that is not connected: say so, as connect does (the engine only sees connected machines)
    if (device && !engine.devices.get(device) && engine.repos.devices.get(device)) throw new HttpError(409, `device ${device} is offline`);
    const written = await engine.syncToClis(device, { only, dryRun });
    if (!dryRun) audit(c, 'extensions.sync', `${written.length} files to ${device ?? 'local'}${only?.length ? ` (${only.join(', ')})` : ''}`);
    return c.json({ ok: true as const, written, dryRun });
  });

}
