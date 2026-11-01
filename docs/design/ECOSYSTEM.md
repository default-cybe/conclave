# Ecosystem: Discover, hook recipes and suggested routines

This is the spec for three things the owner asked for:

1. A **Discover** tab in Extensions that lists tools, skills, plugins, subagents, commands, MCP servers, hook recipes and routines from GitHub, with name, owner, stars, description and an Add button. Recommended items come first. Add shows exactly what will be written and run, then installs.
2. **Better hooks** for tools, memory and MCP servers: tested recipes with one-click add, memory and MCP aware hooks, and runner fixes. Everything stays Claude Code compatible.
3. **Suggested routines** in the Routines tab with one-click add, including a stronger Librarian that reads the code and organizes memory.

The data the builders follow ships in three files, already written and checked:

| File | What it holds |
| --- | --- |
| `packages/core/src/catalog/recommended.ts` | The catalog item types, 45 curated items (28 recommended, ponytail and caveman first), pinned commits, known marketplaces, GitHub topics per kind, and the raw feeds. |
| `packages/core/src/extensions/hook-recipes.ts` | 26 hook recipes with their bash scripts, handlers, needs, tunables and 41 test cases, plus the test fixture and the starter set. |
| `packages/core/src/scheduler/suggestions.ts` | 21 routine suggestions with full prompts, permission rules, prechecks, needs and the hub changes each one waits for, plus two new agents (ops-watch, steward). |

The owner: one person with a homelab (Proxmox host `pve`, the hub on `madx`, an LXC on pve), `arch-desktop` and a macbook. Uni work, CTFs and security research. TypeScript, Rust and Python. Uses Claude Code, Codex and OpenCode, and Basic Memory. Must-haves: `DietrichGebert/ponytail` and `JuliusBrussee/caveman`.

How the facts were checked: repos were read from shallow and blobless git clones, every pinned commit was checked with `git ls-remote` on 2026-10-17, MCP install metadata came from the live official registry, and every hook recipe test passed through Conclave's real hook runner. The GitHub REST API is blocked in the research sandbox (403 for curl), so star counts were read through the GitHub MCP connector and recorded as fixtures. On the owner's hub the catalog calls the GitHub API directly. Tests must replay the recorded fixtures and never call GitHub.

---

## 1. Catalog

### 1.1 Kinds

| Kind | What Add does | Where it ends up | Tab it links to |
| --- | --- | --- | --- |
| `mcp` | Saves an MCP server config, stores secrets, runs a test connect | `mcpServers.<name>` in `config.json`, secrets in the secrets store | MCP servers |
| `plugin` | Adds the marketplace if needed, installs one or more plugins at a pinned commit | `~/.conclave/plugins/<name>` | Plugins |
| `skill` | Copies skill folders from a repo at a pinned commit | `~/.conclave/skills/<name>/` | Skills |
| `subagent` | Copies agent markdown files (or installs the plugin that holds them) | `~/.conclave/agents/<name>.md` | Agents |
| `command` | Copies command markdown files | `~/.conclave/commands/<name>.md` | Commands |
| `hook` | Installs a hook recipe: script plus handlers, then runs its tests | `~/.conclave/hooks/recipes/<id>.sh` and `hooks` in the chosen scope | Hooks |
| `routine` | Opens the Routines tab's Add sheet for that suggestion | a routine, and its agent when missing | Routines |

Plugins that only bring skills or agents keep kind `plugin` when installing the whole plugin is the better path (ponytail, caveman, superpowers). Kind `subagent` or `skill` is used when the install copies single files.

### 1.2 One shape for every item

The types live in `recommended.ts`. Every source maps to `CatalogItem`:

| Field | Meaning |
| --- | --- |
| `id` | `<kind>:<slug>` for curated items, `gh:<owner>/<repo>` for live GitHub results, `reg:<registry name>` for registry results, `mkt:<plugin>@<marketplace>` for marketplace entries. Hook recipes map to `hook:<recipe id>`, routine suggestions to `routine:<suggestion id>`. |
| `kind`, `name`, `repo` (owner/repo), `url` | What it is and where it lives. |
| `stars`, `starsAt` | Star count and the date it was read. The UI says "33.7k stars as of Oct 17" until a live refresh. |
| `description`, `category`, `tags` | Plain text. Tags are words, shown comma separated. |
| `license`, `updatedAt`, `archived` | SPDX id or a short phrase; last commit date on the default branch. |
| `install` | One `InstallSpec` (see 1.6). |
| `variants` | Other ways to run it, picked in the preview (Docker on the hub, remote, skill only). |
| `inputs` | Form fields. Each `{{NAME}}` in the install spec is replaced with the value. `secret: true` values go to the secrets store under `secretKey`, and the config gets `${secret:<secretKey>}`. |
| `touches` | What it can reach: `network`, `files`, `shell`, `hub-code`, `cloud-account`, `real-devices`, `browser`, `memory`, `mail`, `repos`. |
| `needs` | Programs that must exist, with `where`: `hub`, `device` or `every-device`. |
| `hooks` | For plugins and recipes: event, matcher, interpreter, timeout and a cost note. |
| `recommended`, `must`, `rank` | Recommended section membership and order. `must` items always come first. |
| `source` | `recommended`, `recipe`, `suggestion`, `marketplace`, `github`, `mcp-registry`, `docker`, `awesome-list`, `star-index`. |
| `verified` | The install spec was checked against the repo at the pinned commit. |
| `fit`, `risk`, `warnings`, `overlaps` | Why it fits the owner, what can go wrong, preview warnings, and items that do the same job. |

Rules the data follows, and that live results must follow too:

- Secrets only in `env` or `headers`. McpManager expands `${secret:}` and `${env:}` there and nowhere else, so a secret in `args` or `url` would be sent as the literal text. `/tmp/cg/ecosystem/spec-tools/check.ts` asserts this; the catalog tests must too.
- Commits are full 40-character shas. Short shas cannot be fetched.
- An optional input left empty removes the key that held only its placeholder.
- Placeholders also apply to `server` (mcp-proxy names its server from an input).

### 1.3 Sources and precedence

Discover merges these, in this order of trust. A curated entry wins over a derived one with the same id or the same repo.

1. **Shipped data**: `RECOMMENDED`, `HOOK_RECIPES` (as kind `hook`), `ROUTINE_SUGGESTIONS` (as kind `routine`). No network. Discover must render these offline on first open.
2. **Marketplaces**: the ones already added (PluginManager state) plus `KNOWN_MARKETPLACES`. Browsing reads `.claude-plugin/marketplace.json` from `raw.githubusercontent.com`, which costs no API quota. A marketplace is cloned only when the owner installs from it. The default official marketplace stays as today.
3. **Official MCP registry**: `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<q>&version=latest&limit=30`, and `GET /v0.1/servers/<urlencoded name>/versions/latest` for one server. No auth. A daily sync uses `updated_since`. This is the best source for install configs.
4. **GitHub search**: `GET /search/repositories?q=<terms> topic:<topic> archived:false fork:false&sort=stars&order=desc&per_page=30`, one query per kind using `GITHUB_TOPICS` (most specific topic first, the next one only when the first returns fewer than 10). Code search (`filename:SKILL.md`, `path:.claude-plugin filename:marketplace.json`, `filename:server.json`) runs only with a token.
5. **Raw feeds** in `CATALOG_FEEDS`: the star index (quemsah, stars for 48,424 plugin repos with no API calls), the awesome-claude-code CSV, Docker MCP catalog YAML on demand, and optionally the punkpeye MCP list.

Not used: Smithery and Glama. Both need API keys, Glama's data license asks for a visible credit on every page, and the official registry already mirrors most of Smithery.

**Registry trust rule.** Mark a registry entry verified only when its `io.github.<owner>/` namespace matches the repository owner (ignoring case) and the package carries the registry's ownership marker: `mcpName` in package.json, an `mcp-name: <name>` line in the PyPI, NuGet or crates README, or the OCI label `io.modelcontextprotocol.server.name`. Lookalikes are real: `io.github.secforge/chrome-devtools-mcp` names the official repo but ships `@secforge/chrome-devtools-mcp`. Unverified entries show "Not verified" in the row and a risk warning in the preview.

### 1.4 Caching and rate limits

- **Storage**: three SQLite tables in the hub database.
  - `catalog_http(url PRIMARY KEY, etag, last_modified, status, body, fetched_at)` for every fetch.
  - `catalog_items(id PRIMARY KEY, kind, source, repo, json, stars, stars_at, updated_at, fetched_at)` with an FTS5 index on name, description and tags.
  - `catalog_installs(id PRIMARY KEY, kind, ref, source, sha, version, files_hash, installed_at, updated_at, previous_json)`.
- **GitHub limits**: unauthenticated is 60 core calls an hour and 10 searches a minute. With a token it is 5,000 an hour and 30 searches a minute. Search returns at most 1,000 results per query.
- **Token**: optional. The client reads secret `catalog.github-token`, then `github-pat` (the GitHub MCP server's token, so one token does both). It never logs it. Discover's status line says "GitHub: 54 of 60 calls left this hour" or "GitHub: signed in, 4,980 left".
- **Every request** sends `If-None-Match` with the stored ETag. GitHub documents that a 304 does not count against the primary limit. Raw files (marketplace.json, READMEs, manifests) come from `raw.githubusercontent.com`, which sends ETags and is not API-limited.
- **Budget**: background work (refresh, star updates) never spends below 10 remaining core calls. Searches typed by the owner may use what is left. On 403 or 429 the client reads `retry-after` or `x-ratelimit-reset`, stops calling until then, and serves cached results with a note.
- **TTLs**: search results 1 hour per query; repo stars 24 hours; registry pages 6 hours; marketplace.json 24 hours; the star index and CSV daily; trees and manifests read during a preview are kept by commit sha forever (they cannot change).
- **Star refresh** for the rows on screen: unauthenticated, one search with `repo:a repo:b ...` qualifiers fetches about 10 repos per call (the query is capped at 256 chars). With a token, one GraphQL query with repository aliases fetches 100. Rows covered by the star index skip both.
- **Git instead of the API** wherever it works: `git ls-remote` for heads and update checks, blobless clones (`git clone --filter=blob:none --no-checkout --depth 1`) plus `git ls-tree` for kind detection, and sparse checkout for the files an install needs. None of these use API quota, and all of them work in the research sandbox.
- **Offline**: Discover works with no network from shipped data and the cache. Live search shows "Offline: showing saved results from Oct 17". `CONCLAVE_CATALOG_OFFLINE=1` turns every network source off (air-gapped hubs, server tests).
- **API base**: `CONCLAVE_GITHUB_API` replaces `https://api.github.com`, for GitHub Enterprise or a local server that replays recorded responses (how live search was tested in the sandbox, where api.github.com is blocked).
- **Daily refresh** runs as a hub job (not a routine): registry `updated_since`, the star index and CSV, marketplace.json for added and known marketplaces, update checks for installed items, and stale flags (archived, or no commit in 180 days). It notifies once when an installed item's upstream is archived or renamed.

### 1.5 Live results: kind detection and install derivation

A live GitHub result has no install spec yet. The preview derives one, highest confidence first, and always shows the exact result before Add.

**Kind detection** from one tree listing (blobless clone, or `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` when git is not available):

| Found | Kind |
| --- | --- |
| `.claude-plugin/marketplace.json` | marketplace (each entry becomes a `mkt:` item) |
| `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` or a root `plugin.json` | plugin |
| `server.json`, or package.json or pyproject.toml that depends on `@modelcontextprotocol/sdk`, `mcp` or `fastmcp` | mcp |
| `SKILL.md` files, found with the `npx skills` rules: root `SKILL.md`, `skills/` up to 3 levels, `.claude/skills`, `.agents/skills`, plus top-level folders holding a `SKILL.md` (as in ctf-skills) | skill |
| `agents/*.md` with `name` and `description` frontmatter | subagent |
| `commands/*.md` | command |
| `hooks/hooks.json` alone | plugin (hooks only) |

A repo can match several kinds. The row shows the first; the preview lists all and lets the owner pick.

**MCP config derivation** (from the research prototype `derive.py`, run on 50 live registry responses):

1. A curated item in `RECOMMENDED` for that repo.
2. A verified registry `server.json`. npm becomes `npx -y <id>@<ver>` plus packageArguments. pypi becomes `uvx [runtime flags] <id>==<ver>` plus packageArguments, with `--from` when the executable name differs. oci becomes `docker run -i --rm -e VAR ... <runtimeArguments> <image> <packageArguments>`. nuget becomes `dnx <id>@<ver> --yes --`. remotes become `{type: http|sse, url, headers}`. Expand `{var}` placeholders from the `variables` maps. `isSecret` vars become secret inputs; `isRequired` vars become required inputs; vars with only defaults are left out.
3. A `server.json` in the repo or a subfolder.
4. package.json `bin` and `name`, checked against `registry.npmjs.org` (its repository field must match the repo).
5. pyproject `[project.scripts]`, checked against `pypi.org/pypi/<name>/json` project_urls.
6. A Dockerfile `LABEL` or an image `ghcr.io/<owner>/<repo>`.
7. README patterns: JSON blocks with `mcpServers`; `claude mcp add`, `codex mcp add` and `gemini mcp add` lines (parse `-e K=V`, `--transport`, `-- cmd`); VS Code install links (`insiders.vscode.dev/redirect/mcp/install?name=&config=<urlencoded json>`); Cursor deeplinks (base64 config). Treat `YOUR_*`, `<...>`, `xxx` and `ntn_****` as required secret inputs.

Derivation is wrong often enough that the preview must test before saving: basic-memory and serena put subcommands in runtimeArguments (wrong uvx order), serena's package is `serena-agent` but its executable is `serena`, the registry lags PyPI (serena 1.5.3 against 2.0.0), and github-mcp-server hides its token in a `-e` value. So: derive, show the exact config, run a test connect (initialize plus tools/list through `McpManager.test`), then save. A failed test saves nothing unless the owner picks "Save disabled".

### 1.6 Install, step by step

Every kind goes through the same three calls: **preview**, **confirm**, **install**.

**Preview** (`POST /api/catalog/preview`) resolves everything and changes nothing on disk outside a temp folder:

- Resolves the commit: the pinned sha, or `git ls-remote <url> HEAD` for live results. Shows "Pinned to 16352ac" or "Latest commit on main, a1b2c3d".
- Fetches the files with a blobless partial clone at that sha into `~/.conclave/cache/catalog/<plan>/`, then sparse-checks out only what the install needs.
- Lists every file it would write (path under `~/.conclave`, size), each hook (event, matcher, full command, interpreter, timeout), each MCP server with its final config, executable files and package scripts, and the license.
- Checks `needs` with `command -v` on the hub, and on the chosen device for `device` and `every-device` needs (through `Machine.exec`).
- Flags, as warnings: network calls in hooks (curl, wget, fetch, https URLs), `curl | sh`, pip or npm installs at SessionStart, telemetry defaults (caveman CLI on, `npx skills` on, rtk off), non-OSI licenses (Elastic-2.0, BUSL, CC-BY-SA share-alike, source-available), hooks on every tool call, fields Conclave ignores (`userConfig`, `asyncRewake`, `disable-model-invocation`, LSP servers, the hooks `modules` band), and overlaps with installed items.
- Optional scan: when `skillspector` or `agnix` is on the hub PATH, run it on the fetched tree and show findings as warnings next to the file list. Never a gate: scanners give false positives.
- Returns a `planId` valid for 10 minutes. Install refuses a plan whose sha moved.

**Confirm** happens in the UI: the owner fills inputs, picks a variant, plugins, a tool preset and whether hooks are on, and presses Add.

**Install** (`POST /api/catalog/install`) per kind:

- `mcp`: fill placeholders, write secrets with `config.setSecret('values', key, value)`, save with the same code path as `POST /api/mcp`, run `McpManager.test`. On a failed test, remove it again unless "Save disabled" was ticked. Offer "Use as a memory connection" (Basic Memory) and "Connect to my CLIs" (the existing `mcpConnectPlan`).
- `plugin`: `addMarketplace` when the marketplace is not added, then `installPlugin` for each ticked plugin at the sha. When hooks are off, install with the plugin's hooks disabled (new per-plugin `hooks: false` flag in plugins state, see 1.9). Record the commit.
- `skill`, `subagent`, `command`: copy each `from` to `to` under `~/.conclave`, without `.git`. A curated item may also list files Conclave writes itself (`write`, such as a SKILL.md for a repo of detection rules); when several entries or a written file land in one skill folder, the preview puts the folder together in the stage, marks the written files, and the install copies it as one folder. Write `.conclave-catalog.json` `{ id, repo, sha, installedAt, files }` in each skill folder, and one index file `~/.conclave/catalog-files.json` for single-file agents and commands. Offer "Also sync to Codex and OpenCode on <device>" (the existing `POST /api/sync-clis` with `only`).
- `hook`: call the hook recipe service (section 4.2).
- `routine`: never installs from Discover. Add navigates to `/routines?suggest=<id>`, which opens the Routines tab's Add sheet (section 5.2).
- `manual`: nothing to install. The sheet shows the steps and a link to the repo.

Every install writes a `catalog_installs` row and an audit log entry `catalog.install <id> <sha>`.

**Installed state** is matched two ways: a `catalog_installs` row, or by name (an MCP server with the same key and command or URL, a plugin with the same name, a skill folder with the same name, a recipe tag). Name matches show "added" with no update tracking.

### 1.7 Update and remove

- **Update check**: daily, and on demand. For git-based items it runs `git ls-remote` (no API quota). For pinned npx and uvx MCP servers it reads `https://registry.npmjs.org/<pkg>/latest` or `https://pypi.org/pypi/<pkg>/json`.
- **Update preview**: fetch the new sha, diff the installed copy against it, limited to manifests, hooks, `.mcp.json`, scripts, `bin/`, package files and `SKILL.md` files. Mark the update "needs review" when hooks, MCP servers or scripts changed, and ask again before applying. Otherwise one Update button.
- **Update**: keep the previous copy under `~/.conclave/catalog-prev/` (one level; a copy next to a skill folder would load as a second skill), keep the enabled flag and the hooks flag, write the new sha.
- **Rollback**: put the copy from `~/.conclave/catalog-prev/` back and restore the sha.
- **Remove** per kind: MCP removes the server (and its secrets after a separate confirm, since another server may share them); plugins use `removePlugin`; files are deleted when their `.conclave-catalog.json` or index entry says Conclave wrote them, and never otherwise; recipes remove handlers tagged with their id; routines are removed in the Routines tab, and removing one never deletes its agent.

### 1.8 MCP manager changes the catalog needs

Found while mapping configs (`packages/core/src/extensions/mcp.ts`):

1. **Env allowlist** (security). Every stdio server inherits the hub's whole `process.env` (`makeTransport`), which hands provider keys to third-party servers. Pass only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER`, `SHELL` plus the server's own `env`. Add `McpServerConfig.inheritEnv?: boolean` for the rare server that needs more.
2. **Expand placeholders in `args` and `url` too**, so DSN-in-args servers work. Keep secrets out of logs and out of `GET /api/mcp` responses.
3. **`cwd`** on `McpServerConfig` for project-scoped servers (Serena, git).
4. Later: OAuth for remote servers (Notion, Cloudflare), `mcpb` bundles, and a `device` field that spawns a stdio server on a paired device through `Machine.exec`. Until then the catalog recommends mcp-proxy on the device over Tailscale.

### 1.9 Plugin installer changes the catalog needs

Found in `packages/core/src/extensions/plugins.ts`:

1. **sha pins are ignored.** A marketplace entry's `sha` goes to `git clone --branch`, which fails, and the retry clones the default branch with no warning. Fix: for a 40-char sha, `git init`, `git fetch --depth 1 origin <sha>`, `git checkout FETCH_HEAD` (tested against GitHub). Prefer `sha` over `ref` when both exist. Fail loudly instead of falling back.
2. **Record the commit** in `state.json` (`sha`, `version` from plugin.json, and a hash of hooks, `.mcp.json` and scripts), so updates and the Extension watch routine can diff.
3. **`owner/repo@<sha or tag>#subdir`** in `parsePluginSource`, which never sets `ref` today.
4. **`strict: false` entries** (anthropics/skills `document-skills`): merge the entry's `name`, `skills`, `agents`, `commands` and `hooks` into the manifest and use the entry name, instead of loading every skill in the repo under the folder name.
5. **Per-plugin hooks switch**: `state.plugins[name].hooks = false` keeps the plugin's skills, agents and commands but drops its hooks from `pluginHooks()`.
6. Copy without `.git`, and use `--filter=blob:none` for big repos (caveman is about 35 MB with its Go proxy).

### 1.10 agentic-tools-mcp: import instead of install

The owner linked `Pimzino/agentic-tools-mcp`. It is listed (`mcp:agentic-tools`) but not recommended: last commit 2025-06-20, plain `writeFile` saves with no lock, and it duplicates Conclave's task board and memory. Instead:

- `POST /api/tasks/import { from: 'agentic-tools-mcp', device, path, dryRun }` reads `<path>/.agentic-tools-mcp/tasks/tasks.json` (`{projects, tasks, subtasks, migration}`) and `memories/<category>/<title>.json` (`{id, title, details, category, dateCreated, dateUpdated}`) on that device.
- Map status `pending` to `todo`, `in-progress` to `doing`, `blocked` to `todo` plus label `blocked`, `done` to `done`. Map priority 1 to 10 onto 0 to 3. Tags become labels. `parentId` and `dependsOn` go to task `meta`. Memories become `fact` memories tagged with the category.
- Take its good ideas into the task board later: parent and dependency links, and a "next ready task" pick (highest priority, then lowest complexity, then the task that unblocks the most others).

---

## 2. Hub API

New routes. Existing ones stay as they are. All JSON. Client method names are for `packages/core/src/client/index.ts`; put each group in its own commented block so builders do not collide.

### 2.1 Catalog

| Route | Client method | Returns |
| --- | --- | --- |
| `GET /api/catalog?kind=&q=&category=&recommended=1&installed=1&cursor=&limit=` | `catalog(q: CatalogQuery)` | `CatalogPage`. Local data only: shipped items, marketplaces and cached results. With no `q`, `must` items then recommended by `rank`, then the rest by stars. |
| `GET /api/catalog/search?q=&kind=&sort=stars\|updated&page=` | `catalogSearch(q: CatalogSearchQuery)` | `CatalogSearchResult`. Live GitHub and registry search, cached. |
| `GET /api/catalog/items/:id` | `catalogItem(id)` | `CatalogDetail` (README head, manifest, tree summary). `:id` is URL-encoded. |
| `POST /api/catalog/preview` | `catalogPreview(req: CatalogPreviewRequest)` | `InstallPreview` |
| `POST /api/catalog/install` | `catalogInstall(req: CatalogInstallRequest)` | `CatalogInstallResult`. 409 when the plan expired or the sha moved; 400 with `missing` when a required input is empty. |
| `POST /api/catalog/items/:id/setup` `{ step?, variant?, bin?, commands? }` | `catalogSetup(id, req)` | `CatalogSetupResult` (ok, exit code, the last 200 lines, the new `ready`). "Install on the hub" (`catalog/hub-setup.ts`): the owner's only, shipped items only (403 otherwise), 400 for a device step or a step that is not there, 409 when nothing can run, a run for the item is going, or `commands` is not what would run now (the body carries the new `setup` offer). |
| `GET /api/catalog/installed` | `catalogInstalled()` | `InstalledCatalogItem[]` |
| `POST /api/catalog/updates/check` | `catalogCheckUpdates()` | `InstalledCatalogItem[]` |
| `POST /api/catalog/installed/:id/update-preview` | `catalogUpdatePreview(id)` | `UpdatePreview` |
| `POST /api/catalog/installed/:id/update` `{ planId }` | `catalogUpdate(id, planId)` | `InstalledCatalogItem` |
| `POST /api/catalog/installed/:id/rollback` | `catalogRollback(id)` | `InstalledCatalogItem` |
| `DELETE /api/catalog/installed/:id?secrets=1` | `catalogRemove(id, { secrets? })` | `{ ok: true; removed: string[] }` |
| `GET /api/catalog/status` | `catalogStatus()` | `CatalogStatus` |
| `POST /api/catalog/refresh` `{ source? }` | `catalogRefresh(source?)` | `CatalogStatus`. At most once a minute. |
| `POST /api/tasks/import` | `importTasks(req)` | `{ projects: number; tasks: number; memories: number; skipped: string[]; preview?: TaskDraft[] }` |

```ts
import type { CatalogItem, CatalogKind, CatalogCategory, CatalogInput, CatalogNeed, HookSummary, InstallSpec, Touch } from '../catalog/recommended';

interface CatalogQuery { kind?: CatalogKind; q?: string; category?: CatalogCategory; recommended?: boolean; installed?: boolean; cursor?: string; limit?: number }

interface InstalledRef {
  id: string;
  kind: CatalogKind;
  /** Server name, plugin name, skill folder, agent or command name, recipe id, or routine id. */
  ref: string;
  /** Where it lives in the app, e.g. "/extensions/mcp?server=github". */
  href: string;
  sha?: string;
  version?: string;
  installedAt?: number;
  /** record: Discover installed it. name: found by name, no update tracking. */
  matchedBy: 'record' | 'name';
}

interface CatalogItemDto extends CatalogItem {
  installed?: InstalledRef;
  updateAvailable?: boolean;
  /** needs checked on the hub; device needs show as unknown until a device is picked. */
  ready: { ok: boolean; missing: CatalogNeed[] };
  /** Stars refreshed in the last 24 hours. */
  starsLive?: boolean;
}

interface GithubRate { authenticated: boolean; limit: number; remaining: number; resetAt: number; searchRemaining?: number }
interface CatalogSourceStatus { id: string; label: string; on: boolean; items: number; lastFetch?: number; lastError?: string }
interface CatalogStatus { sources: CatalogSourceStatus[]; github: GithubRate; lastRefresh?: number; cache: { items: number; bytes: number } }

interface CatalogPage { items: CatalogItemDto[]; total: number; next?: string; status: CatalogStatus }

interface CatalogSearchQuery { q: string; kind?: CatalogKind; sort?: 'stars' | 'updated'; page?: number }
interface CatalogSearchResult {
  items: CatalogItemDto[];
  page: number;
  more: boolean;
  from: Array<'github' | 'mcp-registry' | 'marketplace' | 'cache'>;
  /** Set when results are partial: "GitHub limit reached. Showing saved results until 14:05." */
  note?: string;
}

interface CatalogDetail extends CatalogItemDto {
  /** First 8 KB of the README as markdown. */
  readme?: string;
  manifest?: Record<string, unknown>;
  tree?: { kinds: CatalogKind[]; files: number; bytes: number };
}

interface CatalogPreviewRequest {
  id: string;
  /** Index into [install, ...variants]. Default 0. */
  variant?: number;
  /** For live gh: items with several kinds. */
  kind?: CatalogKind;
  options?: {
    /** Plugins to install from PluginInstall.plugins. Default all. */
    plugins?: string[];
    hooks?: boolean;
    toolPreset?: string;
    /** Recipes: user or project scope, or another CLI on a device. */
    scope?: 'user' | 'project';
    cwd?: string;
    target?: { cli: 'claude-code' | 'codex' | 'gemini'; device: string };
    /** Device for device needs and device-side steps. */
    device?: string;
  };
}

interface PreviewFile { path: string; bytes: number; role: 'skill' | 'agent' | 'command' | 'hook' | 'script' | 'manifest' | 'mcp' | 'other' }
interface PreviewWarning { level: 'info' | 'warn' | 'risk'; text: string }

interface InstallPreview {
  planId: string;
  expiresAt: number;
  item: CatalogItemDto;
  variant: number;
  variants: Array<{ index: number; label: string; type: InstallSpec['type'] }>;
  /** Full commit to install, and how it was picked. */
  sha?: string;
  shaFrom?: 'pinned' | 'head';
  /** hub: for a step that runs on the hub, what "Install on the hub" would run, or why it cannot (HubSetupOffer). */
  steps: Array<{ say: string; run?: string; on?: 'hub' | 'device'; hub?: HubSetupOffer }>;
  inputs: CatalogInput[];
  /** Paths under ~/.conclave. */
  files: PreviewFile[];
  totalBytes: number;
  /** MCP: the config that will be saved, secrets shown as ${secret:key}. */
  config?: import('../config/schema').McpServerConfig;
  /** The same change as a CLI command, for copy: conclave config set mcpServers.x '...', or the POST /api/plugins body. */
  equivalent?: string;
  hooks: Array<HookSummary & { command?: string; plugin?: string; network?: boolean }>;
  mcpServers: Array<{ name: string; config: import('../config/schema').McpServerConfig }>;
  scripts: string[];
  license?: string;
  licenseOsi?: boolean;
  needs: Array<CatalogNeed & { found: boolean | null; checkedOn: string }>;
  touches: Touch[];
  warnings: PreviewWarning[];
  scan?: { tool: 'skillspector' | 'agnix'; findings: Array<{ level: 'info' | 'warn' | 'risk'; file: string; line?: number; text: string }> };
}

interface CatalogInstallRequest {
  planId: string;
  /** Input values by name. */
  values: Record<string, string>;
  /** Turn it on right away. Default true; false installs it disabled. */
  enable?: boolean;
  /** MCP: keep the server even when the test connect fails (saved disabled). */
  saveOnFail?: boolean;
  syncClis?: { device: string; clis: Array<'claude' | 'codex' | 'opencode' | 'gemini'> };
}

interface RecipeTestResult { name: string; ok: boolean; why?: string; trace?: HookTraceDto }

interface CatalogInstallResult {
  ok: boolean;
  installed: InstalledRef;
  test?: McpTestResult;
  recipeTests?: RecipeTestResult[];
  warnings: string[];
  /** Links for the done state: "Open in MCP servers", "Connect to my CLIs". */
  next: Array<{ label: string; href: string }>;
}

interface InstalledCatalogItem extends InstalledRef {
  name: string;
  source: string;
  upstreamSha?: string;
  updateAvailable: boolean;
  checkedAt?: number;
  previous?: { sha?: string; at: number };
}

interface UpdatePreview {
  planId: string;
  from: string;
  to: string;
  changes: Array<{ path: string; change: 'added' | 'removed' | 'modified'; executable: boolean; diff?: string }>;
  hooksChanged: boolean;
  mcpChanged: boolean;
  scriptsChanged: boolean;
  /** True when hooks, MCP servers or scripts changed: the UI asks again. */
  needsReview: boolean;
  warnings: PreviewWarning[];
}
```

### 2.2 Hook recipes

| Route | Client method | Returns |
| --- | --- | --- |
| `GET /api/hooks/recipes?cwd=` | `hookRecipes(cwd?)` | `HookRecipeDto[]` |
| `GET /api/hooks/recipes/:id` | `hookRecipe(id)` | `HookRecipe & { installed: RecipeInstall[] }` (with the script) |
| `POST /api/hooks/recipes/:id/test` | `testHookRecipe(id)` | `RecipeTestResult[]` |
| `POST /api/hooks/recipes/:id/install` | `installHookRecipe(id, req)` | `{ ok: true; tests: RecipeTestResult[]; installed: RecipeInstall }` |
| `DELETE /api/hooks/recipes/:id?scope=&cwd=&cli=&device=` | `removeHookRecipe(id, where)` | `{ ok: true }` |
| `POST /api/hooks/lint` `{ hooks }` | `lintHooks(hooks)` | `HookLintIssue[]` |
| `GET /api/hooks/builtin` | `builtinHooks()` | `BuiltinHookDto[]` |
| `PATCH /api/hooks/builtin/:id` `{ enabled?, budgetChars? }` | `setBuiltinHook(id, patch)` | `BuiltinHookDto` |

```ts
import type { HookRecipe, RecipeTarget } from '../extensions/hook-recipes';

interface RecipeInstall { scope: 'user' | 'project' | RecipeTarget; cwd?: string; device?: string; env: Record<string, string>; installedAt: number }
interface HookRecipeDto extends Omit<HookRecipe, 'script' | 'tests'> {
  scriptBytes: number;
  testCount: number;
  installed: RecipeInstall[];
  /** needs checked with command -v on the hub. */
  ready: { ok: boolean; missing: string[] };
}
interface RecipeInstallRequest {
  scope: 'user' | 'project';
  cwd?: string;
  /** Tunables that differ from the defaults. */
  env?: Record<string, string>;
  /** Install into another CLI's settings on a device instead of Conclave. */
  target?: { cli: 'claude-code' | 'codex' | 'gemini'; device: string };
  /** Skip running the bundled tests (default false). */
  skipTests?: boolean;
}
interface HookLintIssue { level: 'error' | 'warn'; event: HookEvent; group: number; text: string; fix?: HooksConfig }
interface BuiltinHookDto { id: 'memory-recall' | 'memory-extract' | 'compaction' | 'file-recall'; event: HookEvent; label: string; enabled: boolean; budgetChars?: number; lastRun?: HookRunDto; tokensPerSession?: number }
```

### 2.3 Routine suggestions

| Route | Client method | Returns |
| --- | --- | --- |
| `GET /api/routines/suggestions` | `routineSuggestions()` | `RoutineSuggestionsDto` |
| `POST /api/routines/suggestions/:id/add` | `addRoutineSuggestion(id, req)` | `{ routines: Routine[]; agentCreated?: string }` |

```ts
import type { RoutineSuggestion, HubGap, SuggestionNeed } from '../scheduler/suggestions';

interface RoutineSuggestionDto extends RoutineSuggestion {
  /** Routine ids already made from this suggestion. */
  added: string[];
  /** Needs that are not met on the hub (agents, MCP servers, secrets). Device needs are checked when a device is picked. */
  missing: SuggestionNeed[];
  /** blockedBy entries the hub has not closed yet. Add is disabled while this is not empty. */
  waitingOn: HubGap[];
}
interface RoutineSuggestionsDto {
  suggestions: RoutineSuggestionDto[];
  /** Gaps this hub has closed. */
  closed: HubGap[];
  /** Suggested agents and whether an agent with that name exists. */
  agents: Record<string, { exists: boolean }>;
}
interface AddSuggestionRequest {
  /** One device id, or several when deviceRole is "each". */
  devices: string[];
  cwd?: string;
  enabled: boolean;
  /** Edits made in the sheet: schedule, prompt, notify, model. */
  overrides?: Partial<RoutineInput>;
}
```

`RoutineInput` and `Routine` gain (all optional, all Claude Code neutral):

```ts
interface RoutineInput {
  // existing fields ...
  /** Permission rules seeded into this routine's sessions only. */
  allow?: string[];
  deny?: string[];
  /** What a scheduled run does when a call needs approval. Default "deny": the call is refused, listed on the run, and the turn goes on. */
  onApproval?: 'deny' | 'wait';
  precheck?: string;
  /** Values may be ${secret:name}; exported to the routine's Bash calls only. */
  env?: Record<string, string>;
  /** Stop the run after this long. */
  timeoutMin?: number;
  /** Stop the run when its cost passes this. */
  maxCostUsd?: number;
  /** Suggestion id this routine was made from. */
  suggestion?: string;
}
interface RoutineRun {
  // existing fields ...
  /** Parsed from the "STATUS: ok|attention|problem" first line. */
  outcome?: 'ok' | 'attention' | 'problem';
  /** Calls refused because nobody could approve them. */
  denied?: Array<{ tool: string; input: string; rule?: string }>;
  precheckOutput?: string;
}
type Notify = 'always' | 'on_error' | 'on_attention' | 'never';
```

---

## 3. UI

Rules from `docs/design/SPEC.md` apply: no pills or chips, tags and kinds are words in `--fg-3`, state is a word in a fixed place, filters are text links with an underline, no icon on every row, lists never end in toggles, phones get bottom sheets.

### 3.1 Where Discover lives

- A new Extensions tab **Discover**, second in the index after Overview: `{ id: 'discover', label: 'Discover', desc: 'Find tools, skills, plugins, MCP servers, hooks and routines on GitHub and add them here. Each one shows what it runs before you add it.', short: 'Find and add extensions from GitHub.' }`. Route `/extensions/discover?kind=&q=`.
- Links into it, filtered by kind, as one quiet text link under each tab's explainer: Tools ("Find MCP servers in Discover", `kind=mcp`), Skills (`kind=skill`), Commands (`kind=command`), Plugins (`kind=plugin`; the Marketplace view stays as it is), MCP servers (`kind=mcp`), Hooks (`kind=hook`, text "Add a hook recipe"). The Overview quick actions gain "Discover".
- The Routines page gets its own Suggested section (5.2). Discover rows of kind `routine` open it.

### 3.2 Layout

Top of the tab, on one line on desktop:

- Search input ("Search GitHub for MCP servers, skills, plugins...") with the kind filter as text links under it: `All  MCP servers  Skills  Plugins  Subagents  Commands  Hooks  Routines`. Current one in `--fg` with the 1px underline.
- A category line under it only when a kind is picked, also text links ("All  token savers  memory  security  ctf  homelab  uni ...").
- The status as plain `--fg-3` text at the right: "GitHub: 54 of 60 calls left" or "Offline: saved results from Oct 17". It links to a small dialog with the token setup ("Add a GitHub token to raise the limit to 5,000 an hour") that writes secret `catalog.github-token`.

With no search text:

1. **Recommended** heading with one line: "Picked for your setup. Stars as of Oct 17." Must-have items first with the word "your pick" in the meta line, then by rank. In "All", show the must-haves plus the first 4 of each kind, each kind as a small subheading with "Show all 21" at its end. With a kind picked, show all recommended items of that kind.
2. **More** heading: the non-recommended curated items and cached results, by stars.

With search text: results from `catalogSearch`, curated matches first (marked "recommended" in the meta line), then live results. A "Load more" text button at the end, no infinite scroll. When live search is limited, the note appears above the results in `--fg-3`.

### 3.3 Row

```
ponytail                                                    165k stars     Add
DietrichGebert/ponytail, plugin, minimal code, updated today, your pick
Makes coding agents write less code. Reuse what the repo has, then the stdlib...
Can touch: hub code, files. Needs node on the hub.
```

- Line 1: name in `--fg` 13.5px medium; stars right-aligned in mono (aligned numbers are allowed), "165k stars"; the action at the far right.
- Line 2 (meta, `--fg-3`, comma separated): owner/repo, kind word, category, "updated 3 days ago" (from `updatedAt`), "not verified" for unverified registry items, "archived" in `--fault`, "your pick" for must items.
- Line 3: description, two lines at most.
- Line 4, only when it applies: "Can touch: ..." from `touches`, and missing needs in amber ("Needs uv on the hub").
- Action: an outline small **Add** button. When installed: the word "added" in the button's place and the row title links to the item in its tab (`installed.href`). When an update exists: a text button "Update". When `ready.ok` is false the button still opens the preview, which explains the missing need.
- Row click (outside the button) opens the detail: the same sheet as the preview with the README head on top and Add at the bottom.

### 3.4 Preview sheet

Desktop: a right side sheet, 480px (like the task sheet). Tablet and phone: a bottom sheet, max 88vh, with the Add button pinned to the bottom above the safe area.

Sections, in order, each a plain heading and rows, no boxes inside boxes:

1. **Title block**: name, owner/repo link, stars, license (with "not open source" in amber for non-OSI), "Pinned to 16352ac" or "Latest commit a1b2c3d".
2. **How to run it**: a segmented control over variants when there is more than one ("Remote, hosted by GitHub" / "Docker on the hub, read-only").
3. **Before you add**: `steps`, each with its command in a code block with Copy. A "Run on hub" text button for `on: 'hub'` steps, after a confirm dialog that shows the command again.
4. **Fill in**: inputs. Secrets use a password field with "Saved in the hub's secrets store as github-pat". Defaults prefilled (pve, madx).
5. **Options**: plugins as checkboxes (Trail of Bits shows seven), "Hooks: On / Off" segmented with "Off installs skills, commands and agents only", tool preset as a segmented control, scope for recipes (This hub / This project / Claude Code on <device> / Codex on <device>), "Also sync to Codex and OpenCode" checkbox for skills.
6. **What it adds**: files with sizes (collapsed after 8 rows, "Show all 23 files"), hooks as rows (`SessionStart`, matcher, `node`, 5 s, cost note), MCP servers with the final config in a code block, scripts.
7. **Warnings**: one line each. `risk` lines in `--fault`, `warn` in `--warn`, `info` in `--fg-2`. Overlaps: "Overlaps with karpathy-guidelines (added)."
8. **Needs**: each need with "found" or "missing on madx" and what to do.
9. **Equivalent**: the CLI command (`conclave config set mcpServers.github '...'` or the plugin install source), for copy.

Bottom: **Add** (solid), and "Add disabled" as a quiet text button. While installing, the button reads "Adding" and the progress is words under it ("Fetching 16352ac", "Testing connection", "Running 3 tests"). Done state: "Added. 12 tools." or "Added. 3 of 3 tests passed." with the `next` links. Failure: "Failed. uvx not found on the hub. Install uv, or pick Docker." with the raw error in a drawer.

### 3.5 Phones

- Discover is a full screen tab like the others. The kind filter becomes a horizontally scrolling text row; the category line hides behind a "Category" text button that opens a bottom sheet list.
- Rows: line 1 is name and stars; the Add button sits at the right of line 1 at 32px height; meta wraps; description clamps to 2 lines; line 4 shows only the missing need.
- The preview is a bottom sheet with the Add button pinned. Long configs scroll inside their code block horizontally, not the page.
- Touch targets 44px. No hover-only actions.

### 3.6 Empty and error states

- No results: "Nothing on GitHub matches "zotero" as an MCP server. Try All kinds." with a text link that clears the kind.
- Rate limited: results from cache plus the note. Never an empty page because of limits.
- Offline: the shipped list still shows. Live search says "Can't reach GitHub from the hub."
- Preview failed (clone failed, no manifest): "Failed. No plugin.json, SKILL.md or MCP server found in this repo at a1b2c3d." with "Open on GitHub".

### 3.7 Mock data

The web mock (`packages/web/src/mock/`) gets a `discover.ts` that serves `/api/catalog*`, `/api/hooks/recipes*` and `/api/routines/suggestions*` from the real shipped data (`RECOMMENDED`, `HOOK_RECIPES`, `ROUTINE_SUGGESTIONS`), with fake installed states and a fake rate limit, so screenshots show real names.

---

## 4. Hooks

### 4.1 What the research found

Measured in Conclave's runner:

- ponytail and caveman both work when node is on the hub. The Docker image has node only as Bun's fallback (`/usr/local/bun-node-fallback-bin/node`), and that works. Without node, ponytail fails with exit 127 on every event and caveman does nothing without saying so.
- Context cost with both on: about 10,000 chars at session start (ponytail 4,977, caveman 4,953), about 7,400 per subagent, and about 400 chars on every prompt that stays in the history.
- Six bash plus jq recipes in parallel cost 21 ms median per Bash call. Node plugin hooks cost 36 to 218 ms. An in-process function costs 0.017 ms.
- The hub image has no `jq` and no `python3`, so most published hooks and all recipes fail open there today.

Gaps against Claude Code (2.1.301 as documented in `docs/extensions/research-claude-code-codex.md`):

| Gap | Effect |
| --- | --- |
| `tool_response` is the text the model sees, cut to 20,000 chars. Claude Code sends objects (Bash `{stdout, stderr, interrupted, isImage}`, file objects for Write and Edit). | Anthropic's security-guidance plugin and karanb192's hooks read object fields and find nothing. |
| Prompt hooks do not read Claude Code's prompt hook answer `{"ok": false, "reason": "..."}`. | Trail of Bits fp-check's Stop and SubagentStop checks do nothing. |
| A deny with no reason shows "no reason given" even when the hook set `systemMessage`. | hookify's block message never reaches the model. |
| `summarize()` ignores `updatedToolOutput`. | The Hooks tab shows "noop" for output rewrites (seen for test-output-trim and mcp-json-compact). |
| `ifMatches('mcp__server__*')` is false. | `if` filters on MCP servers never match. |
| Flat entries `{"PreToolUse":[{"command": ...}]}` are skipped with no warning. | parry-guard's README config loads as nothing. |
| All handlers run in parallel and the last `updatedInput` wins silently. | Two rewriting hooks (rtk and memory-tagger style) conflict invisibly. |
| Permission rules see the rewritten input. | `Bash(git status)` stops matching `rtk git status`. |
| `asyncRewake`, `onFailure: block`, `once`, `statusMessage`, `suppressOutput`, `continueOnBlock` are ignored; there are no `http`, `agent` or `mcp_tool` handlers. | security-guidance's Stop review runs synchronously for up to 600 s; security hooks fail open on a crash. |
| Plugins get `PLUGIN_ROOT` and `PLUGIN_DATA` next to the `CLAUDE_*` names. | ponytail reads `PLUGIN_DATA` as "running in Codex" and switches output shape. It works by luck. |
| Plugin hooks write mode flags into `$CLAUDE_CONFIG_DIR` (default `~/.claude`). | On the hub they share state with the owner's real Claude Code. |
| Command hooks run on the hub even for sessions on other devices, and no Conclave hook fires for ACP sessions. | git, format and verify hooks see the wrong disk; Claude Code over ACP uses the device's own hooks. |
| No context budget and no Stop loop cap. | Mode plugins stack thousands of tokens; a broken Stop hook can loop. |
| Built-in memory recall, extraction and compaction are code, not hooks. | They are invisible in the Hooks tab and cannot be turned off there. |

### 4.2 Recipes

`HOOK_RECIPES` in `hook-recipes.ts`: 26 recipes, 21 recommended, 41 tests (the 41st, for ri-trace-export, came in hooks QA). All 41 tests pass through the real runner from the data file alone (prototype runner: `/tmp/cg/ecosystem/spec-tools/run-recipes.ts`, run with `bun` from the repo; the hooks builder turns it into `packages/core/test/extensions/hook-recipes.test.ts`). The recipe file is generated from `/tmp/cg/ecosystem/spec-tools/hook-recipes.src.ts` and the scripts in `/tmp/cg/ecosystem/hooks/recipes/`; after this round edit `hook-recipes.ts` directly.

| Group | Recipes |
| --- | --- |
| Safety | git-work-saver, git-checkpoint, mcp-write-gate, proxmox-guard |
| Security | secrets-firewall, guardrail-config-guard, injection-tripwire, instructions-tripwire |
| Token savers | rtk-rewrite, test-output-trim, mcp-json-compact, subagent-cap |
| Memory | precompact-keep, reinject-after-compact, memory-tagger, memory-recall-start, memory-recall-prompt, session-to-conclave |
| Verification | stop-verify, evidence-before-done (prompt hook), no-test-gaming |
| Minimal code | new-dependency-gate, diff-budget |
| Other | format-on-edit, ctf-command-log, ri-trace-export |

`RECIPE_STARTER` (git-work-saver, secrets-firewall, proxmox-guard, mcp-write-gate, injection-tripwire, test-output-trim, new-dependency-gate, stop-verify) is offered as one "Add the starter set" action in Discover's Hooks filter. Each needs only bash and jq.

**Install** (`HookRecipes.install(id, req)` in a new `packages/core/src/extensions/recipes.ts`):

1. Check `needs` with `command -v` where the hook will run. Refuse with the missing list unless `force`.
2. Write `script` to `<paths.hooks>/recipes/<id>.sh` with mode 0755. For `target` installs, write the same file on the device through `Machine` at `~/.conclave/hooks/recipes/<id>.sh`.
3. Build each handler: `command` with `{script}` replaced by the absolute path, and `NAME=value` prefixes for env values that differ from the defaults (quoted with single quotes). Add `"recipe": "<id>"` to each handler in Conclave files.
4. Merge into the scope: `config.json` hooks (user) or `<cwd>/.conclave/settings.json` (project), through the existing `PUT /api/hooks` code path. For other CLIs: `~/.claude/settings.json` and `~/.codex/hooks.json` take the same shape; `~/.gemini/settings.json` needs event renames (`PreToolUse` to `BeforeTool`, `PostToolUse` to `AfterTool`, `UserPromptSubmit` to `BeforeAgent`, `Stop` to `AfterAgent`, `PreCompact` to `PreCompress`), tool renames and timeouts in milliseconds. In other CLIs the recipe is found again by its script path, since they ignore unknown fields only sometimes; strip `recipe` there.
5. Run the bundled tests in a temp copy of `RECIPE_FIXTURE` (a git repo with `a.txt` committed then modified, plus `NOW.md`, a hostile `CLAUDE.md`, `.ctf` and `eval/traces/`). Each test gets its own `TMPDIR`. `stubConclave` tests put a stub `conclave` first on PATH that prints `RECIPE_STUB_SEARCH`. `modelReply` tests stub the small model. `transcript` tests point `transcript_path` at `RECIPE_FIXTURE_TRANSCRIPT`.
6. Return the test results. A failed test does not undo the install, but the UI shows it in `--fault` with "Remove" next to it.

`runOn: 'device'` recipes say in the preview: "Reads the session's files. Until hooks run on devices, it only works for sessions on the hub." Device-target installs (Claude Code or Codex on arch-desktop) have no such limit, since that CLI runs the hook locally.

### 4.3 Engine changes, in order

All of these keep Claude Code's file format. Anything Conclave adds is an optional field Claude Code ignores, or lives only in Conclave's own files.

**P0, needed for recipes and the must-have plugins to behave**

1. Docker image: add `jq` to the apt line (and `python3-minimal` behind a build arg for hookify-style hooks). Put the Bun node fallback on the hook PATH outside Docker too.
2. Prompt hooks read `{"ok": false, "reason"}` as block with reason (and `{"ok": true}` as no-op), next to the current `decision` shape.
3. A deny or block with no reason falls back to the `systemMessage` text.
4. `summarize()` reports `replace` when `updatedToolOutput` is set.
5. Lint on save and import (`POST /api/hooks/lint`, also called by `PUT /api/hooks` and import): wrap flat entries into `{matcher, hooks: [...]}`, flag timeouts over 600 that look like milliseconds, flag a bare `mcp__<server>` or `mcp__` matcher (it is an exact name in Claude Code and matches nothing; suggest `mcp__<server>__.*`), flag `if` rules that cannot match.
6. `ifMatches` accepts `mcp__<server>__*` and `mcp__<server>`.
7. Stop loop cap: at most 3 Stop blocks per turn; the fourth is ignored with a system message.
8. Plugin env: Claude-format plugins get only `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR`; `PLUGIN_ROOT` and `PLUGIN_DATA` only for `.codex-plugin` manifests. Add `CONCLAVE=1`. Set `CLAUDE_CONFIG_DIR` to `~/.conclave/plugin-data/<plugin>/claude-config` unless the plugin's `shareClaudeConfig` flag (plugins state, a toggle in the plugin detail) is on.
9. The multi-block MCP result spill gap in `session/runner.ts`: results over `maxToolResultChars` are offloaded only when the content is a string, and `mapToolResult` returns a block array when a server sends several blocks. Measure joined text blocks before the check so big MCP results reach `ReadToolOutput`.

**P1, Claude Code parity and safety**

10. `tool_response` as Claude Code's objects for built-in tools (Bash `{stdout, stderr, interrupted, isImage}`, Write and Edit file objects), plus `conclave.output_text` with what the model sees. Recipes already read both shapes. Add the case to `hook-parity.test.ts`.
11. Rewrites run in order: handlers that may rewrite input (any PreToolUse command or prompt hook) run one after another, each fed the previous `updatedInput`, while read-only events stay parallel. Log conflicts in the trace.
12. A rewrite keeps the original call's verdict: check permission rules against both the original and the rewritten input and take the stricter. A hook `allow` that comes with a rewrite counts only when the original call was allowed. The dangerous-command guard still runs after a hook allow (it does today).
13. `onFailure: "block"` makes a crash or timeout count as exit 2 (security recipes fail closed). `once: true` runs a handler once per session. `statusMessage` shows in the session's live strip while the hook runs. `suppressOutput` hides stdout from the transcript view.
14. Context budget per event: SessionStart and SubagentStart cap the merged context at 12,000 chars, UserPromptSubmit at 2,000 per handler, with a "[cut by Conclave: N chars over budget]" note. Read Codex's `additionalContextLimit` per handler. The Hooks tab shows "adds about N tokens per session" per handler from recent traces, and warns when two plugins inject into every subagent.
15. `mcp_tool` handler type with Claude Code's fields `{ "type": "mcp_tool", "server": "basic-memory", "tool": "search_notes", "input": { "query": "${cwd}" } }`. `${path.in.input}` interpolates from the hook input JSON. The tool's text result is treated like a command hook's stdout (JSON hook output when it parses, plain context on SessionStart and UserPromptSubmit). Uses `McpManager.callTool`. Read-only tools only, unless the handler sets `"allowWrite": true` (Conclave field).

**P2, memory and MCP aware**

16. Register the built-ins as in-process hooks through `Hooks.register` (which exists and nothing calls): `memory-recall` (UserPromptSubmit), `memory-extract` (Stop), `compaction` (PreCompact), plus a new `file-recall` on PreToolUse Read (memories tagged with that path or `repo:<name>`; off by default; the claude-mem idea). The Hooks tab lists them under "Built in" with traces, a token budget and an On / Off in the detail view (`GET /api/hooks/builtin`).
17. `conclave hook <name>` CLI subcommands that read hook stdin and print the right JSON: `memory-recall`, `memory-save`, `notify`. One line in any CLI's settings then works without jq. `memory-recall-start` and `memory-recall-prompt` become thin wrappers over it.
18. A `cwd` and project filter on `GET /api/memory/search`, and memory extraction for sessions brought in by `conclave import`, so session-to-conclave turns other CLIs' sessions into memory. Follow caveman's rule for recall: every injection is disclosed and priced (the trace says how many chars it added).
19. Matcher builder in the Hooks form: pick a server, then all its tools, read tools or write tools; it writes `mcp__<server>__.*` or a tool list. Catalog MCP items carry `toolPresets` for `McpServerConfig.tools`.

**P3, later**

20. `runOn: 'device'` per handler: device hooks run through the daemon's `Machine.exec` with the JSON on stdin. Policy hooks that read only the JSON stay on the hub.
21. `asyncRewake` on the durable scheduler: run in the background, then queue the output as a reminder on the next turn or wake an idle session.
22. Export recipes to Cursor (`.cursor/hooks.json` version 1, camelCase events) and as a generated OpenCode plugin that forwards `tool.execute.before`.
23. Read hookify's `.claude/hookify.<name>.local.md` rules natively in-process (no python3).
24. Trust by hash for plugin and recipe updates, as Codex does: an edited hook command stops running until approved again.
25. In-process TypeScript hooks shaped like Claude Code mods (`register(on, options)`, middleware `on('tool.call', async ($, e, next) => ...)`, declared access levels). Start with session.start, prompt.submit, tool.call, turn.complete, session.compact, session.end.

### 4.4 Token savers, in the order to prefer them

1. PostToolUse output rewrites (`test-output-trim`, `mcp-json-compact`): nothing runs on the device, nothing needs installing there, no permission side effects, and the full output stays in `ReadToolOutput`.
2. The built-in offload, once the multi-block MCP gap (P0 item 9) is closed.
3. caveman for output tokens, ponytail for less code written.
4. rtk for Bash output, once rewrites keep the original verdict (P1 item 12).
5. context-mode only if the others are not enough (Elastic-2.0, hooks on every call, a broken `mcp__` matcher).

---

## 5. Routines

### 5.1 The suggestions

`ROUTINE_SUGGESTIONS` in `suggestions.ts`: 23 routines, 16 recommended. All schedules pass `parseSchedule` and `previewRuns` and sit off the hour.

| Group | Suggestions (recommended in bold) |
| --- | --- |
| Memory | **Librarian: deep pass**, **Session harvester** |
| Homelab | **Homelab inventory sync**, **Backup check**, **Disk and ZFS health**, **Update scout**, Alert triage |
| Security | **Edge check**, **CVE watch**, **CTF radar and writeups**, Persistence sweep |
| Dev | **GitHub inbox**, **Unpushed work check**, Flaky test hunter, Docs drift, Dependency upgrade trial |
| Uni | **Uni calendar sync**, Daily recall quiz |
| Meta | **Routine doctor**, **Agent tune-up**, **Extension watch**, **Token and cost review** |

**The stronger Librarian** (`librarian-deep-pass`, Sundays 04:10 on each computer with code, one routine per computer named after it; the hub is offered only when it has repos in `~/code`): reads up to 6 repos with new commits (README, AGENTS.md, CLAUDE.md, manifests, CI, compose files, RepoMap and the commit log since the last pass), writes `Project: <repo>` and `Host: <name>` notes in Basic Memory with dated `[decision]` and `[convention]` observations and relations, merges duplicate notes into `archive/merged`, dedupes Conclave memories (copying every forgotten one into "Librarian log" first), and retires stale facts by closing their Basic Memory 0.24 `@valid[start,end)` range with `#retired` instead of deleting them. Conflicts it cannot settle go to "Librarian review". It keeps per-repo state in "Librarian state" and has hard caps per run (6 repos, 60 note edits, 25 memory changes). The shipped Nightly librarian stays as the light daily pass.

**From recursive-improve** (the owner's link): Agent tune-up runs the same loop over Conclave's stored sessions (loops of 3 or more identical tool calls, give-ups, tool error rate, wasted context, owner corrections), deep-dives the worst patterns and proposes prompt, skill, tool or model fixes for the owner to accept one by one. Dependency upgrade trial applies its keep-or-revert idea to dependency updates on a branch.

**New agents** in `SUGGESTED_AGENTS`: `ops-watch` (read-only checker that never fixes and stays quiet when fine) and `steward` (reviews Conclave itself and proposes changes, never edits). Both leave `tools` unset and use `disallowedTools`, because a tools list would allow every Bash command until gap `agent-tools-allow` is closed.

### 5.2 Routines tab: Suggested

- A **Suggested** section on the Routines page under the routine list, and as the empty state when there are no routines. Rows grouped by category with the words "Memory", "Homelab", "Security", "Dev", "Uni", "Upkeep" as subheadings. Recommended first; "Show 5 more" at the end.
- Row: name, schedule in words and agent in the meta line ("Sundays 04:10, librarian, on arch-desktop"), the description, and a line with missing needs in amber ("Needs Basic Memory. Add it"), linking to Discover's item when `catalog` is set. Action: an outline **Add** button, or "added" when a routine from it exists. When `waitingOn` is not empty the button is disabled with "Needs a hub update" under it.
- The old Templates dialog stays for the shipped templates.
- **Add sheet** (side sheet on desktop, bottom sheet on phones):
  1. **Device**: a picker prefilled from the role (hub to madx, proxmox to pve, workstation to arch-desktop, laptop to macbook, matched by device name; otherwise the first online device). For `each`, checkboxes for every device; one routine is made per ticked device, named "Update scout (pve)".
  2. **Folder** when `askCwd` is set, with the hint. Otherwise `cwd` shown as text, `~` expanded with the device's home.
  3. **Schedule**: the cron in words and the next three runs (`previewSchedule`), editable.
  4. **Runs as**: the agent, with "Adds the ops-watch agent to your agents" when it is missing.
  5. **Allowed without asking**: the `allow` rules as mono rows, each removable; `deny` rules under them. One line: "Calls outside this list are refused while you are away, and listed on the run."
  6. **Before it runs**: the precheck command, when set, with "Skips the model when this prints nothing new."
  7. **Prompt**: collapsed to its first 3 lines, expandable and editable.
  8. **Notify**: segmented (On problems, Always, Never). `on_attention` maps to "On problems".
  9. **Start**: "On / Off" segmented, defaulting to `enabledByDefault`.
  10. **Add**: creates the agent first (from `SUGGESTED_AGENTS`, at user scope, only when no agent of that name exists), then the routine with `suggestion` set. Done state: "Added. Next run Sunday 04:10." with "Run now" and "Open".

### 5.3 Engine changes, in order

**P0, security (ship before any routine allow list)**

1. **Agent tools stop granting permission** (`packages/core/src/engine/permissions-view.ts`, the loop that pushes every plain tools entry into `allow`). Today `explore`, `reviewer` and `planner` list Bash, so `curl https://x | sh` runs with no approval. Only tools whose `readOnly` is true get the implicit allow. A tools list controls what the agent sees, not what it may run. (gap `agent-tools-allow`)
2. **Bash prefix allow rules refuse compound commands.** `splitBashCommand` splits only on `&&`, `||`, `;`, `|` and newline, so `Bash(smartctl -a:*)` allows `smartctl -a /dev/sda & rm -rf ~/code`, `$(...)`, backticks and `> ~/.bashrc`. On the allow path, require `parseCommand(cmd).unsafe` to be empty and treat a single `&` as a separator. Plain `$VAR` expansion stays allowed for exact rules (the uni calendar rule needs it). bash-rules.ts already detects substitution, subshells and redirects. (gap `bash-allow-safe`)
3. `filterTools` and permission rules accept both `mcp__server__*` and `mcp__server` forms.

Added in routines QA (2026-10-17): a prefix allow rule allows any words after it, so `scheduler/guard.ts` adds deny rules next to the prefixes that take dangerous options (git `--upload-pack`, `-u`, `-c`, `--config`, `--template`, `ext::`; gh api `-X`, a second `--method`, `graphql`, full URLs; conclave `--hub` and `--token`; openssl `-keylogfile` and `-out`; smartctl self-test and settings flags; journalctl `--vacuum` and friends). Suggestions and shipped templates both carry them. A routine made from a suggestion also runs in `default` permission mode whatever the config says, needs an allow rule for WebFetch (`PermissionRules.webFetchNeedsRule`), and passes its rules to its subagents. Permission rules accept `mcp__server__*` (`filterTools` not yet). Run now and the webhook answer when the run has its session instead of when it ends.

**P1, unattended runs**

4. `Routine.allow` and `deny` seeded into the routine session's rules, shown once in the Add sheet. (gap `routine-allow`)
5. `Routine.onApproval` defaulting to `deny` for scheduled and webhook runs: the call is refused with "Nobody is there to approve this. Ask the owner in your reply.", listed in `RoutineRun.denied`, and the turn goes on. Manual runs keep waiting. Today the shipped Nightly librarian, Weekly review, Evening wrap-up and Server watchdog hang on "waiting on you" with default config, and later fires are skipped as "Previous run is still going". (part of `routine-allow`)
6. In scheduled runs, `AskUserQuestion` becomes an Inbox item and the turn goes on.
7. Apply the librarian unattended patch to `packages/core/src/agents-defaults/librarian.md`: add `disallowedTools: [Write, Edit, MultiEdit, NotebookEdit, ScheduleRoutine, mcp__basic-memory__delete_note]` (leave `tools` unset) and, after "Surface problems, do not settle them.", this paragraph: "When you run as a routine, nobody is there to answer, so never ask: put every question, conflict and removal candidate in the note "Librarian review" in folder "conclave" and keep going. Retire a stale fact by closing its validity ("@valid[start,end)" and #retired) instead of deleting it, and copy the text of any memory you forget into "Librarian log" first. Read a note before you edit it and pass its checksum, so an edit the owner made in the meantime is never overwritten." Rerun the agent prompt trials in `docs/agents/README.md` for the librarian.
8. Give the shipped Nightly librarian the deep pass's memory allow rules, Server watchdog its read-only Bash rules, and move shipped schedules off the hour (`0 3` to `5 3` and so on). Fix the host naming in `sysadmin.md` and `docs/MEMORY.md`: pve is the Proxmox host, madx the hub LXC.

**P2, quality**

9. Status contract: parse the first line `STATUS: ok|attention|problem` into `RoutineRun.outcome`. Add notify `on_attention` (problem or attention). Route attention runs to the Inbox as a review item. A green run is not a success unless the outcome says so.
10. `Routine.precheck` run on the device through `Machine.exec` (30 s), recorded as "skipped: nothing new" when it prints nothing or the same text as before the last run that went ahead.
11. `timeoutMin` and `maxCostUsd` that abort and record the run (already in the UI spec 11.5, missing from the type).
12. `Routine.env` from the secrets store, exported to the routine's Bash calls only. (gap `routine-env`)
13. Webhook payload: pass the POST body into the run wrapped as `<routine-payload source="webhook" untrusted="true">...</routine-payload>` after the prompt (today `create.ts` drops it). Return 202 with the run id instead of awaiting the whole run. Accept the secret only in the `x-conclave-secret` header, not `?secret=`. Queue webhook runs with a dedupe key and a cap of 5 instead of dropping them while one runs. (gap `webhook-payload`)
14. `@never` schedule for webhook-only routines, and webhooks allowed on disabled routines only when the schedule is `@never`. (gap `never-schedule`)

**P3, tools for self-maintenance**

15. A read-only `RoutineRuns` tool (status, trigger, duration, error, summary, cost, outcome, denied calls) for agents. (gap `routine-runs-tool`)
16. Read-only `SessionsSearch` and `SessionRead` tools for Conclave's own sessions inside the hub. (gap `session-tools`)
17. A native `Tasks` tool (list read-only; create and update with due, labels, project and a dedupe key in meta). Until then prompts use `conclave tasks add`.
18. Conclave memory validity: `validFrom`, `validUntil` or a supersedes link, so the librarian can retire Conclave memories as it does in Basic Memory.
19. Event triggers: `session.end` with a cwd filter (a project librarian pass after 5 sessions in a project), `routine.failed`, `device.online`.

`GET /api/routines/suggestions` reports `closed` gaps from a constant the routines builder updates as each item lands, so the UI enables Add for each suggestion as soon as its blockers are gone.

---

## 6. Testing

- **No GitHub in tests.** Catalog tests replay recorded fixtures through an injected `fetch`. Copy and trim these from the research folders into `packages/core/test/catalog/fixtures/`:
  - `/tmp/cg/ecosystem/mcp/fixtures/gh-search-topic-mcp-server-stars3000.json` (raw REST search JSON; keep 10 items) and `gh-stars-recorded.json`
  - `/tmp/cg/ecosystem/mcp/fixtures/registry/`: `get_io.github.github__github-mcp-server.json`, `get_io.github.basicmachines-co__basic-memory.json`, `get_io.github.oraios__serena.json`, `get_io.github.upstash__context7.json`, `get_io.github.ChromeDevTools__chrome-devtools-mcp.json`, `get_io.github.RekklesNA__proxmox-mcp-plus.json`, `get_io.github.bytebase__dbhub.json`, and one lookalike page (`chrome-devtools.json`)
  - `/tmp/cg/ecosystem/mcp/fixtures/dockerhub-mcp-namespace.json` (keep 10 repos)
  - `/tmp/cg/ecosystem/skills/fixtures/marketplaces/` (all 8; trim the official one to 20 plugins including superpowers, hookify, code-simplifier, claude-md-management and mattpocock-skills)
  - `/tmp/cg/ecosystem/skills/fixtures/github-search-candidates.json`, `quemsah-repos-top300.json` (keep 30), `awesome-claude-code.resources@d9b87c2.csv` (keep the header and 30 rows), `ponytail.plugin.json`, `ponytail.hooks.json`, `caveman.plugin.json`
  - Record ETag and rate limit headers as a small JSON next to each body, so 304 handling and limit backoff are tested.
- **Git in tests** uses local bare repos made in a temp folder, never github.com. The existing `real-plugins.test.ts` stays the only test that clones from GitHub, and it skips offline.
- **Data tests** (catalog backend): every `RECOMMENDED` item passes the checks in `/tmp/cg/ecosystem/spec-tools/check.ts` (run with `bun` from the repo): unique ids prefixed by kind, full shas, every placeholder has an input and every input is used, no secret in `args` or `url`, plugin sources name a known marketplace, overlaps and recipe and suggestion references resolve, ponytail and caveman are the only `must` items and come first.
- **Recipe tests** (hooks): `hook-recipes.test.ts` runs every `HOOK_RECIPES` test case through `Hooks` from the data file alone, skipping cases whose `needs` are missing on the machine. Also assert that each script is valid bash (`bash -n`).
- **Suggestion tests** (routines): every schedule parses, no suggestion id clashes with a template, every agent is built in or in `SUGGESTED_AGENTS`, every suggestion with a Bash allow rule lists `bash-allow-safe`, every prompt asks for a STATUS line, and both suggested agents parse with `parseAgentMarkdown` with no `tools`. Permission tests from the research (`perm-agent.ts`, `perm-check.ts`, `perm-mem.ts` in `/tmp/cg/ecosystem/routines/out/evidence/`) become regression tests for P0 items 1 and 2.
- **UI**: Playwright screenshots of Discover (desktop and phone, light and dark), the preview sheet for ponytail, github and a hook recipe, and the Routines Suggested section, against the mock.

---

## 7. Split of work for the builders

Each builder owns the files listed. Where two builders touch one file, the owner of that file is named and the other asks for the change through the orchestrator.

### Builder 1: catalog backend

- New `packages/core/src/catalog/`: `service.ts` (merge, rank, search, installed state), `github.ts` (client with ETag cache, rate state, token from secrets, repo-qualifier star batches, GraphQL batches with a token), `registry.ts` (official MCP registry, trust rule, config derivation), `feeds.ts` (star index, CSV, Docker YAML, marketplace.json over raw), `detect.ts` (kind detection from a tree), `install.ts` (preview plans, install, update, rollback, remove for mcp, plugin, files; delegates hook and routine kinds), `git.ts` (ls-remote, blobless clone, sparse checkout, fetch by sha).
- Storage tables and migration in `packages/core/src/storage/db.ts` (catalog_http, catalog_items with FTS5, catalog_installs).
- Routes in a new `packages/server/src/routes-catalog.ts`, registered in `app.ts`.
- Client methods and DTOs in `packages/core/src/client/index.ts`, block "catalog" (2.1), plus `importTasks`.
- Plugin installer fixes 1.9 in `packages/core/src/extensions/plugins.ts` (owner of that file).
- MCP manager fixes 1.8 items 1 to 3 in `packages/core/src/extensions/mcp.ts` and `McpServerConfig.cwd` and `inheritEnv` in `config/schema.ts`.
- Daily refresh job on the scheduler.
- agentic-tools import (1.10), last.
- Tests: section 6 catalog and data tests.

### Builder 2: Discover UI

- New `packages/web/src/features/extensions/Discover.tsx` and `features/extensions/discover/` (rows, filters, status line, token dialog, PreviewSheet, install progress, detail).
- The `discover` entry in `TABS` in `ExtensionsPage.tsx`, the Overview quick action, and the "Find ... in Discover" links in Tools, Skills, Commands, Plugins, MCP servers and Hooks tabs (one line each).
- Routine rows deep-link to `/routines?suggest=<id>`; hook rows use the generic preview (scope options for recipes).
- `packages/web/src/mock/discover.ts` serving catalog, recipe and suggestion routes from the shipped data.
- Playwright screenshots (desktop, phone, both themes).
- Depends on the client types from builders 1, 3 and 4. Start against the mock with the DTOs in section 2; the shipped data types already exist.

### Builder 3: hooks

- New `packages/core/src/extensions/recipes.ts` (install, remove, test runner with the fixture, export to Claude Code, Codex and Gemini settings on a device).
- Routes `/api/hooks/recipes*`, `/api/hooks/lint`, `/api/hooks/builtin*` in `packages/server/src/routes-extensions.ts` (owner of the hooks routes there).
- Client block "hook recipes" (2.2).
- Engine changes 4.3 P0 and P1 in `packages/core/src/extensions/hooks.ts`, `engine/create.ts` (hook merge, env), `session/runner.ts` (tool_response objects, rewrite verdicts, the multi-block spill fix) and the `Dockerfile` apt line. P2 items 16 and 17 if time allows.
- Hooks tab additions in `features/extensions/Hooks.tsx` and `hooks/`: "from recipe <id>" on handler rows with Remove, lint warnings in the handler form, the Built in section, and the per-handler token line.
- Tests: `hook-recipes.test.ts`, lint tests, a parity case for `tool_response` objects, prompt hook `ok` shape, Stop cap.

### Builder 4: routines

- `packages/core/src/scheduler/` (owner): RoutineInput and Routine fields (2.3), suggestions service (`GET /api/routines/suggestions`, add with agent creation and device fan-out), status outcome parsing, precheck, timeout and cost caps, env, `@never`, webhook payload and queue.
- Security fixes 5.3 P0 in `packages/core/src/engine/permissions-view.ts` and `packages/core/src/session/permissions.ts` plus `tools/bash-rules.ts` (owner of those files). Hooks builder does not edit them.
- Unattended approvals in `engine/engine.ts` (`requestApproval` for routine sessions) and `engine/create.ts` `runRoutine` (coordinate with builder 3 on create.ts: routines builder edits only `runRoutine` and the routine wiring).
- `agents-defaults/librarian.md` patch, sysadmin host naming, shipped template fixes in `templates.ts`.
- Routes in `packages/server/src/routes.ts` routines block; client block "routines" additions.
- Routines UI: the Suggested section and Add sheet in `packages/web/src/features/routines/` (new `Suggested.tsx`, `AddSuggestion.tsx`), the editor fields for allow, precheck, env, timeout and cost, and the outcome word on runs. The mock routes for suggestions come from builder 2's `discover.ts`; extend it there through the orchestrator if more is needed.
- P3 tools (RoutineRuns, SessionsSearch, SessionRead) if time allows, since Routine doctor and Agent tune-up wait on them.
- Tests: section 6 suggestion and permission tests.

### Order

1. Builder 4's P0 security fixes land first; routine allow lists and the rtk recipe depend on them.
2. Builders 1, 3 and 4 add their client DTOs and method stubs early, so builder 2 can build against real types.
3. Builder 1's plugin sha fix lands before ponytail and caveman are installed from Discover in any demo, so the pins hold.

---

## 8. Later, not in this round

- MCP OAuth for remote servers, `mcpb` bundles, and stdio servers spawned on a device.
- Project `.mcp.json` servers (still listed but not started).
- Plugin `userConfig` prompts, `bin/` on PATH, LSP servers and output styles.
- A native per-session "style" setting (terse, minimal code) that injects a skill body at session start and into subagents without a node process per prompt, as a lighter path than the caveman and ponytail hooks.
- A "Recommended for this project" panel in Discover from a repo scan (claude-code-setup's reference files are a ready map).
