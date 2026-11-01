# Conclave harness review

Date: 2026-10-17. Scope: the native harness in `packages/core` (session loop, tools, engine, memory, providers) and the places where the ACP path touches it. Paths below are relative to `packages/core/src` unless they start with `packages/` or `docs/`.

Method: read the Conclave code, compare it with the technique cards and the list at [best-of-agent-harnesses](https://github.com/ryanalberts/best-of-agent-harnesses), and check suspected bugs by running small scripts against the current code. No model calls were made.

## 1. Summary

Conclave's harness has a good base. Tool errors go back to the model as `is_error` results, every `tool_use` gets a `tool_result`, permission rules follow Claude Code syntax with deny before ask before allow, approvals reach the phone, the system prompt is kept free of clock times, large outputs are offloaded behind an id, compaction keeps old rows, checkpoints use a shadow git, and rate limits fall back or park with a durable resume job. A scripted model test harness (`packages/core/test/engine/harness.ts`) already exists, so most fixes can be tested without paid calls.

The gaps are in the parts that matter when nobody is watching: subagents, routines, loop mode and long sessions on a phone.

Three bugs came out of the review:

1. **Prefix allow rules let command substitution and file redirects through.** `splitBashCommand` splits only on `;`, `&&`, `||`, `|` and newlines. Checked with a script against `checkPermission`: `Bash(git status:*)` allows `git status $(touch /tmp/pwn)` and ``git status `id` ``, and `Bash(echo:*)` allows `echo hi > ~/.bashrc`. `parseCommand` in `tools/bash-rules.ts` already detects these constructs, but only the read-only classifier uses it.
2. **Background subagents never report back.** The Task tool tells the model "You will be notified when it finishes", but `engine/subagent.ts` starts `void driveSubagent(...)` and nothing writes the result into the parent session.
3. **Tool calls from a reply cut by the output limit still run** when their JSON happens to parse (`session/runner.ts` line 364). Only invalid JSON is caught.

Beyond the bugs: the loop has no stuck detection besides a 250-step cap, the step cap ends with no summary, compaction gives up on the first summarizer failure (and the turn then errors on a context overflow), the per-turn clearing of old tool results rewrites cached history on every new user turn, the hub forgets in-flight turns and pending approvals on restart, and there is no measurement of how agents or prompt versions perform.

The plan in section 5 ranks 27 changes by benefit per effort. The first 6 are marked **BUILD**: together about 9 to 10 hours, all testable with the scripted model.

**Status (2026-10-17):** all six BUILD items are done on branch `harness-improvements`, one commit each, with tests in `packages/core/test`. Each item below has a **Status** line with its commit and any change from the plan.

**Review fixes (2026-10-17),** one commit each on the same branch:

- Item 1: `Bash(git commit:*)` covers `git commit -m "$(cat <<'EOF' ... EOF)"` again, as in Claude Code. A quoted-delimiter heredoc substitution runs only cat, so the rules read it as one word, and its lines are not matched by deny rules. It stays gated when the delimiter is unquoted, when text follows the delimiter on its line, when a delimiter line or a `)` could end the body early, and after a comment, `$'...'`, a heredoc, a backtick or another substitution. Exact rules now match literally even with a `*`, and rules may span lines, so every suggested exact rule covers its command.
- Item 2: a background report cannot close its `<subagent_result>` or `<system-reminder>` wrapper, so text it quotes cannot pass as the harness or the user.
- Item 3: the retry of an empty reply carries a note to continue. The same request again tends to get the same empty reply.
- Item 4: a subagent that stops at a usage limit says so to its parent.
- Item 5: a rejected plan (ExitPlanMode) does not count as a denial, so a user can reject several drafts in one turn.
- Item 6: a fallback summary carries only the summary proper of the one before it (`meta.summaryRange`), so repeated fallbacks stay bounded instead of nesting every earlier section.

**Round 2 (2026-10-18):** items 8, 9, 10 (the WebFetch part), 11, 12, 13, 16, 17, 18, 21 and 24 are built, one commit each, with tests in `packages/core/test`. Each has a **Status** line below with its commit and any change from the plan. The coder prompt's regression check now runs in the same Bash call as the test run (commit 6b4db5f), to close part of the one-turn gap the benchmark found.

## 2. Sources

Projects studied through the technique cards (read in source by the research agents) and the list's playbooks and comparisons:

| Project | Link | Used for |
|---|---|---|
| best-of-agent-harnesses (list, playbooks, comparisons, skills) | https://github.com/ryanalberts/best-of-agent-harnesses | Baseline checklist (build-your-own playbook), progressive disclosure, eval comparisons, runaway-guard and claim-check skills |
| recursive-improve (named by the owner) | https://github.com/kayba-ai/recursive-improve | Trace detectors, run records, ratchet loop, skillbook; detectors and scorer re-read in source for this review |
| Gemini CLI | https://github.com/google-gemini/gemini-cli | Loop detection, batch tool-output masking, compression with latch, sandbox argv builders, TOML policy |
| opencode | https://github.com/anomalyco/opencode | Durable claim and restart sweep, background subagent jobs, checkpoint template, compaction shrink ladder, step limit prompt, code mode |
| oh-my-pi | https://github.com/can1357/oh-my-pi | Edit variants per model, provider quirks, stream rules (TTSR), advisors, replay-safe retry, LSP on write |
| Hermes | https://github.com/NousResearch/hermes-agent | Tool loop guardrail controller, compaction recall eval, session_search, iteration budgets, degenerate output guards |
| OpenClaw | https://github.com/openclaw/openclaw | Budgeted summarizer input, summary audit, pair-safe cut points, cache-TTL pruning, loop detection, memory flush |
| QM | https://github.com/yc-software/qm | Goals with a governor judge, budget rails, leases, partial-turn resume, LLM-free compaction fallback |
| Mastra | https://github.com/mastra-ai/mastra | Durable run fences, observational memory, tool search, request-stage processors, goal judge, native sandbox |
| Omnigent | https://github.com/omnigent-ai/omnigent | bwrap and Seatbelt sandbox, egress proxy and SSRF pinning, policy phases, cost budget, ACP env hygiene |
| Microsoft Agent Framework | https://github.com/microsoft/agent-framework | Grouped history with exclusion, chained compaction, judge loops, background agent tools, magentic ledgers |
| claude-mem | https://github.com/thedotmack/claude-mem | Progressive memory search, ACT-R reinforcement, IDF veto, context budget fit, cache invalidation kinds |
| aider | https://github.com/Aider-AI/aider | Post-edit lint, reflection loop capped at 3, recursive summary, cache breakpoints, architect and editor |
| inspect_ai | https://github.com/UKGovernmentBEIS/inspect_ai | Usage-anchored token count, compaction orchestration, edit strategy, limit tree, crash recovery guard |
| harbor (Terminal-Bench) | https://github.com/harbor-framework/harbor | ATIF trajectories, OTel export, question-asking handoff summary, output-limit note, trial analyzer |
| DeerFlow | https://github.com/bytedance/deer-flow | Loop detection, finish-reason guards, tool output synopsis, read-before-write gate, deferred MCP schemas, receipts |
| DeepSeek Harness | https://github.com/deepseek-ai/deepseek-harness | Compaction markers, prune-then-summarize, token meter, sandbox seam, per-tool timeouts |
| open-multi-agent | https://github.com/open-multi-agent/open-multi-agent | Content-bound durable approvals, per-call commits, loop detector, eval scorers |
| Codex | https://github.com/openai/codex | Guardian reviewer and denial breaker, execpolicy, bwrap plus seccomp, two-phase memory, compaction with verbatim user messages |
| pi | https://github.com/earendil-works/pi | Effect sandwich with replay policy, durable inbox, partial commits, cache warmer, branch summaries, paired evals |
| Prime Agent | https://github.com/PrimeIntellect-ai/prime-agent | Refine with snapshots, harness digest, shell gates with snapshot skip, autonomy budgets, recent-state anchor |
| Headroom | https://github.com/headroomlabs-ai/headroom | Content router and log, JSON, diff and search compressors, read lifecycle, volatile-token detector |
| SWE-agent | https://github.com/SWE-agent/SWE-agent | Lint-gated edits, review on submit, retry loops, history processors, requery on format errors |
| caveman | https://github.com/JuliusBrussee/caveman | Content-typed compressors, retrieve with query, cache-stable decisions, three-arm prompt evals |
| ponytail | https://github.com/DietrichGebert/ponytail | Never-cut rule list, prompt canary test, agentic A/B harness with self-tested graders |
| context-mode | https://github.com/mksglu/context-mode | Output offload idea already in Conclave (Elastic-2.0, idea only) |
| DeepSeek-Reasonix | https://github.com/esengine/DeepSeek-Reasonix | Cache stability as a design goal, stable tool order |

Evidence numbers quoted below come from those cards. Where a card says "vendor claim" or "no benchmark", this review says so too.

## 3. What Conclave already does well

- **Tool errors as results.** `SessionRunner.executeTool` turns throws, unknown tools, invalid JSON (`_raw`) and schema failures into `isError` results with text that tells the model what to do. This is the playbook baseline.
- **Transcript repair at request time.** `buildProviderMessages` fills any `tool_use` without a result with "Interrupted: no result was recorded", turns stray results into text, flattens tool calls the current model cannot express, and keeps thinking only for the same model.
- **Permissions.** Claude Code rule syntax, deny before ask before allow, every Bash sub-command must match an allow rule, plan mode is read-only, a dangerous-command guard applies in every mode, PreToolUse hooks can rewrite input, PermissionRequest hooks can answer, and approvals reach the phone with session or always scope. Untrusted agents lose shell and write tools.
- **Cache-aware prompt.** The system prompt has no clock times (date only). Dynamic context rides on the user message as `<system-reminder>` blocks. Anthropic gets breakpoints on the system prompt and the last two user turns; OpenAI-style providers get `prompt_cache_key`.
- **Output offload.** Results over 30,000 chars go to `tool_outputs` with a head and tail view and an id; `ReadToolOutput` pages and greps. Bash keeps the full text behind an id.
- **Compaction keeps history.** The summary is a message with `meta.coversThroughSeq`; old rows stay in SQLite; a PreCompact hook runs first; SessionStart fires again with source `compact`.
- **Checkpoints.** A shadow git per cwd, never touching the project's `.git`, with a restore that is itself undoable.
- **Limits.** Error classes, provider reset-time parsing, per-model fallbacks, and a durable `session.resume` job that survives restarts.
- **Subagents as fresh loops** with a depth cap of 2, SubagentStart and SubagentStop hooks, and parallel launch.
- **Multi-model modes** (jury, debate, review, handoff, loop) and ACP harnesses writing into the same transcript.
- **Instructions and skills.** CONCLAVE.md, AGENTS.md, CLAUDE.md and GEMINI.md from repo root to cwd with `@imports`; skills listed by name and description and loaded on demand; a repo map tool.
- **Test harness.** `test/engine/harness.ts` runs a real engine against a scripted Anthropic-compatible SSE server; `test/providers/mock.ts` and `test/machine/fake-machine.ts` cover providers and devices.

## 4. Techniques by area

Each area has a short note, then the techniques from the cards with what Conclave does today and the gap. Item numbers point to section 5.

### 4.1 Agent loop: stop reasons, limits, errors

Today the loop is sound for the happy path. It lacks guards for unusual stop reasons and a clean end at the step cap.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Tool errors as `is_error` results, never crashes (playbook) | Done in `executeTool` | None |
| Hard turn limit (playbook `MAX_TURNS`) | `MAX_ITERATIONS = 250` for every runner | Same cap for subagents; no wrap-up (item 4) |
| Fill or drop unanswered calls on resume (playbook) | Filled at request build time | Nothing resumes the turn itself (item 20) |
| Run tools only after a stop or tool-use finish (vercel/ai, DeerFlow length guard, terminus-2) | Calls run on `max_tokens` when JSON parses | Bug (item 3) |
| Empty reply guard (Hermes, DeerFlow) | Turn ends silently | Gap (item 3) |
| Step limit wrap-up call with `toolChoice: 'none'` (opencode, Hermes grace call) | Notice "Stopped after 250 steps" | Gap (item 4) |
| Output-limit continuation note (opencode, terminus-2) | Notice only | Unattended runs should continue twice (item 3) |
| Requery on format errors without keeping the bad output (SWE-agent) | Error result kept in history | Later; low value with native tool calls |

### 4.2 Stuck and loop detection

Conclave has no detection at all. Every card project ships one, and the cards agree on hashing the tool name plus key-sorted arguments, checking results, and warning before stopping.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Hash window of tool calls, warn at 3, stop at 5 (DeerFlow, OMA, Gemini CLI) | None | Item 5 |
| Result-aware guard: same call, same result; progress tools reset streaks (Hermes) | None | Item 5 |
| Cycle detection A-B-A-B (Hermes, oh-my-pi, OpenFang) | None | Item 5 |
| Third identical failure ends the turn, always on (OpenClaw) | None | Item 5 |
| Denial circuit breaker, 3 in a row (Codex guardian) | Model told not to retry; nothing enforces it | Item 5 |
| Guard window after compaction (OpenClaw) | None | Item 5 |
| Streamed text repetition and runaway output (Gemini CLI, Hermes) | None | Later |
| Small-model loop check after 30 turns (Gemini CLI) | None | Later, after item 5 data |

### 4.3 Budgets, goals and autonomy

Loop mode reruns until a command passes or a phrase appears. There is no judge, no token or time budget, and no spend cap.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Loop until a command passes (Prime gates, aider) | `untilCommand`, 600 s timeout | Reruns even when nothing changed (item 19) |
| Fresh-context judge with continue, done, step back (QM, Mastra, Agent Framework) | None | Item 19 |
| Turn, token and time budgets per goal (Prime, QM, why-the-harness comparison) | `maxIterations` only | Item 19 |
| Nested limit tree for tokens, cost, turns, working time (inspect_ai) | None | Item 24 |
| Ask at spend thresholds, downgrade at the cap (Omnigent) | None | Item 24 |
| Stop hook that keeps the model going (Claude Code) | Done, with `stop_hook_active` | None |
| Confirm before stop for unattended runs (terminus-2) | None | Covered by item 15 verify gate |

### 4.4 Permissions and shell rules

Strong rule engine with one hole. Approval logic is in code per mode, which is fine for now.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Compound commands always ask: `;`, `&&`, `|`, `$( )`, redirects (playbook) | Splits on separators only; substitution and redirects pass prefix rules | Bug (item 1) |
| Before-tool hooks that block or rewrite input (opencode, crush, Claude Agent SDK) | PreToolUse with `updatedInput`, PermissionRequest | None |
| Prefix rules with justification and load-time match tests (Codex execpolicy) | Plain strings | Later (small) |
| Per-mode policy files; ask becomes deny when nobody can answer (Gemini CLI) | Modes in code; routines wait for the phone | Later |
| LLM reviewer for approvals with fail-closed rules (Codex guardian, goose) | None | Item 23 |
| Content-bound durable approvals, first decision wins (open-multi-agent) | In-memory Map, lost on restart | Item 20 |
| Risk score that rises after untrusted reads (Omnigent) | Untrusted agents drop tools | Part of item 23 |

### 4.5 Sandbox, secrets and egress

Commands run bare on the device. The approval layer is the only boundary.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| OS sandbox on by default (Codex) or opt-in (Gemini CLI, Mastra) | None | Item 26 |
| Env allowlist for spawned tools (Omnigent) | `machine/local.ts` copies all of `process.env` | Item 10 |
| SSRF guard, cloud metadata always blocked (agent-vault, Omnigent) | LAN allowed by design; metadata IPs not blocked | Item 10 |
| Credential proxy so keys never enter the sandbox (Omnigent, agent-vault) | `/gw` gateway keys exist for harnesses | Later |
| Report enforcement level, fail closed when unenforceable (DeepSeek Harness, Open Interpreter) | n/a | With item 26 |

### 4.6 Tool output size and compression

Offload and paging exist. The view is a blind middle cut, and stored outputs never expire.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Content-typed reducers for logs, test reports, JSON, diffs (caveman, Headroom) | Head and tail cut | Item 16 |
| Retrieve with a query, BM25 blocks, gap markers (caveman) | `ReadToolOutput` grep by regex | Item 16 |
| Exact line-range markers and 7-day retention (opencode) | Char counts; rows never deleted | Item 16 |
| Typed synopsis for JSON, CSV, code (DeerFlow) | None | Item 16 |
| Elide old write payloads once a newer read or write exists (DeerFlow) | Old Write and Edit inputs sent forever | Item 12 |
| Stale read markers after a later edit (Headroom) | None | Later, at compaction time only |
| Cross-turn dedup with back pointers (Headroom) | None | Later |

### 4.7 Prompt cache stability

The design goal is right and mostly met. Two things break it: the per-turn clearing rule and the per-iteration system prompt rebuild.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Clear old tool output in batches at a token threshold (Gemini CLI, inspect_ai edit) | Cleared by user-turn age (12), so the boundary moves every turn | Item 12 |
| Persist clearing decisions so later requests replay the same bytes (OpenClaw, caveman) | Recomputed each build | Item 12 |
| Frozen injected context, refreshed at start, compaction or removal (claude-mem) | `systemPromptFor` rebuilt every iteration, including the memory profile | Item 12 |
| Volatile-token detector test (Headroom) | None | Item 12 |
| Stable tools first, contextual tools appended (DeepSeek-Reasonix) | Built-ins then MCP | Keep when adding item 18 |
| Cache warming at 0.9 TTL when savings beat a threshold (pi, aider) | None | Later, only with measured approval latency |
| Cache-miss detection (pydantic-ai) | `cacheReadTokens` recorded per call | Metric in item 14 |

### 4.8 Compaction

The structure is right (summary as a message, old rows kept). The summary step is fragile and the content is unstructured.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| LLM-free fallback when the summary fails (QM, OpenClaw) | Returns false; a context overflow then fails the turn | Item 6 |
| Inflation check and failure latch (Gemini CLI) | None; a failing small model is called every turn | Item 6 |
| Verbatim user messages kept with the summary (Hermes, Codex) | Paraphrased by the small model | Item 6 |
| Several overflow compactions per turn with a progress check (OpenClaw, inspect_ai) | One per turn (`compactedThisTurn`) | Item 6 |
| Compaction start and end markers (DeepSeek Harness) | None; auto and manual can overlap | Item 6 |
| Fixed template with update mode against the previous summary (opencode, OpenClaw, Prime) | Free-form; the old summary is re-summarized as transcript | Item 13 |
| Priority-filled summarizer input (OpenClaw) | `renderTranscript` cut to 120,000 chars by `truncateMiddle` | Item 13 |
| Summary audit for headings and exact identifiers (OpenClaw) | None | Item 13 |
| Token count from the last real usage (inspect_ai, DeepSeek Harness, opencode) | chars/4 with flat guesses for blocks and images | Item 8 |
| Kept tail sized by tokens, pairs whole (OpenClaw, DeepSeek Harness) | Fixed 40,000 chars; drops a leading result-only message | Item 13 |
| Background compaction at a soft threshold (QM, pi, aider, Mastra) | Blocking at 80 percent | Later |
| Summary on the main model as a cache-prefix request (opencode, DeepSeek Harness, terminus-2) | Small model, re-rendered transcript at full input price | Later; measure per provider |
| Provider-native compaction (opencode, inspect_ai) | None | Not recommended (section 6) |

### 4.9 Recall and memory

The memory store is broad. Recall after compaction is missing, and some ranking and dedupe rules work against quality.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| FTS recall tool over past messages (Hermes `session_search`) | `messages_fts` exists, used only for the session list search | Item 7 |
| Recovery pointer in the summary (Hermes) | None | Item 7 |
| Rank by re-confirmation, not by retrieval (claude-mem ACT-R) | `recall()` bumps `last_used_at`, which feeds recency | Item 22 |
| IDF veto on fuzzy dedupe (claude-mem) | Merge at cosine 0.92 or Jaccard 0.75, then overwrite | Item 22 |
| Helpful and harmful counters on learned procedures (recursive-improve, ACE) | None | Item 22 |
| Idle-gated extraction with leases and backoff (Codex) | After every turn, no lease, retried every turn | Item 22 |
| Memory flush turn before compaction (OpenClaw, inspect_ai) | PreCompact hook can only add instructions | Item 22 |
| Progressive search: index, timeline, details (claude-mem) | MemorySearch returns full hits | Later |
| Bi-temporal facts (Graphiti) | Update overwrites | Later |

### 4.10 Durability and crash recovery

Scheduler jobs are durable; sessions are not. On boot `engine.ts` (around line 201) sets running, waiting_approval and waiting_input sessions to idle.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Claim per turn, boot sweep, resume budget of 10 (opencode) | Sessions set to idle | Item 20 |
| Intent row before an effect, per-tool replay policy (pi) | None | Item 20 |
| Per-call result commits (open-multi-agent) | One user message after the whole batch | Item 20 |
| Durable approvals bound to a content hash (open-multi-agent) | In-memory Map | Item 20 |
| Durable inbox for queued and steering input (pi) | In-memory arrays | Item 20 |
| Do not auto-resume when many sessions died at once (inspect_ai) | n/a | Item 20 |
| Background subagents as durable jobs (opencode, Mastra) | `void` promise | Items 2 and 21 |

### 4.11 Subagents and orchestration

Task is a clean fresh loop. Background mode is broken, and the parent learns little about how a child ended.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Deliver background results as a synthetic message that wakes the parent (opencode) | Lost | Bug (item 2) |
| Start, wait, continue and list tools (Agent Framework) | None | Item 21 |
| Typed stop reason and tool receipts (DeerFlow) | Last assistant text only; loop errors swallowed | Items 4 and 5 add stop reasons |
| Per-agent iteration budgets (Hermes: parent 500, subagent 50) | One cap of 250 | Item 4 |
| Frozen-diff cross-vendor review (Omnigent) | Review sends 30,000 chars of transcript plus diff | Later |
| Best of N with verification (aider, SWE-agent chooser) | Jury for answers, not code | Later |
| Architect and editor split (aider) | None | Later |
| Seed a native CLI session from the transcript (harbor) | Fresh ACP sessions get 40,000 chars of text without tools | Later |

### 4.12 Edits and verification

Edit matching is good. Nothing checks the result of an edit.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Fuzzy edit cascade (aider, continue) | `edit-core.ts` typography and line-window fallbacks | None |
| Post-edit syntax check, only new errors (aider, SWE-agent) | None | Item 15 |
| Verify gate with a cap of 3 (aider, Prime gates) | Only if the user writes a Stop hook | Item 15 |
| Read-before-write gate keyed by content hash on the message (DeerFlow) | mtime Map in runner memory | Item 17 |
| Per-model edit format (oh-my-pi) | One format | Item 27 |
| LSP diagnostics on write (oh-my-pi) | None | Later |

### 4.13 Tool surface and MCP

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Skills as on-demand procedures (Anthropic Skills) | Done | None |
| Deferred MCP schemas behind a search tool (Mastra, DeerFlow, dsh-mcp-lens) | Every MCP schema on every step | Item 18 |
| Abort signal and timeouts on MCP calls (MCP SDK, DeepSeek Harness) | No signal, no timeout; `makeTool` ignores the context | Item 9 |
| Refresh on `list_changed` (MCP SDK) | Periodic refresh | Later |
| Scan MCP tool definitions for hidden instructions (Agent Governance Toolkit) | None | Later |
| Code mode over MCP tools (opencode, Docker MCP Gateway) | None | Not now (section 6) |
| Small repo map injected at session start (ponytail) | On-demand tool | Later |

### 4.14 Providers, retries and fallbacks

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Retry with backoff, honor retry-after (opencode) | Done; partial message reset on retry | None |
| Credential rotation before model fallback (oh-my-pi, Hermes) | One key per provider | Later |
| Shared in-flight limiter and circuit breaker per provider (DeerFlow, OpenFang) | Each call retries on its own | Later |
| Per-family wire quirks (oh-my-pi) | Some per-provider code | Item 27 |
| Text tool-call extraction for local models (open-multi-agent, continue) | None | Later, local URLs only |

### 4.15 Instructions, skills and prompts

| Technique (source) | Conclave today | Gap |
|---|---|---|
| AGENTS.md in every request (playbook) | Done, root to cwd | None |
| Nested AGENTS.md, closest file wins (agents.md) | Not loaded below cwd | Item 11 |
| Rules loaded by glob (Claude Code rules, cursorrules) | `.claude/rules` with `paths:` skipped and never loaded | Item 11 |
| Mode survives compaction and reaches subagents (caveman, ponytail) | Modes live in the system prompt, so they survive | None |
| Never-cut list beside any be-lean rule (ponytail) | coder.md says follow existing patterns | Prompt change only after item 25 |
| Canary test for load-bearing prompt phrases (ponytail) | Tests check files load, not phrases | Item 25 (S part) |
| Terse output rules (caveman) | BASE.md already says keep replies short | No change; no per-turn reminder |

### 4.16 Traces, evals and self-improvement

Conclave stores everything a trace system needs and computes nothing from it.

| Technique (source) | Conclave today | Gap |
|---|---|---|
| Detector rates per run: loops, errors, recovery, give-ups (recursive-improve, open-multi-agent scorers) | None | Item 14 |
| Run record with prompt version and commit (recursive-improve) | None | Item 14 |
| Ratchet: keep or revert by score, with repeats, margin and held-out tasks (recursive-improve, fixed per its Avoid cards) | None | Item 25 |
| Compaction recall eval (Hermes) | None | Item 25 |
| Paired A/B with control arms and self-tested graders (ponytail, caveman, pi evals) | None | Item 25 |
| Trajectory export (ATIF) and OTel spans (harbor) | Session export as md or json; OTLP metrics ingest only | Later |
| LLM judge for reward hacking on finished runs (harbor analyze) | None | Later |

## 5. Ranked improvement plan

Order: benefit per effort. Effort: S is under 2 hours, M is half a day to a day, L is several days. "Scripted engine" means `test/engine/harness.ts`. Items 1 to 6 are marked **BUILD**: about 9 to 10 hours in total, no new tables, no paid model calls to test.

| Rank | Item | Effort | Build now |
|---|---|---|---|
| 1 | Prefix allow rules never pass substitution or file redirects | S | BUILD (done) |
| 2 | Background Task results reach the parent | S | BUILD (done) |
| 3 | Guard output-limit, refusal and empty replies | S | BUILD (done) |
| 4 | Step budget per runner with a checkpoint note and a toolless wrap-up | S | BUILD (done) |
| 5 | Tool-call loop guard with argument and result hashes | M | BUILD (done) |
| 6 | Compaction that cannot fail the turn | M | BUILD (done) |
| 7 | SessionSearch tool and a recovery pointer in summaries | M | |
| 8 | Token count anchored on the last real usage | S | BUILD (done) |
| 9 | MCP calls stop on abort and on a timeout | S | BUILD (done) |
| 10 | Hub secrets out of tool env; cloud metadata blocked in WebFetch | S | BUILD (done: WebFetch part) |
| 11 | Path-scoped rules and nested AGENTS.md when a file is touched | S | BUILD (done) |
| 12 | Cache-stable context editing and a frozen system prompt per session | M | BUILD (done) |
| 13 | Structured compaction with update mode and budgeted input | M | BUILD (done) |
| 14 | Session health metrics and a per-run record | M | |
| 15 | Post-edit syntax check and an opt-in verify gate | M | |
| 16 | Content-aware output reducers, query retrieval, retention | M | BUILD (done) |
| 17 | Read state as a content hash on the Read result | S | BUILD (done) |
| 18 | Deferred MCP schemas behind ToolSearch | M | BUILD (done) |
| 19 | Loop mode judge, budgets and unchanged-workspace skip | M | |
| 20 | Durable turn recovery and durable approvals | L | |
| 21 | Background task tools (list, wait, result, continue) | M | BUILD (done) |
| 22 | Memory quality: reinforcement, IDF veto, counters, idle extraction | M | |
| 23 | Approval pre-review for unattended sessions | M | |
| 24 | Spend and work limits per session and subagent tree | M | BUILD (done) |
| 25 | Prompt eval harness, compaction recall eval, ratchet routine | L | |
| 26 | OS sandbox for Bash on Linux and macOS devices | L | |
| 27 | Per-family provider quirks and edit variants | M | |

### 1. BUILD (done): Prefix allow rules never pass command substitution or file redirects

- **Problem.** `checkPermission` in `session/permissions.ts` splits Bash commands with `splitBashCommand`, which knows `;`, `&&`, `||`, `|` and newlines only. A prefix rule then matches the whole segment. A script against the current code printed:
  ```
  "git status $(touch /tmp/pwn)" -> allow  Allowed by rule Bash(git status:*)
  "git status `id`"              -> allow  Allowed by rule Bash(git status:*)
  "echo hi > ~/.bashrc"          -> allow  Allowed by rule Bash(echo:*)
  "echo $(curl x)"               -> allow  Allowed by rule Bash(echo:*)
  "git status; rm x"             -> ask
  ```
  `parseCommand` in `tools/bash-rules.ts` already reports these constructs in `unsafe`, and `suggestBashRule` already refuses to suggest prefix rules for them. Only the matching side is missing.
- **Change.** In the Bash allow branch of `checkPermission`, compute `parseCommand(c.content).unsafe` and keep the gated kinds: command substitution, process substitution, redirect to file, read-write redirect, subshell, background job, unterminated quote. When any is present, only an exact rule (no `:*`, no `*`) equal to the whole trimmed command may allow it. Otherwise fall through to the mode logic, which asks (bypass mode still allows, and `dangerousCommand` still applies). Reason text: `Needs approval: command substitution is not covered by Bash(git status:*)`. Redirects to `/dev/null` stay allowed (the parser already exempts them). Optional in the same change: also run deny rules against the body of each `$( )`.
- **Benefit.** Closes the hole the build-your-own playbook names: "anything with `;`, `&&`, `|`, `$( )`, or a redirect always asks: without it, `ls; rm -rf ~` would run because it starts with `ls`." Gemini CLI turns allow into ask on redirection unless a rule sets `allowRedirection`; Codex execpolicy and Claude Code behave the same way.
- **Risk.** More prompts for people with broad rules who redirect output to files. A later rule option can allow redirects inside the workspace.
- **Effort.** S (about 1 hour).
- **Test.** Unit tests (new `test/session/permissions.test.ts` or in `test/tools/bash-rules.test.ts`): the five commands above, `npm test 2>/dev/null` with `Bash(npm test:*)` (allowed), an exact rule that names a command with `$( )` (allowed), bypass mode (allowed), a deny rule hit inside a pipeline (denied). No model calls.
- **Status.** Done in commit 4b4900f (`test/session/permissions.test.ts`). As planned, with these choices: a bare `Bash` rule still allows every command; the optional deny check runs on the bodies of `$( )`, backticks and process substitution, on subshell groups and after a single `&`; ask rules now match any sub-command (the old code checked the whole line only, though its comment said otherwise); `suggestBashRule` suggests an exact rule for every gated construct, so "always allow" covers the command it was offered for.

### 2. BUILD (done): Background Task results reach the parent

- **Problem.** `tools/task.ts` promises "You will be notified when it finishes". `engine/subagent.ts` line 47 runs `void driveSubagent(...)` and returns. Nothing posts the result to the parent session, so the parent model waits for a note that never comes and the user sees nothing in the parent.
- **Change.**
  - In `runSubagent`, background branch: `driveSubagent(...).then((text) => deliverSubagentResult(engine, parent.id, sub, 'completed', text)).catch((err) => deliverSubagentResult(engine, parent.id, sub, 'error', String(err)))`.
  - `deliverSubagentResult` builds one reminder block:
    ```
    <subagent_result session="ses_..." agent="explore" state="completed" description="find callers">
    ...final text, capped at 12,000 chars; the full text stays in the child session...
    </subagent_result>
    ```
  - New `SessionRunner.deliver(block: ContentBlock)`: when the parent is running, push to a `pendingNotes` array that `agentLoop` adds to the next tool-results message (the same place as the todo reminder in `extra`); when idle, enqueue an auto turn whose user message carries the block, with `meta: { auto: true, subagentResult: childId }`. Completions within 2 seconds of each other go into one turn.
  - Child session meta: `background: { parentId, state, finishedAt }`. Skip delivery when the parent is deleted or archived.
- **Benefit.** Makes a documented feature work. opencode's `SubagentCompletion.deliver` writes `<subagent sessionID=... state=...>final text</subagent>` into the parent and wakes it; Mastra and Agent Framework do the same.
- **Risk.** An idle parent wakes and spends tokens when nobody watches. The model asked for it, and items 4 and 5 bound the cost.
- **Effort.** S (about 1.5 hours).
- **Test.** Scripted engine. Extend `startTestEngine` so a script step can be chosen by a predicate on the request body (child and parent requests interleave). Parent calls Task with `run_in_background: true`, child replies with text, then assert the parent transcript has a user message whose reminder holds that text and that a second parent turn ran with `meta.auto`. A second test keeps the parent busy and asserts the note joins the next tool-results message instead of starting a turn.
- **Status.** Done in commit bdf1a82 (`test/engine/background-task.test.ts`), which also adds the harness extensions from section 8. Changes from the plan: the carrier message meta is `subagentResults: string[]` (a list, since one turn can carry several); after a user stop, notes wait for the next turn instead of starting one; a parked (`waiting_reset`) parent picks them up on resume; a parent that is itself a subagent is not woken; the parent shows a notice "Background task finished: ...". `runSubagent` keeps its signature.

### 3. BUILD (done): Guard output-limit, refusal and empty replies

- **Problem.** `runner.ts` line 364 stops only when there are no tool calls. On `stopReason === 'max_tokens'` a call whose cut JSON still parses runs with partial input (for example a Write whose content ends mid-file). `executeTool` only catches the `_raw` case. A refusal that carries tool calls runs them too. A reply with no text and no calls ends the turn silently.
- **Change.** In `agentLoop`, after `updateMessage`:
  - If `stopReason` is `max_tokens` or `refusal` and there are tool calls, do not run them. Write one error result per call: `Not run: your reply hit the output token limit before this call was complete. Send it again in smaller parts, for example a short Write followed by Edit calls.` with `meta: { notRun: 'max_tokens' }`. For `max_tokens` continue the loop; for `refusal` end the turn with a notice.
  - Count length stops in a row; after 2 continuations stop with a notice. In unattended runs (depth above 0, tag `routine`, mode `loop`) a length stop without tool calls gets one continuation note (opencode `CONTINUE_AFTER_OUTPUT_LIMIT`); interactive sessions keep today's notice.
  - Empty reply (no text, no tool calls, `outputTokens === 0`, `end_turn`): remove the empty message and retry once per turn, then notice "The model returned an empty reply."
- **Benefit.** DeerFlow issues #4271 (tool calls ran after a length cap), #3028 (a cut `write_file` ran, then the filter fired again in a loop) and #4393 (a stored empty assistant message broke the thread for good). harbor's terminus-2 and the DeepSeek Harness loop refuse to run calls from a cut reply. Hermes cut its empty-reply retries after seeing deterministic empty completions.
- **Risk.** A call that was in fact complete gets dropped once; the model resends it.
- **Effort.** S (about 1 hour).
- **Test.** Add an optional `stop` field per script step to the scripted SSE builder. Script a Write with `stop: 'max_tokens'`, then assert the file does not exist in the test cwd, the next request carries an `is_error` result containing "Not run", and the loop continued. Script two empty replies and assert exactly two requests and the notice.
- **Status.** Done in commit 8ec7abf (`test/engine/stop-reasons.test.ts`). Changes from the plan: an empty reply is any `end_turn` or `stop_sequence` reply with no visible text and no tool calls, without requiring `outputTokens === 0`, because some providers count reasoning tokens for a reply that shows nothing; the second empty reply is removed too, so no empty assistant row is stored; a refusal without tool calls also ends the turn with a notice.

### 4. BUILD (done): Step budget per runner with a checkpoint note and a toolless wrap-up

- **Problem.** `MAX_ITERATIONS = 250` applies to parents and subagents alike. At the cap the loop posts "Stopped after 250 steps." and returns. The model never summarizes, so a subagent hands back whatever it last wrote and a routine ends without a report.
- **Change.** In `runner.ts`:
  - Replace the constant with a budget: config `limits.maxSteps` (default 250) and `limits.subagentMaxSteps` (default 100), with an optional `maxSteps` on `AgentDef`.
  - At 80 percent, add one reminder to the newest tool-results message (never to a stored older row, so the cached prefix holds): `Step budget: you have used 200 of 250 steps in this turn. Save durable progress now (files, TodoWrite), then continue. Do not stop only because of this note.`
  - At the cap, make one more `streamCompletion` with the same tool specs and `toolChoice: 'none'` (the Anthropic provider maps it to `{type: 'none'}`), plus a final reminder: `You reached the step limit for this turn (250 steps). Do not call tools. Reply with what you finished, what is left, and the next step you recommend.` On a `bad_request` for tool choice, retry once with tools omitted. If the reply still holds tool calls, drop them.
  - `agentLoop` returns a typed result (`{ done: boolean, stop?: 'step_limit' | 'loop_capped' | ... }`) so `engine/subagent.ts` can tell the parent "(the subagent stopped at its step limit)".
- **Benefit.** opencode's step limit appends a summary prompt and sets `toolChoice: 'none'` while keeping tool definitions, so the cached prefix holds. Hermes gives each agent its own iteration budget (parent 500, subagent 50), a one-shot checkpoint warning on the newest tool result, and one toolless grace call.
- **Risk.** Low; one extra call when the cap is hit.
- **Effort.** S (about 1 hour).
- **Test.** Scripted engine with `limits.maxSteps: 3` and a script that always returns a Read call: assert the budget note in the 3rd request, `tool_choice: {type: 'none'}` and the final reminder in the 4th, and that the last stored assistant message is text.
- **Status.** Done in commit 5b28c97 (`test/engine/step-budget.test.ts`). Changes from the plan: `agentLoop` still returns a boolean so its callers (subagents, jury, debate) stay as they are; the typed stop reason is on `runner.lastStop` (`LoopStop`: done, step_limit, loop_capped, output_limit, refusal, empty_reply, rate_limit, hook, harness). Agent frontmatter accepts `maxSteps` or Claude Code's `maxTurns`. The final reminder is stored as an auto user message (`meta.stepLimit`) so later requests replay the same bytes. Subagents that end on the step limit, the loop guard, a refusal, an empty reply or the output limit say so in the text the parent gets. Follow-up (branch feat/loop-guard): the toolless call is now `finalAnswerTurn` in `runner.ts` and also runs after a loop-guard stop; both reminders ask what was done, what was found and what is left.

### 5. BUILD (done): Tool-call loop guard with argument and result hashes

- **Problem.** Nothing notices repetition. A model can call the same tool with the same input and get the same result until step 250. This costs most in subagents, routines and loop mode, where nobody watches. After a phone denial the model can try small variants of the refused command.
- **Change.** New `session/loop-guard.ts`, pure and free of I/O:
  ```ts
  type Verdict = {
    level: 'ok' | 'warn' | 'halt';
    code?: 'repeat' | 'cycle' | 'same_error' | 'denied' | 'frequency' | 'after_compaction';
    message?: string;
  };
  class LoopGuard {
    constructor(opts: { unattended: boolean });
    before(tool: string, input: unknown): Verdict;   // refuse a call already halted this turn
    after(tool: string, input: unknown, result: ToolResultBlock): Verdict;
    armAfterCompaction(): void;                      // 3-call window
  }
  ```
  - Signature: tool name plus sha256 of key-sorted JSON input. Result hash: sha256 of the result text.
  - Same signature and result 3 times in a row: warn. 5 times: halt.
  - Same signature failing with the same error 3 times in a row: halt, always on (OpenClaw).
  - Cycles of period 2 to 4 with identical results: warn after 3 laps, halt after 5 (Hermes, oh-my-pi).
  - 3 denials in a row in one turn (user, rule or hook): halt (Codex denial breaker).
  - One tool used more than 60 times in a turn: warn once.
  - After a compaction, 3 identical signature and result pairs in the next 3 calls: halt (OpenClaw post-compaction guard).
  - A successful Edit, Write, MultiEdit or NotebookEdit, or a Bash call whose result changed, resets failure streaks, so "edit, rerun the tests" never counts. BashOutput is a poller and is exempt from repeat rules.
  - Wiring: one guard per user turn in `agentLoop`; `executeTool` calls `before` and `after`. Warnings go as one reminder in the `extra` blocks after the tool results (tool_use and tool_result stay adjacent, which OpenAI and Moonshot require, per DeerFlow), each code once. In unattended runs a halt ends the loop with a notice and stop reason `loop_capped`. In interactive sessions the first halt becomes a strong warning and the second ends the turn (Gemini CLI recovers once, then stops).
- **Benefit.** Hermes code comments cite a model that re-ran one empty probe 147 times unflagged; OpenClaw ships a 940-line test file for its detector; Gemini CLI, DeerFlow, open-multi-agent and oh-my-pi each ship one. recursive-improve's rule (same tool name 3 times) would fire on three reads of different files, so this follows its Avoid card and hashes arguments.
- **Risk.** False positives on polling or legitimate retries. Mitigated by result hashing, exemptions, progress resets and warn-first.
- **Effort.** M (about 2.5 hours).
- **Test.** Unit tests on `LoopGuard` with event lists: 5 identical reads halt; reads of 3 different files never fire; failing test, Edit, same failing test does not fire; A-B-A-B-A-B warns; 3 identical errors halt; 3 denials halt; post-compaction window halts. Scripted engine: a subagent that sends the same Grep 6 times stops after the 5th with a notice, and the 4th request carries the warning reminder.
- **Status.** Done in commit 3237ae8 (`test/session/loop-guard.test.ts`, `test/engine/loop-guard.test.ts`). Changes from the plan: the runner calls `before` and `after` around `executeTool` in the loop, not inside it, so a parallel batch is fed in tool_use order; stored-output ids are masked before hashing so equal large outputs match; denial results now carry `meta.denied` (`user`, `rule` or `hook`); in an interactive turn the stopped call is refused if sent again and that counts as the second trip; a stop writes an audit row `loop_guard`. Follow-up (branch feat/loop-guard): a stop used to end the loop with the last assistant message holding only tool calls, so subagents returned "(the subagent produced no final answer)". It now runs the same toolless final-answer call as the step limit (item 4), and every warn or halt is logged.

### 6. BUILD (done): Compaction that cannot fail the turn

- **Problem.** `maybeCompact` returns false when the small model errors, times out or returns nothing. On a `context_length` error the runner then rethrows and the turn ends in error. `compactedThisTurn` allows one compaction per turn, so a long tool loop that fills the window twice fails. A failing small model is called again on every later turn. Nothing checks that the summary is smaller than what it replaces. Early user instructions survive only as the small model paraphrased them.
- **Change.** In `session/compaction.ts`:
  - Deterministic sections appended to every summary: `## User messages (verbatim, newest first)` with each real user message in the compacted region (skip reminders and auto messages), 24,000 chars total and 4,000 per message; `## Files touched` from `file_path` inputs of Read, Edit, Write and MultiEdit in the region (at most 40).
  - LLM-free fallback when the summary call fails or is rejected: store a summary whose text is `[Context reduced without a new summary. Earlier messages are excluded, not deleted. Check the real state before repeating actions whose outcome is missing.]`, then the previous summary text if any, then the deterministic sections. Set `meta.qualityDegraded = true` and post a warning notice.
  - Inflation check: reject a summary whose token estimate is not smaller than the region it replaces.
  - Failure latch: after one failed model summary, set session meta `compaction.latchedUntil = now + 30 min`; auto compaction uses the fallback until then; manual `/compact` always tries the model.
  - One compaction at a time per session (a Set of session ids on the engine), and `engine.audit` rows `compaction:start` and `compaction:end` with the covered seq range, model and token counts.
  - In `runner.ts`: replace `compactedThisTurn` with a counter, at most 3 per turn, and continue only when the new estimate is below the old one.
  - In `transcript.ts`: the `<conversation_summary>` wrapper says the text is a framework summary, not a message from the user (inspect_ai).
  - Summary meta shape: `{ coversThroughSeq, trigger, compactedAt, qualityDegraded?: boolean, fallback?: 'no_llm', userMessages: number }`.
- **Benefit.** Hermes's lean compaction, with verbatim user messages and a recovery pointer, scored 68.3 percent recall at 49K tokens kept against 45.8 percent at 162K for its old default (SCORECARD-2026-08-15). QM and OpenClaw keep a no-summary path so the next turn does not wait on the same failure. Gemini CLI's latch and inflation check stop repeated failing calls. Codex also keeps recent user messages verbatim (20,000 tokens) and puts the summary after them.
- **Risk.** The fallback carries less meaning than a summary. It runs only on failure and is flagged.
- **Effort.** M (about 2 to 2.5 hours).
- **Test.** Scripted engine with a chore handler that returns HTTP 500 (extend the harness so tool-less requests can be scripted too): force auto compaction with a tiny `compactAt` and assert a summary with `qualityDegraded`, the verbatim section and no error status; a second auto compaction inside the latch makes no chore request; a chore reply larger than the region is rejected. Unit tests for the verbatim section (budgets, reminder skipping). A region test with HEAD, MID and TAIL sentinels (as in Hermes `test_region_scoping.py`): only MID text reaches the summarizer request.
- **Status.** Done in commit 3671e42 (`test/session/compaction.test.ts`, `test/engine/compaction.test.ts`). Changes from the plan: auto turns with plain text (a routine's prompt) count as user messages for the verbatim section, since generated nudges are reminders and drop out anyway; summary meta also stores `verbatim` and `files` so the next compaction carries them forward; the summary call has a 120 s timeout; a good summary clears the latch. The runner allows another compaction in the same turn only while the previous one shrank the request.

### 7. SessionSearch tool and a recovery pointer in summaries

- **Problem.** After compaction the model cannot reach exact details from the compacted region, although the rows stay in SQLite and `messages_fts` indexes them. MemorySearch covers extracted memories only.
- **Change.** New read-only `tools/session-search.ts`. Mode by arguments: discover `{query, limit (default 3, max 10), after?, before?}`; scroll `{session_id, around_message_id, window <= 20}`; read `{session_id}` returns the first 20 and last 10 messages at 2,000 chars each. Discover hydrates only the top hit (5-message window, 4,000 chars) and returns the matched message for the rest. The current session is searched only for rows covered by its latest summary. Subagent sessions are hidden; routine sessions rank below interactive ones. Zero hits return an FTS syntax hint. `storage/repos.ts` gets `MessageRepo.search(query, opts)` over `messages_fts` with `bm25()`. The summary footer from item 6 adds: `N earlier messages remain stored. If you need a detail this summary lacks (exact command output, file contents, error text), call SessionSearch with session_id="..." instead of guessing.` Not offered to untrusted agents; chat switches treat it as a memory tool.
- **Benefit.** Hermes SCORECARD-2026-09-19 (3 real 500K transcripts, 45 questions): summary alone 43.3 percent recall, summary plus one session_search round trip 78.9 percent at 55K kept. The pointer was worth 20 to 43 points across runs.
- **Risk.** Large returns (Hermes issue #114344: one read added 74K chars); hence the hard caps.
- **Effort.** M (about 3 hours).
- **Test.** Repo unit test on a temp DB with seeded messages (ranking, hidden subagent sessions, compacted-only rule for the current session); tool test through `test/tools/helpers.ts`; compaction test asserts the footer names the session id.

### 8. BUILD (done): Token count anchored on the last real usage

- **Problem.** `estimateRequestTokens` counts chars/4, uses 2,000 for any non-string tool result and 1,500 per image, and rescans the whole request each step. chars/4 undercounts JSON schemas and CJK text (DeepSeek Harness README), so compaction can fire only after the provider already rejected the request.
- **Change.** The runner keeps `meter = { model, systemHash, toolsHash, baseTokens, throughSeq }`, set after each `streamCompletion` with `baseTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` (inputTokens excludes cache on every provider, per DESIGN.md section 7). The next estimate is `baseTokens` plus chars/4 of stored messages with `seq > throughSeq` when model and hashes match; otherwise today's full estimate. Reset after compaction and on a model switch.
- **Benefit.** inspect_ai, DeepSeek Harness and opencode all trigger from provider-reported usage plus a delta.
- **Risk.** Low; the fallback is today's estimate.
- **Effort.** S.
- **Test.** Unit test with a fabricated usage record; scripted engine where the mock reports `input_tokens: 190000` on a 200K model and compaction runs before the next request although chars/4 is small (extend the mock to set usage per step).
- **Status.** Done in commit e4c2db8 (`test/session/compaction.test.ts`, `test/engine/compaction.test.ts`): the runner keeps a meter from each call and estimates the next request from it. Change from the plan: the estimate is the larger of the metered and the full chars/4 count, so a provider that reports no usage never delays a compaction. The meter also resets after a clearing batch (item 12).

### 9. BUILD (done): MCP calls stop on abort and on a timeout

- **Problem.** `extensions/mcp.ts` `makeTool` ignores the tool context, and `callTool` passes no signal or timeout to `client.callTool`. A user stop does not cancel a hung MCP call, and `executeTool` awaits it. No tool except Bash has a time limit.
- **Change.** Add `timeoutMs?: number` to `Tool` in `tools/types.ts`. `makeTool` passes `ctx.signal` and a per-server timeout (`mcpServers.<name>.timeoutMs`, default 120,000) as request options: `{ signal, timeout, resetTimeoutOnProgress: true, maxTotalTimeout }`. In `executeTool`, race `tool.run` against `AbortSignal.any([signal, AbortSignal.timeout(ms)])` and return `Error: tool call timed out after N s` with `meta.code = 'TOOL_TIMEOUT'` when a tool ignores the signal.
- **Benefit.** DeepSeek Harness timeout policy; MCP TypeScript SDK client hygiene (signal, progress reset, total cap).
- **Risk.** A slow healthy tool gets cut; per-server override.
- **Effort.** S.
- **Test.** A stdio MCP fixture that sleeps; assert that abort returns within 200 ms and that the timeout returns the error text.
- **Status.** Done in commit e677bc7 (`test/extensions/mcp-timeout.test.ts`): MCP calls carry the signal, the server's `timeoutMs` (default 120 s), progress reset and a total cap of 5 times the limit; the runner lets go of a tool with `timeoutMs` at the limit or on a stop (`runBounded`). Built-in tools keep honoring their own signals.

### 10. BUILD (done, WebFetch part): Hub secrets out of tool env; cloud metadata blocked in WebFetch

- **Problem.** `machine/local.ts` (around line 474) copies all of `process.env` into every exec and spawn, so Bash and ACP harness processes inherit any key the hub was started with. `tools/webfetch.ts` allows LAN hosts by design, but nothing stops `http://169.254.169.254/` or other cloud metadata endpoints.
- **Change.** An env filter in `machine/local.ts` and the daemon exec path: drop names matching `/(API_KEY|_TOKEN|_SECRET|PASSWORD|PRIVATE_KEY)$/i` and hub internals unless listed in config `tools.envPassthrough`; env set explicitly by `engine.harnessEnv` stays. In WebFetch: resolve the host once, refuse 169.254.0.0/16, `fd00:ec2::254`, `metadata.google.internal`, 100.100.100.200 and 168.63.129.16 on the first hop and every redirect hop, and connect to the resolved address so a second lookup cannot rebind.
- **Benefit.** Omnigent (deny-by-default env for ACP spawns, resolve-once SSRF pinning, cloud trap networks), agent-vault netguard (cloud metadata always blocked).
- **Risk.** A build that reads a token from the hub env breaks; the passthrough list and a Settings note cover it.
- **Effort.** S.
- **Test.** Unit tests on the env filter and the URL guard, including a redirect to 169.254.169.254.
- **Status.** WebFetch part done in commit 9fa49ee (`test/tools/webfetch-guard.test.ts`): the host is resolved once per hop and metadata addresses and names are refused on every hop, including a name that rebinds between hops. Change from the plan: only plain http connects to the checked address (with the name in the Host header); https keeps the name, since TLS binds the connection to it and metadata services answer plain http only. A name that does not resolve here (behind a proxy) goes on without an address. The env filter (10a) was not in this round.

### 11. BUILD (done): Path-scoped rules and nested AGENTS.md when a file is touched

- **Problem.** `extensions/instructions.ts` loads instruction files from the repo root down to cwd only. `.claude/rules` files with `paths:` are skipped, with a comment saying they load when a matching file is touched, but nothing loads them. AGENTS.md files below cwd never load.
- **Change.** New `loadScopedInstructions(machine, cwd, path)` returns AGENTS.md and CLAUDE.md files between cwd and the file's directory, plus rules whose `paths` globs match. After a successful Read, Edit, Write or MultiEdit, `executeTool` appends any not yet injected as a reminder on the tool result (at most 4,000 chars per file), tracked in session meta `scopedInstructions: string[]`.
- **Benefit.** The agents.md convention (closest file wins, keep it a map), Claude Code path rules and Cursor glob rules. The playbook calls AGENTS.md the cheapest improvement for any harness.
- **Risk.** Context growth; capped and once per session.
- **Effort.** S.
- **Test.** `test/machine/fake-machine.ts` with nested files and a rule with `paths: src/api/**`; assert injection on first touch only.
- **Status.** Done in commit fcd3b25 (`test/extensions/instructions.test.ts`, `test/engine/scoped-instructions.test.ts`): `loadPathRules` and `loadScopedInstructions` in `extensions/instructions.ts`, shown on the result of the first Read, Edit, Write or MultiEdit under them, after the offload so a long result never cuts them. Change from the plan: a compaction or /clear resets `meta.scopedInstructions`, since the results that carried the files left the context.

### 12. BUILD (done): Cache-stable context editing and a frozen system prompt per session

- **Problem.** `transcript.ts` clears results over 2,000 chars once they are 12 user turns old. Each new user turn moves that boundary, so one older message changes and the Anthropic cache misses from that point on, even when the window is far from full. `engine.systemPromptFor` rebuilds the system prompt on every loop iteration and reads instruction files from the device each time; memory extraction after a turn can change the profile block, which sits before the first breakpoint.
- **Change.**
  - Replace the age rule with a batch rule: protect the newest 50,000 tokens of tool output; when older prunable output passes 30,000 tokens, clear all of it in one pass and persist `meta.cleared = { at, chars }` on each stored `tool_result`, so later builds send the same bytes. Exempt TodoWrite, Skill, MemorySearch, SessionSearch and Task results. Stub old Write and Edit inputs over 2,000 chars once a later Read or Write of the same path succeeded.
  - Snapshot the system blocks on the runner; refresh at session start, after compaction, on a memory removal or edit, and when an instruction file's mtime changes (checked at most once per user turn).
  - A unit test that scans `buildSystemPrompt` output for volatile tokens: UUIDs, JWT shapes, ISO datetimes, 32, 40 or 64 char hex.
- **Benefit.** Gemini CLI batches masking (protect 50K, trigger at 30K) and OpenClaw replays persisted projections for exactly this reason; Anthropic cache reads cost 0.1x the input price, so a miss on a 100K-token prompt costs about ten times a hit. Hermes's eval warns against making tool-output deletion the main strategy, so this stays a batch step and compaction stays the main tool.
- **Risk.** Context grows more between batches; compaction still bounds it.
- **Effort.** M.
- **Test.** Build provider messages for a recorded long session (fixture from `exportSession` json) before and after one more user turn and assert the bytes up to the last cache breakpoint are equal; unit tests for batch thresholds and write elision; the volatile-token test.
- **Status.** Done in commit 805b602 (`test/session/context-edit.test.ts`, `test/engine/cache-stability.test.ts`): `session/context-edit.ts` plans and stores the batch, and the system prompt is a snapshot on the runner. Over a 40-turn session with 120 requests the prefix broke 5 times (once per batch) against 27 times under the old 12-turn rule. Changes from the plan: the long session is built in the test rather than taken from an export; instruction files and skills are read again once per user turn and compared as text (this also catches a new file, which an mtime check would miss); `clearToolResultsAfterTurns: 0` still turns clearing off. Cleared results are read back by their tool call id when they were never offloaded.

### 13. BUILD (done): Structured compaction with update mode and budgeted input

- **Problem.** `COMPACT_PROMPT` is free-form. A second compaction re-summarizes the first summary as plain transcript with no merge rules. `renderTranscript` cuts the input at 120,000 chars with `truncateMiddle`, which drops the middle, including old user asks. `recentToKeep` keeps a fixed 40,000 chars whatever the window.
- **Change.**
  - `COMPACT_PROMPT` becomes a template: Objective; User constraints and preferences; Decisions (with reasons); Work state (Done, Active, Blocked); Pending user asks (exact wording, newest first); Exact identifiers; Relevant files (at most 15, with a reason); Next step. Rules: one-line bullets; keep paths, commands, error strings and ids exact; a check that ran and failed is a decision; do not restate project instructions.
  - When the region starts with a summary, pass it as `<previous-summary>` with update rules (newer wins, move finished work to Done, drop resolved blockers), and pass the newest assistant text of the kept tail as `<recent-state-anchor>` (Prime).
  - Summarizer input by priority fill instead of `truncateMiddle` (OpenClaw): newest entries up to 50 percent of the budget, older user messages 25 percent, oldest entries 10 percent, 8 sampled runs across the rest, gap markers that state counts.
  - A deterministic anchor index (Hermes): PR and issue numbers, commit SHAs, branches, paths, error names and URLs, capped per kind.
  - Audit (OpenClaw): all headings present and up to 12 identifiers from the last 10 messages appear; one retry listing the failures; else store the best attempt with `qualityDegraded`.
  - Kept tail sized from the window (Hermes: 2.5 percent clamped to 10K..25K tokens), cut only at a real user message so tool pairs stay whole.
- **Benefit.** opencode reports that update-mode summaries bloated until the template got strict rules; OpenClaw ships tests for the audit; Hermes's anchor index took one transcript from 23.3 to 60.0 percent closed-book recall.
- **Risk.** Prompt changes can lower recall in ways unit tests miss. Gate behind the compaction recall eval (item 25) before making it the default.
- **Effort.** M.
- **Test.** Unit tests for the priority serializer (a 2,000-message case samples every tenth of history), the audit and the anchor extractor; scripted engine asserting the chore request holds `<previous-summary>` on a second compaction.
- **Status.** Done in commit be77569 (`test/session/compaction.test.ts`, `test/engine/compaction.test.ts`), including an engine test where a compaction keeps the pending user asks and the file names and retries once on the audit. Changes from the plan: the state anchor goes with every compaction, not only in update mode; the anchor index is an appended section of the summary; a draft that still fails the audit after the retry is kept with `qualityDegraded` and `meta.audit`, and the latch is not set. Not yet gated behind the recall eval (item 25).

### 14. Session health metrics and a per-run record

- **Problem.** Every message, `isError` flag, `durationMs`, usage row and audit row is stored, but nothing turns them into rates that show where an agent, model or prompt version struggles.
- **Change.** New `usage/health.ts` with `computeSessionHealth(messages, usage)`, run when a session goes idle (debounced) and by a nightly scheduler job. Row shape:
  ```ts
  {
    sessionId, agent, model, mode,
    promptHash,            // sha256 of BASE.md + mode note + agent prompt
    appVersion, turns, toolCalls,
    toolErrorRate,         // from isError, not a regex
    repeatRuns,            // identical signature 3+ in a row
    recoveryRate,          // error followed by success of the same tool
    denials, compactions, degradedCompactions,
    stepLimitHits, loopGuardHits, outputLimitHits, emptyReplies,
    durationMs, tokens, costUsd,
  }
  ```
  Stored in a `session_health` table. The usage page groups by agent, model and `promptHash`, and marks a rate with fewer than 10 runs as directional.
- **Benefit.** recursive-improve's detectors with the fixes its own Avoid cards ask for (structured `isError`, argument hashes, a confidence tag for small samples); open-multi-agent's no-progress and duplicate-work scorers; the regression-finder skill (split sessions by harness version, model or week). It also supplies the data item 25 needs.
- **Risk.** Low; the metrics are hints, never gates.
- **Effort.** M.
- **Test.** Fixture transcripts (json from `exportSession`) per detector, including false-positive fixtures: grep output that contains the word "error", three reads of different files.

### 15. Post-edit syntax check and an opt-in verify gate

- **Problem.** An Edit or Write that breaks syntax is found only when the model runs something later. Nothing checks the work before the model stops.
- **Change.**
  - In `tools/edit-core.ts` and `tools/write.ts`, after a write, check by extension on the hub: `Bun.Transpiler` scan for ts, tsx, js, jsx, mjs and cjs; `JSON.parse` for json; `python3 -m py_compile` through `machine.exec` (5 s) for py when python3 exists. Report only errors that were not there before the edit (SWE-agent's rule), with 3 lines of context, as a note on the tool result. Warn, never reject.
  - Verify gate: a session or project setting `verifyCommand`. In the stop path of `agentLoop`, if this user turn edited files, run it with a timeout; on failure add a reminder with the last 100 lines and continue; at most 3 times per user turn, then a notice "verification still failing". Off for chat.
- **Benefit.** aider runs lint and tests after edits with `max_reflections = 3` and used that as the plausibility gate for 26.3 percent on SWE-bench Lite (previous top 20.3); SWE-agent's paper ablates its lint guardrail; the test-drive comparison found one overnight run self-passed 31 of 40 tasks against 18 by a human, so checks must not come from the agent's own claim.
- **Risk.** Slow test commands lengthen turns; opt-in and capped.
- **Effort.** M.
- **Test.** Unit tests with planted syntax errors per language and a file that was already broken (no new report); scripted engine with `verifyCommand: 'test -f done.txt'` where the script creates the file on the second round.

### 16. BUILD (done): Content-aware output reducers, query retrieval, retention

- **Problem.** Large outputs are cut in the middle (`truncateMiddle` in `runner.ts`, `truncateMiddleOut` in `bash.ts`); for test and build logs the middle often holds the failure. `tool_outputs` rows are never deleted.
- **Change.**
  - New `tools/compress/`: a detector in fixed order (strict JSON, test report, diff, search results, log, text) and reducers. Log: first 2 and last 2 lines, every ERROR, FAIL, WARN, traceback and stack-frame line with 3 lines of context, the rest collapsed into `... N lines elided: <counts> ...`. Test report: counts and every failure. JSON arrays: first and last items, error items, a schema line. Diff: hunks around changes; dropped files are named. Return the original when the result is not smaller. Applied before the head and tail cut; the full text stays behind the output id.
  - `ReadToolOutput` gets `query`: BM25 over blocks, top 20 in source order with `[... non-adjacent ...]` markers, full text when nothing matches.
  - A scheduler job deletes `tool_outputs` rows older than 30 days, except for pinned sessions, and rows of deleted sessions.
- **Benefit.** caveman's README: logs 22,810 to 348 tokens, test output 18,806 to 203, whole Claude Code sessions 33.2 percent fewer input tokens with 18 of 18 answers right (3 runs, older engine). Its gap marker exists because ranked lines placed side by side caused wrong answers. It had no HTML reducer and HTML sessions got 9.9 percent worse, so this plan skips HTML.
- **Risk.** A lossy view hides the one needed line; the note names the id and the query mode. Reducers must be deterministic so the same bytes go out every turn.
- **Effort.** M.
- **Test.** Fixture outputs (bun test, pytest, tsc, cargo, npm) with golden reduced text; every error line survives; `reduce(reduce(x)) === reduce(x)`.
- **Status.** Done in commit abf813f (`test/tools/compress.test.ts`, `test/engine/retention.test.ts`): `tools/compress/` with reducers for test reports, logs, JSON, diffs and grep output, ReadToolOutput `query` (BM25), and a daily `outputs.prune` job. On the fixtures: pytest 16,863 to 1,417 chars, an npm build log 16,233 to 1,055, a JSON list 12,756 to 1,561. Changes from the plan: text counts as a log only when it looks like one (levels or timestamps, or error lines in text that is not code), so a list of numbers or a code dump keeps the plain cut; the bun and tsc fixtures are short and come back unchanged; pytest is hand-written in its usual format, since pytest is not installed here.

### 17. BUILD (done): Read state as a content hash on the Read result

- **Problem.** `staleCheck` uses an mtime Map in runner memory. It is empty after a hub restart (safe, but every edit then needs a re-read), it survives compaction although the model no longer sees the content, and it misses changes that keep the mtime.
- **Change.** Read results store `meta.readMark = { path, sha256, mtimeMs }`. Edit and Write look up the newest mark for the path in the active messages and compare hashes when mtimes match; the Map stays as a cache. Payloads of blocked Edit and Write calls are stubbed in later requests.
- **Benefit.** DeerFlow's read-before-write gate (issue #3857: append-only writes made an agent repeat a report section 5 times; #6019: an error result opened the gate).
- **Risk.** Hashing large files; skip above 4 MB.
- **Effort.** S.
- **Test.** Tool tests with a fake machine: same mtime but changed content is refused; a compaction that drops the Read refuses the edit.
- **Status.** Done in commit f78c656 (`test/tools/read-marks.test.ts`, `test/engine/read-marks.test.ts`): Read, Edit, Write, MultiEdit and NotebookEdit results carry `meta.readMark`, the runner hands tools `readMark(path)` from the active messages, and the hash decides over the mtime. A refused Write or Edit sends its payload once only. Change from the plan: an mtime that moved without a change now passes too.

### 18. BUILD (done): Deferred MCP schemas behind ToolSearch

- **Problem.** `toolsFor` sends every cached MCP tool schema on every step.
- **Change.** When MCP tools exceed `mcp.deferAbove` (default 30), send built-ins, a ToolSearch tool and promoted MCP tools only. ToolSearch ranks by IDF over name, title, server, description and parameter names (dsh-mcp-lens weights) and returns exact schemas of the top 5. Promoted tools are those named by a ToolSearch result still in the active messages (Mastra context mode), so compaction unloads them and no table is needed. Promoted specs go after the fixed set. A call to a tool that is not promoted returns "call ToolSearch first".
- **Benefit.** Anthropic reports about 85 percent fewer tool-definition tokens and MCP eval accuracy from 49 to 74 percent with its tool search (Opus 4); dsh-mcp-lens keeps 1,114 standing bytes against 647,962 for a 1,000-tool catalog.
- **Risk.** One extra round trip; each promotion changes the tool array once (a cache break), so group promotions.
- **Effort.** M.
- **Test.** Ranker unit test on a fixture catalog (Recall@5 on a dozen queries); scripted engine asserting the tools array before and after a ToolSearch call.
- **Status.** Done in commit 20e32e0 (`test/engine/tool-search.test.ts`): Recall@5 11 of 12 on a 45-tool catalog; the first request's MCP part went from 16,572 to 2,196 chars (87 percent less). Changes from the plan: no title field is ranked (MCP tools do not keep it); ToolSearch's description lists every MCP tool of the session, so it stays the same as tools load.

### 19. Loop mode judge, budgets and unchanged-workspace skip

- **Problem.** `loopCheck` knows `untilText` and `untilCommand` with `maxIterations` only. It reruns the command even when nothing changed, has no token or time cap, and no independent judge.
- **Change.** `modeConfig.loop` gains `untilJudge { criteria: string[], model? }`, `maxTokens` and `maxMinutes`. The judge is a fresh-context call (small model, or a different provider family from the worker) with the objective, criteria, last assistant text, git diff (40,000 chars) and the last check output; strict JSON `{ verdict: 'done' | 'continue' | 'needs_user', reasons }`; parse failure means continue; done needs cited evidence. `untilCommand` runs first as the cheap gate and is skipped with a note when the git snapshot (status, diff, untracked file hashes) matches the one from its last failure (Prime gates). Budgets come from usage rows; at the cap one wind-down prompt (QM). No judging while background children run.
- **Benefit.** QM's governor, Mastra's goal judge, Agent Framework's `with_judge`, Prime's gates; the test-drive comparison's rule that the agent must not grade itself.
- **Risk.** Judge cost and false "done"; cap judge loops at 5.
- **Effort.** M.
- **Test.** Scripted chore replies for the judge JSON (done, continue, garbage); fake machine for the unchanged-snapshot skip.

### 20. Durable turn recovery and durable approvals

- **Problem.** On boot the engine sets running, waiting_approval and waiting_input sessions to idle. The in-flight turn, the queue, steering messages, session-scoped allows and pending approvals (an in-memory Map) are lost. Tool results are written once per batch, so a crash mid-batch loses results of tools that already ran.
- **Change.**
  - `sessions` gets `claimed_at` and `resume_attempts`: set in `drain`, cleared on a normal end, an error and a user abort, not on SIGTERM.
  - New tables `tool_intents (tool_use_id, session_id, tool, started_at, finished_at)` and `approvals (id, session_id, tool_use_id, request_hash, content_json, decision, decided_at)`.
  - `executeTool` writes the intent before running and each result as it completes.
  - Boot recovery replaces the idle flip. If more than 3 sessions (or 20 percent of active ones) were claimed, assume a shared cause, resume none, send one notification (inspect_ai). Otherwise, per session: a dangling call with no intent counts as not started; an intent plus a read-only tool is rerun; anything else gets a result "interrupted by a hub restart and may have partly run; check before retrying". If a non-read-only call was interrupted, park in waiting_input with a card; else write `resume_attempts + 1` first and enqueue a continue message through the `session.resume` job, giving up after 10.
  - Pending approvals are raised again from the table. Decisions use `UPDATE approvals SET decision = ? WHERE id = ? AND request_hash = ? AND decision IS NULL`, and the signed phone link carries the hash, so a link minted for one command cannot approve a changed one.
  - Queued and steering inputs persist as messages with kind `queued`.
- **Benefit.** opencode's restart sweep and per-turn budget of 10; pi's intent row and replay policy; QM's partial-turn settle with the stop cause; open-multi-agent's content-bound approvals. opencode's own comment says blind resume is at-least-once, hence the park for unsafe calls.
- **Risk.** Duplicate side effects if the rules are wrong. Ship settle-and-notify first and auto-resume second.
- **Effort.** L.
- **Test.** Engine test: write a session with a dangling `tool_use`, construct a new Engine on the same DB, assert the settled results, status and scheduled job. Subprocess test: SIGKILL a hub running a slow scripted model mid-turn, restart it, assert recovery.

### 21. BUILD (done): Background task tools (list, wait, result, continue)

- **Problem.** After item 2 the parent hears when a child ends, but cannot list, wait for, read or continue children, and a restart leaves them "running".
- **Change.** TaskList, TaskWait `(ids, timeoutSec <= 300, 0 for a snapshot)`, TaskResult `(id)` and TaskContinue `(id, text)` over child sessions (`Session.parentId`). Status: running, completed, failed, lost. Boot marks running children lost and tells the parent. When the parent tries to end its turn with children still running, one reminder lists them.
- **Benefit.** Agent Framework's background agents provider; Prime's `collect` with a 0 timeout as a snapshot; Mastra's deferred disposition.
- **Risk.** Low.
- **Effort.** M (depends on items 2 and 20).
- **Test.** Scripted engine with two background children; TaskWait returns the first to finish; boot test marks a child lost.
- **Status.** Done in commit d258fa6 (`test/engine/background-tools.test.ts`) over the state `engine/subagent.ts` already keeps (`meta.background`); workflow runs keep their own journal and are not listed. Changes from the plan: the tools are offered only once the session started a background task, so other sessions pay nothing for their schemas; the end-of-turn reminder is for unattended runs (subagents, routines), since an interactive parent is woken by the result anyway; a lost child's note waits for the parent's next turn instead of waking it.

### 22. Memory quality: reinforcement, IDF veto, counters, idle extraction

- **Problem.** `recall()` bumps `last_used_at` and `use_count` on every injection, and `rank()` uses `max(updatedAt, lastUsedAt)` for recency, so injected memories look fresh and get injected again. `findDuplicate` merges at cosine 0.92 or Jaccard 0.75 and `save()` overwrites the old content, so two facts that differ only in a version number collapse into one. Extraction runs after every turn with no lease, can process the same messages twice, retries a failing model every turn, and has no way to say "nothing to keep" apart from a parse failure.
- **Change.**
  - Stop recency bumps on recall. Add `reinforced_days` (at most 10 ISO days), appended when a duplicate is saved again or extraction updates an id; rank by ACT-R strength.
  - IDF veto before any fuzzy merge: a rare token present on one side only (df at most 10, split on whitespace) blocks the merge; overwrite only on an exact normalized match.
  - Helpful and harmful counters on procedure memories, bumped by session outcome (verify gate pass or fail, a user correction right after injection); remove at 3 harmful.
  - Extraction after N idle minutes with a lease in kv, an explicit `{"skip": "reason"}` reply and one retry that restates the schema.
  - Optional memory flush turn before compaction (MemorySave and MemorySearch only, small model, once per compaction).
- **Benefit.** claude-mem's veto was checked on a 7,651-observation database (cosine 0.80 plus veto, F1 about 0.95); recursive-improve and the ACE paper (about +10.6 percent on agent benchmarks) for counters; Codex's idle-gated, leased extraction; Anthropic's memory tool plus context editing, 39 percent better on an internal search eval (inspect_ai card).
- **Risk.** Ranking changes what gets injected; ship behind a setting.
- **Effort.** M.
- **Test.** Store unit tests with version-number pairs, reinforcement days and harmful pruning; extraction tests with a scripted `complete()`.

### 23. Approval pre-review for unattended sessions

- **Problem.** Routines and subagents that need approval wait for the phone, and the owner gets pushes for low-risk calls.
- **Change.** Opt-in per agent or routine. Before `notifyEvent('approvalNeeded')`, one small-model call over a trimmed transcript (all user messages kept, at most 40 other entries within 20,000 tokens, tool outputs capped at 1,000 tokens) plus the exact call; strict JSON `{ outcome, risk, rationale }`. An allow at low risk resolves without a push. Deny, timeout or parse failure becomes the normal phone approval with the rationale attached. Never auto-allow `dangerousCommand` hits, outbound tools (Notify, email, git push), or anything after the session read untrusted web content.
- **Benefit.** Codex's guardian (fail closed, 90 s timeout, only user turns count as authorization); its Avoid card notes that a hub with a human to escalate to should escalate rather than auto-deny.
- **Risk.** A wrong allow; the exclusions and the audit log limit it.
- **Effort.** M.
- **Test.** Scripted chore replies (allow, deny, garbage, slow) and assertions on approval routing.

### 24. BUILD (done): Spend and work limits per session and subagent tree

- **Problem.** `limits.ts` handles provider rate limits only. Nothing caps spend, tokens or working time per session, subagent or routine.
- **Change.** A `LimitNode { kind: 'tokens' | 'cost' | 'turns' | 'workingMs', limit, used, parent }` per runner; a subagent's node points at its parent's; usage is recorded up the chain and checked before each `streamCompletion` from usage rows, not a delayed rollup. Soft thresholds ask through the approval card; the hard cap switches to the first cheaper fallback or stops with a notice; a model with no price asks once per tree. Working time leaves out waiting_reset, waiting_approval and waiting_input.
- **Benefit.** inspect_ai's limit tree (outermost limit checked first so subagents cannot loop on an inner one); Omnigent's cost budget; Mastra's fail-open cost guard is the counterexample.
- **Risk.** Prompts at thresholds annoy; default off except for routines.
- **Effort.** M.
- **Test.** Unit tests on the tree; scripted engine with a catalog price override.
- **Status.** Done in commit 0dfa1bf (`test/engine/limit-tree.test.ts`): `session/limit-tree.ts`, a runner extension that checks output tokens, cost, model calls and working time over each node's subtree before each model step, outermost first. A workflow run's budget is a node between the session and the run's agents, and the workflow's own mid-step budget stop is now this check. Defaults: none, except routine runs (1,000,000 output tokens, 120 minutes). Changes from the plan: the hard limit stops instead of switching to a cheaper model, since work past the limit would have no bound of its own; unattended runs are not asked at the soft threshold; tokens are output tokens, as workflow budgets count them.

### 25. Prompt eval harness, compaction recall eval, ratchet routine

- **Problem.** The agents-defaults prompts are tuned by hand. There is no repeatable check that a change helps, and nothing guards against silent drift.
- **Change.**
  - Now (S): a test that pins load-bearing phrases in BASE.md and the agent prompts (the untrusted-content rule, "never invent", "keep replies short") so an edit that drops one fails CI (ponytail `check-rule-copies.js`).
  - `packages/core/evals/`: tasks with hidden checks that ship a good and a bad reference and a `--selftest`; arms alternate per task (control prompt, current, candidate); at least 3 runs per arm; a held-out split; metrics normalized to 0..1 before weighting; keep a change only when it beats the baseline by a margin on the held-out set; log each attempt's description and diff outside the worktree; run in a git worktree under the normal permission rules and never `git clean` a user tree.
  - A compaction recall eval (Hermes): copy the DB, pick long sessions, generate questions whose answers sit in the compacted region, answer from the compacted context with and without a SessionSearch round trip, judge against gold. This gates items 6, 7 and 13.
- **Benefit.** ponytail's 585-session A/B (lines down 53 percent, cost down 26 percent, hidden checks 87 of 90 against 86 of 90); caveman found an earlier harness that compared against a no-prompt control inflated its numbers; recursive-improve's Avoid cards (single-run keep rule, unnormalized scores, regex detectors); harness rankings barely transfer across models, so run per model family.
- **Risk.** Real evals need paid calls; the harness, graders and replay scoring do not.
- **Effort.** L (the phrase test is S).
- **Test.** Grader self-tests against references; replay scoring of recorded transcripts; no model calls for CI.

### 26. OS sandbox for Bash on Linux and macOS devices

- **Problem.** Commands run bare on the device; the approval layer is the only boundary.
- **Change.** `machine/local.ts` and the daemon exec path build a bwrap argv in TypeScript: read-only root, `--dev /dev` and `--proc /proc` after all binds, private `/tmp`, the session cwd writable, the cwd's `.git` read-only, `~/.conclave` masked, `--unshare-pid`, `--unshare-net` unless network is allowed, `--die-with-parent`, env from item 10. macOS gets a deny-default Seatbelt profile with HOME hidden. A per-device and per-agent setting; plan mode maps to read-only. Denial text (read-only file system, permission denied) offers "retry outside sandbox" through the approval card. Report the enforcement level; never call Windows sandboxed.
- **Benefit.** Codex ships its sandbox on by default; Gemini CLI and Mastra build argv in TypeScript (Mastra's is about 350 lines); DeepSeek Harness reports full or partial enforcement; Omnigent documents the mount-order traps.
- **Risk.** Toolchain breakage (caches under HOME); start opt-in.
- **Effort.** L.
- **Test.** Golden argv unit tests; a Linux CI integration test skipped when bwrap is missing: a write outside cwd fails, `~/.conclave` is unreadable, network is off.

### 27. Per-family provider quirks and edit variants

- **Problem.** Open model families differ in wire rules. The oh-my-pi card reports that DeepSeek V4 flash rejects `content: null` on tool-only assistant turns and needs its own `reasoning_content` replayed, while `providers/openai.ts` sends null and drops reasoning from another model after a handoff. Every family gets the same edit tools.
- **Change.** A compat record per family in `providers/catalog.ts` (`emptyContentAs`, `replayReasoning`, `supportsToolChoice`, `alwaysSendMaxTokens`, `editVariant`) applied in `openai.ts` and `anthropic.ts`.
- **Benefit.** oh-my-pi checked each quirk against the model's chat template and the vLLM and SGLang parsers; its hashline edit gains vary by family, so edit format should be a per-family setting.
- **Risk.** A wrong flag breaks a provider; recorded request tests per family.
- **Effort.** M.
- **Test.** Provider tests with `mockServer` asserting request bodies per family.

## 6. Considered and not recommended

- **LLM-written per-prompt security policy** (Gemini CLI Conseca): every failure path returns allow. Keep deterministic rules; spend the effort on items 1 and 26.
- **Rewind tools that cut the shared transcript** (oh-my-pi): Conclave sessions mix models, asides and juries, and cutting history breaks the cache. Task already explores in a child and returns a report.
- **Provider-owned compaction checkpoints** (OpenClaw, opencode native path): an opaque checkpoint cannot move to another provider, and Conclave switches models inside a session. Keep summaries as plain messages. Stateless Anthropic tool-result clearing could be revisited later.
- **Per-step observation elision and rolling micro-compaction** (SWE-agent `LastNObservations`, Hermes micro-compaction): both rewrite the prefix every turn. Hermes measured 2.1x the tokens kept and a loss to summary plus search.
- **An observer model per tool call** (claude-mem): one extra call per tool use; per-turn extraction is the right unit.
- **Heavy style modes and per-turn style reminders** (caveman): about 1,160 input tokens of rules for a 3 percent median gain over "Answer concisely."; agent sessions are mostly input and cache reads.
- **A bare "write less" rule without a never-cut list** (ponytail): the YAGNI one-liner fell to 94.4 percent safe on adversarial checks.
- **Single-run keep-or-revert, regex detectors, unattended self-edits of source** (recursive-improve as shipped): see section 7.
- **Python kernel, factory workflows, gate-less autonomy in chat** (Prime Agent), **MITM TLS proxy, Starlark rules, guardian session pools** (Codex, Omnigent), **lineage journals and lease stores** (open-multi-agent), **multi-instance run infrastructure** (QM), **the Effect-TS service layer** (opencode): sized for other deployments. Conclave is one Bun process on SQLite.
- **Ledgers inserted right after the system prompt** (DeerFlow): they change the bytes at the head of history on most calls.
- **Unwinding the newest turns on overflow** (harbor terminus-2): it throws away the work the next step needs most.
- **Auto-continue prompts in interactive sessions** (inspect_ai react default): an interactive session should stop and wait; nudges belong in loop mode.
- **Cache keepalive pings by default** (aider, pi): pi's own numbers show idle warming rarely pays; only consider for waiting_approval with measured approval latency.
- **Text tool-call extraction on hosted models** (open-multi-agent): a hosted model quoting example JSON would trigger a real call. Local endpoints only.

## 7. Notes on recursive-improve

The owner pointed at [kayba-ai/recursive-improve](https://github.com/kayba-ai/recursive-improve). Its detectors and scorer were re-read in source for this review (`recursive_improve/eval/detectors.py`, `ratchet/scorer.py`).

What to take:

- **Per-run rates from stored traces** (item 14). Conclave already has the structured data, so the detectors become SQL and TypeScript over `messages` and `usage`, using `isError` instead of matching "error" in text, and argument hashes instead of "same tool name 3 times in a row" (`detect_loops` fires at `max_run >= 3` on the name alone).
- **A run record tied to a prompt version** (item 14), so changes to agents-defaults can be compared.
- **Helpful and harmful counters on learned rules** (item 22), enforced in code. In recursive-improve they live only in skill text.
- **The ratchet idea** (item 25), with its gaps fixed: `composite_score` treats every metric as a 0..1 rate (`1 - value` for minimize), so raw token counts swamp it; the keep rule is one run, strictly higher, no margin, no held-out set; reverts run `git clean -fd`; the default improve command runs `claude -p` with Edit, Write and Bash allowed and nobody watching. Conclave's version needs repeats, a margin, a held-out split, normalized metrics, a log of what was reverted, a worktree, and the normal permission rules.
- **The triage rule from its skill**: when an instruction the agent already has keeps being ignored, move it into code (a hook, a tool check or a permission rule) instead of rewording the prompt. Items 1, 3, 5 and 15 follow that rule.

## 8. Testing without paid model calls

- **Scripted engine** (`test/engine/harness.ts`): a real engine against a local SSE server that replays scripted steps. Needed extensions, all small: an optional `stop` reason and `usage` per step (items 3, 4, 8), a handler for tool-less chore requests (items 6, 13, 19, 23), and script selection by a predicate on the request body (item 2, where parent and child requests interleave). Done with items 2 and 4: a step can be `{ blocks, stop, usage, delayMs }`, `route(body, text)` picks a reply or an HTTP status by request content, `chore(body, text)` answers tool-less requests, and `chores` records them.
- **Mock providers** (`test/providers/mock.ts`) for request-body assertions per provider (items 4, 27).
- **Fake machine** (`test/machine/fake-machine.ts`) for file, instruction and snapshot logic (items 11, 15, 17, 19).
- **Recorded transcripts**: `exportSession(id, 'json')` output saved as fixtures for health metrics, cache-stability byte comparisons and compaction region tests (items 12, 13, 14).
- **Pure units** for the new modules: `LoopGuard`, permission matching, verbatim and anchor sections, reducers, the env filter and URL guard.
- **What needs real calls**: prompt A/B runs and the compaction recall eval (item 25). Their graders and harness run offline with self-tests.
