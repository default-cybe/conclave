# Security mode: design for approval

Written 2026-11-05. Inputs: `00-owner-decisions.md`, `01-board-agents.md`, `02-github-agents.md`, the Conclave research summary (03 was not saved as a file), `../bughunt-toolkit/01-owner-method.md`, `04-plan.md`, `05-proof-run.md`, `skills/*.md`, `../cybergym-research.md`.

I checked the Conclave facts on `origin/main` (ba76be7c, 2026-11-05) and on `origin/feat/same-model` (05ef32be). PR #255 ("Same model for all work") is **open, not merged**. Nothing in this design has been built or run.

Revision 2 (2026-11-05) applies a review. Section 7 logs each point, accepted or rejected, with the reason.

Evidence tags:
- **[A]** same model, one factor changed (DoGNAVY-Exploit ablation, n=40, one run each).
- **[B]** several factors changed at once.
- **[C]** component counts or claims only.
- **[owner]** the owner's own track record (01).
- **[none]** no evidence; a design choice.

## 0. What changed from the brief's starting recommendation

The brief proposed that the Security switch turns on the same-model pin. The owner's later written decision (`00-owner-decisions.md`) overrides that:
- In Security mode, Conclave picks the agent and the model for each role automatically, from a per-role table.
- The pin is an optional override.
- A model the owner names always wins.

This design follows the owner's decision. Section 1.4 shows how the two fit together.

## 1. UX decision

### 1.1 Decision

**One Security mode, two ways in, with the lane picked automatically.**

| Piece | Where | What it does |
|---|---|---|
| Security switch | Composer, next to the model picker (same row as the PR #255 "Same model" switch) | Turns the current chat into a security chat. Sets `chat.security = true`, loads the security roster, arms the scope guard. Off restores the chat's previous agent. |
| Security start mode | Sidebar switch: Chat, Assistant, Code, **Security**, Canvas (`StartMode`, `features/home/start.ts:15`) | Starts a session with agent `security` in a hunt workspace folder on a chosen device. The folder holds `scope.yaml`, `targets/`, `playbook/`. Remembered per device like Code's picks. |
| Lane chip | Under the composer, after the first message | Shows the detected lane (for example `Lane: web black-box (Caido)`). Tap to change it. Each change is logged on the session. |
| Routing line | In the lane chip's menu | Shows the model per role for this lane, for example `hunter GLM-5.3 · validator GLM-5.3 · refuter Daybreak · reporter Opus 5.5`. One tap opens Settings > Security > Roles. |
| Same-model switch | Unchanged from PR #255 | Off by default in Security mode. On means every role uses the chat's model (section 1.4). |

Subagent agent choice stays automatic. The parent picks `subagent_type` from the roster, the same way Task works today (`tools/task.ts`, `engine.ts` `subagents()`).

### 1.2 Lane detection (deterministic, no model call)

A pure function runs on the first message plus its attachments. It returns every lane whose signal matched, ranked by the order below, not only the first match.

| Rank | Signal | Lane |
|---|---|---|
| 1 | CTF bundle: archive or text with `flag{`, a `nc <host> <port>` line, or "challenge" plus attached files. Outranks a crash log inside the bundle. | CTF (`solve-challenge`, then `ctf-*` skills) |
| 2 | `CVE-\d{4}-\d{4,}`, `GHSA-[a-z0-9-]{14}`, or a commit/PR URL with a fix | variant (violation hunt). With a repo too, the variant hunt runs on that repo. |
| 3 | Crash log (`AddressSanitizer`, `UndefinedBehaviorSanitizer`, `SIGSEGV` plus a stack), or an attached PoV/PoC file | exploit dev |
| 4 | Binary or firmware: ELF, Mach-O, PE, `.ipa`, `.apk`, `.dmg`, `.bin`, `.img` | RE (REA MCP) |
| 5 | Git URL (`github.com/<o>/<r>`, `.git`), or a folder path containing source | white-box source hunt |
| 6 | Any other `http(s)://` URL or host | web black-box (Caido) |
| 7 | Nothing matched | Ask one question with lane buttons. Default: white-box source. |

Detection only proposes. The chip shows the top lane plus the other matched lanes as one-tap alternatives (for example `Lane: variant · also: source`). The owner can change it before the first tool runs. Nothing reaches a live target before an approval grant (section 4, item 3).

Lanes can change mid-hunt (source lead, then web proof, then chain). The workflow switches lane by itself only from source to proof. It writes the new lane to the chip and logs it.

### 1.3 Alternatives rejected

| Option | Why rejected (values) |
|---|---|
| **Automatic detection, no mode.** Arm the roster on any URL or CVE in any chat. | Normal coding chats mention CVEs and URLs. A false positive would switch models, apply the scope guard to non-security work, and ask for a scope file the owner does not need. No board system detects intent; all of them are explicitly started on a target. |
| **Several cyber modes** (Web, Source, RE, Exploit, CTF as sidebar entries) | The owner would pick the lane before knowing it. Real hunts cross lanes: in 05 the source lead needed a web proof, and chaining needs both. Five more entries next to the four existing ones would crowd the sidebar. The chip gives the same control with one tap and no extra entries. |
| **Composer toggle only** | It works for one chat, but a hunt needs a persistent folder, device and scope file. That is what a start mode remembers (`Picks` in `start.ts`). Both entry points set the same state, so this is one concept, not two. |
| **Pin on by default** (brief's draft) | Overridden by owner decision 00. The evidence is split (1.4), so the owner's choice stands. |

### 1.4 "Same model for all work" vs. a per-role model table

Evidence:
- Most systems above 95% on CyberGym use one model for every role: Sangfor 97.2 on GLM-5.3, mneme 91.0 on Opus 4.6, DoGNAVY, RO0T and Aegis [B].
- Per-role splits are disclosed only by OrcaCyber (worker plus escalation; escalation is about 2/3 of the $3.32 per task, no per-tier solve count) and Zhian [C].
- Mixed-model refuters did not help in practice. In 05, three refuters on three makers (Opus 5.5, Daybreak Blue, GLM-5.3) voted 12 of 12 "confirmed" while sharing the same untested assumptions (05 lists 7). The real check is the runtime oracle, not model diversity.
- Different models per role pay off where one model is clearly stronger at one job. ExploitGym crash-to-exploit: Opus 5.5 300, Mythos 5.1 264, GLM-5.3 130. CyberGym PoC-from-description: GLM-5.3 84.5 bare and 97.2 in a good agent. Opus 5.5 is not on CyberGym.

Resolution, in model-resolution order (first match wins):
1. **A model the owner names** in the message, or as a tool argument the owner typed (unchanged; PR #255 keeps explicit refs winning). A model chosen by the `security-hunt` script or a profile is **not** owner-named. The workflow passes a role name, never a model ref, so the pin can override it. PR 4 tests this.
2. **Same-model pin on:** every role uses the chat's model, the refuter included. The lane menu then shows `all roles: <model>`. Evidence says this costs little, because the runtime oracle and the assumption list do the refuting (05).
3. **Settings > Security > Roles table:** one row per role, with a model and an optional fallback. Empty means the default below.
4. **Roster default** (the `model:` line in the role's profile, table in section 2).
5. **The parent's model:** used when the role model is unusable or has answered 404 in the last 6 h (`agent-model.ts`, `subagentModel`, `DEAD_MS`). This also covers Mythos 5.1 until CLIProxyAPI v0.4.70.

**Most user-friendly choice:** auto table by default, pin as a one-tap override, and no per-hunt model questions. The owner sees the routing line in the chip and never has to edit the table to start.

## 2. Agent roster

Every profile is an `agents-defaults/sec-*.md` file with `subagent: true` and a new `group: security` field, so Task offers them only inside Security mode. `security.md` stays the primary agent. Its frontmatter gains `skills`, `mcpServers: [caido, semgrep, rea]` and a `refusalFallback` list.

Prompt licences:
- Conclave is **AGPL-3.0-only** (checked `package.json`). Apache-2.0, MIT and AGPL-3.0 text can be adapted with attribution.
- CC-BY-SA-4.0 (Trail of Bits skills) stays as installed skills, not copied into Conclave source.
- Not used: CAI's research-only parts, Villager, and the Claude-BugHunter and Agentic-Bug-Hunter skill files (live injection strings; mine by hand only).

### 2.1 Models available

| Ref | Short name |
|---|---|
| `cliproxy/claude-opus-5-5` | Opus |
| `zai/glm-5.3` | GLM |
| `cliproxy/personal-gpt/gpt-daybreak-blue-latest` | Daybreak |
| `experientiallabs/glm-5.3-uncensored` | GLM-U |
| `claude-mythos-5-1` | Mythos, not routable until v0.4.70 |

Daybreak's link to GPT-5.5-Cyber (CyberGym 85.6) is unverified: the Daybreak page returned 403. GLM-U is on no board.

### 2.2 Roles

| Role | Job | Tools / MCP / skills | Default model, fallback | Evidence for model | Prompt sources (licence) | Runs vs reads |
|---|---|---|---|---|---|---|
| `sec-recon` | Map the surface: routes, guard idiom, role-permission table, newest feature, data carriers. Write the evidence brief (facts, open questions, checks not to repeat). | Read, Grep, Glob, Bash (read-only); semgrep MCP; Caido read tools (history, sitemap) on the web lane; REA on the RE lane. Skills: `bughunt-catalogue`, `audit-context-building`. | GLM, then Opus | [none] for recon. GLM is the cheaper of the two and is the base of 4 systems at 95 to 97.2. | DoGNAVY scout brief (paper, idea only); Shannon recon (AGPL); Strix recon skill (Apache-2.0); owner prompts 1, 2, 5 [owner] | Reads code and proxy history. No new target traffic. |
| `sec-hunter` | Per lane, 3 routes in parallel. Output: leads with file:line, invariant, and a proof plan. Never sees the fixed build. | Read/Grep/Bash; semgrep; `cve-violation-hunt`, `variant-analysis`, `tool-semgrep-fix-rule`, 0xdea rules. | Web and source logic: Opus, then GLM. C/C++ PoC: GLM, then Opus. | Logic: [owner], Opus found his web wins (01 §4 step 5); no benchmark. PoC: CyberGym GLM 84.5 bare [B]. | Shannon per-class analysts plus the owner's 12 classes (AGPL plus owner); VARAS v1 stage list (idea); mneme 8 construction strategies (idea) | Reads. It may probe only a lab stack the workflow started (section 4.1). |
| `sec-fuzzer` | C/C++ only. Writes seed corpora and the harness, then runs libFuzzer with ASan/UBSan. No LLM calls while fuzzing. | Bash on Madx Docker; `lib.exec`. | GLM, then Opus | Lyrie lane A: 894 of 1,495 solves, LLM cost < $0.013 per task [C] | FuzzingBrain v2 PoV prompts (Apache-2.0); OSS-Fuzz-gen prototyper (Apache-2.0) | Runs on Madx only. |
| `sec-validator` | Runs the lane oracle (section 3.2) and returns pass/fail plus captured evidence. Default verdict: not reproduced. Runs the negative control (patched build, own-object request). | Bash on the device; Caido `send_request`, `diff_responses`; Playwright (two-tenant); lldb-mcp on Mac. Skills: `tool-proxy-mcp-replay`, `tool-playwright-two-tenant`, `tool-post-patch-validation`. | GLM, then Daybreak. Must differ from the hunter's model when the pin is off. | The verdict comes from the oracle, not the model. A cheap model is enough. [C]: MAPTA validator, XBOW validators, ARTIPHISHELL 5x repro. | MAPTA validation agent (MIT); Big Sleep reporter-on-verified (idea) | Runs. The only role besides exploiter and fuzzer that sends target traffic. |
| `sec-exploiter` | Crash to exploit, staged: understand, primitive, chain, validate. 3 routes per stage. A capability counts only once shown at runtime. | Bash, gdb, pwntools on Madx Docker; REA. | Opus, then Mythos (after v0.4.70), then GLM | ExploitGym: Opus 300 (289 at 2h), Mythos 264, GLM 130 [B]; route ablation [A] | DoGNAVY-Exploit stages (paper, idea); VARAS capability tree (idea) | Runs in a local container only. |
| `sec-refuter` | One call, 3 lenses: reachability from the lowest role; boundary rule; downstream validator. Lists assumptions, each marked tested or untested with how. For authz: "is this data intended for this role, per UI and docs?" Its job is the assumption list that feeds the proof plan, not a vote. | Read/Grep; may run read-only checks on a lab stack. | Daybreak, then GLM. Differs from the hunter's model when the pin is off. | [none]. 05 showed 12 of 12 mixed-model votes "confirmed" with 7 shared untested assumptions, so the 3-model panel is not the default. It is arm E in the eval (section 5). | `lib.panel` lenses; Sangfor "evidence bar rises" (idea); 05 lesson | Reads. Any `tested:true` claim must cite a command and its output. |
| `sec-chainer` | Pairs ledger primitives into 2 to 3 step chains, and asks first whether reachability alone beats a chain. | Read; `jq` on `ledger.jsonl`. Skill `bug-chaining`. | Opus, then GLM | [owner] | `bug-chaining.md` (owner) | Reads. Chains are proved by the validator end to end. |
| `sec-reporter` | Drafts `REPORT.md` for **confirmed** findings only: first person, terse, numbered repro, runnable PoC, honest preconditions, no em dashes, no AI tool names, signed Kaivalya Ahir, github.com/default-cybe. Picks the venue. Never submits. | Read/Write in `findings/`. Skill `avoid-ai-writing`. | Opus, then GLM | [owner]: crewAI flagged his report as "potentially automated"; Apple bans repeat AI-unvalidated reports for 180 days | Owner rule 7 (01 §10) | Reads the validator's evidence. Refuses without `RESULT.txt`. |
| `sec-patcher` | Optional. Patches at the producer of bad state, then reruns the PoV and the test suite. | Bash in a worktree on Madx. | Opus, then GLM | CyberGym-E2E: AWS Continuum (Opus 5) S3 89.0 [C]; no E2E row for these models | Zhian Patch plus Failure Attribution (idea); Buttercup patcher (AGPL) | Runs locally. |

Refusal fallback list for every `sec-*` role:
1. Plans marked "Use when a model refuses" (existing).
2. Daybreak with `access_programs {cyber: daybreak_blue}` (existing, `refusal-fallback.ts`).
3. GLM-U.

The prompt is never reworded around a refusal (owner boundary, 01 §8).

Known gap to fix (inferred by the 03 researcher, not tested): Task children do not carry `chat.cyber`, so a Daybreak child may send no access program. Fixed in PR 3.

## 3. Workflows

### 3.1 One library workflow, `security-hunt`, with lane steps

The same skeleton runs for every lane. Only the Recon, Hunt and Validate steps differ per lane. Args: `{ lane, target, scopeFile, device, budget }`.

| # | Phase | Lib calls | Exit condition |
|---|---|---|---|
| 0 | Preflight | `agent()` reads `scope.yaml`; the script validates the schema | Missing or invalid scope file: stop. Target not in `in_scope`: stop. Scope `expires` in the past: stop. |
| 1 | Load (read first) | `agent()` reads `playbook/hunting-logic.md`, `targets/<t>/catalogue.md`, `PARKED.md`, and the last 200 lines of `ledger.jsonl`; the result is passed on with `lib.fence` | A dedupe list exists |
| 2 | Recon | `sec-recon` writes `targets/<t>/brief.md` | The brief lists the guard idiom, the role table (if one exists) and the carriers |
| 3 | Hunt | `parallel` of 3 `sec-hunter` routes inside `lib.loopUntilDry({k:2, maxRounds:4})`. Route split: continue the leader, isolate its blocker, try an alternative (DoGNAVY [A]). | Leads with file:line and a proof plan. Cap: 10 leads. |
| 4 | Filter | `lib.checkCitations`, `lib.dropDismissed`, `lib.dedupe` against the dedupe list and the latest release | Each lead quotes its lines at the shipped version |
| 5 | Refute | 1 `sec-refuter` call by role (the resolver picks the model; the pin applies). Schema: `lib.schemas.verdict` plus `assumptions[{text, tested, how}]`. | Not refuted, and every untested assumption becomes a check in the proof plan |
| 6 | Approve | Lab-only plans need no approval. A plan that touches a non-lab host needs a live **approval grant** for that target (section 4, item 3). Without one, `lib.approve` asks for a grant: hosts, accounts, total request budget, rate, the scope line it relies on, and an expiry of at most 24 h. Later leads inside the grant run without asking again. | A grant covers the plan, or the lead is parked as `partial` (unattended runs always park) |
| 7 | Validate (run and confirm) | `sec-validator` on `conclave: { device }` runs the lane oracle (3.2) | Pass means `confirmed`. Anything else means `partial` or `refuted`, with evidence. |
| 8 | Gate | One agent answers the 7-Question Gate (7 booleans plus reasons) | Any no: park with the reason. The lead is never deleted. |
| 9 | Record (write last) | `lib.recordFindings`; the agent appends to `ledger.jsonl`; catalogue diffs from the whole run go through one `lib.approve` at the end | Ledger line has `status`, `yields`, `needs` and a `result` path |
| 10 | Report | `sec-reporter` drafts `findings/<t>-hunt/REPORT.md` for confirmed findings | Draft only. The owner submits (HackerOne and Bugcrowd penalise unverified AI reports). |

`status: confirmed` is only allowed when step 7 passed. The script enforces this in code, not in a prompt, so no number of agreeing models can mark a lead confirmed (the 05 failure).

### 3.2 Lane oracles and budgets

| Lane | Recon and hunt specifics | Oracle in step 7 ("confirmed" only if all hold) | Default budget |
|---|---|---|---|
| White-box source (web app) | Mechanical gate inventory and carrier sweep (`rg` commands in `cve-violation-hunt.md`); generalised gate rule reviewed before narrowing | Lab docker-compose stack on Madx at the **shipped** version (`docker exec` checks the compiled code), seeded with two tenants or roles. The bug-class oracle from the table below holds, its negative control holds, 3 of 3 runs. | 2 h, 3 routes |
| Web black-box | Caido history and sitemap; owner prompts for JS recon and parameter mining | The bug-class oracle from the table below, on an **in-scope** host with the owner's test accounts, inside the approval grant's request budget and rate. Its negative control holds. 3 of 3 runs. Request pairs exported. | 1 h, rate from scope (default 1 req/s) |
| Variant (CVE, fix) | Violation hunt (04-plan 2b): the rule must fire on `<fix>^` and be silent on `<fix>`; then search the target | Proof runs in the target's own lane (source or web) | 2 h |
| Memory (C/C++, crash or PoC) | Fuzzer lane first: tiers of 600 s, then 1,800 s (only if coverage still grows), then 3,600 s cut (Lyrie [C]). Then `generator.py`: 8 candidates per round, at most 6 rounds. | Vulnerable build, 3 of 3 runs: exit code not in the runner's no-crash set (CyberGym runner: {0, 71, 124, 137, 300, 999}, Lyrie gate, 01 §2) **and** stderr holds a sanitizer report (`ERROR: AddressSanitizer`, `ERROR: MemorySanitizer` or `runtime error:` from UBSan). The report's top frames include the target function or file (on-target check; ExploitGym: GPT-5.5 flags 210, only 120 on-target). Patched build (when one exists): exit 0 in 3 of 3. The hunter never sees the patched build. | 2 h plus fuzz tiers |
| Exploit dev | Stage gates: understand, primitive, chain, validate; 3 routes per stage | Flag or marker read inside the local container, 3 of 3 runs, and the judge confirms the intended bug | Opus 2 h (289 at 2h vs 300 at 6h); 6 h only if the owner raises it |
| RE | REA decompile and diff (`tool-rea-ghidra-diff`); Ghidra 12.1.x | Result-observable behaviour of the **shipping** binary through its public API on the device (Mac for Apple, with `lldb-mcp` stopped after) | 2 h |
| CTF | `solve-challenge`, then `ctf-*` | Flag captured; `ctf-writeup` | 1 h |

**Bug-class oracles for the web and source lanes.** The validator picks the row from the lead's class. A lead with no matching row stays `partial`.

| Class | Observable proof | Negative control |
|---|---|---|
| Read authz (IDOR, role leak) | Low role or tenant A gets B's seeded canary | A on A's own object succeeds; a forbidden sibling endpoint (for example `/members`) returns 403 |
| Write authz (write-only, state change) | A's request changes B's object; B's own session then reads the new value | The same write on A's object succeeds; B's object is unchanged when A sends no request |
| Auth bypass | A protected resource returns its content with no or wrong credentials | The same request with valid credentials for a user without access is denied |
| Stored or reflected XSS | A unique marker runs in a second Playwright browser session (a `window` flag or a call to a lab listener) | The same input with an inert payload renders as text; the marker never fires there |
| SSRF | The target fetches a unique path on a listener the owner controls (lab host, or an approved callback host in `scope.yaml`) | A request with a harmless URL makes no listener hit with that path |
| Other classes | An owner-approved observable written in the proof plan before the run | Written in the proof plan before the run |

## 4. Safety

1. **Scope file is required per target.** It lives at `targets/<t>/scope.yaml` and holds no secrets:
   ```yaml
   program: <name>            # venue: hackerone|bugcrowd|apple|ghsa|vendor|own|ctf
   venue: hackerone
   in_scope: ["app.example.com", "*.api.example.com"]   # hosts or globs
   paths: ["/api/**"]          # optional
   out_of_scope: ["admin.example.com", "/billing/**"]
   lab: ["sec-lab-<t>"]       # docker networks the workflow created for this target; no IP ranges
   callback: []                # optional SSRF/XSS listener hosts the owner controls
   rate_limit_rps: 1
   request_budget: 500         # most requests per approval grant
   accounts: ["tenantA (test)", "tenantB (test)"]       # labels only
   no: [dos, other_user_data, anti_bot_evasion]
   expires: 2026-12-31
   ```
   - **Lab** means only the docker networks the workflow created for this target (`sec-lab-<t>`) and loopback inside the hunt container. A homelab range such as `10.0.0.0/8` is never lab: it holds live services.
2. **Egress gateway (the boundary).** Every `sec-*` Bash command runs in a per-hunt container on Madx, registered as the session's device. The container reaches only its `sec-lab-<t>` networks and one forward proxy, the egress gateway. The gateway:
   - allows a non-lab host only while an approval grant covers it (item 3), and checks `in_scope`, `out_of_scope` and `paths`;
   - enforces `rate_limit_rps` and the grant's request budget, then refuses further requests;
   - logs every request line to `findings/<t>-hunt/egress.log`.
   This catches `python -c`, scripts and any tool, because it acts on the network, not on command text. The owner's Caido on CT 136 uses the gateway as its upstream proxy (Caido setting, to confirm in PR 1b).
   Other devices: the RE lane on the Mac and the CTF lane touch no live target. There, the hook in item 4 is the only control.
3. **No live target without an approval grant.**
   - A grant names the target hosts, the accounts, a request budget (at most `request_budget`), the rate, and an expiry of at most 24 h. It is stored on the session and pushed to the gateway.
   - One grant covers every lead on that target until it expires or its budget runs out. The owner can revoke it from the chip menu.
   - All live requests need a grant, GETs included. Recon never touches a live target without one.
   - Unattended runs never get a grant, so they stay lab-only.
   - Hook `ask` forces a prompt even in bypass mode (`proxmox-guard` safety note).
4. **`scope-guard` hook recipe (early warning, not the boundary).** It is a PreToolUse recipe in `hook-recipes.ts`, the same shape as `proxmox-guard`, and is on for every `sec-*` profile and `security.md` (`recipes:`).
   - Matcher: `Bash|WebFetch|mcp__.*` (every MCP tool, not a list).
   - It pulls hosts from URLs and from `curl`, `wget`, `httpx`, `nmap`, `ffuf`, `nc` and `ssh` arguments.

   | Host | WebFetch (runs on the hub) | Bash, any MCP tool |
   |---|---|---|
   | In `lab` | pass | pass |
   | In `out_of_scope` | deny | deny |
   | In `in_scope` | deny (use the validator in the container) | pass only with a live grant; else **ask** for a grant |
   | Not listed | pass (advisory and doc research) | **ask** |
   | No scope file loaded | ask | ask |

   - Caido `race_window_send` is denied off-lab (it bypasses proxy scope).
   - `shortcut:` host extraction is regex on the command text and misses hosts built at runtime. The gateway in item 2 covers that gap on Madx; the hook only gives an earlier, clearer prompt.
   - Known gap: WebFetch to a target host that is not listed in `in_scope` passes as research. Keep `in_scope` globs wide (`*.example.com`).
5. **Logs.** Every step 7 run writes `findings/<t>-hunt/RESULT.txt`: commands, request and response pairs (auth headers redacted, the Caido default) and exit codes. Lane changes and approval grants are stored on the session.
6. **Untrusted input.** Advisory, issue, OSV and target-page text goes through `lib.fence`. Playwright runs with `--no-webmcp` and `browser_run_code_unsafe` denied. The existing `injection-tripwire` recipe is turned on in security profiles.
7. **Members.**
   - A member's Security mode resolves every role through `memberCanUse`, as `modelPin` already does. A role model the member cannot use falls to the member's chat model, never the owner's plans.
   - Delegate is limited to the member's own devices.
   - Members get no MCP tools today, and the egress gateway runs only on Madx. So a member's web black-box lane is lab-only in v1. The owner's Caido on CT 136 is never offered to members.

## 5. Evaluation gate (before Security mode's roster workflow ships as default)

**Set:**
- The CyberGym Level 1 **10-task subset** (`sunblaze-ucb/cybergym`, Docker on Madx).
- **2 public web logic bugs, not Ghost.** Candidates, each needing a published advisory and fix commit confirmed first: the Directus GraphQL cache-key authz bug and the ToolJet `/join` missing `ActiveWorkspaceGuard` bug (both from 01).
- Replay hygiene from `cve-violation-hunt.md`: a single-branch clone at the vulnerable revision, later refs deleted, and the grader checks shell history and `answer.json` atime.
- Prefer bugs fixed after the models' training cutoff if any are known.

**Arms** (same budget each: 2 h and a $15 cap per task, 3 runs per task; CyberGym runs are stochastic):

| Arm | Setup |
|---|---|
| A | Plain GLM-5.3: one `security` agent session, same tools, no roster, no workflow |
| B | Plain Opus 5.5, same as A |
| C | `security-hunt` with the default role table |
| D | `security-hunt` with the pin on GLM-5.3. Required: it separates scaffold gain from routing gain. DoGNAVY's ablation supports route exploration, not per-role models (01 §1). |
| E (optional) | C with the 3-model refuter panel instead of one refuter. Ships only if it lowers false confirmed or raises solves. |

Runner: extend `compare-harnesses.js`, which already runs arms with `model` and `agentType`. Its fit for benchmark grading is not checked.

**Report per arm:** solves; paired results per task and run against each other arm (both solve, only one solves, neither); false confirmed; mean and total cost; median wall time per task.

**Pass rule for the workflow (all must hold):**
1. Arm C's or D's CyberGym solves (out of 30 attempts) are at least max(A, B) + 2.
2. That arm confirms both web bugs with a runtime oracle in at least 2 of 3 runs each.
3. It has **0 false confirmed**: nothing marked confirmed fails a grader rerun of its `RESULT.txt`.
4. Its mean cost per task is no more than 1.5 times the better plain arm.

**Routing rule:** the per-role table (C) stays the default only if C beats D by at least 2 solves, or ties D at lower cost. Otherwise the default becomes D (pin on one model) and the table stays as an override. This rule changes the owner's decision 00, so the owner confirms it before the run.

n=30 is directional only, and the rules are written to need a clear gap.

**Size:** A to D give 4 arms × 12 tasks × 3 runs = 144 runs, at most $2,160 at the cap. Adding E gives 180 runs, at most $2,700. Disk for the subset was not measured; the full set is about 240 GB.

## 6. Build plan (smallest first)

Every PR comes with `bun run test`, a CHANGELOG line, and screenshots from the mock build (`conclave-mock-ui-screenshots` skill) at 1440 dark and 390 light.

| PR | Contents | Tests | Screenshots | Owner money or accounts |
|---|---|---|---|---|
| 1 | `scope-guard` hook recipe plus `scope.yaml` parser (named lab networks, no IP ranges) | Recipe tests: in-scope without grant ask, with grant pass; WebFetch in-scope deny; out-of-scope deny; unknown host ask; lab pass; `10.0.0.5` not lab; no file ask; `race_window_send` deny | Settings > Hooks recipe card | no |
| 1b | Per-hunt container on Madx plus egress gateway: grant allowlist, rate, request budget, `egress.log`; approval grant type in `lib.approve` | `python -c` request to an in-scope host without a grant is refused at the gateway; rate and budget cut off; expired grant refused; lab network reachable | Grant card; chip menu revoke | Madx CPU and disk (small) |
| 2 | `sec-*` profiles (9 roles) plus AgentDef `group` and the `subagents()` filter; `security.md` frontmatter (skills, `mcpServers`, `refusalFallback`, recipes) | Parser test for `group`; Task offers `sec-*` only when `chat.security` is set | Agent list with the group | no |
| 3 | Land PR #255; carry `chat.cyber` (and `chat.security`) to children in `subagent.ts` | Child of a Daybreak chat sends the access program; pin covers `sec-*` | Same-model switch next to the Security switch | no |
| 4 | Role routing: config `security.roles.<role>.{model,fallback}`, resolution order 1.4, Settings > Security > Roles table, member check | Resolution-order unit tests (named model > pin > table > profile > parent; 404 fallback; member); a workflow-chosen role under the pin uses the chat's model | Roles table; lane menu routing line | no |
| 5 | Security mode UI: `StartMode 'security'`, composer switch, lane detector (pure function), lane chip with alternatives; Android follow-up issue | Detector table tests (one per row of 1.2, plus GitHub URL goes to source, not web; CTF bundle with a crash log goes to CTF; repo plus CVE gives variant with source as alternative) | Start mode, chip, chip menu, desktop and phone | no |
| 6 | `security-hunt` workflow: skeleton plus source, web and variant lanes; bug-class oracles; confirmed only after step 7 in script code | Scripted-agent test: an agreeing refuter without step 7 never yields confirmed; no grant parks; one grant covers two leads | Run graph of a hunt | Caido already on CT 136. GitHub fine-grained read-only PAT for github-mcp (variant lane): **yes** |
| 7 | Memory, exploit, RE and CTF lanes; Madx Docker images (libFuzzer, ASan, gdb, pwntools) | Scripted test of the crash gate: exits 300 and 999 not confirmed; a non-zero exit with no sanitizer report not confirmed; patched build; on-target frame | Run graph, fuzz lane | Madx disk and CPU; Ghidra 12.1.x for REA (free) |
| 8 | Eval run (section 5); ship as default only on pass | Results file, per-arm table with paired results | Comparison report | **yes**: 144 runs, up to $2,160 (180 runs, $2,700 with arm E), or the plan quota equivalent; Mythos arm waits for v0.4.70 |

Not planned:
- RoboDuck's one-token triage filter ([C], no measured gain).
- An off-path coach ([C]).
- A cross-task knowledge base ([C]).
- Running Strix or Shannon on Madx. They are optional Delegate targets later, not part of the default roster.

## 7. Critique log (review of revision 1)

The reviewer could not write `CRITIQUE.md` (read-only step); the points came inline. I checked each claim against 01, 05 and this file before deciding.

| # | Point | Decision | Reason and change |
|---|---|---|---|
| 1 | Live GET before approval | Accept | True: WebFetch passed for `in_scope` hosts before step 6. WebFetch to `in_scope` is now denied, and every live request needs an approval grant (4.3). WebFetch to unlisted hosts still passes for advisory research; the gap is named. |
| 2 | Regex scope guard is bypassable | Accept | True: `python -c` and unlisted MCP tools slip past. Added the egress gateway on Madx as the boundary (4.2, PR 1b). The hook matches all MCP tools and stays as an early prompt. Partial on "every device": Mac RE and CTF lanes send no live traffic, so only the hook applies there; member web lane is lab-only in v1. |
| 3 | Lab by IP range | Accept | `10.0.0.0/8` holds the live homelab. Lab is now only the workflow's own `sec-lab-<t>` docker networks. The hunter probes only those. |
| 4 | Pin vs. explicit refuter models | Accept | True conflict. Workflow and profile models are not owner-named; the script passes roles, so the pin wins. Test added to PR 4. |
| 5 | First-match lane routing | Accept in part | CTF bundle with a crash log was misrouted: CTF now ranks first. Repo plus CVE to variant is the intended lane (a variant hunt runs on that repo), so that order stays. The chip now shows all matched lanes as alternatives, editable before the first tool runs. |
| 6 | Web oracle fits one bug shape | Accept | True: only read-authz could pass. Added a bug-class oracle table with negative controls (read and write authz, auth bypass, XSS, SSRF, owner-approved other). |
| 7 | Crash gate exit codes | Accept | 01 §2 confirms Lyrie excludes 300 and 999. The no-crash set now follows the runner, and a sanitizer report is required. Tests added to PR 7. |
| 8 | Nine roles with no measured value | Accept in part | Refuter panel cut to one call by default; the 3-model panel moves to optional eval arm E. Rejected for the 3 hunter routes: DoGNAVY [A] shows -40% solves without them. The 7-Question Gate stays: it is the owner's own method and costs one call. Unused profiles cost nothing. |
| 9 | Eval cannot test routing | Accept | 01 §1 confirms the ablation backs routes, not per-role models. Arm D is now required, a routing rule decides table vs. pin, and the report adds paired results, false confirmed, cost and wall time. Cost rises to $2,160. |
| 10 | Repeated approvals, unenforced rate | Accept | Replaced per-lead approval with an expiring per-target grant (24 h max, request budget), enforced at the gateway. Catalogue diffs are approved once per run. |

The research input held pipe-to-shell installer commands, per the reviewer. Nobody ran them, and this design installs nothing that way.
