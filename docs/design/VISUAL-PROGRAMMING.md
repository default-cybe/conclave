# Visual programming: flows

The plan for building programs by connecting blocks on a canvas. Conclave turns the graph into real code in the project folder, and reads the code back into the graph. Written before the code; the code follows it. Paths are relative to `packages/core/src` unless they start with `packages/` or `docs/`.

Status: draft for the owner's review. Section 11 holds the open questions.

## 0. What the owner asked for

- Write programs by connecting blocks on a canvas, with no text code.
- Conclave turns the graph into real code in the project, on the owner's device.
- It fits what Conclave already does: Code sessions, agents that edit real folders, Preview, projects shared through GitHub.

One rule runs through the design: **the code file is the program.** The graph is a second view of that file. Nothing runs from the graph alone, and nothing about the program lives only in Conclave.

## 1. What it is

A **flow** is one TypeScript file in the project, `flows/<name>.flow.ts`, plus a small layout file, `.conclave/graph/<name>.json`. The owner opens it as a graph inside a Code session. Each block on the canvas is one statement in the file. Dragging a block in writes the statement; deleting it removes the statement; a wire is a variable passed from one statement to the next. When the owner, or an agent, edits the file as text, the canvas re-reads it and redraws. Run executes the file with Bun on the session's device. Each block shows its last value on its outgoing wire, and an error lands on the block that threw it. The agent in the same session can build or change the graph from a sentence in chat.

### 1.1 Three examples

Each row is one node. A wire is written as `from node.port`.

**Scrape a page to CSV** (phase 1 nodes only)

| # | Node | Settings | Inputs |
|---|---|---|---|
| 1 | Manual trigger | | |
| 2 | Value | `url` = `https://news.ycombinator.com` | |
| 3 | HTTP request | GET, as text | `url` from 2 |
| 4 | Parse HTML | select `.athing`, many | `html` from 3.body |
| 5 | For each | | `items` from 4.nodes |
| 5a | Pick field | `title` = text of `.titleline a`, `link` = attr `href` | `node` from 5.item |
| 5b | Collect | | `row` from 5a |
| 6 | Write CSV | path `out/hn.csv`, columns `title, link` | `rows` from 5.collected |
| 7 | Log | | `text` from 6.path |

**A REST API with two routes and a database** (phase 2)

| # | Node | Settings | Inputs |
|---|---|---|---|
| 1 | SQLite open | file `data/notes.db`, create table `notes(id, text, at)` | |
| 2 | HTTP route | `GET /notes` | |
| 2a | SQLite query | `select * from notes order by at desc` | `db` from 1 |
| 2b | Respond JSON | status 200 | `body` from 2a.rows |
| 3 | HTTP route | `POST /notes` | |
| 3a | Pick field | `text` from body | `body` from 3.body |
| 3b | If | `text` is empty | `value` from 3a.text |
| 3b yes | Respond JSON | status 400, `{ error: "text is required" }` | |
| 3b no | SQLite run | `insert into notes(text, at) values (?, ?)` | `params` from 3a.text, Now |
| 3c | Respond JSON | status 201 | `body` from 3b.no.row |
| 4 | Serve | port from `PORT`, default 3000 | routes 2, 3 |

**A Discord bot that summarizes a link** (phase 3)

| # | Node | Settings | Inputs |
|---|---|---|---|
| 1 | Secret | `DISCORD_TOKEN` | |
| 2 | Discord on message | channel `links` | `token` from 1 |
| 3 | If | message text starts with `http` | `value` from 2.text |
| 4 | HTTP request | GET, as text | `url` from 2.text |
| 5 | AI step | "Summarize this page in three lines", output text, model `fast` | `input` from 4.body |
| 6 | Discord reply | | `message` from 2, `text` from 5.text |
| 7 | Try/catch around 4 to 6 | on error: Discord reply "Could not read that link" | |

## 2. What we learned from other tools

| Tool | What it does | What we take | What we avoid |
|---|---|---|---|
| Enso | Code on disk is the source of truth; the graph is a view; node positions sit as metadata at the end of the file and are auto laid out when missing ([founder comment](https://www.reddit.com/r/Python/comments/mqbkgm/enso_20_is_out_visual_programming_in_python_java/)); each node is one line of code ([docs](https://help.enso.org/docs/getting-started/enso-graph-editor)) | Code wins; one statement per node; layout is optional metadata | A new language. We use TypeScript. |
| MakeCode | Blocks and Static Python both lower to Static TypeScript ([makecode.com](https://makecode.com/language)); code that cannot become blocks stays as a grey block ([pxt docs](https://github.com/microsoft/pxt/blob/v10/common/docs/blocks/javascript-blocks.md)) | One strict shape the parser knows; everything else becomes an opaque Code node, so nothing is lost | |
| Unreal Blueprints | Exec pins for order, typed data pins for values ([nodes](https://dev.epicgames.com/documentation/en-us/unreal-engine/nodes-in-unreal-engine)); conversion nodes on mismatched types ([connecting](https://dev.epicgames.com/documentation/en-us/unreal-engine/connecting-nodes-in-unreal-engine)); collapsed graphs, macros, functions | Two pin kinds; conversion nodes; reroute points; comment boxes | Binary assets that do not diff, and graph-to-C++ export: nativization was removed in UE5 ([reddit, quoting an Epic commit](https://www.reddit.com/r/unrealengine/comments/nt6szz/blueprint_nativization_is_gone_for_ue5_should_we/)), and a secondary source says it failed whole builds on unsupported nodes ([strayspark](https://www.strayspark.studio/blog/blueprint-nativization-ue57-when-convert-blueprints-cpp)) |
| Blockly | One generator per block per language; precedence-aware parentheses ([docs](https://docs.blockly.com/guides/create-custom-blocks/code-generation/block-code)); no code-to-blocks, because custom blocks emit arbitrary code ([group reply](https://groups.google.com/g/blockly/c/qyj3tzp8d5q)) | Templates per node, with parentheses by precedence | One-way generation |
| Node-RED, n8n | Flat JSON node arrays; untyped messages; function code stored as an escaped JSON string | Subflows and link nodes as ideas | Unreadable JSON diffs ([Node-RED forum](https://discourse.nodered.org/t/node-red-flow-review-process/74546), [n8n forum](https://community.n8n.io/t/how-does-everyone-handle-what-changed-in-n8n-workflows/298536)) |
| LabVIEW | The editor model is separate from the compiler IR ([NI](https://www.ni.com/en/support/documentation/supplemental/10/ni-labview-compiler--under-the-hood.html)) | Keep the canvas model separate from the code model | Binary VIs; auto layout that wipes the owner's arrangement ([NI forum](https://forums.ni.com/t5/LabVIEW-Idea-Exchange/Very-simple-improvement-on-Block-Diagram-Clean-Up-options/idi-p/3182323)) |
| Max/MSP | Order runs right to left, bottom to top ([docs](https://docs.cycling74.com/learn/articles/basicchapter05/)) | | Screen position as meaning. In a flow, order is the file's statement order. |
| ComfyUI Copilot, tldraw agent kit | The model returns small typed edits; code validates and applies them; a snapshot after each change ([dev.to](https://dev.to/_615564fae9eccc7753711/multiagent-architecture-practice-building-comfyui-copilot-v20-with-3k-github-stars-595), [tldraw](https://tldraw.dev/docs/ai)) | Typed graph edits for the agent; a checkpoint per edit | The model re-emitting a whole graph |
| Langflow | Ports are derived from the component class ([docs](https://docs.langflow.org/components-custom-components)); the assistant replaces the whole canvas to iterate ([docs](https://docs.langflow.org/langflow-assistant)) | Ports come from code, not a separate schema | Replace-the-canvas iteration |

The common complaint across all of them is that graphs do not diff, merge or review ([HN](https://news.ycombinator.com/item?id=19025639), [HN](https://news.ycombinator.com/item?id=41080644), [summary](https://drossbucket.com/2021/06/30/hacker-news-folk-wisdom-on-visual-programming/)). The second is that graphs stop being readable past a few dozen nodes ([Deutsch limit](https://en.wikipedia.org/wiki/Deutsch_limit), [HN](https://news.ycombinator.com/item?id=33620427)). Enso keeps 10 to 20 nodes on screen through hierarchy ([HN](https://news.ycombinator.com/item?id=27748738)). Section 3.5 and 3.6 answer both.

Two claims came from sources we could not check well: a VS Code extension that projects TypeScript into a graph with tree-sitter ([hyperion](https://github.com/hyperion-corporation/visual-graph-programming)) and an issue asking for a code to canvas to code round-trip test ([dynavec #292](https://github.com/codeforstartups/dynavec/issues/292)). They agree with the design but are not why we chose it.

## 3. The model

### 3.1 Two files per flow

| File | Who writes it | What it holds | Needed to run |
|---|---|---|---|
| `flows/<name>.flow.ts` | Conclave, the owner, any agent | The program. One `export async function main()` or a set of route and event handlers. | Yes |
| `flows/lib/*.ts` | Conclave, once per project, then anyone | The node helpers as plain, readable TypeScript (`httpRequest`, `parseHtml`, `writeCsv`). Each has a version line. | Yes |
| `.conclave/graph/<name>.json` | The canvas | Positions, groups, comment boxes, reroute points, collapsed state, the viewport, and the hash of the `.flow.ts` it last saw | No |

The code is the source of truth. The JSON holds only what code cannot: where things sit. If the JSON is deleted or stale, the canvas lays out the missing nodes and keeps the rest where they were. This is Enso's rule, with the layout in a side file so the `.ts` stays clean for the owner, `tsc` and other agents.

The layout file is diff friendly: keys sorted, one node per line, positions rounded to 8px.

```json
{
  "v": 1,
  "file": "flows/hn.flow.ts",
  "hash": "sha256:9f2c...",
  "nodes": {
    "page": { "x": 240, "y": 96 },
    "rows": { "x": 480, "y": 96 },
    "stories": { "x": 720, "y": 96, "collapsed": true }
  },
  "groups": [{ "title": "Fetch", "x": 200, "y": 40, "w": 520, "h": 200 }],
  "notes": [{ "text": "HN blocks bots after 30 requests a minute", "x": 200, "y": 280 }],
  "view": { "x": 0, "y": 0, "zoom": 1 }
}
```

### 3.2 The dialect: what a node looks like in code

The parser knows one strict shape, as MakeCode does. A node is one statement:

```ts
const <id> = await <helper>({ <settings and inputs> });
```

- `<id>` is the node's id and its label on the canvas ("page", "rows"). It is unique in its function.
- `<helper>` is imported from `flows/lib`. Its name picks the node kind from the catalog (3.3).
- Literal values in the object are settings. A reference to another node's id, or to a field of it (`page.body`), is a data wire.
- A statement with no `const` is a node with no output (`await log({ text: saved.path })`).
- `if`, `for (const x of ...)`, `try/catch` and nested `function` declarations are group nodes (3.4). Their body is more nodes.
- Order on the canvas follows the file's statement order. The canvas draws an exec wire between each statement and the next, as Unreal draws exec pins. Moving a node in the order moves its statement.

**Anything else is a Code node.** A statement the parser does not recognize becomes a Code node that holds its exact text. Its inputs are the node ids it reads, its outputs are the names it declares. It shows the text in mono and a line count. Nothing is dropped, so the round-trip is lossless for any file, in this dialect or not.

The scraper example in code:

```ts
// Flow "hn". Conclave draws this file as a graph (.conclave/graph/hn.json).
// Edit it as code or as a graph; each reads the other.
import { httpRequest, parseHtml, pick, writeCsv, log } from './lib';

export async function main() {
  const url = 'https://news.ycombinator.com';
  const page = await httpRequest({ url, as: 'text' });
  const stories = await parseHtml({ html: page.body, select: '.athing', many: true });
  const rows = [];
  for (const story of stories.nodes) {
    const row = await pick({ node: story, fields: { title: 'text .titleline a', link: 'attr .titleline a href' } });
    rows.push(row);
  }
  const saved = await writeCsv({ path: 'out/hn.csv', rows, columns: ['title', 'link'] });
  await log({ text: saved.path });
}

if (import.meta.main) await main();
```

A `const` with a plain literal is a Value node. `rows.push(row)` inside a For each is the Collect node. The last line is fixed boilerplate the parser hides.

### 3.3 The node catalog

The catalog (`flow/catalog.ts`) lists each kind: the helper name, its ports with types, its settings, its template, its phase, and a one-line help text. The canvas, the parser, the printer and the agent all read the same catalog. Helper source in `flows/lib` is generated from the same catalog, so the ports and the code cannot drift.

| Family | Kinds | Phase |
|---|---|---|
| Inputs | Manual trigger, Value, Secret (reads `process.env`), Argument | 1 |
| Inputs | Schedule, HTTP route, Read file | 2 |
| Inputs | Discord on message, Webhook | 3 |
| Outputs | Log, Write CSV, Write JSON | 1 |
| Outputs | Respond JSON, Respond text, Write file, Serve | 2 |
| Outputs | Discord reply, Send email (through the hub's mail draft) | 3 |
| Logic (groups) | If, For each, Collect | 1 |
| Logic (groups) | Try/catch, Function (subgraph), Wait | 2 |
| Data | Pick field, Parse HTML, Parse JSON | 1 |
| Data | Template text, Filter, Sort, Join text, Now, Convert (inserted on a type mismatch) | 2 |
| Libraries and APIs | HTTP request | 1 |
| Libraries and APIs | SQLite open, query, run (`bun:sqlite`) | 2 |
| Libraries and APIs | Call package: any exported function of an installed npm package, ports read from its `.d.ts` | 3 |
| AI | AI step: prompt template plus input, output text or JSON with a schema | 2 |
| Escape hatch | Code: a TypeScript body, inputs as named variables, outputs as the names it declares | 1 |

Phase 1 is 15 kinds. Manual trigger is `main()` itself. Every phase 1 kind has a deterministic template and needs no model.

### 3.4 Ports, types and edges

- **Two pin kinds**, as in Unreal: exec (order, drawn as a small triangle) and data (values, a circle).
- **Data types**, a short closed set: `text`, `number`, `bool`, `list<T>`, `record`, `rows` (a list of records), `bytes`, `html node`, `db`, `any`. The type is a word next to the port, not a color. SPEC 1.3 gives color one meaning each, so types cannot be colored.
- **Checks.** The canvas refuses a wire whose types do not fit and says why in the hover line ("rows does not fit text. Add Join text or pick a field."). For `number` to `text` and `text` to `number` it offers a Convert node, as Unreal does. Code nodes have `any` ports until a type annotation in their body says more.
- **Edges** are not stored anywhere. They are derived from which ids a statement reads. A wire drawn on the canvas writes the reference into the statement.
- **Reroute points** live in the layout file only. They have no code.

### 3.5 Groups and subgraphs

| Canvas | Code | Notes |
|---|---|---|
| If, For each, Try/catch | the block statement | A box with its body inside. Nodes cannot be dragged out by accident (React Flow `extent: 'parent'`). Collapsible. |
| Function | a `function` declaration in the same file, and a call node where it is used | "Collapse into function" extracts the selected nodes, as Enso's collapse does ([enso #2405](https://github.com/enso-org/enso/issues/2405)). Double click opens it as its own canvas with a trail back. |
| Comment box | nothing | Layout only. Nodes inside move with it, as in Unreal. |

The canvas shows one function at a time. Past 40 nodes in one function it shows a quiet line: "40 nodes here. Collapse a part into a function to keep it readable." This is the answer to the Deutsch limit: hierarchy, not a bigger screen.

### 3.6 Diff, review and merge

The program is a normal `.ts` file, so git diff, pull requests, code review and search work as they do for any code. The layout file is small and line oriented. A merge conflict in it is resolved by keeping either side; a wrong position costs nothing. Shared projects keep code on GitHub (SHARED-WITH-MEMBERS.md 5), so flows travel with the repository and each member opens them in their own Code session.

## 4. Graph to code, and code back to graph

### 4.1 The approach: code wins, the graph re-reads it

| Option | How it works | Why not |
|---|---|---|
| Graph is the truth, code is generated output | Blockly, Unreal, Node-RED export | Agents in Conclave edit files by hand all the time. Their edits would be overwritten or block the next generation. One-way export is also what Epic removed. |
| Generated regions with "do not edit" markers | Edits allowed only between markers | Agents and people ignore markers. A region edit still has to be read back. Two kinds of code in one file. |
| **Code is the truth, the graph is a view (chosen)** | Enso, MakeCode's grey blocks, Copilot Studio's "source of truth is always YAML" ([agent academy](https://microsoft.github.io/agent-academy/special-ops/yaml-specialist/)) | Needs a parser and a strict dialect. We accept that: it is one module with tests, and unknown code becomes Code nodes. |

Why this fits Conclave:

1. Every Code session already edits real files through Edit and Write, with checkpoints, the stale-read check and file conflict alerts (DESIGN.md 28). A flow edit is a file edit, so all of that applies with no new path.
2. An agent's hand edit can never desync the graph. The next read redraws it.
3. Git, review and diff work on day one, which is the top complaint about every tool in section 2.
4. The owner can leave Conclave and keep a working program.

### 4.2 Language: TypeScript on Bun first

| | TypeScript on Bun | Python |
|---|---|---|
| Runs with no build step | yes (`bun flows/hn.flow.ts`) | yes |
| HTTP server, SQLite, fetch, env, test runner built in | yes (`Bun.serve`, `bun:sqlite`, `fetch`, `bun test`) | needs packages |
| Same language as the hub, so the parser and catalog live in one codebase | yes | no |
| Parser for the dialect | TypeScript's own parser, `ts.createSourceFile` (Apache-2.0), syntax only, no type checking | would need a second parser |
| Paired devices have it | the daemon already runs where Bun can be installed; Run says how when Bun is missing | often present, but versions vary |

MakeCode made the same choice: one TypeScript core under several editors. Python can come later as a second printer and parser over the same catalog (section 9, question 1).

### 4.3 The pipeline

All of it runs on the hub, in a new module `flow/`. The files are read and written through the session's Machine, so the device can be any paired one.

| Step | Module | What it does |
|---|---|---|
| Parse | `flow/parse.ts` | `.flow.ts` text to a `FlowGraph`: functions, nodes with ids, kinds, settings, references, and each node's exact source span. Unknown statements become Code nodes with their text. |
| Layout | `flow/layout.ts` | Merges the layout file. Nodes without a position get one from a layered layout that keeps placed nodes still (LabVIEW's clean-up lesson: never move what the owner placed). |
| Edit | `flow/ops.ts` | Applies typed ops (`add`, `remove`, `connect`, `disconnect`, `set`, `move`, `wrap`, `unwrap`, `collapse`, `rename`) to the text. Each op replaces only its statement's span, as `tools/edit-core.ts` replaces a string. Comments, blank lines and formatting elsewhere stay byte for byte. |
| Print | `flow/print.ts` | Writes one statement from a node with the catalog template. Parentheses by precedence, as Blockly does. Used by Edit for new or changed statements only. |
| Helpers | `flow/lib-gen.ts` | Writes `flows/lib/*.ts` from the catalog the first time, and offers an update when the catalog version is newer. A helper the owner changed by hand is never overwritten; the canvas says "flows/lib/http.ts was changed here; kept". |

The web app never parses. It gets the `FlowGraph` over the API and sends ops back. The hub owns the text.

### 4.4 Where the agent writes code

| Case | Who writes the code |
|---|---|
| A catalog node with all settings filled | The template. No model. |
| A Code node the owner described in words ("keep rows from the last 7 days") | The session's agent writes the body, through the same op API |
| A kind the catalog lacks ("post to Mastodon") | Phase 3: the agent writes a new helper in `flows/lib/` with a typed signature. Its ports come from the signature, as Langflow reads ports from a class. It shows in the palette under "This project". |
| An error at run time | The owner asks the agent from the node's error line (6.3) |

### 4.5 Marking generated code

- The flow file starts with two comment lines (3.2): what it is and where its layout lives. No "do not edit" line, because editing is allowed.
- `flows/lib/*.ts` files start with `// Conclave flow helpers v<n>. Generated once; yours to change.`
- The parser recognizes a flow by the import from `./lib` plus the file name. Any `.ts` file the owner opens as a graph works; a file that is not in the dialect shows as Code nodes.

### 4.6 What happens on each kind of edit

| Edit | Result |
|---|---|
| The owner changes the graph | An op, a text splice, a write through the Machine, a re-parse. The canvas shows the re-parsed graph, so what you see is always what the file says. |
| An agent edits the `.flow.ts` with Edit or Write | The hub sees the write (the write tools already report it for file conflicts) and pushes `flow.changed`. The canvas re-reads. Nodes whose id survived keep their place. New nodes are laid out. |
| Someone edits the file outside Conclave (an editor, `git pull`) | The layout hash differs on next open, or the device's watch (when the session is live) reports it. Same re-read. |
| The edit renames an id | The node loses its position and is laid out again. A rename done on the canvas uses the `rename` op, which moves the position with it. |
| The edit breaks the syntax | The canvas keeps the last good graph, dims it, and shows the parse error with its line: "Line 14: ',' expected. The graph shows the last version that parsed." Editing on the canvas is paused until the file parses. |
| The edit is outside the dialect | Those statements become Code nodes. The canvas header counts them: "3 code nodes". "Turn into nodes" asks the agent to rewrite them into catalog nodes where it can. |

## 5. Running it and seeing it

### 5.1 Run

- **Run** in the canvas header runs `bun flows/<name>.flow.ts` on the session's device with `Machine.spawn`, in the session folder.
- It is a command like any Bash call: it goes through the session's permission mode and the Bash rules (`tools/bash-rules.ts`). The approval card shows the exact command. "Always allow" can cover `bun flows/*.flow.ts` for this folder.
- There is no extra sandbox in phase 1. The program runs as the owner's user on the owner's device, exactly as a Bash call from the agent does. The canvas says this once, on the first Run of a project. A container option is a later phase if the owner wants it.
- **Servers and bots** (Serve, Discord on message) run until stopped. A flow with Serve runs as a Preview launch (`browser/preview.ts`): the hub relays the port, the Preview pane shows the app, and the agent can use `preview_logs`. The REST API example opens in Preview on the route list.
- Secrets come from the project's `.env`, read by the Secret node through `process.env`. They are never written into the flow file or the layout file. Preview already refuses to serve dotfiles (`containedFile`).
- Stop kills the process. A flow left running is listed in the session's Background tasks.

### 5.2 Live values on edges

- Run sets `CONCLAVE_FLOW_TRACE=1`. Each helper then writes one JSON line per call to file descriptor 3: `{ "id": "page", "ok": true, "ms": 212, "value": "<preview>" }`. Without the variable the helpers write nothing, so the program runs the same outside Conclave.
- The value preview is cut to 2 KB and 3 levels deep. Strings that equal a value from `.env` are replaced with `***` before they leave the device.
- Code nodes get the same line from a thin wrapper the parser knows, keyed by the statement's line.
- The hub reads the lines and sends `flow.trace` deltas, at most 10 a second per flow, like the Map's deltas (DESIGN.md 29). Traces are kept in memory for the last run only. They are not stored.
- On the canvas: each wire shows its last value as a short label at its middle ("200 OK", "30 rows", "out/hn.csv"). A click opens the full preview in the inspector. A For each shows the count and the last item. A node that is running has a live elapsed counter in `--signal`, per SPEC 10.17; a node that finished shows its time in `--fg-3`.

### 5.3 Errors on the node

- A helper that throws writes `{ "id": "page", "ok": false, "error": "..." }`. An uncaught error from a Code node is mapped from its stack line to the node whose span holds that line.
- The node shows "failed" in `--fault` and the first line of the error under its title. The full error and stack open in the inspector as a code block.
- The inspector has **Ask the agent** under the error. It posts the error, the node's source and its inputs' last values to the session's chat.
- A parse or type problem before Run (an unconnected required input, a type mismatch from a hand edit) shows on its node as a notice line, and Run says which nodes need it.

## 6. AI

The canvas lives inside a Code session (section 7), so the session's agent is always there. It has the same device, folder, approvals and checkpoints as any Code session.

| Action | How |
|---|---|
| "Build me a scraper for X that saves a CSV" | The agent calls `flow_edit` with ops (6.1). The graph grows in front of the owner. |
| Select nodes and ask | Selected nodes go to the comment tray over the composer as one item ("3 nodes: page, stories, rows"), the way Preview's Pick does. The agent gets their ids, source and last values. |
| Explain a node | "Explain" in the inspector runs the hub's small model on the node's source, its catalog help and its last values, and shows three or four sentences. It does not change anything. |
| Fill a Code node from words | The owner types what it should do in the node; the agent writes the body. |
| Turn code into nodes | 4.6 |

### 6.1 How the agent edits the graph

- **Phase 1: plain file edits.** The agent edits `flows/<name>.flow.ts` with Edit and Write. Code wins, so the canvas follows. The session's instructions get a short note on the dialect when a flow is open. No new tool.
- **Phase 2: two typed tools.** `flow_read` returns the graph as compact JSON: nodes, kinds, settings, wires, last values, errors. `flow_edit` takes a list of ops from 4.3 and applies them in one write. This follows the ComfyUI Copilot and tldraw lesson: the model makes small decisions, code applies them, validates ids and types, and refuses a bad op with the reason. The model never re-emits the whole graph.
- Each `flow_edit` call is one session checkpoint (`session/checkpoints.ts`), so Restore in the session panel undoes it.
- The AI step node (phase 2) calls models through the hub's gateway (`/gw/openai`, DESIGN.md 8) with a gateway key made for the project. The key goes into `.env` as `CONCLAVE_GATEWAY_KEY`. Spend shows on the Usage page and the key can be revoked. Model names are the gateway aliases (`fast`, `smart`, `deep`), so the flow names no provider.

## 7. UI

### 7.1 Where it lives

The canvas is a view of a Code session, not a new top-level page. A session whose folder has a flow gets a **Chat / Graph** segmented control in its header. Graph replaces the transcript in the main column; the composer stays at the foot, so the owner can talk to the agent while looking at the graph. Preview docks at the right as it does today (`PreviewDock`). A new flow starts from "New flow" in the session's `...` menu, or from the agent.

| Width | Layout |
|---|---|
| wide (>= 1280) | Palette 240 at the left of the canvas, canvas, inspector 340 at the right in place of the session panel. Minimap at the canvas's bottom right. |
| desktop and tablet | Palette folds to a button that opens it as a popover. The inspector is a right sheet. |
| phone (< 768) | Canvas full screen under the 56px bar. Palette and inspector are bottom sheets. No minimap; Fit is in the header. |

### 7.2 Parts

- **Canvas.** Pan by drag on empty space, zoom with wheel and pinch, box select with Shift. No background grid or dots: SPEC 2 bans them. The surface is the page background; groups are a 1px `--rule-2` outline with their title, not filled boxes.
- **Nodes.** A node is a box (it is a different kind of object, SPEC 6), `--bg-raise`, 1px `--rule-2`, `--r-2`. Title in body text, kind in `meta` `--fg-3`, settings summary in one line. Ports are small circles (data) and triangles (exec) with their name and type as text. State is a word at the right of the title row: running (violet, with elapsed), failed (`--fault`), or nothing. Code nodes show their first lines in mono, which SPEC 4.3 allows for code.
- **Wires.** 1px `--fg-4` curves, `--fg-2` when a connected node is selected, `--signal` only while a value is passing on a live run. Value labels in `meta`.
- **Palette.** A search field and the catalog as plain rows by family, each with its one-line help. Drag a row onto the canvas, or tap it to add it after the selected node. On phones a tap adds and wires it.
- **Inspector.** The selected node's settings as SPEC 10.5 inputs, its inputs and outputs with last values, its source as a code block with "Edit as code" (opens the file at that line), Explain, and on failure the error and Ask the agent.
- **Header.** Flow name, Run or Stop, the code node count, the parse state, Fit, zoom.
- **Keys.** `R` run, `/` palette search, `Delete` remove, `G` group selection into a comment box, `F` collapse into function, `Enter` open a function or group, `Escape` back up.
- **Accessibility.** React Flow gives tab focus, Enter or Space to select, arrow keys to move, and `aria-live` announcements ([docs](https://reactflow.dev/learn/advanced-use/accessibility)). Ports can be connected by keyboard through the inspector's input selects, so no wire needs a drag. Touch targets are 44px on phones (SPEC 14); handles get an invisible 44px hit area.
- **Phone editing.** Tap to connect is on by default in React Flow (`connectOnClick`). In phases 1 and 2 the phone can view, run, read values and errors, tap to connect, change settings and ask the agent. Dragging nodes around on a phone is allowed but not tuned until phase 3.

### 7.3 Canvas library: React Flow

**`@xyflow/react` v12, MIT.**

| | React Flow | Rete.js | Litegraph | Drawflow | Blockly | Our own (like the Map) |
|---|---|---|---|---|---|---|
| License | MIT, "and it will be forever" ([pro page](https://reactflow.dev/pro)) | MIT | Original MIT; the maintained Comfy copy is now GPL-3.0 inside the ComfyUI frontend ([archive note](https://github.com/Comfy-Org/litegraph.js)) | MIT | Apache-2.0 | ours |
| React 19 | yes, peer `react >= 17` ([package.json](https://raw.githubusercontent.com/xyflow/xyflow/main/packages/react/package.json)) | yes, with `createRoot`; needs styled-components ([docs](https://retejs.org/docs/guides/renderers/react)) | no React layer | Vue bindings only, v0.0.60 | needs a wrapper | yes |
| Size (gzip) | about 60 KB ([bundlephobia](https://bundlephobia.com/package/@xyflow/react)) | core 3 KB plus plugins, total not measured | | about 9 KB | about 200 KB | 0 |
| Touch | pinch zoom, tap to connect | not documented | not documented | pinch, long press | not documented | pinch only |
| Accessibility | keyboard, aria-live | | | | the strongest (keyboard, screen readers) | none for editing |
| Subflows, minimap | built in ([subflows](https://reactflow.dev/learn/layouting/sub-flows), [minimap](https://reactflow.dev/api-reference/components/minimap)) | plugins | | | | to build |

Why React Flow: it is the only option that is MIT, React-native, touch-aware and accessible at once, and its state is Zustand, which the web app already uses. Its internal Zustand is v4 while the app is on v5, so two copies ship; the cost is a few KB. The Map's own canvas (`features/map/MapCanvas.tsx`) is a read-only view; building drag-to-connect, selection, keyboard editing and undo on it would cost more than the library. Blockly fits a separate blocks mode for beginners but not a graph canvas, and its code generators are one-way.

How it is used:

- Loaded only with the Graph view (`React.lazy`), so the rest of the app does not grow.
- Custom node and edge components styled with the SPEC tokens. The `Background` component is not used (SPEC 2 bans background grids). The default node and edge styles are replaced.
- Node components are memoized and never read the whole node list, per the performance guide ([docs](https://reactflow.dev/learn/advanced-use/performance)). The docs give no benchmark for large graphs; the 40-node line in 3.5 keeps each canvas small anyway.
- SPEC 16 gets one row: `@xyflow/react`, the flow canvas, MIT.

### 7.4 Android and desktop

Desktop (Tauri) loads the web app, so it gets the canvas with no extra work. Android shows a read-only graph in phase 3 from the same `FlowGraph` JSON, with Run, values, errors and Ask the agent. Editing on Android waits for the owner's call.

## 8. Phases

### Phase 1: one scraper, end to end

The smallest slice that is useful: the scraper example works on the owner's desktop.

| Part | Scope |
|---|---|
| Core | `flow/catalog.ts` with the 15 phase 1 kinds; `parse.ts`, `print.ts`, `ops.ts`, `layout.ts`, `lib-gen.ts`; TypeScript parser added to `@conclave/core` dependencies |
| API | `GET /api/sessions/:id/flows`, `GET /api/sessions/:id/flows/:name` (graph plus layout), `POST .../ops`, `POST .../run`, `POST .../stop`; `flow.changed` and `flow.trace` events |
| Run | Spawn on the device with the trace channel; values on wires; errors on nodes |
| Web | Chat / Graph switch in Code sessions (wide and desktop widths); canvas, palette, inspector, minimap; React Flow lazy loaded |
| AI | None new. The agent edits the file with Edit; the canvas follows. |
| Out | AI step, routes, servers, SQLite, functions, typed agent tools, phone editing, Android, Python |

### Phase 2: APIs, AI and the agent's tools

Template text, Filter, Sort, Convert, Try/catch, Function and collapse, Wait, Schedule, HTTP route, Serve through Preview, SQLite, Respond, Read and Write file, AI step through the gateway. `flow_read` and `flow_edit` tools with a checkpoint per call. Select nodes and ask; Explain; Turn into nodes. Phone layout with sheets and tap to connect. The REST API example works.

### Phase 3: integrations and reach

Discord and webhook triggers, Send email, Call package from `.d.ts`, project helpers as palette entries, Android read-only view. Then, if the owner wants them: Python as a second language, and a container for Run.

## 9. Test plan

| Test | What it checks |
|---|---|
| Round-trip, text first | For every file in a corpus (the three examples, the default workflow scripts as foreign TypeScript, hand-written edge cases with comments, odd spacing and CRLF): `print(parse(src))` equals `src` byte for byte. Foreign code survives as Code nodes. |
| Round-trip, graph first | Random graphs built from the catalog: `parse(print(g))` equals `g` (kinds, ids, settings, wires, order). |
| Ops keep the rest | Each op on a file with comments around the target changes only the target's span. Checked by diffing outside the span. |
| Hand edits | Apply the kinds of edit in 4.6 to a flow; the graph matches, positions survive for kept ids, a syntax error keeps the last good graph. |
| Helpers | Each phase 1 helper against a local fake HTTP server and a temp folder, with and without `CONCLAVE_FLOW_TRACE`. The trace line format is pinned. Secret values are masked. |
| Error mapping | A Code node that throws on line N pins the error to the node whose span holds N. |
| End to end | The scraper example runs with `bun` against the fake server in CI and writes the expected CSV. Later phases add the API example (requests against Serve) and the bot example with a fake Discord gateway. |
| Web model | Pure tests for the graph to React Flow mapping and the layout merge, like `test/map-model.test.ts`. |
| UI | Screenshot QA per SPEC 15 at each width in dark and light, the banned list checked, mock mode with a running flow, a failed node and a parse error. |

## 10. Risks

| Risk | What we do |
|---|---|
| Agents write code outside the dialect, and the graph fills with Code nodes | The dialect note in the session instructions; `flow_edit` in phase 2 so the agent edits by ops; the code node count in the header; Turn into nodes |
| Graphs get unreadable past a few dozen nodes | One function per canvas, collapse into function, the 40-node line |
| Running generated code on the owner's device | Same permission path as Bash, the exact command on the card, no extra powers. A container is a later option. |
| Secrets leak through traces or the layout file | Secrets only in `.env`; trace values masked against `.env`; traces kept in memory for the last run only; the layout file holds no values |
| The TypeScript parser adds several MB to the compiled hub | Syntax-only use; load it lazily on the first flow request. If the size is a problem, a smaller parser with TypeScript syntax can replace it behind `parse.ts`. |
| Bun is missing on a paired device | Run checks for `bun` first and shows how to install it, as Preview does for missing tools |
| The owner wants no code at all, but errors show code | Errors read as sentences first; the code is one click away, never the first thing shown |
| Some research sources are weak (a founder's comment, a dated forum post, two unverified repositories) | The choice rests on what Enso, MakeCode and Copilot Studio document and on Conclave's own file-editing model, not on the weak sources |
| Flows get confused with workflows | Workflows (DESIGN.md 18) orchestrate agents inside the hub's sandbox. Flows are the owner's own programs in his project. Different names, different places in the UI. |

## 11. Open questions for the owner

1. **Which language first?** Recommended: TypeScript on Bun. It needs no build step, has a server, SQLite and fetch built in, and shares a parser and catalog with the hub. Python can follow as a second language.
2. **Where should the canvas live?** Recommended: as a Graph view inside a Code session, beside the chat and Preview. It reuses the session's device, folder, agent, approvals and checkpoints. A separate Flows page can list flows across projects later.
3. **What happens when someone edits the code by hand?** Recommended: code wins and the graph re-reads it. Code the graph cannot show becomes a Code node with its exact text. Nothing is blocked or overwritten.
4. **How careful should Run be?** Recommended: the same as an agent's Bash command, with the exact command on the approval card and "Always allow" per folder. No container in phase 1.
5. **How should the AI step pay for models?** Recommended: through the hub's gateway with a key per project, so spend shows in Usage and the key can be revoked. Provider keys never go into the project.
6. **How much should a phone do?** Recommended: view, run, see values and errors, tap to connect, change settings, and ask the agent. Full drag editing on phones waits for phase 3.
