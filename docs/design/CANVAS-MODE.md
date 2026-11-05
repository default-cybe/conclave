# Canvas mode

Status: design and clickable mock, branch `design/canvas-mode`. Not merged. Nothing here talks to the hub yet.
Reads with: `docs/design/SPEC.md` (house rules), `docs/design/VISUAL-PROGRAMMING.md` (the flow and graph model), the ComfyUI study (`/var/lib/conclave/outputs/ses_0mvkph0bphw3z49j5vt/comfyui-study.md`) and the graph canvas audit (`/home/conclave/work/cv-graph-fix-audit.md`, 15 findings on the canvas as it is today).

## 1. What it is

Canvas is the fourth top-level mode, next to Chat, Assistant and Code. It is a full-screen node editor that opens and works like ComfyUI and Unreal Blueprint. The owner opens a program (`flows/<name>.flow.ts` in a project folder on a device) or a workflow (his own or one from the library). It appears as typed blocks with ports on the left and outputs on the right. Each block has its settings on it as small widgets, and wires run left to right. He adds blocks from a library or by double-clicking the canvas, drags wires from port to port, and presses Run. Each block then shows its own state: queued, running with progress, done with its value, or failed with the error. The file stays the source of truth: every canvas edit is a text edit to the `.flow.ts` or workflow script, and "Edit as code" opens the same lines in Code. Canvas replaces today's graph boxes inside other screens. Those boxes are the cause of most of the audit's "broken" findings (1, 3, 7, 8): a canvas inside a scrolling page, with the inspector over it.

## 2. Entry points

| From | What happens |
|---|---|
| Mode switcher (sidebar top, `ModeSwitch.tsx`) | A fourth icon, `Spline` (lucide, house icon set). Picking it goes to `/canvas`. The mode is kept like the others (`conclave.mode`). |
| Home start box | Home in Canvas mode redirects to `/canvas`. That page is the start box: "Describe a flow" (an agent drafts the `.flow.ts` in a Code session, then the file opens on the canvas), a "where it lives" picker (program in project X on device Y, or a workflow of yours), and Start empty. The full list of files sits below. |
| Sidebar, Canvas mode | The session list becomes the file list (`features/canvas/files.tsx`). Programs are grouped by project, with the device in `--fg-4`. Then come Your workflows and Library workflows. A running file shows the quiet pulse dot. New row: "New flow". |
| Command palette | "Canvas" and "Open in Canvas: <file>" rows. Build step 1. |
| Deep link from a run | The run page and RunSheet get "Open in Canvas": `/canvas/workflow/<name>?run=<runId>`. The canvas shows that run's states, read-only while it runs. This replaces the List/Graph switch (`RunView.tsx`, `RunGraph.tsx`), audit 13. |
| Deep link from a `.flow.ts` file | `flowOpen.ts` today opens FlowView inside the Code session. It now navigates to `/canvas/program/<name>?device=<d>&cwd=<path>`. The "Blocks" pill in a Code session does the same. |
| Routes | `/canvas` (start), `/canvas/:kind/:name` with `kind` = `program` or `workflow`. |

## 3. Layout at 1440

Shots: `canvas-mode/canvas-1440-dark.png`, `canvas-mode/canvas-1440-light.png`.

- **App sidebar.** It folds to its 56 px strip while a file is open and comes back on leave (`setRailOpen`). The canvas gets the width without a new shell.
- **Top bar, 48 px.** File name in mono with a chevron. It opens a menu to switch file or go to All of Canvas. Then the place words ("Program, conclave, on arch-desktop, saved"), a rule, and the run status line ("Running 1:58, 2 of 8 done, 1 failed", tone word plus `Elapsed`). On the right: Undo, Redo, Stop (only while running), and Run. Run becomes **Queue run** while a run goes on: ComfyUI's Queue, with one run per file at a time and the next one waiting.
- **Node library, left, 248 px.** A search field, then families as group labels: Inputs, Agents, People, Data, Code, Flow. Each row is a title plus one line of help. Click adds the node next to the selected one. Drag drops it where you let go. Programs and workflows have different libraries (no Agent block in a program, no Write CSV in a workflow).
- **Canvas, centre.** React Flow, already installed. No background grid by default (see Q1). The canvas has pan, zoom, zoom buttons at bottom left and a minimap at bottom right. Groups are a 1 px `--rule-2` frame with a title (SPEC 2).
- **Inspector, right, 340 px, its own column.** It never covers the canvas (audit 7). With no node selected it shows file facts. With a node selected: name, state, a progress meter and time while running, the error plus "Re-run this node" and "Ask the agent" on failure, then the widgets at full size, the inputs and outputs with what they are wired to, the last value, and the node's code lines with "Edit as code".
- **Bottom panel, 208 px, folds to 36 px.** Tabs Output, Logs (count), Queue (count). Logs has one row per event: time, node, words. Failures are in `--fault`. Queue lists this hub's canvas runs with their state.

## 4. Layout at 390

Shots: `canvas-mode/canvas-390-light.png`, `canvas-mode/canvas-390-dark.png`, plus `extra-390-*.png`.

- **PhoneBar** with the file name, then a 36 px status line, then the canvas filling the rest of the screen. No page scroll exists, so the audit 3 scroll trap cannot happen.
- **The canvas opens on what matters:** the running node (else the failed one) and the nodes that feed it, at a readable zoom. The whole graph at 390 is too small to read.
- **Floating buttons at the foot, 44 px:** Nodes and Output on the left, Run on the right (Stop while running).
- **Bottom sheets** (`Sheet`): Nodes is the library with search, and Output has the bottom panel's tabs. Tapping a node opens the inspector as a sheet.
- **Touch.** One finger on empty space pans. Pinch zooms. One finger on a node drags it. Long-press (500 ms) on empty space opens node search at that point. Long-press on a node opens its context menu. The mock relies on the browser's touch `contextmenu` event here: Android Chrome fires it, iOS Safari does not. PR 3 adds a timer like the one on empty space. Drag from a port to another port makes a wire. Drop a wire on empty space and the search opens, then the new node comes pre-wired. Ports have a 44 px hit area (`pointer: coarse`, SPEC 14).

## 5. What opens and saves, and where it is listed

- **Programs.** `flows/<name>.flow.ts` in a project folder on a device, read and written by the existing flow service (`packages/core/src/flows/service.ts`, `routes-flows.ts`). Node positions go to `.conclave/graph/<name>.json`, as today. Every edit is a `FlowOp` turned into a text edit of the file and saved at once ("saved" in the top bar). There is no Save button and no draft state. The file on disk always matches the canvas.
- **Workflows.** Yours (editable, same model on the workflow script) and Library (read only). A library workflow shows a Notice with "Copy to yours". Runs go through the existing workflow runner.
- **Listed in:** the sidebar in Canvas mode, the `/canvas` start page, and the top bar file menu. All three use one list: programs of every project on every online device, then your workflows, then library workflows.

## 6. Interactions

1. **Add.** Double-click empty canvas opens node search at the cursor, and the node lands there (audit 9). Other ways: right-click "Add a node", the library (click or drag), `/`, or long-press on a phone. Search ranks title prefix first, then title word, then help (audit 10; `searchLibrary`, tested in `packages/web/test/canvas-search.test.ts`).
2. **Wire.** Drag from an output port to an input port. One wire per input: a new wire replaces the old one. Drop on empty space to open search, and the picked node is wired. Build step 2 adds type checks: a `json` output cannot go into a `diff` input, and valid ports light up while you drag (audit 12).
3. **Context menu.** Right-click, or long-press on touch. On a node: Run from here, Copy, Group, Edit as code, Remove. On empty canvas: Add a node, Paste, Fit to screen.
4. **Group.** Ctrl G, or the menu, wraps the selected node in a titled frame. Build step 2 adds drag-to-move for the group and box select.
5. **Copy and paste.** Ctrl C and Ctrl V. Paste lands at the cursor or the menu point, with a fresh name and no run state.
6. **Undo and redo.** Ctrl Z and Ctrl Shift Z, through `features/graph/history.ts` (the stack FlowView uses). A node drag is one step.
7. **Keys.** `Ctrl Enter` Run (Queue while running), `F` fit, `/` search, `Delete` or `Backspace` remove (audit 11), `Esc` close search, menu or selection. Keys do nothing while the cursor is in a field.
8. **Rename.** Build step 2: double-click a node title (audit 11, needs a `rename` FlowOp).

## 7. Run state on nodes

| State | Node | Elsewhere |
|---|---|---|
| queued | state word in `--fg-3`, normal border | Queue tab |
| running | `--signal` border and word. Foot shows a `Meter` with the step ("3 of 5 steps") and `Elapsed`. Wires into it are `--signal`. | status line, sidebar pulse dot |
| done | `--ok` word. Foot shows what it spent ("41 s, 12.4K tokens, $0.18"). Short values sit on the outgoing wire as a mono chip ("5 steps", "0 items"). | inspector "Value, last run" |
| failed | `--fault` border. The error sits on the node, up to 3 lines, and wraps. | inspector Notice plus Re-run and Ask the agent; Logs row in `--fault` |
| skipped | faded (60 % opacity) | Logs: "Skipped, top failed" |
| waiting | `--warn`, for Approve and Ask | Inbox as today |
| cached | `--fg-3` "cached": ComfyUI's "only what changed runs again" (Run from here) | |

A Code node always has a dashed border, whatever its state: hand-written code, as in the graph today. State words use the existing `stateTone` (`features/graph/nodes.tsx`), so run views and canvas say the same thing. A screen reader hears the status line (`aria-live`).

## 8. Reuse and new

**Reused as is:** `Button`, `Field`/`Input`/`Select`/`Textarea`/`OnOff`, `Menu`/`MenuList`, `Sheet`, `Tabs`, `Meter`, `Notice`, `Section`, `ListRow`, `StateWord`, `CodeBlock`, `Elapsed`, `Page`/`PageHeader`, `PhoneBar`, `toast`, `MOD` (Kbd), `useHistory`, `stateTone`, the `cv-dot-pulse` class, React Flow (`@xyflow/react`, already a dependency) with its `MiniMap` and `Controls`. Tokens only: no new color, font or token. The canvas CSS maps React Flow's variables to house tokens (`features/canvas/canvas.css`).

**Reused after the fix job lands:** `layout.ts` (left-to-right layout, audit 5), `nodeOf` run-to-node matching with its fallback (audit 2), `lineDiff` (audit 4). Canvas mode must not fork these.

**New in the mock:** `features/canvas/CanvasPage.tsx` (start page, editor shell, inspector, bottom panel), `CanvasGraph.tsx` (node with inline widgets and typed ports, node search, context menu, keys, long-press), `files.tsx` (sidebar list), `fixture.ts` (mock data and library), `canvas.css`. Mode wiring touches `start.ts`, `sidebar.ts`, `ModeSwitch.tsx`, `HomePage.tsx`, `Sidebar.tsx`, `PhoneFrame.tsx`, `App.tsx`, and one line each in `EmptyConversation.tsx` and `PhoneHome.tsx`.

**Retired once Canvas ships:** the List/Graph switch in `RunView.tsx`, `RunGraph.tsx` as a page box, FlowView inside the Code session (the Blocks pill becomes a link), and `GraphCanvas.tsx` once both callers move.

## 9. Risks

- **Two canvases at once.** The fix job is repairing `GraphCanvas.tsx`, `nodes.tsx`, `layout.ts` and `graph.css` on `fix/graph-canvas`. The mock does not touch those files. PR 2 must start after that branch merges and build on its layout and run matching, or the same bugs ship twice.
- **Text stays the truth.** Every canvas edit must be a clean text edit. The audit (4) shows a one-line insert diffing as the whole file today. Inline widgets that edit on each key press need a debounce, or the history fills with one step per letter.
- **Run-to-node mapping on real runs** (audit 2). Calls with dynamic labels and no `at` line map to no node. Without the fallback the canvas shows an idle graph during a real run, the worst case for this mode.
- **Remote devices.** A program lives on a device that may be offline. The canvas must open read-only from the last cached copy with a clear "arch-desktop is offline", never as an empty canvas.
- **Phone performance.** Live widgets on every node cost React renders. Measure 50 nodes on a mid phone before PR 3, and drop to read-only widgets under zoom 0.5 if needed.
- **SPEC 2 conflict.** The brief asks for a grid, but SPEC 2 bans background grids and dots (Q1).
- **Scope creep toward ComfyUI's node packs.** Custom node authoring stays out. "Code" is the escape hatch.

## 10. Build split (4 PRs)

1. **Mode shell, read-only canvas.** Mode wiring, `/canvas` start page, sidebar file list, command palette rows, and the editor layout at 1440 and 390, fed by the real flow and workflow APIs. Deep links from runs and `.flow.ts`. View plus run state, no edits. It depends on the fix job's merged `layout.ts` and `nodeOf`.
2. **Editing.** Node search, library drag, wires with type checks, context menu, copy and paste, group, rename, Delete, undo and redo, all as FlowOps through `routes-flows.ts`. Adds a `rename` op and the `/graph/restore` mock route.
3. **Run.** Run and Queue run, Stop, Run from here (cached nodes), and the bottom panel fed by the run journal. Touch polish: long-press, port hit areas, sheets.
4. **Retire the old boxes.** Remove the List/Graph switch and FlowView-in-session. Redirect old links to Canvas. Update `VISUAL-PROGRAMMING.md` and `DESIGN.md`.

## 11. Open questions for the owner

1. **Grid.** SPEC 2 bans background grids and dots, but ComfyUI has one. The mock keeps the house rule and can show dots with `?grid=1` to compare. Should Canvas get an exception?
2. **Which file opens first.** Should Canvas open on the last file you had open (like ComfyUI), or always on the `/canvas` start page?
3. **Saving.** Should edits save at once to the `.flow.ts` (the mock's model, with Undo as the safety net), or should edits stay in a draft until you press Save?

## Mock

Branch `design/canvas-mode`, worktree `/home/conclave/work/cv-canvas-mode`. Build with `VITE_MOCK=1 bunx vite build --outDir dist-mock` in `packages/web` and serve it as a single-page app. Pages to try: `/canvas`, `/canvas/workflow/review-and-fix` (mid-run, one failed node; Run plays a fake run), `/canvas/program/scraper` (failed at `top`), and `/canvas/workflow/fix-until-green` (library, read only). Things to try: double-click the canvas, right-click a node or empty space, drag a port, Ctrl Z, F, Delete, Ctrl Enter.
