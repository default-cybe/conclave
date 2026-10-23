import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Machine } from '../machine/types';
import type { McpServerConfig } from '../config/schema';
import type { AgentDef, SkillDef } from './types';
import { toFrontmatter } from '../util/frontmatter';
import { GEMINI_TOOLS, mcpToClaude, mcpToCodexToml, mcpToGemini, mcpToOpenCode } from './compat';
import { logger } from '../util/log';

const log = logger('cli-sync');

const MARKER = '.conclave-managed';

export type CliTarget = 'claude' | 'codex' | 'opencode' | 'gemini';

export interface SyncInput {
  skills: SkillDef[];
  agents: AgentDef[];
  /** Accepted for API stability; not written. Use mcpConnectPlan for copyable commands instead. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Limit to these CLIs. Default: Claude Code always, others when installed on the machine. */
  only?: CliTarget[];
  /** List the files that would be written, without writing anything. */
  dryRun?: boolean;
}

/**
 * Write Conclave user skills and agents into each CLI's native folders on
 * `machine`, so "install once, have it everywhere" works. Only targets a CLI
 * that is present. Never overwrites a file the user owns: a managed item either
 * lives in a folder marked with `.conclave-managed`, or is guarded by a sibling
 * marker, and anything without that marker is left untouched.
 *
 * Where each CLI reads from (docs/extensions/research-*.md):
 * - Claude Code: ~/.claude/skills/<name>/SKILL.md, ~/.claude/agents/<name>.md
 * - Codex, OpenCode, Gemini: skills from ~/.agents/skills/<name>/SKILL.md (one shared copy)
 * - Codex agents: ~/.codex/agents/<name>.toml (TOML role)
 * - OpenCode agents: ~/.config/opencode/agent/<name>.md (own schema; a Claude-style file stops OpenCode from starting)
 * - Gemini agents: ~/.gemini/agents/<name>.md (strict schema, Gemini tool names)
 */
export async function syncToClis(machine: Machine, input: SyncInput): Promise<string[]> {
  const written: string[] = [];
  const info = await machine.info();
  const home = info.home;
  const clis = info.clis ?? {};
  const want = (t: CliTarget) => (input.only ? input.only.includes(t) : t === 'claude' || t in clis);

  const dry = !!input.dryRun;
  // an agent's name comes from its frontmatter, which a repo from the catalog wrote: "../CLAUDE" must not leave the agents folder
  const plain = (kind: string, name: string) => {
    if (/^[\w-][\w.-]*$/.test(name)) return true;
    log.info(`${kind} ${name} not synced: its name is not a plain file name`);
    return false;
  };
  const skills = input.skills.filter((s) => s.source === 'user' && plain('skill', s.name));
  const agents = input.agents.filter((a) => a.source === 'user' && plain('agent', a.name));

  if (want('claude')) {
    for (const skill of skills) written.push(...(await syncSkill(machine, join(home, '.claude', 'skills', skill.name), skill, dry)));
    for (const agent of agents) written.push(...(await writeManaged(machine, join(home, '.claude', 'agents'), `${agent.name}.md`, claudeAgent(agent), dry)));
  }

  if (want('codex') || want('opencode') || want('gemini')) {
    for (const skill of skills) written.push(...(await syncSkill(machine, join(home, '.agents', 'skills', skill.name), skill, dry)));
  }

  if (want('codex')) {
    const dir = join(home, '.codex', 'agents');
    for (const agent of agents) {
      written.push(...(await writeManaged(machine, dir, `${agent.name}.toml`, codexAgentToml(agent), dry)));
      // Earlier versions wrote Claude-style .md here, which Codex never reads.
      await removeManaged(machine, dir, `${agent.name}.md`, dry);
    }
  }

  if (want('opencode')) {
    for (const agent of agents) written.push(...(await writeManaged(machine, join(home, '.config', 'opencode', 'agent'), `${agent.name}.md`, opencodeAgent(agent), dry)));
  }

  if (want('gemini')) {
    for (const agent of agents) {
      const md = geminiAgent(agent);
      if (!md) {
        log.info(`agent ${agent.name} not synced to Gemini: name must match ^[a-z0-9_-]+$`);
        continue;
      }
      written.push(...(await writeManaged(machine, join(home, '.gemini', 'agents'), `${agent.name}.md`, md, dry)));
    }
  }

  if (input.mcpServers && Object.keys(input.mcpServers).length) {
    log.debug('mcpServers sync is intentionally skipped to avoid clobbering CLI settings');
  }
  return written;
}

async function managedOrFree(machine: Machine, path: string, markerPath: string): Promise<boolean> {
  const st = await machine.stat(path).catch(() => null);
  if (!st) return true; // free to create
  const marker = await machine.stat(markerPath).catch(() => null);
  return !!marker; // only if we created it before
}

async function syncSkill(machine: Machine, destDir: string, skill: SkillDef, dryRun: boolean): Promise<string[]> {
  const markerPath = join(destDir, MARKER);
  if (!(await managedOrFree(machine, destDir, markerPath))) return [];
  const written: string[] = [];
  for (const srcFile of walk(skill.dir)) {
    const rel = relative(skill.dir, srcFile).split(sep).join('/');
    if (rel === MARKER) continue;
    const dest = join(destDir, rel);
    if (dryRun) {
      written.push(dest);
      continue;
    }
    try {
      await machine.writeFile(dest, readFileSync(srcFile));
      written.push(dest);
    } catch (err) {
      log.warn(`failed to write ${dest}: ${(err as Error).message}`);
    }
  }
  if (!dryRun) await machine.writeFile(markerPath, `managed by conclave\n`);
  written.push(markerPath);
  return written;
}

/** Write one file guarded by a sibling marker `.<file>.conclave-managed`. */
async function writeManaged(machine: Machine, dir: string, file: string, content: string, dryRun: boolean): Promise<string[]> {
  const dest = join(dir, file);
  const markerPath = join(dir, `.${file}${MARKER}`);
  if (!(await managedOrFree(machine, dest, markerPath))) return [];
  if (dryRun) return [dest, markerPath];
  try {
    await machine.writeFile(dest, content);
    await machine.writeFile(markerPath, `managed by conclave\n`);
    return [dest, markerPath];
  } catch (err) {
    log.warn(`failed to write ${dest}: ${(err as Error).message}`);
    return [];
  }
}

async function removeManaged(machine: Machine, dir: string, file: string, dryRun: boolean): Promise<void> {
  const markerPath = join(dir, `.${file}${MARKER}`);
  const marker = await machine.stat(markerPath).catch(() => null);
  if (!marker || dryRun) return;
  await machine.remove(join(dir, file)).catch(() => {});
  await machine.remove(markerPath).catch(() => {});
}

function walk(dir: string): string[] {
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
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-CLI agent writers
// ---------------------------------------------------------------------------

const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

/** "anthropic/claude-sonnet-5-5" -> "claude-sonnet-5-5" when the provider matches; otherwise undefined (inherit). */
function modelFor(ref: string | undefined, providers: string[]): string | undefined {
  if (!ref) return undefined;
  const i = ref.indexOf('/');
  if (i < 0) return undefined;
  return providers.includes(ref.slice(0, i)) ? ref.slice(i + 1) : undefined;
}

function claudeAgent(def: AgentDef): string {
  return toFrontmatter(
    {
      name: def.name,
      description: def.description,
      tools: def.tools?.join(', '),
      disallowedTools: def.disallowedTools?.join(', '),
      model: modelFor(def.model, ['anthropic']) ?? undefined,
      color: def.color,
    },
    def.prompt,
  );
}

/** Codex agent role TOML. Mirrors Codex's own Claude importer: body becomes developer_instructions. */
export function codexAgentToml(def: AgentDef): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [`name = ${q(def.name)}`, `description = ${q(def.description || def.name)}`];
  const model = modelFor(def.model, ['openai']);
  if (model) lines.push(`model = ${q(model)}`);
  if (def.thinking && def.thinking !== 'off') lines.push(`model_reasoning_effort = ${q(def.thinking)}`);
  const noEdits = def.untrusted || (def.disallowedTools ?? []).some((t) => EDIT_TOOLS.includes(t)) || (def.tools && !def.tools.some((t) => EDIT_TOOLS.includes(t)));
  if (noEdits) lines.push(`sandbox_mode = "read-only"`);
  else if (def.permissionMode === 'acceptEdits') lines.push(`sandbox_mode = "workspace-write"`);
  // A TOML multi-line literal string cannot contain ''' so fall back to a basic string then.
  const body = def.prompt.trim();
  lines.push(body.includes("'''") ? `developer_instructions = ${q(body)}` : `developer_instructions = '''\n${body}\n'''`);
  return lines.join('\n') + '\n';
}

/** Conclave tool name -> OpenCode permission key. */
const OPENCODE_KEYS: Record<string, string> = {
  Bash: 'bash',
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Task: 'task',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  TodoWrite: 'todowrite',
  Skill: 'skill',
  AskUserQuestion: 'question',
};

/**
 * OpenCode agent markdown. OpenCode validates agent files and refuses to start
 * on `tools` as a list or string, or a named color, so the tool list becomes a
 * `permission` map and only hex colors are kept.
 */
export function opencodeAgent(def: AgentDef): string {
  const permission: Record<string, string> = {};
  if (def.tools) {
    permission['*'] = 'deny';
    for (const t of def.tools) if (OPENCODE_KEYS[t]) permission[OPENCODE_KEYS[t]] = 'allow';
  }
  for (const t of def.disallowedTools ?? []) if (OPENCODE_KEYS[t]) permission[OPENCODE_KEYS[t]] = 'deny';
  if (def.untrusted) {
    permission.bash = 'deny';
    permission.edit = 'deny';
  }
  const mode = def.primary && def.subagent ? 'all' : def.primary ? 'primary' : 'subagent';
  const model = def.model && /^(anthropic|openai|google|openrouter)\//.test(def.model) ? def.model : undefined;
  return toFrontmatter(
    {
      description: def.description || def.name,
      mode,
      model,
      temperature: def.temperature,
      color: def.color && /^#[0-9a-f]{6}$/i.test(def.color) ? def.color : undefined,
      permission: Object.keys(permission).length ? permission : undefined,
    },
    def.prompt,
  );
}

/** Gemini CLI subagent markdown. Strict schema: only known keys, Gemini tool names, name ^[a-z0-9_-]+$. */
export function geminiAgent(def: AgentDef): string | undefined {
  if (!/^[a-z0-9_-]+$/.test(def.name)) return undefined;
  const reverse: Record<string, string> = {};
  for (const [g, c] of Object.entries(GEMINI_TOOLS)) if (!reverse[c]) reverse[c] = g;
  reverse.Grep = 'grep_search';
  reverse.Read = 'read_file';
  let tools = def.tools ? [...new Set(def.tools.map((t) => reverse[t]).filter((t): t is string => !!t))] : undefined;
  if (def.disallowedTools?.length && !tools) {
    const deny = new Set(def.disallowedTools.map((t) => reverse[t]).filter(Boolean));
    tools = [...new Set(Object.values(reverse))].filter((t) => !deny.has(t));
  }
  return toFrontmatter(
    {
      name: def.name,
      description: def.description || def.name,
      kind: 'local',
      tools,
      model: modelFor(def.model, ['google']),
      temperature: def.temperature,
    },
    def.prompt,
  );
}

// ---------------------------------------------------------------------------
// Connect an MCP server (e.g. memory) to other CLIs
// ---------------------------------------------------------------------------

export interface McpConnectStep {
  cli: CliTarget;
  /** Shell command that registers the server at user scope, when the CLI has one. */
  command?: string;
  /** Config file and the snippet to merge into it, for manual setup. */
  file: string;
  snippet: string;
  note?: string;
}

const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Steps to add one MCP server to Claude Code, Codex, OpenCode and Gemini CLI.
 * Nothing is written: the UI shows the commands to copy, or runs them on a
 * device after the user confirms. Used for "connect my memory everywhere".
 */
export function mcpConnectPlan(name: string, cfg: McpServerConfig): McpConnectStep[] {
  const claude = mcpToClaude(cfg);
  const steps: McpConnectStep[] = [
    {
      cli: 'claude',
      command: `claude mcp add-json -s user ${sh(name)} ${sh(JSON.stringify(claude))}`,
      file: '~/.claude.json (mcpServers)',
      snippet: JSON.stringify({ mcpServers: { [name]: claude } }, null, 2),
    },
  ];

  const codexToml = mcpToCodexToml(name, cfg);
  let codexCmd: string | undefined;
  if (cfg.command) {
    const envs = Object.entries(cfg.env ?? {})
      .filter(([, v]) => !v.includes('${'))
      .map(([k, v]) => `--env ${sh(`${k}=${v}`)}`);
    codexCmd = ['codex mcp add', sh(name), ...envs, '--', sh(cfg.command), ...(cfg.args ?? []).map(sh)].join(' ');
  } else if (cfg.url) {
    const bearer = Object.values(cfg.headers ?? {})
      .map((v) => /^Bearer \$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v)?.[1])
      .find(Boolean);
    codexCmd = ['codex mcp add', sh(name), '--url', sh(cfg.url), ...(bearer ? ['--bearer-token-env-var', bearer] : [])].join(' ');
  }
  steps.push({ cli: 'codex', command: codexCmd, file: '~/.codex/config.toml', snippet: codexToml });

  steps.push({
    cli: 'opencode',
    file: '~/.config/opencode/opencode.json (mcp)',
    snippet: JSON.stringify({ mcp: { [name]: mcpToOpenCode(cfg) } }, null, 2),
    note: 'OpenCode exposes the tools as <server>_<tool>.',
  });

  const gem = mcpToGemini(cfg);
  let gemCmd: string;
  if (cfg.command) {
    const envs = Object.entries(cfg.env ?? {}).map(([k, v]) => `-e ${sh(`${k}=${v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1')}`)}`);
    gemCmd = ['gemini mcp add -s user', ...envs, sh(name), sh(cfg.command), ...(cfg.args ?? []).map(sh)].join(' ');
  } else {
    const headers = Object.entries((gem.headers as Record<string, string>) ?? {}).map(([k, v]) => `-H ${sh(`${k}: ${v}`)}`);
    gemCmd = ['gemini mcp add -s user -t', cfg.type === 'sse' ? 'sse' : 'http', ...headers, sh(name), sh(cfg.url ?? '')].join(' ');
  }
  steps.push({
    cli: 'gemini',
    command: gemCmd,
    file: '~/.gemini/settings.json (mcpServers)',
    snippet: JSON.stringify({ mcpServers: { [name]: gem } }, null, 2),
    note: 'Gemini turns off every MCP server in a folder it does not trust. Trust the folder or set GEMINI_CLI_TRUST_WORKSPACE=true.',
  });
  return steps;
}
