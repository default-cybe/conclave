# Round review: remote access, notifications, chat-first Home

This is the whole-app review after the round that answered the owner's three asks:

- "Why connect via Tailscale? My Claude Code works without it."
- "No Telegram or ntfy. Pure on this app only."
- "If Home is not there we should have it, with a normal chat like ChatGPT and claude.ai."

Each area had a builder and a QA pass, and Android had its own. This review checked the whole app after them, fixed what it found, and brought the docs in line.

## What the round built

**Remote access** (DESIGN.md section 14). Phones on the same Wi-Fi connect right away. One switch gives the hub an https address through a Cloudflare quick tunnel that the hub downloads, checks and runs itself, with no account. A stable name on your own Cloudflare domain, Tailscale and your own URL are the other choices. Pairing codes carry every address. Apps, daemons and the terminal app follow the hub when its address changes. Wrong tokens and pairing codes are rate limited and audited.

**Notifications** (DESIGN.md section 11). Telegram, ntfy and UnifiedPush are gone. Notices reach you inside Conclave: toasts and the Inbox, Web Push in browsers, native notifications in the desktop app, and the Android app's own connection. Each app reports whether it is in use, so a phone stays quiet while you are at the desk.

**Home** (DESIGN.md section 15, SPEC 11.1 and 12.3). Home opens on a greeting and the new chat composer. A switch on the box starts an agent session instead. Recent chats sit under it, and the status page is below.

## What was checked

- **Typecheck.** core, server, cli and web. Clean for this round's code. See "Left" for one file from other work.
- **Tests.** `bun test` from the root: 1066 pass, 0 fail. The web tests (`bun test packages/web/test`): 43 pass. The desktop shell (`cargo test` in `packages/desktop/src-tauri`): 6 pass, 3 of them new.
- **Build.** `bun run build` in `packages/web` passes. The main bundle is about 393 KB (121 KB gzip).
- **Mock app sweep** at 1440x900 and 390x844, dark and light: Home, a new chat, a chat, Sessions, a session, Inbox, Devices, the pairing dialog, every Settings section, the phone Settings index, every setup step with `?fresh=1`, and the command palette. 118 screenshots. No console errors or warnings. No sideways scroll at 390px.
- **Flows in the mock.** Setup from step 1 to Done and into Home, on desktop and phone. Sending a chat from Home opens the chat and Back returns to Home. Session mode starts a session and opens it.
- **Leftovers.** Every hit for telegram, ntfy, unifiedpush and tailscale outside `packages/android` was read. The ones left are on purpose: config migration and its tests, the memory filter for token shapes, sample memory and chat text, agent prompt test scenarios, catalog entries that reach a device's own MCP server over Tailscale, the Tailscale option itself, and the old design reference pages.
- **Copy.** No em or en dashes and none of the banned words in this round's code and docs.
- **Real hub** on port 7920, stopped by PID afterwards:
  - Quick mode downloaded cloudflared, ran it, and showed a clear error, because this sandbox cannot reach Cloudflare: "cloudflared could not reach Cloudflare (...). Check that the hub has internet access and working DNS." The hub retried with backoff. Settings, the pairing dialog and `conclave serve` all said the same thing and offered Try again.
  - Twenty different wrong tokens from one forwarded address gave 429 with `retry-after: 60`. Thirty tries of one stale token were not blocked. This computer itself, with no proxy header, was never blocked.
  - Ten wrong pairing codes gave 429. A fake daemon paired with a device code, came online and went offline when stopped. The same code a second time was refused. All of it reached the audit log.
  - The notification endpoints answered as documented, and `/api/notify/unifiedpush` is 404.
  - Home on the real hub showed the first day state, and a chat that failed for lack of a key showed one toast that says how to fix it.

## What this review fixed

**Desktop app and changing addresses.** The docs said the desktop app follows the hub to a new address. It did not. Its page comes from the hub, so a move to another address opened in the browser, and a dead address at start left only the connect form.
- The shell now treats a move to another address that carries its own token as the hub moving. It saves the new address and grants it notifications.
- It keeps the hub's address list from pairing and from `GET /api/remote`. On start, when the saved address does not answer, it tries those in order, never an old quick tunnel name.
- Pairing links with `alt` addresses try them in order.
- In the desktop app the web page now moves by itself instead of showing "Open it". When the address is lost, the toast says to quit from the tray and open the app again, instead of a link that cannot load.
- Files: `packages/desktop/src-tauri/src/{hub,main}.rs`, `packages/desktop/src/main.js`, `packages/web/src/lib/remote.ts`, `packages/web/src/store/store.ts`.

**The terminal app held notifications forever.** It never reported presence, so while it was open the hub treated someone as at the desk. It now connects as in use and says so again when you type, at most every 20 seconds. A terminal left open while you are away stops holding notifications after `idleSeconds`. Test added in `packages/cli/test/tui.test.ts`.

**Two toasts for one failure.** A failed turn showed "Conclave. Error: ..." and "Session error ..." at once. They now share one toast, and the later one wins.

**Remote access screens.**
- Settings offered "Show a pairing code" when only this computer could reach the hub. That group now hides until there is an address a phone can use, and the line above says what to turn on.
- The pairing dialog said "this code only works at home" on a hub with no home network address. It now says "The tunnel is not working yet."
- The "Show a pairing code" button lines up with the other controls.

**Wording.**
- The hub's wrong pairing code error said "invalid or expired pairing code". It now says what to do: make a new one on the Devices page or with `conclave pair`.
- The offline page told people to join the tailnet. It now says to check the hub and its address.
- Defaults said "the quick start bar", which is gone. It now says new chats and sessions use the default model.
- Home said "last seen 0s ago" and "5 hours, Block". They now read "last seen just now" and "5 hours".
- Running on Home said "Nothing running." right under the sentence that said it. It now says how to start a session.
- CLI help said Devices was under Settings. It is its own page.

**Finding remote access.** The command palette now lists every Settings section as a page, with words people search for, so "tunnel", "phone" or "away" finds Remote access.

**Docs.**
- README describes the chat-first Home and setup with remote access.
- DESIGN gains section 15 (Home) and corrects sections 11, 13 and 14: terminal presence, the wave's uses, the desktop app and addresses.
- SPEC 11.1, 12.3, 9.3, 9.4, 11.9, 11.10, 11.11 and 11.12 match the new Home, the pairing dialog, Settings > Remote access and step 1.
- CHAT-AND-MOTION.md notes the greeting is on Home too.
- INSTALL covers Docker on the Wi-Fi, the Android switch and the desktop app following the hub.
- MEMORY.md and `packages/mobile/README.md` use a hub address instead of a tailnet name.

## Left

- **Live tunnels.** A live quick tunnel and real Cloudflare API calls are still untested. This sandbox has no DNS for Cloudflare. The error path is tested on a real hub, and stable mode against fakes only.
- **The desktop app** was built and unit tested. Its window was not run here: there is no display. Following a move and falling back at start need one check on a real desktop.
- **Docker on the Wi-Fi.** The hub cannot see the server's own Wi-Fi address from inside a container. Pairing codes leave it out, and INSTALL says to type it on the phone.
- **A dead quick tunnel in a browser tab.** An https page cannot fall back to a plain http address on the same network. It asks you to pair again, as the docs say.
- **Hub checks not done.** A push address whose hostname resolves to a private address is not refused. Behind your own proxy that strips `X-Forwarded-For`, every client counts as one address. Re-pairing leaves the old client entry until the owner revokes it.
- **Other work in the tree.** `packages/core/test/engine/routine-permissions.test.ts` fails typecheck: `Tool<BashInput>` against `Tool<Record<string, any>>`. It comes from the permissions work running alongside this round, not from this round. Its tests pass.

## What the Android app relies on

The Android report lists the hub API it uses, and nothing in this review changed it. Two things are new for apps:
- The wrong pairing code error is now a full sentence. Android shows its own text for 400, so nothing changes there.
- Pairing links may carry several `alt` addresses. The desktop app now tries them in order, as Android already does.
