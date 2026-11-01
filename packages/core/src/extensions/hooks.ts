import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { HookEvent, HooksConfig } from '../config/schema';
import type { HookFn, HookInput, HookOutcome, HookRunner, HookTrace, RuntimeHookCommand } from './types';
import { globToRegExp, parseRule, splitBashCommand } from '../session/permissions';
import { logger } from '../util/log';
import { isHubSecretEnv } from '../machine/local';
import { HOOK_RECIPES } from './hook-recipes';

const log = logger('hooks');

/** Events where plain stdout from a command hook is added to the model context (verified against Claude Code 2.1.301). */
const STDOUT_IS_CONTEXT = new Set<HookEvent>(['UserPromptSubmit', 'SessionStart']);

/** Default timeout for one command or prompt hook. Claude Code and Codex both use 600 s. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** SessionEnd hooks must not hold up shutdown. Claude Code uses 1.5 s, Codex 1 s. */
const SESSION_END_TIMEOUT_MS = 1_500;
/** How many handler runs recent() keeps. */
const RECENT_CAP = 200;
/** Cap on stdout/stderr kept in a trace. */
const TRACE_CAP = 4_000;

/**
 * Context budgets (ECOSYSTEM.md 4.3 item 14). Mode plugins inject thousands of
 * chars at session start and into every subagent; a hook that prints a whole
 * file on every prompt costs that on every turn. Over the budget, the text is
 * cut and a note says how much.
 */
export const CONTEXT_BUDGET = {
  /** Merged context of all SessionStart or SubagentStart handlers. */
  start: 12_000,
  /** Each UserPromptSubmit handler. */
  prompt: 2_000,
} as const;

/** Most Stop or SubagentStop blocks that keep one turn going. The next one is ignored. */
export const STOP_BLOCK_CAP = 3;

export interface HooksOptions {
  /** Runs a prompt hook. Injected so the engine wires in any model. */
  complete?: (opts: { prompt: string; model?: string; signal?: AbortSignal }) => Promise<string>;
  /** Extra environment for command hooks. */
  env?: Record<string, string>;
  /** Spawner, overridable in tests. Defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn;
  /** Calls an MCP tool for mcp_tool handlers. The text is what the model would see. */
  callTool?: (server: string, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  /** Whether an MCP tool is marked read only. undefined: the server or tool is unknown. */
  toolReadOnly?: (server: string, tool: string) => Promise<boolean | undefined>;
  /** A handler with statusMessage started (done false) or finished (done true). */
  onStatus?: (input: HookInput, text: string, done: boolean) => void;
  /**
   * A folder the runner may use for a `node` shim when node is not on PATH, so
   * node plugin hooks (ponytail, caveman) run on a Bun-only host. Bun runs as
   * node when started through a link named node.
   */
  shimDir?: string;
}

interface Registered {
  event: HookEvent;
  matcher?: string;
  fn: HookFn;
  label?: string;
}

function emptyOutcome(): HookOutcome {
  return { blocked: false, additionalContext: [], systemMessages: [] };
}

/**
 * Other names a tool answers to in hook matchers and `if` rules, so matchers
 * written for Claude Code fire on Conclave's tools. Claude renamed Task to
 * Agent; Claude has no MultiEdit, and its Edit rules cover every file edit.
 */
const TOOL_ALIASES: Record<string, string[]> = {
  Task: ['Agent'],
  Agent: ['Task'],
  MultiEdit: ['Edit'],
};

function namesFor(value: string): string[] {
  return [value, ...(TOOL_ALIASES[value] ?? [])];
}

/**
 * Decide whether a matcher string matches the event's value. Claude Code rules:
 * "*" or empty matches all; names made of letters, digits, _, -, spaces, | and
 * commas are an exact list (so "code-reviewer" is exact); anything else is an
 * unanchored JavaScript regex. When the event carries no matchable value (e.g.
 * UserPromptSubmit), every hook fires.
 */
export function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
  if (!matcher || matcher === '*') return true;
  if (value === undefined) return true;
  const values = namesFor(value);
  if (/^[\w\-\s,|]+$/.test(matcher)) {
    const parts = matcher.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    return values.some((v) => parts.includes(v));
  }
  try {
    const re = new RegExp(matcher);
    return values.some((v) => re.test(v));
  } catch {
    return values.includes(matcher);
  }
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Wildcard match for Bash `if` rules: `*` matches anything, `prefix:*` is a word prefix. */
function bashPatternMatches(pattern: string, command: string): boolean {
  const c = command.trim();
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim();
    return c === prefix || c.startsWith(prefix + ' ');
  }
  if (!pattern.includes('*')) return c === pattern;
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
  return re.test(c);
}

/**
 * Tool part of an `if` rule against a tool name: exact, aliases, Edit for
 * every edit tool, "mcp__server" for all of that server's tools, and *
 * wildcards ("mcp__server__*", "mcp__*").
 */
export function ruleToolMatches(ruleTool: string, tool: string): boolean {
  const names = namesFor(tool);
  if (ruleTool === '*' || names.includes(ruleTool)) return true;
  if (ruleTool === 'Edit' && EDIT_TOOLS.has(tool)) return true;
  if (ruleTool.includes('*')) {
    const re = new RegExp('^' + ruleTool.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return names.some((n) => re.test(n));
  }
  return ruleTool.startsWith('mcp__') && tool.startsWith(ruleTool.replace(/__$/, '') + '__');
}

/**
 * Claude Code's `if` field: a permission-rule filter checked against the tool
 * call, e.g. "Bash(git*commit*)" or "Edit(src/**)". Events without a tool
 * ignore it. Returns true when the hook should run.
 */
export function ifMatches(rule: string | undefined, input: HookInput): boolean {
  if (!rule || !rule.trim()) return true;
  const tool = input.tool_name;
  if (!tool) return true;
  const parsed = parseRule(rule);
  if (!ruleToolMatches(parsed.tool, tool)) return false;
  if (parsed.content === undefined) return true;
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  if (typeof ti.command === 'string') {
    const cmd = ti.command;
    return bashPatternMatches(parsed.content, cmd) || splitBashCommand(cmd).some((part) => bashPatternMatches(parsed.content as string, part));
  }
  const path = [ti.file_path, ti.notebook_path, ti.path].find((v): v is string => typeof v === 'string');
  if (path) {
    let pat = parsed.content;
    if (pat.startsWith('./')) pat = pat.slice(2);
    const abs = isAbsolute(path) ? path : resolve(input.cwd, path);
    if (pat.startsWith('/')) return globToRegExp(pat).test(abs);
    const rel = relative(input.cwd, abs);
    return !rel.startsWith('..') && globToRegExp(pat).test(rel);
  }
  if (typeof ti.url === 'string' && parsed.content.startsWith('domain:')) {
    try {
      const host = new URL(ti.url).hostname;
      const d = parsed.content.slice(7);
      return host === d || host.endsWith('.' + d);
    } catch {
      return false;
    }
  }
  return true;
}

function isJsonObject(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A prompt hook's reply: the JSON object in it, also when the model wrapped it in a code fence or a sentence. */
function jsonInReply(s: string): Record<string, unknown> | undefined {
  const direct = isJsonObject(s);
  if (direct) return direct;
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(s);
  if (fenced) return isJsonObject(fenced[1]);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  return first >= 0 && last > first ? isJsonObject(s.slice(first, last + 1)) : undefined;
}

function mapPermission(v: unknown): HookOutcome['permissionDecision'] {
  const s = String(v);
  if (s === 'allow' || s === 'approve') return 'allow';
  if (s === 'deny' || s === 'block') return 'deny';
  if (s === 'ask' || s === 'ask_user') return 'ask';
  return undefined;
}

function pushContext(out: HookOutcome, v: unknown): void {
  if (typeof v === 'string' && v.trim()) out.additionalContext.push(v);
  else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.additionalContext.push(x);
}

/**
 * Interpret a JSON object printed by a command or prompt hook. Reads the Claude
 * Code / Codex contract, plus Gemini CLI's top-level decision values and its
 * `hookSpecificOutput.tool_input` (merged into the original tool input).
 */
export function applyJsonOutput(json: Record<string, unknown>, event: HookEvent, out: HookOutcome, input?: HookInput): void {
  if (json.continue === false) out.stop = { reason: typeof json.stopReason === 'string' ? json.stopReason : undefined };
  const systemMessage = typeof json.systemMessage === 'string' && json.systemMessage.trim() ? json.systemMessage : undefined;
  if (systemMessage) out.systemMessages.push(systemMessage);

  const reason = typeof json.reason === 'string' ? json.reason : undefined;
  if (json.decision === 'block' || json.decision === 'deny') {
    out.blocked = true;
    if (json.decision === 'deny') out.permissionDecision = 'deny';
    if (reason) out.reason = reason;
  } else if (json.decision === 'approve' || json.decision === 'allow') {
    out.permissionDecision = 'allow';
    if (reason && !out.reason) out.reason = reason;
  } else if (json.decision === 'ask') {
    out.permissionDecision = 'ask';
    if (reason && !out.reason) out.reason = reason;
  }

  // Top-level additionalContext / additional_context (SDK and other hosts).
  pushContext(out, json.additionalContext);
  pushContext(out, json.additional_context);

  const hso = json.hookSpecificOutput;
  if (hso && typeof hso === 'object' && !Array.isArray(hso)) {
    const h = hso as Record<string, unknown>;
    if (h.permissionDecision !== undefined) {
      const d = mapPermission(h.permissionDecision);
      if (d) out.permissionDecision = d;
      if (d === 'deny') out.blocked = true;
    }
    if (typeof h.permissionDecisionReason === 'string' && h.permissionDecisionReason.trim()) out.reason = h.permissionDecisionReason;
    if (h.updatedInput && typeof h.updatedInput === 'object') out.updatedInput = h.updatedInput as Record<string, unknown>;
    if (h.tool_input && typeof h.tool_input === 'object') {
      out.updatedInput = { ...((input?.tool_input as Record<string, unknown>) ?? {}), ...(h.tool_input as Record<string, unknown>) };
    }
    if (h.updatedToolOutput !== undefined) out.updatedToolOutput = h.updatedToolOutput;
    if (h.updatedMCPToolOutput !== undefined) out.updatedToolOutput = h.updatedMCPToolOutput;
    pushContext(out, h.additionalContext);

    // PermissionRequest nests its decision under hookSpecificOutput.
    applyBehavior(h.decision, out);
  }

  // PermissionRequest decision object at the top level (older shape).
  applyBehavior(json.decision, out);

  // A block or deny with no reason: the systemMessage is the best reason there is (hookify sets only that).
  if ((out.blocked || out.permissionDecision === 'deny') && !out.reason && systemMessage) out.reason = systemMessage;

  void event;
}

/**
 * Claude Code's prompt hook answer: {"ok": true} lets the action go on;
 * {"ok": false, "reason": "..."} blocks it with the reason. Returns false when
 * the object is not in that shape.
 */
export function applyOkAnswer(json: Record<string, unknown>, out: HookOutcome): boolean {
  if (typeof json.ok !== 'boolean') return false;
  if (json.ok === false) {
    out.blocked = true;
    const r = typeof json.reason === 'string' && json.reason.trim() ? json.reason : undefined;
    out.reason = r ?? out.reason ?? 'The prompt hook said no.';
  }
  return true;
}

function applyBehavior(decision: unknown, out: HookOutcome): void {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return;
  const d = decision as Record<string, unknown>;
  if (d.behavior === 'allow') out.permissionDecision = 'allow';
  if (d.behavior === 'deny') {
    out.permissionDecision = 'deny';
    out.blocked = true;
    if (typeof d.message === 'string' && !out.reason) out.reason = d.message;
  }
  if (d.updatedInput && typeof d.updatedInput === 'object') out.updatedInput = d.updatedInput as Record<string, unknown>;
}

/** Merge several outcomes. Deny wins over ask wins over allow; any block blocks, and a block's reason wins. */
export function mergeOutcomes(parts: HookOutcome[]): HookOutcome {
  const out = emptyOutcome();
  const rank = { deny: 3, ask: 2, allow: 1 } as const;
  let best = 0;
  const trace: HookTrace[] = [];
  for (const p of parts) {
    if (p.blocked) out.blocked = true;
    if (p.reason && !out.reason) out.reason = p.reason;
    if (p.permissionDecision) {
      const r = rank[p.permissionDecision];
      if (r > best) {
        best = r;
        out.permissionDecision = p.permissionDecision;
      }
    }
    if (p.updatedInput) out.updatedInput = p.updatedInput;
    if (p.updatedToolOutput !== undefined) out.updatedToolOutput = p.updatedToolOutput;
    out.additionalContext.push(...p.additionalContext);
    out.systemMessages.push(...p.systemMessages);
    if (p.stop) out.stop = p.stop;
    if (p.trace) trace.push(...p.trace);
  }
  if (out.permissionDecision === 'deny') out.blocked = true;
  const winner = out.blocked ? parts.find((p) => (p.blocked || p.permissionDecision === 'deny') && p.reason) : parts.find((p) => p.permissionDecision === out.permissionDecision && p.reason);
  if (winner) out.reason = winner.reason;
  if (trace.length) out.trace = trace;
  return out;
}

export function summarize(o: HookOutcome): string {
  if (o.permissionDecision === 'deny') return 'deny';
  if (o.blocked) return 'block';
  if (o.permissionDecision) return o.permissionDecision;
  if (o.updatedInput) return 'rewrite';
  if (o.updatedToolOutput !== undefined) return 'replace';
  if (o.additionalContext.length) return 'context';
  if (o.stop) return 'stop';
  return 'noop';
}

const cap = (s: string) => (s.length > TRACE_CAP ? s.slice(0, TRACE_CAP) + '...' : s);

/** Claude Code spells Conclave's permission modes differently; hooks see Claude's names. */
const PERMISSION_MODE_WIRE: Record<string, string> = { bypass: 'bypassPermissions' };

/** The JSON a hook reads on stdin. Same keys as Claude Code. */
export function wireInput(input: HookInput): HookInput {
  const mode = input.permission_mode;
  return mode && PERMISSION_MODE_WIRE[mode] ? { ...input, permission_mode: PERMISSION_MODE_WIRE[mode] } : input;
}

/** Value at a dotted path in an object: "tool_input.file_path". */
function atPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Fill ${path.in.input} placeholders in an mcp_tool handler's input from the
 * hook input JSON. A string that is only one placeholder keeps the value's
 * type. Placeholders whose first segment is not a hook input key stay as they
 * are (${secret:...}, ${CLAUDE_PLUGIN_ROOT}).
 */
export function interpolateInput<T>(value: T, input: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const whole = /^\$\{([\w.]+)\}$/.exec(value);
    if (whole && whole[1].split('.')[0] in input) {
      const v = atPath(input, whole[1]);
      return (v === undefined ? '' : v) as T;
    }
    return value.replace(/\$\{([\w.]+)\}/g, (m, p: string) => {
      if (!(p.split('.')[0] in input)) return m;
      const v = atPath(input, p);
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateInput(v, input)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateInput(v, input);
    return out as T;
  }
  return value;
}

/** Cut a list of context strings to `budget` chars in total. Returns the cut list and how many chars were dropped. */
export function capContext(list: string[], budget: number): { list: string[]; over: number } {
  const total = list.reduce((n, s) => n + s.length, 0);
  if (total <= budget) return { list, over: 0 };
  const out: string[] = [];
  let left = budget;
  for (const s of list) {
    if (left <= 0) break;
    out.push(s.length <= left ? s : s.slice(0, left));
    left -= s.length;
  }
  const over = total - budget;
  out.push(`[cut by Conclave: ${over} chars over budget]`);
  return { list: out, over };
}

/** Recipes whose handlers all run on the hub: they read the folder from their input (hook-recipes.ts runOn). */
const HUB_RECIPES = new Set(HOOK_RECIPES.filter((r) => r.handlers.every((h) => h.runOn === 'hub')).map((r) => r.id));

/**
 * The folder a command hook starts in: the session's, or, when the session's
 * folder is on another device, the hub's home for a handler that reads the
 * folder from its input (anyCwd, or one added from a hub recipe) and the
 * plugin's own data folder for a plugin hook (caveman's ruleset, say), so a
 * plugin never writes into the hub's home. The input still names the
 * session's folder. Other handlers keep the session's folder and say they
 * could not start there.
 */
function spawnCwd(cmd: RuntimeHookCommand, cwd: string): string {
  const hubRun = cmd.anyCwd || (cmd.recipe && HUB_RECIPES.has(cmd.recipe));
  if (!hubRun && !cmd.plugin) return cwd;
  // the folder must exist here and the hub's user must be able to enter it: /root of a device whose daemon runs as root
  // also exists on the hub, but not for the hub's own user
  try {
    if (cwd && statSync(cwd).isDirectory()) {
      accessSync(cwd, fsConstants.X_OK);
      return cwd;
    }
  } catch {
    /* a folder on another device, or one the hub's user cannot enter */
  }
  if (hubRun) return homedir();
  if (cmd.pluginData) {
    try {
      mkdirSync(cmd.pluginData, { recursive: true });
      return cmd.pluginData;
    } catch {
      /* fall back below */
    }
  }
  return cmd.pluginRoot ?? cwd;
}

let bashPath: string | null | undefined;
function defaultShell(): string {
  if (bashPath === undefined) bashPath = Bun.which('bash');
  return bashPath ?? 'sh';
}

/** Codex-format plugins read PLUGIN_ROOT and PLUGIN_DATA; Claude-format plugins must not see them (ponytail reads them as "running in Codex"). */
const codexRoots = new Map<string, boolean>();
function isCodexPlugin(root: string): boolean {
  let v = codexRoots.get(root);
  if (v === undefined) {
    v = existsSync(join(root, '.codex-plugin', 'plugin.json')) && !existsSync(join(root, '.claude-plugin', 'plugin.json'));
    codexRoots.set(root, v);
  }
  return v;
}

/**
 * The Bun binary a `node` link may point at. Under `bun run` that is
 * process.execPath; in a `bun build --compile` binary execPath is Conclave
 * itself, which must not answer to `node`, so it falls back to a bun on PATH.
 */
function bunBinary(): string | undefined {
  if (/^bun(\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
  return Bun.which('bun') ?? undefined;
}

/** The PATH folder that holds a `node` shim when node is missing, or undefined when node is there or no shim can be made. */
function nodeShim(shimDir?: string): string | undefined {
  if (Bun.which('node')) return undefined;
  const docker = '/usr/local/bun-node-fallback-bin';
  if (existsSync(join(docker, 'node'))) return docker;
  const bun = bunBinary();
  if (!shimDir || !bun) return undefined;
  try {
    const link = join(shimDir, 'node');
    let target: string | undefined;
    try {
      target = readlinkSync(link);
    } catch {
      target = undefined;
    }
    // a link left by an older Bun (upgraded or moved) points nowhere: make it again
    if (target !== bun || !existsSync(link)) {
      mkdirSync(shimDir, { recursive: true });
      rmSync(link, { force: true });
      symlinkSync(bun, link);
    }
    return shimDir;
  } catch (err) {
    log.debug('no node shim for hooks', err);
    return undefined;
  }
}

/**
 * A plugin's own CLAUDE_CONFIG_DIR starts with a settings.json that has a
 * status line that does nothing. Conclave has no status line, and without one
 * set, mode plugins (caveman, ponytail) tell the model in the first session to
 * offer setting one up in a file nothing reads. Only plugins read this file;
 * Claude Code never does. An existing file is left alone.
 */
export function seedPluginClaudeConfig(dir: string): void {
  const file = join(dir, 'settings.json');
  if (existsSync(file)) return;
  try {
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'true' } }, null, 2) + '\n', { flag: 'wx' });
  } catch {
    /* another hook made it first, or the folder is read only */
  }
}

/** A key for one handler: event plus what it runs. */
function handlerKey(event: HookEvent, cmd: RuntimeHookCommand): string {
  return `${event}\u0000${cmd.plugin ?? ''}\u0000${cmd.type}\u0000${cmd.command ?? cmd.prompt ?? `${cmd.server}/${cmd.tool}`}`;
}

/** The trace label of a handler, as the Hooks view matches it. */
export function handlerLabel(cmd: RuntimeHookCommand): string {
  if (cmd.type === 'prompt') return (cmd.prompt ?? '').slice(0, 200);
  if (cmd.type === 'mcp_tool') return `mcp ${cmd.server ?? '?'} ${cmd.tool ?? '?'}`;
  return cmd.args?.length ? [cmd.command, ...cmd.args].join(' ') : (cmd.command ?? '');
}

export class Hooks implements HookRunner {
  private registered: Registered[] = [];
  private complete?: HooksOptions['complete'];
  private env: Record<string, string>;
  private spawn: typeof Bun.spawn;
  private callTool?: HooksOptions['callTool'];
  private toolReadOnly?: HooksOptions['toolReadOnly'];
  private onStatus?: HooksOptions['onStatus'];
  private shim?: string;
  private recentTraces: Array<HookTrace & { at: number; sessionId: string }> = [];
  /** Handlers with once: true that already ran, per session. */
  private ranOnce = new Set<string>();
  /** Context chars per handler label, per session, for "adds about N tokens per session". */
  private costs = new Map<string, Map<string, number>>();

  constructor(opts: HooksOptions = {}) {
    this.complete = opts.complete;
    this.env = opts.env ?? {};
    this.spawn = opts.spawn ?? Bun.spawn;
    this.callTool = opts.callTool;
    this.toolReadOnly = opts.toolReadOnly;
    this.onStatus = opts.onStatus;
    this.shim = nodeShim(opts.shimDir);
  }

  register(event: HookEvent, fn: HookFn, matcher?: string, label?: string): () => void {
    const entry: Registered = { event, matcher, fn, label };
    this.registered.push(entry);
    return () => {
      this.registered = this.registered.filter((r) => r !== entry);
    };
  }

  /** Handlers that would run for this event and value, without running them. */
  plan(event: HookEvent, input: HookInput, opts: { matcherValue?: string; hooks: HooksConfig }): RuntimeHookCommand[] {
    const out: RuntimeHookCommand[] = [];
    for (const group of opts.hooks[event] ?? []) {
      if (!group || !Array.isArray(group.hooks)) continue;
      if (!matcherMatches(group.matcher, opts.matcherValue)) continue;
      for (const cmd of group.hooks as RuntimeHookCommand[]) if (cmd && ifMatches(cmd.if, input)) out.push(cmd);
    }
    return out;
  }

  async run(
    event: HookEvent,
    input: HookInput,
    opts: { matcherValue?: string; hooks: HooksConfig; signal?: AbortSignal },
  ): Promise<HookOutcome> {
    const planned = this.plan(event, input, opts).filter((cmd) => {
      // the Hooks tab's test runner uses session "test": a once handler must run on every test, not only the first
      if (!cmd.once || input.session_id === 'test') return true;
      const key = `${input.session_id}\u0000${handlerKey(event, cmd)}`;
      if (this.ranOnce.has(key)) return false;
      this.ranOnce.add(key);
      if (this.ranOnce.size > 5_000) this.ranOnce.clear();
      return true;
    });
    const fns = this.registered.filter((r) => r.event === event && matcherMatches(r.matcher, opts.matcherValue));

    let parts: HookOutcome[];
    if (event === 'PreToolUse' && planned.length > 1) {
      // Handlers that may rewrite the input run one after another, each fed the input the previous one left,
      // so two rewriting hooks compose instead of the last one silently winning.
      parts = [];
      let current = input;
      let rewroteBy: string | undefined;
      for (const cmd of planned) {
        const o = await this.runOne(cmd, event, current, opts.signal);
        if (o.updatedInput) {
          const label = handlerLabel(cmd);
          if (rewroteBy && o.trace?.[0]) o.trace[0].note = `Changed the input after ${oneLine(rewroteBy, 80)} changed it.`;
          rewroteBy = label;
          current = { ...current, tool_input: o.updatedInput };
        }
        parts.push(o);
      }
      parts.push(...(await Promise.all(fns.map((r) => this.runFn(r, event, current)))));
    } else {
      parts = await Promise.all([...planned.map((cmd) => this.runOne(cmd, event, input, opts.signal)), ...fns.map((r) => this.runFn(r, event, input))]);
    }

    const merged = mergeOutcomes(parts);
    if ((event === 'SessionStart' || event === 'SubagentStart') && merged.additionalContext.length) {
      const cut = capContext(merged.additionalContext, CONTEXT_BUDGET.start);
      if (cut.over) {
        merged.additionalContext = cut.list;
        merged.systemMessages.push(`${event} hooks added ${cut.over} chars over the ${CONTEXT_BUDGET.start} char budget; the rest was cut.`);
      }
    }
    if (merged.trace?.length) this.remember(merged.trace, input.session_id);
    return merged;
  }

  /** Add traces from work that runs like a hook but is not one (built-in memory recall), so the Hooks view shows it. */
  record(trace: HookTrace, sessionId: string): void {
    this.remember([trace], sessionId);
  }

  private remember(traces: HookTrace[], sessionId: string): void {
    const at = Date.now();
    this.recentTraces.push(...traces.map((t) => ({ ...t, at, sessionId })));
    if (this.recentTraces.length > RECENT_CAP) this.recentTraces.splice(0, this.recentTraces.length - RECENT_CAP);
    for (const t of traces) {
      if (!t.contextChars || sessionId === 'test') continue;
      const key = `${t.event}\u0000${t.plugin ?? ''}\u0000${t.label}`;
      let per = this.costs.get(key);
      if (!per) this.costs.set(key, (per = new Map()));
      per.set(sessionId, (per.get(sessionId) ?? 0) + t.contextChars);
      if (per.size > 50) per.delete(per.keys().next().value as string);
    }
  }

  /** Most recent handler runs, newest last. For the "last results" column in the Hooks view. */
  recent(opts: { event?: HookEvent; limit?: number } = {}): Array<HookTrace & { at: number; sessionId: string }> {
    const list = opts.event ? this.recentTraces.filter((t) => t.event === opts.event) : this.recentTraces;
    return list.slice(-(opts.limit ?? 50));
  }

  /** About how many tokens a handler added per session in recent sessions (4 chars a token). undefined when it added none. */
  tokensPerSession(event: HookEvent, label: string, plugin?: string): number | undefined {
    const per = this.costs.get(`${event}\u0000${plugin ?? ''}\u0000${label}`);
    if (!per?.size) return undefined;
    const total = [...per.values()].reduce((n, c) => n + c, 0);
    return Math.round(total / per.size / 4);
  }

  private async runOne(cmd: RuntimeHookCommand, event: HookEvent, input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
    let run: Promise<HookOutcome>;
    if (cmd.type === 'command' && cmd.command) run = this.runCommand(cmd, event, input, signal);
    else if (cmd.type === 'prompt' && cmd.prompt) run = this.runPrompt(cmd, event, input, signal);
    else if (cmd.type === 'mcp_tool') run = this.runMcpTool(cmd, event, input, signal);
    else {
      const out = emptyOutcome();
      out.systemMessages.push(`hook (${event}) skipped: a ${cmd.type ?? 'handler'} with nothing to run`);
      out.trace = [{ event, type: 'command', label: handlerLabel(cmd) || '(empty)', plugin: cmd.plugin, durationMs: 0, result: 'skipped', ...(cmd.recipe ? { recipe: cmd.recipe } : {}) }];
      return out;
    }
    if (cmd.statusMessage) this.onStatus?.(input, cmd.statusMessage, false);
    try {
      const out = await run;
      this.budget(out, cmd, event);
      const t = out.trace?.[0];
      if (t) {
        if (cmd.recipe) t.recipe = cmd.recipe;
        const chars = out.additionalContext.reduce((n, s) => n + s.length, 0);
        if (chars) t.contextChars = chars;
        if (cmd.suppressOutput) {
          t.stdout = '';
          t.note = t.note ?? 'Output hidden (suppressOutput).';
        }
      }
      return out;
    } finally {
      if (cmd.statusMessage) this.onStatus?.(input, cmd.statusMessage, true);
    }
  }

  /** Per-handler context budget: Codex's additionalContextLimit when set, 2,000 chars on UserPromptSubmit. */
  private budget(out: HookOutcome, cmd: RuntimeHookCommand, event: HookEvent): void {
    const limit = typeof cmd.additionalContextLimit === 'number' && cmd.additionalContextLimit > 0 ? cmd.additionalContextLimit : event === 'UserPromptSubmit' ? CONTEXT_BUDGET.prompt : undefined;
    if (!limit || !out.additionalContext.length) return;
    const cut = capContext(out.additionalContext, limit);
    if (!cut.over) return;
    out.additionalContext = cut.list;
    const t = out.trace?.[0];
    if (t) t.note = `Context cut to ${limit} chars (${cut.over} over).`;
  }

  /** A crash or timeout of a handler with onFailure "block": fail closed. */
  private failClosed(out: HookOutcome, cmd: RuntimeHookCommand, event: HookEvent, why: string): boolean {
    if (cmd.onFailure !== 'block') return false;
    out.blocked = true;
    if (event === 'PreToolUse' || event === 'PermissionRequest') out.permissionDecision = 'deny';
    out.reason = `A hook that blocks on failure failed (${why}), so the action is blocked.`;
    return true;
  }

  private async runFn(r: Registered, event: HookEvent, input: HookInput): Promise<HookOutcome> {
    const out = emptyOutcome();
    const started = Date.now();
    try {
      const res = await r.fn(input);
      // undefined means "not for this call": no trace, so a built-in that is off does not fill the run log
      if (res === undefined) return out;
      if (res) Object.assign(out, { ...res, additionalContext: [...out.additionalContext, ...(res.additionalContext ?? [])], systemMessages: [...out.systemMessages, ...(res.systemMessages ?? [])] });
    } catch (err) {
      out.systemMessages.push(`hook (${event}) failed: ${(err as Error).message}`);
    }
    const chars = out.additionalContext.reduce((n, s) => n + s.length, 0);
    out.trace = [{ event, type: 'function', label: r.label ?? '(in-process)', durationMs: Date.now() - started, result: summarize(out), ...(chars ? { contextChars: chars } : {}) }];
    return out;
  }

  private commandEnv(cmd: RuntimeHookCommand, input: HookInput): Record<string, string> {
    // hook scripts (including plugin hooks from the catalog) never see the hub's own credentials
    const inherited: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !isHubSecretEnv(k)) inherited[k] = v;
    const env: Record<string, string> = {
      ...inherited,
      ...this.env,
      CLAUDE_PROJECT_DIR: input.cwd,
      CONCLAVE_PROJECT_DIR: input.cwd,
      CONCLAVE_SESSION_ID: input.session_id,
      CONCLAVE: '1',
    };
    if (this.shim) env.PATH = [env.PATH, this.shim].filter(Boolean).join(delimiter);
    delete env.PLUGIN_ROOT;
    delete env.PLUGIN_DATA;
    const codex = cmd.pluginRoot ? isCodexPlugin(cmd.pluginRoot) : false;
    if (cmd.pluginRoot) {
      env.CLAUDE_PLUGIN_ROOT = cmd.pluginRoot;
      env.CONCLAVE_PLUGIN_ROOT = cmd.pluginRoot;
      if (codex) env.PLUGIN_ROOT = cmd.pluginRoot;
    }
    if (cmd.pluginData) {
      try {
        mkdirSync(cmd.pluginData, { recursive: true });
      } catch {
        /* best effort */
      }
      env.CLAUDE_PLUGIN_DATA = cmd.pluginData;
      if (codex) env.PLUGIN_DATA = cmd.pluginData;
    }
    // Plugin hooks write mode flags into $CLAUDE_CONFIG_DIR. Give each plugin its own, so they do not share state with the owner's Claude Code.
    if (cmd.plugin && cmd.pluginData && !cmd.shareClaudeConfig) {
      const dir = join(cmd.pluginData, 'claude-config');
      try {
        mkdirSync(dir, { recursive: true });
        seedPluginClaudeConfig(dir);
        env.CLAUDE_CONFIG_DIR = dir;
      } catch {
        /* keep the inherited one */
      }
    }
    return env;
  }

  private async runCommand(cmd: RuntimeHookCommand, event: HookEvent, input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
    const out = emptyOutcome();
    const started = Date.now();
    const label = handlerLabel(cmd);
    const timeoutMs = cmd.timeout ? cmd.timeout * 1000 : event === 'SessionEnd' ? SESSION_END_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const shell = cmd.shell === 'sh' || cmd.shell === 'bash' ? cmd.shell : defaultShell();
    const argv = cmd.args?.length ? [cmd.command as string, ...cmd.args] : [shell, '-c', cmd.command as string];
    const finish = (extra: Partial<HookTrace>): HookOutcome => {
      out.trace = [{ event, type: 'command', label, plugin: cmd.plugin, durationMs: Date.now() - started, result: summarize(out), ...extra }];
      return out;
    };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.spawn(argv, {
        cwd: spawnCwd(cmd, input.cwd),
        env: this.commandEnv(cmd, input),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (this.failClosed(out, cmd, event, `it did not start: ${msg}`)) return finish({ result: 'block', stderr: msg, note: 'Failed closed (onFailure: block).' });
      const why = /EACCES/.test(msg) ? `the hub's user may not enter the folder ${input.cwd}` : `check the command and that the folder ${input.cwd} exists on the hub`;
      out.systemMessages.push(`hook (${event}) did not start: ${msg}. Hooks run on the hub, so ${why}.`);
      return finish({ result: 'error', stderr: msg });
    }

    try {
      const stdin = proc.stdin as unknown as { write: (s: string) => void; end: () => void } | null;
      if (stdin) {
        stdin.write(JSON.stringify(wireInput(input)));
        stdin.end();
      }
    } catch {
      /* ignore broken pipe */
    }

    if (cmd.async) {
      // Fire and forget, like Claude Code's async hooks. Output is not used.
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      void proc.exited.finally(() => clearTimeout(timer));
      return finish({ result: 'async' });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let exitCode: number;
    let stdout = '';
    let stderr = '';
    try {
      [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
      exitCode = await proc.exited;
    } catch (err) {
      if (this.failClosed(out, cmd, event, (err as Error).message)) return finish({ result: 'block', note: 'Failed closed (onFailure: block).' });
      out.systemMessages.push(`hook (${event}) errored: ${(err as Error).message}`);
      return finish({ result: 'error' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (timedOut) {
      const secs = Math.round(timeoutMs / 100) / 10;
      if (this.failClosed(out, cmd, event, `timed out after ${secs}s`)) return finish({ timedOut: true, result: 'block', stdout: cap(stdout), stderr: cap(stderr), note: 'Failed closed (onFailure: block).' });
      out.systemMessages.push(`hook (${event}) timed out after ${secs}s: ${oneLine(label, 80)}. Raise its timeout or make it faster.`);
      return finish({ timedOut: true, result: 'timeout', stdout: cap(stdout), stderr: cap(stderr) });
    }

    let note: string | undefined;
    if (exitCode === 0) {
      const json = isJsonObject(stdout);
      if (json) {
        applyJsonOutput(json, event, out, input);
        if (json.suppressOutput === true) note = 'Output hidden (suppressOutput).';
      } else if (STDOUT_IS_CONTEXT.has(event) && stdout.trim()) out.additionalContext.push(stdout.trim());
    } else if (exitCode === 2) {
      // Blocking error. The engine shows the reason to the model (tool events, Stop) or the user (prompt).
      out.blocked = true;
      out.reason = stderr.trim() || `hook ${event} blocked (exit 2)`;
    } else {
      const first = (stderr.trim() || stdout.trim()).split('\n')[0];
      const why = exitCode === 127 ? `a program it calls was not found (exit 127)${first ? `: ${first}` : ''}` : `exit ${exitCode}${first ? `: ${first}` : ''}`;
      if (this.failClosed(out, cmd, event, why)) return finish({ exitCode, stdout: cap(stdout), stderr: cap(stderr), result: 'block', note: 'Failed closed (onFailure: block).' });
      if (first || exitCode === 127) out.systemMessages.push(`hook (${event}) failed, ${why}`);
      else log.warn(`hook (${event}) exited ${exitCode} with no output`);
      note = exitCode === 127 ? 'A program the hook calls is not on PATH on the hub.' : undefined;
    }
    return finish({
      exitCode,
      stdout: note?.startsWith('Output hidden') ? '' : cap(stdout),
      stderr: cap(stderr),
      result: exitCode === 0 || exitCode === 2 ? summarize(out) : 'error',
      ...(note ? { note } : {}),
    });
  }

  private async runPrompt(cmd: RuntimeHookCommand, event: HookEvent, input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
    const out = emptyOutcome();
    const started = Date.now();
    const finish = (extra: Partial<HookTrace> = {}): HookOutcome => {
      out.trace = [{ event, type: 'prompt', label: handlerLabel(cmd), plugin: cmd.plugin, durationMs: Date.now() - started, result: summarize(out), ...extra }];
      return out;
    };
    if (!this.complete) {
      out.systemMessages.push(`prompt hook (${event}) skipped: no model wired`);
      return finish({ result: 'skipped' });
    }
    const prompt = (cmd.prompt as string).replace(/\$ARGUMENTS/g, JSON.stringify(wireInput(input)));
    const timeoutMs = cmd.timeout ? cmd.timeout * 1000 : 30_000;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let text: string;
    try {
      text = await this.complete({ prompt, model: cmd.model, signal: ac.signal });
    } catch (err) {
      const why = ac.signal.aborted && !signal?.aborted ? `timed out after ${timeoutMs / 1000}s` : (err as Error).message;
      if (this.failClosed(out, cmd, event, why)) return finish({ result: 'block', note: 'Failed closed (onFailure: block).' });
      out.systemMessages.push(`prompt hook (${event}) failed: ${why}`);
      return finish({ result: ac.signal.aborted ? 'timeout' : 'error' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const json = jsonInReply(text);
    if (json) {
      // Claude Code's prompt hooks answer {"ok": true} or {"ok": false, "reason": "..."}.
      if (!applyOkAnswer(json, out)) {
        applyJsonOutput(json, event, out, input);
        // Prompt hooks commonly return {decision, reason} without hookSpecificOutput.
        if (json.decision === 'block' && !out.reason && typeof json.reason === 'string') out.reason = json.reason;
      }
      if ((event === 'PreToolUse' || event === 'PermissionRequest') && out.blocked && !out.permissionDecision) out.permissionDecision = 'deny';
    } else if (STDOUT_IS_CONTEXT.has(event) && text.trim()) {
      out.additionalContext.push(text.trim());
    }
    return finish({ stdout: cap(text) });
  }

  private async runMcpTool(cmd: RuntimeHookCommand, event: HookEvent, input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
    const out = emptyOutcome();
    const started = Date.now();
    const finish = (extra: Partial<HookTrace> = {}): HookOutcome => {
      out.trace = [{ event, type: 'command', label: handlerLabel(cmd), plugin: cmd.plugin, durationMs: Date.now() - started, result: summarize(out), ...extra }];
      return out;
    };
    const server = cmd.server?.trim();
    const tool = cmd.tool?.trim();
    if (!server || !tool) {
      out.systemMessages.push(`mcp_tool hook (${event}) needs both server and tool.`);
      return finish({ result: 'error' });
    }
    if (!this.callTool) {
      out.systemMessages.push(`mcp_tool hook (${event}) skipped: MCP is not available here.`);
      return finish({ result: 'skipped' });
    }
    if (!cmd.allowWrite) {
      const ro = await this.toolReadOnly?.(server, tool).catch(() => undefined);
      if (ro !== true) {
        const why = ro === undefined ? `${server} has no tool named ${tool}, or the server is not connected` : `${server} ${tool} is not marked read only`;
        if (this.failClosed(out, cmd, event, why)) return finish({ result: 'block', note: 'Failed closed (onFailure: block).' });
        out.systemMessages.push(`mcp_tool hook (${event}) skipped: ${why}. Set "allowWrite": true to call it anyway.`);
        return finish({ result: 'skipped', note: why });
      }
    }
    const args = interpolateInput(cmd.input ?? {}, wireInput(input) as unknown as Record<string, unknown>);
    const timeoutMs = cmd.timeout ? cmd.timeout * 1000 : 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: { text: string; isError?: boolean };
    try {
      res = await Promise.race([
        this.callTool(server, tool, args),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
          signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        }),
      ]);
    } catch (err) {
      const why = (err as Error).message;
      if (this.failClosed(out, cmd, event, why)) return finish({ result: 'block', note: 'Failed closed (onFailure: block).' });
      out.systemMessages.push(`mcp_tool hook (${event}) ${server} ${tool} failed: ${why}`);
      return finish({ result: /timed out/.test(why) ? 'timeout' : 'error' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.isError) {
      if (this.failClosed(out, cmd, event, oneLine(res.text, 120))) return finish({ result: 'block', stdout: cap(res.text), note: 'Failed closed (onFailure: block).' });
      out.systemMessages.push(`mcp_tool hook (${event}) ${server} ${tool} returned an error: ${oneLine(res.text, 160)}`);
      return finish({ result: 'error', stdout: cap(res.text) });
    }
    const json = isJsonObject(res.text);
    if (json && ('hookSpecificOutput' in json || 'decision' in json || 'continue' in json || 'systemMessage' in json || 'additionalContext' in json)) applyJsonOutput(json, event, out, input);
    else if (STDOUT_IS_CONTEXT.has(event) && res.text.trim()) out.additionalContext.push(res.text.trim());
    return finish({ stdout: cap(res.text) });
  }
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
}
