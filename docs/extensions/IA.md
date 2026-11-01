# Extensions area: information architecture

One place in the app for everything that changes what an agent can do: tools, skills, commands, hooks, plugins and MCP servers, and where each one comes from. This doc is the brief for the UI team and the API contract the backend needs to serve it. Behaviour facts come from [COMPATIBILITY.md](COMPATIBILITY.md).

## Principles

1. **Explain in place.** Every tab opens with one sentence on what the thing is and when it runs. Every item shows its source, and whether Claude Code, Codex, OpenCode or Gemini CLI would see it too.
2. **Show what is in effect, then why.** Lists show the copy in use. A small "also defined in ..." line shows copies that are shadowed, and clicking it shows which file wins and why.
3. **Test before trust.** Hooks, MCP servers and permission rules each have a "Test" action that runs against real code paths and shows the raw result.
4. **Read-only where the file is not ours.** Built-in, plugin and other-CLI items open read-only with a "Copy to user" or "Copy to project" action. Only user (`~/.conclave`) and project (`.conclave/`) items are edited in place.
5. **Same words as the files.** Use the names people see in their CLIs: `PreToolUse`, `hookify:help`, `mcp__github__create_issue`. Add a plain gloss next to each, never instead of it.

## Navigation

```
Extensions
  Overview
  Tools
  Skills
  Commands
  Hooks
  Plugins        (Installed | Marketplace)
  MCP servers
  Sources        (where things load from, conflicts, sync to other CLIs)
```

Agents keep their own top-level area; each agent page links into Tools (what it can use) and Skills (what it preloads). On a phone the tabs become a list; each tab is a full screen with a back button.

A project picker sits in the header (default: the folder of the current session, or "No project"). Project scope changes what loads (`.claude/`, `.conclave/`, `.agents/`, `.opencode/`, `.gemini/`), so every view and API call takes `cwd`.

## Overview

Purpose: answer "what is loaded, and is anything broken?"

- Counts: tools (built-in, MCP), skills, commands, hooks (handlers per event), plugins (enabled of installed), MCP servers (connected of enabled).
- Problems first, each linking to its tab: MCP servers that failed, hooks whose last run errored or timed out, names that clash (shadowed items), hook events configured but not fired by the engine yet.
- Other CLIs: one row per CLI with its compat toggle (`compat.claudeCode`, `compat.codex`, `compat.opencode`, `compat.gemini`), how many items it adds, and whether that CLI is installed on the selected device.
- Quick actions: "Install a plugin", "Add an MCP server", "Connect memory to my CLIs", "Sync to other CLIs".

## Tools

Explainer: "Tools are the actions an agent can take. Built-in tools ship with Conclave; MCP tools come from servers you connect."

- Grouped: Built-in (file, shell, web, agents and planning, memory, other) and one group per MCP server.
- Each row: name, one-line description, read-only badge, which agents can use it, and the permission that applies right now.
- **Which agents see it**: per agent, "yes", "no: not in its tools list", "no: in disallowedTools", "no: untrusted agent", or "only these MCP servers". Clicking an agent opens it.
- **Permission**: the rule that decides (`allow`, `ask` or `deny`) with the rule text and where it is defined (config, `.claude/settings.json`, ...), or the mode default when no rule matches. Inline "Always allow", "Always ask", "Deny" buttons add a rule at user or project scope.
- **Test a call**: a small form (pick tool, agent, mode, input JSON; for Bash just a command) that returns the decision and the reason. Uses the same code as the runner, so `rm -rf /` shows the dangerous-command guard.
- Hook note on each tool: "2 hooks run before this tool" linking to Hooks filtered by matcher.

## Skills

Explainer: "A skill is a folder of instructions an agent loads when a task needs it. Only the name and description sit in the prompt until then."

- Row: name (as typed, e.g. `superpowers:brainstorming`), description, source badge, plugin, path.
- Detail: rendered `SKILL.md`, file list of the folder, `allowed-tools`, which agents preload it, "Use as a command" hint (`/name`), and which CLIs also see it (Claude: `~/.claude/skills`; Codex, OpenCode, Gemini: `~/.agents/skills`).
- Shadowed copies listed under the winner with their scope.
- Actions: New skill (user or project), Copy to user, Open folder, Sync to other CLIs.

## Commands

Explainer: "A command is a saved prompt you run with /name. Arguments fill placeholders in the text."

- Row: `/name`, description, argument hint, source, argument style badge (Claude, Codex, OpenCode, Gemini).
- Detail: the template, an **argument preview**: type sample args and see the expanded text without running `!` shell snippets (they show as "would run: git diff --staged"). A second button runs the full expansion on the selected device.
- Skills that double as commands show here too with a "skill" tag.
- Name clashes: if two plugins define `help`, the list shows `hookify:help` and `ralph-loop:help` and a note that plain `/help` needs the prefix.

## Hooks

Explainer: "Hooks are your scripts that run at fixed points in a session. They can block an action, change its input, or add context for the model."

Events in lifecycle order, each a section with a one-line gloss and a status pill:

| Order | Event | Gloss | Matcher value | Can |
| --- | --- | --- | --- | --- |
| 1 | `SessionStart` | When a session starts, resumes, is cleared or compacted | `startup`, `resume`, `clear`, `compact` | add context |
| 2 | `UserPromptSubmit` | Before your message reaches the model | none | block, add context |
| 3 | `PreToolUse` | Before a tool runs | tool name | block, allow, ask, rewrite input |
| 4 | `PermissionRequest` | When Conclave is about to ask you | tool name | allow or deny for you |
| 5 | `PostToolUse` | After a tool succeeds | tool name | add feedback, stop the turn |
| 6 | `PostToolUseFailure` | After a tool fails | tool name | add feedback |
| 7 | `Notification` | When Conclave notifies you | notification type | side effects only |
| 8 | `SubagentStart` | When a subagent starts | agent name | add context |
| 9 | `SubagentStop` | When a subagent finishes | agent name | make it continue |
| 10 | `PreCompact` | Before old messages are summarized | `manual`, `auto` | block, add instructions |
| 11 | `Stop` | When the agent is about to finish its turn | none | make it continue |
| 12 | `SessionEnd` | When a session is deleted or the hub stops | reason | side effects only (1.5 s) |

- Status pill per event: "Runs" or "Not fired yet" (from `fires` in the API) so people do not configure hooks that never run.
- Each handler row: command or prompt (monospace, plugin root shown as `${CLAUDE_PLUGIN_ROOT}` with the real path on hover), matcher, `if` rule, timeout, async flag, source (config, project file path, plugin name), and the **last result**: time, exit code, duration, outcome (allow, deny, ask, block, context, error, timeout), with stdout and stderr in a drawer.
- **Test runner**: pick event, edit a sample input (prefilled per event with realistic fields: a Bash command for PreToolUse, a prompt for UserPromptSubmit), set the matcher value, run. Shows each handler's trace and the merged outcome in plain words: "Blocked. The model would see: cg-exit2 is not allowed here." Tests run real commands on the hub; the run button says so.
- Add or edit: a form per handler (event, matcher, type, command, timeout, `if`), saved at user scope (`config.json`) or project scope (`.conclave/settings.json`). Plugin and Claude project hooks are read-only here.
- Import: "Import from Gemini CLI" and "Import from Codex" show a preview with renamed events, converted timeouts, skipped events and behaviour notes, then save to the chosen scope.
- Warnings shown inline: a project hook from `.claude/settings.json` in a folder you have not opened before; a hook with no timeout that calls the network; Codex hooks with hyphenated matchers.

## Plugins

Explainer: "A plugin bundles skills, commands, agents, hooks and MCP servers. Conclave uses the Claude Code plugin format, which Codex also reads."

**Installed**

- Card: name, version, description, source (marketplace, git, local), enabled toggle, and what it adds as chips: "3 agents, 4 commands, 1 skill, 4 hooks, 1 MCP server".
- Detail: manifest fields; each component listed with a link to its tab; hooks listed with their events; MCP servers with live status; folder path; "Update" (re-fetch from source), "Remove" (also deletes its data folder), "Copy install command for Claude Code / Codex".
- Disabled plugins stay listed, greyed, with everything they would add.

**Marketplace**

- Search box over every added marketplace; filters: category, marketplace, installed.
- Entry: name, description, category, source kind (in repo, GitHub, git), install button. Installing shows a short preview of what the plugin adds and warns when it has hooks or MCP servers, since those run code.
- "Add marketplace" takes `owner/repo`, a git URL or a local path.

## MCP servers

Explainer: "MCP servers give agents extra tools, such as your notes, GitHub or a homelab API. Each tool appears as `mcp__<server>__<tool>`."

- Row: name, status (connected, connecting, failed, disabled), transport (stdio, http, sse), tool count, origin (config, project `.mcp.json`, plugin name), last error.
- Actions per server: **Restart**, **Test** (reconnect, report time and tool count), **Tools** (list with schemas and read-only flags; "Try" runs one tool with JSON input after a confirm), Enable or disable, Edit, Remove.
- **Add**: a form (stdio command and args, or URL and headers; env values can point at `${env:NAME}` or `${secret:name}`), or "Paste from another CLI" which accepts a Claude `.mcp.json`, Codex `config.toml`, OpenCode `opencode.json` or Gemini `settings.json` and shows what will be added.
- **Connect to my CLIs**: for one server (the common case is memory: Basic Memory over stdio, or a memory server on the homelab over Tailscale), show one step per CLI with a copyable command (`claude mcp add-json ...`, `codex mcp add ...`, `gemini mcp add ...`) or the JSON to paste for OpenCode, plus each CLI's quirk (Gemini ignores MCP in untrusted folders). Where a device is connected, offer "Run on <device>" per step after a confirm.
- Project `.mcp.json` servers are marked "from this project" and need a one-time approval before they connect (backend gap, see below).

## Sources

Explainer: "Conclave reads extensions from several places. When two define the same name, the one lower in this list wins."

- Ordered list (low to high precedence): Built-in, Shared `~/.agents` and `.agents/`, Codex, OpenCode, Gemini CLI, Claude Code (user then project), Plugins, User (`~/.conclave`), Project (`.conclave/`). Each row: on or off (compat toggles; built-in, plugins, user and project are always on), the folders it reads, counts per kind.
- **Conflicts**: every name defined more than once, with the winner, the shadowed copies and their scopes. Clicking opens both files side by side.
- **Sync to other CLIs**: pick a device and CLIs (detected installs are pre-checked). "Preview" lists the files that would be written (dry run); "Sync" writes them. Explains the rules: Conclave only overwrites files it created (marker files), skills go to `~/.claude/skills` and `~/.agents/skills`, agents go out in each CLI's own format.

## Copy notes

- Short sentences, no marketing words. Use "runs", "blocks", "adds context", "shadowed by".
- Never hide the raw value: show `PreToolUse` and `mcp__github__create_issue` as they are.
- Errors say what to do: "Failed to start: `uvx` not found on the hub. Install uv or use the full path."

---

## Backend API

All routes take `cwd` (project folder, optional) and `device` (optional, default the hub) as query parameters where it matters. Existing routes stay as they are; new ones are marked **new**. Shapes are TypeScript-like.

### Shared types

```ts
type Source = 'builtin' | 'user' | 'project' | 'plugin' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'agents';

interface InventoryItem {            // Extensions.inventory(cwd)
  kind: 'agent' | 'skill' | 'command';
  name: string; description?: string;
  source: Source; plugin?: string; path?: string;
  scope: string;                     // e.g. "claude user", "opencode project /repo"
  active: boolean; shadowedBy?: string;
}

interface HookTrace {                // from Hooks.run / Hooks.recent
  event: HookEvent; type: 'command' | 'prompt' | 'function';
  label: string; plugin?: string;
  exitCode?: number; stdout?: string; stderr?: string;
  durationMs: number; timedOut?: boolean;
  result: 'allow' | 'deny' | 'ask' | 'block' | 'rewrite' | 'context' | 'stop' | 'noop' | 'error' | 'timeout' | 'async' | 'skipped';
}
```

### 1. Overview **new**

`GET /api/extensions/overview?cwd=`

```json
{
  "counts": { "tools": 31, "mcpTools": 12, "skills": 40, "commands": 22, "hookHandlers": 9, "plugins": { "installed": 6, "enabled": 5 }, "mcpServers": { "enabled": 4, "connected": 3 } },
  "compat": { "claudeCode": true, "agentsMd": true, "codex": false, "opencode": true, "gemini": false },
  "clis": { "claude": "2.1.301", "codex": null, "opencode": "1.19.3", "gemini": null },
  "problems": [
    { "kind": "mcp", "name": "playwright", "message": "Process exited with code 1" },
    { "kind": "hook", "event": "PreToolUse", "message": "last run timed out after 30000ms" },
    { "kind": "conflict", "name": "code-reviewer", "message": "defined in 2 places" },
    { "kind": "event", "event": "SessionStart", "message": "3 handlers configured, event not fired yet" }
  ]
}
```

Backed by: `extensions.inventory(cwd)`, `mcp.status()`, `hooks.recent()`, `config.get().compat`, `machine.info().clis`.

### 2. Inventory **new**

`GET /api/extensions/inventory?cwd=&kind=` returns `InventoryItem[]`. Backed by `Extensions.inventory(cwd)`.

### 3. Tools

`GET /api/tools?cwd=&agent=` (extend the existing route; today it omits MCP tools)

```json
[
  {
    "name": "Bash", "kind": "builtin", "description": "Run a shell command", "readOnly": false,
    "agents": [ { "name": "coder", "visible": true }, { "name": "librarian", "visible": false, "why": "not in tools list" } ],
    "permission": { "decision": "ask", "reason": "Needs approval", "rule": null, "ruleSource": null },
    "hooks": { "PreToolUse": 2, "PostToolUse": 1 }
  },
  { "name": "mcp__memory__search_notes", "kind": "mcp", "server": "memory", "readOnly": true, "agents": [], "permission": { "decision": "allow", "reason": "Read-only tool" } }
]
```

`POST /api/tools/check` **new**

```json
// request
{ "tool": "Bash", "input": { "command": "git push origin main" }, "agent": "coder", "mode": "default", "cwd": "/home/me/repo" }
// response: PermissionCheck plus the dangerous-command guard
{ "decision": "ask", "reason": "Rule Bash(git push *) requires approval", "rule": "Bash(git push *)", "ruleSource": ".claude/settings.json", "dangerous": false }
```

Backed by `checkPermission` and `dangerousCommand` in `session/permissions.ts`, `engine.permissionRulesFor`.

### 4. Hooks **new**

`GET /api/hooks?cwd=`

```json
{
  "events": [
    {
      "event": "PreToolUse", "fires": true,
      "groups": [
        { "matcher": "Bash", "source": "plugin", "plugin": "hookify", "path": "~/.conclave/plugins/hookify/hooks/hooks.json",
          "hooks": [ { "type": "command", "command": "python3 \"/.../hooks/pretooluse.py\"", "timeout": 10, "if": null, "async": false } ] }
      ],
      "last": [ /* HookTrace & { at, sessionId } */ ]
    },
    { "event": "SessionStart", "fires": false, "groups": [], "last": [] }
  ]
}
```

`fires` comes from a constant in the engine listing the events it fires. `last` from `Hooks.recent({ event })`. Groups are the merged config, plugin and project hooks with their origin (the merge in `engine/create.ts` needs to keep the origin).

`POST /api/hooks/test`

```json
// request
{ "event": "PreToolUse", "cwd": "/home/me/repo", "matcherValue": "Bash",
  "input": { "tool_name": "Bash", "tool_input": { "command": "rm -rf build" } },
  "only": { "source": "config", "index": 0 } }
// response: HookOutcome
{ "blocked": true, "reason": "rm is not allowed here", "permissionDecision": null, "updatedInput": null,
  "additionalContext": [], "systemMessages": [],
  "trace": [ { "event": "PreToolUse", "type": "command", "label": "~/hooks/guard.sh", "exitCode": 2, "stderr": "rm is not allowed here", "durationMs": 31, "result": "block" } ],
  "modelWouldSee": "Blocked by hook: rm is not allowed here" }
```

Backed by `Hooks.run` with a filled `HookInput` (session id `test`). `Hooks.plan` gives the handler list without running.

`PUT /api/hooks` with `{ "scope": "user" | "project", "cwd"?: string, "hooks": HooksConfig }` writes `config.json` or `.conclave/settings.json`.

`POST /api/hooks/import` with `{ "from": "gemini" | "codex", "cwd"?: string }` returns `{ hooks: HooksConfig, skipped: string[], notes: string[] }` (from `compat.readForeignHooks`); the client then calls `PUT /api/hooks`.

### 5. Plugins

Existing: `GET /api/plugins`, `POST /api/plugins {source}`, `PATCH /api/plugins/:name {enabled}`, `DELETE /api/plugins/:name`.

`GET /api/plugins/:name` **new**, backed by `Extensions.pluginDetail(name)`:

```json
{
  "name": "hookify", "dir": "~/.conclave/plugins/hookify", "enabled": true, "source": "hookify@claude-plugins-official", "installedAt": 1792160000000,
  "manifest": { "name": "hookify", "description": "...", "author": { "name": "Anthropic" } },
  "agents": [ { "name": "hookify:conversation-analyzer", "description": "..." } ],
  "skills": [ { "name": "hookify:writing-rules", "description": "..." } ],
  "commands": [ { "name": "hookify:help", "description": "..." } ],
  "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command", "command": "python3 \".../pretooluse.py\"", "timeout": 10 } ] } ] },
  "mcpServers": { "plugin_hookify_x": { "command": "..." } }
}
```

`POST /api/plugins/:name/update` **new**: re-install from the recorded source, keep the enabled flag.

### 6. Marketplace

Existing: `GET /api/marketplace`, `POST /api/marketplace {source}`.

`GET /api/marketplace/search?q=&category=&marketplace=` **new**

```json
{
  "marketplaces": [ { "name": "claude-plugins-official", "source": "anthropics/claude-plugins-official", "plugins": 315 } ],
  "results": [
    { "name": "hookify", "description": "...", "category": "productivity", "marketplace": "claude-plugins-official",
      "sourceKind": "path", "installed": true, "enabled": true, "install": "hookify@claude-plugins-official" }
  ]
}
```

Search is a case-insensitive match on name, description and category over `marketplaces()`; `installed` from `plugins()`.

### 7. MCP servers

Existing: `GET /api/mcp` returns `McpStatus[]`. Extend each entry with `origin: "config" | "project" | "plugin"`, `plugin?`, `transport`.

`POST /api/mcp/:name/restart` **new**: `McpManager.restart(name)` returns the new `McpStatus`.

`POST /api/mcp/:name/test` **new**: `McpManager.test(name)` returns `{ "ok": true, "ms": 412, "tools": 12, "error": null }`.

`GET /api/mcp/:name/tools` **new**: `McpManager.serverTools(name)`:

```json
[ { "name": "search_notes", "fullName": "mcp__memory__search_notes", "description": "...", "inputSchema": { "type": "object" }, "readOnly": true } ]
```

`POST /api/mcp/:name/call` **new**: `{ "tool": "search_notes", "args": {} }` returns `ToolOutput`. Asks for confirmation in the UI when the tool is not read-only.

`POST /api/mcp` **new**: `{ "name": "memory", "config": McpServerConfig, "scope": "user" | "project" }`.

`POST /api/mcp/import` **new**: `{ "from": "claude" | "codex" | "opencode" | "gemini", "text": "<file content>" }` returns `Record<string, McpServerConfig>` for preview (`compat.mcpFromClaude`, `mcpFromCodexToml`, `mcpFromOpenCode`, `mcpFromGemini`).

`GET /api/mcp/:name/connect` **new**: `mcpConnectPlan(name, config)`:

```json
[
  { "cli": "claude", "command": "claude mcp add-json -s user memory '{\"type\":\"stdio\",\"command\":\"uvx\",\"args\":[\"basic-memory\",\"mcp\"]}'", "file": "~/.claude.json (mcpServers)", "snippet": "{...}" },
  { "cli": "codex", "command": "codex mcp add memory -- uvx basic-memory mcp", "file": "~/.codex/config.toml", "snippet": "[mcp_servers.memory]\n..." },
  { "cli": "opencode", "file": "~/.config/opencode/opencode.json (mcp)", "snippet": "{...}", "note": "OpenCode exposes the tools as <server>_<tool>." },
  { "cli": "gemini", "command": "gemini mcp add -s user memory uvx basic-memory mcp", "file": "~/.gemini/settings.json (mcpServers)", "snippet": "{...}", "note": "..." }
]
```

`POST /api/mcp/:name/connect` **new**: `{ "device": "madx", "clis": ["claude", "codex"] }` runs the commands on that device through `Machine.exec` and returns `{ cli, exitCode, stdout, stderr }[]`.

### 8. Sources and sync

`GET /api/extensions/sources?cwd=` **new**

```json
[
  { "id": "builtin", "label": "Built-in", "on": true, "toggle": null, "paths": [], "counts": { "agents": 11, "skills": 0, "commands": 0 } },
  { "id": "agents", "label": "Shared ~/.agents", "on": false, "toggle": ["codex", "opencode", "gemini"], "paths": ["~/.agents/skills", "<cwd>/.agents/skills"], "counts": { "skills": 0 } },
  { "id": "claude", "label": "Claude Code", "on": true, "toggle": "claudeCode", "paths": ["~/.claude", "<cwd>/.claude"], "counts": { "agents": 2, "skills": 5, "commands": 3 } }
]
```

Counts come from `inventory(cwd)` grouped by source; toggles are `PATCH /api/config { compat: {...} }` (existing route).

`POST /api/sync-clis` (existing) gains `{ "device"?: string, "only"?: ["claude","codex","opencode","gemini"], "dryRun"?: boolean }` and returns `{ "ok": true, "written": ["/home/me/.config/opencode/agent/reviewer.md", "..."] }`. With `dryRun` nothing is written.

## Backend gaps this design depends on

- The engine does not fire `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Notification`, `PermissionRequest` yet; until it does, the Hooks tab shows them as "Not fired yet".
- `engine.listTools()` returns no MCP tools today.
- `McpStatus.source` is the transport; the origin (config, project, plugin) is not tracked.
- Hook origin is lost in the merge in `engine/create.ts`; keep it for the Hooks tab.
- Project `.mcp.json` servers and `.claude/settings.json` hooks need a one-time approval step.
- New sources (`codex`, `opencode`, `gemini`, `agents`) are not yet styled in the web app; agent pages treat unknown sources as editable user files.
