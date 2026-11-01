# Design review: web, Linux, iPhone and Mac

The second round, after the phone redesign, password login and hub identity
merged. Its ranked fix list (1 to 12) is done: each finding below says
**Fixed:** with what changed, and what is left says so. The web and Linux
shots are retaken after the fixes; the iPhone and Mac shots are still the
second round's (no simulator or Mac here), so they show the old state.
Screens:

- **Web**: `web/<screen>-<desktop|mobile>-<dark|light>.png`, 1440x900 and
  390x844 (2x), from `scripts/screenshots/web.mjs` against the demo hub
  (`scripts/demo-hub.ts`).
- **Linux desktop app**: `linux/<connect|home|session>-<light|dark>.png`, the
  1180x800 window under Xvfb, from `scripts/screenshots/linux-desktop.sh`
  against the demo hub.
- **iPhone**: `ios/*.png`, the web app's phone layout in the iOS simulator.
- **Mac desktop app**: `mac/connect.png` and `mac/home.png`.
- **Android and Windows**: made by `.github/workflows/screenshots.yml`; not
  reviewed until a run has them.

The web and Linux shots show the demo hub's data (Sam, the fernway-web repo,
a device named MacBook, and since the fixes a hub device named homelab). The iPhone and Mac shots show the web app's mock hub
instead (madx, Kai, `127.0.0.1:5173`), so the same screen holds different data
on those two. To compare like with like, take them against
`bun scripts/demo-hub.ts` next time.

Each finding names the guide and rule it breaks:

- **Impeccable**: `craft-floor` (contrast, spacing, type, states, browser
  surfaces, refuse list), `audit.native` for the phone and the desktop apps,
  `polish`, `typeset`, `layout`, `colorize`.
- **Taste**: `app-screens` (by section number), `tells`, `critique`, `type`,
  `colour`.
- **Vercel**: the Web Interface Guidelines (`command.md`), checked against
  the web code too, with file:line.

Where `docs/DESIGN.md` (section 13, the lab console direction) decides
otherwise, the house rule wins and the finding says so. Two guide rules are
set aside on purpose: Vercel's "Title Case for headings and buttons" (the house
style, and Taste app-screens 9.1, use sentence case) and Taste's ban on violet
(violet is Conclave's own colour for live work and focus, which Taste colour 9
allows for a brand that owns it).

Severity, as in Impeccable audit: **P0** blocks a task, **P1** major, **P2**
minor, **P3** polish. No P0 and no P1 this round: every flow in the
screenshots works, and the two P1 gaps of the first round are closed.

## Fixed since the first review

- The hub's fingerprint is in Settings, Remote access, This hub, in groups of
  four (`settings-identity-*`), and a password login shows it once before
  Continue (`connect-fingerprint-*`).
- Connect has password login on both layouts (`connect-password-*`).
- On a phone, Connect fits one screen: the code form, its button, and the
  other ways in at the foot (`connect-mobile-*`).
- On a phone, Home leads with what needs you, with Allow, Deny and Answer on
  the first screen (`home-mobile-*`, `ios/home-*`).
- On a phone, a session's header names the project ("assistant, MacBook,
  fernway-web") instead of a temp path.

## Scores

Taste critique, read as app screens (the page caps for pictures and motion do
not apply, app-screens 2.7). Scored before the fixes below; not scored again:

| | Design | Usability | Creativity | Content | Overall |
| --- | --- | --- | --- | --- | --- |
| Web and iPhone, phone layout | 8 | 7.5 | 7 | 8 | 7.7 |
| Web, desktop layout (also inside the Linux and Mac apps) | 7 | 7 | 7 | 8 | 7.1 |
| Linux and Mac apps, their connection page | 5 | 7 | 5 | 7 | 5.8 |

The phone layout is now the strongest surface: large titles, a four-tab bar
with labels and a count, what needs you first, state as words. The desktop
layout did not change in this round, so its first screen still puts the
approval under the fold. The desktop apps' own connection page is still a
different visual world from the app it opens.

Impeccable audit.native, for the phone layout as an iPhone app (it is the web
app in a WebView, so Performance is not scored): Accessibility 3 (labels and
44px targets; the toast covers controls), Theming 3 (tokens throughout, both
appearances composed), Conformance 3 (large titles, tab bar, back labels with
the tab's name, safe areas; filter pills are web-shaped), Adaptivity 2 (the
keyboard covers Connect). Verdict: reads as a native app, not a ported site.

## Web, desktop layout

### Connect (`connect-desktop-*`, `connect-password-desktop-*`, `connect-fingerprint-desktop-*`)

Passes: three ways in as one segmented control, the hub address filled in from
the page's own origin, Show on secret fields, "Log in" as the button's word in
password mode, the fingerprint in large mono groups after a password login.

- **P3. After a password login the old heading stays above the new one.** "Connect
  to a hub" and its lede ("Pair this device with your hub. Only the token is
  kept here...") sit over "Logged in to vm", so the screen has two titles and
  a lede that no longer fits. The phone layout already hides its lede in this
  step. [Taste app-screens 4.3: one title, an optional second line about the
  data] File: `packages/web/src/features/connect/ConnectScreen.tsx:46`,
  `packages/web/src/features/connect/ConnectForm.tsx:164`.
  **Fixed:** while the fingerprint shows, "Logged in to homelab" is the one
  heading; the title and lede step aside (`connect-fingerprint-desktop-*`).
- **P3. Version stamp in the corner.** [Taste tells 4: agency micro-meta,
  version stamps] File: `packages/web/src/features/connect/ConnectScreen.tsx:43`.
  **Fixed:** gone; the version stays in Settings, About.
- **P3. The disabled Connect button is grey on grey and does not say what is
  missing** (also on the phone layout). [Taste app-screens 8.1: disabled
  controls stay legible and say why] File:
  `packages/web/src/components/ui/Button.tsx:21`.
  **Fixed:** disabled labels are fg-3 (see Across layouts), and beside the
  button a line says what it waits for ("Paste the token.", "Enter the
  pairing code.") and is its `aria-describedby` (`connect-*`).

### Home (`home-desktop-*`)

Passes: the status sentence answers the screen's question in words, no KPI
tiles, routines on a 24 hour axis, colour only on state.

- **P2. The waiting approval is not on the first screen.** At 1440x900 the
  greeting, the knot and the composer take about 600px, and "Waiting on you"
  starts at about y 780 with its Allow button below the fold. The same shows
  in the Linux and Mac windows (`linux/home-*`, `mac/home.png`, where only the
  sentence "Three are waiting on you" is visible). The phone layout solved
  this with Needs you under the composer; the desktop layout can do the same
  when something waits. [Taste app-screens 2.2: the most frequent job one
  click from the first screen, time-sensitive blocks first] File:
  `packages/web/src/features/home/HomePage.tsx:160`,
  `packages/web/src/features/home/sections.tsx:47`.
  **Fixed:** Waiting on you sits right under the composer when something
  waits, with the oldest approval open and the rest as rows, so Allow is on
  the first screen at 1440x900 and in the 1180x800 window (`home-desktop-*`,
  `linux/home-*`). The status columns keep the rest.
- **P3. "Limits show up here once a plan or key is connected"** on a hub
  whose only provider has a key. Say what is really missing (this provider
  reports no limits). [Impeccable craft-floor: copy names the problem and the
  recovery] File: `packages/web/src/features/home/sections.tsx` (LimitsSection).
  **Fixed:** it says why it is empty: nothing close to a limit, a provider
  that has reported no limits for its key yet (by name), or nothing
  connected.

### Sessions and a session (`chats-desktop-*`, `session-diff-*`, `approval-*`, `question-*`)

Passes: tool calls as rows (tool, target, result), a real unified diff with
line numbers, verbatim test output, the right panel as type (tokens, cost,
context), checkpoints with Restore, the approval as the one filled box with a
neutral ink primary, the question's options with their consequence.

- **P2. On a phone the tool row keeps the start of the path and loses the
  file name**: "Edit /tmp/conclave-demo-.../cod..." hides `redirect.ts`.
  Truncate from the start, or show the path relative to the session folder,
  as the new phone header already does with the project. [Taste app-screens
  7.4: the identity is never the part cut off] [Vercel: text containers handle
  long content] File: the tool header in `packages/web/src/features/conversation/`.
  **Fixed:** paths in tool rows are relative to the session's folder
  ("src/auth/redirect.ts"), and on a narrow row the folders truncate before
  the file name (`features/chat/ToolRows.tsx` PathText, `lib/format.ts`
  pathIn) (`session-diff-mobile-*`).
- **P3. On a phone, diff lines are clipped at the right edge** with no sign
  that the block scrolls sideways ("log i", "string |"). [Taste critique 13:
  an element that runs off the edge reads as cut off] File: the diff block in
  `packages/web/src/features/conversation/`.
  **Fixed:** on a phone diff lines wrap (`components/ui/Code.tsx`).
- **P3. The desktop header and Workspace panel still print the full temp
  path**; the phone header's project name would read better here too. [Taste
  app-screens 7.4: the same short form at every width] File: the session
  header in `packages/web/src/features/conversation/`.
  **Fixed:** the desktop header names the project ("MacBook, fernway-web",
  the path as its tooltip), Workspace shows the end of the path
  ("…/code/fernway-web"), and a workflow run says "in fernway-web".
- **P3. "fact, used 1 times"** in Memory used. `memory/Notes.tsx:64` already
  says "used once". [Impeccable craft-floor: copy] File:
  `packages/web/src/features/chat/ContextPanel.tsx:273`.
  **Fixed.**
- **P3. The agent's reason is in straight quotes**, `"Push fix/login"`, on
  both layouts. [Vercel: curly quotes] File:
  `packages/web/src/components/inbox/ApprovalCard.tsx:308`.
  **Fixed:** “Push fix/login”, and the loop picker's “until” text too.
- **P3. Three dots instead of an ellipsis** in "Always allow..." and in menus.
  [Vercel: `…` not `...`] Files:
  `packages/web/src/components/inbox/ApprovalCard.tsx:340`,
  `packages/web/src/features/chat/ChatView.tsx:298`, `ChatView.tsx:299`,
  `packages/web/src/features/chat/Turn.tsx:326`,
  `packages/web/src/features/conversation/Rail.tsx:247`,
  `packages/web/src/features/conversation/ChatPage.tsx:279`,
  `packages/web/src/features/conversation/Reply.tsx:544`, `Reply.tsx:548`.
  **Fixed:** these, the Hand off button in a notice, the loading words of the
  desktop connection page, example placeholders and two truncations.

### Inbox (`inbox-desktop-*`)

Passes: a list that drives a detail pane, counts on the tabs, the wait as a
word that counts.

- **P3. Two inboxes.** The desktop has All, Approvals and Questions; the
  phone adds Results, Earlier today and Clear done. The same screen should
  offer the same things at both widths. [Impeccable polish: match neighbouring
  mental models] File: `packages/web/src/features/chat/ApprovalsPage.tsx`,
  `packages/web/src/features/chat/PhoneInbox.tsx:102`.
  **Fixed:** the desktop Inbox now has Results in its filter (kept in the
  address as on the phone), Earlier today (what finished today and what was
  decided here) and Clear done, from one shared module
  (`features/chat/Earlier.tsx`) (`inbox-desktop-*`).
- **P3. The selected row is a 2px ink bar on the left, copied into 10
  files.** Neutral, so it passes Impeccable's refuse rule (that one is about
  coloured edges); Taste asks for the active fill in a list that drives a
  detail pane. [Taste app-screens 7.8] [Impeccable polish: one shared
  component] Files: `packages/web/src/components/ui/List.tsx:75`,
  `features/chat/ApprovalsPage.tsx`, `features/chat/SessionList.tsx`,
  `features/settings/SettingsPage.tsx`, `features/conversation/Rail.tsx` and
  five more (`grep -rn "w-\[2px\] bg-fg"`).
  **Fixed:** one `SelectedMark` in `components/ui/List.tsx`. Every one of
  those rows already had the raise fill Taste asks for; the bar stays on it.

### Workflow run (`workflow-*`)

Passes: one status sentence that answers the screen's question, phases as
sections, state as a word, right-aligned tabular figures, the log with times.

- **P2. Empty cells print nothing.** The running agent has no Model and Last
  tool is blank on every row, so a whole column reads as broken. Print a grey
  dash, and drop the column on a run with no tool calls. [Taste app-screens
  11: missing is a grey dash] [Taste app-screens 10: a column empty in every
  row reads as unfinished] File:
  `packages/web/src/features/workflows/CallRows.tsx:89`, `CallRows.tsx:125`.
  **Fixed:** Model, Last tool, tokens and cost print a grey dash ("none" to
  a screen reader) until known, and a run where no call used a tool has no
  Last tool column (`workflow-*`).
- **P3. The run view stops at 1080px and leaves a 330px strip at 1440.**
  [Taste app-screens 4.2: content that stops short of the right edge] File:
  `packages/web/src/features/workflows/RunView.tsx:108`.
  **Fixed:** the rows run to the page's right edge, under Pause and Stop;
  the status sentence, its line and the result keep their own measure.

### Settings, Remote access (`settings-remote-*`, `settings-identity-*`)

Passes: the state first in one sentence, the ways in as radio rows with what
each costs, This hub with the fingerprint in groups of four and the password
row (set date, Change, Remove in the negative colour as a text button).

- **P3. The pairing dialog still does not show the fingerprint.** A code
  typed by hand carries no `fp`, so the person pairing has nothing to compare
  unless they open Settings. One line under the code would close it. [Impeccable
  craft-floor: coverage] File:
  `packages/web/src/features/devices/DevicesPage.tsx:551`.
  **Fixed:** "Hub fingerprint" in groups of four under the code and its
  expiry (`devices-pair-*`).

### Devices (`devices-*`, `devices-pair-*`)

Passes: a list that drives a detail pane, each device's role, system and
agents as words, "3 running" where they run, the dialog saying what the code
carries and what is still missing.

- **P2. The hub device is named by its hostname and cannot be renamed.** Here
  it reads "vm", in the iPhone and Mac shots "madx"; on a CI runner it is a
  runner id. `PATCH /api/devices/local` refuses ("the hub device cannot be
  edited"), so "Hub vm online" stays cryptic in every shell. [Taste
  app-screens 1: the product's own objects as themselves] File:
  `packages/server/src/routes.ts:745`, `packages/core/src/machine/local.ts:198`.
  **Fixed:** `PATCH /api/devices/local` takes a name (1 to 64 characters)
  from the owner token only (403 for a paired client), kept in the kv table
  so it outlives a restart (`DeviceRegistry.renameHub`). It is the hub's
  name in every app; Devices offers Rename on the hub to the owner. Tests in
  `packages/server/test/routes.test.ts` and
  `packages/core/test/machine/registry.test.ts`. The demo hub now names its
  device homelab ("Hub homelab online").
- **P3. Two buttons for one job.** "Pair a device" and "Pair your phone" open
  the same dialog. [Taste app-screens 4.3: one primary per screen] File:
  `packages/web/src/features/devices/DevicesPage.tsx:82`, `DevicesPage.tsx:180`.
  **Fixed:** the first day hint is words only; Pair a device is the button.
- **P3. On a phone the sheet says "Scan the code with the Conclave app"**,
  which the phone showing it cannot do. Lead with "type this code on the other
  device" there. [Impeccable craft-floor: copy] File:
  `packages/web/src/features/devices/DevicesPage.tsx:572`.
  **Fixed:** on a phone: "Type this code on the other device, or scan it
  with the Conclave app there." (`devices-pair-mobile-*`).

## Web, phone layout (also the iPhone shots)

### Home (`home-mobile-*`, `ios/home-*`)

Passes: the hub and its state in the corner, the greeting with what needs you
and what runs as one line, the composer as a card, Needs you with Allow, Deny
and Answer, Working now with the step and the device.

- **P2. One workflow shows twice and counts twice.** Working now lists
  "review-login-fix / prove with tests" (its agent's session) and
  "review-login-fix" (the run), and the line above says "2 agents are working"
  for one agent. Fold a workflow's own sessions into its run row, and count
  the agents, not the rows. [Taste app-screens 2.1: a fact shown twice is one
  variable] [Taste app-screens 5: one figure, one place] File:
  `packages/web/src/features/home/PhoneHome.tsx:58`, `PhoneHome.tsx:240`.
  **Fixed:** a workflow's own sessions fold into its run's row, and the line
  counts agents: each running session and the running calls of each
  running run (`workingNow` in `features/home/status.ts`, tested)
  (`home-mobile-*`: "1 agent is working", one row).
- **P2. Offline, Home says "Nothing needs you. Nothing is running."**
  (`ios/offline-dark.png`) while the hub cannot be reached, so it cannot know.
  The banner is right; the summary should say the state is unknown, or show
  the last known one with its time. [Taste app-screens 11: an error says what
  failed and when the data was last good] File:
  `packages/web/src/features/home/status.ts:91`, `PhoneHome.tsx:73`.
  **Fixed:** on both layouts. Never heard from the hub: "Can't tell what
  needs you while madx is offline.", and Needs you and Working now say "Not
  known while madx is offline." Went offline after loading: the last counts
  and "madx is offline, so this is from 10:37." Not retaken on iOS; the web
  mock shows it at `/?offline`.
- **P3. Working now sublines cut the device**: "Run server tests and push the
  branch, 38m, arch-..." (`ios/home-dark.png`). Put the device and time first
  and let the step truncate. File: `packages/web/src/features/home/PhoneHome.tsx`
  (WorkRow).
  **Fixed:** "arch-desktop, 38m, Run server tests and push…".

### Chats, Inbox and You (`chats-mobile-*`, `inbox-mobile-*`, `you-mobile-*`, `ios/chats-dark.png`, `ios/inbox-dark.png`, `ios/you-dark.png`)

Passes: large titles at 30px, groups with counts ("Waiting on you 2",
"Running 3", "Waiting for reset 1"), the state word on the right of each row,
Inbox cards with the command in full, You starting with the hub and showing
values on the rows ("next 20:00", "2 online", "5 active").

- **P2. The "Approval needed" toast covers what it announces.** On Inbox it
  sits over the second card's Allow row, in a session right under the
  approval card's Allow and Deny (hiding "Allow for this session"), and on You
  over the list (`ios/inbox-dark.png`, `ios/session-dark.png`,
  `ios/you-dark.png`). Skip the toast while the Inbox or that session is open,
  and lift it above the tab bar clear of controls elsewhere. [Taste critique
  13: nothing lies on top of a button] [Taste app-screens 5: one figure, one
  place] File: `packages/web/src/store/store.ts:568`.
  **Fixed:** the Inbox and Home (both layouts) drop approval and question
  toasts before they are drawn, and a session or chat drops its own,
  approvals included (`useQuietAskToasts`, `useQuietToasts`). Question
  notices now carry `questionId` for this. Elsewhere the toast already sits
  above the tab bar, or above a docked composer; it was not moved.
- **P3. The filters are pills, and the last one is cut at 390px.** All,
  Approvals, Questions and Results are fully rounded chips in a row that
  scrolls sideways with no scrollbar, and "Results" ends at the screen edge.
  DESIGN.md bans pills and chips; if the owner's phone design overrides that,
  write the exception into DESIGN.md. [DESIGN.md 13] [Taste critique 13: a row
  that scrolls sideways reads as cut off] File:
  `packages/web/src/components/ui/Tags.tsx:69`,
  `packages/web/src/features/chat/PhoneInbox.tsx:102`.
  **Fixed, by following DESIGN.md:** the phone pattern was not better here,
  so the phone changed. The Inbox filter is the same filter words as on
  wider screens (All, Approvals 2, Questions 1, Results fit in one line at
  390px, each with a 44px hit area), and Chats' Sessions or Chats is the
  segmented control. The pill filter is gone, and DESIGN.md 13 now says the
  phone keeps the same bans (`inbox-mobile-*`, `chats-mobile-*`).
- **P3. An icon on every row in You.** Plain outline icons, not boxed, so
  Taste allows them, but DESIGN.md bans "an icon on every row". Same as above:
  record the phone exception or drop them. [DESIGN.md 13] [Taste app-screens
  13: one plain icon where it helps] File:
  `packages/web/src/features/you/YouPage.tsx:56`.
  **Fixed, by following DESIGN.md:** You's rows are words with their values
  and a chevron; the Inbox's Earlier today rows lost their check and cross
  too, with the state as the first word of the line ("Failed, …") in the
  fault colour (`you-mobile-*`).

### A chat (`chat-mobile-*`)

- **P3. A chat's header and composer differ from a session's.** A session has
  "< Home" with a centred title and subline and a round reply field with
  Stop; a chat has "<" with the title on the left, "Chats" on the right and
  the older composer card. [Impeccable polish: the same pattern for the same
  job] File: `packages/web/src/features/conversation/ChatPage.tsx:201`.
  **Header fixed:** a chat draws a session's header: "< Home" (the tab it
  came from), the title with the model under it, and the chat menu, which
  gains All chats (`chat-mobile-*`). **Remains:** the composer. A chat's box
  keeps the model and Options a session puts in its menu.

### Connect (`connect-mobile-*`, `connect-password-mobile-*`, `connect-fingerprint-mobile-*`, `ios/connect-dark.png`)

Passes: one column, the code first, one outlined button for the other way and
a quiet link for the token, the lede hidden while the fingerprint shows,
Continue as the only action.

- **P3. The iOS keyboard covers the Connect button** (`ios/connect-dark.png`).
  iOS Safari ignores `interactive-widget=resizes-content`, so the form should
  scroll its button into view from `visualViewport`, or submit on the
  keyboard's return key (check that it does). [Impeccable audit.native 5:
  inputs hidden behind the keyboard] File:
  `packages/web/src/features/connect/ConnectScreen.tsx` (PhoneConnect),
  `packages/web/index.html:5`.
  **Fixed in code, not checked on an iPhone:** while a field has focus the
  page gets the keyboard's height as room at its foot (from
  `visualViewport`) and scrolls the button into what is still visible, and
  every field's return key says Go and submits the form (checked in
  Chromium: Return pairs).

### Not your hub (`ios/stranger-dark.png`)

Passes: the title says what happened, the body says nothing was sent, the
other saved addresses are listed with Try, and Pair again is the one action.
No findings.

## Web, across layouts

- **P2. Placeholders and some small text are under 4.5:1.** `--fg-4` is 3.2:1
  on the dark ground and 3.5:1 on the light one, and it colours every
  placeholder ("Ask anything", "Reply", "Filter or search", "ABCD-EFGH"),
  disabled labels and the other `text-fg-4` words. `--fg-3` passes (5.1 and
  5.2). Move placeholders to `--fg-3` and keep `--fg-4` for icons and rules.
  [Impeccable craft-floor: contrast, body and placeholder 4.5:1] [Taste
  app-screens 9.2: every tier that carries words, placeholders included]
  Files: `packages/web/src/styles/index.css:25`, `index.css:61`,
  `index.css:263`, `packages/web/src/components/ui/Field.tsx`.
  **Fixed:** placeholders, disabled labels, line numbers and the other words
  in fg-4 are fg-3 now. fg-4 is left on icons, rules and separators, and on
  a disabled segment, which has to read apart from the fg-3 segments that
  can be picked.

## Desktop apps: Linux and Mac

Both open on their own connection page (`packages/desktop/src`), then load
the hub's web app in the window. On Linux, WebKitGTK renders the web app the
same as Chromium (fonts, mono, the diff and the panels match the web shots at
1180 wide). The Mac window adds the title bar.

### Connection page (`linux/connect-*`, `mac/connect.png`)

Passes: one task in one column, labels above fields, a hint for where a code
comes from, "Let the hub use this computer" with what it allows under it,
light and dark follow the system.

- **P2. It is another product's look.** A violet filled Connect button, a
  violet-tinted navy ground (#14121c, #1d1a28) and the platform sans (SF on
  the Mac, the GTK default on Linux), while the app it opens into is neutral
  ink, Mona Sans and a neutral ground. The house rule is "the primary button
  is neutral ink", and violet means live work and focus only. [DESIGN.md 13]
  [Taste app-screens 13: the accent on chrome, a navy dark theme] [Impeccable
  craft-floor refuse: the platform sans as the voice of an own-world page]
  Use the web app's tokens and font files in
  `packages/desktop/src/style.css:1`, `style.css:48`, `style.css:134`.
  **Fixed:** the web app's tokens (neutral ground and ink, light and dark),
  Mona Sans and JetBrains Mono from files next to the page (the same
  @fontsource files the web app bundles, with their OFL; no CDN), a neutral
  ink Connect button, labels and fields as in the web app, no card box
  (`linux/connect-*`).
- **P3. The checkboxes are the browser's own in dark mode**: unchecked boxes
  are default squares next to the themed field styles (both on the Mac shot,
  "Start at login" on Linux). [Impeccable craft-floor: browser surfaces carry
  the design] File: `packages/desktop/src/style.css:122`.
  **Fixed:** the web app's checkbox, drawn in CSS.
- **P3. Focus on `:focus`, not `:focus-visible`**, and the buttons have no
  focus style of their own. [Vercel: use `:focus-visible`] File:
  `packages/desktop/src/style.css:103`.
  **Fixed:** `:focus-visible` rings in violet on buttons and checkboxes, the
  violet border on fields.
- **P3. "run conclave pair on the hub"** here, "conclave pair-phone" on the
  web connect screen and in the CLI help. Both work; say one. [Impeccable
  polish: consistent terminology] File: `packages/desktop/src/index.html:37`.
  **Fixed:** `conclave pair-phone` everywhere (the desktop page, INSTALL.md,
  the CLI's login line).

### After connecting (`linux/home-*`, `linux/session-*`, `mac/home.png`)

The desktop layout's findings apply (Home's approval below the fold first of
all). One more:

- **P3. The window title stays "Conclave" whatever page is open** (the Mac
  title bar shows it), so the Dock, the taskbar and screen readers cannot tell
  Home from a session. [Vercel: state is reflected outside the page] File:
  `packages/desktop/src-tauri/src/main.rs:202` (let the hub page set
  `document.title` per route and the window follow it).
  **Fixed:** the shell titles every page ("Inbox, Conclave", a session's
  or a run's title, "Conclave" for Home; `pageTitle`, tested), and the main
  window follows the page's title (`on_document_title_changed`).

On `mac/home.png` the round badge at the composer's left edge is macOS's
input-source indicator next to the caret (the composer takes focus on load),
not the product's. **Fixed:** the composer no longer takes focus on load;
the first key typed on Home goes into it, so no caret blinks there and macOS
draws no badge over the box's edge. `/` and a click still focus it, and Esc
then G shortcuts work as before (checked in Chromium). The Mac shot is not
retaken.

## Code check against the Vercel guidelines (web)

Findings already listed above are not repeated.

- Pass: no `transition: all`; zoom is not blocked (`packages/web/index.html:5`);
  `color-scheme` set per theme (`packages/web/src/styles/index.css:14`,
  `index.css:50`) and `theme-color` follows it (`public/theme.js`); a skip link
  (`packages/web/src/components/Shell.tsx:89`); themed `::selection`,
  `:focus-visible`, scrollbars and tabular figures (`index.css:243` to
  `index.css:307`, `index.css:384`); reduced motion honoured
  (`index.css:607`, `styles/motion.css:6`); icon buttons take a required label
  (`IconButton label=`); the `outline-none` uses all have a focus replacement
  or sit on containers.

## What works (keep it)

- State as a word in a fixed place ("Waiting for you, 1 min", "running 1m",
  "Finished 18:00"), never a spinner.
- Colour only on meaning: amber for what waits, violet for live work, green
  for online. Under 1% clearly coloured pixels on every desktop web screen.
- Figures as type, not tiles: tokens, cost and context in the session panel,
  the workflow's status sentence, values on the You rows.
- Real data shown honestly: the diff, the test output and the git log are
  verbatim.
- One filled primary per screen, in neutral ink, on both layouts.
- The phone layout reads as an iPhone app: large titles, a labelled tab bar
  with a count, back links named for the tab, safe areas respected.
- The identity screens say what happened and what to do next in plain words.

## Ranked fix list

All twelve are fixed (commits 689a9ae to 5d65d4a); notes above. What is
left: a chat's composer still differs from a session's (finding under A
chat), the iOS keyboard fix is unchecked on an iPhone, and the iPhone and
Mac shots need retaking against `bun scripts/demo-hub.ts`.

1. **Fixed. P2** Put the oldest waiting approval or question on the desktop Home's
   first screen, as the phone layout does. `packages/web/src/features/home/HomePage.tsx`,
   `sections.tsx`.
2. **Fixed. P2** Lift placeholders to `--fg-3` and audit the other `text-fg-4` words.
   `packages/web/src/styles/index.css`, `components/ui/Field.tsx`.
3. **Fixed. P2** Keep the "Approval needed" toast off the approval it announces.
   `packages/web/src/store/store.ts:568`.
4. **Fixed. P2** Count and list a workflow once on the phone Home.
   `packages/web/src/features/home/PhoneHome.tsx`.
5. **Fixed. P2** Say "unknown while offline" instead of "Nothing needs you" when the
   hub cannot be reached. `packages/web/src/features/home/status.ts`.
6. **Fixed. P2** Bring the desktop apps' connection page into the lab console look:
   neutral ink button, neutral ground, Mona Sans. `packages/desktop/src/style.css`.
7. **Fixed. P2** Let the owner name the hub device. `packages/server/src/routes.ts`.
8. **Fixed. P2** Dashes for missing values in workflow rows, and hide an all-empty
   Last tool column. `packages/web/src/features/workflows/CallRows.tsx`.
9. **Fixed. P2** Keep the file name visible in tool rows on a phone.
   `packages/web/src/features/conversation/`.
10. **Fixed. P3** Settle the phone layout's pills and icon rows with DESIGN.md
    (write the exception, or change them), and make the desktop Inbox match
    the phone's.
11. **Fixed. P3** Copy and typography: "used once", `…`, curly quotes, one pairing
    command name, no version stamp, one heading after a password login, the
    phone pairing sentence, the fingerprint in the pairing dialog.
12. **Fixed. P3** The rest: the shared selected-row marker, the run view's right
    edge, the desktop page's checkboxes and `:focus-visible`, a window title
    that follows the page, the chat header matching the session's, the iOS
    keyboard over Connect.
