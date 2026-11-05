# Visual programming: one canvas for programs and workflows

The plan for a node canvas in the style of ComfyUI and Unreal Blueprints, used for two things: building programs by connecting blocks, and showing, building and running Conclave workflows as node graphs. In both, Conclave keeps real code as the truth and the graph reads and writes it. Written before the code; the code follows it. Paths are relative to `packages/core/src` unless they start with `packages/` or `docs/`.

Status: workflow graphs shipped (0.4.62, 0.4.63). Programs from blocks, phase 1 is built (branch feat/flows): flat top-level statements instead of `main()` (Bun runs top-level await), the workflow tokenizer instead of `ts.createSourceFile`, 14 blocks plus Code, Run with Bun under the session's Bash approval, per-block traces on stderr behind a per-run nonce. Not in phase 1: if/for-each/try groups, functions as subgraphs, port types, Serve, agent graph tools, Python. Section 13 holds the open questions.

## 0. What the owner asked for

- "Visual programming: write programs by connecting blocks (no text code), and Conclave turns the graph into real code in the project."
- After the first draft: "like comfyui and unreal blueprint, see the concept with workflow." and "comfyui and its tools and widgets are on github you can take a look."
- It fits what Conclave already does: Code sessions, agents that edit real folders, Preview, workflows, projects shared through GitHub.

One rule runs through the design: **the code file is the program.** The graph is a second view of that file. Nothing runs from the graph alone, and nothing about a program or a workflow lives only in a canvas file.

## 1. What it is: one canvas, two uses

| | A. Programs | B. Workflows |
|---|---|---|
| What the owner builds | His own program: a scraper, an API, a bot | A Conclave workflow: agents, fan-out, checks, approvals |
| The file that is the truth | `flows/<name>.flow.ts` in the project | The workflow script, `<name>.js`, in `~/.conclave/workflows/` or `<project>/.conclave/workflows/` (`workflows/registry.ts:1-14`) |
| Runs where | Bun on the session's device (6.1) | The hub's QuickJS sandbox, as every workflow does today (`workflows/sandbox.ts:1-16`) |
| Live events | `flow.trace` from the helpers (6.2) | The events workflows already send: `workflow.agent`, `workflow.progress`, `workflow.phase`, `workflow.log` (`types.ts:925-931`) |
| Cache and re-run | None in a program; each Run is fresh | The run journal, keyed by each call's inputs (`workflows/run.ts:7-13`) |
| Where the canvas opens | Graph view of a Code session (9.1) | Graph tab on the Workflows page and in the run view (7.8) |

Both uses share the canvas core in section 3: the React Flow canvas, the node plugin interface, the node schema endpoint and its widgets, the parser and edit ops, the layout file, groups, reroutes and subgraphs, and the per-node live state. Only the catalog of node kinds, the dialect and the runtime differ.

### 1.1 Program examples

Each row is one node. A wire is written as `from node.port`.

**Scrape a page to CSV** (first program slice)

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

**A REST API with two routes and a database** (later program phase)

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

**A Discord bot that summarizes a link** (last program phase)

| # | Node | Settings | Inputs |
|---|---|---|---|
| 1 | Secret | `DISCORD_TOKEN` | |
| 2 | Discord on message | channel `links` | `token` from 1 |
| 3 | If | message text starts with `http` | `value` from 2.text |
| 4 | HTTP request | GET, as text | `url` from 2.text |
| 5 | AI step | "Summarize this page in three lines", output text, model `fast` | `input` from 4.body |
| 6 | Discord reply | | `message` from 2, `text` from 5.text |
| 7 | Try/catch around 4 to 6 | on error: Discord reply "Could not read that link" | |

### 1.2 Workflow examples

**fix-until-green as a graph** (today's built-in, `workflows/defaults/fix-until-green.js`)

| # | Node | Settings | Inputs |
|---|---|---|---|
| 1 | Args | `check` text, `maxRounds` number 5, `isolate` toggle | |
| 2 | Loop until | stop when 2a.ok, after `maxRounds`, or after 2 rounds with no fewer failures | |
| 2a | Check | command | `command` from 1.check, `worktree` from 2c.seq |
| 2b | Agent "diagnose" | agent type `debugger`, model `deep`, prompt with `{{check}}` and `{{output}}` | `output` from 2a.tail |
| 2c | Agent "fix" | agent type `builder`, isolation worktree, with meta | `diagnosis` from 2b.text, `output` from 2a.tail |
| 3 | Return | `{ green, rounds, history }` | from 2 |

The phases Check, Diagnose and Fix (`fix-until-green.js:6`) are the three groups the nodes sit in.

**A small review built on the canvas** (first workflow slice)

| # | Node | Settings | Inputs |
|---|---|---|---|
| 1 | Args | `task` text | |
| 2 | Agent "find" | agent type `explore`, model `smart`, schema `findings` | `task` from 1 |
| 3 | Parallel | one item per finding | `items` from 2.findings |
| 3a | Agent "verify" | agent type `verifier`, schema `verdict` | `finding` from 3.item |
| 4 | Approve | "Keep these findings?" | `text` from 3.collected |
| 5 | Return | | `findings` from 2, `votes` from 3, `ok` from 4 |

Running it lights up node 2, then fans out node 3 into one live row per finding, then waits at node 4 with the approval card.

## 2. What we learned from other tools

| Tool | What it does | What we take | What we avoid |
|---|---|---|---|
| ComfyUI | A node graph for image pipelines; the backend runs a small execution graph, caches outputs and sends node ids on every live event (2.1) | The run model, the live states, typed node schemas with widgets, groups and subgraphs | Its canvas code (GPL-3.0), positional widget values, global extension hooks, mouse-first input |
| Enso | Code on disk is the source of truth; the graph is a view; node positions sit as metadata at the end of the file and are auto laid out when missing ([founder comment](https://www.reddit.com/r/Python/comments/mqbkgm/enso_20_is_out_visual_programming_in_python_java/)); each node is one line of code ([docs](https://help.enso.org/docs/getting-started/enso-graph-editor)) | Code wins; one statement per node; layout is optional metadata | A new language. We use TypeScript and the workflow JavaScript. |
| MakeCode | Blocks and Static Python both lower to Static TypeScript ([makecode.com](https://makecode.com/language)); code that cannot become blocks stays as a grey block ([pxt docs](https://github.com/microsoft/pxt/blob/v10/common/docs/blocks/javascript-blocks.md)) | One strict shape the parser knows; everything else becomes an opaque Code node, so nothing is lost | |
| Unreal Blueprints | Exec pins for order, typed data pins for values ([nodes](https://dev.epicgames.com/documentation/en-us/unreal-engine/nodes-in-unreal-engine)); conversion nodes on mismatched types ([connecting](https://dev.epicgames.com/documentation/en-us/unreal-engine/connecting-nodes-in-unreal-engine)); collapsed graphs, macros, functions | Two pin kinds; conversion nodes; reroute points; comment boxes; collapse into a function | Binary assets that do not diff, and graph-to-C++ export: nativization was removed in UE5 ([reddit, quoting an Epic commit](https://www.reddit.com/r/unrealengine/comments/nt6szz/blueprint_nativization_is_gone_for_ue5_should_we/)), and a secondary source says it failed whole builds on unsupported nodes ([strayspark](https://www.strayspark.studio/blog/blueprint-nativization-ue57-when-convert-blueprints-cpp)) |
| Blockly | One generator per block per language; precedence-aware parentheses ([docs](https://docs.blockly.com/guides/create-custom-blocks/code-generation/block-code)); no code-to-blocks, because custom blocks emit arbitrary code ([group reply](https://groups.google.com/g/blockly/c/qyj3tzp8d5q)) | Templates per node, with parentheses by precedence | One-way generation |
| Node-RED, n8n | Flat JSON node arrays; untyped messages; function code stored as an escaped JSON string | Subflows and link nodes as ideas | Unreadable JSON diffs ([Node-RED forum](https://discourse.nodered.org/t/node-red-flow-review-process/74546), [n8n forum](https://community.n8n.io/t/how-does-everyone-handle-what-changed-in-n8n-workflows/298536)) |
| LabVIEW | The editor model is separate from the compiler IR ([NI](https://www.ni.com/en/support/documentation/supplemental/10/ni-labview-compiler--under-the-hood.html)) | Keep the canvas model separate from the code model | Binary VIs; auto layout that wipes the owner's arrangement ([NI forum](https://forums.ni.com/t5/LabVIEW-Idea-Exchange/Very-simple-improvement-on-Block-Diagram-Clean-Up-options/idi-p/3182323)) |
| Max/MSP | Order runs right to left, bottom to top ([docs](https://docs.cycling74.com/learn/articles/basicchapter05/)) | | Screen position as meaning. Order is the file's statement order. |
| ComfyUI Copilot, tldraw agent kit | The model returns small typed edits; code validates and applies them; a snapshot after each change ([dev.to](https://dev.to/_615564fae9eccc7753711/multiagent-architecture-practice-building-comfyui-copilot-v20-with-3k-github-stars-595), [tldraw](https://tldraw.dev/docs/ai)) | Typed graph edits for the agent; a checkpoint per edit | The model re-emitting a whole graph |
| Langflow | Ports are derived from the component class ([docs](https://docs.langflow.org/components-custom-components)); the assistant replaces the whole canvas to iterate ([docs](https://docs.langflow.org/langflow-assistant)) | Ports come from code, not a separate schema | Replace-the-canvas iteration |

The common complaint across all of them is that graphs do not diff, merge or review ([HN](https://news.ycombinator.com/item?id=19025639), [HN](https://news.ycombinator.com/item?id=41080644), [summary](https://drossbucket.com/2021/06/30/hacker-news-folk-wisdom-on-visual-programming/)). The second is that graphs stop being readable past a few dozen nodes ([Deutsch limit](https://en.wikipedia.org/wiki/Deutsch_limit), [HN](https://news.ycombinator.com/item?id=33620427)). Enso keeps 10 to 20 nodes on screen through hierarchy ([HN](https://news.ycombinator.com/item?id=27748738)). Sections 3.6 and 3.9 answer both.

Two claims came from sources we could not check well: a VS Code extension that projects TypeScript into a graph with tree-sitter ([hyperion](https://github.com/hyperion-corporation/visual-graph-programming)) and an issue asking for a code to canvas to code round-trip test ([dynavec #292](https://github.com/codeforstartups/dynavec/issues/292)). They agree with the design but are not why we chose it.

### 2.1 What we take from ComfyUI and Blueprints

From a source read of ComfyUI@bb878b9 (backend, GPL-3.0), ComfyUI_frontend@aa8c161 (GPL-3.0, with a vendored litegraph fork in `src/lib/litegraph`) and rgthree-comfy@bc48c6a (MIT). Line references are in those repositories.

**Take (ideas only, no code):**

| # | Idea | Where ComfyUI does it | Where it lands here |
|---|---|---|---|
| 1 | Two formats, one converter: a layout graph (nodes, links, groups, reroutes, subgraphs) and a small execution graph keyed by node id | `graphToPrompt`, `src/utils/executionUtil.ts:59` | 3.2. Our "execution graph" is the code; the parser is the converter. |
| 2 | Node ids on every live event: executing, progress, executed, error; state stored per node; the node outline lights up from it | `execution.py:505`, `:547`, `:583`; `executionStore.ts:153`; `LGraphNode.vue:21` | 3.7, a zustand store keyed by node id |
| 3 | Topological run, outputs cached by a key of inputs plus upstream, partial re-runs | `comfy_execution/graph.py:117`, `:321`; `caching.py:83`; `execution.py:1150` | 3.8. Workflows already have this as the journal. |
| 4 | One endpoint serving typed node schemas; widgets picked from input types (INT, FLOAT, BOOLEAN, STRING, COMBO); a seed widget with a control after each run | `server.py:892` (`/object_info`); `widgets.ts:58`; newer typed API `comfy_api/latest/_io.py:164`, `:1841` | 3.3 and 3.4 |
| 5 | Lazy inputs, and node expansion at run time | `execution.py:520`, `:370` | 3.8 and 7.5: branches that only run when taken, Parallel nodes that grow one row per item |
| 6 | Groups, reroutes, subgraphs | `workflowSchema.ts:383`, `:409` | 3.6 |

**From Blueprints:** exec pins for order and data pins for values; conversion nodes on a type mismatch; comment boxes that carry their nodes; collapse a selection into a function.

**Avoid:**

| # | What | Why | Instead |
|---|---|---|---|
| 1 | A large imperative canvas class | Hard to theme and to make accessible | React Flow with our own memoized node components |
| 2 | Positional `widgets_values` arrays | A new widget shifts every saved value | Widget values keyed by name. In code they are object keys already. |
| 3 | Global monkey-patch extension hooks (`types/comfy.ts:336-417`) | Plugins break each other and every upgrade | A typed node plugin interface (3.3) |
| 4 | Any GPL code | Conclave cannot ship it | Read for ideas; write our own |
| 5 | Mouse-first input; litegraph has no pinch-zoom | The owner uses Conclave on a phone | Touch, tap to connect and keyboard paths from day one (9.2) |

## 3. The shared canvas core

### 3.1 Code wins, for both uses

| Option | How it works | Why not |
|---|---|---|
| Graph is the truth, code is generated output | Blockly, Unreal, Node-RED export | Agents in Conclave edit files by hand all the time. Their edits would be overwritten or block the next generation. One-way export is also what Epic removed. |
| Generated regions with "do not edit" markers | Edits allowed only between markers | Agents and people ignore markers. A region edit still has to be read back. Two kinds of code in one file. |
| **Code is the truth, the graph is a view (chosen)** | Enso, MakeCode's grey blocks, Copilot Studio's "source of truth is always YAML" ([agent academy](https://microsoft.github.io/agent-academy/special-ops/yaml-specialist/)) | Needs a parser and a strict dialect. We accept that: it is one module with tests, and unknown code becomes Code nodes. |

Section 7.1 checks this choice again for workflows, where a JSON graph compiled to a script is the obvious other choice.

### 3.2 Two formats, one converter

As ComfyUI keeps a layout workflow and a small execution graph, each graph here has two formats.

| Format | What it is | Who writes it | Needed to run |
|---|---|---|---|
| The code | `flows/<name>.flow.ts` or `<name>.js` (workflow) | Conclave, the owner, any agent | Yes |
| `GraphModel` | What the parser makes from the code: functions, nodes with ids, kinds, settings by name, references, each node's source span. Never stored. | The hub, on each read | No |
| Layout file | Positions, groups, comment boxes, reroute points, collapsed state, the viewport, the hash of the code it last saw | The canvas | No |

The parser is the converter. Edges are not stored anywhere: they are derived from which ids a statement reads. If the layout file is deleted or stale, the canvas lays out the missing nodes and keeps the rest where they were. This is Enso's rule, with the layout in a side file so the code stays clean for the owner, `tsc` and other agents.

| Use | Layout file |
|---|---|
| Program | `.conclave/graph/<name>.json` in the project |
| Workflow | `<name>.layout.json` next to `<name>.js`. The registry loads only `*.js`, so it is ignored there. Built-in workflows get an auto layout and no file. |

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
  "reroutes": [{ "id": "r1", "on": "page.body>stories", "x": 360, "y": 160 }],
  "notes": [{ "text": "HN blocks bots after 30 requests a minute", "x": 200, "y": 280 }],
  "view": { "x": 0, "y": 0, "zoom": 1 }
}
```

One parser serves both uses: TypeScript's own `ts.createSourceFile` (Apache-2.0), syntax only, with `ScriptKind.TS` for programs and `ScriptKind.JS` for workflow scripts. The workflow loader keeps its own small tokenizer for `meta` (`workflows/meta.ts:54`); the canvas does not replace it.

### 3.3 The node plugin interface

Every node kind, for programs and workflows alike, is one plugin: a schema the hub serves, a code mapping that stays on the hub, and an optional React module for a custom widget. Nothing patches globals.

```ts
// graph/plugin.ts (hub)
export interface NodePlugin {
  kind: string;                       // 'flow.httpRequest', 'wf.agent'
  use: 'program' | 'workflow';
  family: string;                     // palette group: 'Agents', 'Data'
  title: string;
  help: string;                       // one line
  phase: number;
  inputs: PortSpec[];
  outputs: PortSpec[];
  widgets: WidgetSpec[];              // settings, keyed by name
  /** Recognize one statement. Returns settings and references by name, or null. */
  match(stmt: Statement): MatchedNode | null;
  /** Write one statement from a node. Parentheses by precedence. */
  print(node: GraphNode): string;
}

export interface PortSpec { name: string; type: PortType; required?: boolean; lazy?: boolean; many?: boolean }

export type WidgetSpec =
  | { name: string; type: 'text'; multiline?: boolean; slots?: boolean; default?: string }
  | { name: string; type: 'number'; min?: number; max?: number; step?: number; default?: number; afterRun?: 'fixed' | 'increment' | 'fresh' }
  | { name: string; type: 'toggle'; default?: boolean }
  | { name: string; type: 'combo'; options?: string[]; optionsFrom?: 'models' | 'agentTypes' | 'efforts' | 'workflows' | 'schemas'; default?: string }
  | { name: string; type: 'schema' }   // a JSON Schema, edited by the schema widget
  | { name: string; type: 'code'; language: 'ts' | 'js' };
```

```ts
// packages/web/src/features/graph/widgets.ts (web)
export interface NodeWidgetModule {
  kind: string;
  /** Replaces the default node body, e.g. the schema editor or a findings preview. */
  Body?: React.ComponentType<NodeBodyProps>;
  /** Extra inspector panel. */
  Inspector?: React.ComponentType<NodeInspectorProps>;
}
export function registerNodeWidgets(m: NodeWidgetModule): void;
```

- The hub owns `match` and `print`, so the web app never parses or prints code.
- A node with no widget module gets the default body: title, kind, a one-line settings summary, ports and the default widget for each setting (3.4).
- Built-in widget modules are lazy loaded by kind with the Graph view.
- Plugins (Conclave's plugin folders) can ship node schemas as JSON in a later phase. A plugin's React module would run third-party code in the web app, so it waits for its own trust decision (12).

### 3.4 Node schemas and widgets

`GET /api/graph/nodes?use=program|workflow` returns every plugin's schema without `match` and `print`. It is ComfyUI's `/object_info`. The canvas, the palette, the inspector and the agent's tools all read it, so they cannot drift.

The widget comes from the setting's type, as ComfyUI picks one from INT, FLOAT, BOOLEAN, STRING and COMBO:

| Type | Widget | Examples |
|---|---|---|
| `text` | One-line input; `multiline` gives a text area; `slots` turns `{{name}}` into an input port each | URL, the agent prompt |
| `number` | Number input with step buttons | `maxRounds`, a port |
| `toggle` | Switch | `isolate`, `many` |
| `combo` | Select. `optionsFrom` fills it on the hub: model aliases (`fast`, `smart`, `deep`), installed agent types, efforts, workflows, `lib.schemas` names | model, agent type |
| `schema` | A small JSON Schema editor: fields with name, type, required, description, and a raw JSON tab | the agent's output schema |
| `code` | Mono code block, opens in the file at that line | Code node body |

**Control after run.** Like ComfyUI's seed, a number widget can say what happens after each Run: keep it (`fixed`), add one (`increment`, e.g. a page number), or, on an Agent node, `fresh`: a `variant` number that is part of the call key goes up, so the next run asks the agent again instead of reusing the cached answer (7.6). Without it, an unchanged agent node replays.

All values are stored by name, in the code as object keys. There is no positional value array.

### 3.5 Ports and types

- **Two pin kinds**, as in Unreal: exec (order, drawn as a small triangle) and data (values, a circle). The canvas draws an exec wire between each statement and the next. `await` order is exec order.
- **Data types**, a short closed set per use. The type is a word next to the port, not a color. SPEC 1.3 gives color one meaning each, so types cannot be colored.

| Use | Types |
|---|---|
| Both | `text`, `number`, `bool`, `list<T>`, `record`, `any` |
| Program | `rows` (a list of records), `bytes`, `html node`, `db` |
| Workflow | `json<schema>` (a value that matches a named schema), `schema` (a JSON Schema itself), `files` (paths), `diff` (a unified diff, from `lib.diff`), `agent result` (the `withMeta` answer: value, seq, worktree, tokens, time; `workflows/agents.ts:41`), `check` (`{ ok, tail }` from `lib.runCheck`) |

- **Checks.** The canvas refuses a wire whose types do not fit and says why in the hover line ("rows does not fit text. Add Join text or pick a field."). For `number` to `text`, `text` to `number`, and `json` to `text` it offers a Convert node, as Unreal does. Code nodes have `any` ports until an annotation or a schema says more.
- **Lazy ports**, as in ComfyUI, are drawn hollow. Their value is only computed when the node needs it: the branches of If, and the body of Loop until. In code this is plain JavaScript: the code in a branch runs only when the branch is taken.
- **Reroute points** live in the layout file only. They have no code.

### 3.6 Groups and subgraphs

| Canvas | Program code | Workflow code | Notes |
|---|---|---|---|
| If, For each, Try/catch, Loop until | the block statement | the block statement | A box with its body inside. Nodes cannot be dragged out by accident (React Flow `extent: 'parent'`). Collapsible. |
| Phase | | `phase('Title')` up to the next `phase()` (`workflows/prelude.ts:64`) | A titled band. The titles match `meta.phases`. |
| Function / subgraph | a `function` declaration and a call node where it is used | a `const name = async (...) =>` helper, or `workflow('name', args)` (`prelude.ts:108`, one level only) | "Collapse into function" extracts the selected nodes, as Enso's collapse does ([enso #2405](https://github.com/enso-org/enso/issues/2405)). Double click opens it as its own canvas with a trail back. |
| Comment box | nothing | nothing | Layout only. Nodes inside move with it, as in Unreal. |

The canvas shows one function at a time. Past 40 nodes in one function it shows a quiet line: "40 nodes here. Collapse a part into a function to keep it readable." This is the answer to the Deutsch limit: hierarchy, not a bigger screen.

### 3.7 Live state per node

Each live event carries a node id. The web app keeps one zustand store per open graph, keyed by node id, and each node component reads only its own entry, so a busy run does not redraw the canvas.

```ts
type NodeLive = {
  state: 'idle' | 'queued' | 'running' | 'waiting' | 'cached' | 'done' | 'failed' | 'skipped' | 'parked';
  calls: number[];          // workflow call seqs on this node; empty for programs
  done: number; total: number;
  ms?: number; tokensIn?: number; tokensOut?: number; costUsd?: number;
  value?: string;           // short preview for the outgoing wire
  error?: string;
  lastTool?: string;        // from workflow.progress
};
```

| ComfyUI event | Program source | Workflow source |
|---|---|---|
| executing | the helper's first trace line | `workflow.agent` with state `running` |
| progress | | `workflow.progress` with `lastTool`, or `waiting: 'approval'` (`workflows/service.ts:204`) |
| executed | trace line with `ok: true` | `workflow.agent` with state `done` or `cached`, and the result |
| error | trace line with `ok: false` | `workflow.agent` with state `failed` |

How a node shows its state: a word at the right of the title row and a 1px outline. Running is `--signal` with a live elapsed counter (SPEC 10.17); failed is `--fault` with the first line of the error; waiting says "waiting for you"; cached says "cached" in `--fg-3`; done shows its time and, for agents, tokens and cost in `meta`. No other colors.

### 3.8 Run order, cache and partial re-runs

ComfyUI sorts the graph, runs ready nodes, caches each output by a key of its inputs plus upstream, and re-runs only what changed.

- **Order.** Both uses run the code top to bottom; `await` gives the order and `parallel()` gives the fan-out. There is no second scheduler.
- **Cache.** Programs have none: a program has side effects (files, requests), so each Run is fresh. Workflows already have the ComfyUI cache under another name, the journal (7.6).
- **Node expansion at run time.** A Parallel or Pipeline node does not know its item count until it runs. As calls arrive it grows one row per item inside the node ("3 of 5 done"), as ComfyUI expands nodes at run time. A sub-workflow node expands into its child calls (`parentSeq`). A Code node that makes agent calls lists them the same way.

### 3.9 Diff, review and merge

Programs and workflows are normal code files, so git diff, pull requests, code review and search work as they do for any code. The layout file is small and line oriented. A merge conflict in it is resolved by keeping either side; a wrong position costs nothing. Shared projects keep code on GitHub (SHARED-WITH-MEMBERS.md 5), so flows and project workflows travel with the repository.

## 4. Programs: the model

### 4.1 Files

| File | Who writes it | What it holds | Needed to run |
|---|---|---|---|
| `flows/<name>.flow.ts` | Conclave, the owner, any agent | The program. One `export async function main()` or a set of route and event handlers. | Yes |
| `flows/lib/*.ts` | Conclave, once per project, then anyone | The node helpers as plain, readable TypeScript (`httpRequest`, `parseHtml`, `writeCsv`). Each has a version line. | Yes |
| `.conclave/graph/<name>.json` | The canvas | The layout (3.2) | No |

### 4.2 The dialect: what a node looks like in code

The parser knows one strict shape, as MakeCode does. A node is one statement:

```ts
const <id> = await <helper>({ <settings and inputs> });
```

- `<id>` is the node's id and its label on the canvas ("page", "rows"). It is unique in its function.
- `<helper>` is imported from `flows/lib`. Its name picks the node kind from the catalog (4.3).
- Literal values in the object are settings. A reference to another node's id, or to a field of it (`page.body`), is a data wire.
- A statement with no `const` is a node with no output (`await log({ text: saved.path })`).
- `if`, `for (const x of ...)`, `try/catch` and nested `function` declarations are group nodes (3.6). Their body is more nodes.
- Order on the canvas follows the file's statement order. Moving a node in the order moves its statement.

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

### 4.3 The program catalog

Each kind is a node plugin (3.3) with `use: 'program'`. Helper source in `flows/lib` is generated from the same plugins, so the ports and the code cannot drift.

| Family | Kinds | Program phase |
|---|---|---|
| Inputs | Manual trigger, Value, Secret (reads `process.env`), Argument | P1 |
| Inputs | Schedule, HTTP route, Read file | P2 |
| Inputs | Discord on message, Webhook | P3 |
| Outputs | Log, Write CSV, Write JSON | P1 |
| Outputs | Respond JSON, Respond text, Write file, Serve | P2 |
| Outputs | Discord reply, Send email (through the hub's mail draft) | P3 |
| Logic (groups) | If, For each, Collect | P1 |
| Logic (groups) | Try/catch, Function (subgraph), Wait | P2 |
| Data | Pick field, Parse HTML, Parse JSON | P1 |
| Data | Template text, Filter, Sort, Join text, Now, Convert (inserted on a type mismatch) | P2 |
| Libraries and APIs | HTTP request | P1 |
| Libraries and APIs | SQLite open, query, run (`bun:sqlite`) | P2 |
| Libraries and APIs | Call package: any exported function of an installed npm package, ports read from its `.d.ts` | P3 |
| AI | AI step: prompt template plus input, output text or JSON with a schema | P2 |
| Escape hatch | Code: a TypeScript body, inputs as named variables, outputs as the names it declares | P1 |

P1, P2 and P3 are the program slices; section 10 places them in the overall phases. P1 is 15 kinds. Manual trigger is `main()` itself. Every P1 kind has a deterministic template and needs no model.

## 5. Programs: graph to code and back

### 5.1 Why this fits Conclave

1. Every Code session already edits real files through Edit and Write, with checkpoints, the stale-read check and file conflict alerts (DESIGN.md 28). A flow edit is a file edit, so all of that applies with no new path.
2. An agent's hand edit can never desync the graph. The next read redraws it.
3. Git, review and diff work on day one, which is the top complaint about every tool in section 2.
4. The owner can leave Conclave and keep a working program.

### 5.2 Language: TypeScript on Bun first

| | TypeScript on Bun | Python |
|---|---|---|
| Runs with no build step | yes (`bun flows/hn.flow.ts`) | yes |
| HTTP server, SQLite, fetch, env, test runner built in | yes (`Bun.serve`, `bun:sqlite`, `fetch`, `bun test`) | needs packages |
| Same language as the hub, so the parser and catalog live in one codebase | yes | no |
| Parser for the dialect | the shared `ts.createSourceFile` (3.2) | would need a second parser |
| Paired devices have it | the daemon already runs where Bun can be installed; Run says how when Bun is missing | often present, but versions vary |

MakeCode made the same choice: one TypeScript core under several editors. Python can come later as a second printer and parser over the same catalog.

### 5.3 The pipeline

All of it runs on the hub. The shared parts live in a new module `graph/`; the program parts in `flow/`. Files are read and written through the session's Machine, so the device can be any paired one.

| Step | Module | What it does |
|---|---|---|
| Parse | `graph/parse.ts` (shared), with the program plugins | Code text to a `GraphModel`: functions, nodes with ids, kinds, settings, references, and each node's exact source span. Unknown statements become Code nodes with their text. |
| Layout | `graph/layout.ts` (shared) | Merges the layout file. Nodes without a position get one from a layered layout that keeps placed nodes still (LabVIEW's clean-up lesson: never move what the owner placed). |
| Edit | `graph/ops.ts` (shared) | Applies typed ops (`add`, `remove`, `connect`, `disconnect`, `set`, `move`, `wrap`, `unwrap`, `collapse`, `rename`) to the text. Each op replaces only its statement's span, as `tools/edit-core.ts` replaces a string. Comments, blank lines and formatting elsewhere stay byte for byte. |
| Print | each plugin's `print` | Writes one statement from a node. Parentheses by precedence, as Blockly does. Used by Edit for new or changed statements only. |
| Helpers | `flow/lib-gen.ts` | Writes `flows/lib/*.ts` from the plugins the first time, and offers an update when the catalog version is newer. A helper the owner changed by hand is never overwritten; the canvas says "flows/lib/http.ts was changed here; kept". |

The web app never parses. It gets the `GraphModel` over the API and sends ops back. The hub owns the text.

### 5.4 Where the agent writes code

| Case | Who writes the code |
|---|---|
| A catalog node with all settings filled | The template. No model. |
| A Code node the owner described in words ("keep rows from the last 7 days") | The session's agent writes the body, through the same op API |
| A kind the catalog lacks ("post to Mastodon") | Later: the agent writes a new helper in `flows/lib/` with a typed signature. Its ports come from the signature, as Langflow reads ports from a class. It shows in the palette under "This project". |
| An error at run time | The owner asks the agent from the node's error line (6.3) |

### 5.5 Marking generated code

- The flow file starts with two comment lines (4.2): what it is and where its layout lives. No "do not edit" line, because editing is allowed.
- `flows/lib/*.ts` files start with `// Conclave flow helpers v<n>. Generated once; yours to change.`
- The parser recognizes a flow by the import from `./lib` plus the file name. Any `.ts` file the owner opens as a graph works; a file that is not in the dialect shows as Code nodes.

### 5.6 What happens on each kind of edit

This table holds for workflow scripts too.

| Edit | Result |
|---|---|
| The owner changes the graph | An op, a text splice, a write through the Machine, a re-parse. The canvas shows the re-parsed graph, so what you see is always what the file says. |
| An agent edits the file with Edit or Write | The hub sees the write (the write tools already report it for file conflicts) and pushes `graph.changed`. The canvas re-reads. Nodes whose id survived keep their place. New nodes are laid out. |
| Someone edits the file outside Conclave (an editor, `git pull`) | The layout hash differs on next open, or the device's watch (when the session is live) reports it. Same re-read. |
| The edit renames an id | The node loses its position and is laid out again. A rename done on the canvas uses the `rename` op, which moves the position with it. |
| The edit breaks the syntax | The canvas keeps the last good graph, dims it, and shows the parse error with its line: "Line 14: ',' expected. The graph shows the last version that parsed." Editing on the canvas is paused until the file parses. |
| The edit is outside the dialect | Those statements become Code nodes. The canvas header counts them: "3 code nodes". "Turn into nodes" asks the agent to rewrite them into catalog nodes where it can. |

## 6. Programs: running

### 6.1 Run

- **Run** in the canvas header runs `bun flows/<name>.flow.ts` on the session's device with `Machine.spawn`, in the session folder.
- It is a command like any Bash call: it goes through the session's permission mode and the Bash rules (`tools/bash-rules.ts`). The approval card shows the exact command. "Always allow" can cover `bun flows/*.flow.ts` for this folder.
- There is no extra sandbox at first. The program runs as the owner's user on the owner's device, exactly as a Bash call from the agent does. The canvas says this once, on the first Run of a project. A container option can come later if the owner wants it.
- **Servers and bots** (Serve, Discord on message) run until stopped. A flow with Serve runs as a Preview launch (`browser/preview.ts`): the hub relays the port, the Preview pane shows the app, and the agent can use `preview_logs`.
- Secrets come from the project's `.env`, read by the Secret node through `process.env`. They are never written into the flow file or the layout file. Preview already refuses to serve dotfiles (`containedFile`).
- Stop kills the process. A flow left running is listed in the session's Background tasks.

### 6.2 Live values on edges

- Run sets `CONCLAVE_FLOW_TRACE=1`. Each helper then writes one JSON line per call to file descriptor 3: `{ "id": "page", "ok": true, "ms": 212, "value": "<preview>" }`. Without the variable the helpers write nothing, so the program runs the same outside Conclave.
- The value preview is cut to 2 KB and 3 levels deep. Strings that equal a value from `.env` are replaced with `***` before they leave the device.
- Code nodes get the same line from a thin wrapper the parser knows, keyed by the statement's line.
- The hub reads the lines and sends `flow.trace` deltas, at most 10 a second per flow, like the Map's deltas (DESIGN.md 29). They feed the per-node store (3.7). Traces are kept in memory for the last run only.
- Each wire shows its last value as a short label at its middle ("200 OK", "30 rows", "out/hn.csv"). A click opens the full preview in the inspector. A For each shows the count and the last item.

### 6.3 Errors on the node

- A helper that throws writes `{ "id": "page", "ok": false, "error": "..." }`. An uncaught error from a Code node is mapped from its stack line to the node whose span holds that line.
- The node shows "failed" in `--fault` and the first line of the error under its title. The full error and stack open in the inspector as a code block.
- The inspector has **Ask the agent** under the error. It posts the error, the node's source and its inputs' last values to the session's chat.
- A parse or type problem before Run (an unconnected required input, a type mismatch from a hand edit) shows on its node as a notice line, and Run says which nodes need it.

## 7. Workflows as graphs

Today a workflow is a JavaScript script that starts with `export const meta = {...}` (`workflows/meta.ts:322-336`) and calls the prelude API: `agent()` (`prelude.ts:69`), `parallel()` (`:78`), `pipeline()` (`:91`), `phase()` (`:64`), `workflow()` (`:108`), and `lib` helpers such as `lib.runCheck` (`:372`), `lib.ask` (`:378`), `lib.approve` (`:379`) and `lib.loopUntilDry` (`:259`). The hub runs it in QuickJS and journals every call.

### 7.1 Source of truth: the script

| Option | For | Against |
|---|---|---|
| A JSON graph is the truth, compiled to a script on save | Easy to draw; any node layout is legal | Agents write workflow scripts all the time (the Workflow tool, scoped runs of scripts an agent wrote, `run.ts:460`). Each such edit would be a one-way fork of the JSON. The 14 built-ins and Claude Code's saved workflows (`registry.ts:10-13`) are scripts, so they would open read-only or not at all. Two files to keep in step. |
| **The script is the truth, the canvas reads and writes it (chosen)** | The same rule as programs (3.1), so one parser, one op engine, one test suite. Every existing script opens. Agents keep editing plain JS. The sandbox stays the one security boundary (`sandbox.ts:1-12`). The journal already keys calls by their inputs, so the cache needs no graph (7.6). | Real scripts use helpers, loops and `let`; those parts show as Code nodes until rewritten |

That cost is real: `plan-implement-verify.js` builds agents inside a helper (`plan-implement-verify.js:80-92`), asks inside a loop (`:48`) and loops with `let` (`:107-145`). Opened today, it shows its six phases as bands, clean nodes for the top-level agents, an If group around Approve (`:74-77`), and Code nodes for the loops. A Code node still lights up live and lists its calls (7.5), so the run view is complete even where the edit view is coarse. Scripts built on the canvas are all nodes.

### 7.2 The workflow dialect

| Statement | Node |
|---|---|
| `export const meta = { ... }` | Hidden. Name, description and phases are edited in the header; `meta.args` (`client/workflows.ts:34`) becomes the Args node. |
| `const A = typeof args === 'string' ? ...` and reads of `args.x` | Args node, one output per `meta.args` field |
| `phase('Title')` | Starts a Phase band (3.6) |
| `const id = await agent(<prompt>, { ...opts })` | Agent |
| `const id = await parallel(<list>.map((item, i) => () => <body>))` | Parallel, with its body as a subgraph |
| `const id = await pipeline(<list>, stage1, stage2, ...)` | Pipeline, one column per stage |
| `const id = await lib.runCheck(<command>, { worktree })` | Check |
| `const id = await lib.approve(<text>)` / `lib.ask(<question>, <options>)` | Approve / Ask |
| `const id = { type: 'object', ... }` or `lib.schemas.<name>` | Schema |
| `for (let round = 1; round <= N; round++) { ... if (<stop>) break }` | Loop until |
| `const id = await workflow('<name>', <args>)` | Sub-workflow |
| `return { ... }` | Return |
| `log(...)` | Log |
| anything else | Code node with its exact text |

The prompt is printed the way the built-ins write it, an array of parts joined by blank lines with each input fenced (`fix-until-green.js:41-46`). The Agent node's prompt widget shows plain text with `{{name}}` slots; each slot is an input port and prints as `lib.fence('name', <ref>)`. The parser reads that shape back.

A small review built on the canvas, in code:

```js
export const meta = { name: 'quick-review', description: 'Find bugs, verify each, ask before keeping', runtime: 'conclave', phases: [{ title: 'Find' }, { title: 'Verify' }] }

phase('Find')
const find = await agent(['Find bugs in the changed files. Cite file:line.', lib.fence('task', args.task)].join('\n\n'), { label: 'find', agentType: 'explore', model: 'smart', schema: lib.schemas.findings })

phase('Verify')
const verify = await parallel(find.findings.map((finding) => () => agent(['Try to prove this finding wrong.', lib.fence('finding', finding)].join('\n\n'), { label: 'verify', agentType: 'verifier', schema: lib.schemas.verdict })))
const keep = await lib.approve('Keep ' + verify.filter(Boolean).length + ' verified findings?')

return { findings: find.findings, votes: verify, ok: keep }
```

### 7.3 The workflow catalog

Each kind is a node plugin (3.3) with `use: 'workflow'`.

| Kind | Widgets | Inputs | Outputs | Slice |
|---|---|---|---|---|
| Args | one per `meta.args` field: text, number, toggle | | one per field | W1 |
| Agent | prompt (text with slots), model (combo: `fast`, `smart`, `deep` and models), agent type (combo from the registry, `agents.ts:117`), effort, schema, isolation worktree (toggle), with meta (toggle), answer (`fresh` control, 3.4) | one per slot; `schema`; `worktreeFrom` | `text`, or `json<schema>` with a schema, or `agent result` with meta | W1 |
| Parallel | | `items` (`list`) | `collected` (`list`, failed items are `null`, `prelude.ts:78-89`) | W1 |
| Phase | title | | | W1 |
| Check | command (text), timeout | `command`, `worktree` | `check` | W1 |
| Approve | text (with slots) | slots | `bool` | W1 |
| Ask | question, options | slots | `text` | W1 |
| Schema | schema (schema widget), or a `lib.schemas` name (combo) | | `schema` | W1 |
| Return, Log | | values | | W1 |
| Code | body | the ids it reads | the names it declares | W1 |
| Pipeline | | `items`, one subgraph per stage | `collected` (a failed item is dropped, `prelude.ts:91-106`) | W2 |
| Loop until | max rounds (number), stop condition, stall rounds | lazy body | `rounds`, last values | W2 |
| Sub-workflow | workflow (combo), args | args | `json` | W2 |
| Library nodes | `lib.panel`, `lib.judgePanel`, `lib.dedupe`, `lib.loopUntilDry`, `lib.checkCitations`, `lib.diff`, `lib.checkout` | per helper | per helper | W2 |

W1 and W2 are the workflow slices; section 10 places them in the overall phases.

### 7.4 Ports for workflows

The workflow types are in 3.5. Typical wires: an Agent's `json<findings>` into a Parallel's `items`; a Schema's `schema` into an Agent's `schema` port; an Agent's `agent result` (with meta) into a Check's `worktree` or the next Agent's `worktreeFrom`; a Check's `check.tail` into a prompt slot; `lib.diff` as `diff` into a reviewer's slot. The canvas refuses `text` into `items` and offers "Parse as list" as a Convert node.

### 7.5 Running with nodes lighting up

- **Run** opens the existing args form (`packages/web/src/features/workflows/args-form.tsx`) and starts the run as today (`service.ts:498`). Nothing about running changes.
- **Which node a call belongs to.** Each journaled call records the source line of its call site. The prelude reads it from the stack when `agent()` or a journaled `lib` helper is called; the hub subtracts the wrapper's offset (`meta.ts:10`) and maps the line to the deepest node whose span holds it. The line goes on `WorkflowCall` as `node`. This works for any script, in the dialect or not. If QuickJS stack lines prove unreliable through the wrapper, the fallback is an `opts.node` id the printer writes, left out of the call key like `label` and `phase` are (`agents.ts:97-107`).
- **States.** The call states exist already: `queued`, `running`, `done`, `failed`, `skipped`, `cached`, `parked` (`client/workflows.ts:7`), plus `waiting` from `workflow.progress` (`service.ts:204`). A node with several calls shows counts ("3 of 5 done, 1 running") and the worst state on its outline: failed, then waiting, then running.
- **Cost and tokens per node.** Each call already carries input and output tokens and cost (`run.ts:360-363`, set from the child session at `run.ts:654`). A node sums its calls and shows "12.4k out, $0.08" in `meta`. A cached call shows its earlier cost struck through, because cached calls cost nothing now (`run.ts:220`). The canvas header shows the run total against the budget.
- **Approve and Ask.** The node says "waiting for you" and shows the question inline. Answering on the node or on the usual approval card are the same action.
- **Inspector.** For an Agent node: each call's prompt, the answer (JSON as a tree when it has a schema), the last tool, the child session link, and the worktree actions that `Worktrees.tsx` already has (Diff, Merge, Discard).
- **Phases.** The band of the current phase (`workflow.phase`) gets a `--signal` title.

### 7.6 Cache and re-running one node

The journal is ComfyUI's output cache. A call's key is its prompt plus every option that decides the answer, with `label` and `phase` left out (`agents.ts:97-107`, `store.ts:177`). Upstream outputs reach an agent through its prompt, so the key covers "inputs plus upstream", as ComfyUI's does. A resumed run replays every call whose key and occurrence match, and runs the rest live (`run.ts:7-13`, `service.ts:585-597`). Scripts cannot read the clock or `Math.random` (`prelude.ts:38-56`), so a replay takes the same path.

| Owner action | What the hub does | Today |
|---|---|---|
| Edit a node's prompt or model, then Run again | Resume with the old journal as cache. The edited node's key changed, so it runs live; nodes downstream run live only if their prompt changed; everything else replays as `cached`. | Works as is: `resume` |
| Re-run this node | Drop only this node's calls from the cache, then resume. Its new answer changes the prompts downstream, so they run again; independent branches replay. | New: `rerun(id, { seqs })` beside `fromSeq` |
| Re-run from here | Drop this call and every later one (`cacheOf(calls, fromSeq)`, `service.ts:588`) | Works as is: `rerun(id, fromSeq)` (`service.ts:957`) |
| Fresh answer every run | The Agent's `fresh` control bumps a `variant` that is part of the key | New: `variant` in `AgentSpec` and `keyParts` |

Two limits stay as they are. Worktree calls: repository state is not in the key, so once one worktree call runs live, later ones do too (`run.ts:10-13`). And a resumed attempt replaces the run's calls (`service.ts:914`), so the canvas shows the newest attempt; spent tokens carry over to the budget (`service.ts:906-913`).

### 7.7 Building and editing

- The canvas edits the script with the same ops as programs (5.3). A workflow the owner made lives in `~/.conclave/workflows/<name>.js`, or in the project's `.conclave/workflows/` when he picks "Save to this project".
- Built-ins and plugin workflows open read-only, with "Copy to my workflows". The copy keeps the name, so it wins in the registry order (`registry.ts:1-14`).
- Every write goes through the workflow loader's checks first (`registry.ts:38`, `loadMeta`). A script that would not load is not saved; the canvas shows the loader's reason on the header.
- "New workflow" starts with Args, one Agent and Return.

### 7.8 Where it lives

- **Workflows page** (`WorkflowsPage.tsx`): each workflow's detail gets **Graph** beside its description and script. Graph is the default for workflows saved from the canvas.
- **Run view** (`RunView.tsx`, `RunSheet.tsx`): a **List / Graph** switch. List is today's view, phases with call rows (`CallRows.tsx`); Graph is the same run on the canvas. Both read the same events.
- **A session's Workflow tool call** links to the run's Graph.

Since Canvas mode (CANVAS-MODE.md, PR 4) Canvas is the one place a graph is drawn: the List / Graph switch, the Graph link and a Code session's Blocks pane gave way to **Open in Canvas**, and `/workflows/graph/<id>` and `?view=graph` redirect to `/canvas/workflow/<id>`.

## 8. AI

The agent edits both kinds of graph through files first, then through typed tools.

| Action | How |
|---|---|
| "Build me a scraper for X that saves a CSV" / "a workflow that reviews my diff with three verifiers" | The agent writes the file, or calls `graph_edit` with ops (8.1). The graph grows in front of the owner. |
| Select nodes and ask | Selected nodes go to the comment tray over the composer as one item ("3 nodes: page, stories, rows"), the way Preview's Pick does. The agent gets their ids, source and last values. |
| Explain a node | "Explain" in the inspector runs the hub's small model on the node's source, its plugin help and its last values, and shows three or four sentences. It does not change anything. |
| Fill a Code node from words | The owner types what it should do in the node; the agent writes the body. |
| Turn code into nodes | 5.6. For workflows this is how a built-in copy becomes all nodes. |

### 8.1 How the agent edits the graph

- **First: plain file edits.** The agent edits the file with Edit and Write. Code wins, so the canvas follows. When a graph is open, the session's instructions get a short note on its dialect. No new tool.
- **Then: two typed tools for both uses.** `graph_read` returns the graph as compact JSON: nodes, kinds, settings, wires, last values, errors, and for workflows the calls with state and cost. `graph_edit` takes a list of ops from 5.3 and applies them in one write. This follows the ComfyUI Copilot and tldraw lesson: the model makes small decisions, code applies them, validates ids and types against the node schemas (3.4), and refuses a bad op with the reason. The model never re-emits the whole graph.
- Each `graph_edit` call is one session checkpoint (`session/checkpoints.ts`), so Restore in the session panel undoes it.
- The program AI step calls models through the hub's gateway (`/gw/openai`, DESIGN.md 8) with a gateway key made for the project, in `.env` as `CONCLAVE_GATEWAY_KEY`. Spend shows on the Usage page and the key can be revoked. Model names are the gateway aliases (`fast`, `smart`, `deep`), so the flow names no provider. Workflow Agent nodes need none of this: they are workflow agents.

## 9. UI

### 9.1 Where it lives

- **Programs:** a view of a Code session, not a new top-level page. A session whose folder has a flow gets a **Chat / Graph** segmented control in its header. Graph replaces the transcript in the main column; the composer stays at the foot, so the owner can talk to the agent while looking at the graph. Preview docks at the right as it does today (`PreviewDock`). A new flow starts from "New flow" in the session's `...` menu, or from the agent.
- **Workflows:** 7.8.
- Both mount the same `features/graph/` canvas with a different plugin set and live source.

| Width | Layout |
|---|---|
| wide (>= 1280) | Palette 240 at the left of the canvas, canvas, inspector 340 at the right in place of the session panel. Minimap at the canvas's bottom right. |
| desktop and tablet | Palette folds to a button that opens it as a popover. The inspector is a right sheet. |
| phone (< 768) | Canvas full screen under the 56px bar. Palette and inspector are bottom sheets. No minimap; Fit is in the header. |

### 9.2 Parts

- **Canvas.** Pan by drag on empty space, zoom with wheel and pinch, box select with Shift. No background grid or dots: SPEC 2 bans them. The surface is the page background; groups and phase bands are a 1px `--rule-2` outline with their title, not filled boxes.
- **Nodes.** A node is a box (it is a different kind of object, SPEC 6), `--bg-raise`, 1px `--rule-2`, `--r-2`. Title in body text, kind in `meta` `--fg-3`, settings summary in one line, widgets below. Ports are small circles (data) and triangles (exec) with their name and type as text. State as in 3.7. Code nodes show their first lines in mono, which SPEC 4.3 allows for code.
- **Wires.** 1px `--fg-4` curves, `--fg-2` when a connected node is selected, `--signal` only while a value is passing on a live run. Value labels in `meta`.
- **Palette.** A search field and the plugins as plain rows by family, each with its one-line help. Drag a row onto the canvas, or tap it to add it after the selected node. On phones a tap adds and wires it.
- **Inspector.** The selected node's widgets as SPEC 10.5 inputs, its inputs and outputs with last values, its source as a code block with "Edit as code" (opens the file at that line), Explain, and on failure the error and Ask the agent. For workflow nodes also the calls (7.5) and Re-run this node.
- **Header.** Name, Run or Stop, the code node count, the parse state, Fit, zoom; for workflows also the run's cost against its budget.
- **Keys.** `R` run, `/` palette search, `Delete` remove, `G` group selection into a comment box, `F` collapse into function, `Enter` open a function or group, `Escape` back up.
- **Accessibility.** React Flow gives tab focus, Enter or Space to select, arrow keys to move, and `aria-live` announcements ([docs](https://reactflow.dev/learn/advanced-use/accessibility)). Ports can be connected by keyboard through the inspector's input selects, so no wire needs a drag. State changes are announced ("verify 3 of 5 done"). Touch targets are 44px on phones (SPEC 14); handles get an invisible 44px hit area.
- **Phone editing.** Tap to connect is on by default in React Flow (`connectOnClick`). The phone can view, run, watch nodes light up, re-run a node, answer Approve and Ask, tap to connect, change widgets and ask the agent from the first slice. Dragging nodes around on a phone is allowed but not tuned until later.

### 9.3 Canvas library: React Flow

**`@xyflow/react` v12, MIT.**

| | React Flow | Rete.js | Litegraph | Drawflow | Blockly | Our own (like the Map) |
|---|---|---|---|---|---|---|
| License | MIT, "and it will be forever" ([pro page](https://reactflow.dev/pro)) | MIT | Original MIT; the maintained Comfy copy is GPL-3.0 inside the ComfyUI frontend ([archive note](https://github.com/Comfy-Org/litegraph.js)), and it imports Vue and app code | MIT | Apache-2.0 | ours |
| React 19 | yes, peer `react >= 17` ([package.json](https://raw.githubusercontent.com/xyflow/xyflow/main/packages/react/package.json)) | yes, with `createRoot`; needs styled-components ([docs](https://retejs.org/docs/guides/renderers/react)) | no React layer | Vue bindings only, v0.0.60 | needs a wrapper | yes |
| Size (gzip) | about 60 KB ([bundlephobia](https://bundlephobia.com/package/@xyflow/react)) | core 3 KB plus plugins, total not measured | | about 9 KB | about 200 KB | 0 |
| Touch | pinch zoom, tap to connect | not documented | no pinch-zoom (source read, 2.1) | pinch, long press | not documented | pinch only |
| Accessibility | keyboard, aria-live | | | | the strongest (keyboard, screen readers) | none for editing |
| Node bodies | DOM, so React widgets work as they are | DOM | canvas-drawn widgets | DOM | blocks only | DOM |
| Subflows, minimap | built in ([subflows](https://reactflow.dev/learn/layouting/sub-flows), [minimap](https://reactflow.dev/api-reference/components/minimap)) | plugins | | | | to build |

Why React Flow: it is the only option that is MIT, React-native, touch-aware and accessible at once, its nodes are DOM so our widget modules are plain React, and its state is Zustand, which the web app already uses (`zustand` ^5 in `packages/web/package.json`). Its internal Zustand is v4, so two copies ship; the cost is a few KB. The Map's own canvas (`features/map/MapCanvas.tsx`) is a read-only view; building drag-to-connect, selection, keyboard editing and undo on it would cost more than the library.

How it is used:

- Loaded only with the Graph view (`React.lazy`), so the rest of the app does not grow.
- Custom node and edge components styled with the SPEC tokens. The `Background` component is not used (SPEC 2 bans background grids). The default node and edge styles are replaced.
- Node components are memoized and read only their own entry in the live store (3.7), per the performance guide ([docs](https://reactflow.dev/learn/advanced-use/performance)). The docs give no benchmark for large graphs; the 40-node line in 3.6 keeps each canvas small anyway.
- SPEC 16 gets one row: `@xyflow/react`, the graph canvas, MIT.

### 9.4 Android and desktop

Desktop (Tauri) loads the web app, so it gets the canvas with no extra work. Android shows a read-only graph later, from the same `GraphModel` JSON, with live states, values, errors, Approve and Ask. Editing on Android waits for the owner's call.

## 10. Phases

**Recommended order: workflow graphs first.** The owner runs workflows every day, and the engine already has what a ComfyUI-style live graph needs: per-call events, states, tokens and cost, and a journal that caches by inputs. So the first slice is mostly the shared canvas plus a view, with one small engine change. Programs need a new runtime path (helpers, `lib-gen`, the trace channel), so they come second and reuse everything from phase 1.

### Phase 1: the shared canvas and live workflow graphs

| Part | Scope |
|---|---|
| Shared core | `graph/plugin.ts`, `graph/parse.ts` (TypeScript parser added to `@conclave/core`, syntax only, loaded lazily), `graph/ops.ts`, `graph/layout.ts`; `GET /api/graph/nodes` |
| Workflow plugins | W1 kinds (7.3): Args, Agent, Parallel, Phase, Check, Approve, Ask, Schema, Return, Log, Code |
| Engine | Call-site line on each journaled call, mapped to `node` on `WorkflowCall` (7.5); `rerun(id, { seqs })` (7.6) |
| API | `GET /api/workflows/:id/graph` (graph plus layout), `POST /api/workflows/:id/graph/ops`; `graph.changed` event. Runs use today's endpoints and events. |
| Web | `features/graph/` with React Flow lazy loaded: canvas, palette, inspector, minimap, the per-node live store; Graph tab on the Workflows page; List / Graph in the run view; Re-run this node; read-only built-ins with Copy |
| Out | Programs, Pipeline, Loop until, Sub-workflow, library nodes, `fresh` control, typed agent tools, plugin node schemas, Android |

Done when: the owner opens `fix-until-green` as a graph (its loop is one Code node until Loop until lands in phase 2) and watches a run light up, builds the quick review on the canvas, runs it, watches each node light up with cost, edits one prompt, and sees only that node and its dependents run again.

### Phase 2: programs on the same canvas, and more workflow nodes

Program P1 kinds (4.3), `flow/lib-gen.ts`, Run on the device with the trace channel, values on wires, errors on nodes, the Chat / Graph switch in Code sessions. The scraper example works. Workflow W2 kinds: Pipeline, Loop until, Sub-workflow, the library nodes, the `fresh` control. `graph_read` and `graph_edit` tools with a checkpoint per call.

### Phase 3: program APIs and AI

Program P2 kinds: Template text, Filter, Sort, Convert, Try/catch, Function and collapse, Wait, Schedule, HTTP route, Serve through Preview, SQLite, Respond, Read and Write file, AI step through the gateway. Select nodes and ask; Explain; Turn into nodes. Phone drag editing tuned. The REST API example works.

### Phase 4: integrations and reach

Program P3 kinds: Discord and webhook triggers, Send email, Call package from `.d.ts`, project helpers as palette entries. Plugin node schemas, then plugin widget modules if the owner decides they are safe. Android read-only view. Then, if the owner wants them: Python as a second program language, and a container for Run.

## 11. Test plan

| Test | What it checks |
|---|---|
| Round-trip, text first | For every file in a corpus (the program examples, all 14 built-in workflows, hand-written edge cases with comments, odd spacing and CRLF): `print(parse(src))` equals `src` byte for byte. Foreign code survives as Code nodes. |
| Round-trip, graph first | Random graphs built from each plugin set: `parse(print(g))` equals `g` (kinds, ids, settings by name, wires, order). |
| Ops keep the rest | Each op on a file with comments around the target changes only the target's span. Checked by diffing outside the span. |
| Hand edits | Apply the kinds of edit in 5.6 to a flow and a workflow; the graph matches, positions survive for kept ids, a syntax error keeps the last good graph. |
| Saved workflows load | Every script the canvas writes passes `loadMeta` and runs with the scripted test agent, as the library workflow tests do. |
| Call to node | In a scripted run of each built-in, every call's `node` points at the node whose span holds its call site, including calls inside helpers, `parallel` and `pipeline`. |
| Re-run one node | With the scripted agent: re-running node B replays A and an independent C as `cached`, runs B live, and runs D (whose prompt reads B) live. Cost of cached calls is not counted again. |
| Helpers | Each program P1 helper against a local fake HTTP server and a temp folder, with and without `CONCLAVE_FLOW_TRACE`. The trace line format is pinned. Secret values are masked. |
| Error mapping | A Code node that throws on line N pins the error to the node whose span holds N, in both uses. |
| End to end | The scraper example runs with `bun` against the fake server in CI and writes the expected CSV. The quick review runs with the scripted agent and stops at Approve. |
| Web model | Pure tests for the graph to React Flow mapping, the layout merge and the live store reducer, like `test/map-model.test.ts`. |
| UI | Screenshot QA per SPEC 15 at each width in dark and light, the banned list checked, mock mode with a running workflow (running, waiting, cached, failed nodes), a running flow and a parse error. |

## 12. Risks

| Risk | What we do |
|---|---|
| Agents write code outside the dialect, and the graph fills with Code nodes | The dialect note in the session instructions; `graph_edit` in phase 2 so the agent edits by ops; the code node count in the header; Turn into nodes |
| Today's workflow scripts open mostly as Code nodes | The run view is complete anyway, because calls map to Code nodes too (7.5). Copy and Turn into nodes rewrite a built-in into nodes. |
| QuickJS stack lines do not survive the script wrapper | Check it first in phase 1. The fallback is an `opts.node` id the printer writes (7.5). |
| Re-run one node gives surprising results with worktrees | The canvas says it on worktree nodes: "Later worktree steps run again too", from the existing rule (`run.ts:10-13`) |
| Graphs get unreadable past a few dozen nodes | One function per canvas, collapse into function, the 40-node line |
| Plugin widget modules run third-party code in the web app | Plugins ship schemas only until the owner decides; built-in widget modules only in phases 1 to 3 |
| Running generated code on the owner's device | Same permission path as Bash, the exact command on the card, no extra powers. A container is a later option. |
| Secrets leak through traces or the layout file | Secrets only in `.env`; trace values masked against `.env`; traces kept in memory for the last run only; the layout file holds no values |
| The TypeScript parser adds several MB to the compiled hub | Syntax-only use; load it lazily on the first graph request. If the size is a problem, a smaller parser with TypeScript syntax can replace it behind `graph/parse.ts`. |
| Bun is missing on a paired device | Run checks for `bun` first and shows how to install it, as Preview does for missing tools |
| The owner wants no code at all, but errors show code | Errors read as sentences first; the code is one click away, never the first thing shown |
| Copying GPL ideas too closely | We read ComfyUI for ideas and write our own code; no file, type or string is copied |
| Some research sources are weak (a founder's comment, a dated forum post, two unverified repositories) | The choice rests on what Enso, MakeCode, Copilot Studio and ComfyUI's source show, and on Conclave's own file-editing model |

## 13. Open questions for the owner

1. **Which use first?** Recommended: workflow graphs. You run workflows every day, and the engine already sends the per-call states, cost and cache a live graph needs. Programs follow in phase 2 on the same canvas.
2. **What is the truth for a workflow graph?** Recommended: the JavaScript script, as for programs. The canvas reads and writes it, agents keep editing plain JS, and every existing workflow opens. No separate JSON graph.
3. **What should "Re-run this node" do?** Recommended: re-run that node, then only the nodes whose inputs changed because of it; everything else replays from the cache, as ComfyUI does. "Re-run from here" stays for re-running everything after a point.
4. **Which language first for programs?** Recommended: TypeScript on Bun. It needs no build step, has a server, SQLite and fetch built in, and shares the parser with workflows. Python can follow.
5. **How careful should a program's Run be?** Recommended: the same as an agent's Bash command, with the exact command on the approval card and "Always allow" per folder. No container at first.
6. **How much should a phone do?** Recommended: view, run, watch nodes light up, re-run a node, answer Approve and Ask, tap to connect, change settings and ask the agent. Full drag editing on phones comes later.
