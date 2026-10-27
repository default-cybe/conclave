/**
 * One store for live hub data. Fed by REST on boot and by engine events from
 * ConclaveClient.connect afterwards.
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type {
  ApprovalRequest,
  Checkpoint,
  ContentBlock,
  Device,
  EngineEventEnvelope,
  LimitState,
  MemoryEntry,
  Message,
  Notice,
  QuestionRequest,
  QueuedMessage,
  RemoteStatus,
  Routine,
  RoutineRun,
  Session,
  Task,
  Todo,
  ToolResultBlock,
  ToolUseBlock,
} from '@conclave/core/types';
import { ApiError } from '@conclave/core/client';
import type { AccountsStatus, AlertItem, AppDto, Attachment, FriendDto, HubInfo, ImportOffer, InboxItemDto, MeDto, ModelGroup, McpStatus, ProjectDto, ReceivedShareDto, SendInput, SendResult, SentShareDto, SharedProjectDto, SubscriptionsStatus, ToolInfo } from '@conclave/core/client';
import { limitKey } from '@conclave/core/accounts/windows';
import type { AgentDef, CommandDef, SkillDef } from '@conclave/core/extensions/types';
import { api, connectClient, loadConnection, webSocketImpl, type Connection } from '@/lib/api';
import { dropDraft } from '@/features/chat/draft';
import { clearComments } from '@/features/chat/lineComments';
import { reportHubError } from '@/lib/identity';
import { clientLog } from '@/lib/clientLog';
import { followMove, recoverAddress, rememberAddresses } from '@/lib/remote';
import { appInUse, deviceNotice, isDesktopApp, syncDeviceNotify, watchPresence } from '@/lib/notify';
import { registerModelNames } from '@/lib/models';
import { afterHubList, newPendingId, pendingIdsOf, shownQueue, withoutIds, type Sending } from './queue';

export type ConnState = 'connecting' | 'open' | 'closed';

export interface ToolRun {
  status: 'running' | 'ok' | 'error';
  name: string;
  startedAt: number;
  finishedAt?: number;
  progress: string;
  result?: ToolResultBlock;
}

export interface Toast extends Notice {
  action?: { label: string; run: () => void };
  /** Stays until dismissed (it needs the owner). */
  sticky?: boolean;
  /** Auto dismiss after this many ms. Default 5000. */
  ttl?: number;
}

/** Hub config as returned by GET /api/config (config.ui.onboarded, ui.limitWarn ...). */
export type HubConfig = Record<string, unknown> & {
  ui?: { theme?: string; onboarded?: boolean; onboardingSteps?: string[]; limitWarn?: number; limitFault?: number };
  setup?: { completedAt?: number; progress?: Record<string, unknown> };
};

export interface HubState {
  conn: ConnState;
  booted: boolean;
  /** When this data was last known good: the last full load, or the moment the live connection dropped. */
  syncedAt?: number;
  hub?: HubInfo;
  sessions: Record<string, Session>;
  messages: Record<string, Message[]>;
  messagesLoaded: Record<string, boolean>;
  streaming: Record<string, true>;
  tools: Record<string, ToolRun>;
  approvals: Record<string, ApprovalRequest>;
  questions: Record<string, QuestionRequest>;
  /** File conflicts and stuck turns, for the Inbox (GET /api/alerts, alert.raised, alert.cleared). */
  alerts: Record<string, AlertItem>;
  /** Offers to import a newly paired computer's chats, by device (GET /api/import/offers, import.offer). */
  importOffers: Record<string, ImportOffer>;
  todos: Record<string, Todo[]>;
  /** Messages waiting while a session works, by session, as the hub lists them (GET /queue, session.queue). store/queue.ts. */
  queues: Record<string, QueuedMessage[]>;
  /** Messages this app sent while a session worked that the hub's list does not show yet. */
  sending: Record<string, Sending[]>;
  limits: Record<string, LimitState>;
  tasks: Record<string, Task>;
  routines: Record<string, Routine>;
  runs: Record<string, RoutineRun[]>;
  memories: Record<string, MemoryEntry>;
  devices: Record<string, Device>;
  /** Paired apps (GET /api/clients, app.updated). Phones and browsers are here, not in devices: they pair as apps and run no work (lib/apps.ts). */
  apps: Record<string, AppDto>;
  checkpoints: Record<string, Checkpoint[]>;
  agents: AgentDef[];
  models: ModelGroup[];
  commands: CommandDef[];
  skills: SkillDef[];
  toolList: ToolInfo[];
  mcp: McpStatus[];
  toasts: Toast[];
  /** /btw side questions per session, newest last: shown as cards, never part of the transcript. */
  btws: Record<string, BtwCard[]>;
  usageVersion: number;
  configVersion: number;
  /** Hub config, loaded at boot and after config.updated. Undefined until loaded. */
  config?: HubConfig;
  /** Which provider secrets are set (names only, never values). keyed: providers with a key from any source. */
  secrets?: { providers: string[]; values: string[]; keyed?: string[] };
  /** Remote access, from the last remote.updated event (Settings, Remote access loads it too). */
  remote?: RemoteStatus;
  /** Subscription sign-in (CLIProxyAPI), from GET /api/subscriptions and subscriptions.updated. */
  subscriptions?: SubscriptionsStatus;
  /** Accounts and their order (Settings > Models > Accounts), from GET /api/accounts and accounts.updated. */
  accounts?: AccountsStatus;
  /** Friends' hubs, not removed ones (docs/design/FRIENDS.md), from GET /api/friends and friend.updated. */
  friends: Record<string, FriendDto>;
  /** Notes from friends, newest first, from GET /api/friends/inbox and friend.message. */
  friendNotes: InboxItemDto[];
  /** Shares friends sent (the Inbox cards), from GET /api/shares/received and friend.share. */
  receivedShares: Record<string, ReceivedShareDto>;
  /** Shares this hub sent, from GET /api/shares/sent and friend.share.sent. */
  sentShares: Record<string, SentShareDto>;
  /** Projects shared with friends, from GET /api/shared-projects and friend.project. */
  sharedProjects: Record<string, SharedProjectDto>;
  /** Projects across devices, for Group by Project (GET /api/projects and project.updated). */
  projects: Record<string, ProjectDto>;
  /** Who is signed in (GET /api/me, docs/design/ACCOUNTS.md). Undefined on a hub from before accounts: the owner. */
  me?: MeDto;
}

const initial: HubState = {
  conn: 'connecting',
  booted: false,
  sessions: {},
  messages: {},
  messagesLoaded: {},
  streaming: {},
  tools: {},
  approvals: {},
  questions: {},
  alerts: {},
  importOffers: {},
  todos: {},
  queues: {},
  sending: {},
  limits: {},
  tasks: {},
  routines: {},
  runs: {},
  memories: {},
  devices: {},
  apps: {},
  checkpoints: {},
  agents: [],
  models: [],
  commands: [],
  skills: [],
  toolList: [],
  mcp: [],
  toasts: [],
  btws: {},
  usageVersion: 0,
  configVersion: 0,
  friends: {},
  friendNotes: [],
  receivedShares: {},
  sentShares: {},
  sharedProjects: {},
  projects: {},
};

export const useHub = create<HubState>(() => initial);
const set = useHub.setState;
const get = useHub.getState;

function byId<T>(list: T[], key: (t: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of list) out[key(it)] = it;
  return out;
}

function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback);
}

/**
 * A member of the hub (docs/design/ACCOUNTS.md): the owner's pages (friends,
 * shares, MCP servers, tools, remote access, provider accounts) answer 403,
 * so their calls are not made. Known from GET /api/me, or from the sign in
 * before it loads.
 */
export function memberNow(): boolean {
  return (get().me?.role ?? loadConnection()?.account?.role) === 'member';
}

/** The owner's data once `me` is known: an empty answer for a member, without asking the hub. */
function ownerOnlyAfter(me: Promise<MeDto | undefined>) {
  return <T>(call: () => Promise<T>, fallback: T): Promise<T> =>
    me.then((m) => ((m?.role ?? loadConnection()?.account?.role) === 'member' ? fallback : settle(call(), fallback)));
}

// ---------------------------------------------------------------------------
// Boot and refetch
// ---------------------------------------------------------------------------

/** Refetch the hub's state. transcripts also refetches every chat opened in this tab (a resync, a reconnect, a restore). */
export async function loadAll(opts: { transcripts?: boolean } = {}) {
  const c = api();
  // who is signed in first: a member's app skips the owner's calls (a hub from before accounts answers 404: the owner)
  const meP = settle(c.me(), undefined);
  const ownerOnly = ownerOnlyAfter(meP);
  const [hub, sessions, approvals, questions, limits, tasks, routines, devices, agents, models, commands, memories, skills, toolList, mcp] = await Promise.all([
    settle(c.info(), undefined),
    settle(c.listSessions({ limit: 500 }), []),
    settle(c.approvals(), []),
    settle(c.questions(), []),
    settle(c.limits(), []),
    settle(c.tasks(), []),
    settle(c.routines(), []),
    settle(c.devices(), []),
    settle(c.agents(), []),
    settle(c.models(), []),
    settle(c.commands(), []),
    settle(c.memories({ limit: 500 }), []),
    settle(c.skills(), []),
    ownerOnly(() => c.tools(), []),
    ownerOnly(() => c.mcp(), []),
  ]);
  const [archived, cfg, friends, friendNotes, alerts, receivedShares, sentShares, projects, sharedProjects, me, apps, importOffers] = await Promise.all([
    settle(c.listSessions({ archived: true, limit: 200 }), []),
    settle(c.config(), undefined),
    // a hub from before friends answers 404: no friends
    ownerOnly(() => c.friends(), []),
    ownerOnly(() => c.friendInbox(), []),
    settle(c.alerts(), []),
    // a hub from before shares answers 404: none
    ownerOnly(() => c.receivedShares(), []),
    ownerOnly(() => c.sentShares(), []),
    // a hub without folders across devices answers 501: no projects
    settle(c.projects(), []),
    // a hub from before shared projects answers 404: none; they are the owner's (docs/design/ACCOUNTS.md)
    ownerOnly(() => c.sharedProjects(), []),
    meP,
    // phones pair as apps; revoked ones are gone
    settle(c.apps(), []),
    // a hub from before the pairing offer answers 404: none
    settle(c.importOffers(), []),
  ]);
  registerModelNames(models.flatMap((g) => g.models.map((m) => ({ ref: m.ref, name: m.name }))));
  set({
    booted: true,
    syncedAt: Date.now(),
    hub,
    sessions: byId([...sessions, ...archived], (s) => s.id),
    approvals: byId(approvals, (a) => a.id),
    questions: byId(questions, (q) => q.id),
    alerts: byId(alerts, (a) => a.id),
    importOffers: byId(importOffers, (o) => o.device),
    // one state per provider, or per account (provider:account)
    limits: byId(limits, limitKey),
    tasks: byId(tasks, (t) => t.id),
    routines: byId(routines, (r) => r.id),
    devices: byId(devices, (d) => d.id),
    apps: byId(
      apps.filter((a) => !a.revoked),
      (a) => a.id,
    ),
    memories: byId(memories, (m) => m.id),
    agents,
    models,
    commands,
    skills,
    toolList,
    mcp,
    config: (cfg?.config as HubConfig | undefined) ?? get().config,
    secrets: cfg?.secrets ?? get().secrets,
    configVersion: get().configVersion + 1,
    friends: byId(friends, (f) => f.id),
    friendNotes,
    receivedShares: byId(receivedShares, (r) => r.id),
    sentShares: byId(sentShares, (r) => r.id),
    projects: byId(projects, (p) => p.id),
    sharedProjects: byId(sharedProjects, (p) => p.id),
    me,
  });
  if (opts.transcripts) for (const id of Object.keys(get().messagesLoaded)) void loadMessages(id, true);
}

/** The newest load of each transcript. Views that open one at once share it; an older, slower answer never lands over a newer one. */
const loads = new Map<string, { done: Promise<void> }>();
/**
 * Messages the socket started while a transcript load was out. The answer
 * was read before they existed, so it keeps them: a new chat's first reply
 * often starts before its transcript arrives.
 */
const startedDuringLoad = new Map<string, Set<string>>();
/** session.queue events seen per session, so a transcript load never lays an older list over a newer one. */
const queueEvents = new Map<string, number>();

export function loadMessages(sessionId: string, force = false): Promise<void> {
  if (!force && get().messagesLoaded[sessionId]) return Promise.resolve();
  const pending = loads.get(sessionId);
  if (pending && !force) return pending.done;
  const load = {} as { done: Promise<void> };
  const started = new Set<string>();
  loads.set(sessionId, load);
  startedDuringLoad.set(sessionId, started);
  load.done = (async () => {
    const c = api();
    const askedAt = Date.now();
    const queueMark = queueEvents.get(sessionId) ?? 0;
    // a hub from before the queue answers 404: nothing waits
    const [msgs, todos, queue] = await Promise.all([settle(c.messages(sessionId), [] as Message[]), settle(c.todos(sessionId), [] as Todo[]), settle(c.queue(sessionId), undefined as QueuedMessage[] | undefined)]);
    if (loads.get(sessionId) !== load) return;
    set((s) => {
      const got = new Set(msgs.map((m) => m.id));
      const live = (s.messages[sessionId] ?? []).filter((m) => started.has(m.id) && !got.has(m.id));
      const list = [...msgs, ...live].sort((a, b) => a.seq - b.seq);
      // what waits: unless a session.queue event came while this load was out (it is newer), and never one already in the transcript
      let queued: Pick<HubState, 'queues' | 'sending'> | undefined;
      if (queue && (queueEvents.get(sessionId) ?? 0) === queueMark) {
        const taken = new Set(list.flatMap(pendingIdsOf));
        const hub = queue.filter((q) => !taken.has(q.id));
        queued = { queues: { ...s.queues, [sessionId]: hub }, sending: { ...s.sending, [sessionId]: afterHubList(s.sending[sessionId], hub, askedAt) ?? [] } };
      }
      return {
        messages: { ...s.messages, [sessionId]: list },
        messagesLoaded: { ...s.messagesLoaded, [sessionId]: true },
        todos: { ...s.todos, [sessionId]: todos },
        ...queued,
      };
    });
  })().finally(() => {
    if (loads.get(sessionId) === load) loads.delete(sessionId);
    if (startedDuringLoad.get(sessionId) === started) startedDuringLoad.delete(sessionId);
  });
  return load.done;
}

// ---------------------------------------------------------------------------
// Messages that wait while a session works (store/queue.ts)
// ---------------------------------------------------------------------------

/** What this app attached to a message that waits, so its bubble shows the pictures before the hub has stored them. */
const previews = new Map<string, Attachment[]>();

/** The files this app sent with a waiting message (none for one sent from another device). */
export function pendingPreview(id: string): Attachment[] | undefined {
  return previews.get(id);
}

/** What waits in a session, in the order it will run: the hub's list, then what this app sent that it does not list yet. */
export function useQueue(sessionId: string): QueuedMessage[] {
  const hub = useHub((s) => s.queues[sessionId]);
  const sending = useHub((s) => s.sending[sessionId]);
  return useMemo(() => shownQueue(hub, sending), [hub, sending]);
}

function setSending(sessionId: string, fn: (list: Sending[]) => Sending[]) {
  set((s) => ({ sending: { ...s.sending, [sessionId]: fn(s.sending[sessionId] ?? []) } }));
}

/**
 * Send while the session works (a turn runs, or waits on you): the message
 * shows at once as yours, Queued (or Sending to the running turn), until the
 * hub's turn takes it. On a failure it leaves and the toast says why;
 * returns undefined then.
 */
export async function sendQueued(sessionId: string, input: SendInput & { whenBusy: 'queue' | 'steer' }): Promise<SendResult | undefined> {
  const id = newPendingId();
  const attachments = input.attachments?.map((a) => ({ mediaType: a.mediaType, ...(a.name ? { name: a.name } : {}) }));
  if (input.attachments?.length) previews.set(id, input.attachments);
  setSending(sessionId, (list) => [...list, { id, text: input.text, at: Date.now(), whenBusy: input.whenBusy, ...(attachments?.length ? { attachments } : {}) }]);
  const r = await attempt(() => api().send(sessionId, { ...input, pendingId: id }));
  setSending(sessionId, (list) => {
    if (!list.some((x) => x.id === id)) return list;
    // it waits on the hub: the hub's list takes it over when its event comes
    if (r?.queued && r.pendingId === id) return list.map((x) => (x.id === id ? { ...x, confirmedAt: Date.now() } : x));
    // refused, or the session was free after all and it ran at once
    previews.delete(id);
    return list.filter((x) => x.id !== id);
  });
  return r;
}

export interface BtwCard {
  id: string;
  question: string;
  /** Undefined while the hub answers. */
  answer?: string;
}

let btwSeq = 0;

/** /btw: ask a side question; its card shows at once and gets the answer, or goes with a toast when the hub refuses. */
export async function askBtw(sessionId: string, question: string): Promise<void> {
  const id = `btw${++btwSeq}`;
  const patch = (f: (list: BtwCard[]) => BtwCard[]) => set((s) => ({ btws: { ...s.btws, [sessionId]: f(s.btws[sessionId] ?? []) } }));
  patch((l) => [...l, { id, question }]);
  const r = await attempt(() => api().btw(sessionId, question));
  patch((l) => (r ? l.map((c) => (c.id === id ? { ...c, answer: r.answer || '(no answer)' } : c)) : l.filter((c) => c.id !== id)));
}

export function dismissBtw(sessionId: string, id: string): void {
  set((s) => ({ btws: { ...s.btws, [sessionId]: (s.btws[sessionId] ?? []).filter((c) => c.id !== id) } }));
}

/** Send a message Stop held: it shows Queued at once, and the hub's next list confirms it. */
export async function sendHeld(sessionId: string, id: string): Promise<void> {
  const held = (list: QueuedMessage[] | undefined, value: boolean) => list?.map((q) => (q.id === id ? { ...q, held: value || undefined } : q)) ?? [];
  set((s) => ({ queues: { ...s.queues, [sessionId]: held(s.queues[sessionId], false) } }));
  if (!(await attempt(() => api().sendQueued(sessionId, id)))) set((s) => ({ queues: { ...s.queues, [sessionId]: held(s.queues[sessionId], true) } }));
}

/** Take a waiting message off before it runs. It leaves at once; if the hub refuses, it comes back and the toast says why. */
export async function removeQueued(sessionId: string, id: string): Promise<void> {
  const before = get();
  const mark = queueEvents.get(sessionId) ?? 0;
  const hub = before.queues[sessionId];
  const mine = before.sending[sessionId]?.find((x) => x.id === id);
  set((s) => ({ queues: { ...s.queues, [sessionId]: withoutIds(s.queues[sessionId], [id]) ?? [] }, sending: { ...s.sending, [sessionId]: withoutIds(s.sending[sessionId], [id]) ?? [] } }));
  try {
    await api().unqueue(sessionId, id);
    previews.delete(id);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    // its turn started (it is in the transcript now), or it is gone already
    if (status === 409 || status === 404) return;
    set((s) => ({
      // the list as it was, unless the hub sent a newer one meanwhile
      queues: (queueEvents.get(sessionId) ?? 0) === mark && hub ? { ...s.queues, [sessionId]: hub } : s.queues,
      sending: mine ? { ...s.sending, [sessionId]: [...(s.sending[sessionId] ?? []), mine] } : s.sending,
    }));
    toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
  }
}

export async function loadCheckpoints(sessionId: string) {
  const list = await settle(api().checkpoints(sessionId), []);
  set((s) => ({ checkpoints: { ...s.checkpoints, [sessionId]: list } }));
}

export async function loadRuns(routineId: string) {
  const list = await settle(api().routineRuns(routineId), []);
  set((s) => ({ runs: { ...s.runs, [routineId]: list } }));
}

let disconnect: (() => void) | null = null;
/** Pages that show the Map, and the socket's switch for its deltas. */
let mapViews = 0;
let setMapLive: ((on: boolean) => void) | null = null;

/** The Map is open: ask the hub for map.delta events until the returned function is called. */
export function watchMap(): () => void {
  if (mapViews++ === 0) setMapLive?.(true);
  return () => {
    if (--mapViews === 0) setMapLive?.(false);
  };
}

export function startLive() {
  disconnect?.();
  const live = api().connect(applyEvent, {
    onStatus: (conn) => {
      const was = get().conn;
      // the hub's log files hear when the live connection comes and goes (lib/clientLog.ts)
      // info: a phone's app drops its socket each time it goes to the background, which is no fault
      if (conn !== was) clientLog('info', conn === 'open' ? (was === 'closed' ? 'reconnect' : 'connect') : conn === 'closed' ? 'disconnect' : 'reconnecting', { was });
      // the data was live up to now; from here it is the last known state
      set(was === 'open' && conn !== 'open' ? { conn, syncedAt: Date.now() } : { conn });
      if (conn === 'open' && was === 'closed') void loadAll({ transcripts: true });
      if (conn === 'open') void loadRemote();
      // the hub's address stopped answering: try its other addresses, or say to pair again
      if (conn === 'closed') void recoverAddress({ reconnect: moveTo, lost: addressLost });
    },
    onResync: () => void loadAll({ transcripts: true }),
    // the socket met another key at the hub's address and sent nothing: the app shows why
    onIdentityError: reportHubError,
    WebSocketImpl: webSocketImpl(),
    active: appInUse(),
    map: mapViews > 0,
  });
  setMapLive = (on) => live.setMap(on);
  // the hub holds notifications while Conclave is in use somewhere
  const stopPresence = watchPresence((active) => live.setActive(active));
  syncDeviceNotify();
  disconnect = () => {
    stopPresence();
    live();
  };
}

/** Remote access status and the hub's addresses, so this app can fall back when one stops answering. */
async function loadRemote() {
  // remote access is the owner's; a member's app keeps the addresses it signed in with
  if (memberNow()) return;
  try {
    const remote = await api().remote();
    set({ remote });
    rememberAddresses(remote);
  } catch {
    /* an older hub without remote access */
  }
}

function moveTo(conn: Connection) {
  void connectClient(conn).then(() => startLive());
}

function addressLost(host: string) {
  // the desktop app checks the hub's other addresses each time it starts
  const desktop = isDesktopApp();
  toast({
    id: 'remote-lost',
    title: `The hub stopped answering at ${host}.`,
    body: desktop
      ? 'Quit Conclave from the tray and open it again. On start it tries the hub\'s other addresses.'
      : 'A quick tunnel gets a new address when the hub restarts. Pair again with a new code from the hub, or connect on the same network.',
    level: 'error',
    sticky: true,
    action: desktop ? undefined : { label: 'Connect again', run: () => location.assign('/?connect=1') },
  });
}

export function stopLive() {
  disconnect?.();
  disconnect = null;
  loads.clear();
  queueEvents.clear();
  previews.clear();
  useHub.setState(initial, true);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastSeq = 0;

/**
 * Show a toast. One line: title (and body) plus at most one action. The
 * Toaster dismisses it after 5s (hover pauses); pass sticky for things that
 * need the owner. level "error" renders with a leading "Failed." in fault.
 */
export function toast(t: Partial<Toast> & { title: string }) {
  const item: Toast = { body: '', level: 'info', createdAt: Date.now(), ...t, id: t.id ?? `t${++toastSeq}` };
  if (get().toasts.some((x) => x.id === item.id)) return item.id;
  // the page shows it already (useOnPage)
  const about = askOf(item);
  if (about && onPage.has(about)) return item.id;
  set((s) => ({ toasts: [...s.toasts.slice(-2), item] }));
  return item.id;
}

export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Drop the toasts `quiet` picks now and as they arrive, before they are drawn. */
function useDropToasts(quiet: ((t: Toast) => boolean) | undefined) {
  useEffect(() => {
    if (!quiet) return;
    const drop = (list: Toast[]) => {
      for (const t of list) if (quiet(t)) dismissToast(t.id);
    };
    drop(get().toasts);
    return useHub.subscribe((s, prev) => {
      if (s.toasts !== prev.toasts) drop(s.toasts);
    });
  }, [quiet]);
}

/**
 * The hub also sends each notice of a session as a toast ("Stopped", an error,
 * "Second opinion added", "Approval needed"). A chat or session on screen
 * already says it in its transcript, and shows its approval card and its
 * question in place, so its own toasts go before they are drawn.
 */
export function useQuietToasts(sessionId: string | undefined) {
  useDropToasts(useMemo(() => (sessionId ? (t: Toast) => t.sessionId === sessionId : undefined), [sessionId]));
}

const isAsk = (t: Toast) => !!t.approvalId || !!t.questionId;

/**
 * Screens that list what waits on you (the Inbox, Home) show a new approval
 * or question themselves: a toast about it would only cover the card it
 * announces.
 */
export function useQuietAskToasts() {
  useDropToasts(isAsk);
}

const isAlert = (t: Toast) => !!t.alertId;

/** The Inbox lists file conflicts and stuck turns too: their toasts would cover the rows. */
export function useQuietAlertToasts() {
  useDropToasts(isAlert);
}

/** The approval, question or alert a toast is about. */
const askOf = (t: Pick<Toast, 'approvalId' | 'questionId' | 'alertId'>) => t.approvalId ?? t.questionId ?? t.alertId;
/** Approvals, questions and alerts the open page shows as a row or a card, with how many show each. */
const onPage = new Map<string, number>();

/**
 * A row or card that shows an approval, a question or an alert, with its
 * answers. The hub's toast about it would say it again and could cover it,
 * so that toast goes while the row is on the page: one already up leaves,
 * and one that arrives is not drawn.
 */
export function useOnPage(id: string | undefined) {
  useEffect(() => (id ? showOnPage(id) : undefined), [id]);
}

/** The page shows this item now (useOnPage). Returns the call for when it no longer does. */
export function showOnPage(id: string): () => void {
  onPage.set(id, (onPage.get(id) ?? 0) + 1);
  for (const t of get().toasts) if (askOf(t) === id) dismissToast(t.id);
  return () => {
    const n = (onPage.get(id) ?? 1) - 1;
    if (n > 0) onPage.set(id, n);
    else onPage.delete(id);
  };
}

/** Run an API call, toast on failure ("Failed. <reason>"). */
export async function attempt<T>(fn: () => Promise<T>, okTitle?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okTitle) toast({ title: okTitle, level: 'success' });
    return r;
  } catch (e) {
    toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
    return undefined;
  }
}

/** True when this app holds the owner token: only the owner's GET /api/config carries server.token. */
export function useIsOwner(): boolean {
  return useHub((s) => typeof (s.config?.server as { token?: unknown } | undefined)?.token === 'string');
}

/** Merge a patch into the hub config: saves it and updates the store at once. */
export async function updateConfig(patch: Record<string, unknown>) {
  const prev = get().config ?? {};
  set({ config: mergeDeep(structuredClone(prev), patch) as HubConfig });
  try {
    await api().updateConfig(patch);
  } catch (e) {
    set({ config: prev });
    throw e;
  }
}

function mergeDeep(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) mergeDeep(cur as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
  return target;
}

/** Refetch model groups (after a key is saved or a provider changes). */
export async function reloadModels() {
  const models = await settle(api().models(), get().models);
  registerModelNames(models.flatMap((g) => g.models.map((m) => ({ ref: m.ref, name: m.name }))));
  set({ models });
}

/** Refetch devices (after pairing or renaming). */
export async function reloadDevices() {
  const list = await settle(api().devices(), []);
  set({ devices: byId(list, (d) => d.id) });
}

/** Reload the hub config (after setSecret or a settings change elsewhere). */
export async function reloadConfig() {
  const cfg = await settle(api().config(), undefined);
  if (cfg) set({ config: cfg.config as HubConfig, secrets: cfg.secrets, configVersion: get().configVersion + 1 });
}

// ---------------------------------------------------------------------------
// Local upserts (after REST calls) so the UI does not wait for the event
// ---------------------------------------------------------------------------

export function upsertSession(s: Session) {
  set((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
}
export function upsertTask(t: Task) {
  set((st) => ({ tasks: { ...st.tasks, [t.id]: t } }));
}
export function upsertRoutine(r: Routine) {
  set((st) => ({ routines: { ...st.routines, [r.id]: r } }));
}
export function upsertMemory(m: MemoryEntry) {
  set((st) => ({ memories: { ...st.memories, [m.id]: m } }));
}
/** A friend as the hub returned it: a removed one leaves the list. */
export function upsertFriend(f: FriendDto) {
  set((st) => {
    const friends = { ...st.friends };
    if (f.status === 'removed') delete friends[f.id];
    else friends[f.id] = f;
    return { friends };
  });
}
/** A note from a friend, new or changed (a large one that finished arriving). */
export function upsertFriendNote(n: InboxItemDto) {
  set((st) => {
    const at = st.friendNotes.findIndex((x) => x.id === n.id && x.friendId === n.friendId);
    if (at < 0) return { friendNotes: [n, ...st.friendNotes].sort((a, b) => b.receivedAt - a.receivedAt) };
    const friendNotes = [...st.friendNotes];
    friendNotes[at] = n;
    return { friendNotes };
  });
}
/** A share from a friend, new or changed (accepted, unsent, a new revision). */
export function upsertReceivedShare(r: ReceivedShareDto) {
  set((st) => ({ receivedShares: { ...st.receivedShares, [r.id]: r } }));
}
/** A share this hub sent, new or changed. */
export function upsertSentShare(r: SentShareDto) {
  set((st) => ({ sentShares: { ...st.sentShares, [r.id]: r } }));
}
/** A shared project, new or changed; with gone, its copy left this hub. */
export function upsertSharedProject(p: SharedProjectDto, gone = false) {
  set((st) => {
    const sharedProjects = { ...st.sharedProjects };
    if (gone) delete sharedProjects[p.id];
    else sharedProjects[p.id] = p;
    return { sharedProjects };
  });
}
/** Approvals decided from a card on screen: the card removes them after showing the result. */
export const heldApprovals = new Set<string>();

export function removeKey<K extends 'sessions' | 'tasks' | 'routines' | 'memories' | 'devices' | 'apps' | 'approvals' | 'questions' | 'alerts'>(k: K, id: string) {
  if (k === 'sessions') {
    void dropDraft(id);
    clearComments(id);
  }
  set((st) => {
    const next = { ...(st[k] as Record<string, unknown>) };
    delete next[id];
    return { [k]: next } as Partial<HubState>;
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function upsertMessage(list: Message[] | undefined, m: Message): Message[] {
  const arr = list ? [...list] : [];
  const i = arr.findIndex((x) => x.id === m.id);
  if (i >= 0) arr[i] = m;
  else {
    arr.push(m);
    arr.sort((a, b) => a.seq - b.seq);
  }
  return arr;
}

function applyDelta(m: Message, index: number, kind: 'text' | 'thinking', text: string): Message {
  const content: ContentBlock[] = [...m.content];
  const b = content[index];
  if (kind === 'text') {
    content[index] = b && b.type === 'text' ? { ...b, text: b.text + text } : { type: 'text', text };
  } else {
    content[index] = b && b.type === 'thinking' ? { ...b, thinking: b.thinking + text } : { type: 'thinking', thinking: text };
  }
  for (let i = 0; i < content.length; i++) if (!content[i]) content[i] = { type: 'text', text: '' };
  return { ...m, content };
}

/** `streaming` without these ids: the same object when none of them streams, so its readers skip the update. */
function stopStreaming(streaming: Record<string, true>, ids: Iterable<string>): Record<string, true> {
  let out = streaming;
  for (const id of ids) {
    if (!out[id]) continue;
    if (out === streaming) out = { ...streaming };
    delete out[id];
  }
  return out;
}

/** Feature modules that follow events the store does not keep (import.batch, workflow.*). */
const eventListeners = new Set<(e: EngineEventEnvelope) => void>();

/** When each session last streamed text or ran a tool (hub time). `session.updatedAt` moves on neither, so a busy task would look quiet. */
const lastActive = new Map<string, number>();
export const lastActiveAt = (sessionId: string): number | undefined => lastActive.get(sessionId);

/** Listen to every hub event. Returns the unsubscribe function. */
export function onHubEvent(fn: (e: EngineEventEnvelope) => void): () => void {
  eventListeners.add(fn);
  return () => void eventListeners.delete(fn);
}

export function applyEvent(e: EngineEventEnvelope) {
  for (const fn of eventListeners) {
    try {
      fn(e);
    } catch {
      /* a listener's failure never stops the store */
    }
  }
  const s = get();
  if (e.type === 'message.delta' || e.type === 'tool.started' || e.type === 'tool.progress' || e.type === 'tool.completed') lastActive.set(e.sessionId, e.ts);
  switch (e.type) {
    case 'session.created':
    case 'session.updated': {
      const streaming = e.session.status === 'running' ? s.streaming : stopStreaming(s.streaming, (s.messages[e.session.id] ?? []).map((m) => m.id));
      set({ sessions: { ...s.sessions, [e.session.id]: e.session }, streaming });
      break;
    }
    case 'session.deleted': {
      lastActive.delete(e.sessionId);
      removeKey('sessions', e.sessionId);
      // its transcript goes too, or every resync would fetch it again from a hub that no longer has it
      const { [e.sessionId]: _m, ...messages } = get().messages;
      const { [e.sessionId]: _l, ...messagesLoaded } = get().messagesLoaded;
      const { [e.sessionId]: _t, ...todos } = get().todos;
      const { [e.sessionId]: _q, ...queues } = get().queues;
      const { [e.sessionId]: _w, ...sending } = get().sending;
      set({ messages, messagesLoaded, todos, queues, sending });
      break;
    }
    case 'message.created':
    case 'message.updated': {
      const m = e.message;
      if (e.type === 'message.created') startedDuringLoad.get(m.sessionId)?.add(m.id);
      const streaming = e.type === 'message.updated' && m.stopReason ? stopStreaming(s.streaming, [m.id]) : s.streaming;
      // your message took a waiting one's place: the pending bubble goes in the same update, so both never show
      const took = pendingIdsOf(m);
      const queued: Partial<HubState> = {};
      if (took.length) {
        const hub = withoutIds(s.queues[m.sessionId], took);
        const mine = withoutIds(s.sending[m.sessionId], took);
        if (hub !== s.queues[m.sessionId]) queued.queues = { ...s.queues, [m.sessionId]: hub ?? [] };
        if (mine !== s.sending[m.sessionId]) queued.sending = { ...s.sending, [m.sessionId]: mine ?? [] };
        for (const id of took) previews.delete(id);
      }
      set({ messages: { ...s.messages, [m.sessionId]: upsertMessage(s.messages[m.sessionId], m) }, streaming, ...queued });
      break;
    }
    case 'message.deleted': {
      // an empty reply, or a refused one the refusal fallback dropped before the next model answered
      const list = s.messages[e.sessionId];
      if (!list?.some((x) => x.id === e.messageId)) break;
      set({ messages: { ...s.messages, [e.sessionId]: list.filter((x) => x.id !== e.messageId) }, streaming: stopStreaming(s.streaming, [e.messageId]) });
      break;
    }
    case 'session.queue': {
      queueEvents.set(e.sessionId, (queueEvents.get(e.sessionId) ?? 0) + 1);
      const sending = afterHubList(s.sending[e.sessionId], e.queue);
      set({ queues: { ...s.queues, [e.sessionId]: e.queue }, ...(sending !== s.sending[e.sessionId] ? { sending: { ...s.sending, [e.sessionId]: sending ?? [] } } : {}) });
      break;
    }
    case 'message.delta': {
      const list = s.messages[e.sessionId] ?? [];
      const found = list.find((x) => x.id === e.messageId);
      // the same object while it already streams, so a chunk does not redraw every reply that reads it
      const streaming = s.streaming[e.messageId] ? s.streaming : { ...s.streaming, [e.messageId]: true as const };
      // a tool call's input streams as partial JSON: its block shows once tool.started brings the whole input
      if (e.kind === 'tool_input' && found) {
        if (streaming !== s.streaming) set({ streaming });
        break;
      }
      const m: Message = found ?? {
        id: e.messageId,
        sessionId: e.sessionId,
        seq: (list[list.length - 1]?.seq ?? 0) + 1,
        role: 'assistant',
        kind: 'normal',
        content: [],
        createdAt: e.ts,
        model: s.sessions[e.sessionId]?.model,
        agent: s.sessions[e.sessionId]?.agent,
      };
      if (!found) startedDuringLoad.get(e.sessionId)?.add(e.messageId);
      const next = e.kind === 'tool_input' ? m : applyDelta(m, e.index, e.kind, e.text);
      set({ messages: { ...s.messages, [e.sessionId]: upsertMessage(list, next) }, streaming });
      break;
    }
    case 'tool.started': {
      const list = s.messages[e.sessionId] ?? [];
      const m = list.find((x) => x.id === e.messageId);
      let messages = s.messages;
      if (m && !m.content.some((b) => b.type === 'tool_use' && b.id === e.toolUseId)) {
        const block: ToolUseBlock = { type: 'tool_use', id: e.toolUseId, name: e.name, input: e.input };
        messages = { ...s.messages, [e.sessionId]: upsertMessage(list, { ...m, content: [...m.content, block] }) };
      }
      set({ messages, tools: { ...s.tools, [e.toolUseId]: { status: 'running', name: e.name, startedAt: e.ts, progress: '' } } });
      break;
    }
    case 'tool.progress': {
      const t = s.tools[e.toolUseId];
      if (!t) break;
      const progress = (t.progress + e.text).slice(-20_000);
      set({ tools: { ...s.tools, [e.toolUseId]: { ...t, progress } } });
      break;
    }
    case 'tool.completed': {
      const t = s.tools[e.toolUseId] ?? { name: '', startedAt: e.ts, progress: '' };
      // the result shows from here on; the live output (up to 20,000 characters a run) would only pile up
      set({ tools: { ...s.tools, [e.toolUseId]: { ...t, status: e.result.isError ? 'error' : 'ok', result: e.result, finishedAt: e.ts, progress: '' } } });
      break;
    }
    case 'approval.requested':
      set({ approvals: { ...s.approvals, [e.approval.id]: e.approval } });
      break;
    case 'approval.resolved':
      // A card that made this decision shows "Allowed once, 14:09" for a moment and removes it itself.
      if (!heldApprovals.has(e.id)) removeKey('approvals', e.id);
      break;
    case 'question.asked':
      set({ questions: { ...s.questions, [e.question.id]: e.question } });
      break;
    case 'question.answered':
      removeKey('questions', e.id);
      break;
    case 'alert.raised':
      set({ alerts: { ...s.alerts, [e.alert.id]: e.alert } });
      break;
    case 'alert.cleared':
      removeKey('alerts', e.id);
      break;
    case 'todo.updated':
      set({ todos: { ...s.todos, [e.sessionId]: e.todos } });
      break;
    case 'usage.recorded':
      set({ usageVersion: s.usageVersion + 1 });
      break;
    case 'limit.updated':
      set({ limits: { ...s.limits, [limitKey(e.limit)]: e.limit } });
      break;
    case 'notice': {
      // a failed turn sends two notices, the transcript line ("Error: ...") and the alert ("Session error"): one toast, the later
      const errorId = e.notice.level === 'error' && e.notice.sessionId ? `error:${e.notice.sessionId}` : undefined;
      if (errorId) dismissToast(errorId);
      // a watch's notice has photos to look at: it stays longer (features/watches)
      toast({ ...e.notice, id: errorId ?? e.notice.id, ...(e.notice.watch ? { ttl: 15_000 } : {}) });
      deviceNotice(e.notice);
      break;
    }
    case 'task.updated':
      upsertTask(e.task);
      break;
    case 'task.deleted':
      removeKey('tasks', e.taskId);
      break;
    case 'routine.updated':
      upsertRoutine(e.routine);
      break;
    case 'routine.deleted':
      removeKey('routines', e.routineId);
      break;
    case 'routine.run': {
      const runs = [...(s.runs[e.run.routineId] ?? [])];
      const i = runs.findIndex((r) => r.id === e.run.id);
      if (i >= 0) runs[i] = e.run;
      else runs.unshift(e.run);
      set({ runs: { ...s.runs, [e.run.routineId]: runs } });
      break;
    }
    case 'memory.updated':
      upsertMemory(e.entry);
      break;
    case 'memory.deleted':
      removeKey('memories', e.id);
      break;
    case 'device.updated':
      // the hub device's name is the hub's name in every header ("Hub madx online")
      set({ devices: { ...s.devices, [e.device.id]: e.device }, ...(e.device.id === 'local' && s.hub ? { hub: { ...s.hub, name: e.device.name } } : {}) });
      break;
    case 'device.deleted':
      removeKey('devices', e.deviceId);
      break;
    case 'app.updated':
      // a phone paired, connected, went away or was revoked
      if (e.app.revoked) removeKey('apps', e.app.id);
      else set({ apps: { ...s.apps, [e.app.id]: e.app } });
      break;
    case 'checkpoint.created':
      set({ checkpoints: { ...s.checkpoints, [e.sessionId]: [...(s.checkpoints[e.sessionId] ?? []), e.checkpoint] } });
      break;
    case 'remote.updated':
      set({ remote: e.remote });
      rememberAddresses(e.remote);
      // a quick tunnel got a new address: follow it when this app uses the old one
      followMove(e.remote, {
        notify: (next, open) => toast({ id: 'remote-moved', title: `The hub has a new address, ${next}.`, body: 'This one stops in a few seconds.', sticky: true, action: { label: 'Open it', run: open } }),
        reconnect: moveTo,
      });
      break;
    case 'subscriptions.updated':
      // events leave out `local` (it belongs to one request): keep what this client was told
      set({ subscriptions: { ...e.status, local: s.subscriptions?.local } });
      // signing in or removing an account changes the models
      if (JSON.stringify(e.status.models) !== JSON.stringify(s.subscriptions?.models)) void reloadModels();
      break;
    case 'accounts.updated':
      set({ accounts: e.status });
      break;
    case 'friend.updated':
      upsertFriend(e.friend);
      break;
    case 'friend.message':
      upsertFriendNote(e.message);
      break;
    case 'friend.share':
      upsertReceivedShare(e.share);
      break;
    case 'friend.share.sent':
      upsertSentShare(e.share);
      break;
    case 'friend.project':
      upsertSharedProject(e.project, e.change === 'forgotten');
      break;
    case 'config.updated':
      void loadAll();
      break;
    case 'import.offer': {
      const { [e.device]: _gone, ...rest } = s.importOffers;
      set({ importOffers: e.offer ? { ...rest, [e.device]: e.offer } : rest });
      break;
    }
    case 'models.updated':
      void reloadModels();
      break;
    case 'project.updated':
      set({ projects: { ...s.projects, [e.project.id]: e.project } });
      break;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function toolResultsFor(messages: Message[]): Record<string, ToolResultBlock> {
  const out: Record<string, ToolResultBlock> = {};
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result') out[b.toolUseId] = b;
  return out;
}

export function agentByName(name: string | undefined): AgentDef | undefined {
  if (!name) return undefined;
  return get().agents.find((a) => a.name === name);
}
