# Changelog

All notable changes to Conclave. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each GitHub release's notes come
from the section of its version (`scripts/releases/notes.ts`); a release
without one fails. At tag time, rename `[Unreleased]` to the version and date,
like `## [0.4.16] - 2026-10-24`.

## [0.4.34] - 2026-10-26

### Added

- Settings > Providers > Add a provider > Custom provider (OpenAI or Anthropic compatible): name, API style, base URL and key, Find models lists the endpoint's models, ids can be added by hand, and Test sends each one tiny request; only models that answer are saved. Custom provider rows get Remove provider (entry and key). Owner only `POST /api/providers/probe` and `/api/providers/probe-model` probe an endpoint without saving it.

### Changed

- `PATCH /api/config` refuses a new provider entry with a bad id, an unsupported type or a non-http(s) `baseUrl`, and `providers.<id>: null` removes an entry.

## [0.4.33] - 2026-10-26

### Added

- Settings > Models > Accounts: a plan's row has Refresh (the Subscriptions refresh, shown when CLIProxyAPI can refresh it) and, when it is not working or its sign-in is gone, Sign in again (that provider's sign-in, both Kiro sign-ins for Kiro).
- `DELETE /api/accounts/:id` and a Remove action for a saved plan whose sign-in CLIProxyAPI no longer lists (`gone: true` on the account). Owner for the hub's plans, a member for their own; a plan still signed in is refused (409) and stays removable in Subscriptions.

### Fixed

- Removing a sign-in in Subscriptions also drops its saved account, its place in every vendor and per model order, and refusal fallback entries pinned to it. Before, the account stayed on Accounts as "Not signed in" for good (three removed Gemini sign-ins). A saved plan CLIProxyAPI stops listing is never dropped on read, so a restart cannot lose the order.
- Kiro's dotted model ids (`claude-opus-5.5`) join the hub's model (`claude-opus-5-5`): its per model order, failover, cooldowns and Per model list. Calls still send Kiro's own id.

## [0.4.32] - 2026-10-26

### Added

- Kiro sign-in with Google or GitHub: a second Kiro row under Subscriptions (provider `kiro4cpa-social`, same pinned kiro4cpa 1.0.5 plugin) starts the plugin's social login on the hub, opens only Kiro's `https://app.kiro.dev` page, and takes the pasted `127.0.0.1:3128/oauth/callback` address to the plugin's `login/social/complete` route (the plugin checks its own state). The account lists as Kiro, not Google. Live Google or GitHub sign-in is not yet verified.

## [0.4.31] - 2026-10-26

### Added

- Usage recap: the Usage page now shows the last 14 days as two small stacked charts, spend (at API prices for plans) and requests per provider per day, drawn from the recent-requests feed in inline SVG (self-contained component, no new dependency).
- The agent glyphs and the pet on Android, ported from the web's v0.4.29 motion work: each running task's row in the running-tasks sheet draws its agent's one-stroke glyph (a violet light travels it while it runs, holds amber when waiting on you, the fault color when failed), and the "2 running tasks" line above the composer shows the pet doing what most of the jobs do (researching, building, testing, reviewing). Only the first three rows move; off screen it stops, and with the system "Remove animations" every state draws its still pose.
- Workflow launch forms and saved presets. A workflow can declare its args in `meta.args` (`{ question: { type: 'string', description: '...' } }`; checked on load) and the Run sheet (web) and the new Android workflow library render a typed form instead of the JSON box; undeclared workflows keep JSON. Any workflow's args can be saved as named presets on the hub (`GET/POST/DELETE /api/workflows/:id/presets`, per account) and picked again to rerun. `review-changes` and `deep-research` declare their args. A typed form keeps a "More args" JSON box (web and Android) for args the schema does not list, such as `votes` or `maxVerify`; picking a preset replaces the whole form, and Android has its own Save button. Saving and deleting a preset are both audited.
- Per-account HTML signature on email drafts (Settings > Calendar and mail): when a signature is set on a mail account, saved drafts (Gmail API raw MIME, IMAP `APPEND`, and Outlook) are built as `multipart/alternative` with the plain-text body followed by the plain-text version of the signature, plus an HTML part with the body escaped and wrapped in paragraphs above the sanitized signature HTML (`table`, `tr`, `td`, `span`, `b`, `strong`, `a` with `http`/`https`/`mailto`, `br`, `div`, `p`, and `color`/`font` styles only).
- GitHub Copilot and Kiro plans through CLIProxyAPI's plugins: the hub fetches the plugin build of CLIProxyAPI where the host can run it (`_no-plugin` asset otherwise), keeps the config's plugin block across rewrites, and lists both under Subscriptions for each member to sign in. Live sign-in is not yet verified. Upgraded hubs' old bare `plugins: {enabled: false}` is treated as unset so plugins turn on, an offline hub keeps running its working static binary instead of failing the migration, and plugin artifacts are trusted by the official store's claim plus the pinned version (no artifact hash).
- Files the model saves in a chat's (or the Assistant's) outputs folder without calling `ShareFile` now get a file card at the end of the turn, so every client shows them as downloads, however the turn ends. Sessions with a project folder do not get this; they still share with `ShareFile`.
- Tool preflight before a subagent or delegated job starts: a brief whose keywords need a shell or file changes is checked against the agent profile's tool list (and a read-only Delegate job's missing edit tools) and refused up front with words naming a better agent (coder, general-purpose), instead of starting on an agent that lacks the tool and failing mid-run. Keywords only, so an unsure match runs as before.
- The iPhone app checks its bundled web version against the hub's. When they differ (the hub updated, the app did not), a line at the top says the app has an older version and to rebuild or reinstall it; Later hides it until the hub's version changes again. The app's version is the last git release tag at build time; a build without tags skips the check, and the app no longer also shows the reload line.
- Attachment delivery receipts. Each user message records, per picked file, whether the hub prepared it (a zip keeps its name while its entries keep their own) and whether the request carried it; the web chat shows a quiet line per file that was expanded, left out of a request (a model without vision or PDFs) or omitted, with the reason. A file the hub cannot read is never dropped silently: the send is refused with its name, and the apps ask "Send without it?" before the message goes on. Inclusion is reported; the apps never claim the model read the file.
- Save drafts without asking: a per-account setting (off by default, Settings > Calendar and mail) that makes the Assistant's `MailDraft` save the draft straight into Drafts with no approval card. It never sends; sending still needs approval, and the email-reading agent still cannot draft.
- A chat's composer draft, its text and attached files, now survives a browser reload or the OS closing the app, in both the chat and the session composer. It is kept per chat in IndexedDB (text and files under separate keys, so typing never rewrites the files) until sent or cleared, saved when you switch chats or hide the page, and removed when the chat is deleted or you sign out. A draft the browser cannot store shows a toast. The Android composers on the Chat tab and the session screen keep their draft too, per chat in the app's own storage (text and files apart), so it survives Android closing the app; sending clears it, a failed send puts it back, and deleting the chat or signing out removes it (a chat screen closing after sign out cannot write it back). A draft the phone cannot store shows a toast instead of closing the app.
- `docs/research/SCRAPLING-BENCH.md`: the written-up 2026-10-24 hub benchmark behind the Scrapling catalog entry, Fetcher and StealthyFetcher vs CloakBrowser per site with RAM, startup and disk. Verdict: the entry stays opt-in; the plain Fetcher is the cheap default.
- A "Why this turn stopped" card at the end of a chat (web and Android): refused, usage limit, provider error, stalled, stopped by you or interrupted by a hub restart (only a turn with the "Stopped" notice counts as stopped by you, also a Stop during a tool run that can not resume; a harness error or output limit shows its own notice, not "stopped by you"), with the evidence (the notice, the refused reply, the time of the last progress) and the next step (Retry with another model and Try the next model stay on their notice). A running subagent in the running-tasks list now shows its session's last activity ("Active 2 min ago"), and "No activity for 7 min" in amber once it is quiet for 5 minutes, so a stalled task does not look alive. A task paused or waiting on your approval or answer shows no activity time. Workflow runs have no activity time on the hub yet and show none.
- Per-task fallback policy: a task's limits (its own `meta.limits`, or the config's session, routine or subagent limits) now carry `fallback` with allowed destination providers, whether paid fallback is allowed, and a billed-cost ceiling that counts the whole tree's billed spend, on the task's own model too (descendants, retries and chores; each paid attempt first reserves a bound sized from its request, and a failed attempt keeps that charge unless the provider turned it away before answering). A call the policy denies parks the task with a "Task paused" notice; a provider's own spend limit still falls back or waits for its reset as before. An ancestor's policy stays binding: a child may narrow it, never relax it. Each automatic switch (a usage limit, a refusal walk, a dead model, a per-call failover) checks it, records where the task moved and the estimated cost on the session (`meta.autoSwitches`, shown on the Usage page), and a switch whose cost cannot be bounded is not taken: the task parks instead. Enforced only on Conclave-managed calls; a limit fallback onto an external harness is recorded, and the switch step labels a harness as outside the policy and shows the task's effective policy from the hub (a $0 ceiling included).

### Changed

- README, the site and llms.txt now match what shipped in 0.4.30 and this round: GitHub Copilot and Kiro plans (with the not-yet-verified caveat), two-way Claude Code sync, the per-task fallback policy, outputs-folder file cards, attachment receipts, the assistant's save-drafts-without-asking setting, and the Mac app's ad hoc signing (the "desktop apps are not signed yet" line now names Windows only). The comparison tables keep their "not listed" rule and were not rechecked.
- Usage restructured around the live questions: a "Now" section opens the page with the hub defaults (which account each vendor's next call uses by default, why the ones before were passed over, and, for the owner, the hub default fallback for a model at its limit everywhere: the usage fallback list, else the Refusal fallback list, else nowhere, with a link to Usage fallback). It says these are defaults: a model's own account order, an agent's own fallback or a task's fallback policy can route a call elsewhere, and the section does not show that per-call route; phone order puts Limits before the history, and every limit window's reset line names the clock time ("resets 15:40 (in 1h 22m)") instead of only the countdown.
- Settings > Models > Accounts: "Add an order for a model" offers every model a plan lists (a subscription or the Z.ai Coding Plan), not only models two or more plans share, and skips ids the hub cannot file under a vendor. A Z.ai order (a pay as you go key before the Coding Plan, say) now picks the first provider of a bare GLM call too. A Z.ai Coding Plan key at its limit hands the same call to the next Z.ai key in the order instead of waiting for the reset; a key over its hard budget is skipped. The Accounts API now tags each plan model with its vendor (`AccountDto.models[].vendor`).
- One notification per job. A workflow run, or a parent session and its subagents, now share one thread, through nested subagents and for failures too: each new notice replaces the last on your phone, the Android app and desktop (and alerts again) instead of adding to a pile.
- Added an end-to-end test for continuing a capped Claude Code chat in Conclave: import, a turn on another model, that model's usage limit failing over to the next one, and the turn written back into the Claude Code `.jsonl`.
- The web conversation opens a long chat with its latest rows only, as a session's transcript already does: older rows mount a chunk at a time as you scroll up and in idle time, rows off screen are skipped from layout, a #message link mounts its row and a few around it, the streaming tail stays mounted, and the scroll position holds while older rows mount. Short chats render as before.
- A foreground Bash command that is only a wait (`gh run watch`, `gh pr checks --watch`, `watch`, `sleep` over 30 seconds) now starts in the background with a one-line notice, so queued messages are read instead of waiting behind it. The session gets a note with the exit code and the end of the output when it ends or hits its timeout (600 seconds unless `timeout` is set). Compound commands, poll loops and quoted text are left alone, and so are subagents, workflow steps, routines and headless runs, which need the result before they report.

### Fixed

- The web screenshot script reaches the Map page on a phone again (the Map row lives in Settings' More list, not the panel index) and dismisses the "Conclave x.y.z is ready" popup that would sit over every shot, so the eight map screenshots regenerate correctly.
- Android retry and edit now pick your last message that actually has text, skipping the hub's context-only user rows (a Stop hook's feedback, say) the same way the web does, so a retry no longer resends an empty message or rewinds to a row you never wrote.
- WebFetch of `reddit.com` threads and listings now requests `old.reddit.com` `.json` endpoints with the Conclave `User-Agent`, retries once through the configured proxy in Settings > Browser when Reddit blocks the hub's address, and falls back to the hub's browser (including through the proxy) when HTTP stays blocked. A member's session never uses the owner's proxy or browser.
- Subagents and workflow steps on the `deep` tier (debugger and other built-in profiles) now run on the session's model when it is already deep tier, else on a deep-tier defaultModel, before the catalog's own pick. Before, with no `models.tiers.deep` set, an Opus 5.5 session sent them to Claude Fable 5.1. `models.tiers.deep` still wins.
- Discard or Clean up of a worktree no longer fails with "Directory not empty" when git removed the folder but a background git maintenance still held its `.git/worktrees` entry: the hub prunes the entry and finishes, branch included.
- The workflow test "a call the owner skipped stays skipped when the run resumes" no longer fails under full-suite load: scripted replies are held by a promise the test releases, and it waits on call state events instead of polling against 3 s timers.
- Accounts: a plan's short name no longer falls back to the old one (or none) right after Save. CLIProxyAPI keeps listing the old model ids for a while, and the models read after the save took those as the truth, so the name looked unsaved and another plan could take it. The saved name now stands until the list shows it, or for up to 5 minutes, and while the list shows the old and the new name side by side the new one wins, also after those 5 minutes. A plan's model count also stays right while an old short name is still listed next to the new one, with or without bare model ids.
- Usage-limit fallback to another model on the owner's session now updates `session.model` and keeps it across turns (`meta.limitFallback`), so every client header shows the model in use and later turns do not retry the limited model and fail again. At the start of a turn, the session moves back to the original model once its reset time (or 15 minutes) passes, or to a higher-priority model on the usage fallback list that is ready on its own account order (`switchBackModel`); when the usage list is off, the refusal fallback list's entries above the current model are that priority, and a model no account of the owner's tracks (a `limits.fallbacks` provider) keeps the ref as written. An account failover that ends in a model fallback now seeds the record with the first ref and its reset instead of the intermediate account, and a failover inside a call on a bare gateway id (another plan's own wire id, or a backup provider) now updates `session.model` and records `meta.limitSwitch`, so the next turn starts where the call landed. A manual model pick clears the fallback, and one-turn overrides, refusal walks, and member sessions are left alone.

## [0.4.30] - 2026-10-25

### Fixed

- Compaction no longer gives up on the summary ("Compacted N messages without a summary") when the small model fails or is rate limited: it tries the session's model next, then the limit fallback chain, logging each model that fails. A failed-summary latch only skips the model for the session model it was set under.
- The Mac app is signed ad hoc, so macOS no longer calls a downloaded copy "damaged". The first open still needs Open Anyway in System Settings > Privacy & Security, since the app is not notarized.
- A chat on an effort variant only one plan lists (Antigravity's `claude-opus-5-5-high`) that hits its limit now moves to the model itself on the next ready plan or key in the owner's order (a Claude plan first) and keeps it for the session, before the usage fallback list or the refusal list offers another model. Before, it went straight to Gemini, GPT or GLM and never came back to Opus. A CLIProxyAPI cooldown on a variant now also blocks the model itself on that plan, so the session does not move back to a plan that is still at its limit.
- A model call no longer sleeps on a long retry-after. A 529 or 503 that says come back in hours (CLIProxyAPI with a plan's credits spent) counts as a usage limit with its reset, and the retry loop waits at most 60 seconds; a longer wait fails over to the next account or model, or parks the session until the reset, and a subagent reports to its parent instead of hanging in running.
- A subagent or workflow agent that makes no progress past the stuck threshold no longer waits on an Inbox answer nobody gives. Its call is cut and it runs once on its fallback model (the parent's, else the hub default); if that is quiet too, or there is none, it stops and its parent gets an error result. A stall inside a tool with no time limit of its own (an MCP tool) skips the failover, so the tool does not run twice, and the error names the tool. If a cut does not end the loop, the next check raises the usual Inbox item. A foreground Task whose child failed now returns that error instead of a bare "(the subagent produced no final answer)".

### Changed

- Android: a shared PNG, JPEG, WebP or GIF file shows in the chat above its card, like the web. Animated GIF and WebP play on Android 9 and later and show their first frame below. Tap the image to open it. SVG never renders, and files over 20 MB stay a card only.
- Google (Antigravity) plans show the raw paid-credit balance and plan tier (AI Pro, AI Ultra) in Accounts and Usage. The hub reads `loadCodeAssist` through CLIProxyAPI with the credential's own token. Credits remain informational, without an invented percentage or quota, and never block ordinary model access. Provider cooldowns still apply.
- Harness parity for GPT, Gemini and GLM. `bun bench/checks/model-parity.ts` checks ten things per model on its own wire with no model calls: tool calls, Delegate, Workflow, ToolSearch, file reads, images, PDFs, zips, structured output and text attachments. GLM-5.3 now gets an attached PDF as text a vision model wrote, not "not readable": at most 2 new PDFs per request, only from a model the catalog says reads them, and a transcription cut at its 16,000-token limit says later pages are missing. `bun run test` now runs the parity check. Gemini 3 behind a Chat Completions gateway gets its thought signature back on tool calls. Models other than Claude get a short "Using Conclave's tools" section in the system prompt.
- Android Usage: pull to refresh shows the stored numbers at once, then asks the hub to re-read plan usage (`POST /api/limits/refresh`) and reloads the summaries with the records it imported. Members, who may not force a re-read, keep the stored values with no error toast. Each limit card says how old its numbers are ("read from OAuth, updated 3m ago"). Opening the page still reads only the stored values.
- Imported Claude Code chats keep the model they ran on (`meta.import.model`), and chats imported earlier get it on their next sync. With the Claude Code engine off, the chat goes on with that model when its provider is set up and still serves it, else the default model, both at import and on the first turn of a chat still on Claude Code. Chats an earlier import already put on the default model stay on it.
- A model call that fails with a provider error (a 5xx, a 400, a network error or a timeout; not a sign-in error, a usage limit or a stop) in agent, chat or plan mode now retries once on the next model of the usage or refusal fallback list, for that turn only, with a visible "X failed, retrying on Y" notice. If that retry also fails, the "Retry with another model" button shows as before.
- Android chat: the subagents one message starts are one card ("3 subagents, 2 running, 1 failed") with each subagent's named row under it, as on the web.
- The base prompt tells agents that "run a workflow" means the Workflow tool; Task subagents alone are not a workflow.
- A 429 with no usage reading blocks only the quota it came from, not the whole account. An Opus limit leaves Sonnet and Haiku ready on the same Claude plan and on the Anthropic API key. A Gemini limit on Antigravity blocks its Gemini models, which share one quota, and leaves its Claude and GPT models ready. A spend cap still stops the whole key, and the account card still shows the limit.
- Loop guard: polling has a budget. The same TaskWait, TaskList, WorkflowStatus, BashOutput or still-running TaskResult call with the same answer is warned at 10 times in a turn and stopped at 15, then the agent writes its final report. A TaskWait that blocked 30 s or more is honest waiting and does not count.

### Added

- Window starter for Google (Antigravity) plans: it goes by the 5 hour window of the model it sends, so the cheapest Gemini Flash starts the `5h gemini` window right after its reset. An owner-picked Claude or GPT model goes by the `5h 3p` window. Before, these plans showed "No 5 hour window".
- Resume now works after Stop too. A turn that Stop or a hub restart cut can go on from the session menu (web and Android): Resume starts a new turn on the stored transcript with a reminder to continue where it stopped. Subagent and workflow agent sessions do not get it (they resume through their parent or run), and a rewind clears it. The Android chat menu also gets Pause and Resume.
- Two-way sync with Claude Code: when a Conclave turn on an imported Claude Code chat ends, its messages go into the chat's `.jsonl` in Claude Code's own row format, so `claude --resume` shows them. No thinking is written from any model, Claude's own signed thinking included, because a block Claude Code cannot replay makes the API refuse the resumed chat. The device that holds the file skips the write while a Claude Code process has the chat open, or when the file changed since the hub read it (new daemon RPC `importAppend`, protocol 5, in the TypeScript and Rust daemons). A skipped write is tried again by the next Sync, the watch job, and the device connecting. Each written message takes the id of its row in the file, so the next sync counts it as present and does not fork, and a later Claude Code prompt still shows as new. A sync and a write-back of one chat file never run at once.

## [0.4.29] - 2026-10-25

### Changed

- Legacy .doc, .xls and .ppt are still refused, now with the LibreOffice command that converts them.
- Web chat: the subagents one message starts are one card ("4 subagents, 1 failed, 1 limited") with a line per subagent (state, label, agent, model, time, first line of its report; tap for the full report and Open session). Result notices, TaskWait, TaskList, TaskResult and TaskContinue fold into it, a later notice leaves a small "updated" line, and no raw `ses_` ids show. A workflow row gets a phase bar and agent counts, and its WorkflowStatus calls fold into it.
- Background tasks tell workflows, subagents and delegated jobs apart (web and Android). Each row leads with a kind icon and word: "Workflow · deep-research" with its phase, "Subagent · builder" with an icon per agent type, "Delegate · Code on MadX Arch". Rows show the subagent's model and the running time, and the list groups them by kind, workflows first.
- The Map names each node in 2 to 5 words instead of its raw title: imported "Continued in Claude Code on ..." and "Session continued from prior context" titles, "New chat", pasted pages, paths, ids and the project name its folder already shows are dropped, and a title with nothing left reads like "Code chat on MacBook". The line under it says what it is, its state and when it last worked ("Code · idle · 3h ago"). The full title stays in the tooltip and the drawer.
- The assistant is one conversation per account. Home's composer in Assistant mode, Plan my day and Goals send into it instead of starting a new session each time. Older assistant chats stay in the sidebar under History, and "New assistant chat" is gone.
- The Morning brief posts into the assistant conversation. The Heartbeat still runs in its own session.
- Android: Assistant is one continuous thread. Sending from Home in Assistant mode goes into the account's Assistant home session (`GET /api/assistant/home`) instead of starting a new session; the side panel lists it first as "Assistant", older assistant sessions under "History", and Assistant mode has no New. Hubs without the route (404) keep the old behavior.
- Paused sessions, tasks and workflow runs do not hold up an automatic update.
- A page change fades the new page in (240ms), and chat rows that arrive together fade in one after another.
- Reduce motion shows each pet and glyph in a still pose; they pause off screen and in background tabs.
### Added

- Read opens Word, Excel and PowerPoint files (docx, xlsx, pptx) and OpenDocument files (odt, ods, odp) as Markdown: headings, paragraphs, lists and tables; one table per sheet (the first 500 rows, with a note); one section per slide with its notes. Long documents page with offset and limit. The files are unzipped on the hub with no new dependency, so they work on paired devices too.
- Optional Docling server: set `documents.docling.url` (http or https, LAN is fine) and Read sends scanned PDFs, PDFs with tables, and docx, xlsx and pptx files to docling-serve for Markdown with OCR and table structure, falling back to the built-in readers on any error. Members' sessions never use it. `docs/research/DOCLING-MADX.md` has the commands to run it CPU-only in an LXC.
- Scrapling is in the extension catalog as an MCP entry (`uvx --from scrapling scrapling mcp`). The plain Fetcher is the cheap default; StealthyFetcher gets past Turnstile and fingerprint checks but downloads its own browsers and uses about 2 GB RAM, so it stays opt-in and complements the built-in browser.
- `POST /api/import/merge-duplicates`: lists Claude Code chats imported into more than one session; `{"apply": true}` keeps the copy with the most messages, points the ledger at it and archives the rest. A dry run by default.
- Setup step 4, "Make Conclave better": install recommended extension packs in one go (Starter on by default; Security and CTF, Homelab, Study, Google and Microsoft optional). One form asks for every key the chosen extensions need, then each one installs through the Discover routes with a row per extension. Extensions without a key or a program the hub lacks are skipped with the reason, and running setup again skips what is installed. Members never see setup.
- `GET /api/assistant/home` returns the caller's assistant conversation, made the first time, in the same shape as `GET /api/sessions/:id`.
- Routines take `sessionPolicy: 'home'`: a run is one turn in the assistant conversation, marked as from the routine, and its rules and unattended refusals apply to that turn only. Webhook runs and watches never use it.
- Pause and Resume for background work. Pause lets the tool call in progress finish (one still running after 30 seconds is cut and marked interrupted), then stops before the next model call. The session shows `paused` and stays paused across hub restarts. Resume goes on with the same turn, with no new message. Messages sent meanwhile queue. `POST /api/sessions/:id/pause` and `/resume`.
- Pause and Resume sit next to Stop on each background task (web Details panel, Android task sheet), in the session menu and on the workflow card. Paused rows say "paused" with a pause icon.
- Pausing a workflow run now also pauses its running agents, not only new ones. A run paused when the hub stops stays paused and runs again from its journal on Resume.
- TaskList, TaskWait and TaskResult report a paused task. TaskWait returns on it, so a parent does not wait for work that waits for you.
- Move to hub: the session menu's "Move to hub (copy folder)" (and `/move hub --copy`, and the Android session sheet) copies the session's whole project folder from its device to the hub's projects drive, byte for byte with node_modules, build output, `.env` and `.git`, then runs the session there. The folder on the device stays as it was. The copy streams with tar, shows bytes and files as it goes, can be cancelled, removes a partial copy, and refuses up front when the hub has no room.
- Move back to <device>: shows what changed on the hub since the copy (text diffs, size changes for binaries) and marks files that changed on the device too as conflicts. Copy back all, or without conflicts; nothing on the device is deleted unless "Also delete files removed on the hub" is ticked. Then the session runs on the device again.
- `projects.hubRoot` sets where copies go (Devices, the hub, Projects drive). Default `/srv/conclave-projects` when it is mounted and writable, else `~/conclave-projects`. docs/INSTALL.md shows how to bind-mount a big drive into the hub's LXC.
- Run in a worktree: a Code session in any git folder, on any device, can get its own worktree on a new `conclave/` branch from the folder's current branch, so several agents work on one repository without clashing. The session's header shows the branch, commits ahead and uncommitted files, with Merge into the base (refused while either checkout has uncommitted changes or the merge conflicts; squash optional), Open pull request when the origin is on GitHub and GitHub is connected, Discard (asks first) and Clean up after the merge. In the web "+" menu and phone options, and on Android. Workflow worktrees now use the same code to make and merge worktrees.
- A pet that shows what agents are doing: idle, thinking, researching, building, testing, reviewing, waiting, parked (asleep until a limit resets), done and failed. It sits on a workflow run's status line, the running tasks pill, the limit notice, the Inbox's open request and Home's first day empty state. Never in a chat reply.
- Agent glyphs: one small mark per agent type (explore, researcher, builder, tester, reviewer, debugger, designer, verifier, general purpose, workflow, delegate) in workflow call rows, the running tasks list and Delegate lines. A light runs along it while the agent works; it turns grey when done, red when failed and amber when waiting. Only three rows move at once.
- See every pet state and glyph at `/dev/motion`.

### Fixed

- Member calls never use the owner's plans (missing from 0.4.28).
- Installing or updating a plugin now installs its Node dependencies (`npm ci`, or `npm install` without a package-lock, with `--omit=dev --ignore-scripts`, 2 minute limit), so hooks that `require()` a package (ECC's SessionStart and `js-yaml`) no longer fail with "Cannot find module". When that install fails, the plugin stays installed and Extensions > Plugins shows the command to run by hand.
- A turn the loop guard stops now ends with a report: after the "Loop guard stopped the turn" notice, the model gets one call with tools disabled and is asked what it did, what it found and what is left. Subagents stopped this way used to return "(the subagent produced no final answer)".
- The step-limit wrap-up call asks for the same final report (what was done, found and left).
- Claude Code chats copied between machines (claudesync, Syncthing) no longer fail as "ambiguous: two imported sessions match this source". The fingerprint now holds the chat id, so a copy on another device joins its own session and a chat resumed under a new id is its own session. Rows an older import marked ambiguous are matched again.
- A chat that grew in Claude Code by more messages than Conclave added syncs in: the source's messages are appended and Conclave's own turns move to a child session "<title> (Conclave branch)". "Continued in Claude Code on ..." is made only when the Conclave side is longer.
- An imported Claude Code chat's folder is the path on the device that holds the file, taken from its project folder name when the file names another machine's path (`/home/default/CMU` on a Mac becomes `/Users/default/MadX/CMU`).
- Imported chats run on your default model when their tool's harness is off as an engine (the default), instead of refusing every turn with "Claude Code is off". The tool's session id is kept.
- A harness turn in a folder its device does not have asks which device has it, instead of failing with `posix_spawn ... ENOENT`.
- A subagent that ends with no answer because of a usage limit now reports `limited` (an error: `failed`), not `completed`.
- Model picker: a model's "via" choices now list every signed in plan that has it, also a plan of another vendor that lists only a variant. Opus 5.5 offers "via backup-gemini (Antigravity)", which picks that plan's own id (`cliproxy/backup-gemini/claude-opus-5-5-high`). Still one Opus 5.5 row. Web and Android.
- A shared file card failed with "Could not get the file. unknown session ..." when its turn also asked a question or ran a long call: the hub stores a step's results only once every call in it is done, and the download looked only there. It now also finds the result in the running step, so Open and Save work as soon as the card shows, on Android and the web.
- Toasts cut short ("Failed. A subagent runs where its parent session...") get an arrow-up button, "Show full message", that opens the whole text, selectable, with Copy on the web; an open toast stays until you fold or close it. The same on Android, where text past two lines was cut.
## [0.4.28] - 2026-10-25

### Fixed
- With both Claude plans at their limit, Opus no longer moves to the API key while Antigravity has room. CLIProxyAPI never gives the bare `claude-opus-5-5` to a plan that lists only `claude-opus-5-5-high`, so the hub now sends that plan's own id with its short name (`backup-gemini/claude-opus-5-5-high`) when it is the first ready plan, before trying the key.
- When a plan refuses a call for its limit, the hub now tries the next ready plan in your order, one at a time (a second Antigravity plan, or a Claude plan placed after Antigravity), and uses an API key only when no plan is left.
- Thinking replays only to the vendor whose account signed it. A conversation that moved between a Claude plan and Antigravity's Claude no longer sends one side's signed thinking to the other, which failed the call.
- A session a usage-limit failover moved to another plan goes back to the owner's first ready plan for the same model at the start of the next turn after its limit resets, with one notice ("Back on <plan>, its limit reset"). A model picked by hand after the failover stays. It waits until the first plan's reset time passes, or 15 minutes when the reset is unknown, so a short block that lifts does not bounce it back each turn.
- Spent Fable credits ("fable credits", paid extra) never block a Claude plan. Fable's own weekly window ("7d fable") stands in for the general weekly window for Fable models, so Fable stays usable when the general week is full while Opus waits for it. The status names the window that blocks ("Weekly limit reached"), never the credits. The 5 hour window still blocks every model.
- "Your signed in plans are at their limit. Using ... for this call." shows once per session for each place calls go, not on every call. It shows again after the session goes back to a plan whose limit reset.
- Plans whose vendor reports no usage (Google Antigravity) now show on the Usage page, web and Android, with "Usage not reported by Google" instead of being left out, and "Blocked" when the hub saw it refuse.

## [0.4.27] - 2026-10-24

### Changed
- Updates install by themselves when nothing is running. "Install updates automatically" is now on unless you turned it off (a saved `updates.auto: false` stays off), and `updates.window` picks when: `idle` (default) looks for a release every hour and installs once nothing ran on two checks in a row (10 minutes apart); `night` keeps 03:00 to 05:00, now also waiting for nothing to run.
- "Nothing running" means no session running or waiting for an approval or an answer, no background task, no queued message waiting to be sent, no workflow run running or queued and no routine run going. A session parked for a usage limit does not count: its resume job is stored and survives the restart.
- Device daemons update in the same window, each only when no session or task works on that device, before the hub restarts.
- Update now refuses while work runs (409, "2 sessions running: ..."). Settings > About then offers Update anyway and Update when idle, a one-shot that installs that version once nothing runs, also with automatic updates off.
- Android app updates: the app looks for an update at every start and, when it comes back, once an hour (was once a day). After you allow Conclave to install apps, the installer opens by itself, and a download checked earlier asks "Install now" at the next start. Skip this version and Don't show at startup work as before.

### Added
- A notification when the hub updated itself, rolled back or failed, with the old and new version (Settings > Notifications, Updates).
- Desktop app: updates install by themselves (Settings > Install updates automatically, on by default). The app checks at start and every 15 minutes, and installs once two checks in a row find the window not in use and the hub on this computer with no session running or waiting for an approval. A hub elsewhere does not hold the update back.
- Desktop app: an update that cannot install for lack of permission (a macOS app the user cannot write, a Windows install for all users) shows one notification, "Conclave X is ready. Click to update.", and keeps the tray item. A version that failed is not tried again by itself until a newer one comes out.

## [0.4.26] - 2026-10-24

### Added
- Usage fallback (Settings > Models > Usage fallback, `models.limitFallback: { enabled, models }`): an ordered list of models, separate from Refusal fallback. When a model is at its limit on every account, the next model after it on the list takes over, on the first ready plan or key of its own account order. A model not on the list starts from the top. Chores use the same list.
- Off or empty, a limit falls back on the Refusal fallback list as before. An agent with the refusal fallback off still gets no other model.
- Window starter for the Z.ai Coding Plan: one tiny request on the cheapest GLM (Flash, then Air) right after each 5 hour reset, sent on the zai provider with its key, inside the owner's starter hours. Its quota is read again around the reset.

### Fixed
- A plan that lists only an effort or thinking variant of a model (Antigravity's `claude-opus-5-5-high`, `claude-opus-4-6-thinking`) now joins that model's order in Accounts and the Per model list. A session moved to it after a limit, or by the Usage fallback list, asks for the plan's own id.
- The Z.ai Coding Plan's windows read as 5 hours and Week again: the plan now answers `CREDIT_LIMIT` entries, which mapped to one "Credit_limit" row. Unknown limit types read as words.

## [0.4.25] - 2026-10-24

### Added
- A member's session at a plan's usage limit continues on the same model on the member's next ready plan of their own. It never moves to the owner's plans or the owner's Refusal fallback list.

### Fixed
- Another vendor's plan that lists a model (Claude Opus 5.5 on Antigravity) now goes before the API key in that model's order also when you saved an order for the vendor: after your saved plans, before the first key. A per model order that lists the plan keeps it where you put it.
- With only an API key for a vendor, a model another vendor's plan lists goes to that plan first, and to the key when the plan is at its limit. A model the plan does not list goes to the key as before.
- A per model order for a model the hub cannot place under a vendor is refused with "Unknown model ...", instead of being saved where it never applies.
- A usage limit on a bare model id (`claude-opus-5-5`) now also blocks another vendor's plan that lists it, for that vendor's models only, since CLIProxyAPI already tried it.
- A Task or Delegate subagent waiting for its usage limit to reset is no longer reported as lost when the hub restarts. It continues when the limit resets and sends its report once.
- A usage limit's fallback follows the session agent's Refusal fallback setting. An agent with `refusalFallback: off` waits for the reset, and an agent with its own list falls back to that list, not yours.
- A subagent waiting for its limit reset that you write to directly stops waiting for the reset. Its report reaches the parent when that turn ends, and its scheduled resume is cancelled.

## [0.4.24] - 2026-10-24

### Added
- A signed in plan of another vendor whose own model list has a model now takes part in that model's order and failover: Claude Opus 5.5 on an Antigravity plan joins Claude Opus 5.5's order after the Claude plans and before the API key. Settings > Models > Accounts has a Per model section: add an order for a model two or more plans offer, and move any plan that offers it up or down (`PUT /api/accounts/order` with `match`; `vendor` may be empty to file it under the model's maker). A limit on a prefixed id (`ag/claude-opus-5-5`) blocks only that plan.
- The Z.ai Coding Plan is an account. Settings > Models > Accounts names it by its plan and shows its 5 hour and weekly windows with their resets, read from Z.ai's quota endpoint. Settings > Subscriptions lists it read only, as a plan that uses an API key. GLM calls go where they went before.

### Fixed
- A usage limit falls back to another model on its own. When no plan for the same model is ready and no `limits.fallbacks` entry matches, the turn moves to the first entry of your Refusal fallback list that is another model, can be called, and whose plan or key is not paused or limited. It says "X hit its limit. Falling back to Y for this turn." Configured `limits.fallbacks` still win. A model that hit its limit in a turn is not tried again in that turn.
- A Task or Delegate subagent at a usage limit now fails over the same way a chat does. If nothing is left, it no longer ends with "stopped at a usage limit". It waits for the reset, continues on its own, and sends its report to the parent as a background task's `<subagent_result>`.
- A Refusal fallback entry at its usage limit first tries the same model on your next ready plan, then moves on to the next entry.
- Chores (titles, summaries, memory, compaction) that hit a usage limit retry once on the next fallback model before they fail.
- Codex `usage_limit_reached` and `usage_not_included` errors sent mid-stream or with a non-429 status count as usage limits, not server or request errors. Gemini `RESOURCE_EXHAUSTED` on a non-429 status counts as a rate limit.
- Android's Usage page shows the latest numbers. It reloads when you return to the app and a couple of seconds after new calls are recorded, and its usage and limit reads run at the same time. Two accounts on one provider each keep their own limit card, with the account named on it, and budget limits read "read from the ledger".

## [0.4.23] - 2026-10-24

### Added
- A model without vision (GLM-5.3) can read images. Each image in an attachment or a tool result (a Read of a PNG, a screenshot) is transcribed once by a model with vision: all its text exactly, then a short description of its layout, charts and UI. The model gets it as `[image NAME, transcribed by MODEL: ...]`. The text is stored with the message, so later requests send the same bytes. Set the model with `conclave config set models.vision <provider/model>`; unset, the hub takes the small model or the default model, whichever has vision first. A member's session uses only models the member may use. Usage rows show the purpose `vision`. With no vision model, an image over 5 MB of base64, more than 8 new images in one request, or a failed call, the model gets a note that says why.

### Fixed
- A Code chat in the Home folder no longer shows "~ is not on <device>." with Choose folder / Continue without files. The folder check now expands `~` before it looks for the folder.
- Grep: when `path` is a single file and `output_mode` is not given, show the matching lines instead of listing that one file. Directories keep `files_with_matches` as the default.
- TodoWrite: accept a list of plain strings (each becomes a pending todo, the first in progress when none is) and a single todo object sent without the `todos` wrapper. Bad statuses, empty items and a missing list are still rejected.
- Workflow: the tool description and the "did not load" error for an inline or saved script now include a minimal working script (meta literal, one `agent()` call, `return r;`).
- A chat pinned to one signed in plan by its prefix (for example `cliproxy/personal-gpt/gpt-6.1-sol`) that hits its usage limit now continues on the same model on your next plan that serves it, in your account order, skipping paused and limited plans, and keeps that plan for the session. It says "GPT-6.1-Sol (personal-gpt) hit its limit. Continuing on GPT-6.1-Sol (backup-gpt)." Only when no other plan can take it does it use the configured fallbacks or wait for the reset as before. A limit on a prefixed model no longer marks your other plans as limited too. Member sessions never move to the owner's plans.

## [0.4.22] - 2026-10-23

### What's new
- Web and Android: retry a failed provider inference with another model in the same session, preserving the full transcript and completed tools without resending the prompt. Disabled providers and stale retries are rejected; retry offers expire when the hub restarts, and generic prompt replay stays unavailable for unresolved provider failures.

### Fixed
- Preserve the original assistant block order when thinking or redacted thinking follows a tool call, including when consecutive assistant messages merge.

### Added
- Bounded, content-free provider boundary evidence for HTTP 400 signed-thinking replay rejections: session/model identifiers, request and tool hashes, reported indexes, and capped block type/byte/hash metadata for the suspect and last assistant messages. Compares against the previous completed request in the same provider instance and session/model/user partition, with at most 64 entries. Normal requests and unrelated errors emit no replay diagnostic. This gathers evidence; it does not fix the rejection or change history, retries, or provider settings.

## [0.4.21] - 2026-10-23

### Added
- Sessions can hand you files. The new ShareFile tool turns a file a session made (a PDF, an image, a spreadsheet, a zip) into a file card in the chat, with a preview for images, PDFs and plain text, and a Download button. Chat gets it for files a delegated job made; the assistant and Code get it with their other tools.
- Sessions on the hub with no project folder (Chat, the assistant) save files for you under `<home>/outputs/<session>`, and the prompt says so.
- The Outputs card in the session panel now lists shared files too, so a file made with Bash shows up.
- Android: a file a session shared shows as a card under the turn's work, with its name, type and size, Open (copied to the app's `shared/` cache and opened in the app for its type) and Save (the system's save picker).
- Shared files come only from `GET /api/sessions/:id/files/:toolUseId`. The hub finds the ShareFile result in that session's own messages and checks the path again on every download. No path comes from the request.
- A shared file must be in the session's folder, its outputs folder, or the folder of a session it started. On the hub, symlinks are resolved first, the hub's private files are refused, and nothing else under the hub home is served. Under the hub user's home only a real subfolder counts: a session in `~`, `~/`, `/home` or `/` never shares `~/.ssh`. Regular files with one link only (a hard link could name a private file), 30 MB at most.
- A download opens the checked file with `O_NOFOLLOW` and sends it only when its device and inode match the check, so a file swapped in between is refused. It makes no folders, and a member's download goes through the same guard as her tools.
- The web shows a file card only for a ShareFile call's result, never for `meta.file` on another tool's.
- Downloads are attachments with `nosniff` and a `sandbox` CSP. Only PDF, PNG, JPEG, GIF and WebP may open inline, so SVG and HTML never run as the hub's page. Each download is in the audit log. Untrusted agents never get ShareFile.

### Changed
- Provider config: `responsesWire: { models }` and `geminiWire: { baseUrl, models }` next to `anthropicWire` send matching models over the Responses or Gemini wire on one provider id.

### Fixed
- GLM on the Z.ai Coding Plan sees every tool again. `zai` now uses Chat Completions at `https://api.z.ai/api/coding/paas/v4`, as opencode does, instead of the Anthropic shim at `/api/anthropic`, which kept only the last tool (ToolSearch) of a long tool list and added its own MCP tools. A config that pinned the old address moves to the new one when the hub loads it, once: the entry gets `migrated: "paas-v4"`, so a later switch back in Settings or `conclave config set` survives restarts; another `/anthropic` address keeps the Anthropic wire, and an address with a `${...}` placeholder is left alone. The model gateway still sends Anthropic-format calls for `zai` (`/gw/anthropic`, `/gw/p/zai/v1/messages`, aliases like `zai/glm-5`) to `https://api.z.ai/api/anthropic`, named by the new `anthropicBaseUrl` provider setting.
- GLM thinking on Z.ai: Effort off now sends `thinking: { type: "disabled" }` (Z.ai thinks unless told not to), and so do calls that set no effort (titles, memory, small model); on sends `clear_thinking: false`, so GLM keeps its reasoning across a tool loop.
- Structured output on Z.ai: its Chat Completions take `response_format` `json_object` only, so the schema goes in the system prompt.
- GPT models on a signed in ChatGPT plan (CLIProxyAPI) go over the Responses wire, so an image a tool returns stays inside that tool's result instead of a later user message.
- Gemini models on a signed in Google plan (CLIProxyAPI) go over the native Gemini wire, so tool results pair with their calls by name and thought signatures survive.

## [0.4.20] - 2026-10-23

### What's new
- Daybreak Blue in the model picker: a ChatGPT plan whose own model list has Daybreak (as Codex shows it) gets a "Daybreak Blue" row under OpenAI. It runs GPT-6-Sol on that plan with Daybreak Blue and never sends the retiring alias. Daybreak Red runs gpt-5.6-cyber. The Cyber access choice on GPT-6 rows stays.
- Refusal retries with Daybreak: a ChatGPT plan marked "Use when a model refuses" and approved for Daybreak retries a refused GPT turn with Daybreak Blue. It keeps the same model when that model takes Blue, else uses GPT-6-Sol, and it can retry on the plan that refused. A refused Claude turn goes to that plan on GPT-6-Sol with Daybreak Blue. The notice names it ("Answered by GPT-6-Sol, Daybreak Blue"), and the session's own Cyber access stays as it was.
- Settings > Web search: pick the engine WebSearch uses from 12 free engines (Tavily, Exa, LangSearch, Linkup, Firecrawl, You.com, Serper, SerpApi, Jina, Brave, your own SearXNG, or DuckDuckGo with no key). Each shows its free allowance, whether it needs a card, and the steps to get a key with links. A key you paste is stored as a hub secret and never shown again; Test runs one real search. With Choose automatically, the hub uses the first engine with a key, in the order shown.
- Hidden models: list model refs or patterns like `cliproxy/glm-*` in Settings > Models > Defaults (`models.hidden`). Pickers leave them out, no tier, fallback, agent, workflow or task uses them, and a chat saved on one says so instead of switching.

### Changed
- When a site blocks the hub (a block page, a login wall, a bot check, a Cloudflare challenge), WebFetch, WebSearch and the browser retry once through the proxy in Settings > Browser, in the hub's own country, and say so in one line. Without a proxy they say plainly that the site blocked the hub. A member's request never uses the owner's proxy.

### Fixed
- A ChatGPT plan's own model list was read but never applied to its account, so on hubs like the owner's the Accounts page kept CLIProxyAPI's names ("GPT 6.0 Astra") and models the plan hides (Codex Auto Review). It now shows the plan's names and leaves the hidden models out. A failed read of the list is now logged as a warning instead of a debug line.
- A workbench session lost its Cyber access setting when saved or changed (for example on a title update). It now keeps it.
- A saved `gpt-daybreak-blue-latest` ref now runs GPT-6-Sol, which takes Daybreak Blue. Before, it ran gpt-5.6-sol, which does not, so Blue was never sent.
- Attached text files (Markdown, HTML, code, a read zip) reach every model again. Z.ai and other Anthropic-compatible endpoints dropped them, so GLM said nothing was attached. They now go as text on every wire, up to 200 KB per file and 512 KB per message, with a note where a file is cut. A PDF, archive or binary a model cannot read gets a one-line note instead of vanishing, and a file the browser sends with no type (a `.md`, a `.zip`) is known by its name.
- GLM on Z.ai sees Conclave's tools again. Z.ai's Anthropic endpoint kept only the tool marked for caching and swapped the rest for its own, so GLM could not Read, run Bash or return structured output. Only Claude models get a cache marker on the tool list now; system and message caching are unchanged.
- GPT models on the Responses API read images from a tool (a Read of a PNG) again. The image now rides in its call's `function_call_output` instead of a later user message, and a PDF a tool attaches goes along the same way. Chat Completions and Gemini send a tool's PDF too.
- Files inside tool results follow the attachment rules: text files go as text, and a model the catalog lists without vision gets a one-line note for an image instead of a picture it cannot read.
- ToolSearch no longer lets an agent search in circles: a search for a Conclave tool the agent does not have (Delegate, Task in a subagent) says it is not available, a search that finds nothing lists the tools the session has, and from the third empty search in a turn the loop guard warns and then ends the turn.
- Settings > Refusal fallback: a step on an API model names its key (for example "Z.ai API key") instead of "Your order".
- Android: tapping a "Message from subagent" row no longer crashes the app.

## [0.4.18] - 2026-10-23

### What's new
- Cyber access: on GPT models from a ChatGPT plan, choose Default, Standard or Daybreak Blue (Daybreak Red on gpt-5.6-cyber) next to effort. Conclave sends it as OpenAI's `access_programs`, tells you when a different program served the reply, and explains OpenAI's access errors.
- Each ChatGPT plan's own model list, read as Codex reads it: its names, which models are hidden, and each model's efforts up to `ultra` with its default.
- A finished subagent or workflow shows one "Message from subagent" row with its state, which opens to the report.

### Changed
- The model picker shows each model once, by name only, grouped by maker and family, newest first. Other routes to the same model sit behind "via". Effort and thinking variants fold under their model; image and review models are out of the chat picker; dates are gone from names.
- The retiring Daybreak aliases (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, retired by OpenAI on October 28) map to their models with the matching Cyber access.

### Fixed
- No more empty message bubbles after a subagent or workflow finishes, or for messages with only hook feedback.

## [0.4.17] - 2026-10-23

### What's new
- `/btw <question>`: ask a side question while a turn runs. It gets its own quick answer from the session's model, as a card you can dismiss, and never enters the turn or the transcript.
- A message you send while a turn works is delivered into that turn right after the current tool call, as Claude Code does. A turn that only writes text keeps it for its own next turn.
- Held messages show "Stopped" with a Send button and an x, on the web and on Android.

### Changed
- Stop, Edit and Retry keep what you queued (held, visible) instead of dropping it.
- Agents never block a turn on a long wait; they start it in the background or hand it to a background agent, so your messages are read.
- The README is a front page for the public repo.

### Fixed
- Queued messages were lost when a turn was stopped or the hub restarted. They are now saved on the hub and survive a restart.
- An agent's tier model (deep, fast) skips a model that answered "model not found" for 6 hours.
- Members' own plans: the tool guard refuses more forms of member and hub secret paths; a granted member gets a clear refusal when the hub's CLIProxyAPI is off; a member's empty Accounts page points to Subscriptions; a member's CLIProxyAPI view never carries the hub's token.

## [0.4.16] - 2026-10-23

### What's new
- Members' own plans: each member signs in their own Claude and ChatGPT plans, on a CLIProxyAPI of their own, with their own Subscriptions and Accounts.
- Two members cannot see or use each other's plans.
- A chat that clones a repo or works in one, started from a home folder, moves into that repo's project.
- WebFetch reads Reddit threads and listings through Reddit's JSON, and says plainly when Reddit or the search engine blocks the hub.

### Changed
- Conclave is now open source under the AGPL-3.0 license.
- The web folds a running turn's steps into one closed row, as Android does, with what runs now as its line.
- Subagents and delegated sessions run in the permission mode of the chat that started them, never plan mode unless that chat is. A read-only job loses the file edit tools instead.
- Chats are named from their first exchange and renamed once after the third turn. A title you set is never changed.
- Commits made by agents keep you as the only author and end with a `Committed-by: Conclave (model)` line.
- Releases and updates now come from the main repo, default-cybe/conclave. Installs made before 0.4.16 keep updating, and move over with this update.
- The website moved to https://conclave.dymnitguys.com.
- CI runs only on main and on pull requests.
- Hardened the GitHub workflows: pinned actions, tighter permissions, no signing key near install scripts.

### Fixed
- An agent whose model the hub cannot serve falls back to the chat's model instead of failing.
- Members' own plans, from the review: no CLIProxyAPI left running after a hub crash, no crash loop at start, a failed start can be retried, a sign-in in progress survives signing out another plan, a call never moves to the hub's plan mid-call, and two installs no longer collide.

## [0.4.15] - 2026-10-23

### What's new
- Accounts: "Use when a model refuses" on a plan or key.
- Accounts: sign in with a sign-in name or an email.
- Android: pair a device from the Devices screen.
- Desktop: sign in to a hub with a name and password.

### Changed
- Model picker: makers first, their models one level in.
- Accounts: a plan's short name is learned from its models, and ChatGPT plans list their own models.

### Fixed
- A flaky zip test now waits for the model request, not only the reply row.

## Older versions

See GitHub releases.
