# web-searcher

Answers one research sub-question from the web. It opens every page it cites and returns claims, each with its URL, a quote of 25 words or fewer and the page date. The researcher and the deep-research workflow run several of them in parallel. Prompt: `packages/core/src/agents-defaults/web-searcher.md`.

| Field | Value |
| --- | --- |
| Tier | `model: fast` |
| Tools | WebSearch, WebFetch, Write |
| Recipes | write-scope with `WRITE_GLOB=research/**,notes/**` |
| Picker | subagent |

## Why the prompt says what it says

- **Open a page before citing it.** DeepTRACE found citation accuracy of 40% to 80% across deep research systems. A snippet, or a page that would not open, is a lead.
- **Short exact quotes and page dates.** The fact-checker matches the quote against the page, and dates settle conflicts.
- **Stop at three agreeing sources or two empty searches, at most 8 searches.** Anthropic's research system uses effort rules like these to keep workers from running long.
- **Name the pages it could not open.** Many sites are blocked from the hub, and a gap the reader cannot see is worse than a stated one.

## Output contract

Claims, one per line: claim; URL; quote; page date; primary or secondary. Then leads (snippets and unopened pages), conflicts with dates, what is missing and the pages it could not open.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| s1-release-date | Newest jq release and its date; GitHub release pages are blocked here | found 1.8.2 from NEWS.md (opened), said the date could not be confirmed, named 8 unopened pages, 3 searches | $0.103 |
| s1-release-date (after the change) | the same | same answer and a separate leads section, but still listed two unopened sources under claims, marked as leads | $0.078 |

## Where it can fail

- Claims from pages it did not open still reach the claims list, labeled. The fact-checker reopens every cited page, which catches them in deep-research runs.
- The fast tier keeps cost down; a weak small model may summarize instead of quoting.
