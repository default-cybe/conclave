# Conclave UI components

What the foundation pass built for the page builders. Read `docs/design/SPEC.md` first; this file says where each piece lives and how to call it. Everything here follows the spec's banned list (section 2), so if you compose these you stay inside it.

See every component with live mock data at **`/dev/ui`** (the gallery, `src/components/dev/Gallery.tsx`).

Paths are relative to `packages/web/src`. The `@/` alias points at `src/`.

---

## 1. Run it

```sh
cd packages/web
VITE_MOCK=1 bunx vite --port <port> --strictPort --host 127.0.0.1
```

| URL | What you get |
|---|---|
| `/` | Normal mock: a set up hub on a busy day. `ui.onboarded` is true, so the app opens on Home. |
| `/?fresh=1` | First-run mock: no keys, sessions, routines, tasks, memory or usage. The app redirects to `/welcome`. Remembered in `sessionStorage` for the tab; progress (config, keys, created routines, imported sessions, paired devices) survives reloads. |
| `/?reset=1` | Clears saved first-run progress and starts the first run again (stays in first-run mode). |
| `/?fresh=0` | Back to the normal mock. |
| `/?connect` | Shows the Connect screen even in mock mode. Password login takes any 12 characters or more without "wrong" in them (or the one set in Settings, Remote access in this tab) and shows the hub's fingerprint. |
| `/?offline` | The hub does not answer for 20 seconds: the shell opens with the offline banner, which retries and clears itself. |
| `/?stranger` | The address in use answers with another key: the identity screen. Its other addresses answer 3 seconds after the page loads, so Try works. |
| `/dev/ui` | Component gallery. |

First-run tips: Skip setup on the stub writes `ui.onboarded: true` and lands on a first-day Home (two devices, empty everything). In first-run mode `testProvider` checks the key you paste (see section 9).

Checks: `bun run typecheck`, `bun run build`, `bun run build:mock`.

---

## 2. Tokens (`styles/index.css`)

Colors are CSS variables with Tailwind names bound in `@theme inline`. Never use Tailwind's palette (`zinc-900`, `violet-500`).

| Variable | Tailwind | Use |
|---|---|---|
| `--bg` | `bg-bg` | page |
| `--bg-sunk` | `bg-sunk` | inputs, code, composer, scope well |
| `--bg-raise` | `bg-raise` | approval card, menus, dialogs, selected row, kbd |
| `--bg-hover` | `bg-hover` | row and quiet button hover |
| `--rule` | `border-rule`, `bg-rule` | row and column rules |
| `--rule-2` | `border-rule-2` | section heading rule, box borders, outline buttons |
| `--edge` | `border-edge` | input, checkbox and radio borders |
| `--fg` `--fg-2` `--fg-3` `--fg-4` | `text-fg` ... `text-fg-4` | text tiers. Words, placeholders and disabled labels included, use fg-3 or above (4.5:1 on both grounds); fg-4 is for icons, rules and separators |
| `--signal` | `text-signal`, `bg-signal` | live work, focus, brand crest, now line. Never buttons, never fills over 2px |
| `--signal-dim` | | text selection only |
| `--ok` `--warn` `--fault` | `text-ok` `text-warn` `text-fault` | healthy; waiting on you or limit at 70%; failed or limit at 90% |
| `--add-bg` `--del-bg` | | diff lines |
| `--solid` `--solid-fg` | `bg-solid` `text-solid-fg` | primary button |
| `--meter-off` `--meter-on` | `bg-meter-off` `bg-meter-on` | meter track and fill |
| `--wave-ink` `--wave-hot` | | wave levels (set on a parent to recolor a wave) |
| `--scrim` | | behind dialogs and sheets |
| `--shadow-pop` | | floating layers only |
| `--syn-kw` `--syn-str` `--syn-num` `--syn-type` `--syn-fn` `--syn-com` | | syntax (hljs classes are themed already) |

Other variables: `--sans`, `--mono`, `--ease`, `--dur-1` 120ms, `--dur-2` 180ms, `--dur-3` 240ms, `--r-1` 3px (controls), `--r-2` 5px (boxes), `--r-3` 10px (phone sheets and the phone approval card), `--safe-t`, `--safe-b`, `--gutter` (32 / 24 / 16 by breakpoint), `--bar-h` 48px, `--bar-h-phone` 52px, `--tabbar-h` 56px, `--row-py` (10px, 6px in compact density), `--body-size`.

Theme: `html[data-theme="dark"|"light"]`, set before paint by `public/theme.js` from `localStorage["conclave.appearance"] = {"theme","logos","density","motion"}`. The store (`store/ui.ts`) owns it: `useUi(s => s.theme | s.logos | s.density | s.motion | s.resolved)`, `toggleTheme()`, `applyTheme()`. `html[data-density="compact"]` and `html[data-motion="reduce"]` follow the Appearance settings.

**Legacy aliases.** Old names (`bg-s1`, `border-line`, `text-accent-text`, `bg-accent`, `text-err`, `--surface-1`, `--accent` ...) still resolve to the new tokens so pages that are not rebuilt yet do not break. Do not use them in new code; delete them when no page does.

### Type roles

Utilities that set size, line height, weight, width and tracking together, with the phone sizes from spec 4.2 built in:

`t-wordmark` (92), `t-status` (28), `t-verdict` (34), `t-step` (30), `t-page` (20), `t-title` (17), `t-stat` (20, tabular), `t-section` (13/600), `t-row` (13.5/500), `t-body` (14), `t-prose` (14.5/1.6), `t-meta` (12), `t-micro` (11/450), `t-code` (mono 12.5/1.6).

Plain sizes exist too: `text-micro`, `text-meta`, `text-code`, `text-section`, `text-row`, `text-body`, `text-prose`, `text-title`, `text-page`, `text-status`. Weights: `font-book` 450, `font-stat` 540, `font-strong` 560, plus `font-normal` 400, `font-medium` 500, `font-semibold` 600. Nothing at 700 or above.

### Utilities

| Class | Does |
|---|---|
| `num` | tabular figures (tables, counters, readouts). Never on running text |
| `mono` | inline mono at 0.93em with slashed zero, for paths, ids, IPs, commands inside sans text |
| `link` | quiet underlined text link |
| `rows` | rule lines between direct children |
| `tbl` | table styling for a hand-built `<table>` (`.r` cells right align) |
| `scroll-y`, `no-scrollbar`, `pb-safe`, `pt-safe` | as named |
| `state-word` | the 240ms color fade when a state word changes |
| `anim-fade`, `anim-rise`, `anim-pop`, `anim-sheet`, `anim-right` | entrances (opacity and up to 4px; sheets slide full height) |

Variants: `phone:` (below 768px), `coarse:` (touch pointer), `hov:` (hover that skips disabled controls, inside `@media (hover: hover)`), `press:` (active that skips disabled), `light:` and `dark:`.

---

## 3. Layout and shell

### Shell (`components/Shell.tsx`)

Rendered by `App.tsx` around every page except onboarding and Connect. You do not render it.

- Desktop and wide: 48px top bar: brand, text nav (Home, Chats, Inbox n, Tasks n, Routines, Agents, Memory, Usage, Devices), command field, hub state ("Hub madx online"), Settings. 1024 to 1279: Agents, Memory, Devices fold into More. Tablet (768 to 1023): Home, Chats, Inbox, Tasks, More.
- Phone (the iPhone app, from the owner's iPhone designs): a bottom tab bar with icons, Home, Chats (sessions and chats), Inbox (its count as a badge) and You (everything else). The four tabs draw their own large titles with no header (`phonePlace(path)` says where a route sits); pages You opens get a "< You" header; inner pages keep the title with a back chevron; a session (`/s/:id`) is full screen with its own header (back to the last tab, the title with agent, device and project under it, the session menu), and so is a chat (`/chat`, the title with the model under it, the chat menu with All chats). The document title is the page's, "Inbox, Conclave" (`pageTitle`), and the desktop app's window follows it. The tab bar hides while the keyboard is open. `BackLink`, `TABS`, `tabOf`, `YOU_PATHS` are exported.
- The page area is `<main id="main" class="flex min-h-0 flex-1 flex-col">`. Your page decides how it scrolls: use `Page` for a scrolling page, or your own `min-h-0 flex-1` layout with inner scroll areas (Chats).
- Exports: `NAV`, `SETTINGS_NAV`, `HubState`, `useInboxCount()`, `isTyping(e)`, and for phones `phonePlace`, `TABS`, `tabOf`, `BackLink`, `YOU_PATHS`.
- Under the header: `OfflineBanner` ("Can't reach madx. Retrying…", the next try and Retry) while the saved hub has not answered since the app started.
- Global keys: ⌘K palette, ⌘N new session, G then H C I T R A M U D S, ? shortcuts, ⌘. theme, ⌘\ context panel, ⌘⇧M model palette, / focuses `[data-composer]` or `[data-quickstart]`.

**Phone header contract.** Inner routes (`/s/:id`, `/settings/:x`, `/routines/:id`, `/agents/:name`, `/tasks/:id`, `/devices/:id/files`) get a title and back chevron automatically. Do not draw a second phone header in the page. To set your own title, back target or a right action ("Details"):

```tsx
import { usePageHeader } from '@/components/ui/Page';
usePageHeader(session.title, '/chats', <button onClick={openDetails} className="text-[15px] text-fg-2">Details</button>);
```

### Page, PageHeader (`components/ui/Page.tsx`)

```tsx
<Page width="wide" | "column" | "full">   // wide caps at 1440 (Home), column is 720 (Settings, editors)
  <PageHeader title="Routines" sub="5 active" actions={<><Button variant="quiet">Templates</Button><Button variant="solid">New routine</Button></>} />
  ...
</Page>
```

`Page` props: `width`, `className` (outer scroll box), `innerClassName`, `scroll` (default true), `id`. `PageHeader` props: `title`, `sub` (only when it carries state), `actions` (at most one solid), `children` (rendered under, e.g. Tabs).

### Routes (`App.tsx`)

`/` Home (`features/home/HomePage.tsx`; phones get `PhoneHome.tsx`), `/welcome/:step?` and `/setup/:step?` onboarding (`features/onboarding/OnboardingPage.tsx`, outside the shell), `/connect` (outside the shell), `/chats`, `/s/:id`, `/approvals` and `/inbox` (phones get `PhoneInbox.tsx`, the filter in `?show=`), `/you` (phones; wider screens go to Settings), `/tasks/:id?`, `/agents/:name?`, `/routines/:id?` (so `/routines/new` works), `/memory`, `/usage`, `/devices`, `/devices/:id/files`, `/settings/:section?`, `/dev/ui`. Pages are default exports, lazy loaded.

### Onboarding gating (`lib/onboarding.ts`)

When the app is connected and the hub config says not onboarded, `App` redirects to `/welcome` (never when already on `/welcome`, `/setup` or `/connect`).

```ts
isOnboarded(config)       // ui.onboarded === true || setup.completedAt
useOnboarded()            // true | false | undefined while loading
recordStep(id, how, resumeAt)       // features/onboarding/progress.ts: ui.onboardingSteps + setup.progress, so a reload resumes
finishOnboarding()        // Done step: ui.onboarded = true and setup.completedAt
skipOnboarding()          // "Skip setup": ui.onboarded = true
SETUP_ROUTE = '/welcome'; RUN_SETUP_AGAIN = '/setup?again=1'
```

---

### Reaching the hub (`lib/reach.ts`, `lib/identity.ts`, `App.tsx`)

At start `reachHub(conn)` tries the saved address, then the hub's other addresses (`addressOrder`, `savedAddresses` in `lib/remote.ts`). The one that answers is saved with the hub's name, and with its key when the connection had none (trust on first use, `client.checkIdentity()`). No answer anywhere: the shell opens and `keepTrying` retries with `retryDelay` (2, 4, 8, 16, 32 s, then every minute) until one answers. Another key (`HubIdentityError`, from any request, the socket's `onIdentityError`, or the start): `StrangerScreen`, "This address is not your hub. Conclave did not send your sign-in.", with the other addresses to try and Pair again. A WebView without Ed25519 (iOS before 17) gets the same screen with "This iPhone needs iOS 17 or later to check the hub." The connection keeps `hubKey` (from `PairResult.identity`) and `hubName` next to the token.

## 4. Store additions (`store/store.ts`, `store/ui.ts`)

- `useIsOwner()`: true when this app holds the owner token (only the owner's GET /api/config carries `server.token`). Settings, Remote access shows the Password row only then.
- `useHub(s => s.config)`: hub config (`config.ui.onboarded`, `ui.limitWarn`, `ui.limitFault`, `setup.*`), loaded at boot. `useHub(s => s.secrets)`: `{ providers: string[], values: string[] }` (names only).
- `updateConfig(patch)`: deep merge into the store at once and PATCH the hub; rolls back and throws on failure.
- `reloadConfig()`, `reloadModels()`, `reloadDevices()`.
- `toast({ title, body?, level?: 'info'|'success'|'warning'|'error', link?, action?: { label, run }, sticky?, ttl? })`. `level: 'error'` renders "Failed." in fault before the text; write the reason as the title. `attempt(fn, okTitle?)` wraps an API call and toasts failures.
- `store/ui.ts`: `openPalette(mode?, query?)` (query ">" opens actions only), `closePalette()`, `openShortcuts()`, `openNewChat(preset?)`, `toggleContext()`, `toggleTheme()`, `useUi(s => s.header)`.

---

## 5. Primitives (`components/ui/*`, also re-exported from `@/components/ui`)

### Button, IconButton, ButtonLink (`ui/Button.tsx`)

```tsx
<Button variant="solid" | "outline" | "quiet" | "quiet-fault" | "danger" | "danger-outline"
        size="sm" | "md" | "lg" | "touch"      // 26, 30, 38, 44px
        busy={saving ? 'Saving' : false}       // label swaps to the verb, width holds, no spinner
        kbd="↵"                                 // key hint inside, currentColor at 55%
        full disabled onClick>Save</Button>
<IconButton label="More actions" size="sm" variant="quiet"><MoreHorizontal /></IconButton>   // label is required; shows as tooltip
<ButtonLink href="/usage" variant="quiet">Usage</ButtonLink>
buttonClass(variant, size, extra)   // when you need the look on another element
```

One solid per region. `quiet-fault` is the approval card's Deny. Legacy variants map: primary to solid, secondary to outline, ghost to quiet. Disabled uses `aria-disabled` (text fg-3, no hover), never lower opacity. Buttons with a label carry no icon (except Stop's square).

### Inputs (`ui/Field.tsx`)

```tsx
<Field label="Hub address" help="The address printed by conclave serve." error={err}>
  <Input mono placeholder="https://madx.tail4e2a.ts.net:7420" />
</Field>
<Input size="sm" | "md" | "lg" mono invalid prefix="$" suffix="ms" kbd="/" />   // 30 / 34 / 38px, 44 on phones
<Textarea prose mono invalid minRows={3} maxRows={12} />                          // grows to maxRows then scrolls
<Checkbox checked onChange label description />
<Radio name checked onChange label description>{shown when chosen}</Radio>
<Segmented label="Theme" value onChange options={[{ value: 'light', label: 'Light' }, ...]} size="sm" | "md" | "touch" full />
<OnOff checked onChange label="Write what it learns" />      // booleans, in detail views only
<Select>{<option/>}</Select>                                  // native select: fine on phones
```

`Field` wires the id, `aria-describedby` and the invalid state to its first control. Errors are sentences that say what happened and how to fix it. Toggle switches are banned: booleans use `OnOff`.

### SelectMenu and PickerButton (`ui/Select.tsx`)

```tsx
<SelectMenu value onChange look="field" | "text" prefix="On" label="Device"
  options={[{ value, label, text?, lead?, detail?, hint?, disabled?, group? }]} />
<PickerButton look="text" prefix="Agent" lead={<ModelMark .../>}>coder</PickerButton>   // the closed picker look
```

`look="text"` is the composer picker (prefix word fg-3, value fg-2, chevron fg-4). Use SelectMenu on desktop, not the native select.

### Overlays (`ui/Overlay.tsx`)

```tsx
<Dialog open onClose title="Rename session" description? width={480} footer={<><Button variant="quiet">Cancel</Button><Button variant="solid">Save</Button></>}>...</Dialog>
<ConfirmDialog open onClose onConfirm title="Delete routine Server watchdog?" body="Its 48 past runs stay in the history." confirm="Delete" busy="Deleting" tone="danger" | "neutral" />
<Popover anchor={ref} open onClose placement="bottom-start" width={380} maxHeight={480} sheetTitle="Model">...</Popover>   // a bottom sheet on phones
<Menu label="Routine actions" items={[{ label: 'Run now', hint: 'R' }, { separator: true, label: '' }, { label: 'Delete', danger: true, onSelect }]}
      trigger={({ ref, props }) => <IconButton ref={ref} label="More actions" {...props}><MoreHorizontal /></IconButton>} />
<MenuList items onDone />      // menu rows with arrow keys and typeahead
<Sheet open onClose title footer>...</Sheet>               // phone bottom sheet with grabber and swipe down
<SideSheet open onClose width={340} label="Details">...</SideSheet>   // right side sheet (context panel, task details)
useFocusTrap(ref, open, { initial? })
```

`MenuItem`: `{ label, lead?, hint?, detail?, danger?, disabled?, checked?, onSelect?, separator?, group?, keep? }`. Dialogs trap focus, close on Esc and scrim, and give focus back.

### Toasts (`ui/Toast.tsx`)

`<Toaster />` is mounted by App. Raise toasts with `toast()` from the store. Bottom left on desktop, above the tab bar on phones, 5s unless `sticky`, hover pauses, at most three.

### Tooltip, Kbd (`ui/Tooltip.tsx`, `ui/Kbd.tsx`)

```tsx
<Tooltip content="Cron: 30 7 * * 1-5" side="top" delay={450}><span>Weekdays at 07:30</span></Tooltip>   // one child element
<Kbd>⌘K</Kbd>  <Kbd plain>↵</Kbd>  <Keys keys={[MOD, 'K']} />  <Keys keys={['G', 'H']} then />
MOD  // "⌘" or "Ctrl";  isMac
```

### Lists (`ui/List.tsx`)

```tsx
<ListRow title="Move auth middleware to jose"
  meta={<MetaLine parts={['coder', <ModelName model={s.model} size={13} />]} />}
  time="12m" state="approve" stateTone="warn" | "fault" | "ok" | "signal" | "dim" | "neutral"
  right={...}            // replaces the right column
  selected href="/s/x" | onClick inset={true}>{children under the meta line}</ListRow>
<StateWord tone="ok">online</StateWord>
<MetaLine parts={['coder', modelNode, 'arch-desktop']} />   // comma separated, empty parts dropped
<SelectedMark />   // the selected row's 2px ink bar, over its bg-raise fill; in any list or side nav (the row is relative)
```

Running rows show elapsed in signal: `state={<Elapsed since={s.createdAt} format="short" className="text-signal" />}` (no strip in narrow rows).

### Sections (`ui/Section.tsx`)

```tsx
<Section title="Running" count={2} countTone="warn" action={{ label: 'All sessions', href: '/chats' }} right={...} tone="warn" rows>
  {rows}
</Section>
<SectionHeading count action right tone as="h3" rule={false}>Limits</SectionHeading>
<TextAction label="Edit" href="/routines" />
<Aside title="Workspace"><KV k="Folder" mono>~/code/conclave</KV></Aside>
<Quote cite="From Reverse proxy for the Proxmox homelab, 2h ago">...</Quote>
<Notice time="12:04" tone="fault" | "warn" action={{ label: 'Retry', onClick }}>Failed. The hub lost the connection to arch-desktop.</Notice>
```

Sections in a column sit 28px apart: give the column `space-y-7` (phones `phone:space-y-8`).

### Stats and meters (`ui/Stat.tsx`, `ui/Meter.tsx`)

```tsx
<StatGroup><Stat value="$4.20" label="today" /><Stat value="$149.07" label="30 days" delta="up 12% on last month" /></StatGroup>
<Meter value={46} max={100} label="Context, 46K of 1M" tone="neutral" | "signal" | "warn" | "fault" />   // 3px bar
<LimitGauge value={72} label="Claude Max, 5 hours" blocked={false} />   // 24 ticks; thresholds from hub config
<LimitRow window={w} plan="Claude Max" blocked compact />               // name, gauge, percent, reset line
<LimitGroup limit={limitState} compact right="read from OAuth 2 min ago" hideRate />   // logo + plan + windows
limitPeak(limit)   // sort groups: Object.values(limits).sort((a, b) => limitPeak(b) - limitPeak(a))
windowLabel('7d opus')   // "Week, Opus";  planParts('ChatGPT Pro · Codex') // ['ChatGPT', 'Pro, Codex']
useLimitThresholds()     // { warn: 70, fault: 90 } from config.ui
isRateWindow(w)          // per-minute API windows; hidden unless above 50%
```

Segmented ticks are for usage limits only. Everything else is a `Meter` or plain text ("4 of 5").

### Empty and loading (`ui/EmptyState.tsx`, `ui/Skeleton.tsx`)

```tsx
<EmptyState action={{ label: 'New routine', onClick }}>Routines you schedule show up here with their next run.</EmptyState>
<EmptyState wave={false}>...</EmptyState>          // a second empty state on the same screen
<LoadingRows loading={!loaded} rows={4} />         // appears only after 300ms, static
<Skeleton className="h-3.5 w-2/3" />
```

### Tags, filters, tabs (`ui/Tags.tsx`)

```tsx
<Tags tags={['homelab', 'uni']} max={3} />     // "homelab, uni" in fg-3
<FilterLinks value onChange options={[{ value: 'all', label: 'All', count: 214 }, ...]} />
<Tabs value onChange options={[{ value: 'settings', label: 'Settings' }, { value: 'runs', label: 'Runs', count: 48 }]} />
<Tabs value={section} options={[{ value: 'runs', label: 'Runs', href: '/routines/x/runs' }]} />   // href makes them links
```

### Table (`ui/Table.tsx`)

```tsx
<Table rowKey={(r) => r.id} onRowClick={(r) => navigate(...)} defaultSort={{ key: 'cost', dir: 'desc' }} empty={<EmptyState>...</EmptyState>}
  columns={[
    { key: 'model', header: 'Model', title: true, render: (r) => <ModelName model={r.ref} tone="brand" /> },
    { key: 'sessions', header: 'Sessions', numeric: true, sort: (a, b) => a.sessions - b.sessions },
    { key: 'cost', header: 'Cost', numeric: true, render: (r) => usd(r.cost) },
  ]}
  rows={rows} />
```

Column options: `numeric` (right, tabular), `title` (500 fg), `dim` (fg-2), `sort`, `width`, `className`, `phoneHide`. With more than three columns it becomes list rows on phones (turn off with `phoneRows={false}`).

### Code (`ui/Code.tsx`)

```tsx
<CodeBlock code lang="ts" shell copy maxLines={12} wrap bare title />
<Command command="proxmox-backup-client verify ..." bare copy />   // wraps between tokens, $ in fg-4
<Diff diff={unified} | file={DiffFile} verb="Edit" maxLines={20} bare header action={<Button variant="quiet" size="sm">View file</Button>} />
<InlineCode>10.0.20.11</InlineCode>
```

Highlighting: `lib/highlight.ts` (`highlight(code, lang)`, `langFromPath(path)`), themed by the `--syn-*` tokens.

---

## 6. Logos (`components/logo/*`)

Three tiers (spec 8.2): a session through a CLI shows the **harness** mark, a model shows its **family** mark, a plan or key shows the **company** mark. Mono (currentColor) by default; pass `tone="brand"` only where the model or provider is the subject of the row (model picker, Limits header, Running model column, jurors, Usage by-model, provider rows, agent editor model field). Harness marks are always mono. The Appearance setting "One color" (`useUi(s => s.logos)`) forces mono.

```tsx
<ModelName model="anthropic/claude-sonnet-5-5" size={14} tone="brand" />   // [claude] Sonnet 5.5
<ModelName model="claude-code/opus" />                                      // [cc] Claude Code (harness first)
<ModelName model="claude-code/opus" as="model" />                           // [claude] Opus
<HarnessName harness="codex" size={13} />                                   // [codex] Codex
<CompanyName provider="claude-max" name="Claude Max" size={16} tone="brand" />
<ModelMark model={ref} size={16} tone="brand" />  <HarnessMark harness="gemini-cli" />  <CompanyMark provider="zai-coding" size={22} tone="brand" />
<Logo id="openrouter" size={14} tone="mono" label="OpenRouter" />          // label only when it stands alone
<MarkStack models={jurorRefs} />                                            // juror stack: up to five 14px marks, 3px apart
<Monogram name="CLIProxy" size={16} />                                      // fallback for unknown providers
modelLogo(ref)  harnessLogo(ref)  companyLogo(providerOrLimitId)            // -> LogoId | undefined
logoGap(size)   // 13px -> 5, 14 -> 7, 16 -> 8, 22 -> 14
LOGO_NOTICE     // the trademark line for Settings > About
```

Sizes: meta line 13, rows and tables 14, pickers and menus 16, Limits and juror headers 16, provider rows and onboarding Done 22. Logo ids: `claude-code codex gemini-cli opencode cursor cline openhands claude gpt gemini glm deepseek qwen kimi mistral grok llama minimax anthropic openai google zai zhipu moonshot openrouter ollama lmstudio groq xai`. Unknown ids render a monogram.

Names (`lib/models.ts`): `modelName(ref)` ("Sonnet 5.5", "GPT-5.5 Codex", "Gemini 3 Pro", "GLM-5", "Qwen3 Coder 30B"), `harnessLabel(ref)`, `harnessId(ref)`, `providerName(id)` ("Z.ai", "Claude Max", "OpenRouter"), `formatModelId(id)`, `contextLabel(n)`. Write model names this way in UI, never raw ids (ids go in tooltips: `ModelName` sets `title` to the ref).

---

## 7. Wave (`components/wave/*`)

```tsx
<Wave variant="hero" | "scope" | "strip" | "ambient"
  className="h-[72px]"        // the canvas fills its box: size it with CSS
  gap radius speed amplitude  // defaults per variant (hero 7 / 1.25, scope 4 / 1.1, strip 3 / 0.9, ambient 6 / 1)
  rate={0.6}                  // 0..1 activity for strip and scope ripple; rateFromTps(tps) = clamp(tps / 60, 0.15, 1)
  series={[...]}              // scope: values 0..1, oldest first
  tone="ink" | "signal"       // strip defaults to signal
  static                      // one frame (finished runs, screenshots)
  label="Model output over the last hour" />   // role="img" when set, aria-hidden otherwise
<LiveStrip tps={38} startedAt={ts} word="Running" showTps detail="api.z.ai" done={finished ? 'done in 3m 12s' : undefined} width={64} />
<LiveIndicator compact startedAt={ts} />       // compact: elapsed only, for rows narrower than a strip
<Elapsed since={ts} until? format="clock" | "short" className="text-signal" />   // 12:04 or 12m, ticks each second
```

One shared 30fps loop drives every wave; DPR aware (capped 2 on touch, 3 elsewhere); offscreen and hidden tabs pause and keep their clock; reduced motion (system or Appearance) draws one static frame; colors follow the theme; slow draws widen the dot pitch. Placement rules (spec 9.3): at most one hero or scope per screen; strips at least 64px wide; never behind text, never as a background, never in nav, headers other than Home, settings, dialogs or toasts. Placements: onboarding hero `gap={8} radius={1.4}` at `h-[clamp(280px,52vh,560px)]` (phones 38vh); step rail `300 x 56, gap 5, amplitude 0.5, speed 0.6`; Home scope 560 x 140 wide, full x 96 desktop, full x 64 phone; chat live line `variant="strip"` full width x 22; empty states via `EmptyState`.

`mountWave(canvas, opts)` is the imperative engine if you need it.

---

## 8. Brand (`components/brand/Mark.tsx`)

```tsx
<Mark size={21} mono? label? surface? />  // the knot with its violet light; `height` (old) gives a box 1.5 times it
<Brand size={15} mark />                  // a 21px knot + "Conclave", Mona Sans 600 at 110% width
```

The mark is the knot with a light (`docs/design/brand/README.md`), drawn by `KnotSvg.tsx` from `knotGeometry.ts`; the Knot (`components/motion`) is the same drawing with its light moving. Onboarding shows the wordmark with `t-wordmark` and no mark beside it. The favicon, the PWA icons and the badge are files in `public/`, written with every other icon by `bun scripts/brand/knot.ts` from `docs/design/brand/knot.json`.

---

## 8a. Motion (`components/motion/*`)

The live mark, live labels, streamed text and swaps. Props, states and placement rules are in `docs/design/CHAT-AND-MOTION.md` (section 1.8); tokens in `styles/motion.css`.

```tsx
<Knot state="thinking" | "tool" | "waiting" | "paused" | "failed" | "done" size={16} />
<Shimmer>Thinking</Shimmer>
<LiveStatus state="tool" label="Searching the web" detail={query} startedAt={ts} />
<InkReveal active={streaming}><Markdown text={text} streaming={streaming} /></InkReveal>
<Swap on={copied} off={<Copy />}><Check /></Swap>
useReducedMotion()   // system setting or Appearance > Reduce motion
```

## 9. Shared domain components

### Approval and question (`components/inbox/*`): Home, Inbox, Chat

```tsx
<ApprovalCard approval={a} collapsed={i > 0} onExpand={() => setOpen(a.id)} inSession onResolved={(d) => ...} />
<QuestionCard question={q} inSession title? />
approvalQuestion(a, deviceName)   // { text, mono?, after? }: "Run this command on madx?", "Edit <path>?"
waitWords(ms)                     // "Waiting 2 min"
```

The card builds the sentence from the tool, shows the command (token wrapped) or the diff (8 lines) or the content, the agent's reason in quotes, Allow once / Allow for this session / Deny / Always allow... (confirm with the exact rule) / Open session, and A, S, D keys when focused. After a decision it collapses to "Allowed once, 14:09" and removes itself after 4s. On phones it becomes the phone card (r-3, full width Allow once, the others below). The question card answers through `answerQuestion`, steps through multiple questions, and has Reply.

### Pickers (`components/pickers/*`): Home quick start, composer, editors, Settings, onboarding

```tsx
<ModelPicker value={model} onChange={setModel} look="text" | "field" harnesses prefix? label="Model" />
<ModelList value onChange values onChangeMany footer harnesses onDone />   // embed the list; multiple mode for jury members
<AgentPicker value onChange look prefix includeHidden />
<DevicePicker value onChange look prefix onlineOnly />
```

The model list has Recent (last five used), each provider with its account word ("key set", "Coding Pro", "rejected", "not set"), then Coding agents with where each can run. Disabled providers show "Add key" (routes to Settings > Providers).

### Provider rows (`components/providers/ProviderRow.tsx`): Settings > Providers, onboarding step 2

```tsx
<ProviderHeader />                                     // Provider, Sign in with, Key, Result
<ProviderRow provider="openrouter" testOnMount menu={[...]} onResult={(r) => ...}>{expanded content}</ProviderRow>
const k = useProviderKey('zai')   // { info, hasKey, result, save(key), test(), remove() }
<ProviderResultWords result={k.result} host="api.z.ai" />
```

Paste or blur saves the key with `setSecret` and tests it with `testProvider`; while testing a LiveStrip shows "Testing api.z.ai"; results are "Works 7 models, 212 ms", "Rejected 401" with the explanation under the row, "Found 4 models on gpu-lxc" for Ollama, "Not set". The catalog is `lib/providers.ts`: `PROVIDERS` (id, name, description, signIn, keyPrefix, host, console, more), `HARNESS_LOGINS` (Claude Code, Codex, Gemini CLI, OpenCode with their plans and CLIs), `providerInfo(id)`, `keyPlaceholder(info)`.

Mock key rules (first run): `sk-ant-` Anthropic, `sk-proj-` or `sk-` OpenAI, `sk-or-` OpenRouter, `AIza` Google, `<32 hex>.<text>` Z.ai, `sk-` DeepSeek and Moonshot, `gsk_` Groq, `xai-` xAI. A key with "revoked", "bad" or "invalid" in it is rejected as revoked. The wrong provider's key is rejected with "This looks like an Anthropic key. OpenRouter keys start with sk-or-." Harness tests: claude-code "Signed in, Claude Max", codex "Signed in, ChatGPT Pro", gemini-cli "Signed in with Google", opencode found in first run (missing in the normal mock).

### Pairing (`components/devices/PairingPanel.tsx`): Devices, onboarding step 7

```tsx
<Dialog open title="Pair a device" width={560}><PairingPanel kind="client" | "device" onPaired={(d) => ...} /></Dialog>
```

QR in its white well, the code, "Expires in 9:42", the install command for a device agent, a "Waiting for the phone" strip, then "Paired iPhone." The mock pairs a device about 6.5s after a code is made (an iPhone for `client`, the MacBook for `device`).

### Routines today (`components/routines/DayAxis.tsx`): Home, Routines

```tsx
const marks = dayMarks(Object.values(routines), runs)   // store.runs, fill with loadRuns(id)
<DayAxis marks={marks} />
```

Schedules in words and today's occurrences: `lib/schedule.ts` (`describeSchedule('30 7 * * 1-5')` = "Weekdays at 07:30", `everyMs`, `parseCron`, `occurrencesToday(schedule, now, anchor)`, `dayStart`).

---

## 10. Formatting helpers (`lib/format.ts`)

New: `elapsedClock(ms)` "12:04", `durationShort(ms)` "1h 22m", `inTime(ts)` "in 6 min", `countWord(n, capital)` "two" / "Two" (status sentences), `longDate(ts)` "Friday 16 October", `shortDate(ts)` "16 Oct", `hhmm(ts)` "14:08", `relTime(ts)` "now", "2m", "3h", "Tue", "16 Oct". Existing: `usd`, `compact`, `int`, `countdown`, `duration`, `bytes`, `plural`, `shortPath`.

Hooks (`lib/hooks.ts`): `useNow(ms)` (one shared, aligned timer per interval), `useBreakpoint()` 'phone' | 'tablet' | 'desktop' | 'wide', `useIsMobile`, `useIsTablet`, `useIsDesktop`, `useIsWide`, `useCoarsePointer`, `useReducedMotion`, `useDelayed(pending, 300)`, `useCopy`, `useLoad`.

---

## 11. Mock data highlights (`mock/data.ts`, `mock/index.ts`)

Hub `madx` (Proxmox LXC), devices madx, arch-desktop (claude, codex, opencode, gemini CLIs), pve, kali-vm, macbook (offline 9h). Sessions: running Sonnet 5.5 on arch-desktop (live scenario with an approval), running Codex GPT-5.5 on madx, waiting for reset (Claude Max blocked), waiting approval (PBS verify through Claude Code), waiting answer (GLM-5 CTF question, two questions), a jury with a failed fifth juror, a debate, a failed Ollama session. Limits: Claude Max blocked 5 hours, ChatGPT Pro Codex, Z.ai Coding prompts, API rate windows. Routines: Morning brief, PBS backup check (failed yesterday), Nightly librarian, CVE watch, Server watchdog (every 30 min, one failure today), Uni deadlines (18:00). A rejected DeepSeek key. Starter templates in spec order: Nightly librarian, Morning brief, Server watchdog, Uni deadlines, Backup check, CTF writeup reminder. External sessions to import: 214 Claude Code and 58 Codex on arch-desktop, 31 and 12 on macbook.
