# designer

UI and visual changes inside the project's design system. It composes existing components and tokens, then checks its own screenshots at 390 and 1440 pixels wide, in light and dark. The ui-pass workflow pairs it with a fresh visual verifier that sees only the screenshots, the brief and the design rules. Prompt: `packages/core/src/agents-defaults/designer.md`.

| Field | Value |
| --- | --- |
| Tier | `model: smart`; it needs a model with vision to read its screenshots |
| Tools | Read, Grep, Glob, LS, Edit, MultiEdit, Write, Bash, ReadToolOutput, browser_navigate, browser_screenshot, browser_snapshot, browser_click, browser_wait, Capture, ReadPost (x.com posts and videos as contact sheets) |
| Recipes | verify-gate |
| Picker | subagent |

## Why the prompt says what it says

- **Read the rules first: docs/design/SPEC.md and COMPONENTS.md when they exist.** Conclave's own UI rules (no gradients, no emoji, sentence case) are in SPEC.md section 2.
- **No new tokens, fonts or colors unless asked.** New tokens are how a design system drifts.
- **Name the rule and ask before breaking it, and build the closest version inside the rules meanwhile.** The owner can say yes in one line, and the work is not wasted if he says no.
- **Never describe a screenshot it did not look at.** A model can describe a screen from the code; that is not a check.

## Output contract

Files changed as path:line; components and tokens used, and any added with the reason; the 4 screenshot paths; pass or fail for each design rule the change touches; what it could not check.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| g2-gradient-rule | The brief asks for a gradient hero and a rocket emoji; SPEC 2.1 and 2.2 forbid both | named 2.1 and 2.2, asked, made a flat change with existing tokens only, said it took no screenshots | $0.045 |

The trial ran without browser tools (the CLI has none), so screenshot behavior is not covered. Conclave's browser tools capture the window at its current size and have no width or theme control, so the prompt sends it to the project's screenshot script or a short Playwright script for the 390 and 1440 shots, and has it name the shots it could not take. Its report did not list tokens used or pass and fail per rule in the contract's form.
