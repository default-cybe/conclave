# Extensions compatibility

How tools, permissions, hooks, plugins, skills, commands, subagents, MCP, instruction files and settings work in Claude Code, Codex, OpenCode and Gemini CLI, and where Conclave stands on each.

Sources: [research-claude-code-codex.md](research-claude-code-codex.md) and [research-opencode-gemini.md](research-opencode-gemini.md) (Claude Code 2.1.301, Codex 0.163.0, OpenCode 1.19.3, Gemini CLI 0.64.0), plus the tests in `packages/core/test/extensions/compat/`. Checked 2026-10-16.

Status words in the Conclave column:

- **same**: behaves like the reference tool (Claude Code unless the row says otherwise).
- **compatible**: the other tool's files load and work; small differences are listed.
- **partial**: some of it works; the gaps are listed.
- **gap**: not supported yet.

## Matrix

| Concept | Claude Code | Codex | OpenCode | Gemini CLI | Conclave |
| --- | --- | --- | --- | --- | --- |
| Built-in tools | `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent` (was `Task`), `TodoWrite`, `Skill`, `NotebookEdit`, `AskUserQuestion`, plan mode tools, and more. | `exec_command`/`shell`, `apply_patch`, `update_plan`, `web_search`, `spawn_agent` and friends. Hooks see the shell as `Bash` and `apply_patch` as `Write`/`Edit`. | Lowercase ids: `bash`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `task`, `webfetch`, `websearch`, `todowrite`, `skill`, `question`. | `run_shell_command`, `read_file`, `write_file`, `replace`, `glob`, `grep_search`, `list_directory`, `web_fetch`, `google_web_search`, `write_todos`, `activate_skill`. | **compatible**. Claude names (`Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, `Skill`, `NotebookEdit`, `AskUserQuestion`, plan mode) plus memory, `RepoMap`, `Consult`, `Notify`, `ScheduleRoutine`. Hook matchers, `if` rules and permission rules treat `Agent` as `Task`; `Edit` covers `MultiEdit`. |
| Permission rules | `permissions.allow/ask/deny` in settings, `Tool(specifier)`. Deny beats ask beats allow. Modes: default, acceptEdits, plan, dontAsk, auto, bypassPermissions. In an untrusted folder, project `allow` rules are ignored in `-p`. | `sandbox_mode` + `approval_policy`, and Starlark `prefix_rule` files in `rules/*.rules`; the strictest match wins. | `permission` map of `allow`/`ask`/`deny` with wildcards; the last match wins; a tool denied for every pattern is hidden. | Approval modes plus a TOML policy engine with tiers 1 to 5. Workspace policies never load. Folder trust is on by default. | **partial**. Claude syntax and order (deny, ask, allow). Modes default, acceptEdits, plan, bypass; no dontAsk or auto. Project allow rules apply only after the folder is trusted once; deny and ask rules always apply. `~/.claude/settings.json` rules load when `compat.claudeCode` is on. `Agent` rules match `Task`. |
| Hook events | 33 events. | 12: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `Interrupt`. | No shell hooks. JS/TS plugin functions such as `tool.execute.before`. | 11: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`. | **compatible**. 12 events in the schema, all fired: `SessionStart` (startup, resume, clear, compact), `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact` (manual, auto), `Stop`, `SessionEnd` (clear, other). |
| Hook input and output | JSON on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, tool fields). Exit 2 blocks and sends stderr to the model. Exit 0 may print JSON with `decision`, `continue`, `systemMessage`, `hookSpecificOutput`. Handler types command, prompt, agent, http, mcp_tool. Default timeout 600 s. | Same keys and contract. Exit 2 with empty stderr is a failure, not a block. User and project hooks run only after their hash is trusted. A hyphen in a matcher makes it a regex. | Throw in `tool.execute.before` to block; change `output.args` to rewrite. Runs before the permission check. | JSON on stdin and stdout. Plain output: exit 0 allows, exit 1 warns, any other code blocks. Timeouts in ms (60000). A timed out hook lets the action go on. | **compatible**. Claude contract, command and prompt handlers, 600 s default (1.5 s for SessionEnd), `if`, `async`, exec-form `args`, `shell`. Also reads Gemini-style top-level `decision` values and `hookSpecificOutput.tool_input`. Also reads prompt hooks' `{"ok": false, "reason"}`, runs `mcp_tool` handlers, honors `once`, `statusMessage` and `suppressOutput`, and sends Claude Code's `tool_response` objects for Bash, Write and Edit. Gaps: no `transcript_path`, no `CLAUDE_ENV_FILE`, no http or agent handlers, `asyncRewake` is not supported, and command hooks run on the hub even when the session runs on another device. See the parity table. |
| Plugins | `.claude-plugin/plugin.json` (only `name` required). `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json`, `bin/`, `settings.json`, `userConfig`. Components are named `plugin:name`. MCP tools are `mcp__plugin_<plugin>_<server>__<tool>`. Hooks get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. | Reads `.codex-plugin/plugin.json` and also `.claude-plugin/plugin.json`. A Claude plugin installs unchanged; skills show as `plugin:skill`. | npm or local JS/TS modules in `plugins/`. V1 and V2 plugin APIs differ. | Extensions in `~/.gemini/extensions/<name>/` with `gemini-extension.json`, TOML commands, skills, agents, hooks, policies, a context file. | **compatible** with Claude and Codex plugins. Same layout and manifest search (`.claude-plugin`, root `plugin.json`, `.codex-plugin`). Names are `plugin:name`; a bare name resolves when only one plugin has it. MCP keys and tool names match Claude. Hooks get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (Codex-format plugins also `PLUGIN_ROOT` and `PLUGIN_DATA`) and their own `CLAUDE_CONFIG_DIR`. `${VAR}` in `.mcp.json` becomes `${env:VAR}`; `${user_config.X}` becomes `${secret:plugin.<plugin>.X}`. Not yet: `userConfig` prompts, `bin/` on PATH, plugin `settings.json`, LSP servers, output styles. OpenCode plugins and Gemini extensions do not load. |
| Marketplaces | `.claude-plugin/marketplace.json`; sources: relative path, `github` (+`path`), `git`, `url`, `git-subdir`, npm, inline. `enabledPlugins` in settings. | Reads `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`. | None. Community list on the docs site. | A gallery JSON index; `gemini extensions install <git|path>`. | **compatible**. Claude `marketplace.json`; relative, `github` with `path`, `git`, `url`, `git-subdir`. Not npm or `strict: false` entries. Default marketplace: `anthropics/claude-plugins-official`. |
| Skills | `SKILL.md` folders in `~/.claude/skills`, `.claude/skills`, plugins. The **folder name** is the skill name (frontmatter `name` is ignored, verified). Only name and description sit in context. | `.agents/skills` from repo root to cwd, `~/.agents/skills`, `$CODEX_HOME/skills` (deprecated). Frontmatter `name` is required and used. | `~/.claude/skills`, `~/.agents/skills`, `.opencode/skills/**` (nested), frontmatter `name`. | `~/.gemini/skills`, `~/.agents/skills`, one level deep, frontmatter `name`. | **same** for Claude folders (named by folder since this pass). `~/.agents/skills`, `.agents/skills`, Codex, OpenCode and Gemini folders load behind `compat.codex`, `compat.opencode`, `compat.gemini`, named by frontmatter like those tools. |
| Commands | `.claude/commands/*.md`, `~/.claude/commands`, plugin `commands/`. Args: `$ARGUMENTS`, `$ARGUMENTS[N]`, zero-based `$0`, `$1` (verified: `/hello Alice Bob` gives `$1 = Bob`). `` !`cmd` `` and `@file`. Skills are listed as commands too. | Custom prompts in `~/.codex/prompts` were removed; skills and `[tui.presets]` replace them. Old prompts ran as `/prompts:name` with one-based `$1`. | `.opencode/commands/**/*.md`, name `git/commit`. One-based `$1`; the highest placeholder takes the rest; args are appended when there is no placeholder. | TOML in `.gemini/commands/**`, name `git:commit`. `{{args}}`, `!{cmd}` (args shell-quoted inside), `@{path}`; the typed command is appended when there is no `{{args}}`. | **same** for Claude (zero-based since this pass; it was one-based). Codex prompts, OpenCode commands and Gemini TOML load behind their flags, each with its own argument rules. Typed names match case-insensitively; a skill works as a command. |
| Subagents | Markdown with frontmatter (`tools`, `model`, `effort`, `permissionMode`, `skills`, `mcpServers`, `hooks`, `memory`). Called with `Agent {subagent_type, prompt}`. Hooks inside get `agent_id`, `agent_type`. | TOML roles in `agents/**/*.toml`, `description` required, `developer_instructions` as the prompt. Called with `spawn_agent`. | Markdown with its own strict schema: `mode`, `permission` map, hex `color`. A Claude-style file (`tools: [..]`, `color: blue`) stops OpenCode from starting. | Strict markdown in `agents/*.md` with Gemini tool names; each agent is a tool. | **compatible**. Claude markdown via the `Task` tool; `effort` and `permissionMode: bypassPermissions` now map. Codex TOML, OpenCode and Gemini agents load behind flags. Sync writes each CLI's own format (the old sync wrote Claude files into OpenCode's folder, which broke OpenCode). Not yet: per-agent `hooks`, `maxTurns`, `agent_id` in hook input. |
| MCP config | `.mcp.json` `{mcpServers: {name: {type, command, args, env | url, headers}}}`. Project servers need approval. Scopes local, user, project, dynamic, plugin, managed. Tools `mcp__<server>__<tool>`. | `[mcp_servers.<name>]` in config.toml; `bearer_token_env_var`, `env_vars`; startup 30 s, tools 300 s. Same tool names. | `mcp.<name> = {type: local, command: [..], environment}` or `{type: remote, url, headers}`. Tools `server_tool`. | `mcpServers.<name> = {command, args, env}` or `{url, type}`. Tools `mcp_server_tool`. Off in untrusted folders. | **compatible**. Claude shape in `config.json` and plugins, with `${env:X}` and `${secret:X}`. Converters import from and export to all four formats, and `mcpConnectPlan` gives the command to add one server (for example Basic Memory) to each CLI. MCP tools reach agents as `mcp__<server>__<tool>` (since the integration pass; before it they only showed in listings). Gap: project `.mcp.json` servers are counted in the trust check but not started. |
| Instruction files | `CLAUDE.md` (user, project, parents), `.claude/CLAUDE.md`, `@path` imports, `.claude/rules/*.md` (path-scoped with `paths:`), `CLAUDE.local.md`. `AGENTS.md` only when there is no `CLAUDE.md`. | Global, then per folder from root to cwd the first of `AGENTS.override.md` and `AGENTS.md`. 32 KiB cap, no imports. | Every `AGENTS.md` from cwd up (falls back to `CLAUDE.md`); subfolder files attach when a file there is read. | `GEMINI.md` hierarchy with `@` imports (depth 5) and a private `MEMORY.md`. | **compatible**. `CONCLAVE.md`, `AGENTS.override.md` or `AGENTS.md` per folder, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules` without `paths:`, `CLAUDE.local.md`, imports to depth 4. `GEMINI.md` and OpenCode's global `AGENTS.md` behind flags. Loads both `AGENTS.md` and `CLAUDE.md`. Not yet: path-scoped rules, lazy subfolder files, a size cap. |
| Settings precedence | user < project < local < flag < policy. | system < user < profile < trusted project `.codex` < `-c` flags; `requirements.toml` sets hard limits. | remote org < global < `OPENCODE_CONFIG` < project files < `.opencode` < env < managed. | defaults < system defaults < user < workspace (if trusted) < system overrides. | **partial**. `config.json` < `.claude/settings.json` < `.claude/settings.local.json` < `.conclave/settings.json` < `.conclave/settings.local.json`. `~/.claude/settings.json` sits below `config.json` when `compat.claudeCode` is on. Hook and permission lists concatenate. Project hooks and allow rules need a one-time folder trust. No managed policy. |

## Hook parity with real Claude Code

The same hook script (`packages/core/test/extensions/compat/fixtures/hooks/parity-hook.ts`) ran under Claude Code 2.1.301 (`claude -p --model sonnet --settings <hooks>`, six runs, about $0.24 in total) and inside the real Conclave engine, driven by a mock model that made the same tool calls. Claude's results are in `fixtures/claude-hook-parity.json`; `hook-parity.test.ts` runs the Conclave side and fails if this table goes stale.

| Case | Claude Code 2.1.301 | Conclave | Status |
| --- | --- | --- | --- |
| PreToolUse exit 2 | Tool did not run. Model saw `PreToolUse:Bash hook error: [<cmd>]: cg-exit2 is not allowed here` | Tool did not run. Model saw `Blocked by hook: cg-exit2 is not allowed here` | same |
| PreToolUse `permissionDecision: deny` | Model saw `PreToolUse:Bash hook error: cg-deny refused by policy` | Model saw `Blocked by hook: cg-deny refused by policy` | same |
| PreToolUse `permissionDecision: ask` | Forced a prompt; headless mode denied it with the hook's reason | Forced a prompt; the denial reached the model | same |
| PreToolUse `permissionDecision: allow` | `touch` ran with no prompt (without the hook it needed approval) | Same | same |
| PreToolUse `updatedInput` (no decision) | Ran the rewritten command | Same | same |
| `if: "Bash(echo cg-if*)"` | Hook ran only for the matching call | Same (added in this pass) | same |
| PostToolUse exit 2 | Stderr reached the model as a separate attachment after the result | Stderr appended to the result in `<hook_feedback>` | same |
| PostToolUse `additionalContext` | Reached the model as a separate attachment | Appended in `<hook_feedback>` | same |
| UserPromptSubmit JSON `additionalContext` | Reached the model | Same | same |
| UserPromptSubmit plain stdout | Reached the model | Same | same |
| SessionStart JSON `additionalContext` | Reached the model; stdin `source: "startup"`; `CLAUDE_ENV_FILE` set | Reached the model; stdin `source: "startup"`; no `CLAUDE_ENV_FILE` | same |
| SessionStart plain stdout | Reached the model | Reached the model | same |
| Stop `{"decision":"block"}` | Turn continued with `Stop hook feedback:\n<reason>`; final text MANGO | Same | same |
| Stop `stop_hook_active` | `false` on the first stop, even after a tool turn; `true` after a block | Same | same |

Other facts checked live: the stdin keys above are the same in both (Conclave sends Claude's names, including `bypassPermissions` for `bypass`); Conclave has no `transcript_path`, `prompt_id` or `effort`. `CLAUDE_PROJECT_DIR` is set on every hook in both.

Naming, checked live with `--plugin-dir` and a project `.claude/`: plugin skill `hookify:writing-rules` (folder name, though its frontmatter says `writing-hookify-rules`), commands `hookify:help` and friends, agent `hookify:conversation-analyzer`; a project skill takes its folder name; a project agent takes its frontmatter `name`. Conclave now does the same.

## Real plugins

`real-plugins.test.ts` clones these once into a cache (`$CONCLAVE_COMPAT_CACHE`, default `/tmp/conclave-compat-cache`), installs them into a temp Conclave home through `PluginManager`, and checks names, paths and root expansion. It skips when offline.

| Repo | What it covers | Result |
| --- | --- | --- |
| `obra/superpowers` | 15 skills, a SessionStart hook with `shell: bash` and matcher `startup|clear|compact` | All skills load as `superpowers:<folder>`. The real hook runs through Conclave's runner, sees `CLAUDE_PLUGIN_ROOT`, picks Claude's output shape, and its context comes back. It does not fire on `resume`. |
| `anthropics/claude-plugins-official` (marketplace) | `hookify` (4 hook events, 4 commands, agent, skill), `feature-dev` and `pr-review-toolkit` (both ship `code-reviewer`), `example-plugin` (flat `.mcp.json`, skill used as a command), `context7` and `github` (http MCP, `${VAR}` header), `fakechat` (stdio MCP with `${CLAUDE_PLUGIN_ROOT}` in args), `security-guidance` (`if` filters, `asyncRewake`), `ralph-loop` (Stop hook) | All install from the marketplace by `name@claude-plugins-official`. Same-named agents and commands stay apart; ambiguous bare names return nothing. A frontmatter block that is not valid YAML (`silent-failure-hunter`) still loads through the lenient parser. `if` filters select the right handler. Disabling a plugin removes its parts. |
| `K-Dense-AI/scientific-agent-skills` | Root `plugin.json` with an Open Plugins `$schema`, 177 skills | Installs; every skill loads with a description. |

## What changed in this pass

In `packages/core/src/extensions/`:

- `hooks.ts`: 600 s default timeout (1.5 s for SessionEnd); `if` filter; `async`; exec-form `args`; `shell`; bash by default; plugin env vars; `Agent`/`Task` and `MultiEdit`/`Edit` matcher aliases; Gemini-style decisions; `updatedToolOutput`; per-handler traces and `recent()`; `plan()` to preview which handlers run; no duplicate PostToolUse feedback; Claude's permission mode names on stdin.
- `plugins.ts`: `plugin:name` components; Claude's MCP key; `CLAUDE_PLUGIN_DATA`; `${VAR}` and `${user_config.X}` in MCP config; inline manifest hooks; `.codex-plugin` manifests; `github` and `git` marketplace sources with `path`; `detail()`.
- `loader.ts`: lenient frontmatter; skills named by folder; Claude `effort` and `bypassPermissions`.
- `commands.ts`: Claude's zero-based args; Codex, OpenCode and Gemini argument rules; Gemini `!{}` and `@{}`.
- `registry.ts`: compat scopes; `inventory()` with shadowing; `pluginDetail()`; bare and case-insensitive name lookup; skills as commands.
- `compat.ts` (new): Codex, OpenCode and Gemini loaders; MCP import and export for all four; Gemini and Codex hook import.
- `cli-sync.ts`: one shared skill copy in `~/.agents/skills`; Codex TOML roles; OpenCode agents in OpenCode's schema (checked with `opencode debug agent` 1.19.3); Gemini agents; dry run; `mcpConnectPlan`.
- `instructions.ts`: `AGENTS.override.md`, `.claude/CLAUDE.md`, `.claude/rules`, `GEMINI.md`, OpenCode's global file.
- `mcp.ts`: `restart`, `test`, `serverTools`.
- `config/schema.ts`: optional `compat.codex`, `compat.opencode`, `compat.gemini` (off unless set).

## Engine gaps closed in the integration pass

1. `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Notification` and `PermissionRequest` fire. Inside a subagent, hook input carries `agent_id` and `agent_type`.
2. `permissionDecision: ask` from PreToolUse forces a prompt (a deny rule still wins).
3. `stop_hook_active` turns true only after a Stop hook blocked; Stop gets `last_assistant_message` and the model sees `Stop hook feedback:` plus the reason.
4. PreCompact matches on its trigger; PostToolUse gets `duration_ms`, PostToolUseFailure gets `error`; `updatedToolOutput` replaces the result.
5. Hooks and permissions from `~/.claude/settings.json` load when `compat.claudeCode` is on. Project hooks and allow rules (`.claude/settings*.json`, `.conclave/settings*.json`) wait until the folder is trusted once (`POST /api/trust`); deny and ask rules always apply.
6. `Agent` is an alias of `Task` in permission rules.

Still open: command hooks run on the hub even when the session runs on another device; no `CLAUDE_ENV_FILE`; project `.mcp.json` servers are listed but not started.

## Hook gaps closed in the ecosystem pass

From docs/design/ECOSYSTEM.md 4.3, tested in `test/extensions/hook-runner.test.ts`, `hook-lint.test.ts`, `hook-recipes.test.ts` and `test/engine/hook-engine.test.ts`:

1. Prompt hooks read Claude Code's `{"ok": false, "reason": "..."}` as a block with that reason, and `{"ok": true}` as no change.
2. A deny or block with no reason uses the hook's `systemMessage` (hookify's message reaches the model).
3. An output rewrite shows as "replaced output" in traces.
4. `if` rules accept `mcp__server__*` and `mcp__server`.
5. Lint on save and import wraps flat entries and flags millisecond timeouts, bare `mcp__` matchers and `if` rules that cannot match.
6. At most 3 Stop blocks per turn.
7. Plugin env: `PLUGIN_ROOT` and `PLUGIN_DATA` only for `.codex-plugin` manifests; `CONCLAVE=1`; a per-plugin `CLAUDE_CONFIG_DIR` (ponytail installed from GitHub at 16352ac wrote its mode flags and statusline script there, not into `~/.claude`).
8. MCP results in several blocks spill to ReadToolOutput like text results.
9. `tool_response` is Claude Code's object for Bash (`{stdout, stderr, interrupted, isImage}`), Write and Edit; `conclave.output_text` has the text the model sees.
10. PreToolUse handlers run in order, each fed the previous rewrite; the trace notes a second rewrite.
11. A rewrite keeps the original call's verdict (a deny or explicit ask rule on the new input still wins).
12. `onFailure: "block"`, `once`, `statusMessage`, `suppressOutput`, context budgets, and `mcp_tool` handlers.

Not yet: `asyncRewake`, `http` and `agent` handlers, hooks that run on the session's device, and trust by hash for edited plugin hooks.
