# OpenCode and Gemini CLI: tools, hooks, plugins, skills, agents, MCP, memory

Research notes for Conclave's extension layer. Companion to `research-claude-code-codex.md`. Exact formats, file locations and precedence for OpenCode and Gemini CLI, plus short notes on Cursor CLI and Goose.

Versions checked (2026-10-16):

- **OpenCode V1**: npm `opencode-ai@1.19.3` (the `latest` tag), branch `v1` of `sst/opencode` (the repo now lives at `anomalyco/opencode`). I ran the 1.19.3 Linux binary.
- **OpenCode V2**: branch `dev` (2.0.31), released as 2.0.30 on 2026-10-15. Installed only with `curl -fsSL https://opencode.ai/v2/install | bash`, which replaces the V1 binary. Docs read from `services/www/src/docs/content`. Not run.
- **Gemini CLI**: `google-gemini/gemini-cli` main (0.66.0-nightly). I ran npm `@google/gemini-cli@0.64.0`.
- **Goose**: `block/goose` docs at HEAD. **Cursor**: docs site blocked by the proxy, notes from memory only.

Tags:

- **[run]** I ran it and saw the result.
- **[src]** I read it in source code or tests.
- **[doc]** only in the project's own docs.
- **[unverified]** from memory.

Where docs and source disagree, both are given and the source wins.

How the runs were done: each CLI got its own `HOME` (and XDG dirs). OpenCode used a custom provider (`@ai-sdk/openai-compatible`, bundled) pointed at a local mock server that replays tool calls, a local plugin that logs every hook, and a small stdio MCP server. Gemini ran hooks in `-p` mode with a fake API key: hooks before the model call fire, then the API call fails.

---

## 0. Which OpenCode

- `npm i -g opencode-ai` still gives V1 (1.19.3). V2 is a separate curl install with the same `opencode` command and the same config paths [src: npm dist-tags, install script].
- V2 keeps V1 agents, commands, skills, MCP config, permissions and `.opencode/` files [doc: migrate-v1.mdx].
- V2 breaks: the plugin API (V1 plugin code does not run in V2), the server API, and TUI config (moves to one `cli.json`) [doc].
- For Conclave: treat config, agents, commands, skills and MCP as shared. Write plugins for V1 now; one package can carry both (section 3).

---

## 1. Built-in tools and permissions

### OpenCode (V1)

Tool IDs, as permission keys and plugin `input.tool` [src: tool/registry.ts]:
`bash`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `task`, `webfetch`, `todowrite`, `websearch`, `skill`, `question`, `lsp`, `plan_exit`, plus internal `invalid`.

- `apply_patch` replaces `edit` and `write` when the model ID contains `gpt-` (but not `gpt-4` or `oss`) [src].
- `websearch` only with the OpenCode provider, `OPENCODE_ENABLE_EXA` or `OPENCODE_ENABLE_PARALLEL` [src]. `lsp` only with `OPENCODE_EXPERIMENTAL_LSP_TOOL=true` [src].
- MCP resource tools `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` appear when a server has resources [src].
- In `opencode run` the model got: `bash, edit, glob, grep, read, skill, task, todowrite, write` plus MCP tools. No `question` [run].
- `bash` arguments: `{command, timeout?, workdir?, description}` [src].

Permissions live in `opencode.json` [src: permission/index.ts]:

```json
{
  "permission": {
    "*": "ask",
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
    "edit": { "*": "deny", "docs/**": "allow" },
    "external_directory": { "~/notes/**": "allow" },
    "mymcp_*": "deny"
  }
}
```

- Actions: `allow`, `ask`, `deny`. A plain string means pattern `*`. `"permission": "allow"` sets everything.
- Rules are flattened in order and the **last match wins** (`findLast` on key wildcard and pattern wildcard). No match means `ask` [src].
- Wildcards: `*` any characters, `?` one character. `~` and `$HOME` expand [doc].
- Extra keys: `external_directory` (path outside the project), `doom_loop` (same call 3 times). `edit` covers `edit`, `write`, `apply_patch`. MCP tools use their full tool name as the key [src].
- A tool whose last matching rule is `{"*": "deny"}` is **removed from the model's tool list** [src, run: `webfetch: deny` hid webfetch; `my_mem_delete*: deny` hid that MCP tool].
- Order inside one agent's ruleset [run: `opencode debug agent`]:
  - built-in agents: defaults, then the agent's built-in rules, then the user's config `permission`. So user config beats built-in agent defaults.
  - custom agents: defaults, then user config, then the agent's own `permission`. So agent frontmatter beats user config.
- Defaults [src, run]: `*: allow`, `doom_loop: ask`, `external_directory: ask` (tmp and skill folders allowed), `question: deny` (build and plan allow it), `read: {"*.env": ask, "*.env.*": ask, "*.env.example": allow}`. **Docs say `.env` reads are denied; the code asks.**
- `plan` agent: `edit: {"*": deny, ".opencode/plans/*.md": allow}` and `task.general: deny` [run]. **Docs say plan asks before edits; the code denies.**
- Subagents get `task` and `todowrite` denied unless their own permission names them [src: tool/task.ts].
- Ask choices: once, always (rest of the session), reject [doc]. `--auto` approves asks but keeps denies [doc].
- `opencode run` without `--auto` auto-rejects asks: `permission requested: bash (ask me); auto-rejecting` [run].
- A deny reaches the model as a tool error: "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [...]" [run].
- `OPENCODE_PERMISSION='{"bash":"deny"}'` (JSON) is deep-merged over the config permission [src].
- Legacy `tools: {name: bool}` still works: `true` = allow, `false` = deny, `write/edit/patch` map to `edit` [src].

### Gemini CLI

Tool names [doc: reference/tools.md, src: tool-names.ts]:
`run_shell_command`, `glob`, `grep_search` (alias `search_file_content`), `list_directory`, `read_file`, `read_many_files`, `replace`, `write_file`, `ask_user`, `write_todos`, `activate_skill`, `get_internal_docs`, `enter_plan_mode`, `exit_plan_mode`, `google_web_search`, `web_fetch`, `list_mcp_resources`, `read_mcp_resource`, `complete_task` (subagents only), `update_topic`, `tracker_*` (experimental). Each subagent is also a tool named after the agent.

There is **no `save_memory` tool** any more. The system prompt says so, and memory is edited with `replace` and `write_file` [src: prompts/snippets.ts].

Permissions are approval mode plus a TOML policy engine [doc: policy-engine.md, src: policy/config.ts]:

- Modes: `default`, `auto_edit` (`autoEdit` in TOML), `plan`, `yolo`. Set with `--approval-mode` or `general.defaultApprovalMode`. `yolo` only from the command line [run: `--help`, doc].
- Policy files: `~/.gemini/policies/*.toml` (user), `/etc/gemini-cli/policies/` (admin on Linux; must be root-owned and not group/other writable), `--policy`, `--admin-policy`, `policyPaths`, `adminPolicyPaths`, extension `policies/*.toml`.
- Workspace `.gemini/policies/` is **not loaded**: `disableWorkspacePolicies = true` in `cli/src/config/policy.ts` [src].
- Tiers: default 1, extension 2, workspace 3, user 4, admin 5. Final priority = tier + priority/1000, priority 0 to 999. Highest wins [src]. (The doc's worked examples use other bases.)
- Settings turned into rules inside the user tier: `mcp.excluded` 4.9, `--exclude-tools` 4.4, `--allowed-tools` 4.3, trusted MCP server 4.2, `mcp.allowed` 4.1 [src].

```toml
[[rule]]
toolName = "run_shell_command"        # or an array; "*", "mcp_*", "mcp_server_*", "mcp_*_tool"
mcpName = "basic-memory"              # optional, joins with toolName
subagent = "codebase_investigator"    # optional
argsPattern = '"command":"(git|npm)'  # regex over the args as stable JSON
commandPrefix = "git"                 # or commandRegex (not both)
toolAnnotations = { readOnlyHint = true }
decision = "ask_user"                 # allow | deny | ask_user
priority = 100
modes = ["default", "autoEdit"]
interactive = true
denyMessage = "Explain why"
```

- `deny` without `argsPattern` hides the tool from the model. `ask_user` in headless mode = deny [doc].
- Extension policies cannot `allow` or turn on yolo; those parts are ignored [doc].
- MCP calls ask per call with "always allow tool" and "always allow server" options. `trust: true` on a server skips prompts [doc].
- **Folder trust is on by default** (`security.folderTrust.enabled: true`) [src, run]. In an untrusted folder: workspace settings, `.env`, every MCP server (user ones too) and custom commands are off. `GEMINI_CLI_TRUST_WORKSPACE=true` or `--skip-trust` trusts for one run. Choices are saved in `~/.gemini/trustedFolders.json`. The trusted-folders doc page still says "disabled by default".

---

## 2. Hooks

### OpenCode: only plugin hooks, no shell hooks

V1 config has no hooks key [src: core/src/v1/config/config.ts]. Hooks are functions returned by a JS/TS plugin (section 3). Signature `(input, output) => Promise<void>`; change `output` in place [src: packages/plugin/src/index.ts]:

| Hook | input | output (mutable) |
|---|---|---|
| `event` | `{event}` | none |
| `config` | resolved config | none |
| `chat.message` | `{sessionID, agent?, model?, messageID?, variant?}` | `{message, parts}` |
| `chat.params` | `{sessionID, agent, model, provider, message}` | `{temperature, topP, topK, maxOutputTokens, options}` |
| `chat.headers` | same as `chat.params` | `{headers}` |
| `permission.ask` | Permission | `{status}` |
| `command.execute.before` | `{command, sessionID, arguments}` | `{parts}` |
| `tool.execute.before` | `{tool, sessionID, callID}` | `{args}` |
| `tool.execute.after` | `{tool, sessionID, callID, args}` | `{title, output, metadata}` |
| `shell.env` | `{cwd, sessionID?, callID?}` | `{env}` |
| `tool.definition` | `{toolID}` | `{description, parameters}` |
| `experimental.chat.system.transform` | `{sessionID?, model}` | `{system: string[]}` |
| `experimental.chat.messages.transform` | `{}` | `{messages}` |
| `experimental.session.compacting` | `{sessionID}` | `{context: string[], prompt?}` |
| `experimental.compaction.autocontinue` | `{sessionID, agent, model, provider, message, overflow}` | `{enabled}` |

Plus `tool` (custom tool map), `auth`, `provider`, `dispose`.

Behavior:

- Hooks from all plugins run one after another in load order. Later hooks see earlier changes [src, run].
- **Throwing in `tool.execute.before` blocks the call.** The error message is the tool result the model sees. Later plugins' `before` hooks do not run [run: "blocked by plugin A"].
- Changing `output.args` changes the real call [run: command rewritten, the second plugin saw the new args].
- `tool.execute.before` runs **before the permission check**, so it also sees calls that are then denied or asked [run].
- **`permission.ask` is declared but never called in V1** [src: no trigger; run: not called when a permission was asked]. Watch `event` for `permission.asked`, or use V2 `ctx.permission.hook("evaluate")`.
- MCP tools fire the same hooks with `tool` = `server_tool`. For MCP, `tool.execute.after` gets the raw MCP result (`content` array), so `output.output` is undefined [run].
- `shell.env` applies to the bash tool and user terminals [src, run: `$PLUGIN_VAR` was set].
- No matcher, timeout or exit code. Filter in code. A slow hook stalls the loop.
- `event` is fire and forget (not awaited) [src]. Event types include `session.idle`, `session.error`, `session.created`, `permission.asked`, `permission.replied`, `file.edited`, `message.updated`, `todo.updated`, `command.executed` [doc, run].

V2 hooks (not run) [doc: build/plugins]: registered in `setup(ctx)` with one mutable `event` argument:

- `ctx.tool.hook("execute.before" | "execute.after", fn)`
- `ctx.session.hook("prompt" | "context" | "compaction" | "model.request" | "http.request" | "http.response" | "retry", fn)`
- `ctx.permission.hook("evaluate", fn)`: runs for allow and ask, not for a configured deny. It may set `event.effect` (`allow|ask|deny`) and `event.message`.
- `ctx.shell.hook("create.before", fn)`: edit `command, cwd, timeout, shell, env`.

### Gemini CLI

Configured in `settings.json` under `hooks`, or in an extension's `hooks/hooks.json` [doc, src]:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "run_shell_command|write_file|replace",
        "sequential": false,
        "hooks": [
          {
            "type": "command",
            "name": "guard",
            "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/guard.sh",
            "timeout": 5000,
            "description": "block rm -rf",
            "env": { "GUARD_MODE": "strict" }
          }
        ]
      }
    ]
  },
  "hooksConfig": { "enabled": true, "disabled": ["guard"], "notifications": true }
}
```

- 11 events: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification` [src: hooks/types.ts]. Unknown event names are skipped.
- Matchers: tool events use a regex (exact match if the regex is invalid). Lifecycle events use an exact string such as `startup`. `*` or empty matches all [src: hookPlanner.ts].
- If any matching group has `sequential: true`, all matching hooks run one by one; otherwise in parallel. Identical hooks (`name:command`) run once [src].
- Hook arrays from all settings files are concatenated (system defaults, user, workspace, system), then extension hooks are added. In an untrusted folder the settings hooks are skipped [src: CONCAT merge, hookRegistry.ts].
- Project hooks are fingerprinted by name and command. A changed hook warns as untrusted [doc].
- Execution: platform shell, cwd = session cwd, JSON on stdin, default timeout 60000 ms [src: hookRunner.ts].
- `$GEMINI_PROJECT_DIR`, `$GEMINI_CWD`, `$GEMINI_PLANS_DIR`, `$GEMINI_SESSION_ID` and `$CLAUDE_PROJECT_DIR` are replaced in the command string (shell-escaped) and also set as env vars [src, run].
- **Hook env is the full parent env** unless `security.environmentVariableRedaction.enabled` is true (default false) or the run is in GitHub Actions [src, run: the hook saw `*_TOKEN` vars]. The hooks doc calls it "sanitized".

stdin (base fields seen in runs: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`) [run]:

| Event | Extra input |
|---|---|
| `SessionStart` | `source`: `startup`, `resume`, `clear` [run] |
| `BeforeAgent` | `prompt` (after slash command expansion) [run] |
| `BeforeModel` | `llm_request {model, messages[{role, content}], config}` [run] |
| `BeforeTool` | `tool_name`, `tool_input`, `mcp_context?`, `original_request_name?` [doc] |
| `AfterTool` | same plus `tool_response {llmContent, returnDisplay, error?}` [doc] |
| `AfterAgent` | `prompt`, `prompt_response`, `stop_hook_active` [doc] |
| `AfterModel` | `llm_request`, `llm_response` (per streamed chunk) [doc] |
| `SessionEnd` | `reason`: `exit`, `clear`, `logout`, `prompt_input_exit`, `other` [doc] |
| `Notification` | `notification_type: "ToolPermission"`, `message`, `details` [doc] |
| `PreCompress` | `trigger`: `auto`, `manual` [doc] |

Output: stdout (or stderr when stdout is empty) is parsed as JSON [src]. Fields: `systemMessage`, `suppressOutput`, `continue`, `stopReason`, `decision` (`allow`, `deny`, `block`, `ask`, `approve`), `reason`, and `hookSpecificOutput` with `additionalContext`, `tool_input` (merged into args), `llm_request`, `llm_response`, `toolConfig {mode, allowedFunctionNames}`, `clearContext`, `tailToolCallRequest {name, args}` [doc, src].

Exit codes when the output is not JSON [src: hookRunner.ts, run]:

- `0`: allow; the text becomes `systemMessage`.
- `1`: warning; the action continues.
- **any other non-zero code (2, 3, ...)**: deny, the text is the reason. The docs say only 2 blocks and other codes warn.
- JSON output is used as-is, whatever the exit code.
- On timeout the hook is killed and the action continues (fails open) [src, run].

Effects:

- `BeforeAgent` deny drops the prompt. With `-p -o json` the CLI exits 0 and adds the warning `Agent execution blocked: <reason>` [run].
- `BeforeTool` deny or exit 2: the reason goes to the model as a tool error and the turn continues [doc].
- `AfterAgent` deny: the reason becomes a new prompt and the agent retries [doc].
- `BeforeModel` can return a synthetic `llm_response` and skip the model [doc].
- `BeforeToolSelection`: allowlists from several hooks are merged; mode `NONE` wins [doc].
- `SessionEnd` is not awaited. It did not fire when the run ended with an API error [run].
- `PreCompress` and `Notification` are advisory [doc].

Management: `/hooks panel`, `/hooks enable|disable <name>`, `/hooks enable-all|disable-all` [doc]. `type: "runtime"` hooks (JS functions) exist for extensions and the SDK and rank first [src].

`gemini hooks migrate --from-claude` reads `.claude/settings.json` and writes `.gemini/settings.json` [run]:

- Events: `PreToolUse -> BeforeTool`, `PostToolUse -> AfterTool`, `UserPromptSubmit -> BeforeAgent`, `Stop -> AfterAgent`, `PreCompact -> PreCompress`, `SessionStart` and `Notification` unchanged.
- Matchers: `Bash -> run_shell_command`, `Edit -> replace`, `Write -> write_file`, `Read -> read_file`. `$CLAUDE_PROJECT_DIR -> $GEMINI_PROJECT_DIR`.
- Bugs: `timeout: 5` (Claude seconds) is copied as `5` (Gemini milliseconds). `SubagentStop` is copied although Gemini has no such event.

---

## 3. Plugins and extensions

### OpenCode V1 plugins

Load order [doc, src]:

1. npm specs in `plugin` of the global config, then the project config. Spec: `"name"`, `"name@1.2.3"` or `["name", {options}]`.
2. `~/.config/opencode/plugins/*.{ts,js}` (also `plugin/`).
3. `.opencode/plugins/*.{ts,js}` in every `.opencode` from cwd up to the worktree root, plus `~/.opencode`.

- Top-level files only, not subfolders [src: `{plugin,plugins}/*.{ts,js}`].
- npm plugins are installed with Bun at startup into `~/.cache/opencode/node_modules` [doc].
- OpenCode runs a background install of `@opencode-ai/plugin` in every config folder (`~/.config/opencode` and each `.opencode`) and writes a `.gitignore` there [src: config.ts, run: about 96 MB of npm cache in the test HOME]. Local plugins can use dependencies from `.opencode/package.json`.
- Module shapes [src: plugin/shared.ts, run]:
  - legacy: every exported function is a plugin, `async (ctx, options) => hooks`. Two exports = two plugins [run].
  - new: `export default { id?, server }`. A module may not export both `server` and `tui`.
- `ctx` keys: `client` (SDK client), `project`, `directory`, `worktree`, `experimental_workspace`, `serverUrl`, `$` (Bun shell) [run].
- Custom tools: a `tool` map in the hooks, or files in `.opencode/tools/` or `~/.config/opencode/tools/` with `export default tool({description, args, execute})`. File name = tool name; named exports become `<file>_<export>`. A custom tool with a built-in name replaces the built-in [doc].
- CLI: `opencode plugin <npm-module> [-g] [-f]` installs and edits config [src]. `--pure` or `OPENCODE_PURE=1` runs without external plugins [src].
- No marketplace. The docs ecosystem page lists community plugins.

```js
// .opencode/plugins/guard.js
export const Guard = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash" && /rm -rf \//.test(output.args.command)) throw new Error("Blocked by guard")
  },
})
```

### OpenCode V2 plugins (not run) [doc]

- Config key `plugins` (plural). Entries: npm name, `name@ver`, `./path`, `file://...`, or `{package, options}`. Prefix an ID with `-` to disable it, `*` matches all, `.*` matches an ID prefix.
- `import { Plugin } from "@opencode/plugin"`, `export default Plugin.define({ id, setup(ctx) })`. `setup` registers hooks and transforms (for tools: `ctx.tool.transform(editor => editor.add({name, description, input, execute}))`) and returns a cleanup function.
- `opencode plugin add|list|check|update|remove`, with npm or git specs (`github:o/r`, `git+ssh://...#ref`).
- One package can serve both: default export with V1 `server()` and V2 `setup()`. The V1 object form needs 1.18.29 or later.

### Gemini CLI extensions

Installed under `~/.gemini/extensions/<name>/` (user only) [src: extensions/storage.ts]. Manifest `gemini-extension.json` [doc, src: ExtensionConfig]:

```json
{
  "name": "homelab",
  "version": "1.0.0",
  "description": "Proxmox helpers",
  "contextFileName": "GEMINI.md",
  "mcpServers": {
    "pve": { "command": "node", "args": ["${extensionPath}${/}server.js"], "cwd": "${extensionPath}" }
  },
  "excludeTools": ["run_shell_command(rm -rf)"],
  "settings": [
    { "name": "API token", "description": "PVE API token", "envVar": "PVE_TOKEN", "sensitive": true }
  ],
  "plan": { "directory": ".gemini/plans" },
  "migratedTo": "https://github.com/new-owner/repo"
}
```

- Folder components: `commands/**/*.toml`, `skills/<name>/SKILL.md`, `agents/*.md`, `hooks/hooks.json`, `policies/*.toml`, the context file (`GEMINI.md` by default), `themes` in the manifest [doc, run: templates].
- Variables in the manifest and `hooks.json`: `${extensionPath}`, `${workspacePath}`, `${/}` [doc]. Env expansion `$VAR`, `${VAR}`, `${VAR:-default}` in settings and manifests [doc].
- `settings` values are stored in `<ext>/.env`; `sensitive: true` goes to the system keychain. Extension processes only get safe vars plus declared `envVar`s [doc].
- The manifest `name` is the identity. It does not have to match the folder [run: folder `myext`, name `custom-commands`].
- MCP server defined by both an extension and settings: settings win; `excludeTools` are unioned, `includeTools` intersected, local scalars and env win [doc].

Commands [run: `--help`, src]:

```
gemini extensions install <git-url|path> [--ref R] [--auto-update] [--pre-release] [--consent] [--skip-settings]
gemini extensions uninstall <name...>
gemini extensions update <name> | --all
gemini extensions enable|disable <name> [--scope user|workspace]
gemini extensions link <path>
gemini extensions new <path> custom-commands|exclude-tools|hooks|mcp-server|policies|skills|themes-example
gemini extensions config <name> [setting] [--scope]
gemini extensions list
gemini -e ext1,ext2 ...   # only these;  -e none = no extensions
```

- Install metadata `<ext>/.gemini-extension-install.json`, types `git`, `github-release`, `local`, `link` [src]. `link` wrote `{"source": "/path", "type": "link"}` [run].
- Enablement: `~/.gemini/extensions/extension-enablement.json` [run]:

```json
{ "custom-commands": { "overrides": ["/home/me/*", "!/home/me/proj/*"] } }
```

  Rules are path globs, `!` disables, a trailing `*` includes subfolders, the last match wins, default is enabled [src, run].
- Gallery index: `https://geminicli.com/extensions.json` [src: extensionRegistryClient.ts].
- Restart the CLI after install or update [doc].

---

## 4. Skills

### OpenCode

Discovery [src: skill/index.ts, run]:

- `~/.claude/skills/**/SKILL.md` and `~/.agents/skills/**/SKILL.md`
- `.claude/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` in each folder from cwd up to the worktree root
- `{skill,skills}/**/SKILL.md` in `~/.config/opencode`, each `.opencode`, and `OPENCODE_CONFIG_DIR`
- config `skills.paths` (extra folders, any depth) and `skills.urls` (pulled from a `.well-known/skills/` index)
- one built-in skill, `customize-opencode` [run]
- `OPENCODE_DISABLE_EXTERNAL_SKILLS` drops `.claude` and `.agents`; `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` drops only `.claude`.

Rules:

- Nested folders count: `skills/group/deep/SKILL.md` loaded [run].
- The code only needs `name` (string); `description` is optional. **The documented name rules (regex `^[a-z0-9]+(-[a-z0-9]+)*$`, 64 chars, must match the folder, description 1 to 1024 chars) are not enforced**: `name: Bad:Name` in folder `wrongdir` loaded [src, run].
- Duplicate names log `duplicate skill name` and the last one parsed wins. Parsing is concurrent, so the winner is not fixed [src; run: `debug skill` showed `.opencode` winning, a later run logged `.agents` loading last].
- Loading: names and descriptions go into the `skill` tool description as `<available_skills>`; the model calls `skill({name})` [doc]. Permission key `skill` with name patterns; `deny` hides a skill [doc].
- Every skill is also a slash command `/<name>` unless a command already has that name. The body gets `Base directory for this skill: <dir>` [src: command/index.ts].

### Gemini CLI

- Tiers, low to high: built-in, extension, user, workspace. Inside user: `~/.gemini/skills` then `~/.agents/skills` (wins). Inside workspace: `.gemini/skills` then `.agents/skills` (wins). The higher one wins a name clash and logs `Skill conflict detected` [run].
- Only `<dir>/SKILL.md` and `<dir>/*/SKILL.md`, one level deep [src, run: `group/deep/SKILL.md` not found].
- `.claude/skills` is not read [run].
- Frontmatter `name` and `description` (YAML, with a simple fallback parser). The characters `: \ / < > * ? " |` in a name become `-` [src, run: `Bad:Name` listed as `Bad-Name`].
- Activation: names and descriptions sit in the system prompt; the model calls `activate_skill {name}`; the user confirms; the body and file tree are added and the folder becomes readable [doc].
- Manage: `/skills list|enable|disable|link|reload` and `gemini skills list [--all] | install <git|path> [--scope] [--path] [--consent] | uninstall | link | enable | disable` [run: `--help`].
- Extension skills become `/<ext>:<skill>` commands, always prefixed [src: resolver tests]. Skill commands load only in interactive mode, not with `-p` [src, run].

---

## 5. Slash commands

### OpenCode

- Markdown files in `~/.config/opencode/commands/**/*.md` or `.opencode/commands/**/*.md` (also `command/`). Name = path without `.md`: `commands/git/commit.md` is `/git/commit` [run].
- JSON: `"command": {"<name>": {"template", "description", "agent", "model", "variant", "subtask"}}`. In markdown, the body is the template [src].
- An invalid command file stops config loading [src: throws InvalidError].

```markdown
---
description: Draft a commit message
agent: plan
model: zai-coding-plan/glm-4.6
subtask: true
---
Staged diff:
!`git diff --staged`
Write a commit message. Ticket: $1. Notes: $ARGUMENTS
```

- Arguments [src: session/prompt.ts]: `$ARGUMENTS` is the raw string. `$1..$n` are 1-based; the highest-numbered placeholder takes all remaining args; missing ones become empty. With no placeholder, the args are appended after a blank line.
- `` !`cmd` `` runs in the shell before sending, **with no permission prompt** [src]. `@path` includes a file [doc].
- `agent` naming a subagent, or `subtask: true`, runs the command as a subtask [doc].
- Built-ins `/init` (AGENTS.md setup) and `/review` (subtask), plus TUI commands. Config commands override built-ins. MCP prompts become commands named `<server>:<prompt>` and are added after config commands, so they override a same-named one. Skills are added last and never override [src: command/index.ts].

### Gemini CLI

- TOML in `~/.gemini/commands/**/*.toml`, `.gemini/commands/**/*.toml`, extension `commands/`. Name = path with `:` between folders: `git/commit.toml` is `/git:commit` [doc, run].

```toml
description = "Review the staged diff"
prompt = """
Review this diff for {{args}}:
!{git diff --staged}
Style guide: @{docs/review.md}
"""
```

- `{{args}}` is raw outside `!{}` and shell-escaped inside. With no `{{args}}` and some args, the CLI appends a blank line and the whole typed command [doc, run: `/git:commit d e` sent `COMMIT ...\n\n/git:commit d e`].
- `!{...}` asks for confirmation; on failure the output includes stderr and `[Shell command exited with code N]`. `@{path}` injects a file or folder and runs before `!{}` and `{{args}}` [doc].
- Name clashes [src: SlashCommandResolver.ts and tests, run]: built-ins keep their name. **Two non-built-ins with the same name are both renamed**: user `user.<name>`, workspace `workspace.<name>`, MCP prompt `<server>.<name>`, extension `<ext>:<name>`; numeric suffixes after that. The docs say "the project command wins" and `/<ext>.<name>`; neither matches 0.64 [run: `/sync` not found; `/user.sync`, `/workspace.sync` and `/custom-commands:help` worked].
- MCP prompts become commands [src: McpPromptLoader.ts]. `/commands reload`, `/commands list` [doc].

---

## 6. Subagents

### OpenCode

- Built-ins: primary `build` (default) and `plan`; subagents `general`, `explore`, `scout` [doc]; hidden `compaction`, `title`, `summary` [src: agent/agent.ts].
- Files: `~/.config/opencode/agents/**/*.md` or `.opencode/agents/**/*.md` (also `agent/`; `modes/*.md` become primary agents). Name = path without `.md`: `agents/sec/audit.md` is `sec/audit` [run]. Or JSON under `agent.<name>`.

```markdown
---
description: Reviews diffs for security bugs
mode: subagent            # primary | subagent | all (default all)
model: zai-coding-plan/glm-4.6
temperature: 0.1
steps: 30
color: "#3366ff"          # hex, or primary|secondary|accent|success|warning|error|info
hidden: false
permission:
  "*": deny
  read: allow
  grep: allow
  bash: { "*": ask, "git diff*": allow }
reasoningEffort: high     # unknown keys are passed to the provider as options
---
You review code. Report findings, do not edit.
```

- Known keys are validated. **`tools: [Read, Grep]`, `tools: "Read, Grep"` or `color: blue` make OpenCode refuse to start**: `Configuration is invalid at .../agent/reviewer.md`, exit 1 [run]. `tools` must be `{name: bool}`.
- `~/.claude/agents/` is not read [run].
- Unknown frontmatter keys move into `options` [run].
- Invocation: the `task` tool `{description, prompt, subagent_type, task_id?, command?}`; `task_id` resumes a child session [src]. `@name` in a prompt. `permission.task` limits which subagents an agent may call; denied ones are left out of the tool description [src].
- Model: the agent's `model`, else the calling message's model [src]. `subagent_depth` defaults to 1 (subagents cannot start subagents) [src].
- `opencode agent create`, `opencode agent list`, `opencode debug agent <name>` [src, run].

### Gemini CLI

- Built-ins: `codebase_investigator`, `cli_help`, `generalist`, `browser_agent` (off by default) [doc].
- Files: `~/.gemini/agents/*.md`, `.gemini/agents/*.md`, extension `agents/*.md` [doc, src: storage.ts]. `experimental.enableAgents` defaults to true.

```markdown
---
name: pve-auditor           # must match ^[a-z0-9-_]+$
description: Audits Proxmox and LXC configs
kind: local                 # local | remote
tools: [read_file, grep_search, "mcp_pve_*"]
model: gemini-3-flash-preview
temperature: 0.2
max_turns: 20               # default 30
timeout_mins: 10            # default 10
mcp_servers:
  pve: { command: node, args: [server.js], include_tools: [list_vms] }
---
System prompt here.
```

- The schema is **strict**: unknown keys (`color`, `permission`) fail, and tool names must be Gemini names, `*` or `mcp_*` [src: agentLoader.ts]. Bad files are reported as load errors; the CLI still starts [src].
- The inline MCP key is **`mcp_servers`** with snake_case keys inside (`include_tools`). The docs show `mcpServers`, which the strict schema rejects [src: schema and tests].
- Each subagent is a tool with its own name. `@name` at the start of a prompt nudges the main agent to call it. Subagents cannot call other subagents. No `tools` = inherit all [doc].
- `agents.overrides.<name>`: `enabled`, `modelConfig.model`, `runConfig.maxTurns` [doc]. Policy rules can target `subagent = "<name>"` [doc].
- Remote agents (`kind: remote`, A2A) exist [doc, src].

---

## 7. MCP

### OpenCode

```json
{
  "mcp": {
    "basic-memory": {
      "type": "local",
      "command": ["uvx", "basic-memory", "mcp"],
      "environment": { "BASIC_MEMORY_HOME": "/home/me/notes" },
      "enabled": true
    },
    "madx-mem": {
      "type": "remote",
      "url": "https://madx.tailnet.ts.net/mcp",
      "headers": { "Authorization": "Bearer {env:MEM_TOKEN}" },
      "oauth": false
    }
  }
}
```

- Fields [src: core/src/v1/config/mcp.ts]: local `type, command[], cwd?, environment?, enabled?, timeout?`. Remote `type, url, enabled?, headers?, oauth?, timeout?` with `oauth: {clientId, clientSecret, scope, callbackPort (19876), redirectUri} | false`.
- Note the shape: `command` is one array and env is `environment`, not `command` + `args` + `env`.
- Remote transport: Streamable HTTP first, then SSE [src].
- Timeout: the schema and docs say 5000 ms; the code uses 30000 ms for connect and list when unset [src]. Tool calls reset the timer on progress [src].
- OAuth: starts on a 401, uses dynamic client registration, stores tokens in `~/.local/share/opencode/mcp-auth.json`. CLI: `opencode mcp add|list|auth <name>|logout <name>|debug <name>` [doc, src].
- **Tool name = `sanitize(server) + "_" + sanitize(tool)`**, where anything outside `[A-Za-z0-9_-]` becomes `_` [src, run: server `my.mem`, tool `write_note` = `my_mem_write_note`; `delete.note` = `my_mem_delete_note`].
- Prompts become `/server:prompt` commands. Resources go through the three resource tools [src].
- Scope = the config file that defines the server (org remote, global, project, `.opencode`). Same names deep-merge, so a project can set `enabled: false` on a global server [doc, src].
- Per agent: deny `"mymcp_*"` globally and allow it in one agent's `permission` [doc].
- `{env:VAR}` and `{file:path}` work in any config string [doc].

### Gemini CLI

```json
{
  "mcpServers": {
    "basic-memory": {
      "command": "uvx",
      "args": ["basic-memory", "mcp"],
      "env": { "BASIC_MEMORY_HOME": "$HOME/notes" },
      "timeout": 600000,
      "trust": false
    },
    "madx-mem": {
      "url": "https://madx.tailnet.ts.net/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer $MEM_TOKEN" }
    }
  },
  "mcp": { "allowed": ["basic-memory", "madx-mem"], "excluded": [] }
}
```

- Fields [src: MCPServerConfig]: stdio `command, args, env, cwd`; `url` with `type: "sse" | "http"` (auto-detect when no type); `httpUrl` (deprecated); `headers`; `tcp`; `timeout` (default 600000 ms); `trust`; `description`; `includeTools`; `excludeTools` (wins over include); `oauth {enabled, clientId, clientSecret, authorizationUrl, issuer, tokenUrl, scopes, redirectUri, tokenParamName, audiences}`; `authProviderType` (`dynamic_discovery`, `google_credentials`, `service_account_impersonation`); `targetAudience`, `targetServiceAccount`.
- `gemini mcp add [-s user|project] [-t stdio|sse|http] [-e K=V] [-H "K: V"] [--timeout ms] [--trust] [--include-tools] [--exclude-tools] [--description] <name> <cmd|url> [args...]`. Default scope is project [run]. It wrote `{command, args}` and `{url, type, headers}` [run].
- `gemini mcp list|remove|enable|disable` [run]. In a session: `/mcp`, `/mcp auth <name>` [doc].
- **Tool name = `mcp_<server>_<tool>`** [src]. Avoid `_` in server names: the policy parser splits on the first `_` after `mcp_` [doc].
- Stdio servers get a redacted env (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`, `*AUTH*`, `*CREDENTIAL*` removed) unless the var is set in `env`. Redaction is forced on for MCP [src: mcp-client.ts].
- OAuth tokens: `~/.gemini/mcp-oauth-tokens.json` [doc].
- In an untrusted folder no server connects, user ones included [run].
- `uvx basic-memory mcp` over stdio connected and registered its tools [run].

---

## 8. Settings precedence

### OpenCode (low to high) [src: config/config.ts, paths.ts; doc]

1. Org remote config from `.well-known/opencode` of a logged-in provider
2. Global `~/.config/opencode/config.json`, `opencode.json`, `opencode.jsonc`
3. `OPENCODE_CONFIG` (a file)
4. Project `opencode.json(c)` files from the worktree root down to cwd (the closer file wins)
5. `opencode.json(c)` inside each `.opencode` folder and `OPENCODE_CONFIG_DIR`, with their agents, commands and plugins
6. `OPENCODE_CONFIG_CONTENT` (inline JSON)
7. Console org config, then `OPENCODE_PERMISSION`
8. Managed: `/etc/opencode/opencode.json(c)` (Linux), `/Library/Application Support/opencode/` (macOS), macOS MDM domain `ai.opencode.managed`

- Merge is deep by key. `instructions` arrays are concatenated and deduped [src, run: `permission.bash` patterns from global and project were merged].
- `OPENCODE_DISABLE_PROJECT_CONFIG` skips project files. TUI settings live in `tui.json`. Inspect with `opencode debug config` [run].

### Gemini CLI [src: settings.ts `mergeSettings`]

Schema defaults < system defaults (`/etc/gemini-cli/system-defaults.json`) < user `~/.gemini/settings.json` < workspace `.gemini/settings.json` (only when trusted) < system overrides `/etc/gemini-cli/settings.json` (macOS `/Library/Application Support/GeminiCli/`). Env vars and CLI flags come after.

- Merge strategy is per key: objects merge, hook arrays concatenate, some lists union, some replace [src: settingsSchema.ts].
- `GEMINI_CLI_HOME` moves `~/.gemini`. `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` move the system files [src, doc].

---

## 9. Memory and instruction files

### OpenCode

- System prompt [src: session/instruction.ts, run]:
  - global: the first of `~/.config/opencode/AGENTS.md`, `~/.claude/CLAUDE.md`
  - project: the first file name found among `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` (deprecated), walking from cwd up to the worktree root. **Every** file with that name on the way is loaded [src: `findUp` returns all matches].
  - `instructions` entries: project-relative globs, absolute paths, `~/` paths, or `http(s)://` URLs (5 s timeout)
  - each block starts with `Instructions from: <path>`
- Lazy loading: when `read` opens a file, AGENTS.md files in the folders between that file and the project root that are not loaded yet are appended to the tool result in `<system-reminder>` [run].
- No `@import` inside AGENTS.md. Use `instructions` globs [doc].
- `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` turns off the CLAUDE.md fallbacks [src].
- No built-in memory tool. `experimental.session.compacting` can add context to compaction [doc].

### Gemini CLI

- GEMINI.md hierarchy [doc: gemini-md.md, src]: `~/.gemini/GEMINI.md`, then GEMINI.md in the workspace folders and their parents up to the first folder holding a boundary marker (`context.memoryBoundaryMarkers`, default `[".git"]`), then just-in-time files when a tool touches a folder. All are concatenated.
- Private per-project memory: `~/.gemini/tmp/<project>/memory/MEMORY.md`, loaded automatically [src: storage.ts, prompts]. The agent edits memory files with `replace` and `write_file`.
- `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` changes the file names [doc].
- Imports: `@./file.md`, `@../file.md`, `@/abs/file.md`; max depth 5; circular imports stopped; ignored inside code [doc: memport.md].
- `/memory show`, `/memory reload`, `/memory inbox`. Auto Memory (`experimental.autoMemory`, off by default) drafts memory patches and skills from past sessions for review [doc].
- Extension context files load too [doc].

---

## 10. Cursor CLI and Goose

### Cursor CLI [unverified: docs blocked, from memory]

- Rules: `.cursor/rules/*.mdc` with frontmatter `description`, `globs`, `alwaysApply`. Also reads `AGENTS.md` and `CLAUDE.md`.
- MCP: `.cursor/mcp.json` and `~/.cursor/mcp.json`, key `mcpServers`, Claude-like shape.
- CLI permissions: `~/.cursor/cli-config.json` and `.cursor/cli.json`, `permissions.allow` and `deny` with tokens like `Shell(git)`, `Read(src/**)`, `Write(**/*.md)`.
- Hooks: `.cursor/hooks.json` or `~/.cursor/hooks.json`, `{"version": 1, "hooks": {"beforeShellExecution": [{"command": "./hook.sh"}]}}`. Events include `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `stop`.

### Goose [doc: block/goose documentation]

- Instructions: `AGENTS.md`, then `.goosehints` (`CONTEXT_FILE_NAMES` JSON array changes the list). Global `~/.config/goose/.goosehints`. Hints in subfolders load when goose reads files there.
- Extensions are MCP servers in `~/.config/goose/config.yaml` under `extensions:`, `type: builtin | platform | stdio | streamable_http` (no SSE), fields `cmd`, `args`, `envs`, `env_keys`, `uri`, `headers`, `timeout` (seconds, default 300), `available_tools`.
- Skills: `~/.agents/skills/`, `.agents/skills/`, and for compatibility `.goose/skills/`, `.claude/skills/`, `~/.claude/skills/`.
- Plugins (Open Plugins spec): `~/.agents/plugins/<name>/` or `<project>/.agents/plugins/<name>/` with `plugin.json`, `skills/`, `hooks/hooks.json`. Plugin skills are named `<plugin>:<skill>`.
- Hooks: Claude-like `{matcher, hooks:[{type:"command", command, timeout}]}`, `${PLUGIN_ROOT}`, run with `sh -c`, timeout in seconds (default 30), `on_failure: allow|block` for `PreToolUse`. Events: `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `PreToolUseResult`, `PostToolUse`, `PostToolUseFailure`, `BeforeReadFile`, `AfterFileEdit`, `BeforeShellExecution`, `AfterShellExecution`. Block with exit 2 or `{"decision":"block"}`.
- Permission modes (`GOOSE_MODE`): `auto` (default), `approve`, `smart_approve`, `chat`.

---

## 11. What this means for Conclave

| | OpenCode V1 | Gemini CLI |
|---|---|---|
| Instructions | `AGENTS.md` (falls back to `CLAUDE.md`) | `GEMINI.md` (name configurable) |
| Skills read from | `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills` | `~/.gemini/skills`, `~/.agents/skills` |
| Agents | markdown, own schema, `permission` map | markdown, strict schema, Gemini tool names |
| Hooks | JS plugin functions only | shell commands in settings |
| MCP config key | `mcp`, `{type, command[], environment}` | `mcpServers`, `{command, args, env}` |
| MCP tool name | `server_tool` | `mcp_server_tool` |
| Command args | `$ARGUMENTS`, `$1..` | `{{args}}` |
| Trust gate | none | folder trust, on by default |

- **One skill path for most CLIs**: `~/.agents/skills/<name>/SKILL.md` is read by OpenCode [src, run], Gemini [run], and Codex and Goose (per the companion doc and Goose docs). Claude Code needs `~/.claude/skills`. OpenCode also reads `~/.claude/skills`, so writing both gives harmless duplicate warnings in OpenCode.
- **Agents need one writer per CLI.** A Claude-format agent stops OpenCode from starting and is rejected by Gemini.
- **Hooks**: Gemini takes Claude-style shell hooks after renaming events and tools (mapping in section 2) and converting seconds to milliseconds. OpenCode needs a generated plugin that forwards `tool.execute.before` to Conclave's hook runner and throws to block.
- **Memory (Basic Memory)**: Gemini `{"mcpServers": {"basic-memory": {"command": "uvx", "args": ["basic-memory", "mcp"]}}}`; OpenCode `{"mcp": {"basic-memory": {"type": "local", "command": ["uvx", "basic-memory", "mcp"]}}}`. A remote memory server on madx over Tailscale uses `url` + `type: "http"` (Gemini) or `type: "remote"` (OpenCode).
- **Driving them**: OpenCode reads `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR` and `OPENCODE_PERMISSION`, so Conclave can inject config per run without touching files. Gemini reads `GEMINI_CLI_HOME`, `--policy`, `--approval-mode`. Gemini in a folder it has not seen ignores project settings and all MCP servers until trusted (`GEMINI_CLI_TRUST_WORKSPACE=true`).

Gaps in Conclave's current code (read only, for the integrator):

- `packages/core/src/extensions/cli-sync.ts` `syncAgent` writes `name, description, tools: string[], model, color` to `~/.config/opencode/agent/<name>.md`. OpenCode rejects `tools` as an array or string and named colors, and then **will not start** [run]. It needs an OpenCode writer: `mode: subagent`, `permission` built from the tool list (`"*": deny` plus `<tool>: allow` with OpenCode tool IDs), `model` as `provider/model`, hex color or none.
- Same file: skills go to `~/.config/opencode/skill/<name>`. OpenCode already reads `~/.claude/skills`, which Conclave also syncs, so each user skill shows up twice. Skip OpenCode skill sync, or write once to `~/.agents/skills`.
- No Gemini target. Gemini needs skills in `~/.gemini/skills` or `~/.agents/skills`, and agents in `~/.gemini/agents/*.md` with its strict schema and Gemini tool names.
- `mcpServers` sync is skipped for every CLI, so memory has to be added by hand in each one. Safe options: run `gemini mcp add -s user ...` and `opencode mcp add`, or write only a server key Conclave owns.
- `commands.ts` `substituteArgs`: 1-based `$1` like OpenCode, but each `$N` takes one token (OpenCode's last placeholder takes the rest), and nothing is appended when the template has no placeholder (OpenCode and Gemini both append the args). Gemini TOML commands need conversion (`{{args}}`, `!{}`, `@{}`).
- `instructions.ts` reads `CONCLAVE.md`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`. It does not read `~/.config/opencode/AGENTS.md`, `~/.gemini/GEMINI.md` or project `GEMINI.md`.

---

## 12. Behaviors a test can check

"Verified" means I ran it or read it in source. "Unverified" means docs or memory only.

OpenCode 1.19.3:

1. Verified (run): two exported functions in one `.opencode/plugins/x.js` load as two plugins; `tool.execute.before` runs in export order and the second sees the first's changes to `output.args`.
2. Verified (run): throwing `new Error("X")` in `tool.execute.before` stops the call, the model gets tool result `X`, and the next plugin's `before` hook does not run.
3. Verified (run): `tool.execute.before` fires for a call that a `deny` rule then blocks.
4. Verified (run): the `permission.ask` plugin hook is not called when a permission is asked; the `event` hook gets `permission.asked`.
5. Verified (run): `opencode run` auto-rejects an `ask` rule and the model gets "The user rejected permission to use this specific tool call."
6. Verified (run): a `deny` rule returns "The user has specified a rule which prevents you from using this specific tool call" with the rule list.
7. Verified (run): `shell.env` sets env for the bash tool (`echo $PLUGIN_VAR` printed the plugin value).
8. Verified (run): `"webfetch": "deny"` removes `webfetch` from the tools sent to the model.
9. Verified (run): MCP server `my.mem` with tools `write_note` and `delete.note` exposes `my_mem_write_note`; `"my_mem_delete*": "deny"` hides `my_mem_delete_note`.
10. Verified (run): for an MCP tool, `tool.execute.after` gets the raw MCP result and `output.output` is undefined.
11. Verified (run): root `AGENTS.md` is in the system prompt and `sub/AGENTS.md` is not; reading `sub/file.txt` appends `<system-reminder>Instructions from: .../sub/AGENTS.md` to the result.
12. Verified (run): `opencode debug config` shows project `model` over global, global `small_model` kept, and `permission.bash` patterns merged from both files.
13. Verified (run): `.opencode/agents/sec/audit.md` is agent `sec/audit`; `.opencode/commands/git/commit.md` is command `git/commit`.
14. Verified (run): unknown agent key `reasoningEffort: high` appears under `options`.
15. Verified (run): an agent file with `tools: [Read, Grep]`, `tools: "Read, Grep"` or `color: blue` makes every command exit 1 with "Configuration is invalid".
16. Verified (run): `~/.claude/agents/*.md` is not loaded.
17. Verified (run): `plan` has `edit "*": deny`; `.env` reads are `ask` for every agent.
18. Verified (run): `name: Bad:Name` in folder `wrongdir` loads; `skills/group/deep/SKILL.md` loads; built-in skill `customize-opencode` exists.
19. Verified (src, run): duplicate skill names across `.opencode`, `.claude`, `.agents` log `duplicate skill name`; which one wins is not fixed.
20. Verified (src): default MCP connect and list timeout is 30000 ms, not the documented 5000.
21. Verified (src): `` !`cmd` `` in a command template runs with no permission check.
22. Verified (src): `$1..$n` are 1-based and the highest-numbered placeholder takes the remaining args; with no placeholder the args are appended after a blank line.
23. Verified (src): MCP prompts become `server:prompt` commands and override a same-named config command; skills never override a command.
24. Verified (src): subagents get `task` and `todowrite` denied unless their permission names them; `subagent_depth` defaults to 1.
25. Unverified (doc): `opencode --auto` approves asks but still enforces denies.
26. Unverified (doc): npm plugins are cached in `~/.cache/opencode/node_modules`.
27. Unverified (doc): V2 `ctx.permission.hook("evaluate")` is not called for a configured deny.

Gemini CLI 0.64.0:

28. Verified (run): `gemini mcp add basic-memory uvx basic-memory mcp` writes `{"mcpServers": {"basic-memory": {"command": "uvx", "args": ["basic-memory", "mcp"]}}}` to `.gemini/settings.json`; `-s user -t http <url> -H "Authorization: Bearer x"` writes `{url, type: "http", headers}` to `~/.gemini/settings.json`.
29. Verified (run): with default settings, `gemini mcp list` in a new folder says servers are disabled because the folder is untrusted; with `GEMINI_CLI_TRUST_WORKSPACE=true` they are listed as configured.
30. Verified (run): skill precedence: `.agents/skills` beats `.gemini/skills` within a tier, and workspace beats user.
31. Verified (run): `skills/group/deep/SKILL.md` is not found, `.claude/skills` is not read, and `name: Bad:Name` is listed as `Bad-Name`.
32. Verified (run): `gemini hooks migrate --from-claude` maps events and tool names as in section 2 and copies `timeout: 5` unchanged.
33. Verified (run): SessionStart stdin has `source: "startup"`; BeforeAgent has `prompt`; BeforeModel has `llm_request.model`, `messages`, `config`; env has `GEMINI_PROJECT_DIR`, `GEMINI_CWD`, `GEMINI_SESSION_ID`, `GEMINI_PLANS_DIR`, `CLAUDE_PROJECT_DIR`.
34. Verified (run): hook env includes parent vars whose names contain `TOKEN` (no redaction by default).
35. Verified (run): BeforeAgent `{"decision":"deny","reason":"R"}` makes `gemini -p ... -o json` exit 0 with warning `Agent execution blocked: R`.
36. Verified (run): a plain-text hook that exits 2 or 3 blocks the turn; exit 1 lets it continue.
37. Verified (run): a hook past its timeout lets the turn continue.
38. Verified (run): user and workspace `sync.toml` become `/user.sync` and `/workspace.sync`; `/sync` is not a command.
39. Verified (run): an extension command named `help` becomes `/custom-commands:help`.
40. Verified (run): a TOML prompt without `{{args}}` gets a blank line and the full typed command appended.
41. Verified (run): `extensions link` writes `.gemini-extension-install.json` `{"source", "type": "link"}`; `disable --scope workspace` adds `!<cwd>/*` to `extension-enablement.json`; `extensions list` shows `Enabled (User): true` and `Enabled (Workspace): false`.
42. Verified (src): workspace `.gemini/policies/` is not loaded (`disableWorkspacePolicies = true`).
43. Verified (src): policy tiers are default 1, extension 2, workspace 3, user 4, admin 5.
44. Verified (src): the subagent frontmatter schema is strict and its inline MCP key is `mcp_servers`.
45. Verified (src): MCP stdio env redaction is always on; hook env redaction follows `security.environmentVariableRedaction.enabled` (default false).
46. Verified (src): matching hook groups run in parallel unless one has `sequential: true`.
47. Unverified (doc): BeforeTool `hookSpecificOutput.tool_input` merges into the tool args.
48. Unverified (doc): AfterAgent `decision: "deny"` retries with `reason` as the new prompt.
49. Unverified (doc): changing a project hook's command triggers an untrusted-hook warning.
50. Unverified (memory): Cursor reads `.cursor/hooks.json` with `version: 1`.
