# Native iPad and iPhone app

A native Conclave app for iPadOS and iOS in Swift and SwiftUI, the way the
Android app is native Kotlin and Compose. No web view and no Capacitor shell.
The Android app (`packages/android`) is the blueprint: its `client` library is
ported first, its screens follow in the phases below.

## 1. Targets

One universal app. The iPad is first; the iPhone gets the compact layout of
the same views.

- **Layout.** A two-column `NavigationSplitView` and an inspector:
  - sidebar: chats and sessions grouped like the other apps (pinned, today,
    yesterday, earlier; sessions by project), the Inbox and the other pages;
  - detail: the transcript;
  - inspector (`.inspector`, hidden by default): todos, files, the session's
    details.
  On iPhone and in a narrow Split View the same views collapse to a stack.
- **iPhone (compact width).** The split view collapses to a
  `NavigationStack`: the list, then the chat pushed on top. The inspector
  becomes a sheet, the composer sits on the keyboard, and the Android phone
  layout (`ChatScreen`, `SidePanel`) is the reference for spacing and order.
  Code checks `horizontalSizeClass`, never the device model, so an iPad in
  a narrow Stage Manager window gets the same layout.
- **Windows.** Stage Manager, Split View and Slide Over. Multiple windows
  through scenes (`UIApplicationSupportsMultipleScenes`): one chat per window,
  opened with `openWindow(value:)` or by dragging a chat out of the sidebar.
- **Input.** Hardware keyboard shortcuts (`.keyboardShortcut`: new chat ⌘N,
  send ⌘↩, search ⌘F, stop ⌘., next and previous chat ⌘↓ ⌘↑), pointer hover
  (`.hoverEffect`, `.onHover` for message actions), Pencil Scribble in the
  composer (free with `TextField`/`TextEditor`).
- **Files and media.** Drag and drop in and out (`.dropDestination`,
  `.draggable` with `Transferable`), paste images (`PasteButton` and ⌘V in the
  composer), the Files picker (`.fileImporter`) and the Photos picker
  (`PhotosPicker`), Quick Look (`.quickLookPreview`) and the share sheet
  (`ShareLink`) for media. Images are decoded at display size
  (`CGImageSourceCreateThumbnailAtIndex`), never whole.
- **Pairing.** Scan the hub's QR code with VisionKit (`DataScannerViewController`),
  type the code, or log in with the hub's password.
- **Look.** Light and dark follow the system; the colors and fonts are the
  Android app's tokens (`ui/theme`).

## 2. Stack

- Swift 6 with strict concurrency, SwiftUI, Observation (`@Observable`),
  async/await.
- `URLSession` for REST, `URLSessionWebSocketTask` for the live socket.
- Keychain for the hub token and the pinned hub key.
- CryptoKit for the hub identity check (Ed25519 and SHA-256).
- Minimum iPadOS and iOS 18: the Observation and SwiftUI APIs above, and
  `Mutex`, without fallbacks.
- No third-party dependencies, with one planned exception: **Markdown** uses
  Apple's [swift-markdown](https://github.com/swiftlang/swift-markdown) (a
  cmark-gfm parser) with Conclave's own SwiftUI renderer. `AttributedString(markdown:)`
  handles inline text only (no tables, no code blocks). MarkdownUI is in
  maintenance mode and draws its own theme. The renderer has to be Conclave's
  anyway: code blocks with copy, file and path links, citations, a stable
  layout while a reply streams. swift-markdown comes in with phase 2, pinned
  to an exact version.

## 3. Code layout

`packages/ios`, next to `packages/android`: the app targets iPadOS and iOS. A
Mac build later would be the same project (Catalyst or "Designed for iPad"),
not a new package.

- `ConclaveKit/`: a Swift package that imports Foundation and CryptoKit only,
  with no UIKit and no SwiftUI. It ports the Android `client` library: wire
  models, REST client, live socket, pairing and identity, transcript logic,
  model picks. Its tests port the Kotlin JVM tests and run with `swift test`.
- `project.yml`: the Xcode project, generated with
  [XcodeGen](https://github.com/yonaskolb/XcodeGen). CI downloads a pinned
  version and checks its SHA-256 before running it (`.github/workflows/ios.yml`).
  `Conclave.xcodeproj` and the generated `App/Info.plist` are not committed.
  Why not a committed `.xcodeproj`: a pbxproj is a long machine format with
  object ids; nobody can review it in a diff, and the hub (Linux, no Xcode)
  could not write or check one. A 60-line YAML file reviews like the Gradle
  files. On a Mac: `brew install xcodegen` (or the pinned zip), then
  `cd packages/ios && xcodegen && open Conclave.xcodeproj`.
- `App/Sources`: the SwiftUI app, a folder per area (`Pairing/`, `Main/`, then
  `Chat/`, `Sessions/` ...). `AppTests/`: its unit tests, run on an iPad
  simulator.

### CI

`.github/workflows/ios.yml`, on changes under `packages/ios/**` and the
workflow itself, on `macos-15`, actions pinned by SHA like the other
workflows:

- `kit`: `swift test` in `ConclaveKit` (Swift Testing).
- `app`: XcodeGen, then `xcodebuild test` for an iPad simulator with
  `CODE_SIGNING_ALLOWED=NO`, then a light and a dark screenshot of the app
  uploaded as the `ios-screenshots` artifact.

## 4. Signing and distribution

The owner's choice, for v1:

- A free Apple ID. That means no push notifications, no App Groups and no app
  extensions (no share extension, no widgets).
- Installed and refreshed with SideStore or AltStore.
- Each release publishes an unsigned IPA and an AltStore/SideStore source
  JSON: `https://github.com/default-cybe/conclave/releases/latest/download/Conclave.ipa`
  and `.../releases/latest/download/altstore-source.json`. SideStore signs the
  IPA on the device with the owner's Apple ID.
- Bundle id `dev.conclave.app`.

Without push, the app tells the hub it is in use while it is open (presence on
the live socket, as on Android). It shows local notifications only while it
runs.

## 5. Phases

One PR each.

0. This document.
1. `ConclaveKit` with its tests; an app that launches on iPad with a connect
   screen and an empty split view; CI (`.github/workflows/ios.yml`).
2. Connect and read: QR scan and password login, the identity screen, the
   chat and session list, the transcript (paged with `trim=1`, cut pictures
   read from `/messages/:msgId/blocks/:index` when they show), Markdown, tool
   folds, presence on the live socket.
3. Write: the composer and streaming send, the queue (steer and queue), stop,
   approvals and questions inline, Try the next model.
4. Media, files and attachments, the media viewer, the model picker,
   Settings essentials.
5. The rest, in the order of parity with Android: Inbox, tasks, devices,
   memory, usage, map, canvas, then the remaining pages.
6. Release pipeline: the IPA and the source JSON on every release.

### Android screens and the phase that ports each

| Android (`app/.../ui`) | Phase |
| --- | --- |
| `pairing/PairingScreen` | 1 (code and URL), 2 (QR, password) |
| `pairing/IdentityScreen` | 2 |
| `AppRoot`, `panel/SidePanel`, `sessions/SessionsScreen` | 2 |
| `chat/ChatScreen`, `conversation/ChatThread`, `Reply`, `ToolFold`, `ConversationSheet` | 2 |
| `conversation/ComposerParts`, `ChatViewModels` (send, queue) | 3 |
| `approvals/ApprovalsScreen` (inline cards) | 3 |
| `conversation/MediaViewer`, attachments | 4 |
| `chat/SwitchSheet` (model picker), `chat/FolderPickerSheet`, `conversation/ContinueSheet` | 4 |
| `settings/SettingsScreen` (essentials) | 4 |
| `home/HomeScreen`, `home/TodayScreen`, Inbox | 5 |
| `tasks/TasksScreen`, `conversation/Tasks` | 5 |
| `devices/DevicesScreen`, `devices/PairSheet` | 5 |
| `memory/MemoryScreen`, `memory/MemoryMapScreen`, `memory/ImportScreen` | 5 |
| `usage/UsageScreen` | 5 |
| `map/MapScreen` | 5 |
| `canvas/CanvasScreens` | 5 |
| `routines/RoutinesScreen`, `agents/AgentsScreen`, `workflows/*` | 5 |
| `friends/*`, `meetings/*`, `settings/RemoteScreen`, `settings/ReflectScreen` | 5 |
| `sessions/ShareTargetScreen`, `widgets/*`, `notify/*` (push) | not in v1: they need extensions or push |
| `update/*` | not needed: the AltStore source updates the app |

## 6. ConclaveKit and the Android client

Ported in phase 1, with tests:

- wire models: `Message`, `Session`, content blocks, events, approvals,
  questions, models, pairing and login. Unknown enum values and unknown block
  and event types fall back instead of failing, as `ConclaveJson` does.
- `ConclaveClient`: REST, the hub identity check before the token goes out,
  pairing, password login, the paged transcript (`limit`, `beforeSeq`,
  `trim=1`) and block reads.
- the live socket: reconnect with backoff, replay with `since`, resync after a
  hub restart, refusals (401, 403, 429), "not your hub".
- logic: `Transcript` and its reducer, `Trimmed` and `BlockRef`, the pending
  queue, `ModelRefs` and `ModelPicks`, `NextModel`, `Asks`, `HubAddress`,
  `DeepLink`, `PasswordRule`.

Later phases port the rest of `client/logic` as their screens need it (chat
items and units, tool summaries, file cards, session grouping, the other
pages' logic), each with its Kotlin tests.
