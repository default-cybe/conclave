# What the benchmark records

The owner asked to note everything. Every run writes one line to results.jsonl with all fields below, and keeps the raw files next to it. Nothing is dropped; a field the tool cannot report is written as null with a reason.

## Per run

**Identity**
- run id, task id, arm (conclave, claude-code, and any extra arm), repeat number, start and end time (UTC)
- model id sent, model id the proxy or tool reported back, proxy account (unprefixed or neu/)
- tool versions: Conclave commit, Claude Code version, bun, node, python, go, rust

**Time**
- wall time from start to agent exit
- API time (time spent waiting on the model), and the rest (tool time and overhead)
- time to first token of the first request
- time per turn (list) and the slowest turn
- time spent waiting on rate limits or retries
- hidden test run time (scored separately, not part of agent time)

**Tokens**
- input, output, cache write and cache read tokens, totals and per request (list), split by model; thinking tokens are billed as output on Claude models, so they are counted inside output for both arms
- number of model requests
- fixed overhead: tokens of the first request (system prompt and tool definitions)
- tokens per turn, and tokens per passed task (in the summary)

**Cost**
- cost computed from tokens with one price table for both arms (input, output, cache write, cache read)
- each tool's own cost figure as a side column only

**Tool use**
- tool calls by tool name (Read, Edit, Write, Bash, Grep, Glob, and so on)
- failed tool calls and their error text
- permission denials and blocked commands
- shell commands run (list), and whether the agent ran tests on its own
- files read, files changed, files created, files deleted

**Result**
- hidden tests: passed, failed, total, and the names of failing tests
- pass (all hidden tests pass), partial pass ratio
- git diff: files changed, lines added, lines removed, the full patch saved
- edits that were later reverted by the agent (a `git stash` that is popped or applied later is not one)
- whether the agent checked its test without the fix (`git stash`, a test run, `git stash pop`) and saw it fail
- whether the agent's own tests fail on the start code (`own_tests`): its changed test files under the task's `protected` globs go over the pristine start tree and the task's visible test command runs there, then on the final tree. `fails_on_start` and `passes_on_final` are true, false, or null when the run said nothing (a timeout, a test that did not load, no test ran; the same rules as Conclave's regression gate, `packages/core/src/util/test-run.ts`). Null for tasks without visible tests and for runs that changed no test file
- for Conclave arms, what its regression gate did (`regression_gate`): how often it ran the turn's changed tests on the code from before the turn and found them failing (proven), passing (passes, and how many reminders went out), saying nothing (not_run), or did not run them (skipped). Counted from the `regression.checked` events, else the session's `regression.gate` audit rows
- existing test files with lines removed or changed, deleted, or with a new skip (flagged), and existing test files the agent only added tests to (not flagged)
- agent files at a hidden test's path, kept in `.bench-moved/` instead of being overwritten
- agent exit status, error, stop reason, number of turns
- the agent's final message, and whether it claimed success
- false success claim (claimed success while hidden tests fail)

**Quality (blind judge)**
- judge model and prompt version
- scores from 1 to 5: correctness beyond the tests, minimal change, readability and fit with the code style
- test tampering: yes or no (stored as a boolean)
- judge notes (two or three sentences)
- the judge never sees the arm name, and runs see each other in a random order

**Resources**
- peak memory and CPU time of the agent process

## Raw files kept per run
- the prompt sent, the full transcript or JSON stream, the final diff, hidden test output, the judge's input and output, stderr

## Summary (summary.md and summary.json)
- per arm: pass rate with a 95 percent interval, partial pass mean, median and p90 wall time, mean tokens by kind, mean computed cost, tool calls per task, failed tool call rate, false success claims, judge score means
- per arm: runs with own tests, of those how many fail on the start code and pass on the final code; runs where the regression gate looked, proved, saw a pass, reminded, said nothing or skipped (Conclave arms; n/a for the others)
- efficiency: tokens, time and cost per passed task
- per task: both arms side by side (pass, time, tokens, cost, judge score)
- head to head: tasks only one arm passed, ties, both failed
- notes on noise: run count, the server's other load, and the proxy's added tokens
