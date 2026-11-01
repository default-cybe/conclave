# Chat mode and motion

Status: for the build. Owner: design. This file adds two things to `SPEC.md`: a motion system that says what the model is doing, and a plain chat page next to the agent workbench. Where this file and `SPEC.md` disagree, this file wins for the parts it names (it amends spec sections 2, 6, 7, 9.3, 10.1 and 12.1, listed in section 5). Everything else in `SPEC.md` and `COMPONENTS.md` still holds: rules not boxes, color means one thing, no pills, no gradients, no em dashes.

Paths are relative to `packages/web/src` unless they start with `packages/` or `docs/`. See every primitive live at `/dev/ui#motion`.

---

## 0. What exists today

### 0.1 Motion inventory (before this file)

| Where | What moves | How |
|---|---|---|
| `styles/index.css` | `anim-fade` (opacity), `anim-rise` (opacity and 4px up), `anim-pop` (opacity and 4px down), `anim-sheet` (a sheet slides its full height), `anim-right` (opacity and 4px from the right), all 180ms `--ease`. `state-word`: a 240ms color change when a state word finishes. A static violet caret after streaming text (`.md-streaming`, `.stream-caret`). Reduced motion: every animation and transition drops to 0.001ms, system setting (unless `html[data-motion=full]`, Appearance > Reduce motion: Off) or `html[data-motion=reduce]`. | CSS |
| `components/wave` | The dot matrix wave: one shared 30fps loop, DPR aware, pauses offscreen and in hidden tabs, slows its dot pitch when a frame takes more than 8ms, one still frame under reduced motion. Variants hero, scope, strip, ambient. `LiveStrip` (64 x 12 strip, word, elapsed) and `Elapsed` (ticks once a second). | canvas |
| Wave placements | Hero: onboarding welcome, Connect, step rail, Done step. Scope: none since the chat-first Home (the Home scope was removed, see ROUND-REMOTE-NOTIFY-HOME.md). Strip: Running rows on Home, `LiveStrip` in 18 places (provider tests, pairing, hook test runner, MCP connect, tool rows), the boot splash. Ambient: every `EmptyState`. | |
| `features/chat/MessageList.tsx` `LiveLine` | Under the last event while a turn runs: "Writing", "Thinking", "Running bun test" in signal, tokens per second at the right, a full width 22px strip whose rate follows the output. | canvas, text |
| `features/chat/ToolRows.tsx` | A running tool row shows a 64px `LiveStrip` and elapsed in the result column; expanding a row rotates its chevron 90 degrees in 120ms; expanded output fades in. | CSS, canvas |
| `features/chat/Turn.tsx` | Every turn piece fades in (`anim-fade`). Turn actions fade in on hover. "Reasoning, 84 words" while thinking streams, "Thought for 12s" after (client timer, lost on reload). | CSS |
| `features/home` | The still mark over the greeting, strips in Running rows, ticking elapsed counters, row hover fills that fade in 120ms, the Chat or Session menu drops in. | canvas, CSS |
| Overlays | Dialogs fade, sheets slide up, side sheets come in from the right, menus drop 4px, toasts rise 4px, the Jump to latest button rises 4px. | CSS |

What is missing: nothing marks "the model is thinking" except a word; streamed text pops in a word at a time; the brand mark never moves; there is no shared vocabulary for tool running, waiting, resuming and failed beyond words; thinking time is not stored.

### 0.2 What people expect, from Claude and ChatGPT (reference only)

We look at these so the states feel familiar. We do not copy their marks or their animations.

- **claude.ai.** While a reply is pending, Claude's own starburst mark animates at the foot of the conversation. With extended thinking on, a collapsed "Thinking" block appears with a running timer; it streams a summary of the reasoning that the user can expand, then settles to "Thought for 12s". Tool use (web search, fetch) shows as a compact row ("Searching the web", then the query and a result count) that expands into the list of sources; answers carry inline citations that open the source. Streamed text appears in small chunks with a soft fade rather than a hard cut. Hover actions under a reply: copy, retry, thumbs; under your message: edit. Long code and HTML become an artifact in a side panel.
- **Claude Code (terminal).** A small glyph cycles through a few star shapes next to a verb that changes every few seconds ("Pondering", "Reticulating"), followed by elapsed seconds, a token count and "esc to interrupt". Tool calls are lines with a bullet that blinks while running and turns solid when done. Thinking shows as a dim "Thinking" line that can be expanded.
- **ChatGPT.** A pulsing dot sits where the reply will start. "Thinking" or "Reasoning" is a label with a light sweep across the text and a timer; the finished state is "Thought for 23s" with an expandable chain of short summaries. Search shows "Searching the web" with the sources as favicons, and citations as small chips after sentences. Text streams with a fade on each new chunk. Canvas opens code and documents in a side panel.

What users carry from these: (1) something moves before the first token, so a slow model never looks frozen; (2) a word says what is happening, with a timer; (3) reasoning is hidden by default, timed, expandable; (4) tool use is a short row, not a wall of output; (5) new text fades in instead of popping; (6) a stop control is always one key away.

What Conclave does instead of copying: the thing that moves is our own mark, the knot with its light (`docs/design/brand`), and the wave. Labels move with our own letter wave, not a gradient sweep. Citations are words, not chips.

---

## 1. Motion system

The owner picked these from the motion lab (`docs/design/motion-lab`, catalog in `CATALOG.md`): the **Knot** for thinking, and ten more: **Ink**, **Rim** with **Breath**, **Settle** and **Fault**, **Steps**, **Fold**, **Roll**, **Send to stop**, **Approve and close the gap**, **Card to panel** and the **Toast stack**. This section is how they work. `MOTION.md` is the plan for the rest of the app.

### 1.1 Principles

1. **Motion says what the model is doing.** Each live state has one look (1.3). If nothing is working, nothing moves.
2. **Calm and precise.** UI moves 4px at most and settles in 120 to 360ms. Loops are slow (2 to 4.4s) and rest.
3. **Our own.** Live work is the Knot (the brand mark, its light moving on the trefoil), the Rim (one light on the composer edge) and Ink (new letters). Nothing made of dots says the model is thinking or working. No spinners, no pulsing, no bounce, no confetti.
4. **Cheap.** Transform and opacity only, or canvas, or the Highlight API for text color. Nothing animates width, height, top, left, margin or font. Loops pause offscreen and in background tabs.
5. **Still when asked.** Reduced motion (system setting, or Appearance > Reduce motion) draws one still, clear frame of every state, with the same colors and words. Counters still tick.

### 1.2 Tokens (`styles/motion.css`; `components/motion/tokens.ts` mirrors them for canvas code)

| Token | Value | Use |
|---|---|---|
| `--dur-0` | 80ms | Press feedback, a copy icon turning into a check |
| `--dur-1` | 120ms | Hover, press, small swaps (index.css) |
| `--dur-2` | 180ms | Menus, entrances (index.css) |
| `--dur-3` | 240ms | Panels, a state word finishing, a digit roll (index.css) |
| `--dur-4` | 360ms | A live mark settling, a fold opening |
| `--dur-spring` | 620ms | The spring below, until it rests (it looks done by about 300ms) |
| `--ease` | `cubic-bezier(.2,.7,.2,1)` | Entrances and settles |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | Exits |
| `--ease-sine` | `cubic-bezier(.37,0,.63,1)` | Loops, the breath |
| `--ease-morph` | `cubic-bezier(.6,0,.4,1)` | **New.** The Knot's light writes and lets go |
| `--ease-emph` | `cubic-bezier(.2,0,0,1)` | **New.** A card grows into its panel, the send glyph folds |
| `--ease-std` | `cubic-bezier(.4,0,.2,1)` | **New.** A panel shrinks back, a fold reopens |
| `--spring` | `linear(...)`, response 420ms, damping 1 | **New.** List gaps and the toast stack. Critically damped, so it never overshoots |
| `--loop-knot` | 3000ms | **New.** The light writes the knot 1650, lets go 1350 |
| `--loop-knot-tool` | 2000ms | **New.** One lap of the light along the knot while a tool runs |
| `--loop-rim` | 4000ms | **New.** One lap of the light round the composer |
| `--loop-breath` | 4375ms | **New.** Amber in 1600, out 2200, rest 575 |
| `--loop-shimmer` | 2200ms | One pass across a live label, then a rest |
| `--stream-word` | 40ms | **New.** Ink releases words this far apart |
| `--stream-lag` | 320ms | **New.** Ink is never further behind the stream |
| `--rise` | 4px | The most a UI element travels |
| `--stagger` | 40ms | Between items that enter together (at most 5) |

Removed: `--loop-think` and `--loop-work` (the dot mark). The lab's values were better than the old ones in three places, so the tokens changed: the spring (the web had none), the three new curves, and Ink's pacing replacing the 60ms and 150ms fade tiers.

### 1.3 Live states

The same states apply to a chat reply, a session turn, a routine run and a jury juror. `LiveStatus` draws the Knot, the words and the time; the composer draws the Rim.

| State | When | Knot | Rim (composer) | Words and text |
|---|---|---|---|---|
| **Thinking** | Request sent and no output yet, or a thinking block streams | The knot dims; one violet light writes it from the bottom of the right lobe, then lets go from the tail. 3s a loop | Live: one light runs round the edge every 4s | "Thinking 4s", the word shimmers. The thought streams in the Fold under it |
| **Tool running** | A tool call started and has no result | The knot dims; a short violet light (14 of 100) travels it, 2s a lap, over and under the crossings. It starts where the written light's head was | Live | Steps: icon, verb, target ("Searching the web  caddy tailscale") |
| **Writing** | Text streams | As Tool running | Live | Ink on the new text |
| **Waiting on you** | An approval or a question is open | The light turns amber and holds where it is. Going back to work resumes from the same frame | Breath: the edge breathes amber | "Waiting on you" in amber, still |
| **Resuming after a limit** | Session status `waiting_reset` | The knot stays dim; the light holds where it is in fg-3 | None | "Resumes in 4:59", the digits roll (Roll). At zero the Knot writes on from the held light |
| **Done** | The turn ended | The light fades (600ms) and the knot turns fg-3, still | Settle: the light coasts, glows evenly round the edge, fades to the hairline | "Thought for 12s" (Fold closes), "Done in 3m 12s" |
| **Failed** | Error, provider refused, tool failed | The light stops where it is and turns the fault color | Fault: the light brakes and stays as a short red mark | "Failed", the reason in fg-2, one action (Retry) |
| **Stopped** | The owner pressed Stop or Esc | As Done | Settle | "Stopped" in fg-3. Partial text stays |

Timing rule: show Thinking at once on send, so a slow first token never looks frozen. If the first token lands within 400ms, go straight to Writing; the word "Thinking" appears only after 400ms.

### 1.4 Micro-interactions

| Interaction | Motion |
|---|---|
| **Send** | Your message enters at once (opacity and 4px up, 180ms). The composer clears in the same frame. The send arrow folds into a stop square (230ms, `--ease-emph`) and opens back into the arrow when the reply ends (Send to stop). Focus stays in the composer. Sent while a turn runs, it enters the same way after the turn, marked "Queued" (2.11). |
| **Queued to sent** | When its turn starts, the stored message takes the queued bubble's place in the same frame: the same bubble at the same spot, no rise. The x goes; nothing else moves (2.11). |
| **Message enter** | `anim-fade` 180ms, no travel; reply text uses Ink. Items that arrive together stagger by 40ms, at most five. |
| **Thought row** | Fold. While thinking the row reads "Thinking" in violet over the streaming thought. In the same frame the answer starts, it turns into "Thought for 12s" (the shared "Th" stays) and the thought folds closed while the answer rises into its place. A click opens it again: the rule draws down and the paragraphs come in top first (360ms, `--ease-std`). |
| **Tool verbs** | Steps. The old step lifts 4px and fades out by 180ms; then the new one rises a word at a time (32ms apart); its verb gets one pass of light 0.6s after it lands. Two steps never share the line. |
| **Numbers** | Roll, for tokens, cost, countdowns and counts. Only changed digits roll, lower ones first (28ms apart), up when the value rises and down when it falls. 240ms, 380ms for a clock. When the old and new values do not line up digit for digit (the value got shorter, "$147.86" to "$35.67", or a value behind a sign got longer, "$8.58" to "$147.86") the old value rolls out whole and the new one rolls in, so no digit vanishes unrolled. A plain count that grows ("999" to "1,000", "9s" to "10s") still rolls its digits. |
| **Approve** | The button confirms in place ("Allowed once" with a check, the side rule turns ok), then the card slides 34px right and fades (170ms); 90ms in, the cards below and everything after the list ride up on the spring. The count rolls down. |
| **A subagent asks** | Its card is in the chat you are in, at the end, as well as in the Inbox (1.10). A quiet fg-3 line above the card says who asks, "Subagent email asks"; the card and its answers are the same as your own session's, and it leaves the same way. |
| **Open a card** | Card to panel. The card grows into its panel (420ms, `--ease-emph`) while the page dims; the card's face fades out first, the panel's content fades in from 110ms. Closing shrinks it back (320ms, `--ease-std`); the card's face returns before the box is empty. Focus moves into the panel and comes back to the card. |
| **Toasts** | One stack. The newest is in front; older ones sit 11px higher and 5% smaller with their words hidden. Hover or focus fans them out; leaving restacks them on the spring. A toast rises 18px and fades in; it leaves with a 6px drop, or slides 22px right when dismissed. Saved, copied and undo all land here. |
| **Copy** | The icon swaps to a check with `Swap` (120ms), holds 1.5s, swaps back. No toast. |
| **Retry** | The old reply fades out (120ms, `--ease-in`); the Knot starts writing in its place. |
| **Edit your message** | The bubble turns into a textarea in place; Save rewinds and sends; later messages fade out together (120ms). |
| **Scroll to bottom** | "Jump to latest" rises 4px in 180ms; click scrolls smoothly (reduced motion: instantly). After a link to an early message of a long session the newest turns may not be mounted yet; then the log opens at the end again, at once. |
| **Open a long session** | It paints at once with its latest turns (two screens or more) at the bottom; older turns mount above as you scroll up and in idle time, and nothing on screen moves when they do (`features/chat/window.ts`). A `#message` link mounts a few turns around the message and lands on it in the middle. |
| **Model switch** | The logo and name swap with `Swap`. |
| **Rail open and close** | In the layout on desktop, one frame. On phones a sheet. |

### 1.5 Reduced motion

Under `prefers-reduced-motion: reduce` or `html[data-motion=reduce]`, each primitive draws one still, clear frame:

- Knot: the knot dims; thinking is the light about three quarters written (the loop at 1000ms) in violet; tool is the short light at home on the right lobe; waiting and failed are the pose of the work they came from (`via`), in amber or the fault color; the limit is the light at home in fg-3; done the knot in fg-3 with no light.
- Rim: live is a still violet segment on the edge; waiting a still amber edge; failed a short red mark; done and idle the plain hairline.
- Ink does nothing: text lands as it arrives, and the static caret stays.
- Steps, Fold, Roll, Swap, the toast stack and Send to stop change at once (index.css drops animations and transitions to 0.001ms and their delays to 0, so a staggered word never leaves a half written label). The one wait that is timing, not motion, stays: the word "Thinking" still waits 400ms. Card to panel, previews and the gap list open, close and remove in place. The hero Knot is the still mark, the light at home.
- `useReducedMotion()` reads both the system and the Appearance setting.

### 1.6 Performance rules

- The Rim and the send glyph are small canvases and the Knot is a small SVG whose light moves by dash offsets, all on one shared requestAnimationFrame loop (`motion/frame.ts`). Each draws only while it moves: a still state draws once and leaves the loop. Each pauses offscreen (IntersectionObserver) and in background tabs.
- Ink writes six static ranges into the CSS Custom Highlight API once a frame, and only while letters are still cooling (up to 330ms after the last word). It never touches React's nodes' content. The new letters repaint; nothing lays out. A box drawn around text (a code block, a code chip, a table, a quote) is held at opacity 0 until the front reaches its first letter, then fades in (120ms), so an empty box never shows ahead of its words.
- Fold, the gap list and card to panel change layout once, then move what changed with `transform` or `translate` until the layout catches up (FLIP). Text never stretches: boxes clip with `scaleY` and counter-scale their content.
- At most one Knot animates per reply. Rows in lists never animate a Knot.
- No `setInterval` per component. Counters use `useNow` (one shared timer).

### 1.7 The Knot, exactly (web and Android)

The Knot is the brand mark (`docs/design/brand/README.md`, SPEC 9.6) with its light moving. The geometry is `docs/design/brand/knot.json`; `scripts/brand/knot.ts` writes it into `components/brand/knotGeometry.ts` and Android's `KnotGeometry.kt`. The motion is `components/motion/knotMath.ts` (pure, tested in `packages/web/test/knot.test.ts`), drawn by `components/brand/KnotSvg.tsx`. Android's `dev.conclave.client.motion` (`Knot.kt`, tested in `MotionTest`) is the same line for line and matches frame for frame; `ui/motion/Knot.kt` draws it.

**The knot.** A path 100 long from the bottom of the right lobe, going left, in six pieces, under and over by turns, split away from the crossings. Each piece has its share of the 100 (`length`) and where it starts (`from`); the last one runs past 100, round to the start. Positions are any real number, 112 is the same point as 12.

**Drawing in a box of s px** (12 to 160; 64 box units). Layers: the under pieces in the base color, the light on them, the three halos (width 9, flat ends, in the surface color), the over pieces in the base color (flat ends: the under pieces' round ends fill the joins below them), the light on them. Stroke 5.2; at 32px and under 7, halos 11. The light is a span from `tail` to `head` drawn on each piece it touches: on the web as dashes (each path's `pathLength` is its share, so a dash of 3 is 3 of the 100), on Android with `PathMeasure.getSegment` at the same fractions of the piece's measured length. A span can touch both ends of one piece (two dashes).

**Thinking loop** (3000ms, t in ms; `laps = floor(t / 3000)`, `u = t mod 3000`, e = `--ease-morph`, cubic-bezier(.6, 0, .4, 1)):

- Write, u under 1650: `tail = 100 laps`, `head = 100 laps + 100 e(u / 1650)`.
- Let go, u from 1650: `tail = 100 laps + 100 e((u - 1650) / 1350)`, `head = 100 laps + 100`.
- Check values (t: tail, head): 0: 0, 0; 825: 0, 50; 1650: 0, 100; 2325: 50, 100; 3000: 100, 100. The still pose is t = 1000: 0, 73.8.

**Tool:** `tail = closeAt + 100 toolClock / 2000`, `head = tail + 14`.

**States.** Two clocks: the thinking clock runs only while thinking, the tool clock only while a tool runs (each step adds at most 100ms). Every change blends the span from the pose last drawn on `--ease`: 240ms into thinking, waiting, paused and failed, 360ms into a tool, 600ms into done. A light that did not show moves at once; only its strength fades in. Colors change on their own: the base in 360ms, the light in 240ms (CSS transitions; Compose `animateColorAsState`).

| State | Base | Light | Pose |
|---|---|---|---|
| thinking | `--rule-2` | `--signal` | The loop, shifted by an anchor. From a tool: the clock jumps into the letting go where the light is as long as the tool light, anchored on its head, so the tool light lets go of its tail. From done: a new write from 0. From waiting, paused or failed: the held clock runs on |
| tool | `--rule-2` | `--signal` | `closeAt` is the head as the tool starts minus 14, so the light keeps its head (from done: 84, the light's home) |
| waiting | `--rule-2` | `--warn` | Held: the clocks stop. An approval arrives in the same update as the tool call it is for, so the caller passes `via="tool"`: the Knot passes through `tool` first and holds the tool light in amber, not a thinking stroke |
| paused (a limit) | `--rule-2` | `--fg-3` | Held. Thinking writes on from it |
| failed | `--rule-2` | `--fault` | Held, still |
| done | `--fg-3` | fades out | Still |

Mounted straight into a state: thinking starts its loop at 0; a tool at its home (84 to 98); waiting and failed show the still pose of their `via` (thinking without one); paused shows the light at home (84 to 100) in fg-3; done shows no light. Reduced motion and `still` use the stills in 1.5. `mono` draws the base and the light in `currentColor`, the base at 30% while it works.

### 1.8 Primitives (`components/motion`)

```tsx
import { Knot, InkReveal, Rim, Steps, Fold, MorphLabel, Roll, SendStopButton, SendStopIcon, GapList, useGapClose, CardToPanel, LiveStatus, Shimmer, Swap } from '@/components/motion';
```

| Component | Props | Notes |
|---|---|---|
| `Knot` | `state?: 'thinking' \| 'tool' \| 'waiting' \| 'paused' \| 'failed' \| 'done'` (old names work: `working` = tool, `resuming` = paused, `idle` = done), `size?: number` (12 to 160, square, default 16), `mono?: boolean`, `still?: boolean`, `via?: 'thinking' \| 'tool'`, `label?: string`, `surface?: string`, `className?` | 14 or 16 in a status line, 112 as the hero (96 on phones). `still` draws the state's still pose and never animates (rows in lists). `via`, for waiting and failed: the working state to freeze when it was not drawn yet (a tool that asked for approval as it started). Without `label` it is `aria-hidden`. `surface` is the color behind it when the nearest background is not |
| `InkReveal` | `active: boolean`, `children`, `className?` | Wrap the markdown. `useInkReveal(ref, active)` for a container you render |
| `Rim` | `state: 'idle' \| 'live' \| 'waiting' \| 'done' \| 'failed'`, `className?` | Put it inside the composer box (position relative). It reads the box size and radius and draws 4px past the edge |
| `Steps` | `step: { id?, icon?, verb, target? }`, `appear?: boolean`, `className?` | Change `step` to swap. Icon: a 15px lucide icon, strokeWidth 1.5 |
| `Fold` | `live: boolean`, `label: string` ("Thought for 6s"), `liveLabel?` ("Thinking"), `open?`, `defaultOpen?`, `onOpenChange?`, `children` (the reasoning, one paragraph per child), `className?` | Uncontrolled it opens while live and closes when live turns false: flip `live` in the same render the first answer token lands |
| `MorphLabel` | `text`, `live?`, `className?` | The "Th" morph on its own. At rest the label is one word; it is in pieces only while it turns, so a copy or find in page reads it once |
| `Roll` | `value: number \| string`, `format?: (n) => string`, `direction?: 'auto' \| 'up' \| 'down'`, `duration?: number` (240, 380 for a clock), `className?` | Screen readers get the plain value |
| `SendStopButton` | `running`, `ready`, `size?` (glyph px, 16 desktop, 18 phones), `ring?`, `sendLabel?`, plus button props (`onClick`, `className` for the size) | `SendStopIcon { stop, size?, ring?: number (button px), radius? }` drops into an existing button |
| `GapList<T>` | `items`, `keyOf`, `children: (item, { leaving }) => node`, `exit?: 'right' \| 'fade'`, `className?`, `itemClassName?` | Confirm in place first (Swap the label, turn the rule ok), then remove the item. `useGapClose(ref)` moves any rows marked `data-gap-key` |
| `CardToPanel` | `open`, `onOpenChange`, `card` (node, rendered in a button), `cardClassName?`, `children` (the panel), `label`, `panelClassName?` | A modal dialog: focus trap, Esc, click outside, focus back to the card |
| `LiveStatus` | `state`, `label?`, `detail?`, `action?`, `startedAt?`, `endedAt?`, `resumeAt?`, `countdown?`, `size?`, `mark?`, `still?`, `className?` | Numbers roll. `countdown` reads "Resumes in 4:59". `action` holds Retry. `still` for rows. It replaces `LiveStrip`, which is gone |
| `Elapsed` | `since`, `until?`, `format?: 'clock' \| 'short'`, `className?` | A ticking elapsed time whose digits roll (moved from `components/wave`) |
| `Shimmer`, `Swap` | as before | |

The toast stack is `Toaster` in `components/ui/Toast.tsx`; raise toasts with `toast()` from `store/store` as before. Hooks: `useReducedMotion()`, `usePageVisible()`, `useOnscreen(ref)`, `usePresence`, `usePresenceList`. Tokens for code: `DUR`, `LOOP`, `STREAM`, `SPRING`, `EASE`, `spring`, `springCss`. All of it, in every state, is at `/dev/motion` (and `/dev/ui#motion`) with a Reduce motion switch.

### 1.9 Placements

| Place | What | Size |
|---|---|---|
| Chat reply, from send to done | One Knot at the reply's foot, the same element the whole time, so it never restarts. Before anything arrives it is the reply's first line: the Knot thinks and "Thinking 4s" shows after 400ms. With thinking on (the model can think and the chat's Thinking is not off) a thought is on its way, so the Fold's row holds the first line from the start ("Thinking" after 400ms, no time) with the Knot under it; the thought then streams in under the same word and nothing jumps. While a thought streams the Fold above reads "Thinking" over it and the Knot thinks alone. While a tool runs or text streams the Knot is in `tool` and Steps says the step ("Searching the web  caddy tailscale", "Reading 3 pages", "Writing"); a running tool has no row of its own until it has a result. Done: the Knot settles into `done` next to the actions | 16 |
| Chat reply, thought | The Fold: violet "Thinking" while it streams (Ink), "Thought for 12s" folding closed in the render the answer starts | |
| Chat reply, failed | The reply's own Knot stops and turns `failed` in place (a reply that failed before anything arrived keeps its row for this); next to it the reason, Retry, Switch model | 16 |
| Chat, limit | The reply's own Knot holds its light in fg-3 (`paused`) and "Resumes in 4:59" sits next to it, the digits roll down; at zero the same Knot writes on. The Rim has no light (as in Sessions) | 16 |
| Chat, waiting on you | A chat's tools need no approval, but a hook can ask, and so can a subagent it started (1.10). Then the reply stays live: its Knot's light holds in amber (`via="tool"`), "Waiting on you", the card at the end of the chat on every width (it is in the Inbox too), the Rim breathes amber, Send stays Stop, and a message you send waits behind the reply. Going back to work resumes the Knot from the same frame | 16 |
| Composer (Chat, Home, Sessions) | The Rim on its edge: live from the moment you send, amber breath while it waits on you, settle at the end, a red mark after a failure. Send to stop on its button (no ring: the Rim is the one light). In Sessions it is the only Stop; the header no longer has one | |
| Empty chat and Home | The Knot as the hero above the greeting: its light writes a loop and a half, then it settles into `brand`: the light lets go from its tail until it rests at home and the knot turns fg, the still mark. Under the launch it starts as the mark, and the launch's tied knot flies into it | 112 desktop and 96 phones over a new chat; 60 on desktop Home; the phone's Home is a 64px still mark |
| Session transcript, live line | The Knot, then `LiveStatus` for thinking, waiting, resuming and done, or Steps for tools and writing; tokens per second roll at the right. No strip. A failure lands on this line too: the Knot stops and turns `failed` in place, the reason and Retry next to it | 14 |
| Session thought rows | The Fold, closed, with "Reasoning" while it streams | |
| Session tool rows, Home running rows, jury rows, test rows in lists | The Knot drawn still (`still`), with the time or rate in a Roll. A group of calls (6.3) carries it in its summary row while a call in it runs | 12 to 16 |
| Approvals: Inbox, Home, the session thread, the chat | GapList. The card confirms in place (the pressed button's label swaps to "Allowed once" with a check, an ok rule fades in at the left edge; there is no stripe at rest), then reports back 600ms later and slides out (12px on phones, inside the gutter, so the page never scrolls sideways). A card keeps its shape while it leaves. In a view scrolled to its end (the session thread) the browser would pull the scroll back and drop everything above at once; a spacer holds the scroll and the content glides down on the spring instead. On the Inbox the card's line under Resolved arrives once the card has gone, rising in like any new row, so it never shows twice | |
| Toasts on a page with a composer at its foot (Chat, a session) | On phones the stack sits above the composer (`Docked`), never over Send or Stop | |
| Previews in chat | Card to panel from the code block: the panel (docked on desktop, a full sheet on phones) grows out of the block and shrinks back into it | |
| Counters | Roll: section and filter counts, stats, limits (percent, left, resets in), elapsed times, tokens per second, import counts | |
| Routines | Card to panel is not used: routines are rows and the detail is a page with an editor, so there is no card to grow from | |
| Never | An animating Knot in list rows, nav, buttons, dialogs or the tab bar; more than one animating Knot per reply | |

### 1.10 Requests from subagents and workflow agents

The owner asked their assistant to find some mail; it handed the job to its email subagent, which runs in a child session and needed approval for MailRead. The card showed only in the Inbox while the chat the owner was in waited with nothing to answer. Now a subagent's or a workflow agent's approval or question shows inline in the chat you are in, as Claude Code shows them, and in the Inbox as before.

- **The hub** (`core/src/engine/ask-origin.ts`) sets `rootSessionId` on every approval and question: the top session of the one that asks, walking `parentId` up (a workflow agent's parent is the session that started its run; a row without one goes up through its run). A request from below the top also carries `from: { sessionId, agent, label, workflow?, chain }`: the session that asks, its agent, the subagent's description or the workflow agent's label, the run and the workflow's name, and the sessions under the top down to the asker. `sessionId` stays the session that asks: answering resolves it there, "for this session" is that session's rule, and who may answer is decided by that session, as before. The live events (`approval.requested`, `question.asked`), the pending lists (`GET /api/approvals`, `/api/questions`) and the map carry both. The notification links to the top session.
- **Where it shows** (`web/src/lib/asks.ts`, Android `client/logic/Asks.kt`): in a session where it asks, where it is the top (`rootSessionId`), or where a session in its `chain` is open (a subagent between). The session view on desktop and phones, the Chat page on every width (the desktop Chat page no longer says "Open Inbox"; the card is there) and, on Android, the session screen and the Chat tab.
- **The line above the card**, fg-3, 12.5px (14 on phones): "Subagent email asks", "Workflow deep-research, agent search r1 3, asks". Not in the session that asks itself, and not for your own request. A question from a subagent drops its "GLM-5 asks:" in favour of that line.
- **The answers** work in place. "Allow for this session" reads "Allow for this subagent" (on phones "Allow for this chat" does too), and "Allowed for this subagent" once given: it applies to the session that asked. An untrusted session (the email agent) gets no Always allow, as the hub counts it once.
- **Waiting on you.** The turn that started the subagent waits with it: the live line says "Waiting on you" and the Knot holds amber. Its subagent row reads ", waiting on you" in amber (a subagent under it asking counts), the running tasks line reads "1 running task, waiting on you" with "waiting on you" in amber, and in its list the subagent's line reads "Waiting on you" and a workflow's "Waiting on you." before where it is. The sidebar marks the chat as waiting.
- **The Inbox** keeps every request. A subagent's says where it is from: "from subagent email in Lisbon flight booking code" under the title on a computer, and Open session opens that chat. A phone row has the chat's title and "Subagent email wants to use MailRead"; a tap opens the chat at the card.
- **The mock** (`VITE_MOCK=1`): the assistant chat "Lisbon flight booking code" (`/s/s_mail`) has its email subagent waiting on MailRead. Allow and the subagent reads the message, reports, and the chat answers with the booking code; Deny and it says it could not.

### 1.11 Pet and glyphs

Two marks for agent work outside a reply. The Knot keeps the reply (1.6): the pet never goes in one.

- **Pet** (`components/motion/Pet.tsx`, `styles/pet.css`): a soft dome ("mochi", `PET_BODY`) on a flat seat and its own shadow, a curl of the Knot's rope on top (`PET_CURL`), 2 dot eyes with a glint in `--bg`, a mouth, 2 feet, and one stubby arm from `PET_SHOULDER` for a prop; the body keeps x 4..24 of the 32x24 box so props on the right never cover the face. 1.5px strokes in currentColor, the body tinted at 8% of it; `--signal`, `--ok`, `--warn`, `--fault` for accents. `<Pet state size={24..64} still label />`. The face and posture say the state, the prop the job: idle (breath, `--loop-breath` ±3% scaleY from the seat, a smile and a blink: `--dur-blink` 140ms closed, a 5.3s cycle, a double blink every third), thinking (eyes up right, lips pursed, the curl in `--signal`, the violet light laps the body on `--loop-knot`), researching (a magnifier sweeps -9..7deg round the shoulder on `--loop-knot-tool`, the eyes follow it), building (a hammer taps 22deg, a block stacks per tap, up to 3), testing (eyes on 3 ticks that draw `--dur-3` apart, `--ok`), reviewing (round glasses, eyes scan 0.8px inside them), waiting (eyes up, mouth open, the amber hand waves twice per `--loop-knot` and holds up; it blinks), parked (asleep: eyes shut, slumped to 95%, a slower breath, the curl drooped, 3 z's fade in one at a time), done (^^ eyes, a wide smile, one hop with a squash and its shadow shrinking, 720ms; two `--ok` sparkles pop), failed (eyes down, sad brows and a frown in `--fault`, a sweat drop, the curl drooped; it droops once, `--dur-4`). Where: the opt-in `pet` of EmptyState (true for idle or a pose: Home's first day, Workflow runs, the Inbox's "Nothing is waiting on you" as done), a workflow run's status line (`petFor`), the chat header's state word (`sessionPet`: waiting on you, asleep beside the Resumes countdown, failed), a failed chat's reason on desktop and phone (`ErrorBody`, failed), the limit notice (parked), the Inbox's open request (waiting), the running tasks pill (the busiest job; waiting when one waits on you) and the setup Done step (done, beside the wave).
- **Agent glyphs** (`components/motion/AgentGlyph.tsx`): one stroke on a 16 grid per kind (explore, researcher, builder, tester, reviewer, debugger, designer, verifier, general-purpose, workflow, delegate); `glyphKind()` maps agent types (web-searcher is researcher, fact-checker verifier, unknown general-purpose). Running, a violet light travels the stroke (`--loop-knot-tool`; workflow hops, verifier tightens, tester, builder, debugger and designer redraw); done fg-3 and still; failed the light in `--fault`; waiting it holds in amber. In a row it takes the still Knot's slot (a mark, not an icon, SPEC 8.1); only the first three running rows move (`stillRows`, 1.9). Where: workflow call rows, the running tasks list, Delegate call lines.
- **Rules.** CSS and SVG only: transform, opacity and stroke-dashoffset (the verifier's dash length aside). The base styles are each state's key pose; reduced motion and `still` set `data-still`, which drops every animation (the light rests 3/4 along, 2 blocks, 3 ticks, 3 z's, ^^ eyes and both sparkles without the hop). Off screen or in a background tab `data-paused` holds them. Both are `aria-hidden` unless labelled and sit beside the state word, never over text.
- **Transitions.** A page change fades in over `--dur-3` (`.anim-page`, keyed by the first path segment, no exit); chat rows that arrive in one update fade `--stagger` apart, 5 deep (`data-msg-n`); `.cv-state` cross-fades a state color over `--dur-3`. See every state at `/dev/motion`.

---

## 2. Chat mode

### 2.1 Naming: "Chat" and "Sessions"

Decision: add a top nav item **Chat** for plain conversations, and rename today's **Chats** (the agent workbench) to **Sessions**.

Why: the workbench is already called a session everywhere it matters (the `/s/:id` route, "New session" on ⌘N, "Open session" on approval cards, the API, `Session` in the client, the Android app). Only the nav label says "Chats", and that label is what people expect to mean a claude.ai style conversation. "Chat" (singular, like claude.ai and ChatGPT) is the verb and the place; "Sessions" are work units with an agent, a device and a folder. Keeping "Chats" for the workbench and calling the new page something else ("Ask", "Talk") would leave two words for one idea and one word for two.

| | Chat | Sessions |
|---|---|---|
| For | Questions, explanations, drafts, quick how-tos | Work on files and machines |
| Agent | `chat` (web and memory only) | Any agent |
| Device and folder | None (the hub) | Picked per session |
| Approvals | None (its tools need none) | Yes |
| Route | `/chat`, `/chat/:id` | `/sessions`, `/s/:id` (`/chats` redirects) |
| Keys | G then C, ⌘⇧O new chat | G then S, ⌘N new session (Settings moves to G then ,) |
| Data | `Session` with `kind: 'chat'` | `Session` without `kind` |

Nav order (desktop): Home, **Chat**, **Sessions**, Inbox, Tasks, Routines, Agents, Extensions, Memory, Usage, Devices. At 1024 to 1279, Agents, Extensions, Memory and Devices fold into More (as today). Tablet: Home, Chat, Sessions, Inbox, More. Phone tab bar: **Home, Chat, Sessions, Inbox, More**, plus New. New is context aware: on a Chat page it starts a new chat; elsewhere it opens the new session sheet. Its `aria-label` says which ("New chat", "New session").

Lists: chats never appear in the Sessions list, Home's Running section, or Inbox. Usage counts them under a new source "Chat". The command palette lists them in their own group, "Chats".

### 2.2 Routes

- `/chat`: a new chat (empty page, nothing is created until the first send). Sending creates the session with `kind: 'chat'` and the first message in one call (`createSession({ kind: 'chat', chat, model, prompt })`), then replaces the URL with `/chat/:id`.
- `/chat/:id`: one chat. A session that is not a chat redirects to `/s/:id`; a chat opened at `/s/:id` redirects to `/chat/:id`.
- `/chats` redirects to `/sessions`. `/sessions` is today's `ChatsPage`.

### 2.3 Layout, desktop (1024 and up)

Since October 2026 the shell's sidebar (SPEC.md 5.3) is the rail: in Chat mode it lists the chats by time (Pinned, Today, Yesterday, This week, Older) under Search and New chat, and there is no top bar. The chat column is as below; a chat's panel of cards (2.11) sits at the right on wide screens. The drawing keeps the rail's first form for the column's measures.

```
+----------------------+---------------------------------------------------------------+
| New chat   ⌘⇧O       |                Caddy certs for tailnet names        ...       |  header 52, no rule until scrolled
| [Search chats   /]   |                                                               |
|                      |              +--------------------------------------------+   |
| Today                |              | can caddy get certs for my tailnet names...|   |  your message, right aligned
|  Caddy certs for t.. |              +--------------------------------------------+   |
|  Socket server tim.. |   Thought for 3s >                                            |
| Yesterday            |   Searched the web, 3 results >                               |
|  Immich moved to C.. |   Yes. When a site address ends in .ts.net, Caddy asks ...    |  reply, plain prose
| Previous 7 days      |   +-------------------------------------------------------+   |
|  Rack layout as an.. |   | sh                                              Copy  |   |
|  When PBS verify j.. |   | echo 'TS_PERMIT_CERT_UID=caddy' >> /etc/default/...   |   |
|  CSP nonces or has.. |   +-------------------------------------------------------+   |
| Previous 30 days     |   Sources  1 caddyserver.com  2 tailscale.com                  |
|  Gift ideas under .. |   Copy  Retry  Branch  Ask another model      Sonnet 5.5 14:08 |  on hover
|                      |                                                               |
|                      |   +-------------------------------------------------------+   |
|                      |   | Reply                                                  |   |  composer
|                      |   | [clip] | [cl] Sonnet 5.5 v | Effort Low v | Web, memory v        [^] |
|                      |   +-------------------------------------------------------+   |
+----------------------+---------------------------------------------------------------+
     rail 264                         column 720, centered in the space left
```

- **Rail** (until October 2026; now the sidebar, SPEC.md 5.3) (264px, `--bg`, 1px `--rule` right): "New chat" (outline sm, with `kbd` ⌘⇧O), then a search field (30px, "Search chats", `kbd` /). Groups by last activity: Today, Yesterday, Previous 7 days, Previous 30 days, then one group per month ("September"). Group headings: `meta` 600 fg-3, no rule. Rows: one line, title in `row-title` fg (fg-2 when not current), 8px 12px padding; the current chat gets `--bg-raise` and the 2px fg bar (spec 10.2). A running chat shows elapsed in signal at the right ("12s"); a chat with memory off shows "memory off" in fg-3. Hover shows a `MoreHorizontal` menu: Rename, Branch, Continue as a session..., Delete. Search filters titles as you type; Enter runs full text search (`/api/search`) and shows hits with a snippet, as the session list does (spec 11.2.1). The rail collapses with ⌘\ (and a quiet "Hide" text button at its foot); collapsed, the chat header shows a quiet "Chats" text button at its left that opens it again. The state is remembered per device.
- **Column**: 720px max, centered in the remaining width, 32px side padding. Prose uses the new `t-chat` role (15/1.6 desktop, 16/1.55 phones, times the Text size of 6.5; `styles/index.css`).
- **Header** (52px, sticky, `--bg`; a 1px `--rule` appears only once the column has scrolled): the chat title (`title` 17/600, click to rename inline) centered over the column; at the right a `MoreHorizontal` menu: Rename, Branch from the last reply, Continue as a session..., Export Markdown, Delete. No model or device meta line: the model shows in the composer.
- **Panel** (2.11): Context, Outputs and Memory used, docked at the right at 1280 and up and toggled with `PanelRight` beside the chat menu; a right sheet below 1280. A preview (2.7) takes that place while it is open. Token and cost figures also stay in the chat's menu ("Usage, 4.2K tokens, $0.02") and on the Usage page.

### 2.4 The empty chat page (`/chat`)

```
                                 (Knot, 112)
                              Good evening, Kai.

          +--------------------------------------------------------------+
          | Ask anything                                                  |
          |                                                               |
          | [clip] | [cl] Sonnet 5.5 v | Effort High v | Web, memory v   [^] |
          +--------------------------------------------------------------+
            Recent   Caddy certs for tailnet names   Socket server time...
```

- Vertically centered a little above the middle (at 40% of the height). The greeting is `t-page` size at 26px, weight 560, width 104%: "Good morning", "Good afternoon" or "Good evening" by the local time, then ", Kai." when hub config `ui.name` is set (Settings > Appearance gets a "Your name" field), else a period. Home opens on the same greeting and composer since the chat-first Home (`features/conversation/Greeting.tsx` serves both); these are the only greetings in the product (they amend spec principle 6 and the banned list for these two pages only). No tagline, no suggestion chips.
- The composer is the same component as in a chat, 720px, centered. Placeholder "Ask anything". Autofocus on desktop, not on phones.
- Under it, on desktop: "Recent" in fg-3 and the last three chats as quiet text links in one line, ellipsized.
- Memory off for this chat shows as a line under the composer in fg-3: "Memory is off for this chat. It will not read or save notes."

### 2.5 Composer

One box: `--bg-sunk`, 1px `--rule-2`, `--r-2`, 12px padding, max 720px. Textarea (`t-chat` size, grows to 12 lines). Placeholder "Ask anything" on a new chat, "Reply" in a chat, "Reply, it will be sent when this one finishes" while running.

Bottom bar, left to right, separated by 1px `--rule` rules 14px tall (spec 10.5):

1. **Attach** (`Paperclip` icon button, "Attach files and images"). Also paste and drag and drop onto the column (the column shows a 1px dashed `--rule-2` outline while dragging, no fill). Images, PDFs, text and code files, and zips; 20 MB per file. Attachments sit above the textarea as one row (2.5.1).
2. **Model** (`ModelPicker look="text"`, mono logo plus name, "Sonnet 5.5"). Changing it PATCHes `model` on an existing chat; the next reply's meta names its model.
3. **Effort** ("Effort" then the level: Off, Low, Medium, High, Extra high, Max; a `SelectMenu look="text"`, `EffortMenu` in `ChatComposer.tsx`). It lists only the levels the selected model has (`ModelInfo.effort`, docs/DESIGN.md 37), Off only where the model can stop thinking, and marks the model's default; unset shows the default. Shown only when the model has an Effort control. Picking another model keeps the level when it has it, else moves it to the nearest one. PATCHes `chat.thinking`.
4. **Tools** ("Web, memory", "Web", "Memory", "No web, no memory"), a menu with two checkable rows: "Search the web" (help: "Look things up and cite sources") and "Use memory" (help: "Read what it knows about you and save what you tell it. Off: this chat leaves no trace in memory."). PATCHes `chat.webSearch` and `chat.memory`.
5. Right: **Send** (`SendStopButton`, `solid` 30px, `aria-label="Send"`), disabled until there is text or an attachment. While a reply runs the arrow folds into **Stop** (`aria-label="Stop"`, `kbd` esc on hover), and the Rim lights the box's edge (1.3). Typing while it runs is allowed; Enter queues the message: it shows at once at the end of the chat as your bubble, marked "Queued" (2.11).

Keys: Enter sends, Shift+Enter new line, Esc stops a running reply, ↑ in an empty composer edits your last message, ⌘⇧O new chat, / focuses the composer (or rail search when the rail has focus).

New chats start with the switches the owner used last on this device (`localStorage["conclave.chat.defaults"] = { model, webSearch, memory, thinking }`), falling back to the hub default model, web on, memory on, effort from the agent (unset: the model's default).

Phones: the bar shows Attach, the model as its logo only (16px, `aria-label` with the name), one "Options" text button that opens a sheet with Model, Effort (the same levels as segments) and Tools as full rows, and Send. Inputs are 16px.

#### 2.5.1 Attachments (October 2026)

The owner attached several files on a phone and the list of rows pushed the field off the screen. Now every composer (the Chat page, a session, Home; web desktop and phones, and Android) shows them the same way:

- **One row, a fixed height.** The files sit above the field as one row of chips, left to right, that scrolls sideways (52px on a desktop, 60px on a phone, 60dp on Android). It never wraps or grows, so the field stays in view with any number of files. A picture is a thumbnail (44px, 48 on a phone) with an x in its corner; another file is a box with its icon (a zip has the archive icon), its name and size, and an x at its end. A file just added scrolls into view at the end. Once the row scrolls, the count sits at its right in fg-3: "7 files". Web: `ComposerParts.tsx` `AttachmentStrip` (the phone box takes it as `attachments`, `PhoneBox.tsx`); Android: `ComposerParts.kt` `AttachmentStrip`.
- **15 per message.** A pick, a drop, a paste or a share that goes past 15 takes the first that fit and says "Up to 15 files per message. Zip the rest." The files of one message also stay under what the hub reads in one request (a 64 MB JSON body, so 45 MB of files before base64): past it, "Files in one message come to 45 MB at most. Send the rest in another message." One file keeps its own limit (20 MB on the Chat page, 12 MB in a session, 8 MB on Android). The hub refuses more than 15 too, with the same line (400). The numbers and words are in one place: `packages/core/src/attachments/limits.ts` (`MAX_ATTACHMENTS`, `TOO_MANY_FILES`, `takeFiles`), mirrored by Android's `client/logic/Attach.kt`.
- **Zips.** The pickers take `.zip` (`application/zip`, `application/x-zip-compressed`; web `ACCEPT_FILES`, Android `Attach.PICKER_TYPES`). A zip is one file of the 15. The hub turns it into what the session can use before the turn starts (`core/src/attachments/prepare.ts`, from `engine.send`):
  - A session that can unzip with its own tools (Code, an agent with a shell, a harness): the zip is saved in the session's folder under `uploads/` (`uploads/src-2.zip` when the name is taken), and the model gets a note with the path and the listing: "src.zip is saved at /home/kai/app/uploads/src.zip. Unzip it there with your tools to work on it." If the folder cannot take it (the device went away), the hub reads it as for a chat.
  - A chat, or an assistant with no shell: the hub reads it. The model gets one text document named as the zip with the listing (200 lines, then "and N more files") and the text files in it, whole, up to 512 KB together ("and 3 more files of text, not included here."); the pictures in it come as images, up to what is left of the 15 (5 MB each, 20 MB together).
  - **What the hub refuses** (400, with the reason, before anything runs): more than 1,000 entries; more than 100 MB unpacked, by what the zip says and by inflating each entry with its claimed size as the hard limit, so a zip that lies stops there ("src.zip is damaged (a.txt)."); a path outside its folder (absolute, a drive letter, a ".." part); a link. Mac junk (`__MACOSX/`, `.DS_Store`) is never listed or read. The hub never writes an entry to disk: it reads in memory with node:zlib, as the export import does, and never shells out with a name from the zip (`core/src/attachments/zip.ts`).

### 2.6 Messages

**Your messages**: right aligned, a quiet bubble: `--bg-raise` with 1px `--rule` in dark, `--surface-2` with no line in light (section 6.4), `--r-2` (5px), padding 9px 14px, `t-chat` fg, max width 85% of the column (520px on desktop), `white-space: pre-wrap`. The same bubble carries your messages in Assistant and Code sessions (`components/ui/Bubble.tsx`). This is a new allowed box (amends spec 6). No name, no avatar. Attachments sit above the bubble, right aligned (images 160px tall max, `--r-2`, 1px `--rule`). On hover (always on touch, under the bubble): "Edit" and "Copy" as quiet text actions, and the time in fg-3. Memory notes injected for this message (`meta.recalled`) show as a fg-3 line under it on hover: "Used 2 notes from memory" linking to them.

**Edit**: the bubble becomes a textarea in place with Cancel (quiet) and Send (solid sm). Send calls `rewind(id, message.seq - 1)` (the hub keeps messages up to the seq it is given, so this removes this message and everything after it) then `send(id, { text, attachments })` with the message's words and attachments kept. Recalled notes the hub attached to the message (a `<system-reminder>` text block) are never shown and never sent again. Confirm first only when more than two replies would be removed: "Edit this message? The 3 replies after it go away. Branch first to keep them." with Branch and Edit.

**Replies**: plain prose, no bubble, no author line, at the reading size and measure of section 6 (15/1.6, phones 16/1.55, about 75 characters a line, times the Text size of 6.5). Markdown as in sessions (headings 22, 19.2 and 17/600, lists, tables with spec 10.7 styling, inline code, links underlined). Order inside a reply: the thinking row, tool rows, the text, sources, then the action row.

- **Thinking row**: the Fold (1.4). While streaming it reads "Thinking" over the thought (fg-2, 1px `--rule-2` left rule, 12px left padding, 13px/1.6), which streams with Ink. In the frame the answer starts it turns into "Thought for 12s" (fg-3, `ChevronRight`, from `ThinkingBlock.durationMs`) and folds closed. Click opens it. Redacted thinking: "The provider hid this reasoning."
- **Tool rows** (one line each, fg-3 `meta`, chevron when expandable):
  - WebSearch running: Steps in the status line at the reply's foot, "Searching the web" with the query (the row itself appears once there is a result). Done: "Searched the web, 3 results" expanding to the results (title in fg, host in fg-3, one per line, links). From `tool_result.meta.results`.
  - WebFetch: "Reading caddyserver.com" in the status line (several at once: "Reading 3 pages" with the hosts), then the row "Read caddyserver.com".
  - MemorySearch: "Checking memory" then "Checked memory, 2 notes" (expands to the notes).
  - MemorySave: "Saved to memory" then the fact as a quote (spec 10.21) with "Undo" (deletes the note) and "Edit" (opens `/memory` at the note). MemoryForget: "Retired a note" with the old text struck through in fg-3.
  - A failed tool: "Search failed" in fault, expanding to the message.
- **Sources**: when the reply links to pages it searched or read, a line after the text: "Sources" in fg-3 then numbered hosts ("1 caddyserver.com  2 tailscale.com") as links, each with the page title as `title`. Built from the reply's markdown links that match `meta.results` URLs, else from all results of that turn. Inline links in the text stay ordinary links. No favicons, no chips.
- **Code blocks**: `CodeBlock` with the language word and a Copy icon that swaps to Check (`Swap`). A `html` or `svg` block (or `xml` whose first element is `<svg`) also gets "Preview" (quiet sm) in its header (2.7).
- **Action row** (on hover of the reply, always on touch, and always on the last reply): Copy, Retry, Branch, Ask another model as quiet text actions (`ActionText`), then at the right in fg-3: the model (mono logo 13 plus name) and the time. Phones (web and Android, since October 2026, as Claude's apps): every finished reply ends with an icon row, always in view: Copy, Retry and `MoreHorizontal` ("..."), fg-3 under the last reply and fg-4 under earlier ones (`features/conversation/ReplyIcons.tsx`, Android `Reply.kt` `Foot`). "..." opens a sheet with the rest: Retry with..., Ask another model, Branch, Continue as a session (Move to Code on Android), Send to friend. A session on a phone has the same row under every finished turn, its "..." holding Ask another model, Fork from here, Rewind to here and Send to friend (`PhoneTranscript.tsx` `TurnIcons`, Android `ChatScreen.kt` `TurnFoot`); Retry under an earlier turn asks first, as the turns after it go.
  - **A long press selects text.** It never opens a menu: a press on a reply selects its words, so part of it can be copied (web: the browser's own selection; Android: the reply's text, markdown, tables and code blocks sit in a `SelectionContainer`, as do asides and jury answers). Your own message opens its actions (Copy and Edit; Copy, Fork, Rewind in a session) on a tap instead, and a long press selects its text too.
  - **One more action.** The row has a place after Retry for one action shown only when it applies: "Try the next model" on a refused reply. Web: `Reply`'s `extraAction` (the desktop row and the phone icons), `ReplyIcons` and `TurnIcons` `extra`; Android: `ReplyView`'s and `TurnFoot`'s `extra`.
  - **Retry**: `rewind(id, userMessage.seq - 1)` then `send` the same text and attachments. "Retry with..." in the menu opens the model list: PATCH `model`, then retry.
  - **Branch**: `forkSession(id, reply.seq)`, then PATCH the new chat's title to "<title>, branch" and open `/chat/:newId`. A toast "Branched. The original is in Today." with Open.
  - **Ask another model**: the model list (`ModelList`), then `secondOpinion(id, { reviewer, messageId: reply.id })`. The aside carries `meta.messageId`, the reply it answers (a branch keeps it pointing at the copy of that reply), and renders inline under the reply: "Second opinion from [logo] GPT-5.5" in `meta` 600 fg-2, then its text in fg-2 with a 1px `--rule-2` left rule and 12px padding, streaming with Ink. Under it: "Continue with GPT-5.5" (quiet, PATCHes `model`) and "Dismiss" (quiet). The chat keeps going with the first model unless you pick Continue. The hub sends the aside to the main model as quoted context on the next turn.
- **Notices** (spec 10.20): "Stopped by you.", "Switched to GPT-5.5." (client side, when the model of a reply differs from the one before), limit and error notices as in spec 11.2.6 with "Switch to GPT-5.5 now" and "Retry".

Scrolling: the view sticks to the bottom while you are at the bottom; "Jump to latest" appears as in sessions. A new reply scrolls so your message sits near the top of the view (like claude.ai), not to the very bottom, so the reply has room to grow under it.

### 2.7 Previews

In: a fenced `html` or `svg` block (complete documents or fragments) opens in a preview panel.

- Desktop (1024 and up): a right panel, 46% of the width (min 420px), 1px `--rule` left, the chat column narrows to fit. Header: the block's language ("HTML", "SVG"), segmented "Preview / Code", Copy, Download (`.html` or `.svg`), "Allow scripts" (an On / Off segmented, off by default), and `X`. Esc closes. One preview open at a time; opening another replaces it.
- Phones and tablets: a full height sheet with the same header.
- The frame: `<iframe sandbox="" srcdoc>` (no scripts, no forms, no same origin, no top navigation). The document gets a CSP meta tag injected: `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:`, so it cannot load anything from the network. "Allow scripts" changes the sandbox to `allow-scripts` only (still no `allow-same-origin`, so the page cannot reach Conclave's storage or cookies) and adds `script-src 'unsafe-inline'` to the CSP; it shows a fg-3 line "Scripts run in a sandbox with no network and no access to Conclave." It resets when the panel closes.
- SVG is wrapped in a minimal HTML document with a white background (`#fff`) so dark mode does not hide dark strokes.
- Still streaming: the Preview button appears when the block's closing fence arrives.

Out: React or JSX previews, Mermaid, Markdown rendering, multi-file projects, editing in the panel, saving or sharing artifacts, previews that fetch from the network, Python or notebook execution. These need a build step, a runtime or a trust model we do not have yet; a sandboxed static frame covers the common case (a page, a chart, a diagram) with almost no risk.

### 2.8 Phones (below 768px)

- The chat is full width with 16px gutters. The header (52px, spec 12.1) shows the chat title with a back chevron to `/chat` and a right "Chats" text button that opens the rail as a bottom sheet (full rail: New chat, search, groups). `/chat` itself shows the empty page; the rail sheet opens from "Chats" in its header too.
- Your bubbles go up to 88% width. Replies use the full width. Code blocks scroll sideways inside their box, never the page.
- The composer sits above the tab bar and hides the tab bar while the keyboard is open (spec 12.1).
- A long press selects text, in a reply and in your message alike; it opens nothing. A reply's actions are its icon row (Copy, Retry, "..." for the rest, 2.6); your message's (Copy, Edit) open on a tap.
- Previews open as a full height sheet.

### 2.9 Continue as a session

A chat turns into a workbench session when it needs files or machines. From the chat menu or the rail menu: "Continue as a session...". The dialog (480px, spec 10.12):

- Title "Continue as a session", body "The conversation so far moves to Sessions with an agent that can work on a device."
- Agent (`AgentPicker`, default the hub's default agent), Device (`DevicePicker`, online only), Folder (mono input, default `~`), Permission mode (segmented, default from settings).
- Checkbox "Keep this chat in Chat" (off by default). On: `forkSession` first and move the fork; off: move this chat.
- Continue (solid): `updateSession(id, { kind: 'agent', agent, device, cwd, permissionMode })`, then open `/s/:id`. The hub drops `chat` switches; the transcript stays; the next turn runs with the new agent's tools.

The chat agent also says this in its reply when you ask it to do something on a machine ("Continue as a session moves this chat to an agent that can run them."); the reply's action row then shows "Continue as a session" as a quiet action for that reply only.

### 2.10 What is in, what is out

In: the Chat page and rail, the composer with model, thinking, web and memory switches and attachments, streaming with the new motion, thinking rows with stored durations, web search rows and sources, memory rows with Undo, code blocks with copy, html and svg previews, edit, retry, branch, ask another model, continue as a session, the greeting, phones, the Android client mirroring the same API.

Out for now: voice input and read aloud, projects or folders of chats, shared links, pinned chats (the rail has no Pinned group; the API's `pinned` stays for later), image generation, per-chat custom instructions (the owner's profile memory does this), message feedback (thumbs), chat import from claude.ai or ChatGPT exports.

### 2.11 Sent while it works (the queue)

While a turn runs, or waits on you, what you send waits on the hub, as in the Claude app. Sessions, the Chat page and both Android screens do the same.

- **At once.** Your message shows as your own bubble after the turn that runs, with a quiet "Queued" and an x before it. Several wait in the order they will run. Steering (Ctrl+Enter or Steer, in a session) says "Sending to the running turn" and sits before the queued ones: it joins the running turn at its next step. In a session on desktop the label and the x sit at the bubble's left, where Copy and Edit wait on hover; on the Chat page they sit under the bubble, where Edit and Copy are; on phones they are a quiet line under the bubble. The composer says nothing more.
- **Remove.** The x takes the message off at once. If the hub refuses for a reason other than "it started" or "it is gone", it comes back and a toast says why.
- **Its turn starts.** The hub stores your message with `meta.pendingIds` (and `meta.whenBusy`), then sends the list without it. The app drops the bubble in the same update as the message lands, so it is never there twice or gone for a frame. The message takes the bubble's place: the same bubble at the same spot, no rise. "Queued" stays next to it ("Steered the running turn" for steering) and the x goes. A queued message stays listed while its turn starts (hooks, memory recall) until it is stored. On the Chat page the coming reply sits under it from that moment, as for a send.
- **Mid-turn delivery.** After each tool call, before the next model call, the queued messages at the front of the queue become steering and join the running turn (as Claude Code does), in order; one held or with its own mode or model waits for its own turn, with what follows it. A turn that only writes text (no tool call) has no such point, so they run after it. Harness turns (ACP Claude Code, Codex) keep end-of-turn delivery.
- **/btw <question>** (web composer, Android) asks a side question: `POST /api/sessions/:id/btw {text}` makes one call on the session's model with no tools, from the transcript's tail (last 60 messages, 20k chars), and answers `{answer}`. Nothing joins the transcript or the queue; web shows it as a dismissible card over the composer, Android as a snackbar line.
- **Steering** joins the running turn as your own message, one per message you sent (the request merges them), with a reminder for the model that it came while it worked. Steering that comes too late for the turn (it was on its last step, or it is a jury, debate or harness turn) runs next as its own turn and says "Queued".
- **Stop** keeps what waits, held (`QueuedMessage.held`): each shows "Stopped" with Send and the x. Send (`POST /api/sessions/:id/queue/:pendingId/send`) runs it in its place; the x removes it. Edit and Retry rewind, which stops, so they hold it too. A turn that fails or stops before it stored its message puts that message back at the front, held. An error after the message is stored runs the next one as before.
- **The hub stores the list** (`core/session/runner.ts` `storeQueue`, kv `queue.<sessionId>`) each time it changes; a message leaves only once it is in the transcript. A hub restart keeps what waits: at boot it waits again in its order and runs (held ones stay held). Each message has an id. The app sends one (`SendInput.pendingId`, 6 to 64 letters, digits, `_` or `-`) so its bubble and the hub's list match from the first frame; the hub makes one when it is missing or taken. A message sent while the session is idle runs as before: no id, no event, no meta.
- **Calls.** `send` answers `{ queued: true, pendingId }`. `GET /api/sessions/:id/queue` lists what waits, in the order it will run (the apps load it with the transcript). `session.queue` carries the whole list each time it changes. `DELETE /api/sessions/:id/queue/:pendingId` takes one off: 404 when it is gone, 409 once its turn started. Only the session's own account may do either, as for sending.
- **Where.** Web: `store/queue.ts` (the rules), `store/store.ts` (`sendQueued`, `removeQueued`, `useQueue`), `features/chat/Pending.tsx` (sessions, desktop and phone), `features/conversation/UserMessage.tsx` `QueuedBubble` (the Chat page). The mock does the same (`mock/queue.ts`). Android: `client/logic/PendingQueue.kt` and `Transcript` (the same rules, tested), `ui/chat/Messages.kt` `PendingUserMessage` and `ui/conversation/Reply.kt` `UserBubble`.

---

### 2.11 The session panel

Every conversation has the same panel (`features/chat/ContextPanel.tsx`, the cards' rules in `features/chat/panel.ts`, SPEC.md 11.2.4), as the Claude app shows a session's: a stack of rounded cards at the right, each a title, a short value and a chevron that opens it, remembered per device. Code sessions get Environment, Context, Connectors, Plan, Outputs, Changes, Background tasks and Memory used; the assistant's conversations the same without Environment and Changes; a chat Context, Outputs and Memory used.

- **Context** shows a small ring with the percent of the window the last reply filled; open, tokens in and out, cost, cache hits and what fills it (the /context breakdown).
- **Outputs** are worked out from the transcript: the files a Write or an edit touched (one row each, a failed call left out; a click opens its row in the transcript), the pictures tool results and replies carry, and the html and svg pages in replies or written to `.html` and `.svg` files, which open in the preview (2.7).
- **Background tasks** fold in what Subagents was: the running tasks of 6.3 (`liveTasks.ts`, Stop on a workflow stops its run, on a subagent its session) and the background shells a Bash call started, followed by BashOutput and KillShell results (the hub has no route to stop a shell from here; the agent does it). What ended is folded under "N finished" while something still runs.

### 2.12 Switching models

A switch is a new model for a session that has history. It is made with the model picker under the composer, the only place a session switches models, or with the limit notice's "Pick another model..." (which then sends "Continue where you left off."). The word is "switch"; "Hand off" is gone. Picking a model asks the hub what the switch costs (`GET /api/sessions/:id/switch-estimate?model=`, docs/DESIGN.md 44). Under the hub's switch size (`context.switchBriefAt`, 50K tokens), for a cheap model (Haiku 5.5, a fast tier model, or a full replay under 5 cents), or from a hub that does not answer, the pick switches at once with the full history, as before.

Over it, the picker turns into the switch step (`features/chat/SwitchChoice.tsx`, `switch.ts`) in the same popover or sheet:

- **"Switch to Sonnet 5.5"**, Back at the right, then "This chat holds about 100K tokens. Sonnet 5.5 reads them with no cache on its first reply."
- Two radio rows. **Full history**, checked by default: "About $0.40 once, pays back after about 9 replies." **Short handover**: "About $0.15 once, pays back after about 3 replies. A summary and the recent turns, with old tool output cleared. The full chat stays stored." A model that costs more per reply says "and each reply costs more than staying"; one cheaper from the start says "cheaper than staying from the first reply".
- When the short handover saves at least $0.20, a quiet line: "A short handover would save about $0.25 here." It goes once Short handover is picked.
- **Switch** (solid) and **Ask once** (quiet), then "One answer from Sonnet 5.5, about $0.04". Ask once sends one second opinion with the transcript; the session stays on its model and its cache stays warm.

Short handover is opt-in. Picking it and switching remembers it on this device (`localStorage["conclave.switch.brief"] = "1"`), so the step opens on it next time; switching with Full history forgets it. The notice after a switch and the summary line are as in SPEC.md 11.2.5. The Android app has the same step as a sheet, reached from the model picker and the limit notice's Switch model (`ui/chat/SwitchSheet.kt`, words in `client/logic/SwitchWords.kt`, the pick in `AppSettings.switchBrief`). The Chat page still changes a chat's model with a PATCH, with no price step; the hub's switch marker still tells the new model it took over.

## 3. API contract (hub, web, Android)

All of this is in `packages/core/src/client/index.ts` (the contract) and served by `packages/server`. The Android client mirrors it with the same JSON names; unknown fields must be ignored by both.

### 3.1 Types

```ts
interface Session {
  // ...existing fields
  kind?: 'agent' | 'chat';     // "chat" for the Chat page; absent means an agent session (all sessions before this change)
  chat?: ChatSettings;         // only when kind is "chat"
}

interface ChatSettings {
  webSearch: boolean;          // offer WebSearch and WebFetch
  memory: boolean;             // profile and recalled notes in the prompt, MemorySearch/Save/Forget offered, notes extracted after a turn
  thinking?: 'off' | 'low' | 'medium' | 'high';   // unset: the agent's setting (the chat agent has none, so off)
}

type ChatSettingsPatch = { webSearch?: boolean; memory?: boolean; thinking?: 'off' | 'low' | 'medium' | 'high' | null };  // null goes back to the agent's setting

interface ThinkingBlock {
  type: 'thinking'; thinking: string; signature?: string;
  durationMs?: number;         // NEW: how long it thought; "Thought for 12s"
}
```

Usage: every call made for a chat (its turns and its title) is recorded with `source: 'chat'`; the Usage page lists it as "Chat".

A failed reply: `session.error` and the error notice say what to do next. A provider with no key reads "Anthropic has no API key on this hub. Add one in Settings, Providers, or switch model, then retry."; a refused key or an empty account says the same kind of thing. The web adds an "Open Providers" action when the reason names Settings, Providers.

WebSearch results: a `tool_result` for `WebSearch` now carries `meta.results: Array<{ title: string; url: string; date?: string }>` along with `meta.provider` and `meta.count`. WebFetch results carry `meta.url`. MemorySave results carry `meta.memoryId`, the id Undo deletes.

A user message's `meta.recalled` lists the memory ids injected for that turn (existing).

### 3.2 Endpoints

| Call | Client | Notes |
|---|---|---|
| `GET /api/sessions?kind=chat` | `listSessions({ kind: 'chat' })` | Chats only. `kind=agent` lists everything else, including old sessions with no kind. No `kind`: both (old clients keep working). Any other value: 400 "kind must be one of agent, chat". Combine with `archived`, `limit`, `search`. |
| `POST /api/sessions` | `createSession({ kind: 'chat', chat?, model?, title?, prompt? })` | Agent defaults to `chat` (when installed), device to the hub (`local`), mode `agent`. `chat` missing switches are on. Bad switches: 400 naming the field. `prompt` sends the first message in the same call. Title is "New chat" until the first reply ends; then the hub writes a 3 to 6 word title and emits `session.updated`. |
| `PATCH /api/sessions/:id` | `updateSession(id, { chat: { webSearch: false } })` | Merges switches; the others keep their value. Also `model`, `title`, `archived`. |
| `PATCH /api/sessions/:id` | `updateSession(id, { kind: 'agent', agent, device, cwd, permissionMode })` | Continue as a session: drops `kind` and `chat`, keeps the transcript. |
| `POST /api/sessions/:id/messages` | `send(id, { text, attachments })` | As for any session. While a reply runs, it queues (`whenBusy: 'queue'`, with the app's `pendingId`) and answers `{ queued: true, pendingId }` (2.11). 15 attachments at most (400 "Up to 15 files per message. Zip the rest."); a zip is saved or read as 2.5.1 says, and one the hub refuses is a 400 with the reason. |
| `GET /api/sessions/:id/queue` | `queue(id)` | What waits while it works, in the order it will run (2.11). |
| `DELETE /api/sessions/:id/queue/:pendingId` | `unqueue(id, pendingId)` | Take a waiting message off. 404 when it is gone, 409 once its turn started. |
| `POST /api/sessions/:id/abort` | `abort(id)` | Stop. |
| `POST /api/sessions/:id/rewind` | `rewind(id, seq)` | Keeps messages with `seq <= seq` and removes the rest. Edit and Retry send the message's `seq - 1`. With `restoreFiles`, files go back to the first checkpoint at or after `seq`. Chats have no file checkpoints (`restoreFiles` does nothing). |
| `POST /api/sessions/:id/fork` | `forkSession(id, fromSeq)` | Branch. The fork keeps `kind` and `chat`. Title "<title> (fork)"; the web app renames it. |
| `GET /api/sessions/:id/switch-estimate?model=` | `switchEstimate(id, model)` | What a switch costs before it happens (2.12): `tokens`, `full` and `brief` (`onceUsd`, `paybackReplies`...), `askUsd`, `confirm` (show the step) and `suggestBrief`. |
| `POST /api/sessions/:id/handoff` | `handoff(id, model, { brief })` | A switch. `brief: true` asks for a short handover; the hub keeps the full history when the chat is small, the model cheap or a reply running, and says so in the notice. |
| `POST /api/sessions/:id/second-opinion` | `secondOpinion(id, { reviewer, messageId })` | Ask another model. The aside arrives as a message with `kind: 'aside'`, `author: 'Second opinion'`, `model: reviewer` and `meta.messageId` (the reply it answers). |
| `GET /api/sessions/:id/messages` | `messages(id, afterSeq?)` | Transcript. |
| `DELETE /api/sessions/:id` | `deleteSession(id)` | |
| `GET /api/search?q=` | `search(q)` | Full text across all sessions; filter hits to chats by the session's kind on the client. |
| `DELETE /api/memory/:id` | `deleteMemory(id)` | Undo on a "Saved to memory" row. |
| `PATCH /api/config` | `updateConfig({ ui: { name: 'Kai' } })` | The greeting name. |

### 3.3 Events (WebSocket, as for sessions)

`session.created`, `session.updated` (status, title after the first reply, switches), `session.deleted`, `message.created`, `message.updated` (the final message, with `durationMs` on thinking blocks), `message.delta` (`kind: 'text' | 'thinking' | 'tool_input'`, with `index`), `tool.started`, `tool.progress`, `tool.completed` (`result.meta.results` for WebSearch), `memory.updated`, `memory.deleted`, `usage.recorded`, `session.queue` (the whole list of what waits, each time it changes, 2.11).

Client state machine for one reply: `message.created` (assistant, empty) starts Thinking; the first `message.delta` with `kind: 'thinking'` keeps Thinking and streams the thought; the first `kind: 'text'` delta switches to Writing; `tool.started` switches to Tool running until `tool.completed`; `session.updated` with `status: 'idle'` ends the turn (Done), `status: 'error'` is Failed, `waiting_reset` is Resuming.

### 3.4 What the hub does for a chat

- Mode: a chat runs in session mode `agent`. The older session mode `chat` means "no tools at all" and stays as it is for jury and debate turns; the Chat page never uses it.
- Tools: the `chat` agent offers WebSearch, WebFetch, MemorySearch, MemorySave and MemoryForget, minus what the switches turn off. No files, shell, devices, MCP servers or subagents. Its tools are allowed without approval (an agent's listed tools are implicitly allowed).
- Memory off: no profile block in the system prompt, no recalled notes on the user message, no memory tools, no note extraction after the turn.
- No file checkpoints (a chat runs on the hub's home folder and has no file tools).
- Effort: `chat.thinking` wins over the agent's `thinking`, at the nearest level the model has (docs/DESIGN.md 37).
- Prompt: `packages/core/src/agents-defaults/chat.md` (validated, see `docs/agents/chat.md`).

### 3.5 Mock

`VITE_MOCK=1` serves the same contract from `mock/chat.ts`: eight chats over two weeks (one with thinking and a web search with sources and code, one with a second opinion, one that saved to memory, one with an svg block, one with an html page, one with memory off, one with web search off). A new message streams a reply that honors the switches: thinking only when it is on, a WebSearch with `meta.results` only when web search is on, MemorySearch and MemorySave when you ask it to remember something and memory is on, a code block, and a title after the first reply. "svg" or "draw" in the prompt returns an svg block; "html" or "page" returns an html block. "fail" makes the reply fail the way a refused key does. "ask first" holds the web search on an approval, as a hook that asks would (the chat waits on you; answer at the end of the chat or in the Inbox). A message sent while a reply runs waits as on the hub (`mock/queue.ts`, shared with the session routes): listed by `session.queue`, written with `meta.pendingIds` when its turn starts, dropped by Stop.

---

## 4. Build split (suggested)

| Area | Owns | Uses |
|---|---|---|
| Chat page | `features/conversation/*` (new: `ChatPage`, `Rail`, `ChatComposer`, `ChatMessages`, `Preview`), routes `/chat` and `/chat/:id` in `App.tsx`, the nav and tab bar change in `components/Shell.tsx` (Chat, Sessions, keys), `/chats` to `/sessions` redirect, palette group "Chats" | `components/motion`, `features/chat/Markdown.tsx`, `ui/Code`, pickers, `mock/chat.ts` |
| Motion in Sessions | `features/chat/MessageList.tsx` (`LiveLine` gets the mark), `features/chat/Turn.tsx` (thinking row with `durationMs`, `InkReveal` on text), `features/chat/ToolRows.tsx` (WebSearch results), `features/chat/SessionList.tsx` (filter out `kind: 'chat'`), Home Running filter | `components/motion` |
| Settings | Appearance "Your name" (`ui.name`), Usage source "Chat" | |
| Android | `packages/android`: Chat tab, chat list, composer switches, the Knot in Compose (same math and geometry as 1.7 and `docs/design/brand/knot.json`: a Canvas, the light on each piece with `PathMeasure.getSegment`, halos in the surface color), reduced motion from the system animator scale | this file, section 3 |

---

## 5. Amendments to SPEC.md

- **2 (banned)**: "Spinners, pulsing dots, shimmering skeletons" stays banned. The Knot, the Rim, Ink and `Shimmer` (a letter wave on a live verb) are allowed by name, only for live model work. Nothing made of dots says the model is thinking.
- **6 (boxes)**: adds a seventh allowed box: your message bubble on the Chat page (`--bg-raise`, 1px `--rule`, `--r-2`).
- **Principle 6 and 13 (copy)**: the Chat empty page may greet by time of day and name ("Good evening, Kai."). Nowhere else.
- **7 (motion)**: adds the tokens in 1.2, the live states in 1.3 and the loops of the Knot, the Rim and the letter wave. UI travel stays at 4px (a resolved card slides 34px out, a toast rises 18px); no bounce.
- **9.3 (placements)**: adds the placements in 1.9.
- **10.1 and 12.1 (nav)**: Chat and Sessions replace Chats; Settings moves to G then ,; ⌘⇧O new chat.
- **4.2 (type)**: adds `t-chat` for chat messages, now the reading size of section 6 (15/1.6, phones 16/1.55; it was 16/1.65 for a day, and 15/1.65 before that), the reading tokens `--read-base`, `--read-size`, `--read-leading`, `--read-measure` and `--read-gap`, and `tx-*` for the rest of a conversation's text, scaled by the Text size (6.5).

---

## 6. Reading (October 2026)

The owner found replies hard to read though the words were fine ("maybe the colours?"), saw their own messages in Assistant and Code sessions look like output, and asked for a turn's tool calls as one line that opens, as Claude does. This section is what was measured, what changed and why. It amends 2.6 and 1.9 and the type roles (section 5).

### 6.1 Measured

Chromium computed styles in the mock at 1440x900, dark and light: the 300 turn session (`?long=300`, `/s/s_long`), `/s/s_auth` and the chat `c_caddy`. Contrast is the WCAG 2 ratio of the text color to the nearest painted background. Characters per line is the text's width over its average glyph width (Mona Sans averages 0.48em).

| | Before | After | Guidance |
|---|---|---|---|
| Answer text color | fg: 16.4:1 dark, 17.0:1 light | the same | WCAG 1.4.3 (AA) 4.5:1, 1.4.6 (AAA) 7:1 |
| Size and leading | 14.5px / 1.6 in sessions, 15 / 1.65 on the Chat page | 16 / 1.65 in both (phones 16 / 1.6, compact density 15 / 1.6); then a step down, 15 / 1.6 (phones 16 / 1.55), with a Text size setting (6.5) | Material body large 16/24; Apple's body text 17pt on iOS; 1.4.8: at least 1.5 |
| Measure | 659px, 95 to 97 characters (sessions); 101 (Chat) | 36em, 576px: 76 to 77 characters | Baymard 50 to 75; 1.4.8: at most 80 |
| Paragraph gap | 10px: paragraphs 1.44 lines apart (Chat 11px) | 0.9em, 14.4px: 1.55 lines apart | 1.4.8: paragraph spacing at least 1.5 times the line spacing |
| List items | 4px apart | 6.4px (0.4em) | |
| Headings | 15px / 600 on a 14.5px body, 1.03 times | h1 22, h2 19.2, h3 17 (600, fg), h4 16 in fg-2 | |
| Your message | plain text in fg under a "You" line: the same as a reply | the Chat page bubble at the right: 15.5:1 on bg-raise (dark), 15.3:1 on surface-2 (light) | |
| Tool targets (paths, commands, patterns) | mono 12.5 in fg, 16.4 and 17.0:1: as loud as the answer | fg-2, 9.1 and 8.6:1; a path's folders fg-3, 5.1 and 5.2:1 | |
| Tool calls | a row each | a stretch of thoughts and calls is one summary row (6.3) | |
| Link underline | rule-2: 1.6:1 dark, 1.7:1 light | fg-3: 5.1 and 5.2:1, fg on hover | 1.4.11: 3:1 for what marks a link |
| Code in an answer | blocks 12.5px with a stray 8.75px margin inside the box (`.md pre`); inline 0.93em | blocks 13px, no inner margin; inline 0.875em (14px) | |
| Tables in an answer | 13px, header 12px fg-3 | 0.875em, header 0.93em fg-2 at 500 | |

So it was not the answer's color: it already had 16:1. It was hierarchy and rhythm. Everything wore the strongest color at nearly one size (the answer, your messages, every path and command in the tool rows, code), lines ran to 95 to 100 characters, paragraphs and list items sat close, headings were barely bigger than the text, your messages looked like replies, and every call was a row of its own between the paragraphs.

### 6.2 Who wears which color

The answer is the strongest thing on the page; everything around it steps down in color and size. Hue says state only, as everywhere else (spec 3): signal for live work, amber for what waits on you, red for failures, green and red for lines added and removed. Kinds of output differ by tone and face, not by hue, so the log never turns into a rainbow.

| Piece | Color | Type |
|---|---|---|
| Answer prose | fg | `--read-size` / `--read-leading` (15 / 1.6, phones 16 / 1.55), measure `--read-measure` (`styles/index.css`, `.md`) |
| Headings in an answer | fg, h4 to h6 fg-2 | 600, 1.375em, 1.2em, 1.0625em, 1em |
| Your message | fg in the bubble (6.4) | `t-chat`, the reading size |
| Author line | fg-2, the model fg-3 | 12.5 / 600 |
| Thought row ("Thought for 12s") | fg-3; opened, the reasoning fg-2 | 12 (13 phones); 13.5 / 1.6, the same measure |
| Tool verb (the tool) | fg-2, signal while it runs | 13.5 / 500 |
| Path | folders fg-3, file name fg-2 | mono 12.5 |
| Command, pattern, other target | fg-2 | mono 12.5 (sans for a web query or a subagent) |
| Result | fg-3; "+12" ok, "−3" and "failed" fault, "waiting on you" warn, the running time signal | 12, tabular |
| Group summary (6.3) | fg-2, fg on hover | 13.5 |
| Terminal output | fg-2; pass markers ok, fail markers fault | mono 12.5 |
| Time gutter, meta | fg-3 | 11 to 12 |

Contrast in both themes: fg 16.4 and 17.0:1, fg-2 9.1 and 8.6:1, fg-3 5.1 and 5.2:1 (4.9:1 on bg-sunk in light), so body text is AAA and every word in the log is at least AA. fg-4 (3.2 and 3.5:1) is for chevrons and the shell prompt only, never words.

### 6.3 Grouped tool calls

`features/chat/toolGroups.ts` (rules), `lib/toolLine.ts` `workSummary` and `groupSummary` (words), `ToolRows.tsx` `ToolGroup` and `CallGroup` (desktop), `PhoneTranscript.tsx` `PhoneWork` and `PhoneGroup` (phones). Workflows and subagents: `features/workflows/WorkflowCard.tsx` (the row and its detail), `ToolRows.tsx` `SubagentRow`, `features/chat/liveTasks.ts` (what runs) and `features/chat/RunningTasks.tsx` (the line above the composer and its list). Tested in `test/tool-groups.test.tsx`, `test/thinking-label.test.tsx`, `test/workflow-card.test.tsx` and `test/running-tasks.test.tsx`.

- **What groups.** All the work between two pieces of prose is one stretch: its thoughts and its calls (Bash, Read, Grep, Glob, LS, Edit, Write, WebFetch, WebSearch, MCP tools and the rest), in the order they ran. A stretch of two or more fold into one summary row, thoughts before the first call and after the last included: the owner saw one stretch of work as three rows ("Thought for 9s", "Ran git log", "Thought for 6s"), now it is one ("Thought for 15s, ran git log"). A single call stays its own row; a lone thought stays its own "Thought for 12s" row, as it was. Background work (Workflow, Task), a card and a call that asks you something (AskUserQuestion, places and routes, watches) keep a row of their own and split the stretch around them, so a workflow or a subagent is never "ran a workflow" or "ran 2 subagents" inside a fold. A stretch runs across messages of one turn; an empty text block does not split it. A tool another server hands on (`mcp__conclave__Workflow`, `mcp__conclave__Task`), and a call a harness only titled whose input is a workflow script, keep their row (`workName`).
- **The words.** The calls as counts by kind, in the order each kind first ran: "Ran 6 commands, read 2 files, searched 3 times, edited 1 file". A file counts once however often it was read or edited; commands and searches count each call; "searched once", "searched the web 2 times", "updated the plan", "used github 2 times". One call is named, as the tool line names it: "ran git log", "read auth.ts". The thoughts are one phrase with their total time, "thought for 15s" (the same words as a thought's row), first when the stretch starts with a thought and last otherwise: "Thought for 15s, ran git log", "Ran 6 commands, read 2 files, thought for 40s". While a thought streams it reads "thinking"; with no time known, "reasoned".
- **The state, at the right** (the place a row keeps its result): "waiting on you" in amber if a call waits on you; else the still Knot and the running time in signal while one runs; else "1 failed" in red (and "1 denied" in fg-3); else the lines its edits changed ("+12 −3"), or the time its calls took, or "done" (nothing for thoughts alone).
- **While the turn works.** The group it is at stays closed, as on Android (the owner asked for it in October 2026: the open group made the page grow with every step). Its summary row names what happens now in signal, "Thinking" while a thought streams or "Running bun test" for the call without a result (`ToolRows.tsx` `groupNow`, after Android's `Work.now`), with the still Knot and the running time at the right; the full summary is its hover title. When the answer starts (the first words after the calls) or the turn ends, the row shows the summary. Opening it yourself keeps it open across updates from then on. Closed, a call that waits on you stays in view under the summary; the approval and question cards stay at the foot of the log as before, never inside a group.
- **Open.** A click or Enter on the summary opens it: the thoughts and calls in order under a rule, indented 32px, fading in (180ms), each thought its own "Thought for 6s" row. An edit's diff is open by default inside, so a diff is one click from a closed group.
- **The rest of the log.** Pieces still mount by window (`window.ts`) and skip layout off screen (`.log-unit`); a closed group renders no rows, which makes long sessions lighter. Stick to bottom is unchanged. A `#message` link to a tool result (or to a message of calls only) opens the group that holds the call as it mounts and lands on the call's row (`MessageList.tsx` `linkedCall`, `ToolRows.tsx` `revealOnMount`). The session's file list ("Changed") finds an edit in a closed group by a hidden marker, opens the group and lands on the diff (`revealToolRow`). Find in page does not see the rows of a closed group: they are not in the page until it opens. The summary words are.
- **Phones.** The same groups and words, as one line with the state and a chevron; open, the thoughts and calls in order, and a call's row opens its sheet. The group the turn works on is closed with its live line, as on desktop. A workflow and a subagent are one line each that opens in place (below), never a sheet. This replaces MOBILE-V2's one line per turn ("Read redirect.ts, edited it, ran bun test"), which pulled calls made after the text up to the first call's place, and folded a workflow into the line: a phone app built before October 22 still shows "Ran set, ran flutter analyze, ran a workflow and 1 more". The iPhone app bundles the web app when it is built (`packages/mobile`, `bun run sync`), so it needs a new build to get this. The Android app is native and does the same in its own code (`packages/android/client` `Work.kt`, drawn in `ui/conversation`): one group per stretch of thoughts and calls, Workflow and Task on their own rows, the running tasks line above the composer, and the same words. There the group stays closed while the turn works on it, with its line saying what runs now.
- **Workflows and subagents, one row each** (as the Claude app shows them; the owner asked for it in October 2026). A Workflow or a Task call is ONE compact row that stands alone and follows the work live, in the log's grid on desktop and as one 15px line on a phone. The big live card it was before is gone from the transcript: its parts are the row's detail.
  - **A workflow** (`WorkflowCard.tsx` `WorkflowRow`): "Workflow deep-research, 3 of 6 agents running" with the still Knot and the running time in signal; paused or waiting for a limit, that word in amber at the right instead; before its run is known (waiting for your approval), "starting". When the run ends: "Workflow deep-research: Use Caddy for the homelab front door." (the first line of its report) and "done in 6m", or "failed" in red, "stopped", "stopped at budget"; refused before it ran, the reason in red and "did not start". The row finds its run by the call's id on the run (`toolUseId`), by its result (`meta.workflowRunId`), or, from an older hub, as the live run of that name, which it keeps once the run ends. It stays closed while the run goes. A click opens the detail under it (`WorkflowDetail`): "Phase 2 of 5, Search. 3 of 6 agents running" (or the result line), each phase numbered with its counts ("2 of 5 done, 2 running"), the phase the run is in (or one where an agent failed or waits on you) listing its agents: label, what it is doing now in a subagent's words ("Searching for jwt", "Reading caddyserver.com", from its last tool, `lib/toolLine.ts` `agentDoing`), its state word (queued, running in signal with its time, waiting in amber, done with how long it took, failed in red with why). More than eight in a phase: the ones still at work, and "and 12 more in the run". The agents, tokens and cost and Open run at the foot.
  - **A subagent** (`ToolRows.tsx` `SubagentRow`, `PhoneTranscript.tsx` `PhoneSubagentRow`): "Subagent explore: Find the auth code, searching for jwt" with its running time; what it is doing now comes from its own transcript ("searching for jwt", "reading auth.ts", "writing", "waiting on you" in amber while it or a subagent under it has an approval or a question open, 1.10). One started in the background (its call answered at once, `meta.background`) runs on in its own session, and the row follows that session. Done: "done in 41s", or "failed" in red. A click opens its log on desktop (who ran it on which model, its calls and words, Open the subagent session) and, on a phone, who ran it, its answer and its session.
- **Running tasks** (`RunningTasks.tsx`, `liveTasks.ts`). While a session has background work going, one small line sits just above the composer, on desktop and on a phone: the still Knot and "2 running tasks" ("1 running task"). It goes away when nothing runs. A click opens the list, a popover above the line on desktop and a sheet on a phone, the one started first first:
  - a workflow: "Workflow deep-research" and its time (or its state word when paused), "Phase 2 of 5, Search. 3 of 6 agents running" and Open run, to the run page. Its chevron opens the same detail as the row, without the summary and foot the list already shows.
  - a subagent: "Subagent explore: Find the auth code" and its time, what it is doing now, and Open session.

  While one of them waits on you (1.10) the line reads "2 running tasks, waiting on you", the words after the comma in amber and the Knot in its waiting pose, and that task's line in the list says "Waiting on you".

  What runs is worked out on the client, with no endpoint of its own: a Workflow call whose run is live (queued, running, paused, waiting for a limit), and any other live run the session started; a Task call with no result while the call runs or the session is at work, and one in the background while its own session is at work (running, waiting on you, waiting for a limit). The session's runs are asked for once (`GET /api/workflows/runs?sessionId=`) and shared by its rows and the line (`workflows/data.ts` `useSessionRuns`), then kept by `workflow.run` and `workflow.phase`; an opened workflow follows `workflow.agent` and `workflow.progress`; a subagent follows its own transcript in the store. Nothing polls. Android uses the same words: "N running tasks", "3 of 6 agents running", "Open run".

### 6.4 Your message

Your message is a bubble in all three modes, the Chat page's (`components/ui/Bubble.tsx`): at the right, at most 85% of the column and 520px wide (about 64 characters), the reading size, `--r-2`, padding 9px 14px. Dark: bg-raise with a rule. Light: surface-2 and no line; the white bubble with a hairline on the near white ground hardly showed. Phones keep surface-2, radius 20. In a session the bubble renders your markdown (sessions always did, and code names in backticks are common there); on the Chat page it stays plain text. A message longer than 18 lines or 1600 characters (a paste) shows 14 lines and "Show all N lines". In a session, Copy and Edit wait at the bubble's left on hover (always on touch), and "Queued" or "Steered the running turn" sits next to the bubble when it was sent while the session worked (where the waiting bubble had it, 2.11); the time stays in the log's gutter. On phones that label is a quiet line under the bubble. Attachments sit above the bubble, at the right.

### 6.5 Text size

The owner found replies too big to read comfortably at 16 / 1.65 on a desktop. Claude's apps read at about 15px on a desktop and 16 on a phone, so the default is a step down, and a setting picks the size.

- **The default.** Desktop 15 / 1.6, a 24px line (`--read-base: 15px`, `--read-leading: 1.6`). Phones 16 / 1.55, as MOBILE-V2 5 and the Android app (16sp, `ConclaveType.chat`). Compact density 14 / 1.6 (phones 15). The measure stays 36em, so a line keeps about 75 characters at any size, and the paragraph gap stays 0.9em (1.56 lines apart). The tool rows, thoughts and code keep their sizes (13.5, 12.5 mono, 13 for code blocks).
- **The setting.** Settings > Appearance, Text size: Small, Default, Large, Larger, at 0.875, 1, 1.125 and 1.25 of the default (desktop replies 13.1, 15, 16.9 and 18.75px; phones and Android 14, 16, 18 and 20). A line under the label reads "A reply reads at this size." at the size picked, and it changes as you pick. Per device: the web app keeps it in `conclave.appearance` with the theme (`store/ui.ts`, `lib/textSize.ts`); Android in its settings store (`text_size`, `client/logic/TextSize.kt`), as a row that opens the four choices and the same line.
- **What it scales.** A conversation only: replies, your messages, the tool rows (verb, target, result, a group's line, the verb's column), thoughts, author lines, code blocks, diffs and terminal output, on the session log, the phone transcript and the Chat page. Not the chrome: the sidebar, headers, the composer, the time gutter, the turn's actions (Copy, Retry), notices and cards, Settings and every other page.
- **How (web).** One variable: `--text-scale` on `<html>`, set from the choice at once (`applyTheme`) and before first paint (`public/theme.js`), so it changes live with no reload. A conversation's scroller carries `.log-text`, which sets `--read-size: calc(var(--read-base) * var(--text-scale))` and `--log-scale`. `.md`, `t-chat`, `t-code`, the Fold and code blocks multiply by `--log-scale`, which is unset (1) outside a conversation, so the same pieces elsewhere (a skill's page, a file viewer) stay as they are. Other text in a conversation uses `tx-N` (N px times the scale, `tx-13.5 phone:tx-15`) in place of `text-[Npx]`: use it for any new row in the log. The field that edits your message on the Chat page stays at least 16px on a phone, so iOS does not zoom.
- **How (Android).** `ConclaveTheme` provides the choice (`LocalTextSize`); the session's and the chat's lists draw under `chatDensity()`, the phone's density with its font scale times the size. Every sp in the transcript scales and no dp does, on top of the phone's own font size, and the composer and the screen around stay as they are.
- Tested in `test/text-size.test.tsx` (the stored value, the variable, `theme.js`, the stylesheet, the row) and `client/.../TextSizeTest.kt`.

### 6.6 Sources

- WCAG 2.2, 1.4.3 Contrast (Minimum) and 1.4.6 Contrast (Enhanced): 4.5:1 and 7:1 for body text. https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
- WCAG 2.2, 1.4.8 Visual Presentation (AAA): at most 80 characters a line, line spacing at least 1.5 within paragraphs, paragraph spacing at least 1.5 times the line spacing. https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation
- WCAG 2.2, 1.4.11 Non-text Contrast: 3:1 for what identifies a control or its state. https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast
- Baymard Institute, line length: 50 to 75 characters for body text. https://baymard.com/blog/line-length-readability
- Apple Human Interface Guidelines, Typography: body text 17pt default on iOS and 13pt on macOS, larger for long reading and thin weights. https://developer.apple.com/design/human-interface-guidelines/typography
- Material Design 3, type scale: body large 16 on a 24 line (1.5). https://m3.material.io/styles/typography/type-scale-tokens
- Tailwind Typography (`prose`), a common default for long text on the web: 16px on 1.75 with paragraphs 1.25em apart and a 65ch measure. https://github.com/tailwindlabs/tailwindcss-typography
- Claude.ai and ChatGPT, looked at in use (they publish no type spec): replies in plain text at about 16px in one column, no box; your message in a filled, rounded bubble at the right; tool use as a short row that opens. We follow the shape, not their marks or colors. Claude's desktop and Android apps, looked at again for 6.5: replies at about 15px on a desktop and 16sp on Android.
