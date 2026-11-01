# Conclave UI spec

Status: final, for the build. Owner of this file: design. Engineers build from it without asking each other. If two rules seem to conflict, the more specific rule wins (a page spec beats a component spec, a component spec beats a principle).

- Reference mock (open in a browser, read the CSS): `docs/design/reference/` (`home.html`, `chat.html`, `chat.html#jury`, `onboarding.html`, `onboarding-keys.html`, `mobile.html`, `lab.css`, `wave.js`, `common.js`, `logos.js`). The brand mark and app icon: `docs/design/brand/`.
- The contest, every direction's screenshots: `docs/design/directions/<key>-<name>.jpg`.
- Where this spec and the mock disagree, **this spec wins**. The mock predates the grafts in section 0.3 and still shows a few things we dropped (the amber left edge on the approval card, segmented meters on tasks, wave strips in session list rows, the old brand mark).

---

## 0. Decision

### 0.1 Scores

Weights: (a) does not read as AI-made, x3; (b) craft, x3; (c) dense information, x2; (d) signature (wave and logos), x2; (e) owner taste, x2; (f) implementable, x1; (g) accessibility, x1. Maximum 140.

| Direction | a | b | c | d | e | f | g | Total |
|---|---|---|---|---|---|---|---|---|
| **lab** (Lab console) | 8 | 8 | 9 | 8 | 9 | 8 | 7 | **115** |
| quiet (Quiet instrument) | 8 | 8 | 7 | 6 | 7 | 9 | 8 | 105 |
| ink (Ink and paper) | 7 | 8 | 7 | 9 | 6 | 6 | 7 | 102 |

### 0.2 Why Lab console

- It is the only direction that makes the hard part, dense live state, easy to read: the Home screen at 1440x900 shows approvals, running sessions with model logos, every limit with its reset, routines on a 24 hour axis, devices and memory without a single card or pill.
- It matches the owner's world and stated references (oxide.computer, Trail of Bits, watchTowr, Linear): a flat graphite bench, hairline rules, tabular numbers, Mona Sans with its width axis, JetBrains Mono kept to code.
- The wave becomes useful, not only pretty: the Home scope plots real model output, the strip replaces spinners and reflects tokens per second, and the hero on onboarding is the brand moment.
- Its color discipline is the strictest: the primary button is neutral ink, so violet only ever means live work or the brand.

Why not the others. **Quiet** is very clean and the most accessible, but at product scale it reads as a well made generic SaaS; the wave strips are faint and the brand has little to hold on to. **Ink** has the most ownable wave (the risograph halftone is lovely) and the best typesetting, but a serif notebook on warm paper moves away from the owner's Mona Sans and JetBrains Mono taste, needs a third self-hosted font with custom subsets, puts serif prose on long technical answers, and uses lavender filled buttons and small caps labels that drift back toward the tells.

### 0.3 Grafts and changes (named, applied throughout this spec)

From **quiet**:
1. **Three-tier logo rule.** Harness mark for a session that runs through a CLI, model family mark for a model, company mark for billing and keys (section 8).
2. **Inbox.** Approvals and questions get their own nav item, "Inbox", with the amber count. On phones the tab bar is Home, Chats, Inbox, More, plus New (section 12).
3. **The phone approval card** is the only filled card on phone Home, with Allow once full width and the two other actions below it.
4. **Now rule inside the timetable.** The routine timetable gets a violet "now" row with the current time, not only the dot on the 24 hour axis.
5. **Reach it from your phone** on the Hub step: once connected, the step says how phones reach the hub (the same network now, the quick tunnel one tap away) with the choice from Settings > Remote access. This replaced tailnet discovery when remote access became built in (DESIGN.md section 14).
6. **No strips in narrow rows.** A wave strip needs at least 64px. Session list rows show live state as elapsed time in violet text.
7. Settings and onboarding share one provider row component.

From **ink**:
8. **The verdict is a sentence.** "Use Caddy." set large, followed by a tally that uses each juror's logo, and a criteria table (options as columns).
9. **Providers step grouped** as "Found on this computer" (existing CLI logins) above "API keys".
10. **Errors that explain.** A rejected key says what is wrong and how to fix it ("Rejected with 401. This looks like an Anthropic key. OpenRouter keys start with sk-or-.").
11. **The approval card shows the agent's reason** as a quoted line under the command, and "Always allow..." is a quiet action that opens a confirm dialog with the exact rule.
12. **Checkpoints with Restore** in the chat context panel.

Our own changes to the Lab mock:
13. **No colored edge stripe on the approval card.** A 2px amber left edge on a box is a common AI-made tell. The card is a plain raised box; the amber is in the words ("Waiting 2 min").
14. **Segmented tick meters only for usage limits.** Tasks, context and cache use a 3px solid meter or plain text. Fewer little elements.
15. **New brand mark** (section 9.6) replacing the council ring: since October 2026 the knot with a light.
16. **Axis labels and hints at fg-3**, warn and ok darkened in light mode, fg-3 lifted in dark mode, so every text pair passes AA (section 3.3).
17. **Logos in color only where the model is the subject**; monochrome in meta lines (section 8.3).

---

## 1. Principles

1. **Rules, not boxes.** The page is one flat surface. Columns are split by 1px vertical rules and sections sit on a heading rule. A box appears only when its content is a different kind of object: code, a diff, an input, an approval, a dialog.
2. **Words in fixed places.** State is a word at the end of a row or the right of a heading: running, done, failed, waiting, online, offline. No badges, pills or dots for state.
3. **Color means one thing each.** Neutrals carry about 95% of the UI. Violet (`--signal`) is live activity, focus and the brand. Amber (`--warn`) is something waiting on the owner, or a limit at 70% or more. Green (`--ok`) is healthy or passed. Red (`--fault`) is failed, rejected or a limit at 90% or more. Any other use of color is a bug. Two exceptions: provider logos in brand color (section 8) and syntax highlighting in code.
4. **Numbers line up.** Counts, percents, prices, durations and token figures in columns use tabular figures and are right aligned.
5. **One expressive element.** The wave. Everything else is still.
6. **Say the thing.** Copy is a status or an instruction. Home opens with a sentence built from data. No greetings, no taglines.
7. **Hierarchy per page:** one status line or title, then sections, then rows. If everything looks the same weight, something is wrong.

---

## 2. Banned patterns (check every PR against this list)

A reviewer rejects a change that adds any of these, unless a line in this spec allows it by name.

- [ ] Pill or chip tags, with or without a colored dot. Tags are words (section 10.6).
- [ ] UPPERCASE letter-spaced micro labels. All headings are sentence case. No `text-transform: uppercase` anywhere, no `letter-spacing` above 0.01em on text under 20px.
- [ ] Monospace for metadata ("anthropic · key set · 3 models"). Mono only for the list in 4.3.
- [ ] An icon on section headings, table headers or list rows, or on nav other than the sidebar's rows (8.1). Logos are identity, not icons; lucide only from the allowlist in 8.1.
- [ ] Boxes inside boxes. Bordered card in a bordered column in a bordered panel. Same rounded rectangle everywhere.
- [ ] A colored edge stripe on a card or callout (left or top accent bar). The selected list row bar in 10.2 is the only edge bar, and it is neutral.
- [ ] Colored dots as the identity of a model, provider, agent or project. `ModelDot`, `AgentIcon` color tiles and per-agent colors are removed from the UI.
- [ ] Background grids, crosshair corner marks, concentric rings, noise overlays, scanlines, glows, blurred blobs.
- [ ] Gradients of any kind on surfaces, text or borders. Glassmorphism or `backdrop-filter` (except the mobile tab bar, see 12, and the meeting overlay, which floats over other apps: docs/design/MEETING-MODE.md 7.3). Glowing borders. Sparkle icons. Emoji in UI chrome.
- [ ] KPI tile rows. Sparklines next to numbers. Charts stay on the Usage page (the Home scope, 9.4, went with the chat-first Home).
- [ ] Lists of identical rows each ending in a colored toggle switch. Booleans are a neutral "On / Off" segmented control and live in detail views (10.11).
- [ ] Spinners, pulsing dots, shimmering skeletons. Live work shows a wave strip or an elapsed counter. A plain static skeleton is allowed only for a first load that takes more than 300ms.
- [ ] Violet buttons. Violet fills larger than a 2px rule. Violet text that is not live state, focus or a link in the brand moment.
- [ ] Placeholder copy, marketing lines, taglines, "Welcome back", exclamation marks.
- [ ] Em dashes in any UI copy, comment or doc. These words: seamless, effortless, supercharge, unleash, magic, AI-powered, delve, robust, leverage, elevate.
- [ ] Badges with a count inside a colored circle. Counts are text (amber when they need the owner).
- [ ] Text below 11px. Weights of 700 or more.
- [ ] Wave canvases narrower than 64px, behind text, or used as a background texture.

---

## 3. Color tokens

### 3.1 Semantic tokens (OKLCH)

Neutrals sit on hue 286 at very low chroma, so they lean slightly cool. The signal violet is hue 300 to 303, away from Tailwind indigo (about 277).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `oklch(0.163 0.005 286)` | `oklch(0.982 0.002 286)` | Page surface |
| `--bg-sunk` | `oklch(0.138 0.005 286)` | `oklch(0.960 0.003 286)` | Inputs, code, scope well, composer |
| `--bg-raise` | `oklch(0.198 0.006 286)` | `oklch(1 0 0)` | Approval card, menus, dialogs, selected row, kbd |
| `--bg-hover` | `oklch(0.215 0.007 286)` | `oklch(0.950 0.004 286)` | Row and quiet button hover |
| `--rule` | `oklch(0.262 0.007 286)` | `oklch(0.905 0.005 286)` | Row and column rules |
| `--rule-2` | `oklch(0.335 0.009 286)` | `oklch(0.820 0.008 286)` | Section heading rule, box borders, outline buttons |
| `--edge` | `oklch(0.480 0.009 286)` | `oklch(0.640 0.008 286)` | Input and checkbox borders (3:1 against fill) |
| `--fg` | `oklch(0.945 0.004 286)` | `oklch(0.205 0.010 286)` | Primary text |
| `--fg-2` | `oklch(0.765 0.008 286)` | `oklch(0.405 0.012 286)` | Secondary text, body in panels |
| `--fg-3` | `oklch(0.610 0.010 286)` | `oklch(0.520 0.012 286)` | Metadata, labels, axis labels, hints |
| `--fg-4` | `oklch(0.500 0.010 286)` | `oklch(0.620 0.010 286)` | Disabled text, placeholders, line numbers, `$` prompt. Never for information the owner needs. |
| `--signal` | `oklch(0.775 0.125 303)` | `oklch(0.520 0.170 300)` | Live state, focus ring, the light on the brand mark, now line |
| `--signal-dim` | `oklch(0.775 0.125 303 / 0.14)` | `oklch(0.520 0.170 300 / 0.09)` | Text selection only |
| `--ok` | `oklch(0.790 0.120 158)` | `oklch(0.520 0.130 155)` | Online, works, passed, diff add gutter |
| `--warn` | `oklch(0.830 0.125 80)` | `oklch(0.555 0.130 65)` | Waiting on you, limit at 70% or more |
| `--fault` | `oklch(0.705 0.155 26)` | `oklch(0.560 0.190 27)` | Failed, rejected, deny hover, limit at 90% or more |
| `--add-bg` | `oklch(0.790 0.120 158 / 0.09)` | `oklch(0.700 0.130 155 / 0.12)` | Diff added line |
| `--del-bg` | `oklch(0.705 0.155 26 / 0.10)` | `oklch(0.650 0.170 27 / 0.10)` | Diff removed line |
| `--solid` | `= --fg` | `= --fg` | Primary button fill |
| `--solid-fg` | `= --bg` | `= --bg` | Primary button text |
| `--meter-off` | `oklch(0.300 0.008 286)` | `oklch(0.900 0.005 286)` | Meter track and off segments |
| `--meter-on` | `oklch(0.800 0.010 286)` | `oklch(0.330 0.010 286)` | Meter fill under 70% |
| `--wave-ink` | `oklch(0.700 0.020 300)` | `oklch(0.480 0.030 295)` | Wave levels 1 to 3 |
| `--wave-hot` | `oklch(0.860 0.110 303)` | `oklch(0.500 0.170 300)` | Wave top level |
| `--scrim` | `oklch(0.10 0.005 286 / 0.60)` | `oklch(0.20 0.010 286 / 0.28)` | Behind dialogs and sheets |
| `--shadow-pop` | `0 12px 32px oklch(0 0 0 / 0.35)` | `0 12px 32px oklch(0.2 0.01 286 / 0.12)` | Menus, dialogs, toasts, sheets |

Syntax (code blocks and diffs only):

| Token | Dark | Light |
|---|---|---|
| `--syn-kw` | `oklch(0.780 0.100 303)` | `oklch(0.480 0.160 300)` |
| `--syn-str` | `oklch(0.800 0.090 150)` | `oklch(0.480 0.110 150)` |
| `--syn-num` | `oklch(0.800 0.090 60)` | `oklch(0.520 0.120 55)` |
| `--syn-type` | `oklch(0.800 0.070 220)` | `oklch(0.470 0.100 230)` |
| `--syn-fn` | `= --fg` | `= --fg` |
| `--syn-com` | `= --fg-3` | `= --fg-3` |

### 3.2 CSS block (paste into `packages/web/src/styles/index.css`, replacing the old tokens)

```css
:root, :root[data-theme='dark'] {
  color-scheme: dark;
  --bg: oklch(0.163 0.005 286);     --bg-sunk: oklch(0.138 0.005 286);
  --bg-raise: oklch(0.198 0.006 286); --bg-hover: oklch(0.215 0.007 286);
  --rule: oklch(0.262 0.007 286);   --rule-2: oklch(0.335 0.009 286);  --edge: oklch(0.480 0.009 286);
  --fg: oklch(0.945 0.004 286);     --fg-2: oklch(0.765 0.008 286);
  --fg-3: oklch(0.610 0.010 286);   --fg-4: oklch(0.500 0.010 286);
  --signal: oklch(0.775 0.125 303); --signal-dim: oklch(0.775 0.125 303 / 0.14);
  --ok: oklch(0.790 0.120 158);     --warn: oklch(0.830 0.125 80);     --fault: oklch(0.705 0.155 26);
  --add-bg: oklch(0.790 0.120 158 / 0.09); --del-bg: oklch(0.705 0.155 26 / 0.10);
  --solid: var(--fg); --solid-fg: var(--bg);
  --meter-off: oklch(0.300 0.008 286); --meter-on: oklch(0.800 0.010 286);
  --wave-ink: oklch(0.700 0.020 300); --wave-hot: oklch(0.860 0.110 303);
  --scrim: oklch(0.10 0.005 286 / 0.60); --shadow-pop: 0 12px 32px oklch(0 0 0 / 0.35);
  --syn-kw: oklch(0.780 0.100 303); --syn-str: oklch(0.800 0.090 150); --syn-num: oklch(0.800 0.090 60);
  --syn-type: oklch(0.800 0.070 220); --syn-fn: var(--fg); --syn-com: var(--fg-3);
}
:root[data-theme='light'] {
  color-scheme: light;
  --bg: oklch(0.982 0.002 286);     --bg-sunk: oklch(0.960 0.003 286);
  --bg-raise: oklch(1 0 0);         --bg-hover: oklch(0.950 0.004 286);
  --rule: oklch(0.905 0.005 286);   --rule-2: oklch(0.820 0.008 286);  --edge: oklch(0.640 0.008 286);
  --fg: oklch(0.205 0.010 286);     --fg-2: oklch(0.405 0.012 286);
  --fg-3: oklch(0.520 0.012 286);   --fg-4: oklch(0.620 0.010 286);
  --signal: oklch(0.520 0.170 300); --signal-dim: oklch(0.520 0.170 300 / 0.09);
  --ok: oklch(0.520 0.130 155);     --warn: oklch(0.555 0.130 65);     --fault: oklch(0.560 0.190 27);
  --add-bg: oklch(0.700 0.130 155 / 0.12); --del-bg: oklch(0.650 0.170 27 / 0.10);
  --solid: var(--fg); --solid-fg: var(--bg);
  --meter-off: oklch(0.900 0.005 286); --meter-on: oklch(0.330 0.010 286);
  --wave-ink: oklch(0.480 0.030 295); --wave-hot: oklch(0.500 0.170 300);
  --scrim: oklch(0.20 0.010 286 / 0.28); --shadow-pop: 0 12px 32px oklch(0.2 0.01 286 / 0.12);
  --syn-kw: oklch(0.480 0.160 300); --syn-str: oklch(0.480 0.110 150); --syn-num: oklch(0.520 0.120 55);
  --syn-type: oklch(0.470 0.100 230); --syn-fn: var(--fg); --syn-com: var(--fg-3);
}
:root {
  --sans: 'Mona Sans Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: 'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, monospace;
  --ease: cubic-bezier(.2, .7, .2, 1);
  --dur-1: 120ms; --dur-2: 180ms; --dur-3: 240ms;
  --r-1: 3px; --r-2: 5px; --r-3: 10px;
  --safe-t: env(safe-area-inset-top, 0px); --safe-b: env(safe-area-inset-bottom, 0px);
}
@theme inline {
  --color-bg: var(--bg); --color-sunk: var(--bg-sunk); --color-raise: var(--bg-raise); --color-hover: var(--bg-hover);
  --color-rule: var(--rule); --color-rule-2: var(--rule-2); --color-edge: var(--edge);
  --color-fg: var(--fg); --color-fg-2: var(--fg-2); --color-fg-3: var(--fg-3); --color-fg-4: var(--fg-4);
  --color-signal: var(--signal); --color-ok: var(--ok); --color-warn: var(--warn); --color-fault: var(--fault);
  --color-solid: var(--solid); --color-solid-fg: var(--solid-fg);
  --font-sans: var(--sans); --font-mono: var(--mono);
}
```

Tailwind classes then read as `bg-bg`, `bg-sunk`, `bg-raise`, `text-fg-3`, `border-rule`, `text-signal`, `text-warn`. Do not use Tailwind's built-in palette (`text-violet-500`, `bg-zinc-900`) anywhere.

Theme: `localStorage["conclave.appearance"] = {"theme":"dark"|"light"|"system","logos":"brand"|"mono"}`. `public/theme.js` sets `html[data-theme]` before first paint (keep the current mechanism). `meta[name=theme-color]`: dark `#141417`, light `#f9f9fa`.

### 3.3 Contrast (checked, WCAG 2.x)

| Pair | Dark | Light |
|---|---|---|
| fg on bg | 16.5 | 17.0 |
| fg-2 on bg | 9.2 | 8.6 |
| fg-3 on bg / on raise | 5.1 / 4.8 | 5.2 / 5.0 |
| fg-4 on bg (non-essential only) | 3.3 | 3.5 |
| signal on bg | 9.1 | 5.7 |
| warn on bg | 11.3 | 4.5 |
| ok on bg | 10.5 | 4.9 |
| fault on bg | 6.9 | 4.9 |
| edge on bg-sunk (input outline) | 2.9 | 2.8, plus the fill step, plus a label |

Rule: information text is fg, fg-2 or fg-3. fg-4 never carries information on its own.

---

## 4. Type

### 4.1 Families

- **Mona Sans** variable (`wght` 200 to 900, `wdth` 75 to 125), from `@fontsource-variable/mona-sans/standard.css` (already imported in `main.tsx`; the standard file carries both axes). Family name `'Mona Sans Variable'`.
- **JetBrains Mono** variable, from `@fontsource-variable/jetbrains-mono`. Family name `'JetBrains Mono Variable'`. Always with `font-feature-settings: 'zero' 1` and `letter-spacing: -0.01em`, set at 0.93em of the surrounding text when inline.
- No third family. No italics in UI chrome (Mona Sans italic is not loaded; do not let the browser synthesize it). Emphasis in prose is weight 560.

### 4.2 Scale

Sizes in px. Line height as a ratio. `wdth` is `font-stretch`. Tracking in em.

| Role | Size / LH | Weight | wdth | Tracking | Where |
|---|---|---|---|---|---|
| `wordmark-xl` | 92 / 0.95 | 600 | 118% | -0.035 | Onboarding welcome only (64 on phones) |
| `status` | 28 / 1.15 | 560 | 106% | -0.02 | Home status sentence (23 on phones) |
| `verdict` | 34 / 1.1 | 600 | 108% | -0.025 | Jury and debate verdict |
| `step-title` | 30 / 1.15 | 600 | 106% | -0.02 | Onboarding step title (24 on phones) |
| `page-title` | 20 / 1.25 | 600 | 104% | -0.012 | Title of every page except Home |
| `title` | 17 / 1.3 | 600 | 102% | -0.01 | Chat header, dialog title, panel title |
| `stat` | 20 / 1.1 | 540 | 100% | -0.01 | Stat readouts, tabular |
| `section` | 13 / 1.3 | 600 | 100% | 0 | Section headings |
| `row-title` | 13.5 / 1.35 | 500 | 100% | 0 | List and table row titles |
| `body` | 14 / 1.45 | 400 | 100% | 0 | Default UI text |
| `prose` | 14.5 / 1.6 | 400 | 100% | 0 | Chat messages, memory notes, routine prompts |
| `meta` | 12 / 1.4 | 400 | 100% | 0 | Meta lines under rows, column headers, captions |
| `micro` | 11 / 1.3 | 450 | 100% | 0 | kbd, axis labels (mono), never anything else |
| `code` | 12.5 / 1.6 | 450 | n/a | -0.01 | Mono blocks, diffs, terminal |

Phones (below 768px): `body` 15, `prose` 15.5 / 1.6, `row-title` 15, `meta` 13, `section` 14. Inputs are 16px on phones so iOS does not zoom.

Weights in use: 400, 450, 500, 540, 560, 600. Nothing else.

Measure: prose max 72ch (about 720px at 14.5). The status sentence max 22em.

### 4.3 Where mono is allowed

Allowed: code, diffs, terminal output, shell commands, file paths, branch names, IP addresses and ports, URLs typed by the owner, API key fragments, ids (session, run, checkpoint), cron expressions, clock times in timetables and on chart axes, keyboard keys in `kbd`, step indices on the onboarding procedure strip (`01`).

Not allowed: model names (write "Sonnet 5.5", not `claude-sonnet-5-5`), provider names, agent names, device names, metadata lines, counts, prices, percents, durations in sentences, status words.

### 4.4 Figures

- `.num` = `font-variant-numeric: tabular-nums`. Use it in table number columns, meters' percent column, elapsed counters, stat readouts, timetable times, token and cost columns.
- Mona Sans switches to a slashed zero under `tnum`. That is fine in readouts and tables (it suits the instrument look). Do not set `tnum` on running text or headings: in a sentence, numbers stay proportional ("Claude's 5 hour window is at 72%.").
- Never set `tabular-nums` on `body` or a page wrapper.
- Number formats: `$4.20`, `$149.07`, `46K`, `1.2M`, `335K tokens`, `72%`, durations `12m`, `1h 22m`, `3d 4h`, elapsed counters `12:04` (minutes:seconds) or `1:02:04`. Clock times 24 hour `14:08` unless the system locale says 12 hour. Dates "Friday 16 October" in headers, "16 Oct" in tables, "Tue" for this week, relative ("2m", "3h") in lists.

---

## 5. Spacing and layout

### 5.1 Scale

4px base: `4, 8, 12, 16, 24, 32, 48, 64`. Use Tailwind's default spacing (`1` = 4px).

Rhythm:
- Section heading rule to first row: 0 (rows start right under the rule; each row has its own vertical padding).
- Between sections in a column: 28px desktop, 32px phone.
- Row vertical padding: 9px (tables), 10 to 12px (two-line list rows).
- Title to meta line in a row: 2px.
- Column gutter around a vertical rule: 28px on each side.

### 5.2 Breakpoints

| Name | Width | Shell |
|---|---|---|
| phone | < 768 | 56px bar on every screen, a drawer from the left, single column (MOBILE-V2.md) |
| tablet | 768 to 1023 | The sidebar (272, folds to a 56px strip) and the page; the session panel is a right sheet |
| desktop | 1024 to 1279 | The sidebar and the page; the session panel is a right sheet toggled with `PanelRight` |
| wide | >= 1280 | Sidebar, page and the session panel docked at the right (340) |

Max content width 1440 for Home (centered with 32px gutters beyond that). Settings, Routines editor, Agents editor and onboarding steps use a 720px content column.

### 5.3 Desktop shell

The owner asked for the Claude desktop app's layout in October 2026: Conclave had the features, Claude's shell was cleaner and easier to read. There is no top bar. A sidebar at the left holds the navigation, the mode's conversations and the account; the page fills the rest; a conversation's details are a stack of cards at the right (11.2.4).

```
+------------------------------+------------------------------------------------+---------------------------+
| mark Conclave  [c][a][<>] [<] | Move auth middleware to jose    Running 12:04 ... [] | Environment  arch-desktop . > |
| Search                  ⌘K   | coder, Sonnet 5.5, arch-desktop, conclave      | Context         (o) 12%  v |
| New session                  |------------------------------------------------|   335K in  9.4K out  $0.71 |
| Inbox                     3  |                                                | Connectors   4 connected > |
| Workflows                    |   the transcript                               | Plan              3 of 5 > |
| Routines                     |                                                | Outputs           1 file > |
| Memory                       |                                                | Changes          +8 -6   > |
| Extensions                   |                                                | Background tasks 2 running v|
| More                         |                                                | Memory used            1 > |
|                              |                                                |                           |
| Sessions           Project v |                                                |                           |
| conclave               + ... |                                                |                           |
|   Move auth middl.. arch .   |   [ the composer and its options row ]         |                           |
| All conversations            |                                                |                           |
| (K) Kai, Owner, madx       . |                                                |                           |
+------------------------------+------------------------------------------------+---------------------------+
  sidebar 272, --side              page                                             panel 340 (wide)
```

- **Sidebar** (`components/Sidebar.tsx`): 272px on `--side`, a step under the page (no border), rows of 32px and 13.5px with 8px radius, `--side-hover` and `--side-active` for hover and the current row. Folded (`⌘\`, or its button) it is a 56px strip: the mark, open, New, Search, the Inbox with an amber dot, and the avatar.
  - **Header** (52px): the mark and "Conclave" (14px) to Home, the mode switch as three 26px icon buttons (Chat, Assistant, Code; the open mode raised on `--bg-raise`, its name and line in a tooltip), and the fold button.
  - **Rows**, each with a 16px lucide glyph (8.1): Search (opens the palette, `⌘K`), New (a new chat, assistant chat or session in the mode), Inbox (approvals, questions, alerts, import offers and what friends sent, the count in `--warn`), Workflows, Routines, Memory, Extensions (the owner's), More: a menu with Tasks, Goals, Agents, Usage, Devices, Map, Today, Friends and Remote access (the owner's), then All conversations. Every page keeps its "G then X" key.
  - **The mode's conversations** (`lib/sidebar.ts`): Code by project (one group per project across devices, a repository's worktrees under the repository, "No folder" last), by device, or by time, chosen with a quiet "Group by" at the right of the heading and kept on this device. Chats and the assistant's go by time: Pinned, Today, Yesterday, This week, Older. A row is the title only, a quiet dot while it runs (signal, breathing) or waits on you (amber, still), and the device in `--fg-4` unless the list is by device; on hover a `...` menu (Rename, Pin, Archive, Delete), also on right click. A group heading folds its rows; a project's heading shows `+` (a new session in its newest session's folder on that device, or its repository) and `...` (New session here, Fold, Share with friends) on hover. At most 80 rows; "All conversations" opens the full list at `/sessions`.
  - **Delegated work** (`lib/sidebar.ts` `delegatedRows`, DESIGN.md 43): under the mode's groups, in every mode, a group of the sessions a Delegate call started, newest first (at most 30), folding with its heading like the others. A row is two lines: the title and the dot, then a quiet line with who did it and where in `--fg-3` and the conversation it came from in `--fg-4` ("Code on MadX Arch, from Capstone chat"); 272px leaves no room for both on the title's line. It opens the session. Its `...` menu (and right click) has Move to main list first, then Rename, Archive, Delete; once moved, the session is a row of its kind's list.
  - **Account row** at the foot (`components/AccountMenu.tsx`): an initial in a circle, the name (the display name, else "Owner" or "Member"), "Owner, madx" under it, and the hub's state as a dot (ok, fault, or the knot while it reconnects). A violet dot on the avatar says a new release waits. It opens the account menu: the email (or the hub's address) as a quiet heading, Settings (`⌘,`), Usage, Devices, Update to X (the owner's, when one waits), Keyboard shortcuts, Get help, What's new, the other accounts on this browser and Add account, then Log out.
- **The conversation's header** stays at the top of its column (title, meta line, state, its menu and `PanelRight`). Pages keep their own `PageHeader`.
- **Settings** opens over the page (11.10).
- **Keys**: `⌘\` the sidebar, `⌘⇧\` the session panel, `⌘,` Settings, `⌘K` Search.
- Page gutters: 32px desktop, 24px tablet, 16px phone.

---

## 6. Borders, radii, elevation, boxes

- Borders are 1px. `--rule` between rows and columns. `--rule-2` under section headings, around boxes and on outline buttons. `--edge` on inputs, checkboxes and radios.
- Radii: `--r-1` 3px for controls (buttons, inputs, kbd, segmented controls). `--r-2` 5px for boxes (code, diff, approval card, composer, dialog, menu, toast). `--r-3` 10px only for phone bottom sheets (top corners) and the phone approval card. Nothing is round except the brand mark dots and radio buttons.
- Elevation: none on the page. Floating things (menus, popovers, pickers, dialogs, toasts, sheets) use `--bg-raise`, a 1px `--rule-2` border and `--shadow-pop`.

**A box is allowed only for:**
1. Code, terminal output, commands (`--bg-sunk`, `--rule` border).
2. Diffs (same).
3. Inputs, textareas and the composers, the one on Home included (`--bg-sunk`, `--edge` border; composers use `--rule-2`).
4. The approval card (`--bg-raise`, `--rule-2`). Only one approval card is expanded at a time per list; the rest collapse to rows.
5. The QR code well on pairing.
6. Floating layers listed above.

Never nest one of these inside another, with one exception: a command or code block inside the approval card, which then drops its border and keeps only the `--bg-sunk` fill.

---

## 7. Motion

- Durations: 120ms hover and press, 180ms menus, panels and sheets, 240ms page transitions. Easing `var(--ease)`.
- Only opacity and translate, at most 4px (sheets slide their full height on phones). No scale, no bounce, no spring.
- New rows fade in over 180ms. A state word that finishes cross-fades from `--signal` to `--fg-3` over 240ms.
- Elapsed counters tick once a second. The routine now line moves once a minute.
- The wave is the only continuous motion (section 9).
- `prefers-reduced-motion: reduce`: all transitions become 0ms, waves draw one static frame, counters still tick.

---

## 8. Iconography and the logo system

### 8.1 Lucide allowlist

Lucide stays for function only. Size 16px (14px inside 26px buttons), `strokeWidth={1.75}`, color inherits. Allowed glyphs and their only uses:

| Glyph | Use |
|---|---|
| `X` | Close dialog, sheet, toast; clear a field |
| `ChevronDown` | Pickers and selects (12px, `--fg-4` when idle) |
| `ChevronRight` / `ChevronLeft` | Expand a collapsed tool row; phone back; pagination |
| `ArrowUp` | Send (icon only button, with `aria-label="Send"`) |
| `Square` | Stop (filled, 10px, next to the word "Stop") |
| `Paperclip` | Attach |
| `Copy`, `Check` | Copy button in code blocks (Check shows for 1.5s after copying) |
| `MoreHorizontal` | Row or header overflow menu |
| `PanelRight` | Toggle the session panel (11.2.4) |
| `Plus` | The phone New button; a project's `+` in the sidebar |
| `PanelLeft`, `PanelLeftClose` | Open and fold the sidebar (5.3) |
| `MessageCircle`, `CalendarDays`, `Code` | The sidebar's mode switch: Chat, Assistant, Code |
| `Search`, `SquarePen`, `Inbox`, `Workflow`, `CalendarClock`, `Brain`, `Blocks`, `Ellipsis` | The sidebar's rows: Search, New, Inbox, Workflows, Routines, Memory, Extensions, More (and the drawer's New, Search and Inbox) |

Everything else is a word. No icons in headings, list rows, table headers, settings section lists, buttons that have a text label (except Stop), toasts, empty states. The sidebar's rows above are the one place nav carries glyphs, as in the Claude app the owner chose as the model.

### 8.2 Provider, model and harness logos

Source: `@lobehub/icons-static-svg` (MIT). Import the needed files as raw strings so only they are bundled:

```ts
// src/components/logo/registry.ts
import claude from '@lobehub/icons-static-svg/icons/claude.svg?raw';
import claudeColor from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
// ...one import per file in the table below
```

Strip the `<title>` element and the `width`/`height`/`style` attributes when registering; the wrapper sets size.

**Three tiers.** Pick the mark by what the thing is:
- A **session or run that goes through a CLI** shows the **harness** mark.
- A **model** shows its **model family** mark.
- A **plan, key, bill or provider account** shows the **company** mark.

| Id | Display name | Tier | Mono file | Color file |
|---|---|---|---|---|
| `claude-code` | Claude Code | harness | `claudecode.svg` | `claudecode-color.svg` |
| `codex` | Codex | harness | `codex.svg` | `codex-color.svg` |
| `gemini-cli` | Gemini CLI | harness | `geminicli.svg` | `geminicli-color.svg` |
| `opencode` | OpenCode | harness | `opencode.svg` | none |
| `cursor` | Cursor | harness | `cursor.svg` | none |
| `cline` | Cline | harness | `cline.svg` | none |
| `openhands` | OpenHands | harness | `openhands.svg` | `openhands-color.svg` |
| `claude` | Claude (Opus, Sonnet, Haiku) | model | `claude.svg` | `claude-color.svg` |
| `gpt` | GPT, o-series | model | `openai.svg` | none |
| `gemini` | Gemini | model | `gemini.svg` | `gemini-color.svg` |
| `glm` | GLM | model | `zai.svg` | none |
| `deepseek` | DeepSeek | model | `deepseek.svg` | `deepseek-color.svg` |
| `qwen` | Qwen | model | `qwen.svg` | `qwen-color.svg` |
| `kimi` | Kimi | model | `kimi.svg` | `kimi-color.svg` |
| `mistral` | Mistral, Codestral | model | `mistral.svg` | `mistral-color.svg` |
| `grok` | Grok | model | `grok.svg` | none |
| `llama` | Llama | model | `meta.svg` | `meta-color.svg` |
| `minimax` | MiniMax | model | `minimax.svg` | `minimax-color.svg` |
| `anthropic` | Anthropic, Claude Max, Claude Pro | company | `anthropic.svg` | none |
| `openai` | OpenAI, ChatGPT Plus and Pro | company | `openai.svg` | none |
| `google` | Google, AI Studio | company | `google.svg` | `google-color.svg` |
| `zai` | Z.ai, GLM Coding plan | company | `zai.svg` | none |
| `zhipu` | Zhipu (bigmodel.cn) | company | `zhipu.svg` | `zhipu-color.svg` |
| `moonshot` | Moonshot | company | `moonshot.svg` | none |
| `openrouter` | OpenRouter | company | `openrouter.svg` | `openrouter-color.svg` |
| `ollama` | Ollama | company | `ollama.svg` | none |
| `lmstudio` | LM Studio | company | `lmstudio.svg` | none |
| `groq` | Groq | company | `groq.svg` | none |
| `xai` | xAI | company | `xai.svg` | none |

Resolution, in `src/components/logo/resolve.ts`, built on `lib/models.ts`:

```ts
export type LogoId = /* ids above */;
export function harnessLogo(ref: string): LogoId | undefined;   // 'claude-code/...' -> 'claude-code'
export function modelLogo(ref: string): LogoId;                 // family from the model id; openrouter refs use the routed model
export function companyLogo(providerOrLimitId: string): LogoId; // 'claude-max' -> 'anthropic', 'codex' -> 'openai', 'zai-coding' -> 'zai'
```

`modelLogo` matches on the model id: `claude|opus|sonnet|haiku` to claude, `gpt|o\d|codex` to gpt, `gemini` to gemini, `glm` to glm, `deepseek`, `qwen`, `kimi|moonshot` to kimi, `mistral|codestral|devstral` to mistral, `grok`, `llama` to llama, `minimax`. A harness ref with a known model (`claude-code/opus`) returns the harness for the session row and `claude` for the model picker row.

### 8.3 Mono or color

- **Brand color** (`-color` file when one exists) where the model or provider is the subject of the row and the logo is 14px or larger: the model picker, the Limits group header, the Running table model column, jurors in the jury ballot and tally, the Usage by-model table, provider rows in Settings and onboarding, the agent editor's model field.
- **Mono** (`currentColor`) everywhere else: meta lines, the session list, chat header meta, composer pickers, routine rows, the command palette, and every harness mark in every place. Mono logos take the color of the text next to them (`--fg-2` in meta, `--fg` in titles).
- Brands without a color file are always mono, in every place.
- Appearance setting "Logos: Brand colors / One color" (default Brand colors). One color forces mono everywhere.

### 8.4 Sizes

| Place | Size | Gap to text |
|---|---|---|
| Meta line (12px text) | 13px | 5px |
| Row and table text (13 to 14px) | 14px | 7px |
| Pickers and menus | 16px | 8px |
| Limits header, juror header | 16px | 8px |
| Provider rows (settings, onboarding) | 22px | 14px |
| Onboarding Done step summary | 22px | 14px |

Minimum 13px. Vertical alignment: `vertical-align: -0.16em` inline, or flex `align-items: center`.

A logo never stands alone without its name, except: the juror stack (up to five 14px marks with 3px gaps followed by "4 jurors") and the tally (marks after the count). Standalone logos carry `aria-label` with the name; logos next to their name are `aria-hidden`.

### 8.5 Fallback

Unknown provider or model: a monogram. 1 or 2 letters from the display name, Mona Sans 600 at 62% of the logo size, `wdth` 90%, `--fg-2`, inside a square of the logo size with a 1px `--rule-2` border and `--r-1` radius. Example: "LM" for an unknown local model. No color fill.

### 8.5a Trademarks

Provider, model and harness marks come from LobeHub's icon set (`@lobehub/icons-static-svg`, MIT). The license covers the SVG files; the marks themselves are trademarks of their owners. Conclave uses them only to identify the service a row refers to, never to suggest endorsement or partnership, and never alters their shapes. Settings > About carries one line: "Provider and model logos are trademarks of their owners and identify the service only. Icons by LobeHub, MIT license." (the text lives in `LOGO_NOTICE`, `src/components/logo/registry.ts`).

### 8.6 `Logo` component

```tsx
<Logo id="claude" size={14} tone="auto" />   // tone: 'auto' | 'mono' | 'brand'
<ModelMark model="anthropic/claude-sonnet-5-5" size={14} />   // resolves via modelLogo
<HarnessMark harness="claude-code" size={13} />               // always mono
<CompanyMark provider="claude-max" size={16} />
<ModelName model="..." logo />  // logo + display name ("Sonnet 5.5"), the common case
```

`tone="auto"` means: brand if the place is in the list in 8.3 and the appearance setting allows it. The caller passes `tone="brand"` in those places; the default is mono.

Display names: write models the way their makers write them in prose: "Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "GPT-5.5", "GPT-5.5 Codex", "Gemini 3 Pro", "Gemini 3 Flash", "GLM-5", "Qwen3 Coder 30B", "DeepSeek V4". Raw ids appear only in the model picker's detail line and in tooltips.

---

## 9. The wave

### 9.1 Engine

Port `docs/design/reference/wave.js` to a TypeScript module, `src/components/wave/engine.ts`, with no globals. Keep the algorithm:

1. A grid of cells `gap` px apart, centered in the canvas.
2. For each cell with `u` (0 to 1 left to right) and `v` (-1 to 1 bottom to top), the variant field returns brightness `f`.
3. Add a stable per-cell grain (integer hash, plus or minus 0.03) so flat areas have texture that does not shimmer.
4. Quantize `f` into `levels` (4) with a 4x4 Bayer threshold: `lvl = floor(f*L) + (frac(f*L) > bayer[cy&3][cx&3])`.
5. One `Path2D` per level. Levels 1 to 3 use `--wave-ink` at alpha `0.18 + 0.6 * lvl/L` and radius `radius * (0.42 + 0.58 * lvl/L)`. Level 4 uses `--wave-hot` at alpha 1. Four `fill()` calls per frame.

Field functions: copy `hero`, `scope`, `strip`, `ambient` from the reference exactly. They are ours; tune constants only with design review.

Runtime rules:
- **One shared scheduler.** A single `requestAnimationFrame` loop drives every mounted wave at 30fps (skip frames under 33ms). Waves register and unregister.
- Backing store at `devicePixelRatio`, capped at 2 on phones (`pointer: coarse`) and 3 elsewhere. `ResizeObserver` resizes.
- `IntersectionObserver` pauses offscreen canvases. `visibilitychange` pauses all and freezes the clock, so a wave resumes where it stopped.
- `prefers-reduced-motion: reduce` or `static` prop: draw one frame at t = 6.0, never schedule.
- **Budget.** If a wave's draw takes more than 8ms on three consecutive frames, the engine raises its `gap` by 1px (up to 2x the start value). A full-bleed hero on a phone starts at gap 8.
- Colors read from computed style of the canvas (`--wave-ink`, `--wave-hot`) and re-read when `html[data-theme]` changes or the system scheme flips.

### 9.2 `Wave` component API

```tsx
// src/components/wave/Wave.tsx
type WaveVariant = 'hero' | 'scope' | 'strip' | 'ambient';
interface WaveProps {
  variant: WaveVariant;
  className?: string;      // the canvas fills its box; size it with CSS
  gap?: number;            // dot pitch px. Defaults: hero 7, scope 4, strip 3, ambient 6
  radius?: number;         // brightest dot radius px. Defaults: hero 1.25, scope 1.1, strip 0.9, ambient 1
  speed?: number;          // default 1
  amplitude?: number;      // default 1
  rate?: number;           // 0..1 activity level for strip and scope ripple. Default 0.6
  series?: number[];       // scope only: values 0..1, oldest first
  tone?: 'ink' | 'signal'; // signal sets both wave colors to --signal. Strip defaults to signal, others to ink
  static?: boolean;        // draw one frame (a finished run, reduced motion)
  label?: string;          // when set, role="img" and aria-label; otherwise aria-hidden
}
```

Changing props calls the engine's `set()`, which redraws without remounting. `rate` for a strip comes from the live tokens per second: `rate = clamp(tps / 60, 0.15, 1)`.

`LiveStrip` wraps the common case:

```tsx
<LiveStrip tps={38} startedAt={ts} word="Running" />   // strip 64x12 + "Running" in signal + elapsed 12:04 (tabular)
```

### 9.3 Placements

| Place | Variant | Size | Notes |
|---|---|---|---|
| Onboarding welcome, Connect screen | hero | full width, `clamp(280px, 52vh, 560px)` tall | gap 8, radius 1.4. Phones: 38vh, gap 8 |
| Onboarding step rail header | hero | 300 x 56 | gap 5, amplitude 0.5, speed 0.6 |
| Running table row, Inbox while a tool runs, key test, harness detection | strip | 64 x 12 | with `LiveStrip` word and elapsed |
| Chat, under the last event while a turn runs | strip | full text column width x 22 | gap 3, with "Writing" or the tool verb and tokens per second |
| Empty states | ambient | full width x 72 (phone 56) | under the sentence |

Never: session list rows (use violet elapsed text), nav, headers other than Home, settings, tables other than Running, dialogs, toasts, behind text, as a background. At most one hero or scope per screen.

When a run finishes, its strip gets `static` for 600ms, then is replaced by the result word.

### 9.4 Home scope details

Removed with the chat-first Home (11.1): Home opens on a chat, and model output per minute lives on the Usage page. The `scope` variant stays in the wave component and the gallery (`/dev/ui`).

### 9.5 Static frame

Every variant has a reduced motion frame at t = 6.0. Screenshots and visual tests use `static`.

### 9.6 Brand mark: the knot with a light

Decision (October 2026): the owner picked "Knot with a light" over a wave of seats and a ring of seats. It replaces both earlier marks, the seven dot wave (top bar, app icon, favicon) and the canvas Knot (Home, thinking), so the mark the app wears is the mark that thinks. The council ring and the wave of seven dots are retired.

The mark is the trefoil knot drawn as a ribbon with real over and under crossings, in the foreground color, with one violet light on it. The source of every asset is `docs/design/brand/knot.json`; `bun scripts/brand/knot.ts` writes them; the rules (clear space, sizes, colors, do and do not) are in `docs/design/brand/README.md`. Files to look at: `docs/design/brand/mark-dark.svg`, `mark-light.svg`, `mark-mono.svg`, `app-icon.svg`.

- Geometry: `x = sin t + 2 sin 2t`, `y = cos t - 2 cos 2t` in a 64 unit box, one lobe up. Six pieces, under and over by turns, each with its share of a path 100 long that starts at the bottom of the right lobe; halos in the color behind the mark at the three crossings. Stroke 5.2; 7 at 32px and under.
- Colors: the knot `currentColor` (`--fg`), the light `--signal`, the halos the surface behind. The light rests at home, 84 to 100 of the path: down the outside of the right lobe. One color contexts (notification badge, Android themed and notification icons): one color, no light, the crossings cut.
- Wordmark: "Conclave" in Mona Sans 600, `wdth` 110%, tracking -0.01em, 15px in the top bar, the knot 21px at a 9px gap (`Brand`). On onboarding the wordmark is `wordmark-xl` and the mark is not repeated next to it.
- Components: `Mark` (`size`, or the old `height`, which gives a box 1.5 times it; `mono`, `label`, `surface`) and `Brand` in `components/brand/Mark.tsx`; the moving mark is the Knot (`components/motion`, CHAT-AND-MOTION.md 1.3 and 1.7). Android: `Mark` and `Wordmark` in `ui/common/Brand.kt`, `Knot` in `ui/motion/Knot.kt`.
- App icon: the knot at 73% of a `#141417` tile (radius 14 of 64), knot `#ecebef`, light `#b592f0`. Favicon: 90% of the tile, heavier stroke. PWA maskable: 74% of a full square. Android adaptive icon: 56 of 108 dp with a monochrome layer. iPhone: a full square icon and a launch image on the light and the dark ground. Tauri: the whole set from one 1024px PNG.
- `CouncilRing` is deleted. The splash is the launch: the rope ties itself into the mark (`docs/design/KNOT-MOTION.md`).

---

## 10. Components

File locations are suggestions that keep five builders from colliding: shared pieces in `src/components/ui/`, logos in `src/components/logo/`, wave in `src/components/wave/`. Every interactive element has the focus style in 10.0.

### 10.0 Focus and states (all components)

- `:focus-visible`: `outline: 2px solid var(--signal); outline-offset: 2px; border-radius: inherit`. Inputs: border becomes `--signal` and gets `box-shadow: 0 0 0 1px var(--signal)`. Never remove focus without a replacement.
- Hover: `--bg-hover` fill on rows and quiet buttons, text to `--fg` on links and nav.
- Pressed: no transform; fill one step darker (`filter: brightness(0.94)` on solid).
- Disabled: text `--fg-4`, no hover, `cursor: default`, `aria-disabled`. Never a lower opacity on the whole element.

### 10.1 Sidebar nav

- The sidebar's rows (5.3): 32px, 13.5px, `--fg-2` with a 16px glyph in the same color, 10px gap, 8px radius. Hover `--side-hover` and `--fg`; current `--side-active` and `--fg`, `aria-current="page"`. No underline and no edge bar.
- Counts sit at the right, tabular: the Inbox count in `--warn` 500. Search shows its key (`⌘K`) in `--fg-4`.
- Quiet headings (the list's name, a group's name): 12px 500 `--fg-3`, no rule.
- The phone has no sidebar: the drawer (12.1).

### 10.2 List row

Two lines: title (`row-title`, `--fg`), meta line (`meta`, `--fg-3`). Right column: time on line 1 (`meta`, tabular), state word on line 2.

- Meta line is comma separated words, with a mono logo before a model or harness name: "coder, [cc] Claude Code" or "security, [z] GLM-5". Use commas, not middle dots, in the product.
- Padding 10px 12px. Hover `--bg-hover`. Selected: `--bg-raise` fill and a 2px `--fg` bar on the left edge (inset, no radius). This is the only edge bar in the product.
- States by word, right column line 2: `approve` and `answer` in `--warn`, `failed` in `--fault`, `waiting for reset` in `--fg-3` with the time ("resumes 15:42"), running shows elapsed `12m` in `--signal` (no strip here).
- Truncation: title one line with ellipsis; meta one line.

### 10.3 Section heading

`section` text (13/600) in `--fg`, then the count in `--fg-3` 450 tabular after 8px, then an optional text action at the right (12px, `--fg-3`, hover `--fg`). 9px bottom padding, 1px `--rule-2` rule under it. `h2` element. One variant: in the chat session list the "Waiting on you" group heading text is `--warn` (the word only, never the rule).

### 10.4 Buttons

| Kind | Look | Use |
|---|---|---|
| `solid` | `--solid` fill, `--solid-fg` text, 500 | The one primary action per region (Allow once, Start, Continue, Save) |
| `outline` | transparent, 1px `--rule-2`, `--fg` | Secondary actions, answer options |
| `quiet` | text `--fg-2`, no border, hover fill | Tertiary (Deny, Skip for now, Open session) |
| `danger` | quiet with `--fault` text, hover `--fault` 10% fill | Delete, Revoke, Deny in destructive contexts |

Heights: `sm` 26 (12.5px text), `md` 30 (13px), `lg` 38 (14px), `touch` 44 (15px, phones). Radius `--r-1`. Padding 12px (`lg` 18px). A `kbd` hint inside a button uses `currentColor` at 55% opacity with no fill.

Working state: no spinner. The label changes to the progressive verb ("Testing", "Saving", "Connecting") and the button stays the same width; where the action takes more than 1s, a `LiveStrip` appears next to the button, not inside it.

### 10.5 Inputs, selects and pickers

- **Input**: 34px tall (44 on phones), `--bg-sunk`, 1px `--edge`, `--r-1`, 10px padding, 13px text (16 on phones). Label above in 12px `--fg-2` 500, help below in 12px `--fg-3`. Keys, URLs, paths, cron in mono.
- **Invalid**: border `--fault`, and the reason as a sentence below in `--fault` ("Rejected with 401. This looks like an Anthropic key. OpenRouter keys start with sk-or-."). Never only a red border.
- **Textarea**: same, 1.6 line height, grows to 12 lines then scrolls.
- **Select**: a button showing the value plus `ChevronDown` 12px `--fg-4`; opens a menu (10.13). Never the native select on desktop; native on phones is fine.
- **Composer pickers**: text buttons inside the composer bar: optional label word in `--fg-3` ("Agent", "On"), value in `--fg-2`, logo before the model, chevron. Order: agent, model, device and folder, permission mode. Separated by 1px `--rule` vertical rules 14px tall.
- **Model picker** (popover, 380px wide, max 480px tall), in two levels like the Claude app's picker:
  - Search input at top, autofocus. Typing searches every model by name, id and maker and shows one flat list, each row with its maker's name; clearing it goes back to the makers.
  - First level: Recent (last 5 used, each picks at once), a rule, then one row per maker in this order: Anthropic, OpenAI, Google, Z.ai, then the others, then "Coding agents" (harnesses) last. A model sits under its maker whatever route reaches it (`makerOf`). A maker's row, 34px: brand company mark 16px, name `--fg` 500, at the right the current model's name in `--fg-2` when it is there, else how many models it has in `--fg-3` tabular, and a `ChevronRight`.
  - A maker's row opens its models in place: the list slides in from the right under a back row ("< [mark] Anthropic", `ChevronLeft`, 600) with the account state word at right ("key set", "Max", "rejected" in `--fault`, "not set" in `--fg-3`; none when other providers feed that maker). Back slides in from the left. The list keeps the height of its tallest level, so the popover does not jump or flip sides.
  - It opens on the current model's maker, with the back row; with no model (and for jurors) it opens on the first level.
  - Model row, 34px: brand color model logo 16px, display name `--fg` 500, then right aligned meta in `--fg-3` tabular: context ("200K") and price per million ("$3 / $15") or the plan word ("plan"). Current model shows a `Check` 14px at the far right.
  - Harness rows: mono harness mark, name, and where it can run ("arch-desktop, madx").
  - Keyboard: arrows move, Enter opens a maker or picks a model, Right opens a maker, Left or Backspace in an empty search goes back, Esc closes. Disabled rows (provider not set) show "Add key" as a quiet button that routes to Settings > Providers.
  - Phones: the same levels in the bottom sheet, rows 44px. Android's sheet (`ui/common/Pickers.kt`, `client/logic/ModelPicks.kt`) has the same levels, and the system back goes back to the makers.
  - Jury and debate member picking uses the same list with checkboxes and a footer "4 selected" plus the judge picker; a maker's row names the one picked there, or says "2 selected".
- **Segmented control** (On / Off, Light / Dark / System, ranges): text segments in a `--rule-2` outline, current segment `--bg-raise` with `--fg`, others `--fg-3`. Neutral ink, never accent.
- **Checkbox and radio**: 14px, 1px `--edge`, checked fill `--fg` with `--bg` check. Label to the right.

### 10.6 Tags as text

Tags, labels, projects and kinds are words in `--fg-3`, comma separated, in the meta line or a right column: "homelab, uni". Filtering by tag uses text links above the list ("All  homelab  uni  ctf"), current one `--fg` with a 1px underline at 3px offset. No chips, no hash signs, no colors.

### 10.7 Table

- No outer border, no zebra, no vertical rules. Header in `meta` `--fg-3` 450, 1px `--rule` under it. Rows split by `--rule`, 9px vertical padding. The last row has no rule.
- Numbers right aligned, tabular. Titles 500 `--fg`. Secondary columns `--fg-2`.
- Sort: click the header; the current sort column header is `--fg` with "ascending" or "descending" in `aria-sort`, and a text arrow (↑ ↓) after it.
- Phones: tables with more than 3 columns become list rows (title, meta line with the other columns as words, number at right).

### 10.8 Stat

A number in `stat` (20/540, tabular) with a label under it in `meta` `--fg-3`. A group of stats sits in a row split by 1px `--rule` vertical rules with 20px padding. At most four in a row. No box, no icon, no trend arrow, no sparkline. A delta, when needed, is a word under the label ("up 12% on last week" in `--fg-3`).

### 10.9 Meter and limit gauge

Two kinds only.

**Limit gauge** (usage limits only, Home and Usage):
- Segmented ticks: 24 segments, 2px gaps, 8px tall (6px on phones), segment radius 0.5px.
- Off segments `--meter-off`. On segments `--meter-on` below 70%, `--warn` from 70%, `--fault` from 90%. Threshold values come from hub config `ui.limitWarn` and `ui.limitFault` (defaults 70 and 90) and must not be hardcoded in components.
- Layout per window row: window name (`meta` `--fg-3`, 72px column: "5 hours", "Week", "Week, Opus"), gauge (flex), percent right aligned tabular in the same color as the fill (`--fg` when neutral). Under the row, when relevant: "resets in 1h 22m" (`meta` `--fg-3`, the countdown tabular). Prompt quotas show "396 of 600 left" instead of a percent label in the reset line.
- Blocked (provider refusing): percent shows "100%", fill `--fault`, reset line reads "Blocked. Resets at 15:42 (in 1h 22m)." in `--fault`.
- `role="meter"`, `aria-valuenow`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-label="Claude Max, 5 hours, 72%"`.

**Meter** (everything else: context window, cache hits, task steps, storage):
- A 3px tall bar, `--meter-off` track, `--meter-on` fill (signal for the live context window of a running session), radius 1.5px. Percent or fraction as text beside it. Same aria.

### 10.10 Card (when allowed)

Only the approval card (10.15) and the phone approval card. Anything else that looks like it wants a card becomes a section with rows.

### 10.11 Toggles and booleans

A boolean is a segmented "On / Off" (10.5). It appears in detail views (an agent's editor, a routine's editor, a settings section), with the label and a one line explanation on the left. Lists never end in toggles: a routine list row ends in its state word ("active", "paused") and a `MoreHorizontal` menu has Pause and Resume.

### 10.12 Dialog and sheet

- **Dialog**: centered, 480px wide (640 for the palette, 560 for confirm with code), `--bg-raise`, 1px `--rule-2`, `--r-2`, `--shadow-pop`, 20px padding. Title `title` 17/600. Body `body` `--fg-2`. Actions bottom right, 8px apart, primary last. `X` top right. Esc closes, focus is trapped and returns to the trigger. Scrim `--scrim`.
- **Confirm** for destructive actions names the thing: "Delete routine Server watchdog? Its 48 past runs stay in the history." Buttons: Cancel (quiet), Delete (danger, outline in `--fault`).
- **Sheet (phones)**: bottom sheet, full width, top corners `--r-3`, `--bg-raise`, 1px `--rule-2` top border, a 36 x 4 `--rule-2` grabber centered 8px from the top, max height 88vh, safe area padding. Swipe down or tap the scrim to close.
- **Side sheet (tablet, desktop below 1280)**: the chat context panel slides in from the right, 340px, `--bg`, 1px `--rule` left border, no shadow.

### 10.13 Menu and popover

`--bg-raise`, 1px `--rule-2`, `--r-2`, `--shadow-pop`, 4px padding, rows 30px with 8px padding, hover `--bg-hover`, `kbd` hints right aligned in `--fg-3`. Separators are 1px `--rule` with 4px margins. Group labels are `meta` `--fg-3`, sentence case.

### 10.14 Toast

Bottom left on desktop (24px from edges). On phones under the top bar, so a toast never covers a card's buttons or the composer; with a sheet open, above the sheet. A toast about an approval, a question or an alert is not shown while the page shows that item's row or card. `--bg-raise`, 1px `--rule-2`, `--r-2`, `--shadow-pop`, max 420px. One line of text plus at most one text action ("Undo", "Open"). Auto dismiss after 5s unless it needs the owner; hover pauses. Failure toasts start with the word "Failed." in `--fault`. No icons. At most 3 stacked, newest at the bottom.

### 10.15 Approval card

```
Run this command on madx?                                    Waiting 2 min
Verify PBS backups for all LXCs, sysadmin on [cc] Claude Code
+------------------------------------------------------------------+
| $ proxmox-backup-client verify --repository root@pam@pbs:tank ct/103 |
+------------------------------------------------------------------+
"Checking the latest snapshot of ct/103 before I move on. Read only."
[Allow once]  Allow for this session   Deny          Always allow...  Open session
```

- Box: `--bg-raise`, 1px `--rule-2`, `--r-2`, padding 14px 16px 16px. No edge stripe.
- Line 1: the question as a sentence, `body` 14/600 `--fg`. Built from the tool: Bash "Run this command on <device>?", Edit/Write "Edit <path>?" (path mono), WebFetch "Fetch <host>?", MCP "Use <server> <tool>?". Right: "Waiting 2 min" in `--warn`, tabular, ticking.
- Line 2: task title, agent, harness mark plus name (`meta` `--fg-3`).
- The command or diff preview: mono block with `--bg-sunk` fill and no border (allowed nesting), `$` prompt in `--fg-4`. Commands wrap by token (each token `white-space: nowrap`) so flags never split. Edits show the diff component, collapsed to 8 lines with "Show all 24 lines".
- The agent's stated reason, when present, in `--fg-2` with straight quotes, one line, clamp to 2.
- Actions: Allow once (`solid`), Allow for this session (`outline`), Deny (`quiet`, `--fault` on hover), then right aligned quiet "Always allow..." (opens a confirm showing the exact rule from `suggestedRule` in mono and where it is saved) and "Open session".
- Keyboard when focused: `A` allow once, `S` allow for session, `D` deny.
- After a decision the card collapses to a one line row: "Allowed once, 14:09" in `--fg-3` and fades out of Home after 4s.
- Phones: the card gets `--r-3`, 16px padding, Allow once full width `touch`, then Allow for session and Deny side by side, then "Always allow this command on madx" as a centered quiet link.

### 10.16 Question card

Not boxed. A row under the section rule: title (`row-title`) and time at right; then "GLM-5 asks: Which libc does the remote run?" (model mono logo plus name in `--fg-2`, the question in `--fg`, `body`). Then the options as `outline` buttons in one row (wrap on desktop, one horizontally scrolling row on phones), each option's description as its `title` tooltip and under the button on phones. Then "Reply" (quiet) which opens an inline input with Send. Multi-select questions show checkboxes and a Send button. Multiple questions in one request are numbered "1 of 2".

### 10.17 Tool call row

A log line in a 3-column grid: verb (`body` `--fg-2` 500, 64px column: Read, Edit, Bash, Search, Fetch, Agent, MCP), target (mono `--fg`, ellipsis), result (`meta` `--fg-3`, right, tabular: "48 lines", "done in 41s", "3 matches"). Rows split by `--rule`, 7px vertical padding. No box, no icon.

States:
- running: result column shows `LiveStrip` (64 x 12) and elapsed.
- done: result text.
- failed: result "failed" in `--fault`; expanding shows the error output in a code block.
- denied: result "denied" in `--fg-3`.
- waiting: "waiting on you" in `--warn` (the approval card renders in the thread right after).

Consecutive read-only calls (Read, Search, Glob, Fetch) collapse into one row: "Read 6 files, searched 2 times" with `ChevronRight`; click expands. Edit rows expand into the diff by default. Bash rows expand into terminal output when it is under 12 lines, else collapsed with "Show 140 lines".

### 10.18 Diff

- Header row (not boxed, above the block): verb "Edit", path in mono, `+3 −1` right aligned (`--ok` and `--fault`, tabular).
- Body: box `--bg-sunk`, 1px `--rule`, `--r-2`. Mono `code`. Columns: line number (`--fg-4`, right aligned, 36px), gutter sign (`+` `--ok`, `−` `--fault`, 14px), code. Added lines `--add-bg`, removed `--del-bg`. Hunk headers `@@ ... @@` in `--fg-3`.
- Syntax highlighting with the `--syn-*` tokens (highlight.js, custom theme).
- Long diffs collapse to 20 lines with "Show all 86 lines". Horizontal scroll inside the box, never the page.
- A "View file" quiet action in the header opens the full file in a sheet.

### 10.19 Code block

Box `--bg-sunk`, 1px `--rule`, `--r-2`, padding 10px 12px, mono `code`. Optional header line inside the box: language word in `meta` `--fg-3` and a `Copy` icon button at right (appears on hover and focus on desktop, always on phones). Shell blocks show `$` in `--fg-4` (not copied). Inline code: mono at 0.93em, `--bg-sunk` fill, 1px `--rule`, radius 3px, padding 0 4px.

### 10.20 Notice line

System events in a transcript or a page: one line, `meta` `--fg-3`, with a mono timestamp in the gutter, optional text action. Examples: "Compacted 46K tokens into 3K.", "Switched from Opus 5.5 to GPT-5.5.", "Rewound to 12:04. Files restored.", "Routine Morning brief started this session." Errors use `--fault` for the first word ("Failed. The hub lost the connection to arch-desktop."). No box, no icon.

### 10.21 Aside

A column section used in the chat context panel and Home's second and third columns: a section heading (10.3) then key and value rows: key in `meta` `--fg-3` (left, 96px column), value in `body` `--fg` (mono only when the value is a path, branch or id). Row padding 6px. No rules between key and value rows inside one aside; aside groups are separated by 24px.

Quotes (a dissent, a memory fact) inside asides or the thread: `--fg-2`, 1px `--rule-2` left rule, 12px left padding. Neutral, never colored.

### 10.22 Live indicator

- With room (64px or more): `LiveStrip` + state word in `--signal` + elapsed tabular in `--signal`.
- Without room: elapsed in `--signal` ("12m").
- Finished: the word becomes `--fg-3` ("done in 3m 12s").
- Screen readers: the row has `aria-live="polite"` on the state word only, not on the counter.

### 10.23 Empty state

An ambient wave band (72px), then one sentence in `body` `--fg-2` that says what will appear and how to cause it, then one action (`outline`). Left aligned with the column, not centered in the viewport. Examples:
- Routines: "Routines you schedule show up here with their next run." [New routine]
- Inbox: "Nothing is waiting on you. Approvals and questions from running sessions land here."
- Memory: "Nothing saved yet. Sessions write notes here when they learn something about you or your setup." [Add a note]
- Tasks: "No tasks. Add one, or start a session from a task to track its steps." [New task]

### 10.24 Jury and debate group

See the Chats page spec (11.2.5) for layout. Pieces:
- **Ballot table**: Model (brand logo 14 + name), Pick (600), Main reason (`--fg-2`, wraps, 2 lines then "more"), Time, Cost (tabular right). A running juror shows `LiveStrip` in the Pick column. A failed juror shows "failed" in `--fault` with the reason in the reason column.
- **Verdict**: a 2px `--fg` rule full width, then "Verdict" (`meta` `--fg-3`), then the verdict sentence in `verdict` size ("Use Caddy."), then the tally on the same baseline at right or below on phones: "3" (stat) + juror logos for the winning option, "1" + logos for each other option, in `--fg-2`. Then the judge's rationale (`prose`), then the dissent as a quote (10.21).
- **Criteria table** (when the judge produced one): rows are criteria, columns are options, winner column header 600. Same table style.
- **Juror answers**: each juror's full answer is collapsed under "Read Sonnet 5.5's answer" (quiet, with brand logo). Expanding renders it as a normal assistant message with the juror as speaker.
- Actions under the verdict: "Save as a note" (outline), "Ask all four a follow-up" (quiet), "Rerun" (quiet).

---

## 11. Pages

Every page except Home starts with a page header: `page-title` on the left, page actions on the right (at most one `solid`), 24px top padding, 20px below. No subtitle unless it carries state ("214 notes, 6 this week").

### 11.1 Home (`/`)

Route change: `/` renders Home (not a redirect to /chats).

Home opens on a chat, like claude.ai or ChatGPT, and the status page sits under it, compact and secondary. (The first version opened on the status sentence with a quick start bar and the output scope; the owner asked for a normal chat first.)

**The chat (top)**: a centered column 784px wide with 32px side padding, `clamp(40px, 10vh, 104px)` above it and 40px below.
1. The Knot (112px, 96 on phones; it writes a loop and a half, then settles), then the greeting, the same as on an empty Chat page (CHAT-AND-MOTION.md): "Good morning, Kai." with hub config `ui.name`, else "Good morning.". Morning is 5:00 to 11:59, afternoon 12:00 to 17:59, otherwise evening.
2. The new chat composer from the Chat page, three lines tall on desktop: attach, model with logo, Effort, Web and memory, and before Send a quiet switch, "Chat" (default) or "Session", whose menu lines up with the box's right edge. Enter sends, Shift+Enter adds a line, `/` focuses the box from anywhere on Home and Esc leaves it (so G shortcuts work). With a mouse and keyboard the first key typed on Home goes into the box; it does not take focus on load, so no caret blinks there and macOS draws no input source badge over the box's edge. Never on touch. Files dropped on the top of Home attach to it.
   - **Chat**: sending opens `/chat` at once with the message and the thinking mark, then `/chat/:id` with the reply streaming, with no blank frame. Back returns to Home. Someone who left before the hub answered stays where they are, and the chat shows up in Recent chats.
   - **Session**: the pickers become agent, model with logo, and device with folder, and the placeholder "Describe the task, or type / for commands". `/` opens the hub's commands in a menu, and a Resume line under the box offers the last session. Enter starts the session and opens `/s/:id` if you are still on Home; meanwhile "Starting the session, coder on arch-desktop" shows under the box. Default picks: what was picked here, else the last own session's agent, model, device and folder, else the default agent. An agent that no longer exists, or an offline device, falls back. The choice of Chat or Session is remembered per device.
3. **Waiting on you** (count, action "Open inbox"), 24px under the box, only when something waits: the oldest approval as a whole card (10.15), the other approvals as one line rows, then question cards (10.16), answered in place. On the first screen at 1180x800 and up, as the phone's Needs you.
4. **Recent chats** (action "All chats", 24px under the box, or under Waiting on you): 4 rows (3 on phones): title, model (logo 13 + name, desktop only), and at the right the relative time, the elapsed time in `--signal` while it answers, or "failed" in `--fault`.

**Status (below)**: a 1px `--rule` full width, then the status sentence at the left and the dateline at the right ("Saturday 17 October, 09:49", `meta` `--fg-3`, the time tabular and ticking each minute).
- The sentence in `status` style (15px 500 on desktop), built from data in this order: the waiting count in `--warn` ("Two are waiting on you.", skipped when 0) and the running count ("Two sessions running." / "Nothing running."), the running clause first when nothing waits. Chats never count. Then in `--fg-2` 400: a blocked plan ("Claude Max is blocked until 11:12."), else the nearest window at or over `ui.limitWarn` (default 70), else the next routine ("Next routine at 18:00, Uni deadlines."). Numbers one to nine as words, 10 and up as digits.
- The sections in columns split by 1px `--rule` with 28px on each side, 24px top padding. Wide (1280 and up): `1.6fr 1fr 1fr`, column 1 Today and Running, column 2 Limits, column 3 Routines today and Devices. From 900: two columns, `1.42fr 1fr`, column 1 Today, Running and Routines today, column 2 Limits and Devices. Under 900: one column. Waiting on you is not down here: it sits under the box (above).
- **Running** (count, action "All sessions"): rows: title (500) with the current plan step under it in `meta` `--fg-3` ("4 of 5, Running server tests"), model (logo 14 + name, or harness mark + name), elapsed (tabular), `LiveStrip` with tokens per second in `--signal`. Sessions waiting for a reset show "resumes 15:42" in `--fg-3` in place of the strip. Chats are not listed. Empty: "Sessions you start show up here. Switch the box above to Session to start one." in `--fg-3` (the sentence already says "Nothing running.").
- **Limits** (action "Usage"): one group per plan or provider with any window: header = brand company logo 16 + plan name (500) + plan detail in `--fg-3` ("Max", "Pro, Codex", "Coding"); then each window as a limit gauge row (10.9). Sorted by the highest percent first. Rows split by `--rule` between groups. Show subscriptions and plans; per-minute API rate windows only when above 50%.
- **Routines today** (action "Edit"): a 24 hour axis (00, 06, 12, 18, 24 mono `micro` `--fg-3`, hour ticks 4px `--rule-2`), finished runs as filled 6px circles in `--fg-2` (`--fault` if failed), scheduled as hollow 6px circles with 1px `--fg-3` stroke, recurring every-N runs as 1px x 8px ticks, the now line 1px `--signal` full axis height. Hover on a mark shows a tooltip with name, time, result. Under it a timetable: time (mono `--fg-3`, or "30 min" for interval routines), name (500) with its last result line in `--fg-3`, state at right ("done", "failed" in `--fault`, "next 14:30", "in 3h 52m"). A now row sits between past and future runs: the time in `--signal` mono plus a 1px `--signal` rule across the row.
- **Devices** (action "Pair a device"): rows: name (500), role or detail in `--fg-3` ("Hub, Proxmox LXC 104", "1 session running", "Last seen 9h ago"), state word right ("online" `--ok`, "offline" `--fg-3`).
- Gone from Home: the output scope, Spend, Memory learned and Tasks in progress. They live on Usage, Memory and Tasks.

**First day** (no session that is not a chat has ever existed, archived included): the sentence is "Nothing running yet." Column 1 holds an empty state: "Sessions you start show up here. Switch the box above from Chat to Session to start one, or import past sessions from Claude Code and Codex." [Import sessions]. Limits shows only when a plan is connected; Routines today offers "New routine".

**Phone**: see 12.3.

### 11.2 Chats (`/chats`, `/s/:id`)

Layout wide: session list 300px | conversation (fluid, text column max 860px centered with 32px padding) | context panel 316px, each split by 1px `--rule`. Desktop: context panel becomes a right side sheet toggled with `PanelRight` (state remembered). Tablet: list is its own view at `/chats`; a session opens full width with a back link. Phone: same, with the context panel as a bottom sheet from a "Details" text button in the header.

#### 11.2.1 Session list

- Top: filter input (30px, placeholder "Filter", `kbd` /) and "New" (`solid` sm, ⌘N).
- Groups by state first, then by time: "Waiting on you" (heading word in `--warn`), "Running", "Waiting for reset", then "Today", "This week", "Earlier". Group heading = `meta` 600 `--fg-3` with count, no rule.
- Rows (10.2): title; meta line "agent, [logo] model or harness"; jury rows "Jury of 4, verdict Caddy"; routine rows "Routine, [logo] Gemini 3 Flash". Right: time, then state word (`approve`, `answer`, `failed`, `resumes 15:42`, or violet elapsed when running).
- Archived sessions behind a text link at the bottom "Show archived".
- Search beyond titles: typing in the filter and pressing Enter runs full text search and shows hits with a snippet line (match in `--fg` 560, rest `--fg-3`).

#### 11.2.2 Transcript

- Header (sticky, `--bg`, 1px `--rule` bottom, 64px): title (`title`), meta line "coder on [cc] Claude Code, [claude] Sonnet 5.5, arch-desktop `~/code/conclave`". Right: state ("Running 12:04" in `--signal`, or "Finished 12:06" in `--fg-3`) and Stop (`outline` sm with `kbd` esc) while running; `MoreHorizontal` menu: Rename, Fork from here, Second opinion..., Compact, Export Markdown, Export JSON, Archive, Delete. The model picker under the composer switches models, on the web and on Android.
- Body is a log. Each turn: a mono timestamp gutter (48px, `micro` `--fg-3`), the author line ("You", or the model name with mono logo, or the agent name), then content. Owner messages are plain text in `--fg` (no bubble). Assistant prose in `prose` `--fg`, markdown: headings at 15/600, lists, tables (10.7), inline code, links underlined `--rule-2` hover `--fg-3`.
- Tool calls (10.17), diffs (10.18), terminal output (10.19), notices (10.20), approval cards (10.15) and question cards (10.16) appear inline in order.
- While running: the live line under the last event: "Writing" (or the tool verb "Running bun test") in `--signal`, tokens per second right aligned in `--fg-3`, and the full width strip (9.3) under it.
- Thinking blocks: one line "Thought for 12s" (`meta` `--fg-3`, `ChevronRight`), expanding to the text in `--fg-2`.
- Subagent runs: one row "Agent  Find all JWT usages, Haiku 5.5  done in 41s", expandable to its own log indented 16px with a 1px `--rule` left rule.
- New content fades in. The view sticks to the bottom while the owner is at the bottom; otherwise a "Jump to latest" quiet button appears above the composer.

#### 11.2.3 Composer

- One box at the bottom of the conversation column, max 860px, `--bg-sunk`, 1px `--rule-2`, `--r-2`, 12px padding. Textarea (`body`, grows to 12 lines). Placeholder: "Reply" when idle, "Reply, or steer the running turn" while running.
- Bottom bar inside the box: pickers (10.5) Agent, Model, On (device and folder, folder mono), permission mode ("Ask before edits", "Accept edits", "Plan only", "Bypass" in `--fault`); `Paperclip` attach; right: Queue (while running, `outline`) or Send (`solid`, or `ArrowUp` icon button on phones).
- Under the box: hints in `meta` `--fg-3` with `kbd`: "↵ send, ⇧↵ new line, / commands, @ files, esc stop".
- Mode picker for a new session: Agent, Chat, Plan, Jury, Debate, Loop as a segmented control above the box in the empty state only; inside a session the mode shows in the header meta.
- `@` opens a file picker menu (mono paths from the session device). `/` opens commands with descriptions.
- Attachments show as text rows above the textarea ("screenshot.png, 240 KB" with `X`), not chips.

#### 11.2.4 Session panel

A stack of rounded cards (12px radius, `--card`: raised in dark, white with a `--rule` hairline in light, 8px apart, 12px from the panel's edge), like the Claude app's session panel (`features/chat/ContextPanel.tsx`, CHAT-AND-MOTION.md 2.11). Each card is a 44px button: its title (13.5px 500) at the left, a short value in `--fg-3` at the right, and a `ChevronRight` that turns when it opens. Which cards are open is kept on this device. Docked at the right at 1280 and up (340px), a right sheet below.

1. **Environment** ("arch-desktop" and a green dot): Device with online or offline, Repository, Folder or Worktree (mono), Branch (mono), Syncthing conflicts, Permissions, the Task it is linked to (a menu), Tags.
2. **Context** (a 16px ring and "12%"; amber from 70%, red from 90%, signal while running): Tokens in, Tokens out, Cost; the Context and Cache hits meters; what fills it (system prompt, tools, messages, tool output, from `/context`) as rows with 3px bars; "What fills it" opens the /context sheet.
3. **Connectors** ("4 connected"): each MCP server (mono name, its tools or state) with On / Off for this session alone (/mcp); "Manage connectors" opens the /mcp sheet.
4. **Plan** ("3 of 5"), when the agent keeps one: numbered rows, "now" in signal, "done" in `--fg-3`.
5. **Outputs** ("2 files, 1 image"): files it wrote (the last write wins; a click opens the call's row in the transcript, or what it wrote), pictures its tools and replies made (open large) and html or svg pages (open in the preview, 2.7).
6. **Changes** ("+8 −6" in ok and fault): the changed files (a click opens the diff in the thread), the checkpoints with Restore (a confirm with "Restore files too"), and Create pull request for a repo session that can open one.
7. **Background tasks** ("2 running" in signal, else "3 finished"): running workflows and subagents (a link to the run or session, the elapsed time, Stop) and background shells (the command and its time; the agent stops those with KillShell), then "N finished" folded with each one's state word.
8. **Memory used** (a count), when facts were given: quoted, with "Edit memory".

The assistant's conversations have no Environment or Changes; a chat has Context, Outputs and Memory used. For a jury or debate: **This run** (Wall time, Cost, "3 of 4 agree"), **Jurors** (brand logo, name, output size right "2.1K out", judge marked "judge" in `--fg-3`), **Memory learned**.

#### 11.2.5 Jury and debate

- The owner's question as a normal turn.
- Then the group (10.24): "Jury" author line, ballot table, verdict block, criteria table, collapsed juror answers.
- While running: ballot rows fill in as jurors finish; rows still running show `LiveStrip`; the verdict area shows "Waiting for 2 of 4 jurors" in `--fg-3` and then "Judging" with a strip.
- **Debate**: rounds as subsections: "Round 1 of 3" (`section`), then each speaker's turn as a normal assistant turn (author = model with logo). After the last round: "Where they ended up" verdict block (sentence + tally of positions + remaining disagreement as a quote).
- **Second opinion** inside a normal session: a turn whose author line reads "Second opinion from [gpt] GPT-5.5", content as normal, with "Adopt" (outline) and "Dismiss" (quiet).
- **Switch** (docs/DESIGN.md 44): a notice line "Switched from Opus 5.5 to Sonnet 5.5." The new model reads the full history by default. With a short handover, which the owner picks, the summary comes first as its own line, "Earlier messages were summarized for the switch to Sonnet 5.5." with "Show summary", and the notice reads "Switched from Opus 5.5 to Sonnet 5.5 with a short handover: a 3K token summary and the recent turns, 9 old tool outputs cleared." In a chat over `context.switchBriefAt` (50K tokens), picking the model first shows what the switch costs (CHAT-AND-MOTION.md 2.12): "About $0.40 once, pays back after about 9 replies", Full history (default) and Short handover, and Ask once.

#### 11.2.6 Limit notice and waiting for reset

- When a provider refuses for a limit, the thread gets a notice block (not boxed): first line in `--warn`: "Claude Max 5 hour limit reached." second line `--fg-2`: "This session resumes at 15:42 (in 1h 22m) and picks up where it stopped." Then actions: "Switch to GPT-5.5 now" (outline, picks the configured fallback), "Pick another model..." (quiet; Android: Switch model; in a big chat it shows the switch's price first, 11.2.5), "Don't resume" (quiet).
- Session state "waiting for reset": header state reads "Resumes 15:42" with a countdown "1h 22m" (tabular, `--fg-3`). No wave (it is not working). The composer stays usable; sending queues the message ("Queued for 15:42").
- On resume, a notice: "Resumed after the Claude Max reset."

### 11.3 Inbox (`/approvals`)

- Page title "Inbox", subtitle count. Filters as text links: All, Approvals, Questions.
- Two column layout on wide: list 420px (rows: question sentence, task and agent meta, time and "Waiting 4 min" in `--warn`) and the selected item's full card on the right with 120 lines of session context above it (last assistant message and tool calls, read only) and "Open session".
- On desktop below 1280 and phones: one column of expanded cards, newest first.
- Bulk: select rows with checkboxes (on hover or when one is checked) then "Deny selected" (danger). No bulk allow.
- Resolved items stay for 10 minutes in a "Resolved" group ("Allowed once at 14:09", `--fg-3`) so a mistake can be traced; then they move to the audit log.
- Empty state (10.23).

### 11.4 Tasks (`/tasks`)

- Page title "Tasks", action New task (`solid`). Filters: project text links, agent select.
- Wide and desktop: a board of five columns (Inbox, To do, Doing, Review, Done) split by 1px `--rule` vertical rules, each with a section heading and count. Task rows are not cards: title (500), meta line (project, agent, due date "due Mon" in `--warn` when within 24h, `--fault` when overdue), priority as a word only for P0 and P1 ("urgent", "high") in `--fg-2`. Drag rows between columns (keyboard: focus a row, `[` and `]` move it). Done column shows the last 10 with "Show all".
- Row click opens a side sheet (480px): title (editable inline), description (textarea, markdown), status segmented control, project, agent, priority, due, labels (text input of comma separated words), linked sessions as rows with their state, and "Start a session" (`solid`) with agent, model, device pickers.
- Phones: one list grouped by status with the column names as headings; a status filter at the top.

### 11.5 Routines (`/routines`, `/routines/:id`)

**List** (`/routines`): page title "Routines", actions "Templates" (quiet) and "New routine" (`solid`). Wide: the 24 hour axis for today across the top (same as Home) at full width, then a table: Name (500) with its prompt's first line in `--fg-3` under it, Schedule in words ("Every 30 min", "Weekdays at 07:30", "Daily at 03:00") with the cron in mono in a tooltip, Next run (tabular, "in 6 min" or "14:30"), Last run ("done", "failed" in `--fault`, with time), Agent and model (mono logo + name), State ("active" `--fg-2`, "paused" `--fg-3`), `MoreHorizontal` (Run now, Pause or Resume, Duplicate, Delete). Phones: rows with name, schedule words, next run at right.

**Editor** (`/routines/:id`, also `/routines/new`): a 720px column with a sticky footer (Cancel quiet, Save `solid`, "Run now" outline when saved). Sections, each with a section heading:
1. **What**: Name input; Prompt textarea (`prose`, mono off); "Mode" segmented (Agent, Chat, Jury); Session policy segmented ("New session each run", "Keep one session").
2. **When**: Schedule input that accepts words or cron ("every weekday at 7:30", "*/30 * * * *", "@every 30m"); below it the parsed form in `--fg-2` ("Weekdays at 07:30, Europe/London") and the next 5 runs from `previewSchedule` as a mono list; errors in `--fault` from the preview. Timezone select.
3. **Who and where**: Agent select, Model picker, Device select, Folder (mono input with a browse button that opens the device file browser in a dialog).
4. **After a run**: Notify ("On failure", "Always", "Never" segmented), "Save a summary to memory" On / Off.
5. **Limits**: Max cost per run (number input with "$"), Timeout (minutes).
6. **Danger**: Delete routine (danger), with a confirm.

**Runs** (`/routines/:id` second tab, tabs are text links under the page title: "Settings", "Runs"): table: Started (date and time tabular), Trigger (schedule, manual, webhook), Duration, Result (summary first line, or error in `--fault`), Cost; row click opens the run's session. Running runs show `LiveStrip`.

**Templates** (dialog 640px, from "Templates"): rows: name (500), description (`--fg-2`), schedule words in `--fg-3`, "Use" (outline) which opens the editor prefilled. Starter set: Nightly librarian, Morning brief, Server watchdog, Uni deadlines, Backup check, CTF writeup reminder (whatever `routineTemplates()` returns, in that order).

### 11.6 Agents (`/agents`, `/agents/:name`)

Agents are words. No icons, no color tiles, no avatars. The `icon` and `color` fields stay in the data but are not rendered.

**List**: page title "Agents", action New agent (`solid`). Table: Name (500, mono off), Description (`--fg-2`, one line), Default model (mono logo + name, or harness mark), Tools ("12 tools"), Memory scope, Scope ("user", "project" in `--fg-3`). Row click opens the editor. Built-in agents have "built in" in `--fg-3` after the name and open read only with "Duplicate to edit".

**Editor**: 720px column, sticky footer (Cancel, Save). Sections:
1. **Identity**: Name (input, lowercase id rules shown as help), Description (one line).
2. **Instructions**: system prompt textarea (`prose`, 14 lines visible, markdown allowed), with a "Preview with memory" quiet link showing the final prompt in a code block dialog.
3. **Model**: model picker (brand logo), fallback model picker ("When the default is limited, use"), effort or thinking select when the model supports it.
4. **Tools**: a checkbox list of tool names (mono names allowed here, they are ids) grouped by source (Built in, MCP servers, Plugins), with a filter input. "Allow all" and "None" as quiet links.
5. **Permissions**: permission mode segmented; per-tool rules as a table (Pattern mono, Decision word, Remove quiet).
6. **Memory**: scope segmented (Global, Project, This agent), "Write what it learns" On / Off.
7. **Skills**: checkbox list of skills with descriptions.

### 11.7 Memory (`/memory`)

- Page title "Memory", subtitle "214 notes, 6 this week". Actions: "Add a note" (`solid`).
- Connection line under the title (`meta` `--fg-2`): "Basic Memory vault at `~/notes/conclave` on madx, synced 2m ago." or "Using the hub's own store." with "Change" link to Settings.
- Search input (full width of the column, 38px, "Search memory"), then filters as text links: kind (All, Profile, Facts, Procedures, Episodes) and scope (Global, Projects, Agents).
- List of notes, one per row, split by `--rule`: the content (`prose` `--fg`, clamp 3 lines, inline mono for IPs and paths), then a meta line: kind, scope or project, "from <session>" link, date, "used 4 times". Right: `MoreHorizontal` (Edit, Change kind, Delete). Edit is inline: the row becomes a textarea with Save and Cancel.
- Profile notes (always injected) are pinned at the top under a "Profile" section heading with a help line: "Always given to every model."
- Search results show the match in `--fg` 560 and a relevance number is not shown.
- Empty state (10.23).

### 11.8 Usage (`/usage`)

- Page title "Usage". Range as a segmented control: Today, 7 days, 30 days, This month, plus "Custom" opening two date inputs.
- **Stats** row (10.8): Spend, Tokens in, Tokens out, Cache hits, Sessions.
- **Cost per day**: an SVG bar chart, full width, 180px tall: one bar per day, 60% of the slot width, `--meter-on` fill, today `--fg`, radius 1px top only. Y axis 3 gridlines in `--rule` with `micro` mono labels in `--fg-3` ("$0", "$10", "$20"); X axis day labels every 7 days. Hover or focus on a bar shows a tooltip (menu style) with date, cost, tokens and the top 3 models. Bars are `role="img"` with an accessible table fallback via "View as table".
- **By model** (table): Model (brand logo + name), Sessions, Tokens in, Tokens out, Cache hits, Cost, Share (3px meter + percent). Sorted by cost.
- **By source** (table): Chat, Routines, Jury and debate, Gateway (CLI traffic through the hub), Harness sessions; columns Sessions, Tokens, Cost, Share.
- **Limits**: every provider and plan with all its windows as limit gauge rows (10.9), each group with: company logo + plan name, "read from OAuth 2 min ago" (source and age in `--fg-3`), and a "Refresh" quiet button that calls `refreshLimits()`.
- **Recent requests** (collapsed by default, "Show recent requests"): table of the last 100 with time, model, source, tokens, cost, latency.

### 11.9 Devices (`/devices`)

- Page title "Devices", action "Pair a device" (`solid`).
- Table: Name (500, inline rename on click), Kind and OS ("Arch Linux desktop", "macOS laptop", "iPhone", "Proxmox LXC, the hub"), State ("online" `--ok`, "offline" `--fg-3` with "last seen 9h ago"), Sessions running, Roots (mono paths, comma separated, `--fg-2`), `MoreHorizontal` (Browse files, Edit roots, Remove). The hub row has "hub" in `--fg-3` after the name and cannot be removed.
- **Pairing** (dialog 560px): two segments "Phone or another computer" and "Run commands on a machine (device agent)". Above the code, one line says which address it carries ("The code carries `https://quiet-river-lamp.trycloudflare.com`, Cloudflare quick tunnel."); when no outside address works, a line in `--fg-3` says so ("Away from home it will not work.") with "Turn on the quick tunnel" (`outline`), or "Try again" while the tunnel is failing, and "Other ways" (Settings > Remote access). A new best address makes a new code. Then the QR code from `createPairing().qrSvg` in a white box (the allowed QR well, `--r-2`, 16px padding, always white background for scanning, 200px), the pairing code in mono `stat` size with letter groups ("K7Q-4MZ-9TD"), a countdown "Expires in 9:42" tabular, and for a device agent three lines in a code block with Copy: the installer, `conclave daemon pair <address> <code>` and `conclave daemon install`. While waiting, a `LiveStrip` with "Waiting for the device". On success: "Paired arch-desktop." and the row appears.
- **File browser** (`/devices/:id/files?path=`): a two pane view: left (360px) a list of entries for the current path with a mono breadcrumb on top (each segment a link), rows: name (mono), size and modified date right (`--fg-3`, tabular), folders first and marked by a trailing "/" (no folder icons). Right: preview of the selected file as a code block (highlighted by extension, truncated notice "Showing the first 2,000 lines"), with "Start a session here" (`outline`) which opens the composer with that device and folder. Roots are listed at the top level. Phones: one pane at a time.

### 11.10 Settings (`/settings/:section`)

On a computer Settings opens over the page, like the Claude app's (`features/settings/SettingsPage.tsx` `SettingsOverlay`): a panel up to 1180 x 860 on the scrim, 16px radius. At its left, on `--side`, a "Search settings" field (Enter opens the first match) and the sections under quiet group names: **Settings** (Your account, People, Appearance, Notifications, Assistant), **Models** (Providers, Subscriptions, Accounts, Defaults), **Customize** (Permissions, Connected apps, GitHub, Maps, Calendar and mail, Browser, Gateway keys), **Platform** (Remote access, Friends, This computer, Audit log, Logs, About). At the right the section's title and line, its content, and `X`. The address stays `/settings/<section>`: deep links and reloads open it over Home, the page that was open stays under it (`lib/settingsRoute.ts`), the index replaces the address so Back and Esc close Settings at once, and a link out of Settings closes it and goes there. Phones: the index is a list page (the Inbox and More first, then the same groups); a section opens full screen with a back link; More (`/settings/more`) lists every page the drawer leaves out.

Index order: Providers, Defaults, Permissions, Notifications, Assistant, Gateway keys, Connected apps, Appearance, Audit log, Remote access, About. Hooks, MCP servers and Plugins moved to Extensions; their old Settings links redirect there.

Every section: page title (`page-title`), one line description in `--fg-2`, then groups of key and value rows: label (500) and one line help (`meta` `--fg-3`) on the left (50%), control on the right, 14px vertical padding, `--rule` between rows. Saves are immediate for booleans and selects (toast "Saved." only on failure), explicit Save button for text fields and code.

- **Providers**: the provider row (shared with onboarding, 11.11 step 2): company logo 22 (brand), name (500) and one line description; sign in method; key field or found login; result words at right ("Works, 7 models, 212 ms" with "Works" in `--ok`; "Rejected" in `--fault`; "Not set" `--fg-3`); `MoreHorizontal` (Test again, Change key, Base URL, Models, Remove). Expanding a provider shows: base URL input (mono), models list with checkboxes (enabled models), and the account plan if detected. "Add a provider" at the bottom opens a menu of all supported providers with logos.
- **Defaults**: default agent, default model (picker), fallback model, default device, auto resume after limit resets (On / Off), title generation model, per-kind defaults table ("Coding", "Homelab", "Uni", "Security research": agent, model, device).
- **Permissions**: default permission mode (segmented), rules table (Pattern mono, Tool, Decision word "allow" / "ask" / "deny", Scope, Remove), "Add rule" (outline), protected paths list (mono).
- **Hooks**: table of hooks (Event, Matcher mono, Command mono, Timeout), editor dialog with a code input for the command and a "Test" button that shows output in a code block.
- **MCP servers**: rows: name (500), transport ("stdio", "http"), command or URL (mono `--fg-2`), state ("connected, 14 tools" `--ok` word, "failed" `--fault` with the error line), `MoreHorizontal` (Restart, Edit, Remove). "Add server" dialog with name, transport, command or URL, env as key value rows.
- **Plugins**: Installed (rows: name, version mono, description, "enabled" or "disabled" word, menu with Enable or Disable, Remove), Marketplace (rows with "Install" outline), "Add a marketplace" (input with a git URL).
- **Notifications**: notifications stay inside Conclave (no outside services). "Devices": "Notify this device" (On / Off, which asks the browser or OS, then "Send a test" outline; Web Push in a browser, native notifications in the desktop app), the other browsers the hub notifies (name, "Added 3 Oct", quiet "Remove"), and a row for the Android app, which keeps its own connection. Then "Notify me about" as rows with On / Off: Approvals and questions, Failures, Limit resets, Routine finished, Session finished. Then "Hold notifications" (Never, 1 min, 5 min) while Conclave is in use.
- **Gateway keys**: explanation line ("Point Claude Code, Codex or OpenCode at the hub so their usage is tracked and routed."), table (Name, Device, Agent, Created, Last used, Revoke danger). "New key" dialog shows the key once in a mono code block with Copy and the env lines to paste.
- **Connected apps**: chatbots signed in to `/mcp` with OAuth (claude.ai, ChatGPT). Table: Name, Domain (mono), Can (scope words, comma separated), Added, Last used, Revoke (danger); phones get list rows. Under it, "Add Conclave to a chatbot": the connector URL in a code block, an amber line when the hub has only a quick tunnel or no outside address, and the custom instruction line. The consent page (`/oauth/consent`) sits outside the shell: a 56px top bar with the brand and "Signed in to <hub>", then a 600px column: the redirect host in mono as the headline ("claude.ai wants access to your Conclave"), the self-given name, an amber warning line when needed, the scopes as checkbox rows, where the answer goes in mono, and Allow (solid) and Deny (quiet), full width on phones.
- **Appearance**: Theme (Light, Dark, System segmented), Logos (Brand colors, One color), Text size (Small, Default, Large, Larger: a conversation's text only, with a reply line at the size picked; CHAT-AND-MOTION.md 6.5), Density (Comfortable, Compact: compact sets row padding to 6px and `body` 13px), Reduce motion (System, On, Off: Off keeps motion when the device asks to reduce it, as Windows does with Animation effects off).
- **Audit log**: table: Time (tabular), Device, Session (link), Action (mono tool name), Detail (`--fg-2`, ellipsis), Decision word. Filters by session and device. "Export CSV".
- **Remote access**: how phones and other computers reach the hub (DESIGN.md section 14). A status line ("On." in `--ok` then "Phones and computers reach the hub at this address." and the address in mono; "Starting." with a strip; "Not working." in `--fault` with the hub's error, which says what to do, and "Try again"), then Copy address and New address. "How devices reach the hub": radio rows with one line of help each: Quick tunnel ("suggested"), Stable address on your domain (Cloudflare API token, domain, name, Set up; Remove when set), Tailscale (Find it), My own URL (URL input), Local only. "Same network": Devices on this network (On / Off) with the address phones on the Wi-Fi use. "Addresses" (count): each with its kind, "in pairing codes" on the first, and a copy icon. "Pair a phone" with "Show a pairing code" (hidden while only this computer reaches the hub). "What an outside address exposes": one stacked row each for the web app, `/api`, `/mcp`, `/gw`, pairing and wrong tokens, then "Open the audit log". A footnote names the cloudflared version and path and whether its SHA-256 matched the one GitHub publishes.
- **About**: Hub (name, version mono, address mono, uptime), This client (version, platform), Connection (how this client reaches the hub, in words: This computer, Same network, Cloudflare quick tunnel, Tailscale or Internet; latency), Data (database path mono, size), "Import past sessions" (outline, opens the import step as a dialog), "Run setup again" (outline, routes to `/setup` with existing answers prefilled), "Sign out of this hub" (danger).

### 11.11 Onboarding (`/setup`)

When it runs: on a fresh hub (hub config `setup.completedAt` missing) the first client goes Welcome, then steps 1 to 10. A client that pairs with a hub that is already set up skips to a short device flow (11.11.12). "Run setup again" in Settings opens `/setup` at step 2 with answers prefilled. Progress per step is saved to hub config `setup.progress` so a reload resumes.

**Welcome** (full screen, no top nav):
- Top bar 48px: mark + "Conclave" + "Setup" in `--fg-3`; right: "Version 0.9.2" (`--fg-3`, version in mono) and "Restore from a backup" (link).
- Hero wave band (9.3) full width under the top bar, 1px `--rule` under it.
- Below the band, a two column row (8 / 4 of 12, 40px gutters): left the wordmark at `wordmark-xl`; right one paragraph in `body` 17/1.5 `--fg-2`: "Your models, agents, routines and usage limits in one place, served from a hub you run. Setup takes about five minutes and every choice can be changed later." ("a hub you run" in `--fg` 560), then actions: "Start setup" (`solid` lg), "I have a pairing code" (`outline` lg), and "Press ↵ to start" in `--fg-3` with `kbd`.
- Bottom: the procedure strip, 10 columns split by 1px `--rule` vertical rules, 1px `--rule` above: each cell has the index in mono `micro` `--fg-3` ("01"), the step name (500), one line in `meta` `--fg-3` ("Connect or create", "Keys and plans", "Claude Code, Codex", "Models per agent", "Basic Memory vault", "Past sessions", "Computer and phone", "What reaches you", "Starter set", "Open Home"). Phones: the strip becomes a vertical list under the actions with 5 rows visible and "and 5 more" link.

**Step layout** (steps 1 to 10): left rail 300px (`--bg`, 1px `--rule` right): mark and wordmark, the small hero band (9.3), then the numbered steps (mono index `--fg-3`, name; done steps show their value in `--fg-3` at right, "madx", "3 ready"; current step `--fg` on `--bg-raise` with the selected bar), and at the bottom the hub connection in words ("Connected to madx at `quiet-river-lamp.trycloudflare.com` over a Cloudflare tunnel, online", or "on this network", with "online" `--ok`). Right: content column 720px with 48px left padding: "Step 2 of 10" (`meta` `--fg-3`), `step-title`, one sentence lede (`body` 15 `--fg-2`, max 64ch), then the step content, then a sticky footer (1px `--rule` top, 64px): Back (quiet) at left; at right a summary sentence of this step's state, "Skip for now" (outline, on skippable steps) and Continue (`solid`). Phones: the rail becomes "Step 2 of 10" plus a 3px meter at the top; footer buttons `touch`.

Steps:

1. **Hub** "Connect to your hub". Connected: the result line ("Connected to madx, version 0.9.2, 38 ms.", `--ok` "Connected"), then key value rows: Address (mono), Network (how this client reaches it: "Same network", "Cloudflare quick tunnel", "Tailscale"), Machines ("madx and arch-desktop online"), Up for. Then "Reach it from your phone": "On the same Wi-Fi a phone can connect now. To use it anywhere else, pick a way in. The quick tunnel needs nothing else installed.", the remote access status line, and the same choice as Settings > Remote access, Quick tunnel suggested. Remote access stays off until the owner picks one. Not connected: input "Hub address" (mono, `https://hub.example.com`) + Connect (`solid`), and a token input when the hub asks for one ("Paste the token printed by `conclave serve`"). "No hub yet? Run the hub on this computer" link (desktop app only) which starts the bundled hub and shows its log in a code block with a strip while starting. Errors explain: "Could not reach madx on port 7717. Check that `conclave serve` is running. A quick tunnel address changes when the hub restarts, so scan a new code."
2. **Providers** "Add your providers". Two sections: **Found on this computer** (CLI logins detected through the hub: Claude Code login, Codex login, Gemini CLI login) with rows: logo, name ("Claude Max", "Through Claude Code"), what was found ("Found a Claude Code login on arch-desktop"), "Use this login" (outline) or result words. **API keys**: a table: Provider (logo 22 brand + name + one line), Sign in with ("API key", "No key" for Ollama), Key (mono input with the provider's prefix as placeholder, "Paste a key that starts with sk-or-"), Result (words). On paste or blur the key is saved with `setSecret` and tested with `testProvider`; while testing: `LiveStrip` + "Testing" + host in `--fg-3` ("api.z.ai"). Results: "Works  7 models, 212 ms" (`--ok` word), "Rejected  401, key revoked?" (`--fault`, input border `--fault`, explanation under the row), "Found  4 models on gpu-lxc" for Ollama. Rows: Anthropic, OpenAI, Z.ai (GLM Coding plan), Google Gemini, OpenRouter, DeepSeek, Moonshot, Ollama, then "More providers" link (Mistral, Groq, xAI, LM Studio, Qwen). Two footnotes side by side under the table: "Where keys live" ("On madx only, encrypted with the hub key. Phones and other computers never receive them.") and "Subscriptions" ("Claude Max and ChatGPT Pro run through their own CLIs. Conclave reads their limits so Home can show what is left."). Footer summary: "3 ready, 1 testing, 1 needs a new key".
3. **Coding agents** "Coding agents on your machines". Table per device: Harness (mono mark + name), Version (mono), Signed in as ("Claude Max", "ChatGPT Pro", "not signed in" `--fg-3`), State ("Found" `--ok`, "Not installed" `--fg-3` with the install command in a code block on expand). Detection runs on enter with a `LiveStrip` per device ("Looking on arch-desktop"). Toggle "Route through the hub gateway" On / Off per harness with help "Track their usage and limits here."
4. **Defaults** "Pick defaults". Rows: Default model (picker), Fallback when limited (picker), Default device. Then "Per kind of work" table (Coding, Homelab, Uni, Security research, Everyday) with agent, model, device pickers prefilled from what step 2 and 3 found. Summary: "Coding uses Sonnet 5.5 on arch-desktop."
5. **Memory** "Memory". Choice (radio rows with help): "Keep notes in the hub" or "Use a Basic Memory vault" (path input mono, "Test write" outline that writes and deletes a test note, result words). "Let sessions save what they learn" On / Off. "Profile" textarea: "A few lines about you that every model should know" prefilled empty with help, e.g. "Security student. Homelab on Proxmox. Short answers, no em dashes."
6. **Import** "Import past sessions". Per source rows (Claude Code, Codex, OpenCode) per device: harness mark, "214 sessions, 3 Mar to 15 Oct" (`--fg-2`), Import segmented ("All", "Last 30 days", "None"), progress while importing (`LiveStrip` + "Imported 120 of 214", then "Imported 214" `--ok`). Imported sessions become archived chats and seed memory if step 5 allows it.
7. **Devices** "Pair your devices". Two blocks side by side: "This computer" (name input prefilled "arch-desktop", "Allow sessions to run here" On / Off, roots as mono path rows with Add) and "Your phone" (QR box + code + countdown as in 11.9, state "Waiting for the phone" with a strip, then "Paired iPhone"). "Another machine" link shows the device agent install command.
8. **Notifications** "What reaches you". "Notify this device" ("Allow notifications" outline which asks the browser or OS, then "Send a test"), two notes (other computers and phones turn it on for themselves; the Android app keeps its own connection), then the events list as checkboxes (same keys as Settings). Defaults on: all of them.
9. **Routines** "Starter routines". Each template as a sentence row with editable time: "Every day at 03:00, the librarian files notes and merges duplicates." "Weekdays at 07:30, a morning brief with deadlines and failed jobs, sent to your phone." "Every 30 min, a server watchdog checks your containers." "Weekdays at 18:00, uni deadlines from Moodle and course calendars." Each with Add (outline) which becomes "Added" (`--ok`) and Undo. Times are mono inputs inline.
10. **Done** "Conclave is ready". An ambient wave band, then a summary list (rows with logos 22 for providers: "3 providers", "2 coding agents", "Basic Memory vault", "214 sessions imported", "2 devices", "3 routines"), each with "Change" link back to its step. Action "Open Home" (`solid` lg). Writes `setup.completedAt`.

**11.11.12 Device flow** (a new client on a hub that is set up): Connect (pairing code or address and token), then "Name this device", then Notifications for this device, then Home. Same step layout with 3 steps.

### 11.12 Connect (`/connect`, and whenever there is no saved connection)

Uses the Welcome layout with the hero band, without the procedure strip. Left: wordmark at 64px; right: "Connect to a hub" (`title`), then two segments "Pairing code" (default on phones) and "Address and token". Pairing code: one mono input with groups ("K7Q-4MZ-9TD"), device name input, Connect. Address: mono URL input (`https://hub.example.com`), token input (password type with Show), Connect. Errors explain (see step 1). Below: "New here? Set up a hub" link (desktop app) and the version.

### 11.13 Command palette (⌘K or Ctrl K, and the top bar field)

- Dialog 640px wide, top 15vh. Input 48px with no box inside the dialog (only a 1px `--rule` under it), placeholder "Search or run a command".
- Results in groups with `meta` 600 `--fg-3` headings: Actions ("New session", "New routine", "Toggle theme", "Pair a device", "Run setup again"), Sessions (title, meta with mono logo, time), Pages, Agents, Models (brand logo, "Use for this session" when a session is open), Memory (search hits, content line).
- Rows 34px, the current row `--bg-hover` with `kbd` "↵" at right. Shortcuts shown right aligned in `kbd`.
- Typing `>` limits to actions, `@` to sessions, `#` to memory. Empty query shows Recent sessions and the top 6 actions.
- Arrow keys, Enter, Esc. On phones the palette is a full height sheet opened from More > Search.

### 11.14 Keyboard shortcuts sheet (`?`)

Dialog 640px: title "Keyboard shortcuts", three groups as tables (action left `--fg-2`, keys right in `kbd`): Anywhere (⌘K palette, ⌘N new session, G then H/C/I/T/R/M/U/D go to page, ? this sheet, ⌘. toggle theme), Chat (↵ send, ⇧↵ new line, esc stop, ⌘↵ steer now, ⌘⇧C copy last code block, ] next session, [ previous session, ⌘\ context panel), Lists and Inbox (J/K move, ↵ open, A allow once, S allow for session, D deny, E archive). Shows ⌘ on macOS, Ctrl elsewhere.

---

## 12. Mobile

### 12.1 Shell

- The bar (56px + safe area top, no border): the menu button, the screen's title, New. MOBILE-V2.md 1.
- No tab bar. The drawer (`components/PhoneFrame.tsx`), as plain as the Claude app's: the Chat, Assistant and Code switch, New and Search, the Inbox while something waits on you (its count in `--warn`), the mode's conversations grouped as on a computer (5.3), Delegated work (5.3), All conversations, and the account row at its foot, whose menu (a sheet) has Settings. Every other page is under Settings: the Inbox and More at the top of its index, More listing Workflows, Routines, Memory, Extensions, Tasks, Goals, Agents, Usage, Devices, Map and the rest.
- Gutters 16px. Touch targets at least 44px tall. Commands wrap by token.

### 12.2 Gestures

Swipe back from the left edge on inner pages (native in WKWebView). Pull to refresh on Home, Chats, Inbox (the refresh indicator is the strip, 64 x 12, under the header). Long press on a session row opens its menu sheet.

### 12.3 Phone Home

The chat fills the first screen, a little above the middle: the mark, the greeting, the composer (attach, the model's logo, "Options", which opens a sheet with model, thinking, web and memory, the "Chat" switch and Send at 44px), then Recent chats with 3 rows. In Session mode the pickers fold into one text button ("coder, arch-desktop") that opens the Session sheet. At rest the foot of the first screen shows the rule, the dateline and then the whole status sentence in its short forms ("Two running. Two waiting on you. Claude Max blocked until 11:12."), never half a line. Further down: Waiting on you (approval cards using the phone card, then question cards with each option as a full width row), Running (rows: title, meta "[logo] Sonnet 5.5 on arch-desktop, 12m", strip 64 x 12 at right), Limits (5 hour windows only, one row each: company logo, plan name, "resets 1h 22m" `--fg-3`, percent right; gauge under it), Next routine (one row, action "All"), Devices (one line: "madx and arch-desktop online, macbook offline", action "Pair"). Section actions get a 44px tall hit area. Memory learned and Spend are on their pages.

### 12.4 Phone Chats

List full screen; a session opens full screen; header shows title and "Details" which opens the context panel as a sheet; the composer sits above the tab bar (tab bar hides while the keyboard is open); pickers in the composer collapse into one "coder, Sonnet 5.5, arch-desktop" text button that opens a sheet with the three pickers.

---

## 13. Copy

- Sentence case everywhere. No exclamation marks. No "Welcome back". No em dashes.
- Status sentences are built from data and say counts in words up to nine.
- Buttons are verbs: "Allow once", "Start setup", "Test", "Pair a device", "Add key". Not "OK" (except in a confirm that asks a yes or no question, where it is the verb: "Delete").
- Errors say what happened and what to do, in two short sentences.
- Empty states say what will appear and how to cause it.
- Model and product names as their makers write them: Claude Code, Codex, OpenCode, Gemini CLI, GLM-5, GPT-5.5, Sonnet 5.5, Z.ai, Proxmox, Tailscale.
- Time words: "in 6 min", "2m ago" in lists, "resets in 1h 22m", "resumes 15:42".

---

## 14. Accessibility

- AA contrast for all text (3.3). Focus visible on every interactive element (10.0).
- Every icon only button has `aria-label`. Logos follow 8.4.
- Live regions: Inbox count changes and new approvals announce politely ("New approval: Run this command on madx?"). Running counters are not announced.
- Meters and gauges carry `role="meter"` and a label. Charts have a "View as table" alternative.
- Dialogs trap focus and restore it. Sheets too.
- Hit targets: 24px minimum on desktop, 44px on phones.
- `prefers-reduced-motion` honored (7, 9.1). `prefers-contrast: more`: `--rule` takes `--rule-2` values and `--fg-3` takes `--fg-2` values.
- Language: `lang="en"`; numbers with units have accessible text ("72 percent").

---

## 15. Build notes

- Remove: `CouncilRing`, `ModelDot`, `ModelBadge` (the bordered mono chip), `AgentIcon` color tiles, `Spinner`, `ping-soft`, `orbit-pulse`, `--grid` and `--xh` tokens, all `uppercase tracking-*` classes, icon props in the settings section list.
- Add: `components/logo/*` (registry, resolve, Logo, ModelName), `components/wave/*` (engine, Wave, LiveStrip), `components/ui/*` per section 10 (Button, Input, Select, Segmented, Meter, LimitGauge, Table, Stat, SectionHeading, ListRow, Dialog, Sheet, Menu, Toast, EmptyState, Kbd, CodeBlock, Diff, Notice, Aside).
- Routes to add: `/` Home, `/setup`, `/connect`, `/devices/:id/files`, `/routines/new`.
- Hub config keys used by the UI: `setup.completedAt`, `setup.progress`, `ui.limitWarn` (70), `ui.limitFault` (90).
- Mock mode (`VITE_MOCK=1`) must cover every page and state named here, including: a session waiting for reset, a failed juror, a rejected key, an empty Memory, a first day Home.
- Screenshot QA per page: 1440x900 dark and light, 1280x800, 1024x768, 390x844 dark and light. Check the banned list (section 2) on each.

## 16. Packages to add

| Package | Why |
|---|---|
| `@lobehub/icons-static-svg` | Provider, model and harness logos (MIT), imported per file with `?raw` |
| `@fontsource-variable/mona-sans` | Already present; keep importing `standard.css` (wght and wdth axes) |
| `@fontsource-variable/jetbrains-mono` | Already present |

Nothing else is required. The wave and charts are our own code, and the pairing QR code arrives as SVG from the hub (`createPairing().qrSvg`).
