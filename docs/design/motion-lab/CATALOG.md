# Conclave motion lab 2: catalog

Four families, 66 prototypes, 115 GIFs. None of them is built from dots.
I opened frames of every GIF. I also checked every loop seam and looked for one-frame flickers with a script.
Fixes are listed per item and again at the end.

Sheets (one GIF per family, plus top picks). Each cell plays whole loops of its own GIF, so every sheet loop closes.
Where a cell's loop does not fit the sheet loop, it plays up to 10% faster or slower, or its longest rest is held a little longer.

| Sheet | Path | Size |
|---|---|---|
| Top picks, thinking (dark) | /tmp/cg/motion-lab2/sheets/top-picks-thinking.gif | 2.9 MB |
| Top picks, thinking (light, extra) | /tmp/cg/motion-lab2/sheets/top-picks-thinking-light.gif | 2.8 MB |
| Shapes | /tmp/cg/motion-lab2/sheets/shapes-sheet.gif | 2.9 MB |
| Type | /tmp/cg/motion-lab2/sheets/type-sheet.gif | 1.7 MB |
| Light | /tmp/cg/motion-lab2/sheets/light-sheet.gif | 2.8 MB |
| UI | /tmp/cg/motion-lab2/sheets/ui-sheet.gif | 2.9 MB |

The sheet builder is /tmp/cg/motion-lab2/sheets/tools/sheet.py. The specs are in /tmp/cg/motion-lab2/sheets/specs.

Status words used below:
- **Top pick**: in the top picks sheet.
- **Keep**: good, worth building.
- **Fixed**: I changed the source and re-recorded it.
- **Flag**: works, but has a risk I would not ship as is.
- **Dropped**: do not build.

---

## Top picks: thinking

| # | Name | Family | GIF (dark) | GIF (light) |
|---|---|---|---|---|
| 1 | Septa | Shapes | gifs (not in the repo): septa-dark.gif | gifs (not in the repo): septa-light.gif |
| 2 | Knot | Shapes | gifs (not in the repo): knot-dark.gif | gifs (not in the repo): knot-light.gif |
| 3 | Flex | Type | gifs (not in the repo): type-05-flex.gif | gifs (not in the repo): type-05-flex-light.gif |
| 4 | Sheen | Type | gifs (not in the repo): type-01-sheen.gif | gifs (not in the repo): type-01-sheen-light.gif |
| 5 | Rim | Light | gifs (not in the repo): 01-rim-dark.gif | gifs (not in the repo): 01-rim-light.gif |
| 6 | Harmonic | Shapes | gifs (not in the repo): harmonic-dark.gif | gifs (not in the repo): harmonic-light.gif |

---

## Shapes

Page: /tmp/cg/motion-lab2/shapes/index.html. GIFs: /tmp/cg/motion-lab2/shapes/gifs.

| Name | Purpose | What moves | GIF | Status |
|---|---|---|---|---|
| Septa | Thinking | A seven-sided outline turns into a star, then a circle, then back. It turns one seventh per loop and rests 300ms between shapes. | septa-dark.gif, septa-light.gif | Top pick |
| Knot | Thinking | One stroke writes a trefoil over a faint guide, with real over and under crossings. It holds, then lets go from the tail. | knot-dark.gif, knot-light.gif | Top pick |
| Spoke | Thinking | Seven tapered arms of uneven length grow one after another and hold. Then they pull into a small asterisk while the mark turns one seventh. | spoke-dark.gif, spoke-light.gif | Flag: uneven rays around a center read close to the Claude spark. |
| Gimbal | Thinking | Three nested rings start as a still target, open out, turn on their own axes and close. The back halves are dimmer. | gimbal-dark.gif, gimbal-light.gif | Flag: mid-spin it looks like an atom or the React logo. |
| Fold | Thinking | A square sheet folds toward you in half, then in half again, then opens. It is lit by face and its underside is violet. | fold-dark.gif, fold-light.gif | Keep. At 16px it is just a small triangle. |
| Harmonic | Thinking | A pen traces a 3 to 2 Lissajous figure with a fading tail over a hairline guide. Its phase drifts, so the figure slowly turns. | harmonic-dark.gif, harmonic-light.gif | Top pick |
| Tumble | Thinking | A cube turns a quarter turn per 500ms beat, on X then Y, and rests. One violet face shows the turn. | tumble-dark.gif, tumble-light.gif | Keep. A turning cube is a common loader. |
| Septa turn | One reply: thinking, a tool, waiting on you, done | Septa thinks. For the tool it holds a dim heptagon while light runs round the outline. Waiting freezes it in amber mid-morph, and it resumes from the same pose. Done settles to a grey heptagon. | septa-turn.gif | Fixed: status words now swap one after the other. |
| Septa fault | Failed, then retry | Mid-morph the outline presses flat onto the midline and turns red, with one Retry. Retry lifts it back into the violet heptagon. | septa-fault.gif | Fixed: same word swap. |
| Lens | Searching the web | A lens ring glides over four results and rests on each. Inside it the lines are larger and bright. A violet rule marks each result read. | lens.gif | Keep |
| Mesh | Running a tool | Two gear outlines turn one tooth per beat: a soft start, a firm stop, a rest. The driven gear is violet. | mesh.gif | Keep. I checked the teeth never overlap. Gears are a stock icon, so it is not a lead piece. |
| Dial | Limit reached, countdown to resume | A ring of 60 ticks holds the wait. Each second a run of ticks goes out and the digit rolls. At zero the ring fills violet and Septa starts thinking. The GIF squeezes the wait into 6 seconds. | dial.gif | Fixed: word swap. |
| Jury | Several models answer, a judge decides | Three juror shapes turn while they work and stop when done. Each answer travels up its wire. The judge reads each wire, then draws one violet line to its pick. | jury.gif | Fixed: the footer showed two lines on top of each other for one frame. |
| Relay | Handoff to another model | The mark packs into a circle and flies along a dashed route to the other model. There it opens into the heptagon, and the names trade brightness. | relay.gif | Fixed: word swap. |
| Septa, reply line | Septa in context | A 16px Septa next to "Thinking" at the head of a reply. | ctx-inline-septa.gif | Keep |
| Knot, reply line | Knot in context | The same reply line with Knot. | ctx-inline-knot.gif | Keep |
| Septa, hero | Empty chat page | A 112px Septa above "Good evening, Kai." In the product it should play a few loops, then hold (MOTION.md X6). | ctx-hero-septa.gif | Keep |
| Knot, hero | Empty chat page | The same page with Knot. | ctx-hero-knot.gif | Keep |

## Type

Page: /tmp/cg/motion-lab2/type/index.html. GIFs: /tmp/cg/motion-lab2/type/gifs.

| Name | Purpose | What moves | GIF | Status |
|---|---|---|---|---|
| Sheen | The live "Thinking" word | A soft band of light crosses the word in 1.5s with a short violet trail, then rests 1s. In light theme it is an ink sweep. | type-01-sheen.gif, type-01-sheen-light.gif | Top pick |
| Decode | A live word arriving | Letters cycle through dim stand-ins of the same width, then land with a small drop and a flash. Two quiet re-reads follow, then it scrambles out. | type-02-decode.gif, type-02-decode-light.gif | Flag: a scramble is a common AI trope, and mid frames read as typos ("Painking"). |
| Caret | Thinking with the model's own note | A violet caret types "Thinking", gliding on a damped spring. It fades softly while it waits, then drops a line and types the note. | type-03-caret.gif, type-03-caret-light.gif | Keep. Strong second choice for the word. |
| Wave | The live "Thinking" word | A crest of light and 2.5px of lift runs through the letters, with a small dip behind it, then rests. | type-04-wave.gif, type-04-wave-light.gif | Flag: the lifted letters read as a broken baseline. |
| Flex | The live "Thinking" word | A pulse of weight runs through the letters on Mona Sans' weight and width axes. Each letter keeps its place, so nothing reflows. | type-05-flex.gif, type-05-flex-light.gif | Top pick |
| Focus | Streaming reply text | Each word comes up from a 5px blur to sharp. Words are released 42ms apart. | type-06-focus.gif | Keep. Blur per word costs more, and many products already do it. |
| Ink | Streaming reply text | A soft-edged mask wipes along each line as words arrive. The newest letters carry a violet tint that cools to ink just behind the front. | type-07-ink.gif | Keep. My pick for streaming. |
| Rise | Streaming reply text | Each word rises 5px as it fades in. Fresh words start grey and settle to full ink over 0.6s. | type-08-rise.gif | Keep. It moves words, and MOTION.md keeps words in fixed places. |
| Fold | The "Thought for 6s" row | "Thinking" turns into "Thought for 6s", keeping "Th". The reasoning folds up as the answer arrives. A click opens it again: the rule draws down and the lines come in top first. | type-09-fold.gif | Keep. The reopen covers most of its height in the first frame; ease it a little in the build. |
| Roll | Tokens, cost and the limit countdown | Only changed digits roll, each in a clipped cell. Lower digits move first. Up when the value rises, down when it falls. | type-10-roll.gif | Keep |
| Steps | The live status line | The old step lifts 4px and blurs out in 150ms. The next comes up a word at a time with its own stroke icon. Its verb gets one pass of light 0.6s after it lands. | type-11-steps.gif | Keep |

## Light

Page: /tmp/cg/motion-lab2/light/index.html. GIFs: /tmp/cg/motion-lab2/light/gifs. Each has a `-dark.gif` and a `-light.gif`.

| Name | Purpose | What moves | GIF | Status |
|---|---|---|---|---|
| Rim | Thinking, on the composer | A thin violet light with a fading tail runs once around the composer border every 4s. It lights the surface just inside the edge. | 01-rim-dark.gif, 01-rim-light.gif | Top pick |
| Aurora | Background of an empty chat | Two dim curtains of light with fine rays drift and sway above the greeting. They fade out before the composer. | 02-aurora-dark.gif, 02-aurora-light.gif | Flag: the rays read as stripes at small sizes, and the GIF is 1.8 MB. Drift once, then hold. |
| Ink (light) | Memory saved | A drop blooms into three soft watercolor layers. The edges sharpen, the saved note rises in, then it fades. | 03-ink-dark.gif, 03-ink-light.gif | Keep. Rename it (Bloom) so it does not clash with type Ink. |
| Pool | Thinking, small | A glassy violet bead swells, dents and lets go of a droplet, then takes it back. One soft highlight. | 04-pool-dark.gif, 04-pool-light.gif | Fixed: small pinholes showed in the shading. Flag: a liquid blob is close to the stock AI orb. |
| Glass | Onboarding step card | A frosted card over a soft field. The bright part of the edge follows a circling light, the shadow leans away, and one sheen crosses the face. | 05-glass-dark.gif, 05-glass-light.gif | Keep. Backdrop blur costs more on phones. |
| Halo | Tool running | A hairline ring with an arc of light that turns at an uneven pace, about 1.4s a lap. | 06-halo-dark.gif, 06-halo-light.gif | Dropped: it is a spinner. |
| Haze | Searching the web | A heat shimmer rises through ghost result rows. A violet band sweeps across and the rows catch the light. | 07-haze-dark.gif, 07-haze-light.gif | Flag: the wavy rows read as a rendering bug. |
| Breath | Waiting on you | Amber light breathes in from the card's left rule and around its edge: in for 1.6s, out for 2.2s, then a rest. The words stay still. | 08-breath-dark.gif, 08-breath-light.gif | Keep. My pick for waiting. |
| Develop | Streaming text | Words appear behind a soft front at the stream's pace. Each letter passes through a faint violet light, then settles. | 09-develop-dark.gif, 09-develop-light.gif | Keep. Same idea as type Ink; build them as one. |
| Settle | Done | The rim light slows and its tail opens around the whole border. The edge glows evenly, then fades to the hairline as "Done in 12s" comes in. | 10-settle-dark.gif, 10-settle-light.gif | Keep. Pairs with Rim. |
| Fault | Failed | The rim light brakes, its tail pulls in and it cools from violet to red. A short red mark stays beside the reason and Retry. | 11-fault-dark.gif, 11-fault-light.gif | Keep. Pairs with Rim. |
| Eclipse | Limit reached, countdown to resume | A dark disc covers a disc of light so only a thin edge shows. Each tick slides the cover aside. At zero the light turns violet and reads "Resumed". | 12-eclipse-dark.gif, 12-eclipse-light.gif | Fixed: word swap. Flag: in light theme it reads like a toggle switch. |
| Relay (light) | Handoff to another model | The light around one model's card leaves through its edge and crosses a wire as one packet. It enters the next card and keeps running; the first card dims. | 13-relay-dark.gif, 13-relay-light.gif | Fixed: word swap. |
| Prism | Jury | Each answer sends light down a wire into a small glass prism, which fills a little more each time. Light circles the prism once, then one beam leaves for the verdict. | 14-prism-dark.gif, 14-prism-light.gif | Fixed: "running" and "picks B" sat on top of each other at every swap and at the loop reset, and the count read "Waiting for 0 of 4". |
| Loupe | Second opinion | A small glass lens reads the answer line by line, with the text under it larger and brighter. Then it lifts away and the second model's note slides in. | 15-loupe-dark.gif, 15-loupe-light.gif | Keep |
| Lantern | Memory recalled | A soft pool of light moves down the saved notes and lingers on the two that match. They brighten and keep a thin rule; the line above changes to "Recalled 2 notes". | 16-lantern-dark.gif, 16-lantern-light.gif | Fixed: word swap. Keep. |
| Pane | Panel and page transition | A frosted side panel slides in on the sheet curve while the page settles back and dims. A line of light runs down the panel's leading edge. It closes faster than it opens. | 17-pane-dark.gif, 17-pane-light.gif | Fixed: word swap. |
| Sheen (light) | Toast | A glass toast rises 4px into place and one band of light crosses it. It leaves with a short fade and a 4px drop. | 18-sheen-dark.gif, 18-sheen-light.gif | Fixed: the dark GIF lost the toast text for one frame (a capture fault). Re-recorded. |
| Sync | Device pairing | Laptop and phone screens glow out of step, then drift into step. A thread of light joins them and the same code shows on both. | 19-sync-dark.gif, 19-sync-light.gif | Fixed: the two captions overlapped for one frame. |
| Dawn | A routine fires | At the fire minute, light rises behind the routine's rule and runs out along it both ways. The countdown changes to "Running". | 20-dawn-dark.gif, 20-dawn-light.gif | Fixed: word swap. Keep. |

## UI

Page: /tmp/cg/motion-lab2/ui/index.html. GIFs: /tmp/cg/motion-lab2/ui/gifs. Each also has a `-light.gif`.

| Name | Purpose | What moves | GIF | Status |
|---|---|---|---|---|
| Open a chat | Route change from the chat list to a chat | The row title travels and grows into the page header while the list and the chat crossfade. Going back is faster. | route-title.gif | Keep |
| Sessions list | Rows that arrive, close or change order | Each row rides a damped spring to its slot. A moving row lifts with a shadow, a new row slides out from under the header, a closed row slides out left. | list-springs.gif | Keep |
| Card to panel | Opening a routine card | The card grows into the detail panel, its title glides into the panel header, and the page dims behind it. | card-panel.gif | Keep. In light theme the closing card is a blank white box for a few frames. |
| Bottom sheet | Phone sheets, here the model picker | The sheet springs up while the page behind shrinks back. Dragging up meets resistance, and a flick down carries its speed into the close. | sheet-spring.gif | Keep |
| Toast stack | Saved, copied and undo toasts | New toasts rise and push older ones into a stack. Hover fans them out. Dismissing one lets the rest spring into place. | toast-stack.gif | Keep |
| Send to stop | The composer button while a reply streams | The arrow folds into a square and a violet ring draws around it. Your text lifts into a message bubble. At the end the square opens back into an arrow. | send-stop.gif | Keep |
| Save to check | Buttons with a quick result | The button narrows into a circle, a ring traces once around it, then it turns green and a check draws in. | save-check.gif | Keep |
| Tab indicator | Top nav and segmented controls | The underline stretches toward the new tab, leading edge first, and the trailing edge catches up. The segment thumb slides. | tab-glide.gif | Keep. MOTION.md says repeated actions like tabs get little motion, so keep it short. |
| Approve and close the gap | Inbox approval cards | The button confirms in place and the side line turns green. The card slides out, the cards below spring up, and the count rolls down. | approve-gap.gif | Keep |
| Jury verdict | Jury mode | Four answer cards gather into a loose stack, merge into one card, and the card turns over in 3D to show the verdict. | jury-flip.gif | Keep |
| Model handoff | Handing work to another model | The model mark lifts out of its tile and travels on an arc while it morphs into the other model's mark. A violet trail draws behind it and the token count rolls. | handoff-morph.gif | Keep. The white marks are heavy next to the hairline UI. |
| Memory saved | Saving a fact to memory | The fact lifts off its card and shrinks along a curve into the Memory tab. The tab answers with a short violet underline and "+1". | memory-fly.gif | Keep |
| Routine fires | A routine's schedule firing | A hand sweeps one full turn and leaves a filled wedge. A violet ring closes around the dial, a ripple goes out, and the status turns to Running. | routine-dial.gif | Keep |
| Limit countdown | A usage limit with a known reset time | An amber ring fills as the seconds roll down. At zero it turns violet and straightens into a live line with light running along it. | limit-ring.gif | Keep. While it curls and uncurls it looks like a spinner arc for a moment. |
| Skeleton | First load over 300ms | One soft diagonal band of light crosses all the bars as one surface. Then each real row fades in over its skeleton row. | skeleton-sheen.gif | Keep |
| Onboarding steps | First run setup | Content leaves to the left and the next step slides in from the right. The step rail fills a circle, draws a check and runs a line down. | onboarding-steps.gif | Keep |
| Preview panel | Side panels, such as a file preview | The panel slides in from the right while the chat column moves left with it, as one surface. Closing is a little faster. | panel-slide.gif | Keep |

---

## Recommendations

### (a) Main thinking animation: Septa

- Use Septa as the one thinking mark: 16px in the reply line, 112px on the empty chat page.
- It reads clearly at 16px, and it does not look like any brand mark I know.
- It carries every live state as one object: light round the outline for a tool, an amber freeze for waiting, a red flat line for failed, a grey heptagon for done (see Septa turn and Septa fault).
- It is one SVG path with rests in each loop, so it is cheap and calm.
- Runner-up: Knot. It is the most refined line work. Use it for the hero if Septa feels too busy at 112px.
- For the word "Thinking" where no mark shows (session rows, the tab title), use Sheen: one pass of light, then a rest. Flex is the more original word motion; keep it for rare moments, since it repaints the word each frame.

### (b) Streaming text reveal: Ink

- A soft mask runs along the line as words arrive, and the newest letters carry violet that cools to ink.
- Nothing moves or reflows, so long answers stay easy to read while they stream.
- Violet only sits at the live front, which matches "violet means live work".
- Build it with the MOTION.md C4 pacing: words 40ms apart, never more than 320ms behind. Merge Develop (light family) into it; it is the same idea.
- Reduced motion: words fade in with no wipe.

### (c) Live border or light for working states: Rim, with Breath, Settle and Fault

- Rim: one thin violet light runs round the composer edge every 4s while the model works.
- Breath: the same edge breathes amber while it waits on you.
- Settle: the light slows and fades to the hairline when done.
- Fault: the light brakes and turns red beside the reason and Retry.
- These four are one light that changes its behavior, so they read as one system and never cover content.
- Keep the falloff short so it stays a line of light, not a glow. Reduced motion: a still violet segment on the edge.

### (d) Top 10 app-wide motions to build first

1. **Septa and its states** (Septa, Septa turn, Septa fault). Every reply shows it.
2. **Ink** streaming reveal. Every reply uses it.
3. **Rim, Breath, Settle, Fault** on the composer. They show live, waiting, done and failed where you type.
4. **Steps** live status line. Tool verbs change many times per reply, and clean swaps stop the line from flickering.
5. **Fold** thought row. Every reply with reasoning ends here, and it makes room for the answer without a jump.
6. **Roll** digits. Tokens, cost, countdowns and inbox counts all share one small component.
7. **Send to stop.** It runs on every message, confirms the send and shows how to stop.
8. **Approve and close the gap.** Approvals are the main waiting-on-you action, and the list must not jump.
9. **Preview panel** (with Card to panel). Panels open often, and moving the column with the panel keeps your place.
10. **Toast stack.** Saved, copied and undo all land here, and the stack keeps toasts from piling up.

Next in line: Limit countdown (UI) or Dial, Lens for search, Lantern for memory recalled, Memory saved, Jury verdict, Relay or Model handoff, Dawn for routines, Onboarding steps, Sync for pairing, Open a chat.

---

## What I changed

- **Light, Prism.** Labels now swap one after the other, at each answer and at the loop reset. The count never reads "0 of 4". Re-recorded both themes.
- **Light, shared word swap.** The new word now waits for the old one to leave. This fixed one-frame overlaps in Eclipse, Relay, Lantern, Pane, Sync and Dawn. Re-recorded both themes of each.
- **Light, Pool.** The shading made pinholes deep inside the bead. I flattened the surface there. Re-recorded both themes.
- **Light, Sheen (toast).** One dark frame lost its text in capture. Re-recorded.
- **Shapes, status line swap.** The new line now starts after the old one fades. This fixed a one-frame overlap in Jury and the same swap in Septa turn, Septa fault, Dial and Relay. Re-recorded.
- All re-recorded loops still close, and both edited pages load with no console errors.

## Dropped and flagged

- **Dropped:** Halo (light). It is a ring with a turning arc, which is a spinner.
- **Flagged, not for the first build:** Spoke (close to the Claude spark), Gimbal (atom or React logo), Decode (scramble trope), Wave (broken baseline look), Haze (looks like a bug), Aurora (heavy; drift once, then hold), Pool (blob look), Eclipse in light theme (reads as a toggle).
