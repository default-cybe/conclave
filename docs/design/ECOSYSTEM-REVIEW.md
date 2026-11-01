# Ecosystem round: review

This is the whole-app review after the Discover, hook recipes and suggested routines round (spec: [ECOSYSTEM.md](ECOSYSTEM.md)). It lists what was checked, what was fixed and what is left. Date: 2026-10-17.

## What was checked

**Builds and tests.** Core, server, cli and web typecheck clean. `bun test` from the repo root passes 1,078 tests in 92 files (core, server and cli). The web package passes 60 tests. `bun run build` in `packages/web` works; its only warnings are four older lightningcss notes about `::highlight`, which are not from this round.

**Mock sweep** (Vite with `VITE_MOCK=1`). Every Extensions tab (Overview, Discover, Tools, Skills, Commands, Hooks with its Events, Recipes and Built in views, Plugins, MCP servers, Sources), the ponytail preview, the recipe sheet, the Routines Suggested section, the Librarian Add sheet and the command palette, at 1440x900 and 390x844, in dark and light. No console errors or warnings, no sideways scroll at 390 px. All 57 in-app links found on those screens land on their own page. Visible text has no long dashes and none of the banned words.

**Real hub** (`conclave serve` on port 8020 with its own home folder):

- MCP server: markitdown from Discover, test connect passed with 1 tool, saved and connected.
- Skills: karpathy-guidelines (through the API) and skill-creator (by clicking Add in the Discover sheet on a phone layout), both fetched from GitHub at their pinned commits, both loaded as user skills.
- Hook recipes: secrets-firewall through the catalog routes (4 of 4 tests passed) and Git work saver by clicking Add in Discover (3 of 3 passed). Both landed in `config.json` with their scripts at mode 0755.
- Plugin: ponytail installed at 16352ac, its hooks turned off and on again with the new switch, then removed with its marketplace clone.
- Routine: the Librarian deep pass added with the suggestion route and again from the Add sheet in the Routines tab. It was made paused, on the only device, in `/root/code`, with its five allow rules and its precheck. The librarian agent blocks all 7 tools it should.
- Search: api.github.com is blocked in this sandbox, so the hub pointed `CONCLAVE_GITHUB_API` at a local server that replays the recorded fixtures. Live GitHub search was not run against the real API. The registry, marketplace, star index and awesome-list sources were fetched live.
- Everything installed was removed again through `DELETE /api/catalog/installed/:id`, and the hub, the fixture server and both Vite servers were stopped by PID.

## What was fixed

1. **Needs with a version or a flag looked missing.** Recipe needs like `jq 1.6+` and `grep -P` were checked as program names, so rows said "Needs grep -P on the hub" even with grep present, the starter set included. The hub and the mock now check the program and keep the rest in the reason. (`catalog/service.ts`, `mock/discover.ts`)
2. **Recipes and routine suggestions came back in alphabetical order.** On a real hub Agent tune-up was first instead of the Librarian. They now keep the shipped order, after curated items. (`catalog/service.ts`)
3. **A bad push date beat every real one.** A repo with no push date became `nullT00:00`, which sorts after every real date, so ponytail lost its "updated" word. Dates that are not dates are now dropped. (`catalog/github.ts`)
4. **The frontmatter fallback kept only the first list item.** When an agent's YAML did not parse, `disallowedTools` and `tools` lists lost every item after the first. The routines QA fixed the librarian's own file; the loader is now fixed for every agent and plugin. (`extensions/loader.ts`)
5. **Plugin hooks could not be turned off after install.** The hub had the switch inside but no route or control. `PATCH /api/plugins/:name {"hooks": false}` now works (audited), the client has `setPluginHooks`, and the plugin sheet has a Hooks On / Off row that keeps skills, commands and agents. (`server/src/routes.ts`, `client/index.ts`, `plugins/PluginSheet.tsx`, `mock/ext-runtime.ts`)
6. **Routines made from a suggestion showed their run rules as the summary.** The row now shows what the routine does. (`routines/RoutineList.tsx`)
7. **Wording.** "pipe a download" is now "pipes" for one file; a tunable with no default said "Default ." and now says "Empty by default."; one installed plugin said "All 1 are on." (`catalog/inspect.ts`, `hooks/RecipeSheet.tsx`, `plugins/Installed.tsx`)
8. **The Discover mock drifted from the hub.** It listed `routine-env` as closed, and its recipe routes left out `file`, `note`, `ready` and `scriptPath` and ignored project folders and CLI targets. It now uses the hub's `CLOSED_GAPS` and answers like the hub. (`mock/discover.ts`)

New tests: shipped order and program-only needs (`core/test/catalog/service.test.ts`), bad push dates (`core/test/catalog/github.test.ts`), list items in the fallback parser (`core/test/extensions/loader.test.ts`), the plugin hooks switch route (`server/test/extensions-routes.test.ts`) and the recipe mock shapes (`web/test/discover-mock.test.ts`).

Docs: a Discover section, pinned plugin commits, the plugin hooks switch and the MCP environment rules in [EXTENSIONS.md](../EXTENSIONS.md); the features table in the README; `catalog-prev`, `CONCLAVE_GITHUB_API` and `CONCLAVE_CATALOG_OFFLINE` in ECOSYSTEM.md.

## What is left

**Security, worth doing next**

- Bash on the hub device runs with the hub's own environment, including `CONCLAVE_TOKEN` and provider keys. `printenv` and WebFetch count as read-only for ordinary sessions, so a prompt injection could read a key and send it out. Suggested routines are protected (default mode, WebFetch needs a rule); other sessions are not. Hook commands also get the whole environment, as in Claude Code.

**Not built in this round**

- Routine env (Uni calendar sync), the RoutineRuns and session tools (Routine doctor, Agent tune-up), and the webhook queue, header-only secret and `@never` (Alert triage). These suggestions stay disabled with "Needs a hub update".
- Questions as Inbox items during unattended runs, and `mcp__server__*` in `filterTools`.
- The `conclave hook` CLI subcommands and the folder filter on memory search (hooks P2 items 17 and 18), and all of hooks P3.
- The `shareClaudeConfig` toggle per plugin (the runner reads the flag; nothing sets it).
- The optional skillspector or agnix scan in the preview, the item detail's tree summary, and a "Run on hub" button for setup steps.
- The preview names other kinds a repo holds only in warning text; the UI reads it from there.

**Known limits**

- Live GitHub search and GraphQL star batches were tested only with recorded responses. The rate-limit headers in the fixtures follow GitHub's documented format but were not recorded.
- Open previews live in memory, so a hub restart drops them. A failed second plugin in a multi-plugin install leaves the first installed without an install record. Update preview cannot tell local edits from upstream changes.
- Adding the same suggestion twice on the same device makes two routines; the sheet shows "added" and links the existing one, but the route does not refuse.
- The librarian prompt trials were not rerun, and no routine ran end to end with a real model (no provider key in the sandbox).

## Screenshots

In `/tmp/cg/ecosystem/review/shots/`: the mock sweep (`discover-*`, `preview-ponytail-*`, `recipes-*`, `routines-suggested-*`, `routine-add-librarian-*`, `tab-*`, `palette-*`, `plugin-hooks-*`) and the real hub (`real-*`). The scripts are `sweep.mjs`, `real.mjs`, `ui-install.mjs`, `ui-routine.mjs` and `plugin-hooks.mjs` in `/tmp/cg/ecosystem/review/`.
