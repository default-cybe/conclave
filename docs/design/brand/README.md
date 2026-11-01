# The Conclave mark

**Knot with a light.** The trefoil knot drawn as a ribbon with real over and
under crossings, in the foreground color, with one violet light on it. It is
the only mark: the app icons, the favicon, the top bar, Home, and every live
state, where its light moves (the Knot, `CHAT-AND-MOTION.md` 1.3 and 1.7).

![The mark on dark](mark-dark.svg)

## Files

| File | What |
|---|---|
| `knot.json` | The one source: curve, pieces, halos, strokes, the light, states, icon placement |
| `../../../scripts/brand/knot.ts` | Writes every asset below from `knot.json`. Re-running it gives the same files |
| `mark-dark.svg`, `mark-light.svg` | The mark on its own, transparent (the crossings are cut), for dark and light grounds |
| `mark-mono.svg` | One color, no light |
| `app-icon.svg` | The app icon: the knot on the dark tile |

What the script writes:

| Where | Files |
|---|---|
| Web code | `packages/web/src/components/brand/knotGeometry.ts` |
| Web icons | `public/favicon.svg`, `public/favicon.ico`, `public/icons/` (favicon 16, 32, 48; `apple-touch-icon.png` 180; `icon-192`, `icon-512`, `maskable-192`, `maskable-512`; `badge-96` for notifications) |
| Desktop | `packages/desktop/icon.png` (1024), then `src-tauri/icons/` through `tauri icon`, small sizes redrawn with the heavier stroke; the mark in `src/index.html` |
| iPhone | `packages/mobile/assets/icon-1024.png`; `Splash.imageset/` (the launch image on the light and the dark ground, and its `Contents.json`); `Ground.colorset/Contents.json` (the web app's page ground, light and dark: `icons.ground` in `knot.json`, checked against `--bg` by `packages/web/test/ios-launch.test.ts`). `bun run assets:ios` copies them into the Xcode project |
| Android | `KnotGeometry.kt` in `:client`; `ic_launcher_foreground.xml`, `ic_launcher_monochrome.xml`, `ic_stat_conclave.xml` |
| The rope | the `rope` block of `knot.json` (its paths, halos and light home, from the pieces), and the rope in both geometry files |

To change the mark: edit `knot.json`, run `bun scripts/brand/knot.ts --sheet /tmp/knot-sheet.png`,
look at the sheet (every icon, the maskable safe zone, the Android masks), then
`bun test packages/web/test/knot.test.ts` (it fails if a generated file is out of date) and
`./gradlew :client:test` in `packages/android`.

## Geometry

- The curve `x = sin t + 2 sin 2t`, `y = cos t - 2 cos 2t`, drawn at `32 + 8.044 x`,
  `32 + 8.044 (y + 0.47)` in a 64 unit box: one lobe up, centered.
- Positions are shares of the knot's length, 0 to 100, from the bottom of the right lobe
  (43.97, 52.37) going left. The crossings: over at 6.34, 39.68, 73.01; under at 16.77, 50.11,
  83.44.
- Six pieces, under and over by turns, split away from every crossing, so a round end never
  lands on another strand. The last piece runs past 100, round to the start.
- Three halos, about 6.3 long, one on each crossing inside its over piece.
- Drawn in this order: the under pieces, the light on them, the halos (strokes in the color
  behind the mark, width 9), the over pieces (flat ends: the under pieces' round ends fill the
  joins below them), the light on them. So the light passes under a strand where the strand does.
- Stroke 5.2. At 32 px and under (the knot's box), 7, with halos 11.

## Colors

| Part | In the apps | On the app icon |
|---|---|---|
| The knot | `--fg` (`currentColor`) | `#ecebef` |
| The light | `--signal` | `#b592f0` |
| Halos | the surface behind the mark | the tile, `#141417` |
| The knot while it works | `--rule-2` | |
| Done | `--fg-3`, no light | |
| Light waiting on you | `--warn` | |
| Light in a limit | `--fg-3` | |
| Light failed | `--fault` | |

The light's home is 84 to 100: the last 16 of the path, down the outside of the right lobe to
its bottom. The still mark always shows it there. A launch animation that ties the rope ends
there, so the tied rope is the still mark.

## Rules

- **Clear space.** Keep other marks and words at least a quarter of the box away from the box.
  Next to the wordmark the gap is 0.6 of the text size (9 px at 15 px).
- **Sizes.** 16 px is the smallest mark on screen; 12 px only for the still Knot in dense rows.
  The favicon puts the knot at 90% of its tile with the heavier stroke. App icons: 73% of the
  tile. Maskable: 74% of a full square, well inside the 80% safe circle. Android adaptive:
  56 of 108 dp, inside the 66 dp safe zone.
- **One color.** Where only one color shows (the notification badge, Android themed and
  notification icons, `mono`), drop the light and cut the crossings: halos as a mask, or the
  under strands stopping short of each crossing.
- **Motion.** Only live work moves the light (thinking, a tool, writing), and the rope moments
  move the rope (`../KNOT-MOTION.md`): the launch ties it on a cold start, run and success wait
  on the hub and say it answered. The top bar and the icons are still. Reduced motion draws one
  still pose per state, and the tied knot at rest for every rope moment.

Do:

- Draw it from `knot.json`: the components (`Mark`, `Knot` on web and Android) or the files above.
- Give the halos the color really behind the mark (`surface` when it is not the page).
- Put it on the dark tile when the ground is busy.

Do not:

- Rotate or mirror it (a mirror swaps every crossing), stretch it, or change the stroke.
- Draw the base in violet, add a second light, or move the still light off its home.
- Add outlines, shadows, glows or gradients, or redraw the crossings by hand.
- Use the old seven dot wave mark; it is retired.

## The rope

Launch, run, success, receive and send: one rope that slides along the same path, approved
2026-10-20. The spec, the numbers and where each one plays: `../KNOT-MOTION.md`. Its pieces are
these six, moved to 100 to 200 on the rope, so the tied rope is the still mark.
