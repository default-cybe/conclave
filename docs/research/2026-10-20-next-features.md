# Next features: research and build plan (2026-10-20)

Five research passes, one per ask. Each section says what to build, where,
the effort (S, M, L) and how to validate it. The order at the end is the
recommended build order.

## 1. Accounts, priority and limits

**The ask.** Two Claude accounts and one Claude API key, used in the
owner's order:

- Account 1 first. It has a 5 hour limit only.
- Account 2 next. It is a 20x plan whose weekly limit resets on Tuesday.
- The API key last. Its budget resets on the 22nd of each month.
- An account more than 90% into a weekly limit with a far reset is skipped.
- An account whose weekly reset is close and has room left is used first.

**What CLIProxyAPI (v8.0.32, the pinned build) already does.**

- Per-credential `priority`. The highest tier with a ready credential is used.
- `routing.strategy`: round-robin (default), weighted, or fill-first.
- Failover on 403/408/429/5xx inside one request.
- Cooldown until the reset it reads from `anthropic-ratelimit-unified-*` headers.
- Session affinity (`routing.session-affinity`).
- Per-account model lists: `GET /v8/management/credentials/models?name=`.
- Usage reads without the token leaving it: `POST /v8/management/requests/api-call`
  with `$TOKEN$` in a header, aimed at `https://api.anthropic.com/api/oauth/usage`
  (5h, 7d, 7d Opus, 7d Sonnet, Fable windows, each with `utilization` and `resets_at`).
- Last seen limit headers and cooldowns per account in `GET /v8/management/credentials`.

**What it lacks** (Conclave adds these):

- soft thresholds (skip above 90% weekly), use before reset;
- money budgets with an owner chosen reset day;
- an order per model;
- which account served each call.

**Bugs found on the way.**

- Conclave writes no `routing` section, so CLIProxyAPI uses round-robin.
  Two signed in Claude accounts alternate per request and the prompt cache
  is lost on each switch.
- With an Anthropic API key set, `opus` and bare Claude ids resolve to the
  API key ahead of the subscription (`providers/registry.ts`). The owner
  wants the reverse.
- The `limits` table is keyed by provider, so all CLIProxyAPI accounts
  collapse into one row. Usage rows have no account.
- The Anthropic spend cap error (`enforced_spend_limit_reached`) is not
  detected.

**Design: Conclave decides, CLIProxyAPI executes.**

- Config:
  - `models.accounts`: id, label, vendor, kind (subscription or api), how to
    reach it (a CLIProxyAPI credential or a native provider), enabled, budget
    (USD, period, reset day, time zone, warn at, hard stop).
  - `models.routes`: a model match (`claude-*` or an exact id), the account
    order, and the policy (skip above 90%, far reset 24 h, use before reset
    12 h with at least 30% left, hysteresis 3%, sticky per session).
- State: windows per account (`5h`, `7d`, `7d-opus`, `month`, `budget`),
  each with used percent, reset time, window length, source and age.
  `usage` rows gain an `account` column.
- The API key stays in Conclave's native `anthropic` provider, so its cost,
  headers and budget are exact.
- A core `Router` picks the account per turn:
  1. Hard blocked (100%, cooldown, auth error, budget spent): skip until reset.
  2. Soft skip: weekly at or above 90% with the reset more than 24 h away.
  3. Boost: weekly resetting within 12 h with 30% or more left goes first.
  4. Then the owner's order, then soft skipped accounts, then API.
  5. A session keeps its account while its prompt cache is warm. It moves
     only when the account is blocked or the cache has gone cold.
- On a 429 the Router retries the next account in the same call. Only when
  every account is blocked does the existing park and resume run.

**Refresh.**

- Every 60 s: `GET /credentials` (free; last seen headers and cooldowns).
- Every 5 to 10 min per account, jittered: the OAuth usage endpoint through
  `api-call`. Also right after a 429 and on a manual Refresh.
- Models per account on sign in and every 10 min. API keys use the
  provider's model list.
- API budget from Conclave's own cost ledger.

**UI.**

- Settings, Models, Accounts: one row per account with plan, meters
  (5h, 7d, 7d Opus, budget) and reset times, the models it reaches, pause,
  "try now", an order list, and a budget editor for API keys.
- A "Now using Account 2 (resets Tue 10:00, 45% left)" line with the reason.
- Usage page: limits and spend grouped by account. Sessions show "via Account 2".

**Safety.** OAuth tokens never leave CLIProxyAPI. `api-call` goes only to
an exact URL allowlist. The `observability/usage/api-keys` endpoint is never
read (its map keys are raw keys). Tests scan every response, event, log and
audit row for token strings.

**Phases.**

| Phase | What | Effort |
|---|---|---|
| 1 | Visibility: per account limits, models and usage; the missing windows | M |
| 2 | Static order: priorities written to CLIProxyAPI, fill-first, session affinity with a per session id, API last | S |
| 3 | API budget with reset day, account column, spend cap detection | S to M |
| 4 | Router: soft skip, use before reset, cache aware stickiness, in call failover | L |
| 5 | Codex and Antigravity quotas, gateway traffic through the Router | M |

Phase 2 alone gives "Account 1, then Account 2, then API" with hard limit
failover and fixes the cache loss.

**Validate.** Policy table tests with a fixed clock (the owner's example at
several times, missing windows, hysteresis, warm and cold cache, all
blocked, reset day 22 across months and time zones). The fake CLIProxyAPI
in `packages/server/test/cliproxy.test.ts` gains `api-call`,
`credentials/fields` and `credentials/models`. Then a real hub run against
the owner's CLIProxyAPI with the three accounts.

**Check on the real binary first.** Whether prefixed credentials still list
unprefixed ids, whether `auth_index` survives a restart (use the credential
name as the key), and how affinity treats `metadata.user_id: 'conclave'`.

## 2. Recap (like Claude's Reflect)

**Reflect** (claude.ai, beta since 9 July 2026): a monthly recap with
figures, a daily chart, topics and a written summary.

**Build: a Recap tab on the Usage page**, Week, Month and Year.

- Figures computed in code: sessions, turns, active hours, longest streak,
  busiest day and hour, models and accounts used, files and repos touched,
  approvals and how long they waited, tools used, spend by plan and API.
- A daily chart and an hour by weekday grid.
- An optional written summary by a small model. Off by default, cached per period.

| Phase | What | Effort |
|---|---|---|
| 0 | Data capture: a `turns` table, `requested_at` on approvals, device and folder on usage rows; check ACP and log imports are not counted twice | M |
| 1 | Figures and charts | M |
| 2 | Written summary | S |
| 3 | Phone and Android | M |
| 4 | Export | S to M |

Phase 0 shares a migration with the `account` column from section 1.

**agent-orchestration-standard: skip.** It is 3 days old, has one author,
and is a spec for agent handoffs, not a stats format.

## 3. harness2 (google-research)

**What it is.** A Python research framework that improves an agent's
harness (prompt, rules, skills, hooks) at test time, without a verifier: it
runs the task k times, two improver sessions propose harness edits, each
candidate is probed once, and a composer merges. Reported gains of 4.5 to
11.8 points on legal and office benchmarks. Apache-2.0, version 0.1.0.
The paper (arXiv 2610.14224) could not be fetched here; the repo was read.

**Do not port the per task loop.** It costs about 4 runs plus 4 improver
sessions per task, and the bench pass rate is already 36 of 36.

**Take its rules instead**, ranked by effect on the measured bench:

| # | What | Where | Effort |
|---|---|---|---|
| 1 | Regression gate: at stop, when a turn changed tests and source, run the changed tests on the code from before the turn. If they pass there, remind the agent once. Replaces the `git stash` prose (11 of 12 bug runs skipped it) | new `session/regression-gate.ts` beside `verify-gate.ts` | M |
| 2 | Bench metric: "the agent's tests fail on the start code" | `bench/lib/score.ts`, `report.ts` | S to M |
| 3 | Workspace facts in the Environment block: `python3` but no `python`, which check the verify gate runs | `session/project.ts` | S |
| 4 | Cut the prose that code now enforces (stash clause, "Read, not cat") | `agents-defaults/coder.md` | S |
| 5 | Offline improve loop over the bench, human merges | `bench/improve.ts` | L |
| 6 | Graded lessons for learned skills and memories (helped, hurt, no effect) | `tools/skill-manage.ts`, `memory/extract.ts` | M |

Item 3 removes about 6 of the 10 failed tool calls left in run 4.

**Status (2026-10-20):** items 1, 2 and 3 are built, with tests, and not yet measured (the sets below need the API key).
- Item 1: `session/regression-gate.ts`, on for coder, builder and tester. A turn a usage limit parks keeps its checkpoint, so the resumed run compares with the code from before the user turn, after a hub restart too. The `failingTest` and `NOT_RUN` rules moved to `util/test-run.ts`, shared with workflows and the bench.
- Item 2: `own_tests` and `regression_gate` on every result line, two rows in the per arm table (PROTOCOL.md section 9, version 5).
- Item 3: the Environment block says "use python3" when the device has no `python` (Python projects only) and names the check the verify gate runs at stop, or "no type checker found".

**Validate.** The 12 bug runs first, then all 36, one change per set,
against PROTOCOL.md section 13.

## 4. Orca (onorca.dev)

MIT Electron IDE for running agents in parallel. Worth taking:

| What | Effort |
|---|---|
| Line comments on a diff, sent to the agent as one batch | M |
| Race agents in worktrees, keep the winner (reuses `compare-harnesses.js`) | M |
| An optional worktree per session | M |
| Commit, push and open a PR from the session | M |
| "Fix failing checks" from a PR's CI | M |
| Unread sessions in bold | S |
| A status line per agent (model, context, cost) | S |
| Command palette refinements | S |
| A lint for banned styles in the web app | S |
| A multi session view | M |
| A design mode picker | S to M |
| Session from a GitHub issue | M |

Do not copy its permission bypass, glyph icons, uppercase labels, stat
tiles, vendor relay or telemetry.

## 5. Browser engines and detection rules

**CloakBrowser** (closed source Chromium build with fingerprint patches,
MIT wrappers for JS, Python and .NET).

- Build an engine switch in `BrowserManager.launch`
  (`packages/core/src/browser/manager.ts`): `browser.profiles.<name>.engine:
  'chromium' | 'cloak'`.
- The `cloakbrowser` npm wrapper's `launchPersistentContext` returns normal
  Playwright objects, so snapshots, tools and the CDP screencast for
  takeover should keep working (to be tested).
- Keep one fingerprint seed per profile, so one cookie jar keeps one identity.
- The owner installs the binary; Conclave pins its sha256 and turns off the
  wrapper's auto update.
- Keep the renderer sandbox on (the wrapper adds `--no-sandbox` by default).
  An agent opens untrusted pages.
- Free builds are Chromium 146 (Linux, Windows) and 145 (macOS).
- Effort M.

**invisible_playwright** (patched Firefox, Python only, Juggler protocol).

- It cannot plug into the TypeScript browser: no CDP, so no takeover view.
- Add it as a catalog MCP server (`uvx invisible-playwright-mcp`) with the
  launch counter pref off (`invisible_firefox.usage_ping.enabled=false`).
- Effort S.

**Neither helps design screenshots.** Both spoof and randomize fonts, canvas,
DPR and color scheme, so shots stop matching what users see and change
between runs. Design work stays on stock Chromium.

**elastic/detection-rules** (Elastic License 2.0; 2,122 active rules, 376 for Linux).

- A catalog skill that fetches `rules/linux` and `hunting/linux` at a pinned
  commit with the license, plus a SKILL.md that tells the agent to search
  rules by process, path or ATT&CK id and turn their logic into read only
  checks (journal, auth log, systemd units, crontabs, `authorized_keys`,
  `/etc/ld.so.preload`). Effort S. Needs one field added to `FilesInstall`
  for a Conclave written file.
- Then a weekly read only "persistence sweep" routine over the 97
  persistence and 52 privilege escalation rules, with a baseline in memory
  so it reports changes only. Effort M.

## Build order

1. Accounts phases 1 to 3, with Recap phase 0 in the same migration.
2. harness2 items 3 and 4, then 1 and 2 (bench runs on the API key).
3. Accounts phase 4 (Router).
4. Recap phases 1 and 2.
5. Orca small items (unread bold, status line, palette, style lint), then
   diff line comments, worktree per session, commit and PR, race agents.
6. Detection rules skill, then the sweep routine.
7. CloakBrowser engine and the invisible_playwright catalog entry.
8. Recap on phone and Android; Accounts phase 5; Orca multi session view.

Each step ships with its tests, a mock UI sweep, a real hub run, and CI
green before `main` moves.
