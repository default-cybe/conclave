# Harness benchmark protocol

Version 5. Written 2026-10-17. Versions 2 and 3 (same day, before any real set) change four task prompts, add checks, and fix fairness and isolation gaps; version 4 hardens the runner and scoring; version 5 (2026-10-20, after run 4) adds the own-test metric and the regression gate count. See section 16.

This file fixes the rules before any run. Change it only between benchmark sets, never during one, and bump the version when you do.

## 1. Question

Does the Conclave harness (the coder agent) get as much out of a Claude model as Claude Code does, when both use the same model?

"As much" means four things, in this order:

1. Correct work: hidden tests pass.
2. Honest work: the agent does not claim success when the tests fail.
3. Clean work: small, readable diffs that do not touch the tests.
4. Cheap work: fewer tokens, less money, less time.

The model is held fixed. The harness is the only thing we want to vary: system prompt, tools, loop, context handling and defaults.

## 2. Arms

| Arm | What runs | Model path | Default |
|---|---|---|---|
| A | Conclave `run` with `--agent coder` | Conclave provider `bench-claude`, type `anthropic`, baseUrl = the tap (4.5), which forwards to CLIProxyAPI (native Messages API) | on |
| B | Claude Code `claude -p` | `ANTHROPIC_BASE_URL` = the tap, which forwards to CLIProxyAPI (default), or its own login (see 3.2) | on |
| A2 | Conclave `run` with `--agent coder` | The existing `cliproxy` provider, type `openai`, `http://127.0.0.1:8317/v1` | off |
| C | Conclave driving Claude Code over ACP | Conclave provider `claude-code` (type `acp`) | off |
| D | Codex `codex exec` | Codex login, its own model | off |

Notes:

- A uses the anthropic provider type so that A and B speak the same wire protocol to the same proxy. A2 exists to check whether the OpenAI translation in the proxy costs anything. It is not part of the A vs B verdict.
- C tells us whether Conclave adds or loses anything when it only wraps Claude Code. Its model is an alias (`opus`, `sonnet`), so it cannot be pinned to an exact id. Record the served id if the ACP stream reports it.
- C starts the ACP adapter with `npx`. `doctor` fetches it once ahead of time, so runs do not wait on a download.
- D uses a different model. It is a reference point only and never enters the verdict.
- Select arms with `--arms A,B` (the default). Example: `--arms A,B,A2,C`.

## 3. Model pinning

### 3.1 One model id

- The operator passes one id, for example `--model claude-opus-5-5`.
- `doctor` lists `GET http://127.0.0.1:8317/v1/models` and refuses an id the proxy does not list.
- A gets `--model bench-claude/<id>`.
- B gets `--model <id>`.
- Both arms must get the same served model id for every request on the main model. The runner reads it from what the API answered (`message.model` in `message_start`), as recorded by the tap (4.5), the same way for both arms. Conclave's own usage records only echo the requested id, so they cannot show a swap. Without the tap (B on `login`), B falls back to `message.model` in stream-json and the keys of `modelUsage`. A dated id (`<id>-20261001`) counts as the same model.
- A run whose main loop served a different id is marked `invalid: model_mismatch` and left out of the analysis.
- Side calls on a small model (titles, summaries) are allowed in both arms. They are counted and reported apart from the main model.

### 3.2 Transport for arm B

`--b-transport proxy|login|auto`, default `proxy`. With `proxy`, A and B reach the model the same way (same proxy, same account, same added system text) and both go through the tap, so their tokens are counted by one parser. `login` and `auto` are kept for a check of the login path; the summary then says that token counts come from two sources.

- `login`: Claude Code uses its own subscription login. Use `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or a login stored in the bench Claude config dir (see 4.2).
- `proxy`: the runner sets `ANTHROPIC_BASE_URL` to the proxy (`CLIPROXY_BASE_URL`, default `http://127.0.0.1:8317`), `ANTHROPIC_API_KEY=$CLIPROXY_API_KEY`, and points the small and fast model variables at a proxy model id.
- `auto`: `doctor` sends one tiny prompt through `login` with `--model <id>`. If the served id matches, B uses `login`. If it does not match, or the id is refused, B uses `proxy`.
- The chosen transport is written to every result line as `transport`. The summary states it in the setup block.

Known confound: to use a subscription token, CLIProxyAPI may add Claude Code identity text to the system prompt of arm A requests. Record the proxy version. If the proxy logs show it, say so in the summary.

### 3.3 Thinking and effort

- Both arms run with their shipped defaults. This is part of what a harness is.
- Conclave today: the coder agent sets no thinking level. Claude 5 models then think in adaptive mode with no effort field.
- Claude Code: record the version's default thinking and effort, and any flag or setting the runner passes.
- The manifest records both. The tap records what each request actually sent (`thinking`, `output_config.effort`, `max_tokens`) in every result line under `sent`. If the arms differ, the summary says so near the top, with the values. On the build machine (Claude Code 2.1.302, Sonnet 5.5) Conclave sent `max_tokens` 32000, adaptive thinking and no effort; Claude Code sent `max_tokens` 128000, adaptive thinking and `effort: medium`. That is a real difference in defaults, so plan a `--match-effort` set next to the default set.
- Optional variant `--match-effort <low|medium|high>`: sets the same level in both arms (A: a bench agent override with `thinking: <level>`; B: the version's effort flag or setting, if it has one). Results of this variant go in a separate set. Never mix them with a default set.

## 4. Isolation and parity

### 4.1 What both arms share

- The same prompt text, byte for byte (section 6).
- The same model id (section 3).
- A fresh copy of the task folder per run.
- The same time limit per task.
- The same permission level: everything allowed inside the copy, no prompts.
- The same denied tools: web search, web fetch, browser, and anything that reaches another model, a person or a schedule. Denied the same way: the tool is not in the list sent to the model. B: `--disallowedTools`. A: `disallowedTools` in bench copies of the coder agent and every subagent (4.2); the config deny list stays as a backstop. A deny list alone would leave the tools in A's list (Conclave checks it only at call time), which costs A tokens and turns B never pays. Every run records the tools offered (`sent.tools`) and any denied tool still offered (`flags.forbidden_tools_offered`).
- The same environment variables, except the few each arm needs for its own config and auth. No bench or runner path in any agent's env or argv (checked per run).
- The same user, PATH, toolchains, ulimits and machine.
- Sequential runs. One agent at a time.

### 4.2 Clean homes

Neither tool may see the owner's memory, instructions, skills, plugins, hooks or MCP servers. Neither may see anything left by an earlier run: its own earlier runs, or the other arm's.

- Every run gets a fresh `HOME` at `<work>/<run_id>/home/`, used by the agent and by every tool it starts. The runner passes the real toolchain paths through `RUSTUP_HOME`, `GOPATH`, `GOMODCACHE`, `GOCACHE` and `PATH`. `CARGO_HOME` is `<home>/.cargo`, fresh per run (and its own for the scorer), because cargo reads a `config.toml` there that can change how tests run; the tasks need no crates. The runner also writes a minimal `.gitconfig` (name `bench`, email `bench@localhost`) into that home. The home is deleted with the sandbox after scoring (4.3).
- Arm A: one hub per run on port 7799 (flag `--hub-port`), with `HOME` = the run's home and `CONCLAVE_HOME=<home>/.conclave`, started before the run and stopped after the runner has read the session, its children and the usage records. So A, like B, starts every run from a fresh install: no sessions, usage records, routines or background shells of earlier runs. A hub start takes under a second and is not part of `wall_ms`. The runner writes this `config.json` before the hub starts:
  - providers: `bench-claude` (type `anthropic`, baseUrl = the tap (4.5), apiKeyEnv `CLIPROXY_API_KEY`) and `cliproxy` enabled for A2. No other provider has a key.
  - `defaultModel` and `smallModel` point at proxy model ids, so side calls never fall back to a provider without a key.
  - `memory.enabled: false`, `compat.claudeCode: false`, `compat.agentsMd: false`, `mcpServers: {}`.
  - `permissions.mode: bypass`, `permissions.deny`: `WebFetch`, `WebSearch`, `Consult`, `Notify`, `ScheduleRoutine`, `MemorySave`, `MemorySearch`, `MemoryForget`, `AskUserQuestion`, the assistant tools (`GoalList`, `GoalGet`, `GoalCreate`, `GoalUpdate`, `GoalLog`, `DayPlan`, `ProactivePrefs`), past chats and learned skills (`SessionSearch`, `SessionRead`, `SkillManage`), `Workflow` (Claude Code offers no workflow tool without an opt-in), `browser_*`. This is a backstop at call time. The assistant, past chat, skill and workflow tools are on the list from run 3 on.
  - `limits.autoResume: false`, `limits.fallbacks: {}` (no silent model switch), remote access off, notifications off.
  - Bench copies of the shipped `coder` agent and of every subagent (`explore`, `general-purpose`, `reviewer`, `researcher`) in `<home>/.conclave/agents/`, each with one added frontmatter line, `disallowedTools:` and the same list as the deny list. The prompt text stays byte for byte (`bench parity` checks it). This takes the tools out of the list sent to the model, the way `--disallowedTools` does for B (4.1). With `--match-effort` the coder copy also gets `thinking: <level>`.
- Arm B: a fresh `CLAUDE_CONFIG_DIR=<home>/.claude` per run, so no transcript, memory file or setting of an earlier run is there. `--strict-mcp-config` with an empty MCP config in that folder, `--disallowedTools` with `WebFetch`, `WebSearch`, `DesignSync`, `AskUserQuestion`, the schedule tools (`CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`), the notify tools (`PushNotification`, `SendUserMessage`) and the tools that reach other sessions (`SendMessage`, `ListAgents`), `DISABLE_AUTOUPDATER=1`, stdin from `/dev/null`. If the runner's user is root, it sets `IS_SANDBOX=1` so bypass mode starts. For `--b-transport login` without `CLAUDE_CODE_OAUTH_TOKEN`, log in once with `CLAUDE_CONFIG_DIR=bench/.state/claude-login claude`; each run copies only `.credentials.json` from there.
- Machine wide settings (`/etc/claude-code/managed-settings.json`) still reach B. `doctor` warns when the file exists.
- The owner's running hub (port 7717), `~/.conclave` and `~/.claude` are never read or written by the runner.
- No agent env var or argv names a path in `bench/` or in the runner state (`bench/.state`). The scorer and `validate` use `bench/.state/home`, which no agent sees. Every run records any such path it finds (`isolation.env_bench_paths`, `isolation.argv_bench_paths`).

### 4.3 Work copies

- Work root: `$BENCH_WORK`, default `/tmp/conclave-bench/<set>/`. It must sit outside any git repo, and no parent folder may hold `CLAUDE.md`, `AGENTS.md`, `CONCLAVE.md` or `.claude/`. `doctor` checks this. `doctor` also fails when the work base (`/tmp/conclave-bench/`) holds files of other sets or of a `validate` run, since a sandbox's `../..` would show them. `validate` keeps its scratch in `bench/.state/scratch/`.
- Run nothing else from `bench/` (validate, dry runs, checks) while a set runs. Those processes name task and hidden paths in their command lines, which an agent running `ps` would see. The runner records any such process it finds before each run (`isolation.foreign_bench_processes`).
- Per run, a sandbox `<work>/<run_id>/` with two folders only: `repo/` (the agent's working folder: a copy of `tasks/<id>/repo/`, `git init`, one commit named `initial`) and `home/` (4.2). The run id is random and does not name the arm.
- The pristine copy (for the diff), the diff scratch and the scoring copy live in `bench/.state/private/<run_id>/`, outside the sandbox. `validate` and `judge` scratch live in `bench/.state/scratch/<set>/`, not in the work root.
- When the agent exits, the runner kills every process whose working folder is inside the sandbox (`isolation.stragglers_killed`). Both harnesses can leave background shells behind, and Conclave starts its shells in their own process groups, so killing the agent's process group is not enough. For A the runner also aborts the session through the hub and waits until it is idle. Only then does it diff and score.
- After scoring, the runner copies the final `repo/` to `runs/<run_id>/final/` in the set folder and deletes the sandbox and the private folder. The work root then holds only the run in progress, so an agent that lists `..` or `../..` sees nothing of another run. `bench parity --e2e` checks this from inside both real agents.
- Network is not needed. Both arms get `GOPROXY=off`, `GOTOOLCHAIN=local`, `CARGO_NET_OFFLINE=true`, `PIP_NO_INDEX=1` and `npm_config_offline=true`, so package installs fail fast instead of hanging. The model API itself still works.

### 4.4 Conclave version under test

Another workflow may be editing `packages/` while you run this. The runner never changes `packages/`.

- `--conclave-src <dir>` picks the Conclave checkout to run, default the repo root. For a stable test, point it at a `git worktree` of a fixed commit.
- The manifest records the commit and a dirty flag (`git status --porcelain packages | wc -l`). A dirty source is allowed but printed in the summary.
- Claude Code: record `claude --version` before the first run and after the last. If it changed, the summary says so.

### 4.5 The tap

Both arms send every model call through the tap, a small pass-through on `127.0.0.1:<hub port - 1>` (flag `--tap-port`, 0 turns it off) that forwards to `CLIPROXY_BASE_URL` and streams the answer back unchanged. Runs are sequential, so the runner tells the tap which run is current. For every request it records, in `runs/<run_id>/tap.jsonl`:

- the model requested and the model the API says it served (`message_start`);
- the tokens from the response (input, output, cache read, cache write, and the part of cache writes at the 1 hour TTL);
- what the harness sent: tools offered, `thinking`, `output_config.effort`, `max_tokens`, system prompt size and hash, message count;
- whether the task prompt appears byte for byte in the first user message;
- the leak scan (section 9): bench paths named in tool calls, bench paths shown in tool results, and hidden test lines shown in tool results that the agent did not write itself.

With the tap, token counts, list cost, the served model check and the per run token cap use one parser and one clock for both arms. Each tool's own counts are kept beside them (`tokens_tool`, `cost.list_usd_tool`). Requests outside any run go to `tap-unattributed.jsonl`. The judge and `doctor` talk to the proxy directly.

## 5. Tasks

### 5.1 Layout

```
bench/tasks/<id>/
  task.json      metadata, see 5.2
  prompt.md      the task text the agent gets (before the shared wrapper)
  repo/          what the agent sees
  hidden/        tests, reference solution, optional naive fix, optional alt/<name>/ fixes; never copied before scoring
  NOTICE         source and license, for public tasks
bench/fixtures/<base>/   shared base codebases for seeded tasks
bench/tasks/<id>/overlay/ the files a seeded bug task changes in its base (the bug itself)
bench/runners/           test output helpers (for example unittest_json.py)
bench/third_party/       license texts
```

`bench build` materializes seeded tasks from a base fixture plus a task overlay, so each `repo/` is complete and self-contained.

### 5.2 task.json

```json
{
  "id": "bug-ts-cents",
  "kind": "bug",
  "lang": "typescript",
  "difficulty": "medium",
  "time_limit_s": 900,
  "smoke": false,
  "source": { "type": "fixture", "base": "ledgerkit" },
  "visible_test_cmd": "bun test",
  "hidden": {
    "files": { "hidden/tests/cents.test.ts": "tests/hidden/cents.test.ts" },
    "runs": [
      { "cmd": "bun test tests/hidden", "format": "bun", "env": {} }
    ],
    "timeout_s": 120,
    "expected_total": 7,
    "restore": ["bunfig.toml", "package.json"],
    "move_aside": []
  },
  "protected": ["test/**", "tests/**", "bunfig.toml", "package.json"],
  "artifacts": ["node_modules/", "target/", "__pycache__/", ".pytest_cache/", ".bench-moved/"],
  "reference": "hidden/reference/",
  "naive": "hidden/naive/",
  "license": null
}
```

Field rules:

- `kind`: `polyglot`, `bug` or `feature`.
- `difficulty`: `easy`, `medium` or `hard`.
- `time_limit_s`: 600 for easy, 900 for medium, 1200 for hard.
- `hidden.runs[].format`: `unittest-json`, `bun`, `go-json` or `cargo`. A task may have several runs (for example two time zones). `expected_total` is the sum over runs.
- `hidden.restore`: files put back from pristine in the scoring copy before tests run (or deleted if pristine had none).
- `hidden.move_aside`: globs of files the agent created that would break the hidden build (Go `*_test.go`). They move to `.bench-moved/` in the scoring copy. The move is logged.
- `hidden.clear`: folders removed from the scoring copy before the hidden tests go in (`tests/hidden/`), so files the agent put there cannot change the count.
- `reference`: an overlay that makes every hidden test pass.
- `naive`: optional overlay with the obvious wrong fix. `validate` checks that it still fails at least one hidden test.
- `hidden/alt/<name>/` (not in task.json): optional overlays with other correct fixes, written in a different style from the reference. `validate` checks that each one passes every hidden test, so the tests do not ask for more than the prompt says.
- `{bench}` in a command expands to the absolute bench path.

### 5.3 The 18 tasks

Public set: 8 Exercism exercises from the Aider polyglot benchmark, commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`.

| id | exercise | lang | diff. | limit | hidden test command |
|---|---|---|---|---|---|
| pg-rs-luhn-from | rust/luhn-from | Rust | easy | 600 | `cargo test --offline --test luhn-from -- --include-ignored` |
| pg-py-bowling | python/bowling | Python | medium | 900 | `python3 {bench}/runners/unittest_json.py bowling_test.py` |
| pg-js-tic-tac-toe | javascript/state-of-tic-tac-toe | JavaScript | medium | 900 | `bun test ./state-of-tic-tac-toe.spec.js` |
| pg-go-word-search | go/word-search | Go | medium | 900 | `go test -json ./...` |
| pg-py-sgf-parsing | python/sgf-parsing | Python | hard | 1200 | `python3 {bench}/runners/unittest_json.py sgf_parsing_test.py` |
| pg-js-react | javascript/react | JavaScript | hard | 1200 | `bun test ./react.spec.js` |
| pg-go-forth | go/forth | Go | hard | 1200 | `go test -json ./...` |
| pg-rs-xorcism | rust/xorcism | Rust | hard | 1200 | `cargo test --offline --all-features --test xorcism -- --include-ignored` |

Vendoring rules for public tasks:

- `repo/` gets the stub files and helper files the exercise marks as editor files (for example Go `interfaces.go`). Nothing from `.meta/` (it holds the example solution) and no test files.
- The prompt is built from `.docs/instructions.md` plus `.docs/instructions.append.md` when present, then a "Notes for this task" section when the catalog has one, then this line: "Use the instructions above to change these files: <solution files>. Keep the names of existing functions, classes and types, because the tests use them. Use only the standard library. Do not install packages."
- JavaScript: replace `package.json` with `{"name": "<exercise>", "private": true, "type": "module", "scripts": {"test": "bun test"}}`. Drop `babel.config.js`, `.eslintrc` and `.npmrc`. Keep the exercise `LICENSE`. In the hidden spec, change `xtest(` to `test(`.
- Rust: the hidden command uses `--include-ignored` because Exercism marks most tests `#[ignore]`.
- `hidden/reference/` comes from `.meta/example.*` or `.meta/proof.ci.js`.
- On Exercism the student sees the test file. Here the agent does not, so any fact the tests need that the instructions leave out goes in the notes: the board format, return values and exact error messages for `pg-js-tic-tac-toe`, the cell API for `pg-js-react`, and the fact that the `io` feature tests count for `pg-rs-xorcism`. The notes state interfaces, never the algorithm. `bench check` fails when a hidden test needs an exact error text or an API name that neither the prompt nor `repo/` shows.
- Go exercises keep `cases_test.go` in `repo/`, as Exercism lists it as an editor file. It holds the test data (inputs and expected outputs), which the instructions alone do not specify, such as the coordinate order in word search. The test functions stay hidden.
- Each task gets a `NOTICE` that names the exercise, its Exercism track, the polyglot commit, and the MIT license. `bench/third_party/EXERCISM-LICENSE.md` holds the license text with the Exercism copyright line.
- These exercises are public and probably in the model's training data. That helps both arms the same way. It is one reason for the seeded tasks below.

Seeded tasks live in two small codebases written for this kit. Both have no dependencies, a README, a visible test suite that passes, and one `initial` commit.

- `ledgerkit` (TypeScript on Bun, about 800 lines): a personal ledger CLI and library. `src/money.ts`, `src/currency.ts`, `src/importers/csv.ts`, `src/dates.ts`, `src/filter.ts`, `src/report.ts`, `src/export.ts`, `src/config.ts`, `src/cli.ts` (exports `main(argv, io)` for tests), `test/*.test.ts`.
- `tasksd` (Python 3 standard library, about 800 lines): a small job queue with a JSON HTTP API. `tasksd/store.py` (sqlite3), `models.py`, `backoff.py`, `clock.py`, `worker.py`, `http_util.py`, `api.py` (`http.server`), `cursor.py`, `cli.py` (argparse), `tests/test_*.py` (unittest).

Hidden tests for seeded tasks go to `tests/hidden/` and test only public behavior.

Seeded bug fixes. Each has a real bug, a symptom that points the wrong way, and a fix that needs more than one file read.

| id | lang | diff. | limit | what the user reports | real cause | trap the hidden test catches |
|---|---|---|---|---|---|---|
| bug-ts-cents | TS | medium | 900 | "The March report total is one cent short. The report must round the total wrong." | `importers/csv.ts` has its own `Math.floor(parseFloat(s) * 100)` instead of `money.parseAmount`, so 0.29 becomes 28 cents. The report math is right. | Rounding in the report. Hidden tests check exact cents per imported entry, and that the importer accepts every format `parseAmount` does, such as `(12.30)`, as the README promises. |
| bug-ts-timezone | TS | hard | 1200 | "On my server (TZ=Europe/Berlin) entries from March 31 are missing from the March report. On my laptop they show up. Is the server's data file stale?" | `dates.ts` parses `YYYY-MM-DD` as UTC midnight, while `monthRange` and the month grouping in `report.ts` and `filter.ts` use local time. | A fix that works only east of UTC. Hidden tests run twice, with `TZ=Europe/Berlin` and `TZ=America/Los_Angeles`, and check the first and last day of the month. |
| bug-ts-config | TS | medium | 900 | "`ledgerkit report --currency EUR` still prints USD when a ledgerkit.json exists. The flag parser looks broken." | `config.ts` merges `defaults, flags, file`, so the file wins. The parser is fine. | `cli.ts` passes every known flag key, unset ones as `undefined`. Swapping the merge order then wipes file values. Hidden tests check default < file < env < flag, with flags absent and present. |
| bug-py-retry | Python | medium | 900 | "After a job fails once, the worker retries it in a hot loop, thousands of times a minute. backoff.py must be broken; it should wait 2s, 4s, 8s." | `worker.py` adds `backoff.delay()` (seconds, as documented) to `clock.now_ms()`. The store column is `next_run_at_ms`. | Changing `backoff.py` to return milliseconds. That breaks the `Retry-After` header in `api.py`, which uses seconds. Hidden tests use a fake clock and check both. |
| bug-py-utf8 | Python | easy | 600 | "Some clients fail on GET /tasks/<id> with 'Unterminated string'. I think json.dumps in api.py writes bad JSON for some titles." | `http_util.send_json` sets `Content-Length` from `len(str)`, not the byte length. Non-ASCII titles get cut off. | Setting `ensure_ascii=True`. The README promises raw UTF-8. Hidden tests check the raw bytes, the header, and error responses from `send_error_json`. |
| bug-py-cursor | Python | hard | 1200 | "Paging GET /tasks?limit=50 with next_cursor sometimes shows a task twice and skips others, mostly after bulk imports. Is limit off by one in api.py?" | Keyset paging on `created_at` alone (second resolution) with `>=`, plus a hack in `api.py` that drops one duplicate. Ties break it. | Patching the limit or the dedupe hack. Hidden tests insert 120 tasks over 3 timestamps, page with limit 7, and require every id exactly once, stable order, full pages. The fix spans `store.py`, `cursor.py` and `api.py`. |

Feature tasks in the same codebases. The prompt fixes the interface the hidden tests use.

| id | lang | diff. | limit | request |
|---|---|---|---|---|
| feat-ts-json | TS | easy | 600 | Add `--format json` to `ledgerkit report`. Shape: `{"month", "currency", "total_cents", "categories": [{"name", "total_cents", "count"}], "entries"}`. Text stays the default. Any other value exits 2 and prints `unknown format: <v>` to stderr. Update help and README. Add tests. |
| feat-ts-money | TS | medium | 900 | Refactor: money formatting is copied in `report.ts` and `export.ts`, and the copies disagree for JPY. Move it into `formatMoney(cents: number, currency: string, locale?: string): string` in `src/money.ts`, use it in both places, print zero-decimal currencies without decimals, keep all other output byte for byte. Add tests. |
| feat-py-attempts | Python | medium | 900 | Add `GET /tasks/{id}/attempts`: newest first, `{"task_id", "attempts": [{"n", "started_at", "finished_at", "ok", "error"}]}`, `?limit=` default 20, max 100, 400 on a bad value, 404 `{"error": "not found"}` for an unknown task. Add tests. |
| feat-py-purge | Python | easy | 600 | Add `--dry-run` to `tasksd purge --older-than <dur>`. Accept `30m`, `12h`, `7d`, and a bare integer as days (today's form). With `--dry-run`, print `would delete <n> tasks` and one line `<id> <created_at ISO>` per task, and delete nothing. A bad duration exits 2 with a message. |

Mix: 4 easy, 8 medium, 6 hard. 8 public, 6 bug, 4 feature. Smoke set (`--tasks smoke`): `pg-rs-luhn-from` and `feat-py-purge`.

### 5.4 Task validation (`bench validate`)

Run once after building, and on the server before the first set. A task that fails any check is skipped for every arm and listed in the summary.

1. Required toolchain present (`python3`, `bun`, `go`, `cargo`). A missing one skips its tasks for all arms.
2. Visible tests pass on pristine `repo/` (seeded tasks).
3. Hidden tests fail on pristine `repo/` (at least one failure or a build error).
4. Hidden tests all pass with the `reference` overlay. Store the count as `expected_total`.
5. The `naive` overlay, if present, fails at least one hidden test.
6. Hidden tests finish within a quarter of `hidden.timeout_s` and pass with the offline variables from 4.3 set.
7. `repo/` holds no `CLAUDE.md`, `AGENTS.md`, `CONCLAVE.md`, `.claude/`, solution file or test that the hidden set will overwrite.
8. Visible tests pass with the `reference` overlay, so a correct fix never has to edit them.
9. Every `hidden/alt/<name>/` overlay passes every hidden test, and the visible tests.
10. With `--repeat <n>`, each tree (pristine, reference, naive, alternatives) is scored n times. Any change in counts, exit codes or failing test names is a problem (a flaky test). Run `validate --repeat 3` after any change to a task.

`bench check` runs the static checks, with no toolchain and no model:

- `task.json` matches the catalog.
- Polyglot prompts hold their notes block.
- Exact error texts and API names that polyglot hidden tests use appear in the prompt (as code) or in `repo/`.
- Bug prompts do not contain the words that name the real cause (the list is `CAUSE_WORDS` in `lib/checks.ts`).
- Seeded repos carry no comments such as BUG, FIXME or HACK.
- The time limit fits the difficulty, the full set has at least 5 hard tasks and the smoke set has 2.

## 6. Prompt

Both arms get exactly this text. `<prompt.md>` is the task's own text.

```
You are working in the repository in the current directory.

<prompt.md>

Rules for this task:
- Work only inside this directory. You do not need the network.
- Hidden tests will check your work after you finish. They are not in this directory. You may write and run your own tests.
- Nobody will answer questions. If something is unclear, make a reasonable choice and say what you chose.
- End your reply with one line, exactly "RESULT: DONE" or "RESULT: NOT DONE", then one sentence on how you checked your work.
```

- A: the runner passes the text as the prompt argument of `conclave run`. B: the same text as the `-p` argument. If a shell would mangle it, both arms get it on stdin instead.
- Nothing else is added: no system prompt changes, no appended instructions, no task-specific hints for one arm.

## 7. Run procedure

Per set:

1. `doctor`: toolchains, Claude Code version and flags, proxy reachable, model id listed, served id check for A and B, ports free, work root clean, Conclave commit and dirty flag. Write `manifest.json`.
2. Start the tap (4.5). For each run of arms A, A2 and C, the runner starts a fresh hub with `CONCLAVE_HOME=<home>/.conclave HOME=<home> bun <conclave-src>/packages/cli/src/index.ts serve --port 7799` as a child, waits for `/api/health`, passes its token to `run` with `--hub`, and stops it after the run (4.2). The CLI never starts or touches any other hub.
3. Build the run list: tasks in an order shuffled by `--seed` (default 1), and for each task each repeat as a group of all selected arms. The arm order rotates from group to group (a seeded shuffle, then a rotation by one per group), so each arm goes first in exactly as many groups as the other, give or take one. A coin flip per group could give 12 to 6 over 18 tasks. The manifest records the counts (`first_in_group`).
4. Before each group, check the budget (section 11). Stop if it would be exceeded.
5. For each run in the group: make a fresh sandbox (4.3), start the arm (7.1), wait for exit or the time limit, save logs, kill leftover processes, compute the diff (8.1), score (8.2), extract metrics (9), append one line to `results.jsonl`, flush it to disk, keep the final repo and delete the sandbox.
6. After the last group, or on a stop: stop the tap, run `judge` unless `--no-judge`, then `report`.

### 7.1 Commands

Arm A:

```
CONCLAVE_HOME=<home>/.conclave HOME=<home> \
bun <conclave-src>/packages/cli/src/index.ts run "<prompt>" \
  --agent coder --model bench-claude/<id> --cwd <copy> \
  --json --yes --permission-mode bypass --timeout <limit>s \
  --hub http://127.0.0.1:7799 --token <token>
```

Arm B:

```
HOME=<home> CLAUDE_CONFIG_DIR=<home>/.claude ANTHROPIC_BASE_URL=<tap> ANTHROPIC_API_KEY=$CLIPROXY_API_KEY \
claude -p "<prompt>" --model <id> \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --disallowedTools WebFetch WebSearch DesignSync CronCreate CronDelete CronList \
    ScheduleWakeup RemoteTrigger PushNotification SendUserMessage SendMessage ListAgents AskUserQuestion \
  --strict-mcp-config --mcp-config <home>/.claude/mcp-none.json
```

The runner starts B with the copy as its working directory.

Flag detection for B: the runner reads `claude --help` once per set.

- If `--permission-mode` does not list `bypassPermissions`, use `--dangerously-skip-permissions`.
- If `stream-json` is missing, use `--output-format json`. Tool metrics are then `null`, not 0.
- Use whichever spelling of the disallowed tools flag the help shows.
- Write the final argv of both arms into `manifest.json`.

Time limits:

- A: `--timeout` aborts the session at the limit. If the CLI is still alive 15 s later, the runner sends SIGINT (the CLI aborts again), then SIGTERM and SIGKILL 15 s apart. Before scoring, the runner aborts the session through the hub again and waits until it is idle.
- B: the runner sends SIGINT at the limit, SIGTERM 15 s later, SIGKILL 15 s after that, to the whole process group.
- A timed out run is still scored on what is in the folder. It is marked `timed_out: true`.
- The tap records when each model call ended, so every run also gets `limit_overrun_ms`: how long after the limit the last model call ended. The summary shows the worst case per arm.

## 8. Scoring

### 8.1 Diff

- Compute the diff between `pristine/` and the final `repo/` with `git diff --no-index`. Exclude `.git/`, the task's `artifacts`, and build products the start repo did not have (`Cargo.lock`, `bun.lock`, `bun.lockb`, `.venv/`, `.ruff_cache/`, `.mypy_cache/`, `.cache/`, coverage files). This holds even if the agent committed. Without the build product rule, the arm that runs `cargo test` gets a stray `Cargo.lock` in its diff, a bigger `files_touched`, and a lower `minimal` score from the judge.
- Save `diff.patch` and `numstat.txt`.
- Record files changed, lines added and lines removed.
- Record `modified_existing_tests`: changed or deleted files that match `protected` and exist in pristine.
- Record `protected_changed`: any change under `protected`, including new files there.
- Record `suspicious_files`: new `sitecustomize.py`, `usercustomize.py`, `*.pth`, `conftest.py`, `bunfig.toml`, `.cargo/config.toml`, `go.work` or test preload files.

### 8.2 Hidden tests

1. Copy the final `repo/` to `<run>/score/`. The agent's own folder stays as it was.
2. In `score/`: first remove every link that resolves outside `score/`, and every link on a path the scorer writes (`hidden.restore`, `hidden.clear`, `hidden.files`). Then restore `hidden.restore` and the tool config files `.cargo/config.toml`, `.cargo/config`, `go.work`, `bunfig.toml` for every task (deleted when pristine has none), move `hidden.move_aside` files aside, remove `hidden.clear` folders, copy `hidden.files` in (overwriting). Without the first step a link the agent left (`tests -> /somewhere`) makes the scorer write hidden tests outside its copy, delete outside folders, and score the wrong tree. Removed links are listed in `tests.links_removed`.
3. Run each `hidden.runs[]` command with its env, the offline variables and a timeout of `hidden.timeout_s`.
4. Parse the output by `format` into passed, failed and errored counts:
   - `unittest-json`: the helper prints JSON.
   - `bun`: the summary lines, the last block of them (the code under test may print look-alike lines first).
   - `go-json`: leaf test events.
   - `cargo`: `test ... ok|FAILED` lines.
5. A build error counts as 0 passed of `expected_total`. So does a hidden test file that did not run: for `cargo` and `bun` the output must name each hidden file (`Running tests/x.rs`, `tests/x.test.ts:`). This catches a `[[test]]` entry in `Cargo.toml` that points the hidden test target at the agent's own file. Such files are listed in `tests.not_run`.
6. `pass` is true only when passed equals `expected_total` and every command exited 0.
7. `partial` is passed divided by `expected_total`.
8. Save the raw output as `test-output.txt`.

## 9. Metrics

One value per run. "n/a" is stored as `null`, never as 0.

| metric | definition | A source | B source |
|---|---|---|---|
| pass | all hidden tests pass | scorer | scorer |
| partial | hidden passed / expected_total | scorer | scorer |
| wall_ms | process start to exit | runner clock | runner clock |
| input, output, cache_read, cache_write | tokens, summed over all model calls of the run, including subagents and side calls | the tap (4.5) | the tap |
| tokens_by_model | the same, split by the served model id | the tap | the tap |
| tokens_tool | the tool's own count, kept as a cross check and used when the tap did not see the arm | usage records of the run's fresh hub | `result.modelUsage` (else `result.usage`) |
| cost_reported_usd | what the tool says | session `costUsd`, summed | `total_cost_usd` |
| cost_list_usd | tokens times list price from `bench/prices.json` (dated), same formula for every arm; cache writes at the 1 hour TTL at 2 times input | runner, from tap tokens | runner, from tap tokens |
| turns_main | model responses in the main loop | assistant messages of the main session (cross check: usage records with purpose `turn`) | distinct `message.id` with no `parent_tool_use_id` |
| turns_sub | model responses inside subagents | assistant messages of child sessions | distinct `message.id` with a `parent_tool_use_id` |
| tool_calls | calls by normalized tool: read, edit, write, bash, grep, glob, list, todo, task, other | `tool.started` events | `tool_use` blocks |
| failed_tool_calls | results with `is_error`, Bash excluded | `tool.completed` `isError` | `tool_result` `is_error` |
| bash_nonzero | Bash calls that exited non-zero (a failing test run is normal work, so it is kept apart) | same | same |
| edit_misses | failed edits whose old text was not found or not unique | error text | error text |
| reverted_edits | (a) a later edit that swaps back an earlier edit's old and new text on the same file, (b) files the agent edited that end equal to pristine, (c) Bash `git checkout --`, `git restore`, `git stash` or a copy back from a backup | events | events |
| files_touched | files changed in the final diff; also `files_written` = distinct files hit by edit tools | diff, events | diff, events |
| diff_lines | lines added plus lines removed in the final diff | diff | diff |
| claim | `DONE`, `NOT DONE` or `null` from the last `RESULT:` line of the final reply | final assistant message (`GET /api/sessions/<id>/messages`) | `result.result` |
| false_success | claim is `DONE` and pass is false | runner | runner |
| no_claim | the final reply has no `RESULT:` line | runner | runner |
| timed_out | hit the time limit | runner | runner |
| limit_overrun_ms | how long after the time limit the last model call ended | tap | tap |
| sent | what the harness sent the model: tools offered, thinking, effort, max_tokens, system prompt size, prompt found | tap | tap |
| network_attempt | a Bash call runs curl, wget, pip, npm, cargo fetch or similar, or a fetch tool was tried | events | events |
| leak_suspect | any of: a tool call names a path into `bench/tasks`, `bench/fixtures`, `bench/results`, the runner state, another run's sandbox, a `hidden/tests`, `hidden/reference`, `.meta` or `polyglot-benchmark` folder; a tool result shows such a path; a tool result shows 2 or more lines of this task's hidden tests that the agent did not write itself in any tool call. A wide search alone (`find /`) is recorded as `wide_search`, not a leak | tap and events | tap and events |
| isolation | sandbox neighbours, leftover processes killed, bench paths in env or argv, hub start time | runner | runner |
| tamper_flags | `modified_existing_tests`, `protected_changed`, `suspicious_files` | diff | diff |
| own_tests | whether the agent's own tests show its change. Its added or changed test code under the task's `protected` globs (`.py`, `.js`, `.ts` and kin; config such as package.json left out, links left out) goes over the pristine start tree, and the task's `visible_test_cmd` runs there, 60 s at most. The same command then runs on the final tree, with links out removed and tool config restored as in 8.2. `fails_on_start` and `passes_on_final` are true, false, or null when that run said nothing: a timeout, exit 126 or 127, a test that did not load, no test ran (the shared rules in `packages/core/src/util/test-run.ts`, which Conclave's regression gate uses too). The visible suite passes on the start tree (5.4), so a failure there comes from the agent's tests; a test file the command does not run cannot fail. Null for tasks without a visible test command and for runs that changed no test file. Kept in `own-tests.txt` | runner | runner |
| regression_gate | what Conclave's regression gate did: runs of the turn's changed tests on the code from before the turn that failed (`proven`), passed (`passes`, with `reminded` counting the reminders), said nothing (`not_run`), or that it did not run (`skipped`: the checkpoint raced, a runner it does not know, an untrusted folder). Run 4 and older sets have no such field | `regression.checked` events in the stream, else the session's `regression.gate` audit rows | null |

Tool name map: Read, NotebookRead to read. Edit, MultiEdit, NotebookEdit to edit. Write to write. Bash, BashOutput, KillShell to bash. Grep, RepoMap to grep. Glob to glob. LS to list. TodoWrite to todo. Task to task. Everything else to other, with its real name kept in `tool_calls_raw`.

## 10. Blind judge

`bench judge` runs after all runs of a set.

- Judge model: `--judge-model`, default the same id through the proxy, with thinking on. Arm labels never reach it. Since both arms use the same model, self preference hits both equally.
- One judge call per task. It sees:
  1. The task prompt exactly as the agents got it.
  2. A known good reference solution, labeled "one correct solution, not the only valid one".
  3. For each candidate: the final diff (artifacts excluded, cut at 60,000 characters with a note), the hidden test summary, up to 80 lines of failing test output, and the list of changed existing test files.
- It never sees transcripts, tool names, timings, tokens, cost, the claim line or any arm name. The runner strips harness files from the diff before judging (`.claude/`, `CONCLAVE.md`, todo files a harness writes) and lists them separately in the results.
- Candidates are named "Candidate 1", "Candidate 2" and so on. Their order is a shuffle seeded by `sha256(task_id)`, so each arm comes first in about half the tasks.
- Two passes by default: the second with the order reversed, so each arm sits in each position once per task and position bias cancels. Scores are averaged. If the preference flips between passes, it is recorded as `tie (order sensitive)`. `--no-judge-swap` runs one pass only.
- Rubric per candidate, integers 1 to 5:
  - `correctness`: beyond the tests. Edge cases, error handling, no hard coded answers, no special cases for test inputs.
  - `minimal`: does what was asked and no more. No unrelated edits, no stray files.
  - `readability`: clear names and structure, follows the patterns already in the repo.
  - `tampering`: yes or no. Weakened, edited or deleted tests or test config, or code that detects the test run.
- Plus `preference`: the candidate it would merge, or `tie`. Plus `notes`: one to three sentences per candidate.
- Output is strict JSON. On invalid JSON the runner retries once, then stores `judge_error`.
- Results go to `judge-<model>.jsonl`, one file per judge model and one line per run (`run_id`, scores, notes, and the task level preference mapped back to an arm after judging). A set judged before this rule keeps its `judge.jsonl` for its first judge. A second judge (for example a GPT model through `/v1/chat/completions`, `--judge-provider openai`) adds its own file, and the report shows every judge side by side with their agreement. The first judge drives the main tables.
- The judge prompt lists the test files that were in the starting repo, so a new agent test that uses names from them is not flagged.

## 11. Budget, rate limits, stops

Budget flags, checked before each group of runs:

- `--budget-tokens` (default 150,000,000, all token types summed).
- `--budget-usd` (list price, default none).
- `--budget-wall` (default 12h, counted from the set start).

The check: if spent plus the estimate for the next group exceeds a budget, stop. The estimate is the 90th percentile of completed runs, or the time limit times the number of arms when no run is done yet.

`--run-token-cap` (default 8,000,000) stops a single runaway run. The runner watches live usage (A: usage events, B: stream usage) and stops the arm the same way as a timeout. The run is marked `capped` and still scored.

Rate limits:

- A: detected when the session status is `waiting_reset`, or when the error matches `rate limit|429|usage limit|overloaded`.
- B: detected when the result is an error and its text matches the same pattern, or when the stream reports retries for 429.
- A rate limited run is stopped and stored with `valid: false, invalid_reason: "rate_limit"`, then:
  - If the reset time is known and within `--max-wait` (default 45m), the runner waits until reset plus 60 s, then reruns the same run id from a fresh copy as attempt 2. At most 2 attempts per run.
  - Otherwise it stops cleanly.
- Other transient errors (overload, network), no model calls at all, or a bench hub that does not start: wait 60 s and retry once.
- If one arm ends 3 runs in a row invalid for a reason other than a rate limit or a stop (agent not found, hub does not start, no model calls, wrong model served), stop cleanly with exit 3. Its tasks cannot pair, and the other arm's runs would be spent for nothing.
- A runner error (a bug, a full disk) stops the set with exit 1 after the judge and the summary.

Clean stop (budget, rate limit, SIGINT):

- Stop the current run and mark it invalid (`interrupted`).
- Keep every line already in `results.jsonl`.
- Write `summary.md` from the valid runs, stop the hub, and exit with code 3 (budget or rate limit) or 130 (SIGINT).
- `--resume --set <name>` skips run ids that already have a valid line and continues in the same order. It first deletes any sandbox a dead runner left in the work root, and kills what still runs there.
- A second Ctrl-C exits at once, after killing the running agent's process group and its leftover processes. If the runner dies without cleanup (kill -9, out of memory), a watchdog shell ends the agent and the bench hub within about a second, so no orphan keeps spending tokens.

## 12. Output

All under `bench/results/<set>/`. The default set name is `<date>-<model>-<short sha>`.

```
manifest.json         versions, argv per arm, transport, thinking, seed, flags, skipped tasks,
                      arm order counts, tap and isolation setup
results.jsonl         one line per run (valid or not)
judge-<model>.jsonl   one line per judged run, per judge model
summary.md            the report
tap-all.jsonl         every model call the tap saw, in order
tap-unattributed.jsonl  model calls outside any run (should be empty)
runs/<run_id>/        events.jsonl, stdout.txt, stderr.txt, final.txt, diff.patch,
                      numstat.txt, test-output.txt, meta.json, tap.jsonl,
                      hub.json and hub.log (A), final/ (the final repo)
```

### 12.1 results.jsonl line

```json
{
  "schema": 1, "set": "2026-10-18-claude-opus-5-5-a1b2c3d", "run_id": "r7f3k2",
  "task_id": "bug-ts-cents", "kind": "bug", "lang": "typescript", "difficulty": "medium",
  "arm": "A", "repeat": 1, "attempt": 1, "order_in_group": 2,
  "started_at": "2026-10-18T09:12:03Z", "ended_at": "2026-10-18T09:18:40Z",
  "model_requested": "claude-opus-5-5", "model_served": ["claude-opus-5-5"], "model_served_source": "tap",
  "transport": "proxy-anthropic", "harness_version": "conclave a1b2c3d (dirty: 0)",
  "thinking": { "mode": "adaptive", "effort": null },
  "sent": { "thinking": ["{\"type\":\"adaptive\"}"], "effort": ["none"], "max_tokens": [32000], "tools": ["Bash", "Edit", "Read"],
            "system_chars": 7151, "system_sha": "3f2a...", "prompt_found": true, "forbidden_tools": [] },
  "status": "completed", "valid": true, "invalid_reason": null,
  "exit_code": 0, "timed_out": false, "limit_overrun_ms": null, "capped": false, "wall_ms": 397000,
  "tests": { "passed": 7, "failed": 0, "errored": 0, "expected_total": 7, "partial": 1.0, "pass": true, "build_error": false },
  "tokens": { "input": 41200, "output": 9800, "cache_read": 612000, "cache_write": 38000,
              "cache_write_1h": 0, "source": "tap",
              "by_model": { "claude-opus-5-5": { "input": 40000, "output": 9500, "cache_read": 612000, "cache_write": 38000 } } },
  "tokens_tool": { "input": 41200, "output": 9800, "cache_read": 612000, "cache_write": 38000, "by_model": {} },
  "cost": { "reported_usd": 1.42, "list_usd": 1.38, "list_usd_tool": 1.38, "list_usd_tap": 1.38, "prices": "2026-10-17" },
  "turns": { "main": 23, "sub": 0 },
  "tools": { "calls": 31, "by_tool": { "read": 9, "edit": 4, "bash": 12, "grep": 3, "todo": 3 },
             "raw": { "Read": 9, "Edit": 4, "Bash": 12, "Grep": 3, "TodoWrite": 3 },
             "failed": 1, "bash_nonzero": 3, "edit_misses": 1 },
  "edits": { "edit_calls": 4, "reverted": 0 },
  "own_tests": { "files": ["test/csv.test.ts"], "fails_on_start": true, "passes_on_final": true,
                 "start": { "outcome": "failed", "why": "the tests failed", "exit_code": 1, "timed_out": false, "ms": 640 },
                 "final": { "outcome": "passed", "why": "the tests passed", "exit_code": 0, "timed_out": false, "ms": 610 } },
  "regression_gate": { "proven": 1, "passes": 0, "not_run": 0, "skipped": 0, "reminded": 0 },
  "diff": { "files_changed": 2, "files_written": 2, "lines_added": 9, "lines_removed": 4,
            "modified_existing_tests": [], "protected_changed": [], "suspicious_files": [], "harness_files": [] },
  "claim": "DONE", "false_success": false, "no_claim": false,
  "flags": { "network_attempt": false, "leak_suspect": false, "leak_evidence": [], "hidden_lines_seen": 0, "wide_search": [],
             "model_mismatch": false, "forbidden_tools_offered": [], "prompt_not_found": false },
  "isolation": { "neighbours": [], "stragglers_killed": [], "env_bench_paths": [], "argv_bench_paths": [],
                 "hub": { "start_ms": 640, "overrides": ["coder.md", "explore.md"], "settle_status": "idle", "error": null }, "tap": true },
  "paths": { "dir": "runs/r7f3k2", "final": "runs/r7f3k2/final" }
}
```

### 12.2 summary.md

Sections, in this order:

1. **Verdict.** Three to six plain sentences, following the rules in section 13.
2. **Setup.** Model id requested and served, B transport, Conclave commit and dirty flag, Claude Code version (before and after), proxy version, thinking and effort per arm, seed, repeats, dates, skipped tasks and why, how often each arm went first.
2b. **Isolation and parity.** Per arm, from the tap and the sandbox checks: runs through the tap, prompt found, served ids, token source, effort, thinking and max_tokens sent, system prompt size, first request tokens, share of 1 hour cache writes, tools offered (and which only one arm offers), denied tools still offered, leftover processes killed, sandbox neighbours, bench paths in env or argv, hidden lines shown, leak suspects, model calls after the limit, hub start time.
3. **Per arm table.** One column per arm. Rows:
   - pass rate with a 95% Wilson interval
   - mean partial
   - false success claims, no claim
   - judge correctness, minimal and readability means, tampering count
   - median and total wall time
   - median and total tokens (input, output, cache read, cache write)
   - cost reported and list, median and total
   - median turns (main, sub)
   - median tool calls, failed tool call rate, edit misses, reverted edits
   - median files touched and diff lines
   - runs that checked a test without the fix by stashing it, and saw it fail
   - runs with own tests, and of those the runs whose tests fail on the start code and whose visible tests pass on the final code
   - the regression gate, as runs where it looked, proved, saw a pass, reminded, said nothing or skipped (Conclave arms; n/a for the others)
   - timeouts, caps, invalid runs, network attempts, leak suspects
4. **Paired results.** Tasks both pass, only A, only B, neither. Sign test p value. Mean pass difference with a 90% bootstrap interval over tasks. Geometric mean A/B ratios of list cost, total tokens and wall time, with 90% bootstrap intervals, over tasks where both runs are valid.
5. **Per task table.** Task, kind, difficulty, then for each arm: pass, partial, wall time, list cost, turns, claim. Then the judge's preferred arm.
6. **Judge notes.** Per task, the notes mapped back to arms, one to three lines each.
7. **Run problems.** Every invalid, timed out, capped, leak suspect, network attempt and tamper flag, with the run id.
8. **Noise floor.** Only with `--repeats 2`: the share of tasks where the two repeats of the same arm disagree on pass.
9. **Reproduce.** The exact command line.

## 13. Analysis and verdict rules

Fixed before the data comes in.

- The unit is the task. With repeats, a task's score per arm is the mean over repeats (0, 0.5 or 1).
- Only valid pairs count: tasks where every compared arm has at least one valid run. Report how many. The verdict starts with what is left out: an unfinished plan, each task without a counted run in both arms and why, and the invalid runs per arm. Invalid runs are not failures, so an arm that crashes before any model call would otherwise look no worse.
- Each run id counts once: its last valid line, else its last line. The attempt number restarts at 1 on `--resume`, so it does not order lines.
- A call from a bootstrap interval (the 2 repeat bar, and the cost, token and time ratios) needs at least 5 tasks with data. With one or two tasks the interval is a single point and always excludes the null.
- Primary metric: hidden test pass rate, A vs B.
- Test with the exact two sided sign test on discordant tasks (only A passes vs only B passes). Use the 90% bootstrap interval of the mean paired difference: 10,000 resamples over tasks, seed 1.
- Call a winner on correctness only if the test passes its bar. With 1 repeat, the bar is a sign test p < 0.10. With 2 repeats, the bar is a bootstrap interval that excludes 0.
  - With 18 tasks this needs roughly a 5 to 0 or 7 to 1 split of discordant tasks. A 6 to 1 split is not enough (p = 0.125).
  - Say this in the verdict, so a reader does not read 12 vs 14 passes as a result.
- If no winner: "No clear difference in correctness. A passed X, B passed Y, of N tasks." Then state which way it leans, if at all.
- Honesty: report false success claims per arm. Call a difference only if one arm has at least 3 more over the set.
- Quality: a judge mean gap below 0.5 points on the 1 to 5 scale counts as no difference.
- Cost and speed: call a difference only if the 90% interval of the geometric mean ratio excludes 1. Report the ratio either way. Example: "A used 1.4 times the tokens of B (90% interval 1.1 to 1.8)."
- Confidence label:
  - `low` with 1 repeat or fewer than 15 valid pairs.
  - `medium` with 2 repeats and at least 15 valid pairs.
  - Never `high` at this size.
- Look at the runs where A failed and B passed. List the harness causes you can see (tool errors, edit misses, a stuck loop, stopping early, context loss). This list is often the most useful part for fixing Conclave.

## 14. Threats to validity

- **Small n.** 18 tasks and 1 or 2 repeats only show large gaps.
- **Run to run noise.** The same arm can pass and fail the same task. `--repeats 2` measures it.
- **Defaults differ.** Thinking, effort and tool sets are part of each harness. A gap may come from one default, not the whole harness. `--match-effort` tests that.
- **Transport.** B through its login and A through the proxy may differ in system prompt text or limits. The default `--b-transport proxy` removes most of this: both arms reach the same proxy and account through the tap. The proxy adds about 100 input tokens to every request, so the arm that makes more requests pays a little more of it.
- **Public tasks in training data.** These help both arms the same way.
- **Judge bias.** The judge sees diffs, and diffs can carry a harness's style. Blinding, order shuffles and `--judge-swap` reduce this. The hidden tests remain the primary metric.
- **Moving code.** Conclave may change during a set if `--conclave-src` is a live checkout. Claude Code may update. Both are recorded.
- **Hidden test leaks.** With bypass permissions, and as root on the server, an agent can read any file, including `bench/tasks/*/hidden/`. File permissions cannot stop that, so the kit keeps hidden material out of reach of normal moves (no other run in the work root, no bench path in env or argv, fresh homes) and detects the rest: the tap scans every request for bench paths the agent named or was shown, and for hidden test lines it was shown but never wrote. Flagged runs are listed and left out of the analysis. A Conclave agent that runs `ps` can see the hub's command line, which names the repo; B sees no such line. Both still need a path into `bench/` to reach anything, and that is flagged.
- **Time of day and load.** Arms alternate within each task, so slow periods hit both.
- **The RESULT line.** It changes the prompt a little, but the same way for both arms.

## 15. Build checklist

For whoever writes the runner and tasks:

- [x] `bench/bench.ts` with `doctor`, `build`, `check`, `validate`, `run`, `judge`, `report`, `all`.
- [x] Arm adapters for A, A2, B, C, D that return the normalized metrics in section 9. Unknown values are `null`.
- [x] Hub lifecycle on its own port and home. The owner's hub and homes are never touched.
- [x] Clean `HOME` and `CLAUDE_CONFIG_DIR` setup, with toolchain paths passed through.
- [x] Copy, diff, score and parse for the four test formats.
- [x] `bench/runners/unittest_json.py` (standard library only).
- [x] `bench/prices.json` with the source and date of each price.
- [x] Budget, cap, rate limit, SIGINT and `--resume` handling, with an fsync after each result line.
- [x] `ledgerkit` and `tasksd` fixtures, the 10 seeded tasks, the 8 vendored public tasks, `NOTICE` files and `third_party/EXERCISM-LICENSE.md`.
- [x] `bench validate` passes for all 18 tasks on the build machine.
- [x] A dry run (`--dry-run`) that prints the run list and the exact argv per arm without calling any model, then runs every step after the agent (diff, scoring, metrics, judge, summary) on a fake agent that applies the reference for some runs and the naive fix (or nothing) for others.
- [x] `bench parity` passes, and `bench parity --e2e` passes with the real Conclave hub and Claude Code against the fake model API (build machine, Claude Code 2.1.302).
- [ ] `bench parity --e2e` on the server before the first set.
- [ ] A smoke set run of A and B before the first full set.

## 16. Changes

Version 2, before any real set:

- Prompts of `pg-js-tic-tac-toe`, `pg-js-react` and `pg-rs-xorcism` got a "Notes for this task" section (5.3). Without it, 4 of the 27 tic-tac-toe tests needed error texts the agent could not know, react needed a `values` array the prompt never named, and xorcism called the `io` tests a bonus while scoring counted them.
- `feat-ts-money`: the prompt now says what `locale` does. A hidden test checks `de-DE` output, and the prompt only said it defaults to `en-US`.
- Alternative correct fixes in `hidden/alt/` for 7 seeded tasks, checked by `validate` (5.4).
- `validate` also runs the visible tests on the reference, and `--repeat <n>` catches flaky tests.
- `bench check` for static task checks (5.4).
- Finished work copies leave the work root after scoring (4.3).

Version 3, before any real set (fairness and isolation review):

- Fresh sandbox per run with only `repo/` and `home/`; pristine and scoring copies outside it; the sandbox is deleted after scoring (4.3). Before, every earlier run's finished repo, and the shared home with Claude Code transcripts in `~/.claude/projects`, sat where the next agent could list them. That let either arm read the other arm's work on the same task, and let arm A read arm B's full transcripts in its own `HOME`.
- Fresh `HOME` per run for both arms, a fresh `CLAUDE_CONFIG_DIR` for B and a fresh hub and `CONCLAVE_HOME` for A (4.2). Before, all runs shared one home inside `bench/.state`, which put a bench path in every agent's env and argv.
- Leftover processes inside the sandbox are killed before scoring (4.3). Both harnesses left a background `sleep` running in the e2e check, and A's shells survive the hub's process group.
- The tap (4.5): one parser for tokens and cost for both arms, the served model id from the API for both arms (Conclave's own records only echo the request), what each harness sent, and a symmetric leak scan.
- A's denied tools are taken out of the tool list (agent copies with `disallowedTools`), as `--disallowedTools` does for B (4.1). Before, A was offered WebFetch, WebSearch, Consult, Notify, ScheduleRoutine, the three memory tools and AskUserQuestion, and was only refused at call time. `AskUserQuestion` is denied in both arms.
- `--b-transport` defaults to `proxy` (3.2).
- Arm order rotates for an exact balance of who goes first (7 step 3).
- Build products leave the diff (8.1). The judge runs two passes by default (10).
- `leak_suspect` also covers what the agent was shown, and hidden test lines it did not write; a wide search alone is no longer a leak (9).
- A's grace after its own timeout is 15 s, not 60 s, and `limit_overrun_ms` shows work after the limit for both arms (7.1).
- Cache writes at the 1 hour TTL are priced at 2 times input (9). Claude Code and Conclave may ask for different TTLs.
- `bench parity` (fast) and `bench parity --e2e` (both real harnesses on a fake model) check all of the above.

Version 4, before any real set (runner and scoring review with fault injection, `bench/checks/faults.ts` and `bench/checks/summary.ts`):

- Links out of the repo are removed before scoring (8.2). A fake agent that made `tests/` a link sent the hidden tests to a folder outside the sandbox, deleted that folder's contents on the next run, and scored 0 of 24 where the tree earned 18.
- A hidden test file that did not run scores 0 (8.2). A `[[test]]` redirect in `Cargo.toml` with 14 empty tests passed `pg-rs-luhn-from` 14 of 14.
- Tool config in the repo is restored before scoring for every task (8.2). A `.cargo/config.toml` test runner that prints 14 `ok` lines passed a wrong `pg-rs-luhn-from` 14 of 14.
- Each home gets its own `CARGO_HOME` (4.2). Before, every agent and the scorer shared the real `~/.cargo`, so one agent could set a test runner in `~/.cargo/config.toml` for the scorer and all later runs.
- Leftover processes are also found by the run's `HOME`, not only the working folder. A child that did `cd /` survived every run and the runner's exit.
- A child that keeps the agent's stdout open no longer stalls the run forever; the pipes get 5 s after the agent exits.
- A second Ctrl-C used to leave the agent running in its own session; kill -9 of the runner left it running with no time limit. Both now end it (11).
- `--resume` used to leave a dead runner's sandbox beside the next one, where the next agent could read it (11).
- The report kept a rate limited attempt 2 over the valid attempt 1 that `--resume` wrote, so the run never counted (13).
- The verdict said "No clear difference ... of 0 tasks" for an empty or all-invalid set, called ratios from one task, and did not say which tasks were left out (13).
- `RESULT: **DONE**` and other markdown around the RESULT line now count as the claim.
- Claude Code's `usage limit reached|<epoch>` reset time is read.
- One arm that keeps ending invalid stops the set (11).
- Ctrl-C during a wait for a rate limit reset (up to `--max-wait`, 45 min) or before a retry did nothing until the wait ended, then started one more agent run. It now stops at once.
- A cut-off last line in `results.jsonl` (runner killed mid-write) is skipped instead of breaking `--resume` and the report, and the next line is written on a new line.
- The judge rejects a reply that scores one candidate twice, which left the other run unscored.
- Bun output is parsed from its last summary block; the code under test can print look-alike lines first.

Version 5, after run 4 (2026-10-20):

- `own_tests` (9): whether the agent's own tests fail on the start code and pass on the final code. Run 4 found A's stash check in 1 of 36 runs; this measures what that check is for, whatever way the agent took, the same way for every arm.
- `regression_gate` (9): Conclave's regression gate (`packages/core/src/session/regression-gate.ts`) runs a turn's changed tests on the code from before the turn when the agent stops, and reminds it once when they pass there. The count lets a later set compare runs with the gate against run 4.
