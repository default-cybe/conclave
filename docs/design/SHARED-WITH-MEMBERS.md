# Sharing with people on your hub, and chats with more than one person

The owner asked: "yes sharing between accounts on one hub is cool, also we can start project together or i can add him or one of my friend to the chat im doing?"

Three things:

1. **Share with a person on this hub.** Nihir shows up as a contact. You send him a chat, memories, files or a shared project, and he gets an Inbox card with Accept and Decline, as from a friend's hub. Nothing goes over the network.
2. **Start a project together.** A shared project with a person on this hub, using the shared projects that already exist between hubs.
3. **Chats with more than one person.** Add Nihir, or a friend on another hub, to a chat you are in. They read it and write in it. Your agent answers, on your models, with your approvals.

This is a design. Nothing here is built yet. Paths with line numbers are the code as it is on `main` at 2db22c31.

## 1. Rules that hold in every phase

These come from ACCOUNTS.md and FRIENDS.md section 1. This feature must not weaken any of them.

- **Each account's keys, plans, memory, devices, browser logins, mail and calendar stay its own.** Sharing copies what the sender picked. It never opens a store.
- **Nothing arrives without Accept.** A share, a project invite and a chat invite wait as an Inbox card until the person accepts it.
- **Another person's text is data, never consent.** It cannot approve a tool call, change a setting, run a slash command or start a tool without the chat owner's approval.
- **The chat owner pays and the chat owner's policy applies.** A turn in your chat runs on your account: your keys, plan, budget, permission rules and devices.
- **Memory is read only from the chat owner, and learns only from the chat owner.** A participant's memory is never read. A participant's words are never extracted into the owner's memory.
- **Leaving is immediate.** A person who leaves or is removed loses access on the next request and on their open sockets.
- **"Asked to delete", never "deleted"** for a copy on another hub, as in FRIENDS.md.

## 2. What the code does today

| Fact | Where |
|---|---|
| Friends, shares and shared projects are the owner's. No peer table has `account_id`; they are in `HUB_TABLES`. | `core/src/people/tables.ts:97-113`, ACCOUNTS.md 7 |
| Every friends, shares and shared projects route is `admin`. | `server/src/route-policy.ts:453-491` |
| Only the owner's sessions can be shared. | `server/src/peer/shares.ts:246-247` |
| A friend is a hub key: `friends.fingerprint` is unique, and every envelope is signed by the sending hub and sealed for the receiving one. | `server/src/peer/store.ts:17`, `server/src/peer/envelope.ts:74-138` |
| Adding this hub as a friend fails twice: by address (`addressRefused` gives `'this hub'`) and by key (`fp === this.fingerprint`). | `server/src/peer/service.ts:887-890`, `:906` |
| Share kinds are only `chat` and `session`. Memories travel only as shared project items. | `server/src/peer/share-store.ts:92`, `shares.ts:560` |
| An incoming share is a `friend_shares_in` row in state `offered`. Accept fetches and checks the bundle. Fork, handoff and reference make sessions from it. | `shares.ts:584`, `:659-709`, `:798-850` |
| A session has one account. Ownership is checked by `own({ id: 'session' })`, and a mismatch answers 404. | `route-policy.ts:48`, `:89-108`, `:758-763` |
| The engine caches a session's account and assumes it never changes. | `core/src/engine/engine.ts:396-405` |
| `messages` has no account column. `author` is a display label for asides. | `core/src/storage/db.ts:43-57`, `core/src/types.ts:145-146` |
| A turn runs as the session's account. | `core/src/session/runner.ts:1030` |
| The payer is `target.accountId ?? session.accountId`. | `core/src/session/stream.ts:131` |
| Recall reads the session account's memory. | `runner.ts:875-880` |
| Extraction reads every message of the session into the session account's memory. | `engine.ts:2138-2145` |
| Tools run on `machineFor(session)`, and the guard compares `currentAccount()` with the device's account. | `engine.ts:1951-1962`, `core/src/people/guard.ts:40-63` |
| Approvals belong to the session's account. Only that account sees or answers them. | `route-policy.ts:166`, `:681-683`, `engine.ts:1216-1218` |
| Each bus event is stamped with exactly one account. A socket gets it only on an exact match, or when the stamp is `'*'`. Live events go over `/api/ws`, not SSE. | `core/src/people/events.ts:54-87`, `server/src/ws/clients.ts:125`, `:181` |
| A push goes to the session's account. It is held while that account is active. | `engine.ts:2125-2127`, `core/src/notify/notifier.ts:138-164` |
| A fork of a friend's share is guarded: every tool asks, until the owner writes a message of their own. | `core/src/session/friend-share.ts:289`, `core/src/session/untrusted.ts` |
| Quoted history goes to the model as one `<shared-history>` block naming its source. | `core/src/session/quoted.ts:12`, `:69` |

The brief calls the live channel "SSE per account". It is the WebSocket `/api/ws`, with the same filtering per account. This design says "socket" throughout.

## 3. Decision: people on this hub are contacts, not friends

The brief preferred modelling a person on this hub as a "local friend": a row in `friends`, on the same code paths. That is not clean, for four reasons:

- **A friend row is a key.** `friends.fingerprint` is unique and every message is signed and sealed with it. People on one hub share one hub key, so `from === to`. Sealing to yourself, the nonce cache (`peer_nonces` by `fp:nonce`) and inbox dedup (`peer_inbox` by `friend_id, id`) all assume two keys (`store.ts:535-572`).
- **Friends are the owner's.** A member has no friends and no hub key. Per-account keys and a new invite format are "a later round" (ACCOUNTS.md 7). A "local friend" row would have to be the owner's, so Nihir could not share with Kai.
- **The outbox, addresses, reachability, safety code and key rotation mean nothing on one hub.** Each would need an "if local" branch.
- **Both self checks would have to be undone.** Those checks (`service.ts:890`, `:906`) protect a real case: a hub must never call itself.

**So:** one model above the transport, two ways to deliver.

- A **party** is who you share with. It is `friend:<friendId>` for a friend's hub, or `account:<accountId>` for a person on this hub. The share, project and chat code works on parties.
- A **carrier** delivers to a party. The **peer carrier** is today's code: envelope, outbox and signed fetch. The **local carrier** writes the recipient's row in the same database, in one transaction, and emits the event for the recipient's account. It needs no signing and no sealing: it runs inside the hub that both accounts already trust (ACCOUNTS.md 8, the owner is not defended against).
- The review (`POST /api/shares/preview`), the redaction, the bundle, the Inbox card, Accept and Decline, fork, handoff and reference, project items and their versions are all the same code.

The seam for the peer side is where shares and projects queue an envelope today: `shares.ts:375` (offer) and `projects.ts:560`, `:1244` (fanout). The blob fetch on Accept is `service.ts:1156`. A local party skips both. The local payload is the signed bundle as a file under the sender's share folder, read straight from disk.

**Why not a fake `fetchFn` that routes self-URLs in process?** It would keep every crypto and address step, but with one key on both ends, and it would defeat `addressRefused` on purpose. A carrier interface is less code and keeps the self check meaning what it says.

### Who appears as a contact

| Viewer | Sees |
|---|---|
| Owner | their friends, and every member of this hub |
| Member | the owner and every other member of this hub; no friends (friends stay the owner's) |

A contact shows the person's shown name (`shownName`, ACCOUNTS.md 1) and avatar, never their sign-in name or email. The owner's switch "People on this hub can share with each other" (People page, on by default) turns off member-to-member contacts. The owner stays a contact for everyone. Each person can turn off "Others on this hub can send me things" in Your account. When that is off, they are not listed, and a send to them gets 404. A blocked person is the same.

## 4. Part 1: share with a person on this hub

### What can go

| Kind | What goes | On Accept |
|---|---|---|
| `chat`, `session` | The phase 2 bundle: same review, same redaction, same "keep anyway". Code as a diff or git bundle. | Fork, handoff or reference in the recipient's account, as from a friend. A fork is guarded the same way (`friendGuardTurn`). |
| `memory` (new) | Memory rows the sender picks one by one: text, kind, tags. Never the profile, never the review queue, never a memory connection. | Each row goes into the recipient's **memory review queue** marked "from Kai". It is never added to memory directly. |
| `file` (new) | Files from the sender's session outputs (`outputsDir`, `core/src/files/share.ts:48`) or uploads, up to `SHARE_MAX_BYTES` (30 MB) each and 100 MB per share. | Copied into the recipient's files under `accounts/<id>/received/<shareId>/`. They count against the recipient's disk cap (`people/disk.ts`). |

`memory` and `file` are local only in phase 1. They get envelope bodies for friends later, under the same review.

### Data model

The share tables move from `HUB_TABLES` to `ACCOUNT_TABLES`, with `ensureAccountColumn` (default `'owner'`, so every row today stays the owner's):

| Table | New columns | Meaning |
|---|---|---|
| `friend_shares_out` | `account_id` | the sender |
| `friend_share_sends` | `to_account TEXT NULL` | set for a local party; `friend_id` is then `''` |
| `friend_shares_in` | `account_id` (the recipient), `from_account TEXT NULL` | `from_account` set for a local sender; `friend_id` and `fingerprint` are `''` |
| `friend_shares_in` | `items TEXT NULL` | the memory rows or the file list of a `memory` or `file` share |

`UNIQUE (friend_id, share_id)` becomes `UNIQUE (account_id, friend_id, from_account, share_id)`. The table names stay; renaming them buys nothing.

### Routes

The share routes open to members, scoped by account. Remote parties stay owner only, so a member's `to` may hold only `account:` parties. A `friend:` party from a member is a 403.

| Route | Rule now | Rule after |
|---|---|---|
| `GET /api/contacts` (new) | | `self`: the table in section 3 |
| `POST /api/shares/preview`, `POST /api/shares` | `admin` | `self`; `ownSession` for each session id; each `to` checked against the caller's contacts |
| `GET /api/shares/sent`, `/received` | `admin` | `self`, filtered on `account_id` |
| `.../sent/:id`, `.../sent/:id/update`, `DELETE .../sent/:id` | `admin` | `own({ id: 'shareOut' })` |
| `.../received/:id` and `/accept`, `/decline`, `/view`, `/fork`, `/handoff`, `/reference`, `/apply-plan`, `/apply` | `admin` | `own({ id: 'shareIn' })` |
| `POST /api/memory/review/:id/accept` | as today | takes a review row that came from a share, like any other |

`shareOut` and `shareIn` are two new cases in `ownerOf` (`route-policy.ts:658`), reading `account_id`. `shares.ts:246-247` changes from "the owner's" to "the caller's".

### Events

`friend.share` and `friend.share.sent` leave `OWNER_EVENTS` (`events.ts:14-24`) and carry `accountId`: the recipient's for `friend.share`, the sender's for `friend.share.sent`. A share from a friend still carries `'owner'`.

### UI

- **Web.** `SendDialog.tsx` lists contacts in two groups, "On this hub" and "Friends", with avatars. The review sheet is unchanged. A memory share starts from Memory: select rows, then "Send to…". A file share starts from a file card or the Files list. The Inbox card (`ShareCards.tsx`) says "Nihir sent 'Trip plan' (chat, 18 messages)" with Accept and Decline. A memory card lists the rows, each with Keep or Skip.
- **Android.** `ui/friends/SendToFriend.kt` lists the same two groups. `SharesScreen.kt` and `ShareCards.kt` show the local cards. `ConclaveClientFriends.kt` gets `contacts()`.
- **CLI.** `conclave sessions send <id> --to nihir` resolves a shown name or sign-in name to a contact.

## 5. Part 2: start a project together

The same shared project, with people on this hub as members.

### What is shared and what never is

| Shared (in the project) | Never shared |
|---|---|
| name, description, the GitHub repo name | anyone's provider keys, plans, budgets or GitHub token |
| notes, each edited only by its author | anyone's devices, folders, paths or path pairs |
| memories a member picks one by one, as copies | anyone's memory store, profile or review queue |
| chats a member shares, as phase 2 snapshots | sessions nobody shared |
| chats started in the project, as multi-person chats (part 3) with the members invited | approvals, tool output of sessions nobody shared |
| the member list (shown names) | emails, sign-in names |

Code stays on GitHub, as today (FRIENDS.md "Code never goes hub to hub"). Each member reads it with their own token, from their own devices.

### One copy on this hub

Between hubs, each hub keeps a copy, and the owner's hub relays items (star topology, `projects.ts:11-14`). On one hub there is one row per project and one row per item, read by every member. Membership gates who reads it. Nothing is relayed, and nothing can drift.

### Data model

| Table | Change |
|---|---|
| `shared_projects` | `account_id`: the account that owns it. For a project a member made, `owner_fp` is `account:<id>`. A member's project may have local members only (members have no hub key). |
| `shared_project_members` | `account_id TEXT NULL`, set for a person on this hub. For them, `fingerprint` holds `account:<id>` and `public_key` is `''`. The `account:` prefix never collides with a hex fingerprint. |
| `shared_project_members` | `local_project_id TEXT NULL`: each member links the project to a project of their own. Today the link is one column on `shared_projects` (`project-store.ts:27`), which is the owner's folders; per member it must be per row. |
| `shared_project_items` | `author` is `account:<id>` for a person on this hub. Local items carry no signature. The route's account is the proof of authorship. |

A **mixed project** (the hub owner's project with members both here and on friends' hubs) still works. The owner's hub signs a local member's item with the hub key when it goes to a friend's hub, with author `account:<id>` and the member's shown name. The friend's hub shows it as "Nihir on Kai's hub". It checks the hub key, since the member list names that key for `account:` authors.

The tables move to `ACCOUNT_TABLES`, or `CHILD_TABLES` for items and versions under `shared_projects`. "Which projects can I see" reads `shared_project_members` on its own, so the members table needs its own `account_id`, by the rule in ACCOUNTS.md 3.

### Routes

The `/api/shared-projects` routes (`project-routes.ts:44-107`) open with a new owned kind, `sharedProject`. `ownerOf` for it answers the caller's own id when the caller is an active member. That needs one change to the policy: `own` today compares one owner. A new rule kind does it instead:

- `member({ id: 'sharedProject' })`: the caller must be an active member. Otherwise 404.
- Owner-only actions inside a project stay checked in the handler: invite, remove, rename, end. The handler compares `role === 'owner'`.
- Item writes check `author === account:<caller>` (today's "Only its author edits an item" check, `projects.ts` inbound checks).

### SharedProject tool and trust

`session/shared-project.ts` fences a friend's items as quoted data. A local member's items are fenced the same way, with `from="Nihir (on this hub)"`. A person on the same hub is still another person, and their note can be a prompt injection. Only the reader's own items read plain. The tool is given to a session in the project only when the session's account is a member.

### UI

- **Web.** `/projects` lists projects where you are a member. "New shared project" invites from contacts in both groups. The member list shows "on this hub" or "Alice's hub". The Inbox has the invite card.
- **Android.** The projects screens exist on web and iPhone only today. Android gets the list, the page and the invite card in this phase.

## 6. Part 3: chats with more than one person

### Who can do what

| Action | Chat owner | Participant on this hub | Friend on another hub |
|---|---|---|---|
| Read messages | yes | yes, from when they joined, or the whole chat if the owner chose "Show earlier messages" | the same, as a mirror on their hub |
| Post a message | yes | yes, unless the owner set them to read only | yes, unless read only |
| Start an agent turn | yes | yes, by posting (see Payment) | yes, by posting |
| See tool calls | yes | a one-line summary; full output only if the owner turns on "Show tool output to others" | the same |
| Approve a tool call | yes, only they can | no | no |
| Change model, agent, mode, device, permission mode, title | yes | no | no |
| Add or remove people | yes | no (they can ask in the chat) | no |
| Leave | | yes | yes |
| Fork, export or share the chat | yes | "Save a copy", as a local share of the part they could read, fork only | no in phase 3 |
| Delete the chat | yes, for everyone | no | no |

**Phase 1 is for chats only** (`kind: 'chat'`, `SessionKind` in `core/src/types.ts:267`). Agent and code sessions with participants come later. A code session has a device, a folder and a much larger tool surface.

### Data model

**`chat_participants`**, a new table in `ACCOUNT_TABLES`. A participant must list "chats I am in" without going through someone else's session.

| Column | Meaning |
|---|---|
| `session_id` | the chat |
| `account_id` | the participant's account (for a person on this hub); for a friend, the chat owner's account |
| `friend_id` | set for a friend on another hub, else `''` |
| `role` | `participant` (the owner is not a row; the session's `account_id` is the owner) |
| `state` | `invited`, `active`, `declined`, `left`, `removed` |
| `can_post` | 1 or 0 |
| `history_from_seq` | the first `seq` they may read |
| `read_upto_seq` | their read mark |
| `muted` | their notifications for this chat |
| `added_by`, `added_at`, `updated_at` | |

The primary key is `(session_id, account_id, friend_id)`.

**`messages`** gets `sender TEXT NULL`. `NULL` means the session's owner, which covers every message written before this feature. Otherwise it is `account:<id>` or `friend:<friendId>`. The existing `author` column takes a snapshot of the shown name when the message is written, so it still reads right after the person renames, leaves or is removed. The avatar is looked up by `sender` and falls back to initials.

**`sessions.meta.participants`** holds the chat's switches:

- `showToolOutput` (off)
- `showEarlier` (off)
- `othersStartTurns` (on)
- `turnCap` (30 turns an hour per participant)
- `memory` (see Memory)

**On a friend's hub**, a mirror session with `kind: 'chat'` and `meta.joined = { friendId, sessionId }`, owned by that hub's owner. Like a reference (FRIENDS.md "A reference is a session the hub never runs"), the hub never runs it:

- memory never learns from it;
- the digest leaves it out;
- send posts to the owner's hub instead of starting a turn.

### Who can reach the chat: one check

A new rule kind, `seat({ id: 'session' })`, allows the session's owner or an active participant. The routes split:

| Route | Rule |
|---|---|
| `GET /api/sessions/:id`, `GET /api/sessions/:id/messages`, `.../messages/:msgId/blocks/:index` | `seat`; the handler shapes the reply for a participant (below) |
| `POST /api/sessions/:id/messages` | `seat`; the handler checks `can_post` and the turn cap, and records `sender` |
| `POST /api/sessions/:id/read` (new) | `seat`; moves the caller's own read mark |
| `POST /api/sessions/:id/participants` (new) | `own` (the session's owner): invite contacts |
| `PATCH`, `DELETE /api/sessions/:id/participants/:pid` (new) | `own`: read only or post, remove |
| `POST /api/sessions/:id/leave` (new) | `seat`: the caller leaves |
| `GET /api/chats/invites`, `POST /api/chats/invites/:id/accept`, `/decline` (new) | `self` and `own({ id: 'chatInvite' })` |
| every other `/api/sessions/:id/*` route (`PATCH`, `DELETE`, fork, export, bundle, queue, approvals, checkpoints, hub copy…) | unchanged: `own`, so a participant gets 404 |

`seat` reads `chat_participants` on each request and does not cache. Leaving or being removed therefore takes effect on the next call. The cached `sessionAccount` (`engine.ts:396`) stays right, because the owner never changes.

**What a participant's copy of the session leaves out:**

- `cwd`, `device`, `permissionMode`, cost and stats;
- the queue;
- the stored tool output, unless `showToolOutput` is on;
- recalled memory blocks and system reminders.

This is one function, `seatView(session, messages)`, in core. It is used by the routes and by the socket fan-out, so the two cannot differ.

### Attribution

Each human message shows its sender's name and avatar: a bubble on the left for others, on the right for you. For the model, every message not written by the chat owner goes in a quoted block:

```
<shared-history from="Nihir (on this hub)" kind="participant">…</shared-history>
```

This reuses `quotedBlock` (`quoted.ts:69`), with framework tags defused (`untrusted.ts`). The owner's messages go plain. The model is told who is in the chat and who its owner is. It knows that only the owner's words are the owner's instructions.

### Payment: the chat owner's account

Every turn in the chat runs under `runAs(session.accountId)` (`runner.ts:1030`). The payer is the session's account (`stream.ts:131`). That is today's code with no change, and it is the recommendation: the chat is the owner's, on the owner's models and plan.

What keeps a participant from spending the owner's money:

- **The owner's budget rules apply.** A member who owns a chat pays from their own keys, plan or hub budget, with today's checks (`access.ts:173-273`).
- **A turn cap per participant:** `turnCap` turns an hour that their messages start (default 30). Past it, their messages are kept but start nothing, with "Kai's agent answers again at 15:40, or when Kai writes".
- **`othersStartTurns`** can be off. Then only the owner's messages start a turn. Others' messages wait and go with the owner's next turn.
- **Messages that arrive close together** while a turn runs are queued and go as one next turn, the way the queue works today. Five quick messages make one turn.
- **Each usage row** carries `meta.startedBy = sender`. The owner can see on the chat's cost line who started what.

**Later: "use my own models".** A participant opts in for turns they start, and `target.accountId` (`stream.ts:131`) names them as payer. Their model, their plan, their budget. The turn still runs as the owner (`runAs(owner)`) for tools, approvals and memory, so this only changes which key pays. It needs the payer and the context split cleanly in `streamCompletion`. That is not built and not in phase 1.

### Tools, devices and approvals

- **Tools run only where the chat owner's tools run:** `machineFor(session)`, under the owner's context. A participant's own devices are never used. The guard (`guard.ts:40-63`) is unchanged: the context is the owner's, and the device is the owner's.
- **A turn started by someone else is guarded.** It is the fork guard (`friendGuardTurn`, `friend-share.ts:289`; `untrusted.ts`), applied per turn:
  - every tool call asks the owner, read-only ones and the owner's allow rules included;
  - "always" and "for this session" count once;
  - hooks cannot approve;
  - bypass mode does not apply.
  A turn the owner starts with their own message runs on the owner's normal rules.
- **While anyone else is active in the chat, bypass mode is off** for every turn, the owner's too. Others' text sits in the context of every turn, and bypass would let an injection run with no one asked. The chat header says so.
- **The approval card names who asked and who will see.** "Nihir's message started this. The result will show in a chat Nihir reads." Only the owner sees the card. `approval.requested` stays the owner's event, and `POST /api/approvals/:id` stays `own`. Participants see "Waiting for Kai" with the tool's name and no input.
- **The signed approval link** (`/api/approvals/:id/act`) goes only to the owner's devices, as today. It checks no account (`routes.ts:619`). It must never go into a chat message, a push to a participant or a socket event they get.
- **No slash commands from participants.** A participant's text starting with `/` is plain text.

### Memory

- **Recall reads only the chat owner's memory** (`runner.ts:880`, unchanged), never a participant's.
- **Owner memory in a chat others read is a leak by design:** what the agent recalls, it can say. When the first other person joins, the chat's memory switch (`chat.ts`, the `memory` switch) turns **off** for recall, with the line "Your memory stays out while others are in this chat. Turn it on to let the agent use it; they will see what it says." The owner can turn it on.
- **Extraction learns only from the owner's own messages**, and from the agent's replies to turns the owner started. `afterTurn` (`engine.ts:2143`) passes `messages.list(id)` filtered on `sender IS NULL` and drops replies to turns others started.
- **A participant's consent** ("Kai's agent may remember what I say here") is a later switch, per participant, off by default. Phase 1 has no consent: none of a participant's words go into anyone's memory.
- **On the participant's side**, the chat is someone else's. Their own memory never learns from it and never recalls into it.
- **Past chat search:** the owner's search covers the chat as today. A participant's search covers chats they are in, marked "Kai's chat", with only what they can read (`seatView`).

### Live updates

Today an event has one stamp, and `eventVisibleTo` needs an exact match (`events.ts:84-87`). The change:

- `eventAccount` returns a set for session events. The set is the owner plus the session's active local participants, and only for event types on an allow list.
  - Allowed: `message.created`, `message.updated`, `message.deleted`, `message.delta` (assistant text only), `session.updated` and `session.deleted` (shaped by `seatView`), `chat.typing` (new), `chat.participants` (new). These names are in `core/src/types.ts:827-835`.
  - Never allowed: `approval.*`, `question.*`, `notice`, `session.queue`. `tool.started` and `tool.completed` go as one-line summaries. `tool.progress` goes only when `showToolOutput` is on.
- `eventVisibleTo(stamp, account)` checks membership in the set. The replay after a reconnect (`ws/clients.ts:125`) uses the same check. It also drops events from before the participant's `history_from_seq`.
- A participant who leaves or is removed gets `chat.removed` for that chat. Their sockets drop the chat's events from then on: the set is computed when each event is emitted, from the table.
- The engine keeps the participant set per session in memory and updates it on every change to `chat_participants`. It is never built from a stale read.

### Notifications

- **New rule `notifications.on.chatMessage`** (on). A message from another human in a chat you are in pushes to you. It is held while you are active (`someoneActive`, `notifier.ts:138`) and skipped while the chat is muted.
- **The agent's reply** pushes to the person whose message started the turn, under `sessionDone`, never to everyone.
- **Approvals push only to the owner**, as today.
- **A chat invite** pushes to the invitee under `friendMessage` (the rule shares already use).

### Leave, remove, delete

- **Leave:** state `left`. The chat goes from their list. Their messages stay, with their name. They can "Save a copy" first.
- **Remove** (by the owner): state `removed`, the same for them, with "Kai took you out of 'Trip plan'".
- **Delete** (by the owner): the chat is gone for everyone. `chat_participants` rows go with it. Friends' mirrors get `chat.end` and turn read only.
- **A person removed from the hub** (`purgeAccount`, `people/store.ts:316`): their `chat_participants` rows go. Their messages in others' chats stay, with the `author` snapshot. `sender` becomes `account:removed`, so no lookup finds a new account by a reused id. (Ids are never reused, but this does not rely on it.)
- **A friend removed** (`friend.remove`): they leave every chat of the owner's, and the mirrors on their side turn read only.

### Friends on another hub in a chat (phase 3)

Friends are the owner's, so only the hub owner can add a friend to a chat. A member can when per-account keys exist.

**Topology:** a star, like shared projects. The owner's hub holds the chat and runs every turn. The friend's hub holds a mirror and never runs it.

**New envelope types** in `envelope.ts:34-72`, all signed by the sending hub, sealed for the receiving one, through the outbox:

| Type | From, to | What |
|---|---|---|
| `chat.invite` | owner, friend | title, owner's name, other participants' names, message count. Nothing else before Accept. |
| `chat.join` | friend, owner | accepted. The owner answers with `chat.state`. |
| `chat.leave` | friend, owner | declined, or left |
| `chat.remove` | owner, friend | taken out, or the chat ended (`ended: true`) |
| `chat.message` | owner, friends | one finished message (human or assistant) with the owner's `seq`, `sender`, `author` and `createdAt`, shaped by `seatView`. No streaming deltas. |
| `chat.post` | friend, owner | the friend's own message: `clientId` (a ULID), text, up to 20,000 characters as for `note` (`service.ts:89`). No attachments in phase 3. |
| `chat.state` | owner, friend | meta and every message from `history_from_seq`, on join and on sync, as a blob when over 256 KB |
| `chat.sync` | friend, owner | send `chat.state` again; at most once a minute per friend, as `project.sync` |

**Ordering:** the owner's hub gives every message its `seq` when it takes it. That is the one order. A `chat.post` that arrives late (outbox, pull path) goes in at the end with its own `createdAt` shown. The mirror applies `chat.message` in `seq` order. A gap (a `seq` missing for 2 minutes) sends `chat.sync`.

**Idempotence:** by envelope id, as today (`peer_inbox` primary key), and by `clientId` for posts. A retried post never makes two messages.

**Offline:** the outbox retries for 7 days (`service.ts:79`). The friend's hub shows its own post as "Sending" until a `chat.message` echoes its `clientId`.

**Limits on the owner's hub for each friend:**

- 60 `chat.post` an hour per chat;
- the turn cap above;
- 20,000 characters per message;
- 5 open chat invites per friend.

A post over a limit is acked and named in `refused=` (FRIENDS.md "Phase 1 as built"). The friend's hub shows "Not delivered: Kai's hub takes no more messages in this chat this hour".

**Grants:** a new friend grant, `joinChats` (off), on the owner's side. It is needed before a friend can be invited. On the friend's side, `receiveShares` covers invites, as with projects.

### UI

**Web:**

- The chat header (`ChatPage.tsx`, `ChatView.tsx:259`) gets a row of avatars and "Add people". The owner gets Add, read only or post, Remove, and the switches (show tool output, show earlier messages, others start turns, memory). A participant gets Leave and Mute.
- The sidebar (`Sidebar.tsx` `Row`, `lib/sidebar.ts`) marks a chat with others by stacked avatars. Chats you are in but do not own sit in the same list with "Kai's".
- The bubbles (`conversation/UserMessage.tsx`, `features/chat/Turn.tsx:56`) show a name and avatar for others' messages.
- The composer says "Kai's agent answers on Kai's models" for a participant.
- The Inbox gets "Kai added you to 'Trip plan'" with Accept and Decline.

**Android:**

- `ui/conversation/ChatThread.kt` and `ChatViewModels.kt` show names and avatars and a participants sheet.
- `ui/sessions/SessionsScreen.kt` shows chats you are in.
- `client/.../ConclaveClient*.kt` gets the participant routes and the invite list.
- Push opens the chat.

**CLI:** `conclave chats add <id> <contact>`, `leave`, `people <id>`.

## 7. Threat model

**Who we defend against:** a member of this hub, a friend's hub, and anything that steers one of their agents or messages (a pasted page, a crafted note). As in ACCOUNTS.md 8, not the hub owner, who can read the database.

**Assets:** each account's chats, memory, keys, plans, budget, devices, files and approvals; the hub machine.

| Threat | Check that stops it |
|---|---|
| A member reads a chat they are not in, by id | `seat` reads `chat_participants` on each request: not an active participant is 404, the same as an unknown id. Every other session route stays `own`. Route sweep test. |
| A participant reads more than they should: the owner's paths, device, cost, recalled memory, tool output | `seatView` is the only shape a participant gets, from the routes and the socket alike. One function, one test per field. |
| A participant gets the owner's events (approvals, notices, tool output) | Session events fan out only for types on an allow list, shaped by `seatView`. `approval.*`, `question.*` and `notice` stay the owner's. Replay filtered the same way. |
| Someone who left still gets events or reads | Membership is read per request and per emitted event, never from a cache built earlier. The leave test reads, posts and listens after leaving. |
| A participant runs tools on the owner's device or the hub | Every turn others start is guarded: each tool call needs the owner's approval, no allow rules, no bypass, no "always". Bypass is off while others are active. |
| A participant answers an approval | Approvals stay `own` (`route-policy.ts:166`). The signed link goes only to the owner's devices and never into a chat, a participant's push or an event they get. |
| A participant runs a tool on their own device through the owner's turn | The owner's turn runs as the owner. The guard (`guard.ts`) refuses every device not the owner's. |
| A participant uses a slash command or changes the model, mode or device | Their text is quoted data. `/` is not parsed for them. Settings routes stay `own`. |
| A participant spends the owner's money | Turns they start count against `turnCap`. `othersStartTurns` can be off. Queued messages go as one turn. The owner's budget checks are unchanged. Usage carries `startedBy`. |
| A participant reads the owner's memory | Recall is off when another person joins, until the owner turns it on. The owner is told the others will see it. |
| The owner's memory learns a participant's words | Extraction reads only `sender IS NULL` messages and replies to turns the owner started. |
| A participant's memory is read | Recall only ever reads `memoryFor(session.accountId)`. No path names a participant's memory. |
| A participant's prompt injection steers the owner's agent | Their messages go as a `<shared-history>` block naming them, with framework tags defused. The model is told only the owner instructs. Guarded turns. |
| A share or invite forced on someone | Every share, project invite and chat invite waits for Accept. "Others on this hub can send me things" off hides the person; a send then 404s. |
| A member finds others' names, sign-in names or emails | `GET /api/contacts` gives shown names and avatars only. The owner can turn member-to-member contacts off. |
| A member shares to a friend of the owner, or reaches the hub key | A member's `to` may hold only `account:` parties: `friend:` is 403. Friends routes stay `admin`. |
| A member writes another member's project item or sees a project they are not in | `member({ id: 'sharedProject' })` gates the project. Item writes check `author === account:<caller>`. Owner actions check the role in the handler. |
| A local member's project item is passed off as signed by them to a friend's hub | It is signed by the hub key with author `account:<id>`. The friend's hub knows it is "Nihir on Kai's hub", vouched for by Kai's hub only. |
| A shared file fills the recipient's disk | Accept counts against the recipient's disk cap. Each file is at most 30 MB, each share 100 MB. |
| A shared memory row poisons the recipient's memory | It lands in the review queue, marked with its sender. It is never added to memory directly. |
| A friend floods a chat over `conclave-peer` | 60 posts an hour per chat, 20,000 characters, the turn cap, 5 open invites, refused with a reason. Signing, nonces and the 5-minute expiry as today. |
| A friend's post replayed or doubled | Envelope id dedup and `clientId` dedup. |
| A friend's hub sends `chat.message` | The owner's hub takes only `chat.post`, `chat.join`, `chat.leave` and `chat.sync` from a participant. `chat.message` and `chat.state` are taken only from the chat's owner hub. |
| A removed account's id matches a new account | `sender` becomes `account:removed` on purge. |

**Where it can still fail:**

- The owner can approve a tool call whose output a participant then reads. The card says so; the owner decides.
- An assistant reply can quote recalled memory or tool output in its own words, even with "show tool output" off. The memory default and the card wording are the defense, not a filter.
- A participant's text sits in the context of the owner's own turns, which run on the owner's normal rules (minus bypass). An injection there can still steer a tool call the owner then approves.

## 8. Phases

| Phase | What | Smallest useful slice |
|---|---|---|
| 1 | Contacts on this hub; share a chat or session with a person on this hub (local carrier, Accept, fork, handoff, reference); chats with people on this hub | You add Nihir to your chat. He reads and writes. Your agent answers on your models, asks you before any tool. |
| 2 | Memory and file shares on this hub; shared projects with people on this hub; "Start a chat in this project" | You and Nihir have a project with notes, picked memories and the repo, and start a chat in it together. |
| 3 | Friends on other hubs in your chats (`chat.*` envelopes) | You add Alice from her hub to your chat. |
| later | Agent and code sessions with participants; "use my own models"; consent to memory; member-owned projects with friends (needs per-account keys) | |

## 9. Test plan

Every phase runs `bun run test`. The people sweep and the route sweep (`server/test/people-sweep.test.ts`) must pass with the new tables and routes listed.

### Phase 1

- **Tables.** `chat_participants`, the new share columns and `messages.sender` are in the right list. Migration on an old database, twice, leaves every row the owner's.
- **Contacts.** The owner sees members and friends. A member sees people on this hub and no friends. Off switches hide people, and a send to them is 404.
- **Shares, cross-account.** A member's share to a member lands in the recipient's account only. The owner's Inbox does not show it. A third member cannot accept, view or fork it (404). A member's `to: friend:…` is 403. The fork is guarded.
- **Seat routes.** Owner, active participant, invited, left, removed and stranger each hit every `/api/sessions/:id/*` route. Only the rows in section 6 open to a participant. Every other route is 404 for them.
- **seatView.** A participant's session and messages hold no `cwd`, `device`, `permissionMode`, cost, queue, recalled memory, reminders or tool output (unless switched on), on GET and on the socket.
- **Sockets.** A participant's socket gets `message.*` and `session.updated` for the chat, never `approval.*`, `question.*`, `notice` or `tool.progress`. Replay the same. After leaving, nothing more arrives.
- **Payment.** A participant's turn writes usage on the owner's account with `startedBy`. The turn cap refuses the 31st turn in an hour and keeps the message. `othersStartTurns` off starts nothing.
- **Tools.** A participant's turn asks for every tool, including one an allow rule covers. "Always" counts once. Bypass is ignored while a participant is active. The tool runs on the owner's device only. A participant cannot `POST /api/approvals/:id` (404). The approval link never appears in any participant-visible payload.
- **Memory.** Recall is off when a participant joins. Extraction after a participant's turn and after a mixed chat adds nothing from the participant's messages (checked by text in the owner's memory store). The participant's memory store is unchanged after every test.
- **Attribution.** Messages store `sender` and `author`. The model request quotes a participant's message in a `<shared-history>` block with framework tags defused.
- **Leave and purge.** Leave, remove and delete each end access on the next call. Purging a member keeps their messages with `account:removed`.
- **Web and Android.** Header avatars, bubbles with names, add and leave flows, Inbox invite card. Client tests for the new routes in `:client`.

### Phase 2

- **Memory share.** Rows land in the recipient's review queue only, never in memory, and never in a third account.
- **File share.** The copy counts against the recipient's disk cap. A share past the cap is refused at Accept.
- **Projects, cross-account.** A non-member gets 404 on every `/api/shared-projects/:id/*`. A member cannot edit another member's item or invite or remove (owner only). `local_project_id` is per member: one member's link never shows another's folders.
- **Mixed project.** A local member's item reaches a friend's hub signed by the hub key, author `account:<id>`. The friend's hub refuses an `account:` item signed by any other key.
- **SharedProject tool.** It fences other members' items, local ones too. A non-member's session does not get the tool.

### Phase 3

Two hubs on one machine, with `PeerOptions.loopback` as the friends tests do.

- **Envelopes.** Each `chat.*` type is accepted only from the right side. `chat.message` from a participant is refused.
- **Ordering.** Out-of-order delivery is applied in `seq` order. A gap triggers `chat.sync`. A retried post is one message.
- **Offline.** A post queued while the owner's hub is down arrives after it is back, at the end.
- **Limits.** The 61st post in an hour is refused with a reason that shows as Not delivered.
- **Guard and memory.** A friend's post starts a guarded turn. The friend's words reach neither hub's memory.
- **Remove and end.** `friend.remove` and `chat.remove` make the mirror read only.

## 10. Open questions for the owner

1. **Contacts.** Should members see each other as contacts by default, or only the owner, until the owner turns it on?
2. **Turns.** Should a participant's message start the agent on its own (default here, with a cap of 30 turns an hour), or only when the chat owner writes?
3. **History.** When you add someone, should they see the earlier messages by default? This design says no: they see from when they joined, unless you choose to show earlier messages.
4. **Memory.** Is "recall off while others are in the chat, until you turn it on" the right default, or should recall stay on and you accept they see what it says?
5. **Phase 1 scope.** Should multi-person be for chats only in phase 1, as here, or do you also want it in code sessions soon? Those run tools on your devices.
6. **Purge.** When a person is removed from the hub, should their messages in others' chats stay, with their name, as here, or be deleted?
