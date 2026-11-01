# Claude Code and Codex: tools, hooks, plugins, skills, agents, MCP, memory

Research notes for Conclave's extension layer. Exact formats, file locations and precedence for the two harnesses Conclave drives most.

Versions checked (2026-10-16):

- Claude Code CLI 2.1.301 (installed), `@anthropic-ai/claude-agent-sdk` 0.3.301 (`sdk.d.ts`), `anthropics/claude-code` and `anthropics/claude-plugins-official` at HEAD.
- Codex: `openai/codex` at HEAD (`codex-rs`), `@openai/codex` CLI 0.163.0 from npm.

Tags used below:

- **[run]** I ran it and saw the result.
- **[src]** I read it in source, type definitions or the changelog.
- **[unverified]** from plugin-dev reference docs or memory only.

Test scratch (hooks, plugin, marketplace, transcripts) is in `/tmp/cg/work/res-cc-codex/`.

---

## 1. Built-in tools and permissions

### Claude Code

Tool names, as permission rules and hook matchers spell them [src: `BUILTIN_TOOL_NAMES` in sdk.d.ts]:
`Agent` (the subagent tool; `system/init` still lists it as `Task`) [run], `AskUserQuestion`, `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `LSP`, `Monitor`, `PowerShell`, `TaskCreate/Get/List/Update/Stop`, `CronCreate/Delete/List`, `SendMessage`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, plus product tools. The list is not exhaustive. A session's real list is the `tools` field of the `system/init` stream event.

Permission rules live in `settings.json` under `permissions` [src]:

```json
{
  "permissions": {
    "allow": ["Bash(git status)", "Bash(npm run *)", "Read(./src/**)", "WebFetch(domain:github.com)", "mcp__memory"],
    "ask":   ["Bash(git push *)"],
    "deny":  ["Read(./.env)", "Bash(rm -rf *)"],
    "defaultMode": "default",
    "additionalDirectories": ["../shared"],
    "disableBypassPermissionsMode": "disable"
  }
}
```

- Rule syntax: `Tool` or `Tool(specifier)`. Bash uses command patterns with `*`. File tools use gitignore-style paths. `Edit(...)` rules cover all file writes (`Write(...)` rules are not matched by file checks) [src: changelog]. `mcp__server` covers every tool of that server; `mcp__server__tool` one tool.
- Order: **deny, then ask, then allow** [run: with `allow: Bash(echo *)`, `deny: Bash(echo secret *)`, `ask: Bash(echo maybe *)`, `echo secret one` was denied and `echo maybe two` went to ask].
- Read-only shell commands such as `ls -a` run without a rule [run]. A command with an unexpanded variable (`echo $X`) needs approval [run].
- Modes: `default` (alias `manual`), `acceptEdits`, `plan`, `dontAsk` (deny anything not pre-approved), `auto` (a model classifier decides), `bypassPermissions` [src].
- Headless: `--permission-prompts none` denies anything that would prompt. The denial reaches the model as a tool error and emits a `system/permission_denied` event [run].
- **Untrusted workspace**: in `-p` mode, project `.claude/settings.json` `permissions.allow` entries are ignored until the folder is trusted ("Ignoring 3 permissions.allow entries ... this workspace has not been trusted"). Project **hooks still ran**. Rules passed with `--settings` did apply [run].
- CLI equivalents: `--allowedTools`, `--disallowedTools`, `--tools` (restricts the built-in set), `--permission-mode`, `--add-dir` [run: `--help`].
- Sandbox (Bash only): the `sandbox` settings block (`network.allowedDomains`, `autoAllowBashIfSandboxed`, `excludedCommands`) [src: examples/settings].

### Codex

Core model tools [src: core/src/tools]: `exec_command` + `write_stdin` (unified exec; the legacy `shell` tool also exists), `apply_patch`, `update_plan`, `request_user_input`, `request_permissions`, native `web_search`, multi-agent tools (`spawn_agent`, `send_input`/`send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`, `resume_agent`, `interrupt_agent`), MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`).

Codex controls risk with a **sandbox plus approval policy**, not per-tool allow lists:

```toml
sandbox_mode    = "workspace-write"        # read-only | workspace-write | danger-full-access
approval_policy = "on-request"             # untrusted | on-request (alias on-failure) | never | { granular = {...} }

[sandbox_workspace_write]
writable_roots = ["/home/me/shared"]
network_access = false
exclude_tmpdir_env_var = false
exclude_slash_tmp = false
```

- `granular` fields: `sandbox_approval`, `rules`, `mcp_elicitations` (required), `skill_approval`, `request_permissions`. A field set to false auto-rejects that kind of prompt [src: protocol.rs `AskForApproval`].
- CLI: `-s/--sandbox`, `-a/--ask-for-approval on-request|never`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `-c key=value` [src: utils/cli].
- Sandbox backends: macOS Seatbelt, Linux bubblewrap/landlock (`codex-rs/linux-sandbox`, `bwrap`), Windows sandbox crates [src]. `codex sandbox <cmd>` runs a command under it [run: `--help`].
- **Exec policy rules** (Starlark) [run: `codex execpolicy check`]: files `<config folder>/rules/*.rules` in every config layer (`~/.codex/rules/`, `<repo>/.codex/rules/`, `/etc/codex/rules/`) [src: core/src/exec_policy.rs].

  ```starlark
  prefix_rule(pattern = ["git", ["push", "reset"]], decision = "prompt", justification = "risky git")
  prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden", justification = "use trash instead")
  prefix_rule(pattern = ["git"], decision = "allow")
  ```

  `git status` gives allow, `git push origin` gives prompt (strictest of all matches wins: forbidden > prompt > allow), `rm -rf /x` gives forbidden, `ls` matches nothing [run]. `requirements.toml` may not use `allow` [src].
- Named permission profiles: `default_permissions = "<name>"` plus `[permissions.<name>]` (filesystem and network rules) [src: schema].

---

## 2. Hooks

### Claude Code: where

Same JSON shape in all of these [src, run]:

| Source | File |
| --- | --- |
| User | `~/.claude/settings.json` → `"hooks": {...}` |
| Project | `.claude/settings.json` → `"hooks"` |
| Local | `.claude/settings.local.json` → `"hooks"` |
| Managed | `managed-settings.json` → `"hooks"` (`allowManagedHooksOnly: true` drops all others) |
| Plugin | `<plugin>/hooks/hooks.json` → `{"description"?: "...", "hooks": {...}}`, or `"hooks"` in `plugin.json` |
| Agent / skill / command | `hooks:` in frontmatter, scoped to that component's lifetime |
| SDK | `options.hooks` callbacks |

Shape:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check.sh", "timeout": 30 }
      ] }
    ]
  }
}
```

Note: the plugin-dev skill says settings.json hooks have no `"hooks"` wrapper. That is wrong; settings use `"hooks": {Event: [...]}` [run].

### Claude Code: handler types [src: Settings type]

| `type` | Required | Optional |
| --- | --- | --- |
| `command` | `command` | `args` (exec form, no shell), `if` (permission-rule filter such as `"Bash(git *)"`), `shell` (`bash`/`powershell`), `timeout` (s), `onFailure` (`continue`/`block`), `statusMessage`, `once`, `async`, `asyncRewake` |
| `prompt` | `prompt` (`$ARGUMENTS` = input JSON) | `if`, `timeout`, `model`, `continueOnBlock`, `statusMessage`, `once` |
| `agent` | `prompt` | `if`, `timeout` (default 60), `model` (default Haiku), `statusMessage`, `once` |
| `http` | `url` (POSTs the input JSON) | `if`, `timeout`, `onFailure`, `headers` (`$VAR` only if listed in `allowedEnvVars`), `allowedEnvVars`, `statusMessage`, `once` |
| `mcp_tool` | `server`, `tool` | `input` (`${tool_input.file_path}` interpolation), `if`, `timeout`, `statusMessage`, `once` |

### Claude Code: events

33 events [src: `HOOK_EVENTS`]: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`.

Matcher value per event:

- Tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`): the tool name [run].
- `SessionStart`: the source. The stream showed `hook_name: "SessionStart:startup"` [run].
- `SubagentStart`/`SubagentStop`: the agent type (`"SubagentStart:lister"`) [run].
- `PreCompact`: `manual`/`auto`. `Notification`: notification type. `SessionEnd`: reason [unverified].
- `UserPromptSubmit`, `Stop`: no matcher [run: they fired with no matcher].

Matcher syntax [src: changelog]: empty or `*` matches everything. Plain names, `|` lists and comma lists (`"Bash,PowerShell"`) match exactly, hyphenated names included (`code-reviewer`, `mcp__brave-search`). Anything else is a regex (`mcp__.*__delete.*`). Case-sensitive.

### Claude Code: stdin JSON

Common fields [run]: `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Also `prompt_id` (after the first prompt), `permission_mode`, and `effort: {"level": "medium"}` on turn-scoped events. `agent_id` + `agent_type` appear only inside a subagent [run: PostToolUse from the `lister` subagent carried both].

Per-event extras [run unless noted]:

- `SessionStart`: `source` (`startup|resume|clear|compact|fork`), plus `model`, `agent_type` and resume cost fields [src].
- `UserPromptSubmit`: `prompt`, plus `source` (`user|sdk|system|loop_wakeup|schedule_wakeup|poll_event`) [src].
- `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`, plus `mcp_server {name, source}` for MCP tools [src].
- `PostToolUse`: as PreToolUse plus `tool_response` and `duration_ms`. Bash response: `{stdout, stderr, interrupted, isImage, noOutputExpected}`.
- `PostToolUseFailure`: `error`, `is_interrupt` [src].
- `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]`.
- `SubagentStop`: same as Stop plus `agent_id`, `agent_type`, `agent_transcript_path`.
- `SubagentStart`: `agent_id`, `agent_type`.
- `SessionEnd`: `reason` (`clear|resume|logout|prompt_input_exit|other`). It was `other` for `-p`.
- `InstructionsLoaded`: `file_path`, `memory_type` (`User|Project|Local|Managed`), `load_reason` (`session_start|nested_traversal|path_glob_match|include|compact`), `parent_file_path` (for `@` imports), `globs`, `trigger_file_path`.
- `Notification`: `message`, `title`, `notification_type`. `PreCompact`: `trigger`, `custom_instructions`. `PostCompact`: `compact_summary`. `CwdChanged`: `old_cwd`, `new_cwd`. `FileChanged`: `file_path`, `event`. `ConfigChange`: `source`, `file_path` [src].

### Claude Code: output and exit codes

| Exit | Effect |
| --- | --- |
| 0 | Success. Stdout is parsed as JSON if it looks like JSON. For `SessionStart`/`UserPromptSubmit`, plain stdout becomes context [unverified for plain text; JSON verified]. |
| 2 | Blocking. Stderr goes to the model. On PreToolUse the tool result reads `PreToolUse:Bash hook error: [<command>]: <stderr>` [run]. |
| other | Non-blocking error, shown to the user. With `onFailure: "block"` it counts as exit 2. |

JSON fields (`SyncHookJSONOutput`) [src]: `continue` (false stops the session), `stopReason`, `suppressOutput`, `systemMessage` (shown to the user), `decision: "approve"|"block"`, `reason`, `terminalSequence`, `hookSpecificOutput`. Or `{"async": true, "asyncTimeout": n}`.

`hookSpecificOutput` by event (always include `hookEventName`) [src]:

- `PreToolUse`: `permissionDecision` (`allow|deny|ask|defer`), `permissionDecisionReason`, `updatedInput`, `additionalContext`. A JSON `deny` reached the model as `PreToolUse:Bash hook error: <reason>` [run].
- `PermissionRequest`: `decision: {behavior: "allow", updatedInput?, updatedPermissions?} | {behavior: "deny", message?, interrupt?}`.
- `PostToolUse`: `additionalContext`, `updatedToolOutput`, `updatedMCPToolOutput`.
- `SessionStart`: `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`. `additionalContext` reached the model [run: the model reported the hook codeword].
- `UserPromptSubmit`: `additionalContext`, `sessionTitle`, `suppressOriginalPrompt`.
- `Stop`/`SubagentStop`: `additionalContext`. Top-level `{"decision":"block","reason":"..."}` on Stop continues the turn with "Stop hook feedback:\n<reason>". The next Stop input has `stop_hook_active: true` [run].
- `PermissionDenied`: `retry`. `WorktreeCreate`: `worktreePath`. `Elicitation`: `action`, `content`.

### Claude Code: runtime

- Hooks run in parallel. Command hooks run with the project dir as cwd [run].
- Default timeout: **600 s** for tool hooks ("changed from 60 seconds to 10 minutes"). SessionEnd hooks default to 1.5 s (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`) [src: changelog].
- Env [run]: `CLAUDE_PROJECT_DIR` (all hooks), `CLAUDE_ENV_FILE` (SessionStart only, a file under `~/.claude/session-env/<session>/`; `export X=...` lines written there apply to later Bash calls), `CLAUDE_EFFORT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`. Plugin hooks also get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/<plugin>-<marketplace>/`) [run].
- Headless: `--include-hook-events` emits `system/hook_started` and `system/hook_response` (`exit_code`, `stdout`, `stderr`, `outcome`) [run].
- `disableAllHooks: true` turns all hooks off. `--bare` skips settings and plugin hooks [src].

### Codex hooks

Codex now has Claude-shaped hooks [src: codex-rs/hooks, config schema].

Where (each config layer):

- `<config folder>/hooks.json` with `{"description"?, "hooks": {Event: [MatcherGroup]}}`. Example paths: `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `/etc/codex/hooks.json`.
- Or inline `[hooks]` in that layer's `config.toml`. Using both in one layer gives a warning.
- Plugins: `hooks/hooks.json` or `hooks` in the manifest.
- Managed: `requirements.toml`. `allow_managed_hooks_only = true` works only there.

Events (12): `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `Interrupt`. `UserPromptSubmit`, `Stop` and `Interrupt` ignore the matcher.

Handlers: `{"type":"command", "command", "timeout", "async", "statusMessage", "commandWindows", "additionalContextLimit"}` and `{"type":"mcp_tool", "server", "tool", "input"}`. `prompt` and `agent` types parse but carry no fields.

Matcher: empty or `*` = all. Only `[A-Za-z0-9_|]` = exact, `|`-separated. Anything else = regex. Unlike Claude, a hyphen makes it a regex.

Tool names in hooks: the shell tool is reported as **`Bash`**. `apply_patch` also matches `Write` and `Edit`. `spawn_agent` also matches `Agent`. MCP tools are `mcp__<server>__<tool>`. So Claude matchers mostly work unchanged [src: core/src/tools/hook_names.rs].

Stdin [src: hooks/schema/generated]: `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, `turn_id`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`), and `agent_id`/`agent_type` inside subagents. Tool events add `tool_name`, `tool_input`, `tool_use_id`, and `tool_response` on PostToolUse. Stop adds `stop_hook_active` and `last_assistant_message`.

Output:

- Exit 0 with JSON stdout. Same keys as Claude: `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `decision`, `reason`, `hookSpecificOutput` (`permissionDecision allow|deny|ask`, `permissionDecisionReason`, `updatedInput`, `additionalContext`; PermissionRequest `decision.behavior allow|deny`).
- Exit 2 with a reason on stderr blocks. Exit 2 with empty stderr is a hook failure, not a block.
- Other exits are failures.
- Invalid JSON that looks like JSON is a failure.

Runtime:

- Shell: `$SHELL -lc "<command>"` (fallback `/bin/sh`), cwd = session cwd.
- Default timeout **600 s**. SessionEnd defaults to 1 s, max 3 s.
- Plugin hooks get `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`.
- **Hook trust**: a non-managed hook runs only after its hash is stored as `[hooks.state."<source>:<event>:<group>:<handler>"] trusted_hash = "..."`. The TUI `/hooks` writes this. Editing the hook marks it `Modified` and it stops running. `--dangerously-bypass-hook-trust` skips the check for one run.

Legacy `notify = ["prog", "arg"]` still works. Codex appends one JSON argument: `{"type":"agent-turn-complete","thread-id","turn-id","cwd","client","input-messages":[],"last-assistant-message"}` [src].

---

## 3. Plugins

### Claude Code

Layout [run: `claude plugin validate`, `--plugin-dir`]:

```
my-plugin/
  .claude-plugin/plugin.json      # manifest; only "name" is required
  commands/*.md                   # slash commands (legacy layout)
  skills/<name>/SKILL.md          # skills (preferred for commands too)
  agents/*.md                     # subagents
  hooks/hooks.json                # {"hooks": {...}}
  .mcp.json                       # {"mcpServers": {...}}; a flat {name: cfg} map also appears in the official repo
  "lspServers" (manifest or marketplace entry)   # language servers; a .lsp.json file is [unverified]
  bin/                            # added to the Bash tool's PATH [src]
  settings.json                   # default settings [src]
```

`plugin.json` fields [src]:

- Metadata: `name` (kebab-case, immutable slug), `version`, `description`, `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords`.
- Component paths: `commands`, `agents`, `skills`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`. Each is a string, an array, or an inline object.
- Other: `userConfig`, `dependencies`, `defaultEnabled`.
- Setting `commands` or `agents` replaces the default folder (with a warning). `skills` adds to `skills/` [src: changelog].

`userConfig` example:

```json
"userConfig": { "api_token": { "type": "string", "title": "API token", "description": "...", "sensitive": true } }
```

- Values are set with `/plugin configure` or `claude plugin install --config key=value`. Sensitive values go to the keychain or a protected file.
- Reference them as `${user_config.api_token}` in `.mcp.json` env/headers.
- In shell-form hooks they are rejected; there use exec form `args` or `$CLAUDE_PLUGIN_OPTION_<KEY>` [src: changelog].

Namespacing, from `--plugin-dir` with plugin `cgtest` [run]:

- Commands: `cgtest:hi`. Skills: `cgtest:notes`. Agents: `cgtest:notes-reviewer`.
- MCP server shows as `plugin:cgtest:inner` (source `plugin`). Its tools are `mcp__plugin_cgtest_inner__<tool>`.

Marketplace (`.claude-plugin/marketplace.json`):

- Top level: `name`, `owner`, `plugins[]`, optional `$schema`, `description`, `renames` [src: official repo].
- Entry fields: `name`, `source`, `description`, `version`, `author`, `category`, `tags`, `keywords`, `homepage`, `displayName`, `strict`, `skills`, `lspServers`.
- `source` forms: `"./relative"`, `{source:"github", repo, ref?, path?, sparsePaths?}`, `{source:"git", url, ref?}`, `{source:"url", url, headers?, headersHelper?}`, `{source:"git-subdir", url, path, ref, sha}`, npm, and `settings` (inline) [src].
- `strict: false` lets the entry declare components for a repo with no `plugin.json` [src].

Install, enable, scopes [run: `claude plugin --help`]:

- `claude plugin marketplace add <owner/repo|url|path>`, then `claude plugin install name@marketplace -s user|project|local`.
- Also `enable|disable|uninstall|update|list|details|validate|prune`.
- Enabled state is `enabledPlugins: {"name@marketplace": true}` in the scope's settings file.
- Teams share marketplaces with `extraKnownMarketplaces` in `.claude/settings.json`.
- On disk: `~/.claude/plugins/known_marketplaces.json`, `installed_plugins.json`, `marketplaces/`, `cache/`, `data/` [src].
- `--plugin-dir <path>` loads a plugin for one session as `name@inline` [run].
- Precedence for `enabledPlugins`: user < project < local < flag < policy, so disable a project-enabled plugin in `settings.local.json` [src].

### Codex

Manifest search order [src: utils/plugins, exec-server-protocol]:

1. Root `plugin.json` with an `https://agent-plugins.org/schemas/...` `$schema`.
2. `.codex-plugin/plugin.json`.
3. **`.claude-plugin/plugin.json`**.
4. `.cursor-plugin/plugin.json`.

Manifest fields: `name`, `version`, `description`, `keywords`, `skills`, `mcpServers`, `apps`, `hooks`, `commands`, and `interface{displayName, shortDescription, category, capabilities, brandColor, logo, defaultPrompt, ...}`. Default component files: `skills/`, `.mcp.json`, `.app.json`, `hooks/hooks.json`.

Marketplace files searched: `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, **`.claude-plugin/marketplace.json`**, `.cursor-plugin/marketplace.json`.

Commands [run]: `codex plugin marketplace add <path|git>`, `codex plugin add name@marketplace`, `codex plugin list`, `codex plugin remove`. Config written:

```toml
[marketplaces.cg-local]
source_type = "local"            # or "git" (+ ref, sparse_paths)
source = "/path/to/marketplace"

[plugins."cgtest@cg-local"]
enabled = true
```

Cache: `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` [run].

**A Claude-format plugin from a Claude-format marketplace installed into Codex unchanged, and its skill reached the model as `cgtest:notes`** [run: `codex debug prompt-input`].

---

## 4. Skills

### Claude Code

Format: a folder with `SKILL.md`. YAML frontmatter, then the markdown body. Extra files sit beside it.

```markdown
---
name: codeword
description: Use when the user asks for the skill codeword.
---
The skill codeword is PAPAYA. Arguments were: $ARGUMENTS
```

Frontmatter [src: changelog, example-plugin]:

- `name`, `description`
- `argument-hint`
- `allowed-tools` (string or YAML list), `disallowed-tools`
- `model`, `effort`
- `context: fork` and `agent` (run in a forked subagent)
- `user-invocable` (false hides it from the `/` menu), `disable-model-invocation`
- `paths` (globs), `hooks`, `version`, `license`

Body substitutions:

- `$ARGUMENTS`, `$ARGUMENTS[0]`, and `$0`, `$1` (zero-based).
- `!` prefixed shell lines run before the prompt.
- `@file` includes a file.
- `${CLAUDE_PLUGIN_ROOT}` in plugins.

Discovery [src, run]:

- `~/.claude/skills/<name>/SKILL.md` (user).
- `.claude/skills/<name>/SKILL.md` (project).
- Nested `.claude/skills` in subfolders load when Claude works on files there. On a name clash the nested one appears as `<dir>:<name>`.
- Plugin `skills/`.
- `--add-dir` directories.

Loading:

- Only name and description are listed up front; the budget is set by `skillListingBudgetFraction` and `skillListingMaxDescChars`.
- The model calls `Skill {"skill": "codeword", "args": "zz"}`. The tool result is "Launching skill: codeword". The body then arrives as a user message starting "Base directory for this skill: <dir>" with `$ARGUMENTS` replaced [run].
- Users type `/codeword zz`.
- Controls: `skillOverrides: {name: "on"|"name-only"|"user-invocable-only"|"off"}`, `disableBundledSkills`, `Skill(name)` permission rules [src].

### Codex

Format: `SKILL.md` with frontmatter. Fields read: `name` (max 64 chars, required), `description` (required), `metadata.short-description`. A missing frontmatter block is an error [src: skills/src/parser.rs]. Optional `agents/openai.yaml` beside it holds `interface` (display name, icons, brand color, default prompt), `dependencies.tools` (MCP servers to install) and `policy.allow_implicit_invocation` [src].

Roots [src: ext/skills/src/host_roots.rs; run]:

| Scope | Path |
| --- | --- |
| Repo | `.agents/skills/` in every folder from the project root (marker `.git`) to cwd |
| Repo | `<repo>/.codex/skills/` (trusted project layers) |
| User | `~/.agents/skills/`, and the deprecated `$CODEX_HOME/skills/` |
| System | `$CODEX_HOME/skills/.system/` (bundled, e.g. `imagegen`, `openai-docs`) |
| Admin | `/etc/codex/skills/` |
| Plugin | `<plugin>/skills/` |

Loading: a developer message `<skills_instructions>` lists a table of skill roots (`r0`, `r1`, ...) and `- name: description (file: rN/<name>/SKILL.md)`. The body is not preloaded; the model reads the file when needed [run]. Users invoke a skill with a `$skill-name` mention or `/skills` [src: skills/src/mentions.rs]. Turn skills on or off with `[[skills.config]] path|name = ..., enabled = false`. The catalog budget is `skills.max_context_tokens` (default 2% of the context window, capped at 10,000 tokens) [src: schema].

---

## 5. Slash commands and custom prompts

### Claude Code

- Files: `.claude/commands/<name>.md` (project) [run] and `~/.claude/commands/<name>.md` (user). Subfolder namespacing [unverified].
- Same frontmatter as skills (`description`, `argument-hint`, `allowed-tools`, `model`, `effort`, `disable-model-invocation`).
- Commands and skills are listed together. A skill folder can serve as a command.
- `$1` is the **second** argument: `/hello Alice Bob` with `$1 / all=$ARGUMENTS` rendered `Bob / all=Alice Bob` [run]. Positional args are zero-based (`$0`, `$1`, or `$ARGUMENTS[0]`) [src: changelog].
- MCP prompts become slash commands [src: changelog]; the exact `/mcp__<server>__<prompt>` spelling is [unverified]. The `UserPromptExpansion` hook sees `expansion_type: "slash_command"|"mcp_prompt"` [src].

### Codex

- The old `~/.codex/prompts/*.md` custom prompts are **gone** from current source (no prompts loader found) [src: grep].
- Reusable inputs are now TUI presets: `[tui.presets."<0-9>"] input = "...", label = "..."`, run from `/presets` [src: tui/src/app/quick_dials.rs].
- Plugin manifests can still declare `commands` paths [src]. Skills replace most custom-prompt uses.
- Built-in slash commands include `/skills`, `/hooks`, `/mcp`, `/plugins`, `/agents`, `/memories`, `/import`, `/init`, `/review`, `/plan`, `/compact` [src: tui/src/slash_command.rs].

---

## 6. Subagents

### Claude Code

Definition: markdown with frontmatter in `.claude/agents/*.md` (project), `~/.claude/agents/*.md` (user), plugin `agents/`, or JSON via `--agents '{"name": {...}}'` / SDK `agents` [run]. The body is the system prompt.

```markdown
---
name: lister
description: Lists files. Use when asked to list files with the lister agent.
tools: Bash
model: haiku
---
You list files. Run the exact shell command you are given with Bash and return its raw output only.
```

Fields [src: `AgentDefinition`, changelog]:

- `name`, `description` (required).
- `tools` (allow list; omitted = inherit all; `Agent(type)` limits which subagents it may spawn), `disallowedTools`.
- `model` (`sonnet|opus|haiku|inherit|<full id>`), `effort`, `permissionMode`, `maxTurns`.
- `skills` (preloaded), `mcpServers`, `hooks`.
- `memory` (`user` → `~/.claude/agent-memory/<type>/`, `project` → `.claude/agent-memory/<type>/`, `local` → `.claude/agent-memory-local/<type>/`).
- `background`, `initialPrompt`, `omitClaudeMd`, `autoCompactWindow`, `color`.
- `color` is optional. plugin-dev wrongly calls `model` and `color` required.

Invocation [run]:

- The main model calls `Agent {"subagent_type": "lister", "description": "...", "prompt": "...", "run_in_background": false}`.
- The subagent's tool calls carry `parent_tool_use_id`. Hooks inside it get `agent_id` and `agent_type`.
- The result returns as a tool result.
- The transcript is at `<session>/subagents/agent-<id>.jsonl`.
- Built-ins in `system/init.agents`: `general-purpose`, `Explore`, `Plan`, `statusline-setup`, `claude`.
- `--agent <name>` runs a definition as the main thread.
- Subagent model precedence: definition `model` or the per-spawn model, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model [src].

Name clashes between user and project agents: project wins [unverified].

### Codex

Roles are TOML files, discovered recursively under `<config folder>/agents/**/*.toml` in each layer (`~/.codex/agents/`, `<repo>/.codex/agents/`), or declared in `config.toml` [src: agent-roles/src]:

```toml
# ~/.codex/agents/reviewer.toml
name = "reviewer"
description = "Reviews diffs for bugs. Use for code review."   # required
nickname_candidates = ["Rex"]
# any config.toml key may follow and applies to that agent only:
model = "gpt-5.5"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """You review code. Report bugs with file:line."""
```

```toml
# config.toml
[agents]
max_concurrent_threads_per_session = 4
default_subagent_model = "..."
[agents.reviewer]
description = "..."
config_file = "agents/reviewer.toml"
```

- Built-in roles: `default`, `explorer`, `worker` [src: core/src/agent/role.rs].
- The model spawns with `spawn_agent {message|items, agent_type, model?, reasoning_effort?, fork_context|fork_turns}`. Follow-ups use `send_input`/`followup_task`, then `wait_agent`, then `close_agent`.
- Codex's own Claude importer maps a Claude agent file to this TOML [src: external-agent-migration/src/subagents.rs]:
  - `name` and `description` copy over.
  - The body becomes `developer_instructions`.
  - `effort` maps to `model_reasoning_effort` (`max` → `xhigh`).
  - `permissionMode: acceptEdits` → `sandbox_mode = "workspace-write"`.
  - `tools` and `model` are dropped.

---

## 7. MCP

### Claude Code

Files and scopes [run: `claude mcp add`]:

| Scope | Where | Flag |
| --- | --- | --- |
| local (default) | `~/.claude.json` → `projects["<path>"].mcpServers` | `-s local` |
| user | `~/.claude.json` → `mcpServers` | `-s user` |
| project | `.mcp.json` at repo root (needs a one-time approval per server) | `-s project` |
| dynamic | `--mcp-config <file or json>` (`--strict-mcp-config` ignores all others) | |
| plugin | `<plugin>/.mcp.json` or `mcpServers` in `plugin.json` | |
| managed | `managed-mcp.json`, `managedMcpServers` (http/sse only), `allowedMcpServers` / `deniedMcpServers` | |
| agent | `mcpServers` in agent frontmatter | |

`.mcp.json` as written by `claude mcp add -s project` [run]:

```json
{
  "mcpServers": {
    "memtest": { "type": "stdio", "command": "npx", "args": ["-y", "pkg", "--flag"], "env": { "FOO": "bar" } },
    "webtest": { "type": "http", "url": "https://example.invalid/mcp", "headers": { "Authorization": "Bearer xyz" } }
  }
}
```

- Transports: `stdio` (default), `http`, `sse`, `ws`, and SDK in-process. Per-server `timeout` (ms) and `alwaysLoad` [src].
- `${VAR}` and `${VAR:-default}` expansion in config [unverified for the default form].
- Unapproved `.mcp.json` servers show "Pending approval" and are not connected [run]. Approval settings: `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`.
- Auth: `--header`, OAuth via `claude mcp login <name>` (with `--client-id`, `--client-secret`, `--callback-port`) [run: `--help`].
- Tool naming: `mcp__<server>__<tool>` [run: `--mcp-config` server `cc-mcp` gave `mcp__cc-mcp__Read`]. Plugin servers: `mcp__plugin_<plugin>_<server>__<tool>` [run].
- When tool search is on, MCP tools are deferred behind `ToolSearch` unless `alwaysLoad: true` [src].
- `claude mcp serve` exposes Claude Code's own tools as an MCP server [run].

### Codex

`config.toml` [run: `codex mcp add`]:

```toml
[mcp_servers.memtest]
command = "npx"
args = ["-y", "basic-memory-fake", "--flag"]
[mcp_servers.memtest.env]
FOO = "bar"

[mcp_servers.webtest]
url = "https://example.invalid/mcp"         # streamable HTTP
bearer_token_env_var = "MY_TOKEN"
```

- Other fields [src]: `cwd`, `env_vars` (names to pass through), `http_headers`, `env_http_headers`, `startup_timeout_sec` (default 30), `tool_timeout_sec` (default 300), `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode` and per-tool `[mcp_servers.x.tools.<tool>] approval_mode` (`auto|prompt|writes|approve`), `oauth`, `scopes`, `startup_readiness`.
- Scopes are config layers: user `~/.codex/config.toml`, project `.codex/config.toml` (only when trusted), plus plugins.
- CLI: `codex mcp add|list|get|remove|login|logout` [run].
- Tool naming: `mcp__<server>__<tool>` [src].
- OAuth credentials: `mcp_oauth_credentials_store` (`keyring`, file or auto) [src].

---

## 8. Settings precedence

### Claude Code

Lowest to highest [src: sdk.d.ts `enabledPlugins` doc]: user `~/.claude/settings.json` < project `.claude/settings.json` < local `.claude/settings.local.json` < flag (`--settings`, SDK) < policy.

- Policy sources: `managed-settings.json` (`/etc/claude-code/` on Linux, `C:\Program Files\ClaudeCode\` on Windows, plus a `managed-settings.d/` folder), macOS plist `com.anthropic.claudecode`, Windows HKLM, server-managed settings [src].
- Permission arrays merge across sources [unverified]. Deny wins at evaluation time [run].
- `--setting-sources user,project,local` limits what loads.
- In `-p` mode, invalid settings files are silently ignored.
- Global state (trust, MCP local/user scope, OAuth flags) lives in `~/.claude.json`, not in settings.

### Codex

Lowest to highest [src: config/src/loader/mod.rs]:

1. Packaged defaults.
2. macOS MDM.
3. `/etc/codex/config.toml` (Windows: `%ProgramData%\OpenAI\Codex\config.toml`).
4. Cloud managed bundle.
5. `$CODEX_HOME/config.toml` (default `~/.codex`).
6. Profile `$CODEX_HOME/<name>.config.toml` (`-p/--profile`).
7. `.codex/config.toml` in each folder from the repo root down to cwd, loaded but **disabled unless the project is trusted** (`[projects."<path>"] trust_level = "trusted"`).
8. Session flags (`-c key=value`, `--enable/--disable <feature>`).
9. Legacy `managed_config.toml`.

Hard limits come from `requirements.toml` (`/etc/codex/requirements.toml`, MDM, cloud). These limits cannot be loosened by any layer.

---

## 9. Memory and instruction files

### Claude Code

Loaded at start [run unless noted]:

| Kind | Path | `memory_type` |
| --- | --- | --- |
| Managed | `/etc/claude-code/CLAUDE.md` (platform policy dir) [unverified path] | Managed |
| User | `~/.claude/CLAUDE.md` [src]; `~/.claude/rules/*.md` [unverified] | User |
| Project | `./CLAUDE.md` [run] (`./.claude/CLAUDE.md` [unverified]), and the same in parent folders [unverified] | Project |
| Rules | `.claude/rules/**/*.md`; no `paths:` frontmatter = always loaded | Project |
| Local | `./CLAUDE.local.md` | Local |

- `.claude/rules/*.md` with `paths:` frontmatter (glob or YAML list) loads only when a matching file is read, written or edited. My `paths: ["src/**/*.py"]` rule did not load in a session that touched no such file [run].
- Nested `CLAUDE.md` in subfolders also load on file access [src].
- Imports: `@path/to/file.md` anywhere in a memory file. The imported file reports `load_reason: "include"` and `parent_file_path` [run].
- `AGENTS.md`: in a project with **no** `CLAUDE.md`, Claude reads `AGENTS.md` instead. A built-in `cc-plugin-agents-md@builtin` plugin shows in `system/init` [src, run].
- Auto memory: `~/.claude/projects/<cwd with / replaced by ->/memory/` (`system/init.memory_paths.auto`) [run]. The index `MEMORY.md` is truncated at 200 lines or 25 KB. Other settings: `autoMemoryDirectory`, and `/memory` [src].
- Excludes: `claudeMdExcludes` (globs). `--bare` skips CLAUDE.md discovery [src].

### Codex

AGENTS.md discovery [src: core/src/agents_md.rs; run: `codex debug prompt-input`]:

- Global: `$CODEX_HOME/AGENTS.override.md`, else `$CODEX_HOME/AGENTS.md`.
- Project: walk from the project root (first ancestor holding a `project_root_markers` entry, default `.git`) down to cwd. In each folder take the **first** of `AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames` entries. Concatenate root first.
- Test: root `AGENTS.md` (ALPHA), `sub/AGENTS.md` (BETA), `sub/AGENTS.override.md` (GAMMA), `sub/deeper/CLAUDE.md` (DELTA). From `sub/deeper` the model saw ZETA (global), ALPHA, GAMMA. BETA was shadowed. DELTA appeared only with `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`.
- Delivered as one **user-role** message: `# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>\n<global>\n\n--- project-doc ---\n\n<root>\n\n<...>\n</INSTRUCTIONS>`.
- Cap: `project_doc_max_bytes` (default 32768) across all files. No `@import` syntax.
- Other knobs: `developer_instructions` (developer message), `instructions`, `model_instructions_file` (replaces built-in instructions; discouraged).

Codex memories [src: codex-rs/memories/README.md]:

- Background two-phase pipeline. Phase 1 extracts per-thread memories into the state DB. Phase 2 consolidates them into `~/.codex/memories/` (`MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries/`, `skills/`), git-baselined.
- Config: `[memories] generate_memories, use_memories, extract_model, consolidation_model, max_rollout_age_days, min_rollout_idle_hours, max_unused_days, dedicated_tools`.
- `/memories` in the TUI. Sub-agent sessions are excluded.

---

## 10. What this means for Conclave

- **One plugin format serves both.** Codex reads `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, gives plugin hooks `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`, and namespaces skills as `plugin:skill` like Claude [run, src]. Conclave can keep the Claude plugin layout as its native format and export to both.
- **Hooks are near-identical.** Same event names, same `{matcher, hooks:[{type:"command"}]}` shape, same stdin keys, same exit-2 and `hookSpecificOutput` contract. Codex adds hook trust hashes, has 12 events vs Claude's 33, and treats a hyphenated matcher as a regex.
- **Skills differ by root, not format.** Claude reads `.claude/skills`. Codex reads `.agents/skills` and `~/.agents/skills`. Both use `SKILL.md` with `name` + `description` and list only metadata up front.
- **Subagents differ in format.** Claude uses markdown frontmatter. Codex uses TOML roles with `developer_instructions`. Codex's own importer defines the mapping.
- **Instruction files differ.** Claude: `CLAUDE.md` + `CLAUDE.local.md` + `.claude/rules` + `@imports`, and `AGENTS.md` only when there is no `CLAUDE.md`. Codex: `AGENTS.override.md` > `AGENTS.md` > fallbacks per folder, no imports, 32 KiB cap.

Gaps seen in Conclave's current code (read only, for the integrator):

- `packages/core/src/extensions/hooks.ts`: default hook timeout is 60 s. Both CLIs use 600 s. `CLAUDE_ENV_FILE` is not provided. Commands run via `sh -c`, while Codex uses `$SHELL -lc` and Claude bash.
- `packages/core/src/extensions/instructions.ts`: no `.claude/rules/` (with `paths:`), no `AGENTS.override.md`, no `project_doc_fallback_filenames`, no "AGENTS.md only when no CLAUDE.md" rule.
- `packages/core/src/extensions/registry.ts`: scans `~/.claude`, `<cwd>/.claude`, plugins and `.conclave`. It does not scan Codex's `.agents/skills` or `~/.agents/skills`.
- `packages/core/src/extensions/commands.ts` `substituteArgs`: `$1` is the first token (1-based). Claude Code makes `$0` the first and `$1` the second [run], and also supports `$ARGUMENTS[0]`. Claude commands imported as-is will get shifted arguments.
- `packages/core/src/extensions/cli-sync.ts` `syncAgent`: writes `~/.codex/agents/<name>.md`. Codex reads only `*.toml` there (section 6), so Codex never sees these agents. Skills are synced to `~/.codex/skills`, which Codex still reads but marks deprecated; `~/.agents/skills` is the current path.

---

## 11. Behaviors a test can check

Claude Code (CLI 2.1.301):

1. [run] Project `CLAUDE.md`, `@docs/extra.md` import, `.claude/rules/always.md` (no `paths`) and `CLAUDE.local.md` all reach the model in `-p` mode.
2. [run] A rule with `paths: ["src/**/*.py"]` does not load when no matching file is touched.
3. [run] `InstructionsLoaded` fires once per loaded file. An import reports `load_reason: "include"` and `parent_file_path`.
4. [run] A SessionStart hook printing `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"X"}}` puts X in model context.
5. [run] SessionStart stdin has `source: "startup"`. `CLAUDE_ENV_FILE` is set only for SessionStart.
6. [run] PreToolUse exit 2 with stderr S gives tool result `PreToolUse:Bash hook error: [<cmd>]: S`, and the tool does not run.
7. [run] PreToolUse JSON `permissionDecision: "deny"` with reason R gives tool result `PreToolUse:Bash hook error: R`.
8. [run] Stop hook `{"decision":"block","reason":"R"}` makes the model continue with "Stop hook feedback:\nR". The next Stop stdin has `stop_hook_active: true`.
9. [run] Hooks inside a subagent carry `agent_id` and `agent_type`. SubagentStop carries `agent_transcript_path` and `last_assistant_message`.
10. [run] PostToolUse for Bash has `tool_response.stdout/stderr/interrupted` and `duration_ms`.
11. [run] Permission order: deny beats ask beats allow for `Bash(...)` patterns.
12. [run] In `-p` with an untrusted folder, project `permissions.allow` is ignored (stderr notice) and `--settings` rules apply.
13. [run] `/hello Alice Bob` with body `$1 / all=$ARGUMENTS` renders `Bob / all=Alice Bob`.
14. [run] Skill call shape is `Skill {"skill","args"}`. The body arrives prefixed "Base directory for this skill: <dir>".
15. [run] Subagent call shape is `Agent {"subagent_type","description","prompt","run_in_background"}`. `tools: Bash` limits it to Bash.
16. [run] `claude mcp add -s project` writes `.mcp.json` with `{"mcpServers": {name: {type, command, args, env}}}`. The server stays "Pending approval" until approved.
17. [run] `--mcp-config` servers are `source: "dynamic"`. Tools are named `mcp__<server>__<tool>`.
18. [run] Plugin via `--plugin-dir`: names `plugin:cmd`, `plugin:skill`, `plugin:agent`. MCP server `plugin:<plugin>:<server>`, tools `mcp__plugin_<plugin>_<server>__<tool>`. Hook env has `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`.
19. [run] `claude plugin validate` passes a plugin with `userConfig` and warns on an unquoted `${CLAUDE_PLUGIN_ROOT}` in a shell-form hook.
20. [src] Default tool-hook timeout is 600 s. SessionEnd hooks default to 1.5 s.
21. [src] A hyphenated matcher (`code-reviewer`) matches exactly. `"Bash,PowerShell"` matches both.
22. [src] `AGENTS.md` is read only when the project has no `CLAUDE.md`.
23. [unverified] Plain (non-JSON) stdout from UserPromptSubmit/SessionStart exit 0 becomes context.
24. [unverified] Project agents override user agents with the same name.

Codex (0.163.0 / main):

25. [run] `codex mcp add NAME --env K=V -- cmd args` writes `[mcp_servers.NAME]` with `command`, `args` and `[mcp_servers.NAME.env]`. `--url` + `--bearer-token-env-var` writes `url` and `bearer_token_env_var`.
26. [run] `codex execpolicy check`: `git status` allow, `git push origin` prompt, `rm -rf /x` forbidden, `ls` no match. The strictest match wins.
27. [run] AGENTS.md: global, then root, then per-folder first-of (`AGENTS.override.md`, `AGENTS.md`). The override shadows the sibling AGENTS.md. `CLAUDE.md` is ignored unless listed in `project_doc_fallback_filenames`. The separator is `--- project-doc ---`.
28. [run] Skills under `.agents/skills/<name>/SKILL.md` appear in `<skills_instructions>` as `name: description (file: rN/...)`. The body is not inlined.
29. [run] A plugin with only `.claude-plugin/plugin.json`, from a marketplace with only `.claude-plugin/marketplace.json`, installs via `codex plugin marketplace add` + `codex plugin add name@mkt`. It is cached under `plugins/cache/<mkt>/<plugin>/<version>`, and its skills show as `plugin:skill`.
30. [src] Hook matcher `Bash` matches the shell tool. `Write|Edit` matches `apply_patch`. `Agent` matches `spawn_agent`.
31. [src] A user or project hook with no matching `trusted_hash` does not run. `--dangerously-bypass-hook-trust` runs it.
32. [src] PreToolUse exit 2 with empty stderr is a failure, not a block.
33. [src] Project `.codex/config.toml` (including its MCP servers, hooks and rules) is ignored unless `[projects."<path>"] trust_level = "trusted"`.
34. [src] Agent role TOML under `~/.codex/agents/` without `description` (and no `[agents.<name>].description`) fails to load.
35. [src] `notify` receives one JSON argv with `type: "agent-turn-complete"` and kebab-case keys.
