# Skill tasks

Two tasks that need knowledge from a skill the owner used on this hub. They answer one question: does capping the skill list in the system prompt (PR #136, `agents.skillTokens`) hurt work that needs a skill? Results: [bench/reports/2026-10-28-skill-tasks.md](../reports/2026-10-28-skill-tasks.md).

They are not part of the 18-task set. Select them with `--tasks skills` or by id. The catalog entries are `SKILL_CATALOG` in `bench/lib/catalog.ts` (`kind: 'skill'`). Their `repo/` is written by hand, and `bench build` only rewrites their `task.json`. To give an arm the skills, seed them with `BENCH_SEED_HOME` (bench/lib/hub.ts). The seed needs `plugins/claude-api`.

Prompt rules, enforced by `bench check`:

- No prompt says skill, plugin or superpowers, and none names the skill.
- No prompt states the trap the check scores.

The hidden checks score the outcome only. They never look at the agent's wording or at whether it called Skill.

| Task | Skill (hub path) | Fact or step the check depends on | Why a strong model likely misses it | How the check scores it |
|---|---|---|---|---|
| `skill-api-haiku` (python, medium) | `claude-api` (plugins/claude-api, `shared/model-migration.md` § Migrating to Claude Haiku 5.5) | The newest Haiku is `claude-haiku-5-5`, with no date suffix. On that model `temperature` must be 1 or absent, an assistant prefill is a 400, thinking is on by default and counts toward `max_tokens`, and a response can start with a `thinking` block. A decline is HTTP 200 with `stop_reason: "refusal"`. | The model id and every one of these 400s postdate training. The code reads `content[0].text`, uses `max_tokens: 20` and a prefill, and all of that worked on Haiku 4.5. | A local fake `/v1/messages` (`hidden/tests/fake_api.py`) rejects what the skill says Haiku 5.5 rejects and answers in its shape. With `tools` it answers with a `tool_use` block; a forced `tool_choice` (`any` or a named tool) skips the thinking block, as the skill says. The test runs `classify()` on 5 tickets plus one declined ticket, and checks 4 things: the model id, no rejected request, the right labels, and `None` on a refusal. The naive fix only changes the id and drops `temperature` (prefill left in). Alternatives that pass: thinking off (`hidden/alt/thinking-off`) and an enum-valued tool with forced `tool_choice` (`hidden/alt/enum-tool`). |
| `skill-api-sonnet-tools` (typescript, hard) | `claude-api` (§ Migrating to Claude Sonnet 5.5) | On `claude-sonnet-5-5`, `thinking: {type: "disabled"}` is a 400. Thinking off is `{type: "between_tools"}`, at effort `high` or below. A forced `tool_choice` (`tool`/`any`) is a 400. With `auto`, check that the call happened and retry. | `between_tools` is a new value the model cannot guess. Dropping forced tool use breaks a common extraction pattern. The prompt asks to keep thinking off, which pushes the old `disabled` request. | A fake API (`hidden/tests/fake-api.ts`) applies those rules. With tool_choice `auto` it answers the first request for one invoice (`north`) in prose, even when the prompt names the tool, so only a retry passes. The test checks 4 things: the model id, no 400, `thinking.type == "between_tools"` on every request, and the exact fields for 3 invoices plus a throw for a non-invoice. An alternative with structured outputs (`output_config.format`) also passes. The naive fix (id change, `auto`, `disabled` kept) fails. |

In the 2026-10-28 run, an arm with no skills passed these two tasks 0 of 6 times; with the skills seeded, 5 of 6 (full list) and 6 of 6 (capped list).

## Dropped, and why

- `skill-docx-redline` (needs `docx`, tracked changes in a contract): an arm with no skills passed it 3 of 3, the same as or better than the arms with the skill (FULL 2 of 3, CAPPED 3 of 3). The model knows tracked-change XML without the skill, so the task cannot measure it.
- `skill-pptx-team` (needs `pptx`, fill a deck template's team slide): an arm with no skills passed it 3 of 3, the same as both seeded arms. The model knows slot removal without the skill.
- `skill-verify-csv` (needs `superpowers:verification-before-completion`): built and dropped after the leak audit. The shared bench prompt already tells every arm to run its tests, the visible tests caught the naive fix, and the textbook fix avoids the trap, so it could not measure the skill.

## Skills checked and skipped

Not on the hub, so no task:

- `workflow-authoring` (12 loads, from imported Claude Code chats).
- `artifact-design`, `playwright-skill-v2`, `design-taste-frontend`, `web-design-guidelines`, `impactful-explainer-video`, `schedule`.

On the hub but skipped:

- `conclave-batch-merge-release` (22) and `conclave-recovery-release-preflight` (8): both need GitHub (gh PRs, tags, watched workflows) and a live hub.
- `ecc:github-ops`: needs GitHub.
- `headless-browser-stealth-bench`: needs a browser.
- `frontend-design` and `karpathy-guidelines`: style guidance, with no fact an offline check can score.
- The other process skills (`superpowers:using-superpowers`, `brainstorming`, `systematic-debugging`, `receiving-code-review`, `ponytail`, `caveman:verify-and-stop`): no outcome an offline check can tie to the skill.
- `pdf`: its content (pypdf/reportlab snippets, no Unicode subscripts in ReportLab) is either well known or needs reportlab, which the hub does not have.

## Limits

- Both tasks use a fake server built from the skill's migration guide. It is not the real API, so an undocumented behaviour of the real model is not covered, and the tasks measure "follows the skill". Neither fake supports streaming: `stream: true` is a 400 there and accepted by the real API.
- A model without the skills can still fetch the docs with curl through Bash; only `WebFetch` is denied.
