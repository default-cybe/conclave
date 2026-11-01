# Skill tasks: does the skill-list cap (PR #136) hurt work that needs a skill?

> **What was compared:** three Conclave arms on tasks that need a skill: FULL (60129a0d, v0.4.42, before the cap, skills seeded), CAPPED (f73a910a, v0.4.43, with the cap, same skills seeded) and NONE (f73a910a, no skills). Arm A (Conclave) only.
> **Model:** claude-sonnet-5-5. **Tasks:** skill-api-haiku, skill-api-sonnet-tools, skill-docx-redline, skill-pptx-team. **Repeats:** 3, seed 1, 12 runs per arm. No judge.
> **Route:** hub gateway to CLIProxyAPI on the owner's subscription, so list cost is accounting only, not money spent.
> **Raw results:** were in `cv-skill-budget/bench/results/skb3-fullcap-baseline`, `skb3-fullcap-candidate` and `skb3-none` in a temporary worktree on the hub. They are not kept in git.
> **Kept in the repo:** only the two API tasks (`bench/tasks/skill-api-haiku`, `bench/tasks/skill-api-sonnet-tools`). The docx and pptx tasks were dropped because NONE passed them 6/6 without the skill; see [bench/tasks/TASKS-SKILLS.md](../tasks/TASKS-SKILLS.md).
> **Caveats stated below:** n=3 per cell, one model, one seed; the API tasks score against fake servers built from the skill text; CAPPED was not re-run next to NONE; cost figures exclude doctor preflight requests.

Date: 2026-10-28. Model: claude-sonnet-5-5 through the hub gateway (cliproxy). Arm A (Conclave `run --agent coder`) only. 4 tasks x 3 repeats per arm, bench seed 1, no judge.

## Setup

| Arm | Harness | Skills seeded |
|---|---|---|
| FULL | detached worktree of `60129a0d` (0.4.42, before the cap) | `BENCH_SEED_HOME=/tmp/conclave-bench/seed-skills-3` |
| CAPPED | detached worktree of `origin/main` = `f73a910a` (0.4.43, includes #136 `ab2f4db1`) | same seed |
| NONE | same `origin/main` worktree | none (BENCH_SEED_HOME unset) |

- The seed was one fresh copy of `/var/lib/conclave/plugins` and `/var/lib/conclave/skills` without `.git` (551 MB, 30 plugins, 18 hub skills). Both seeded arms used that same copy, file md5 checksum `310e0eb12bc175f735a5e4e1b822c032`.
- FULL vs CAPPED ran through `bench/improve.ts` (set `skb3-fullcap`: FULL is the baseline, CAPPED the candidate). `--budget-usd 15`.
- improve.ts uses one `BENCH_SEED_HOME` for both of its sets, so it cannot compare seeded with unseeded. NONE therefore ran as `bench run --arms A --tasks skills --repeats 3` (set `skb3-none`, same seed and options). Its comparison is against the CAPPED-seeded set from the first run; CAPPED was not run a second time.
- Recorded list price (the gateway itself is free): FULL $5.37, CAPPED $2.97, NONE $1.60.
- Results: were in `cv-skill-budget/bench/results/skb3-fullcap-baseline`, `skb3-fullcap-candidate`, `skb3-none` on the hub; not kept in git.

## Tasks (after the audit fixes)

| Task | Needs | Validate (x3) |
|---|---|---|
| skill-api-haiku | claude-api | untouched 1/5, reference 5/5, naive 2/5. Alternatives `thinking-off` and `enum-tool` (new) both pass. |
| skill-api-sonnet-tools | claude-api | untouched 1/7, reference 7/7, naive 2/7. Alternative `structured-output` passes. The retry is now required: a probe with no retry fails 6/7. |
| skill-docx-redline | docx | untouched 4/6, reference 6/6, naive 5/6 |
| skill-pptx-team | pptx | untouched 3/6, reference 6/6, naive 4/6. Probe: keeping the template positions with group 4 removed passes. Probe: an ElementTree round-trip fails the prefix test. |

`skill-verify-csv` was dropped, as the audit advised.

## Per run

"Needed" means the agent called Skill with the skill the task needs, and the call returned the skill body. "Other" means any other Skill call. "First" is the tokens of the first main request. "Tokens" is the run total, cache included. "Turns" is main turns (no subagents ran).

| Arm | Task | Rep | Hidden | Needed | Other | First | Tokens | Turns |
|---|---|---|---|---|---|---|---|---|
| FULL | haiku | 1 | PASS 5/5 | yes | none | 71,758 | 571,200 | 7 |
| FULL | haiku | 2 | PASS 5/5 | yes | none | 71,799 | 963,883 | 11 |
| FULL | haiku | 3 | PASS 5/5 | yes | none | 71,765 | 970,158 | 11 |
| FULL | sonnet-tools | 1 | PASS 7/7 | yes | none | 71,901 | 948,753 | 10 |
| FULL | sonnet-tools | 2 | fail 6/7 (fields for north) | yes | none | 71,927 | 784,717 | 9 |
| FULL | sonnet-tools | 3 | PASS 7/7 | yes | none | 71,887 | 1,311,662 | 14 |
| FULL | docx | 1 | PASS 6/6 | yes | none | 71,667 | 877,656 | 11 |
| FULL | docx | 2 | PASS 6/6 | yes | none | 71,579 | 806,202 | 10 |
| FULL | docx | 3 | fail 4/6 (accept view, author) | yes | none | 71,596 | 786,956 | 10 |
| FULL | pptx | 1 | PASS 6/6 | yes | none | 71,664 | 677,756 | 8 |
| FULL | pptx | 2 | PASS 6/6 | yes | none | 71,664 | 1,153,851 | 12 |
| FULL | pptx | 3 | PASS 6/6 | yes | none | 71,669 | 1,128,670 | 12 |
| CAPPED | haiku | 1 | PASS 5/5 | yes | none | 29,885 | 348,495 | 8 |
| CAPPED | haiku | 2 | PASS 5/5 | yes | none | 29,754 | 471,246 | 11 |
| CAPPED | haiku | 3 | PASS 5/5 | yes | none | 29,887 | 395,445 | 9 |
| CAPPED | sonnet-tools | 1 | PASS 7/7 | yes | none | 29,718 | 292,931 | 7 |
| CAPPED | sonnet-tools | 2 | PASS 7/7 | yes | none | 29,779 | 456,228 | 10 |
| CAPPED | sonnet-tools | 3 | PASS 7/7 | yes | none | 29,789 | 512,472 | 11 |
| CAPPED | docx | 1 | PASS 6/6 | yes | none | 29,699 | 366,250 | 10 |
| CAPPED | docx | 2 | PASS 6/6 | yes | none | 29,771 | 296,361 | 8 |
| CAPPED | docx | 3 | PASS 6/6 | yes | none | 29,771 | 320,745 | 9 |
| CAPPED | pptx | 1 | PASS 6/6 | yes | none | 29,541 | 705,119 | 13 |
| CAPPED | pptx | 2 | PASS 6/6 | yes | none | 29,542 | 592,226 | 11 |
| CAPPED | pptx | 3 | PASS 6/6 | yes | none | 29,542 | 639,937 | 12 |
| NONE | haiku | 1 | fail 4/5 (labels) | n/a | none | 15,307 | 179,368 | 9 |
| NONE | haiku | 2 | fail 4/5 (labels) | n/a | none | 15,270 | 165,360 | 8 |
| NONE | haiku | 3 | fail 4/5 (labels) | n/a | none | 15,271 | 190,441 | 9 |
| NONE | sonnet-tools | 1 | fail 2/7 | n/a | none | 15,405 | 90,398 | 5 |
| NONE | sonnet-tools | 2 | fail 2/7 | n/a | none | 15,352 | 90,778 | 5 |
| NONE | sonnet-tools | 3 | fail 2/7 | n/a | none | 15,406 | 94,905 | 5 |
| NONE | docx | 1 | PASS 6/6 | n/a | none | 15,353 | 101,686 | 5 |
| NONE | docx | 2 | PASS 6/6 | n/a | none | 15,347 | 115,407 | 6 |
| NONE | docx | 3 | PASS 6/6 | n/a | none | 15,353 | 117,803 | 6 |
| NONE | pptx | 1 | PASS 6/6 | n/a | none | 15,358 | 837,537 | 19 |
| NONE | pptx | 2 | PASS 6/6 | n/a | none | 15,404 | 263,361 | 9 |
| NONE | pptx | 3 | PASS 6/6 | n/a | none | 15,413 | 280,464 | 8 |

Every run was valid. No run had a network attempt and none was flagged as a leak.

## Totals

| Arm | Hidden pass | Needed skill loaded | Mean first request | Mean tokens per run | Mean turns |
|---|---|---|---|---|---|
| FULL | 10/12 | 12/12 | 71,740 | 915,122 | 10.4 |
| CAPPED | 12/12 | 12/12 | 29,723 | 449,788 | 9.9 |
| NONE | 6/12 | n/a (no skills) | 15,353 | 210,626 | 7.8 |

Passes per task (FULL / CAPPED / NONE):

| Task | FULL | CAPPED | NONE |
|---|---|---|---|
| haiku | 3/3 | 3/3 | 0/3 |
| sonnet-tools | 2/3 | 3/3 | 0/3 |
| docx | 2/3 | 3/3 | 3/3 |
| pptx | 3/3 | 3/3 | 3/3 |

## Verdicts

- **The cap does not hurt these tasks.** CAPPED passed 12/12 against FULL's 10/12. It loaded the needed skill in 12/12 runs, the same as FULL. improve.ts decided "candidate for human review", with 2 runs improved and 0 regressed. The two FULL failures are single misses, and CAPPED's lead of 2 is within noise at n=3. The supported claim is "no harm", not "the cap helps". The cap cut the first request by 59% (71.7k to 29.7k tokens) and the mean tokens per run by 51%.
- **Only the two API tasks are authentic skill tasks.** NONE passed 0/6 on them, against 5/6 for FULL and 6/6 for CAPPED.
  - On sonnet-tools, NONE kept `thinking: disabled`, which is a 400. The agent said in its final message that it guessed the model id.
  - On haiku, NONE got the id right and dropped temperature. It left `max_tokens` too small for thinking, so the label test failed.
- **The docx and pptx tasks are not authentic.** NONE passed them 6/6, the same as or better than FULL (5/6). The model knows tracked-change XML and slot removal without the skill. Overall NONE passed 6/12 against FULL's 10/12, a gap that comes only from the API tasks.
- No arm loaded any skill other than the one each task needs.

## Limits

- n=3 per cell, one model, one seed.
- The API tasks score against fake servers built from the skill text, not the real API.
- The hub lacks lxml, defusedxml, zip and soffice, so the docx and pptx helper scripts cannot run in the seeded arms.
- CAPPED's seeded side was reused from the improve run, not re-run next to NONE.
- Doctor preflight calls are not in the cost figures.
