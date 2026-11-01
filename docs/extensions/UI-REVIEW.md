# Extensions, memory and agents UI: whole-app review

This is the review after the four build areas (Extensions catalog, Extensions runtime, Memory and agents, punch list) were built and checked by QA. It records what was checked, what was fixed, and what is left.

## What was checked

- `bun run typecheck` and `bun run build` in `packages/web`, typecheck for core, server and cli, and `bun test` for all packages.
- Every page in the mock hub at 1440x900 and 390x844, in dark and light: Home, Chats, a session, Inbox, Tasks, Routines and one routine, Agents and one agent, every Extensions tab and the phone index, every Memory tab, Usage, Devices and device files, every Settings section and the phone index, and the command palette. 148 scenes in all.
- First run with `?fresh=1`, from Welcome through all ten steps to Home, in all four size and theme pairs.
- Every in-app link on 35 pages (145 links), opened one by one: where it lands, whether the `#anchor` exists, console output.
- The old routes: `/settings/hooks`, `/settings/mcp`, `/settings/plugins` and `/memory/connections#share`. Also `?agent=`, `?event=` and unknown tabs.
- Escape, focus on open and focus on close for the drawers and dialogs in Hooks, MCP servers, Memory, Gateway keys and Backup.
- Copy: no em or en dashes and none of the banned words in `packages/web/src`, the shipped agent files and these docs.
- A real hub on its own home, with the app pointed at it: every Extensions tab, every Memory tab, the agent pages, About and Permissions, on desktop and phone. No request failed.

## What was fixed

Links and state

- Tools ignored `?agent=`, so "Permissions per tool" on an agent's page opened with all agents. It now opens with that agent, and the picker keeps the address in step.
- The Overview quick action for sharing memory now goes straight to `/memory/share`. The old `#share` link still redirects.
- Settings, Permissions now says where per-agent rules and hooks moved, with links to Extensions, Tools and Extensions, Hooks.

Layering and focus

- Menus and pickers opened behind dialogs and side sheets. The device picker in "New gateway key" was hidden under the dialog. Popovers now sit above dialogs.
- "Paste from another CLI" opened with focus on the page behind. The drawer now focuses the paste box.
- "Add a connection" opened with focus on Cancel, because the store list loads after the panel opens. Focus now moves to the first store.
- Focus is picked a frame after a dialog opens, so a form that switches mode on open still gets a field.

Touch targets

- Confirm dialogs had 30px buttons on phones. They are 44px now.
- The Copy button on code blocks and commands was 24px on phones and could sit on the first line of text. It is 44px, code blocks get their header line on phones, and commands keep room for it.
- "Test a call" on the Tools tab was hidden on phones. It shows now.

Data and wording

- The mock had two lists of MCP tools. Tools and Overview counted 61 MCP tools while MCP servers listed 44 (github 41 against 16). Both now read one list, and github lists 24 tools.
- Overview said "MCP servers 5, 4 of 5 connected" while the tab said 6 servers. It now says "5 on, 4 connected". Plugins says "3 of 4 on", the same word as the Plugins tab.
- MCP and hook problems on Overview now say what to do next, the same advice the MCP servers tab gives.
- Hooks from `~/.conclave/config.json` were labeled "config". They read "user", like the scope picker. MCP rows say "from your config".
- "read-only" and "read only" were mixed. It is "read only" everywhere.
- Plugin details and the hook import preview said "no matcher". They use the same words as the Hooks tab: "Every tool", "Always", "Every source".
- The phone Extensions index cut each tab's explainer mid-sentence. Each tab now has a short line for the index.
- `mcp__server__tool` in the MCP servers explainer is in mono.
- The agent editor showed every tool unticked on built-in agents, because a read-only style cleared the checkbox fill. Ticked boxes show again.
- The palette listed loose session matches above the page you typed. With a query, the group with the best match now comes first, so "ext" puts Extensions on top.
- The Import tab now lists `AGENTS.override.md`, which the hub reads.
- On a real hub, opening an agent that is not built in logged a 404, because the page asked for a shipped default. It now checks the built-in names in the inventory first, once per page load.
- Home showed "ios" for a phone. It says "iOS", and "macOS" keeps its case.
- The shipped `librarian`, `security` and `sysadmin` descriptions used " - " as a dash. They use a colon now.
- The hub's MCP note and its pairing hint said "Settings > ...". They now say "Settings, Gateway keys" and "the Devices page", like the rest of the app.

Hub

- The hub called itself "Conclave", so the top bar read "Hub Conclave online". It now uses its own device name, the host name unless renamed.
- Each sync to other CLIs wrote two audit entries. The route writes one, with who asked, the device and the CLIs.
- Closing the live connection while it was still connecting made the browser log a warning on every page load in development. The client now waits for it to open, then closes it.

## Results

- Typecheck is clean for web, core, server and cli. The web build passes.
- `bun test`: 765 tests pass across core, server and cli.
- The sweep has no console errors or React warnings, and no sideways scroll at 390px.
- All 145 links land where they should.

## What is left

- A gateway route that is off answers 403 before the key is checked, so anyone can see that it is off.
- Marketplace search results carry no component counts, so the install dialog can only warn in general terms. The exact "adds 2 hooks" line shows after install.
- `codex plugin add name@marketplace` comes from the research notes and has not been tried on a real Codex.
- "Copy to user", "New skill", "Open folder" and running a command's full expansion on a device are not built. The hub has no routes for them.
- Rules added from Tools go to user scope only, because the config API has no project scope.
- Without a project, Overview counts 15 agents and the Agents page lists 16, because Agents also shows project agents.
- The mock prints a build warning about a circular import between `mock/index.ts` and `mock/punch.ts`. It only affects the mock chunk.
- An earlier QA run added a `playwright` server to `/root/.claude.json` in this container. Run `claude mcp remove -s user playwright` to undo it.
- Phone dialogs are bottom sheets up to 88% of the screen, as the spec says, not full screen. The detail sheets in Extensions are full screen.
