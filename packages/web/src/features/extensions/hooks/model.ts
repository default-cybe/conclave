/**
 * Hooks tab data helpers: sample inputs per event, the words for outcomes,
 * and rebuilding a whole scope for saveHooks (it replaces the scope, so the
 * UI always sends the full list).
 */
import type { HookEventInfo, HookGroupDto, HookHandlerDto, HookRunDto, HooksOverview } from '@conclave/core/client';
import type { HookEvent, HookMatcher, HooksConfig } from '@conclave/core/config/schema';
import { sourceWord } from '../shared/SourceBadge';

export const EVENT_ORDER: HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'SessionEnd',
];

/** What a hook at this event can do (IA.md table, "Can"). */
export const EVENT_CAN: Record<HookEvent, string> = {
  SessionStart: 'Can add context.',
  UserPromptSubmit: 'Can block the message or add context.',
  PreToolUse: 'Can block, allow, ask, or change the input.',
  PermissionRequest: 'Can allow or deny for you.',
  PostToolUse: 'Can add feedback or stop the turn.',
  PostToolUseFailure: 'Can add feedback.',
  Notification: 'Side effects only.',
  SubagentStart: 'Can add context.',
  SubagentStop: 'Can make it continue.',
  PreCompact: 'Can block or add instructions.',
  Stop: 'Can make the agent continue.',
  SessionEnd: 'Side effects only, 1.5 seconds by default.',
};

/** Sample hook input per event, prefilled in the test runner. */
export const SAMPLES: Record<HookEvent, Record<string, unknown>> = {
  SessionStart: { source: 'startup' },
  UserPromptSubmit: { prompt: 'deploy it' },
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'git push origin main' } },
  PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'pct destroy 104' } },
  PostToolUse: { tool_name: 'Edit', tool_input: { file_path: 'src/server/auth.ts', old_string: 'jwt.verify(token, key)', new_string: 'await jwtVerify(token, key)' }, tool_response: { success: true } },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'bun test' }, error: 'Exit code 1: 3 tests failed' },
  Notification: { notification_type: 'permission_prompt', message: 'Conclave needs your permission to use Bash' },
  SubagentStart: { agent_type: 'explore' },
  SubagentStop: { agent_type: 'explore', stop_hook_active: false },
  PreCompact: { trigger: 'auto', custom_instructions: '' },
  Stop: { stop_hook_active: false, last_assistant_message: 'Done.' },
  SessionEnd: { reason: 'clear' },
};

/** The field of the sample input the hub compares a matcher with by default. */
export function matcherField(event: HookEvent): string | undefined {
  if (/ToolUse|PermissionRequest/.test(event)) return 'tool_name';
  if (event === 'SessionStart') return 'source';
  if (event === 'SessionEnd') return 'reason';
  if (event === 'PreCompact') return 'trigger';
  if (event === 'SubagentStart' || event === 'SubagentStop') return 'agent_type';
  if (event === 'Notification') return 'notification_type';
  return undefined;
}

export function isToolEvent(event: HookEvent): boolean {
  return /ToolUse|PermissionRequest/.test(event);
}

/** "Compared with the tool name." or "Matchers are ignored." */
export function matcherWords(info: Pick<HookEventInfo, 'matcherValue'>): string {
  if (!info.matcherValue) return 'Matchers are ignored here.';
  return `Matcher compares: ${info.matcherValue}.`;
}

export type Tone = 'ok' | 'fault' | 'warn' | 'dim' | 'neutral';

/** How an outcome word reads. Errors and timeouts are faults; a block is the hook doing its job. */
export function resultTone(result: string): Tone {
  if (result === 'error' || result === 'timeout') return 'fault';
  if (result === 'block' || result === 'deny' || result === 'ask' || result === 'stop' || result === 'rewrite' || result === 'replace') return 'neutral';
  return 'dim';
}

const RESULT_WORD: Record<string, string> = {
  allow: 'allowed',
  deny: 'denied',
  ask: 'asked you',
  block: 'blocked',
  rewrite: 'changed input',
  replace: 'replaced output',
  context: 'added context',
  stop: 'stopped the turn',
  noop: 'no change',
  error: 'error',
  timeout: 'timed out',
  async: 'ran in background',
  skipped: 'skipped',
};

export function resultWord(result: string): string {
  return RESULT_WORD[result] ?? result;
}

/** Command or prompt text of a handler; "mcp <server> <tool>" for an MCP tool handler. */
export function handlerText(h: Pick<HookHandlerDto, 'type' | 'command' | 'prompt' | 'server' | 'tool'>): string {
  if (h.type === 'mcp_tool') return `mcp ${h.server ?? '?'} ${h.tool ?? '?'}`;
  return (h.type === 'prompt' ? h.prompt : h.command) ?? '';
}

/** The label the hub writes in a run for this handler: the command with its args, the first 200 characters of the prompt, or "mcp <server> <tool>". */
function runLabel(h: Pick<HookHandlerDto, 'type' | 'command' | 'prompt' | 'args' | 'server' | 'tool'>): string {
  if (h.type === 'prompt') return (h.prompt ?? '').slice(0, 200);
  if (h.type === 'mcp_tool') return `mcp ${h.server ?? '?'} ${h.tool ?? '?'}`;
  return h.args?.length ? [h.command ?? '', ...h.args].join(' ') : (h.command ?? '');
}

/** The recipe a handler came from: its tag, or a command that runs a recipe script. */
export function recipeOf(h: Pick<HookHandlerDto, 'recipe' | 'command'>): string | undefined {
  if (h.recipe) return h.recipe;
  const m = /\/hooks\/recipes\/([a-z0-9-]+)\.sh\b/.exec(h.command ?? '');
  return m?.[1];
}

/** "adds about 1,250 tokens per session" from recent runs, when the hub priced it. */
export function tokenWords(tokens?: number): string | undefined {
  if (!tokens) return undefined;
  return `adds about ${tokens.toLocaleString('en-US')} tokens per session`;
}

/** Runs of one handler, matched by label like the hub writes them. */
export function runsFor(last: HookRunDto[], h: HookHandlerDto): HookRunDto[] {
  const label = runLabel(h);
  return last.filter((r) => r.label === label && (!h.plugin || !r.plugin || r.plugin === h.plugin));
}

/** Plugin name to its folder, from the handlers the hub listed, so run labels can show ${CLAUDE_PLUGIN_ROOT}. */
export function pluginRoots(ov: HooksOverview | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ev of ov?.events ?? []) for (const g of ev.groups) for (const h of g.hooks) if (h.plugin && h.pluginRoot) out[h.plugin] = h.pluginRoot;
  return out;
}

/** "default timeout, 600s": the hub's default when a handler sets none (SessionEnd gets 1.5 s). */
export function defaultTimeoutWords(event: HookEvent): string {
  return event === 'SessionEnd' ? 'default timeout, 1.5s' : 'default timeout, 600s';
}

/** A command handler with no timeout that looks like it calls the network (IA.md, inline warnings). */
export function networkWithoutTimeout(h: Pick<HookHandlerDto, 'type' | 'command' | 'timeout' | 'async'>): boolean {
  if (h.type !== 'command' || h.timeout || h.async) return false;
  return /\b(curl|wget|ssh|scp|rsync|nc|http)\b|https?:\/\//.test(h.command ?? '');
}

/** True when scrolling should jump instead of glide (system setting or Appearance > Motion). */
export function scrollBehavior(): ScrollBehavior {
  try {
    if (document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto';
  } catch {
    /* no matchMedia */
  }
  return 'smooth';
}

/** The settings file of a project group, relative to the project: ".conclave/settings.json", ".claude/settings.local.json". */
export function groupFile(g: Pick<HookGroupDto, 'source' | 'path'>): string | undefined {
  if (g.source !== 'project' && g.source !== 'claude-project') return undefined;
  const m = /(\.(?:claude|conclave)\/settings(?:\.local)?\.json)$/.exec(g.path ?? '');
  return m?.[1] ?? (g.source === 'project' ? '.conclave/settings.json' : '.claude/settings.json');
}

/** Where a group comes from, in words: "config", "plugin hookify", "Claude Code project .claude/settings.json". */
export function sourceWords(g: Pick<HookGroupDto, 'source' | 'plugin' | 'path'>): string {
  const file = groupFile(g);
  return file ? `${sourceWord(g.source, g.plugin)} ${file}` : sourceWord(g.source, g.plugin);
}

export type Scope = 'user' | 'project';

/** Groups that saveHooks writes for a scope. Project scope writes .conclave/settings.json only. */
export function inScope(g: HookGroupDto, scope: Scope): boolean {
  if (scope === 'user') return g.source === 'config';
  return g.source === 'project' && !g.path?.endsWith('settings.local.json');
}

/** Editable here: the hub says so and saveHooks can write it back (not .conclave/settings.local.json). */
export function canEdit(g: HookGroupDto): boolean {
  return g.editable && (inScope(g, 'user') || inScope(g, 'project'));
}

/** The handler as stored: what the hub listed, minus what it adds (plugin, pluginRoot, tokensPerSession). */
function stripHandler(h: HookHandlerDto): HookHandlerDto {
  const out: HookHandlerDto = { type: h.type };
  if (h.type === 'command' && h.command !== undefined) out.command = h.command;
  if (h.type === 'prompt' && h.prompt !== undefined) out.prompt = h.prompt;
  if (h.type === 'mcp_tool') {
    if (h.server) out.server = h.server;
    if (h.tool) out.tool = h.tool;
    if (h.input) out.input = h.input;
    if (h.allowWrite) out.allowWrite = true;
  }
  if (h.args?.length) out.args = h.args;
  if (h.model) out.model = h.model;
  if (h.timeout !== undefined) out.timeout = h.timeout;
  if (h.if) out.if = h.if;
  if (h.async) out.async = h.async;
  if (h.shell) out.shell = h.shell;
  if (h.recipe) out.recipe = h.recipe;
  if (h.onFailure) out.onFailure = h.onFailure;
  if (h.once) out.once = true;
  if (h.statusMessage) out.statusMessage = h.statusMessage;
  if (h.suppressOutput) out.suppressOutput = true;
  if (h.additionalContextLimit) out.additionalContextLimit = h.additionalContextLimit;
  return out;
}

/** The whole scope as a HooksConfig, in the order the hub returned it. */
export function scopeConfig(ov: HooksOverview, scope: Scope): HooksConfig {
  const out: HooksConfig = {};
  for (const ev of ov.events) {
    const list = ev.groups.filter((g) => inScope(g, scope));
    if (!list.length) continue;
    out[ev.event] = list.map((g) => ({ ...(g.matcher ? { matcher: g.matcher } : {}), hooks: g.hooks.map(stripHandler) }) as HookMatcher);
  }
  return out;
}

/** Where a handler sits inside a scope: event, group position in that scope, handler position. */
export interface HandlerRef {
  scope: Scope;
  event: HookEvent;
  group: number;
  handler: number;
}

/** Position of a group among the groups of its scope for that event. */
export function scopeIndex(ev: HookEventInfo, g: HookGroupDto, scope: Scope): number {
  return ev.groups.filter((x) => inScope(x, scope)).indexOf(g);
}

/** Put a handler at event + matcher: replace in place when editing the same spot, else append to a matching group or a new one. */
export function placeHandler(cfg: HooksConfig, event: HookEvent, matcher: string, handler: HookHandlerDto, from?: HandlerRef): HooksConfig {
  const next = structuredClone(cfg) as HooksConfig;
  const m = matcher.trim();
  if (from) {
    const list = next[from.event] ?? [];
    const g = list[from.group];
    if (g && from.event === event && (g.matcher ?? '') === m) {
      g.hooks[from.handler] = stripHandler(handler) as HookMatcher['hooks'][number];
      return next;
    }
    if (g) {
      g.hooks.splice(from.handler, 1);
      if (!g.hooks.length) list.splice(from.group, 1);
      if (!list.length) delete next[from.event];
      else next[from.event] = list;
    }
  }
  const list = (next[event] ??= []);
  const same = list.find((g) => (g.matcher ?? '') === m);
  const h = stripHandler(handler) as HookMatcher['hooks'][number];
  if (same) same.hooks.push(h);
  else list.push({ ...(m ? { matcher: m } : {}), hooks: [h] });
  return next;
}

export function removeHandler(cfg: HooksConfig, at: HandlerRef): HooksConfig {
  const next = structuredClone(cfg) as HooksConfig;
  const list = next[at.event] ?? [];
  const g = list[at.group];
  if (!g) return next;
  g.hooks.splice(at.handler, 1);
  if (!g.hooks.length) list.splice(at.group, 1);
  if (!list.length) delete next[at.event];
  return next;
}

/** Append imported hooks after the scope's own. */
export function mergeHooks(base: HooksConfig, add: HooksConfig): HooksConfig {
  const next = structuredClone(base) as HooksConfig;
  for (const [ev, list] of Object.entries(add) as Array<[HookEvent, HookMatcher[]]>) next[ev] = [...(next[ev] ?? []), ...structuredClone(list ?? [])];
  return next;
}

export function countHandlers(cfg: HooksConfig): number {
  return Object.values(cfg).reduce((n, list) => n + (list ?? []).reduce((m, g) => m + g.hooks.length, 0), 0);
}

/** Show ${CLAUDE_PLUGIN_ROOT} instead of the plugin folder, as in the plugin's hooks.json. */
export function withPluginRoot(text: string, root?: string): string {
  if (!root) return text;
  return text.split(root).join('${CLAUDE_PLUGIN_ROOT}');
}

/** Events whose matcher is ignored (the hub reports no matcher value for them). */
const NO_MATCHER = new Set<string>(['UserPromptSubmit', 'Stop']);

/**
 * Words for an empty matcher, per event: "Every tool", "Every source", "Always".
 * Pass the event's matcherValue when you have it; without it, the known
 * matcher-less events read "Always".
 */
export function anyWords(event: HookEvent, matcherValue?: string | null): string {
  const mv = matcherValue === undefined ? (NO_MATCHER.has(event) ? null : event) : matcherValue;
  if (!mv) return 'Always';
  if (/ToolUse|PermissionRequest/.test(event)) return 'Every tool';
  if (event === 'SessionStart') return 'Every source';
  if (event === 'Notification') return 'Every notification';
  if (event === 'SubagentStart' || event === 'SubagentStop') return 'Every agent';
  if (event === 'PreCompact') return 'Manual and auto';
  return 'Every reason';
}
