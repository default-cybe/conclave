import { isAbsolute, relative, resolve } from 'node:path';
import type { PermissionMode } from '../types';
import type { Tool } from '../tools/types';
import { toolIsReadOnly } from '../tools/types';
import { gatedConstructs, heredocLines, maskSafeHeredocs, parseCommand, quoteEnd, readHeredoc, startsComment, substitutionBodies, type Heredoc } from '../tools/bash-rules';

/**
 * Permission rules use Claude Code syntax:
 *   "Bash"                 every Bash call
 *   "Bash(npm test:*)"     commands starting with "npm test"
 *   "Bash(git status)"     exact command
 *   "Read(./src/**)"       paths matching a glob (relative to cwd)
 *   "Edit(~/notes/**)"     home-relative glob
 *   "WebFetch(domain:github.com)"
 *   "mcp__github"          every tool from one MCP server (also "mcp__github__*")
 *   "mcp__github__create_issue"
 *
 * Order: deny beats ask beats allow. Then the permission mode decides.
 */
export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
  /**
   * WebFetch needs an allow rule (WebFetch(domain:x)) instead of passing as a
   * read-only tool. Set for routines made from a suggestion, whose allow list
   * is the whole contract while nobody watches: an unlisted domain is refused.
   */
  webFetchNeedsRule?: boolean;
  /**
   * Only an allow rule lets a call through: read-only tools ask like any
   * other, and bypass and acceptEdits modes allow nothing on their own. Set
   * for untrusted sessions (session/untrusted.ts), where a read can carry the
   * owner's files into a reply or a fetch.
   */
  askReadOnly?: boolean;
}

export interface PermissionCheck {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
  rule?: string;
}

interface ParsedRule {
  tool: string;
  content?: string;
  raw: string;
}

export function parseRule(raw: string): ParsedRule {
  // [\s\S]: an exact Bash rule may span lines (a command with a heredoc)
  const m = raw.trim().match(/^([^()]+?)(?:\(([\s\S]*)\))?$/);
  if (!m) return { tool: raw.trim(), raw };
  return { tool: m[1].trim(), content: m[2]?.trim() || undefined, raw };
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Claude Code treats Edit rules as covering every file-editing tool. */
function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName || ruleTool === '*') return true;
  // Claude Code renamed Task to Agent; rules written either way match the Task tool.
  if (ruleTool === 'Agent' && toolName === 'Task') return true;
  if (ruleTool === 'Edit' && EDIT_TOOLS.has(toolName)) return true;
  if (ruleTool.startsWith('mcp__') && toolName.startsWith(ruleTool + '__')) return true;
  // "mcp__github__*" is the same as "mcp__github": every tool of that server
  if (ruleTool.startsWith('mcp__') && ruleTool.endsWith('__*') && toolName.startsWith(ruleTool.slice(0, -1))) return true;
  return false;
}

/** Glob to regex: ** any depth, * one segment, ? one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function matchPath(pattern: string, absPath: string, cwd: string, home: string): boolean {
  let base: string;
  let pat = pattern;
  if (pat.startsWith('//')) {
    base = '/';
    pat = pat.slice(1);
  } else if (pat.startsWith('~/')) {
    base = home;
    pat = pat.slice(2);
  } else if (pat.startsWith('/')) {
    // Claude Code: "/x" is relative to the settings file dir; we use cwd as the project root
    base = cwd;
    pat = pat.slice(1);
  } else {
    base = cwd;
    if (pat.startsWith('./')) pat = pat.slice(2);
  }
  const rel = relative(base, absPath);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return globToRegExp(pat).test(rel) || globToRegExp(pat).test(rel + '/');
}

function contentMatches(rule: ParsedRule, toolName: string, content: string | undefined, cwd: string, home: string): boolean {
  if (rule.content === undefined) return true;
  if (content === undefined) return false;
  if (toolName === 'Bash' || rule.tool === 'Bash') {
    const c = content.trim();
    if (rule.content.endsWith(':*')) {
      const prefix = rule.content.slice(0, -2).trim();
      return c === prefix || c.startsWith(prefix + ' ');
    }
    if (rule.content.includes('*')) return globToRegExp(rule.content).test(c);
    return c === rule.content;
  }
  if (rule.content.startsWith('domain:')) return content === rule.content || content.endsWith('.' + rule.content.slice(7)) || content === `domain:${rule.content.slice(7)}`;
  // path-based tools
  const abs = isAbsolute(content) ? content : resolve(cwd, content);
  return matchPath(rule.content, abs, cwd, home);
}

/** Commands chained with && || ; | & and newlines must all be allowed, like Claude Code does. */
export function splitBashCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let docs: Heredoc[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // a quote must end where the shell ends it ($'\'' is one quote, \' is none), or a later command hides inside it
    if (c === '"' || c === "'" || (c === '$' && cmd[i + 1] === "'")) {
      const end = quoteEnd(cmd, i);
      cur += cmd.slice(i, end === -1 ? cmd.length : end);
      i = (end === -1 ? cmd.length : end) - 1;
      continue;
    }
    if (c === '\\') {
      cur += cmd.slice(i, i + 2);
      i++;
      continue;
    }
    // a comment runs to the end of its line, quotes in it included
    if (c === '#' && startsComment(cmd, i)) {
      const nl = cmd.indexOf('\n', i);
      cur += cmd.slice(i, nl === -1 ? cmd.length : nl);
      i = (nl === -1 ? cmd.length : nl) - 1;
      continue;
    }
    const doc = c === '<' ? readHeredoc(cmd, i) : undefined;
    if (doc) {
      docs.push(doc.doc);
      cur += cmd.slice(i, doc.next);
      i = doc.next - 1;
      continue;
    }
    if (c === '\n' && docs.length) {
      // each body line is a part of its own, as before, but read as plain text
      const body = heredocLines(cmd, i + 1, docs);
      parts.push(cur, ...body.lines.map((l) => l.text));
      cur = '';
      docs = [];
      i = body.next - 1;
      continue;
    }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      parts.push(cur);
      cur = '';
      continue;
    }
    // a single & runs the left side in the background and goes on: a separator too.
    // It stays part of a redirect (2>&1, &>, >&) and of |& (the pipe already split).
    if (c === '&') {
      const prev = cmd[i - 1];
      if (prev === '|') continue;
      if (prev !== '>' && prev !== '<' && cmd[i + 1] !== '>') {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A sub-command without the grouping around it: "(rm -rf x)" and "{ rm x; }" read as "rm -rf x" and "rm x". */
function ungrouped(part: string): string {
  return part.replace(/^[\s({!]+/, '').replace(/[\s)}]+$/, '').trim();
}

/**
 * Every command a Bash line may run, for deny and ask rules: each sub-command,
 * the same without grouping or quotes (the parser also splits on a single &),
 * and the sub-commands inside $( ), backticks and process substitution. The
 * body of a $(cat <<'EOF' ... EOF) substitution is text, not commands.
 */
export function bashRuleTargets(cmd: string): string[] {
  const out = new Set<string>();
  cmd = maskSafeHeredocs(cmd);
  for (const line of [cmd, ...substitutionBodies(cmd)]) {
    for (const part of splitBashCommand(line)) {
      out.add(part);
      const bare = ungrouped(part);
      if (bare) out.add(bare);
    }
    for (const words of parseCommand(line).segments) if (words.length) out.add(words.join(' '));
  }
  return [...out];
}

export interface CheckInput {
  tool: Tool;
  input: Record<string, any>;
  /** Rule content (command, path, domain). */
  content?: string;
  mode: PermissionMode;
  rules: PermissionRules;
  /** Session-scoped grants from "allow for this session". */
  sessionAllow: string[];
  cwd: string;
  home: string;
  /** Directories edits may touch without asking in acceptEdits mode. */
  workspaceRoots: string[];
}

export function checkPermission(c: CheckInput): PermissionCheck {
  const name = c.tool.name;
  const readOnly = toolIsReadOnly(c.tool, c.input);
  const rules = (list: string[]) => list.map(parseRule).filter((r) => toolMatches(r.tool, name));

  const matchAny = (list: ParsedRule[]): ParsedRule | undefined => {
    if (name === 'Bash' && c.content) {
      // every sub-command must match for allow; any sub-command matching is enough for deny/ask
      return list.find((r) => contentMatches(r, name, c.content, c.cwd, c.home));
    }
    return list.find((r) => contentMatches(r, name, c.content, c.cwd, c.home));
  };

  // deny: any sub-command hit denies, including commands inside $( ) and backticks
  const bashTargets = name === 'Bash' && c.content ? bashRuleTargets(c.content) : [];
  const denyRules = rules(c.rules.deny);
  for (const part of bashTargets) {
    const hit = denyRules.find((r) => contentMatches(r, name, part, c.cwd, c.home));
    if (hit) return { decision: 'deny', reason: `Denied by rule ${hit.raw}`, rule: hit.raw };
  }
  const deny = matchAny(denyRules);
  if (deny) return { decision: 'deny', reason: `Denied by rule ${deny.raw}`, rule: deny.raw };

  if (c.mode === 'plan' && !readOnly && name !== 'ExitPlanMode') {
    return { decision: 'deny', reason: 'Plan mode is read-only. Present a plan with ExitPlanMode first.' };
  }

  // ask: like deny, any sub-command hit asks
  const askRules = rules(c.rules.ask);
  const ask = matchAny(askRules) ?? bashTargets.map((p) => askRules.find((r) => contentMatches(r, name, p, c.cwd, c.home))).find(Boolean);
  if (ask) return { decision: 'ask', reason: `Rule ${ask.raw} requires approval`, rule: ask.raw };

  const allowList = rules([...c.rules.allow, ...c.sessionAllow]);
  /** Set when prefix rules matched but the command has constructs they never cover. */
  let gatedReason: string | undefined;
  if (name === 'Bash' && c.content) {
    const whole = c.content.trim();
    const gated = gatedConstructs(whole);
    // a $(cat <<'EOF' ... EOF) commit message is one word here, so its lines are not sub-commands
    const parts = splitBashCommand(maskSafeHeredocs(whole));
    if (gated.length) {
      // only a bare "Bash" rule or a rule naming this exact command covers substitution, redirects and the like;
      // the comparison is literal, so a suggested exact rule covers its command even when it contains *
      const exact = allowList.find((r) => r.content === undefined || r.content === whole);
      if (exact) return { decision: 'allow', reason: `Allowed by rule ${exact.raw}`, rule: exact.raw };
      // name the construct whenever a prefix rule matched any part, so the prompt says why the rule did not apply
      const used = [...new Set(parts.map((p) => allowList.find((r) => contentMatches(r, name, p, c.cwd, c.home))?.raw).filter((r): r is string => !!r))];
      if (used.length) gatedReason = `Needs approval: ${gated.join(', ')} ${gated.length > 1 ? 'are' : 'is'} not covered by ${used.join(', ')}`;
    } else if (parts.length && parts.every((p) => allowList.some((r) => contentMatches(r, name, p, c.cwd, c.home)))) {
      // name the rules that matched, for the Tools view and the audit trail
      const used = [...new Set(parts.map((p) => allowList.find((r) => contentMatches(r, name, p, c.cwd, c.home))!.raw))];
      return { decision: 'allow', reason: `Allowed by rule ${used.join(', ')}`, rule: used[0] };
    }
  } else {
    const allow = matchAny(allowList);
    if (allow) return { decision: 'allow', reason: `Allowed by rule ${allow.raw}`, rule: allow.raw };
  }

  // an untrusted session: nothing but an allow rule lets a call through
  if (c.rules.askReadOnly) return { decision: 'ask', reason: gatedReason ?? 'Needs approval: this session reads untrusted input' };
  if (c.mode === 'bypass') return { decision: 'allow', reason: 'Bypass mode' };
  // a fetch can carry data out, so a strict routine fetches only from the domains it lists
  if (readOnly && !(name === 'WebFetch' && c.rules.webFetchNeedsRule)) return { decision: 'allow', reason: 'Read-only tool' };
  if (c.mode === 'acceptEdits' && c.tool.editsFiles) {
    const path = c.content;
    if (!path || c.workspaceRoots.some((root) => !relative(root, path).startsWith('..'))) {
      return { decision: 'allow', reason: 'acceptEdits mode' };
    }
  }
  return { decision: 'ask', reason: gatedReason ?? 'Needs approval' };
}

/** Commands that should never run without a human, regardless of mode. */
const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd|vd)/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+0?777\s+\/(\s|$)/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  />\s*\/dev\/(sd|nvme|hd|vd)[a-z]/,
  /\bgit\s+push\s+.*--force\b.*\b(main|master)\b/,
];

export function dangerousCommand(cmd: string): string | undefined {
  for (const re of DANGEROUS) if (re.test(cmd)) return re.source;
  return undefined;
}
