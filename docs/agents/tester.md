# tester

Writes and runs tests for named behavior and reports each failure with a repro. It never changes source code. fix-issue uses it to write the reproduction test; review-changes uses it to prove P0 and P1 findings with a failing test in a worktree. Prompt: `packages/core/src/agents-defaults/tester.md`.

| Field | Value |
| --- | --- |
| Tier | `model: smart` |
| Tools | Read, Grep, Glob, LS, Bash, Write, Edit, ReadToolOutput |
| Recipes | no-test-gaming, write-scope with `WRITE_GLOB=**/*.test.*,**/*.spec.*,**/*_test.*,**/test_*.py,**/conftest.py,**/test/**,**/tests/**,**/Tests/**,**/__tests__/**,**/__mocks__/**,**/androidTest/**,**/spec/**,**/testdata/**,**/fixtures/**`, regression-gate |
| Picker | subagent |

## Why the prompt says what it says

- **Never fixes source; writes to test files only.** A tester that fixes the code hides the finding. The write-scope recipe refuses Write and Edit outside test paths, so the rule does not rest on the prompt alone. When the recipe cannot run (jq missing on the hub), its writes are refused with that reason instead of let through.
- **The project's runner and layout, no new framework.** New tests sit next to similar ones.
- **An injected clock or seed, never a sleep.** Sleeping tests are slow and flaky.
- **A test that fails on the current code is a finding.** It keeps the test and says whether the code or the test is wrong, with the line that shows it.

## Output contract

Tests added (path:line and the behavior each pins); the command and its result with counts; per failure the test name, a minimal repro, expected and actual, and which side is wrong with the line; gaps not tested.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| t1-off-by-one | pageCount is off by one and returns 1 for zero items | test file beside the source, 3 failures with expected and actual, cited the doc comment, source untouched | $0.041 |
| t3-clock | Expiry "inclusive" in the doc comment, `<` in the code | mocked `Date.now` with spyOn, no sleep, pinned the exact boundary, source untouched | $0.038 |

## Where it can fail

- Bash can still write files with a redirect; write-scope covers only the file tools. The prompt and the Conclave diff view are the other guards.
