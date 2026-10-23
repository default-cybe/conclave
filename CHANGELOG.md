# Changelog

All notable changes to Conclave. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each GitHub release's notes come
from the section of its version (`scripts/releases/notes.ts`); a release
without one fails. At tag time, rename `[Unreleased]` to the version and date,
like `## [0.4.16] - 2026-10-24`.

## [0.4.20] - 2026-10-23

### What's new
- Settings > Web search: pick the engine WebSearch uses from 12 free engines (Tavily, Exa, LangSearch, Linkup, Firecrawl, You.com, Serper, SerpApi, Jina, Brave, your own SearXNG, or DuckDuckGo with no key). Each shows its free allowance, whether it needs a card, and the steps to get a key with links. A key you paste is stored as a hub secret and never shown again; Test runs one real search. With Choose automatically, the hub uses the first engine with a key, in the order shown.

## [0.4.18] - 2026-10-23

### What's new
- Cyber access: on GPT models from a ChatGPT plan, choose Default, Standard or Daybreak Blue (Daybreak Red on gpt-5.6-cyber) next to effort. Conclave sends it as OpenAI's `access_programs`, tells you when a different program served the reply, and explains OpenAI's access errors.
- Each ChatGPT plan's own model list, read as Codex reads it: its names, which models are hidden, and each model's efforts up to `ultra` with its default.
- A finished subagent or workflow shows one "Message from subagent" row with its state, which opens to the report.

### Changed
- The model picker shows each model once, by name only, grouped by maker and family, newest first. Other routes to the same model sit behind "via". Effort and thinking variants fold under their model; image and review models are out of the chat picker; dates are gone from names.
- The retiring Daybreak aliases (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, retired by OpenAI on October 28) map to their models with the matching Cyber access.

### Fixed
- No more empty message bubbles after a subagent or workflow finishes, or for messages with only hook feedback.

## [0.4.17] - 2026-10-23

### What's new
- `/btw <question>`: ask a side question while a turn runs. It gets its own quick answer from the session's model, as a card you can dismiss, and never enters the turn or the transcript.
- A message you send while a turn works is delivered into that turn right after the current tool call, as Claude Code does. A turn that only writes text keeps it for its own next turn.
- Held messages show "Stopped" with a Send button and an x, on the web and on Android.

### Changed
- Stop, Edit and Retry keep what you queued (held, visible) instead of dropping it.
- Agents never block a turn on a long wait; they start it in the background or hand it to a background agent, so your messages are read.
- The README is a front page for the public repo.

### Fixed
- Queued messages were lost when a turn was stopped or the hub restarted. They are now saved on the hub and survive a restart.
- An agent's tier model (deep, fast) skips a model that answered "model not found" for 6 hours.
- Members' own plans: the tool guard refuses more forms of member and hub secret paths; a granted member gets a clear refusal when the hub's CLIProxyAPI is off; a member's empty Accounts page points to Subscriptions; a member's CLIProxyAPI view never carries the hub's token.

## [0.4.16] - 2026-10-23

### What's new
- Members' own plans: each member signs in their own Claude and ChatGPT plans, on a CLIProxyAPI of their own, with their own Subscriptions and Accounts.
- Two members cannot see or use each other's plans.
- A chat that clones a repo or works in one, started from a home folder, moves into that repo's project.
- WebFetch reads Reddit threads and listings through Reddit's JSON, and says plainly when Reddit or the search engine blocks the hub.

### Changed
- Conclave is now open source under the AGPL-3.0 license.
- The web folds a running turn's steps into one closed row, as Android does, with what runs now as its line.
- Subagents and delegated sessions run in the permission mode of the chat that started them, never plan mode unless that chat is. A read-only job loses the file edit tools instead.
- Chats are named from their first exchange and renamed once after the third turn. A title you set is never changed.
- Commits made by agents keep you as the only author and end with a `Committed-by: Conclave (model)` line.
- Releases and updates now come from the main repo, default-cybe/conclave. Installs made before 0.4.16 keep updating, and move over with this update.
- The website moved to https://conclave.dymnitguys.com.
- CI runs only on main and on pull requests.
- Hardened the GitHub workflows: pinned actions, tighter permissions, no signing key near install scripts.

### Fixed
- An agent whose model the hub cannot serve falls back to the chat's model instead of failing.
- Members' own plans, from the review: no CLIProxyAPI left running after a hub crash, no crash loop at start, a failed start can be retried, a sign-in in progress survives signing out another plan, a call never moves to the hub's plan mid-call, and two installs no longer collide.

## [0.4.15] - 2026-10-23

### What's new
- Accounts: "Use when a model refuses" on a plan or key.
- Accounts: sign in with a sign-in name or an email.
- Android: pair a device from the Devices screen.
- Desktop: sign in to a hub with a name and password.

### Changed
- Model picker: makers first, their models one level in.
- Accounts: a plan's short name is learned from its models, and ChatGPT plans list their own models.

### Fixed
- A flaky zip test now waits for the model request, not only the reply row.

## Older versions

See GitHub releases.
