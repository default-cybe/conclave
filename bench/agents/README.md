# Agent prompt trials

Cheap real-model trials for the built-in agent prompts, mainly the specialists from docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md section 4. Each trial runs one agent prompt on one small scenario with the official Claude Code CLI, using the system prompt Conclave itself would send. The result is judged against the agent's output contract and the scenario's rubric.

This is not the harness benchmark in `bench/` (Conclave against Claude Code on coding tasks). It tests prompts, not harnesses.

## Files

| File | What it does |
| --- | --- |
| `compose.ts` | Prints the system prompt for a built-in agent: BASE.md, the environment block, the mode note (the workflow step note for `workflow`), the role and a two-line owner profile. It imports the shipped files, so it always matches the code. |
| `trial.sh` | Runs one trial: copies the fixture to a temp folder, runs `setup.sh`, composes the prompt, runs the CLI with the scenario's tools and allowlist, writes `transcript.jsonl` and `summary.json`, then runs `post.sh`. |
| `summarize.ts` | Final text, tool calls, permission denials, turns and cost from a stream-json transcript. |
| `scenarios/<agent>/<id>/` | One scenario. |

A scenario folder holds:

- `scenario.env`: `AGENT`, `TOOLS` (CLI tool names), `ALLOWED` (the `--allowedTools` list), `MAXT`, `BUDGET` (USD cap per run), `GIT`.
- `task.txt`: the brief, sent on stdin.
- `rubric.md`: what is true in the fixture and the binary must-pass checks.
- `fixture/` (optional): copied into the work folder.
- `setup.sh` (optional): runs with the work folder and the scenario folder, for example to commit the fixture and put a change on top.
- `post.sh` (optional): checks the folder after the run (git status, a marker file, a grep).

## Running

```bash
CLAUDE_BIN=/path/to/isolated-claude AGENT_BENCH_OUT=/tmp/agent-bench bash bench/agents/trial.sh bench/agents/scenarios/verifier/v1-rmrf-true 1
```

`CLAUDE_BIN` defaults to `claude`. Point it at a wrapper that runs the CLI with its own HOME and without the parent session's environment, so a trial cannot see or change your own Claude Code setup. Results go to `$AGENT_BENCH_OUT/<agent>/<scenario>/r<n>/` (default `/tmp/conclave-agent-bench`). Each run costs about $0.01 to $0.10 on Sonnet; `BUDGET` caps it.

Several at once: `xargs -P 4 -L1 bash bench/agents/trial.sh < list.txt`, with one `scenario-dir run-index` per line.

## What the trials do not cover

- Conclave's own tools: the CLI has no LS, RepoMap, ReadToolOutput, StructuredOutput from Conclave, or browser tools, and Task runs Claude Code's agents. Hooks and recipes do not run either, so write-scope and the verify gate are tested in `packages/core/test` instead.
- Other model families. GLM, GPT and Gemini runs need Conclave itself (`conclave run --agent`), not this runner.
- Judging is by hand against the rubric. `bench/lib/judge.ts` can be pointed at the transcripts for blind A/B judging.

## Round 5 results

21 trials, $0.855 in total (from the CLI's `total_cost_usd`). Per-agent results are in docs/agents/<agent>.md; the summary is in docs/agents/README.md.
