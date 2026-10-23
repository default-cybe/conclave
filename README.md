<div align="center">

# Conclave

**One hub for every AI model, agent and device. Self-hosted.**

Chat with any model, bring a second model into the same chat for a second opinion or a jury vote, drive Claude Code / Codex / OpenCode / Gemini CLI through one interface, keep one memory across all of them, run agents on a schedule, and reach it all from the web, a native app, your desktop, or the terminal.

</div>

---

## Why

If you use several coding agents and chat models, you juggle several harnesses. Each has its own memory, its own subagents, its own remote access, its own usage limits, and no easy way to get a second model's opinion without copy-pasting context into another tool.

Conclave is one self-hosted hub that puts all of it in one place:

- **Every model, one chat.** Talk to Claude, GPT, Gemini, GLM (Z.ai), or a local model. Pull another model into the same conversation for a second opinion, a jury, or a debate, then carry on with the first.
- **Your own harness, plus the vendors'.** A built-in agent loop (rebuilt from Claude Code's public design) gives any model good tools. When you want a vendor's tuned loop, Conclave drives Claude Code, Codex, Gemini CLI and OpenCode over the Agent Client Protocol.
- **One memory.** Facts, preferences and past work persist across every model, session and device, with an adapter for Basic Memory.
- **Agents and routines.** Build named agents (model + skills + tools + permissions + device) and run them on a schedule: a morning brief, a nightly memory tidy, a server watchdog.
- **Every device.** A web PWA, a native Android app, a desktop app, and a terminal UI, all talking to the same hub. Start a session on your server from your phone, approve a risky command with one tap.
- **See your limits.** 5-hour and weekly subscription windows, token spend per model, cache hit rate, and auto-resume when a limit resets.

> Conclave spawns and talks to the official CLIs; it does not reuse their login tokens. Run routines and unattended work on API keys. See [docs/INSTALL.md](docs/INSTALL.md).

## What it looks like

Screenshots are in [`docs/screenshots/`](docs/screenshots): a flat graphite workbench with hairline rules, Mona Sans for text and JetBrains Mono only for code, real provider and model logos instead of colored dots, and violet kept for live work, shown by an animated dot-matrix wave that replaces spinners. Home opens on a chat, like ChatGPT or claude.ai: a greeting, the composer and your recent chats. A switch on the box starts an agent session instead. Under it a short status page shows what needs you, what is running, usage limits with their resets, today's routines and your devices. A first-run setup walks through the hub, remote access, keys, coding agents, memory, import and pairing. The spec is [`docs/design/SPEC.md`](docs/design/SPEC.md) and the three contest directions are in [`docs/design/directions/`](docs/design/directions).

**Chat** is a plain conversation next to **Sessions**, the agent workbench. Pick a model, turn thinking, web search and memory on or off, and get answers with their sources. From any reply you can edit, retry, branch, ask another model, or preview an html or svg answer in a sandbox. When a chat needs files or a shell, Continue as a session moves it to Sessions. While a model works, the Conclave mark moves: its seven dots ride a wave while it thinks, a packet of light crosses them while it writes or runs a tool, and they settle when it is done. New text fades in as it streams. Chats and sessions move the same way, and reduced motion draws a still frame. See [`docs/design/CHAT-AND-MOTION.md`](docs/design/CHAT-AND-MOTION.md).

## Architecture

```
  Web PWA   ·   Android app   ·   Desktop (Tauri)   ·   TUI
                          |  HTTPS + WebSocket, one bearer token
                   Hub  (conclave serve)  on your server
   agent loop · tools · memory · routines · scheduler · usage · model gateway
                          |  daemons connect out over a WebSocket (no open ports)
            Daemons  (conclave daemon)  on your PC, Mac, other boxes
                files · shells · browser · Claude Code / Codex / OpenCode (ACP)
```

- **One brain, many hands.** The agent loop runs on the hub. Tools never touch the filesystem or a shell directly; they go through a `Machine` interface. The hub's own disk is one machine; a paired PC or Mac is another, reached over the daemon's outbound WebSocket. Picking a device for a session just picks which machine the tools run on.
- **TypeScript on Bun** for the hub, daemon, CLI and web. **Kotlin + Jetpack Compose** for the native Android app. One SQLite file (WAL, FTS5) holds sessions, messages, memory, usage and the durable job queue.

See [docs/DESIGN.md](docs/DESIGN.md) for the full reasoning: every feature, why it is built that way, and where it can fail.

## Features

| Area | What you get |
| --- | --- |
| Models | Anthropic, OpenAI (Chat + Responses), Gemini, Z.ai GLM, OpenRouter, DeepSeek, Kimi, Qwen, local (Ollama / LM Studio), and any OpenAI-compatible endpoint. Streaming, prompt caching, cost tracking. |
| Harnesses | Claude Code, Codex, Gemini CLI, OpenCode over ACP. Their permission prompts become Conclave approvals you can answer from your phone. |
| Multi-model | Second opinion, jury (N models answer, a judge synthesizes or votes), debate, handoff (switch model mid-session), loop (keep going until a check passes). |
| Tools | Read, Write, Edit, MultiEdit, Bash (with background shells), Glob, Grep, LS, WebFetch, WebSearch, Task (subagents), TodoWrite, AskUserQuestion, plan mode, Skill, RepoMap, memory tools, a browser, and any MCP server. |
| Memory | SQLite full-text + optional embeddings, a profile that is always in context, auto-extraction of durable facts, and a Basic Memory adapter. |
| Past chats | Import your Claude Code, Codex and Gemini CLI chats from any paired device, and claude.ai or ChatGPT exports. Import only, import and learn, or learn only. A small model reads each chat and keeps an item only when its quote is really in the chat; a cost estimate comes first, and Undo works for 30 days. A chat is never imported twice, a Syncthing copy at another path lands in the same session, and a chat that grew gets its new messages. |
| Folders across devices | Resume a session on another device even when the project lives at another path there. Conclave finds the folder by git history, Syncthing, a path pair it learned, or a search, and says how sure it is. Choose folder pins it. Old paths in the chat map to the new folder, and the first change after a move asks once. |
| Repo sessions | Pick a GitHub repository and a session gets its own git worktree on a new branch, on the hub or a paired computer. Push and Open pull request with a drafted title and body, the pull request's state and checks in the session, and Clean up after the merge. A fine-grained token only the hub uses; sessions never see it. Never a force push, never the default branch. |
| Workflows | A script runs many subagents with checks in code: review a change with refuter votes, deep research with fact-checkers that never see the draft, fix until green, bug hunts, security audits and 7 more. Scripts run in a sandbox, resume from a journal after a crash, keep a budget, and give each risky agent its own git worktree. Ultra lets the main agent start one on its own. |
| Agents | Markdown profiles (Claude Code compatible). Model, tools, skills, MCP servers, permissions, device, and an untrusted mode for email- or web-facing agents. Specialists for coding (builder, tester, debugger, verifier, designer, refactorer, docs-writer) and research (web-searcher, code-researcher, fact-checker, synthesizer) ask for a model tier (fast, smart, deep), carry their own hooks, and return checked JSON when asked. |
| Routines | Cron, `@every`, `@once`, or webhook. Templates for a morning brief, nightly librarian, server watchdog, deadline check and more, plus 21 suggested routines added in one click: a Librarian that reads your repos and organizes Basic Memory, homelab inventory, backup and disk checks, CVE watch, a GitHub inbox. Each has its own allow list, so unattended runs refuse anything else and list it. Durable: missed runs catch up after downtime. |
| Watches | Ask the assistant to look at listings on a site (cars on Facebook Marketplace). It searches once with the hub's browser, shows cards with photos, prices and links, and on "Watch this daily" makes a routine that remembers what it saw and tells you only what changed: new, gone, price drops. Runs only read; sign in once in Settings, Browser. |
| Permissions | allow / deny / ask rules (Claude Code syntax), modes (default, acceptEdits, plan, bypass), a dangerous-command guard, and a full audit log. |
| Extensions | Skills, slash commands, hooks, plugins and MCP servers, all Claude Code compatible, so your existing `~/.claude` setup works. Discover finds them on GitHub with name, stars and description, shows every file, hook and config before Add, and pins the commit; ponytail and caveman lead the recommended list. 26 tested hook recipes (git work saver, secrets firewall, test output trim and more) add in one step. Install once, sync to every device. |
| Usage | Subscription windows (5h / weekly) across providers, spend per model and per key, cache savings, and a gateway so external CLIs' usage shows up too. |
| Limits | Classified errors, retries with backoff, model fallback chains, and auto-resume that continues a session when a rate-limit window reopens, even across a hub restart. |
| Notifications | Inside Conclave, no outside service: toasts and the Inbox in the app, Web Push for browsers and the installed web app (Allow and Deny right on the notification), native notifications from the desktop app in the tray, and the Android app's own connection. Held while you are using Conclave. |
| Checkpoints | A shadow git snapshot before each turn, so any change is one click to undo, even outside a git repo. |
| Remote access | Built in, nothing else to install. Phones on the same Wi-Fi pair right away. One switch gives the hub an https address through a Cloudflare tunnel it runs itself, with no account. Or a fixed name on your own Cloudflare domain, Tailscale, or your own reverse proxy. Wrong tokens and pairing codes are rate limited and audited. |

## Quick start

```bash
# On your server
docker compose up -d           # or: curl -fsSL .../scripts/install.sh | sh && conclave serve

# Reach it from anywhere: an https address from a tunnel the hub runs, no account
conclave remote quick          # or Settings, Remote access in the web app

# On your PC or Mac: install the desktop app, enter a pairing code, and leave
# "Let the hub use this computer" on, so sessions can run there.
# No server? In the desktop app, choose "Run the hub on this computer" instead.
# Without the app: conclave daemon pair https://your-hub-address ABCD-1234
#                  conclave daemon install --start

# From the terminal, anywhere. The desktop app puts `conclave` on your PATH,
# signed in to its hub; without the app, the install script above does.
conclave                       # chat TUI, auto-starts a local hub if none is set
conclave run "summarize today's git log"   # headless one-shot
```

Open the printed login link in a browser for the web app, or scan the pairing QR with the Android app. On the same Wi-Fi that works at once. Away from home, turn on remote access: the quick tunnel needs no account and no other install, the way Claude Code reaches its own servers. Full setup, every remote access option (quick tunnel, your own Cloudflare domain, Tailscale, your own URL) and phone install are in [docs/INSTALL.md](docs/INSTALL.md).

## Repository layout

```
packages/
  core/      engine, providers, tools, agent loop, memory, routines, usage, ACP, extensions
  server/    hub HTTP + WebSocket, device daemon protocol, model gateway
  cli/        conclave binary: TUI and headless commands
  web/        React PWA
  android/    native Kotlin + Compose app
  desktop/    Tauri desktop shell
  mobile/     Capacitor config for iOS
docs/         DESIGN.md, INSTALL.md, research notes, screenshots
scripts/      installer, service files, build
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run dev        # hub with web dev server
```

Requires Bun 1.4+, ripgrep and git. See [docs/DESIGN.md](docs/DESIGN.md).

## Status and name

This repository is `conclave` (the published package name). The GitHub repo may still be under its original name; rename it to `conclave` in the repository settings when you are ready.

Built for one person's homelab, shared in case it is useful to yours.

## License

Conclave is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). A commercial license is available from the author on request. Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
