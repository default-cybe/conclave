# The assistant

The default `assistant` agent is a personal assistant for your day, your goals and your setup, modelled on Meta's Muse and built on Conclave's own memory. It knows you from memory before it acts, keeps goals with a progress history, plans your day, reviews it in the evening, checks your goals each week, and can poll a checklist during the day and learn how you like to work at night. It can also search a site with the hub's browser and watch it for you, saying only what changed (Watches, below). Each part can be turned off on its own. The plan and API are in `docs/design/ROUND-LIFE-ASSISTANT.md`.

## Goals

Tell the assistant what you want to reach ("I want to finish my thesis draft by December"). It reads the goals you already have in that life area and the guide for the area, asks one question at a time until it knows what done looks like and when, creates one goal in your words, then offers a first step and the work it can do now. Or add one on the Goals page (`G O`, or New goal in the palette).

- **Life areas**: study, career, health, money, homelab and projects, relationships, interests, something else. Each has a short guide the assistant reads on demand (`packages/core/src/agents-defaults/guides/`).
- **Subgoals**: one level only. A subgoal takes its goal's area.
- **Active or done**, no pause. A break is a progress entry; a finished goal is completed and can be reopened.
- **Progress entries** are dated notes that build the history. The assistant logs what you report and commitments you make; the evening wrap-up logs what moved each day; you add them on the goal.
- **Linked tasks**: link tasks from the task board, or add a task from the goal.

**Where goals live.** Two tables in the hub's database (`goals`, `goal_entries`). Each top-level goal is also one memory (global fact, tagged `goal`, from `@goals`), so every agent recalls it like any other memory and it shows on the Memory page as "From Goals". That memory follows the goal; edit the goal, not the memory. When a memory connection writes (Basic Memory in mirror or external mode), each goal is also a note at `conclave/goals/<title>.md` with its subgoals and the whole progress log. A rename leaves a pointer in the old note, and a deleted goal's note stays, marked deleted. Two goals with the same title (last year's "Read 12 books" and this year's) get their own notes: the later one has a short id after its title. A sync never imports these notes back as more memories.

## Proactive preferences

Settings > Assistant, or tell the assistant ("stop telling me about sports", "only one line"):

- **Tell me about** and **Never tell me about**: one line each.
- **Message hours**: when messages may arrive, 09:00 to 21:30 by default. Outside them are your quiet hours: a routine's message waits as a job and goes out when the hours start. Approvals, questions and failures always go out. Hold notifications while you use Conclave still applies on top.
- **How**: one line, a short list, or a full page.
- **Timezone**: set here, else an IANA zone named in your profile memory ("Timezone: Europe/Berlin"), else the hub's.

They are stored in the hub (`kv assistant.prefs`) and as one profile memory for the assistant agent, so it sees them on every turn and other agents do not pay for them. An edit to that memory on the Memory page is read back.

## The daily loop

These are routine templates. Add them from Routines or setup; routines you added before this release get the new prompt on hub start, keeping your schedule, model and switches, unless you edited the prompt (then `POST /api/routines/:id/upgrade` applies it).

- **Morning brief** (weekdays 07:30): a day plan from tasks due, goal next steps, a connected calendar and memory: items in time order, one focus block, at most one question with two or three options. The plan shows on Home under Today; tapping an option sends the answer to the plan's session. The notification waits for your message hours.
- **Evening wrap-up** (21:05): what got done, one progress entry per goal that moved, what is still open, the first step for tomorrow.
- **Weekly review** (Sundays 18:05): each goal as on track, stuck or deadline passed (it asks whether to extend or close; it never changes a goal itself), stale tasks, three priorities.

## Calendar and mail

Connect calendars and mail in Settings, Calendar and mail (`docs/INSTALL.md`, section 11): CalDAV for Nextcloud, iCloud and Fastmail, Sign in with Google for Gmail and Google Calendar, Sign in with Microsoft for Outlook, IMAP for the rest. The assistant reads the calendars you mark Read and proposes events only in the ones marked Write. Every new event, change and message is a proposal: a card on Home (Today), on `/today` on a phone and on the Android Today screen, with Approve and Decline. Nothing is written before you approve it, in any permission mode and in routines. Mail is read only by the email agent, because strangers write it; the assistant gets its report and drafts replies with MailDraft.

Ask for:

- **Plan my week** (or my workouts): work and study blocks around your fixed events, and workouts from your health goal in free slots.
- **A meal plan**: meals for the week from the food preferences in memory, with recipes and one grocery list.
- **A meeting** with someone: three times that fit everyone's free/busy, the invite drafted, booked after you approve.
- **Time booking**: log hours on a project ("2 hours on Thesis this morning"), plan hours ahead, or ask how many went where.

## Heartbeat

Off until you turn it on in Settings > Assistant. It is a poll, not a watch: every 30 minutes inside your message hours. Before each tick the hub builds a digest of your local date, the checklist, open tasks overdue or due within 2 hours and active goals at or past their target date. If it matches the last tick that ran, the tick is skipped and no model is called. So the model runs at most once a day plus once per change, on the small model (`fast`). It replies `STATUS: ok` and stays silent, or `STATUS: attention` and a message that passes your preferences.

The checklist is a memory note for the assistant (tag `heartbeat-checklist`); edit it in Settings or ask the assistant. With an empty checklist every tick is skipped without a model call. The hub only sees tasks, goals and the checklist: a line that needs your calendar or mail is checked when the heartbeat runs for another reason, and every morning by the day plan. "Did it run" is answered from the run history (DayPlan shows it), never from the schedule.

## Nightly reflection

Off until you turn it on. At 02:40 the hub gathers the chats and assistant sessions you wrote in since the last reflection (only your words and the assistant's text: no tool results, so no email or web page can speak). The assistant saves at most 3 notes on how to work with you (agent-scoped procedures tagged `reflection`) and retires the ones they replace. Days without chats are skipped without a model call.

**Settings > Reflect** has it on one page, like Claude's Reflect settings (on a phone, Settings, Reflect):

- **Reflect each night**: the on and off switch. It is the same setting as the switch in Settings > Assistant (one routine, `nightly-reflection`), so turning one changes the other.
- **Time**: once a night, 02:40 by default, in your timezone.
- **Model**: the default model (about $0.07 a night), the small model (`fast`, about $0.005), or another one for this routine only.
- **Reflect now**: one reflection right away, with the night's rules: the same digest of your words and the assistant's text, untrusted chats left out, only `MemorySave` and `MemoryForget`. With nothing new to read it says so and calls no model. Only the hub's owner can press it. It runs even with the switch off and leaves the switch as it is.
- **Last run**: "Last ran 02:40, saved 2 notes, retired 1", counted from the run's `MemorySave` and `MemoryForget` calls that went through, with a link to the run.
- **Notes on how to work with you**: the notes it keeps, newest first, each with Edit and Delete. The next reflection reads them before it saves anything. They also show on the Memory page.

The Android app's Settings, Reflect has the switch, Reflect now and the notes with Delete; the time and the model are set on the web. Routes: `GET` and `PUT /api/assistant/reflect` (`{ enabled?, time?, model? }`), `POST /api/assistant/reflect/run` (the owner only).

## Watches

Ask the assistant to look for something on a site: "Look for used cars under $8,000 near Oakland on Facebook Marketplace." It searches once with the hub's browser and shows what it found as cards: photo, price, title, place and a link to the listing. Then it offers "Watch this daily". Say yes, or press the button under the cards, and it makes a watch: a routine that runs the same search on a schedule and tells you only what changed, such as "3 new, 1 gone, 1 price drop". Or ask for a watch outright ("watch flats under 1,500 in Leipzig every morning").

- **A run**: opens the search address in the watch's browser profile, reads the listings, and reports them to the hub. For each item from the last run that the search no longer shows, it opens the item's own link to see whether it is still listed, sold or gone. The hub compares and keeps, for each item, when it was first and last seen and every price change.
- **What changed**: new, gone (sold, removed, or not found), price down, price up, other changes (marked pending), still there. An item that comes back is new again, with its old history.
- **Only reads**: a watch run browses and reads, and never posts, messages, offers or buys. It has only the reading browser tools (open a page, read its links, click, scroll, go back), opens only its own site, and its pages send nothing: every request other than GET, HEAD and OPTIONS is blocked, and so is every WebSocket.
- **Messages**: by default only when something changed. Edit filters, Tell me, After every run sends a summary every time. Message hours apply as for every routine. The toast shows the photos of what changed and opens the watch.
- **Routines page**: watches have their own rows: the newest photo, how many are listed, how many are new, what the last run changed and when, and the next run. A watch opens on its items, with links for New, Price changes, Still there and Gone, each item's history and a link to the listing. Run now, Pause and Edit filters sit at the top; Runs and Settings are the routine's usual tabs.
- **Edit filters**: the search address, lowest and highest price, distance and from where, words to look for, words to leave out, facts to read (year, mileage), the browser profile, and when to tell you. New items outside the filters are left out; items already kept stay.
- **Limits**: 200 items per watch by default (`watch.cap`, up to 1000; gone items go first), 30 history entries per item, the last 60 runs, and up to 40 MB of photos per watch. Deleting the routine deletes its items, runs and photos. Items are not in hub backups yet; the routine is.

### Signing in to a site

Facebook Marketplace shows listings only to a signed in browser. Settings, Browser, Sign in to a site opens the site in a browser profile on the hub (for example `marketplace`) and shows the page in the app. Click and type as you would, or type in the box and press Send; on a phone the page opens at a phone's width. Press Done when you are signed in. The login stays in that profile, the profile lists the site, and the assistant and new watches for that site use it.

The hub needs a Chromium for this: a Chrome or Chromium it finds, `browser.executablePath`, or `bunx playwright-core install chromium` on the hub. The Docker image and the LXC setup do not ship one yet.

Keep to what a site allows a person:

- Use your own personal account, and keep watches to once or twice a day. Sites limit automated use and may ask you to sign in again, show a check, or lock the account.
- A watch can stop working when the site changes its pages. A run that reads no items changes nothing, fails, and says so: open the watch's last run, and sign in again if the page asked for it.
- The hub does not get around a site's checks. If a site wants a code or a puzzle, solve it in the sign-in view.

## Tools

| Tool | Does | Permission |
| --- | --- | --- |
| `GoalList`, `GoalGet` | List goals or read one, with the area guide on request | read-only |
| `GoalCreate`, `GoalUpdate`, `GoalLog` | Create, change (status, links, add a task), log progress | asks in default mode, like `MemorySave` |
| `DayPlan` | Read the day or week (tasks, goals, sessions, routine runs); `save` stores today's plan | reading is read-only; saving asks |
| `ProactivePrefs` | Read or change the preferences | reading is read-only; changing asks |
| `CalendarList`, `CalendarFreeBusy` | Read events, find free time and meeting slots | read-only |
| `CalendarEvent`, `MailDraft` | Propose an event change or a message | never writes: the owner approves the card. With Save drafts without asking on for a mail account, a draft is saved at once and never sent; sending still needs approval |
| `MailSearch`, `MailRead` | Search and read mail | only in the untrusted email agent |
| `WatchReport` | Show what a search found as cards; in a watch run, report the items | read-only |
| `WatchCreate` | Make a watch from the chat: schedule, search address, prompt, profile, fields, filters | asks in default mode, like `ScheduleRoutine` |
| `browser_*` | The browser (`docs/DESIGN.md` 34): open, read, read links, click, type, switch profile | reading is read-only; opening a page and anything that acts asks, unless a rule allows it |

The assistant has the browser and the watch tools through `optInTools` in its profile; other agents get them by naming them. Remove them there to take them away.

The routines allow exactly the writes they need (`DayPlan`, `GoalLog`, `MemorySave`, `MemoryForget`). Untrusted agents (email, web) never get any of these tools, and neither does a subagent they start with Task, whatever agent it runs. Their chats are left out of the nightly reflection, and DayPlan lists their sessions without a title or summary.

## Costs

Default models: small model Claude Haiku 5.5 ($0.10 in, $0.50 out per million tokens), default model Claude Sonnet 5.5 ($2 in, $10 out). Measured: a heartbeat or reflection request is about 14,000 tokens before its data (the assistant prompt and 33 tool definitions).

| Part | When it calls a model | Per day |
| --- | --- | --- |
| Heartbeat, skipped tick | never | $0 |
| Heartbeat, tick that runs | once a day plus once per change, about 3 to 6 runs, about $0.002 each | about $0.01; at most about $0.08 if every tick of the day ran |
| Nightly reflection | once a night with chats, 3 to 5 calls on Sonnet 5.5 with caching | about $0.07; about $0.005 with the routine's model set to `fast` |
| Goal tools in every session | their definitions add about 1,900 tokens to each trusted agent's tool list, cached after the first call | a fraction of a cent |
| Browser and watch tools | their definitions add about 2,300 tokens to the assistant's tool list, cached after the first call | a fraction of a cent |
| A watch | each run, about 5 to 15 calls: the search, the report, and one page per item that left the search (estimated, not measured) | about $0.05 to $0.20 a run on Sonnet 5.5; much less with the routine's model set to `fast` |

The day loop routines cost what they did before plus a DayPlan call each.

## Turning parts off

- Heartbeat and nightly reflection: Settings > Assistant, On or Off (or pause the routine). The reflection's switch is also in Settings > Reflect; it is the same setting.
- Morning brief, evening wrap-up, weekly review: pause or delete the routine on Routines.
- Quiet hours: set the message hours to 00:00 to 00:00 to let everything through.
- Goals in recall: delete or complete goals; the memory follows. Basic Memory notes stop when no connection writes.
- The assistant's goal and plan tools: deny them in Settings > Permissions (for example `GoalCreate`), or in an agent's `disallowedTools`.
- A watch: pause or delete it on Routines. The assistant's browser: deny `browser_navigate` in Settings > Permissions, or edit `optInTools` in its profile.
