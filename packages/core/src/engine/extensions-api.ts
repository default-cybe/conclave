/**
 * The Extensions area of the hub API (docs/extensions/IA.md): overview,
 * inventory and sources, tools with access and permissions, hooks with their
 * origin and a test runner, project trust, plugin detail and update,
 * marketplace search, MCP server admin and "connect to my CLIs".
 *
 * Every function takes the Engine; Engine methods delegate here so engine.ts
 * stays about sessions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Session } from '../types';
import type {
  CliName,
  ComponentKindDto,
  ExtensionProblem,
  ExtensionSourceId,
  ExtensionSourceInfo,
  ExtensionsOverview,
  HookEventInfo,
  HookGroupDto,
  HookImportResult,
  HookLintIssue,
  HookTestInput,
  HookTestResult,
  HooksOverview,
  InventoryItemDto,
  MarketplaceSearchItem,
  MarketplaceSearchResult,
  McpCallResult,
  McpConnectRunResult,
  McpConnectStepDto,
  McpImportFormat,
  McpStatus,
  McpTestResult,
  McpToolDto,
  PluginDetailDto,
  ProjectTrustInfo,
  ToolAgentAccess,
  ToolCheckInput,
  ToolCheckResult,
  ToolDetail,
  ToolPermissionInfo,
} from '../client';
import type { HookEvent, HooksConfig, McpServerConfig } from '../config/schema';
import { claudeHome, codexHome, parseJsonc } from '../config';
import type { AgentDef, HookInput, HookOutcome, InstalledPlugin, MarketplaceEntry, RuntimeHookCommand } from '../extensions/types';
import type { Tool } from '../tools/types';
import { filterTools, untrustedOffers } from '../tools';
import { checkPermission, dangerousCommand } from '../session/permissions';
import { mcpFromClaude, mcpFromCodexToml, mcpFromGemini, mcpFromOpenCode, readForeignHooks } from '../extensions/compat';
import { mcpConnectPlan } from '../extensions/cli-sync';
import { oneLine } from '../util/text';
import type { Engine } from './engine';
import { EngineError } from './errors';
import { PermissionRulesFor, ruleSources } from './permissions-view';
import { FIRED_HOOK_EVENTS, HOOK_EVENTS, claudeUserSettings, collectHookGroups, hooksFromGroups, projectNeedsTrust, projectSettingsFiles, type HookGroupInfo } from './settings-sources';
import { handlerLabel } from '../extensions/hooks';
import { lintHooks, wrapFlatEntries } from '../extensions/hook-lint';

const CLI_NAMES: CliName[] = ['claude', 'codex', 'opencode', 'gemini'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hookGroups(engine: Engine, cwd: string | undefined): HookGroupInfo[] {
  return collectHookGroups({
    config: engine.config.get(),
    pluginHooks: engine.extensions.pluginHooks(),
    cwd,
    trusted: engine.trust.isTrusted(cwd),
    configPath: engine.config.paths.config,
  });
}

function handlerCount(groups: HookGroupInfo[]): number {
  return groups.filter((g) => g.active).reduce((n, g) => n + g.hooks.length, 0);
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

/** A stand-in session for permission checks outside a real session. */
function pseudoSession(engine: Engine, cwd: string, agent?: string, mode?: Session['permissionMode']): Session {
  const now = Date.now();
  return {
    id: 'check',
    title: 'check',
    agent: agent ?? engine.config.get().defaultAgent,
    model: engine.config.get().defaultModel,
    mode: 'agent',
    permissionMode: mode ?? engine.config.get().permissions.mode,
    cwd,
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  };
}

async function homeDir(engine: Engine): Promise<string> {
  return (await engine.machineHome(engine.localMachine)) ?? process.env.HOME ?? '/';
}

export function trustInfo(engine: Engine, cwd: string): ProjectTrustInfo {
  const needs = projectNeedsTrust(cwd, engine.config.get().compat.claudeCode);
  return { cwd, trusted: engine.trust.isTrusted(cwd), ...needs };
}

// ---------------------------------------------------------------------------
// overview, inventory, sources
// ---------------------------------------------------------------------------

export function inventory(engine: Engine, cwd?: string, kind?: ComponentKindDto): InventoryItemDto[] {
  const items = engine.extensions.inventory?.(cwd) ?? [];
  return (kind ? items.filter((i) => i.kind === kind) : items).map((i) => ({ ...i, source: i.source as ExtensionSourceId }));
}

export async function overview(engine: Engine, cwd?: string, device?: string): Promise<ExtensionsOverview> {
  const cfg = engine.config.get();
  const machine = device ? engine.devices.get(device) : engine.localMachine;
  const info = await machine?.info().catch(() => undefined);
  const clis = Object.fromEntries(CLI_NAMES.map((c) => [c, info?.clis?.[c] ?? null])) as Record<CliName, string | null>;
  const status = engine.mcpStatus();
  const groups = hookGroups(engine, cwd);
  const plugins = engine.extensions.plugins();
  const problems: ExtensionProblem[] = [];

  for (const s of status) if (s.status === 'failed' && s.error) problems.push({ kind: 'mcp', name: s.name, message: s.error });
  // the last run of each handler, if it went wrong
  const lastByLabel = new Map<string, { event: HookEvent; result: string; label: string; durationMs: number }>();
  for (const t of engine.hookRunner?.recent({ limit: 200 }) ?? []) lastByLabel.set(`${t.event}\u0000${t.label}`, t);
  for (const t of lastByLabel.values()) {
    if (t.result === 'error') problems.push({ kind: 'hook', event: t.event, name: oneLine(t.label, 80), message: 'last run failed' });
    if (t.result === 'timeout') problems.push({ kind: 'hook', event: t.event, name: oneLine(t.label, 80), message: `last run timed out after ${t.durationMs}ms` });
  }
  // the same name defined in two places, other than a copy that replaces a built-in on purpose
  const items = inventory(engine, cwd);
  for (const i of items) {
    if (i.active || i.source === 'builtin') continue;
    problems.push({ kind: 'conflict', name: i.name, message: `${i.kind} defined in ${i.scope} is shadowed by ${i.shadowedBy}` });
  }
  for (const ev of HOOK_EVENTS) {
    if (FIRED_HOOK_EVENTS.has(ev)) continue;
    const n = handlerCount(groups.filter((g) => g.event === ev));
    if (n) problems.push({ kind: 'event', event: ev, message: `${n} ${n === 1 ? 'handler' : 'handlers'} configured, event not fired yet` });
  }
  let trust: ProjectTrustInfo | undefined;
  if (cwd) {
    trust = trustInfo(engine, cwd);
    if (!trust.trusted && (trust.hooks || trust.allow)) {
      const what = [trust.hooks && `${trust.hooks} ${trust.hooks === 1 ? 'hook' : 'hooks'}`, trust.allow && `${trust.allow} ${trust.allow === 1 ? 'allow rule' : 'allow rules'}`].filter(Boolean).join(' and ');
      problems.push({ kind: 'trust', message: `This folder has ${what} that stay off until you trust it` });
    }
  }

  const builtin = engine.allTools();
  const mcpTools = status.filter((s) => s.status === 'connected').reduce((n, s) => n + s.tools, 0);
  return {
    counts: {
      tools: builtin.length + mcpTools,
      mcpTools,
      agents: engine.extensions.agents(cwd).length,
      skills: engine.extensions.skills(cwd).length,
      commands: engine.extensions.commands(cwd).length,
      hookHandlers: handlerCount(groups),
      plugins: { installed: plugins.length, enabled: plugins.filter((p) => p.enabled).length },
      mcpServers: { enabled: status.filter((s) => s.status !== 'disabled').length, connected: status.filter((s) => s.status === 'connected').length },
    },
    compat: {
      claudeCode: !!cfg.compat.claudeCode,
      agentsMd: !!cfg.compat.agentsMd,
      codex: !!cfg.compat.codex,
      opencode: !!cfg.compat.opencode,
      gemini: !!cfg.compat.gemini,
    },
    clis,
    problems,
    trust,
  };
}

export function sources(engine: Engine, cwd?: string): ExtensionSourceInfo[] {
  const cfg = engine.config.get();
  const c = cfg.compat;
  const items = inventory(engine, cwd);
  const count = (id: ExtensionSourceId) => {
    const of = items.filter((i) => i.source === id);
    return { agents: of.filter((i) => i.kind === 'agent').length, skills: of.filter((i) => i.kind === 'skill').length, commands: of.filter((i) => i.kind === 'command').length };
  };
  const home = process.env.HOME ?? '~';
  const p = (...xs: Array<string | undefined | false>) => xs.filter((x): x is string => !!x);
  const list: ExtensionSourceInfo[] = [
    { id: 'builtin', label: 'Built-in', on: true, toggle: null, paths: [] , counts: count('builtin') },
    {
      id: 'agents',
      label: 'Shared ~/.agents',
      on: !!(c.codex || c.opencode || c.gemini),
      toggle: ['codex', 'opencode', 'gemini'],
      paths: p(join(home, '.agents', 'skills'), cwd && join(cwd, '.agents', 'skills')),
      counts: count('agents'),
    },
    { id: 'codex', label: 'Codex', on: !!c.codex, toggle: 'codex', paths: p(join(codexHome(), 'skills'), join(codexHome(), 'prompts'), join(codexHome(), 'agents')), counts: count('codex') },
    {
      id: 'opencode',
      label: 'OpenCode',
      on: !!c.opencode,
      toggle: 'opencode',
      paths: p(join(home, '.config', 'opencode'), cwd && join(cwd, '.opencode')),
      counts: count('opencode'),
    },
    { id: 'gemini', label: 'Gemini CLI', on: !!c.gemini, toggle: 'gemini', paths: p(join(home, '.gemini'), cwd && join(cwd, '.gemini')), counts: count('gemini') },
    { id: 'claude', label: 'Claude Code', on: !!c.claudeCode, toggle: 'claudeCode', paths: p(claudeHome(), cwd && join(cwd, '.claude')), counts: count('claude') },
    { id: 'plugin', label: 'Plugins', on: true, toggle: null, paths: [engine.config.paths.plugins], counts: count('plugin') },
    { id: 'user', label: 'User (~/.conclave)', on: true, toggle: null, paths: [engine.config.paths.agents, engine.config.paths.skills, engine.config.paths.commands], counts: count('user') },
  ];
  if (cwd) list.push({ id: 'project', label: 'Project (.conclave/)', on: true, toggle: null, paths: [join(cwd, '.conclave')], counts: count('project') });
  return list;
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const GROUPS: Record<string, string> = {
  Read: 'file', Write: 'file', Edit: 'file', MultiEdit: 'file', Glob: 'file', Grep: 'file', LS: 'file', NotebookEdit: 'file', NotebookRead: 'file', RepoMap: 'file', ReadToolOutput: 'file',
  Bash: 'shell', BashOutput: 'shell', KillShell: 'shell',
  WebFetch: 'web', WebSearch: 'web',
  Task: 'agents', TodoWrite: 'agents', AskUserQuestion: 'agents', EnterPlanMode: 'agents', ExitPlanMode: 'agents', Skill: 'agents', Consult: 'agents',
  MemorySave: 'memory', MemorySearch: 'memory', MemoryForget: 'memory', SessionSearch: 'memory', SessionRead: 'memory',
};

function toolGroup(t: Tool): string {
  const m = /^mcp__(.+?)__/.exec(t.name);
  if (m) return m[1];
  if (GROUPS[t.name]) return GROUPS[t.name];
  if (t.optIn || /^Browser/i.test(t.name)) return 'browser';
  return 'other';
}

/** Can this agent use the tool, and if not, why not. */
export function agentAccess(t: Tool, agent: AgentDef): ToolAgentAccess {
  const name = agent.name;
  const server = /^mcp__(.+?)__/.exec(t.name)?.[1];
  if (server && agent.mcpServers && !agent.mcpServers.includes(server)) return { name, visible: false, why: 'not in its mcpServers' };
  // an untrusted agent sees only the tools its list names (tools/index.ts untrustedOffers)
  if (agent.untrusted && !untrustedOffers(t.name, { allow: agent.tools })) return { name, visible: false, why: 'untrusted agent' };
  if (agent.disallowedTools?.length && !filterTools([t], { deny: agent.disallowedTools }).length) return { name, visible: false, why: 'in disallowedTools' };
  if (agent.tools?.length && !filterTools([{ ...t, optIn: false }], { allow: agent.tools }).length) return { name, visible: false, why: 'not in its tools list' };
  if (t.optIn && !filterTools([t], { allow: agent.tools ?? [], optIn: agent.optInTools }).length) return { name, visible: false, why: 'opt-in tool, name it in the tools list' };
  return { name, visible: true };
}

function hookCountsFor(engine: Engine, tool: string, groups: HookGroupInfo[], cwd: string): Partial<Record<HookEvent, number>> {
  const out: Partial<Record<HookEvent, number>> = {};
  const runner = engine.hookRunner;
  if (!runner) return out;
  const hooks = hooksFromGroups(groups);
  for (const ev of ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'] as HookEvent[]) {
    const n = runner.plan(ev, { session_id: 'check', cwd, hook_event_name: ev, tool_name: tool, tool_input: {} }, { matcherValue: tool, hooks }).length;
    if (n) out[ev] = n;
  }
  return out;
}

function permissionFor(
  engine: Engine,
  tool: Tool,
  input: Record<string, unknown>,
  ctx: { session: Session; home: string; sources: ReturnType<typeof ruleSources> },
): ToolPermissionInfo & { dangerous: string | false } {
  const cfg = engine.config.get();
  let content: string | undefined;
  try {
    content = tool.ruleContent?.(input as Record<string, any>, { cwd: ctx.session.cwd, machine: engine.localMachine });
  } catch {
    content = undefined;
  }
  let check = checkPermission({
    tool,
    input: input as Record<string, any>,
    content,
    mode: ctx.session.permissionMode,
    rules: PermissionRulesFor(engine, ctx.session),
    sessionAllow: [],
    cwd: ctx.session.cwd,
    home: ctx.home,
    workspaceRoots: [ctx.session.cwd, ...cfg.permissions.additionalDirectories],
  });
  let dangerous: string | false = false;
  if (tool.name === 'Bash' && typeof input.command === 'string') {
    const d = dangerousCommand(input.command);
    if (d) {
      dangerous = 'Potentially destructive command';
      if (check.decision === 'allow') check = { decision: 'ask', reason: 'Potentially destructive command' };
    }
  }
  if (tool.name === 'ExitPlanMode') check = { decision: 'ask', reason: 'Approve the plan to start working' };
  const src = check.rule ? ctx.sources.find((r) => r.rule === check.rule) : undefined;
  return {
    decision: check.decision,
    reason: check.reason,
    rule: check.rule ?? null,
    ruleSource: check.rule ? (src?.source ?? 'agent') : null,
    dangerous,
  };
}

export async function toolsDetail(engine: Engine, q: { cwd?: string; agent?: string }): Promise<ToolDetail[]> {
  const cwd = q.cwd || (await homeDir(engine));
  const home = await homeDir(engine);
  const builtin = engine.allTools();
  const mcp = await withTimeout(engine.mcpToolList(), 8_000, engine.cachedMcpTools());
  const agents = q.agent ? engine.extensions.agents(q.cwd).filter((a) => a.name === q.agent) : engine.extensions.agents(q.cwd);
  if (q.agent && !agents.length) throw new EngineError(404, `unknown agent ${q.agent}`);
  const session = pseudoSession(engine, cwd, q.agent);
  const sources = ruleSources(engine, q.cwd);
  const groups = hookGroups(engine, q.cwd);
  const out: ToolDetail[] = [];
  for (const t of [...builtin, ...mcp]) {
    const isMcp = t.name.startsWith('mcp__');
    const perm = permissionFor(engine, t, {}, { session, home, sources });
    out.push({
      name: t.name,
      description: oneLine(t.description, 300),
      readOnly: typeof t.readOnly === 'boolean' ? t.readOnly : false,
      source: isMcp ? 'mcp' : 'builtin',
      server: isMcp ? /^mcp__(.+?)__/.exec(t.name)?.[1] : undefined,
      kind: isMcp ? 'mcp' : 'builtin',
      group: toolGroup(t),
      agents: agents.map((a) => agentAccess(t, a)),
      permission: { decision: perm.decision, reason: perm.reason, rule: perm.rule, ruleSource: perm.ruleSource },
      hooks: hookCountsFor(engine, t.name, groups, cwd),
      ...(t.optIn ? { optIn: true } : {}),
    });
  }
  return out;
}

export async function checkTool(engine: Engine, input: ToolCheckInput): Promise<ToolCheckResult> {
  if (!input || typeof input.tool !== 'string' || !input.tool.trim()) throw new EngineError(400, 'tool is required');
  const builtin = engine.allTools();
  let tool = builtin.find((t) => t.name === input.tool);
  if (!tool && input.tool.startsWith('mcp__')) tool = (await withTimeout(engine.mcpToolList(), 8_000, engine.cachedMcpTools())).find((t) => t.name === input.tool);
  if (!tool) throw new EngineError(404, `unknown tool ${input.tool}`);
  if (input.agent && !engine.extensions.agent(input.agent, input.cwd)) throw new EngineError(404, `unknown agent ${input.agent}`);
  const home = await homeDir(engine);
  const cwd = input.cwd || home;
  const session = pseudoSession(engine, cwd, input.agent, input.mode);
  const args = input.input && typeof input.input === 'object' ? input.input : {};
  const perm = permissionFor(engine, tool, args, { session, home, sources: ruleSources(engine, input.cwd) });
  const runner = engine.hookRunner;
  const hooks = runner
    ? runner.plan('PreToolUse', { session_id: 'check', cwd, hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: args }, { matcherValue: tool.name, hooks: hooksFromGroups(hookGroups(engine, input.cwd)) }).length
    : 0;
  return { decision: perm.decision, reason: perm.reason, rule: perm.rule, ruleSource: perm.ruleSource, dangerous: perm.dangerous, hooks };
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

const EVENT_INFO: Record<HookEvent, { gloss: string; matcher: string | null }> = {
  SessionStart: { gloss: 'When a session starts, resumes, is cleared or compacted', matcher: 'startup, resume, clear, compact' },
  UserPromptSubmit: { gloss: 'Before your message reaches the model', matcher: null },
  PreToolUse: { gloss: 'Before a tool runs', matcher: 'tool name' },
  PermissionRequest: { gloss: 'When Conclave is about to ask you to approve a tool call', matcher: 'tool name' },
  PostToolUse: { gloss: 'After a tool succeeds', matcher: 'tool name' },
  PostToolUseFailure: { gloss: 'After a tool fails', matcher: 'tool name' },
  Notification: { gloss: 'When Conclave notifies you', matcher: 'permission_prompt, idle_prompt, errors, ...' },
  SubagentStart: { gloss: 'When a subagent starts', matcher: 'agent name' },
  SubagentStop: { gloss: 'When a subagent finishes', matcher: 'agent name' },
  PreCompact: { gloss: 'Before old messages are summarized', matcher: 'manual, auto' },
  Stop: { gloss: 'When the agent is about to finish its turn', matcher: null },
  SessionEnd: { gloss: 'When a session is cleared or deleted, or the hub stops', matcher: 'clear, other' },
};

const HANDLER_FIELDS = [
  'command', 'prompt', 'args', 'model', 'timeout', 'if', 'async', 'shell', 'plugin', 'pluginRoot',
  'recipe', 'onFailure', 'once', 'statusMessage', 'suppressOutput', 'server', 'tool', 'input', 'allowWrite', 'additionalContextLimit',
] as const;

function handlerDto(h: RuntimeHookCommand, event?: HookEvent, runner?: Engine['hookRunner']): HookGroupDto['hooks'][number] {
  const out: HookGroupDto['hooks'][number] = { type: h.type };
  for (const k of HANDLER_FIELDS) {
    if (h[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = h[k];
  }
  const tokens = event && runner ? runner.tokensPerSession(event, handlerLabel(h), h.plugin) : undefined;
  if (tokens) out.tokensPerSession = tokens;
  return out;
}

/** MCP server names hooks can match: config.json servers and plugin servers (plugin_<plugin>_<server>). */
export function hookMcpServerNames(engine: Engine): string[] {
  let plugin: string[] = [];
  try {
    plugin = Object.keys(engine.extensions.pluginMcpServers?.() ?? {});
  } catch {
    plugin = [];
  }
  return [...Object.keys(engine.config.get().mcpServers ?? {}), ...plugin];
}

/** Lint what loads: config.json, the project's .conclave/settings.json and Claude Code's settings files, read raw so flat entries show up. */
function lintLoaded(engine: Engine, cwd?: string): HookLintIssue[] {
  const servers = hookMcpServerNames(engine);
  const out: HookLintIssue[] = [];
  const add = (raw: unknown, path: string | undefined) => {
    if (!raw) return;
    for (const i of lintHooks(raw, { mcpServers: servers }).issues) out.push({ ...i, ...(path ? { path } : {}) });
  };
  add(engine.config.getUser().hooks, engine.config.paths.config);
  const compat = engine.config.get().compat.claudeCode;
  if (compat) add(claudeUserSettings()?.hooks, claudeUserSettings()?.path);
  if (cwd) for (const f of projectSettingsFiles(cwd, compat)) add(f.hooks, f.path);
  // two plugins that inject into every subagent stack their text on each one
  const sub = engine.extensions.pluginHooks().SubagentStart ?? [];
  const injecting = [...new Set(sub.filter((g) => !g.matcher || g.matcher === '*').flatMap((g) => (g.hooks as RuntimeHookCommand[]).map((h) => h.plugin)).filter(Boolean))];
  if (injecting.length > 1) out.push({ level: 'warn', event: 'SubagentStart', group: 0, text: `${injecting.join(' and ')} both add text to every subagent. Each subagent starts with both; turn one plugin's hooks off if they do the same job.` });
  return out;
}

export function hooksOverview(engine: Engine, cwd?: string): HooksOverview {
  const groups = hookGroups(engine, cwd);
  const recent = engine.hookRunner?.recent({ limit: 200 }) ?? [];
  const events: HookEventInfo[] = HOOK_EVENTS.map((event) => ({
    event,
    gloss: EVENT_INFO[event].gloss,
    matcherValue: EVENT_INFO[event].matcher,
    fires: FIRED_HOOK_EVENTS.has(event),
    groups: groups
      .filter((g) => g.event === event)
      .map((g) => ({
        matcher: g.matcher,
        source: g.source,
        path: g.path,
        plugin: g.plugin,
        index: g.index,
        active: g.active,
        // saveHooks writes config.json and .conclave/settings.json; .conclave/settings.local.json is edited by hand
        editable: g.source === 'config' || (g.source === 'project' && !/settings\.local\.json$/.test(g.path ?? '')),
        hooks: g.hooks.map((h) => handlerDto(h, event, engine.hookRunner)),
      })),
    last: recent.filter((t) => t.event === event).slice(-10),
  }));
  const lint = lintLoaded(engine, cwd);
  return { events, trust: cwd ? trustInfo(engine, cwd) : undefined, ...(lint.length ? { lint } : {}) };
}

/** The default matcher value for a test run, taken from the sample input. */
function defaultMatcherValue(event: HookEvent, input: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
      return s('tool_name');
    case 'SessionStart':
      return s('source');
    case 'SessionEnd':
      return s('reason');
    case 'PreCompact':
      return s('trigger');
    case 'SubagentStart':
    case 'SubagentStop':
      return s('agent_type');
    case 'Notification':
      return s('notification_type');
    default:
      return undefined;
  }
}

/** What the model or the user would see for an outcome, in plain words. */
export function describeOutcome(event: HookEvent, o: HookOutcome): string {
  const reason = o.reason ?? 'no reason given';
  const ctx = o.additionalContext.length ? ` Added to the model's context: ${o.additionalContext.join(' | ')}` : '';
  switch (event) {
    case 'PreToolUse':
      if (o.blocked || o.permissionDecision === 'deny') return `Blocked. The model would see: Blocked by hook: ${reason}`;
      if (o.permissionDecision === 'ask') return `Asks you to approve the call: ${reason}`;
      if (o.permissionDecision === 'allow') return `Allowed without a prompt.${o.updatedInput ? ` Input changed to ${JSON.stringify(o.updatedInput)}.` : ''}`;
      if (o.updatedInput) return `Runs with changed input: ${JSON.stringify(o.updatedInput)}`;
      return `No change; the normal permission check decides.${ctx}`;
    case 'PermissionRequest':
      if (o.blocked || o.permissionDecision === 'deny') return `Denied for you. The model would see: Permission denied by hook: ${reason}`;
      if (o.permissionDecision === 'allow') return 'Approved for you; no prompt is shown.';
      return 'No decision; you would be asked as usual.';
    case 'UserPromptSubmit':
      if (o.blocked) return `Prompt blocked. You would see: Prompt blocked by hook: ${reason}`;
      return ctx ? ctx.trim() : 'No change.';
    case 'Stop':
    case 'SubagentStop':
      if (o.blocked && o.reason) return `The agent would keep going with: ${event === 'Stop' ? 'Stop' : 'SubagentStop'} hook feedback:\n${o.reason}`;
      return 'The agent would stop as usual.';
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const notes = [...o.additionalContext, ...(o.blocked && o.reason ? [o.reason] : [])];
      const parts: string[] = [];
      if (o.updatedToolOutput !== undefined) parts.push(`Tool result replaced with: ${typeof o.updatedToolOutput === 'string' ? o.updatedToolOutput : JSON.stringify(o.updatedToolOutput)}`);
      if (notes.length) parts.push(`Appended to the tool result: ${notes.join(' | ')}`);
      if (o.stop) parts.push(`The turn stops: ${o.stop.reason ?? 'Stopped by hook'}`);
      return parts.join(' ') || 'No change.';
    }
    case 'PreCompact':
      if (o.blocked) return `Compaction is skipped: ${reason}`;
      return ctx ? `Compaction keeps these details:${ctx.replace(" Added to the model's context:", '')}` : 'No change.';
    default:
      return ctx ? ctx.trim() : 'Side effects only; nothing reaches the model.';
  }
}

export async function testHook(engine: Engine, t: HookTestInput): Promise<HookTestResult> {
  if (!t || typeof t.event !== 'string' || !(HOOK_EVENTS as string[]).includes(t.event)) throw new EngineError(400, `event must be one of ${HOOK_EVENTS.join(', ')}`);
  const runner = engine.hookRunner;
  if (!runner) throw new EngineError(501, 'hooks are not available on this hub');
  const cwd = t.cwd || (await homeDir(engine));
  const sample = t.input && typeof t.input === 'object' ? t.input : {};
  const input: HookInput = {
    session_id: 'test',
    cwd,
    permission_mode: engine.config.get().permissions.mode,
    ...(sample as Partial<HookInput>),
    hook_event_name: t.event,
  };
  if (input.cwd !== cwd) input.cwd = cwd;
  const groups = hookGroups(engine, t.cwd);
  const hooks = hooksFromGroups(groups, t.only);
  const matcherValue = t.matcherValue ?? defaultMatcherValue(t.event, sample);
  const outcome = await runner.run(t.event, input, { matcherValue, hooks });
  return {
    blocked: outcome.blocked,
    reason: outcome.reason,
    permissionDecision: outcome.permissionDecision,
    updatedInput: outcome.updatedInput,
    updatedToolOutput: outcome.updatedToolOutput,
    additionalContext: outcome.additionalContext,
    systemMessages: outcome.systemMessages,
    stop: outcome.stop,
    trace: outcome.trace ?? [],
    modelWouldSee: describeOutcome(t.event, outcome),
  };
}

/** Check a HooksConfig from the API before saving it. */
export function validateHooks(hooks: unknown): HooksConfig {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new EngineError(400, 'hooks must be an object keyed by event');
  for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as string[]).includes(event)) throw new EngineError(400, `unknown hook event ${event}`);
    if (!Array.isArray(list)) throw new EngineError(400, `hooks.${event} must be a list of groups`);
    list.forEach((g, i) => {
      const where = `hooks.${event}[${i}]`;
      if (!g || typeof g !== 'object' || !Array.isArray((g as { hooks?: unknown }).hooks)) throw new EngineError(400, `${where} needs a hooks list`);
      const m = (g as { matcher?: unknown }).matcher;
      if (m !== undefined && typeof m !== 'string') throw new EngineError(400, `${where}.matcher must be a string`);
      for (const [j, h] of ((g as { hooks: unknown[] }).hooks).entries()) {
        const hw = `${where}.hooks[${j}]`;
        const hh = h as Record<string, unknown>;
        if (!hh || typeof hh !== 'object') throw new EngineError(400, `${hw} must be an object`);
        if (hh.type === 'command' && (typeof hh.command !== 'string' || !hh.command.trim())) throw new EngineError(400, `${hw}.command is required`);
        else if (hh.type === 'prompt' && (typeof hh.prompt !== 'string' || !hh.prompt.trim())) throw new EngineError(400, `${hw}.prompt is required`);
        else if (hh.type === 'mcp_tool' && (typeof hh.server !== 'string' || !hh.server.trim() || typeof hh.tool !== 'string' || !hh.tool.trim())) throw new EngineError(400, `${hw} needs server and tool`);
        else if (hh.type !== 'command' && hh.type !== 'prompt' && hh.type !== 'mcp_tool') throw new EngineError(400, `${hw}.type must be command, prompt or mcp_tool`);
        if (hh.onFailure !== undefined && hh.onFailure !== 'block' && hh.onFailure !== 'ignore') throw new EngineError(400, `${hw}.onFailure must be block or ignore`);
        if (hh.input !== undefined && (!hh.input || typeof hh.input !== 'object' || Array.isArray(hh.input))) throw new EngineError(400, `${hw}.input must be an object`);
        if (hh.timeout !== undefined && (typeof hh.timeout !== 'number' || hh.timeout <= 0)) throw new EngineError(400, `${hw}.timeout must be a positive number of seconds`);
      }
    });
  }
  return hooks as HooksConfig;
}

/** One scope's hooks as stored: config.json (user) or <cwd>/.conclave/settings.json (project). */
export function readScopeHooks(engine: Engine, scope: 'user' | 'project', cwd?: string): HooksConfig {
  if (scope === 'user') return structuredClone(engine.config.getUser().hooks ?? {});
  if (!cwd) throw new EngineError(400, 'cwd is required for project hooks');
  const file = join(cwd, '.conclave', 'settings.json');
  if (!existsSync(file)) return {};
  try {
    const data = parseJsonc<Record<string, unknown>>(readFileSync(file, 'utf8')) ?? {};
    return (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as HooksConfig;
  } catch (err) {
    throw new EngineError(400, `${file} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Save one scope's hooks. Flat entries are wrapped first; the rest of the lint comes back as warnings. */
export function saveHooks(engine: Engine, input: { scope: 'user' | 'project'; cwd?: string; hooks: HooksConfig }): HookLintIssue[] {
  if (input?.scope !== 'user' && input?.scope !== 'project') throw new EngineError(400, 'scope must be user or project');
  const wrapped = wrapFlatEntries(input.hooks);
  const hooks = validateHooks(wrapped.hooks);
  const lint = lintHooks(hooks, { mcpServers: hookMcpServerNames(engine) }).issues;
  // drop empty events so the files stay tidy
  for (const k of Object.keys(hooks) as HookEvent[]) if (!hooks[k]?.length) delete hooks[k];
  if (input.scope === 'user') {
    engine.config.replace({ ...engine.config.getUser(), hooks });
    return lint;
  }
  if (!input.cwd) throw new EngineError(400, 'cwd is required for project hooks');
  // a relative folder would be written next to wherever the hub was started
  if (!isAbsolute(input.cwd)) throw new EngineError(400, `cwd must be a full path, like /home/you/code/app. Got ${input.cwd}.`);
  const dir = join(input.cwd, '.conclave');
  const file = join(dir, 'settings.json');
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = parseJsonc<Record<string, unknown>>(readFileSync(file, 'utf8')) ?? {};
    } catch (err) {
      throw new EngineError(400, `${file} is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (Object.keys(hooks).length) data.hooks = hooks;
  else delete data.hooks;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return lint;
}

export function importHooks(from: 'gemini' | 'codex', cwd?: string): HookImportResult {
  if (from !== 'gemini' && from !== 'codex') throw new EngineError(400, 'from must be gemini or codex');
  const res = readForeignHooks(from, cwd);
  // lint the converted list: wrap flat entries, and say what still looks wrong
  const wrapped = wrapFlatEntries(res.hooks);
  const lint = lintHooks(wrapped.hooks);
  const notes = [...res.notes];
  if (wrapped.wrapped) notes.push(`${wrapped.wrapped} bare handler${wrapped.wrapped === 1 ? ' was' : 's were'} wrapped into a group with a hooks list.`);
  for (const i of lint.issues) notes.push(i.text);
  return { ...res, hooks: lint.fixed, notes };
}

// ---------------------------------------------------------------------------
// plugins and marketplace
// ---------------------------------------------------------------------------

export function pluginDetail(engine: Engine, name: string): PluginDetailDto | undefined {
  const ext = engine.extensions as { pluginDetail?: (n: string) => PluginDetailDto | undefined };
  if (ext.pluginDetail) return ext.pluginDetail(name);
  const p = engine.extensions.plugins().find((x) => x.name === name);
  return p ? { ...p, agents: [], skills: [], commands: [], hooks: {}, mcpServers: {} } : undefined;
}

export async function updatePlugin(engine: Engine, name: string): Promise<InstalledPlugin> {
  const p = engine.extensions.plugins().find((x) => x.name === name);
  if (!p) throw new EngineError(404, `unknown plugin ${name}`);
  let next: InstalledPlugin;
  try {
    next = await engine.extensions.installPlugin(p.source);
  } catch (err) {
    throw new EngineError(502, `update of ${name} from ${p.source} failed: ${(err as Error).message}`);
  }
  if (!p.enabled) {
    await engine.extensions.setPluginEnabled(next.name, false);
    next = { ...next, enabled: false };
  }
  return next;
}

function sourceKind(e: MarketplaceEntry): string {
  if (typeof e.source === 'string') return /^(\.|\/)/.test(e.source) || !e.source.includes(':') ? 'path' : 'url';
  const kind = e.source?.source;
  return kind === 'github' || kind === 'git' || kind === 'url' ? kind : kind ? String(kind) : 'other';
}

export async function searchMarketplace(engine: Engine, q: { q?: string; category?: string; marketplace?: string }): Promise<MarketplaceSearchResult> {
  const entries = await engine.extensions.marketplaces();
  const installed = new Map(engine.extensions.plugins().map((p) => [p.name, p]));
  const needle = q.q?.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.marketplace, (counts.get(e.marketplace) ?? 0) + 1);
  const results: MarketplaceSearchItem[] = entries
    .filter((e) => !q.marketplace || e.marketplace === q.marketplace)
    .filter((e) => !q.category || (e.category ?? '').toLowerCase() === q.category.toLowerCase())
    .filter((e) => !needle || [e.name, e.description ?? '', e.category ?? ''].some((s) => s.toLowerCase().includes(needle)))
    .map((e) => {
      const p = installed.get(e.name);
      return {
        name: e.name,
        description: e.description,
        category: e.category,
        version: e.version,
        marketplace: e.marketplace,
        sourceKind: sourceKind(e),
        installed: !!p,
        enabled: !!p?.enabled,
        install: `${e.name}@${e.marketplace}`,
      };
    });
  return { marketplaces: [...counts].map(([name, plugins]) => ({ name, plugins })), results };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Config of a server by name: config.json first, then plugins. */
export function mcpServerConfig(engine: Engine, name: string): { config: McpServerConfig; origin: 'config' | 'plugin' } | undefined {
  const own = engine.config.get().mcpServers[name];
  if (own) return { config: own, origin: 'config' };
  const plugin = engine.extensions.pluginMcpServers()[name];
  return plugin ? { config: plugin, origin: 'plugin' } : undefined;
}

/** McpStatus plus origin, plugin, transport and enabled. */
export function enrichStatus(engine: Engine, list: McpStatus[]): McpStatus[] {
  const own = engine.config.get().mcpServers;
  const pluginServers = engine.extensions.pluginMcpServers();
  const plugins = engine.extensions.plugins().map((p) => p.name).sort((a, b) => b.length - a.length);
  return list.map((s) => {
    const origin = own[s.name] ? 'config' : pluginServers[s.name] ? 'plugin' : undefined;
    const plugin = origin === 'plugin' ? plugins.find((p) => s.name.startsWith(`plugin_${p}_`)) : undefined;
    const transport = s.source === 'stdio' || s.source === 'http' || s.source === 'sse' ? s.source : undefined;
    return { ...s, ...(origin ? { origin } : {}), ...(plugin ? { plugin } : {}), ...(transport ? { transport } : {}), enabled: s.status !== 'disabled' };
  });
}

function requireServer(engine: Engine, name: string): { config: McpServerConfig; origin: 'config' | 'plugin' } {
  const found = mcpServerConfig(engine, name);
  if (!found) throw new EngineError(404, `unknown mcp server ${name}`);
  return found;
}

export async function restartMcp(engine: Engine, name: string): Promise<McpStatus> {
  requireServer(engine, name);
  const mcp = engine.mcpManager;
  if (!mcp) throw new EngineError(501, 'MCP is not available on this hub');
  const st = await mcp.restart(name);
  const status = st ?? engine.mcpStatus().find((s) => s.name === name);
  if (!status) throw new EngineError(404, `unknown mcp server ${name}`);
  engine.invalidateMcpTools();
  return enrichStatus(engine, [status])[0];
}

export async function testMcp(engine: Engine, name: string): Promise<McpTestResult> {
  const found = requireServer(engine, name);
  if (found.config.enabled === false) throw new EngineError(409, `mcp server ${name} is disabled`);
  const mcp = engine.mcpManager;
  if (!mcp) throw new EngineError(501, 'MCP is not available on this hub');
  const r = await mcp.test(name);
  engine.invalidateMcpTools();
  return r;
}

export async function mcpServerTools(engine: Engine, name: string): Promise<McpToolDto[]> {
  const found = requireServer(engine, name);
  if (found.config.enabled === false) throw new EngineError(409, `mcp server ${name} is disabled`);
  const mcp = engine.mcpManager;
  if (!mcp) throw new EngineError(501, 'MCP is not available on this hub');
  try {
    return (await mcp.serverTools(name)).map((t) => ({ ...t, inputSchema: t.inputSchema as Record<string, unknown> | undefined }));
  } catch (err) {
    throw new EngineError(502, `could not reach ${name}: ${(err as Error).message}`);
  }
}

export async function callMcpTool(engine: Engine, name: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const found = requireServer(engine, name);
  if (found.config.enabled === false) throw new EngineError(409, `mcp server ${name} is disabled`);
  if (typeof tool !== 'string' || !tool.trim()) throw new EngineError(400, 'tool is required');
  const mcp = engine.mcpManager;
  if (!mcp) throw new EngineError(501, 'MCP is not available on this hub');
  const out = await mcp.callTool(name, tool, args && typeof args === 'object' ? args : {});
  return { content: out.content as McpCallResult['content'], isError: out.isError };
}

function validateServerConfig(cfg: unknown): McpServerConfig {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new EngineError(400, 'config must be an object');
  const c = cfg as McpServerConfig;
  if (!c.command && !c.url) throw new EngineError(400, 'config needs a command (stdio) or a url (http, sse)');
  if (c.command !== undefined && typeof c.command !== 'string') throw new EngineError(400, 'config.command must be a string');
  if (c.url !== undefined) {
    try {
      const u = new URL(c.url.replace(/\$\{[^}]+\}/g, 'x'));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new EngineError(400, 'config.url must be an http(s) URL');
    }
  }
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string'))) throw new EngineError(400, 'config.args must be a list of strings');
  if (c.type !== undefined && !['stdio', 'http', 'sse'].includes(c.type)) throw new EngineError(400, 'config.type must be stdio, http or sse');
  return c;
}

function statusOf(engine: Engine, name: string): McpStatus {
  const s = engine.mcpStatus().find((x) => x.name === name);
  return s ?? { name, status: 'failed', tools: 0, source: 'unknown' };
}

export function addMcpServer(engine: Engine, name: string, config: McpServerConfig): McpStatus {
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) throw new EngineError(400, 'name must be 1-64 letters, digits, _ or -');
  if (mcpServerConfig(engine, name)) throw new EngineError(409, `an mcp server named ${name} already exists`);
  const cfg = validateServerConfig(config);
  engine.config.update({ mcpServers: { ...engine.config.getUser().mcpServers, [name]: cfg } });
  engine.invalidateMcpTools();
  // start it now so the list shows "connecting" and then the real outcome, not a server that never ran
  if (cfg.enabled !== false) void engine.mcpManager?.ensure(name).catch(() => undefined);
  return statusOf(engine, name);
}

export function updateMcpServer(engine: Engine, name: string, patch: { enabled?: boolean; config?: McpServerConfig }): McpStatus {
  const found = requireServer(engine, name);
  if (found.origin === 'plugin') throw new EngineError(400, `${name} comes from a plugin; enable or disable the plugin instead`);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new EngineError(400, 'enabled must be a boolean');
  const base = patch.config !== undefined ? validateServerConfig(patch.config) : found.config;
  const next: McpServerConfig = { ...base, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) };
  if (next.enabled === true) delete next.enabled;
  const user = engine.config.getUser();
  engine.config.replace({ ...user, mcpServers: { ...(user.mcpServers ?? {}), [name]: next } });
  engine.invalidateMcpTools();
  if (next.enabled !== false) void engine.mcpManager?.ensure(name).catch(() => undefined);
  return statusOf(engine, name);
}

export function removeMcpServer(engine: Engine, name: string): boolean {
  const found = mcpServerConfig(engine, name);
  if (!found) return false;
  if (found.origin === 'plugin') throw new EngineError(400, `${name} comes from a plugin; remove the plugin instead`);
  const user = engine.config.getUser();
  const servers = { ...(user.mcpServers ?? {}) };
  if (!(name in servers)) throw new EngineError(400, `${name} is not in config.json, so it cannot be removed here`);
  delete servers[name];
  engine.config.replace({ ...user, mcpServers: servers });
  engine.invalidateMcpTools();
  return true;
}

export function importMcp(from: McpImportFormat, text: string): Record<string, McpServerConfig> {
  if (typeof text !== 'string' || !text.trim()) throw new EngineError(400, 'text is required');
  if (!['claude', 'codex', 'opencode', 'gemini'].includes(from)) throw new EngineError(400, 'from must be claude, codex, opencode or gemini');
  try {
    if (from === 'codex') return mcpFromCodexToml(text);
    const json = parseJsonc<Record<string, unknown>>(text);
    if (!json || typeof json !== 'object') throw new Error('expected a JSON object');
    if (from === 'claude') return mcpFromClaude(json);
    if (from === 'opencode') return mcpFromOpenCode(json);
    if (from === 'gemini') return mcpFromGemini(json);
  } catch (err) {
    throw new EngineError(400, `could not read the ${from} config: ${(err as Error).message}`);
  }
  throw new EngineError(400, 'from must be claude, codex, opencode or gemini');
}

const SECRET_NOTE = 'Other CLIs cannot read Conclave secrets: replace ${secret:...} with the value or an environment variable before running this.';

export function mcpConnectPlanFor(name: string, config: McpServerConfig): McpConnectStepDto[] {
  return mcpConnectPlan(name, config).map((step) => {
    const text = `${step.command ?? ''}\n${step.snippet}`;
    if (!text.includes('${secret:') && !text.includes('********')) return step;
    return { ...step, note: step.note ? `${step.note} ${SECRET_NOTE}` : SECRET_NOTE };
  });
}

export async function connectMcp(engine: Engine, name: string, steps: McpConnectStepDto[], device: string, clis: CliName[]): Promise<McpConnectRunResult[]> {
  if (!Array.isArray(clis) || !clis.length || clis.some((c) => !CLI_NAMES.includes(c))) throw new EngineError(400, `clis must list some of ${CLI_NAMES.join(', ')}`);
  const machine = engine.devices.get(device || 'local');
  if (!machine) throw new EngineError(device && engine.repos.devices.get(device) ? 409 : 404, `device ${device} is not available`);
  const info = await machine.info().catch(() => undefined);
  const out: McpConnectRunResult[] = [];
  for (const cli of clis) {
    const step = steps.find((s) => s.cli === cli);
    if (!step?.command) {
      out.push({ cli, exitCode: null, stdout: '', stderr: '', skipped: `no command for ${cli}; add the snippet to ${step?.file ?? 'its config file'}` });
      continue;
    }
    if (info && !info.clis?.[cli]) {
      const where = engine.devices.list().find((d) => d.id === (device || 'local'))?.name ?? (device || 'the hub');
      out.push({ cli, command: step.command, exitCode: null, stdout: '', stderr: '', skipped: `${cli} is not installed on ${where}` });
      continue;
    }
    const res = await machine.exec(step.command, { cwd: info?.home ?? '/', timeoutMs: 60_000 });
    out.push({ cli, command: step.command, exitCode: res.exitCode, stdout: res.stdout.slice(-4000), stderr: res.stderr.slice(-4000) });
  }
  engine.audit(undefined, 'mcp.connect', `${name} on ${device || 'local'}: ${clis.join(', ')}`);
  return out;
}
