# Conclave vs Claude Code benchmark

This kit answers one question: does Conclave's own harness get as much out of a Claude model as Claude Code does, when both use the same model?

It runs both tools on the same 18 small coding tasks, with the same prompt, model, time limit and permissions. Hidden tests score the work after the agent finishes. A blind judge rates the diffs. The kit writes one line per run to `results.jsonl` and a report to `summary.md`.

The full rules are in [PROTOCOL.md](PROTOCOL.md). Read it before you change anything.

## What it measures

Per run:

- **Correctness**: did all hidden tests pass, and what share of them passed.
- **Honesty**: did the agent say `RESULT: DONE` while the tests fail (a false success claim).
- **Quality**: blind judge scores (1 to 5) for correctness beyond the tests, minimal change, readability, plus a yes or no for test tampering.
- **Cost**: input, output, cache read and cache write tokens, cost as each tool reports it, and cost at list price with one formula for both.
- **Speed**: wall time.
- **Behavior**: turns, tool calls by tool, failed tool calls, edit misses, reverted edits, files touched, diff size.
- **Own tests**: whether the agent's own tests fail on the start code and pass on its final code, and for Conclave what its regression gate did (PROTOCOL.md section 9).

## Arms

| Arm | What | Default |
|---|---|---|
| A | Conclave `run --agent coder`, Claude through CLIProxyAPI (anthropic provider type) | on |
| B | Claude Code `claude -p`, same model id, its own login or CLIProxyAPI | on |
| A2 | Conclave through the OpenAI compatible `cliproxy` provider | off |
| A+skills | arm A with catalog items installed into its hub through Conclave's own catalog API, from their pinned commits (`--skills`, default `plugin:ponytail,plugin:caveman`). Needs node and GitHub access on the bench machine. The summary says how many tokens the items add to the first request | off |
| C | Conclave driving Claude Code over ACP | off |
| D | Codex (different model, reference only) | off |

Only A and B enter the verdict.

## Tasks

18 tasks, each a small repo with a prompt, hidden tests, a time limit and a difficulty tag.

- 8 Exercism exercises from the Aider polyglot benchmark: 2 each in Python, JavaScript, Go and Rust.
- 6 seeded bug fixes in two small codebases written for this kit (`ledgerkit` in TypeScript, `tasksd` in Python). Each bug report points at the wrong file on purpose.
- 4 feature tasks in the same codebases: two flags, an endpoint and a refactor.

Mix: 4 easy, 8 medium, 6 hard. Nothing needs Docker, the network or a package install. The list is in PROTOCOL.md section 5.3.

## Requirements

On the machine that runs the benchmark:

- Bun, Python 3, Go and Rust (cargo). A missing toolchain skips its tasks for every arm.
- This repo, for Conclave itself.
- Claude Code (`claude`) on the PATH.
- CLIProxyAPI with your Claude subscription. Put its address in `CLIPROXY_BASE_URL` (default `http://127.0.0.1:8317`) and its key in `CLIPROXY_API_KEY`. `BENCH_MODEL` can hold the model id instead of `--model`.
- About 2 GB free disk under `/tmp` for work copies and Rust builds.

The benchmark does not need internet access beyond the model API.

## It does not touch your other work

- For each Conclave run it starts a fresh hub on port 7799 with a fresh home, and stops it after the run. Your hub on 7717 and `~/.conclave` stay as they are.
- Every run, in both arms, gets a fresh `HOME` next to its repo, so your memory, `CLAUDE.md`, skills, plugins, hooks and MCP servers do not reach the runs, and no run sees an earlier run's transcripts, sessions or settings. Toolchain paths are passed through.
- Agents work in throwaway sandboxes under `/tmp/conclave-bench/<set>/<run_id>/` that hold only `repo/` and `home/`. They run with all permissions inside them.
- After the agent exits, the runner kills anything it left running in the sandbox, scores the run, keeps the final repo in `runs/<run_id>/final/` and deletes the sandbox. So the next agent cannot find the other arm's finished work, or its transcripts, next to its own folder.
- Both arms send every model call through a small local tap on port 7798, which forwards to CLIProxyAPI unchanged. It counts tokens for both arms the same way and records what each harness sent (see PROTOCOL.md 4.5).
- The runner only reads `packages/`. If another workflow is editing it, pass `--conclave-src <dir>` with a `git worktree` at a fixed commit. Otherwise the manifest records the commit and a dirty flag.

## Run it

All commands start from the repo root.

1. Check the machine and pick a model id the proxy lists:

   ```
   export CLIPROXY_API_KEY=...
   bun bench/bench.ts doctor --model claude-sonnet-5-5
   ```

   `doctor` checks toolchains, Claude Code flags, the proxy, the served model id for both arms, free ports and a clean work root. It also picks the transport for arm B (see below).

2. Check that both arms get the same deal (once per machine, and after any change to the runner, Conclave or Claude Code):

   ```
   bun bench/bench.ts parity --e2e
   ```

   This runs the real Conclave hub and the real Claude Code against a fake model API, through the tap, and checks what each one sent and what each agent could see: the same prompt byte for byte, no denied tool in either tool list, a fresh home per run, nothing of another run in the parent folders, no bench path in env or argv, leftover processes killed, and tap token counts equal to each tool's own. It needs no proxy and no model. Without `--e2e` it runs the fast checks only (a few seconds).

3. Check the tasks (once per machine, and after any change to a task):

   ```
   bun bench/bench.ts check
   bun bench/bench.ts validate --repeat 3
   ```

   `check` reads the task files: prompts must state what the hidden tests need, bug reports must not name the cause, and `task.json` must match the catalog. `validate` runs the tests: the hidden tests fail on the start code, pass with the reference and with each alternative fix in `hidden/alt/`, the naive fix fails, and the visible tests pass with the reference. `--repeat 3` scores every tree three times and reports any flaky result.

4. Check the whole pipeline without calling any model:

   ```
   bun bench/run.ts --dry-run
   ```

   This prints the plan and the exact argv per arm, then runs a fake agent in place of each arm. The fake agent applies the reference solution for some runs and the naive fix (or nothing) for others, and prints the same stream format as the real tool. Diff, hidden tests, metrics, the judge (a fake one) and `summary.md` all run for real. Each task gets one good and one bad run, so the summary shows every hidden test passing with the reference and failing without it.

   Then check how the runner copes with agents that go wrong, and the summary math (after any change to the runner):

   ```
   bun bench/checks/faults.ts       # --quick: Python and Bun tasks only
   bun bench/checks/summary.ts
   ```

   `faults.ts` runs dry-run sets where the fake agent hangs, ignores signals, leaves background processes, crashes, tampers with the hidden test paths, links folders out of the repo, deletes the repo, loops, burns tokens or hits a rate limit, plus budget stops, Ctrl-C, kill -9 of the runner and `--resume` after each. It takes about two minutes. `summary.ts` checks the statistics and the verdict rules on made up results in a second. Neither calls a model.

5. Smoke test on 2 easy tasks:

   ```
   bun bench/bench.ts run --model claude-sonnet-5-5 --tasks smoke --set smoke
   ```

   Open `bench/results/smoke/summary.md` and look at the two run folders. Fix anything odd before the full set.

6. Full set, then judge and report:

   ```
   bun bench/run.ts --model claude-sonnet-5-5
   ```

   `bench/run.ts` is the one entry point: it is `bench.ts all`, which runs doctor, validate, the runs, the judge and the report in order. `bench.ts run` skips the judge; `bench.ts judge --set <name>` and `bench.ts report --set <name>` run the last two steps on their own.

### Useful flags

| flag | default | what it does |
|---|---|---|
| `--arms A,B` | `A,B` | arms to run, for example `A,B,A2,C` |
| `--tasks <ids or smoke>` | all 18 | task ids, comma separated |
| `--repeats 2` | 1 | runs per task per arm. Use 2 if the budget allows. |
| `--seed <n>` | 1 | task order and arm order within each task |
| `--b-transport proxy\|login\|auto` | proxy | how Claude Code reaches the model; `proxy` puts both arms on the same path and through the tap |
| `--budget-tokens <n>` | 150000000 | stop before going over, all token types summed |
| `--budget-usd <x>` | none | stop before going over, list price |
| `--budget-wall <t>` | 12h | stop before going over |
| `--budget-minutes <n>` | | the same as `--budget-wall`, in minutes |
| `--out <dir>` | `bench/results` | where sets are written |
| `--small-model <id>` | `claude-haiku-4-5-20251001` | model for side calls (titles, summaries) in both arms |
| `--no-judge` | off | skip the judge |
| `--skip-validate` | off | reuse the last `validate` results |
| `--dry-run` | off | fake agent and fake judge, no model calls |
| `--run-token-cap <n>` | 8000000 | stop a single runaway run |
| `--max-wait <t>` | 45m | longest wait for a rate limit reset before a clean stop |
| `--match-effort <level>` | off | same thinking effort in both arms, as a separate set |
| `--conclave-src <dir>` | repo root | Conclave checkout to test |
| `--hub-port <n>` | 7799 | port of the bench hub (one fresh hub per Conclave run) |
| `--tap-port <n>` | hub port - 1 | port of the tap; 0 turns it off (token counts then come from each tool) |
| `--judge-model <id>` | same as `--model` | model for the blind judge. Judging a judged set again with another model adds that judge's results next to the first |
| `--judge-provider anthropic\|openai` | from the model id | `openai` sends the judge to `/v1/chat/completions` on the same proxy; `gpt-*` and `o*` ids pick it on their own |
| `--judge-effort <level>` | `high` for a GPT judge | `low`, `medium`, `high`, `xhigh` or `max` (`reasoning_effort`, or `output_config.effort` for a Claude judge) |
| `--no-judge-swap` | off | one judge pass only; by default the judge runs twice, the second time with the candidates in reverse order |
| `--resume --set <name>` | | continue a stopped set |

### Arm B transport

Arm B must run the exact same model id as arm A.

- `proxy` (default): Claude Code goes through the tap and CLIProxyAPI with `ANTHROPIC_BASE_URL`. A and B then share the same path to the model, and the tap counts both.
- `login`: Claude Code uses your subscription directly. Set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or log in once with `CLAUDE_CONFIG_DIR=bench/.state/claude-login claude`; each run copies only the credentials file. The tap then sees only arm A, and the summary says token counts come from two sources.
- `auto` tries `login` and falls back to `proxy` if the served model id does not match.

Every result line records the transport used.

### Stops and resume

The runner stops cleanly when a budget would be exceeded, when a rate limit lasts longer than `--max-wait`, or on Ctrl-C. Finished runs stay in `results.jsonl` and `summary.md` covers them. Continue later with:

```
bun bench/run.ts --resume --set <name>
```

Runs that hit a rate limit are not scored. They are rerun from a fresh copy after the reset.

- Ctrl-C once stops the current run (stored as `interrupted`), or a wait for a rate limit reset, and writes the summary. Ctrl-C twice exits at once; it kills the running agent and anything it left running first.
- If the runner itself dies (kill -9, out of memory), a watchdog ends the agent and the bench hub within about a second. `--resume` deletes the sandbox the dead run left behind.
- If one arm ends 3 runs in a row invalid (agent not found, hub does not start, no model calls, wrong model), the set stops with exit 3. Fix the cause, then resume.
- A runner error (a bug, a full disk) stops the set with exit 1 after writing the summary.
- `summary.md` says at the top of the verdict when the set is not finished, which tasks are left out and why, and how many runs of each arm are invalid. Invalid runs are not counted as failures, so read that line first.

## Output

```
bench/results/<set>/
  manifest.json     versions, exact commands per arm, transport, seed, skipped tasks, arm order counts
  results.jsonl     one line per run
  judge-<model>.jsonl  one line per judged run, one file per judge model (older sets: judge.jsonl)
  summary.md        the report, with an "Isolation and parity" section
  tap-all.jsonl     every model call of the set, as the tap saw it
  runs/<run_id>/    events, stdout, stderr, final reply, diff, test output, tap.jsonl, final/ (the final repo)
```

The default set name is `<date>-<model>-<short commit>`.

## How to read the results

Start with the verdict at the top of `summary.md`, then check it against the tables.

- **Pass rate is the main number.** The paired table shows tasks only A passed and tasks only B passed. Those discordant tasks decide the result, not the totals.
- **n is small.** With 18 tasks, a winner needs roughly a 5 to 0 or 7 to 1 split of discordant tasks. A gap of 1 or 2 tasks is noise. The verdict says "no clear difference" in that case, and so should you.
- **Repeats show the noise.** With `--repeats 2` the summary reports how often the same arm passes once and fails once on the same task. If that share is high, trust single gaps even less.
- **False success claims matter.** An agent that says DONE on failing work costs you more than one that says NOT DONE.
- **Cost and time are ratios.** The summary gives A divided by B, over tasks where both runs are valid, with an interval. A ratio of 1.3 with an interval of 0.9 to 1.8 does not show a difference.
- **Judge scores are secondary.** The judge is blind and the order is shuffled, but it is still a model reading diffs. Treat gaps under 0.5 points as ties.
- **Read the failures.** The section on tasks where A failed and B passed lists harness causes: tool errors, edit misses, stuck loops, early stops. This is where fixes for Conclave come from.
- **Check the setup block.** If the thinking defaults, the transport or the Conclave commit differ from what you expected, the comparison may not be the one you wanted.
- **Check "Isolation and parity".** It shows what each harness actually sent the model. On the build machine Conclave sent no effort and `max_tokens` 32000, and Claude Code sent `effort: medium` and `max_tokens` 128000. A gap can come from those defaults alone, so also run a `--match-effort` set. Any denied tool still offered, bench path in env or argv, sandbox neighbour or leak suspect there means the set is not clean.

## Files in this folder

```
bench/
  README.md        this file
  PROTOCOL.md      the rules
  run.ts           the one entry point (bench.ts all)
  bench.ts         runner (doctor, build, check, parity, validate, run, judge, report, all)
  lib/             runner code: arms, hub, tap, leaks, scoring, metrics, judge, report, the fake agent
  checks/          parity checks and the fake model API they use, fault injection (faults.ts), summary math (summary.ts)
  tsconfig.json    type check: bunx tsc -p bench
  prices.json      list prices used for cost_list_usd, with date and source
  runners/         test output helpers (unittest_json.py)
  fixtures/        ledgerkit and tasksd base codebases
  tasks/<id>/      task.json, prompt.md, repo/, hidden/ (tests, reference/, naive/, alt/), overlay/ for bug tasks, NOTICE for public tasks
  third_party/     license texts
  .state/          runner state: scorer home, private pristine and scoring copies, validate scratch (not in git, never shown to an agent)
  results/         benchmark sets (not in git)
```

## Credits

The 8 public tasks come from the [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark), which collects exercises from the [Exercism](https://exercism.org) language tracks. Exercise content is copyright Exercism and used under the MIT license. Each public task folder has a `NOTICE` with its source, and `third_party/EXERCISM-LICENSE.md` holds the license text.
