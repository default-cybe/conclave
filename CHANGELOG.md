# Changelog

All notable changes to Conclave. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each GitHub release's notes come
from the section of its version (`scripts/releases/notes.ts`); a release
without one fails. At tag time, rename `[Unreleased]` to the version and date,
like `## [0.4.16] - 2026-10-24`.

## [Unreleased]

### Added

- Meetings: the overlay renders answers as streaming markdown (streaming-markdown, vendored from Pickle Glass; only the new text is parsed each frame): the "Say this" bullets large with **bold** terms, then code blocks with highlighting and a Copy button, tables, ```chart blocks drawn as small SVG bar or line charts, and ```mermaid diagrams (loaded only when one appears). Model output never becomes HTML: links open in the browser, images become links. Earlier answers are one step back with the arrows or Ctrl or Cmd + Alt + [ and ], shown as "2 of 3"; Copy copies the whole answer.
- Meetings: a Meetings page (sidebar, `G N`, and the Android side panel) with Now, Upcoming and Past. Schedule a meeting with a project folder, a calendar event, reminders and a steering prompt (presets or your own text, short or long answers). Before it, the hub prepares a dossier from the folder's chats, workflows and commits that you can edit or re-run; your edits survive a re-run, and a prep over 500k tokens waits for your OK. At the start time a notice links to the meeting's **Open overlay**. The Meeting button in the chat header is gone; the session menu has **Schedule a meeting here...**.

### Changed

- Meetings: the overlay window fits its content (at most 75 % of the screen), is a one-line bar while no answer shows, keeps to the bottom only when you were there, and fades each new block in (none with reduced motion). Streaming a 2,000-token answer in mock mode dropped no frames.
- Meetings: live answers may add a short table, code block, chart or diagram after the bullets when the question asks for numbers, code or structure.

## [0.4.52] - 2026-11-01

### Fixed

- Meetings: starting a meeting from a desktop app older than 0.4.51 now says to update the app in Settings > About, instead of `Command meeting_open not allowed by ACL`.
- Desktop app on macOS: tapping Start listening in a meeting no longer quits the app (the overlay's keyboard-focus switch wrote a field the meeting panel does not have). The app is signed with the microphone entitlement so macOS can ask for the mic, and a crash now writes its reason to `~/Library/Logs/dev.conclave.desktop/panic.log` (the app's log folder on Windows and Linux).

## [0.4.51] - 2026-10-31

### Changed

- Hub: the transcript API pages. `GET /api/sessions/:id/messages?limit=N` answers the newest N messages, `&beforeSeq=S` the page before seq S, and `afterSeq` still reads forward; no parameters still answers the whole transcript. On a copy of the live database the newest 200 messages of an 11,301-message session are 0.49 MB in 4 ms instead of 40.6 MB in 250 ms.
- Hub: `GET /api/sessions/:id/messages?trim=1` sends every content block over 100 KB light (text cut to 100,000 characters, image and document data left out, a tool result's parts the same way) and lists each in the message's `meta.trimmed` with its full size; `GET /api/sessions/:id/messages/:msgId/blocks/:index` returns one block in full. Without `trim` nothing changes. On a copy of the live database the heaviest 200-message page drops from 12.1 MB to 0.97 MB and its largest block from 11.1 MB to 67 KB.
- Web: a tab no longer keeps every transcript it opened. Views keep the transcript they show and the 2 last left; other sessions keep an 8-message live tail with no tool results. A resync (after a hub restart) fetches only the messages after the newest one held, and the whole transcript only when that message is gone at the hub. On the 5 largest real sessions, 5 resyncs fetched 63 KB instead of 1,010 MB and the tab's heap dropped from 408 MB to 179 MB.

### Fixed

- Release: the Linux desktop app builds again. Meeting mode needs the ALSA headers, which the release workflow did not install, so v0.4.50 shipped without the Linux desktop files; this release has them.
- Desktop app: a main window hidden in the tray for 10 minutes on a hub page other than Home goes to Home, and comes back to that page when shown. Closing only hides the window, so a long session page kept its memory growing for hours (13 MB to 227 MB in 110 minutes on Windows, then the page restarted). Home keeps the hub's connection, so notifications still come; composer drafts are kept in IndexedDB.
- Desktop app: links that open in a new tab (chat links, View pull request, sign-in pages) open in the browser again. The opener plugin's click hook called a command the hub page is not allowed, so the click did nothing and logged `plugin:opener|open_url not allowed by ACL` (16 times since 2026-10-26 on Linux and Windows). The hook is off; the windows send new-window requests for http, https and mailto to the browser and open no popup.
- Desktop app on Linux: reports its memory to the hub's log as `perf.memory` every 5 minutes (`rssMb`, with `appMb` and `webMb` for the WebKit processes, `source: "native"`). WebKitGTK has no `performance.memory` or long tasks, so the Linux app sent no slowness data at all before.

## [0.4.50] - 2026-10-31

### Added

- **Meeting mode**: a small always-on-top overlay in the desktop app that listens to your microphone ("Me") and the computer's sound ("Them") during a meeting you start in a project folder, and shows short "Say this" answers written as you from that project (git, recent sessions, tasks, memory, the last meeting's notes, secrets redacted). Start it from a Code session's **Meeting** button or the tray (`Ctrl/Cmd+Alt+M`); the hub writes a brief first, and nothing is heard until you press **Start listening**. Speech becomes text on the computer (Parakeet, audio never saved or sent); questions from "Them" get an answer on the fast tier with no tools, the transcript fenced as untrusted. Ending writes notes to `<project>/.conclave/meetings/`, tasks for your action items and one memory episode; **Meetings** lists them with their transcripts. The overlay asks Windows and macOS to leave it out of screen captures and hides itself when it sees a share start; macOS 15 capture and Linux still see it. Each account sees only its own meetings. docs/INSTALL.md, Meeting mode.
- Web: Conclave's own ASCII art on the sign-in screen and in empty states (a new chat, an empty chat list on the phone). A hub with seven agents on a slowly turning ring and a faint constellation behind; every few seconds an agent sends a violet packet down its link and the hub answers. Drawn on a canvas in the theme's colours at 20 fps, paused when hidden or off screen, one still frame under reduced motion, hidden from screen readers.

## [0.4.49] - 2026-10-30

### Added

- **Members get the hub's features, each with their own copy**: a hub member can Delegate to their own paired devices (never the hub or anyone else's), keeps their own "always allow" rules (Settings > Permissions), and has their own agents, skills, commands, workflows and learned skills (SkillManage) under their account folder. They get their own browser profile and saved logins (at most 2 members' browsers at once, closed after 5 minutes idle, no `file://` or hub network), so Capture, ReadPost, RenderFile, SaveInspiration and WebFetch's browser retry work for them; their own watches; maps and web search with their own keys (or a hub key the owner grants); and their own proxy instead of the hub's (Settings > Maps, Web search, Browser). A per-member disk cap (People, default 5 GB) refuses uploads, downloads, saves and browser launches past it. Nothing a member saves reaches the hub config or another account.
- **Imported chats have their own place, and you can continue them**: chats imported from claude.ai, ChatGPT, Claude Code, Codex or Gemini CLI show in an Imported group (web sidebar, Chats and Sessions lists, Android side panel), ordered by their original date, with their source on each row. An open imported chat shows attachments as file chips, claude.ai artifacts as code blocks, and each message's original time. Writing in one sends the imported turns to the model as conversation turns, with attachment text and artifact code. That first message moves the chat into its date group as a normal chat. Existing imports work with no re-import. docs/MEMORY.md, Importing past chats.
- **Memory map opens in 3D, and an area opens up when clicked**: Memory > Map starts in 3D (Clusters) on every device unless you picked Tree or Rings before (remembered on the device). Clicking or tapping an area flies the camera to it in 800 ms (a jump under reduced motion). Its sphere fills the view, the other areas fade back, and its items spread out inside, most linked in the middle. Each is titled where it fits without overlap (34 at most on a desktop, 12 on a phone; the rest show theirs on hover). Links inside are drawn, and links leaving the area run faint to the sphere's rim. Its items are listed beside it, or in a bottom sheet on a phone: searchable, most linked first, a hovered row rings its point, a click opens the item panel. Esc, All areas, a click outside the sphere or the browser's Back flies out; the open area is kept in the URL (`?cluster=People`).
- **Members get their own fallbacks and memory map**: a hub member edits their own Usage fallback and Refusal fallback lists in Settings > Models (saved on their account, only models they can call, checked on save and at run time). Their sessions use them as the owner's use the hub's: refusal fallback and "Try the next model" (no more 409 with a list), the usage chain, the same model on their other plans, sticky fallback and switch back, and chores. They never reach the owner's models, plans or lists; an owner per-model fallback a member could not call was picked for them before and is now skipped. Memory > Map opens for members with their own memory only.
- **Inspiration board**: the SaveInspiration tool (opt-in, the assistant has it, owner-only) saves a design reference as a memory of the new kind `inspiration`: an x.com post or video read with ReadPost, or any page as one 1440 px light Capture shot, with tags, the owner's note and its contact sheets or screenshot copied to `<home>/inspiration/`. MemorySearch takes `kind: "inspiration"` and returns items inside `<untrusted_web_content>`; plain searches, recall and extraction leave them out. The web-studio skill and workflow search the board first and read the closest 2 to 3 items, and use ReadPost instead of the manual fxtwitter steps. Memory > Notes shows an Inspiration filter.
- **ReadPost** tool: reads an x.com or twitter.com post without a login (through api.fxtwitter.com: author, date, text, quoted post, X article body, media) and "watches" its videos as PNG contact sheets of 3x3 frames spread over the clip, with photos saved as stills, in the session's outputs folder. It also takes a direct .mp4, .webm or .mov URL. Media downloads refuse private and metadata hosts and stop at 100 MB. The researcher, web-searcher and designer agents get it, and WebFetch points x.com links at it.
- **Capture** tool for agents and `lib.capture` for workflows: one call screenshots any http(s) URL on the hub's stock Chromium (and Firefox when installed) per width and theme, with an early frame, scroll contact sheets (ffmpeg from PATH, else a pinned static build fetched on first use) and a JSON report of console errors, failed requests, horizontal overflow, fonts, CLS, LCP and axe-core violations. Pages with H.264 video run on real Chrome when one is installed. The designer agent gets it.
- Built-in skills: Conclave ships skills inside the binary, listed and loaded like any other skill, with the lowest precedence, so a learned, installed or own skill with the same name wins. The first is **web-studio**, a method for building a site that does not look AI-made: design read, references, spec, prototypes, then screenshots at 390 and 1440 in light and dark and a 10-point rubric scored by a fresh judge (average 8 or more, nothing under 7, at most 3 rounds).
- Workflows: a findings ledger per project folder (`lib.ledger.read`, `write`, `fence`, `id`), stored on the hub per device and folder. bug-hunt and ui-pass read it before their judges and write their results back, so a later round does not report a fixed bug again or retry a rejected idea.
- **web-studio** library workflow: builds a new site in any project folder by the web-studio skill. Design read, references by lane, STYLE.md and SPEC.md you approve before any code, 3 to 6 signature prototypes in worktrees that a critic ranks and you pick from, a parallel module build, then `lib.capture` and a fresh judge on the 10-point rubric with the pass bar computed in code (up to 3 fix rounds), and validation round A (QA, accessibility, design, security, plus the project's own package.json checks) before round B (break-it, persona, owner proxy). Keeps the folder's findings ledger.
- Client logs report slowness: tasks that held the page over 50 ms go as one `perf.longtasks` summary a minute at most (count, longest, total, page path), and on Chromium (the Windows desktop app, Chrome) the JS heap as `perf.memory` every 5 minutes.

### Fixed

- Desktop app: a member no longer has to sign in again after every boot. When the app starts at login before the network is up, it stays on "Connecting to <hub>…" and tries again (after 1, 2, 4, 8 s, then every 15 s, and at once when the network comes back), with Retry now and Use another hub. Only the hub turning the saved token away shows the sign-in form. A settings file that cannot be read is now logged and kept as `settings.json.bad` instead of being dropped without a word.
- Desktop app: dropping files into the window attaches them again, as on the web. The app's own drop handler took the files before the page saw them; the main window and quick ask now leave drops to the page.
- A member's browser and Capture reach only public addresses: every connection, redirect hop and WebSocket goes through a relay that refuses the hub, its LAN and private or link-local addresses, a failed name lookup is refused, and WebRTC sends no UDP around it.

## [0.4.48] - 2026-10-29

### Added

- The Android app has Memory > Map, like the web's: **Map** on the Memory screen shows all memory as a Tree around the brain or an item, as Rings with the real links bundled through the middle, or in 3D as Clusters or a Timeline (drag to orbit, pinch to zoom). Tapping an item opens a sheet with its area, link count and links by relation, **Center here** and **Open in Notes**. A phone draws at most 1,400 links, each item's strongest first. Member accounts see that the map is owner only.
- The Android hub Map's labels read like the web's: a short name from the title (no paths, ids or "Session continued from prior context"), and a second line with the mode, state and when, such as "Code · done · 5m ago". A Stop that fails no longer leaves the button stuck on Stopping.

### Fixed

- On Android, a link or notification opened while the side panel was open showed its screen behind the panel. The panel now closes first.

## [0.4.47] - 2026-10-28

### Added

- Android: Code sessions have **Delete** in their sheet, and a long press on any conversation in the side panel deletes it, after a confirm.

### Fixed

- The email agent searches and reads mail without an approval card for every call. `MailSearch` and `MailRead` are marked as readers built for untrusted sessions (`untrustedReader`); every other call in an untrusted session still asks, and deny rules still win.
- Memory > Map no longer crashes with "Something went wrong on this screen" when an item opens in newer Chrome on Android: the item panel's scroll reset returned `scrollTo`'s Promise, which React then called as the cleanup.
- Memory > Map, 3D: under the phone's link cap, every item gets its strongest link before any item gets a second, so the most linked item no longer takes every thread.

## [0.4.46] - 2026-10-28

### Added

- Code sessions have a Preview pane, like Claude Code desktop's: **Preview** above the message box runs the dev server from `.conclave/launch.json` (or `.claude/launch.json`) on the session's device, or opens an HTML file of the session folder, and shows it live from a fresh stock Chromium on the hub (never CloakBrowser while stock Chromium is installed) that reaches only that dev server. The toolbar sets the width (390, 768, 1440) and theme, reloads, takes over, and has **Pick**: click an element, say what should change, and it joins the comment tray with its selector, source file when the page has one, and a crop, fenced as page data. **Console** lists the page's errors, failed requests and blocked addresses. Agents get `preview_start`, `preview_stop` and `preview_logs`. A launch.json command runs like a Bash command: through the session's permissions, and in a folder that is not trusted only after the owner confirms the exact line. Devices need daemon protocol 6 (the new `connect`); update older ones from Settings > Devices.

### Fixed

- Browser sessions through a proxy and Preview pages no longer send WebRTC traffic around the proxy on full Chromium builds.

## [0.4.45] - 2026-10-28

### Changed

- Memory > Map, 3D view: violet is back as the map's colour, and the space has real height. Points and links rest in faint `--signal` violet, fuller the more linked an item is, the most linked and their links in a brighter (dark) or deeper (light) violet; focus is full violet with the picked item in ink. Clusters now sit on a sphere instead of one ring: areas that share links settle near each other, the sphere turns so more recently written areas sit higher, and inside each area newer items sit higher ("newer items sit higher" in the corner legend). Timeline is unchanged.

## [0.4.44] - 2026-10-28

### Changed

- Memory > Map, 3D view: restyled from a sci-fi hologram to a quiet studio space. The radar sweep, floor bezel, rings and glass ball round the core, dashed orbits round clusters, lock-on brackets, cyan glow and blur halos are gone. Points are small crisp discs in the app's neutrals with depth fog, links are hairlines whose opacity follows how linked their ends are, and `--signal` violet marks only what has focus. The core is a small "Memory 2,980" origin; search and picks get a fine ring, the item's links in the accent and one leader line to a label card. Timeline is one fine axis with mono date ticks, seen square on. The camera eases more slowly and only drifts (about 25 minutes a turn) after 6 seconds of rest, never with reduced motion. Light theme sits on a warm off-white.

### Fixed

- Settings > About > This client in the desktop app shows the app's real version instead of 0.1.0, an "Update to X" button when the app has an update, and the last update check error. Browsers show the release version too: CI now writes it into the web app.

## [0.4.43] - 2026-10-28

### Changed

- The skills list in every session's system prompt now fits a token budget (`agents.skillTokens`, default 6000; 0 lists everything as before). Over it, the agent's own `skills:` list, project and hub skills, and skills that match the agent or the session's first message keep their descriptions; the rest are listed by name, one line per plugin, and still load by name. The Skill tool takes `query` to search skills or list a plugin's. The choice holds for the whole session, so the prompt cache keeps hitting. On a hub with 440 skills the section goes from about 36,000 to about 5,600 tokens.

## [0.4.42] - 2026-10-27

### Added

- Memory > Map has a 3D view (Tree / Rings / 3D): your memory as a holographic space you orbit, zoom and fly through, with two layouts, Clusters (areas as constellations, linked items together) and Timeline (fly along your memory's history). Hover lights an item's links, click opens it, double click flies there, search locks on. three.js loads only when the view opens. Rings, the earlier ring instrument, replaces the Brain view and stands in for 3D without WebGL or with reduced motion.
- Memory > Map: Expand all (E) puts every area and every item on screen at once. Far out it shows area names and counts over faint ticks; titles appear as you zoom in, never overlapping and never under 11 px. Fit frames the whole, and Collapse all goes back to the brain and its areas. A Tree / Brain switch adds a Brain view that shows how memories connect across areas. Two hemispheres hold lobes of items: what was said (Conversations, Conclave) on the left, and what it is about (People, Projects, Homelab, Services, ...) on the right. Every real link is drawn as a curve bundled through its areas (hierarchical edge bundling), so busy links between areas form visible tracts. Hover an area or an item to light its links and dim the rest. Click opens the same details panel. Relation filters, Across areas only, the store filter, the time scrubber and search all work here too. On a phone the page header and tabs take less room and a search path shows every step. A new depth now brings its rings out from under the drawer.

### Changed

- Code sessions carry less that is not about code. The coder no longer gets CalendarList, CalendarFreeBusy, CalendarEvent, MailDraft, PlaceSearch, PlaceDetails, Directions and MapImage (its `disallowedTools`); mail, calendar and browser work still goes to the assistant through Delegate, and ShareFile and ConclaveHelp stay. The platform card in a Code session leaves out the app's pages, the settings and the accounts and models line; the modes, Delegate, devices and the "Files you deliver" note stay. A coder request is about 8,500 characters of tool definitions and 900 of system prompt smaller. Chat and the assistant keep everything.

### Fixed

- Hook and prompt fixes. A recipe installed as a global hook and also listed in an agent's `recipes:` (no-test-gaming, new-dependency-gate and diff-budget on coder, builder, refactorer and tester) now runs once instead of twice; the agent keeps its recipe on hubs without the global hook, and write-scope keeps the agent's own tunables. The secrets firewall no longer takes a single-quoted jq filter such as `'.hooks|to_entries[]|.key'` for a `.key` file, while the files jq reads are still checked. The guardrail config guard lets reads of hooks and settings through (`ls`, `cat`, `jq`, `2>/dev/null`, `2>&1`) and still refuses writes (redirects, `tee`, `sed -i`, `rm`, `mv`, `cp`, `chmod`); before, words like "permissions" or a dropped stderr counted as writes. An agent's `mcpServers` filter in tool listings now matches the whole server name, so `semgrep` no longer lets `semgrep2` through. The sysadmin prompt, the homelab guide and the scheduled-checks prompt now say the hub runs on the device named conclave, an LXC container (CT 135) on pve, and that madx is a separate server.

## [0.4.41] - 2026-10-27

### Added

- A style lint for the web app: `bun run lint:styles` (`scripts/check-styles.ts`, also a CI step) fails on the styles docs/DESIGN.md bans in `packages/web/src`: pills and chips, uppercase labels, gradients, glass, glows, spinners, glyphs as icons, sparklines and raw hex colors outside tokens. Justified exceptions live in `scripts/check-styles.allow.json`, each with a reason; six are there today, and an entry that no longer matches anything fails too.
- Unread conversations: a chat or session that finished a turn after you last opened it shows its title in bold in the sidebar, the lists and the phone's Code and Chats lists; opening it clears it. The hub keeps it (`meta.doneAt`, `meta.seenAt`, `POST /api/sessions/:id/seen`), so the web and Android agree. The command palette matches words in any order, puts the commands you used lately first, can start a new session in Plan, Jury, Debate or Loop mode, and can run a workflow from the library.
- Start a Code session from a GitHub issue. With a repository picked, an Issue picker next to the branch lists its open issues, newest activity first. Each row shows the number, title, labels and comment count, and the list can be searched by number, title or label; a search also asks GitHub for older issues. You can also paste an issue link, there or in the repository search. The session starts in a new worktree as before and is named "#N title". Its first message holds what you typed, then the issue's title, body and last 5 comments, wrapped as untrusted text because other people wrote them. It also tells the agent to put "Fixes #N" in the pull request so GitHub links and closes the issue. A wrong number or a pull request number is refused before anything is cloned. The CLI takes `conclave sessions new --repo owner/name --issue N`.
- Fix failing checks: when a check of a repo session's open pull request fails, the repo bar (and the phone's conversation sheet) offers Fix failing checks. It reads the failed jobs from GitHub with the hub's token and sends the agent one message with each job's name, its link and the last 200 lines of its log, fenced as untrusted data, and asks it to fix them. The agent can read the same itself with the PullRequest tool's new "checks" action, without an approval. The token never goes into the message, and the log storage GitHub redirects to is fetched without it.
- A `race` library workflow: several agents do the same task in separate worktrees, the check runs in each, and a blind judge panel picks the best passing change with its reasons. The run view shows the winner with its diff and Keep winner, which merges its branch into the run's checkout (or opens a pull request from the repo session's branch). The other branches are deleted only after you keep one, and nothing merges on its own.
- Design direction for UI work in Code sessions. `/design` in a session (or "+" when starting one, or Options on a phone) picks how UI changes should look: this app's design system, minimal, editorial, dense dashboard, playful, or match a reference page URL or uploaded screenshot. The pick is kept with the session, and the agent gets it as a short brief on its next turn and again after `/clear` or a compaction, not on every turn. A designer subagent it hands work to gets the same brief with its task. Style directions point the agent at the hub's frontend-design skill when one is installed.
- Web: a status line per agent, like the terminal app's status rows. Under the composer of a session or a chat one quiet line says the model, the plan or key it runs on, how full the context is, the tokens and cost so far ("plan" when a plan pays), and whether it is running, waiting on you, waiting for a reset or idle. On phones it leaves out the plan and a tap opens the plan, limits and context sheet; the context ring's popover says the state too. Subagent lines and the Background tasks card add each subagent's tokens and cost, and workflow agent rows say "plan" for a call a plan paid instead of a dash.
- Sessions side by side. On a computer, Side by side (`/sessions/split`, in the command palette and in a session's menu) shows two to four sessions as columns, each with its live transcript, approvals, state and its own composer, so you can watch and steer them at once. Add session picks from recent sessions; a full view makes room by dropping the leftmost. The layout is saved to your account, so it follows you between computers and each person on the hub keeps their own. All columns read the one live connection the app already has. On a phone the page lists the same sessions to open one at a time.
- Comments on diff lines. In a session's edit diffs, the Changes card's diff and a workflow branch's diff, click a line number (Shift picks a range) and write a comment. Comments collect in a small tray over the composer ("3 comments on the diff"), where each can be edited or removed, and they survive a reload. Send to agent posts them as one message, each with its file and line, the quoted lines and your comment; while a turn runs it queues like any message. Works from the keyboard: Tab to a line number, Enter opens the box, Ctrl or Cmd+Enter adds, Esc cancels.
- Connect apps that sign in with OAuth. An MCP server with `"auth": "oauth"` gets Connect, Reconnect and Disconnect in Extensions > MCP servers (and the /mcp sheet) with a status line. Connect opens the app's sign-in page in a new tab and comes back to the hub at `/api/mcp/oauth/callback`; the hub does discovery, client registration and PKCE itself, seals the tokens in `secrets.json` and refreshes them once per refresh token. A lapsed or revoked sign-in shows "not connected" and stops retrying until you press Connect. Discover adds Notion and Linear (sign in with Connect) and AFFiNE through the community affine-mcp-server, with the one-time setup in docs/EXTENSIONS.md. Connect needs the hub's public address. A sign-in is tied to the server's URL and is forgotten when the URL or auth changes or the server is removed; discovery and token addresses must be https on a public address, and failures show no response body.

### Changed

- The chat makes files itself instead of handing them to a Code session. It writes text, Markdown, CSV, JSON, HTML and SVG with Write and Read, both confined to the chat's outputs folder on the hub (a path outside it, through `..` or a symlink, is refused), and a new opt-in RenderFile tool turns an HTML, SVG or Markdown file there into a PDF (A4 or Letter) or PNG with the hub's Chromium, then ShareFile hands it over. Rendering is offline: every request except files in the outputs folder is aborted, JavaScript and service workers are off, inputs are capped at 5 MB and outputs at 25 MB, and a render stops after 30 seconds. The chat still has no shell, and delegates only work that needs the owner's devices or files, a shell, code to run, mail, calendar or the browser. The assistant gets RenderFile too; untrusted agents and members' sessions do not. Without a browser installed on the hub, RenderFile says so.

## [0.4.40] - 2026-10-27

### Added

- Android: share anything to Conclave. The app now shows in the share sheet for any file and for several files at once (PDFs, documents, zips, pictures from Files, Gallery or Drive), not only text and single images. Before anything opens, a "Share to" page asks where it goes: a new Chat, Assistant or Code conversation (Code asks for its folder as usual), or any existing chat or session, searchable, newest first and marked by mode. The files land in that conversation's box, unsent, so you can type and send. Back drops the share. A file the hub cannot read (video, audio, Office files), one over 8 MB, or more than 15 files or 45 MB together is named on that page with the reason instead of being dropped silently. A share made while the app is locked or not yet paired waits until it is open.

### Fixed

- Claude Code import keeps the whole history of a chat compacted many times. Newer Claude Code builds re-write a preserved tail of messages after a compaction and point the compact boundary at it, so the import stopped at that compaction and dropped everything before it. When a boundary's link back is missing, dead or loops, the import (hub and Rust daemon) now goes on from the last message written before the boundary. Each message shows once, and chats that imported fine before import the same.

### Changed

- Memory > Map is now a mind map of all your memory: the brain in the middle, your areas (People, Projects, Homelab, Courses and more, taken from your folders and tags) around it, and the items of an area as plain labels joined by curves. Open an item to see its links, double click to center on it, search reaches every item and draws the path inside the tree, and the scrubber fades what came later. The map now loads every item, not the first 1,000.
- New chats and sessions get a name as soon as the first message arrives, before the agent works: the first line of the message at once, then the title model's name from that message alone, while the turn runs. The name then keeps up with the work: after a big step (a turn that edited files, changed the todo list or plan, was compacted, or ran 6 or more tools), or after 6 turns, the title model is asked again with the current title and the recent messages, and keeps it when the topic has not moved. It asks at most once per 3 turns and once per 2 minutes. A title you set is never changed, subagents are not named, and headless runs are still named from their prompt with no model call. The web and Android show the new name live.

## [0.4.39] - 2026-10-27

### Added

- Watch and take over the assistant's browser. While a session's browser tool runs, or its page is open on the hub, a line above the composer says so, on the web and at phone width. Watch shows that session's page live. Take over lets you click, scroll and type in it; the session's next browser tool call waits until you press Give back, and is then told the page may have changed. Closing the view, or a minute without it, gives the browser back. Only the owner can watch or take over, only that session's page is shown, input is refused unless you hold it, and the take over and give back are in the audit log. Android does not have it yet.
- Memory has a Map tab: Conclave's memories and the linked Basic Memory notes in one graph, joined only by real links (Basic Memory relations and wiki links, shared tags, the session a memory came from). A fact mirrored to Basic Memory is one node. Filter by source and kind, search, and open an item to see its links. When Basic Memory does not answer, the map shows Conclave's memory and says Basic Memory is offline.
- Settings > Browser has Import cookies on each profile. Export cookies from your own browser (for example Cookie-Editor's Export as JSON), pick the file, and the profile is signed in to those sites on the hub. It takes Cookie-Editor and EditThisCookie JSON, a Playwright storage state and cookies.txt, up to 5 MB and 10,000 cookies, and leaves out expired cookies. The answer gives counts per site only, the hub keeps no copy of the file, and the dialog says to delete the file after.
- Bench operators can compare one harness edit against a baseline with `bun bench/improve.ts`. The offline comparison uses existing hidden tests and gate metrics, stops candidate runs on regression, and leaves the merge decision to a person.
- Learned skills now count how the verify gate's first check went in each turn that loaded them, and SkillManage list shows it ("check passed first time in 3 of 4 checked turns"). This is an outcome count, not a grade: no turn ran the same task without the skill, so the line says "effect not graded" and never helped, hurt or no effect. Only turns where the verify gate ran a check count, a retry after the gate sent the agent back does not, and memories are not tracked.
- Coding agents now look at their UI work. A new `visual-check` gate, on for coder, builder and refactorer, sends one short reminder per user turn when a main-session turn edited UI files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`, `.svg`, and Compose `.kt` under a `ui/` folder; test files left out) and no tool result in the turn carried an image: take screenshots at phone and desktop width, light and dark, and look at them with Read, or say why it cannot. It writes a `visual.check` audit row and a `visual.checked` event. Edits made through Bash and edits made by subagents are not seen. `browser_screenshot` takes `width` (320-2560), `height` (320-4000) and `color_scheme` (`light` or `dark`) for one shot and puts the tab's size and theme back after it; width and height need a headless browser. The coder prompt gained one line about taking and reading screenshots after a UI change.

### Fixed

- Android: a picture in a Code session (one you sent, a screenshot an agent read, or a tool's image) now opens full screen on a tap, with pinch to zoom, like on the Chat page. Before, only Chat page pictures opened; Code sessions draw messages with their own image view, which had no tap.
- Kiro plans now show their monthly credit on Usage and in the composer's context ring: used and left, the limit and the reset. The hub reads it through the kiro4cpa plugin's quota provider in CLIProxyAPI, which asks Kiro's getUsageLimits with the account's own token. GitHub Copilot plans say "Usage not reported by GitHub Copilot", because its plugin has no quota read and CLIProxyAPI cannot put its GitHub token into a usage call. Plugin accounts are now named Kiro and GitHub Copilot instead of Kiro4cpa and Copilot.
- Move back no longer marks a file as a conflict when the device only touched it: same size, a new mtime and the same bytes. The usual case was `.git/index`, which `git status` on the device rewrites unchanged when a second has passed. Such files are now hashed on the device and compared with the copy's manifest, as the hub side already did.

### Changed

- Whole files now come as downloadable file cards instead of huge code blocks. The system prompt and the ShareFile description tell the model to save a complete program, config file, document, or a chart or graph as a PNG or SVG, share it with ShareFile, and answer in a few lines, keeping short commands, diffs and examples inline. A chat hands the writing to Delegate with readOnly off, and a session that cannot save or share files is told to say so. This is guidance to the model only: nothing checks that it follows it, and ShareFile's folder, ownership and size checks are unchanged. File cards on the web and Android now also draw an SVG up to 2 MB inline, and the web caps inline PNG, JPEG, GIF and WebP at 20 MB like Android. The web draws an SVG only as an `<img>` from a `data:` URL with no Open button. Android draws it in a WebView with JavaScript, network, file access and navigation turned off. Text, code, CSV and PDF files no longer preview inside the card; a PDF still has Open, and Download and Save keep the original bytes.

## [0.4.38] - 2026-10-27

### Added

- Delegate takes a `model`: when the owner names one for the job ("do it on Opus 5.5"), the delegated Code or Assistant session runs on it. Left out, the session runs on its agent's own model as before. A named model that cannot run on the hub is refused with the reason, never swapped for another.

## [0.4.37] - 2026-10-26

### Added

- The context ring under the composer now says which model and plan or key the conversation runs on (a plan by its short name, such as neu-claude, a key by its label, such as Z.ai Coding Plan) and why: the default, picked, moved to another plan at a limit, or the usage fallback. It also lists the other plans and keys that serve the model, each with its 5 hour and week windows and reset times as on Usage. A plan whose window for this model alone is full (7d opus) or that rests for this model is passed over, as the hub does; only CLIProxyAPI models go to plans by your order, and a model on another provider shows its own key or nothing. It shows the first ready plan in your order, not yet the one the hub keeps the conversation on after a move, and the Android app's context sheet does not show any of this yet.

### Fixed

- Android: pasting a picture into the message box (long-press Paste, keyboard paste, Gboard clipboard or image suggestions) now attaches it like one from Photos, with the same 15-file and 45 MB limits. Text still pastes as text.
- Settings > GitHub no longer says there is no token when you gave one while installing the GitHub MCP server. Repo sessions now use that token (the hub secret `github-pat`) when no `github` token is saved, and Settings and `conclave github status` say it is shared with the MCP server. Disconnect leaves the MCP server's token alone, and Connect a separate token saves a `github` token that takes over, for example a write token when the MCP token is read only.

## [0.4.36] - 2026-10-26

### Added

- Terminal chat (`conclave`): `/effort` picks how hard the model thinks (the levels the model has), and the status row shows it. Messages sent while a turn runs show above the input until they run, and `/queue` lists them to remove one or send a held one. A turn that ends on a provider error, a usage limit, a refusal or a hub restart prints the "Why this turn stopped" card the web chat shows. Approvals and questions from subagents and workflow agents now show in the chat you are in, with who asks. Workflow and Delegate calls get their own titles.

### Changed

- Terminal chat: the two status rows are laid out left and right (model, effort, agent and mode against the permission mode; the folder against context, tokens, cost and limits), the hub shows only when it is not connected, and a bare `/` lists commands in their listed order instead of by name length.
- The pet is redrawn as a soft dome with a curl of the Knot's rope on top, dot eyes, a mouth and one arm for its prop, on web and Android. Each state has its own face and posture (a magnifier, a hammer and blocks, glasses, a waving amber hand, asleep with z's, a hop with sparkles when done, a frown and a sweat drop when failed). It now also sits beside the chat header's Waiting on you, Resumes and Failed words, beside the reason of a failed chat on desktop and phone, in the Inbox and workflow runs empty states, and on the setup Done step; `/dev/motion` shows it in each place.

### Fixed

- The pet and the agent glyphs stop moving off screen and in a background tab: each pose's own animation rule set the play state back to running, so their loops kept going.
- A picture you attached to your own message opens full size: on the web a click or tap on its thumbnail (Chat page and session log) shows it fitted to the screen with Download, and Escape, Close or a click outside shuts it; on Android a tap opens it full screen with pinch to zoom, and a tap, Back or Close shuts it. Before, the thumbnails did nothing.
- A device with a large Claude Code or Codex transcript no longer drops off every 10 minutes ("Received too big message"): the usage scan reads device logs in 8 MB pieces from where it stopped, skips a single line over 8 MB, keeps its progress when a read fails and waits longer before each retry (20 minutes, doubling, up to a day). Every file read from a device now travels in replies of at most 32 MB, a daemon without range reads is not asked for a bigger file, and the Rust daemon answers a reply that would pass the hub's 64 MB limit with an error instead of sending it. A tool call on a device that dropped in the last minute waits up to 20 seconds for it to reconnect before failing with "is offline".

## [0.4.35] - 2026-10-26

### Fixed

- A provider model that only starts with a catalog id (`glm-5.3-uncensored` on a custom provider) keeps the rest of its id in its name ("GLM-5.3 Uncensored", "GLM-5.3 Flash Uncensored") and the catalog's capabilities, and shows no price unless the provider is that vendor's own API: before, it took the catalog model's name and price, and read as a copy of Z.ai's GLM-5.3. Exact ids, aliases, dates and effort variants (`-high`) are unchanged. In the web and Android model pickers a row from a provider that is not the maker's own says whose it is ("via Experiential Labs", the provider's config name).
- Terminal chat: `NO_COLOR` now turns off the colors of borders, pickers and approval keys too, hub context (`<system-reminder>` blocks) no longer shows as your own words, and code blocks wrap on narrow terminals when color is off.
- Terminal chat: when a turn ends, a background subagent's or workflow agent's approval or question stays on screen until it is answered, the stop card no longer repeats a notice already shown, a reconnect reads the messages before it says why the turn stopped (a Stop from another device no longer reads as a hub restart) and refetches the waiting messages, and a steer message waits as "joins the running turn".

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
