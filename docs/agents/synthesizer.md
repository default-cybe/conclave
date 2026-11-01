# synthesizer

The single writer of a research report. It uses only checked claims, starts with the verdict, cites inline and shows conflicts with their dates. It lists the unverified claims it left out. Prompt: `packages/core/src/agents-defaults/synthesizer.md`.

| Field | Value |
| --- | --- |
| Tier | `model: smart`; deep for long reports |
| Tools | Read, Write |
| Recipes | none |
| Picker | subagent |

## Why the prompt says what it says

- **One writer.** LangChain found that parallel section writers produce reports that do not fit together. Many searchers, one writer.
- **Only claims marked supported, and the part that held of partly supported ones.** The rest is listed, so the reader sees what was dropped.
- **Conflicts with dates and a stated choice.** The owner can disagree with the choice only if he sees it.
- **The owner's writing rules on the style line.**

## Output contract

The report with inline [n] citations and a numbered source list with dates; "Left out (unverified)" with one line per claim.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| y1-cmake-report | 7 checked claims about building Redis with CMake 4.1, one conflict, two unusable claims | verdict first, pin 3.31.6 with pip3, conflict shown with both dates and the README chosen, both unusable claims left out and listed, no dashes | $0.024 |

It added one line of its own advice (use a venv), not from a claim.
