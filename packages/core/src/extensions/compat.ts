import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type { HookEvent, HookMatcher, HooksConfig, McpServerConfig } from '../config/schema';
import { codexHome } from '../config/paths';
import type { AgentDef, CommandDef, SkillDef } from './types';
import { EFFORT_TO_THINKING, loadSkillFolder, loadSkillsFromDir, parseMd, type LoadResult, type ModelMapper } from './loader';
import { textField, toList } from '../util/frontmatter';
import { logger } from '../util/log';

const log = logger('compat');

/**
 * Loaders for other CLIs' formats, behind the compat.codex, compat.opencode and
 * compat.gemini flags, plus pure converters for MCP servers and hooks. Formats
 * and paths come from docs/extensions/research-*.md (Codex 0.163, OpenCode
 * 1.19.3, Gemini CLI 0.64).
 */

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function agentsHome(): string {
  return join(homedir(), '.agents');
}

export function geminiHome(): string {
  return join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini');
}

export function opencodeConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}

/** Folders from the project root (nearest ancestor with .git) down to cwd. Just [cwd] outside a repo. */
export function projectChain(cwd: string): string[] {
  const up: string[] = [];
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    up.push(dir);
    if (existsSync(join(dir, '.git'))) return up.reverse();
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [cwd];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full, match));
    else if (st.isFile() && match(name)) out.push(full);
  }
  return out;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readToml(path: string): Record<string, unknown> | undefined {
  try {
    return Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    log.warn(`invalid toml in ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

function readJsonLoose(path: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(path, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const EDIT_FAMILY = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

/**
 * Map another CLI's provider/model id to a Conclave ref. Known provider ids are
 * renamed (OpenCode's zai-coding-plan is Conclave's zai); bare model ids get a
 * provider guessed from the name.
 */
export function mapForeignModel(raw: string | undefined, mapModel: ModelMapper): string | undefined {
  const v = str(raw);
  if (!v) return undefined;
  const slash = v.indexOf('/');
  if (slash > 0) {
    const provider = v.slice(0, slash);
    const model = v.slice(slash + 1);
    const rename: Record<string, string> = {
      'zai-coding-plan': 'zai',
      'zhipuai-coding-plan': 'zai',
      zhipuai: 'zai',
      gemini: 'google',
      'google-vertex': 'google',
    };
    return `${rename[provider] ?? provider}/${model}`;
  }
  if (/^(gpt-|o\d|codex)/i.test(v)) return `openai/${v}`;
  if (/^gemini/i.test(v)) return `google/${v}`;
  if (/^glm/i.test(v)) return `zai/${v}`;
  return mapModel(v);
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Codex custom prompts ($CODEX_HOME/prompts/*.md). Current Codex dropped them in
 * favour of skills, but old setups still have them. They load as commands named
 * "prompts:<name>", the way Codex used to invoke them, with one-based $1..$9.
 */
export function loadCodexPrompts(dir: string, mapModel: ModelMapper): CommandDef[] {
  const out: CommandDef[] = [];
  if (!existsSync(dir)) return out;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return out;
  }
  for (const file of names) {
    const path = join(dir, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseMd(text);
    out.push({
      name: `prompts:${basename(file, '.md')}`,
      description: str(data.description),
      argumentHint: textField(data['argument-hint'] ?? data.argumentHint),
      model: mapForeignModel(str(data.model), mapModel),
      body: body.trim(),
      argStyle: 'numbered',
      source: 'codex',
      path,
    });
  }
  return out;
}

/**
 * Codex agent roles (<config>/agents/**\/*.toml). description is required, as
 * in Codex. The mapping follows Codex's own Claude importer in reverse:
 * developer_instructions is the prompt, model_reasoning_effort the thinking
 * level, sandbox_mode read-only removes the edit tools and workspace-write
 * means acceptEdits.
 */
export function loadCodexAgents(dir: string, mapModel: ModelMapper): AgentDef[] {
  const out: AgentDef[] = [];
  for (const path of walk(dir, (n) => n.endsWith('.toml'))) {
    const data = readToml(path);
    if (!data) continue;
    const description = str(data.description);
    if (!description) {
      log.warn(`codex agent ${path} has no description; skipped (Codex rejects it too)`);
      continue;
    }
    const effort = str(data.model_reasoning_effort);
    const sandbox = str(data.sandbox_mode);
    out.push({
      name: str(data.name) ?? basename(path, '.toml'),
      description,
      prompt: (str(data.developer_instructions) ?? str(data.instructions) ?? '').trim(),
      model: mapForeignModel(str(data.model), mapModel),
      thinking: effort ? EFFORT_TO_THINKING[effort] : undefined,
      disallowedTools: sandbox === 'read-only' ? [...EDIT_FAMILY] : undefined,
      permissionMode: sandbox === 'workspace-write' ? 'acceptEdits' : undefined,
      subagent: true,
      source: 'codex',
      path,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/** OpenCode tool ids and the Conclave tools they stand for. */
const OPENCODE_TOOLS: Record<string, string[]> = {
  bash: ['Bash'],
  read: ['Read'],
  glob: ['Glob'],
  grep: ['Grep'],
  list: ['LS'],
  edit: EDIT_FAMILY,
  write: ['Write'],
  patch: EDIT_FAMILY,
  apply_patch: EDIT_FAMILY,
  task: ['Task'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  todowrite: ['TodoWrite'],
  skill: ['Skill'],
  question: ['AskUserQuestion'],
  plan_exit: ['ExitPlanMode'],
};

type Action = 'allow' | 'ask' | 'deny';

function actionOf(v: unknown): Action | undefined {
  if (v === 'allow' || v === 'ask' || v === 'deny') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const star = actionOf(o['*']);
    if (star) return star;
    // Pattern-only rules (e.g. bash: {"git *": allow}) keep the tool usable.
    return Object.values(o).some((x) => x === 'allow' || x === 'ask') ? 'ask' : undefined;
  }
  return undefined;
}

/** Turn an OpenCode `permission` map and legacy `tools: {name: bool}` into Conclave allow and deny lists. */
export function opencodePermissionToTools(permission: unknown, tools: unknown): { tools?: string[]; disallowedTools?: string[] } {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  let starDeny = false;
  if (typeof permission === 'string') {
    if (permission === 'deny') starDeny = true;
  } else if (permission && typeof permission === 'object' && !Array.isArray(permission)) {
    const p = permission as Record<string, unknown>;
    starDeny = actionOf(p['*']) === 'deny';
    for (const [key, v] of Object.entries(p)) {
      const mapped = OPENCODE_TOOLS[key];
      if (!mapped) continue;
      const a = actionOf(v);
      if (a === 'deny') mapped.forEach((t) => denied.add(t));
      else if (a) mapped.forEach((t) => allowed.add(t));
    }
  }
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    for (const [key, v] of Object.entries(tools as Record<string, unknown>)) {
      const mapped = OPENCODE_TOOLS[key];
      if (!mapped) continue;
      if (v === false) mapped.forEach((t) => denied.add(t));
      else if (v === true) mapped.forEach((t) => allowed.add(t));
    }
  }
  if (starDeny) return { tools: [...allowed].filter((t) => !denied.has(t)) };
  return denied.size ? { disallowedTools: [...denied] } : {};
}

/** OpenCode agent markdown (`agent/` or `agents/`). The name is the path without .md, e.g. "sec/audit". */
export function loadOpenCodeAgents(dir: string, mapModel: ModelMapper): AgentDef[] {
  const out: AgentDef[] = [];
  for (const path of walk(dir, (n) => n.endsWith('.md'))) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseMd(text);
    const name = relative(dir, path).replace(/\.md$/, '').split(sep).join('/');
    const mode = str(data.mode) ?? 'all';
    if (data.disable === true) continue;
    const color = str(data.color);
    const perms = opencodePermissionToTools(data.permission, data.tools);
    out.push({
      name,
      description: str(data.description) ?? '',
      prompt: body.trim(),
      model: mapForeignModel(str(data.model), mapModel),
      temperature: num(data.temperature),
      color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined,
      tools: perms.tools,
      disallowedTools: perms.disallowedTools,
      subagent: mode === 'subagent' || mode === 'all',
      primary: (mode === 'primary' || mode === 'all') && data.hidden !== true,
      source: 'opencode',
      path,
    });
  }
  return out;
}

/** OpenCode command markdown. Name is the path without .md ("git/commit"); one-based args, last one takes the rest. */
export function loadOpenCodeCommands(dir: string, mapModel: ModelMapper): CommandDef[] {
  const out: CommandDef[] = [];
  for (const path of walk(dir, (n) => n.endsWith('.md'))) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseMd(text);
    out.push({
      name: relative(dir, path).replace(/\.md$/, '').split(sep).join('/'),
      description: str(data.description),
      agent: str(data.agent),
      model: mapForeignModel(str(data.model), mapModel),
      subtask: data.subtask === true || undefined,
      body: body.trim(),
      argStyle: 'opencode',
      source: 'opencode',
      path,
    });
  }
  return out;
}

/** Skills at any depth under dir (OpenCode reads `skills/**\/SKILL.md`). */
export function loadNestedSkills(dir: string, source: SkillDef['source']): SkillDef[] {
  const out: SkillDef[] = [];
  for (const path of walk(dir, (n) => n === 'SKILL.md')) {
    const skill = loadSkillFolder(dirname(path), source, undefined, 'frontmatter');
    if (skill) out.push(skill);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

/** Gemini CLI tool names and the Conclave tools they stand for. */
export const GEMINI_TOOLS: Record<string, string> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  read_many_files: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  glob: 'Glob',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  list_directory: 'LS',
  web_fetch: 'WebFetch',
  google_web_search: 'WebSearch',
  write_todos: 'TodoWrite',
  ask_user: 'AskUserQuestion',
  activate_skill: 'Skill',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
};

/** Gemini TOML commands. Name is the path with ":" between folders ("git:commit"). */
export function loadGeminiCommands(dir: string): CommandDef[] {
  const out: CommandDef[] = [];
  for (const path of walk(dir, (n) => n.endsWith('.toml'))) {
    const data = readToml(path);
    const prompt = str(data?.prompt);
    if (!data || !prompt) continue;
    out.push({
      name: relative(dir, path).replace(/\.toml$/, '').split(sep).join(':'),
      description: str(data.description),
      body: prompt,
      argStyle: 'gemini',
      source: 'gemini',
      path,
    });
  }
  return out;
}

/** Gemini subagents (agents/*.md, strict schema). Gemini tool names are mapped to Conclave's. */
export function loadGeminiAgents(dir: string, mapModel: ModelMapper): AgentDef[] {
  const out: AgentDef[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return out;
  }
  for (const file of names) {
    const path = join(dir, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseMd(text);
    const rawTools = toList(data.tools);
    let tools: string[] | undefined;
    if (rawTools && !rawTools.includes('*')) {
      tools = [...new Set(rawTools.map((t) => GEMINI_TOOLS[t]).filter((t): t is string => !!t))];
    }
    out.push({
      name: str(data.name) ?? basename(file, '.md'),
      description: str(data.description) ?? '',
      prompt: body.trim(),
      model: mapForeignModel(str(data.model), mapModel),
      temperature: num(data.temperature),
      tools,
      subagent: true,
      source: 'gemini',
      path,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregate loaders used by the registry
// ---------------------------------------------------------------------------

export interface CompatFlags {
  codex?: boolean;
  opencode?: boolean;
  gemini?: boolean;
}

export interface CompatHomes {
  agents?: string;
  codex?: string;
  opencode?: string;
  gemini?: string;
}

function homes(h: CompatHomes = {}): Required<CompatHomes> {
  return {
    agents: h.agents ?? agentsHome(),
    codex: h.codex ?? codexHome(),
    opencode: h.opencode ?? opencodeConfigDir(),
    gemini: h.gemini ?? geminiHome(),
  };
}

/**
 * Load other CLIs' components in precedence order (lowest first). Each entry is
 * one scope, so the registry can show what shadows what.
 */
export function loadCompatScopes(flags: CompatFlags, mapModel: ModelMapper, cwd?: string, h?: CompatHomes): Array<{ label: string } & LoadResult> {
  const H = homes(h);
  const scopes: Array<{ label: string } & LoadResult> = [];
  const empty = (): LoadResult => ({ agents: [], skills: [], commands: [] });
  const chain = cwd ? projectChain(cwd) : [];

  // ~/.agents/skills and .agents/skills: the shared folder Codex, OpenCode and Gemini all read.
  if (flags.codex || flags.opencode || flags.gemini) {
    scopes.push({ label: '~/.agents', ...empty(), skills: loadSkillsFromDir(join(H.agents, 'skills'), 'agents', undefined, 'frontmatter') });
  }

  if (flags.codex) {
    scopes.push({
      label: 'codex user',
      agents: loadCodexAgents(join(H.codex, 'agents'), mapModel),
      skills: loadSkillsFromDir(join(H.codex, 'skills'), 'codex', undefined, 'frontmatter'),
      commands: loadCodexPrompts(join(H.codex, 'prompts'), mapModel),
    });
    for (const dir of chain) {
      scopes.push({ label: `codex project ${dir}`, ...empty(), agents: loadCodexAgents(join(dir, '.codex', 'agents'), mapModel), skills: loadSkillsFromDir(join(dir, '.codex', 'skills'), 'codex', undefined, 'frontmatter') });
    }
  }
  if (flags.codex || flags.opencode || flags.gemini) {
    for (const dir of chain) scopes.push({ label: `.agents ${dir}`, ...empty(), skills: loadSkillsFromDir(join(dir, '.agents', 'skills'), 'agents', undefined, 'frontmatter') });
  }

  if (flags.opencode) {
    const fromDir = (base: string, label: string) => ({
      label,
      agents: [...loadOpenCodeAgents(join(base, 'agent'), mapModel), ...loadOpenCodeAgents(join(base, 'agents'), mapModel)],
      skills: [...loadNestedSkills(join(base, 'skill'), 'opencode'), ...loadNestedSkills(join(base, 'skills'), 'opencode')],
      commands: [...loadOpenCodeCommands(join(base, 'command'), mapModel), ...loadOpenCodeCommands(join(base, 'commands'), mapModel)],
    });
    scopes.push(fromDir(H.opencode, 'opencode user'));
    for (const dir of chain) scopes.push(fromDir(join(dir, '.opencode'), `opencode project ${dir}`));
  }

  if (flags.gemini) {
    scopes.push({
      label: 'gemini user',
      agents: loadGeminiAgents(join(H.gemini, 'agents'), mapModel),
      skills: loadSkillsFromDir(join(H.gemini, 'skills'), 'gemini', undefined, 'frontmatter'),
      commands: loadGeminiCommands(join(H.gemini, 'commands')),
    });
    if (cwd) {
      const root = chain[0] ?? cwd;
      scopes.push({
        label: `gemini project ${root}`,
        agents: loadGeminiAgents(join(root, '.gemini', 'agents'), mapModel),
        skills: loadSkillsFromDir(join(root, '.gemini', 'skills'), 'gemini', undefined, 'frontmatter'),
        commands: loadGeminiCommands(join(root, '.gemini', 'commands')),
      });
    }
  }
  return scopes;
}

// ---------------------------------------------------------------------------
// MCP converters (import from and export to each CLI)
// ---------------------------------------------------------------------------

/** `$VAR`, `${VAR}`, `{env:VAR}` in a foreign config string become Conclave's `${env:VAR}`. */
function toConclaveVars(s: string): string {
  return s
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => `\${env:${n}}`)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => `\${env:${n}}`)
    .replace(/(^|[^{$])\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, pre, n) => `${pre}\${env:${n}}`);
}

function mapRecord(rec: unknown, f: (s: string) => string): Record<string, string> | undefined {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) out[k] = f(String(v));
  return Object.keys(out).length ? out : undefined;
}

function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Claude `.mcp.json` / `~/.claude.json` `mcpServers`. Same shape; `${VAR}` becomes `${env:VAR}`. */
export function mcpFromClaude(json: Record<string, unknown>): Record<string, McpServerConfig> {
  const map = (json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : json) as Record<string, Record<string, unknown>>;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(map)) {
    if (!c || typeof c !== 'object') continue;
    const type = str(c.type);
    out[name] = clean({
      type: type === 'sse' || type === 'http' || type === 'stdio' ? type : undefined,
      command: str(c.command),
      args: Array.isArray(c.args) ? c.args.map((a) => toConclaveVars(String(a))) : undefined,
      env: mapRecord(c.env, toConclaveVars),
      url: c.url ? toConclaveVars(String(c.url)) : undefined,
      headers: mapRecord(c.headers, toConclaveVars),
    }) as McpServerConfig;
  }
  return out;
}

/** Codex `[mcp_servers.<name>]` from config.toml text. */
export function mcpFromCodexToml(text: string): Record<string, McpServerConfig> {
  const data = Bun.TOML.parse(text) as Record<string, unknown>;
  const servers = (data.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(servers)) {
    const headers: Record<string, string> = { ...(mapRecord(c.http_headers, String) ?? {}) };
    for (const [k, v] of Object.entries((c.env_http_headers ?? {}) as Record<string, unknown>)) headers[k] = `\${env:${v}}`;
    if (c.bearer_token_env_var) headers.Authorization = `Bearer \${env:${c.bearer_token_env_var}}`;
    const env: Record<string, string> = { ...(mapRecord(c.env, String) ?? {}) };
    for (const v of Array.isArray(c.env_vars) ? c.env_vars : []) env[String(v)] = `\${env:${v}}`;
    out[name] = clean({
      command: str(c.command),
      args: Array.isArray(c.args) ? c.args.map(String) : undefined,
      env: Object.keys(env).length ? env : undefined,
      url: str(c.url),
      type: c.url ? ('http' as const) : undefined,
      headers: Object.keys(headers).length ? headers : undefined,
      enabled: c.enabled === false ? false : undefined,
      tools: Array.isArray(c.enabled_tools) ? c.enabled_tools.map(String) : undefined,
    }) as McpServerConfig;
  }
  return out;
}

/** OpenCode `mcp` block: `{type: local, command: [..], environment}` or `{type: remote, url, headers}`. */
export function mcpFromOpenCode(json: Record<string, unknown>): Record<string, McpServerConfig> {
  const map = (json.mcp && typeof json.mcp === 'object' ? json.mcp : json) as Record<string, Record<string, unknown>>;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(map)) {
    if (!c || typeof c !== 'object') continue;
    const cmd = Array.isArray(c.command) ? c.command.map(String) : typeof c.command === 'string' ? [c.command] : [];
    out[name] = clean({
      command: c.type === 'local' || cmd.length ? cmd[0] : undefined,
      args: cmd.length > 1 ? cmd.slice(1).map(toConclaveVars) : undefined,
      env: mapRecord(c.environment, toConclaveVars),
      url: c.url ? toConclaveVars(String(c.url)) : undefined,
      type: c.url ? ('http' as const) : undefined,
      headers: mapRecord(c.headers, toConclaveVars),
      enabled: c.enabled === false ? false : undefined,
    }) as McpServerConfig;
  }
  return out;
}

/** Gemini `mcpServers`: `{command, args, env}` or `{url, type}` / `{httpUrl}`. */
export function mcpFromGemini(json: Record<string, unknown>): Record<string, McpServerConfig> {
  const map = (json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : json) as Record<string, Record<string, unknown>>;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(map)) {
    if (!c || typeof c !== 'object') continue;
    const url = str(c.httpUrl) ?? str(c.url);
    out[name] = clean({
      command: str(c.command),
      args: Array.isArray(c.args) ? c.args.map((a) => toConclaveVars(String(a))) : undefined,
      env: mapRecord(c.env, toConclaveVars),
      url: url ? toConclaveVars(url) : undefined,
      type: url ? (c.type === 'sse' ? ('sse' as const) : ('http' as const)) : undefined,
      headers: mapRecord(c.headers, toConclaveVars),
      tools: Array.isArray(c.includeTools) ? c.includeTools.map(String) : undefined,
    }) as McpServerConfig;
  }
  return out;
}

/** `${env:VAR}` back to each CLI's spelling. Secrets (`${secret:..}`) cannot be exported and are left as-is. */
function envOut(s: string, style: 'claude' | 'opencode' | 'gemini'): string {
  return s.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => (style === 'opencode' ? `{env:${n}}` : `\${${n}}`));
}

/** Claude Code `.mcp.json` entry. */
export function mcpToClaude(cfg: McpServerConfig): Record<string, unknown> {
  if (cfg.command) return clean({ type: 'stdio', command: cfg.command, args: cfg.args, env: mapRecord(cfg.env, (v) => envOut(v, 'claude')) });
  return clean({ type: cfg.type === 'sse' ? 'sse' : 'http', url: cfg.url && envOut(cfg.url, 'claude'), headers: mapRecord(cfg.headers, (v) => envOut(v, 'claude')) });
}

/** OpenCode `mcp.<name>` entry. */
export function mcpToOpenCode(cfg: McpServerConfig): Record<string, unknown> {
  if (cfg.command) return clean({ type: 'local', command: [cfg.command, ...(cfg.args ?? [])], environment: mapRecord(cfg.env, (v) => envOut(v, 'opencode')), enabled: cfg.enabled === false ? false : true });
  return clean({ type: 'remote', url: cfg.url && envOut(cfg.url, 'opencode'), headers: mapRecord(cfg.headers, (v) => envOut(v, 'opencode')), enabled: cfg.enabled === false ? false : true });
}

/** Gemini `mcpServers.<name>` entry. */
export function mcpToGemini(cfg: McpServerConfig): Record<string, unknown> {
  if (cfg.command) return clean({ command: cfg.command, args: cfg.args, env: mapRecord(cfg.env, (v) => envOut(v, 'gemini')), includeTools: cfg.tools });
  return clean({ url: cfg.url && envOut(cfg.url, 'gemini'), type: cfg.type === 'sse' ? 'sse' : 'http', headers: mapRecord(cfg.headers, (v) => envOut(v, 'gemini')), includeTools: cfg.tools });
}

/**
 * Codex `[mcp_servers.<name>]` TOML block. Env values that point at a variable
 * become `env_vars` pass-through; an `Authorization: Bearer ${env:X}` header
 * becomes `bearer_token_env_var`.
 */
export function mcpToCodexToml(name: string, cfg: McpServerConfig): string {
  const q = (s: string) => JSON.stringify(s);
  const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : q(name);
  const lines = [`[mcp_servers.${key}]`];
  if (cfg.command) {
    lines.push(`command = ${q(cfg.command)}`);
    if (cfg.args?.length) lines.push(`args = [${cfg.args.map(q).join(', ')}]`);
    const pass: string[] = [];
    const literal: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      const m = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
      if (m && m[1] === k) pass.push(k);
      else literal.push([k, v]);
    }
    if (pass.length) lines.push(`env_vars = [${pass.map(q).join(', ')}]`);
    if (cfg.enabled === false) lines.push('enabled = false');
    if (literal.length) {
      lines.push('', `[mcp_servers.${key}.env]`);
      for (const [k, v] of literal) lines.push(`${k} = ${q(v)}`);
    }
    return lines.join('\n') + '\n';
  }
  if (cfg.url) lines.push(`url = ${q(cfg.url)}`);
  const headers: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    const m = /^Bearer \$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
    if (k.toLowerCase() === 'authorization' && m) lines.push(`bearer_token_env_var = ${q(m[1])}`);
    else headers.push([k, v]);
  }
  if (cfg.enabled === false) lines.push('enabled = false');
  if (headers.length) lines.push(`http_headers = { ${headers.map(([k, v]) => `${q(k)} = ${q(v)}`).join(', ')} }`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Hook converters
// ---------------------------------------------------------------------------

const GEMINI_EVENTS: Record<string, HookEvent> = {
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  BeforeAgent: 'UserPromptSubmit',
  AfterAgent: 'Stop',
  PreCompress: 'PreCompact',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Notification: 'Notification',
};

const CONCLAVE_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'Notification',
  'PermissionRequest',
]);

export interface HookImport {
  hooks: HooksConfig;
  /** Events or handlers that have no Conclave equivalent and were left out. */
  skipped: string[];
  /** Behaviour differences the user should know about. */
  notes: string[];
}

/** Rewrite a Gemini tool-name matcher (regex or exact) to Conclave tool names. */
function geminiMatcher(m: string | undefined): string | undefined {
  if (!m || m === '*') return m;
  return m.replace(/[a-z_]+/g, (word) => GEMINI_TOOLS[word] ?? word);
}

/**
 * Import Gemini CLI hooks (settings.json `hooks`). Events and tool names are
 * renamed, timeouts go from milliseconds to seconds, and $GEMINI_PROJECT_DIR
 * becomes $CLAUDE_PROJECT_DIR. Unlike `gemini hooks migrate`, the unit change
 * is applied.
 */
export function hooksFromGemini(json: Record<string, unknown>): HookImport {
  const src = (json.hooks && typeof json.hooks === 'object' ? json.hooks : json) as Record<string, unknown>;
  const out: HooksConfig = {};
  const skipped: string[] = [];
  for (const [event, groups] of Object.entries(src)) {
    const target = GEMINI_EVENTS[event];
    if (!target) {
      skipped.push(event);
      continue;
    }
    const list: HookMatcher[] = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      const group = g as Record<string, unknown>;
      const hooks = (Array.isArray(group.hooks) ? group.hooks : [])
        .map((h) => h as Record<string, unknown>)
        .filter((h) => (h.type ?? 'command') === 'command' && typeof h.command === 'string')
        .map((h) =>
          clean({
            type: 'command' as const,
            command: String(h.command).replace(/\$\{?GEMINI_PROJECT_DIR\}?/g, '$CLAUDE_PROJECT_DIR').replace(/\$\{?GEMINI_CWD\}?/g, '$CLAUDE_PROJECT_DIR'),
            timeout: typeof h.timeout === 'number' ? Math.max(1, Math.ceil(h.timeout / 1000)) : undefined,
          }),
        );
      if (hooks.length) list.push(clean({ matcher: target === 'PreToolUse' || target === 'PostToolUse' ? geminiMatcher(str(group.matcher)) : str(group.matcher), hooks }));
    }
    if (list.length) out[target] = [...(out[target] ?? []), ...list];
  }
  return {
    hooks: out,
    skipped,
    notes: [
      'Gemini blocks on any non-zero exit other than 1; Conclave and Claude Code block only on exit 2. Check scripts that exit 1 or 3.',
      'Gemini hook output fields llm_request, llm_response and toolConfig have no Conclave equivalent.',
    ],
  };
}

/** Import Codex hooks (hooks.json or the `hooks` table of config.toml). Same shape as Claude; Codex-only fields are dropped. */
export function hooksFromCodex(json: Record<string, unknown>): HookImport {
  const src = (json.hooks && typeof json.hooks === 'object' ? json.hooks : json) as Record<string, unknown>;
  const out: HooksConfig = {};
  const skipped: string[] = [];
  for (const [event, groups] of Object.entries(src)) {
    if (event === 'state') continue;
    if (!CONCLAVE_EVENTS.has(event as HookEvent)) {
      skipped.push(event);
      continue;
    }
    const list: HookMatcher[] = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      const group = g as Record<string, unknown>;
      const hooks = (Array.isArray(group.hooks) ? group.hooks : [])
        .map((h) => h as Record<string, unknown>)
        .filter((h) => h.type === 'command' && typeof h.command === 'string')
        .map((h) => clean({ type: 'command' as const, command: String(h.command), timeout: typeof h.timeout === 'number' ? h.timeout : undefined }));
      if (hooks.length) list.push(clean({ matcher: str(group.matcher), hooks }));
    }
    if (list.length) out[event as HookEvent] = list;
  }
  return {
    hooks: out,
    skipped,
    notes: ['Codex treats a hyphen in a matcher as a regex; Conclave matches hyphenated names exactly, like Claude Code.'],
  };
}

/** Read every Gemini or Codex hook source on disk for the import preview. */
export function readForeignHooks(kind: 'gemini' | 'codex', cwd?: string, h?: CompatHomes): HookImport {
  const H = homes(h);
  const merged: HookImport = { hooks: {}, skipped: [], notes: [] };
  const add = (res: HookImport) => {
    for (const [ev, list] of Object.entries(res.hooks)) {
      const k = ev as HookEvent;
      merged.hooks[k] = [...(merged.hooks[k] ?? []), ...(list ?? [])];
    }
    merged.skipped.push(...res.skipped);
    for (const n of res.notes) if (!merged.notes.includes(n)) merged.notes.push(n);
  };
  if (kind === 'gemini') {
    for (const f of [join(H.gemini, 'settings.json'), cwd ? join(cwd, '.gemini', 'settings.json') : '']) {
      const j = f ? readJsonLoose(f) : undefined;
      if (j?.hooks) add(hooksFromGemini(j));
    }
  } else {
    for (const base of [H.codex, cwd ? join(cwd, '.codex') : '']) {
      if (!base) continue;
      const j = readJsonLoose(join(base, 'hooks.json'));
      if (j) add(hooksFromCodex(j));
      const t = existsSync(join(base, 'config.toml')) ? readToml(join(base, 'config.toml')) : undefined;
      if (t?.hooks && typeof t.hooks === 'object') add(hooksFromCodex(t.hooks as Record<string, unknown>));
    }
  }
  return merged;
}
