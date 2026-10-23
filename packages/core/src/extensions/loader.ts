import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import type { SessionMode, PermissionMode } from '../types';
import type { HookCommand, HookEvent, HookMatcher, HooksConfig } from '../config/schema';
import type { AgentDef, CommandDef, ExtensionSource, SkillDef } from './types';
import { parseFrontmatter, textField, toList } from '../util/frontmatter';
import { refusalFallbackField } from '../session/refusal-entries';

/**
 * Loading of agents, skills and commands from markdown on disk. The formats
 * are Claude Code compatible, so a user's existing .claude files load as-is.
 *
 * These functions read the hub's own filesystem directly (the extension config
 * lives on the hub, like config.json). Session tools still go through a Machine.
 */

/** Map a frontmatter model value to a "provider/model" ref, resolving Claude aliases. */
export type ModelMapper = (raw: string | undefined) => string | undefined;

export function readMd(path: string): { data: Record<string, unknown>; body: string } | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  return parseMd(text);
}

/**
 * Parse frontmatter like Claude Code does: YAML first, and when that fails
 * (common with unquoted "description: Use when: ..." lines in real plugins),
 * fall back to one `key: value` per line so name and description still load.
 */
export function parseMd(text: string): { data: Record<string, unknown>; body: string } {
  const parsed = parseFrontmatter<Record<string, unknown>>(text);
  if (Object.keys(parsed.data).length) return parsed;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m || !m[1].trim()) return parsed;
  const data: Record<string, unknown> = {};
  let lastKey: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      data[lastKey] = unquote(kv[2].trim());
    } else if (lastKey && /^\s+\S/.test(line)) {
      // a list keeps growing: every "- item" line is kept, not only the first
      const prev = data[lastKey];
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item) data[lastKey] = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), unquote(item[1].trim())];
      else if (typeof prev === 'string') data[lastKey] = `${prev} ${line.trim()}`.trim();
    }
  }
  return { data, body: m[2] };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function bool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return undefined;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function positiveInt(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 1 ? Math.floor(n) : undefined;
}

const MODES = new Set<SessionMode>(['agent', 'chat', 'plan', 'jury', 'debate', 'loop']);
const PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'bypass']);
/** Claude Code permissionMode spellings that differ from Conclave's. */
const PERMISSION_ALIASES: Record<string, PermissionMode> = { bypassPermissions: 'bypass', manual: 'default' };
export const THINKING = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
/**
 * Claude `effort` and Codex `model_reasoning_effort` values mapped to Conclave
 * thinking levels. xhigh and max pass through: verifier stages ask for them,
 * and providers that stop at high cap them there (providers/common.ts).
 */
export const EFFORT_TO_THINKING: Record<string, AgentDef['thinking']> = { none: 'off', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const MEMORY = new Set(['global', 'agent', 'none']);

/** Claude Code model names and the tier each one asks for. */
const TIER_ALIASES: Record<string, 'fast' | 'smart' | 'deep'> = { haiku: 'fast', sonnet: 'smart', opus: 'deep', opusplan: 'deep', fast: 'fast', smart: 'smart', deep: 'deep' };

/**
 * Default alias map used when no provider-aware mapper is supplied. Claude
 * Code names become tier words (haiku fast, sonnet smart, opus and opusplan
 * deep), which each session resolves through models.tiers
 * (extensions/agent-model.ts), so an agent can ask for a stronger model than
 * the default. The two arguments are kept for callers; tiers no longer need them.
 */
export function defaultModelMapper(_defaultModel?: string, _smallModel?: string): ModelMapper {
  return (raw) => {
    const v = str(raw);
    if (!v) return undefined;
    const lower = v.toLowerCase();
    if (lower === 'inherit' || lower === 'default') return undefined;
    return TIER_ALIASES[lower] ?? v;
  };
}

/** Thinking from `thinking:` or Claude Code's `effort:`. */
export function thinkingField(data: Record<string, unknown>): AgentDef['thinking'] {
  const t = str(data.thinking)?.toLowerCase();
  if (t && THINKING.has(t)) return t as AgentDef['thinking'];
  const e = str(data.effort)?.toLowerCase();
  return e ? EFFORT_TO_THINKING[e] : undefined;
}

const HOOK_EVENT_NAMES = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification', 'PermissionRequest']);

/**
 * An agent's `hooks:` frontmatter, in Claude Code's settings shape: event
 * names to lists of { matcher?, hooks: [handlers] }. Unknown events and
 * groups without handlers are dropped.
 */
export function hooksField(raw: unknown): HooksConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!HOOK_EVENT_NAMES.has(event as HookEvent) || !Array.isArray(groups)) continue;
    const clean: HookMatcher[] = [];
    for (const g of groups as Array<{ matcher?: unknown; hooks?: unknown }>) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) continue;
      const handlers = g.hooks.filter((h): h is HookCommand => !!h && typeof h === 'object' && typeof (h as { type?: unknown }).type === 'string');
      if (!handlers.length) continue;
      clean.push({ ...(typeof g.matcher === 'string' && g.matcher ? { matcher: g.matcher } : {}), hooks: handlers });
    }
    if (clean.length) out[event as HookEvent] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The frontmatter fields every agent loader reads the same way: tier, effort, hooks, recipes, ultra, verifyCommand. */
export function agentExtras(data: Record<string, unknown>): Pick<AgentDef, 'thinking' | 'hooks' | 'recipes' | 'ultra' | 'verifyCommand' | 'optInTools' | 'refusalFallback' | 'platformCard'> {
  return {
    // the owner's refusal fallback list, replaced or turned off for this agent
    refusalFallback: refusalFallbackField(data.refusalFallback ?? data['refusal-fallback']),
    thinking: thinkingField(data),
    hooks: hooksField(data.hooks),
    recipes: toList(data.recipes),
    ultra: bool(data.ultra),
    verifyCommand: str(data.verifyCommand ?? data['verify-command']),
    // opt-in tools (the browser) on top of the default tools
    optInTools: toList(data.optInTools ?? data['opt-in-tools']),
    // platform awareness: false leaves the Conclave card out (platform/card.ts)
    platformCard: bool(data.platformCard ?? data['platform-card']),
  };
}

/** List files with the given extension under a directory, recursing into subfolders. */
function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFiles(full, ext));
    else if (st.isFile() && name.endsWith(ext)) out.push(full);
  }
  return out;
}

export function loadAgentsFromDir(dir: string, source: ExtensionSource, mapModel: ModelMapper, plugin?: string): AgentDef[] {
  const out: AgentDef[] = [];
  if (!existsSync(dir)) return out;
  for (const file of walkFiles(dir, '.md')) {
    const parsed = readMd(file);
    if (!parsed) continue;
    const { data, body } = parsed;
    const name = str(data.name) ?? basename(file, '.md');
    if (!name) continue;
    const mode = str(data.mode);
    const pmRaw = str(data.permissionMode ?? (data as Record<string, unknown>)['permission-mode']);
    const pm = pmRaw ? (PERMISSION_ALIASES[pmRaw] ?? pmRaw) : undefined;
    const def: AgentDef = {
      name,
      description: str(data.description) ?? '',
      prompt: body.trim(),
      model: mapModel(str(data.model)),
      tools: toList(data.tools),
      disallowedTools: toList(data.disallowedTools ?? (data as Record<string, unknown>)['disallowed-tools']),
      mode: mode && MODES.has(mode as SessionMode) ? (mode as SessionMode) : undefined,
      permissionMode: pm && PERMISSION_MODES.has(pm as PermissionMode) ? (pm as PermissionMode) : undefined,
      color: str(data.color),
      icon: str(data.icon),
      skills: toList(data.skills),
      mcpServers: toList(data.mcpServers ?? (data as Record<string, unknown>)['mcp-servers']),
      memory: (() => {
        const m = str(data.memory);
        return m && MEMORY.has(m) ? (m as AgentDef['memory']) : undefined;
      })(),
      subagent: bool(data.subagent),
      primary: bool(data.primary),
      untrusted: bool(data.untrusted),
      device: str(data.device),
      temperature: num(data.temperature),
      maxSteps: positiveInt(data.maxSteps ?? (data as Record<string, unknown>).maxTurns),
      ...agentExtras(data),
      source,
      path: file,
      plugin,
    };
    for (const k of ['hooks', 'recipes', 'ultra', 'verifyCommand', 'optInTools', 'refusalFallback', 'platformCard'] as const) if (def[k] === undefined) delete def[k];
    out.push(def);
  }
  return out;
}

/**
 * How a skill gets its name. Claude Code uses the folder name and ignores the
 * frontmatter `name` (verified: folder "writing-rules" with `name:
 * writing-hookify-rules` is listed as "writing-rules"). Codex, OpenCode and
 * Gemini use the frontmatter `name`.
 */
export type SkillNaming = 'folder' | 'frontmatter';

/** Load skills from a directory of `<name>/SKILL.md` folders. */
export function loadSkillsFromDir(dir: string, source: ExtensionSource, plugin?: string, naming: SkillNaming = 'folder'): SkillDef[] {
  const out: SkillDef[] = [];
  if (!existsSync(dir)) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = loadSkillFolder(full, source, plugin, naming);
    if (skill) out.push(skill);
  }
  return out;
}

/** Load a single skill from a folder that contains SKILL.md directly. */
export function loadSkillFolder(folder: string, source: ExtensionSource, plugin?: string, naming: SkillNaming = 'folder'): SkillDef | undefined {
  const file = join(folder, 'SKILL.md');
  const parsed = readMd(file);
  if (!parsed) return undefined;
  const { data } = parsed;
  const name = naming === 'folder' ? basename(folder) : (str(data.name) ?? basename(folder));
  if (!name) return undefined;
  return {
    name,
    description: str(data.description) ?? '',
    dir: folder,
    path: file,
    allowedTools: toList(data['allowed-tools'] ?? data.allowedTools),
    source,
    plugin,
  };
}

/** Load slash commands. Nested folders give names like "git:commit". */
export function loadCommandsFromDir(dir: string, source: ExtensionSource, mapModel: ModelMapper, plugin?: string): CommandDef[] {
  const out: CommandDef[] = [];
  if (!existsSync(dir)) return out;
  for (const file of walkFiles(dir, '.md')) {
    const parsed = readMd(file);
    if (!parsed) continue;
    const { data, body } = parsed;
    const rel = relative(dir, file).replace(/\.md$/, '');
    const name = rel.split(sep).join(':');
    out.push({
      name,
      description: str(data.description),
      argumentHint: textField(data['argument-hint'] ?? data.argumentHint),
      allowedTools: toList(data['allowed-tools'] ?? data.allowedTools),
      model: mapModel(str(data.model)),
      agent: str(data.agent),
      body: body.trim(),
      source,
      path: file,
      plugin,
    });
  }
  return out;
}

/** A directory group to scan for the three component kinds. */
export interface ScanDirs {
  agents?: string;
  skills?: string;
  commands?: string;
  source: ExtensionSource;
  plugin?: string;
}

export interface LoadResult {
  agents: AgentDef[];
  skills: SkillDef[];
  commands: CommandDef[];
}

/**
 * Load from a list of scopes in precedence order (lowest first). Later scopes
 * with the same name win. Returns de-duplicated maps collapsed to arrays.
 */
export function mergeScopes(scopes: ScanDirs[], mapModel: ModelMapper): LoadResult {
  const agents = new Map<string, AgentDef>();
  const skills = new Map<string, SkillDef>();
  const commands = new Map<string, CommandDef>();
  for (const scope of scopes) {
    if (scope.agents) for (const a of loadAgentsFromDir(scope.agents, scope.source, mapModel, scope.plugin)) agents.set(a.name, a);
    if (scope.skills) for (const s of loadSkillsFromDir(scope.skills, scope.source, scope.plugin)) skills.set(s.name, s);
    if (scope.commands) for (const c of loadCommandsFromDir(scope.commands, scope.source, mapModel, scope.plugin)) commands.set(c.name, c);
  }
  return { agents: [...agents.values()], skills: [...skills.values()], commands: [...commands.values()] };
}
