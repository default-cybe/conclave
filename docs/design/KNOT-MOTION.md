# Knot motion: a rope that ties itself

The Conclave knot is one rope. Every knot motion moves that rope along its own
path. Nothing morphs or twists in place. The owner approved this direction on
2026-10-20 from the "Knot motion moments" board (four prototypes: launch, run,
success, receive and send).

## 1. The rope model

- **Units.** Positions along the rope are shares of the knot's length: the
  knot is 100 long (205.34 in the 64 box, stroke 5.2).
- **Knot path.** Global positions 100 to 200. It starts at the bottom of the
  right lobe, (43.97, 52.37), heading left, and follows the trefoil
  x = 32 + s(sin t + 2 sin 2t), y = 35.78 + s(cos t - 2 cos 2t), s = 44/5.47,
  from t = 1.44545.
- **Lead in.** A straight line from the right at y = 52.37, positions -40 to
  100.
- **Lead out.** From the start point it dips under the left lobe and runs
  left at y = 60: `C x0-7 y0, x0-11 60, x0-19 60`, then a straight line.
  Positions 200 to 350. The dip keeps the leaving rope off the bottom of the
  left lobe.
- **The window.** The rope is 100 long. At progress `w` it covers
  `[w, w+100]`. `w = 0` lies straight on the lead in. `w = 100` is the tied
  knot. `w = 250` has left to the left.
- **The light.** The light is the rope's last 16: `[w+84, w+100]`. On a tied
  rope that is 184 to 200, which is the logo's resting light. A lap moves it
  with a separate position `p` from 184 to 284. Positions over 200 wrap back
  into the knot.

## 2. Drawing it

- **Pieces.** The knot is drawn in pieces split away from every crossing, so
  a round cap at a split never lands on another strand.
  - Crossings: over at 106.34, 139.68 and 173.01; under at 116.77, 150.11
    and 183.44 (all 75 degrees).
  - Splits: 111.07, 128.71, 144.41, 162.05, 177.74, 195.38.
  - The rope start at 100 falls inside an over piece, so the rope has seven
    segments:

    | Segment | Layer | Start | Length |
    |---|---|---|---|
    | k0 | over | 100 | 11.07 |
    | k1 | under | 111.07 | 17.64 |
    | k2 | over | 128.71 | 15.70 |
    | k3 | under | 144.41 | 17.64 |
    | k4 | over | 162.05 | 15.69 |
    | k5 | under | 177.74 | 17.64 |
    | k6 | over | 195.38 | 4.62 |

  - Halos: background color, width 9, butt caps, 6.33 long, centered on
    each over crossing (starts 103.17, 136.51, 169.84).
- **Order.** Draw bottom to top:
  1. lead in, then its light;
  2. the under segments, then their lights;
  3. halos;
  4. lead out, then its light;
  5. the over segments, then their lights.

  The lead out sits above the halos so a halo never cuts the leaving rope.
- **Each piece shows the part of the window that falls on it.**
  - Web: give the piece's path `pathLength` = its length, use dash
    `100 1000` and offset `start - w`. Use the same window for halos, so a
    crossing gap exists only where its over strand is there.
  - The head light uses dash `16 1000` and offset `start - w - 84`.
  - The lap light uses dash `16 84` and offset `start - p`, so it wraps.
  - Android: `PathMeasure.getSegment` on each piece over the intersection
    of the piece and the window, drawn with round caps.
- **Head light and lap light.** They are separate strokes. Swap them, by
  opacity, at the moment they cover the same 16 (the end of a tie, the start
  of an untie).
- **Data.** Path data, pieces and halos are generated, not hand typed. The
  static logo uses the same six pieces (the knot without lead in and lead
  out) and the light at 184 to 200.

## 3. The moments

| Moment | Where | What moves |
|---|---|---|
| Launch | Cold start of the iPhone, Android and desktop apps; first run before Connect | Straight rope, tip lit; tie `w` 0 to 100; cinch; one light lap |
| Run | Connecting to the hub, reconnecting, first load of a list, pairing in progress | A 34 long piece with a 10 long light at its head runs the knot over a dim knot |
| Success | Paired, back online, friend added, import finished | The light runs two laps from rest and slows into place; trail; cinch at the stop |
| Receive | A friend's share arrives (Inbox card, toast) | Rope slides in from the right and ties; cinch; one light lap |
| Send | After sending to a friend | Rope pulls out through the knot to the left, the light leading |

### Timings

- **Launch, cold start.** 0.25 s straight. Tie in 1.6 s, ease in out
  cubic. Cinch in 0.45 s. Light lap in 1.0 s. Plays once per cold start.
  A tap skips it. When the app is ready sooner it still finishes the tie,
  then fades out.
- **Launch, first run.** The board's version: 0.6 s straight, tie in
  3.4 s, cinch, lap in 1.6 s, then "Conclave" fades in.
- **Launch camera.** It starts zoomed out so the whole straight rope fits.
  It follows the bounding box of the visible rope, smoothed over time, and
  ends at the knot at scale 1.
- **Run.** One lap every 2.4 s, linear. Rope dash `34 66`, light `10 90` at
  the head. The dim knot is the static knot in the faint ink. The halos stay
  in place, because the dim over strands are always there.
- **Success.** The light goes from 184 to 384 in 1.5 s with
  `cubic-bezier(.3,.05,.15,1)`. A trail of 34 at 32% opacity fades in and
  out. Cinch at the stop: scale 1, .93, 1.025, 1 over 0.45 s, around the
  knot's center (32, 32).
- **Receive.** `w` from -36 to 100 in 2.7 s, ease in out cubic. Then the
  cinch and a lap in 1.25 s.
- **Send.** `w` from 100 to 250 in 2.5 s, ease in (`x^2.2`). The view clips
  the rope as it leaves.
- **Reduced motion.** Show the tied knot, with the light at rest. No
  movement.

## 4. What stays

The status mark keeps its states: thinking, working, waiting (amber),
paused, failed and done. The run moment does not replace them. It is for
waiting on the hub, not on a model.

## 5. In the apps

### Where it lives

| Part | Web (also desktop and iPhone) | Android |
|---|---|---|
| Data | `knot.json`, block `rope`: `scripts/brand/knot.ts` writes its paths, halos and light home from the six pieces; `--check` covers it | the same file |
| Geometry | `components/brand/knotGeometry.ts`: `ROPE_PATHS`, `ROPE_HALOS`, `ROPE` | `:client` `KnotGeometry.kt`: `RopeGeometry` |
| Math | `components/motion/knotMath.ts`, section "The rope"; `test/knot-rope.test.ts` | `:client` `motion/Knot.kt`, the same section line for line; `RopeTest` |
| Drawing | `components/motion/KnotRope.tsx`: one path element per piece and kind, dashes set on every frame | `ui/motion/KnotRope.kt`: a Canvas, `PathMeasure.getSegment` per piece |
| Launch | `components/BootSplash.tsx` | `ui/motion/LaunchSplash.kt` |
| Helpers | `useRopeMoment()`: run while waiting, `await succeed()` before moving on | `KnotRopeLine` (the knot and a word), `RopeSplash` (one moment over the app) |
| Look at it | `/dev/motion`, "Knot rope": every moment, replay, a scrubber | |

### Where each moment plays

| Moment | Web | Android |
|---|---|---|
| Launch | The boot splash, once per cold start. A tap or a key skips it. Ready sooner, it finishes the tie, then the tied knot flies into the hero mark (Home, a new chat) or the splash fades into the app. Not ready at the end, the knot runs until it is | Over the app once per process, after the system splash; fades into it |
| Launch, first run | No saved hub, once per device: the long launch with "Conclave", then Connect | Before the first pairing, once per phone |
| Run | Beside Connect and Log in while they wait; the phone Connect mark while it pairs; the top bar while the hub reconnects; the offline line while a try runs; beside "Waiting for the phone" in pairing; first loads (`LoadingRows`) | Beside "Checking the hub" and "Waiting for the hub" in pairing; the offline line while it connects; first loads (`LoadingBox`) |
| Success | Connect plays it before the app opens; "Paired" in the pairing panel; the top bar and the offline line ("Back online.") after being offline; an import that finishes while you watch | The first pairing, before the app; the offline line ("Back online.") after being offline; an import that finishes |
| Friend added, receive, send | `features/friends/moments.tsx`: receive on a share card that arrives while you watch (the Inbox, a friend's thread, Shares); success by a friend just added (their row and page); send in Send to friend's sent state | `KnotRope` with `RopeMoment.SUCCESS`, `RECEIVE` or `SEND` |

The Home hero settles into the mark with its light at rest (the Knot's
`brand` state: the light lets go from its tail until the home 16 is left),
not into the grey done knot.

### Choices made in building it

- **Flat over ends, as the still mark.** The over pieces' base ends flat,
  so the tied rope draws exactly as the mark. Where the rope ends on an
  over piece, and at the join of k6 and k0 (two flat ends), a round dot in
  the base color stands in for the cap. A piece shown whole draws with no
  dashes at all.
- **The run's dim over strands go only where the run piece is not**, so a
  join inside the piece shows no seam.
- **Starts.** Run starts with its light ending where the home light ends
  (the piece at 166 to 200). Success, receive and send start at once; the
  board's pauses before them were for its loop.
- **Long launch numbers** are the board's: 0.64 s straight, tie 3.36 s,
  cinch 0.88 s, the lap 0.48 s after the tie for 1.6 s, the name 1.12 s
  after the tie for 0.64 s, rising 8 px.
- **Cinch.** Scale 1, .93, 1.025, 1 at 0, .32, .68 and 1 of its time,
  straight lines between, as on the board.
- **Camera.** Smoothed over time: a triangle of plus and minus 5 steps of
  1/32 of the tie, only while the rope moves; it reaches the knot at scale
  1 as the tie ends.
- **Trail.** 34 long, from 14 behind the lap light, as on the board.
