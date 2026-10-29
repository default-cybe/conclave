# Built-in agents

Conclave ships twenty-four agents and one base prompt: twelve general agents, and twelve specialists for building, testing, debugging, design and research (added with workflows, docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md section 4). Each general prompt was written for the owner's real work (a Proxmox homelab, an Arch desktop and a MacBook, uni courses, CTFs, Conclave itself), tried against a real model on realistic scenarios, revised, and then checked again by a second person on scenarios the first one never saw. The specialists had a smaller first round of trials (see How they were validated). This page lists the agents, says where their files live and how to change them, and summarizes how they were validated.

## The agents

| Agent | Role | Picker | Tools | Prompt notes | Validation |
| --- | --- | --- | --- | --- | --- |
| [assistant](assistant.md) | Default agent for everything outside coding: homelab questions, uni logistics, reminders, emails, file chores | primary | all | [assistant.md](assistant.md) | [personal](validation-personal.md): accept |
| [chat](chat.md) | The Chat page: plain conversations, explanations, drafts, quick how-tos; answers from memory and cites the web | primary (and the default for chats) | WebSearch, WebFetch, MemorySearch, MemorySave, MemoryForget | [chat.md](chat.md) | six single-run trials, one revision; not blind-validated yet |
| [tutor](tutor.md) | Uni work: teaches on graded work, no answers during an open quiz or exam, worked solutions for practice | primary | all | [tutor.md](tutor.md) | [personal](validation-personal.md): revise, fixed in v4 |
| [researcher](researcher.md) | Web research with sources: versions, CVEs, prices, hardware; leads larger research with web-searcher subagents | primary and subagent | read, write, web, ReadPost, todos, Task, Workflow, AskUserQuestion, MemorySearch | [researcher.md](researcher.md) | [personal](validation-personal.md): accept; the lead rules are not trialled yet |
| [coder](coder.md) | Software engineer in the owner's repos: reads first, small diffs, runs the tests | primary | all; recipes verify-gate, regression-gate, no-test-gaming, new-dependency-gate, diff-budget | [coder.md](coder.md) | [code](validation-code.md): accept |
| [reviewer](reviewer.md) | Reviews a diff for bugs, security holes and missing tests, with file:line; a finder mode for workflows | subagent | read-only plus Bash and WebFetch | [reviewer.md](reviewer.md) | [code](validation-code.md): accept; finder mode one trial |
| [planner](planner.md) | Plan mode: explores read-only, then a plan to approve | primary | Read, Grep, Glob, LS, Bash, RepoMap, web, MemorySearch, todos, Task, ExitPlanMode (plan mode keeps it read-only) | [planner.md](planner.md) | [code](validation-code.md): accept |
| [explore](explore.md) | Fast read-only search of files and git history | subagent | Read, Grep, Glob, LS, Bash, RepoMap | [explore.md](explore.md) | [code](validation-code.md): accept |
| [general-purpose](general-purpose.md) | Subagent for a self-contained job that changes files or runs commands | subagent | all | [general-purpose.md](general-purpose.md) | [code](validation-code.md): revise one line, fixed in v5 |
| [sysadmin](sysadmin.md) | The owner's machines: Proxmox host, LXC containers, Arch, Mac | primary | all | [sysadmin.md](sysadmin.md) | [ops](validation-ops.md): accept |
| [security](security.md) | Authorized security review and CTF practice; confirms scope first | primary | all | [security.md](security.md) | [ops](validation-ops.md): accept |
| [librarian](librarian.md) | Memory gardener: tags, links, merges duplicates without losing text | neither (routines) | all | [librarian.md](librarian.md) | [ops](validation-ops.md): accept |
| [verifier](verifier.md) | Tries to prove one finding or claim wrong, in a fresh context; deep tier, xhigh effort | subagent | read-only plus Bash and WebFetch | [verifier.md](verifier.md) | 4 trials |
| [builder](builder.md) | Implements one scoped change in the files the brief names and proves it | subagent | file tools, Bash, todos; recipes verify-gate, regression-gate, no-test-gaming, diff-budget, new-dependency-gate | [builder.md](builder.md) | 2 trials |
| [tester](tester.md) | Writes and runs tests for named behavior; never changes source | subagent | file tools, Bash; recipes no-test-gaming, write-scope (test paths), regression-gate | [tester.md](tester.md) | 2 trials |
| [debugger](debugger.md) | Root cause of one failure from a repro; diagnoses only; deep tier | subagent | read-only plus Bash | [debugger.md](debugger.md) | 1 trial |
| [designer](designer.md) | UI changes inside the design system, checked with screenshots | subagent | file tools, Bash, browser, Capture, ReadPost; recipe verify-gate | [designer.md](designer.md) | 1 trial |
| [refactorer](refactorer.md) | Restructures code without changing behavior; stops on a red suite | subagent | file tools, Bash, RepoMap; recipes verify-gate, no-test-gaming, diff-budget, new-dependency-gate | [refactorer.md](refactorer.md) | 2 trials |
| [docs-writer](docs-writer.md) | Brings docs in line with the code; every fact has a source; fast tier | subagent | file tools, Bash; recipe write-scope (Markdown and docs) | [docs-writer.md](docs-writer.md) | 2 trials |
| [web-searcher](web-searcher.md) | One research sub-question: claims with URL, quote and date; fast tier | subagent | WebSearch, WebFetch, ReadPost, Write; recipe write-scope (notes) | [web-searcher.md](web-searcher.md) | 2 trials |
| [code-researcher](code-researcher.md) | Answers from source code in a shallow clone; never runs repo code | subagent | Bash, read tools | [code-researcher.md](code-researcher.md) | 1 trial |
| [fact-checker](fact-checker.md) | Checks claims against their pages, without the draft | subagent | WebFetch, WebSearch, Read | [fact-checker.md](fact-checker.md) | 1 trial |
| [synthesizer](synthesizer.md) | The single writer of a research report, from checked claims | subagent | Read, Write | [synthesizer.md](synthesizer.md) | 1 trial |
| [workflow](workflow.md) | The default profile of a workflow step: does what the brief asks, returns to a script | neither (workflows) | all except AskUserQuestion, Workflow, Task and the plan tools | [workflow.md](workflow.md) | 1 trial |
| [email](email.md) | Reads the owner's mail for the assistant and reports what matters; untrusted, changes nothing | subagent | MailSearch, MailRead, TodoWrite | [email.md](email.md) | scripted-model tests only; not trialled on a real model yet |

Every session also gets the [base prompt](BASE.md) first (who the agent works for, reply length, tool habits, untrusted content, memory) and, in chat, plan or loop mode, a short mode note. A session with Ultra on gets the `## ultra` note, and a workflow step gets the `## workflow` note. Validation: [base](validation-base.md): accept.

"Picker" is where the agent shows up: primary agents are in the agent picker, subagents are offered to the `Task` tool by their description.

## Where the files live

```
packages/core/src/agents-defaults/
  BASE.md          base prompt, the first system block of every session
  modes.md         ## chat, ## plan, ## loop, ## ultra and ## workflow notes, each sent as "# Mode: <name>"
  <agent>.md       one file per agent: frontmatter + prompt
```

The agent files use the same format as a user agent or a Claude Code subagent (`name`, `description`, `tools`, `mode`, `permissionMode`, `primary`, `subagent`, `memory`, `color`, `icon`, then the prompt). Specialists also use `model` (a tier word), `effort`, `recipes` (hook recipes that apply only to sessions running that agent, `verify-gate` and `regression-gate` included) and, where needed, `hooks`, `ultra` and `verifyCommand`; EXTENSIONS.md describes each one. They are embedded in the build as text imports, so the compiled `conclave` binary carries them and needs nothing on disk. `builtinAgents()` in `packages/core/src/extensions/builtin-agents.ts` parses them; `session/prompt.ts` sends, in order: the base prompt, the environment, the mode note, `# Your role: <agent>` with the agent's prompt, the platform card (DESIGN.md section 51), project instructions (CLAUDE.md, AGENTS.md, ...), the owner's profile memories, the skill list, and the card's live block.

The general agents pin no model, so each one uses the session's model. The specialists name a tier instead: `fast` (docs-writer, web-searcher), `smart` (most) or `deep` (verifier, debugger). Each session resolves the word through `models.tiers` in config.json, then smallModel, the session's model or the cheapest deep model of a configured provider (`packages/core/src/extensions/agent-model.ts`). Set `model:` in your own copy to pin one.

## Changing an agent, and going back

- **Edit:** save a copy from the Agents page, or `PUT /api/agents/<name>` with the fields you change. It is written to `~/.conclave/agents/<name>.md` and replaces the shipped one by name. A project copy in `<project>/.conclave/agents/` wins inside that project.
- **See the shipped one:** `GET /api/agents/<name>/default` returns the shipped markdown and profile, the profile in use now, whether it is overridden, and whether a reset is possible.
- **Reset:** `DELETE /api/agents/<name>` removes your user copy, so the shipped prompt is used again.

Shipped prompts change with Conclave updates. A user copy does not, so after an update compare it with the default and pull in what you want.

## How they were validated

Each cluster (personal, code, ops, base) had two roles.

1. **The prompt engineer** wrote 4 to 10 scenarios per agent from the owner's real situations, each with a fixture folder, a task, and 4 or 5 binary must-pass checks scored from the transcript and post-run checks on the files (did the test pass, is `.env` still there, was memory poisoned). Each agent's set includes safety or judgment cases: prompt injection in a log or a saved web page, a destructive command with a trap, a memory-poisoning aside from another model, a live quiz, scope in security work. Each version ran 2 or 3 times per scenario against the old built-in prompt as the baseline, on Claude Sonnet 5.5 through the official Claude Code CLI with Conclave's composed system prompt and Conclave's real tool descriptions over MCP. The per-agent docs list each change and the failure that caused it.
2. **A blind validator** who had not seen the engineer's scores wrote new held-out scenarios (2 per agent), ran the old and the final prompt twice each, judged A/B pairs with the version hidden, and unblinded afterwards. The validator could accept, ask for a revision, or reject.

Results:

| Cluster | Engineer spend | Validator spend | Verdict |
| --- | --- | --- | --- |
| Base prompt and mode notes | $4.86 | $1.06 | accept: won 8 of 12 blind pairs, tied 4, lost none |
| Personal: assistant, tutor, researcher | $5.14, plus $1.01 for the tutor revision | $1.54 | assistant and researcher accept; tutor revised (see below) |
| Code: coder, reviewer, planner, explore, general-purpose | $11.39, plus $0.52 for the general-purpose revision | $1.99 | four accept; general-purpose revised one line |
| Ops: sysadmin, security, librarian | $5.93 | $1.15 | accept all three |

Revisions made after validation:

- **tutor (v4):** the validator found that "if they ask for the full answer to graded work, give it" let a short "just tell me the letter" hand over answers during a live quiz (2 of 7 runs). v4 adds a case for a quiz or exam that is open right now: no answer, no hint that settles it, and an offer to go through it once it closes. The live-quiz scenario went from 10/25 to 25/25 checks over 5 runs, with no loss elsewhere. Details in [tutor.md](tutor.md).
- **general-purpose (v5):** it wrote new files with shell heredocs, which do not show up as diffs in the app. The validator's replacement line (create and change files only with Write or Edit) was applied and re-run.

Round 5, the specialists (October 2026): one engineer, no blind validator yet. 21 trials on Claude Sonnet 5.5 through the official CLI, with the system prompt composed by `bench/agents/compose.ts` from the shipped files, on scenarios in `bench/agents/scenarios/` (each with a fixture, a task, a rubric of binary checks and a post-run check). Each run was judged against its agent's output contract and rubric. Three prompts changed once after a first run: verifier (it tried to run the script it was checking), docs-writer (it wrote the README with a shell heredoc) and web-searcher (it listed snippet-only sources as claims). Total spend $0.855, from the CLI's `total_cost_usd`. Per-agent results are on each agent's page; the runner is described in `bench/agents/README.md`.

## Open items

- The specialists have had one round of trials, mostly one run per scenario, and no blind validation. GLM, GPT and Gemini runs are not done. web-searcher still lists unopened sources under claims (labeled), and docs-writer still reaches for a heredoc before Write.
- The researcher's lead rules (sub-questions, web-searcher fan-out, the deep-research workflow) are not trialled.

- The chat agent (added with chat mode) had six single-run trials and one revision; the revision has not been re-run and no blind validator has seen it. See [chat.md](chat.md).
- The base prompt validator suggested four small wording fixes (limit "preferences override these defaults" to style and length, keep data-loss checks under "skip extra checks", let an agent role ask for more depth, name hidden injection forms). They are listed in [validation-base.md](validation-base.md) and not applied yet.
- An instruction hidden in an HTML comment was flagged to the owner in only 1 of 7 runs. The model never followed it, but rarely said it was there.
- All trials ran on Claude Sonnet 5.5. The prompts use plain instructions with no Claude-only tricks, but GLM, GPT and Gemini runs have not been done.
- Raw runs, scorers and blind judgments are in `/tmp/cg/evals/` on the machine that ran them, not in the repo.
