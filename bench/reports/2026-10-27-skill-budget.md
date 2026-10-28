# Bench: skills list budget (feat/skill-list-budget), 2026-10-27

> **What was compared:** Conclave without the skill-list cap (baseline 60129a0d, v0.4.42) against Conclave with the cap (candidate 901da2e6, branch feat/skill-list-budget, shipped as PR #136 in v0.4.43), arm A (Conclave) only, through `bench/improve.ts`. Both arms seeded with the hub's real set of 440 skills.
> **Model:** claude-sonnet-5-5. **Tasks:** the 6 bug tasks. **Repeats:** 2, seed 1, 12 runs per arm. No judge.
> **Route:** hub gateway to CLIProxyAPI on the owner's subscription, so list cost is accounting only, not money spent.
> **Raw results:** were in `cv-skill-budget/bench/results/skill-budget-2-{baseline,candidate}/` in a temporary worktree on the hub. They are not kept in git.
> **Caveats stated below:** no bench task depends on a skill (see [2026-10-28-skill-tasks.md](2026-10-28-skill-tasks.md) for tasks that do); the skills section sizes are chars/4 estimates; cost figures exclude doctor preflight requests.

Baseline origin/main 60129a0d (v0.4.42); candidate feat/skill-list-budget 901da2e6 (main merged in).
Both arms seeded via BENCH_SEED_HOME with the same copy of the hub's skills, learned-skills and plugins (440 skills).
Model claude-sonnet-5-5 through the hub gateway; tasks bug-ts-cents, bug-ts-timezone, bug-ts-config, bug-py-retry, bug-py-utf8, bug-py-cursor; repeats 2; seed 1; set skill-budget-2.
No bench task depends on a skill, so no skill-specific runs were added.

## Skills section of a coder session (hub's 440 skills, chars/4 estimate)

- Before: 144,778 chars, ~36,195 tokens
- After: ~22,000-22,550 chars, ~5,490-5,640 tokens (the first message changes which skills keep descriptions)

## Bench

| Arm | Hidden tests pass | First-request tokens (median, range) | Total tokens per run (median) | Total tokens (12 runs) | List cost |
|---|---|---|---|---|---|
| Baseline 60129a0d | 11/12 | 71,957 (71,885-72,157) | 650,448 | 7,999,145 | $4.03 |
| Candidate 901da2e6 | 12/12 | 29,847 (29,682-29,963) | 292,331 | 3,521,083 | $1.98 |

- Hidden tests: 12/12 paired, 1 improved, 0 regressed. The one baseline miss: bug-py-cursor r2 (3/8, claimed NOT DONE).
- Own tests (fail at start, pass at end): 10/12 in both arms; regression gate proven 10/12 in both.
- First request -58%, median tokens per run -55%, total tokens -56%.
- Recorded list cost $6.02 of the $10 cap (free on the owner's plans through the gateway).

## improve.ts comparison

- Baseline: a worktree at 60129a0d; candidate: a worktree at 901da2e6 (both temporary, removed).
- Model: claude-sonnet-5-5; tasks: bug-ts-cents, bug-ts-timezone, bug-ts-config, bug-py-retry, bug-py-utf8, bug-py-cursor; repeats: 2; seed: 1.
- Decision: **candidate for human review**. Human review only; no merge or deploy.
- Hidden tests: 12/12 paired; 1 improved; 0 regressed.
- Baseline own tests (fail start/pass final): 10/12; regression gate proven: 10/12.
- Candidate own tests (fail start/pass final): 10/12; regression gate proven: 10/12.
- Recorded run list cost: $6.02 / $10.00 cap. The cap and reported spend exclude doctor preflight model requests (one per started set); doctor exposes no usage or cost.
- Raw results: were in cv-skill-budget/bench/results/skill-budget-2-{baseline,candidate}/ on the hub; not kept in git.
