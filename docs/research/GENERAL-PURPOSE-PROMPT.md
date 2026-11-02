# What the general-purpose subagent's first call is made of

Item 3 of the optimisation review (2026-11-01): a general-purpose subagent's first model call averages about 55.7k input tokens, against about 11.7k for explore (249 spawns, 11.2M cache-write tokens). This note measures where the tokens go. It proposes cuts but makes none.

Tokens below are characters / 4, rounded. They are estimates, not tokenizer counts.

## How it was measured

1. **Built-in parts, measured.** The engine test harness (`packages/core/test/engine/harness.ts`) ran one turn for each agent with the scripted model, on branch `perf/round-2`. The first request body was split into its system blocks and its tool definitions (name, description, `input_schema`). The harness has no skills, no memories, no MCP servers and no project instruction files, so these numbers are the floor that every hub pays.
2. **Hub-only parts, estimated.** Skills, the profile, MCP servers, project instructions and the brief only exist on a live hub. They are estimated from the code (`session/prompt.ts`, `session/skill-list.ts`) and from a live general-purpose prompt on the owner's hub (this report was written by one). They are marked "est." in the tables.

## The floor: built-in parts (measured)

| Part | general-purpose | explore |
|---|---:|---:|
| System prompt, all blocks | 2,929 | 2,083 |
| Tool definitions | 17,898 (49 tools) | 2,874 (7 tools) |
| **Total** | **20,827** | **4,957** |

So the tool list alone is 15.0k of the 15.9k gap the harness can see.

### System prompt blocks

| Block | general-purpose | explore |
|---|---:|---:|
| Base prompt ("You are running inside Conclave...") | 1,504 | 1,172 |
| `# Environment` | 49 | 49 |
| `# Your role: <agent>` (agent file body) | 671 | 535 |
| `# Conclave` (platform card) | 272 | 267 |
| `# Files you deliver` | 250 | none |
| `# Skills` (empty in the harness) | 74 | none |
| `# Conclave right now` | 108 | 59 |

The base prompt is longer for general-purpose because `basePromptFor(toolNames)` adds the paragraphs for tools explore does not have (Task, Workflow, memory, skills).

### Tool definitions, general-purpose (largest first)

| Tool | Total | Description | Schema |
|---|---:|---:|---:|
| Task | 1,733 | 1,541 | 167 |
| Workflow | 931 | 704 | 209 |
| Grep | 717 | 334 | 359 |
| Delegate | 706 | 414 | 275 |
| Bash | 701 | 573 | 110 |
| SkillManage | 578 | 327 | 233 |
| MemorySave | 559 | 409 | 125 |
| DayPlan | 554 | 313 | 225 |
| SessionSearch | 494 | 266 | 209 |
| AskUserQuestion | 449 | 222 | 208 |
| TodoWrite | 437 | 284 | 135 |
| Read | 410 | 245 | 150 |
| CalendarEvent | 408 | 245 | 147 |
| MemorySearch | 373 | 255 | 100 |
| ScheduleRoutine | 372 | 250 | 101 |
| WebFetch | 357 | 280 | 61 |
| CalendarFreeBusy | 351 | 198 | 135 |
| GoalCreate | 340 | 204 | 118 |
| MultiEdit | 339 | 161 | 163 |
| WebSearch | 339 | 209 | 114 |
| NotebookEdit | 326 | 156 | 153 |
| Edit | 320 | 177 | 130 |
| ConclaveHelp | 306 | 205 | 83 |
| ProactivePrefs | 304 | 211 | 76 |
| Skill | 301 | 201 | 86 |
| ShareFile | 301 | 241 | 33 |
| ReadToolOutput | 300 | 157 | 127 |
| Consult | 295 | 186 | 93 |
| MailDraft | 291 | 196 | 79 |
| RepoMap | 285 | 178 | 91 |
| GoalUpdate | 283 | 103 | 164 |
| CalendarList | 279 | 175 | 88 |
| Glob | 261 | 176 | 68 |
| PlaceSearch | 261 | 186 | 56 |
| Directions | 254 | 173 | 64 |
| GoalList | 249 | 136 | 99 |
| WorkflowStatus | 229 | 145 | 69 |
| Write | 223 | 138 | 71 |
| MapImage | 206 | 116 | 75 |
| SessionRead | 204 | 105 | 84 |
| BashOutput | 190 | 110 | 65 |
| LS | 188 | 99 | 75 |
| EnterPlanMode | 184 | 152 | 16 |
| Notify | 164 | 98 | 53 |
| GoalLog | 158 | 85 | 59 |
| GoalGet | 112 | 47 | 52 |
| MemoryForget | 96 | 46 | 36 |
| PlaceDetails | 92 | 51 | 26 |
| KillShell | 88 | 33 | 41 |

Total (the column "Total" is the whole JSON of the tool, so it is a little more than description plus schema).

Grouped:

| Group | Tools | Tokens |
|---|---|---:|
| Code work (shared with explore) | Bash, Read, Grep, Glob, LS, RepoMap, ReadToolOutput | 2,862 |
| Editing | Edit, MultiEdit, Write, NotebookEdit | 1,208 |
| Agents and workflows | Task, Delegate, Workflow, WorkflowStatus, Consult | 3,894 |
| Shells and planning | BashOutput, KillShell, TodoWrite, EnterPlanMode, AskUserQuestion | 1,348 |
| Web | WebFetch, WebSearch | 696 |
| Memory, sessions, skills | MemorySave, MemorySearch, MemoryForget, SessionSearch, SessionRead, Skill, SkillManage | 2,605 |
| Owner's day (personal assistant) | DayPlan, GoalList, GoalGet, GoalCreate, GoalUpdate, GoalLog, ProactivePrefs, ScheduleRoutine, Notify | 2,536 |
| Calendar, mail, places | CalendarList, CalendarFreeBusy, CalendarEvent, MailDraft, PlaceSearch, PlaceDetails, Directions, MapImage | 2,142 |
| Files and help | ShareFile, ConclaveHelp | 607 |

## The hub-only parts (estimated)

These are not in the harness and change with the hub.

| Part | general-purpose | explore | Where it comes from |
|---|---:|---:|---|
| `# Skills` list | up to about 6,000, est. | none | `skills.skillTokens` budget, default 6000 (`config/schema.ts`). Only sent when the agent has the Skill tool. On the owner's hub the names-only tail is long too. |
| `# What you know about the user` | about 2,500 to 3,500, est. | same | Profile memories (`engine.profileFor`). Both agents get them. |
| Task tool's subagent catalog | grows with the agent count, est. | none | `subagentCatalog()` adds one line per agent to the Task description. The harness has only the built-in agents. |
| Workflow tool's library list | grows with workflows, est. | none | Same pattern for the Workflow description. |
| MCP | ToolSearch plus the server list, est. under 500 | none | Deferred MCP tools stay out until ToolSearch loads them (`mcp.deferAbove`). |
| Project instructions | same for both | same | `CLAUDE.md` / `AGENTS.md` under the cwd. The Conclave repo has none at its root. |
| First user message | same for both | same | The brief plus `<system-reminder>` blocks (memories, active skills such as caveman). Often 2k to 5k. |

## Where the gap comes from

| | Tokens |
|---|---:|
| Live gap (55.7k minus 11.7k) | about 44,000 |
| Tool definitions, measured | 15,024 |
| System blocks, measured (base, role, files, skills header, live block) | 846 |
| Skills list, est. | up to 6,000 |
| Larger Task and Workflow catalogs on the live hub, est. | 1,000 to 3,000 |
| **Not explained by this measurement** | **about 19,000 to 22,000** |

The unexplained part needs one live capture. The easiest one: log, at debug level, the size of each system block and each tool definition of the first request of a general-purpose subagent (`session/runner.ts`, where `this.prompt` is built at line 1688). One capture on the owner's hub would close the table. Candidates for the rest, in order of likelihood: MCP tools loaded straight into the list because the server count is under `deferAbove`, plugin skills pushing the names-only tail past the budget, and a long platform card when many devices and accounts are connected.

## Cut candidates, ranked

Ranked by tokens saved per general-purpose spawn, then by risk. No cut is made in this PR.

1. **Drop the owner's-day and calendar tools from general-purpose (about 4,700).** DayPlan, Goal*, ProactivePrefs, ScheduleRoutine, Notify, Calendar*, MailDraft, Place*, Directions, MapImage. A subagent "that changes files or runs commands" has no use for the owner's calendar or goals, and the parent session still has them. Risk: low. A routine that delegates "plan my week" to general-purpose would lose them; route that to the assistant agent instead. Do it with a `tools:` deny list in `agents-defaults/general-purpose.md`, the same way explore lists its tools.
2. **Cap the skills list for subagents (up to about 6,000).** Pass a smaller `skillTokens` (for example 1,500) when `depth > 0`, or list names only. The subagent can still call `Skill` with a query. Risk: medium. The subagent may miss a skill it would have loaded from a description.
3. **Shorten the Task description (about 1,000).** 1,541 tokens of description is the largest single tool. A subagent rarely spawns its own subagents. Either drop Task for general-purpose at depth 1 or trim its usage notes. Risk: medium. Some jobs do fan out.
4. **Drop Workflow and WorkflowStatus at depth 1 (about 1,200).** Workflows are started by the owner's session. Risk: low to medium.
5. **Drop Delegate and Consult at depth 1 (about 1,000).** Delegate hands work to other devices and Consult asks other models; both are decisions for the parent session. Risk: low.
6. **Drop NotebookEdit unless the cwd has `.ipynb` files (about 330).** Risk: low.
7. **Trim the base prompt sections that only make sense at depth 0 (a few hundred).** For example the memory and goal paragraphs. Risk: low, small gain.

Items 1, 4 and 5 together save about 6,800 tokens per spawn with low risk, about 1.7M cache-write tokens over the 249-spawn sample. Measure the unexplained 20k before ranking anything above them.

## Reproduce

Run a throwaway `bun test` file next to the harness that starts the engine, creates a session with `agent: 'general-purpose'` (then `'explore'`), runs one turn, and parses `t.requests[0]`: `body.system[*].text` for the blocks and `body.tools[*]` for the tools, with length / 4 for each.
