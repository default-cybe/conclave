# Mobile v2: one screen, a side panel, no tab bar

The phone apps (Android, and iPhone through the web build's phone layout)
follow the claude.ai mobile app's shape: a conversation fills the screen,
everything else lives in a side panel, and the chrome is quiet. Conclave keeps
its own mark, fonts (Mona Sans, JetBrains Mono for code) and color tokens.
Desktop layouts do not change.

## 1. Frame

- No bottom tab bar.
- Top bar on every main screen, 56 dp tall, no border:
  - left: menu button (opens the side panel);
  - center: the screen's title, 17 sp semibold, one line; on a conversation,
    tapping it opens the conversation's sheet (section 5);
  - right: new chat button (pencil on square).
- Side margins 20 dp. No cards inside cards. Separators only between list
  groups, never around them.
- Toasts sit under the top bar, never over a card's buttons or the
  composer. With a sheet open they move above it.
- No mono text outside code, commands and file paths.
- No meta lines made of dot-joined parts under titles. One plain line at most.

## 2. Side panel

Opens from the left, 85% of the width (max 360 dp), over a dim scrim. Swipe
from the left edge also opens it.

From October 2026 the web build's drawer is as plain as the Claude mobile
app's (SPEC.md 5.3 and 12.1). From top to bottom:

1. The **Chat, Assistant, Code** switch.
2. **New** (pencil icon): a new chat, assistant chat or session in the mode.
3. **Search** (opens the palette as a sheet).
4. **Inbox**, only while approvals, questions or alerts wait, with the count
   (accent color).
5. The mode's conversations, grouped as on a computer: Code by project,
   device or time (Group by at the right of the heading), chats and the
   assistant's by time (Pinned, Today, Yesterday, This week, Older). Title
   only; a running one has a small breathing dot, one waiting on you an amber
   dot; the device when not grouped by device. Then All conversations.
6. Pinned at the bottom: the account row (initial, name, "Owner, madx", the
   hub's state as a dot). It opens the account menu as a sheet: Settings,
   Usage, Devices, Keyboard shortcuts, Get help, What's new, accounts, Log out.

Every other page moved under Settings: its index starts with the Inbox and
More, and More lists Workflows, Routines, Memory, Extensions, Tasks, Goals,
Agents, Usage, Devices, Map, Shares and Shared projects. The Android app
keeps its own side panel (section 2 as it was) until it follows.

## 3. Home is a new chat

- Empty canvas. Centered: the Conclave mark, the knot with its violet light
  (40 dp; `docs/design/brand/README.md`), then the greeting ("Good evening,
  Sam.") at 28 sp. On a fresh launch the light writes the knot and settles
  (the Knot, CHAT-AND-MOTION.md 1.7); with Remove animations it is still.
- Under the greeting, only when something waits: one accent line,
  "2 need you", that opens the Inbox. Nothing else: no working now, no limits,
  no devices line.
- The composer sits at the bottom (section 4).
- A chip row above the composer switches **Chat** and **Code** (two words,
  the current one filled). Code asks for the device and folder on first send
  if they are not set.

## 4. Composer

- One rounded container (radius 24 dp), surface-2 fill, no border in dark,
  hairline in light.
- Text field on top: "Ask anything" (Chat) or "Describe a task" (Code);
  grows to 6 lines.
- Row inside the container, under the text:
  - left: **+** (photos, camera, files);
  - a sliders button: a sheet with model, thinking, agent, device, folder,
    permission mode, Ultra;
  - right: the model's short name in fg-3 (tap opens the model list), mic,
    then send: a 36 dp circle, filled accent when there is text, fg-4 outline
    when empty; a stop square while working.
- No chips row under or over the composer other than Chat/Code on Home, and
  the attached files: one row over the text that scrolls sideways at a fixed
  height, so the text stays on screen (CHAT-AND-MOTION.md 2.5).

## 5. Conversation

- **User message:** right aligned bubble, surface-2 fill, radius 20, max 85%
  width, 16 sp, your markdown rendered, a long paste cut to 14 lines with
  "Show all N lines" (CHAT-AND-MOTION.md 6.4).
- **Assistant message:** plain text, full width, no avatar, no name, no model
  line, 16 sp, line height 1.6 (CHAT-AND-MOTION.md 6.1).
- Under every finished reply: icon row (copy, retry, more), always in view,
  fg-3 under the last one and fg-4 under earlier ones. A long press on a
  reply selects its text; a tap on your own message opens its actions
  (CHAT-AND-MOTION.md 2.6 and 2.8).
- **No tokens, cost or timing lines in the transcript.** They move to the
  conversation sheet.
- **Tool use:** calls in a row fold into one quiet line with a chevron, the
  same groups and words as desktop (CHAT-AND-MOTION.md 6.3): "Ran 2
  commands, read 3 files", with "running", "waiting" or "1 failed" at the
  right. A single call is its own row. Tap expands to plain rows (verb, file
  name, "+2 −0" for edits); the line the agent works on is open while it
  works, and a closed line keeps the running call in view. Tap a row: a sheet
  with the diff or output. No borders, no mono except the file name and
  command. (It was one line per turn, "Read redirect.ts, edited it, ran bun
  test", which pulled calls made after the text up to the first call.)
- **Working:** while the agent works, the last line shows the animated mark (the
  knot's light moving) and
  one word ("Working", "Running bun test"). No strips, no bars.
- **Approval** (inline, at the end of the transcript, like a permission prompt):
  - title: "Run this command?" / "Edit redirect.ts?";
  - the command or file in a mono block;
  - the agent's reason under it in fg-2, curly quotes;
  - full width buttons stacked: **Allow once** (filled), **Allow for this chat**,
    **Deny**; "Always allow" in the more menu.
- **Question:** the question text, options as full width outlined rows, an
  "Other answer" field, send.
- **Conversation sheet** (tap the title): agent, model, device, folder, tokens,
  cost, started; actions Pause, Stop, Rename, Archive, Move to Code or Chat.

## 6. Lists (Chats, Code, Inbox)

- Search field at the top of Chats and Code.
- Rows: title (16 sp) and, on its right, the time (fg-3). A second line only
  when it says something: "Running", "Waiting for you", "Failed".
- No segmented controls, no filter words, no pills. Archived is a row at the
  end of the list.
- Inbox rows: the session title, then one line ("Wants to run git push",
  "Asks: Keep the old API route?"). An approval row has text buttons
  **Deny** and **Allow** on the right. Tap the row: the conversation, scrolled
  to its card. Done items under "Earlier", in fg-3, at the end.

## 7. Settings and More

- Plain grouped list, iOS settings style: group label, rows with a chevron.
  First the Inbox and More, then Settings, Models, Customize and Platform,
  the groups a computer's Settings uses.
- More (`/settings/more`) is the list of pages; they keep their content and
  their headers follow section 1 (a back arrow, back to Settings when
  nothing in the app came before).

## 8. Connect

- Mark, "Connect to your hub", one line of help.
- **Scan QR code** (filled, opens the camera full screen), then
  **Use address and password** as a text button.
- The address form stays as it is (it was fixed in v1).

## 9. Done means

- Same screens on Android and the iPhone build, light and dark.
- Screenshots of: Connect, Home (empty and with "2 need you"), side panel,
  chat, session with tool line folded and expanded, approval, question, Inbox,
  Chats, Code, Settings, in light and dark.
- Existing tests pass; new logic (tool line sentence, side panel recents)
  has tests.
