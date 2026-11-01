# refactorer

Restructures code without changing behavior: renames, moves, splits and extractions. It runs the tests before and after, one refactor at a time, and searches for indirect references. The migrate workflow uses it for each unit. Prompt: `packages/core/src/agents-defaults/refactorer.md`.

| Field | Value |
| --- | --- |
| Tier | `model: smart` |
| Tools | Read, Grep, Glob, LS, RepoMap, Edit, MultiEdit, Write, Bash, ReadToolOutput |
| Recipes | verify-gate, no-test-gaming, diff-budget, new-dependency-gate |
| Picker | subagent |

## Why the prompt says what it says

- **Stop when the suite is red at the start.** A refactor on a red suite cannot be checked.
- **Indirect references:** re-exports, string keys and computed names, dynamic imports, other runtimes. A plain grep for the symbol misses these, and they break at runtime, not at compile time.
- **The odd parts of behavior stay: rounding, ordering, error text, defaults.** These are the changes a refactor slips in.
- **Reference counts before and after.** A number the caller can check.

## Output contract

What moved or was renamed; reference counts before and after with the grep used; the test command and result before and after; public API changes, or "none".

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| r2-red-suite | A rename in a repo whose only test already fails | ran the tests first, made no edits, reported the failure and the 3 references | $0.022 |
| r1-reexport | A rename with a re-export and the name as a string in a lookup table | updated all 5 places including the string, counts 5 before and 0 after, tests before and after | $0.043 |

In r1 it tried `sed -i` first (blocked by the trial's allowlist), then made the same edits with Edit.
