<div align="center">

# Conclave

**Your own AI app, on your own computer.**

[![Latest release](https://img.shields.io/github/v/release/default-cybe/conclave)](https://github.com/default-cybe/conclave/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![CI](https://github.com/default-cybe/conclave/actions/workflows/ci.yml/badge.svg)](https://github.com/default-cybe/conclave/actions/workflows/ci.yml)
[![Website](https://img.shields.io/badge/website-conclave.dymnitguys.com-555)](https://conclave.dymnitguys.com)

</div>

Chat with any AI model and let coding agents work on your machines. One app for the web, your desktop and your phone. You host it, so everything stays with you.

Conclave is a hub you run on a home server, a Proxmox box or your own desktop. It keeps your chats, memory, routines and keys. Your PCs and Macs connect out to it, so agents can work on their files and shells without opening ports. There is no Conclave cloud: model calls go straight to the provider you pick.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/img/home-desktop-dark.webp">
    <img src="site/img/home-desktop-light.webp" width="900" alt="Conclave in a desktop browser: Home opens on a chat, with an approval waiting under the composer and recent chats below it.">
  </picture>
</p>

## What you get

- **Chat with any model.** Claude, GPT, Gemini, GLM, DeepSeek, Kimi, Qwen, OpenRouter, Ollama, LM Studio or any OpenAI-compatible API. Ask a second model, or a jury, in the same chat.
- **Coding agents on your machines.** Sessions edit, test and commit on a paired PC or Mac. Claude Code, Codex, Gemini CLI and OpenCode run through Conclave too.
- **Approve from your phone.** Risky steps wait for your OK. Tap Allow or Deny from anywhere.
- **Your subscriptions, not only API keys.** Sign in to Claude, ChatGPT, Google, Grok, Kimi and Muse plans through [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), which the hub runs for you.
- **Bring your people.** Family or friends get their own accounts, chats, memory, keys and plans on your hub. You can set a monthly budget on yours.
- **One memory.** Every model and device shares what it learned about you and your projects, with a Basic Memory adapter.
- **Routines that run themselves.** Morning briefs, server checks, or a daily look for new listings on a site. Missed runs catch up after downtime.
- **Workflows.** A script runs many agents with checks in code: review a change, deep research, fix until green, security audits and more.
- **Every device.** Web app, desktop app (Windows, Mac, Linux), Android app, iPhone home screen app and a terminal app.
- **Self-hosted and in control.** Docker, Proxmox LXC or a plain Linux box. Permission rules, checkpoints you can undo, and an audit log.

See [all features](https://conclave.dymnitguys.com/details.html#features) on the website.

## Install

Run the hub on a computer that stays on. Then install the app on each device and pair it with a code from the hub's Devices page.

**Docker Compose**

```sh
mkdir conclave && cd conclave
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/docker-compose.yml
docker compose up -d
docker compose exec hub conclave remote   # prints your login link
```

**Proxmox LXC** (on the Proxmox VE host, as root; add `--dry-run` to see every command first)

```sh
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/conclave-lxc.sh
sh conclave-lxc.sh
```

**Linux and macOS** (also gives you the terminal app and the device program)

```sh
curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh
conclave serve
```

No server? The desktop app can run the hub itself: choose **Run the hub on this computer** on its first page.

Full setup, remote access (built-in tunnel, your Cloudflare domain, Tailscale or your own URL) and updates are in [docs/INSTALL.md](docs/INSTALL.md). The website has the same steps in its [download section](https://conclave.dymnitguys.com/#download).

## Apps

| Platform | File |
| --- | --- |
| Windows | [Conclave-windows-x64-setup.exe](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-windows-x64-setup.exe) or [Conclave-windows-x64.msi](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-windows-x64.msi) |
| Mac, Apple silicon | [Conclave-mac-apple-silicon.dmg](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-mac-apple-silicon.dmg) |
| Mac, Intel | [Conclave-mac-intel.dmg](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-mac-intel.dmg) |
| Linux | [Conclave-linux-x64.AppImage](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-linux-x64.AppImage), [.deb](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-linux-amd64.deb) or [.rpm](https://github.com/default-cybe/conclave/releases/latest/download/Conclave-linux-x86_64.rpm) |
| Android | [conclave-android.apk](https://github.com/default-cybe/conclave/releases/latest/download/conclave-android.apk) |
| iPhone | Open your hub in Safari, then Share, then Add to Home Screen. |

Every file has a `.sha256` next to it. The desktop apps are not signed yet: on a Mac, right click the app and choose Open the first time; on Windows, choose More info, then Run anyway. Hub archives and the standalone device program are on the [releases page](https://github.com/default-cybe/conclave/releases/latest).

## How it works

```
  Web app  ·  Android  ·  iPhone  ·  Desktop app  ·  Terminal
                     |  HTTPS + WebSocket
          Hub (conclave serve) on your server
   agent loop · tools · memory · routines · usage · model gateway
                     |  daemons connect out over a WebSocket (no open ports)
          Daemons on your PCs and Macs
   files · shells · browser · Claude Code / Codex / OpenCode
```

The agent loop runs on the hub. Tools reach files and shells through the machine you pick for a session: the hub's own disk or a paired computer. The hub is TypeScript on Bun with one SQLite file. The Android app is Kotlin and Jetpack Compose. The desktop app is Tauri.

## Docs

| Doc | What it covers |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Install, remote access, subscriptions, devices, people, updates |
| [docs/DESIGN.md](docs/DESIGN.md) | Every feature, why it is built that way, and where it can fail |
| [docs/EXTENSIONS.md](docs/EXTENSIONS.md) | Skills, slash commands, hooks, plugins and MCP servers |
| [docs/design/ACCOUNTS.md](docs/design/ACCOUNTS.md) | Several people on one hub: accounts, keys, budgets, threat model |
| [docs/MEMORY.md](docs/MEMORY.md) | How memory works, past chats, Basic Memory |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Running and writing workflows |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and open an issue before a large change. Pull requests need the CLA in CONTRIBUTING.md; tick its box in the pull request template.

```sh
bun install
bun run typecheck
bun test
```

## Security

Report security issues privately to the author through GitHub ([default-cybe](https://github.com/default-cybe)), not in a public issue.

## License

Conclave is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). A commercial license is available from the author on request. Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
