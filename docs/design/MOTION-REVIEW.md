# Motion review: the Knot and the ten motions

This is the whole-app review of the motion round on the web, after the foundation, the web build and its QA. It covers what was checked, what was fixed, and what is left. The spec is `CHAT-AND-MOTION.md`; the plan for the rest of the app is `MOTION.md`.

## Checked

**Builds and tests**

- `bunx tsc --noEmit -p .` is clean in core, server, cli and web.
- `bun run build` in `packages/web` passes.
- `bun test` from the repo root: 1267 pass, 0 fail. This includes the 96 web tests.

**Page sweep (mock hub)**

- 20 pages: Home, Chat (empty and a chat), Sessions, three session threads, Inbox, Tasks, Routines, Usage, Devices, Agents, Extensions, Memory, Settings (three), `/dev/motion` and `/dev/ui`.
- Six setups: 1440 and 390 wide, dark and light, reduced motion on and off.
- No console errors. One load on `/agents` once hit `ERR_INSUFFICIENT_RESOURCES` in the headless browser; it loaded cleanly on two reruns.
- No sideways scroll at 390.

**Motion, from frame sequences**

- Chat: send, the Knot thinking, Fold with Ink, Steps through a tool, Ink on the answer, the Fold closing as the answer starts, the done Knot, a failure with Retry, Stop. Dark and light, desktop and phone, and reduced motion.
- Composer: the Rim live, amber breath, settle and the fault mark; Send to stop both ways, by a finished reply and by Esc.
- Sessions: the live line through Thinking, Writing, Running, Writing, Waiting on you, with the Rim and the amber Knot.
- Inbox: approve and close the gap, in the wide and the card layouts.
- Home: the hero Knot writes a loop and a half and settles.
- Usage: Roll on every stat when the range changes.
- Previews: card to panel, opening and closing.
- Toasts: stack, fan out on hover, restack, leave.
- Reduced motion: one still pose per state (thinking violet, waiting amber, failed red, done grey).

**Leftover dot marks.** None for live work. The dot wave is left only as brand art: the empty-state band, the Connect hero, the onboarding hero and rail, and the Done step. The `/dev/ui` gallery still shows the wave variants as brand art.

**Copy.** All strings added this round use short plain sentences. No em or en dashes, no AI words.

## Fixed

1. **A chat that waits on you showed a finished reply.** A chat's tools need no approval, but a hook can ask. The reply then dropped out of its live state: the Knot turned into the grey done knot, the actions showed, and Send came back while the Rim breathed amber.
   - The reply now stays live. Its Knot freezes amber, and "Waiting on you" shows with "Open Inbox" next to it.
   - Send stays Stop, and Esc stops the reply.
   - A message you send waits behind the reply. Before, it opened a new turn.
   - The queued list is no longer cleared while the reply waits.
   - Files: `features/conversation/ChatMessages.tsx`, `Reply.tsx`, `ChatComposer.tsx`, `ChatPage.tsx`, `actions.ts`.
2. **The waiting Knot froze on a tiny stroke.** An approval arrives in the same update as the tool call it is for, so the Knot went straight from thinking to waiting. It froze wherever the thinking loop was, often a short stub.
   - `Knot` has a new `via` prop. The chat reply and the session live line pass `via="tool"` when a tool is waiting. The Knot passes through `tool` first and freezes the whole knot in amber.
   - A test covers it.
3. **Roll dropped a digit before rolling.** When a value got shorter ("$147.86" to "$35.67"), the leading "$" vanished at once while the other digits waited for their turn. When a value behind a sign got longer ("$8.58" to "$147.86"), the "$" landed mid-number and rolled out there.
   - Both cases now roll out the old value whole and roll in the new one.
   - Plain counts that grow ("9s" to "10s", "999" to "1,000") still roll digit by digit.
   - Tests cover it.
4. **The Inbox showed a decided approval twice.** The line under Resolved appeared while the card was still sliding out, and the Resolved group popped in.
   - The line now arrives once the card has gone. Rows rise in through the same `GapList`, and the group fades in.
5. **Chat limit lit the Rim.** On a limit the chat composer played the done settle, but the spec says no light. It now matches Sessions.
6. **Gap list entrance timing.** New rows rose in over 200ms. They now use `--dur-2` (180ms), like every other entrance.
7. **The gallery hero was out of date.** It said 160px and only toggled two states. It now shows the real `Greeting` at 112px (96 on phones), with Replay.
8. **A core test had expired.** "GitHub refusals > a 403 that is not a rate limit does not pause calls" compared against a fixture reset time that has passed. The test now pins its clock, so it no longer depends on the date.
9. **The mock can wait on you in a chat.** Put "ask first" in a message and the web search waits on an approval, as a hook that asks would. Answer it in the Inbox.

The spec (`CHAT-AND-MOTION.md` 1.4, 1.7, 1.8, 1.9 and 3.5) now describes all of this.

**Tokens.** No token values changed. The per-primitive timings from the lab are all within the token range (80 to 620ms) and are listed in the spec: Steps out in 150ms, the Fold label 220ms, the gap slide 170ms and the toast exit 200ms.

## Left

- **The chat column jumps when a preview docks or undocks.** The text reflows and the column re-centers in one frame. Reflow cannot move with a transform. A fix would keep the column width fixed while the panel opens.
- **Toasts cover the bottom of the left rail on desktop.** This is the chat rail's "Hide" link, and the session list on Sessions. On phones the stack docks above the composer.
- **The fault mark on the Rim is faint.** It follows the lab exactly: a 30px tail at 60%, with a hot head. At 1x it reads as pale pink more than red.
- **A failure within about 200ms leaves a small red Knot.** The QA noted this. It follows the Knot rule (freeze the current frame), which Android shares.
- **"Waiting 0 s" on a new approval card.** The card counts in "42 s", while every other timer reads "42s". This is older copy, not motion, and was left alone.
- **Android Roll.** The Roll fix above is web only. If the Android Roll compares digits from the right in the same way, it has the same glitch on values that get shorter. Android was out of scope for this review.
- **Not built:** the Stalled state, and the title glide inside card to panel.
- **Test temp folders.** Each full `bun test` run leaves about 75MB of `conclave-*` folders in `/tmp`. About 3GB from earlier runs is still there. The folders from this review's runs were deleted.

## Recordings

GIFs for the owner are in `/tmp/cg/motion3/final`: the Knot states in a chat reply, the Knot hero on Home, Ink with Fold, the Rim, Send to stop, approve and close the gap, card to panel, the toast stack, Roll on Usage, and a full chat turn on a phone.
