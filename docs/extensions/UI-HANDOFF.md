# UI hand-off: new hub API for Extensions, memory connections and agent defaults

Everything below is live on the hub and typed in `packages/core/src/client/index.ts`. All changes there are additive: no existing method or type changed shape, and new fields on existing types are optional. Every route takes the normal bearer token. Errors come back as `{ "error": "<plain message>" }` with 400 (bad input), 404 (unknown name or id), 409 (conflict, disabled, device offline), 501 (not available on this hub) or 502 (an outside service failed). The messages are written for people and can be shown as they are.

The screens these feed are described in [IA.md](IA.md). Behaviour per CLI is in [COMPATIBILITY.md](COMPATIBILITY.md); the user-facing explanation is [../EXTENSIONS.md](../EXTENSIONS.md).

Conventions: `cwd` is the project folder picked in the header (absolute path on the hub); leave it out for "No project". `device` defaults to the hub (`local`). A hub with these routes lists `extensions`, `memory-connections`, `mcp-server` and `project-trust` in `info().features`, so the app can hide screens when talking to an older hub.

## Agents: shipped defaults

| Client method | Route | Returns |
| --- | --- | --- |
| `agentDefault(name)` | `GET /api/agents/:name/default` | `AgentDefaultInfo` (404 when `name` is not built in) |

```ts
interface AgentDefaultInfo {
  name: string;
  markdown: string;        // the shipped file: frontmatter + prompt (show in a read-only code view)
  agent: AgentDef;         // the shipped profile
  active?: AgentDef;       // the profile in use now
  overridden: boolean;     // a user/project/plugin/other-CLI copy replaces it
  activeSource?: string;   // "builtin", "user", "claude", ...
  resettable: boolean;     // true when deleteAgent(name) brings the shipped one back
}
```

UI: on a built-in agent's page show "Shipped default" next to the edited copy (a diff view works well), and a "Reset to default" button when `resettable` that calls the existing `deleteAgent(name)`. `agents()` still lists sources as before; built-in agents now come from markdown files but their fields are the same.

## Extensions overview, inventory, sources

| Client method | Route | Returns |
| --- | --- | --- |
| `extensionsOverview(cwd?)` | `GET /api/extensions/overview?cwd&device` | `ExtensionsOverview` |
| `extensionsInventory({ cwd?, kind? })` | `GET /api/extensions/inventory?cwd&kind` | `InventoryItemDto[]` (kind: agent, skill, command) |
| `extensionSources(cwd?)` | `GET /api/extensions/sources?cwd` | `ExtensionSourceInfo[]`, low to high precedence |

```ts
interface ExtensionsOverview {
  counts: { tools; mcpTools; agents; skills; commands; hookHandlers: number;
            plugins: { installed; enabled }; mcpServers: { enabled; connected } };
  compat: { claudeCode; agentsMd; codex; opencode; gemini: boolean };   // toggle with updateConfig({ compat: {...} })
  clis: { claude; codex; opencode; gemini: string | null };              // version on the device, null = not installed
  problems: Array<{ kind: 'mcp' | 'hook' | 'conflict' | 'event' | 'trust'; name?; event?; message: string }>;
  trust?: ProjectTrustInfo;                                              // when cwd is given
}
interface InventoryItemDto { kind; name; description?; source: ExtensionSourceId; plugin?; path?; scope: string; active: boolean; shadowedBy?: string }
interface ExtensionSourceInfo { id: ExtensionSourceId; label; on: boolean; toggle: string | string[] | null; paths: string[]; counts: { agents; skills; commands } }
type ExtensionSourceId = 'builtin' | 'user' | 'project' | 'plugin' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'agents';
```

- Problems link to their tab: `mcp` to MCP servers, `hook` and `event` to Hooks, `conflict` to Sources, `trust` to the trust banner.
- `toggle` is the key under `compat` for `updateConfig({ compat: { opencode: true } })`. For `agents` it is a list: any of `codex`, `opencode`, `gemini` turns it on.
- **Styling needed:** sources `codex`, `opencode`, `gemini` and `agents` are new. Today the agents page treats unknown sources as editable user files; they are read-only (offer "Copy to user").

## Tools

| Client method | Route | Returns |
| --- | --- | --- |
| `toolsDetail({ cwd?, agent? })` | `GET /api/tools?cwd&agent` | `ToolDetail[]` |
| `checkTool(input)` | `POST /api/tools/check` | `ToolCheckResult` |

`GET /api/tools` now returns `ToolDetail`, a superset of `ToolInfo`, so the old `tools()` method keeps working. MCP tools are included now (they were missing before).

```ts
interface ToolDetail extends ToolInfo {          // name, description, readOnly, source: 'builtin' | 'mcp', server?
  kind: 'builtin' | 'mcp';
  group: string;                                  // file, shell, web, agents, memory, browser, other, or the MCP server name
  agents: Array<{ name: string; visible: boolean; why?: string }>;   // why: "not in its tools list", "in disallowedTools",
                                                  // "untrusted agent", "not in its mcpServers", "opt-in tool, name it in the tools list"
  permission: { decision: 'allow' | 'ask' | 'deny'; reason: string; rule?: string | null; ruleSource?: string | null };
  hooks: Partial<Record<HookEvent, number>>;      // e.g. { PreToolUse: 2 } -> "2 hooks run before this tool"
  optIn?: boolean;
}
// POST /api/tools/check
interface ToolCheckInput { tool: string; input?: object; agent?: string; mode?: PermissionMode; cwd?: string }
interface ToolCheckResult { decision; reason; rule?; ruleSource?;   // ruleSource: "config", a settings file path, "agent" or null
                            dangerous: string | false;              // the dangerous-command guard fired
                            hooks: number }                         // PreToolUse handlers that would run
```

`permission` is the decision for a call with no input in the session's default mode; use `checkTool` with real input for the "Test a call" form. Inline "Always allow" / "Deny" buttons can append to `permissions.allow` / `deny` with `updateConfig`.

## Hooks

| Client method | Route | Returns |
| --- | --- | --- |
| `hooks(cwd?)` | `GET /api/hooks?cwd` | `HooksOverview` |
| `testHook(input)` | `POST /api/hooks/test` | `HookTestResult` |
| `saveHooks({ scope, cwd?, hooks })` | `PUT /api/hooks` | `{ ok: true }` |
| `importHooks(from, cwd?)` | `POST /api/hooks/import` | `HookImportResult` (preview only) |

```ts
interface HooksOverview { events: HookEventInfo[]; trust?: ProjectTrustInfo }
interface HookEventInfo {
  event: HookEvent;               // all 12, in lifecycle order: SessionStart ... SessionEnd
  gloss: string;                  // one plain sentence, ready to show
  matcherValue: string | null;    // what a matcher is compared with; null = matchers ignored
  fires: boolean;                 // true for every event now
  groups: HookGroupDto[];
  last: HookRunDto[];             // up to 10 recent runs, newest last
}
interface HookGroupDto {
  matcher?: string;
  source: 'claude-user' | 'config' | 'plugin' | 'claude-project' | 'project';
  path?: string; plugin?: string;
  index: number;                  // pass with source in testHook({ only }) to run just this group
  active: boolean;                // false = project hook in an untrusted folder (show greyed with the trust banner)
  editable: boolean;              // config and project (.conclave/settings.json); others are read-only
  hooks: Array<{ type: 'command' | 'prompt'; command?; prompt?; args?; model?; timeout?; if?; async?; shell?; plugin?; pluginRoot? }>;
}
interface HookRunDto { event; type; label; plugin?; exitCode?; stdout?; stderr?; durationMs; timedOut?; result: string; at: number; sessionId: string }
// result: allow, deny, ask, block, rewrite, context, stop, noop, error, timeout, async, skipped

interface HookTestInput { event: HookEvent; input?: object; matcherValue?: string; cwd?: string;
                          only?: { source?; plugin?; index?; path? } }
interface HookTestResult { blocked; reason?; permissionDecision?; updatedInput?; updatedToolOutput?;
                           additionalContext: string[]; systemMessages: string[]; stop?;
                           trace: HookTraceDto[];       // one per handler that ran
                           modelWouldSee: string }      // plain words, e.g. "Blocked. The model would see: Blocked by hook: ..."
interface HookImportResult { hooks: HooksConfig; skipped: string[]; notes: string[] }
```

- Test runs execute the real commands on the hub (session id `test`); the Run button should say so. Only active groups run, so a project hook runs in a test only after the folder is trusted. `matcherValue` defaults to the matching field of the sample input (`tool_name`, `source`, `trigger`, `reason`, `agent_type`, `notification_type`).
- Suggested sample inputs: PreToolUse `{ "tool_name": "Bash", "tool_input": { "command": "git push origin main" } }`; UserPromptSubmit `{ "prompt": "deploy it" }`; SessionStart `{ "source": "startup" }`; Stop `{ "stop_hook_active": false, "last_assistant_message": "Done." }`.
- `saveHooks` replaces all hooks at that scope: send the full list for the scope, not a patch. `user` writes `config.json`; `project` writes `<cwd>/.conclave/settings.json` and keeps its other keys. Validation errors name the field (`hooks.Stop[0].hooks[1].command is required`).
- Import flow: `importHooks('gemini' | 'codex', cwd)` gives a preview with skipped events and notes; save with `saveHooks`.

### Project trust

| Client method | Route | Returns |
| --- | --- | --- |
| `projectTrust(cwd)` | `GET /api/trust?cwd` | `ProjectTrustInfo` |
| `setProjectTrust(cwd, trusted)` | `POST /api/trust` | `ProjectTrustInfo` |

```ts
interface ProjectTrustInfo { cwd: string; trusted: boolean; hooks: number; allow: number; mcpServers: number; files: string[] }
```

New behaviour: hooks and allow rules from a project's `.claude/settings*.json` and `.conclave/settings*.json` stay off until the folder is trusted (deny and ask rules always apply). Show a banner in Hooks and Tools when `!trusted && (hooks || allow)`: "This folder has N hooks and M allow rules that stay off until you trust it", listing `files`, with a "Trust this folder" button. Trust covers subfolders. Sessions in such a folder also get a notice message on their first turn.

## Plugins and marketplace

| Client method | Route | Returns |
| --- | --- | --- |
| `pluginDetail(name)` | `GET /api/plugins/:name` | `PluginDetailDto` |
| `updatePlugin(name)` | `POST /api/plugins/:name/update` | `InstalledPlugin` (keeps the enabled flag; 502 when the source cannot be fetched) |
| `searchMarketplace({ q?, category?, marketplace? })` | `GET /api/marketplace/search` | `MarketplaceSearchResult` |

```ts
interface PluginDetailDto extends InstalledPlugin { agents: AgentDef[]; skills: SkillDef[]; commands: CommandDef[];
                                                    hooks: HooksConfig; mcpServers: Record<string, McpServerConfig> }
interface MarketplaceSearchResult { marketplaces: Array<{ name: string; plugins: number }>; results: MarketplaceSearchItem[] }
interface MarketplaceSearchItem { name; description?; category?; version?; marketplace: string;
                                  sourceKind: string;    // path, github, git, url, other
                                  installed: boolean; enabled: boolean;
                                  install: string }      // pass to installPlugin(), e.g. "hookify@claude-plugins-official"
```

Chips for a plugin card come from `PluginDetailDto` lengths ("3 agents, 4 commands, 1 skill, 4 hooks, 1 MCP server"). Warn before installing when the detail has hooks or MCP servers. Plugin parts are named `plugin:name`; a plugin MCP server is `plugin_<plugin>_<server>` (it was `<plugin>-<server>`, so saved allow rules for the old name need renaming).

## MCP servers

| Client method | Route | Returns |
| --- | --- | --- |
| `mcp()` (existing) | `GET /api/mcp` | `McpStatus[]`, now with `origin`, `plugin`, `transport`, `enabled` |
| `addMcpServer(name, config)` | `POST /api/mcp` `{ name, config, scope: 'user' }` | `McpStatus` (409 if the name exists) |
| `updateMcpServer(name, { enabled?, config? })` | `PATCH /api/mcp/:name` | `McpStatus` (400 for plugin servers) |
| `removeMcpServer(name)` | `DELETE /api/mcp/:name` | `{ ok: true }` |
| `restartMcp(name)` | `POST /api/mcp/:name/restart` | `McpStatus` |
| `testMcp(name)` | `POST /api/mcp/:name/test` | `{ ok, ms, tools, error? }` |
| `mcpTools(name)` | `GET /api/mcp/:name/tools` | `McpToolDto[]` |
| `callMcpTool(name, tool, args)` | `POST /api/mcp/:name/call` | `{ content, isError? }` |
| `importMcp(from, text)` | `POST /api/mcp/import` | `Record<string, McpServerConfig>` (preview, nothing saved) |
| `mcpConnectPlan(name)` | `GET /api/mcp/:name/connect` | `McpConnectStepDto[]` |
| `connectMcp(name, device, clis)` | `POST /api/mcp/:name/connect` | `McpConnectRunResult[]` |

```ts
interface McpStatus { name; status: 'connected' | 'connecting' | 'failed' | 'disabled'; tools: number; error?; source: string;
                      origin?: 'config' | 'plugin' | 'project'; plugin?: string; transport?: 'stdio' | 'http' | 'sse'; enabled?: boolean }
interface McpToolDto { name: string; fullName: string; description?: string; inputSchema?: object; readOnly: boolean }
interface McpConnectStepDto { cli: 'claude' | 'codex' | 'opencode' | 'gemini'; command?: string; file: string; snippet: string; note?: string }
interface McpConnectRunResult { cli; command?; exitCode: number | null; stdout; stderr; skipped?: string }
type McpImportFormat = 'claude' | 'codex' | 'opencode' | 'gemini';
```

- Confirm before `callMcpTool` when the tool is not `readOnly`, and before `connectMcp` (it changes those CLIs' config on that device). `connectMcp` skips CLIs that have no command (OpenCode: paste the snippet) or are not installed, with a reason in `skipped`.
- Only `scope: 'user'` is accepted for adding; project `.mcp.json` servers are not started by Conclave yet (they are counted in `ProjectTrustInfo.mcpServers`).
- MCP tools now reach agents in sessions as `mcp__<server>__<tool>`, filtered by each agent's `tools` and `mcpServers`.

## Sync to other CLIs

| Client method | Route | Returns |
| --- | --- | --- |
| `syncClis({ device?, only?, dryRun? })` | `POST /api/sync-clis` | `{ ok: true, written: string[], dryRun: boolean }` |

`only` limits to some of `claude`, `codex`, `opencode`, `gemini` (default: Claude Code plus the CLIs installed on the device). With `dryRun: true` nothing is written and `written` lists what would be. The old `syncToClis(device)` still works.

## Conclave as an MCP server ("connect memory to my CLIs")

| Client method | Route | Returns |
| --- | --- | --- |
| `mcpServerSnippets()` | `GET /api/mcp-server/snippets` | `McpServerSnippets` |

```ts
interface McpServerSnippets {
  url: string;                    // https://<hub>/mcp (uses server.publicUrl when set)
  tools: Array<{ name: string; description: string; readOnly: boolean }>;   // memory_search, memory_save, memory_forget,
                                                                            // memory_recent, sessions_search, tasks_list, routines_list
  tokenEnv: string;               // "CONCLAVE_TOKEN": the snippets read the token from this variable
  http: McpConnectStepDto[];      // per CLI, over HTTP with a bearer token
  stdio: McpConnectStepDto[];     // per CLI, via `conclave mcp` on that machine
  notes: string[];
}
```

The endpoint itself is `/mcp` on the hub (streamable HTTP, POST only, stateless). It accepts the owner token, a paired client token, or a gateway key. Suggested flow: "Create a key for this tool" (existing `createGatewayKey(name)`), show the key once, then the snippet for the chosen CLI with a copy button. On a device with the CLI, the stdio snippet needs no token handling.

## Memory connections

| Client method | Route | Returns |
| --- | --- | --- |
| `memoryConnections()` | `GET /api/memory/connections` | `MemoryConnectionInfo[]` |
| `memoryConnectionPresets()` | `GET /api/memory/connections/presets` | `MemoryConnectionPreset[]` |
| `memoryConnection(id)` | `GET /api/memory/connections/:id` | `MemoryConnectionInfo` |
| `addMemoryConnection(input)` | `POST /api/memory/connections` | `MemoryConnectionInfo` |
| `updateMemoryConnection(id, patch)` | `PATCH /api/memory/connections/:id` | `MemoryConnectionInfo` |
| `removeMemoryConnection(id, keepImported?)` | `DELETE /api/memory/connections/:id[?keepImported=1]` | `{ ok: true }` |
| `testMemoryConnectionConfig(input)` | `POST /api/memory/connections/test` | `MemoryConnectionTestResult` (unsaved form) |
| `testMemoryConnection(id)` | `POST /api/memory/connections/:id/test` | `MemoryConnectionTestResult` |
| `syncMemoryConnection(id)` | `POST /api/memory/connections/:id/sync` | `MemorySyncResult` (409 when disabled, 400 when the store cannot list notes) |
| `clearImportedMemory(id)` | `DELETE /api/memory/connections/:id/imported` | `{ ok: true, removed: number }` |
| `memoryConnectionConnectPlan(id)` | `GET /api/memory/connections/:id/connect` | `McpConnectStepDto[]` (400 for non-MCP types) |
| `memoryOverview()` | `GET /api/memory/stats` | `MemoryStatsDto` |

```ts
type MemoryConnectionType = 'basic-memory' | 'mcp' | 'http' | 'mem0' | 'cognee';
type MemoryConnectionMode = 'mirror' | 'read' | 'external';
type MemoryConnectionInputDto = { id?; type; name?; enabled?; mode?; search?; timeoutMs?; options?: Record<string, unknown> };
interface MemoryConnectionInfo extends MemoryConnectionConfigDto {
  name; enabled; mode; search; timeoutMs; options;   // defaults filled in; credentials shown as "********"
  legacy?: boolean;                                   // the old memory.external setting, id "external"
  status: { state: 'ok' | 'error' | 'backoff' | 'disabled' | 'unknown'; lastOkAt?; lastErrorAt?; lastError?; latencyMs?;
            failures: number; retryAt?; lastSync?: MemorySyncResult & { at: number; error?: string }; imported: number };
  capabilities: { search: boolean; write: boolean; pull: boolean };
}
interface MemoryConnectionPreset { key; type; label; description; template; fields: string[]; docs: string }
// fields: option keys for the form, in order; a trailing "?" marks optional ones
interface MemoryConnectionTestResult { ok; latencyMs; steps: Array<{ step; ok; ms?; detail? }>; error?; hint?; hits?; tools? }
interface MemorySyncResult { added; updated; removed; unchanged; total; skipped: number }
interface MemoryStatsDto { total; byKind; external?: string; connections: Array<{ id; type; mode; state }> }
```

- Add form: start from a preset's `template`, show `fields`, "Test" calls `testMemoryConnectionConfig` and renders `steps` with their timings, then `hint` in plain words when something failed.
- Credentials (`apiKey`, `token`, `password`, Authorization and X-API-Key headers) are moved to the secrets store on save. Lists show `********`; if the form sends `********` back, the saved value is kept, so an edit form can round-trip.
- Modes for the UI copy: mirror = "save here and in Conclave", read = "search and import only", external = "save here instead of Conclave".
- Remove also deletes the notes that connection imported unless `keepImported`; ask which.
- "Connect to my CLIs" for an MCP-based store uses `memoryConnectionConnectPlan(id)`, same step shape as MCP servers.

### Import from other tools' memory files, and export

| Client method | Route | Returns |
| --- | --- | --- |
| `importMemoryFiles({ device?, paths?, cwd?, force?, dryRun? })` | `POST /api/memory/import` | `MemoryFileImportResult` |
| `exportMemory({ layout?, includeImported?, root? })` | `GET /api/memory/export` | `MemoryMarkdownExport` |
| `exportMemoryTo({ dir, device?, layout?, includeImported?, root? })` | `POST /api/memory/export` | `{ dir, files, count }` |

```ts
interface MemoryFileImportResult {
  files: Array<{ path; source: 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'file'; scope: 'global' | 'project';
                 status: 'imported' | 'unchanged' | 'missing' | 'empty' | 'error' | 'preview'; added; updated; error? }>;
  added: MemoryEntry[]; updated: MemoryEntry[];
  proposed: Array<{ content; kind; tags; scope; file }>;        // dryRun only
  proposedUpdates: Array<{ id; content; file }>;               // dryRun only
  dropped: number;                                              // items that looked like secrets
}
interface MemoryMarkdownExport { layout: 'single' | 'folder'; files: Array<{ path: string; content: string }>; count: number; generatedAt: string }
```

- Import reads each CLI's user memory file (and the project's files with `cwd`) and runs the small model per file, so it can take several seconds: show progress and run `dryRun: true` first as a preview, then the real import.
- For a one-file download use a plain link to `GET /api/memory/export?format=md` (needs the bearer token, so fetch it and save the blob); it is served as `conclave-memory.md`.

## Behaviour changes to know about

- Built-in agents are loaded from `packages/core/src/agents-defaults/*.md`. Names and fields are unchanged; descriptions and prompts are the new validated ones.
- Plugin agents, skills and commands are named `<plugin>:<name>`. Bare names still resolve when unique, so stored `session.agent` values keep working.
- Claude-style command templates are zero-based (`$0` first, `$1` second), as in Claude Code.
- All 12 hook events fire. Stop hooks can make the model continue; `ask` from PreToolUse forces a prompt; PermissionRequest hooks can answer prompts, so some approvals the user used to see may now be answered by a hook (they show up in the hook's `last` runs).
- Hooks and permissions in `~/.claude/settings.json` apply when `compat.claudeCode` is on (the default).
- Project hooks and allow rules need folder trust (above).
- MCP tools now reach agents in sessions, and `GET /api/tools` lists them.
