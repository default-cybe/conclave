/**
 * Hook lint (ECOSYSTEM.md 4.3 item 5). Finds hook settings that load as
 * nothing or behave unlike what the author meant, and says how to fix them.
 * Runs on save (PUT /api/hooks), on import, on demand (POST /api/hooks/lint)
 * and over the files that load (GET /api/hooks).
 *
 * Fixes keep Claude Code's file format: a fixed list is still valid in
 * ~/.claude/settings.json.
 */
import type { HookEvent, HooksConfig } from '../config/schema';
import { parseRule } from '../session/permissions';
import { ruleToolMatches } from './hooks';

export const HOOK_EVENT_NAMES: HookEvent[] = [
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

/** Other CLIs' event names and what they are called here. */
const FOREIGN_EVENTS: Record<string, HookEvent> = {
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  BeforeAgent: 'UserPromptSubmit',
  AfterAgent: 'Stop',
  PreCompress: 'PreCompact',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  beforeSubmitPrompt: 'UserPromptSubmit',
  stop: 'Stop',
  sessionStart: 'SessionStart',
};

const TOOL_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
/** Events whose matcher Conclave and Claude Code ignore. */
const NO_MATCHER = new Set<HookEvent>(['UserPromptSubmit', 'Stop']);
const HANDLER_KEYS = ['type', 'command', 'prompt', 'timeout', 'if', 'async', 'args', 'shell', 'server', 'tool'];

export interface LintIssue {
  level: 'error' | 'warn';
  event: HookEvent;
  group: number;
  handler?: number;
  text: string;
  /** The whole list with this issue fixed, when a fix is known. */
  fix?: HooksConfig;
}

export interface LintResult {
  issues: LintIssue[];
  /** The input with every known fix applied (flat entries wrapped, ms timeouts, bare mcp__ matchers). */
  fixed: HooksConfig;
}

export interface LintOptions {
  /** MCP server names on this hub, to flag matchers and mcp_tool handlers for servers that do not exist. */
  mcpServers?: string[];
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** A matcher that is a bare server prefix: "mcp__github" or "mcp__". In Claude Code that is an exact tool name and matches nothing. */
export function bareMcpMatcher(m: string): string | undefined {
  const t = m.trim();
  if (t === 'mcp__') return 'mcp__.*';
  const one = /^mcp__([A-Za-z0-9_-]+?)(?:__)?$/.exec(t);
  if (one && !one[1].includes('__')) return `mcp__${one[1]}__.*`;
  return undefined;
}

/** The exact tool names a matcher lists, or undefined when it is a regex or matches everything. */
function exactNames(matcher: string | undefined): string[] | undefined {
  if (!matcher || matcher === '*' || !/^[\w\-\s,|]+$/.test(matcher)) return undefined;
  return matcher.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
}

/** Wrap a flat handler ({type, command} straight in the event list) into a group. */
function wrapFlat(g: Raw): Raw {
  const { matcher, ...handler } = g;
  return { ...(typeof matcher === 'string' && matcher ? { matcher } : {}), hooks: [{ type: handler.type ?? (handler.prompt ? 'prompt' : 'command'), ...handler }] };
}

function isFlat(g: Raw): boolean {
  return !Array.isArray(g.hooks) && HANDLER_KEYS.some((k) => k in g) && (typeof g.command === 'string' || typeof g.prompt === 'string' || g.type === 'mcp_tool');
}

export function lintHooks(raw: unknown, opts: LintOptions = {}): LintResult {
  const issues: LintIssue[] = [];
  if (!isObj(raw)) {
    issues.push({ level: 'error', event: 'PreToolUse', group: 0, text: 'Hooks must be an object keyed by event name, like {"PreToolUse": [...]}.' });
    return { issues, fixed: {} };
  }
  const fixed = structuredClone(raw) as Raw;
  const servers = opts.mcpServers ? new Set(opts.mcpServers) : undefined;

  /** Apply one fix to a fresh copy of the input, and also to the all-fixes copy. */
  const fixOne = (apply: (cfg: Raw) => void): HooksConfig => {
    const copy = structuredClone(raw) as Raw;
    apply(copy);
    apply(fixed);
    return copy as HooksConfig;
  };

  for (const [name, list] of Object.entries(raw)) {
    const event = name as HookEvent;
    if (!HOOK_EVENT_NAMES.includes(event)) {
      const known = FOREIGN_EVENTS[name];
      issues.push({
        level: 'warn',
        event: known ?? 'PreToolUse',
        group: 0,
        text: known ? `${name} is another CLI's name for ${known}. Claude Code and Conclave ignore it.` : `${name} is not a hook event. It is ignored. Events: ${HOOK_EVENT_NAMES.join(', ')}.`,
        ...(known && !(known in raw)
          ? {
              fix: fixOne((c) => {
                c[known] = c[name];
                delete c[name];
              }),
            }
          : {}),
      });
      continue;
    }
    if (!Array.isArray(list)) {
      issues.push({ level: 'error', event, group: 0, text: `${event} must be a list of groups, like [{"matcher": "Bash", "hooks": [...]}].` });
      continue;
    }
    list.forEach((g, gi) => {
      if (!isObj(g)) {
        issues.push({ level: 'error', event, group: gi, text: `Group ${gi + 1} of ${event} is not an object.` });
        return;
      }
      if (isFlat(g)) {
        issues.push({
          level: 'error',
          event,
          group: gi,
          text: `Group ${gi + 1} of ${event} is a bare handler with no "hooks" list, so it loads as nothing (in Claude Code too). Wrap it: {"matcher": ..., "hooks": [{"type": "command", "command": ...}]}.`,
          fix: fixOne((c) => {
            (c[event] as Raw[])[gi] = wrapFlat((c[event] as Raw[])[gi]);
          }),
        });
      } else if (!Array.isArray(g.hooks)) {
        issues.push({ level: 'error', event, group: gi, text: `Group ${gi + 1} of ${event} needs a "hooks" list.` });
        return;
      }
      const matcher = typeof g.matcher === 'string' ? g.matcher : undefined;
      if (g.matcher !== undefined && typeof g.matcher !== 'string') issues.push({ level: 'error', event, group: gi, text: `The matcher of group ${gi + 1} of ${event} must be a string.` });
      if (matcher && NO_MATCHER.has(event)) issues.push({ level: 'warn', event, group: gi, text: `${event} ignores matchers, so "${matcher}" has no effect. The handler runs every time.` });
      if (matcher && TOOL_EVENTS.has(event)) {
        const better = bareMcpMatcher(matcher);
        if (better) {
          issues.push({
            level: 'warn',
            event,
            group: gi,
            text: `Matcher "${matcher}" is an exact tool name, so it matches no MCP tool. Use "${better}" for all of that server's tools.`,
            fix: fixOne((c) => {
              const grp = (c[event] as Raw[])[gi];
              grp.matcher = better;
            }),
          });
        } else if (!exactNames(matcher) && matcher !== '*') {
          try {
            new RegExp(matcher);
          } catch {
            issues.push({ level: 'error', event, group: gi, text: `Matcher "${matcher}" is not a valid regex, so it only matches a tool with exactly that name.` });
          }
        }
        if (servers) {
          // server names may hold underscores (basic_memory, plugin_x_y): the name ends at the first "__"
          const m = /^\^?mcp__([A-Za-z0-9_-]+?)__/.exec(matcher);
          if (m && !servers.has(m[1]) && m[1] !== 'conclave') issues.push({ level: 'warn', event, group: gi, text: `Matcher "${matcher}" names MCP server ${m[1]}, which is not set up on this hub.` });
        }
      }
      const handlers = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [g];
      handlers.forEach((h, hi) => {
        if (!isObj(h)) {
          issues.push({ level: 'error', event, group: gi, handler: hi, text: `Handler ${hi + 1} in group ${gi + 1} of ${event} is not an object.` });
          return;
        }
        const type = h.type ?? (typeof h.command === 'string' ? 'command' : typeof h.prompt === 'string' ? 'prompt' : undefined);
        if (type !== 'command' && type !== 'prompt' && type !== 'mcp_tool') {
          issues.push({ level: 'error', event, group: gi, handler: hi, text: `Handler ${hi + 1} in group ${gi + 1} of ${event} has type ${JSON.stringify(h.type)}. Use "command", "prompt" or "mcp_tool".` });
          return;
        }
        if (type === 'command' && (typeof h.command !== 'string' || !h.command.trim())) issues.push({ level: 'error', event, group: gi, handler: hi, text: `A command handler in ${event} has no command.` });
        if (type === 'prompt' && (typeof h.prompt !== 'string' || !h.prompt.trim())) issues.push({ level: 'error', event, group: gi, handler: hi, text: `A prompt handler in ${event} has no prompt.` });
        if (type === 'mcp_tool') {
          if (typeof h.server !== 'string' || typeof h.tool !== 'string') issues.push({ level: 'error', event, group: gi, handler: hi, text: `An mcp_tool handler in ${event} needs "server" and "tool".` });
          else if (servers && !servers.has(h.server)) issues.push({ level: 'warn', event, group: gi, handler: hi, text: `The mcp_tool handler calls server ${h.server}, which is not set up on this hub.` });
        }
        if (h.timeout !== undefined) {
          if (typeof h.timeout !== 'number' || !(h.timeout > 0)) issues.push({ level: 'error', event, group: gi, handler: hi, text: `Timeout ${JSON.stringify(h.timeout)} in ${event} must be a positive number of seconds.` });
          else if (h.timeout > 600) {
            const secs = h.timeout >= 1000 ? Math.max(1, Math.round(h.timeout / 1000)) : undefined;
            issues.push({
              level: 'warn',
              event,
              group: gi,
              handler: hi,
              text: secs
                ? `Timeout ${h.timeout} is in seconds here (${Math.round(h.timeout / 60)} minutes). It looks like milliseconds; did you mean ${secs}?`
                : `Timeout ${h.timeout} seconds is over the 600 second default.`,
              ...(secs
                ? {
                    fix: fixOne((c) => {
                      const grp = (c[event] as Raw[])[gi];
                      const list2 = Array.isArray(grp.hooks) ? (grp.hooks as Raw[]) : [grp];
                      list2[hi].timeout = secs;
                    }),
                  }
                : {}),
            });
          }
        }
        if (typeof h.if === 'string' && h.if.trim()) {
          if (!TOOL_EVENTS.has(event)) issues.push({ level: 'warn', event, group: gi, handler: hi, text: `"if": "${h.if}" is ignored on ${event}; it filters tool calls only.` });
          else {
            const names = exactNames(matcher);
            const rule = parseRule(h.if);
            if (names && !names.some((n) => ruleToolMatches(rule.tool, n))) {
              issues.push({ level: 'warn', event, group: gi, handler: hi, text: `"if": "${h.if}" can never match: the group matcher only lets ${names.join(', ')} through.` });
            }
          }
        }
        if (type === 'command' && typeof h.command === 'string' && !h.timeout && !h.async && /\b(curl|wget)\b|https?:\/\//.test(h.command)) {
          issues.push({ level: 'warn', event, group: gi, handler: hi, text: 'This command calls the network and has no timeout. A slow server can hold the session for up to 10 minutes.' });
        }
      });
    });
  }
  return { issues, fixed: fixed as HooksConfig };
}

/** Only the wrapping of flat entries, so a save or import of a README config loads instead of failing. */
export function wrapFlatEntries(raw: unknown): { hooks: unknown; wrapped: number } {
  if (!isObj(raw)) return { hooks: raw, wrapped: 0 };
  let wrapped = 0;
  const out: Raw = {};
  for (const [event, list] of Object.entries(raw)) {
    out[event] = Array.isArray(list)
      ? list.map((g) => {
          if (isObj(g) && isFlat(g)) {
            wrapped++;
            return wrapFlat(g);
          }
          return g;
        })
      : list;
  }
  return { hooks: out, wrapped };
}
