# Round review: past chats, folders across devices, workflows and specialists

This is the whole-app review of the round in `ROUND-IMPORT-PATHS-WORKFLOWS.md`, after the four builders (import, paths, workflows, subagents), their QA passes and the Android builder. It covers what was checked, what was fixed, and what is left. No paid model calls were made in this pass.

## Checked

**Builds and tests**

- `bunx tsc --noEmit -p .` is clean in core, server, cli, web and bench.
- `bun run build` in `packages/web` passes.
- `bun test packages/core packages/server packages/cli`: 1,533 pass, 1 skip, 0 fail across 137 files.
- `bun test` in `packages/web`: 96 pass, 0 fail.
- The first run of the full suite left 42 `/tmp/conclave-*` folders behind. After fix 13 a full run leaves 6, most of them empty homes from older tests; they were deleted.

**Real hub, end to end** (port 8120, a scripted fake model, a real paired daemon as the second machine)

- **Import with learning.**
  - The scan of a fixture home found 11 Claude Code and Codex chats, one of them an archived `.zst` rollout. 6 were new; 5 were skipped, each with its reason (subagent, internal, automation twice, too short).
  - The estimate priced 6 chats at $0.0082 before anything ran.
  - With the model down, the 6 chats were imported and the batch failed with Bun's raw socket error. That message is now clear (fix 8).
  - Resume learned all 6: 6 memories kept, 18 bad items dropped by the checks (13 quotes not in the chat, 5 from the wrong speaker).
  - A second import of the same chats copied nothing: all 6 came back as already here.
- **Resume on a second machine.**
  - The "macbook" was a real `conclave daemon` with its own home. The imported chat "Portfolio contact form" points at `/home/kai/code/portfolio`, which is on neither machine.
  - The location said missing. The move searched the macbook and found `~/Developer/portfolio` (weak, since nothing is known about the original copy). Choose folder with remember moved it.
  - A Read of the old path read the macbook copy, and the result said so once. A Write to the old path landed in the macbook repository after one approval.
  - Memories learned from the import were recalled in the session on the macbook.
- **Two default workflows.**
  - review-changes on the macbook session: 13 agents and 4 checks ran, and one finding was confirmed by all three refuters at the cited line.
  - design-panel, started from the chat through the Workflow tool with Ultra on: the first run showed the approval card, then 12 agents ran and the result came back into the chat. The session was then marked approved for Ultra.
  - An inline script written by the agent then started with no card, as Ultra allows. Its agents that reached for `~/.ssh` and for another device were refused (fix 2), and its agent in `src` ran.
- **The web app on the real hub.** The run view, the moved session and Memory > Import, on desktop and phone. No console errors.

**Web sweep (mock hub)**

- 21 scenes:
  - Sessions and the command palette.
  - The offline, missing-folder and folder-chooser banners, and an imported session.
  - Memory > Import with the learning preview, and the import sheet.
  - The Workflows library, the runs list, a finished and a live run view, a session with a workflow card, and the Ultra switch open.
  - Agents and the verifier editor.
  - Devices with Folders.
  - Settings, About, Memory and Home.
- Each at 1440x900 and 390x844, dark and light: 84 screenshots.
- The sweep checks each page for console errors, sideways scroll, em or en dashes, the banned words, and "undefined", "NaN" or "[object Object]" in the text. All clean after the fixes below.
- The top bar was also measured at widths from 768 to 1680 (fix 10).

**Adversarial pass on the riskiest code**

- The workflow sandbox and runtime (`workflows/sandbox.ts`, `meta.ts`, `prelude.ts`, `run.ts`, `service.ts`, `agents.ts`). Checked:
  - the meta tokenizer and the pure-literal check;
  - the host function surface;
  - every place a script can reach the shell, the file system, a device or memory;
  - the source and trust of each way a script arrives.
- Path translation (`tools/util.ts`, `projects/service.ts`, `projects/resolve.ts`, `projects/store.ts`, `session/runner.ts`, `tools/bash.ts`). Checked:
  - prefix boundaries;
  - roots that would map too much;
  - how permission rules and the approval card see a mapped path.

## Fixed

Each fix has a test that failed before it, unless it says otherwise. Tests:

- `packages/core/test/workflows/review-scope.test.ts`;
- `packages/core/test/projects/review.test.ts`;
- `packages/core/test/import/review.test.ts`;
- one case in `packages/core/test/providers/catalog.test.ts`.

1. **A script the agent saved could grant itself Bash.** The QA fix limits `meta.permissions.allow` to the owner's own workflows. But `scriptPath` counted any file outside the runs folder as the owner's library. An agent in acceptEdits could write `./wf.js` with `allow: ['Bash']` and run it through the Workflow tool with `scriptPath`. In Ultra that needs no card, and its `lib.exec` then ran with no approval. Now only files in `~/.conclave/workflows` on the hub count as the owner's. A file anywhere else counts as a project script, and a relative path is read from the session's folder on its device. File: `workflows/service.ts`.
2. **An agent's script could send its agents anywhere.** `opts.conclave.cwd` and `device` were taken as given. An agent inherits the session's permission mode, and acceptEdits allows edits inside the agent's own folder. So a script that set `cwd: '~/.ssh'`, or picked pve, widened what ran without asking.
   - A run from an agent, a repository or such a file is now scoped. The new `workflow_runs.scoped` column carries this across a restart and a resume.
   - Its agents stay on the run's device. Their folder must be inside the run's repository or one of the run's own worktrees and checkouts, so review-changes' `lib.checkout` pattern still works.
   - Otherwise `agent()` throws with the reason, naming the device.
   - Built-in, plugin and saved workflows keep the full options.
   - A relative `conclave.cwd` now resolves against the run's folder for every run. Before, the child got a relative folder.
   - Files: `workflows/run.ts`, `workflows/store.ts`, `workflows/service.ts`.
3. **Worktree setup ran any shell command with no check.** `opts.conclave.worktreeSetup` from a script, and `worktreeSetup` from a repository's `.conclave/settings.json`, went straight to `machine.exec`. Now:
   - a script's command asks like `lib.exec` unless the run is the owner's own;
   - a project's command runs without asking only in a trusted folder, like the verify gate;
   - an unattended run that needs approval fails the call with the reason.
   - File: `workflows/run.ts`.
4. **Nested workflows could use up the hub's memory.** `parallel()` over `workflow()` made one QuickJS runtime per call, each allowed 64 MB. Twenty at once grew the hub by 930 MB, and 4,096 were allowed. Now at most two nested sandboxes run at once per run; more wait, with one log line. Twenty at once now grow it by 177 MB. File: `workflows/run.ts`.
5. **Deny rules judged the old path.** File tools map an old path to the new folder, but the permission check saw the raw input. After a move, `Read` of `<old root>/.env` matched no `Read(./.env)` deny rule, then read the new `.env`. In acceptEdits, a write by the old path asked as "outside the workspace" although it landed inside. `ruleContent` now gets the path map, so rules judge the path the tool touches. Files: `session/runner.ts`, `tools/types.ts`, and `ruleContent` in `read`, `write`, `edit`, `multiedit`, `notebook-edit` and `ls`.
6. **The approval card showed a path that is not on the device.** A Write to the old path showed "Write /home/kai/code/portfolio/NOTES.md" on the macbook. The card now adds "(now /Users/.../portfolio/NOTES.md)". File: `session/runner.ts`.
7. **A root of / would map every path.** `mapOldPath` and `refreshPathMap` now skip an empty or `/` old root. Files: `tools/util.ts`, `projects/service.ts`.
8. **A learning batch whose model does not answer said only the socket error.** The owner saw "fake: Unable to connect. Is the computer able to access the url? (ConnectionRefused)" and a failed batch, with no word that the chats were imported. It now reads "Learning stopped: anthropic/claude-haiku-5-5 did not answer (...). The chats copied so far stay imported. Resume tries the rest again once it answers." Resume then learns them; the test covers both. File: `import/service.ts`.
9. **Imported coding chats resumed with the personal assistant.** The default agent is `assistant`, whose own prompt sends coding to the coder. A Claude Code, Codex or Gemini CLI chat now comes in with `coder` when it exists. claude.ai and ChatGPT exports stay chats. File: `import/service.ts`.
10. **Settings fell off the top bar.** Goals (life assistant round) and Workflows (this round) made the full nav about 1540 px wide, but it still showed whole from 1440. At 1440, Settings sat at x 1518 and was cut off. The bar also overflowed at 1120 (6 px), at 1024 (43 px) and on tablets at 768 (3 px). Now:
    - the whole nav shows from 1560;
    - below that, Workflows, Agents, Extensions, Memory and Devices fold into More;
    - below 1200, Usage and Routines fold too;
    - the tablet bar's right group is tighter.
    - Measured at 10 widths from 768 to 1680: no overflow, and Settings always shows. No unit test; the sweep's `navw.mjs` measures it.
    - File: `components/Shell.tsx`.
11. **The run view named the device by its id.** A run on the macbook read "On dev_0mvd9gii24xxmt8qic4, in /tmp/...". It now uses the device name, and a run in `~` reads "in the home folder". Seen on the real hub; no unit test. File: `features/workflows/RunView.tsx`.
12. **The Workflow approval card cut words.** The description was cut at 140 characters, and a period followed the ellipsis ("with named i…. Phases"). It now cuts at a word with no extra period. A workflow from a project or a script file names its path, so a repository's `review-changes` that shadows the built-in shows where it came from. File: `workflows/service.ts`.
13. **Test runs left folders in /tmp.** The LiteLLM price download finishes after an engine closes, and `mkdirSync(..., { recursive: true })` made the deleted test home again. A full run left 42 folders behind. The download no longer makes a home that is gone. File: `providers/catalog.ts`.

## Left

**From the builders and QA, still open**

- Android:
  - no Devices > Folders screen;
  - no workflow library to start a run from;
  - findings are read only;
  - export uploads stay on the web.
- Import:
  - no OpenCode reader;
  - mem0 and HTTP connections get writes, not deletes;
  - no Group notes button on the web Connections page;
  - the quote check compares words, not meaning;
  - uploads stop at 128 MB per request.
- Folders across devices:
  - project files and project hooks are still read on the hub at the session's path;
  - trust is per path, not per device;
  - `paths.carryTranscripts` does nothing;
  - nothing writes the `.conclave/project.json` marker;
  - old checkpoints have no Apply here after a move;
  - suggested folders come from imported sessions, not the import ledger;
  - ToolRows shows old tool paths as they were;
  - a harness in its own bypass mode never asks.
- Workflows:
  - a workflow agent that hits the budget is stopped, with no toolless wrap-up;
  - `dropDismissed` compares words;
  - a resume deletes the saved answers before replaying them, so a crash in that window loses them;
  - Anthropic's `scan.js` is not vendored (its license is unclear);
  - startup `git worktree prune` runs only when there are runs to resume.
- Subagents:
  - write-scope does not see writes made through Bash;
  - quick explore relies on the caller passing `model: fast`;
  - the share of findings the verifier refuted is not recorded per workflow;
  - the designer cannot set the browser width or theme;
  - the prompts had single runs on Sonnet only.

**Found in this pass, not fixed**

- **Imported chats have no identity to compare.** A chat imported from a machine the hub never probed has no git identity, so the copy on the Mac shows as weak and the owner picks it once. The scan knows the chat's remote; using it would give a better line ("Same remote"), but a remote alone still stays weak by design.
- **Hooks see the raw old path.** A PreToolUse hook that matches an absolute path sees the path the model typed, not the mapped one.
- **Device roots are not enforced.** The Devices page says sessions "may only read and write inside these folders", but core uses `Device.roots` only as search roots. This predates the round.
- **Workflows sits under More between 768 and 1559 px wide.** The command palette and Home still reach it in one step.
- **Old test checkpoints use up disk space.** `/root/.conclave/checkpoints` (2.5 GB from runs before the paths QA fix) and about 150 `/tmp/conclave-*` folders from earlier runs are still there. This pass was not allowed to delete files it did not make. The disk is at 95%.

**Prompt trial cost.** None in this pass. The round's trials cost $0.948: $0.855 for the subagents builder and $0.093 for its QA, from the CLI's own cost total.

## Screenshots

In `/tmp/cg/r5/review/shots/`, named `<scene>-<d|l|pd|pl>.png` (desktop dark, desktop light, phone dark, phone light). The real hub ones are `real-run-*`, `real-session-*` and `real-import-*`.
