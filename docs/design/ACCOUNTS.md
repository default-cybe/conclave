# Accounts: several people on one hub

The owner asked: "If I host the hub, can I have multiple users, so my friend can use the same hub with his account for his work? He doesn't have to use Basic Memory."

Until now a hub had one owner. One password, the hub token, every paired app and every paired device were the owner's, and every row in the database was the owner's. This round adds accounts: an owner and members, each with their own chats, memory, keys and devices, on one hub.

## 1. What an account is

An account is one person on the hub.

| Field | Meaning |
|---|---|
| `id` | `owner` for the owner, `acc_<time><random>` for a member. Fixed for life. |
| `name` | The sign-in name: what the person types to sign in. Unique on the hub, case does not matter, 1 to 40 letters, digits, `.`, `_` or `-`. The owner starts as `owner` and can rename it. |
| `displayName` | What the apps show and greet the person by ("Kai Ahir"): letters of any script, digits, spaces and common punctuation (`. , ' " ( ) & ! ? @ + : ; / # _ ~ -` and curly quotes), trimmed with each run of spaces made one, 1 to 60 characters. Never used to sign in, and not unique. A member starts with their sign-in name unless the owner gives one; the owner starts with none. Optional: empty or `null` clears it. |
| `email` | Optional. Signs in too, in place of the sign-in name (section 4). Unique on the hub, case does not matter: a new person or a changed email that someone else already has gets 409 "Another person already has that email." Two accounts that shared an email before this rule keep it, but it signs neither of them in. Shown on the People page; never used to send mail. |
| `role` | `owner` or `member`. There is exactly one owner. |
| password | An argon2id hash, like the hub password before. Optional: a person can sign in with a pairing code or an invite instead. |
| invite | The SHA-256 of a one time invite secret and its expiry (7 days). |
| `settings` | Provider access and budgets (set by the owner) and the person's own preferences (default model, small model, default agent, import watch). |

The table is `hub_accounts` in the shared database (`core/src/people/store.ts`). The owner row always exists; its id is the constant `owner`, so every old row can point at it without a lookup.

**Which name shows.** Apps show a person by `shownName` (`core/src/client/people.ts`): the display name as it was typed; one that is still the sign-in name gets a capital first letter (`riley` shows as Riley); with none, the sign-in name the same way; the owner's default `owner` is no name, so Home says "Good evening." and the account menu "No name yet". A new sign-in name carries along a display name that was none or the old sign-in name, so an app that only knows sign-in names still renames the person everywhere; a display name set apart stays. Why two names: the sign-in name is typed on a phone's login screen and in `conclave login --account` (the email works there too), so it stays one short word; the name people are greeted by and see in People can be "Kai Ahir" or "Zoë O'Brien".

Why a fixed owner id: the migration is one `ALTER TABLE ... DEFAULT 'owner'` per table, and code that knows nothing about accounts (an older module, a test, a merge from another branch) keeps working as the owner, which is exactly the behavior before accounts.

Roles: only `owner` and `member`. The owner is the admin. A second admin is not needed for a household or a few friends and would double the cases to test. It can come later as a role without a schema change.

## 2. What is per account and what is shared

**Per account** (each person sees only their own):

- sessions and chats, their messages, todos, checkpoints, turns, stored tool output and locations
- live approvals and questions, and the Inbox they make (alerts follow their session)
- notifications: Web Push subscriptions, and the "someone is looking" hold per person
- memory: profile, facts, procedures, episodes, the review queue, and memory connections, so one person can use Basic Memory and another not
- goals, the assistant's preferences (quiet hours, what to tell), Today and day plans
- routines and their runs, the daily digest
- tasks
- usage and cost rows, and the budget each person has on the hub's keys
- paired devices and paired apps (tokens), pairing codes and invites
- projects and their folders across devices, path pairs between devices
- chat import sources, batches, the ledger and uploads
- the GitHub token and repo sessions
- calendar and mail: the CalDAV, IMAP, Google and Microsoft accounts, their app passwords and refresh tokens (in the person's own secrets file), the short ids the tools use, the proposals waiting for approval, and what Today and the day plan read
- workflow runs (through their session) and dismissed findings
- connected apps (claude.ai, ChatGPT through OAuth) and what Conclave's own MCP endpoint (`/mcp`) shows: a token or an app sees its own account's memory, chats, tasks and routines
- the audit log: each person reads their own entries
- the person's own provider keys and GitHub token (`<home>/accounts/<id>/secrets.json`, mode 0600)
- preferences: default model and agent

**Shared hub wide** (set by the owner, used by everyone):

- `config.json`: providers, models, permissions, notification rules, limits, browser, the UI defaults
- the hub's provider keys and subscriptions, which a member uses only where the owner allows it. A member's own signed in plans are theirs, on a CLIProxyAPI of their own (section 12)
- agents, skills and commands that ship with Conclave or come from plugins the owner installed
- the hub device itself, its name and its address (remote access, tunnels)
- the response cache for chores (a hit needs the exact same input, so it tells nothing new)
- embeddings and web search, which run on the hub's keys
- the hub's own Google and Microsoft OAuth clients for calendar and mail sign-ins: the owner sets them up, everyone signs in with them

**The owner's alone** (not shared with members even though they live on the hub):

- MCP servers, hooks and plugins configured on the hub: they run as the hub's OS user, so a member's session never gets them
- agents, skills, instructions and settings from the owner's home folders (`~/.claude`, `~/.conclave` user files, `~/.codex` and the rest): a member's session sees only builtin and plugin agents and skills
- the hub identity key, friends, shares and shared projects (section 7)
- the log files and their export: hub wide, read by the owner only. Any app sends its own lines (`POST /api/logs/client`), and a member's lines carry `account`, as do the hub's own lines written while a member's work runs. They hold ids of everyone's work, never its words. A member's apps cannot push the owner's history out: all their apps together send 100 lines an hour (an owner's app 1,000), and their lines never make room at the size cap (they are dropped, warnings and errors too, where the owner's lines would delete the oldest day) and keep to a tenth of the cap over the kept days (`MEMBER_SHARE` in `logs/sink.ts`, a day's part counted since the hub started that day)
- watches and the browser sign-in (Settings, Browser): they browse with the hub's Chromium, so they are the owner's for now. A member cannot make a watch (`routines.create` and `update` refuse a `watch` for a member, and the WatchCreate and WatchReport tools are not theirs)
- maps: the key, the home and the daily cap are the owner's, and so are the tools. A member's session gets no PlaceSearch, PlaceDetails, Directions or MapImage, and no leave-by times ("Maps use the hub owner's key, daily cap and home, so they are the owner's on this hub."). Why: the hub's maps key has no per-person allowance or budget the way provider keys do, the daily cap is one counter for the hub, and leave-by starts from the owner's home. A per-person maps allowance can come later in the provider access model
- gateway keys and OTLP ingest: they serve the owner's own CLIs
- Maps settings and key, routine suggestions (they install agents and MCP servers), the Discover catalog and installs, backups and restore (a backup holds the owner's data only, and a restore is the owner's)
- the hub's own entries in the audit log (blocked addresses, remote access)

The owner does not see members' chats, memory or keys through the API or the apps. The owner runs the machine, though, and can read the database file and every secrets file. A member has to trust the owner; this is a household or friends feature, not a hosting product. The invite page says so, and section 8 says it plainly.

## 3. Data model

**Rule:** a table whose rows can be found without going through a parent row has an `account_id` column. A child table that is only ever reached through its parent's id is scoped by the parent: messages through their session, routine runs through their routine, workflow calls through their run, goal entries through their goal, path pairs through their device. Any query that reads a child table on its own (full text search over messages, the Map's runs) joins the parent and filters on the parent's `account_id`.

`account_id TEXT NOT NULL DEFAULT 'owner'` is on:

- tables of the shared migration (storage/db.ts): `sessions`, `tasks`, `routines`, `memories`, `usage`, `devices`, `clients`, `pairing_codes`, `push_subscriptions`, `gateway_keys`, `audit`
- module tables, added by each module right after its `CREATE TABLE IF NOT EXISTS` with `ensureAccountColumn(db, table)`: `projects`, `goals`, `import_sources`, `import_batches`, `maps_items`, `oauth_grants`, `oauth_codes`, `pim_proposals`

A watch's items and runs (`watch_items`, `watch_runs`) are children of their routine. Friends' blocks and shared projects are the hub's (the owner's), like friends and shares. Calendar and mail accounts and short ids live in kv under the account's keys (`accountKey`); the hub's OAuth clients keep the one hub wide key.

`usage` also gets `paid_by` (`hub` or `own`): whose key served the call. Budgets count only `hub` rows.

Every table lives in exactly one list in `core/src/people/tables.ts`: `ACCOUNT_TABLES` (has `account_id`), `CHILD_TABLES` (child to parent) or `HUB_TABLES` (the hub's own). A test (`server/test/people-sweep.test.ts`, "the tables") opens a full hub, lists every table in its database and fails when one is in none of the lists or when an account table has no `account_id`. Removing a person (`purgeAccount`) walks these lists, deepest children first.

`hub_accounts` keeps each lookup key beside the value, trimmed and in lower case: `name_key` (unique) for the sign-in name and `email_key` (indexed, not unique, so old rows that share an email stay) for the email. The store refuses a new email another account has.

Per account kv keys go through `accountKey(accountId, key)`: the owner keeps the old key, a member gets `acct:<id>:<key>`.

Per account files live in `<home>/accounts/<id>/`: `secrets.json` (the person's own provider keys and GitHub token, and a `hub` part for the keys of their own CLIProxyAPI), `basic-memory/` when the hub runs Basic Memory for them, and `cliproxy/` while they have a plan signed in (section 12).

## 4. Auth

Every request and every socket resolves to an account and a role.

- **The hub token** (`server.token`) is the owner's.
- **Paired app tokens** (`clients`) carry `account_id`. A pairing code carries the account of whoever made it, so an app paired with Alice's code is Alice's.
- **Device tokens** (`devices`) carry `account_id` the same way: a daemon paired with Alice's device code is Alice's device.
- **Password login**: `POST /api/login { account?, password, name, platform }` (`name` is the device's name). Without `account` it is the owner, so a single person hub keeps the old flow and old apps keep working. With `account` it is the person with that sign-in name or that email (`PeopleStore.bySignIn`), trimmed, case aside; a sign-in name has no `@`, so the two never clash. An email two old accounts share signs in neither. A wrong name or email, a shared email and a wrong password get the same answer ("Wrong name or password.") in the same time (a stand-in hash is checked when no one account matches), and count against the address like a wrong pairing code. `conclave login --account`, the web, desktop and Android logins all send `account`, so all take either. The reply carries `account: { id, name, displayName, role }` (`displayName` left out when there is none). A display name never signs in.
- **Invites**: the owner adds a person and gets a link, `<hub>/invite/<secret>`, good once for 7 days. `GET /api/invite/:secret` says whose it is; `POST` sets the password (12 characters or more) and signs in. The hub keeps only the SHA-256 of the secret, and a wrong secret counts like a wrong pairing code.
- **`GET /api/health`** says `people: true` when the hub has more than one account, so the login asks for a name only then.
- **`GET /api/me`** says who you are: id, sign-in name, display name, email, role, which providers you may use and whose key a call takes, your budgets and what you spent this month. `PATCH /api/me` changes your own sign-in name, display name (`null` or empty clears it), email and defaults. When the name the owner is shown by changes (here or on People), the hub also sets config `ui.name`, the name apps greet the owner by (Android's Home reads it), so Home on every app says it, older apps too; a greeting set apart in Settings, Appearance stays until that name changes, and one that was the cleared name goes with it. A member's `GET /api/config` carries `ui.name` set to their own shown name, never the owner's, and `GET /api/me` is only ever their own, so the owner's display name never reaches a member. `GET /api/people` (the owner) and `GET /api/invite/:secret` carry `displayName` too.
- **`/api/auth/password`** sets the caller's own password: a member from their app, the owner only with the hub token, as before.

The old owner password (kv `auth.password`) moves to the owner row.

**Routes.** One table, `server/src/route-policy.ts`, names every `/api` route and its rule, and one middleware (`routePolicy`) enforces it after the bearer check:

- `public`: no token (pairing, login, health, identity, invites, webhooks with their own secret, signed approval links)
- `admin`: the owner only (hub settings, providers, extensions, MCP, hooks, plugins, remote access, the update of the hub's CLIProxyAPI (`POST /api/subscriptions/update`), friends, shares and shared projects, backup, gateway keys, maps settings, the hub's calendar OAuth clients, watches and the browser sign-in, logs, People)
- `self`: any account; the handler works on the caller's account only (lists, creates, settings of your own). `server/src/scope.ts` has the helpers: `accountOf(c)`, `ownSession` and `ownDevice` for ids that come in a body or a query
- `own(kind)`: any account, and the `:id` (or `:sessionId`, `:device`) in the path must be one of the caller's own sessions, routines, memories, devices, calendar accounts, proposals and so on. The middleware looks the row up and answers 404 when it is someone else's, before the handler runs, the owner included, so a handler never sees another account's id
- `hub`: any account; hub wide facts that are safe to show (hub info, routine templates, the push key)

A route that is not in the table is owner only. Routes outside `/api` with their own check (the model gateway, OTLP, `/mcp` and its OAuth server, friends' hubs) are listed in `OWN_AUTH_ROUTES`. The route sweep test lists every route the app has and fails when one is in neither, so a new route cannot quietly open to members.

**Sockets.** Each event is stamped with its account when it is emitted (`EventBus` asks a resolver, `core/src/people/events.ts`: the event's own `accountId`, the account of the session, routine, task, memory, device, run or batch it carries). A socket gets only events of its own account and a short list of hub wide ones (`remote.updated`, `config.updated`). Hub settings events (limits, subscriptions, provider accounts, friends) are the owner's, except `subscriptions.updated` and `accounts.updated` when they carry an `accountId`: those are a member's own plans and go to that member only (section 12). An event the resolver cannot place goes to the owner only. The replay after a reconnect filters the same way. A removed person's or reset password's sockets close at once.

## 5. The hub machine

This is the security core. Tools run as the hub's OS user. A member's agent running Bash on the hub could read the owner's files, `secrets.json`, the database, and the owner's SSH keys.

- **Members get no shell or file tools on the hub.** A member's session on the hub gets a machine that refuses every call ("This runs on the hub's own computer, which only the hub's owner can use. Pair a device of your own in Settings, Devices, and work there."). No approval card is shown for a shell or file call that cannot run there. Chats and the assistant work: they need the model, web search and fetch, memory, goals and routines, none of which run on the hub's disk.
- **A code session on the hub is refused when it starts.** Creating a session that needs a machine (a coding agent from `CODING_AGENTS`, or a harness model) for a member on the hub answers 400 "Code sessions run on a computer you paired. Pair yours in Devices." (`CODE_NEEDS_DEVICE`): `POST /api/sessions`, `POST /api/tasks/:id/start` and `POST /api/github/sessions` (the engine's `createSession(..., { byPerson: true })`). Chats, the assistant and other agents still start there. Work the hub starts itself (routines, workflows, subagents) is not refused up front and meets the guard as before. Home's Session mode for a member with no paired device of their own shows that sentence with a link to Devices instead of starting, and for a member with devices the hub never stands in for one of theirs. The Android app shows the hub's text when a start fails.
- **One guard in one place.** Every `Machine` the device registry hands out is wrapped in a guard (`core/src/people/guard.ts`). The engine runs every request, turn, routine and job inside an account context (`AsyncLocalStorage`, `core/src/people/context.ts`). The guard refuses every call on the hub machine unless the context is the owner, and every call on a paired device unless the context is that device's account. Code that forgot to check still cannot reach the wrong machine. With no context (boot, a test), calls go through as before.
- **Members run coding sessions on devices they pair to their own account**, with the same daemon and desktop app as the owner. Sessions, workflows, routines and imports refuse another account's device.
- **What else a member's session does not get:** the hub's MCP servers, hooks (configured, plugin, project or agent command hooks), the browser tools (Chromium runs on the hub), learned skill writes (they would land in the owner's skills), "always allow" rules (they would change the hub's config; a member's "always" counts for the session), and project settings read from the hub's disk. WebFetch from a member's session refuses loopback, private and link local addresses, so it cannot reach the owner's network or the hub's own ports.
- **A member's calendar and mail servers** are never on the hub's network: a CalDAV address, an IMAP host and an SMTP host are checked when the account is added, and every CalDAV request of a member goes through a fetch that refuses private and loopback addresses.
- **A member's memory connections** are Basic Memory as the hub runs it (the default command only, in the member's own folder, with a bare environment that has none of the hub's keys), or an HTTP or MCP server at a public address. Never a program of their own on the hub, never one of the hub's MCP servers by name, never an address on the hub's network.
- **Hub workspace (optional).** The owner can give a member a place on the hub machine that cannot reach the owner's files: a separate OS user, or a container, running the ordinary daemon, paired to the member's account. The hub makes a device code for the member (People, Workspace in the web app, or `conclave people workspace <name>`) with the commands filled in: `useradd`, the install script, `conclave daemon pair`, `loginctl enable-linger` and `conclave daemon install --start` for a Linux user, or one `docker run` with its own volume. `docs/INSTALL.md` has them. The hub process itself never runs anything as another user and needs no root. Why this and not the hub switching users: switching users needs root or a setuid helper in the hub, and a container needs the Docker socket, which is root on that machine; both would make the hub a bigger target than the files it protects. A daemon under its own user is the same thing the owner already trusts for their laptop.

## 6. Provider keys and budgets

- **A member's own keys.** Settings, Providers on a member's account stores keys in the member's own secrets file. The member's calls use their own key first.
- **The hub's keys.** The owner allows a member to use the hub's key per provider, with a monthly budget in USD or no cap. Subscriptions through CLIProxyAPI show up as the provider `cliproxy` and are allowed the same way. Only a provider the hub has something to share for can be granted: a key, or none needed (a local server, `cliproxy` once subscriptions are set up), and turned on (`ProviderAccess.hubHas`). People in the web app lists only those, and the hub answers any other grant with 400 "The hub has no key for OpenAI. Add one in Settings, Providers first." (a harness: it runs on the person's own device, with nothing to share).
- **No access**: the person's model list has only what they can use, and a call fails with "You can't use Anthropic on this hub. Add your own key in Settings, Providers, or ask the owner."
- **Enforced in one place.** `streamCompletion` (session/stream.ts) is the only path to a model API. It picks the key for the call's account (own, then the hub's if allowed, `core/src/people/access.ts`), checks the budget before the call (`SUM(cost_usd)` of the account's `paid_by = 'hub'` rows for that provider since the first of the month, in the hub's time zone, plus what calls still running hold), and records the usage row with the account and who paid. A member's call on the hub's key holds an estimate of its cost (its input, and up to 1,000 tokens of answer) in memory from the check until its usage row is written or it ends (`ProviderAccess.reserve`), so calls started together see each other: they overshoot by one call at most, as calls one after another do, and the one that does not fit is refused with "Calls running now use the rest of your $20 monthly budget for Anthropic. Try again when they finish, ...". The owner's calls and a member's calls on their own key hold nothing. A call on the hub's key that ends mid-answer (Stop, a dropped connection) has no usage from the provider, so it counts an estimate of its input and of what was written; otherwise Stop would be a way around the budget. At the limit the call fails before anything is sent, with "You reached your $20 monthly budget for Anthropic. It resets on November 1. Add your own key in Settings, Providers, or ask the owner."
- **Chores** (titles, memory extraction, summaries) run on the account's keys and count against its budget. When the small model is out of reach for the person, they use their default model, or the first one they can use.
- **A member's own plans.** A member can also sign in their own Claude, ChatGPT or other plan in Settings, Models, Subscriptions. It runs on a CLIProxyAPI of theirs, and their `cliproxy` calls use it first (section 12). Those calls are `paid_by = 'own'` and count against no budget.
- **Harnesses** (Claude Code, Codex, Gemini CLI, OpenCode) run on the member's own device with the member's own login, so a member's subscription works without the owner.
- **The owner sees** each person's spend this month per provider on the People page.

## 7. Friends

The hub identity stays the owner's. A friend is another hub, and the friendship, the notes and the shares are between the owner's hub and theirs. Members do not see Friends, cannot send shares, and their sessions cannot be shared by the owner (the share routes check the session is the owner's). A share a friend sends lands in the owner's account. Shared projects are the same: owner routes only, the SharedProject tool and the sharing of new sessions only for the owner's sessions, and only the owner's chats and projects can go in one. Per account friends would need a key per account and a new invite format; that is a later round.

## 8. Threat model

**Assets:** each person's chats, memory, keys, GitHub token and devices; the owner's files and network; the hub's provider keys and budget.

**Who we defend against:** a member, and anything that steers a member's agent (a web page, a pasted document). Also a stranger on the internet, as before.

**Not defended:** the owner. The owner runs the machine and can read the database and every secrets file. The invite page tells the person.

| Threat | Defense |
|---|---|
| Member reads another account's data through the API | Route table: `own(kind)` checks ids before the handler; `self` handlers filter by account; lists and search filter on `account_id`; ids in bodies checked; route sweep test. |
| Member guesses ids | Ids carry about 50 random bits after the time, and a wrong id and someone else's id get the same 404. |
| Member gets another account's live events | Events stamped at emit time, sockets filtered, replay filtered, unknown events owner only. |
| Member's agent reads the owner's files on the hub | Machine guard refuses the hub for members; no hub MCP, hooks or browser for members; Basic Memory for a member runs with a bare environment in their folder. |
| Member's agent reaches the owner's LAN or the hub's own ports | WebFetch, memory connections and calendar and mail servers refuse loopback, private and link local addresses for members, with no redirects for memory connections. |
| Member spends the owner's maps quota or learns the owner's home | No maps tools or leave-by times for members. |
| Member reads the hub's logs | Log routes are the owner's; a member only sends their own app's lines. |
| Member's app floods the hub's logs | 100 lines an hour for all of a member's apps; their lines never make room at the size cap and keep to a tenth of it, so the owner's older days stay. |
| Member's agent uses the owner's devices | Machine guard on every paired device; sessions, workflows, routines and imports only on the account's own devices. |
| Member's recall or extraction sees another account's memory | One memory store per account; recall, search, extraction and the MCP tools filter by account; tests. |
| Member spends the owner's money | Hub keys only per provider the owner allows and the hub has a key for, a monthly budget checked before every call, chores included, with calls in flight held at an estimate. |
| Member changes hub settings | Admin routes, unknown routes owner only. A member's PUT on `/api/subscriptions` may only send `{ mode: 'builtin' }`. |
| A session reads a member's plan tokens or keys | Tools refuse `<home>/accounts/*/cliproxy` and every account's `secrets.json`, the owner's sessions too; the keys sit in a `hub` part that `${secret:...}` never reads (section 12). |
| Member's skill or rule lands in the owner's sessions | No learned skill writes, no "always allow" to the hub config, no hooks for members. |
| A connected app sees another account | An OAuth grant belongs to the account that allowed it; `/mcp` serves that account only. |
| Brute force of names, passwords and invites | Same answer and time for a wrong name and a wrong password; the existing per address limit and block; wrong invite secrets count the same. |
| A stolen member token | The owner removes the person or sets a new password; both revoke all their app tokens at once and close their sockets (removing also unpairs their devices and deletes their rows). |
| Downgrade of an old app that sends no name | No name means the owner, as before; only the owner's password works without a name. |

Where it can still fail: a route added without a rule is owner only, but a `self` handler that forgets `accountOf(c)` would list everyone's rows; the sweep catches it for lists that exist when the test runs. DNS rebinding could let a member's WebFetch or CalDAV request reach a private address between the check and the request, and an IMAP or SMTP host is checked only when it is added. A CalDAV server's redirect is followed by fetch. Web search and embeddings use the hub's keys for everyone.

## 9. Migration

`people/migrate.ts`, run by `openDb`, and `ensureAccountColumn` in each module after it creates its tables:

1. `CREATE TABLE IF NOT EXISTS hub_accounts`, then `INSERT OR IGNORE` the owner row.
2. Display names: when `hub_accounts` has no `display_name` column, add it and set it to the sign-in name on every account but the owner's still called `owner`, which gets none. Only when the column is new, so a display name cleared or set apart later is never filled in again.
3. Emails: when `hub_accounts` has no `email_key` column, add it and fill it from each email, trimmed and in lower case; then an index on it (not unique, so two old rows that share an email stay as they are).
4. For each table in `ACCOUNT_TABLES` that exists and has no `account_id`: `ALTER TABLE ... ADD COLUMN account_id TEXT NOT NULL DEFAULT 'owner'`, then an index on `account_id`.
5. `usage.paid_by` the same way.
6. If kv `auth.password` holds a hash and the owner row has none, copy it to the owner row; then delete the kv key.

It runs in one transaction, and every step checks before it acts, so running it twice changes nothing (a test runs it on an old database, again, and after a reopen; others on a `hub_accounts` from before display names and from before email keys). Every existing row, token and paired device becomes the owner's, because the column's default is the owner. Nothing is copied or rewritten. An older Conclave started on a migrated database keeps working as before except for the password login, whose key has moved.

## 10. Clients

- **Web:** setup step 1 asks the owner's name ("Your name", spaces fine, filled in with the name the account shows; `owner` counts as none) and saves it as the display name with `PATCH /api/me`, leaving the sign-in name as it is; Home's greeting and the top bar use it, or no name. The password login asks for the "Sign-in name or email" when the hub has more than one person. An invite link opens a page that sets the password and signs in. Settings, People (owner): each person by their display name with "Signs in as" their sign-in name; add a person with a display name, a sign-in name and an invite link or a password, access to the hub's keys (the providers the hub has a key or a signed in plan for) with a monthly budget and this month's spend, a display name, sign-in name and email for a member, a new password, a new link, a workspace, remove. Settings, Your account (everyone): display name, sign-in name, email, a member's password and default model, and the sign ins kept on this browser. The top bar shows who is signed in, with switch, add account and sign out, once there is more than one person or sign in. A member's Settings shows Your account, Providers (their keys and budget), Subscriptions and Accounts under Models (their own plans, section 12), Notifications, Assistant, Calendar and mail (without the hub's Google app setup), Connected apps, GitHub, Appearance, Audit log and About; Extensions, Friends, Remote access, Browser, Logs and the hub's settings are hidden, and onboarding is the owner's.
- **CLI:** `conclave people [list] | add [--display-name] | access | passwd | invite | workspace | remove`, and `conclave login <url> --password --account <name or email>` (asked for when the hub has several people).
- **Desktop app:** its first page has Pairing code, Password and Token. Password asks for the "Sign-in name or email" when `GET /api/health` says `people: true`, sends `POST /api/login` from the Rust side with the device's name and platform `desktop`, and shows the hub's fingerprint before anything is kept, since there is no code to check the hub against; Not my hub signs that token out again. Only the token and the hub's addresses are saved, as after pairing; the password never is.
- **Android `:client`:** `login(password, name, platform, account)`, `health().people`, `me()`, `updateMe`, `invite`, `acceptInvite`, the `Me` model, tests. The app's login screen has a "Sign-in name or email" field (empty for the owner). Home greets by config `ui.name`, which the hub keeps to the display name (section 4), so the app needs no change for display names; the extra `displayName` field in replies is ignored by its JSON reader. Devices has **Pair** for the owner and members alike: `createPairing(kind)` (`POST /api/pairing`, `self`) makes a code of the signed in account, so a member pairs their own app or computer to their own account. The sheet spots what paired as the web does: a new app in `apps()` (`GET /api/clients`) and `app.updated`, or a computer that came online in the devices list (`logic/Pairing.kt`, `PairingTest`).

## 11. For other features: how to scope a new table or route

1. **A new table** whose rows can be listed or looked up on their own: add `account_id TEXT NOT NULL DEFAULT 'owner'`, call `ensureAccountColumn(db, '<table>')` right after `CREATE TABLE IF NOT EXISTS`, and add the table to `ACCOUNT_TABLES` in `core/src/people/tables.ts`. Every insert sets it (the account in hand, else `currentAccount() ?? OWNER_ID`); every read has `WHERE account_id = ?`. A child table reached only through its parent's id needs no column; add it to `CHILD_TABLES` with its parent. A table of the hub itself goes in `HUB_TABLES`. The sweep fails on a table in none of them.
2. **A new route**: add it to `ROUTE_POLICY` in `server/src/route-policy.ts` with one of `public`, `admin`, `self`, `own({ param: kind })` or `hub`. In a `self` handler use `accountOf(c)` from `server/src/scope.ts` for lists and creates, and `ownSession` / `ownDevice` for ids in a body or query. A new kind of id for `own` is one case in `ownerOf` in the same file. Until the route is in the table it is owner only, and the route sweep test fails.
3. **A new bus event**: carry a `sessionId`, or an object with `accountId`, or add the type to the resolver in `core/src/people/events.ts`. Otherwise it goes to the owner only.
4. **Work outside a request** (a job, a timer, a watcher): run it inside `runAs(accountId, ...)` for the account it serves, so the machine guard knows whose it is, and read memory with `engine.memoryFor(accountId)`.
5. **Code that runs a command or reads a file**: go through `engine.machineFor(session)` or `engine.devices.get(id)`; never `node:fs` or `Bun.spawn` on a path that came from a session.
6. **Per account settings in kv**: `accountKey(accountId, key)`. Per account secrets: `engine.accountSecrets`.

## 12. A member's own plans

A member can sign in their own Claude, ChatGPT or other plan, and only their chats use it. The owner asked for the same Subscriptions and Accounts pages that the hub's plans have, for each person.

**One CLIProxyAPI per member.** The hub runs it as it runs its own in builtin mode (`MemberPlansManager`, `server/src/cliproxy/member.ts`). It lives in `<home>/accounts/<id>/cliproxy/` (mode 0700) and listens on `127.0.0.1` only. Its management key and client key are in the member's `<home>/accounts/<id>/secrets.json`, under a `hub` part (`hubValue`, `hubNames`, `setHubValue` in `core/src/people/secrets.ts`). `${secret:...}` in the member's own config reads `values` and `providers` only, never `hub`. The owner has no `hub` part: the hub's keys are the hub's own secrets.

**The program.** It is the one the hub has: `models.cliproxy.binary` when set, else the copy in `<home>/bin`, else the pinned release, downloaded there the same way as for the hub's own (INSTALL.md section 4 says how it is checked).

**Start and stop.**

- It starts on the member's first sign-in: `PUT /api/subscriptions { mode: 'builtin' }` starts it, and the sign-in runs on it.
- It starts at hub start (`attach()`) for each member whose folder has plans. A folder with none is deleted.
- It stops and its folder, its keys (the `hub` part) and the saved order go when the last plan is signed out (`afterRemove`), and when the member is removed (`DELETE /api/people/:id` calls `remove`).
- When the last plan is signed out while another sign-in is in progress, it keeps running for that sign-in.
- When it stopped with an error, the member can retry it from their Subscriptions page.
- The hub's limits table is the owner's. A member's limits stay in memory and start empty at each hub start.
- The program, its version, its binary path, its updates and how the hub reaches CLIProxyAPI (`url`, `key`, `managementKey`) are never shown to a member, also not in their Subscriptions status.

**Routes.** The paths are the ones the owner uses (`routes-subscriptions.ts`, `routes-accounts.ts`). `plansFor(ctx, accountId)` picks the owner's work on the hub's CLIProxyAPI and a member's on their own. In `route-policy.ts` they are `self`, except `POST /api/subscriptions/update`, which stays `admin`. A member's `PUT /api/subscriptions` may only send `{ mode: 'builtin' }`: any other mode, `url`, `key` or `managementKey` gets 403. A `PATCH /api/accounts/:id` with `starter` (the window starter) or `refusal` ("Use when a model refuses") is 400 for a member, since both use the hub's plans only. The web hides the Refusal and Starter rows from a member. Order, pause, prefix, try now and refresh work on their own plans. A member who names another person's plan id gets 404.

**Events.** `subscriptions.updated` and `accounts.updated` from a member's CLIProxyAPI carry `accountId`, so `PLAN_EVENTS` in `core/src/people/events.ts` sends them to that member only. Without an `accountId` they are the owner's. A member's view drops `limit.updated`: that is the owner's Usage page.

**Routing of a call.** Core knows a member's plans through `MemberPlans` (`core/src/people/plans.ts`):

- `ProviderAccess.registryKeys` gives a member's registry an overlay for the provider `cliproxy`. `MemberPlanProvider` sends a call to the member's own CLIProxyAPI when one of their plans lists the model. Any other model goes to the hub's `cliproxy`, and only while the owner granted `cliproxy` to that member. The grant is checked on every call, so taking it back stops the next one.
- The choice is made per call, by model. A call on the member's own plan is paid by them: `source` with that model answers `own` (`ownPlan` in `access.ts`), the usage row is `paid_by = 'own'` and no budget counts it. Without a model, `source` and `apiKey` answer `own` whenever the member's CLIProxyAPI runs.
- A call that started on the member's plan stays on it to the end. It never moves to the hub's plan mid-call.
- The member's model list shows their own models first, then the hub's they may use.
- The owner's calls never reach a member's plan: `ownPlan` is false for the owner, and the owner's registry has no overlay.

**What the owner sees.** The People page shows only how many plans a member has: `ownPlans` in `personDto` (`routes-people.ts`). Which plans, their names and their limits stay the member's. `ProviderAccess.info` also carries `ownPlans`, counted from the member's folder, so it is right while their CLIProxyAPI is not running.

**Private paths.** `core/src/machine/private.ts` refuses `<home>/accounts/*/cliproxy` and every `<home>/accounts/*/secrets.json` to every session's tools, the owner's too. As for the hub's own folder, a script that tries hard can still reach them, since it runs as the hub's user (INSTALL.md section 4).

**Web.** Settings, Models, Subscriptions and Accounts show a member their own variant (`features/settings/member-plans.tsx`, `SettingsPage.tsx`). It has the sign-in rows, their plans, their order and limits, and their models. It has no program, version, binary path, update or hub address. When their CLIProxyAPI stopped with an error, it offers a retry.

Where it can fail: a member's CLIProxyAPI is one more process per member with plans. A member's plan has no window starter and no "Use when a model refuses". Limits are lost at a hub restart until the next read. The owner can read the folder and keys on the machine, as in section 8.
