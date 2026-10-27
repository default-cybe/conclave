import type { HookCommand, HookEvent, HooksConfig, McpServerConfig, RefusalFallbackEntry } from '../config/schema';
import type { PermissionMode, SessionMode, JuryConfig } from '../types';

/**
 * Where an agent, skill or command came from. 'claude', 'codex', 'opencode'
 * and 'gemini' are other CLIs' folders read by the compat loaders. 'agents' is
 * the shared ~/.agents and .agents folder that Codex, OpenCode and Gemini read.
 */
export type ExtensionSource = 'builtin' | 'user' | 'project' | 'plugin' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'agents';

/**
 * An agent profile. Stored as markdown with YAML frontmatter, compatible with
 * Claude Code subagent files (.claude/agents/*.md):
 *
 * ---
 * name: reviewer
 * description: Reviews diffs for bugs. Use after edits.
 * tools: Read, Grep, Glob, Bash
 * model: openai/gpt-5.5
 * ---
 * You are a meticulous reviewer...
 */
export interface AgentDef {
  name: string;
  description: string;
  /** System prompt body. */
  prompt: string;
  /**
   * "provider/model", or a tier word: fast, smart or deep, resolved per
   * session through models.tiers (extensions/agent-model.ts). Claude Code
   * aliases map to tiers: haiku is fast, sonnet is smart, opus and opusplan
   * are deep. inherit means the session's model.
   */
  model?: string;
  /** Allowlist of tool names; undefined means all default tools. */
  tools?: string[];
  disallowedTools?: string[];
  /**
   * Opt-in tools (the browser) this agent gets on top of its default tools,
   * for an agent without a tools list (frontmatter optInTools). A tools list
   * names them itself.
   */
  optInTools?: string[];
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  color?: string;
  /** Emoji or lucide icon name for UIs. */
  icon?: string;
  /** Skills preloaded into the system prompt. */
  skills?: string[];
  /** MCP servers this agent may use; undefined means all enabled. */
  mcpServers?: string[];
  /** Memory namespace. Defaults to global + project. */
  memory?: 'global' | 'agent' | 'none';
  /** Can be picked as a subagent by the Task tool. */
  subagent?: boolean;
  /** Show in the main agent picker. */
  primary?: boolean;
  /** Treat this agent's inputs as untrusted (email, web): no shell, no file writes. */
  untrusted?: boolean;
  /** Default device for sessions with this agent. */
  device?: string;
  temperature?: number;
  /** Thinking effort. Frontmatter `thinking`, or Claude Code's `effort` (low, medium, high, xhigh, max), which is kept as written. */
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Model calls per user turn for sessions and subagents running this agent (frontmatter maxSteps or maxTurns). */
  maxSteps?: number;
  /**
   * Hooks for sessions running this agent (Claude Code's subagent `hooks:`
   * frontmatter). For a subagent, its Stop hooks run on SubagentStop. Hooks
   * from a project folder run only once the folder is trusted.
   */
  hooks?: HooksConfig;
  /**
   * Hook recipe ids (extensions/hook-recipes.ts) that apply to sessions
   * running this agent, as "id" or "id NAME=value ...". "verify-gate" turns on
   * the built-in check on the session's device (session/verify-gate.ts), and
   * "regression-gate" the run of a turn's changed tests on the code from
   * before the turn (session/regression-gate.ts), and "visual-check" a
   * reminder to look at screenshots after a UI edit (session/visual-check.ts).
   */
  recipes?: string[];
  /** New sessions with this agent start with Ultra on (docs/WORKFLOWS.md). */
  ultra?: boolean;
  /** The check the verify gate runs, instead of the project's or the detected one. */
  verifyCommand?: string;
  /**
   * Refusal fallback for sessions with this agent (session/refusal-fallback.ts):
   * false turns it off, a list replaces the owner's list (models.refusalFallback)
   * and turns it on. Frontmatter `refusalFallback:` takes "model" or
   * "model@account" strings, or `off`.
   */
  refusalFallback?: RefusalFallbackEntry[] | false;
  /**
   * Platform awareness (platform/card.ts): false leaves the Conclave card out
   * of this agent's system prompt. On unless set false, and only while the
   * config's agents.platformCard is on too.
   */
  platformCard?: boolean;
  jury?: Partial<JuryConfig>;
  source: ExtensionSource;
  path?: string;
  plugin?: string;
}

/** SKILL.md in a folder. Only name and description sit in context until the Skill tool loads the body. */
export interface SkillDef {
  name: string;
  description: string;
  dir: string;
  path: string;
  allowedTools?: string[];
  source: ExtensionSource;
  plugin?: string;
  /** Set for a skill an agent wrote (extensions/learned.ts): where it came from. */
  learned?: { sessionId?: string; project?: string; created?: string; updated?: string };
}

/**
 * How a command template reads its arguments.
 * - claude: $ARGUMENTS, $ARGUMENTS[N] and $N are zero-based ($0 is the first word). Matches Claude Code 2.1.
 * - numbered: $1..$9 are one-based, one word each (Codex custom prompts).
 * - opencode: one-based, the highest placeholder takes the rest; args are appended when there is no placeholder.
 * - gemini: {{args}} is the raw string; !{cmd} and @{path}; args are appended when there is no {{args}}.
 */
export type CommandArgStyle = 'claude' | 'numbered' | 'opencode' | 'gemini';

/** Slash command from a markdown file (Claude Code compatible). */
export interface CommandDef {
  name: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  agent?: string;
  /** Template body: supports $ARGUMENTS, $0..$9, !`cmd` and @file. */
  body: string;
  /** Argument syntax of the body. Undefined means 'claude'. */
  argStyle?: CommandArgStyle;
  /** Run as a subtask in a fresh subagent (OpenCode `subtask: true`). */
  subtask?: boolean;
  source: ExtensionSource;
  path?: string;
  plugin?: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string } | string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | HooksConfig;
  mcpServers?: string | Record<string, McpServerConfig>;
}

export interface InstalledPlugin {
  name: string;
  dir: string;
  manifest: PluginManifest;
  enabled: boolean;
  /** git url, marketplace ref, or local path. */
  source: string;
  installedAt: number;
  /** Commit the files came from, when installed from git. */
  sha?: string;
  version?: string;
  /** False when the plugin's hooks are switched off (its skills, agents and commands stay). */
  hooksEnabled?: boolean;
  /** Set when installing its npm dependencies failed: the command to run by hand. */
  depsCommand?: string;
}

/** Options for installs that come from Discover or a pinned source. */
export interface PluginInstallOptions {
  /** Recorded source (what an update reinstalls from). */
  source: string;
  sha?: string;
  /** Default true. false installs the plugin with its hooks off. */
  hooks?: boolean;
  /** Default true. */
  enabled?: boolean;
  /** Manifest override (strict:false marketplace entries). */
  manifest?: PluginManifest;
  /** Name to install under; default the manifest name or the folder name. */
  name?: string;
  /** The clone the folder came from: symlinks resolving inside it are copied as files, others dropped. Default the folder itself. */
  copyRoot?: string;
}

export interface MarketplaceEntry {
  name: string;
  description?: string;
  source: string | { source: string; repo?: string; url?: string; path?: string };
  version?: string;
  category?: string;
  marketplace: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** JSON written to a command hook's stdin (Claude Code compatible field names). */
export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: HookEvent;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  source?: string;
  reason?: string;
  trigger?: string;
  custom_instructions?: string;
  message?: string;
  agent_type?: string;
  /** Set inside a subagent (with agent_type), and on SubagentStart / SubagentStop. */
  agent_id?: string;
  /** Stop / SubagentStop: the final assistant text of the turn. */
  last_assistant_message?: string;
  agent_transcript_path?: string;
  /** PostToolUse: how long the tool ran. */
  duration_ms?: number;
  /** PostToolUseFailure. */
  error?: string;
  is_interrupt?: boolean;
  /** Notification. */
  notification_type?: string;
  title?: string;
  /** SessionStart: the model in use. */
  model?: string;
  /** Conclave extras. */
  conclave?: { model: string; agent: string; device: string; /** PostToolUse: the result text the model sees. */ output_text?: string };
}

/** Merged outcome of all hooks for one event. */
export interface HookOutcome {
  /** Block the action (exit 2 or decision "block"/"deny"). */
  blocked: boolean;
  reason?: string;
  /** PreToolUse permission override. */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  /** PreToolUse input rewrite. */
  updatedInput?: Record<string, unknown>;
  /** PostToolUse: replace the tool result the model sees (Claude `updatedToolOutput` / `updatedMCPToolOutput`). */
  updatedToolOutput?: unknown;
  /** Text added to the model context (UserPromptSubmit, SessionStart, PostToolUse). */
  additionalContext: string[];
  /** Shown to the user. */
  systemMessages: string[];
  /** continue: false stops the whole turn. */
  stop?: { reason?: string };
  /** One entry per handler that ran, for test runs and the "last results" view. */
  trace?: HookTrace[];
}

/** What one hook handler did. */
export interface HookTrace {
  event: HookEvent;
  type: 'command' | 'prompt' | 'function';
  /** Command line, prompt text, or "(in-process)". */
  label: string;
  plugin?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  timedOut?: boolean;
  /** Short outcome: allow, deny, ask, block, rewrite, replace, context, stop, error, timeout, noop. */
  result: string;
  /** Chars this handler added to the model's context, after any budget cut. */
  contextChars?: number;
  /** Extra words: a rewrite conflict, a budget cut, a fail-closed crash. */
  note?: string;
  /** Hook recipe the handler came from. */
  recipe?: string;
}

/**
 * A hook handler as loaded at run time. Adds Claude Code fields the schema
 * does not model, plus plugin data the runner needs for the environment.
 */
export interface RuntimeHookCommand extends HookCommand {
  /** Permission-rule filter, e.g. "Bash(git *)". The hook runs only when the tool call matches. */
  if?: string;
  /** Exec form: run `command` with these args and no shell. */
  args?: string[];
  /** 'bash' or 'sh'. PowerShell is not supported and falls back to the default shell. */
  shell?: string;
  /** Claude `async`: fire and forget. Conclave runs it but does not wait for the result. */
  async?: boolean;
  /** Plugin that contributed this hook. */
  plugin?: string;
  /** Plugin folder, exported as CLAUDE_PLUGIN_ROOT and PLUGIN_ROOT. */
  pluginRoot?: string;
  /** Persistent plugin data folder, exported as CLAUDE_PLUGIN_DATA (and PLUGIN_DATA for Codex plugins). */
  pluginData?: string;
  /** Let a plugin hook share the owner's ~/.claude config dir instead of its own (plugins state flag). */
  shareClaudeConfig?: boolean;
  /** Hook recipe this handler was added from (Conclave field, stripped when exported to other CLIs). */
  recipe?: string;
  /** "block": a crash, a bad exit or a timeout blocks like exit 2, so security hooks fail closed. */
  onFailure?: 'block' | 'ignore';
  /**
   * The handler reads the session's folder from its JSON input, not from its
   * working directory (a recipe that runs on the hub). When that folder is not
   * on the hub (a session on another device), it starts in the hub's home
   * instead of failing to start.
   */
  anyCwd?: boolean;
  /** Run once per session (Claude Code `once`). */
  once?: boolean;
  /** Shown in the session's live strip while the hook runs. */
  statusMessage?: string;
  /** Keep stdout out of the run log (Claude Code hides it from the transcript). */
  suppressOutput?: boolean;
  /** mcp_tool: the MCP server and tool to call, and its input. String values may use ${path.in.input}. */
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  /** mcp_tool: allow a tool that is not marked read only. */
  allowWrite?: boolean;
  /** Most chars of context this handler may add (Codex additionalContextLimit). */
  additionalContextLimit?: number;
}

/** In-process hooks registered by built-ins or JS plugins. */
export type HookFn = (input: HookInput) => Promise<Partial<HookOutcome> | void> | Partial<HookOutcome> | void;

export interface HookRunner {
  run(event: HookEvent, input: HookInput, opts: { matcherValue?: string; hooks: HooksConfig; signal?: AbortSignal }): Promise<HookOutcome>;
  register(event: HookEvent, fn: HookFn, matcher?: string): () => void;
}

// ---------------------------------------------------------------------------
// Registry facade the engine uses
// ---------------------------------------------------------------------------

export interface ExtensionRegistry {
  /** Reload everything from disk (user, project, plugins, claude compat). */
  reload(cwd?: string): Promise<void>;
  agents(cwd?: string): AgentDef[];
  agent(name: string, cwd?: string): AgentDef | undefined;
  saveAgent(def: AgentDef, scope: 'user' | 'project', cwd?: string): Promise<AgentDef>;
  deleteAgent(name: string): Promise<boolean>;
  skills(cwd?: string): SkillDef[];
  skill(name: string, cwd?: string): SkillDef | undefined;
  commands(cwd?: string): CommandDef[];
  command(name: string, cwd?: string): CommandDef | undefined;
  /** Hooks contributed by plugins (merged with config hooks by the engine). */
  pluginHooks(): HooksConfig;
  /** MCP servers contributed by plugins. */
  pluginMcpServers(): Record<string, McpServerConfig>;
  plugins(): InstalledPlugin[];
  installPlugin(source: string): Promise<InstalledPlugin>;
  removePlugin(name: string): Promise<boolean>;
  setPluginEnabled(name: string, enabled: boolean): Promise<void>;
  marketplaces(): Promise<MarketplaceEntry[]>;
  addMarketplace(source: string): Promise<void>;
  /** Install a staged, previewed plugin folder at a known commit (Discover). Optional so test fakes need not implement it. */
  installPluginFrom?(dir: string, opts: PluginInstallOptions): Promise<InstalledPlugin>;
  /** Turn one plugin's hooks on or off. */
  setPluginHooks?(name: string, on: boolean): Promise<void>;
  /** Marketplaces added so far. */
  marketplaceSources?(): Array<{ name: string; source: string; dir: string }>;
  /** Forget a marketplace and delete its clone (Discover, when the last plugin from it is removed). */
  removeMarketplace?(name: string): Promise<boolean>;
  /** Every component found, including shadowed copies. Optional so test fakes need not implement it. */
  inventory?(cwd?: string): Array<{ kind: 'agent' | 'skill' | 'command'; name: string; source: ExtensionSource; scope: string; active: boolean; shadowedBy?: string; path?: string; plugin?: string; description?: string; learned?: boolean }>;
}
