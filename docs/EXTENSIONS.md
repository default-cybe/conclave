# Extensions

Six things change what an agent in Conclave can do: **tools**, **skills**, **commands**, **hooks**, **plugins** and **MCP servers**. This page says what each one is, how they fit together, how each maps to Claude Code, Codex, OpenCode and Gemini CLI, and the one way to add each.

Conclave uses Claude Code's file formats, so an existing `~/.claude` setup works as it is. Files from Codex, OpenCode and Gemini CLI load too when you turn their switch on.

Deeper references: [extensions/COMPATIBILITY.md](extensions/COMPATIBILITY.md) (behaviour per CLI, what was tested), [extensions/IA.md](extensions/IA.md) (the Extensions screens and API), [MEMORY.md](MEMORY.md) (memory and memory connections).

## At a glance

| Kind | What it is | When it acts | Add one |
| --- | --- | --- | --- |
| Tool | An action the agent can take: read a file, run a command, search the web. | When the model calls it. | Built in. More come from MCP servers. |
| Skill | A folder of instructions (`SKILL.md` plus files) the agent loads when a task needs it. | The model loads it with the `Skill` tool, or you type `/name`. | `~/.conclave/skills/<name>/SKILL.md` |
| Command | A saved prompt you run with `/name`. Arguments fill placeholders. | When you type it. | `~/.conclave/commands/<name>.md` |
| Hook | Your script that runs at a fixed point in a session. It can block, allow, rewrite or add context. | On the event it is registered for. | `hooks` in `~/.conclave/config.json` |
| Plugin | A bundle of skills, commands, agents, hooks and MCP servers. | Its parts act as above. | Extensions > Plugins, or `POST /api/plugins` |
| MCP server | A program that gives agents more tools, such as your notes, GitHub or a homelab API. | Its tools are called like any tool. | `conclave config set mcpServers.<name> '<json>'` |

You can also add every kind from the app: Extensions > Discover finds them on GitHub and shows what each one runs before you add it (see [Discover](#discover)).

Agents are the seventh piece and have their own area. An agent is a markdown profile that picks a model, a prompt, which tools it gets, which skills it preloads and which MCP servers it may use, and can carry its own hooks (see [Agent hooks and recipes](#agent-hooks-and-recipes)). See [agents/README.md](agents/README.md) for the agents that ship with Conclave.

## How they fit together

One tool call goes through this path:

```
model asks for a tool
  -> PreToolUse hooks        can block, allow, ask, or rewrite the input
  -> permission rules        allow / ask / deny rules, the mode, the dangerous-command guard
  -> PermissionRequest hooks can answer the prompt for you
  -> you approve             from the app, a notification or the TUI
  -> the tool runs           on the session's device
  -> PostToolUse hooks       can add feedback, replace the result or stop the turn
```

- **Agents choose tools.** An agent with a `tools:` list gets only those tools (MCP tools included only if listed, for example `mcp__memory__*`). Without a list it gets every tool except opt-in ones like the browser. `mcpServers:` limits which servers it sees.
- **Skills are cheap until used.** Only each skill's name and description sit in the prompt. The body loads when the model calls `Skill` or you type `/name`.
- **Commands are prompts.** `/review src/` expands the template and sends it as your message.
- **Plugins add parts.** A plugin's parts are named `plugin:name` (for example `hookify:help`). A bare name works when only one plugin has it.
- **MCP tools are named** `mcp__<server>__<tool>`, the same names Claude Code and Codex use, so permission rules carry over.

## Where Conclave looks

When two places define the same name, the later one in this list wins. Hook lists and permission lists from all places add up instead.

| Order | Source | Folders | Switch |
| --- | --- | --- | --- |
| 1 | Built-in | (shipped agents) | always on |
| 2 | Shared `~/.agents` | `~/.agents/skills`, `<project>/.agents/skills` | on with any of the three below |
| 3 | Codex | `~/.codex/skills`, `prompts`, `agents` | `compat.codex` |
| 4 | OpenCode | `~/.config/opencode`, `<project>/.opencode` | `compat.opencode` |
| 5 | Gemini CLI | `~/.gemini`, `<project>/.gemini` | `compat.gemini` |
| 6 | Claude Code | `~/.claude`, `<project>/.claude` | `compat.claudeCode` (on by default) |
| 7 | Plugins | `~/.conclave/plugins` | per plugin |
| 8 | User | `~/.conclave/agents`, `skills`, `commands` | always on |
| 9 | Project | `<project>/.conclave` | always on |

Turn a switch on with `conclave config set compat.opencode true`. The Sources tab in Extensions shows the counts per source and every name that is defined twice.

## Discover

Extensions > Discover lists MCP servers, skills, plugins, subagents, commands, hook recipes and routines, with name, owner, stars, a short description and an Add button. "Find ... in Discover" under each tab's explainer opens it filtered to that kind.

**Recommended first.** Conclave ships a picked list: 47 curated items (28 recommended), the 27 hook recipes and the 23 routine suggestions. ponytail (writes less code: reuse, stdlib, no extras) and caveman (terse replies that cut output tokens) come first. The rest cover token savers, memory (Basic Memory), security and CTF, the homelab (Proxmox), uni work and self-improvement, including `kayba-ai/recursive-improve`. `Pimzino/agentic-tools-mcp` is listed but not recommended; to bring its tasks and memories over, use `POST /api/tasks/import` instead.

**Listed for security work:** `skill:elastic-detection-rules-linux` copies Elastic's 376 Linux detection rules and 43 Linux hunts (`rules/linux/`, `hunting/linux/queries/`, `LICENSE.txt`, `NOTICE.txt`) at a pinned commit into one skill folder, with a SKILL.md Conclave writes itself: the agent greps the rules by process, path or ATT&CK id and turns their logic into read-only checks (journal, auth log, auditd, systemd units, crontabs, `authorized_keys`, `/etc/ld.so.preload`, PAM, udev). It never runs their EQL. The rules are under the Elastic License 2.0, which is not open source; the preview says so. The Persistence sweep routine uses it. `mcp:invisible-playwright` runs `uvx invisible-playwright-mcp`, a patched Firefox over Juggler for sites that block stock Chromium; it has no CDP, so it stays a separate MCP server, and its launch counter cannot be turned off from the server.

**Where results come from**, most trusted first. A curated entry always wins over a live result for the same repo.

| Source | What it gives | API cost |
| --- | --- | --- |
| Shipped list | The picked items, recipes and routine suggestions, with install steps checked at a pinned commit | none, works offline |
| Plugin marketplaces | Every plugin in the marketplaces you added plus the known ones, read from `raw.githubusercontent.com` | none |
| Official MCP registry | Install configs for MCP servers. An entry counts as verified only when its namespace matches the repo owner | none |
| GitHub search | Repos by topic and keywords, sorted by stars | GitHub API |
| Star index and awesome-claude-code | Stars for thousands of plugin repos, and a reviewed list | none |

**Add shows everything first.** The preview fetches only the files the install needs, at the pinned commit (or the latest commit for a live result). It lists every file with its size, every hook command, the final MCP config with secrets shown as `${secret:key}`, scripts, needs and warnings. Nothing from the repo runs during the install. An MCP server is saved only after a test connect works, unless you tick "Save disabled". Plugins can go in with their hooks off, which keeps their skills, commands and agents. Update shows what changed and asks again when hooks, MCP servers or scripts changed; Roll back puts the earlier copy back from `~/.conclave/catalog-prev/`. Remove deletes only what the install wrote.

**Install on the hub.** When an item needs a program the hub does not have ("Needs serena on the hub"), its card and the setup step in the preview get an "Install on the hub" button, if the hub can install it itself. The confirm lists the exact commands and says they run as the hub's own user (`conclave` in the LXC container) in its home folder, one after another, never with sudo, with the hub's secrets left out of the environment and a 10 minute limit. Then it shows the result (or the failure with the last 200 lines of output), checks again, and the card turns ready so Add works. It can install uv and uvx (astral's install script for a pinned uv release, into `~/.local/bin`), Python programs with `uv tool install`, and the hub setup steps of items that ship with Conclave (Serena, Semgrep, Zotero, and radare2 MCP once radare2 itself is there), uv first when a step needs it. It never runs the commands of a GitHub or registry result, since those are text from the internet: they stay as commands to copy. Programs that need root (docker, Chrome, Node.js, curl, radare2 and other system packages) and anything needed on a device get no button: the card says why in one line and shows the Debian command (`sudo apt-get install -y ...`) to copy. When a program lands in `~/.local/bin` but that folder is not on the hub's PATH (the Docker image), the result says so; the LXC unit has it on PATH.

**Safety rules for anything not curated:** a `${env:X}` or `${secret:X}` in a registry entry or README becomes a field you fill in, so an outside server never reads your keys; plugins see only their own `plugin.<name>.*` secrets; only https and ssh git URLs are fetched; and `curl | sh`, host-reaching docker flags and shell commands show as risks.

**Limits and caching.** Without a token GitHub allows 60 calls an hour. Every answer is cached in the hub's database and asked again with its ETag, background work never spends the last 10 calls, and on a limit the hub waits for the reset and serves saved results with a note. Add a token as secret `catalog.github-token` (or reuse `github-pat`) to get 5,000 an hour. A daily job refreshes the sources, checks installed items for updates and tells you when an installed repo is archived.

Hub settings: `CONCLAVE_GITHUB_API` points the catalog at another API base, such as GitHub Enterprise (`https://ghe.example/api/v3`); `CONCLAVE_CATALOG_OFFLINE=1` turns off every network source, so Discover shows the shipped list and the cache only.

API: `GET /api/catalog`, `GET /api/catalog/search`, `GET /api/catalog/items/:id`, `POST /api/catalog/preview`, `POST /api/catalog/install`, `POST /api/catalog/items/:id/setup` (Install on the hub, the owner's only), `GET /api/catalog/installed`, `POST /api/catalog/updates/check`, `POST /api/catalog/installed/:id/update-preview`, `POST /api/catalog/installed/:id/update`, `POST /api/catalog/installed/:id/rollback`, `DELETE /api/catalog/installed/:id`, `GET /api/catalog/status`, `POST /api/catalog/refresh`. The full shapes are in [design/ECOSYSTEM.md](design/ECOSYSTEM.md).

Routine rows open the Routines tab's Add sheet. The Routines page has its own Suggested section: the Librarian deep pass (reads your repos and organizes Basic Memory), session harvester, homelab inventory, backup and disk checks, CVE watch, a weekly persistence sweep over the Elastic Linux rules, GitHub inbox and more, each with the rules it may run without asking.

## Tools

Built in, with Claude Code's names: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash` (with background shells), `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task` (subagents, also matched as `Agent`), `TodoWrite`, `AskUserQuestion`, plan mode, `Skill`, `NotebookEdit`, `RepoMap`, `ReadToolOutput`, the memory tools (`MemorySearch`, `MemorySave`, `MemoryForget`), `SessionSearch` and `SessionRead` (past chats, [MEMORY.md](MEMORY.md#past-chats)), `SkillManage` (skills agents write, below), `Consult`, `Notify`, `ScheduleRoutine`, `Delegate` and `ConclaveHelp`. Browser tools are opt-in per agent.

`Delegate` lets a chat, the assistant or a Code session hand a job to a new Code or Assistant session on one of the owner's devices and answer with what comes back, the way Task returns a subagent's report. It takes `to` (`code` or `assistant`), `agent` (explore when read-only, coder otherwise), `device` (a name, matched without case, spaces or dashes; the hub when left out), `folder`, `prompt`, `readOnly` (true unless the owner asked for changes) and `background` (the answer arrives later as a note). The new session's `parentId` is the caller. It runs in the caller's permission mode; read-only takes its file-editing tools away. The description lists the online devices with their known project folders and names the offline ones. Subagents, workflow steps, untrusted sessions and members' sessions never get it (DESIGN.md section 43).

`ConclaveHelp` searches the Conclave docs that ship with the hub (this page, INSTALL, MEMORY, ASSISTANT, WORKFLOWS, DESIGN and the specs in `docs/design`), so an agent asked "how do I add a second Claude account" reads the answer instead of guessing. It takes `query` (a few words; the best sections come back with the paragraphs that match and an id each), `section` (an id, to read that section whole) and `limit` (default 3). It is read-only and reads nothing of the owner's. The docs are embedded in the compiled binary; a hub run from source reads `docs/`.

**Platform awareness.** Every primary session's system prompt carries a short card about Conclave: what it is, the modes and how work moves between them, where things are in the app, what an agent cannot do here, and a live block with this session's tools by group, its MCP servers, the devices online, the browser and the models and accounts set up. Subagents get two lines. `platformCard: false` in an agent's frontmatter (Platform awareness in the agent editor) leaves it out for that agent; `agents.platformCard: false` in config.json leaves it out for all (DESIGN.md section 51).

**Permissions** use Claude Code's rule syntax in `permissions.allow`, `ask` and `deny`:

```json
{ "permissions": { "allow": ["Bash(git status)", "Bash(npm test:*)", "mcp__memory"], "deny": ["Bash(rm -rf *)"] } }
```

Deny beats ask beats allow, then the mode decides (default, acceptEdits, plan, bypass). Commands that look destructive (`rm -rf /`, `mkfs`, `dd of=/dev/sda`, a force push to main) always ask. In a session that moved to another device or folder, a file tool maps an old path to the new folder before the rules see it, so `Read(./.env)` in `deny` holds for the old path too. The `Workflow` tool is one more built in tool; an allow rule `Workflow` starts runs without the approval card, and a run's own agents and `lib.exec` calls still go through these rules (`docs/WORKFLOWS.md`, Permissions). In the app, Extensions > Tools shows which agents can use each tool and which rule decides, and "Test a call" runs the same check the session would.

| Conclave / Claude Code | Codex | OpenCode | Gemini CLI |
| --- | --- | --- | --- |
| `Bash` | `exec_command` / `shell` | `bash` | `run_shell_command` |
| `Read`, `Write`, `Edit` | `apply_patch` (hooks see `Write`/`Edit`) | `read`, `write`, `edit` | `read_file`, `write_file`, `replace` |
| `Glob`, `Grep` | via the shell | `glob`, `grep` | `glob`, `grep_search` |
| `WebFetch`, `WebSearch` | `web_search` | `webfetch`, `websearch` | `web_fetch`, `google_web_search` |
| `Task` (`Agent`) | `spawn_agent` | `task` | each agent is a tool |
| `TodoWrite` | `update_plan` | `todowrite` | `write_todos` |

### Browser profiles and engines

Each named browser profile is a persistent profile under `~/.conclave/browser-profile/<name>` that keeps its cookies and logins; `browser_profile` moves a session to another one. Settings, Browser lists each profile's sites and saved logins and deletes a profile (below). A profile runs on Playwright's Chromium (or a system Chrome), or on CloakBrowser when `browser.profiles.<name>.engine` is `cloak`. Settings, Browser picks the engine per profile and shows each engine as installed (with its version) or missing.

**Install on the hub.** Settings, Browser, Engines has an Install on the hub button for each engine, the owner's only (`POST /api/browser/setup`). It works with no shell and no root, on a hub from a release binary too. Everything goes in the hub's browser folder, `<CONCLAVE_HOME>/browser` (`/var/lib/conclave/browser` in the Proxmox container, `/data/browser` in Docker), which the hub's user owns. The confirm lists every step as it will run: the command, or the URL with the hash it must match. The hub runs exactly those steps and refuses a list that changed since the owner looked; the audit log has the run and its result.

- playwright-core 1.64.1, the version `packages/core/package.json` pins, from the npm registry, checked against the sha512 in `bun.lock`, unpacked into `node_modules/playwright-core` there. The release binary keeps Playwright out (`scripts/build-cli.ts`), so the hub imports it from that folder by its full path. A source install and the Docker image have it with the app and skip this step.
- Chromium: Playwright's own installer (`cli.js install --no-shell chromium`) for Chrome for Testing 156.0.8078.4, from `cdn.playwright.dev`, into `ms-playwright` there. The hub's own binary runs it as bun (`BUN_BE_BUN=1`), so no Node.js is needed.
- CloakBrowser 146.0.7680.177.5 for Linux x64, from CloakHQ's GitHub release `chromium-v146.0.7680.177.5`, the build the `cloakbrowser` npm wrapper (0.6.3) uses for linux-x64. The archive must match the sha256 in that release's `SHA256SUMS` (signed with the Ed25519 key the wrapper pins; the signature checks), and the unpacked `chrome` must match its own pinned sha256. The hub then sets `browser.cloak.executablePath` and pins `browser.cloak.sha256`. CloakBrowser's terms: builds up to v146 are free for personal and commercial use without redistribution; v148 and later need a CloakBrowser Pro key. Other machines (arm64, macOS) install CloakBrowser by hand.

**System libraries.** Install on the hub never runs as root. When the browsers miss a library (`ldd`, asked again every 20 seconds while something is missing) or the machine has no fonts, the page names them and offers what fits where the hub runs (`system/host.ts` finds it: an LXC container with its Proxmox CT id when the CT's disk name gives it, Docker, a VM, a machine of its own):

- **The root helper is installed** (`conclave system-helper install`, `docs/INSTALL.md` 16): an **Install system libraries** button. Its confirm shows the one line, `sudo /usr/local/libexec/conclave-root-helper browser-deps`; the owner only (`POST /api/browser/libs`, `admin`), confirmed (a different line is refused with 409 and the fresh one), audited before and after (`browser.libs`, `browser.libs.result`). The helper runs `apt-get update` and installs every package the page could name for the release, the list built into it; the hub then runs `ldd` again and says **Ready**, or which libraries are still missing.
- **It is not:** two short choices, both as root inside the hub's container: (a) `conclave system-helper install` once, so the hub does this and later installs itself, or (b) the `apt-get install -y --no-install-recommends ...` line for the missing packages alone, with the Debian 13 and Ubuntu 24.04 names where they differ. Then where to run them: for an LXC container, "inside the hub's container, not on the Proxmox host", `pct exec <CTID> -- conclave system-helper install` from the host shell (the CT id filled in when known), or the CT's Console in the Proxmox web UI; a VM or a machine says to run it there with `sudo`. An installed helper that cannot run (no sudo, `NoNewPrivileges` on the service, sudo refusing the user) says why.
- **Docker:** build the image with `--build-arg BROWSER=1`. The image has no helper.

The agent can do the same from its Bash tool when the helper is installed: `sudo /usr/local/libexec/conclave-root-helper browser-deps`. A browser that cannot start for a missing library says so in its error, with that command. The helper takes no other argument, so the agent cannot run anything else as root through it; docs/DESIGN.md (The root helper) has the security model.

**New profiles get CloakBrowser** once it is installed: a profile with no engine set that no browser has run in yet. The choice is written to `browser.profiles.<name>.engine` before its folder is made, so a first launch that fails (the sandbox as root, a missing library) does not turn it into Chromium later. A profile Chromium has run in stays on Chromium until the owner moves it; the page warns that the sites then see another browser.

```json
{ "browser": {
    "profiles": { "stealth": { "engine": "cloak" } },
    "cloak": { "executablePath": "/var/lib/conclave/browser/cloakbrowser/chromium-146.0.7680.177.5/chrome", "sha256": "715722e8605ae3ce81523c1218aba1ec89425786ab33ceaf99f8a6cb5e70e6e8" } } }
```

CloakBrowser is a closed source Chromium build with fingerprint patches. Conclave never updates it (it sets `CLOAKBROWSER_AUTO_UPDATE=false`), and with `sha256` set it refuses to start a file that does not match. It starts the binary through Playwright with the flags of CloakBrowser's own wrapper (a `--fingerprint` seed, `--fingerprint-platform`, no `--enable-automation`, no SwiftShader), with one change: the renderer sandbox stays on, because an agent opens untrusted pages. Chromium cannot sandbox as root, so the hub must run as a normal user with user namespaces allowed (the Proxmox container has nesting on); Conclave says so instead of turning the sandbox off. Each profile keeps one seed in `.cloakbrowser-seed` in its folder, the file the wrapper uses, so one cookie jar keeps one identity.

Snapshots, every browser tool and the takeover screencast work the same on both engines. `browser_profile` names the engine in its answer and each takeover frame carries it, so the takeover header can say "CloakBrowser". Not for design screenshots: fonts, canvas and screen size are spoofed. For a patched Firefox instead, Discover lists `mcp:invisible-playwright` as its own MCP server.

`PATCH /api/config` refuses an unknown engine or a malformed `sha256`. `CONCLAVE_CLOAK_BINARY=<path> bun test packages/core/test/browser/browser-cloak.test.ts` runs a real CloakBrowser profile end to end.

### Browser sites and saved logins

Settings, Browser, **Sites and logins** lists each profile's sites: one row per site with the account, whether the profile is **signed in** (its cookies, from Sign in to a site or a login the hub did) and whether a **login is saved**, when it was last used, and **Edit login**, **Forget** and **Delete login** (or **Save login** for a site with cookies only). Every profile but the default has **Delete profile**.

**Saved logins.** Add a login takes the profile, the site (an origin such as `https://www.facebook.com`), the username, the password, an optional 2FA key (the base32 key or the `otpauth://` link an authenticator app takes), and **Include subdomains**. The assistant then logs in by itself with `browser_login` when a task of the owner's needs it, instead of the owner signing in through the takeover view each time. Sign in to a site stays for sites with a puzzle or a check.

**Saved logins are kept on the hub, encrypted.** The list (`<CONCLAVE_HOME>/browser-logins.json`, mode 600) has no secret in it. The password and 2FA key are hub secrets, `browser.login.<id>.password` and `browser.login.<id>.totp` in `secrets.json`, each encrypted with AES-256-GCM under a key of their own in `<CONCLAVE_HOME>/browser-logins.key` (mode 600), with the secret's name as associated data. Other hub secrets are plain values in `secrets.json` (mode 600); these are encrypted because a password to a personal account is worth more. Tools never read the list, the key or `secrets.json`. None of them is in a backup, keys or not, so a restored hub asks for the passwords again. An answer, the config, a tool result, an audit line and a log line say only that a password is saved. Edit login replaces the password only when a new one is typed.

**`browser_login`** (`site`, `account`) fills and submits the saved login on the session's tab. The hub does it, not the model: it finds the login form in the tab's own document, sets the username and password with the page's own input setter, presses the form's button, waits for the page, and fills a sign-in code from the 2FA key when the site asks for one. Without a 2FA key it asks the owner for the code (a question card; any answer that is not a code means the owner finishes in Sign in to a site). A username-first site (the password on the next page) works. The model gets "Filled the saved login for facebook.com (username and password) and submitted it." and the page after, never the password. The rules:

- **Origin binding.** It fills only when the tab's top-level origin is the saved one exactly, or, with Include subdomains, the same scheme and port on the saved host without `www` or one of its subdomains (`m.facebook.com` for `www.facebook.com`). An IP address never counts for subdomains. Anything else is refused, so a page that tells the agent to log in gets nothing.
- **No frames.** Only the tab's own document is searched, never a frame, so a login form from another site inside the page gets nothing.
- **Only a login form.** The password goes only into an `<input type=password>`, and only on a page with one password field (a sign-up or change form has two and is refused). A form whose button or action sends to another site is refused too.
- **Nothing left behind.** After the submit, a password field that still holds the password is cleared, and every browser tool result in that session replaces the password (as is, quoted or in an address) with `[saved password]`.
- **Who.** The owner's sessions only. A member's session, an untrusted one (a watch run, a mail agent, a webhook run, their subagents), a read-only session and a session on the proxy are refused, and watch runs never get the tool. The login must belong to the session's profile; `browser_profile` lists each profile's saved logins.
- **Audit.** Every use is audited: `browser.login` (site, profile, what was filled, never a value) and `browser.login.refused` with the reason.

The tool's description tells the model to use saved logins only for the owner's own tasks on that site, when the page asks to log in. In the default permission mode it asks for approval, like the other browser tools that act; an allow rule such as `browser_login(domain:facebook.com)` skips that for one site.

**Forget** clears a site's cookies (its own and those of its parent domain that it gets) and what it stored (local storage, IndexedDB, caches, service workers) in that profile, starting the profile's browser for it when it is closed, then drops the site from the list. A saved login stays; that is Delete login.

**Delete profile** removes the profile's folder with every cookie in it, its `browser.profiles.<name>` entry and its saved logins. The confirm lists the watches and routines that use it (a watch on the profile, or a routine prompt that names it as a profile). The default profile cannot be deleted. A profile a session has open is refused (409) until the owner confirms closing it; sessions on it go back to the default profile.

API, all the owner's: `POST /api/browser/logins`, `PUT /api/browser/logins/:id`, `DELETE /api/browser/logins/:id` (each answers the full `GET /api/browser`, whose profiles now carry `logins`, `isDefault` and `usedBy`), `POST /api/browser/profiles/:name/forget` `{host}`, `DELETE /api/browser/profiles/:name?close=1`.

### Browser proxy

The rule: **pages load from the hub's own address; when a site blocks that address, the request is retried once through the proxy, in the hub's own country.** There is no switch that keeps a profile on the proxy.

**Automatic retry when blocked** (`core/src/tools/blocked.ts`). `looksBlocked` decides that a site refused the hub: Reddit's "blocked by network security" or a 403/429 from Reddit, a redirect to Reddit's login page (old.reddit's `reason=lor2`), DuckDuckGo's 202 anomaly page, a Cloudflare challenge ("Attention Required", "Just a moment...", error 1020, `cf-mitigated: challenge`), or a 403/429 page that says captcha, access denied or blocked. A plain 404, an API's 401 or an ordinary 403 is not a block. WebFetch, WebSearch (DuckDuckGo and Reddit's own search) and `browser_navigate` then retry that same request once through the proxy, and the result says so in one line: "Reddit blocked the hub's address; fetched through the proxy (US)." With no proxy set, the blocked message ends with "Set a proxy in Settings > Browser to retry these through it." The country is the one of the hub's own public IP, asked once per process from Cloudflare's trace page (no key) and kept; when that fails, the proxy's configured country. With DataImpulse it goes in the user name (`login__cr.us`); a custom proxy is used as configured. WebFetch and WebSearch go through Bun's fetch `proxy` option, which speaks HTTP proxies only, so a SOCKS5 custom proxy serves the browser alone. `browser_navigate` turns the proxy on for that session (`useProxy`, the same throwaway browser as below) and loads the page again; later calls in that chat stay on it until `proxy: false`. The proxy is the owner's: a member's call never retries through it, since members have no browser settings or browser tools (ACCOUNTS.md).

The owner can also ask in a chat ("open it through the proxy", "open it from Japan"), and the agent passes the `proxy` input of `browser_navigate` (or `browser_tabs` new): `true` for the provider's default country, a country by name or two-letter code, or `false` to stop. A watch or routine passes it only when its own instructions say so; the automatic retry above needs no input. The session then browses in a throwaway browser through the proxy: the session's profile's engine, a fresh folder under `<CONCLAVE_HOME>/cache/browser-proxy`, deleted when it closes, so no saved login ever goes through the proxy. Later calls in that chat stay on it until `false` or another country (another country is another browser). The result says where it went out: "Through the proxy (DataImpulse, Japan), exit IP 126.209.14.83 in Japan (JP) at the check." The check is one request through the proxy to Cloudflare's trace page; a rotating proxy may use other addresses for the page itself. The sign-in view and a call that names another profile never use it. WebRTC is told not to send UDP around the proxy.

Settings, Browser, Proxy picks the provider (`PUT /api/browser/proxy`, `POST /api/browser/proxy/test` for the exit IP and country of a chosen country):

- **DataImpulse:** an HTTP proxy at `gw.dataimpulse.com:823` (both editable). The user name is the login plus `__cr.<cc>` for a country (`login__cr.jp`; parameters after two underscores, separated by semicolons), the password is the account password. Chromium answers an HTTP proxy's login itself through Playwright, so no relay is needed. Their SOCKS5 port is not clear from their public pages, so the hub uses HTTP.
- **Custom:** one `socks5://user@host:port` or `http://user@host:port`. It has no country choice. A SOCKS5 proxy with a login goes through a relay on 127.0.0.1: Chromium speaks SOCKS5 to it with no login, and it logs in to the upstream (RFC 1929) for each connection, so the password never reaches Chromium's command line. The relay listens on loopback only and speaks CONNECT only.

```json
{ "browser": { "proxy": {
    "provider": "dataimpulse",
    "dataimpulse": { "login": "${secret:browser.dataimpulse.login}", "password": "${secret:browser.dataimpulse.password}", "country": "JP" } } } }
```

The login and passwords are hub secrets (`browser.dataimpulse.login`, `browser.dataimpulse.password`, `browser.proxy.password`); the config holds only `${secret:name}`, and `PATCH /api/config` refuses plain values. Settings says whether each is saved, never what it is, and no tool result, audit line or log line has them: proxies show as "DataImpulse, Japan" or `scheme://user@host:port`.

## Skills

A skill is a folder with a `SKILL.md`:

```markdown
---
name: proxmox-backup
description: How I back up LXC containers to PBS. Use when adding a container to backups.
---
1. Check the container's storage with `pct config <id>`.
...
```

**Add one:** create `~/.conclave/skills/<name>/SKILL.md` (or `<project>/.conclave/skills/` for one repo). The folder name is the skill name, as in Claude Code. Type `/<name>` to run a skill as a command.

Claude Code reads `~/.claude/skills`; Codex, OpenCode and Gemini CLI all read `~/.agents/skills`. Sync to other CLIs (below) copies your user skills to both, so every tool sees them.

### Skills agents write

Agents turn a method that worked into a skill with the `SkillManage` tool,
so the next session starts from it. Memory keeps facts about you; a skill
keeps steps, commands, checks and pitfalls. The base prompt asks for one
after a task of about 5 or more tool calls, a tricky fix or a workflow that
was not obvious, a patch when a loaded skill turned out wrong or missed a
step, and nothing for one-off task progress.

| Action | Does |
| --- | --- |
| `create` | A new skill: name, one line of description, the Markdown body. Scope `project` ties it to the session's folder; the default is global. |
| `patch` | Replace a section by its heading (or add it), add one line under Pitfalls, or change the description. |
| `list`, `view` | The skills agents wrote, with when each was last loaded; one skill's text. |
| `disable` | Turn one off with a reason (merged, replaced, unused). Agents never delete skills. |

They live in `~/.conclave/learned-skills/<name>/SKILL.md` with frontmatter
`name`, `description`, `source: learned`, `session` (where it was written),
`created`, `updated`, and `project` or `disabled` when they apply. The
loader reads that folder after plugins and before `~/.conclave/skills`, so a
skill you write with the same name wins. They are not synced to other CLIs;
copy one into `~/.conclave/skills` to make it yours.

What a learned skill can hold: Markdown in one SKILL.md. No scripts or other
files, no hooks, no `allowed-tools` (the loader ignores it even if the file
is edited), no `` !`command` `` lines or `@file` includes (a skill typed as
`/name` would run or read them), and nothing the secrets filter flags.
Untrusted agents (email, web) do not get the tool.

Writes ask for approval like MemorySave. Set `skills.learn` to `auto` (or
pick Save without asking under Extensions > Skills, Learned) to let them save
on their own; ask and deny rules still win. Extensions > Skills marks each
one Learned with the session it came from, and the detail lets you edit it,
turn it off or on, or delete it. The Skill review routine template (Sundays
19:10, added off) merges duplicates and turns off skills unused for 60 days
or contradicted by later sessions, and says what it changed.

API: `GET /api/skills/learned`, `GET /api/skills/learned/:name` (with the
body), `PATCH /api/skills/learned/:name` (`description`, `body`, `enabled`),
`DELETE /api/skills/learned/:name`.

## Commands

A command is a markdown template:

```markdown
---
description: Review the staged diff
argument-hint: [focus]
---
Review this diff with a focus on $ARGUMENTS:

!`git diff --staged`
```

**Add one:** `~/.conclave/commands/<name>.md`, then type `/<name> args`. Arguments work as in Claude Code: `$ARGUMENTS` is everything, `$0` is the first word, `$1` the second. `` !`cmd` `` runs a command on the session's device and inlines the output; `@path` inlines a file.

Other formats load behind their switches, each with its own argument rules: Codex prompts (`/prompts:name`, `$1` is the first word), OpenCode commands (`git/commit`), Gemini TOML commands (`git:commit`, `{{args}}`, `!{cmd}`, `@{path}`).

## Hooks

A hook is a command (or a prompt for a small model) that runs on an event. It gets JSON on stdin with Claude Code's field names (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, ...). Exit code 2 blocks and shows stderr to the model. Exit 0 with JSON can allow, deny, ask, rewrite the input or add context. Scripts written for Claude Code work as they are.

**Add one:** put it under `hooks` in `~/.conclave/config.json` (`conclave config edit`), or in Extensions > Hooks:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/hooks/guard.sh", "timeout": 10, "if": "Bash(git push *)" }] }
    ]
  }
}
```

Events, in the order they happen:

| Event | When | Matcher compares | Can | Codex | Gemini CLI |
| --- | --- | --- | --- | --- | --- |
| `SessionStart` | a session starts, resumes after a hub restart, after `/clear`, after compaction | `startup`, `resume`, `clear`, `compact` | add context | same | same |
| `UserPromptSubmit` | before your message reaches the model | (all) | block, add context | same | `BeforeAgent` |
| `PreToolUse` | before a tool runs | tool name | block, allow, ask, rewrite input | same | `BeforeTool` |
| `PermissionRequest` | Conclave is about to ask you | tool name | allow or deny for you | same | none |
| `PostToolUse` | after a tool succeeds | tool name | feedback, replace the result, stop | same | `AfterTool` |
| `PostToolUseFailure` | after a tool fails | tool name | feedback | none | none |
| `Notification` | Conclave notifies you (`permission_prompt`, `idle_prompt`, `errors`, ...) | notification type | side effects | none | same |
| `SubagentStart` | a subagent starts | agent name | add context | same | none |
| `SubagentStop` | a subagent finishes | agent name | send it back to work | same | none |
| `PreCompact` | before old messages are summarized | `manual`, `auto` | block, add instructions | same | `PreCompress` |
| `Stop` | the agent is about to end its turn | (all) | make it continue | same | `AfterAgent` |
| `SessionEnd` | `/clear`, a deleted session, the hub stopping | `clear`, `other` | side effects (1.5 s limit) | same | same |

OpenCode has no shell hooks; its JS plugins (`tool.execute.before`) are the closest thing and do not load in Conclave. Hooks from Gemini CLI and Codex settings can be converted: Extensions > Hooks > Import, or `POST /api/hooks/import`.

**Test before you trust:** the Hooks tab has a test runner that sends a sample input through the real runner and tells you what the model would see. Each handler also shows its last run (exit code, time, stdout, stderr), how many chars it added to the context, and about how many tokens it adds per session.

Hooks run on the hub, in the session's folder. When a session runs on another device, its hook commands still run on the hub.

### Recipes

Extensions > Hooks > Recipes lists 27 tested hooks by goal: safety (git work saver, Proxmox guard, MCP write gate, write scope), security (secrets firewall, injection tripwire), token savers (test output trim, MCP JSON compact, rtk), memory, verification and minimal code. Add shows the exact config and script first, lets you pick this hub, this project, or Claude Code, Codex or Gemini CLI on a device, then runs the recipe's own tests through the hub's runner. "Add 8 recipes" adds the starter set, which needs only bash and jq. Handlers a recipe added say "from recipe" and can be removed together. API: `GET /api/hooks/recipes`, `POST /api/hooks/recipes/:id/install`, `POST /api/hooks/recipes/:id/test`, `DELETE /api/hooks/recipes/:id`.

A project install needs the folder's full path, and its hooks stay off until you trust the folder. Codex runs a new hook only after you trust it there (Codex asks at start, or use `/hooks`), and it compiles matchers with Rust's regex crate, which has no lookahead, so Codex gets the matcher without lookahead groups and the recipe script checks the tool name again. `ri-trace-export` writes traces with the keys recursive-improve writes itself (duration, token usage, last answer), so its loop, error, duration and token detectors work on Claude Code sessions.

### More than Claude Code reads

All optional, all ignored by Claude Code:

- `"type": "mcp_tool"` with `server`, `tool` and `input` calls a connected MCP server instead of a script (Claude Code's shape). `${cwd}`, `${prompt}` and `${tool_input.file_path}` take values from the event. Read-only tools only, unless the handler sets `"allowWrite": true`. A SessionStart handler that asks Basic Memory's `search_notes` for `${cwd}` gives each session the notes about its folder with no jq and no process.
- `"onFailure": "block"`: a crash or timeout blocks like exit 2, so a guard cannot fail open. `"once": true` runs a handler once per session. `"statusMessage"` shows while it runs. `"suppressOutput"` keeps stdout out of the run log.
- Context budgets: SessionStart and SubagentStart handlers together add at most 12,000 chars, a UserPromptSubmit handler 2,000 (or its `additionalContextLimit`). More is cut with a note.
- A Stop hook can keep a turn going at most 3 times; the 4th block is ignored with a notice.
- PreToolUse handlers run one after another, each seeing the input the one before left. A rewrite keeps the original call's verdict: `Bash(git status)` still allows a hook's `rtk git status`, while a rewrite into a denied command is denied.
- A hook's `allow` skips the approval prompt, but a deny rule or plan mode still wins, as in Claude Code since 2.1.77. A plugin hook that allows everything cannot undo your deny rules.
- Plugin hooks get their own `CLAUDE_CONFIG_DIR`. It starts with a `settings.json` whose status line does nothing, because Conclave has none; otherwise caveman and ponytail ask the model to set one up in the first session.
- Lint on save and import: a bare handler with no `hooks` list is wrapped, and the tab flags timeouts that look like milliseconds, a bare `mcp__server` matcher (it matches nothing; use `mcp__server__.*`) and `if` rules that cannot match. `POST /api/hooks/lint` runs it on demand.
- Built in: memory recall, memory extraction, compaction and file recall (off by default) are listed under Hooks > Built in with their last run, cost and an On / Off (`GET /api/hooks/builtin`).

### Agent hooks and recipes

An agent profile can bring hooks that apply only to sessions running that agent, so the tester gets its write scope without turning it on for every session.

- **`hooks:`** in the agent's frontmatter, in the same shape as `hooks` in settings (Claude Code's subagent `hooks:` field). For a subagent, its `Stop` hooks run on `SubagentStop`, when the subagent finishes; the parent's own hooks for that event run too.
- **`recipes:`**, a list of recipe ids from Extensions > Hooks > Recipes, each `"id"` or `"id NAME=value"` for the recipe's tunables. The script is written to `~/.conclave/hooks/recipes/<id>.sh` the first time, the same file an install uses. `verify-gate` and `regression-gate` are not hooks; they turn on the gates below.

```yaml
recipes:
  - no-test-gaming
  - "write-scope WRITE_GLOB=**/*.test.*,**/tests/**"
```

The shipped coding agents use this: coder, builder and refactorer get no-test-gaming, new-dependency-gate, diff-budget and the verify gate; coder and builder also get the regression gate; tester gets no-test-gaming, write-scope on test paths and the regression gate; docs-writer gets write-scope on Markdown and `docs/**`; web-searcher on `research/**` and `notes/**`; designer gets the verify gate. evidence-before-done stays off.

**write-scope** refuses Write, Edit, MultiEdit and NotebookEdit on a path outside `WRITE_GLOB` (comma-separated globs relative to the project folder; default `**`, the whole folder and nothing outside it). A `*` also matches across folders, and a leading `**/` also matches at the top. `./` parts and doubled slashes are dropped; paths with `..` parts are refused. It does not see writes made through Bash. In an agent profile it fails closed: when it cannot be set up (jq or bash missing on the hub, a tunable it does not know, a character a tunable cannot hold), that agent's file writes are refused with the reason, so a tester never writes source because jq is missing. Other recipes in a profile are skipped with one warning in that case. Recipes that run on the hub read the session's folder from their input, so they also run for a session on another device whose folder is not on the hub (they start in the hub's home); before, they failed to start there and let every call through.

**The verify gate** runs the project's check after a turn that edited files, on the session's own device, before the turn may end. A failure sends the agent back with the last 40 lines, at most 3 times per user turn; the third time also posts a notice. The command is the agent's `verifyCommand`, else `verifyCommand` in the folder's `.conclave/settings.json` (trusted folders only), else detected: a `typecheck` script in package.json (run with bun, pnpm, yarn or npm from the lockfile), `cargo check`, `go build ./...`, or `py_compile` on the edited Python files. It runs project code without a prompt, so it runs only in a trusted folder or when your rules already allow that Bash command; otherwise the session gets one notice saying why it did not run. It replaces the stop-verify recipe for coding agents, because hook commands run on the hub and a session on arch-desktop needs its check on arch-desktop.

**The regression gate** checks that a turn's new tests show something. When a turn changed both test files and source files, it rebuilds the folder as it was before the turn from the turn's checkpoint, lays only the changed test files (and changed helpers in test folders) over it in a temp folder on the session's device, and runs them there with the project's runner for at most 30 s: `python3 -m unittest <modules>` or `python3 -m pytest <files>` for Python, `bun test <files>` for Bun. When they fail on the old code, nothing is said; when they pass there, the agent gets one reminder per user turn: "Your changed tests pass without your change. If this fixes a bug or adds behavior, make one fail without it. If it is a refactor, say so." A run that says nothing (a timeout, a test that does not load on the old code, no test ran) is not reported to the agent. Each look writes an audit row `regression.gate` and a `regression.checked` event. A turn a usage limit parks keeps its checkpoint (in session meta too), so when `session.resume` continues it, after a hub restart as well, the tests still run on the code from before the user turn and the reminder still goes out at most once. It runs after the verify gate and waits while that gate sends the agent back; both share the cap of 3 continuations per turn. It follows the verify gate's trust rule, works on main sessions only (a subagent's edits are checked at its parent's stop), and leaves out Go and Rust, whose tests share a package or a file with the code they test.

Hooks and recipes from a project folder's agent (`<project>/.conclave/agents`, `<project>/.claude/agents`) run only once the folder is trusted, like the folder's settings hooks. A plugin agent's hooks follow the plugin's hooks switch.

### Agent tiers

`model:` in an agent profile can be a tier word instead of a model: `fast`, `smart` or `deep`. Claude Code names map to them: `haiku` is fast, `sonnet` is smart, `opus` and `opusplan` are deep. Each session resolves the word:

| Tier | Resolves to |
| --- | --- |
| fast | `models.tiers.fast`, else `smallModel` |
| smart | `models.tiers.smart`, else the session's model (the parent's, for a subagent) |
| deep | `models.tiers.deep`, else the cheapest deep-tier model of a configured provider (the session model's provider first; `anthropic/claude-opus-5-5` with an Anthropic key), else `claude-code/opus` when that harness is installed, else the session's model |

Set the tiers once with `conclave config set models.tiers '{"deep": "anthropic/claude-opus-5-5", "fast": "zai/glm-4.5-air"}'`. Task's `model` takes the same words. `effort:` (low, medium, high, xhigh, max) sets the thinking effort; xhigh and max pass through to providers that take them.

`refusalFallback:` gives sessions with this agent their own Refusal fallback list (what the owner calls "safety priority", docs/DESIGN.md 47): each entry is a model, or `model@account` with an account id from Settings > Models > Accounts. A list replaces the owner's and turns it on for this agent; `refusalFallback: off` turns it off. Without the field the owner's setting applies.

```yaml
refusalFallback:
  - cliproxy/neu/claude-opus-5-5
  - anthropic/claude-opus-5-5@api-anthropic
  - zai/glm-5.3
```

### Project folders need trust once

Hooks and allow rules in a project's `.claude/settings.json`, `.claude/settings.local.json`, `.conclave/settings.json` or `.conclave/settings.local.json` come from whoever wrote the repo. A cloned CTF challenge could ship a `SessionStart` hook that runs `curl ... | sh`. So these stay off until you trust the folder:

- The first session in such a folder shows a notice listing what is off.
- Trust it in Extensions > Hooks, or with `POST /api/trust {"cwd": "/path", "trusted": true}`. Trust covers the folder and everything under it.
- Deny and ask rules from the folder always apply, since they only make things stricter.

Your own `~/.claude/settings.json` hooks and permissions load without a trust step when `compat.claudeCode` is on.

## Plugins

A plugin is a folder with `.claude-plugin/plugin.json` (Codex's `.codex-plugin/plugin.json` and a root `plugin.json` work too) and any of `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json`. It is the same format Claude Code and Codex install.

**Add one:** Extensions > Discover or Plugins > Marketplace, or `POST /api/plugins {"source": "..."}` where the source is `name@marketplace` (for example `hookify@claude-plugins-official`), `owner/repo` (optionally `owner/repo@<sha or tag>#<subfolder>`), a git URL or a local path. The default marketplace is `anthropics/claude-plugins-official`; add more with `POST /api/marketplace`. A marketplace entry pinned to a commit is fetched at exactly that commit, or the install fails; it never falls back to the default branch. The commit, version and a hash of the plugin's hooks, MCP config and scripts are recorded, so updates can show what changed.

- Parts are named `plugin:name`. Hooks get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CONCLAVE=1` (Codex-format plugins also `PLUGIN_ROOT` and `PLUGIN_DATA`), and their own `CLAUDE_CONFIG_DIR` under the plugin's data folder, so mode flags they write never touch your real `~/.claude`. When `node` is not on the hub's PATH, plugin hooks get a `node` that runs Bun. MCP servers become `plugin_<plugin>_<server>`, so their tools are `mcp__plugin_<plugin>_<server>__<tool>`, as in Claude Code.
- Installing shows what the plugin adds. Plugins with hooks or MCP servers run code on the hub; read them first.
- Hooks can be turned off per plugin in its detail (`PATCH /api/plugins/<name> {"hooks": false}`). Its skills, commands and agents still load. This suits ponytail and caveman when you want their skills without a node process on every prompt.
- Update re-fetches from the recorded source and keeps the enabled flag. Disable keeps the files; remove deletes them and the plugin's data folder.

OpenCode JS plugins and Gemini CLI extensions do not load.

## MCP servers

**Add one:** `conclave config set mcpServers.<name> '<json>'`, or Extensions > MCP servers > Add, or `POST /api/mcp`. Two common shapes:

```sh
# a local program (stdio), e.g. Basic Memory
conclave config set mcpServers.memory '{"command":"uvx","args":["basic-memory","mcp"]}'
# a server on the homelab over Tailscale (streamable HTTP)
conclave config set mcpServers.homelab '{"type":"http","url":"https://madx.your-tailnet.ts.net/mcp","headers":{"Authorization":"Bearer ${secret:homelab-token}"}}'
```

`${env:NAME}` reads an environment variable on the hub; `${secret:name}` reads a value from the hub's secrets file, set with `PUT /api/secrets {"kind": "values", "key": "name", "value": "..."}` or in the app's settings. Already set one up in another CLI? Paste its config into Extensions > MCP servers > Paste from another CLI (`POST /api/mcp/import`); it reads Claude `.mcp.json`, Codex `config.toml`, OpenCode `opencode.json` and Gemini `settings.json`.

Placeholders work in `env`, `headers`, `args` and `url`, and connect errors hide secret values. A stdio server does not get the hub's whole environment: it gets `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER`, `SHELL`, the proxy and CA bundle variables and the XDG folders, plus its own `env`. Provider keys and tokens never reach it. Set `"inheritEnv": true` for a server that really needs everything, and `"cwd"` for one that works on a project folder.

Servers connect on first use and reconnect with backoff. Per server you can restart it, test it (reconnect, time, tool count), list its tools with their schemas and try one.

Servers in a project's `.mcp.json` are counted in the trust check but Conclave does not start them yet; add them to your config instead.

| Conclave / Claude Code | Codex | OpenCode | Gemini CLI |
| --- | --- | --- | --- |
| `mcpServers.<name>` in JSON | `[mcp_servers.<name>]` in `config.toml` | `mcp.<name>` with `type: local` or `remote` | `mcpServers.<name>` |
| tools `mcp__<server>__<tool>` | same | `<server>_<tool>` | `mcp_<server>_<tool>` |

## Sharing with your other CLIs

Three ways, depending on what you want everywhere.

**1. Your agents and skills.** Extensions > Sources > Sync (`POST /api/sync-clis`) writes your user agents and skills into each CLI's own format on a device: Claude Code markdown, Codex TOML roles, OpenCode's agent schema, Gemini's agent format, and one shared skill copy in `~/.agents/skills`. Preview lists the files first (`dryRun`). Sync only overwrites files it wrote before.

**2. One MCP server in every CLI.** Each server has a "Connect to my CLIs" view (`GET /api/mcp/<name>/connect`) with the command for each CLI, for example:

```sh
claude mcp add-json -s user memory '{"type":"stdio","command":"uvx","args":["basic-memory","mcp"]}'
codex mcp add memory -- uvx basic-memory mcp
gemini mcp add -s user memory uvx basic-memory mcp
```

plus the JSON to paste for OpenCode. On a connected device the app can run them for you after you confirm (`POST /api/mcp/<name>/connect`). A memory connection that is an MCP server (Basic Memory, a knowledge graph server) has the same plan at `GET /api/memory/connections/<id>/connect`.

**3. Conclave's own memory in every CLI.** The hub is an MCP server too, at `https://<hub>/mcp`, with `memory_search`, `memory_save`, `memory_forget`, `memory_recent`, `sessions_search`, `tasks_list` and `routines_list`. A fact saved from Codex is there in Claude Code and in Conclave. Get ready-made config with `conclave mcp snippets` or `GET /api/mcp-server/snippets`. Use a gateway key as the token (Settings > Gateway keys, one per tool so you can revoke it). On a machine with the Conclave CLI logged in, `conclave mcp` serves the same tools over stdio:

```sh
claude mcp add --scope user conclave -- conclave mcp
codex mcp add conclave -- conclave mcp
```

Details and the per-CLI snippets are in [MEMORY.md](MEMORY.md#sharing-memory-with-other-tools).

## How this was checked

- **Hooks:** one hook script ran under real Claude Code 2.1.301 and inside the real Conclave engine with a scripted model making the same tool calls. All 14 cases match (exit 2, deny, ask, allow, input rewrite, `if` filters, PostToolUse feedback, UserPromptSubmit and SessionStart context, Stop continuation and `stop_hook_active`). `packages/core/test/extensions/compat/hook-parity.test.ts` fails if that stops being true.
- **Every event fires:** `packages/core/test/engine/hook-events.test.ts` drives the engine through startup, `/clear`, compaction, delete, approvals, subagents and notifications and checks each hook's input.
- **Real plugins:** `obra/superpowers`, nine plugins from `anthropics/claude-plugins-official` and the 177 skills of `K-Dense-AI/scientific-agent-skills` install and load with the right names; the superpowers SessionStart hook runs through Conclave's runner.
- **Other CLIs:** synced OpenCode agents pass `opencode debug agent` 1.19.3; MCP config converts to and from all four formats; the `gemini mcp add` and `codex mcp add` commands were checked against the real CLIs.
- **MCP:** a real stdio MCP server's tools reach the model in a session (`hook-events.test.ts`). The hub's `/mcp` endpoint and `conclave mcp` pass tests with the official MCP SDK client, and were tried from real Claude Code 2.1.301 against the compiled binary: it saved a memory over HTTP and found it again through `conclave mcp` over stdio, and the generated `claude mcp add-json` snippet worked as given, token read from `CONCLAVE_TOKEN`. Codex 0.163.0 accepted both generated `codex mcp add` commands and wrote the expected `config.toml`.

## Known gaps

- For a session on another device, hook commands still run on the hub (the verify gate is the exception: it runs on the device), and project files (`.claude/`, `.conclave/`, project agents and skills) are read from the hub's disk at that path. A session that moves between devices finds its folder there (DESIGN.md section 17), but these files are still read on the hub at the new path. No `CLAUDE_ENV_FILE`, no `transcript_path`, no http or agent hook handlers.
- Project `.mcp.json` servers do not start.
- Plugin `userConfig` prompts, `bin/` on PATH, plugin `settings.json`, LSP servers and output styles are not supported.
- Permission modes `dontAsk` and `auto` do not exist; there is no managed policy layer.
- Path-scoped `.claude/rules` (`paths:`) and lazy loading of subfolder instruction files are not supported.
