# Conclave for Android

Native Android client for the Conclave hub. Kotlin, Jetpack Compose, Material 3.

```
packages/android
  client/   pure Kotlin/JVM: API models + HTTP/WebSocket client (mirrors packages/core/src/client)
  app/      the Android app (single activity, Compose)
```

`:client` has no Android dependencies, so it builds and tests on any JVM.

## Build

Requirements: JDK 17 or newer (CI uses 21). For `:app` you also need the Android SDK
(platform 37). The Gradle wrapper downloads the right Gradle.

```sh
cd packages/android
./gradlew :client:test              # works without an Android SDK
./gradlew :app:assembleDebug        # needs ANDROID_HOME or sdk.dir in local.properties
```

`:app` is only part of the build when an SDK is found (`ANDROID_HOME`, `ANDROID_SDK_ROOT`
or `local.properties`). Force it with `-Pconclave.app=true`, skip it with `-Pconclave.app=false`.

CI (`.github/workflows/android.yml`) runs the client tests, builds a debug APK on every
push that touches this folder, and on `v*` tags attaches an APK to the GitHub release.
The release APK is signed when these repository secrets exist:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Without them the debug APK is attached instead.

## Install

Download `conclave-debug-apk` from the latest workflow run (or the APK from a release)
and open it on the phone, or:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug and release builds share the id `dev.conclave.app` but not the signing key:
uninstall one before installing the other.

## Connect

1. On the hub, open Devices in the web app, or Settings, Remote access, to get a QR code, or run
   `conclave pair-phone` there. A phone already paired makes one too: Devices, **Pair**.
2. In the app, point the camera at it: Connect opens with the scanner. Or tap **Use address and
   password** and type the hub address with the hub's password, or with the pairing code.
3. The app calls `POST /api/pair` (or `POST /api/login`) and stores the token and the hub's
   public key encrypted (Tink AES-GCM, key in the Android Keystore, excluded from backups).

The code carries the hub's best address (its tunnel when remote access is on), the others as
fallbacks, and the hub's identity fingerprint (`conclave://pair?url=...&code=...&fp=...&alt=...`).
If the first address does not answer, pairing tries the next.

**Password login** (docs/design/HUB-LOGIN-AND-IDENTITY.md section 1) is the backup to the QR
code, off until the owner sets a password on the hub (`conclave password set`). The app sends
the password only over https, or over plain http to this device or a private address (10/8,
172.16/12, 192.168/16, 100.64/10, fd00::/8, `*.local`, `*.ts.net`); anything else is refused
before sending: "Use the https address of your hub to log in with a password." With no code to
check against, the hub's fingerprint shows once after the login, in groups of four, to compare
with Settings on the hub. Settings in the app shows it too.

## Hub identity

The phone never sends its token to a stranger (HUB-LOGIN-AND-IDENTITY.md section 2). The hub
has an Ed25519 key; `fingerprint` is the first 16 bytes of SHA-256 of the 32 raw key bytes, in
hex. `HubIdentityGuard` in `:client` (`HubIdentity.kt`) does the checks:

- **Pairing with a QR code**: the address proves it holds the key with the code's `fp`
  (`GET /api/identity` with a fresh nonce, the signature of `conclave-hub-identity-v1\n<nonce>`)
  before the pairing code goes there. A mismatch stops pairing: "This address is not the hub that
  made the code."
- **Every connection**: before the first request or socket with the token to an address (not
  loopback), the address proves the pinned key. A success holds for 10 minutes at that address;
  a socket reconnect checks again. A stranger (a wrong key, a bad signature, a 4xx other than
  429, or a page that is not a proof, such as a captive portal) gets nothing and shows "This
  address is not your hub. Conclave did not send your sign-in." full screen, with **Try another
  address** (the saved list) and **Pair again**; the socket keeps checking with backoff. An
  address that does not answer is offline, not a stranger, and a 5xx or 429 is the hub's own
  error: the usual retry and fallback apply. The same rules as `checkIdentity` in
  `packages/core/src/client`.
- **Pairings from before this change** keep the key from their first successful check (trust on
  first use). Until there is one (a hub older than identity has no `/api/identity`) nothing
  blocks them, as with the TypeScript client and the CLI.

Signatures are checked with Tink's `Ed25519Verify` in the app (`data/TinkEd25519.kt`), since
`java.security` has no Ed25519 on Android before 14. `:client` has no Tink, so it defaults to
`java.security` Ed25519 (Java 15 and newer), which its tests use; `IdentityTest` checks the RFC
8032 vector, a fixed signature of the identity text, the fingerprint, the password rule, the
cache, `fp` in links, and a mismatch against no answer.

## Reaching the hub

Nothing else needs to be installed. The hub lists every address that reaches it, best first:
a stable tunnel on your domain, the built-in quick tunnel, your own URL, then the same network.
The app saves the list (from pairing, `GET /api/remote` on each connect, and every
`remote.updated` event) and:

- follows the hub to a new quick tunnel address when the one it uses is replaced
  (`previousUrl` in the event), within a few seconds;
- when the address in use stops answering, checks the saved ones with `GET /api/health` and
  moves to the first that answers, so a phone at home falls back to the same network;
- asks you to scan a new code only when nothing answers and the address was a quick tunnel,
  which never comes back.

Settings, Remote access has the same choices as the web app: Quick tunnel, Stable address on
your domain, Tailscale, My own URL, Local only, and the same network switch. It warns before a
change that would cut this phone off.

Plain http is allowed to this device, home and office networks and private VPN ranges (the
hub's same network address is plain http). Plain http to a public address shows a warning and
must be allowed per host.

## Notifications

No push service is involved. With **Notify this device** on (Settings, on by default), a
foreground service keeps the app's own connection to the hub open and shows the hub's notices:
finished work, errors, limits, and approvals with Approve and Deny. On a locked phone, Approve
asks to unlock first (Android 12 and newer).

- Only notices the hub marks `alert` become notifications. Those passed your rules (Settings,
  Notifications in the web app) and were not held because you were using Conclave elsewhere.
- The app tells the hub whether it is on screen (presence), so a phone in a pocket never holds
  notifications for your browsers.
- Battery: the connection waits while there is no network, reconnects at once on a new one,
  backs off longer in the background, and sends nothing of its own there.
- Android requires an ongoing notice for the service. It sits in the lowest importance
  category, "Background connection"; hide that category in system settings and notifications
  still arrive.
- The service starts again after a restart or an update, and stops when you sign out.
- A periodic check (every 15 minutes) catches approvals that slipped through.
- Settings, Send a test shows a local notification.

## The side panel

No tab bar (docs/design/MOBILE-V2.md). Every main screen has a top bar: the menu button, the
title (on a conversation a tap opens its sheet), the **Inbox** icon with its count while
something waits there (approvals, questions, alerts, what friends sent), and New (in the mode of
where you are). The menu, or a swipe, opens the side panel (`ui/panel/SidePanel.kt`; always
shown at 840dp and wider). It is kept simple, as in the Claude app:

- **New** (in the mode of the switch) and **Search**, a field that narrows the list below by
  title, and for a session by agent, folder, project or device. The Chats and Sessions lists in
  Settings search the messages too.
- The **Chat | Assistant | Code** switch, remembered on this phone: it picks whose conversations
  are listed.
- The conversations of that mode, Pinned first, in groups. **Group by** picks Project (one group
  per project across devices, else the folder; chats under Chats), Device, or Time (Today,
  Yesterday, This week, Older), kept on this phone. A breathing dot on one that runs, the accent
  dot on one that waits on you.
- At the foot the **account row**: the avatar, your name, and the hub with its state. It opens
  Settings, and has a dot when an update of the app waits.

Every other page is in **Settings**, in sections under quiet headings: Conversations (Inbox,
Chats, Sessions), Automation (Tasks, Routines, Workflows, Agents), Memory and usage (Memory,
Usage), then Hub (Devices, Map, Remote access, Friends, Scan a new code), Notifications,
Security, Appearance (the theme, and Text size for the conversations' text) and About.

**The app's own update** (`update/UpdateDialog.kt`): when a newer release is ready, a dialog at
app start says "Conclave X.Y.Z is ready" with a short what's new line, **Update now**, **Skip
this version** (quiet until a newer one) and **Don't show at startup**. With the dialog off, the
update shows only as the dot on the account row and in Settings, About, where Show updates at
startup turns the dialog on again. The choices are in the settings store; the rules are
`client/.../update/UpdatePrompt.kt`, tested in `UpdatePromptTest`.

- **Home** is a new conversation: the switch is the bar's title, the mark and the greeting,
  "2 need you" when something waits, and the composer. Chat starts a plain chat; Assistant the
  assistant agent on the hub (no device or folder); Code the coding agent on the last computer
  used, and asks where to work when no folder is known, or takes a repository from GitHub and
  the branch to start from.
- **The composer** (`ui/conversation/ChatComposer.kt`, `ComposerParts.kt`), like Claude Code's
  (docs/DESIGN.md 40): one box with "+" at the left, "Type / for commands" (the hub's commands
  as you type), the mic and Send at the right; under it one quiet row with the permission mode
  (and Code's folder) at the left and the model with its effort as one picker ("Opus 5.5
  Medium", the levels from `ModelInfo.effort`) and the context ring at the right, whose tap
  shows the context window, tokens and cost. "+" holds the files, the web and memory switches
  (a chat), and the custom agent, the computer, the repository, the mode and Ultra (a session).
  The rules are in `client/.../logic` (`Start.kt`, `Effort.kt`, `ContextUse.kt`), tested in
  `ComposerTest`. A new model for a session over the hub's switch size opens the switch sheet
  first (`ui/chat/SwitchSheet.kt`, docs/DESIGN.md 44): the price once and when it pays back, Full
  history (default) or Short handover, and Ask once; the words are in `SwitchWords.kt`, tested in
  `SwitchTest`.
- **A conversation**: your messages in bubbles, replies as plain text, a turn's tool calls folded
  into one line ("Read redirect.ts, edited it, ran bun test") that opens to rows and sheets, an
  approval or a question inline at the end. Tokens and cost are in the sheet.
- **Chats** and **Code**: a search field, rows with the time, a second line only when it says
  something, Archived at the end. **Inbox**: rows, Deny and Allow on an approval, alerts with
  their answers, a friend's request, key change, notes and shares (Decline and Accept), Earlier
  at the end.

The words and lists these show are plain Kotlin in `client/.../logic` (`Drawer.kt`, `Panel.kt`,
`ToolLines.kt`, `Inbox.kt`), tested in `DrawerTest`, `PanelTest`, `ToolLinesTest` and `InboxTest`.

Motion follows the web primitives (docs/design/CHAT-AND-MOTION.md section 1). The math is pure
Kotlin in `client/.../motion` (the Knot's geometry, generated from `docs/design/brand/knot.json`,
and its states, Ink's pace, Roll, the Rim, the timings), tested in `MotionTest` against
`knot.json` and the web CSS tokens; the Compose side is `app/.../ui/motion`:

- **Knot** (`Knot.kt`): the brand mark with its light moving: the light writes the knot and
  lets go (thinking), travels it (a tool), holds in amber, grey or red (waiting, a limit,
  failed) and fades (done), so a failure or a limit shows on the reply's own Knot. The still
  mark is `Mark` in `ui/common/Brand.kt`; the launcher icon is the same knot. At a
  reply's foot while it is written, on the live line under a session turn
  (`chat/SessionLiveLine.kt`), and in status lines.
- **Ink** (`ChatProse.kt`): streamed letters arrive violet and cool to ink; nothing reflows.
- **Rim** (`Rim.kt`) on the chat and session composers; **Send to stop** (`SendStop.kt`) on their
  button, with no ring there (the Rim is the one light).
- **Steps**, **Fold** with its label morph (chat and session thoughts), **Roll** for numbers.
- **Approve and close the gap** (`Gap.kt`, LazyColumn `animateItem` on the spring: a decided
  approval says so in place, slides away, and the rows below ride up), **card to panel**
  (`CardPanel.kt`, SharedTransitionLayout) for routines, and the **toast stack** (`Toasts.kt`).

## Folders, workflows and past chats

The same hub calls as the web (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md section 5). Each
feature has its model file and its calls in its own file: `model/Projects.kt` with
`ConclaveClientProjects.kt`, `model/Workflows.kt` with `ConclaveClientWorkflows.kt`, and
`model/Import.kt` with `ConclaveClientImport.kt`. The rules the screens follow are plain Kotlin
in `client/.../logic` (`Locations.kt`, `WorkflowRuns.kt`, `ImportWords.kt`), tested in
`ProjectsTest`, `WorkflowsTest` and `ImportTest`.

- **Folder on another device** (`ui/chat/LocationBanner.kt`, `FolderPickerSheet.kt`). A session
  shows one line above its composer when its folder needs you: the device is offline (Run on
  the device that has it, Wait), the folder is missing (Choose folder, Clone here, Continue
  without files, then Look again), the copy is behind (Continue, Check again), or it has another
  history (Choose folder). The session's options have Run on another device. When the hub finds no
  folder, Choose folder opens with the closest folders it found, browses the device, and says
  in one line how each folder compares with the old copy. Pin this folder keeps it as the
  project's place on that device; a different history offers Use once and Use and remember.
- **Workflow runs** (`ui/workflows`, Workflows in Settings, and in a session's sheet). A run
  opens with one sentence and the Knot while it works, the current step in Steps under it, then
  the phases in order with one row per call (label, state word, tokens). A row opens the
  agent's transcript, read only; its menu has Skip and Rerun from here. Pause, Resume and Stop
  sit in the top bar; the result, findings and the log follow. A Workflow tool card in a
  session has Open run. A finished, failed or budget stopped run reaches the phone as a notice
  that opens it (`conclave://workflow-run/<id>`).
- **Ultra** under the session composer's "+", with its one line. Never on chats.
- **Import past chats** (Memory, Import). Pick a computer, tick projects or single chats, pick
  Chats only, Chats and learn memory, or Learn memory only, read the cost line, Start. The job
  runs on the hub; Recent imports shows its progress with Pause, Resume, Cancel and Undo.
  Uploading claude.ai and ChatGPT exports stays on the web.
- **Pair a device** (`ui/devices/PairSheet.kt`, **Pair** on Devices), the web's Pair a device
  dialog as a sheet, for the owner and members alike. **App** or **Command line**, then the
  code in large mono type with Copy, its QR code (drawn as the friend invite's is), the hub's
  fingerprint, the time left with Make a new code once it runs out, and for a command line the
  three lines to run there. It says Paired and the name once a new app (`GET /api/clients`,
  `app.updated`) or a computer that came online (the devices list) shows up. The rules are in
  `logic/Pairing.kt`, tested in `PairingTest`.

## The Map, friends and shares

The same hub calls as the web (docs/DESIGN.md 26, 27, 29, 30), each with its model and calls in
`:client` (`model/Map.kt` with `ConclaveClientMap.kt`, `model/Friends.kt` with
`ConclaveClientFriends.kt`, `model/Github.kt` with `ConclaveClientGithub.kt`) and its rules in
plain Kotlin (`client/.../map`, `logic/FriendWords.kt`, `logic/ShareWords.kt`, `logic/RepoWords.kt`,
`logic/Pictures.kt`), tested in `MapLayoutTest`, `MapModelTest`, `FriendsTest`, `SharesTest`,
`RepoSessionTest` and `MapsTest`.

- **Map** (`ui/map`). The layout, the phone's start view, the glide and the particle streams are a
  port of the web's (`MapLayoutTest` runs the web's 300 random hubs). Compose draws it on one
  Canvas: curved links, streams (Full, Quiet, Lines; Lines when animations are off), stuck rings
  and conflict links. Pinch and drag, Fit, the scrubber with Live, and a drawer for the node
  tapped. The socket asks for `map.delta` only while the Map is open.
- **Friends** (`ui/friends`). Whether friends reach the hub, key changes, requests both ways,
  the friends, an invite as a link and a QR code (read from the hub's SVG), a friend's link
  pasted, opened (`conclave://friend?...`) or scanned. A friend's page has the notes both ways;
  its title opens the safety code, Mark verified, Sync, the grant and Remove.
- **Shares**. The list both ways; a share from a friend read only with its diff, Accept and
  Decline, Continue as fork, Handoff, Use as reference and Apply code. Send to friend sits in a
  chat's or a session's sheet; a sent share has Update and Unsend.
- **Repo sessions**. One action over the composer (Clean up, Open pull request or Push) and the
  rest in the sheet with View pull request and Check now. A push or a pull request approval is
  said in words and asks each time.
- **Map pictures** on a maps card: a PNG as it is, the OpenStreetMap SVG drawn on a Canvas.

Loops stop offscreen and when the app is in the background. With the system "Remove animations"
setting (animator scale 0) every state draws one still, clear frame.

## Links

- `conclave://pair?url=...&code=...&fp=...&alt=...` pairing. While paired it opens the pair screen
  with the code filled in; the stored token is never sent to an address a code or link names.
  With `fp` the address proves it is that hub before the code is sent.
- `conclave://approvals` the Inbox
- `conclave://session/<id>` open a session (a chat opens as a chat)
- `conclave://chat/<id>` open a chat
- `conclave://new` Home, ready for a new chat (also the launcher shortcut)
- `conclave://workflow-run/<id>` open a workflow run
- `conclave://friend?fp=...&url=...&s=...&exp=...` a friend's invite, shown in Friends until you
  tap Send request
- `conclave://map` the Map
- Share text or an image to Conclave to start a chat with it.
