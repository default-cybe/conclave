# Memory

Conclave keeps one memory for every model, agent and device. This page covers
how it works, how to connect outside memory stores (Basic Memory, any MCP
memory server, mem0, Cognee, a plain HTTP service), how to import what Claude
Code, Codex, Gemini CLI and OpenCode already know about you, how to export it,
and how those tools can use Conclave's memory in return.

## How Conclave memory works

Memory lives in the hub's SQLite database (`memories` table, FTS5 index,
optional embeddings). It has these layers:

| Layer | What it holds | When a model sees it |
| --- | --- | --- |
| Profile | Who you are and how you want answers. | Always, in the system prompt (about 1,500 tokens at most). |
| Facts and procedures | Durable facts ("pve is the Proxmox host") and how-tos ("deploys run `make release`"). | Recalled per turn when relevant. |
| Episodes | A 3 to 6 line summary of a past session. | Searched on demand with SessionSearch. In recall only with `memory.recallEpisodes`. |
| Inspiration | The owner's inspiration board: design references saved with SaveInspiration (URL, tags, note, the post's text, paths of its contact sheets or screenshot). | Never recalled on its own. Searched with MemorySearch `kind: "inspiration"`; the text comes back inside `<untrusted_web_content>`. |

The inspiration board: SaveInspiration `{ url, tags?, note? }` reads an x.com
post or video URL with ReadPost (text and contact sheets) or takes one 1440 px
light Chromium shot of any other page with Capture, copies the images to
`<home>/inspiration/<item>/` (outputs folders are pruned, this one is not) and
saves one `inspiration` memory. Saving the same URL again replaces the item.
Items stay local in every external memory mode, are not merged by the near
duplicate check, and are left out of plain MemorySearch calls, recall and
extraction. The web-studio skill and workflow search the board first and read
the closest 2 to 3 items in full. The tool is opt-in (the assistant has it),
owner-only (members never get it) and never offered to untrusted sessions.
Memory > Notes lists the items under the Inspiration filter with their tags.

Each memory has a scope: `global`, `project` (keyed by the session's working
directory) or `agent`. A session sees global memory plus its own project and
agent.

**Recall.** On every user turn the hub searches memory with the message text:
BM25 full-text search, blended with cosine similarity when
`memory.embeddings` is set, plus small boosts for importance, recency and a
matching scope. Hits below a relevance floor are dropped. Up to
`memory.injectLimit` (default 6) go into a `<memories>` block on the user
message, marked as background data, not instructions. The block rides on the
user message, not the system prompt, so prompt caching keeps working.
Connected stores are searched at the same time and add at most 2 hits per turn.

Recall leaves episodes out by default (`memory.recallEpisodes`, default
false): the past is searched when a chat asks about it (Past chats, below),
so a turn does not pay for summaries it does not need. Episodes are still
written; they feed SessionSearch and the Basic Memory digest.

**Extraction.** When a session goes idle, the small model (`smallModel`) reads
only the new part of the transcript and returns facts to add or update, as
JSON. New facts are compared with existing ones (cosine above 0.92 or heavy
word overlap) and merged instead of duplicated. The transcript is treated as
data: instructions inside tool results, files or web pages are ignored, so a
web page cannot plant a memory. Untrusted agents (email, web) lose the memory
save and forget tools; set `memory: none` in an agent's profile to skip
extraction for it as well.

**Already in your notes.** Before a learned fact is saved, after a session
goes idle or in the learning job of a chat import, Conclave searches your own
notes on each Basic Memory connection with live search on: one search per
fact, at most three notes back, four searches at a time, 2 seconds each. The
folder Conclave writes (`conclave/`, or the connection's `options.folder`)
is left out, so its own notes never count. When a line of one of your notes
says the same thing (cosine above 0.92 with `memory.embeddings`, else the
same heavy word overlap the dedupe uses) and has every word of the fact that
matters, with the note's title, the fact is not saved. "madx runs Debian 12"
is in a note titled madx with the line "runs Debian 12 with Docker"; "pve
runs Debian 12" is not. Each one is counted as already in your notes: on the
import in Memory, Import and export, Recent imports ("4 already in your
notes"), in the daily digest's summary, and in the hub log for extraction
after a chat. Profile items and preferences are saved anyway, since they ride
in every system prompt and a note only comes back when a turn asks for it,
and so is an item that replaces a memory, so the old one stops being
recalled. When Basic Memory does not answer in time, the facts are saved as
before and the check rests for a minute. Your notes are only read, never
edited or deleted. On a hub with several people (docs/design/ACCOUNTS.md),
each person's facts are checked against their own Basic Memory only: a
member's never against the owner's notes, nor the owner's against a
member's.

**Facts, not orders.** A memory is a fact about you or your setup ("The
owner prefers short answers"), never an order to the model ("Always answer
short"). Memories are read back in later sessions, and an order there reads
as an instruction that can override what you ask for now. Extraction, file
import and the learning job ask the small model for facts, then check what
comes back: an item that starts like an order ("Always", "Never", "Do not",
"Make sure", "Use ...", or "you must" anywhere) is rewritten when the
rewrite is simple ("Always use pnpm" becomes "The user uses pnpm.") and
dropped otherwise. An explicit save (MemorySave, the MCP `memory_save`) gets
the same rewrite, or a short error asking for a fact. Notes you edit on the
Memory page are not checked. A method with several steps belongs in a skill
(docs/EXTENSIONS.md, Skills agents write), not in memory.

**Secrets filter.** Anything that looks like a credential is never stored:
API keys (`sk-`, `ghp_`, `AKIA`, `xox`, `glpat-` and more), JWTs, private key
blocks, bearer tokens, passwords in `key: value` form, URLs with a password,
and long random strings. Extraction drops such items; explicit saves get the
match replaced with `[redacted]`. Transcripts are redacted before they go to
the small model, and imports and exports are redacted again.

You can see and edit every memory in the web app's Memory page or through
`/api/memory`.

## Past chats

Agents can search the hub's own chats and sessions with `SessionSearch`, so
"what did we decide about the backup script last week" or "like last time"
gets an answer instead of a request to repeat it. The search is full text
(SQLite FTS5) over session titles, the owner's and the assistant's words,
and session summaries. Tool output is never indexed, and neither are the
memories and hook notes that ride on a message. Chats imported from Claude
Code, Codex and Gemini CLI are archived sessions, so they are searched too.

| Filter | Takes |
| --- | --- |
| `query` | The topic in a few words. |
| `since`, `until` | Dates as `YYYY-MM-DD`. |
| `agent` | An agent name. |
| `folder` | A path (and what is below it), `~/code/homelab`, a folder name, or a project id. |
| `device` | A device id or name. |
| `kind` | `chat` (the Chat page) or `session`. |

Each result is one session with its title, date, agent, folder, device, the
summary when it has one, and two or three short snippets with their message
numbers. `SessionRead` opens a window of up to 30 messages (12,000
characters) around one of those numbers, text only, with tool calls named.

Never searched: the session asking (and the sessions it runs under), subagent
and workflow steps, chats and sessions with memory off, sessions marked
untrusted (webhook runs) and sessions of untrusted agents (email, web).
Untrusted sessions do not get the two tools, leave no trace in memory (no
profile, recall or extraction), and the results are wrapped and marked as
data, not instructions.

Other tools get the same search on the hub's MCP endpoint as `chat_search`
(read only).

## Connections

A connection links an outside memory store. Each one has a **mode**:

| Mode | Search | Writes |
| --- | --- | --- |
| `mirror` (default) | yes | New facts and session summaries go to the store and stay local too. |
| `read` | yes | Never. Use it for a store you only want to read, or to import from. |
| `external` | yes | Facts and summaries go to the store instead of the local database. The profile always stays local. If the store fails, the memory is kept locally. |

Every connection is searched on each recall, in parallel, with its own
timeout (`timeoutMs`, default 2500). A slow or broken store is skipped
without delaying the answer, and after two failures in a row it rests for a
while (15 seconds, growing to 5 minutes) before live search tries it again.
Results from all stores are scored per store, merged, and near duplicates are
dropped, including hits that repeat a local memory.

Set `"search": false` on a connection to skip live search and rely on an
**import** instead: sync copies the store's notes into the local index as
read-only facts (tagged `imported` and `source:<id>`). Conclave never edits
them on its own; the next sync updates or removes them. Removing the
connection removes them too.

| Type | Store | Live search | Writes | Import |
| --- | --- | --- | --- | --- |
| `basic-memory` | Basic Memory notes over MCP | yes | yes | yes |
| `mcp` | Any MCP memory server; preset for the official knowledge graph server | yes | yes (preset, or with `writeTool`) | yes (preset, or with `listTool`) |
| `mem0` | mem0 platform or self-hosted mem0 server | yes | yes | yes |
| `cognee` | Cognee REST API | yes | yes | no (Cognee keeps a graph, not notes) |
| `http` | Any service with `POST /search` and `POST /add` | yes | yes | with `listPath` |

Connections live in the hub config (`/data/config.json` in Docker) under
`memory.connections`:

```json
{
  "memory": {
    "connections": [
      { "id": "notes", "type": "basic-memory", "mode": "mirror", "options": { "server": "basic-memory" } },
      { "id": "mem0", "type": "mem0", "mode": "read", "search": false, "options": { "apiKey": "${secret:mem0}" } }
    ]
  }
}
```

The hub API manages them too, and every change applies without a restart:

| Call | What it does |
| --- | --- |
| `GET /api/memory/connections` | List connections with status, latency, last error, last sync and imported count. |
| `GET /api/memory/connections/presets` | Starting configs for each type. |
| `POST /api/memory/connections` | Add one. The body is a connection; `id` is made from `name` when left out. |
| `PATCH /api/memory/connections/:id` | Change one. `id` and `type` stay fixed. |
| `DELETE /api/memory/connections/:id` | Remove one and the notes it imported (`?keepImported=1` keeps them). |
| `POST /api/memory/connections/:id/test` | Connect, list tools, run a harmless search. Returns each step with timings, a plain error and a hint. |
| `POST /api/memory/connections/test` | Same, for a config that is not saved yet. |
| `POST /api/memory/connections/:id/sync` | Import the store's notes into the local index. |

**Secrets.** Paste a key into `apiKey`, `token`, `password` or an
`Authorization` header and the hub moves it into the secrets store on save,
writing `${secret:memory.<id>.<key>}` in the config instead. You can also
store a named secret yourself (`PUT /api/secrets` with
`{"kind": "values", "key": "mem0", "value": "..."}`) and write
`${secret:mem0}`, or read one from the hub's environment with `${env:NAME}`.
Listings show `********` for any literal credential that is left.

The older single setting `memory.external` still works. It shows up as a
connection with id `external`, and the first edit through the API turns it
into a normal entry.

### Basic Memory

[Basic Memory](https://github.com/basicmachines-co/basic-memory) keeps notes
as markdown files with a SQLite index and serves them over MCP. Conclave uses
its `search_notes`, `write_note`, `read_note`, `recent_activity` and
`build_context` tools.

**Setup (Docker hub).** Run Basic Memory next to the hub and point a
connection at it.

1. In `docker-compose.yml`, uncomment the `basic-memory` service. Mount the
   folder with your notes at `/app/data`, then `docker compose up -d`.
2. Add the server and the connection to the hub config:

   ```json
   {
     "mcpServers": {
       "basic-memory": { "type": "http", "url": "http://basic-memory:8000/mcp" }
     },
     "memory": {
       "connections": [
         { "id": "notes", "type": "basic-memory", "mode": "mirror", "options": { "server": "basic-memory", "project": "main" } }
       ]
     }
   }
   ```

3. Test it: `POST /api/memory/connections/notes/test`.

Naming a server from `mcpServers` means agents also get Basic Memory's tools
directly. Without `server`, a connection can carry its own `url`, or its own
`command` and `args`. With none of the three (Basic Memory on the hub, as
setup step 6 and Settings, Memory add it), the hub saves it as the
`basic-memory` server in `mcpServers` (`uvx basic-memory mcp`, the same entry
Discover installs) and points the connection at it with
`options.server: "basic-memory"`. One process then serves memory and agents,
and routines that need Basic Memory find it. A hub that already had such a
connection and no `basic-memory` server gets the same change once when it
starts; the connection keeps its project and folder. uvx needs
[uv](https://docs.astral.sh/uv/) installed on the hub (the Docker image does
not have it). A member's own Basic Memory still runs as its own process.

What to know:

- New connections keep a few grouped notes (`options.layout: "grouped"`),
  rebuilt from Conclave's memory whenever one of their memories changes:
  `conclave/profile.md`, `conclave/projects/<project>.md`,
  `conclave/hosts/<host>.md`, `conclave/paths.md`, `conclave/procedures.md`,
  `conclave/notes.md`, and a monthly digest of sessions in
  `conclave/sessions/<YYYY-MM>.md`. Each is a list of
  `- [kind] text (date, source)` observations with `[[relations]]`, so an
  update or a delete reaches the store, a reworded fact does not make a
  second note, and an import of a thousand items makes one write per touched
  note. Writes are coalesced per note and sent two at a time.
- Connections made before keep the old layout (`per-fact`): one note per fact
  in `conclave/memories/<title>.md` and one per session in
  `conclave/sessions/<date> <topic>.md`, never updated afterwards.
  `POST /api/memory/connections/<id>/group` switches one to grouped notes and
  writes them; with `{"deletePerFact": true}` it then deletes the per-fact
  notes Conclave wrote (only notes it can name from its own memories, using
  `delete_note`; an older server without it keeps them and the reply says
  so). `options.folder` changes the `conclave` folder.
- Goals go to `conclave/goals/<title>.md`, one note per goal with its
  subgoals and progress log (docs/ASSISTANT.md). Locally each goal is one
  memory tagged `goal`, kept by the hub from the Goals page.
- On the first search, Basic Memory downloads its embedding model (about
  70 MB). The first test can time out; run it again a minute later.
- Its HTTP transport has no authentication. Keep it on the Docker network
  (as the compose file does) and never publish its port.
- Sync in `mirror` mode skips the `conclave` folder, since those notes are
  already local. `importFolders` and `skipFolders` narrow an import.
- Notes you also edit on your PC: sync the notes folder between machines
  (Syncthing or git); Basic Memory reindexes changed files on its own.

### Any MCP memory server

**Official knowledge graph server.** `@modelcontextprotocol/server-memory`
stores entities with observations in a JSONL file.

```json
{ "id": "graph", "type": "mcp", "mode": "mirror",
  "options": { "preset": "knowledge-graph", "env": { "MEMORY_FILE_PATH": "/data/memory-graph.jsonl" } } }
```

This runs `npx -y @modelcontextprotocol/server-memory` on the hub (needs
Node). Set `MEMORY_FILE_PATH`, or the graph lands in the npx cache and is
lost on update. To share one graph with Claude Code, add the same server
there with the same `MEMORY_FILE_PATH`, or add it to `mcpServers` and use
`"server"` instead. Facts become observations on the entity `user` (change
with `options.entity`), and each session summary becomes a `session` entity.
`search_nodes` only matches the whole query as a substring, so Conclave also
searches the longest words of your message.

**Other servers.** Name the tools and map the arguments. Placeholders:
`{{query}}`, `{{limit}}`, `{{title}}`, `{{content}}` (markdown),
`{{text}}` (plain), `{{kind}}`, `{{tags}}`, `{{folder}}`, `{{project}}`.
A value that is only a placeholder keeps its type (a number, a list).

```json
{ "id": "mymem", "type": "mcp", "mode": "mirror",
  "options": {
    "preset": "custom",
    "server": "my-memory",
    "searchTool": "search_memories",
    "searchArgs": { "query": "{{query}}", "limit": "{{limit}}" },
    "writeTool": "add_memory",
    "writeArgs": { "text": "{{text}}", "tags": "{{tags}}" },
    "resultPath": "results",
    "fields": { "id": "id", "content": "memory", "score": "score" }
  } }
```

Without `writeTool` the connection must use `mode: "read"`. Add `listTool`
(and `listArgs`) to allow imports. The test step lists the server's tools
and names any that are missing.

### mem0

**Setup (hosted).** Create an API key at app.mem0.ai, then add:

```json
{ "id": "mem0", "type": "mem0", "mode": "mirror",
  "options": { "apiKey": "m0-...", "userId": "me" } }
```

The hub moves the key into the secrets store when you save.

Self-hosted: run the server from the mem0 repo (`cd server && make
bootstrap`, which prints an API key; it listens on port 8888), then use
`"variant": "self-hosted", "url": "http://mem0:8888"`. The old OpenMemory app
is gone from the mem0 repo; the self-hosted server replaces it.

Routes used: hosted `GET /v1/ping/`, `POST /v3/memories/search/`,
`POST /v3/memories/add/`, `POST /v3/memories/`; self-hosted `POST /search`,
`POST /memories`, `GET /memories`. Conclave sends each fact as one user
message with `infer: false`, because it already extracted the fact; set
`"infer": true` to let mem0 rewrite it. Everything is filed under `userId`
(default `conclave`), and `agentId` adds an agent filter.

### Cognee

**Setup.** Run Cognee's API (its `docker compose up` listens on port 8000,
and needs its own LLM key for graph building), then:

```json
{ "id": "cognee", "type": "cognee", "mode": "mirror", "timeoutMs": 5000,
  "options": { "url": "http://cognee:8000", "apiKey": "${secret:cognee}", "dataset": "conclave" } }
```

Search uses `POST /api/v1/search` with `search_type: "CHUNKS"`, which returns
stored text without an LLM call. Change `searchType` to `GRAPH_COMPLETION`
for graph answers, at the cost of an LLM call per turn. Writes upload the
note to `POST /api/v1/remember` and build the graph in the background (older
servers: `/api/v1/add` then `/api/v1/cognify`). Leave `apiKey` out when the
server runs with `REQUIRE_AUTHENTICATION=false`; `token` sends a bearer token
instead. `nodeSet` tags what Conclave writes.

### Plain HTTP

```json
{ "id": "home", "type": "http", "options": { "url": "http://notes.lan:8080", "headers": { "Authorization": "Bearer ${secret:notes}" }, "listPath": "/all" } }
```

Conclave sends `POST /search` with `{"query", "limit"}` and reads rows from
`results`, `memories`, `items` or a bare list (fields `content`, `text` or
`memory`, plus optional `id`, `title`, `score`). Writes send `POST /add` with
`{"title", "content", "text", "kind", "tags", "folder"}`. `searchPath`,
`addPath` and `listPath` change the routes.

## Importing what other tools know

Each coding agent keeps its own memory as markdown files. Conclave reads them
through any paired device and turns them into profile, fact and procedure
memories with the small model, merged with what is already stored.

| Tool | User file | Project files |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and auto memory in `~/.claude/projects/<project>/memory/` (`MEMORY.md` plus topic files) |
| Codex | `~/.codex/AGENTS.md` or `AGENTS.override.md`, and its own memory in `~/.codex/memories/` (`MEMORY.md`, `memory_summary.md`) | `AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` (its `/memory add` writes here) | `GEMINI.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `AGENTS.md` (falls back to `CLAUDE.md`) |

```http
POST /api/memory/import
{ "device": "arch-desktop", "cwd": "/home/me/code/homelab", "dryRun": true }
```

- With no `paths`, the user files above are read, plus the project files
  when `cwd` is set. Pass `paths` to pick files.
- `dryRun` shows what would be saved and saves nothing. Run it first.
- User files become global memories. Project files become project memories
  for that directory, unless an item is about you in general.
- Files that did not change since the last import are skipped; `force`
  re-reads them.
- HTML comments and `@import` lines are skipped, secrets are dropped, and the
  model ignores instructions written inside the files.
- Imported items are tagged with the tool's name (`claude-code`, `codex`,
  `gemini`, `opencode`).

## Importing past chats

Old Claude Code, Codex and Gemini CLI chats on any paired machine, and
claude.ai or ChatGPT exports, can come into Conclave as archived sessions,
teach memory, or both. Memory, Import and export, Past chats does it in the
app; Sessions has the same sheet under List options; onboarding has it as
step 6. Plan and API: `docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md`
section 1.

When a computer pairs for the first time (the desktop app or `conclave
daemon`) and has chats on it, the hub asks once: the Inbox and a
notification say "Found 12 chats from Claude Code and Codex on studio.
Import them?", and the device's page in Devices shows the same. Import
opens the sheet above with that computer picked, cost estimate first;
nothing is imported until you start it. Not now, or an import from that
computer, closes it for good. A member's computer asks that member only.
docs/DESIGN.md 38 has the details.

| Source | Where it is read | Notes |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<folder>/<id>.jsonl` | Only the live chain: edited prompts, rewinds and retracted replies are left out. Subagent transcripts are listed under their chat and skipped. |
| Codex | `~/.codex/sessions/` and `archived_sessions/`, `.jsonl` and `.jsonl.zst` | Titles from `session_index.jsonl`. A paginated fork starts with its base thread. `memory_consolidation` and review threads are never learned from. |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/` | Rewind, patch and set records are replayed. The folder comes from `projects.json`. |
| claude.ai, ChatGPT | An upload of the export zip or its `conversations.json` | ChatGPT keeps the branch that was on screen. They become chats on the hub. |

**Three modes.** Chats only copies the chats and sends nothing to a model.
Chats and learn memory copies them, then the learning job reads each one.
Learn memory only reads them and makes no sessions; it also takes Conclave
sessions, which is how chats imported earlier without learning get learned
("Learn from 12 imported chats not learned yet").

**Skipped by default**, each with a filter to include it: automation runs
(Claude Code `sdk-*` entrypoints, Codex exec), subagent and internal
threads, and chats with fewer than 2 prompts or 300 characters typed.

**Never twice.** A ledger keeps one row per chat file. Its fingerprint is the
tool, the tool's chat id, and the first three message ids, so a Syncthing or
claudesync copy of a chat on another machine lands in the same session, and a
Claude Code chat resumed under a new id is its own session. Ledger rows from
before the chat id was in the fingerprint still match a copy with the same
id. A chat that grew gets the new messages appended. A chat that grew both
there and in Conclave: when the tool's side has more new messages, they are
appended and Conclave's own turns move to a child session, "<title>
(Conclave branch)"; otherwise the tool's version becomes a new session,
"Continued in Claude Code on arch-desktop", next to the old one. Histories
are never mixed. Turns Conclave ran through the same Claude Code session are
matched by text and not copied again. Sync under an imported session's title
does the same for one chat.

**Duplicates from older imports.** `POST /api/import/merge-duplicates` lists
the Claude Code chats that have more than one session (same chat id and first
message). With `{"apply": true}` it keeps the one with the most messages,
points every ledger row at it and archives the others with
`meta.import.duplicateOf`; nothing is deleted. Without `apply` it is a dry
run. A row an older import marked ambiguous is matched again on the next
import.

**The folder.** A Claude Code chat's folder is read for the device that holds
the file: when the `cwd` inside is another machine's path (a sync tool
rewrote only some paths), the project folder name gives the path on this
device, so `/home/default/CMU` in `-Users-default-MadX-CMU` becomes
`/Users/default/MadX/CMU`.

**The learning job** reads each chat in windows of at most 30k tokens: the
owner's words, the final answer of each turn, the commentary, then tool
output (2k tokens per call, 20k in all), with rows labelled `[user]`,
`[assistant]`, `[tool]` and `[agent notice]`. Reads of `.env`, `*.pem`,
`id_*` and credential files are left out, and so are `<private>` spans.
One call per window returns an episode and items. Code then keeps an item
only when its quote is in the transcript, its kind and basis are known
words, it is under 200 characters and has no secret in it; every drop is
counted on the batch ("Left out: 9 the quote was not in the chat"). The
quote must also come from a row its basis allows and share a word that
matters with the item. "The user said" needs the owner's own words; an
assistant line alone backs nothing; a fetched web page or web search result
is never evidence, whatever the basis. A row label inside a tool output or a
pasted text ("[user] ...") is neutralized, so a page cannot pass for the
owner. A quote of one word, or of an unrelated line, is dropped too, and so
is an item with a number (a size, a port, a version) that the chat never had;
a date the model resolved from "next friday" is fine. A
preference said in one chat waits in Notes, To review, until the owner
accepts it or a second chat says it too; other kinds become facts and
procedures tagged `learned`, `source:<tool>`, `batch:<id>` and `kind:<x>`,
with the quote, the basis and the chat's date in the memory's provenance. A
newer item can supersede an older memory; both are kept and recall skips the
old one. A fact your own Basic Memory notes already state is not saved and is
counted on the batch (Already in your notes, above). After the batch one call
per project merges repeats.

**Cost.** `POST /api/import/estimate` counts the windows and tokens before
anything runs and prices them with the catalog for the configured model
(`memory.importModel`, else `smallModel`) and up to two others the hub can
use. About 100 typical chats cost $0.29 on Haiku 5.5. A rate limit parks the
batch until the reset; a hub restart continues it. A model that does not
answer at all (no key, the provider down) stops only the learning: the chats
copied so far stay imported, and the batch reads "Learning stopped:
anthropic/claude-haiku-5-5 did not answer (...). The chats copied so far stay
imported. Resume tries the rest again once it answers."

**Resuming one.** An imported chat is an archived session on the device it
came from, with the coder agent for a coding tool's chat. It runs on the
tool's own harness model only when that harness is on as an engine, else on
your default model; the tool's session id is kept for a later resume. Send a
message to go on; move it to another device first when the files are there
(`docs/DESIGN.md` section 17). A harness turn in a folder the device does not
have stops with "<folder> is not on <device>. Which device has this folder?"
instead of a spawn error.

**Undo** is offered for 30 days on every batch: it deletes the sessions the
batch made, the messages it appended and the memories it learned, and clears
the supersede links it set. Memories edited since are kept and listed, and so
is a session you kept going in after the import: it stays whole, with the
messages the batch added, because your later turns read them. Chats the batch
learned are offered for learning again.

**The tools delete old chats.** Claude Code deletes chats older than 30 days
when it starts (`cleanupPeriodDays`), and Gemini CLI has
`general.sessionRetention` on. The import warns and offers Keep 10 years,
which writes `3650` into the tool's settings and keeps every other key.
"Keep importing new chats" (`import.watch`) reads the online machines every
6 hours and imports what is new in the mode set by `import.watchMode`.

**Devices.** A daemon on protocol 2 scans and converts on its own disk and
sends rows for changed files only, so a 23 MB transcript is never sent
whole; long tool output is cut there and stays in the file. An older daemon
is read from the hub, each file once per change. An offline machine shows
its last scan with its time.

**Limits and bad files.** A session file over 512 MB (on disk, or once a
`.zst` is unpacked) becomes an error row; the scan goes on. A zip entry that
unpacks past 1 GB is refused with 413, whatever the zip says about its size.
One broken conversation in an export is counted and left out; the rest
imports. An export uploaded as the other app (a ChatGPT file as claude.ai) is
refused with a hint. History records that point at each other (a Codex fork
of itself) and ChatGPT branches that loop end instead of hanging. A file that
now holds another conversation fails closed and the session is left alone.
A reply from a device is checked before it is stored. A token in a chat's
first prompt is redacted from its title and from the learning prompt.

Where it can fail: the tools change their formats between releases; unknown
line and content types are counted per scan so the drift shows. A folder name
with `-`, a space or a dot in the part that differs between machines reads
back wrong, so the stored folder can be off when the device does not have
either path. A device daemon built before the chat id was in the fingerprint
lists a copy on another machine as not imported until it is imported; the
import still lands in the right session. A
preference said once in a mood can still be wrong; To review and Undo keep
that cheap. Uploads go up to 128 MB per request, so a big account's export
goes up in its parts.

## Daily digest

One routine a night turns the day's chats into memory. It is off until you
turn it on: Settings, Memory, Daily digest, where you also set the time
(02:30 by default, before the nightly reflection at 02:40 and the librarian
at 03:05). It is also in the routine suggestions, recommended and off. Off
pauses the routine; daily notes already written stay where they are.

It runs in the hub, not as an agent:

1. **Import.** For each online device it imports and learns the day's new
   or grown Claude Code, Codex and OpenCode chats through the import service
   above (the ledger, the learning job and its evidence checks), in
   Chats and learn memory mode (Chats only when memory is off). Offline
   devices are skipped and named in the run. OpenCode has no reader yet, so
   it finds none.
2. **Catch up.** Conclave sessions of the day whose extraction did not run
   or failed (one still open at night, a model error) get it now, and each
   session of the day without a summary gets one. At most 30 a night.
3. **Note.** When a Basic Memory connection takes grouped notes, one small
   model call writes `conclave/daily/<YYYY-MM-DD>.md` from the day's
   sessions (the same search as SessionSearch), their summaries and the
   memories saved that day: what you worked on by project, decisions with
   their reason, things learned and open threads, one line each, about 40
   lines at most, with `[[links]]` to the project, host and goal notes it
   touches. It goes through the same writer and secrets filter as the
   grouped notes. A second run the same day rewrites the same note. Without
   such a connection the note is skipped and no model is called for it.
4. **Silent.** The run ends without a notification unless a step failed;
   the run history lists what each step did.

The routine's prompt holds what the note should say, so you can change it
in Routines; the reply format is fixed in code. It replaces the Session
harvester suggestion. A harvester you installed keeps working and shows
"Replaced by Daily digest".

API: `GET /api/memory/digest` (on or off, time, schedule, whether a
connection takes the note, the last note) and `PUT /api/memory/digest` with
`{ "enabled": true, "time": "02:30" }`.

## Exporting

`GET /api/memory/export` renders all memory as markdown for backup and git:

- `?layout=single` (default): one `conclave-memory.md`, grouped by profile,
  facts and sessions, then by scope.
- `?layout=folder`: Basic Memory style notes under `conclave-memory/`:
  `profile.md`, `facts/global.md`, `facts/project-<name>.md`,
  `facts/agent-<name>.md`, and one note per session in `sessions/`. Each has
  frontmatter, `- [kind] text #tag` observations and `[[relations]]`.

Order is stable (oldest first), so a nightly export into a git repo shows only
real changes in `git diff`. Imported notes are left out unless
`includeImported=1`. To write the export onto a device instead of
downloading it, `POST /api/memory/export` with `{ "device", "dir" }`. Use its
own folder, not your Basic Memory notes folder, or the facts appear twice.

## Sharing memory with other tools

Other tools can search and save Conclave memory over MCP, so a fact learned in
a Codex session is there in Claude Code the next day. The hub serves MCP in
two ways:

- **Streamable HTTP** at `https://hub.example.com/mcp`, with the hub token as
  a bearer token. Use the hub's address from Settings > Remote access, so it
  works from any device that can reach the hub. A quick tunnel address
  changes when the hub restarts, so pick the stable option or your own URL
  for this.
- **stdio** with `conclave mcp`, for tools on a machine where the Conclave
  CLI is installed. It talks to your hub with the CLI's saved login.
- **OAuth** on the same `/mcp` URL, for claude.ai and ChatGPT, which sign in
  instead of sending a token. See [claude.ai and ChatGPT](#claudeai-and-chatgpt)
  below.

The memory tools are `memory_context`, `memory_search`, `memory_save` and
`memory_forget`. `memory_context` returns one short block (about 1,500
tokens at most) with your profile memory, the most important facts, your
active goals with their next step and today's plan, for a chatbot to read
before it answers. Search covers local memory and every connection, so your
Basic Memory notes come with it; saves go through the same secrets filter,
dedupe and facts check as Conclave's own. `chat_search` searches past chats
as SessionSearch does (Past chats, above).

In the snippets below, `CONCLAVE_TOKEN` is an environment variable holding the
hub token. Keep it out of files you commit.

**Claude Code**

```sh
claude mcp add --scope user --transport http conclave https://hub.example.com/mcp \
  --header "Authorization: Bearer $CONCLAVE_TOKEN"
# or, with the Conclave CLI installed:
claude mcp add --scope user conclave -- conclave mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.conclave]
url = "https://hub.example.com/mcp"
bearer_token_env_var = "CONCLAVE_TOKEN"

# or stdio:
# [mcp_servers.conclave]
# command = "conclave"
# args = ["mcp"]
```

**OpenCode** (`opencode.json`, or `~/.config/opencode/opencode.json` for all
projects)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "conclave": {
      "type": "remote",
      "url": "https://hub.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:CONCLAVE_TOKEN}" },
      "enabled": true
    }
  }
}
```

For stdio use `"type": "local", "command": ["conclave", "mcp"]`.

**Gemini CLI** (`~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "conclave": {
      "httpUrl": "https://hub.example.com/mcp",
      "headers": { "Authorization": "Bearer $CONCLAVE_TOKEN" }
    }
  }
}
```

For stdio use `"command": "conclave", "args": ["mcp"]`.

To make the agents use it, add a line to each tool's user file (the files in
the import table above), for example: "At the start of every chat, call
Conclave's memory_context. Search the conclave memory tools before answering
questions about my setup, and save durable facts there."

### claude.ai and ChatGPT

claude.ai custom connectors and ChatGPT apps reach `/mcp` from their own
servers on the internet and sign in with OAuth. You add the hub's URL once,
press Allow on a Conclave page, and that chatbot shares the same memory as
everything else. How the sign in works and what it guards against:
`docs/design/MCP-OAUTH.md`.

**First, a stable https address.** The hub needs an address that the
internet can reach and that does not change: the stable tunnel on your
Cloudflare domain or your own URL (INSTALL.md section 2). A quick tunnel
gets a new address on every hub restart, and the connector stops working
until you add it again. A Tailscale address only works with Tailscale
Funnel, since claude.ai and ChatGPT are not on your tailnet. The
connector URL is that address plus `/mcp`, for example
`https://conclave.example.com/mcp`. Settings > Connected apps shows it.

**claude.ai** (Pro and Max; the Free plan allows one custom connector):

1. Open **Customize > Connectors** and press **+ Add**, then **Add custom
   connector**.
2. Give it a name, such as Conclave, and paste the connector URL. Press
   **Continue**.
3. Keep the settings Claude found: **Sign in now** under Authentication.
   Under OAuth client, **Use Claude's published identity** and **Register
   automatically** both work with Conclave. Press **Add**.
4. A Conclave page opens. If this browser is not signed in to the hub yet,
   sign in first. The page says "claude.ai wants access to your Conclave"
   and lists what it may do: read your memory, save and forget memories,
   search your past chats. Clear any line you do not want, then press
   **Allow**.
5. In a chat, turn the connector on with the **+** button, then
   **Connectors**.

On Team and Enterprise plans an Owner adds it under **Organization settings
> Connectors > Add > Custom > Web**, with the same URL, and each member then
presses **Connect** under **Customize > Connectors**. The same connector
works in Claude Desktop, the mobile apps and Cowork. If the Conclave page
says it could not read the app's details, remove the connector and add it
again with **Register automatically**.

**ChatGPT** (custom apps need developer mode, which OpenAI offers on paid
plans; its help article "Developer mode and MCP apps in ChatGPT" has the
current plans and menu names):

1. Open **Settings > Apps > Advanced settings** and turn on **Developer
   mode**. On a Business or Enterprise workspace an admin may have to allow
   it first.
2. In **Settings > Apps**, press **Create app**. Give it a name, paste the
   connector URL, choose **OAuth** for authentication, confirm that you
   trust the app, and press **Create**.
3. Allow it on the Conclave page that opens, as above. The page names
   `chatgpt.com`.
4. In a chat, pick the app from the **+** menu.

ChatGPT names itself with its published client document and signs each
token request with its own key (`private_key_jwt`). The hub checks that
signature against the keys ChatGPT publishes. If ChatGPT offers a choice of
client registration, keep the default. Dynamic client registration works
too.

**Tell the chatbot to use it.** Add this line to its custom instructions
(claude.ai: **Settings > Profile**, the personal preferences box; ChatGPT:
**Settings > Personalization > Custom instructions**):

```text
At the start of every chat, call Conclave's memory_context.
```

`memory_context`'s own description asks for the same, and it is also
offered as an MCP prompt and resource for clients that add those to a chat.

**What an app can do.** Each app gets only the scopes you allowed:

| Scope | What it allows |
| --- | --- |
| `memory:read` | `memory_context`, `memory_search`, `memory_recent`, `tasks_list`, `routines_list` |
| `memory:write` | `memory_save`, `memory_forget` |
| `chats:read` | `sessions_search` |

An app that calls a tool outside its scopes gets a `403` that asks you to
sign in again with more. Tokens work only on `/mcp`, never on `/api`.
**Settings > Connected apps** lists every app with its domain, what it can
do, when it was added and last used, and **Revoke**, which ends its access
at once. Registrations, consents, new tokens and revokes go in the audit log.
