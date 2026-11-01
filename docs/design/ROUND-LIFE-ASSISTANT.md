# Round: the life assistant

Plan and API for turning the default `assistant` agent into a personal assistant that helps the owner run each day: goals, a day plan, an evening review, a weekly goal check, a heartbeat and a nightly reflection. It is modelled on Meta's Muse agent (goals, proactive preferences, heartbeat, dreaming, question discipline) and built on Conclave's own memory instead of Muse's files. Written before the code; the code follows it.

## 1. What the owner asked for

"Personal assistant setup based on muse is good, maybe we can even improve it for our profile and like make it use the memory the tool is using." One owner: a uni student with a homelab (hub madx, Proxmox host pve, arch-desktop, a MacBook), daily Claude Code, Codex and Basic Memory, who wants short direct answers with one method.

What we take from Muse: goals with one level of subgoals, active or done (no pause) and dated progress entries; a goal intake that asks one question at a time, creates one goal, then offers support; per-area guides read on demand; proactive preferences (tell me about, never tell me about, when, how); a heartbeat checklist on a 30 minute poll; honest scheduling words ("I check every 30 minutes", run history is the truth); nightly dreaming that learns how to work with this owner. What we leave: Meta's values text, its Meta-only tools, and its line that household requests override safety.

## 2. Storage

### Goals: a small table, recalled through memory

Goals live in two tables that the goals module creates with `CREATE TABLE IF NOT EXISTS` (no shared migration index to collide with):

```sql
goals(id, parent_id, title, area, description, next_step, target_date, status, task_ids, source_session_id, created_at, updated_at, completed_at)
goal_entries(id, goal_id, date, text, source, session_id, created_at)
```

Each top-level goal is projected into the `memories` table as one global fact (subgoals, next step, target date, latest progress and open linked tasks folded into its text), through `SqliteMemory.upsertImported('@goals', ...)`. That is the same path notes imported from a connection take, so:

- every agent recalls goals with the recall it already does per turn (BM25, embeddings when set), with no extra query and no extra prompt text;
- they show on the Memory page, marked "From Goals", and in memory search, the palette and the hub MCP `memory_search`;
- the extractor shows them as context but never rewrites them, a user's `MemorySave` never dedupes into them, and they are never mirrored as loose fact notes;
- `@goals` is not a valid connection id, so no connection can claim or delete them.

Why not a new memory kind: `MemoryKind` is matched in the Memory page filters, export, extraction prompts, the hub MCP, the server's validation and the Android app, and a kind still has nowhere to keep subgoals, dates, task links or a history. Why not metadata on memory rows: the table has no meta column, and progress entries as more rows would flood recall. A table gives real queries (area, status, target dates, entries in a range) and the projection keeps recall cheap: one row per goal, clipped to 800 characters.

**Basic Memory.** When a connection writes (mirror or external mode), each top-level goal is written as one note, `conclave/goals/<title>.md`, with area, status, target date, next step, why, subgoals as sections and the progress log, plus `- [goal]` and `- [progress]` observations and `- part_of [[Goals]]`. Writes are queued per goal and debounced (one write per burst of changes). A rename rewrites the old note as a one line pointer to the new one. Local goals stay the source of truth in both modes.

### Proactive preferences: kv plus one profile memory

`kv['assistant.prefs']` holds `{ tell[], never[], hours: { start, end }, how, timezone? }`. It is rendered into one profile memory, scope agent `assistant`, tag `proactive-preferences`, so the assistant always sees it in its system prompt and other agents do not pay for it. When the owner edits that memory on the Memory page, the hub parses it back on the next read.

`hours` is when messages may arrive, default 09:00 to 21:30 local; the rest is quiet hours. The timezone is `prefs.timezone`, else an IANA zone found in a global profile memory ("Timezone: Europe/Berlin"), else the hub's own.

### Heartbeat checklist: a memory note

One procedure memory, scope agent `assistant`, tag `heartbeat-checklist`. The owner edits it in Settings > Assistant or on the Memory page; the assistant edits it with MemorySave and MemoryForget. The newest one with the tag wins.

### Day plans

`kv['assistant.plan.<YYYY-MM-DD>']`: `{ date, summary, items[], focus?, question?, sessionId, savedAt }`, the last 14 days kept.

## 3. Hub API

All under the bearer token, typed in `packages/core/src/client/assistant.ts`.

| Call | What it does |
| --- | --- |
| `GET /api/goals?status=active\|done\|all&area=` | Top-level goals with their subgoals, last entry, entry count and open linked tasks. |
| `GET /api/goals/:id` | One goal: parent, subgoals, entries (newest first, subgoals included), linked tasks. |
| `POST /api/goals` | `{ title, area, description?, nextStep?, targetDate?, parentId?, taskIds? }`. A subgoal takes its parent's area; nesting stops at one level. |
| `PATCH /api/goals/:id` | Any field; `status: 'done' \| 'active'` completes and reopens; `targetDate: null` clears. |
| `DELETE /api/goals/:id` | Removes the goal, its subgoals and their entries. |
| `POST /api/goals/:id/entries` | `{ text, date? }`: a dated progress entry. |
| `DELETE /api/goals/:id/entries/:entryId` | Removes one entry. |
| `GET /api/assistant` | Preferences, the timezone and where it came from, quiet hours now, held notices, heartbeat and reflection state (routine, enabled, model, next run, runs today, last run, checklist). |
| `PATCH /api/assistant/prefs` | Partial preferences. Also moves the heartbeat schedule to the new hours. |
| `PUT /api/assistant/heartbeat` | `{ enabled?, checklist? }`. Turning it on makes the routine from its template the first time. |
| `PUT /api/assistant/reflection` | `{ enabled?, time?, model? }`, same. A time or model set while it is off makes the routine paused. |
| `GET /api/assistant/reflect` | Settings > Reflect: the same switch, the time and timezone, the model, the next run, the last run with the notes it saved and retired, and the notes tagged `reflection`. |
| `PUT /api/assistant/reflect` | `{ enabled?, time?, model? }` through the same code as above; answers with the Reflect page. |
| `POST /api/assistant/reflect/run` | Reflect now, the hub's owner only: one run with the night's rules, answered once it started; `{ skipped }` and no model call when there are no chats to read. |
| `GET /api/assistant/today` | Today's saved plan, the latest day plan run, top goal next steps, tasks due today and overdue. |
| `POST /api/assistant/today/answer` | `{ option }`: answers the plan's question in the plan's session. |
| `POST /api/routines/:id/upgrade` | Replaces an edited routine's prompt with its template's current one. |

## 4. Tools

Native tools in `packages/core/src/tools/goals.ts`, `day-plan.ts` and `proactive-prefs.ts`. Read calls are read-only (no approval); writes are not read-only, so in default mode they ask like `MemorySave`, and routines list them in `allow`. All of them join `UNTRUSTED_DENY`, so the email and web agents never get them.

| Tool | Input | Notes |
| --- | --- | --- |
| `GoalList` | `status?`, `area?`, `guide?` | `guide: true` with an area adds that area's guide (before intake). |
| `GoalGet` | `id`, `guide?` | History, subgoals, linked tasks; the guide when helping with it. |
| `GoalCreate` | `title`, `area`, `description?`, `nextStep?`, `targetDate?`, `parentId?`, `taskIds?` | Refuses a second active goal with the same title in the area. |
| `GoalUpdate` | `id` plus fields, `status`, `linkTasks?`, `unlinkTasks?`, `addTask?: { title, due? }` | `addTask` makes a board task and links it. |
| `GoalLog` | `id`, `text`, `date?` | One dated entry. |
| `DayPlan` | `date?`, `days?` (1 to 14), `guide?`, `save?: { summary, items, focus?, question? }` | Reads the owner's day or week: local time, message hours, tasks, goals, sessions with summaries, routine runs ("did it run"), the saved plan, and with a calendar connected the events, the proposals waiting and the mail accounts (section 10). `guide` adds a flow guide. `save` stores today's plan (not read-only then). |
| `ProactivePrefs` | `tell?`, `never?`, `hours?` ("09:00-21:30"), `how?` | No fields reads them. |

Life-area guides are prompt files in `packages/core/src/agents-defaults/guides/<area>.md` (study, career, health, money, homelab, relationships, interests, other), each under 40 lines, served by `GoalList`/`GoalGet` with `guide: true`.

## 5. Routines

**Templates are versioned by prompt.** Today a template is copied into a routine and nothing links them. Each template now carries `template: <id>` (a new optional routine field kept in the extra column) and the hashes of every prompt it shipped before. On hub start, a routine whose template id matches (or, for older routines, whose name matches) and whose prompt hash is one of those shipped prompts gets the new prompt, allow list and precheck. Its schedule, timezone, model, notify, device and enabled state stay as the owner set them. An edited prompt is left alone, logged, and can be upgraded on request.

- `morning-brief` (07:30 weekdays, same id and schedule): a day plan. DayPlan for tasks and goals, the calendar when one is connected, deadlines from memory, one focus block, at most one question with two or three options, saved with `DayPlan save` so Home shows it and the options are tappable.
- `evening-wrap-up` (21:05): a review that logs one goal progress entry per goal that moved today, from the day's sessions and finished tasks.
- `weekly-review` (Sunday 18:05): per goal, on track, stuck or deadline passed (asks to extend or close; never changes the goal itself).
- `heartbeat` (new, off): `*/30 9-21 * * *` in the owner's zone, model `fast` (the small model), notify `on_attention`, precheck `@heartbeat`.
- `nightly-reflection` (new, off): `40 2 * * *`, default model, notify `on_error`, precheck `@reflection`, allow `MemorySave` and `MemoryForget`, deny web, shell and file writes.

**Built-in prechecks.** A precheck starting with `@` runs in the hub, not on a device. It returns a digest (stored on the run and compared like a shell precheck's output), an optional skip reason, and a context block the run gets after its prompt, marked as data.

- `@heartbeat`: skips outside message hours or with an empty checklist. Digest: the local date, a hash of the checklist, open tasks overdue or due within 2 hours, active goals at or past their target date. Unchanged digest: skipped, no model call. So it thinks at most once a day plus once per change. Context: local time, the checklist, the due items with titles, and the last heartbeat's reply.
- `@reflection`: the chats and assistant sessions with new owner messages since the last reflection (routine runs and subagents left out). None: skipped. Context: owner and assistant text only (no tool results, so no email or web page can speak), and the current reflection notes with ids so it can retire them.

**Quiet hours.** The notifier is wrapped: a notice from a routine session (a routine's result, or its Notify call) that is not an approval, a question or a failure, sent outside message hours, becomes a durable job at the end of quiet hours instead. Settings shows how many wait. Hold-while-active still applies when they go out.

## 6. Web

- **Goals** (`/goals`, nav after Tasks, `G O`, palette): Active and Done, grouped by life area as sections with rows (title, next step, target date words, progress count). A row opens the goal with Card to panel: subgoals, the progress timeline (newest first), Add progress, Complete or Reopen, Edit, Link tasks (a picker over the task board), Add a task, Delete with a confirm that names what goes. Completing a goal lets it leave the Active list through GapList; counts Roll. A goal being worked on in a live session shows the still Knot.
- **Home, Today** (a section, not a box, first in the status area): the plan's sentence, its timed items, the focus block, the plan question with its options as outline buttons, and up to three goal next steps. While the morning plan runs: the Knot with "Planning your day". No plan: one line with "Plan my day", which starts a chat.
- **Settings > Assistant**: Tell me about, Never tell me about (one per line), Message hours (two times; quiet outside), How (One line, Short list, Full page), the timezone and where it came from, Heartbeat (On / Off, its checklist, model, last run and runs today), Nightly reflection (On / Off, last run).
- Mock routes in `packages/web/src/mock/assistant.ts`, registered through `ctx` like `mock/punch.ts`.

## 7. Prompt

`assistant.md` keeps every rule it has (one method, look before asking, confirm before anything irreversible, TodoWrite for multi-part asks, memory hygiene) and adds: know the owner first, goal intake, commitments, honest scheduling words, proactive preferences, discretion with other people's information, and when to use the goal and plan tools. Under about 60 lines.

## 8. Tests

Goals CRUD, subgoal nesting, entries; recall of a goal through `memory.recall`; Basic Memory mirroring with a fake connection (one note per goal, progress log, rename pointer); quiet hours holding a routine notice and letting failures through; heartbeat precheck skipping the model (scripted fake model, request count unchanged); template upgrade of an unedited routine and not of an edited one; untrusted agents lose the tools; tool runs through the engine harness.

## 9. Where it can fail

- The heartbeat's precheck sees the hub only (tasks, goals, the checklist). A checklist line that needs the calendar or mail is checked when the heartbeat runs for another reason, and at least once a day. The docs say so.
- A morning plan at 07:30 lands on Home at once, but its notification waits for the end of quiet hours (09:00 by default).
- The goal memory row is a projection: editing it on the Memory page is overwritten by the next change to the goal. The page says to edit it on Goals.
- Goals are not in hub backups yet (backup.ts belongs to another area); the Basic Memory notes and the memory projection are the copies until then.

## 10. Calendar and mail (the follow-up round)

Built after this round; the design is in `docs/DESIGN.md`, section 32, and the setup in `docs/INSTALL.md`, section 11. What changed for the assistant:

- **Real calendars and mail in the hub.** CalDAV accounts (Nextcloud, iCloud, Fastmail, any server) with an app password; Sign in with Google (Gmail, Google Calendar) and Sign in with Microsoft (Outlook mail); IMAP for the rest. Settings, Calendar and mail picks which calendars the assistant may read and where it may propose events.
- **Tools.** `CalendarList` (events in a range with repeats expanded in the owner's zone, project totals for time booking), `CalendarFreeBusy` (free slots over every readable calendar and the attendees an account can see, three meeting suggestions), `CalendarEvent` (create, update, delete as a proposal), `MailDraft` (a message as a proposal). All four join `UNTRUSTED_DENY`. `MailSearch` and `MailRead` run only in the new untrusted `email` agent, which the assistant asks with Task.
- **Proposals, not writes.** Every calendar change and message waits for the owner's approval on a card: Home's Today on the web, `/today` on phones, the Today screen on Android. This works in routines too, where an ordinary approval would be refused. The session hears the outcome before its next turn.
- **DayPlan** includes the day's events (with ids), the proposals still waiting and the connected mail accounts. `guide` returns a flow guide: `plan-week` (work and study blocks around fixed events, workouts from the health goal in free slots), `meal-plan` (meals, recipes and one grocery list from saved food preferences), `meeting` (three times that fit everyone, the invite, book after approval) and `time-booking` (log or plan hours against a project). The guides are prompt files in `agents-defaults/guides/flows/`, like the life-area guides. The health guide points at `plan-week`.
- **Morning brief.** Reads the calendar through DayPlan, asks the email agent about unread mail from people, and proposes its focus block. The old prompt's hash is in `PREVIOUS_PROMPTS`, so installed copies upgrade; its allow list gains `MailSearch` and `MailRead` for the email agent, which reads in an untrusted session.
- **Home.** Today lists today's events and the proposal cards. On a phone, Home stays a new chat (MOBILE-V2) with at most two more quiet lines: proposals to approve, and the next event.

Section 9's first point still holds: the heartbeat's precheck sees the hub only, so a checklist line about the calendar is checked when the heartbeat runs for another reason.
