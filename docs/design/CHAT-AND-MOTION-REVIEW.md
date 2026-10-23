# Chat mode and motion: review

Status: done for this round. This is the whole app review after the chat mode, motion and Android builds. The app wide motion pass is not part of it; a later round does that from `MOTION.md`.

## What was checked

- **Builds and tests.** Web typecheck and production build. Typecheck of core, server and cli. The full test suite from the repo root: 779 tests pass, 4 of them new.
- **Every page in the mock.** At 1440x900 and 390x844, dark and light:
  - Home, Chat (new and open), Sessions (list and a running session), Inbox, Tasks, Routines, Agents, Extensions, Memory, Usage, Devices, Settings.
  - Onboarding with `?fresh=1`, the command palette, the shortcuts sheet, the phone More sheet.
  - No console errors or React warnings. No page scrolls sideways at 390px. Escape closes the palette and the shortcuts sheet. The focus ring shows in the nav.
- **Naming after the rename.** Every link, redirect and line of copy that said "Chats" for the workbench.
- **Motion between Chat and Sessions.** Frame sequences of a send in each, 120ms apart.
  - Both use the same mark, the same 14px size and the same word.
  - The word waits 400ms in both, and the mark starts from the still pose.
  - Streamed text fades in per chunk in both.
- **Reduced motion.** The system setting and Appearance > Reduce motion, on twelve pages. Two frames 400ms apart match, except for ticking counters and text the mock streams in. The thinking mark is the still mark and the word still shows.
- **Copy.** A grep of `packages/web/src`, core and server for em dashes, en dashes and AI words found none.
- **Real hub.** A hub on port 7880 with no provider key, plus a small fake model on port 7883.
  - Every chat endpoint with curl: create, the kind filter and its 400, bad switches, messages, usage.
  - Chat mode in the browser against the hub: the greeting with a name, a send that fails, the failed state, Open Providers.
  - Streaming, the title, recalled notes and Retry, with the fake model.

## What was fixed

1. **Rewind removed the wrong messages on the real hub.** The hub keeps messages up to the seq it is given. Sessions sent the seq of the message to drop, so Edit kept your message and sent it twice. "Rewind to here" kept one message too many, and `/rewind` left your prompt behind.
   - Sessions now send `seq - 1`, as Chat and Android already do.
   - The mock now matches the hub.
   - With "Restore files too", the hub now restores the first checkpoint at or after the kept message. Before, it went back one turn too far.
   - The spec says it right now, and a test covers it.
2. **The hub's hidden memory text showed in your messages.** The hub adds recalled notes to your message as a `<system-reminder>` block for the model.
   - Chat and Sessions showed it in your bubble. Copy copied it. Edit and Retry sent it back, so the notes doubled.
   - It is now never shown, copied or resent. A message that is only hub context, like a Stop hook's feedback, no longer shows as an empty "You".
   - The mock now stores recalled notes the way the hub does, so this stays tested.
3. **A failed reply did not say what to do.** It read "anthropic 401 authentication_error: x-api-key header is required."
   - The hub now says "Anthropic has no API key on this hub. Add one in Settings, Providers, or switch model, then retry."
   - A refused key and an empty account get the same kind of sentence. Other errors keep the provider's words.
   - Chat and Sessions add an "Open Providers" action next to Retry and Switch model.
4. **Chat titles stayed "New chat" on some hubs.** When the small model fails, the hub now asks the model that just answered. It also no longer overwrites a title you set while it worked.
5. **Second opinions lost their place after a branch, or on another device.**
   - The hub now stores which reply a second opinion answers (`meta.messageId`).
   - A branch points it at its copy of that reply. The mock does the same.
6. **Two marks moved at once** when you asked for a second opinion while a reply ran. The waiting row now keeps its words and drops its mark.
7. **"Thinking 0s".** Chat showed a zero second counter, while Sessions waited for one second. Every live counter now starts at 1s. "Thought for" now reads the same in both (1m 24s, not 84s).
8. **Doubled feedback in Sessions.** The hub sends each session notice as a toast too. An open session now drops its own toasts, as an open chat already did, so "Stopped" and errors show once.
9. **Leftover "Chats".**
   - Links and redirects in the session view, the session list and the gallery now go to `/sessions`.
   - Routine, task, import and backup copy now says sessions.
   - The shortcuts sheet lists Chat and Sessions, the new keys (G C, G S, G comma, ⌘⇧O) and the Chat page keys.
10. **Missing pieces from the spec.**
    - Settings > Appearance has a "Your name" field, saved on the hub as `ui.name`.
    - Usage counts chats under their own source, "Chat".
11. **The message count of a session** went up by one after every failed turn. The hub now counts it right.

## What is left

- **The CLI's `/rewind`** sends the prompt's own seq, so the hub keeps that prompt. The cli package was outside this review.
- **Android** reads neither `meta.messageId` on second opinions nor the new error wording. Both are compatible: Android keeps placing second opinions from memory, and it strips "Error: " as before.
- **On phones a toast covers the chat composer's bottom row** for its five seconds, an approval from another session for example.
- **Old session messages show only the time** in the transcript. A message from four days ago at 05:19 reads like today.
- **The session list counter** shows "0s" for the first second of a run. It is a list counter, not the live line.
- **The hub's "Second opinion from anthropic/... added." notice** still names the raw model. Web and Android hide it.
- **Memory note extraction after a chat** still counts under "Direct API" on the Usage page, because that call carries no session.
- **When a turn fails, the hub drops its empty reply without an event.** Clients keep it until reload. Web and Android already ignore it.
- **Sessions Retry after a failure** sends the prompt again as a new message, while Chat rewinds first. This was left on purpose, because a failed session turn may have run tools.
- **The app wide motion pass** waits for the next round (`docs/design/MOTION.md`).

Scripts, logs and screenshots are in `/tmp/cg/ui3/review`. The final screenshots are in `/tmp/cg/ui3/review/final`.
