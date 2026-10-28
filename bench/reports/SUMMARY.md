# Bench results: summary

Every number here is copied from the linked report. Newest first. All runs used `claude-sonnet-5-5`. "List cost" is tokens priced at Anthropic's list price; on the gateway and proxy routes the runs billed the owner's subscription, so list cost is accounting only. Arm A is Conclave's coder agent; arm B is Claude Code 2.1.302 in `-p` mode.

## Skill-dependent tasks: does the skill-list cap hurt work that needs a skill? (2026-10-28)

[2026-10-28-skill-tasks.md](2026-10-28-skill-tasks.md). Arm A only. FULL = 60129a0d (v0.4.42, no cap) with the hub's skills seeded; CAPPED = f73a910a (v0.4.43, with the cap) with the same seed; NONE = f73a910a with no skills. 4 tasks x 3 repeats per arm.

| | FULL | CAPPED | NONE |
|---|---|---|---|
| hidden pass, all 4 tasks | 10/12 | 12/12 | 6/12 |
| hidden pass, the 2 API tasks (skill-api-haiku, skill-api-sonnet-tools) | 5/6 | 6/6 | 0/6 |
| hidden pass, docx and pptx tasks | 5/6 | 6/6 | 6/6 |
| needed skill loaded | 12/12 | 12/12 | n/a |
| mean first request tokens | 71,740 | 29,723 | 15,353 |
| mean tokens per run | 915,122 | 449,788 | 210,626 |
| mean turns | 10.4 | 9.9 | 7.8 |
| recorded list price | $5.37 | $2.97 | $1.60 |

The report's verdict: the cap does not hurt these tasks ("no harm", not "the cap helps"; CAPPED's lead of 2 is within noise at n=3). Only the two API tasks need the skill; NONE passed docx and pptx 6/6, so those two tasks were dropped and are not in the repo.

## Skill-list cap on the hub's real 440 skills (2026-10-27)

[2026-10-27-skill-budget.md](2026-10-27-skill-budget.md). Arm A only, baseline 60129a0d (v0.4.42) vs candidate 901da2e6 (the cap, PR #136, shipped in v0.4.43). 6 bug tasks x 2 repeats. Both arms seeded with the same 440 skills.

| | baseline 60129a0d | candidate 901da2e6 | change |
|---|---|---|---|
| skills section of a coder session (chars/4 estimate) | 144,778 chars, ~36,195 tokens | ~22,000-22,550 chars, ~5,490-5,640 tokens | |
| hidden tests pass | 11/12 | 12/12 | 1 improved, 0 regressed |
| first request tokens (median) | 71,957 | 29,847 | -58% |
| tokens per run (median) | 650,448 | 292,331 | -55% |
| tokens total (12 runs) | 7,999,145 | 3,521,083 | -56% |
| list cost | $4.03 | $1.98 | |
| regression gate proven | 10/12 | 10/12 | |

## Tool diet: coder without calendar, mail and maps tools (2026-10-27)

[2026-10-27-tool-diet.md](2026-10-27-tool-diet.md). Arm A only, baseline e5e539ac vs candidate d8429b69 (PR #133, shipped in v0.4.42). 6 bug tasks x 2 repeats.

| | baseline e5e539ac | candidate d8429b69 |
|---|---|---|
| hidden-test pass | 12/12 | 12/12 |
| tools offered | 24 | 16 |
| system prompt chars (median) | 13,256 | 12,322 |
| first request tokens (median) | 19,037 | 15,148 (-20%) |
| tokens median per run | 121,837 | 124,718 |
| tokens total | 1,714,087 | 1,481,884 (-13.5%) |
| regression gate proven | 10/12 | 10/12 |

The per-run median is flat: two repeats are too few to separate it from turn-count noise.

## Harness²: before and after (2026-10-27)

[2026-10-27-h2-bugs.md](2026-10-27-h2-bugs.md). Arm A only, baseline ff62ecca (the run-4 harness) vs candidate e5e539ac (Harness²). 6 bug tasks x 2 repeats.

| | baseline ff62ecca | candidate e5e539ac |
|---|---|---|
| hidden-test pass | 12/12 | 12/12 |
| regression gate proven | 0/12 | 10/12 |
| own tests: added / fail on start / visible pass final | 12 / 10 / 12 | 12 / 10 / 12 |
| tokens median / total | 104,076 / 1,403,842 | 150,472 / 1,871,078 |
| first request tokens (median) | 12,027 | 19,048 |
| system prompt chars (median) | 9,497.5 | 13,255.5 |
| list cost total | $0.994 | $1.07 |

- The regression gate is a structural change: the candidate runs it, the baseline has none.
- Pass rate cannot separate the two: both hit 12/12.
- Tokens: the candidate was higher on 6 of 6 task means; PR #133 puts it at about 45% more tokens per run. The report gives the cause: about 7k extra tokens per request from the larger system prompt and 11 added non-coding tools, repeated in cache reads every turn. The tool diet above was the fix.

## Conclave vs Claude Code, runs 1 to 4 (2026-10-17 to 2026-10-20)

Same 18 tasks, same model in both arms, same route for both arms in each run, hidden tests scored by the kit. Reports: [run 1](2026-10-17-run1.md), [run 2](2026-10-18-run2.md), [run 3](2026-10-18-run3.md), [run 4](2026-10-20-run4.md). Ratios are A divided by B, geometric mean over tasks; below 1 means Conclave used less.

| | run 1, defaults | run 1, effort matched | run 2 | run 3 | run 4 |
|---|---|---|---|---|---|
| Conclave commit | 5677fc5 | 5677fc5 | af754ec | b16ee74 | ff62ecc |
| route | CLIProxyAPI, main account | CLIProxyAPI, main account | CLIProxyAPI, main account | CLIProxyAPI, second account | Anthropic API, owner's key |
| runs per arm | 18 | 18 | 18 | 36 | 36 |
| A passed / B passed | 18 / 18 | 17 / 18 | 18 / 18 | 35 of 35 / 35 of 36 | 36 / 36 |
| A/B list cost (90% interval) | 1.64 (1.38 to 1.94) | 1.30 (1.14 to 1.49) | 1.04 (0.91 to 1.17) | 1.18 (1.03 to 1.35) | 0.89 (0.81 to 0.98) |
| A/B tokens (90% interval) | 1.15 (0.93 to 1.42) | 0.95 (0.84 to 1.09) | 0.75 (0.64 to 0.89) | 0.98 (0.82 to 1.19) | 0.74 (0.65 to 0.84) |
| A/B wall time | 1.66 | 1.29 | 1.26 | 1.37 | 0.99 |
| A first request tokens (median) | 12,391 | 12,409 | 10,995 | 13,105 | 11,844 |
| B first request tokens (median) | 19,990 | 20,006 | 19,985 | 20,327 | 19,981 |

Judge preference, tasks (runs 1 and 2) or task groups (runs 3 and 4) where the judge preferred each arm. A+skills is Conclave with ponytail and caveman (runs 2, 3) or ponytail only (run 4); it was not a Claude Code arm.

| run | Claude judge (prompt v3) | GPT judge, gpt-6.1-sol (prompt v3) |
|---|---|---|
| run 1, defaults | A 9, B 3, tie 6 | A 13, B 3, tie 2 |
| run 1, effort matched | A 10, B 2, tie 6 | A 11, B 2, tie 5 |
| run 2 | A 10, A+skills 3, B 1, tie 4 | A 6, A+skills 3, B 5, tie 4 |
| run 3 | A 11, A+skills 6, B 4, tie 15 | A 21, A+skills 6, B 3, tie 6 |
| run 4 | A 12, A+skills 4, B 3, tie 17 | A 14, A+skills 2, B 9, tie 11 |

Run 3's report gives the judges' main reason: A adds a regression test almost every time; B often adds none (GPT notes: no regression test for B in 9 of 36 runs, never for A). In run 4 those notes say A left one out in 2 runs and B in 9.

## What this does not show

- **One model.** Every agent run used claude-sonnet-5-5. No other model was tested.
- **Small repeat counts.** 1 run per task (runs 1, 2), 2 (runs 3, 4 and the 2026-10-27 harness runs), 3 (skill tasks). The reports call several gaps noise at these counts, including CAPPED's 12/12 against FULL's 10/12.
- **Conclave vs Claude Code was last measured in run 4 (2026-10-20).** Harness², the tool diet and the skill cap were measured against older Conclave only, not against Claude Code.
- **Routes differ between runs.** Run 3 used a second account that adds about 335 input tokens per request; run 4 used the Anthropic API. Compare ratios across runs, not totals.
- **One judge shares the agents' model family.** The Claude judge is claude-sonnet-5-5, the same model as both arms. The GPT judge was added for that reason; the two judges picked opposite arms in 3 of 36 groups in run 3 and 3 of 36 in run 4.
- **Easy bug tasks tie.** On the 6 bug tasks both harness arms hit 12/12 in the Harness² and tool-diet runs, so pass rate cannot separate them; those runs show cost and the regression gate only.
- **Fake API servers.** The two API skill tasks score against local fake servers built from the skill's migration guide, not the real API. They measure "follows the skill".
- **docx and pptx tasks dropped.** An arm with no skills passed them 6/6, so they did not depend on the skill. The skill-task results that hold are the two API tasks, with 6 runs per arm.
- **Often-used skills are not tested.** `conclave-batch-merge-release` (22 loads) and `conclave-recovery-release-preflight` (8 loads) need GitHub and a live hub, and style or process skills have no outcome an offline check can score, so no task covers them ([TASKS-SKILLS.md](../tasks/TASKS-SKILLS.md)).
- **Cost figures leave out doctor preflight requests**, and list cost on the gateway and proxy routes was not money spent.
