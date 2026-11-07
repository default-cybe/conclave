# Model picker, composer controls, and a quieter app

Design only. The clickable mock is at `/dev/picker-composer` in the mock build (`bun run --cwd packages/web dev:mock`), `?part=picker|composer|panel|sidebar` for one part. Code: `packages/web/src/components/dev/PickerComposerDesign.tsx`. Nothing here is wired to sessions yet.

## 1. Model picker

Today (`components/pickers/ModelPicker.tsx`): a two level list, makers first, then a maker's models by family; Effort at the foot.

New, one level:

1. **Search** at the top, focused on open.
2. **Maker row** under it: All, Anthropic, OpenAI, Google, Z.ai, Other. The `Segmented` control, the same look as Effort (SPEC 10.5). Other holds every other maker, local models and the coding agents. The row opens on the picked model's maker.
3. **List**, most capable first:
   - Pinned, then Recent (All only, three at most), then "*Maker*, most capable first".
   - Rank: rows that can be picked first, then catalog tier (deep, smart, fast, none), then context window, then output price, then newer (`compareModels`). A plan's copy of a model takes the catalog tier by name. Test: `packages/web/test/picker-design-rank.test.tsx`.
   - Each row: logo, name, maker (All only), "via *provider*" when it is not the maker's own. Under it, the capability line in `--fg-3`: "Deep, 1M context, $4 / $20, vision, tools, thinking". Price is "plan" or "local" when there is no per-token price. Words, no badges (SPEC 0.4, 10.6).
   - The unavailable reason replaces the line, in `--warn`. A maker with no key shows "No key for this provider" and Add key.
   - "via" on a row with several routes opens them below it, as today.
   - Pin: an icon at the right on hover. On a phone a long press pins, so rows carry no icon.
4. **Effort** for the picked model at the foot, unchanged.

Phone: a bottom sheet with the same parts; the capability line wraps to two lines.

## 2. Composer controls

Today the `+` menu holds the agent, memory, Ultra, web search, design direction and more. New: one place for each.

- Quiet row under the box, left: Permissions, folder, device (Code). Right: **agent**, **mode** ("Agent mode"; the menu has the six modes and Ultra under a rule), **memory** ("Memory", "Memory, use only", "No memory" in `--fg-3`), **model and effort**, the context ring. A chat shows memory and model only.
- `+` is files and add-ons only: Attach files and images, Search the web, Design direction, A GitHub repository. An add-on that is on says so in the box ("Web search on").
- Phone: the same controls wrap under the box. Each opens a sheet.

All are `PickerButton` / `SelectMenu` / `MenuList`; no new component or token.

## 3. Why the app looks busy (against Settings)

Settings works because each row is one line: a label at the left, one value at the right, details one click away. The main screens break that in these places:

1. Session panel: Context opens by default with three stats, two meters and four more meters (`features/chat/ContextPanel.tsx:243`, `store/ui.ts:82`). **Fixed in the mock**: one row per card, as Settings.
2. Sidebar session rows end in a device name and a colored dot (`components/Sidebar.tsx:405`). **Fixed in the mock**: title only; "running" or "waiting" as a word when it matters (SPEC 0.4 rule 2).
3. Five icon-only mode buttons in the sidebar head, and on a phone the Chat/Assistant/Code/Security/Canvas switch is clipped at 390 ("Ca") (`components/Sidebar.tsx:114`, `features/home/ModeSwitch.tsx:84`).
4. The composer `+` menu mixes files, agent, memory, Ultra and add-ons (`features/conversation/ChatComposer.tsx:540`, `features/chat/Composer.tsx:580`). Section 2.
5. A status line under the composer repeats the model, context and cost the panel already shows (`features/chat/Composer.tsx:702`, `features/conversation/ChatComposer.tsx:622`).
6. Preview and Open in Canvas as outlined buttons over the composer on every Code turn (`features/chat/BrowserLive.tsx:45`, `:68`).
7. The workflow card's six bar segments and "26 of 27 agents done, 1 failed" in the transcript (`features/workflows/WorkflowCard.tsx:206`). The summary line is enough until opened.
8. "52 tokens per second" beside Writing (`features/chat/MessageList.tsx:688`), and "Running 38:05" in the header at the same time (`features/chat/ChatView.tsx:171`).
9. Home on a phone stacks four status lines in two colors under the greeting ("4 need you", "2 proposals to approve", "Now: ...", "3 learnings ...") (`features/home/SessionStart.tsx`). One line, the rest in the Inbox.
10. Canvas lists every file twice, in the sidebar (mono) and the page (sans), one group per folder and device, each with one row (`features/canvas/CanvasPage.tsx`, `components/Sidebar.tsx:258`). One list, grouped by folder only.

## Screenshots

In `/home/conclave/work/cv-todo-design-shots/` (not in the repo): `picker-*`, `composer-*`, `panel-before-*` / `panel-after-*`, `sidebar-before-*` / `sidebar-after-*`, `audit-*`.
