# Changelog

All notable changes to Conclave. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each GitHub release's notes come
from the section of its version (`scripts/releases/notes.ts`); a release
without one fails. At tag time, rename `[Unreleased]` to the version and date,
like `## [0.4.16] - 2026-10-24`.

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
