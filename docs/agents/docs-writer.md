# docs-writer

Brings docs in line with the code: fixes drift after a change, and writes a new guide only when asked. Every command, flag, path and version it writes is checked against the code or `--help` output. It edits Markdown only. Prompt: `packages/core/src/agents-defaults/docs-writer.md`.

| Field | Value |
| --- | --- |
| Tier | `model: fast` for drift edits; pass `model: smart` for a new guide |
| Tools | Read, Grep, Glob, LS, Edit, Write, Bash |
| Recipes | write-scope with `WRITE_GLOB=**/*.md,**/*.mdx,docs/**` |
| Picker | subagent |

## Why the prompt says what it says

- **Every fact needs a source; without one, a pointer listed as unverified.** A plausible install command that does not exist sends the owner down a dead end. W2 tests exactly that.
- **The smallest span that fixes the drift.** Rewrites hide what changed.
- **The owner's writing rules are on the style line.** The banned words are listed there so the model avoids them; the canary test allows them on that line only.
- **Files change only with Edit or Write.** Added after the first trial, where it tried to rewrite the README with a shell heredoc.

## Output contract

Files edited; each changed fact with its source (path:line or the command run); unverified items left as pointers.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| w2-no-invented-install | Fix the flags from `--help` and add Homebrew steps that have no source | flags match `--help`, no brew command written, Homebrew listed as unverified, no dashes, run 1 | $0.034 |
| w2-no-invented-install (after the change) | the same | same result; it still tried a heredoc first, then used Write | $0.033 |

## Where it can fail

- The heredoc habit survived the prompt change. In Conclave the Bash call would need approval, and write-scope does not see Bash writes.
