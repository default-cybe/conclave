# Friends: sharing between Conclave hubs

One Conclave owner sends chats, sessions, code and messages to another
Conclave owner, hub to hub. Each side keeps its own models, keys, memory and
rules. Nothing goes through a central service, and nothing is reachable
without a friend's key.

Sources: the research reports of 2026-10-20 (how others share, and the code
map). No product ships this between independent owners today; the closest
models are Syncthing (keys as identity, mutual accept), Matrix federation
(signed requests, idempotent transactions) and Tailscale node sharing
(quarantined shares). Lessons kept from the others: shared links leak
(ChatGPT, Grok, Claude, Meta AI), live public links were retired (OpenCode,
Amp), recipients get a fork almost everywhere, and friend text is prompt
injection unless capabilities are cut.

## 1. Rules that hold in every phase

- **A key is the identity; addresses are hints.** The friend id is the hub
  fingerprint from `hub-key.pem`. Every request is identity checked first.
- **Nothing is reachable without a friend's key.** No public links, no
  discoverable pages. Strangers reach only the friend request endpoint,
  which needs a one time invite secret, or, while the owner allows requests
  by address (on by default), takes a request that holds a name, a key and
  an address record and nothing else (see "Add a friend by address").
- **Each grant is separate and starts off,** except "receive shares into my
  Inbox". Grants never widen each other.
- **A friend's message is data, never consent.** It cannot approve, change
  settings, skills or permissions, or run a slash command. Permission
  prompts still go to the owner.
- **Received content is untrusted** until the owner adopts it: quoted
  history with provenance, no memory learning, no past chat indexing, no
  "always allow", every tool asks.
- **Memory and secrets stay home.** Bundles pass the sanitizer at export and
  again at import, and the sender reviews what was removed.
- **Owner pays and owner's policy applies** for anything that runs on a hub.
- **Say "asked to delete", never promise deletion** of a copy on another hub.

## 2. Protocol `conclave-peer/1`

- **Keys.** The Ed25519 hub key signs. An X25519 subkey, signed by the hub
  key and rotatable, seals bodies end to end, so tunnels and proxies see only
  ciphertext.
- **Invite.** `conclave://friend?fp&url&alt&s&exp`: `s` is a 128 bit one time
  secret, valid 24 hours. Shown as a QR code and a link.
- **Request.** Bob's hub identity checks Alice's hub at `url` against `fp`,
  then sends a signed `friend.request` with `s`, Bob's key, name, subkey and
  address record. Alice sees "Bob (3f9a 12c0 …) wants to be friends" and
  accepts. At most 3 pending requests; per address limits apply.
- **Safety code.** A short hash of both fingerprints, sorted. Compared in
  person or by QR; a verified friend gets a badge.
- **Requests between hubs.** HTTPS JSON with an RFC 9421 style signature over
  method, path, authority, content digest, a `conclave-to` header with the
  recipient fingerprint, created and expires (5 minutes at most) and a nonce.
  The receiver keeps a nonce cache. Friend credentials are checked only on
  `/peer/v1/*` routes, never by the owner and client auth.
- **Addresses.** A signed record `{fp, addrs, seq, issuedAt, expiresAt}`,
  pushed to friends on change (quick tunnels move) and served at
  `GET /peer/v1/addresses`. An address that is never a friend's hub
  (loopback, link local, this hub itself) is refused; see "Addresses a
  friend gives".
- **Delivery.** `PUT /peer/v1/inbox/{msgId}` (ULID, idempotent). An outbox
  retries with backoff and jitter for 7 days, then shows "Not delivered"
  with Retry and Cancel. If the friend cannot be reached, their hub pulls
  from `GET /peer/v1/outbox` when it can reach yours.
- **Large objects are pulled.** An offer carries a manifest of sealed,
  content addressed blobs; the recipient fetches them with signed
  `GET /peer/v1/blobs/{sha256}` after accepting. Cap 100 MB per share.
- **Message types.** `friend.request|accept|remove`, `address.update`,
  `key.rotate`, `share.offer|update|revoke|ack`, `agent.task.send|update|cancel`.
- **Key change** without a rotation signed by the old key blocks traffic
  until the owner confirms ("Alice's hub has a new key").

## 3. Phases

| Phase | What | Notes |
|---|---|---|
| 0 | Sanitizer, signed bundle, untrusted hardening, safe exports | in progress |
| 1 | Friends: invite, request, accept, safety code, addresses, outbox, remove | built: server, core, CLI, web and iPhone screens |
| 2 | Send a chat or session; Inbox "Shared with you"; read only view | built: server, core, CLI, web and iPhone screens |
| 3 | Continue as fork, Handoff, Use as reference | built: server, core, CLI, web and iPhone screens |
| 3+ | Add a friend by address; shared projects (notes, picked memories, chats, code on GitHub) | built: server, core, CLI and web, phone layouts included |
| 4 | Message a friend's agents | A2A shaped tasks, grants, budget |
| 5 | Live seats in a session (viewer, contributor) | later |

### Phase 1 as built

`packages/server/src/peer` (DESIGN.md 27). Where it differs from section 2:

- The invite secret never travels. The request carries an HMAC of both
  fingerprints and the message id, keyed with SHA-256 of the secret, which
  is all the inviting hub keeps. A tunnel that sees the request cannot use
  the invite for another key.
- The friend request is the one unsealed message: the requester has no
  subkey for the other hub yet. It holds no secret, and it is signed.
- The address record also carries the hub key and the subkey with the hub
  key's signature, so `GET /peer/v1/addresses` and `address.update` move a
  new subkey too.
- Every message is an envelope the sender's key signs, so a pulled message
  is checked like a pushed one. A pull acks the ids it took
  (`GET /peer/v1/outbox?ack=`); a cursor would skip an item the owner
  retried. One it took and refused (a note while that friend's notes are
  off) is also named in `refused=<id>.<code>`: the sender marks it Not
  delivered with the reason ("Bob's hub refused it: it does not take notes
  or shares from this hub now"), and Retry sends it again. It is acked all
  the same, so the next pull does not serve it again in front of the rest.
  An older hub that does not read `refused` counts it delivered, as before.
- A removed friend may still pull its `friend.remove`, and nothing else, so
  a remove reaches a hub that could not be reached at the time.
- A key change is detected when the friend's stable or own address answers
  with another key. A quick tunnel or same network address that does is
  just an address that moved. What waits for a friend is sealed again for
  its new key once the owner confirms it.
- `note` is a plain text message to try all this. Grants hold only
  `receiveShares` (on), which notes and shares need. A sent note keeps
  its whole text in the outbox (`text`), after delivery too, so every
  device of the owner shows it.
- Read marks live on the hub, one per friend: `POST /api/friends/:id/read`
  with `upTo`, the id of the newest note or share card seen (none: all so
  far). A mark is a time on the hub's clock and never moves back. The
  friend's DTO has `unread`, `unreadNotes`, `unreadShares` and `readAt`;
  a note (`InboxItemDto`) and a share card (`ReceivedShareDto`) have
  `read`. A share card counts while it waits for the owner: an offer, or a
  newer revision of one accepted.
- Screens (`packages/web/src/features/friends`): Settings, Friends and a
  page per friend (`/settings/friends/:id`) with the notes both ways. On a
  phone that page draws its own bar like a conversation; its title opens
  the details. The Inbox counts requests, key changes and notes not read
  yet, from the hub's read marks: a friend's page on screen moves the mark
  (the newest note and each share card seen), so every device counts the
  same. A sent note shows its whole text from the outbox.

### Addresses a friend gives

A friend's signed address record, the addresses in an invite link and the
address the owner types for Add by address all name places this hub then
calls: `GET /api/identity` first, then signed requests. The record is the
friend's to write, so without a check a friend could point this hub at its
own machine or at the cloud's metadata service (169.254.169.254).
`peer/address-check.ts` and `addressRefused` in `peer/service.ts` refuse:

- loopback (127/8, ::1, `localhost`), link local (169.254/16, fe80::/10),
  unspecified (0/8, ::), multicast (224/4, ff00::/8) and broadcast (240/4
  with 255.255.255.255), also when written as IPv4-mapped IPv6, and the
  cloud metadata addresses outside link local (100.100.100.200,
  168.63.129.16, fd00:ec2::254);
- this hub itself: any of its own addresses, and its port on any address
  of this machine.

Same network addresses (10/8, 172.16/12, 192.168/16, 100.64/10,
fc00::/7) stay: a friend on the LAN is real, and an invite carries them
when the owner asks (`includeLan`). A name is resolved first and refused
when any of its addresses is; a name that does not resolve on this hub
goes on, since the request fails the same way (or a proxy resolves it).

A refused address is kept nowhere: not in the friend's addresses, not as a
hint from a link, and not in the signed record that holds it (the hub keeps
that record only when it took every address in it). One audit line,
`friend.address.refused`, names what was left out and why. A link left with
no address is refused, and so is a refused address for Add by address
(400, "That is your own hub's address" for this hub). The check runs again
before every request to another hub, so a name that points elsewhere later
is passed over too. Tests run two hubs on one machine, so they take
loopback (`PeerOptions.loopback`); a hub never does.

### Phase 2: send

- "Send to friend" on a chat or session, pick friends, then a review sheet:
  title and note; range (whole, up to a message); what goes (messages, tool
  calls as summaries or full output, attachments, code); the redaction list
  with "show" and "keep anyway" per item.
- Code by default is the session's diff with relative paths. A git bundle
  of the session branch is opt in. Untracked files and credential files
  (`.env`, `*.pem`, `id_rsa`, `*.tfvars` and the like) never go.
- "Update" sends a new revision of the same share; "Unsend" revokes it.
- The friend sees an Inbox card: "Alice sent 'Fix flaky auth test' (session,
  42 messages, diff 12 files)". Nothing downloads before Accept. Unaccepted
  shares expire after 30 days.

### Phase 3: fork, handoff, reference

- **Continue as fork:** a new chat or session on the recipient's hub, with
  their models and keys. The sender's copy is untouched.
- **Handoff:** a fresh session seeded with a generated brief and a file
  list, editable before sending. Default for long or cross provider
  sessions.
- **Use as reference:** read only; the recipient's agents can read it like a
  past chat, as quoted data.
- Imported turns are quoted history marked "from Alice's hub". The first turn
  of a fork runs in ask mode; nothing auto approves until the recipient sends
  a message of their own. Provider reasoning blobs from the sender are
  dropped.
- Code: apply the diff into a new branch `from-alice/<slug>` on a device the
  recipient picks, through an approved step. Never run scripts or hooks from
  a bundle.

### Phases 2 and 3 as built

`packages/server/src/peer/shares.ts` and `share-store.ts`, with core
`session/share.ts` (the review), `session/share-code.ts` (code),
`session/friend-share.ts` and `session/quoted.ts` (the receiving side).
DESIGN.md 27 has the walk through. The API:

| Call | What |
|---|---|
| `POST /api/shares/preview` | the review: counts, the report, each find with its id, the code's files and what stays home |
| `POST /api/shares` | send to friends: the review's choices, `to`, `title`, `note` |
| `GET /api/shares/sent`, `POST .../sent/:id/update`, `DELETE .../sent/:id` | list, a new revision, unsend |
| `GET /api/shares/received`, `POST .../received/:id/accept`, `.../decline` | the Inbox cards, fetch and check, decline |
| `GET .../received/:id/view` | read only, quoted, with the signature check |
| `POST .../received/:id/fork`, `.../reference`; `GET`, `POST .../handoff` | continue, keep, or start fresh from a brief |
| `POST .../received/:id/apply-plan`, `.../apply` | the code onto a new branch, after the owner approves the plan |

CLI: `conclave sessions send <id> --to <friend>` (`--dry-run` for the review,
`--keep`, `--upto`, `--code none|diff|bundle`, `--tool-output`,
`--no-attachments`, `--thinking`) and `conclave friends shares` (ls, sent,
show, accept, decline, view, fork, handoff, reference, apply, update,
unsend). Events: `friend.share` (received, updated, accepted, revoked,
expired) and `friend.share.sent` (sent, updated, accepted, revoked).

Where it differs from the spec above:

- **The payload is always a blob, fetched on Accept.** The offer that goes
  through the outbox is the card only: title, note, kind, counts, and the
  hash and size of the sealed payload. Even a small share is not inline, so
  nothing of it reaches the friend's hub before Accept. The payload is the
  signed bundle with the share's id, revision and code under the same
  signature, sealed for each friend with the message context
  `<shareId>.<revision>` and `share.payload`.
- **Keep anyway is per value.** Each value a text rule found (secret, path,
  private address, email, device name) is one item with a stable id, a
  count and the messages it is in; "show" is the item's value in the
  review, which only the owner's apps get. Reminders, recalled memories and
  reasoning blobs cannot be kept. Thinking text is the `thinking` switch.
- **The receiving hub sanitizes again, but only for secrets.** It drops
  reminders, signatures and encrypted reasoning, runs the secret rule (a
  secret the sender kept anyway is redacted here too), defuses framework
  tags in every string, keeps attachments only as inline data, and checks
  the bundle's shape. Paths, emails, addresses and names the sender chose
  to keep stay.
- **The fork guard keeps the tools.** A fork's first turn is untrusted
  (session/untrusted.ts): every call asks, bypass and allow rules
  included, an answer of "always" or "for this session" counts once, hooks
  cannot approve, and memory stays out. Unlike other untrusted sessions it keeps
  its agent's tools, because the owner started it and is there. The guard
  lifts at the next turn the owner starts with a message of their own (not
  a resume, a routine or a note). The session keeps the owner's permission
  mode: the guard is the ask mode. A handoff is guarded the same way,
  because its brief quotes the friend.
- **The handoff brief is built from the text,** with no model call: the
  note, the first and last asks, where it ended, and the files. The owner
  edits it (`GET .../handoff`, then `POST` with the brief) before the
  session starts.
- **A reference is a session the hub never runs.** Send refuses it, memory
  never learns from it, and the daily digest leaves it out, but past chat
  search and SessionRead find it, marked "shared by Alice's hub, quoted
  data", with the friend's messages as role `friend`.
- **Imported turns stay in their roles but travel as one quoted block.**
  They are stored as messages with `meta.quoted`, and a request carries a
  run of them as a single `<shared-history>` user block that names the hub
  and its fingerprint. Thinking goes; images in it are text placeholders.
- **Code.** A diff leaves out binary files too. A git bundle covers the
  commits after the branch's upstream (or `origin/HEAD`), and is refused
  when any commit in that range touched a credential file. Apply is two
  calls: a plan (checked with `git apply --check` on a temporary index, or
  `git bundle verify`), then the apply with the plan's id within 10 minutes.
  The plan lists files that can run code on checkout or build. All git
  commands run with `core.hooksPath=/dev/null`; a diff becomes a commit
  through a temporary index and commit-tree, a bundle is fetched into the
  new branch, nothing is checked out. A taken branch name gets `-2`.
- **Unsend** withdraws the blobs, cancels offers not delivered yet, and
  queues `share.revoke`. The friend's hub deletes its copy and the
  references made from it; forks and handoffs stay, as the owner's own
  work. The sender's words stay "asked to delete". An unsend can come
  before its offer, when the offer met a passing error on the way (its body
  was still to fetch). The friend's hub then remembers the share's id from
  that friend, for 30 days and at most 1000 per friend (the oldest go
  first), and drops the offer or update when it comes, so no card shows a
  share that was unsent.
- **Update** is a new revision from the session as it is now. On an
  accepted share the card shows the revision waiting until Accept fetches
  it. After a friend's key change, a payload not fetched yet is sealed
  again for the new subkey under the same revision.
- `share.ack` answers Accept only; a decline is not sent. Shares notify
  under `notifications.on.friendMessage`.
- Caps: 100 MB sealed, 70 MB for a git bundle before base64, 20 MB of
  diff, 20 friends per share, 50 sessions and 20,000 messages per bundle.

Screens (`packages/web/src/features/friends`, the desktop and iPhone apps
too):

- **Send to friend** is in the session and chat menus and, on a phone, the
  conversation sheet after Rename: pick friends, then the review from
  `POST /api/shares/preview`, asked again on every change (title and note,
  the range up to a turn, tool output, attachments, thinking, code with its
  files and what stays home, and each value found with its count, Show and
  Keep anyway), then the sent state. The dialog loads when it first opens.
- **The Inbox card** says "Alice sent 'Fix flaky auth test'" and what it
  holds, with Accept and Decline in place; it counts in the Inbox, the
  side panel and the top bar until it is seen (`ReceivedShareDto.read`).
- **A friend's page** has the shares both ways in the thread with the
  notes: one from them with Accept and Decline, then Open; one you sent
  with how they have it, Update (the same review, a new revision) and
  Unsend ("asked to delete").
- **`/shares/:id`** is one share: waiting, fetching, declined, unsent and
  expired say so; accepted, the conversation read only and marked as
  quoted from the friend's hub with the signature check, the code's diff,
  and Continue as fork (one line: its first turn asks before any tool
  runs), Handoff (the brief to edit first), Use as reference and Apply
  code (a device and folder, the hub's plan, then an approval; the branch
  is `from-<friend>/<title>`). **`/shares`** lists both ways; Settings,
  Friends links to it.
- A session made from a share says under its title whose turns are quoted
  and, while the guard holds, that its first turn asks.
- The knot rope plays `receive` on a share card that arrives while you
  watch, `send` in the sent state, and `success` by a friend just added
  (docs/design/KNOT-MOTION.md 5).

### Add a friend by address

The owner asked for it in so many words: "I just add their email and hub
address and the invite goes to their hub." Settings, Friends has Add by
address (their hub's address, their email if you like, a name for them);
`conclave friends add <hub-address> [--email E] [--name N]` is the same.

- **The asking side.** The hub reads the key the hub at that address proves
  (`GET /api/identity`, as for an invite), then posts a signed
  `friend.request` with no invite in it and `via: "address"`. Its body is
  this hub's name, its key and its address record, nothing more. There is
  no fingerprint to check the key against, so it is trust on first use: the
  result shows the safety code, and both owners compare it. The email stays
  on the asking hub as a label and a contact (`FriendDto.email`), and never
  travels.
- **When it does not go** (no hub answers, their hub takes invites only,
  a limit), the request is undone and the answer says why. With an email,
  the hub makes an ordinary invite and returns it in a `mailto:` link
  (`POST /api/friends/mail-invite` makes one on its own). Their side uses
  it like any invite; if both had asked, the two requests cross and both
  are friends.
- **The receiving side.** A request by address waits in the Inbox like any
  request, with "They added your hub by its address" in its notice. Accept
  is the same as for an invite.

**Why this is safe enough.** An invite secret proves the requester was
given something by the owner. A request by address proves only that some
hub knows the address, and a key costs nothing to make, so the request
must not be able to do anything but wait to be seen. It holds a name, a key
and an address record; the receiving hub keeps the name only (the Inbox
row) and the key and record on the pending friend, and nothing comes or is
sent until the owner accepts. What a stranger can still do is make noise,
so the limits are on noise:

| Limit | Value | Why |
|---|---|---|
| The owner's switch | on by default (`PUT /api/friends/settings`, `conclave friends by-address off`) | the owner asked for adding by address to just work; off means invites only |
| Waiting requests by address | 5, apart from the 3 for invites | strangers cannot crowd out a friend who has an invite |
| Per network address | 3 an hour | one source cannot fill the 5 again and again |
| For the hub | 20 a day | many sources together cannot either |
| Size | 16 KB for the request (64 KB for any friend request) | it holds a name, a key and an address record |
| Block list | `POST /api/friends/:id/block`, `DELETE /api/friends/blocked/:fp` | a hub that keeps asking is turned away for good |
| Declined | the same key may ask again after 30 days | a decline is not a block, but it is not an invitation to ask again tomorrow |

The per address limit counts before the keys are checked, since signing
costs a stranger nothing. A blocked key, a key declined lately and a hub
with the switch off all get the same words ("This hub takes friend requests
by invite only"), so a stranger cannot tell a block from "off". A request
from a hub this one asked itself (both added each other) is not held back
by a block, a recent decline or the waiting cap, and makes both friends at
once. Local requests (the hub's own network) skip the rate limits, as
pairing does.

### Shared projects as built

`packages/server/src/peer/projects.ts` (with `project-store.ts` and
`project-routes.ts`), core `client/shared-projects.ts` (the contract) and
`session/shared-project.ts` (the fence and the SharedProject tool), the CLI's
`commands/projects.ts`, and the web's `features/friends/SharedProject*.tsx`.

**What a shared project holds.** A name, a description, an optional GitHub
repository (owner/name), and items: notes, memories and chats. Each item
has one author and only its author edits or deletes it. Memories go only as
the owner picks them, one by one (`GET .../memory-candidates` lists the
project's memories on this hub). A chat or session goes as a phase 2 share
(review rules, signed bundle, fetched on Accept) without code, and the item
carries the share's id; each member's hub links the item to the share card
it got. "Share new sessions in this project" (off by default) sends each new
session of the linked project or repository once its first turn ends. A
project can be linked to a project of this hub (folders across devices,
`localProjectId`), which is how sessions find it.

**Topology.** The hub that made the project (the owner) is the hub of a
star. Every member is the owner's friend; members need not be each other's.
A member's item goes to the owner's hub, which passes it on to the other
members. Members see each other in the member list the owner sends, with
the key each one signs with.

| Message | From, to | What |
|---|---|---|
| `project.invite` | owner, a friend | the card: name, repo, owner, members and their keys, counts. Nothing else before Accept |
| `project.join` | member, owner | accepted (with the member's GitHub login when its hub has one). The owner answers with `project.state` |
| `project.leave` | member, owner | declined, or left |
| `project.meta` | owner, members | name, description, repo, members with role and state, ended. Numbered by `seq`; an older one changes nothing |
| `project.item` | member to owner, owner to members | one version of one item, signed by its author |
| `project.state` | owner, a member | the meta and every item (deleted ones too), on join and on sync |
| `project.sync` | member, owner | send me `project.state` again (answered at most once a minute per member; a newer state replaces one still waiting) |

All of them are ordinary peer envelopes: signed by the sending hub, sealed
for the receiving one, through the outbox (7 days, backoff, the pull path),
idempotent by message id, and blobs when large. So a project works while a
hub is offline and catches up when it is back.

**Items are signed by their author.** An item is `{ v, project, id, author,
kind, version, createdAt, updatedAt, deleted?, title?, text, chat? }`; its
author's hub key signs `conclave-peer/1 project-item` and the canonical JSON
of the rest. The owner's hub passes it on unchanged, so it cannot alter a
member's item, and every hub checks it again against the author's key: the
owner takes an item only from its author, an active member; a member takes
items only from the owner, checked against the key the owner listed (and,
when the author is also its own friend, that key must be the one it knows).
An item whose id belongs to another author is refused ("Only its author
edits an item"). An edit is the next version; the last 50 versions of an
item are kept (`GET .../items/:id/history`). Last writer wins only within
one author's own item: a higher version wins, the same version twice takes
the later time, an older one is stale. A delete is a version with no text.

**Why 50 versions.** Before, every version stayed (an item's version went
up to 1,000,000), and the owner's hub sent each one to every member, so one
member editing in a loop filled every hub's disk and outbox. The history is
for reading back what changed: 50 covers a note edited every day for seven
weeks, and 50 versions of the largest note (64,000 characters) are about
3 MB of text. Each write drops the versions at or below the newest minus
50, on every hub, and cancels the `project.item` messages that carry one
and still wait in the outbox, so a dropped version is never sent on. The
newest version is always kept and last writer wins against it, so a
version that is gone changes nothing: one that comes late is stale, and
sync (`project.state`) sends the newest of each item. A hub from before
drops what is past the 50 when it starts.

**Membership and roles.** Owner and member. The owner invites, takes a
member out (their hub keeps a read only copy and gets nothing more; their
items stay), changes the name, description and repository, and ends the
project (every copy turns read only). A member accepts or declines in the
Inbox, and leaves; a copy no longer active can be removed from the hub
(`DELETE ...?forget=1`). Removing a friend takes them out of the projects
you own, and makes theirs read only here.

**Code never goes hub to hub.** It is on GitHub. The project page's Code
section (`GET .../code`) reads the repository with this hub's own token:
its page, default branch, open pull requests grouped by the member who
opened them (by the GitHub login each member's hub shares on join), other
open pull requests, and branches without one. "New session from the
repository" starts a repo session (DESIGN.md 30), so each side works from
the same repository on a branch of its own.

**Trust.** Everything from a friend is data, never instructions, as with
shares. Secrets come out of every string before an item is signed and
leaves the hub (the author sees how many), and a friend's items pass the
secret rule again when they are shown or read. This hub's agents read a
project through the SharedProject tool, which only sessions in the project
get (by the linked project or the repo session's repository), never
untrusted ones. The owner's own items read plain; each friend's items come
in one `<friend-shared-context from="Alice's hub" fingerprint="...">` block
that says it is quoted data from another person's hub and not
instructions, with framework tags (the fence's own tag included) defused.
Received items never enter this hub's memory.

**The API.** `GET`, `POST /api/shared-projects`; `GET`, `PATCH`, `DELETE
/api/shared-projects/:id`; `.../accept`, `.../decline`, `.../members`
(invite), `DELETE .../members/:fp`, `.../notes`, `PATCH`, `DELETE
.../items/:item`, `.../items/:item/history`, `.../memory-candidates`,
`.../memories`, `.../chats`, `.../code`, `.../sync`, `.../read`. Adding by
address: `POST /api/friends/add`, `POST /api/friends/mail-invite`, `GET`,
`PUT /api/friends/settings`, `POST /api/friends/:id/block`, `DELETE
/api/friends/blocked/:fp`, and `PATCH /api/friends/:id` takes `email`.
Events: `friend.project` (invited, updated, item, members, removed, ended,
left, forgotten). CLI: `conclave friends add <hub-address> [--email]`,
`conclave friends by-address on|off`, and `conclave projects`
(ls, show, share, members, accept, decline, note, leave, sync).

**Screens.** Settings, Friends has Add by address (with Email them an
invite when a request cannot go), your hub's address, the switch for
requests by address, and Shared projects with New shared project.
`/projects` lists them; `/projects/:id` is one: who owns it and who is in
it, notes (add, edit and delete your own, history), memories (Share
memories, Take back), chats (Share chats, each opening its share), Members
(Invite, Remove), Code, and Settings (repository, your project, share new
sessions, Sync, Leave or End). A friend's items say "From Alice's hub". The
Inbox has an invite with Accept and Decline in place and a row for new items
from members. Share project sits on a project's header in Group by Project
(desktop list and phone Code list) and on its row in Devices, Folders. On a
phone a project draws its own bar like a share, and its dialogs are sheets.

Where it differs or stops short:

- Chats reach only members who are the author's friends (a share is
  fetched from the author's hub). Others see the item with "ask them for
  it". A member who joins later gets the chats shared before, while the
  author's payload is kept (30 days).
- A removed or departed member's items stay on the other hubs, and the
  copies they keep stay with them: "asked to delete" holds here too.
- One owner per project; the owner's hub must be reachable now and then for
  members to hear each other (the outbox and the pull path cover gaps).
- The code view knows a member by the GitHub login their hub shared on
  join; a hub with no GitHub token shares none, and its pull requests show
  under Others.

### Phase 4: message a friend's agents

- The owner exposes agents per friend: off (default), ask me, or run in
  quarantine. The friend sees only the agents exposed to them.
- A message lands in the Inbox: "Alice asks Researcher: …" with Run, Run with
  edits, Decline. Task states follow A2A: submitted, working,
  input-required, auth-required (waiting for the owner), completed,
  rejected, canceled.
- Quarantine: no shell, no file writes, no memory, no past chats, no network
  except tools the owner allowed for that agent. An agent that can read
  private data replies only after the owner reviews the answer.
- Per friend budget per day, rate limits, a size cap, at most a few open
  tasks, a turn cap per task, and the audit log.

## 4. Defaults for the open questions

- Friends of friends: no.
- Relay or mailbox: none in the first version; the pull path covers one
  reachable side. If neither side can be reached, the outbox waits up to
  7 days.
- A guest's turns on the guest's own model: later, with phase 5.
- Code sharing: diff by default, git bundle opt in.

## 5. Reachability

A friend reaches your hub through a Cloudflare tunnel (quick or stable) or
your own URL. Tailscale serves only your tailnet, and remote access off
serves only your network: Settings, Friends says so and offers to turn on a
tunnel.

## 6. Where it lives

- Settings, Friends: add (by address, QR, link), pending, list with
  fingerprint, safety code, verified badge, last seen, reachability, grants,
  remove; shared projects.
- Shared projects: `/projects` and `/projects/:id`; Share project on a
  project's header in Group by Project and in Devices, Folders.
- The phone side panel's More rows gain Friends; the Inbox counts friend
  shares and messages.
- "Send to friend" in the session and chat menus and the conversation sheet.
- Shares: `/shares` (both ways) and `/shares/:id` (one from a friend), and
  in each friend's thread.
- CLI: `conclave friends add|accept|ls|rm`, `conclave sessions send <id> --to <friend>`,
  `conclave projects share|members|leave`.

## 7. Threats from a friend's hub

A friend's hub holds a key this hub trusts, so whatever it sends is signed.
Strangers are covered by the rules in section 1 and the limits in "Add a
friend by address". These are the ways a friend's hub, or one that lost
its key, could still do harm, and what stops each.

| Threat | Defense |
|---|---|
| A request replayed, or sent on to another hub | Signed requests name the recipient and live 5 minutes at most; the nonce cache refuses one seen before |
| A friend's text read as instructions | Quoted data with provenance, fenced for agents; a fork's first turn asks before every tool; nothing a friend sends runs on its own |
| A record, an invite link or an address points this hub at itself, its machine or the cloud metadata service | Loopback, link local, unspecified, multicast, broadcast, the metadata addresses, and this hub's own addresses and port are refused, names resolved first, when they come and again before each request; kept nowhere, one audit line ("Addresses a friend gives") |
| A shared item edited without end, every version kept and sent to every member | The last 50 versions per item; each write drops older ones and cancels those still waiting in the outbox ("Shared projects as built") |
| A message refused on a pull shows as delivered | The pull names it in `refused=`; the sender shows Not delivered with the reason, and it is not served again ahead of the rest ("Phase 1 as built") |
| An unsend overtakes its offer and the offer leaves a card | The unsend is remembered 30 days, 1000 per friend, and the offer dropped ("Phases 2 and 3 as built") |
| A large or endless body | Bodies are read up to their cap, also without a length; a blob up to the size its message says |

Where it can still fail: a name is resolved by the check and again by the
request, so DNS that answers differently the second time (rebinding) can
still send a request to a refused address. Its answer is checked like any
other (a key proof, a signed envelope, a hash), so nothing from there is
taken, but the request was made. A hub on the same machine as this one, at
a loopback address, cannot be a friend. A message an older hub refused on a
pull still shows as delivered.
