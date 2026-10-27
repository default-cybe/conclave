/**
 * The session panel (spec 11.2.4, docs/design/CHAT-AND-MOTION.md 2.11), like
 * the Claude app's: a stack of rounded cards, each a title, a short value at
 * the right and a chevron that opens it. Which cards are open is kept on
 * this device.
 *
 *   Environment        arch-desktop .    device and its state, folder, branch, permissions, task
 *   Context            [ring] 12%        tokens in and out, cost, cache hits, what fills it
 *   Connectors         3 connected       the MCP servers, each on or off for this session (/mcp)
 *   Plan               3 of 5            the agent's todo list
 *   Outputs            4 files           files it wrote, pictures and pages it made, each opening its preview
 *   Changes            +8 -6             changed files, checkpoints with Restore, Open pull request
 *   Background tasks   2 running         workflows, subagents and background shells, Stop; "3 finished" folded
 *   Memory used        3                 the facts it was given
 *
 * The assistant's conversations have no Environment or Changes; a chat has
 * Context, Outputs and Memory used (panel.ts panelCards). Jury and debate
 * sessions get This run, Jurors and Memory learned.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { McpServerConfig } from '@conclave/core/config/schema';
import type { Checkpoint, Message, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, loadCheckpoints, upsertSession, useHub } from '@/store/store';
import { setCardOpen, useUi } from '@/store/ui';
import { useLoad } from '@/lib/hooks';
import { cn, parseDiff, type DiffFile } from '@/lib/text';
import { compact, durationShort, fileName, hhmm, plural, relTime, shortPath, slashes, usd } from '@/lib/format';
import { worthLine } from '@/features/usage/value';
import { harnessId, modelName } from '@/lib/models';
import { repoActions, sessionRepo } from '@/lib/github';
import { ModelName } from '@/components/logo';
import { Button, IconButton } from '@/components/ui/Button';
import { Checkbox, OnOff } from '@/components/ui/Field';
import { Meter } from '@/components/ui/Meter';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/Overlay';
import { KV, Quote, TextAction } from '@/components/ui/Section';
import { Stat, StatGroup } from '@/components/ui/Stat';
import { StateWord } from '@/components/ui/List';
import { Diff } from '@/components/ui/Code';
import { Elapsed } from '@/components/motion';
import { StatusWord } from '@/features/extensions/McpServers';
import { useRepoActions, useRepoSession } from '@/features/github/RepoBar';
import { useSessionRuns } from '@/features/workflows/data';
import { isLive, RUN_TONE, RUN_WORD } from '@/features/workflows/words';
import { openPreview } from '@/features/conversation/state';
import { analyzeJury } from './Group';
import { permissionMeta } from './modes';
import { revealToolRow } from './ToolRows';
import { agoText, msgText } from './util';
import { subagentOf, taskCalls, taskKind, tasksWord, useRunningTasks, type RunningTask } from './liveTasks';
import { PausedWord, TaskTitle } from './RunningTasks';
import { groupByKind } from '@/lib/taskKinds';
import { backgroundShells, callCostWord, contextPercent, costWord, outputsWord, panelCards, sessionOutputs, type BackgroundShell, type CardId, type Output } from './panel';
import { sessionMcpOff, ConnectorsSheet } from './sheets/Connectors';
import { ContextSheet, CONTEXT_PARTS } from './sheets/ContextSheet';
import { SessionSheet } from './sheets/SessionSheet';

/** The panel's width, docked and as a sheet. */
export const PANEL_W = 340;

export function ContextPanel({ session, onClose }: { session: Session; onClose?: () => void }) {
  const isGroup = session.mode === 'jury' || session.mode === 'debate';
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-bg" aria-label="Session details">
      {onClose && (
        <div className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-5 phone:hidden">
          <span className="t-title flex-1 text-[15px] text-fg">Details</span>
          <IconButton label="Close details" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 pt-3 pb-8 phone:px-4 phone:pt-2">{isGroup ? <GroupCards session={session} /> : <SessionCards session={session} />}</div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// A card
// ---------------------------------------------------------------------------

function Card({ id, title, value, children }: { id: string; title: ReactNode; value?: ReactNode; children: ReactNode }) {
  const open = useUi((s) => !!s.cards[id]);
  return (
    <section data-card={id} className="rounded-[12px] bg-card light:shadow-[0_0_0_1px_var(--rule)]">
      <h3 className="m-0">
        <button type="button" aria-expanded={open} onClick={() => setCardOpen(id, !open)} className="group/card flex h-11 w-full items-center gap-3 rounded-[12px] px-3.5 text-left focus-visible:-outline-offset-2">
          <span className="shrink-0 text-[13.5px] font-medium text-fg">{title}</span>
          <span className="ml-auto flex min-w-0 items-center justify-end gap-1.5 truncate text-[13px] text-fg-3">{value}</span>
          <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)] group-hover/card:text-fg-2', open && 'rotate-90')} />
        </button>
      </h3>
      {open && <div className="px-3.5 pb-3.5 text-[13px] anim-fade">{children}</div>}
    </section>
  );
}

/** A row inside a card: words at the left, something at the right. */
function Line({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-8 items-center gap-3 py-1', className)}>
      <div className="min-w-0 flex-1">{children}</div>
      {right !== undefined && <div className="shrink-0">{right}</div>}
    </div>
  );
}

const EMPTY = 'm-0 py-1 text-[13px] leading-[1.45] text-fg-3';

// ---------------------------------------------------------------------------
// A session, an assistant conversation or a chat
// ---------------------------------------------------------------------------

function SessionCards({ session }: { session: Session }) {
  const cards = panelCards(session);
  const [sheet, setSheet] = useState<'context' | 'mcp' | null>(null);
  const show = (id: CardId) => cards.includes(id);
  return (
    <>
      {show('environment') && <EnvironmentCard session={session} />}
      {show('context') && <ContextCard session={session} onDetails={() => setSheet('context')} />}
      {show('connectors') && <ConnectorsCard session={session} onManage={() => setSheet('mcp')} />}
      {show('plan') && <PlanCard session={session} />}
      {show('outputs') && <OutputsCard session={session} />}
      {show('changes') && <ChangesCard session={session} />}
      {show('tasks') && <TasksCard session={session} />}
      {show('memory') && <MemoryCard session={session} />}
      <SessionSheet open={!!sheet} onClose={() => setSheet(null)} title={sheet === 'mcp' ? 'Connectors' : 'Context'} sub={session.title}>
        {sheet === 'mcp' ? <ConnectorsSheet session={session} onClose={() => setSheet(null)} /> : sheet === 'context' ? <ContextSheet session={session} openConnectors={() => setSheet('mcp')} /> : null}
      </SessionSheet>
    </>
  );
}

async function patchSession(session: Session, p: Parameters<ReturnType<typeof api>['updateSession']>[1], ok?: string) {
  const s = await attempt(() => api().updateSession(session.id, p), ok);
  if (s) upsertSession(s);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function EnvironmentCard({ session }: { session: Session }) {
  const device = useHub((s) => s.devices[session.device]);
  const task = useHub((s) => (session.taskId ? s.tasks[session.taskId] : undefined));
  const tasks = useHub((s) => s.tasks);
  const [, navigate] = useLocation();
  // Syncthing conflict files in the folder are said here, not in the banner over the composer
  const where = useLoad(() => (session.kind === 'chat' ? Promise.resolve(undefined) : api().sessionLocation(session.id)), [session.id, session.device, session.cwd]);
  const conflicts = where.data?.freshness?.conflicts ?? 0;
  const repo = sessionRepo(session);
  const branch = repo?.branch ?? (typeof session.meta?.branch === 'string' ? session.meta.branch : undefined);
  const name = device?.name ?? session.device;
  const online = device?.online ?? session.device === 'local';
  return (
    <Card
      id="environment"
      title="Environment"
      value={
        <>
          <span className="truncate">{name}</span>
          <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', online ? 'bg-ok' : 'bg-fg-4')} />
          <span className="sr-only">{online ? 'online' : 'offline'}</span>
        </>
      }
    >
      <dl className="m-0">
        <KV k="Device" keyWidth={84}>
          {name}
          <span className={cn('ml-2 text-[12px]', online ? 'text-ok' : 'text-fg-3')}>{online ? 'online' : 'offline'}</span>
        </KV>
        {repo && <KV k="Repository" keyWidth={84}>{repo.repo}</KV>}
        <KV k={repo ? 'Worktree' : 'Folder'} mono keyWidth={84}>
          {/* the end of the path, where the project is; the whole of it on hover */}
          <span title={session.cwd || '~'}>{shortPath(session.cwd || '~', 2)}</span>
        </KV>
        {branch && (
          <KV k="Branch" mono keyWidth={84}>
            {branch}
          </KV>
        )}
        {conflicts > 0 && (
          <KV k="Syncthing" keyWidth={84}>
            <span className="text-warn">{conflicts === 1 ? '1 conflict file' : `${conflicts} conflict files`}</span>
          </KV>
        )}
        <KV k="Permissions" keyWidth={84}>
          <span className={cn(session.permissionMode === 'bypass' && 'text-fault')}>{permissionMeta(session.permissionMode).label}</span>
        </KV>
        <KV k="Task" keyWidth={84}>
          <Menu
            label="Task"
            placement="bottom-end"
            width={280}
            trigger={({ ref, props }) => (
              <button ref={ref} type="button" {...props} className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-left text-fg hov:text-fg-2">
                <span className={cn('truncate', !task && 'text-fg-3')}>{task?.title ?? 'None'}</span>
                <ChevronDown aria-hidden strokeWidth={1.75} className="size-3 shrink-0 text-fg-4" />
              </button>
            )}
            items={[
              ...(task ? [{ label: 'Open task', onSelect: () => navigate(`/tasks/${task.id}`) }, { separator: true, label: '' }] : []),
              { group: true, label: 'Link this session to' },
              { label: 'No task', checked: !session.taskId, onSelect: () => patchSession(session, { taskId: null }) },
              ...Object.values(tasks)
                .filter((t) => t.status !== 'done' || t.id === session.taskId)
                .map((t) => ({ label: t.title, checked: t.id === session.taskId, onSelect: () => patchSession(session, { taskId: t.id }) })),
            ]}
          />
        </KV>
        {session.tags.length > 0 && (
          <KV k="Tags" keyWidth={84}>
            {session.tags.join(', ')}
          </KV>
        )}
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A small ring for how full the context is: neutral, amber from 70%, red from 90% (spec 10.9). */
function Ring({ pct, live }: { pct: number; live: boolean }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const tone = pct >= 90 ? 'var(--fault)' : pct >= 70 ? 'var(--warn)' : live ? 'var(--signal)' : 'var(--fg-2)';
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--meter-off)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} style={{ transition: 'stroke-dashoffset var(--dur-3) var(--ease)' }} />
    </svg>
  );
}

function ContextCard({ session, onDetails }: { session: Session; onDetails: () => void }) {
  const messages = useHub((s) => s.messages[session.id]);
  const models = useHub((s) => s.models);
  const open = useUi((s) => !!s.cards.context);
  const running = session.status === 'running';
  const info = models.flatMap((g) => g.models).find((m) => m.ref === session.model);
  const lastUsage = [...(messages ?? [])].reverse().find((m) => m.usage)?.usage;
  const ctxUsed = lastUsage ? lastUsage.inputTokens + (lastUsage.cacheReadTokens ?? 0) : 0;
  const pct = contextPercent(ctxUsed, info?.contextWindow);
  const cacheBase = session.stats.inputTokens + session.stats.cacheReadTokens;
  const cachePct = cacheBase ? Math.round((session.stats.cacheReadTokens / cacheBase) * 100) : 0;
  const tokensTotal = session.stats.inputTokens + session.stats.outputTokens + session.stats.cacheReadTokens;
  // subscriptions and harness plans have no per-token price, so a zero cost reads "plan"
  const cost = costWord(session.stats, session.model, info);
  return (
    <Card
      id="context"
      title="Context"
      value={
        pct === undefined ? (
          'Not measured'
        ) : (
          <>
            <Ring pct={pct} live={running} />
            <span className="num text-fg-2">{pct}%</span>
          </>
        )
      }
    >
      {tokensTotal === 0 ? (
        <p className={EMPTY}>{running ? 'Token counts show up when the first reply finishes.' : `No token counts yet${harnessId(session.model) ? '. The harness reports them when a turn ends.' : '.'}`}</p>
      ) : (
        <>
          <StatGroup className="mt-1">
            <Stat value={compact(session.stats.inputTokens + session.stats.cacheReadTokens)} label="tokens in" />
            <Stat value={compact(session.stats.outputTokens)} label="tokens out" />
            <Stat value={cost} label="cost" delta={worthLine(session.stats)} />
          </StatGroup>
          <div className="mt-3.5 space-y-3 text-[12px] text-fg-3">
            <div>
              <div className="mb-1.5 flex justify-between">
                <span>Context</span>
                <span className={cn('num', ctxUsed ? 'text-fg-2' : 'text-fg-3')}>{!ctxUsed ? 'not measured yet' : info ? `${compact(ctxUsed)} of ${compact(info.contextWindow)}` : compact(ctxUsed)}</span>
              </div>
              {ctxUsed > 0 && info && <Meter value={ctxUsed} max={info.contextWindow} tone={running ? 'signal' : 'neutral'} label={`Context, ${compact(ctxUsed)} of ${compact(info.contextWindow)}`} />}
            </div>
            <div>
              <div className="mb-1.5 flex justify-between">
                <span>Cache hits</span>
                <span className="num text-fg-2">{cachePct}%</span>
              </div>
              <Meter value={cachePct} label={`Cache hits, ${cachePct}%`} />
            </div>
          </div>
        </>
      )}
      {open && <ContextParts session={session} />}
      <div className="mt-3">
        <TextAction label="What fills it" onClick={onDetails} />
      </div>
    </Card>
  );
}

/** The breakdown /context shows, as rows (a hub from before it has none). */
function ContextParts({ session }: { session: Session }) {
  const count = useHub((s) => s.messages[session.id]?.length ?? 0);
  const load = useLoad(() => api().contextUsage(session.id), [session.id, count]);
  const u = load.data;
  if (!u || !u.total) return null;
  return (
    <dl className="m-0 mt-3.5 space-y-2 border-t border-rule pt-3">
      {CONTEXT_PARTS.map((p) => {
        const v = u.parts[p.key as keyof typeof u.parts] ?? 0;
        return (
          <div key={p.key}>
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <dt className="text-fg-2">{p.label}</dt>
              <dd className="num m-0 text-fg-3">{compact(v)}</dd>
            </div>
            <div aria-hidden className="mt-1 h-[3px] overflow-hidden rounded-[1.5px] bg-meter-off">
              <div className="h-full" style={{ width: `${Math.min(100, (v / (u.total || 1)) * 100)}%`, background: p.color }} />
            </div>
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

function ConnectorsCard({ session, onManage }: { session: Session; onManage: () => void }) {
  const load = useLoad(() => api().mcp(), []);
  const agent = useHub((s) => s.agents.find((a) => a.name === session.agent));
  const config = useHub((s) => s.config);
  const [busy, setBusy] = useState<string | null>(null);
  const off = sessionMcpOff(session);
  const list = load.data ?? [];
  const forAgent = (name: string) => !agent?.mcpServers || agent.mcpServers.includes(name);
  const onHere = list.filter((st) => st.status === 'connected' && !off.includes(st.name) && forAgent(st.name));
  const configured = Object.keys((config?.mcpServers ?? {}) as Record<string, McpServerConfig>).length;

  const toggle = async (name: string, on: boolean) => {
    setBusy(name);
    const next = on ? off.filter((x) => x !== name) : [...off, name];
    await patchSession(session, { mcpOff: next.length ? next : null }, on ? `${name} is on in this session.` : `${name} is off in this session. Its tools leave the next turn.`);
    setBusy(null);
  };

  const value = !load.data ? (load.error ? 'Not loaded' : '') : list.length ? `${onHere.length} connected` : 'None';
  return (
    <Card id="connectors" title="Connectors" value={value}>
      {load.error && !load.data && <p className={EMPTY}>Could not load the servers. {load.error}</p>}
      {load.data && list.length === 0 && <p className={EMPTY}>{configured ? 'The servers are starting.' : 'No MCP servers yet. Add one to give agents tools such as your notes or GitHub.'}</p>}
      {list.length > 0 && (
        <ul className="m-0 list-none p-0" aria-label="Servers">
          {list.map((st) => {
            const here = !off.includes(st.name);
            const agentOff = !forAgent(st.name);
            const usable = st.status !== 'disabled' && !agentOff;
            return (
              <li key={st.name}>
                <Line right={<OnOff size="sm" label={`${st.name} in this session`} checked={here && usable} disabled={!usable || busy === st.name} onChange={(v) => void toggle(st.name, v)} />}>
                  <span className={cn('block truncate font-mono text-[12.5px]', usable && here ? 'text-fg' : 'text-fg-3')}>{st.name}</span>
                  <span className="block truncate text-[12px] text-fg-3">
                    {st.status === 'connected' ? plural(st.tools, 'tool') : <StatusWord st={st} />}
                    {agentOff && `, not for ${session.agent}`}
                  </span>
                </Line>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2">
        <TextAction label="Manage connectors" onClick={onManage} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function PlanCard({ session }: { session: Session }) {
  const todos = useHub((s) => s.todos[session.id]) ?? [];
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <Card id="plan" title="Plan" value={<span className="num">{`${done} of ${todos.length}`}</span>}>
      <ol className="m-0 list-none p-0">
        {todos.map((t, i) => (
          <li key={i} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2 py-1 text-[13px] leading-[1.45]">
            <span className="num font-mono text-[11px] leading-[19px] text-fg-3">{i + 1}</span>
            <span className={cn(t.status === 'completed' ? 'text-fg-3' : 'text-fg')}>{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
            <span className={cn('text-[12px] leading-[19px]', t.status === 'in_progress' ? 'text-signal' : 'text-fg-3')}>{t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'now' : ''}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Open the call's row in the transcript, the way a click on a changed file does; false when it is not on screen. */
function revealInTranscript(toolUseId: string | undefined): boolean {
  if (!toolUseId) return false;
  const row = revealToolRow(toolUseId);
  if (!row) return false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
  row.style.transition = 'background-color 240ms var(--ease)';
  row.style.backgroundColor = 'var(--bg-hover)';
  setTimeout(() => (row.style.backgroundColor = ''), 1400);
  return true;
}

function OutputsCard({ session }: { session: Session }) {
  const messages = useHub((s) => s.messages[session.id]);
  const list = useMemo(() => sessionOutputs(messages ?? []), [messages]);
  const [shown, setShown] = useState<Output | null>(null);
  const [all, setAll] = useState(false);
  const open = (o: Output) => {
    if (o.page) openPreview({ key: o.key, lang: o.page.lang, code: o.page.code });
    else if (o.kind === 'image' || !revealInTranscript(o.toolUseId)) setShown(o);
  };
  const rows = all ? list : list.slice(0, 8);
  return (
    <Card id="outputs" title="Outputs" value={outputsWord(list)}>
      {list.length === 0 && <p className={EMPTY}>{session.kind === 'chat' ? 'Pages and pictures from the replies show up here.' : 'Files it writes and pictures or pages it makes show up here.'}</p>}
      <ul className="m-0 list-none p-0">
        {rows.map((o) => (
          <li key={o.key}>
            <button type="button" onClick={() => open(o)} title={o.path} className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-3 rounded-[8px] px-1.5 py-1.5 text-left transition-colors duration-[var(--dur-1)] hov:bg-hover">
              {o.image ? <Thumb o={o} /> : null}
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-fg', o.kind === 'file' && 'font-mono text-[12.5px]')}>{o.label}</span>
                {o.detail && <span className={cn('block truncate text-[12px] text-fg-3', o.kind === 'file' && 'font-mono')}>{o.detail}</span>}
              </span>
              <span className="shrink-0 text-[12px] text-fg-3">{o.page ? 'Preview' : o.kind === 'image' ? 'View' : 'Open'}</span>
            </button>
          </li>
        ))}
      </ul>
      {list.length > 8 && (
        <div className="mt-1">
          <TextAction label={all ? 'Fewer' : `${list.length - 8} more`} onClick={() => setAll((x) => !x)} />
        </div>
      )}
      <Dialog open={!!shown} onClose={() => setShown(null)} title={shown?.label} description={shown?.path} width={shown?.image ? 820 : 760}>
        {shown?.image ? (
          <img src={imageSrc(shown)} alt={shown.label} className="max-h-[64vh] w-full rounded-[var(--r-2)] object-contain" />
        ) : shown?.content ? (
          <pre className="t-code m-0 max-h-[60vh] overflow-auto rounded-[var(--r-2)] bg-sunk p-3 text-fg">{shown.content}</pre>
        ) : (
          <p className="m-0 text-[14px] text-fg-2">Its change is in the transcript, in the row of the call that wrote it.</p>
        )}
      </Dialog>
    </Card>
  );
}

function imageSrc(o: Output): string | undefined {
  if (!o.image) return undefined;
  return o.image.url ?? (o.image.data ? `data:${o.image.mediaType};base64,${o.image.data}` : undefined);
}

function Thumb({ o }: { o: Output }) {
  const src = imageSrc(o);
  return src ? <img src={src} alt="" className="size-8 shrink-0 rounded-[6px] object-cover shadow-[0_0_0_1px_var(--rule)]" /> : null;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

function ChangesCard({ session }: { session: Session }) {
  const messages = useHub((s) => s.messages[session.id]);
  const checkpoints = useHub((s) => s.checkpoints[session.id]);
  const diff = useLoad(() => api().diff(session.id), [session.id, messages?.length]);
  const files = useMemo(() => (diff.data?.diff ? parseDiff(diff.data.diff) : []), [diff.data]);
  const [openFile, setOpenFile] = useState<DiffFile | null>(null);
  const [restore, setRestore] = useState<Checkpoint | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const repoMeta = sessionRepo(session);
  const { repo, reload } = useRepoSession(session);
  const pr = useRepoActions(session, repo, reload);
  const canPr = !!repoMeta && !!repo && repoActions(repo).openPr;

  useEffect(() => {
    void loadCheckpoints(session.id);
  }, [session.id]);

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const extra = diff.data ? diff.data.files.length - files.length : 0;

  const showDiff = (f: DiffFile) => {
    const base = fileName(f.path);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-tool-path]')].filter((el) => {
      const p = el.dataset.toolPath ?? '';
      return p === f.path || p.endsWith(`/${base}`) || f.path.endsWith(p);
    });
    // a call in a closed group is a hidden marker: open its group and take the row
    const last = rows[rows.length - 1];
    const ref = last?.dataset.toolRef ?? last?.id.replace(/^tool-/, '');
    if (!revealInTranscript(ref)) setOpenFile(f);
  };

  return (
    <Card
      id="changes"
      title="Changes"
      value={
        files.length ? (
          <span className="num font-mono text-[12.5px]">
            <span className="text-ok">+{added}</span> <span className="text-fault">−{removed}</span>
          </span>
        ) : extra > 0 ? (
          plural(extra, 'file')
        ) : (
          'None'
        )
      }
    >
      {files.length === 0 && extra === 0 && !checkpoints?.length && <p className={EMPTY}>Files it changes show up here, with a checkpoint before each change.</p>}
      {files.length > 0 && (
        <ul className="m-0 list-none p-0">
          {files.map((f) => {
            const parts = slashes(f.path).split('/');
            const name = parts.pop();
            const dir = parts.slice(-2).join('/');
            return (
              <li key={f.path}>
                <button type="button" onClick={() => showDiff(f)} title={f.path} className="-mx-1.5 flex w-[calc(100%+12px)] items-baseline gap-3 rounded-[8px] px-1.5 py-1.5 text-left transition-colors duration-[var(--dur-1)] hov:bg-hover">
                  <span className="mono min-w-0 flex-1 truncate text-fg-3">
                    {dir && `${dir}/`}
                    <span className="text-fg">{name}</span>
                  </span>
                  <span className="num mono shrink-0 text-[12px]">
                    <span className="text-ok">+{f.added}</span> <span className="text-fault">−{f.removed}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {extra > 0 && <p className="m-0 mt-1 text-[12px] text-fg-3">{files.length ? `and ${extra} more without a diff` : `${plural(extra, 'file')} changed, without a diff`}</p>}
      {!!checkpoints?.length && (
        <div className="mt-3 border-t border-rule pt-2.5">
          <div className="pb-1 text-[12px] text-fg-3">Checkpoints</div>
          {[...checkpoints].reverse().map((c) => (
            <Line key={c.id} right={<TextAction label="Restore" onClick={() => setRestore(c)} />}>
              <span className="block truncate text-fg">
                {checkpointLabel(c, messages)}, <span className="num text-fg-3">{hhmm(c.createdAt)}</span>
              </span>
            </Line>
          ))}
        </div>
      )}
      {canPr && (
        <div className="mt-3">
          <Button variant="outline" size="md" busy={pr.busy === 'draft' ? 'Drafting' : false} onClick={() => void pr.startPr()}>
            Create pull request
          </Button>
        </div>
      )}
      {pr.dialogs}

      <Dialog open={!!openFile} onClose={() => setOpenFile(null)} title={openFile ? fileName(openFile.path) : 'Diff'} description={openFile?.path} width={760}>
        {openFile && <Diff file={openFile} header={false} maxLines={400} />}
      </Dialog>

      <ConfirmDialog
        open={!!restore}
        onClose={() => setRestore(null)}
        tone="danger"
        width={480}
        title={restore ? `Restore to ${hhmm(restore.createdAt)}?` : 'Restore?'}
        body={restore ? `${checkpointLabel(restore, messages)}. Messages after this point leave the session.` : undefined}
        confirm="Restore"
        busy="Restoring"
        onConfirm={async () => {
          if (!restore) return;
          // keeps the prompt the checkpoint was taken at; with files, the hub restores this checkpoint
          const s = await attempt(() => api().rewind(session.id, restore.seq, restoreFiles), restoreFiles ? 'Restored the session and its files.' : 'Restored the session.');
          if (s) upsertSession(s);
        }}
      >
        <Checkbox className="mt-3" checked={restoreFiles} onChange={setRestoreFiles} label="Restore files too" description={`Put the ${restore?.files ?? 0 ? `${restore?.files} changed files` : 'files'} back as they were.`} />
      </ConfirmDialog>
    </Card>
  );
}

/** "Before editing auth.ts" from the first edit after the checkpoint. */
function checkpointLabel(c: Checkpoint, messages: Message[] | undefined): string {
  for (const m of messages ?? []) {
    if (m.seq < c.seq) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) {
        const p = String(b.input.file_path ?? b.input.path ?? '');
        if (p) return `Before editing ${fileName(p)}`;
      }
      if (b.type === 'tool_use' && b.name === 'Bash') return `Before ${String(b.input.command ?? 'a command').split(' ').slice(0, 2).join(' ')}`;
    }
  }
  return `Checkpoint ${c.commit.slice(0, 7)}`;
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

type Finished = { key: string; kind: 'workflow' | 'subagent' | 'shell'; title: ReactNode; word: ReactNode; href?: string; at: number };

function TasksCard({ session }: { session: Session }) {
  const running = useRunningTasks(session.id);
  const messages = useHub((s) => s.messages[session.id]);
  const sessions = useHub((s) => s.sessions);
  const runs = useSessionRuns(session.id);
  const shells = useMemo(() => backgroundShells(messages ?? []), [messages]);
  const [folded, setFolded] = useState(true);
  const liveShells = shells.filter((s) => s.state === 'running');

  const finished = useMemo(() => {
    const out: Finished[] = [];
    for (const r of runs) if (!r.parentRunId && !isLive(r.status)) out.push({ key: `w:${r.id}`, kind: 'workflow', title: <>Workflow <span className="font-medium">{r.name}</span></>, word: <StateWord tone={RUN_TONE[r.status]}>{RUN_WORD[r.status]}</StateWord>, href: `/workflows/runs/${r.id}`, at: r.finishedAt ?? r.createdAt });
    for (const c of taskCalls(messages ?? [])) {
      if (c.kind !== 'subagent') continue;
      const s = subagentOf(c, { sessionId: session.id, status: session.status, sessions });
      if (s.state !== 'done' && s.state !== 'failed') continue;
      out.push({ key: `t:${c.tool.id}`, kind: 'subagent', title: <>Subagent {s.agent && <span className="font-medium">{s.agent}: </span>}{s.description}</>, word: <StateWord tone={s.state === 'failed' ? 'fault' : 'dim'}>{s.state === 'failed' ? 'failed' : 'done'}</StateWord>, href: s.childId ? `/s/${s.childId}` : undefined, at: c.at });
    }
    for (const sh of shells) if (sh.state !== 'running') out.push({ key: `b:${sh.id}`, kind: 'shell', title: <>Shell <span className="font-mono text-[12.5px]">{sh.description ?? sh.command}</span></>, word: <StateWord tone={sh.state === 'failed' ? 'fault' : 'dim'}>{sh.state === 'killed' ? 'stopped' : sh.state === 'failed' ? 'failed' : 'done'}</StateWord>, at: sh.startedAt });
    return out.sort((a, b) => b.at - a.at);
  }, [runs, messages, shells, sessions, session.id, session.status]);

  const n = running.length + liveShells.length;
  return (
    <Card id="tasks" title="Background tasks" value={n ? <span className="text-signal">{n} running</span> : finished.length ? `${finished.length} finished` : 'None'}>
      {n === 0 && finished.length === 0 && <p className={EMPTY}>Workflows, subagents and background shells it starts show up here while they run.</p>}
      {n > 0 && (
        <ul className="m-0 list-none p-0" aria-label={tasksWord(n)}>
          {/* by kind, workflows first */}
          {groupByKind(running, taskKind).flatMap((g) => g.items.map((t) => <RunningRow key={t.key} task={t} />))}
          {liveShells.map((sh) => (
            <ShellRow key={sh.id} sh={sh} />
          ))}
        </ul>
      )}
      {finished.length > 0 && (
        <div className={cn(n > 0 && 'mt-2 border-t border-rule pt-1.5')}>
          {/* folded under what runs; with nothing running the card is the list */}
          {n > 0 && (
            <button type="button" aria-expanded={!folded} onClick={() => setFolded((f) => !f)} className="flex h-8 items-center gap-1 text-[12.5px] text-fg-3 hov:text-fg">
              {finished.length} finished
              <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3 transition-transform duration-[var(--dur-1)]', !folded && 'rotate-90')} />
            </button>
          )}
          {(!folded || n === 0) && (
            <ul className="m-0 list-none p-0">
              {finished.map((f) => (
                <li key={f.key}>
                  <Line right={<span className="text-[12px]">{f.word}</span>}>
                    {f.href ? (
                      <Link href={f.href} className="block truncate text-fg-2 hover:text-fg">
                        {f.title}
                      </Link>
                    ) : (
                      <span className="block truncate text-fg-2">{f.title}</span>
                    )}
                  </Line>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function StopButton({ label, onStop }: { label: string; onStop: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="quiet"
      size="sm"
      aria-label={label}
      busy={busy ? 'Stopping' : false}
      onClick={async () => {
        setBusy(true);
        await onStop();
        setBusy(false);
      }}
    >
      Stop
    </Button>
  );
}

/** Pause or Resume next to Stop: paused work waits, kept across restarts, until Resume. */
function PauseButton({ paused, label, onPause, onResume }: { paused: boolean; label: string; onPause: () => Promise<unknown>; onResume: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="quiet"
      size="sm"
      aria-label={`${paused ? 'Resume' : 'Pause'} ${label}`}
      busy={busy ? (paused ? 'Resuming' : 'Pausing') : false}
      onClick={async () => {
        setBusy(true);
        await (paused ? onResume() : onPause());
        setBusy(false);
      }}
    >
      {paused ? 'Resume' : 'Pause'}
    </Button>
  );
}

function RunningRow({ task }: { task: RunningTask }) {
  const childStatus = useHub((s) => (task.kind === 'subagent' && task.childId ? s.sessions[task.childId]?.status : undefined));
  // its session's tokens and bill, as the composer's status line says them
  const used = useHub((s) => {
    const st = task.kind === 'subagent' && task.childId ? s.sessions[task.childId]?.stats : undefined;
    const tokens = st ? st.inputTokens + st.cacheReadTokens + st.outputTokens : 0;
    return st && tokens && task.kind === 'subagent' ? `${compact(tokens)} tokens · ${callCostWord(st.costUsd, tokens, task.model)} · ` : '';
  });
  if (task.kind === 'workflow') {
    const r = task.run;
    const canPause = r.status === 'running' || r.status === 'paused';
    return (
      <li>
        <Line
          right={
            <span className="flex gap-1">
              {canPause && <PauseButton paused={r.status === 'paused'} label={`the workflow ${r.name}`} onPause={() => attempt(() => api().pauseWorkflow(r.id))} onResume={() => attempt(() => api().resumeWorkflow(r.id))} />}
              <StopButton label={`Stop the workflow ${r.name}`} onStop={() => attempt(() => api().stopWorkflow(r.id), `Stopping ${r.name}.`)} />
            </span>
          }
        >
          <Link href={`/workflows/runs/${r.id}`} className="block truncate text-fg hover:underline hover:decoration-rule-2 hover:underline-offset-3">
            <TaskTitle task={task} />
          </Link>
          <span className="block text-[12px]">{r.status === 'running' ? <Elapsed since={r.startedAt ?? r.createdAt} format="short" className="text-signal" /> : r.status === 'paused' ? <PausedWord /> : <StateWord tone={RUN_TONE[r.status]}>{RUN_WORD[r.status]}</StateWord>}</span>
        </Line>
      </li>
    );
  }
  return (
    <li>
      <Line
        right={
          task.childId ? (
            <span className="flex gap-1">
              {childStatus !== 'waiting_reset' && <PauseButton paused={childStatus === 'paused'} label={`the subagent ${task.description}`} onPause={() => attempt(() => api().pauseSession(task.childId!))} onResume={() => attempt(() => api().resumeSession(task.childId!))} />}
              <StopButton label={`Stop the subagent ${task.description}`} onStop={() => attempt(() => api().abort(task.childId!), 'Stopping the subagent.')} />
            </span>
          ) : undefined
        }
      >
        {task.childId ? (
          <Link href={`/s/${task.childId}`} className="block truncate text-fg hover:underline hover:decoration-rule-2 hover:underline-offset-3">
            <TaskTitle task={task} />
          </Link>
        ) : (
          <span className="block truncate text-fg">
            <TaskTitle task={task} />
          </span>
        )}
        {childStatus === 'paused' ? (
          <PausedWord className="flex" />
        ) : (
          <span className="block truncate text-[12px]">
            {(task.model || used) && <span className="num text-fg-3">{task.model && `${modelName(task.model)} · `}{used}</span>}
            <Elapsed since={task.startedAt} format="short" className="text-signal" />
          </span>
        )}
      </Line>
    </li>
  );
}

/** A background shell. The hub has no way to stop one from here yet: the agent stops it with KillShell. */
function ShellRow({ sh }: { sh: BackgroundShell }) {
  return (
    <li>
      <Line>
        <span className="block truncate text-fg" title={sh.command}>
          <span className="text-fg-2">Shell</span> <span className="font-mono text-[12.5px]">{sh.description ?? sh.command}</span>
        </span>
        <span className="block text-[12px]">
          <Elapsed since={sh.startedAt} format="short" className="text-signal" /> <span className="text-fg-3">{sh.id}</span>
        </span>
      </Line>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Memory used
// ---------------------------------------------------------------------------

function MemoryCard({ session }: { session: Session }) {
  const memories = useHub((s) => s.memories);
  const messages = useHub((s) => s.messages[session.id]);
  // memory facts given to this session, plus what it learned
  const used = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages ?? []) {
      const r = m.meta?.recalled ?? m.meta?.memories;
      if (Array.isArray(r)) for (const id of r) if (typeof id === 'string') ids.add(id);
    }
    return Object.values(memories).filter((m) => ids.has(m.id) || m.sourceSessionId === session.id);
  }, [messages, memories, session.id]);
  if (!used.length) return null;
  return (
    <Card id="memory" title="Memory used" value={<span className="num">{used.length}</span>}>
      <div className="space-y-3 pt-1">
        {used.map((m) => (
          <Quote key={m.id} className="text-[13px] leading-[1.5]" cite={m.sourceSessionId === session.id ? `Learned here ${agoText(relTime(m.createdAt))}` : `${m.kind}, ${m.useCount === 1 ? 'used once' : `used ${m.useCount} times`}`}>
            {m.content}
          </Quote>
        ))}
      </div>
      <div className="mt-3">
        <TextAction label="Edit memory" href="/memory" />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Jury and debate
// ---------------------------------------------------------------------------

function GroupCards({ session }: { session: Session }) {
  const messages = useHub((s) => s.messages[session.id]);
  const streaming = useHub((s) => s.streaming);
  const memories = useHub((s) => s.memories);
  const models = useHub((s) => s.models);
  const flatModels = useMemo(() => models.flatMap((g) => g.models), [models]);
  const run = useMemo(() => {
    const list = messages ?? [];
    const last = [...list].reverse().find((m) => m.group);
    if (!last?.group) return undefined;
    const members = list.filter((m) => m.group === last.group && m.kind === 'aside');
    const verdict = list.find((m) => m.group === last.group && m.kind !== 'aside');
    const idx = list.findIndex((m) => m.group === last.group);
    const question = [...list.slice(0, idx)].reverse().find((m) => m.role === 'user');
    return { members, verdict, question };
  }, [messages]);
  const learned = Object.values(memories).filter((m) => m.sourceSessionId === session.id);
  const jury = session.mode === 'jury';
  const a = useMemo(() => (run && jury ? analyzeJury(run, streaming, session.status === 'running', flatModels) : undefined), [run, jury, streaming, session.status, flatModels]);

  const start = run?.question?.createdAt ?? run?.members[0]?.createdAt;
  const end = run?.verdict?.createdAt ?? (session.status === 'running' ? Date.now() : run?.members[run.members.length - 1]?.createdAt);
  const wall = start && end && end > start ? durationShort(end - start) : '';
  const judge = run?.verdict?.model ?? (jury ? session.modeConfig?.jury?.judge : session.modeConfig?.debate?.judge);
  const people = run ? [...new Map(run.members.map((m) => [m.model ?? '', m])).values()] : [];
  const rounds = run ? Math.max(...run.members.map((m, i) => Number(/round\s*(\d+)/i.exec(m.author ?? '')?.[1] ?? Math.floor(i / 2) + 1)), 0) : 0;
  const totalRounds = Math.max(session.modeConfig?.debate?.rounds ?? 0, rounds);

  return (
    <>
      <Card id="run" title="This run" value={<span className="num">{wall || usd(session.stats.costUsd)}</span>}>
        <StatGroup className="mt-1">
          <Stat value={wall || '0s'} label="wall time" />
          <Stat value={usd(session.stats.costUsd)} label="cost" delta={worthLine(session.stats)} />
          {jury ? (
            a && a.winner && !a.pending ? (
              <Stat value={`${a.agree} of ${a.done.length}`} label="agree" />
            ) : (
              <Stat value={`${a?.done.length ?? 0} of ${a?.rows.length ?? 0}`} label="answered" />
            )
          ) : (
            <Stat value={`${rounds} of ${totalRounds}`} label="rounds" />
          )}
        </StatGroup>
      </Card>

      <Card id="jurors" title={jury ? 'Jurors' : 'Debaters'} value={people.length ? <span className="num">{people.length}</span> : undefined}>
        {people.map((m) => {
          const failed = !!(m.meta as { failed?: boolean } | undefined)?.failed || m.stopReason === 'error';
          const side = m.meta?.side as string | undefined;
          const out = run!.members.filter((x) => x.model === m.model).reduce((n, x) => n + (x.usage?.outputTokens ?? Math.round(msgText(x).length / 4)), 0);
          return (
            <div key={m.id} className="flex items-center gap-3 py-1.5 text-[13px]">
              <ModelName model={m.model} size={14} tone="brand" as="model" className="min-w-0 flex-1 text-fg" />
              {side && <span className="shrink-0 text-[12px] text-fg-3">for {side}</span>}
              <span className={cn('num shrink-0 text-[12px]', failed ? 'text-fault' : 'text-fg-3')}>{failed ? 'failed' : `${compact(out)} out`}</span>
            </div>
          );
        })}
        {judge && (
          <div className="flex items-center gap-3 py-1.5 text-[13px]">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <ModelName model={judge} size={14} tone="brand" as="model" className="min-w-0 text-fg" />
              <span className="text-[12px] text-fg-3">judge</span>
            </span>
            <span className="num shrink-0 text-[12px] text-fg-3">{run?.verdict ? `${compact(run.verdict.usage?.outputTokens ?? Math.round(msgText(run.verdict).length / 4))} out` : ''}</span>
          </div>
        )}
        {!people.length && !judge && <p className={EMPTY}>{modelName(session.model)} has not answered yet.</p>}
      </Card>

      {learned.length > 0 && (
        <Card id="learned" title="Memory learned" value={<span className="num">{learned.length}</span>}>
          <div className="space-y-3 pt-1">
            {learned.map((m) => (
              <Quote key={m.id} className="text-[13px] leading-[1.5]" cite={`Saved ${agoText(relTime(m.createdAt))}`}>
                {m.content}
              </Quote>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
