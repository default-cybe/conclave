# Sharing with people on your hub, and chats with more than one person

The owner asked: "yes sharing between accounts on one hub is cool, also we can start project together or i can add him or one of my friend to the chat im doing?"

Three things:

1. **Share with a person on this hub.** Nihir shows up as a contact. You send him a chat, memories, files or a shared project, and he gets an Inbox card with Accept and Decline, as from a friend's hub. Nothing goes over the network.
2. **Start a project together.** A shared project with a person on this hub, using the shared projects that already exist between hubs.
3. **Chats with more than one person.** Add Nihir, or a friend on another hub, to a chat you are in. Everyone reads the same chat. Each person's messages start their own agent turn, on their own account, models, limits and devices.

This design is not yet implemented end to end. The `feat/shared-chats` branch adds the contacts API and client, additive membership/sender/turn-starter storage, and tested membership and message-redaction helpers. Chat membership is not exposed over HTTP or WebSocket: seat execution, transcript routing, the turn queue, local share delivery, notifications and the app flows remain unimplemented. The helpers alone do not establish runtime isolation. Contacts currently have no opt-out controls or avatars. Paths with line numbers below describe `main` at 2db22c31.

## 0. The owner's answers

The first draft asked six questions. The owner answered:

| Question | Answer | What it means here |
|---|---|---|
| Turns | "no the chat is shared but they can talk and make changes but they use their own acc and limits" | A participant's message starts a turn that runs on the participant's own account: their models, plans, keys, limits and fallbacks, paid by them. They can do real work on their own devices. Section 6, "Turns". |
| History and access | "it's like adding to chat and project and i can change the access and control for them" | Roles the owner changes at any time: Viewer, Participant, Collaborator, and whether a person sees earlier messages. Section 6, "Roles". |
| Memory | "yes but when they text it should only use memory for that project not other. or maybe we can have option to share memory for this project with people we add" | Your own turns use your memory as before. A participant's turn never reads your personal memory. It reads only project memory someone chose to share, and the participant's own memory as they set it. Section 5, "Project memory". |
| Contacts, removed members | "Yes, keep messages" | People on this hub see each other as contacts by default. A removed person's messages stay with their saved name. |

## 1. Rules that hold in every phase

These come from ACCOUNTS.md and FRIENDS.md section 1. This feature must not weaken any of them.

- **Each account's keys, plans, memory, devices, browser logins, mail and calendar stay its own.** Sharing copies what the sender picked. It never opens a store.
- **Nothing arrives without Accept.** A share, a project invite and a chat invite wait as an Inbox card until the person accepts it.
- **Whoever starts a turn owns the turn.** The turn runs as that person's account: their keys, plan, budget, fallbacks, permission rules, approvals, devices and browser profile. It never uses anyone else's, the chat owner's included.
- **Another person's text is data, never consent.** In any turn, only the words of the person who started it are instructions. Everyone else's messages, and their agents' replies, are quoted data.
- **Memory never crosses accounts unless its owner shares it.** A turn reads its starter's memory, and project memory that its author chose to share. A turn learns only into its starter's memory, and only from the starter's own words and replies.
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
| The payer is `target.accountId ?? session.accountId`, where the session is read again by id. | `core/src/session/stream.ts:129-131` |
| The provider registry is picked by the session's account. | `runner.ts:1048`, `engine.ts:449` |
| About 93 places in 28 files read the account from the session (`accountOf(session)`, `session.accountId`, `sessionAccount(id)`), not from the running turn. | grep over `packages/core/src` and `packages/server/src` |
| Recall reads the session account's memory. Project memory is found by the session's project keys (`memoryKeys`). | `runner.ts:875-880`, `engine.ts:777-778`, `core/src/projects/service.ts:873` |
| Extraction reads every message of the session into the session account's memory. | `engine.ts:2138-2145` |
| Tools run on `machineFor(session)`, and the guard compares `currentAccount()` with the device's account. | `engine.ts:1951-1962`, `core/src/people/guard.ts:40-63` |
| The browser picks its profile by the session's account first, and only then by the current account. | `core/src/browser/manager.ts:461-463` |
| Approvals belong to the session's account. Only that account sees or answers them. | `route-policy.ts:166`, `:681-683`, `engine.ts:1216-1218` |
| `usage` rows carry `account_id` (who paid) and `session_id`. `turns.account` is the provider account (plan login), not the hub account. | `core/src/storage/db.ts:146-162`, `:362-372`, `core/src/storage/repos.ts:733-736` |
| Each bus event is stamped with exactly one account. A socket gets it only on an exact match, or when the stamp is `'*'`. Live events go over `/api/ws`, not SSE. | `core/src/people/events.ts:54-87`, `server/src/ws/clients.ts:125`, `:181` |
| A push goes to the session's account. It is held while that account is active. | `engine.ts:2125-2127`, `core/src/notify/notifier.ts:138-164` |
| A fork of a friend's share is guarded: every tool asks, until the owner writes a message of their own. | `core/src/session/friend-share.ts:289`, `core/src/session/untrusted.ts` |
| Quoted history goes to the model as one `<shared-history>` block naming its source. | `core/src/session/quoted.ts:12`, `:69` |

The brief calls the live channel "SSE per account". It is the WebSocket `/api/ws`, with the same filtering per account. This design says "socket" throughout.

The row about 93 places matters most. If a participant's turn ran inside the owner's session object, each of those places would hand it the owner's keys, memory, device, browser profile or approvals. Section 6, "Turns", avoids that by construction instead of fixing 93 call sites.

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

The owner's answer: people on this hub see each other by default.

| Viewer | Sees |
|---|---|
| Owner | their friends, and every member of this hub |
| Member | the owner and every other member of this hub; no friends (friends stay the owner's) |

A contact shows the person's shown name (`shownName`, ACCOUNTS.md 1) and avatar, never their sign-in name or email. Two switches can narrow this:

- **The owner's switch** "People on this hub can share with each other" is on the People page and on by default. Off, it turns off member-to-member contacts. The owner stays a contact for everyone.
- **Each person's switch** "Others on this hub can send me things" is in Your account. Off, the person is not listed, and a send to them gets 404. A blocked person is the same.

## 4. Part 1: share with a person on this hub

### What can go

| Kind | What goes | On Accept |
|---|---|---|
| `chat`, `session` | The phase 2 bundle: same review, same redaction, same "keep anyway". Code as a diff or git bundle. | Fork, handoff or reference in the recipient's account, as from a friend. A fork is guarded the same way (`friendGuardTurn`). |
| `memory` (new) | Memory rows the sender picks one by one: text, kind, tags. Never the profile, never the review queue, never a memory connection. | Each row goes into the recipient's **memory review queue** marked "from Kai". It is never added to memory directly. |
| `file` (new) | Files from the sender's session outputs (`outputsDir`, `core/src/files/share.ts:48`) or uploads, up to `SHARE_MAX_BYTES` (30 MB) each and 100 MB per share. | Copied into the recipient's files under `accounts/<id>/received/<shareId>/`. They count against the recipient's disk cap (`people/disk.ts`). |

`memory` and `file` are local only at first. They get envelope bodies for friends later, under the same review.

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
| memories a member picks one by one, as copies (items, as today) | anyone's memory store, profile or review queue |
| project memory, read only, when its author turns on "Share this project's memory" (below) | memory of other projects, and memory with no project |
| chats a member shares, as phase 2 snapshots | sessions nobody shared |
| chats started in the project, as multi-person chats (part 3) | anyone's approvals |
| the member list (shown names) and each member's role | emails, sign-in names |

Code stays on GitHub, as today (FRIENDS.md "Code never goes hub to hub"). Each member works on their own devices with their own token, on a branch of their own, and opens pull requests. The project's Code section already groups pull requests by member (FRIENDS.md "Code never goes hub to hub"). This is how a Collaborator's changes reach the others (section 6, "Roles").

### One copy on this hub

Between hubs, each hub keeps a copy, and the owner's hub relays items (star topology, `projects.ts:11-14`). On one hub there is one row per project and one row per item, read by every member. Membership gates who reads it. Nothing is relayed, and nothing can drift.

### Data model

| Table | Change |
|---|---|
| `shared_projects` | `account_id`: the account that owns it. For a project a member made, `owner_fp` is `account:<id>`. A member's project may have local members only (members have no hub key). |
| `shared_project_members` | `account_id TEXT NULL`, set for a person on this hub. For them, `fingerprint` holds `account:<id>` and `public_key` is `''`. The `account:` prefix never collides with a hex fingerprint. |
| `shared_project_members` | `local_project_id TEXT NULL`: each member links the project to a project of their own. Today the link is one column on `shared_projects` (`project-store.ts:27`), which is the owner's folders; per member it must be per row. |
| `shared_project_members` | `share_memory INTEGER NOT NULL DEFAULT 0`, `share_memory_since INTEGER NULL`: this member's project memory is readable by the project (below) |
| `shared_project_members` | `role` keeps `owner` or `member`; a new `access` column holds `viewer`, `participant` or `collaborator` (section 6, "Roles") |
| `shared_project_items` | `author` is `account:<id>` for a person on this hub. Local items carry no signature. The route's account is the proof of authorship. |

A **mixed project** (the hub owner's project with members both here and on friends' hubs) still works. The owner's hub signs a local member's item with the hub key when it goes to a friend's hub, with author `account:<id>` and the member's shown name. The friend's hub shows it as "Nihir on Kai's hub". It checks the hub key, since the member list names that key for `account:` authors.

The tables move to `ACCOUNT_TABLES`, or `CHILD_TABLES` for items and versions under `shared_projects`. "Which projects can I see" reads `shared_project_members` on its own, so the members table needs its own `account_id`, by the rule in ACCOUNTS.md 3.

### Project memory

The owner's answer: a participant's turn should use "memory for that project not other", with an option to share it.

**What it is.** Each account already has project memory: rows whose project key is one of `memoryKeys(session)` for its linked project (`projects/service.ts:873`, `engine.ts:777`). "Share this project's memory with people in it" makes those rows readable by the project's other members. Each member decides for their own memory. It is off by default.

| Question | Answer |
|---|---|
| Scope id | the shared project's id, plus the sharer's `local_project_id`. The rows are the sharer's memory rows whose project key is in the `memoryKeys` of that linked project. |
| What is never in it | rows of other projects, rows with no project, the profile, the review queue, a memory connection's rows (Basic Memory, an MCP server) |
| Who reads | turns started by active members with access Participant or Collaborator, in a chat or session of that shared project. Never a Viewer (they start no turns), never a non-member. |
| How it is read | at recall, read only, through `memoryFor(sharer)` with a strict "this project only" filter. It is fenced like another member's notes: `<friend-shared-context from="Kai (on this hub)">`, quoted data with framework tags defused (`shared-project.ts`). |
| Who writes | only the sharer's own turns, into the sharer's own memory, as today. No other member's turn, extraction or tool writes into it. |
| Revoke | the sharer turns it off, or leaves, or is removed, or the project ends. The next recall stops reading it. Nothing was copied, so nothing is left to delete. What a reply already said stays in the chat. |
| Owner's own turns | read the owner's whole memory as today. Shared project memory of other members is added only in chats and sessions of that project. |

Recall today mixes rows with no project into project recall. The strict filter is new: `recall(q, { project, only: true })`. Phase 2 reads SQLite memory only. A sharer whose memory lives in a connection gets "Project memory sharing works with the hub's memory only for now".

Remote friends do not get project memory. They keep the picked memory items they get today.

### Routes

The `/api/shared-projects` routes (`project-routes.ts:44-107`) open with a new owned kind, `sharedProject`. `ownerOf` for it answers the caller's own id when the caller is an active member. That needs one change to the policy: `own` today compares one owner. A new rule kind does it instead:

- `member({ id: 'sharedProject' })`: the caller must be an active member. Otherwise 404.
- Owner-only actions inside a project stay checked in the handler: invite, remove, change access, rename, end. The handler compares `role === 'owner'`.
- Item writes check `author === account:<caller>` (today's "Only its author edits an item" check, `projects.ts` inbound checks), and `access` is not `viewer`.
- `PUT /api/shared-projects/:id/memory-share` (new, `member`): turns the caller's own project memory share on or off. Nobody can set it for someone else.

### SharedProject tool and trust

`session/shared-project.ts` fences a friend's items as quoted data. A local member's items are fenced the same way, with `from="Nihir (on this hub)"`. A person on the same hub is still another person, and their note can be a prompt injection. Only the reader's own items read plain. The tool is given to a session in the project only when the session's account is a member.

### UI

- **Web.** `/projects` lists projects where you are a member. "New shared project" invites from contacts in both groups. The member list shows "on this hub" or "Alice's hub", and the owner's controls for each member's access. Settings for each member has "Share this project's memory with people in it", with the line "They will see what their agents recall from it." The Inbox has the invite card.
- **Android.** The projects screens exist on web and iPhone only today. Android gets the list, the page and the invite card.

## 6. Part 3: chats with more than one person

### Roles

The owner's answer: "i can change the access and control for them". The chat owner sets each person's access, and can change it or remove them at any time.

| Can | Viewer | Participant | Collaborator | Owner |
|---|---|---|---|---|
| Read the chat (from `history`, below) | yes | yes | yes | yes |
| Post a message | no | yes | yes | yes |
| Start an agent turn, on their own account | no | yes | yes | yes |
| Tools in their turns | none | chat tools only: web search, web fetch, their own memory | as Participant, plus tools on their **own** devices, with their own approvals | the owner's own, as today |
| Add notes and items in the chat's shared project | no | yes | yes | yes |
| Stop a turn | no | their own | their own | any |
| Change the title, roles, history, switches; add or remove people | no | no | no | yes |
| Leave | yes | yes | yes | |
| "Save a copy" (a local share of what they can read, fork only) | yes | yes | yes | |
| Delete the chat | no | no | no | yes, for everyone |

**History** is set per person: `joined` (from when they were added, the default) or `all`. Changing `joined` to `all` shows earlier messages at once. Changing `all` to `joined` hides them from then on, but cannot unsee what was read. The owner's screen says so.

**Changes take effect on the next request.** A role change also stops a turn that the new role no longer allows (for example a Collaborator made Viewer). The stop ends the turn's tool calls; anything a tool already did on their device stays done.

In a chat linked to a shared project, a person's chat access is their project `access` unless the owner sets it apart for the chat.

### Turns: each turn runs on its starter's account

**The seat session.** A Participant or Collaborator gets a **seat session**: a session owned by their own account, `kind: 'chat'`, with `meta.seat = { chatId }`. It is hidden from their list, where the shared chat shows instead. Their turns run in their seat session's runner. That one choice makes the 93 places in section 2 right by construction. Each reads the session's account, and for a seat session that is the participant. It covers:

- `runAs` (`runner.ts:1030`);
- the registry and payer (`runner.ts:1048`, `stream.ts:131`);
- usage rows and budgets (`access.ts`);
- the participant's own fallbacks (ACCOUNTS.md 13);
- memory (`runner.ts:880`, `engine.ts:2143`);
- the machine and guard (`engine.ts:1951`);
- the browser profile (`browser/manager.ts:462`);
- approvals (`route-policy.ts:681`) and pushes (`engine.ts:2125`).

**What the seat session holds.** It keeps its starter's model pick, device, folder and permission mode for this chat, their turns, usage, approvals and checkpoints. It holds no transcript of its own. The runner reads and writes the transcript through one seam pointed at the shared chat. The seam reads what that person can see (`seatView`, below) and writes into the shared chat with `sender` set.

**The owner's turns** run in the chat session itself, exactly as today.

**Model.** A participant's turn uses their pick for this chat (the model menu in their composer, kept on their seat). The first pick is their default model. Their list has only models they can call, so a pick is never the owner's model on the owner's key. Harness models (Claude Code, Codex and the rest) are not offered in a shared chat in the first phases. A harness keeps its own session and would not see the shared transcript.

**Payment.** The starter pays, always:

- **Who paid is recorded.** Usage rows are written by `streamCompletion` with `account_id` = the payer. `session_id` = the seat session, so "what did this chat cost me" joins seats to the chat. The `turns` table gets `started_by TEXT NULL` (`NULL` = the session's owner) for the chat's turn log.
- **The owner never pays for a participant's turn,** and a participant never pays for the owner's. Nothing in a participant's turn can fall back to the session the transcript lives in.
- **Chores follow the turn.** Compaction for a turn, and extraction after it, are paid by the starter. The chat's title belongs to the owner.
- **No turn cap on others' money.** A participant who loops spends their own limits. The owner can make them a Viewer or remove them.

**One turn at a time.** A chat runs one turn at a time. Messages that come in while a turn runs wait in one queue, in order, and each starts its own sender's turn. This keeps the transcript readable and avoids two turns writing between each other's tool calls. The owner can stop any turn; a starter can stop their own.

**The transcript with several models.** Each assistant message already stores `model` (`db.ts:43-57`). It also gets `sender` (whose agent wrote it). The UI groups a turn under its starter: "Nihir · GPT-5.5" on the left, the owner's turns on the right, as for human messages.

**How a turn sees the others.** When a turn's request is built:

- The starter's own messages, and their own agent's earlier replies, go in their normal roles.
- Every other message goes in one `<shared-history>` block per run, naming its sender ("Kai", "Kai's agent, claude-opus"), with framework tags defused (`quoted.ts:69`, `untrusted.ts`). That covers other people's messages, their agents' replies and their tool calls (as one-line summaries).
- Reasoning blobs and provider-specific blocks from other turns are dropped, as for a friend's share (FRIENDS.md "Imported turns"). They belong to another provider and another person.
- The model is told who is in the chat, and that only the starter's words are instructions.

### Tools, devices and approvals

- **A turn's tools run only on the starter's machine.** `machineFor(seat)` gives a Collaborator their seat's device: one of their own paired devices, or their hub workspace (ACCOUNTS.md 5). The guard (`guard.ts:40-63`) refuses any other device, because the context is theirs. The owner's devices are never in reach of a participant's turn, and a participant's are never in reach of the owner's.
- **A Participant's turn has chat tools only,** cut with the tool filter (`sessionAllowsTool`, `core/src/session/chat.ts:74`), whatever their account. This matters when the hub owner is the participant in a member's chat: the owner's account could reach the hub machine, and the Participant role must not.
- **Approvals go to the starter only.** They are raised on the seat session, so `pendingAccount` answers the starter, and `POST /api/approvals/:id` stays `own`. The owner can neither see nor answer a participant's approval, and a participant cannot answer the owner's. The signed approval link (`routes.ts:619`) goes only to the starter's devices.
- **Bypass is off while anyone else is active in the chat,** for every turn, the owner's included. Others' text sits in every turn's context, and bypass would let an injection run with no one asked. Each person's own allow rules still apply to their own turns. The chat header says so.
- **The approval card says who will see the result.** "The result shows in Kai's chat, which Kai and Priya read" when `showToolOutput` is on. When it is off: "others see a one-line summary".
- **No slash commands from someone else's text.** A `/` line is a command only in the starter's own message, and only commands of the starter's account run.
- **Making changes in a shared project** goes through git. A Collaborator's turn works in their own clone, on their own device, on a branch of their own, with their own GitHub token, and opens a pull request. Nothing writes into another person's folder.

### Data model

**`chat_participants`**, a new table in `ACCOUNT_TABLES`. A participant must list "chats I am in" without going through someone else's session.

| Column | Meaning |
|---|---|
| `session_id` | the chat |
| `account_id` | the participant's account (for a person on this hub); for a friend, the chat owner's account |
| `friend_id` | set for a friend on another hub, else `''` |
| `access` | `viewer`, `participant`, `collaborator` |
| `state` | `invited`, `active`, `declined`, `left`, `removed` |
| `history` | `joined` or `all` |
| `joined_seq` | the chat's `seq` when they joined (what `joined` reads from) |
| `seat_id` | their seat session, made on Accept for Participant and Collaborator |
| `read_upto_seq` | their read mark |
| `muted` | their notifications for this chat |
| `use_my_memory` | their own memory is recalled into their turns here (off) |
| `added_by`, `added_at`, `updated_at` | |

The primary key is `(session_id, account_id, friend_id)`.

**`messages`** gets `sender TEXT NULL`. `NULL` means the session's owner, which covers every message written before this feature. Otherwise it is `account:<id>` or `friend:<friendId>`, on human and assistant messages alike. The existing `author` column takes a snapshot of the shown name when the message is written. It still reads right after the person renames, leaves or is removed (the owner's answer: keep messages). The avatar is looked up by `sender` and falls back to initials.

**`turns`** gets `started_by TEXT NULL`. **`usage`** needs no new column; `account_id` is already who paid.

**`sessions.meta.participants`** holds the chat's switches: `showToolOutput` (off).

**On a friend's hub**, a mirror session with `kind: 'chat'` and `meta.joined = { friendId, sessionId }`, owned by that hub's owner. It is the friend's seat and their transcript copy at once (section 6, "Friends on another hub").

### Who can reach the chat: one check

A new rule kind, `seat({ id: 'session' })`, allows the session's owner or an active participant. The routes split:

| Route | Rule |
|---|---|
| `GET /api/sessions/:id`, `GET /api/sessions/:id/messages`, `.../messages/:msgId/blocks/:index` | `seat`; the handler shapes the reply with `seatView` |
| `POST /api/sessions/:id/messages` | `seat`; the handler checks the caller's access, records `sender`, and queues a turn on the caller's seat (the owner's on the chat itself) |
| `PATCH /api/sessions/:id/seat` (new) | `seat`: the caller's own model, device and folder for this chat. A device must be the caller's own (`ownDevice`). |
| `POST /api/sessions/:id/turns/:turnId/stop` (new) | `seat`: the turn's starter, or the owner |
| `POST /api/sessions/:id/read` (new) | `seat`; moves the caller's own read mark |
| `POST /api/sessions/:id/participants` (new) | `own` (the session's owner): invite contacts with an access and a history |
| `PATCH`, `DELETE /api/sessions/:id/participants/:pid` (new) | `own`: change access or history, remove |
| `POST /api/sessions/:id/leave` (new) | `seat`: the caller leaves |
| `GET /api/chats/invites`, `POST /api/chats/invites/:id/accept`, `/decline` (new) | `self` and `own({ id: 'chatInvite' })` |
| every other `/api/sessions/:id/*` route (`PATCH`, `DELETE`, fork, export, bundle, queue, approvals, checkpoints, hub copy…) | unchanged: `own`, so a participant gets 404 |
| seat sessions | `own`, as any session: only their account reaches them. `GET /api/sessions` leaves them out of lists. |

`seat` reads `chat_participants` on each request and does not cache. Leaving or being removed therefore takes effect on the next call. The cached `sessionAccount` (`engine.ts:396`) stays right: the chat's owner never changes, and a seat's owner never changes.

**`seatView(session, messages, viewer)`** is one function in core. The routes, the socket fan-out and the transcript seam of a seat's turn all use it, so the three cannot differ. For anyone but the owner it leaves out:

- the owner's `cwd`, `device`, `permissionMode`, cost and stats;
- the queue's other entries' details;
- messages before the viewer's history start;
- full tool output of other people's turns, unless `showToolOutput` is on;
- recalled memory blocks and system reminders of every turn.

### Memory

The owner's answer, as rules:

| Turn started by | Reads | Learns into |
|---|---|---|
| the chat owner | the owner's own memory, as today (`runner.ts:880`); plus shared project memory of other members in a chat of a shared project | the owner's memory, from the owner's own messages and replies to the owner's turns |
| a participant | (a) shared project memory of members who turned it on, in a chat of that project; (b) their own memory, only when `use_my_memory` is on (off by default). **Never the owner's personal memory.** | the participant's memory, from their own messages and replies to their own turns |

- **Extraction filters by sender.** `afterTurn` (`engine.ts:2143`) reads the shared chat's messages filtered to `sender` = the starter, and the replies of the starter's turns. It writes into `memoryFor(starter)`. It does not use `messages.list(id)` of the whole chat.
- **Nothing from one account's turns goes into another account's memory.** No consent switch exists in these phases.
- **The owner's recall can still show in replies others read.** The owner's turns use the owner's memory, as the owner asked. What the agent recalls, it can say, and the others read it. The chat header says "Your turns use your memory. People here see the replies." The chat's memory switch (`chat.ts`) turns it off for the owner's turns.
- **A participant's own memory has the same problem the other way,** which is why `use_my_memory` starts off. Their composer says "Your memory stays out of this chat" until they turn it on.
- **Past chat search.** The owner's search covers the chat as today. A participant's search covers chats they are in, marked "Kai's chat", with only what `seatView` gives them.

### Live updates

Today an event has one stamp, and `eventVisibleTo` needs an exact match (`events.ts:84-87`). The change:

- `eventAccount` returns a set for events of a shared chat: the owner plus the chat's active local participants. It does this only for event types on an allow list.
  - Allowed: `message.created`, `message.updated`, `message.deleted`, `message.delta` (assistant text only), `session.updated` and `session.deleted` (shaped by `seatView`), `chat.typing` (new), `chat.participants` (new), `chat.turn` (new: who is running, queued next). These names are in `core/src/types.ts:827-835`.
  - Never allowed: `approval.*`, `question.*`, `notice`, `session.queue`. `tool.started` and `tool.completed` go as one-line summaries. `tool.progress` goes only when `showToolOutput` is on.
- Events of a seat session (its approvals, notices, usage, tool progress) are stamped with the seat's account, as for any session. Nobody else gets them.
- `eventVisibleTo(stamp, account)` checks membership in the set. The replay after a reconnect (`ws/clients.ts:125`) uses the same check. It also drops events from before the participant's history start.
- A participant who leaves or is removed gets `chat.removed` for that chat. Their sockets drop the chat's events from then on: the set is computed when each event is emitted.
- The engine keeps the participant set per chat in memory and updates it on every change to `chat_participants`.

### Notifications

- **New rule `notifications.on.chatMessage`** (on). A message from another human in a chat you are in pushes to you. It is held while you are active (`someoneActive`, `notifier.ts:138`) and skipped while the chat is muted.
- **A turn's end** pushes to its starter, under `sessionDone`, never to everyone.
- **Approvals push only to the starter of the turn.**
- **A chat invite** pushes to the invitee under `friendMessage` (the rule shares already use).
- **A change of access** ("Kai made you a Viewer in 'Trip plan'") is an Inbox line, not a push.

### Leave, remove, delete

- **Leave:** state `left`. The chat goes from their list. Their messages stay, with their name. Their seat session stays theirs (it holds their usage and turns) and turns read only. They can "Save a copy" first.
- **Remove** (by the owner): state `removed`, the same for them, with "Kai took you out of 'Trip plan'". A turn of theirs that runs is stopped.
- **Delete** (by the owner): the chat is gone for everyone. `chat_participants` rows go with it. Seat sessions turn read only and keep their usage. Friends' mirrors get `chat.remove` with `ended` and turn read only.
- **A person removed from the hub** (`purgeAccount`, `people/store.ts:316`): their seats and `chat_participants` rows go with their account. Their messages in others' chats stay, with the `author` snapshot, as the owner asked. `sender` becomes `account:removed`, so no lookup finds a new account by a reused id. (Ids are never reused, but this does not rely on it.)
- **A friend removed** (`friend.remove`): they leave every chat of the owner's, and the mirrors on their side turn read only.

### Friends on another hub in a chat

Friends are the owner's, so only the hub owner can add a friend to a chat. A member can when per-account keys exist.

**Topology:** a star, like shared projects. The owner's hub holds the chat and its order. The friend's hub holds a mirror. A friend's turns run **on the friend's hub**, with their models, keys and devices, from the mirror, as the owner's first answer asks. The owner's hub never runs a turn for a friend.

**New envelope types** in `envelope.ts:34-72`, all signed by the sending hub, sealed for the receiving one, through the outbox:

| Type | From, to | What |
|---|---|---|
| `chat.invite` | owner, friend | title, owner's name, other participants' names, access, message count. Nothing else before Accept. |
| `chat.join` | friend, owner | accepted. The owner answers with `chat.state`. |
| `chat.leave` | friend, owner | declined, or left |
| `chat.remove` | owner, friend | taken out, or the chat ended (`ended: true`) |
| `chat.access` | owner, friend | the friend's new access or history |
| `chat.message` | owner, friends | one finished message with the owner's `seq`, `sender`, `author`, `model` and `createdAt`, shaped by `seatView` for that friend. No streaming deltas. |
| `chat.post` | friend, owner | the friend's own message: `clientId` (a ULID), text, up to 20,000 characters as for `note` (`service.ts:89`). No attachments at first. |
| `chat.turn` | friend, owner | the finished result of the friend's turn: their agent's reply and one-line tool summaries, with `clientId` and the `seq` it answered. Full tool output only when `showToolOutput` is on. |
| `chat.state` | owner, friend | meta and every message the friend may read, on join and on sync, as a blob when over 256 KB |
| `chat.sync` | friend, owner | send `chat.state` again; at most once a minute per friend, as `project.sync` |

**Turns over the network.** The friend's hub runs one turn per post, on the mirror, and sends `chat.turn` when it ends. The owner's hub takes the queue slot when `chat.post` arrives and holds it for the friend's turn for up to 10 minutes. If the result is late it is placed when it comes, with "late" shown, and the queue moves on.

**Ordering:** the owner's hub gives every message its `seq` when it takes it. That is the one order. A post that arrives late (outbox, pull path) goes in at the end with its own `createdAt` shown. The mirror applies `chat.message` in `seq` order. A gap (a `seq` missing for 2 minutes) sends `chat.sync`.

**Idempotence:** by envelope id, as today (`peer_inbox` primary key), and by `clientId` for posts and turns. A retried post never makes two messages.

**Offline:** the outbox retries for 7 days (`service.ts:79`). The friend's hub shows its own post as "Sending" until a `chat.message` echoes its `clientId`.

**Limits on the owner's hub for each friend:**

- 60 `chat.post` an hour per chat;
- 20,000 characters per message, 200,000 per `chat.turn`;
- 5 open chat invites per friend.

These are about noise and disk, not money: a friend's turns cost the friend. A post over a limit is acked and named in `refused=` (FRIENDS.md "Phase 1 as built"). The friend's hub shows "Not delivered: Kai's hub takes no more messages in this chat this hour".

**Grants:** a new friend grant, `joinChats` (off), on the owner's side. It is needed before a friend can be invited. On the friend's side, `receiveShares` covers invites, as with projects.

### UI

**Web:**

- The chat header (`ChatPage.tsx`, `ChatView.tsx:259`) gets a row of avatars and "Add people". The owner gets, per person, the access (Viewer, Participant, Collaborator), history (from when they joined, or all), Remove, and the chat's switch "Show tool output to others". A participant gets Leave, Mute and "Use my memory here".
- The sidebar (`Sidebar.tsx` `Row`, `lib/sidebar.ts`) marks a chat with others by stacked avatars. Chats you are in but do not own sit in the same list with "Kai's".
- The bubbles (`conversation/UserMessage.tsx`, `features/chat/Turn.tsx:56`) show a name and avatar for others' messages. A turn shows its starter and model.
- A participant's composer has their own model menu and, for a Collaborator, their device and folder. It says "Your turns use your models and limits". A Viewer has no composer, only "Kai gave you read access".
- A "Running: Nihir's turn · next: Kai" line shows the queue.
- The Inbox gets "Kai added you to 'Trip plan' as a Participant" with Accept and Decline.

**Android:**

- `ui/conversation/ChatThread.kt` and `ChatViewModels.kt` show names, avatars, each turn's starter and model, and a people sheet.
- `ui/sessions/SessionsScreen.kt` shows chats you are in.
- `client/.../ConclaveClient*.kt` gets the participant, seat and invite routes.
- Push opens the chat.

**CLI:** `conclave chats add <id> <contact> [--access viewer|participant|collaborator] [--history all]`, `access`, `leave`, `people <id>`.

## 7. Threat model

**Who we defend against:** a member of this hub, a friend's hub, and anything that steers one of their agents or messages (a pasted page, a crafted note). As in ACCOUNTS.md 8, not the hub owner, who can read the database.

**Assets:** each account's chats, memory, keys, plans, budget, devices, browser profile, files and approvals; the hub machine.

### Reading what is not yours

| Threat | Check that stops it |
|---|---|
| A member reads a chat they are not in, by id | `seat` reads `chat_participants` on each request: not an active participant is 404, the same as an unknown id. Every other session route stays `own`. Route sweep test. |
| A participant reads more than they should: the owner's paths, device, cost, recalled memory, others' tool output, history before they joined | `seatView` is the only shape anyone but the owner gets, from the routes, the socket and their own turn's context alike. One function, one test per field. |
| A participant's turn reads hidden parts through the model | The seat's transcript seam reads through `seatView` too, so their model never gets what they could not read themselves. |
| A participant gets the owner's events (approvals, notices, tool output) | Shared chat events fan out only for types on an allow list, shaped by `seatView`. Seat events stay their seat's. Replay is filtered the same way. |
| Someone who left, or was made a Viewer, keeps acting | Access is read per request and per emitted event, never from a cache built earlier. A role change stops a turn it no longer allows. |
| A Viewer posts or starts turns | `POST .../messages` checks access. No seat is made for a Viewer. |

### Using someone else's account

| Threat | Check that stops it |
|---|---|
| A participant's turn pays with the owner's keys, plan or budget | The turn runs in the participant's seat session, so `runAs`, the registry and the payer (`stream.ts:131`) are the participant's. A test fails if any provider call in a seat turn resolves the chat owner's account. |
| The owner's turn pays with a participant's keys | The owner's turns run in the chat session, owned by the owner, as today. |
| A participant's turn uses the owner's devices or the hub | `machineFor(seat)` gives the participant's own device only, and the guard refuses any other. A Participant has chat tools only, cut by the tool filter, whatever their account. |
| The owner's turn uses a participant's device | The chat session's device is the owner's; the guard refuses a member's device for the owner's context. |
| A participant's turn uses the owner's browser profile | The browser picks the profile by the session's account (`browser/manager.ts:462`), which for a seat is the participant's. A test opens the browser in a seat turn and checks the profile key. |
| A tool or chore in a seat turn is handed the chat id instead of the seat id | That would resolve the owner on every one of the 93 paths. The transcript seam is the only code that knows the chat id. A test spies `providersFor`, `memoryFor`, `machineFor`, the browser's `accountFor` and `requestApproval` during a seat turn and fails on the owner's account. |
| A participant answers the owner's approvals, or the other way | Approvals are raised on the turn's own session and stay `own` (`route-policy.ts:166`). The signed link goes to the starter's devices only and never into a chat, a push to others, or an event others get. |
| The owner, as a participant in a member's chat, reaches the hub machine through the member's prompts | The owner's seat as a Participant has chat tools only. As a Collaborator, every tool still asks the owner (bypass off while others are active), and the member's text is quoted data. |
| A participant picks a model they cannot use, or a harness | The model menu is their own registry. The seat route checks `isUsable` for their account. Harnesses are refused in a shared chat. |
| A slash command in someone else's text runs | `/` is parsed only in the starter's own message, and only that account's commands run. |

### Memory

| Threat | Check that stops it |
|---|---|
| A participant's turn reads the owner's personal memory | Recall reads `memoryFor(seat account)`, which is the participant's. The owner's memory is reached only through the project memory share, with the strict project filter, and only when the owner turned it on. |
| Project memory share leaks rows of other projects or with no project | The strict filter (`only: true`) reads only rows whose project key is in the sharer's linked project's `memoryKeys`. A test plants rows in another project and with no project and checks they never come back. |
| Someone writes into another person's memory | Extraction writes only into `memoryFor(starter)`, from the starter's own messages and replies. Nothing writes into a shared project memory but its owner's own turns. |
| A participant's memory leaks to the owner | `use_my_memory` starts off. Their recall comes only from their own memory and shared project memory. |
| The owner's memory leaks to participants through the owner's replies | Accepted by the owner's answer. The header says so, and the chat's memory switch turns it off. |
| A share revoked late | Recall reads the switch each time. Off, the next turn reads nothing. Text already in the chat stays; the doc and the screen say so. |

### Text, files and noise

| Threat | Check that stops it |
|---|---|
| A participant's prompt injection steers another person's turn | Every message that is not the starter's goes in a `<shared-history>` block naming its sender, with framework tags defused. The model is told only the starter instructs. Bypass is off while others are active, so a tool call still asks the starter. |
| Reasoning or provider blocks from one person's turn reach another's provider | Dropped from other people's turns when a request is built. |
| A share or invite forced on someone | Every share, project invite and chat invite waits for Accept. "Others on this hub can send me things" off hides the person; a send then 404s. |
| A member finds others' names, sign-in names or emails | `GET /api/contacts` gives shown names and avatars only. The owner can turn member-to-member contacts off. |
| A member shares to a friend of the owner, or reaches the hub key | A member's `to` may hold only `account:` parties: `friend:` is 403. Friends routes stay `admin`. |
| A member writes another member's project item, or sees a project they are not in | `member({ id: 'sharedProject' })` gates the project. Item writes check `author === account:<caller>` and access. Owner actions check the role in the handler. |
| A Collaborator changes another person's files | Their tools run only on their own device. Shared code moves through branches and pull requests on GitHub, which each person reviews. |
| A local member's project item is passed off as signed by them to a friend's hub | It is signed by the hub key with author `account:<id>`. The friend's hub knows it is "Nihir on Kai's hub", vouched for by Kai's hub only. |
| A shared file fills the recipient's disk | Accept counts against the recipient's disk cap. Each file is at most 30 MB, each share 100 MB. |
| A shared memory row poisons the recipient's memory | It lands in the review queue, marked with its sender. It is never added to memory directly. |
| A participant floods the chat with turns | They pay for their own turns. Turns run one at a time. The owner can make them a Viewer or remove them. |
| A friend floods a chat over `conclave-peer` | 60 posts an hour per chat, size caps, 5 open invites, refused with a reason. Signing, nonces and the 5-minute expiry as today. |
| A friend's post or turn replayed or doubled | Envelope id dedup, and `clientId` dedup. |
| A friend's hub forges `chat.message` or another person's turn | The owner's hub takes only `chat.post`, `chat.turn`, `chat.join`, `chat.leave` and `chat.sync` from a participant, and stores a `chat.turn` with `sender` = that friend. `chat.message`, `chat.state`, `chat.access` and `chat.remove` are taken only from the chat's owner hub. |
| A removed account's id matches a new account | `sender` becomes `account:removed` on purge. |

**Where it can still fail:**

- What a reply says cannot be unsaid. Recalled memory or tool output an agent quotes in its own words reaches everyone who reads the chat, whatever `showToolOutput` says. The defaults and the screen's wording are the defense, not a filter.
- Turning history from `all` to `joined`, removing a person, or turning a memory share off stops future reads. It does not unsee what was read.
- Everyone's text reaches every participant's model provider. Adding Nihir means your chat goes to the providers he picks. The add dialog says so.
- An injection in someone else's text can still shape a tool call that the starter then approves.
- The seat design keeps the 93 session-derived paths right only while a seat turn never passes the chat id to them. The spy test catches the paths that tests run. A new path added later must use the seat.

## 8. Phases

Turns that run on their starter's account are the core of the owner's answer, so the seat session is in phase 1. Device tools are not. They bring device and folder picking, approvals routed per seat, and git work, and they are what a shared project is for.

| Phase | What | Smallest useful slice |
|---|---|---|
| 1 | Contacts on this hub (on by default). Share a chat or session with a person on this hub (local carrier, Accept, fork, handoff, reference). Chats with people on this hub, with Viewer and Participant access, history per person, seat sessions on each person's own models and limits, chat tools only, memory by the rules in section 6 (no project memory yet). | You add Nihir to your chat as a Participant. He reads and writes. His messages get answers from his own models, paid by him. Yours from yours. |
| 2 | Collaborator access: tools on the participant's own devices, their own approvals and folder. Shared projects with people on this hub, with access per member. Project memory sharing. Memory and file shares. "Start a chat in this project". | You and Nihir share a project and its repo. Each of you works in the same chat from your own laptop, on your own branch, and shares project memory if you choose. |
| 3 | Friends on other hubs in your chats (`chat.*` envelopes). Their turns run on their hub. | You add Alice from her hub to your chat. |
| later | Agent and code sessions with participants. Harness models in shared chats. Two turns at once. Project memory for friends' hubs and for memory connections. Member-owned projects with friends (needs per-account keys). | |

## 9. Test plan

Every phase runs `bun run test`. The people sweep and the route sweep (`server/test/people-sweep.test.ts`) must pass with the new tables and routes listed.

### Phase 1

- **Tables.** `chat_participants`, the new share columns, `messages.sender` and `turns.started_by` are in the right list. Migration on an old database, twice, leaves every row the owner's.
- **Contacts.** By default the owner sees members and friends, and a member sees everyone on this hub and no friends. The off switches hide people, and a send to them is 404.
- **Shares, cross-account.** A member's share to a member lands in the recipient's account only. The owner's Inbox does not show it. A third member cannot accept, view or fork it (404). A member's `to: friend:…` is 403. The fork is guarded.
- **Seat routes.** The owner, each access level, invited, left, removed and a stranger each hit every `/api/sessions/:id/*` route. Only the rows in section 6 open to a participant. Every other route is 404 for them. A seat session is 404 for everyone but its account, and missing from `GET /api/sessions`.
- **Roles.** A Viewer cannot post (403) and has no seat. Changing a Participant to a Viewer stops their running turn and refuses their next post. History `joined` hides earlier messages on GET, on the socket and in their turn's context; `all` shows them.
- **seatView.** A participant's session, messages and turn context hold no `cwd`, `device`, `permissionMode`, cost, recalled memory, reminders or others' tool output (unless switched on).
- **Payer, cross-account.** Two members with their own keys and a hub owner with hub keys. A Participant's turn writes usage only with `account_id` = the participant and `session_id` = their seat. The owner's usage is unchanged. A participant with no key and no grant gets their own "You can't use…" error, never a call on the owner's key. A participant at their budget is refused, while the owner's turn in the same chat still runs. The participant's own usage fallback is walked, never the owner's.
- **The spy test.** During a seat turn, `providersFor`, `registryFor`, `memoryFor`, `machineFor`, the browser's `accountFor` and `requestApproval` are never called with the chat owner's account. The same runs in reverse for an owner's turn in a member's chat.
- **Tools.** A Participant's turn is offered chat tools only, also when the participant is the hub owner. Bypass is ignored while another person is active.
- **Memory.** The owner's turn recalls the owner's memory. A participant's turn never recalls a row from the owner's store, checked by planted text. With `use_my_memory` off it recalls none of the participant's own rows either. After a mixed chat, the owner's store gained nothing from the participant's messages, and the participant's store gained nothing from the owner's.
- **Transcript.** Messages store `sender`, `author` and `model`. A turn's request has the starter's messages in their roles and everyone else's in `<shared-history>` blocks with framework tags defused and other turns' reasoning dropped.
- **Queue.** Two posts in a row run as two turns, one after the other, each on its own sender's account.
- **Leave and purge.** Leave, remove and delete each end access on the next call. Purging a member keeps their messages with their name and `account:removed`.
- **Web and Android.** Header avatars and access controls, bubbles with names, turns with starter and model, the participant's model menu, add and leave flows, the Inbox invite card. Client tests for the new routes in `:client`.

### Phase 2

- **Collaborator devices.** A Collaborator's seat takes only their own device (`ownDevice`: another's is 404). Their tool calls run there and nowhere else. Their approvals reach only them. The owner's `GET /api/approvals` never lists them, and the reverse.
- **Project memory, cross-account.** Off by default: a member's turn recalls nothing of the owner's. On: it recalls only the owner's rows of the linked project, never rows of another project or with no project, never the profile. Off again: the next turn recalls none. Leaving the project stops it the same way. No turn of a member writes a row into the sharer's store.
- **Memory share.** Rows land in the recipient's review queue only, never in memory, and never in a third account.
- **File share.** The copy counts against the recipient's disk cap. A share past the cap is refused at Accept.
- **Projects, cross-account.** A non-member gets 404 on every `/api/shared-projects/:id/*`. A member cannot edit another member's item, change access, invite or remove (owner only). A Viewer cannot add items. `local_project_id` is per member: one member's link never shows another's folders.
- **Mixed project.** A local member's item reaches a friend's hub signed by the hub key, author `account:<id>`. The friend's hub refuses an `account:` item signed by any other key.
- **SharedProject tool.** It fences other members' items, local ones too. A non-member's session does not get the tool.

### Phase 3

Two hubs on one machine, with `PeerOptions.loopback` as the friends tests do.

- **Envelopes.** Each `chat.*` type is accepted only from the right side. `chat.message` and `chat.access` from a participant are refused.
- **Turns on the friend's hub.** A friend's post runs a turn on the friend's hub only. Its usage is on the friend's hub, and the owner's hub makes no provider call for it. The result arrives as `chat.turn` with `sender` = the friend.
- **Ordering.** Out-of-order delivery is applied in `seq` order. A gap triggers `chat.sync`. A retried post or turn is one message.
- **Offline.** A post queued while the owner's hub is down arrives after it is back, at the end. A late `chat.turn` is placed with "late" and the queue moves on.
- **Limits.** The 61st post in an hour is refused with a reason that shows as Not delivered.
- **Memory.** The friend's words reach neither hub's memory except the friend's own, from their own turns.
- **Remove and end.** `friend.remove` and `chat.remove` make the mirror read only.

## 10. Final owner decisions

1. **Talking without the agent.** A normal send starts the sender's own AI turn. The per-message "Just talk" switch sends a plain human message with no turn.
2. **One turn at a time.** Turns run one after another, in order.
3. **Stopping.** The chat owner can stop anyone's running turn. Each person can stop their own turn.
4. **Default access.** New people start as Participants, with chat tools only. Phase 1 has Viewer and Participant roles. Earlier history is off by default. The owner can change role/history or remove a person anytime.
5. **Their memory.** A participant's own memory starts off in someone else's chat. They can turn it on for themselves. Their turn never reads the chat owner's personal memory, and each turn learns only into its starter's memory.
6. **Tool output.** Others see one-line tool summaries. Only the turn starter sees full tool output.
7. **Payer and identity.** Every turn runs in a seat owned by its starter, using their models, plans, keys, limits and fallbacks, billed to them. Hub members see each other as contacts by default. Removing a member keeps their messages and saved name.
