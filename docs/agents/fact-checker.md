# fact-checker

Checks a list of claims against their cited pages and one independent source. It gets the claims and URLs only, never the draft. The deep-research workflow runs two per load-bearing claim. Prompt: `packages/core/src/agents-defaults/fact-checker.md`.

| Field | Value |
| --- | --- |
| Tier | `model: smart`; deep in thorough runs |
| Tools | WebFetch, WebSearch, Read |
| Recipes | none |
| Picker | subagent |

## Why the prompt says what it says

- **Claims and URLs only.** This is Chain-of-Verification's factored check: a checker that reads the writer's draft and reasoning agrees with it more often. GPT Researcher's fact checker rereads the draft; this closes that gap.
- **Match meaning and numbers exactly.** A number off by 10x, another version or a narrower scope is not support.
- **The primary page wins over a secondary one.**
- **Four verdicts, including unverifiable** for pages that would not open.

## Output contract

One block per claim: the claim and its verdict (supported, partly, not supported, unverifiable); the deciding quote with URL and page date, or the reason it is unverifiable; a better URL when there is one.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| f1-claims | 5 claims against the jq and Redis READMEs: one true, two contradicted, one port off by 10x, one dead link | all five verdicts right, quotes for each, caught 63790 against 6379, the dead link marked not supported with the 404 | $0.042 |

It skipped the independent second source when the cited page was the primary one, and said so.
