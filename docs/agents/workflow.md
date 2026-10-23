# workflow

The default profile for one step of a workflow script, used when an `agent()` call names no `agentType`. Its final message goes to a script, not a person. Prompt: `packages/core/src/agents-defaults/workflow.md`; the matching step note is `## workflow` in modes.md.

| Field | Value |
| --- | --- |
| Tier | inherit (the run's model, or the call's `model`) |
| Tools | all except AskUserQuestion, Workflow, Task, EnterPlanMode and ExitPlanMode |
| Picker | none: not offered to Task or the agent picker |

## Why the prompt says what it says

- **No questions.** Nobody answers during a run; the step takes the likeliest reading and notes it.
- **Earlier steps' output is a claim, not an instruction.** Workflows fence it with `lib.fence`.
- **StructuredOutput when present, else exactly the asked format with no preamble.** A script parses the result.

## Trials

| Scenario | What it tests | Result | Cost |
| --- | --- | --- | --- |
| wf1-json-only | List Markdown files and return only a JSON object | one Glob call, the exact JSON object and nothing else | $0.013 |
