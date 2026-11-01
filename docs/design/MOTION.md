# Motion

Status: plan for the build, updated after the motion lab round. Owner: design. This file is the motion plan for the whole app, web and Android. `CHAT-AND-MOTION.md` section 1 defines the primitives that exist (the Knot, Ink, the Rim, Steps, Fold, Roll, Send to stop, the gap list, card to panel, the toast stack, `LiveStatus`, `Shimmer`, `Swap`) and wins for them; this file is the plan for everything else. Section 9 lists changes to other docs. Everything else still holds: rules not boxes, color means one thing, violet only for live work, no pills, no gradients, no glow.

Paths are relative to `packages/web/src` unless they start with `packages/` or `docs/`.

Prototypes: `docs/design/motion-lab/*.html` (plain JS and canvas, no build step), listed in `docs/design/motion-lab/CATALOG.md`. Open any frame with `?solo=<id>&t=<ms>`. The built primitives are at `/dev/motion`.

---

## 0. In short

The owner wants more motion, especially for thinking, and wants it to feel like Claude without looking like every other AI product. The research says the same thing three ways: the products people trust tie every moving thing to a real signal, they spend motion on rare and live moments, and they say plainly when nothing is happening. The products people complain about rotate jokes, fake progress, glow, and animate the things you use a hundred times a day.

So this plan does three things:

1. **The Knot is the thinking motion.** One violet stroke writes a trefoil over a faint guide, with real over and under crossings, holds, then lets go from the tail. The owner picked it in the motion lab and rejected anything made of dots for thinking, so Step, Bench and the dot `ThinkingMark` are gone.
2. **A family from the same stroke**: a tool closes the knot and runs a light along it, waiting freezes the frame in amber, a limit draws back to a grey stub, done settles into the whole knot in grey, failed stops in the fault color. Ten more motions from the lab carry the rest (3.4).
3. **A catalog of motions and removals** across the app, with priorities: the command palette and menus stop animating on open, reduced motion keeps short fades, sheets get a curve that fits their distance.

---

## 1. Principles

1. **Motion reads real work.** Every live motion has a signal behind it: tokens arriving, a tool's clock, a countdown with a known end. When the signal stops, the motion says so. No fake progress, no time ladders ("almost done"), no rotating words.
2. **Spend motion where it is rare.** Actions people repeat all day (the palette, menus, keyboard moves, tabs) get no motion or an exit only. Live work and first-time moments get the budget.
3. **One vocabulary: one stroke and one light.** The Knot says what the model is doing, the Rim says it on the composer edge, Ink brings in new text. Dots never say the model is working; the dot wave stays only as brand art (3.5). Nothing glows, bounces or flies free.
4. **Words in fixed places.** A state change is a crossfade in a cell that already has its size. Layout moves only when content arrives, never because a state changed.
5. **Quiet and quick.** UI travels 4px at most and settles in 120 to 240ms. Loops are 1.2 to 3s with rests. Exits are faster than entrances.
6. **Still when asked, never dead.** Reduced motion stops movement and loops, keeps short fades and color changes, and counters still tick.

---

## 2. Tokens

`styles/motion.css` and `index.css` on the web, `ui/motion/Motion.kt` on Android. Values in **bold** are new or changed.

| Token | Today (`CHAT-AND-MOTION.md` 1.2) | This plan | Why |
|---|---|---|---|
| `--dur-0` | 80ms | 80ms | Press feedback. Emil Kowalski puts button press at 100 to 160ms; ours is a color change, so shorter is right. |
| `--dur-1` | 120ms | 120ms | Hover, swaps, exits. Matches Material short3 (150ms) and Rauno's 200ms ceiling for interaction. |
| `--dur-2` | 180ms | 180ms | Entrances, menus closing, toasts. Inside Emil's 150 to 250ms for dropdowns. |
| `--dur-3` | 240ms | 240ms | Panels, state words, verdict rule, digit roll. |
| `--dur-4` | 360ms | 360ms | A live mark coasting to its still pose. |
| `--dur-sheet` | none (sheets use 180ms) | **320ms open, 200ms close** | A sheet travels up to 88vh. Vaul uses 500ms and Material puts full-screen moves at 400 to 500ms; 180ms reads as a jump on tall phones. 320ms keeps it under the 400ms where people start to wait. |
| `--dur-flash` | none | **700ms** | Neutral "here it went" flash after a reorder or arrival (Atlassian Pragmatic drag and drop). Color only. |
| `--ease` | `cubic-bezier(.2,.7,.2,1)` | keep | Starts fast and settles. Close to Material emphasized decelerate `(.05,.7,.1,1)` and Emil's ease-out `(.23,1,.32,1)`. |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | keep | Exits. Material standard accelerate is `(.3,0,1,1)`; same feel. |
| `--ease-sine` | `cubic-bezier(.37,0,.63,1)` | keep | Loops and the breath. |
| `--ease-morph`, `--ease-emph`, `--ease-std` | none | **`(.6,0,.25,1)`, `(.2,0,0,1)`, `(.4,0,.2,1)`** | The Knot's write and release; a card growing into a panel; a panel shrinking back and a fold reopening. From the lab. |
| `--ease-drawer` | none | **`cubic-bezier(.32,.72,0,1)`** | Sheets. The iOS sheet curve, used by Vaul. |
| `--loop-think` | 1800ms, continuous | **replaced by `--loop-knot` 3000ms** (write 1300, hold 200, let go 1350, rest 150) | The lab's Knot. It rests every loop. |
| `--loop-work` | 1200ms | **replaced by `--loop-knot-tool` 2000ms** for tools and writing | One lap of the light along the knot. Ink shows the stream's real pace. |
| `--loop-rim`, `--loop-breath` | none | **4000ms; 4375ms** (in 1600, out 2200, rest 575) | The Rim's lap and the amber breath while waiting. |
| `--loop-shimmer` | 2200ms | 2200ms, **phase-locked to one clock**; a new label waits **600ms** before its first pass | Codex times every shimmer from one start, so all live labels pass together; it also holds 600ms before a new heading shimmers. |
| `--rise` | 4px | 4px | Matches Atlassian's 4px fade-in travel. Material's 30dp shared axis is too loud for a console. |
| `--stagger` | 40ms, at most 5 items | keep | Streamdown uses 40ms per word. Atlassian's log stagger is the option if a list ever needs more than five. |
| `--stall` | none | **10s** without a text delta | Claude Code's threshold before the glyph turns red. |
| `--late-timer` | none (elapsed shows at once) | **3s** | Short replies never flash a timer. Claude Code waits 16s; 3s suits chat, where most replies start in under 3s. |
| `--stream-step` | 60ms and 150ms (StreamReveal tiers) | **replaced by Ink: `--stream-word` 40ms, `--stream-lag` 320ms**; letters cool from violet to ink over 330ms | Streamdown's numbers. Even pacing hides chunky providers without a hidden queue. |
| Reduced motion | every animation and transition 0.001ms | **movement and loops stop; opacity and color transitions stay at 120ms** | Apple HIG and Emil: reduced motion is fewer, gentler animations, not none. A fade still tells you a panel opened. |
| Springs | none | **web: one, `--spring`** (response 420ms, damping 1, compiled to `linear()`, `--dur-spring` 620ms) for list gaps and the toast stack. **Android: critically damped only** (`dampingRatio = 1`, `MotionScheme.standard()`) | Damping 1 never overshoots, so it stays inside "no bounce". Never `MotionScheme.expressive()` (damping 0.6 visibly bounces). |

---

## 3. The signature: the Knot and its family

### 3.1 Why the Knot

The lab tried seven shapes and four families of motion, none made of dots (`motion-lab/CATALOG.md`). The owner picked the Knot. It is one stroke, so it is calm and cheap; its over and under crossings read at 16px; it rests every loop; and it does not look like any AI product's mark. Step, Bench, Weigh and Trace (the dot candidates in the first lab) are dropped. Septa, the lab's first pick, is not built.

### 3.2 The Knot, exactly

The drawing rules, the timing and the state rules with exact numbers are in `CHAT-AND-MOTION.md` 1.7, for web and Android alike. Since October 2026 the Knot is the brand mark itself, the knot with a light (`docs/design/brand/README.md`): the geometry is `docs/design/brand/knot.json`, the code `components/motion/knotMath.ts` and `components/brand/KnotSvg.tsx`, tested in `packages/web/test/knot.test.ts`.

### 3.3 The family

One stroke, one look per state (`CHAT-AND-MOTION.md` 1.3 has the full table):

| State | The Knot | Reduced motion |
|---|---|---|
| **Thinking** | Writes the trefoil, holds, lets go from the tail. 3s | Holds 90% of the knot in violet |
| **Tool running, writing** | Closes into the whole knot, dims, a short light runs along it, 2s a lap | The dimmed knot, the light resting on one lobe |
| **Waiting on you** | Freezes the exact frame in amber; resumes from it | The hold pose in amber |
| **Resuming after a limit** | Draws back to a grey stub; the countdown rolls (Roll); at zero it writes on from the stub | A grey stub |
| **Done, stopped** | Closes into the whole knot in fg-3, then still | The whole knot in fg-3 |
| **Failed** | Stops and turns the fault color; Retry next to it | The hold pose in fault |
| **Stalled** (not built yet) | When built: freeze like waiting, in fg-3, with "No output for 14s" | Same |

Rules that hold for the whole family:
- At most one animated Knot per reply. Headers and list rows never animate it; they show words and elapsed time.
- Every state change blends from the frame on screen, never a jump, never a layout change.
- The words name the work literally: the tool verb, the model's own note, or "Thinking". Never random verbs, never jokes, never a ladder of reassurances.

### 3.4 The ten motions

The owner picked these from the lab (Rim, Breath, Settle and Fault count as one light), as the curator described them in `CATALOG.md`. Each is built in `components/motion` (or `components/ui/Toast.tsx`) and specified in `CHAT-AND-MOTION.md` 1.3 and 1.4.

1. **Ink** (type-07): streamed text is revealed by a soft front along each line, newest letters violet, cooling to ink. Nothing moves or reflows. Words 40ms apart, never more than 320ms behind the stream.
2. **Rim, Breath, Settle, Fault** (light 01, 08, 10, 11): one thin light on the composer edge: live (travels), waiting on you (amber breath), done (settles), failed (a red mark).
3. **Steps** (type-11): the status line swaps tool verbs cleanly; the old one leaves before the new one arrives.
4. **Fold** (type-09): "Thought for Ns" folds closed in the same frame the answer starts, and opens to show the reasoning.
5. **Roll** (type-10): one number component for tokens, cost, countdowns and counts; only changed digits roll, in the direction of change.
6. **Send to stop**: the send button folds into a stop square while a reply runs, and back.
7. **Approve and close the gap**: an approval resolves, its label swaps, the card slides away and the list closes the gap without a jump.
8. **Card to panel**: a card grows into its full panel (container transform), for previews and routine detail.
9. **Toast stack**: toasts stack, fan out on hover, restack; saved, copied and undo all land there.

With the Knot itself, that is the plan for this round. Next in line (from `CATALOG.md`): Limit countdown or Dial, Lens for search, Lantern for memory recalled, Memory saved, Jury verdict, Relay or Model handoff, Dawn for routines, Onboarding steps, Sync for pairing, Open a chat.

### 3.5 Dots: where the wave stays and where it goes

- **Gone:** the dot `ThinkingMark` (it is now the Knot), the packet across the seats, the flatline, the seat clock.
- **Gone too:** `LiveStrip`, `LiveIndicator` and the strip under the session live line, everywhere they said work was running (the session live line, tool rows, running rows on Home, jury rows, provider and MCP tests, pairing, the hook test runner, routines, memory, settings, onboarding, Usage refresh, the boot splash). In their place: `LiveStatus`, the Knot at 14px with the words and the time in a Roll. In rows of a list the Knot is drawn still (`still`). `Elapsed` moved to `components/motion` and rolls its digits.
- **Stays, as brand art only, never for live work:** the still logo (`Mark`), the wave hero on onboarding, Connect and the Done step, and the ambient band in `EmptyState` (drift once, then hold, X6).

---

## 4. Catalog

62 motions and 7 removals. P0 must ship with the motion pass, P1 should, P2 is nice to have. "Now": exists, partly, new, change (exists but changes). Times are duration then easing. "RM" is the reduced-motion fallback.

After the lab round: rows that move the dot mark or a dot field (C1, C2, C11, C12, C13, M2 to M8, A1, H2, H3, R1, ME1, ME3, ME4, D1, E1, O1 to O3, F4) are drawn with the Knot, the Rim, Ink or Roll when they are built (3.5). C4 is Ink, C5 and C6 are Fold, C8 is Roll, A2 is the gap list. The rest stands.

### 4.1 Chat and sessions

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| C1 | Chat reply first line, session live line | Request sent; thinking deltas | The Knot thinking (3.2). If the first token lands within 400ms the word "Thinking" never shows | 3s loop, `--ease-morph` | The hold pose in violet | P0 | done |
| C2 | Reply foot, session live mark | Text deltas | The packet's clock follows smoothed tok/s (3.3), so it slows and stops with the stream | 1.2s pass at 30 tok/s, 0 to 1.6 times | Still mark | P0 | change |
| C3 | Writing reply or turn | 10s with no text delta | Crest cools to fg-3 over 10s; "No output for 14s" counts in fg-3; at 60s amber "Not responding" with Retry and Switch model | Color 10s linear; words `Swap` 120ms | Words only | P0 | new |
| C4 | Chat and session text, web and Android | `message.delta` | Deltas are re-chunked into words and released 40ms apart, never more than 320ms behind (no delay in a hidden tab). Each word comes up in three steps: 30%, 66%, 100% (Highlight API on the web, `graphicsLayer { alpha }` per span on Android) | 60ms, 150ms | Text lands as it arrives | P0 | partly |
| C5 | Chat thinking row while thinking streams | Thinking deltas | The last three lines of the thought in a fixed 60px well, stepped by age: newest fg-2, middle fg-3, oldest fg-3 at 55%. A new line pushes in; nothing fades | None (content steps) | Same | P1 | new |
| C6 | Chat thinking row | First text delta | The live row crossfades to "Thought for 4s ›" in the same cell; the well goes in the same frame the first words appear, so nothing you read moves. (AI Elements waits 1s, which moves text already on screen) | 120ms `--ease` | Instant | P0 | new |
| C7 | `LiveStatus` words and detail | A progress note or summary heading arrives; any Shimmer mounts | The model's own note swaps in and gets one Shimmer pass 600ms after it lands. Every Shimmer takes its phase from one clock (`animation-delay: -(now % 2200)ms`), so all live labels pass together. The model name and the timer sit outside the shimmering span | `Swap` 120ms; 2.2s pass, 45ms per letter | Plain text | P1 | partly |
| C8 | Elapsed, tok/s, token counts, the handoff summary count | Live state passes 3s; usage numbers change | Elapsed fades in after 3s, then ticks once a second. Counts chase the real value: +3 per tick under a gap of 70, `max(8, 15%)` under 200, half the gap beyond. Never "0 tokens" before the first token | 120ms fade; 50ms ticks on the shared clock | Jump to value | P0 | change |
| C9 | Tool rows (chat and sessions) | Input starts streaming; started; completed | Row appears as soon as input streams (verb in fg-3); on start the verb gets the Shimmer; on completion present tense swaps to past tense with a count: "Searching the web" to "Searched the web, 3 results" | Row `anim-fade` 180ms; `Swap` 120ms | Instant swap | P0 | partly |
| C10 | Edit and Write diffs in sessions | A diff lands on screen | A 1px signal scan rule moves down, fast through context, slow on hunks; 300ms hold at the top, 250ms at the end; changed lines go 30% to 100% as it passes (Cline paces its sweep the same way). Skip over 300 lines or when offscreen | At most 900ms | None | P2 | new |
| C11 | Composer, reply, transcript | Send; Retry; scrolled up while content arrives | Your message rises 4px and Send swaps to Stop; Retry fades the old reply and the mark takes its first line; "Jump to latest" rises 4px | 180ms `--ease`; `Swap` 120ms; 120ms `--ease-in` | Fades | P0 | exists |
| C12 | Chat reply foot | Turn ends | The mark coasts to still, holds, then crossfades with the action row in the same 20px slot | 360ms; 240ms hold; 180ms | Instant swap | P1 | new |
| C13 | Every `LiveStrip` (session live line, Home rows, tests) | Strip starts; run ends | Ignition: the trace enters from the left edge and its amplitude ramps 0 to 1. End: the Bayer threshold rises right to left so dots drop out in the ordered pattern, leaving a dim hairline; then "Worked for 3m 12s, 14:08" fades in | 600ms ease out; 360ms in 4 steps; 120ms | Still frame; end frame | P1 | change (holds 600ms today) |

### 4.2 Multi-model modes

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| M1 | Every action that starts model work: Ask another model, Jury, Debate, Hand off, Routine Run now, provider Test | Click | The `LiveStatus` Thinking line appears on click, before the server answers; a failure replaces it in place | `anim-fade` 180ms; `Swap` 120ms | Appears | P0 | new |
| M2 | Jury verdict head | Jurors running | The mark is the bench: judge in the crest seat, jurors in seats 0, 2, 4, 6 (fewer jurors leave seats empty at fg-4, 55%). A running juror's seat steps 1.3 units on the beat; a finished one settles at full fg | 480ms beat; settle 120ms | Still seats, colors only | P1 | new |
| M3 | Ballot Pick column and head line | A juror finishes | Its strip fades and drops 2px while the pick fades in; its time turns fg-3; "Waiting for 2 of 4 jurors" rolls the digit | `Swap` 120ms; roll 240ms | Instant | P0 | partly |
| M4 | Verdict head | Judging | The violet crest visits juror seats in the order they finished; "Judging" with Shimmer and elapsed | 300ms per visit | Still mark | P1 | new |
| M5 | Verdict block | Judge done | A 2px fg rule draws left to right (`scaleX`), "Verdict" fades in, the sentence arrives by ordered dissolve (4 by 4 Bayer mask, 4 steps of 60ms), the tally 240ms later; dissenting picks go fg-3 | 240ms `--ease`; 120ms; 240ms | Fades only | P0 | new |
| M6 | Handoff notice | A handoff while you watch | The summary count rolls up (C8). A 3 by 3 block of signal dots crosses a dotted wire from the old model's name to the new one; the names trade brightness; the notice fades in; the composer model swaps down-up; the new model's mark starts thinking in the same place | 400ms + 100ms per 1K tokens, at most 1200ms, `--ease`; 240ms; `Swap` 120ms | Notice only | P1 | new |
| M7 | Second opinion aside | Reviewer runs; Continue with it | The mark mirrored top to bottom (y becomes 18 - y) runs Step at the aside's foot. On "Continue with GPT-5.5" each dot moves straight to its upright seat | 360ms `--ease` | Mirrored still mark | P2 | new |
| M8 | Debate | The turn passes; debate ends | The live mark moves from one speaker's line to the next as one shared element. At the end a duet strip of two traces settles its phase gap to the judge's agreement score and stays as the record | 240ms `--ease`; 900ms | Final frame | P2 | new |

### 4.3 Approvals and inbox

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| A1 | Session mark and strip | Approval or question opens | Freeze in place, amber crest on the highest seat; the strip drops one level; continue from the same frame on answer | 240ms level change; resume within 120ms | Amber still mark | P0 | change (switches to the still pose today) |
| A2 | Inbox cards, Home "Waiting on you", phone cards | Allow or Deny | The label swaps to "Allowed once" or "Denied" and holds 400ms; the card fades; the rows below slide up into the gap (FLIP, transform only). Keyboard A, S, D skips the hold | `Swap` 120ms; fade 120ms `--ease-in`; slide 200ms `--ease` | Fade, rows jump | P0 | new (rows jump today) |
| A3 | Inbox list, Home | An approval arrives after first load; time passes | The row rises 4px, for arrivals only (`useArrivals`). "Waiting 4 min" ticks once a minute | 180ms `--ease` | Fade | P0 | partly |

### 4.4 Home

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| H1 | Home scope | Output in the last minute | The live ripple at the right edge, and the sweep **only while something is live**; idle shows "Idle since 13:12" over a still scope | 30fps canvas | t = 6 frame | P1 | change (sweep always runs) |
| H2 | Running rows | Live | Elapsed in signal, the 64 by 12 strip | 1s ticks; 30fps | Still strip | P0 | exists |
| H3 | Running rows | A run ends | The strip ends (C13); the row stays 2s with "done in 3m 12s", then fades and the rows below close the gap | 120ms fade; 200ms slide | Fade, jump | P1 | new |
| H4 | Limits (Home and Usage) | Percent changes | Gauge segments switch one at a time from the old edge to the new, 10ms apart (at most 240ms); a threshold crossing recolors the fill 120ms after the ticks land. Never on page load | 10ms per segment; 120ms | Instant | P1 | new |

### 4.5 Tasks

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| T1 | Task rows, session plan block | A step completes | The type changes: a strike draws left to right (`clip-path`), color goes to fg-3, the check swaps in | Strike 180ms; color 240ms; `Swap` 120ms | Color only | P1 | new |
| T2 | `LiveStatus` words | The running task changes | The words become the running task's present tense ("Running bun test"); a "Next:" line in fg-3 names the following task | `Swap` 120ms | Instant | P1 | new |

### 4.6 Routines

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| R1 | Routine row and detail | The schedule fires | "in 2m" swaps to violet elapsed at the fire minute; the detail strip ignites (C13) | `Swap` 120ms; 600ms | Swap | P1 | new |
| R2 | Routine "next run", limit "resets in" lines | Time passes | Tick once a minute; once a second in the last minute; tabular, fg-3 | | Same | P1 | partly |

### 4.7 Memory

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| ME1 | MemorySearch tool row strip | Running | Stored notes are fixed fg-3 dots on a stable grain; a one-column read head in signal sweeps left to right | 90 to 120ms per column | Still strip | P1 | new |
| ME2 | Same | Done | The head stops; the columns for the notes it found stay at full fg; the label swaps to "Checked memory, 2 notes" | `Swap` 120ms | Final frame | P1 | new |
| ME3 | MemorySave tool row | Saved | A 5-column block fills in Bayer order (4 steps of 60ms), holds signal 1.2s, settles to fg. Then the quote's left rule draws top to bottom, the fact fades in, Undo and Edit fade in | 240ms; 1.2s; rule 240ms `--ease`; 120ms | Final state | P0 | new |
| ME4 | Memory rows | Undo; retire a note | Undo: the rule retracts and the row closes its gap. Retire: a strike draws left to right and the block empties in reverse Bayer order | 120ms, 200ms slide; 180ms, 240ms | Instant | P1 | new |

### 4.8 Usage

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| U1 | Usage charts | First view; range change or refresh | First view only: bars reveal from the baseline with `clip-path` (8ms per bar, at most 160ms of stagger), lines reveal left to right. After that values morph in place with no re-entrance. The box keeps one height in every state (loading, empty, error, data). Turn off library defaults (Recharts draws lines over 1500ms) | Bars 240ms; lines 480ms; morph 240ms; `--ease` | Still chart | P1 | change |

### 4.9 Devices

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| D1 | Pair dialog, Android pairing screen, Devices table | Waiting; answered; paired | A 5 by 5 dot glyph from SHA-256 of the pairing code on both screens. Waiting: the device side's cells turn over one every 60ms in signal. Answered: they settle to the code's pattern in Bayer order and turn fg; the owner checks the two glyphs match. Then "Paired arch-desktop." swaps in and the new row gets the neutral flash | 60ms steps; settle 320ms; flash 700ms | Final glyph, "Check that both glyphs match" | P1 | new |

### 4.10 Extensions

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| E1 | MCP connect, provider key test, hook test runner | Test runs; passes; fails | The strip ignites (C13), the result word swaps in. A failure is a flatline: the trace drains to a flat row of dim dots with one red dot where the packet was | 600ms; `Swap` 120ms; 360ms `--ease-in` | Words, final frame | P1 | partly |

### 4.11 Settings

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| S1 | Theme toggle (⌘. and Appearance) | Switch | No transition storm: `transition: none` on the root for one frame around the swap. Optional crossfade on pointer toggles only | 180ms | Instant | P1 | new |
| S2 | Save buttons | Save | The label stays; "Saving…" after 200ms; a still check for 1.5s on success | `Swap` 120ms | Swap | P1 | partly |

### 4.12 Onboarding

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| O1 | Boot splash | Every cold start | The launch: a straight rope ties itself, then fades into the app or flies into the hero mark; the knot runs if the hub is still not reached (KNOT-MOTION.md) | 3.1s, a tap skips | The tied knot at rest | P1 | done |
| O2 | Step rail hero band, Done step | A step completes | Assembly: one seat of the mark condenses out of the hero field (dots never fly, light gathers); the crest seat condenses last, on Done, and the summary lines arrive by ordered dissolve | 600ms `--ease-sine`; 240ms each | Frame for the current step | P2 | new |
| O3 | Step content column | Next step | Old content fades out, new fades in with a 4px rise; the rail's current bar slides | 90ms out; 180ms in | Fades | P1 | partly |

### 4.13 Navigation and overlays

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| N1 | Command palette | ⌘K | **Opens and closes with no animation**; results replace in place. Raycast's window has none; nothing used 100 times a day animates | 0ms | Same | P0 | change (`anim-rise` today) |
| N2 | Menus, `SelectMenu` | Open, close | **Open at once; fade out only** (the macOS context menu pattern) | 0ms in; 120ms `--ease-in` out | Same | P0 | change (drop 4px today) |
| N3 | Bottom sheet (phones) | Open, close, drag | Opens on `--ease-drawer`, closes on `--ease-in`; drag writes `translateY` straight to the sheet; dismiss past 25% of its height or above 0.4px per ms | 320ms open; 200ms close | Fade 120ms | P0 | change (180ms today) |
| N4 | Routes | Navigation by pointer | React 19.3 `ViewTransition`: the old page fades 90ms, the new one fades 150ms with a 4px rise; nav, rail and tab bar have a `view-transition-name` so they never move; `::view-transition-group(*)` at 180ms. Not for G-then-X keys or Back | 90ms, 150ms `--ease` | Fade only | P1 | new |
| N5 | Session and chat lists | Open a row by pointer | The title moves from its row into the page header (shared element); everything else crossfades; the return is faster | 240ms in; 180ms back | Crossfade | P2 | new |
| N6 | Tooltips | Hover | The first one waits 450ms and fades in from 2px; a neighbour within 300ms opens at once with no animation | 120ms `--ease` | Fade | P1 | change |
| N7 | Dialogs, side sheets, preview panel, rail | Open, close | Dialogs fade (no scale); side sheets and the preview come 4px from the right; the chat column and the rail change width in one frame | 180ms in; 120ms out | Fade | P0 | exists |
| N8 | Top nav current bar, phone tab bar, On/Off segmented, Settings index | Pointer selection | One indicator moves between items with `translateX` and `scaleX`, never `left` or `width`; on a segmented control the label color changes fast | 200ms `--ease`; color 67ms | Instant | P2 | new |

### 4.14 Toasts and feedback

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| F1 | Toasts | Add, leave, restack | Move from keyframes to transitions so a burst retargets instead of restarting (Sonner). Enter: 4px rise. Leave: fade with a 4px drop. Others slide to their new slot. The timer pauses on hover and while the tab is hidden. Phones: swipe down past 45px or above 0.11px per ms | 180ms in; 120ms out; 200ms restack | Fades | P1 | change |
| F2 | Copy | Click | The icon swaps to Check, holds 1.5s, swaps back; no toast | `Swap` 120ms | Instant | P0 | exists |
| F3 | Loading buttons, skeletons (first load over 300ms) | Wait | Show after 200ms; once shown, stay at least 400ms; a skeleton mirrors the final layout and content crossfades over it | 120ms | Same | P1 | partly |
| F4 | Browser tab favicon and title | Run state while the tab is hidden | The mark with a violet crest while live, amber and "Waiting on you" in the title when waiting, red on failure, "Done" until focus. One canvas draw per state change, never an animated favicon | | Same | P1 | new |
| F5 | Inbox count (amber), Home status sentence, plan "2 of 5 done", Usage totals | A count changes | Only the changed digit rolls, inside its own clipped cell, up when the value rises and down when it falls. Not on first render or in a hidden tab; elapsed counters never roll | 240ms `--ease` | 120ms crossfade | P1 | new |

### 4.15 Android

| ID | Where | Trigger | What moves | Time, easing | RM | P | Now |
|---|---|---|---|---|---|---|---|
| AN1 | `ui/motion/ThinkingMark.kt` and every place it shows | Live states | The whole family (3.3) on one `Canvas`, `pose(t)` from the shared math, drawn in the draw phase | As web | `areAnimatorsEnabled()` false: still frame | P0 | change (travelling sine today) |
| AN2 | Every `LazyColumn` (sessions, approvals, tasks, memory, routines) | Items added, removed, moved | `Modifier.animateItem()` with stable keys; placement spring at stiffness 400, damping 1; fade in 150ms, out 90ms | Spring; 150ms; 90ms | Jump | P0 | new |
| AN3 | State words and counts | Value changes | `AnimatedContent` with fade only (override the default 0.92 scale-in): out 90ms, in 150ms after it | 90ms; 150ms | Instant | P1 | new |
| AN4 | Navigation (`AppRoot.kt`) | Push, pop | A shared axis X of 4dp with fade, not Material's 30dp | 240ms `--ease` | Fade | P1 | new |
| AN5 | Approval cards | Allow, Deny | As A2, with `animateItem()` closing the gap | As A2 | Fade | P0 | new |

### 4.16 Remove or stop

Motion that tells the user nothing, or costs more than it gives:

| ID | What | Why |
|---|---|---|
| X1 | The command palette's `anim-rise` and the menus' 4px drop on open (N1, N2) | Used many times a day from a key; an exit fade is enough. |
| X2 | The Home scope sweep while nothing runs (H1) | A moving band over an idle chart says something is happening when nothing is. |
| X3 | `anim-fade` on every turn piece when a transcript opens | Only arrivals should enter (`useArrivals`); history should just be there. |
| X4 | Elapsed counters on replies under 3s (C8) | A timer that flashes for one second is noise. |
| X5 | A second animated mark in the same view (for example a header and the live line) | One live mark per view; headers use words. |
| X6 | The ambient band drifting forever in every `EmptyState` | Drift for the first 8s after mount, then hold the frame (PatternFly: play once, then rest). |
| X7 | Rotating or playful status words, and time ladders like "almost done" | Never add them. Claude Code issue #76031 showed "almost done thinking" 20 minutes in. |

---

## 5. Techniques and performance budget

### 5.1 Web

- **What moves:** `transform`, `opacity`, `translate`, canvas, the CSS Custom Highlight API for text color. Never `width`, `height`, `top`, `left`, `margin`, `font`, or `transition: all`.
- **The Knot, the Rim, the send glyph:** small canvases on one shared requestAnimationFrame loop (`motion/frame.ts`). Each is a pure function of its state and clocks (`knotMath.ts`), draws only while it moves, and leaves the loop when still. Waiting freezes the clocks, so going back to work resumes from the same frame.
- **One clock per kind:** waves share one 30fps loop (exists); counters use `useNow` (exists); shimmers take their phase from `performance.now()` (C7). No `setInterval` per component.
- **Lists:** FLIP with WAAPI on top of `usePresenceList` (`GapList`, `useGapClose`): measure, invert, play `translate` on `--spring`. What follows the list rides along (`motion/flip.ts`). Never animate height.
- **Routes:** `ViewTransition` only for updates inside `startTransition`; urgent updates (typing) never animate. Wrap navigations, not keystrokes.
- **Curves:** CSS `cubic-bezier` tokens. If a spring-like curve is ever needed, compile it to `linear()` (Chrome 113, Firefox 112, Safari 17.2) so it still runs on the compositor.
- **Stream:** the word release buffer (C4) runs in the client store, not in components, and it never delays text while the tab is hidden.
- **Pause rules:** every loop stops offscreen (IntersectionObserver) and in hidden tabs (exists for the mark and waves).

Budget per frame, measured on a mid laptop with 4 times CPU slowdown:

| Item | Budget |
|---|---|
| All script for live motion together (stream buffer, counters, strip draws) | 4ms per frame at 60Hz |
| One wave strip draw | under 1ms; the engine widens the dot pitch after three frames over 8ms (exists) |
| Animated marks per view | 1 |
| Animated strips at once | 6 onscreen; the rest draw a still frame |
| Long tasks during a streaming reply | none over 50ms |
| Layout shift during state changes in the live line | 0 |

### 5.2 Android

- Read animated values in the draw phase: `Canvas`, `drawBehind`, `graphicsLayer { alpha; translationY }`, `offset { }`. No recomposition per frame.
- Frame budget: 16ms at 60Hz, 11ms at 90Hz, **8ms at 120Hz**. A frame 1ms late is dropped, not shown late.
- `MotionScheme.standard()` only. Critically damped springs for list placement.
- Reduced motion: `ValueAnimator.areAnimatorsEnabled()` (false with Remove animations and with Battery Saver). With the duration scale at 0, Compose jumps every animation to its end, which matches our still frames.
- `animateContentSize` goes before size modifiers; prefer fixed live line heights so it is rarely needed.

---

## 6. Testing motion

1. **Every motion is a function of time.** That is how the lab is built (`?solo=<id>&t=<ms>` draws any frame), and it is how components are written: state plus time in, pose out. The Knot's curve, loop and state rules, Ink's pacing, Roll's cells, the breath and the spring are pure functions with unit tests (`packages/web/test/knot.test.ts`, `motion-primitives.test.ts`): the loop closes at 3000ms, waiting freezes the frame, done ends on the whole knot, the curve table in the docs matches the code.
2. **Frame sequences (web).** Playwright's clock (`page.clock.install()`) controls `Date`, timers and `requestAnimationFrame`; for CSS and WAAPI animations, pause them with `document.getAnimations()` and set `currentTime`. Capture frames at fixed times per state (for example 0, 120, 240, 480, 1200ms) in dark and light, and compare with goldens.
3. **Frame sequences (Android).** `composeTestRule.mainClock.autoAdvance = false`, then `advanceTimeBy(ms)` or `advanceTimeByFrame()`, then `onRoot().captureToImage()` against goldens.
4. **Video for review.** Playwright `recordVideo` plus ffmpeg (`fps=18`, `palettegen` with `stats_mode=diff`, `paletteuse` with `diff_mode=rectangle`) makes the review GIFs. Note: in this sandbox the screencast ran 8 to 15% longer than wall time, so the recorder maps wall time onto video time (`setpts=(PTS-STARTPTS)/ratio`, ratio = video duration over wall duration). Without that, loops do not close. For exact loops, step the clock and screenshot each frame instead.
5. **Reduced motion.** Run the visual suite twice: `page.emulateMedia({ reducedMotion: 'reduce' })` and `html[data-motion=reduce]`. Assert that no animation is running except opacity and color transitions of 120ms or less (`document.getAnimations()`), that every state still shows its words, and that counters still tick.
6. **Layout stability.** While a turn cycles through all states, a `PerformanceObserver` for `layout-shift` must report nothing inside the transcript.
7. **Performance.** Chrome trace of a 60s streaming reply with 4 times CPU slowdown: no frame over 16ms caused by our code, no long task over 50ms. Android: Macrobenchmark `FrameTimingMetric` on the session screen while streaming, and JankStats in debug builds.
8. **Copy checks.** A lint list for live words: no random verbs, no "almost", no exclamation marks, past tense names a real duration.

---

## 7. Build order

1. Done in the foundation round: the Knot (web), the ten motions as primitives, the tokens, the gallery at `/dev/motion`, the Knot spec for Android.
2. Wire them in: the Knot hero on the empty chat and Home, the Rim and Send to stop on the composer, Steps and Fold in the reply, Roll for counters, the gap list in Inbox and Home, card to panel for routines and previews.
3. Android: the Knot in Compose from `CHAT-AND-MOTION.md` 1.7 and `docs/design/brand/knot.json`, then the same ten.
4. Replace the running `LiveStrip`s (3.5), stall (C3), the late timer (C8).
5. Remove palette and menu entrances (N1, N2), sheet timing (N3).
6. Everything P1, then P2, starting with the next in line in 3.4.

---

## 8. Recommendation for the thinking animation

Decided: **the Knot** (3.1). The earlier recommendation, Step, is withdrawn: the owner rejected anything made of dots for thinking.

---

## 9. Changes to other docs

- `CHAT-AND-MOTION.md` section 1 is rewritten for the Knot and the ten motions (done this round): tokens 1.2, states 1.3, micro-interactions 1.4, reduced motion 1.5, the Knot spec 1.7, the primitives 1.8, placements 1.9.
- `CHAT-AND-MOTION.md` 2.4, 2.5, 2.6: the Knot hero, Send to stop and the Rim on the composer, the Fold for the thinking row (done).
- `SPEC.md` 2 (banned): allow by name the Knot, the Rim and Ink, only for live work. Spinners, pulsing dots and glows stay banned.
- `SPEC.md` 7: sheets 320ms open and 200ms close on `--ease-drawer`; menus open at once; the palette has no animation.

---

## 10. Sources

Primary sources read for this plan (through the research notes in `/tmp/cg/motion-research`):

- Claude Code 2.1.112 `cli.js` (spinner frames, stall color after 10s, token counter catch-up, 16s timer) and `CHANGELOG.md` (layout jitter fixes, tool elapsed counter, reduced motion); issues #76031, #80030, #100280, #52759, #6038.
- OpenAI Codex `codex-rs/tui` (`status_indicator_widget.rs`, `summary_shimmer.rs`, `shimmer.rs`, `motion.rs`): 600ms hold, 1s pass every 4s, one shared shimmer clock.
- Gemini CLI `GeminiSpinner.tsx`, `usePhraseCycler.ts`, issues #9192, #15075.
- Warp `status_bar.rs`, `shimmer_math.rs` (timer outside the shimmer, model names in the live line).
- Zed `thread_view.rs` (thinking block capped and scrolled, 0.3 to 0.7 pulse).
- Vercel Streamdown `animate.ts` (150ms per word, 40ms stagger, 320ms cap), AI SDK `smooth-stream.ts`, AI Elements `reasoning.tsx`, `tool.tsx`.
- Claude API docs, progress updates between tool calls (display "updates").
- Material 3 motion tokens (`@material/web` 2.5.0), Compose `StandardMotionTokens.kt`, `AnimatedContent.kt`, Android vitals render docs, Compose animation testing docs.
- Apple HIG Motion, Accessibility (Reduce Motion), Progress indicators; WWDC23 "Animate with springs".
- Emil Kowalski's design engineering notes, Rauno Freiberg's interface guidelines, Vercel Web Interface Guidelines.
- Sonner 2.0.8, Vaul 1.1.2, Radix Tooltip, AutoAnimate 0.10.0, Atlassian `@atlaskit/motion` and Pragmatic drag and drop, NumberFlow 0.6.2, Motion (`motion-dom` 14.3.0) and its performance tier list.
- React 19.3 `ViewTransition`; Chrome view transitions posts; Chrome's `linear()` article (support versions).
- Identity references: Nothing Glyph Matrix SDK, Teenage Engineering OP-1, Playdate SDK on dither, Lucas Pope on Obra Dinn, Hackaday on Bayer versus error diffusion, PatternFly AI animation guidelines.

From memory or search summaries, not read directly: claude.ai's web spinner and voice mode, ChatGPT's pulsing dot, Grok's live thought box, Arc Search loading, Cursor's inline diff detail, Things 3 completion, Linear's J and K behaviour.
