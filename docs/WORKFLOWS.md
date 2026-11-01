# Workflows

A workflow is a short JavaScript file that runs many agents in a fixed plan:
fan work out, check what comes back, and hand the result to you or to the
agent that started it. Conclave runs the same scripts as Claude Code's
Workflow tool, keeps a journal so a run can resume after a crash or an edit,
and shows every agent as its own session with a transcript.

Design notes: `docs/DESIGN.md` section 18. The full plan and API:
`docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md` section 3.

## Running a workflow

**From the web app.** Open Workflows in the sidebar (or press `g w`). The
Library tab lists every workflow by where it came from. Run opens a sheet
with the arguments (JSON), the device and folder, and a token budget. Runs
lists past and current runs. A run view shows:

- a status sentence and the step running now;
- one section per phase, one row per agent: model, state (running in violet,
  waiting or parked in amber, failed in red), the last tool, tokens and cost;
- the result, the findings with their verdicts, kept worktrees, and the log.

A row opens that agent's transcript. Its menu can skip a running call (the
script gets `null`) or rerun the run from that call.

**From a chat.** Ask the agent for it ("review my changes", "research Caddy
against Traefik"). The agent calls the Workflow tool, you approve once, and
the run shows as a card in the conversation that opens into the run view.
In bypass permission mode the run starts without the approval card; its
budget and caps still hold. A run in the background reports back when it
ends, and the agent goes on from its result. Ask the agent how it is going
before then and it checks with the WorkflowStatus tool: the state, each
phase with its agents, tokens, errors so far and the last log lines.

**From the API.** `POST /api/workflows/runs` with
`{ "name": "review-changes", "cwd": "/path/to/repo" }`. See [API](#api).

## The default library

| Workflow | Use it for | Arguments |
| --- | --- | --- |
| review-changes | A change before you merge or commit it. Five finder lenses each run twice, citations are checked in code, a three-vote refuter panel judges each finding, and failing tests prove the worst ones. | `base`, `focus`, `votes`, `maxVerify`, `worktreeFrom` |
| deep-research | A question that needs several sources. Searchers open every page they cite, two fact-checkers check each claim without seeing the draft, one writer, then a completeness critic. | `question`, `depth` (quick, normal, thorough) |
| research-sweep | Learning code you do not know yet, before a design. Explorers split by subsystem, entity, history and tests. | `question`, `entities`, `areas` |
| plan-implement-verify | A real change. Understand, ask only what changes the work, plan with a check per step, build in one worktree, then tests and a review decide when it is done. | `task`, `check` |
| fix-until-green | A red test suite, typecheck or build. A debugger finds the root cause and a builder fixes it, round after round. | `check`, `maxRounds`, `isolate` |
| fix-issue | A bug report. A reproduction test must fail first, three fixes from different angles run in separate worktrees, and judges pick the smallest correct one. | `issue`, `check` |
| bug-hunt | Bugs in a codebase, not one change. Rounds of finders until two find nothing new. Keeps the folder's findings ledger. | `path`, `maxRounds`, `prove`, `round` |
| security-audit | A security review of a repository, or of the homelab with `target: "homelab"`. The shipped hard exclusions (test files, docs, plain DoS, rate limits, memory safety in safe languages, log spoofing, ReDoS, timing, outdated dependencies) drop findings in code before the panel votes; `.conclave/security-exclusions.md` adds project rules for the panel. | `target`, `devices`, `maxComponents` |
| design-panel | An open design choice. Four designs from fixed angles, three judges score them in both orders, one design is built from the winner. | `request`, `context` |
| ui-pass | A visual change in the web app, checked by a verifier that sees only the screenshots, the brief and the spec. Keeps the folder's findings ledger. | `brief`, `spec`, `checks`, `round` |
| migrate | The same change across many files or packages, in growing batches with a circuit breaker. | `goal`, `check`, `units` |
| compare-harnesses | One task run by several harnesses or models, then scored. | `task`, `check`, `hiddenTests`, `arms` |
| race | One task raced by several agents in separate worktrees. The check runs in each, a blind judge panel picks the best passing change with its reasons, and the run view shows it with Keep winner: apply its branch to the session's checkout or open a pull request from it. Nothing merges on its own, and the other branches are deleted only after you keep one. | `task`, `check`, `n`, `arms` |
| web-studio | A new site, landing page or portfolio in any project folder, following the web-studio skill. A design read, researchers per reference lane (your links first), STYLE.md and SPEC.md you approve before any code, 3 to 6 prototypes of the signature idea in worktrees that a critic ranks and you pick from, modules built in parallel, then `lib.capture` and a fresh judge that sees only the screenshots, contact sheets, brief and STYLE.md score the 10-point rubric. The pass bar (average 8 or more, nothing under 7) is computed in code; the 3 weakest areas are fixed for up to 3 rounds. Validation round A (QA, accessibility, design, security) runs the project's own package.json scripts; round B (break-it, persona, owner proxy) runs only when A is clean. Keeps the folder's findings ledger. Without `url` an agent starts the dev server or a static server; the capture runs on the hub, so the URL must open from there. About 35 agents. | `brief`, `dir`, `url`, `references`, `prototypes`, `round` |

The Run sheet shows each workflow's `whenToUse` line, which lists the
arguments in full.

## Where workflows come from

Conclave reads these places, and a later one wins a name:

1. the fourteen built in workflows;
2. enabled plugins, from their `workflows/` folder (ids look like `plugin:name`);
3. your own, in `~/.conclave/workflows/*.js` on the hub;
4. the project's, in `<project>/.conclave/workflows/*.js`, read on the session's device;
5. Claude Code's, in `~/.claude/workflows` and `<project>/.claude/workflows`,
   when `compat.claudeCode` is on.

Every run saves its script to `~/.conclave/workflows/runs/<run id>.js`. To
change a run, edit that file and start it again with `scriptPath` and
`resumeFromRunId`. A relative `scriptPath` is read from the session's folder on
its device. A script file anywhere outside `~/.conclave/workflows` on the hub
counts as a project script (see Permissions), because an agent can write one.

## Writing a workflow

A script starts with a `meta` literal: plain values only, no variables, calls,
spreads or template interpolation. Then the body runs as an async function.

```js
export const meta = {
  name: 'flaky-tests',
  description: 'Find flaky tests and propose fixes',
  whenToUse: 'When CI fails at random. args: { since?: a date }',
  phases: [{ title: 'Scan' }, { title: 'Fix' }],
}

phase('Scan')
const found = await agent('List tests that passed and failed on the same commit in the CI logs.', {
  schema: { type: 'object', properties: { tests: { type: 'array', items: { type: 'string' } } }, required: ['tests'] },
})
log(`${found.tests.length} flaky tests`)

phase('Fix')
const fixes = await pipeline(found.tests, (name) => agent(`Find why ${name} is flaky and fix it.`, { label: name, isolation: 'worktree' }))
return { fixes: fixes.filter(Boolean) }
```

The script API (the same as Claude Code's):

- `agent(prompt, opts)` runs one agent. Options: `label`, `phase`, `schema`
  (a JSON Schema; the answer comes back as a checked object), `model`,
  `effort` (low to max), `isolation: 'worktree'`, `agentType` (a profile such
  as verifier, builder or tester). It returns `null` when the call is skipped
  or fails.
- `parallel(thunks)` waits for all of them; a thunk that throws gives `null`.
- `pipeline(items, ...stages)` runs each item through the stages with no
  barrier between them. Each stage gets `(previous, item, index)`.
- `phase(title)`, `log(text)`, `args`, `budget` (`total`, `spent()`,
  `remaining()`, and `costUsd()` in Conclave).
- `workflow(nameOrRef, args)` runs another workflow inside this run, one level
  deep.

Scripts run in a sandbox: no file system, no process, no network, no
`import`. `Date.now()`, `Math.random()` and `new Date()` with no argument
throw, because they would break resume; pass times in through `args`.
`setTimeout` works and waits at most 5 minutes. A script may use 60 s of CPU
and 64 MB of memory, and its result may be 4 MB.

### Conclave extras

Add `runtime: 'conclave'` to `meta` to use these. A script with them does not
run in Claude Code.

- `agent(prompt, { conclave: { device, cwd, tools, maxSteps, worktreeSetup, worktreeFrom, withMeta } })`
  picks the device and folder, limits the tools, runs a setup command in a new
  worktree, starts the worktree from an earlier call's kept commit, or returns
  `{ value, seq, worktree, tokens, durationMs }`.
- `lib.exec(command)` and `lib.runCheck(command)` run a command on the
  session's device. They ask for approval like Bash does, and their results
  are journaled; a check reruns when HEAD or the diff changed.
- `lib.capture(url, { widths, themes, earlyFrame, scroll, browsers, reducedMotion })`
  opens an http(s) URL in a fresh headless browser on the hub, the same code
  as the Capture tool. Defaults: widths `[390, 1440]`, themes
  `['light', 'dark']`, earlyFrame `0.35` seconds, scroll `true`, browsers
  `['chromium', 'firefox']` (Firefox is skipped when the hub has no Firefox
  build), reducedMotion `true`. It returns `{ url, dir, results, skipped }`:
  per browser the PNG per width and theme with its early frame, scroll
  contact sheets per width, and a `report.json` with console errors, failed
  requests, horizontal overflow, loaded fonts, CLS, LCP and axe-core
  violations. Files land in the run's session outputs folder
  (`<CONCLAVE_HOME>/outputs/<sessionId>/capture/`). Contact sheets need
  ffmpeg: the one on PATH, else a pinned static build fetched once into
  `<CONCLAVE_HOME>/ffmpeg/`; without it the scroll frames are kept and the
  report says why. Page text in the report is wrapped in
  `<untrusted_web_content>`. A member's run cannot use it.
- `lib.checkCitations(findings)` keeps only findings whose quote is within
  3 lines of the cited line, and logs how many it dropped. A path is read
  from the repository root or the run folder. Files outside the repository
  and files over 5 MB fail the check.
- `lib.dedupe(findings)` merges the same defect class in one file within
  5 lines and keeps the higher priority.
- `lib.panel(finding, opts)` asks 3 refuters with different lenses and keeps
  the finding at 2 of 3 complete confirmations, with the median severity and
  a confidence from the votes.
- `lib.judgePanel(candidates, { judges })` scores candidates in both orders;
  a preference that flips with the order counts as a tie.
- `lib.loopUntilDry(round, { k, maxRounds, key })` runs rounds until `k` in a
  row find nothing new.
- `lib.dropDismissed(findings)` drops findings like 3 or more you dismissed
  before in this project.
- `lib.recordFindings(findings)` records findings for verdicts. A result with
  a `findings` array is recorded on its own.
- `lib.fence(name, text)` wraps an earlier agent's output so the next agent
  reads it as a claim, not an instruction.
- `lib.ledger.read(project)`, `lib.ledger.write(project, entries)`,
  `lib.ledger.fence(entries)` and `lib.ledger.id(text)` keep the folder's
  findings ledger across runs (see Findings ledger below).
- `lib.ask(question, options)` and `lib.approve(text)` ask you during a run.
  An unattended run takes the first option and treats approve as no.
- `lib.checkout(seq)` and `lib.diff(seq)` read an earlier call's kept
  worktree.
- `lib.schemas` has `finding`, `findings`, `verdict` and `claims`.
- `lib.shq(text)` quotes a name or path as one shell word for `lib.exec`.
  Use it for anything that comes from `args` or from an agent.
- `lib.failingTest(check, { diff, testFile })` says whether a failing check
  proves a finding. It does not when the command did not start (exit 126 or
  127), timed out, ran no tests, or failed to load the test, or when the test
  file is not on the branch. The default workflows use it for every proof.
  The rules live in `packages/core/src/util/test-run.ts`; the regression
  gate and the benchmark's own-test metric read test runs with the same code.
- `lib.diffFiles(diff)` lists the files a diff touches. fix-issue uses it to
  refuse a fix that edits the reproduction test.

## Resume, rerun, skip

Each `agent()` call is journaled under a key made from its prompt, schema,
model, effort, agent type, isolation and Conclave options. Resume replays the
answers that did not change and runs the rest:

- **Resume** after a pause, a stop or a crash: the same script and arguments
  replay every finished call.
- **Rerun from here** on a call: earlier calls replay, that one and later ones
  run again.
- **Edit and run again**: an edited call reruns, and so do the calls that use
  its answer.
- **Skip** a running or waiting call: the script gets `null` and goes on. A
  call you skipped stays skipped when the run resumes. A call stopped by its
  `stallMs` runs again.

A run the hub was running when it stopped resumes once at the next boot. When
more than 3 runs stopped together, none resume on their own, and a notice says
where to resume them.

A usage limit (a 429 or a quota error) parks the call. The run shows "waiting for
the limit" and resumes at the reset time.

## Budgets and limits

Set a budget in the Run sheet, with `budget` in the API, or with a `+500k` or
`+2m` word in your chat message. A budget is a hard ceiling on output tokens
(answers a new run replays from another run's journal do not count), and the
API also takes a cost ceiling in dollars. Once it is spent, `agent()` throws
and the run ends as "stopped at budget". A script can scale to it with
`budget.remaining()`. When the same run resumes, after a restart or from the
run view, what it spent before still counts. Only resuming a run that
stopped at its budget gives it a fresh budget.

| Setting | Default | What it limits |
| --- | --- | --- |
| `workflows.concurrency` | 8 (16 at most) | Agents at once in one run. |
| `workflows.perProvider` | 6 | Agents at once on one provider, across runs. |
| `workflows.hubMax` | 16 | Workflow agents at once on the hub. |
| `workflows.maxAgents` | 1000 | Agents in one run. |
| `workflows.autoApproveTokens` | 2,000,000 | The largest estimate Ultra starts without asking. |

When a cap holds calls back, the run log says which one, once.

Each run also has fixed caps that end it, so a script that loops cannot keep
the hub busy: 10,000 timer and lib calls (plus the agent cap), 1,000
`lib.exec` and `lib.runCheck` calls, 1,000 recorded findings and 64 phases.
Past the call caps the run fails with "Workflow host call cap reached" or
"Workflow check cap reached", even when the script catches the error. `args`
over 1 MB of JSON are refused.

## Models and effort

`model` takes a full model id or a tier word. `fast` is `models.tiers.fast`,
else `smallModel`. `smart` is `models.tiers.smart`, else the session's model.
`deep` is `models.tiers.deep`, else a deep catalog model of a configured
provider, else `claude-code/opus` when Claude Code is installed, else the
session's model. Claude Code's `haiku`, `sonnet` and `opus` map to fast, smart
and deep. When a tier lands on a harness that does not start, the call runs
again on the session's model and later calls in the run skip that harness.
Set `models.tiers` in the config to pin each tier.

`effort` sets the thinking level for one call: low, medium, high, xhigh or max.

## Worktrees

`isolation: 'worktree'` gives the agent a fresh git worktree on the session's
device, under `~/.conclave/worktrees/<repo hash>/<run>-<call>`, never inside
the repository and never under a Syncthing folder. A worktree that is still
clean is removed. A changed one is committed to the branch
`conclave/wf/<run>/<call>` and kept. In the run view, Worktrees shows each
kept branch with Diff, Merge, Cherry-pick and Discard.

If `.conclave/settings.json` in the project sets `worktreeSetup` (for example
`bun install --frozen-lockfile`), it runs in each new worktree first. In a
folder you have not trusted it asks first, like `lib.exec`; in a trusted folder
it runs without asking. A `worktreeSetup` in `opts.conclave` from a script an
agent wrote asks too.

## Findings and verdicts

Findings in a result appear in the run view. Mark each one:

- **Fixed**: it was real and it is done.
- **Dismiss**: it is not a bug. A reason is required. Later runs drop findings
  like 3 or more you dismissed.
- **Ignore**: not now.

The run view also shows how many findings the refuters turned down.

### Findings ledger

A ledger keeps what earlier rounds found in a project folder and what became
of it, so a later round does not report a fixed bug again or retry a rejected
idea. The hub stores it in its database (the `workflow_ledger` table), one
ledger per device and absolute folder.

An entry is `{ id, finding, severity, verdict, round, evidence?, updatedAt }`:
`severity` is high, medium or low, `verdict` is open, fixed, rejected or
wontfix, and `evidence` is a path or a URL.

- `lib.ledger.read(project)` returns the entries. `project` is a folder,
  relative to the run folder or absolute; it defaults to the run folder. The
  read is journaled, so a resumed run sees what its first attempt saw.
- `lib.ledger.write(project, entries)` upserts by `id` and returns the merged
  list. A later write replaces the finding, severity, verdict and evidence,
  keeps its own `round` (else the earlier one) and sets `updatedAt`. Without
  an `id`, the id is a hash of the finding's text with case, spacing and
  punctuation dropped; `lib.ledger.id(text)` gives the same id.
- `lib.ledger.fence(entries)` gives the block a judge prompt includes: do not
  report items marked fixed unless the evidence shows they regressed, do not
  propose rejected or wontfix ones again. It is empty for an empty ledger.

Entries come from agents' output, so the hub caps them (a finding at 500
characters, evidence at 300, an id at 100, 200 entries per write, 500 per
folder) and the fence defuses framework tags. A scoped run (see Permissions)
keeps its ledger inside its repository.

bug-hunt reads the ledger first and gives it to every finder. It drops
findings whose id is marked rejected or wontfix, and ones marked fixed unless
the finder set `regressed`. At the end it writes confirmed findings as open
and findings a complete refuter panel turned down as rejected. ui-pass gives
the ledger to the visual verifier, drops problems marked rejected or wontfix,
and writes the last look's problems as open and the ones the fix round cleared
as fixed. Both take `round` from `args.round`, else one past the ledger's
highest. web-studio gives the ledger to its rubric judge and every validation lens, drops findings the same way bug-hunt does, and writes both validation rounds' findings as open. Marking a finding Fixed in the run view does not change the ledger;
a script marks it with `lib.ledger.write`.

## Ultra

Ultra is a switch per session in the composer, off by default and not
offered in chats. With it on, the agent plans and runs a workflow for each
real task, usually one per phase (understand, design, build, review), reads
each result before the next, and verifies findings before it adds more
finders. It uses many more tokens.

The first workflow in a session asks for approval. After that, Ultra starts
runs whose estimate is under `workflows.autoApproveTokens` without asking. A
call with no estimate asks. A
`+500k` word in your message sets the budget and, with Ultra on, approves the
run. An allow rule `Workflow` in your permissions skips the question in every
session, and a session in bypass permission mode never asks it.

## Permissions

Workflow agents never ask you questions (they lose AskUserQuestion), and they
cannot start workflows or, unless their profile lists it, subagents. Their
tool approvals go to the Inbox and the phone like any other, with the session
title "workflow / agent label"; the run view shows that call as waiting. An
unattended run (a routine or a schedule) denies approvals and the agent reads
the denial. `meta.permissions` (`allow` and `deny` lists) applies only to the
run's own agents and its `lib.exec` calls. Its `allow` list counts only for a
workflow you put in place: a built-in, an installed plugin, a file in
`~/.conclave/workflows/`, or a script you send through the API. A script an
agent wrote with the Workflow tool, or one that came with a repository,
keeps its `deny` list only, and the run log says the `allow` list was not
applied. An agent that is not trusted cannot call the Workflow tool.

Such a run is scoped. Its agents run on the run's device, and
`opts.conclave.cwd` must be inside the run's repository (or its folder outside
git) or one of the run's own worktrees and checkouts; anything else makes
`agent()` throw with the reason. An agent inherits the session's permission
mode, and acceptEdits allows edits in the agent's own folder, so a script that
picked `~/.ssh` or another device would otherwise widen what runs without
asking. Workflows you put in place keep the full `opts.conclave`.

## API

All routes need the owner token.

| Route | What it does |
| --- | --- |
| `GET /api/workflows` | The library, with each workflow's last run. |
| `GET /api/workflows/:id` | One workflow with its script. Encode a plugin id (`plugin%3Aname`). |
| `POST /api/workflows/runs` | Start a run: `{ name \| script \| scriptPath, args?, sessionId?, device?, cwd?, budget?: { tokens?, costUsd? }, background? }`. 201 with the run. |
| `GET /api/workflows/runs` | Runs; filters `sessionId`, `status`, `name`, `limit`. |
| `GET /api/workflows/runs/:id` | The run, its calls, log, result and findings. |
| `POST /api/workflows/runs/:id/pause` | Running calls finish; new ones wait. |
| `POST /api/workflows/runs/:id/resume` | Go on, or resume a stopped run from the journal. |
| `POST /api/workflows/runs/:id/stop` | Stop now. |
| `POST /api/workflows/runs/:id/rerun` | `{ fromSeq }`: rerun from that call. |
| `POST /api/workflows/runs/:id/calls/:seq/skip` | The call returns `null`. |
| `POST /api/workflows/runs/:id/calls/:seq/worktree` | `{ action: diff \| merge \| cherry-pick \| discard }`. |
| `POST /api/workflows/runs/:id/findings/:findingId` | `{ verdict: fixed \| dismissed \| ignored, reason? }`. |
| `PATCH /api/sessions/:id` | `{ ultra: true }` turns Ultra on. |

Events on the WebSocket: `workflow.run`, `workflow.phase`, `workflow.agent`,
`workflow.log`, and `workflow.progress` (`runId`, `callSeq`, `lastTool`,
`waiting`), which is not kept for replay.

## Limits

- Scripts cannot `import`. A script that loops forever stops at the CPU
  limit, and one that loops on lib calls stops at the call caps.
- `Date.now()`, `new Date()` and `Date()` throw, also through the prototype
  chain, so a resumed run makes the same calls.
- `dropDismissed` compares words, not meaning, and the ledger matches ids made
  from the text, so a finding worded differently is a new entry.
- A plugin workflow that names an agent you do not have runs it as
  general-purpose and says so in the log.
- At most two nested `workflow()` calls run at once in one run; more wait.
- Android shows runs, the run view and the Ultra switch, but has no library
  screen to start a workflow from.
