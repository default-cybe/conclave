/**
 * The sheets the "/" menu opens over a session (slash.ts SheetId). Each one
 * acts on this session where that makes sense, and reuses the settings
 * pages' parts: the MCP servers, Hooks and Skills tabs of Extensions, the
 * permission rules of Settings, the model list.
 */
import { useMemo, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { PermissionMode, Session } from '@conclave/core/types';
import { underParent } from '@conclave/core/session/delegated';
import { api } from '@/lib/api';
import { attempt, upsertSession, useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { compact, hhmm, plural, relTime, shortPath, usd } from '@/lib/format';
import { worth, worthLine } from '@/features/usage/value';
import { harnessId, modelName } from '@/lib/models';
import { cn } from '@/lib/text';
import { deviceName, projectGroupOf } from '@/lib/grouping';
import { Checkbox, Radio } from '@/components/ui/Field';
import { KV, SectionHeading, TextAction } from '@/components/ui/Section';
import { Stat, StatGroup } from '@/components/ui/Stat';
import { ModelName } from '@/components/logo';
import { ModelList } from '@/components/pickers/ModelPicker';
import { EffortSegments } from '@/features/conversation/ChatComposer';
import { CyberAccess } from '@/features/conversation/ComposerParts';
import { cyberLabel } from '@conclave/core/providers/access-programs';
import { effortLabel, shownEffort, useModelEffort } from '@/lib/effort';
import { HooksTab } from '@/features/extensions/Hooks';
import { SkillsTab } from '@/features/extensions/Skills';
import { ExtCwdProvider } from '@/features/extensions/project';
import { TrustBanner } from '@/features/extensions/shared/TrustBanner';
import { PermissionsSection } from '@/features/settings/permissions';
import { PERMISSION_MODES } from '../modes';
import { isChat } from '../util';
import { SECTION_WORDS, SHEET_TITLES, sectionsOf, type SheetId, type SlashItem } from '../slash';
import { SessionSheet, SheetRouter } from './SessionSheet';
import { ConnectorsSheet } from './Connectors';
import { ContextSheet } from './ContextSheet';
import { DesignSheet } from './DesignSheet';

/** What the session's folder is: its project's name, else the folder. */
function useWhere(session: Session): string {
  const projects = useHub((s) => s.projects);
  const devices = useHub((s) => s.devices);
  return useMemo(() => {
    const g = projectGroupOf(session, { projects, devices });
    return `${g.key === 'chats' ? shortPath(session.cwd) : g.label} on ${deviceName(session, { devices })}`;
  }, [session, projects, devices]);
}

async function patch(session: Session, p: Parameters<ReturnType<typeof api>['updateSession']>[1], ok?: string) {
  const s = await attempt(() => api().updateSession(session.id, p), ok);
  if (s) upsertSession(s);
}

/** The folder Extensions tabs use: the session's, when the hub can read it (a session on the hub). */
function hubCwd(session: Session): string | undefined {
  return session.device === 'local' || !session.device ? session.cwd : undefined;
}

export function SessionSheets({
  session,
  sheet,
  onClose,
  onOpen,
  items,
  onPick,
}: {
  session: Session;
  sheet: SheetId | null;
  onClose: () => void;
  onOpen: (s: SheetId) => void;
  /** The "/" menu's items, for /help. */
  items: SlashItem[];
  /** Run or fill a command from /help. */
  onPick: (item: SlashItem) => void;
}) {
  const where = useWhere(session);
  const shown = sheet ?? 'help';
  let body: ReactNode = null;
  if (shown === 'mcp') body = <ConnectorsSheet session={session} onClose={onClose} />;
  else if (shown === 'context') body = <ContextSheet session={session} openConnectors={() => onOpen('mcp')} />;
  else if (shown === 'hooks')
    body = (
      <ExtCwdProvider cwd={hubCwd(session)}>
        <SheetRouter base="/extensions/hooks" onLeave={onClose}>
          <HooksTab />
        </SheetRouter>
      </ExtCwdProvider>
    );
  else if (shown === 'skills')
    body = (
      <>
        <p className="m-0 mb-4 text-[13px] leading-[1.45] text-fg-2 phone:text-[15px]">
          Run one with <span className="mono">/name</span> and what it should do. The agent loads it through the Skill tool.
        </p>
        <ExtCwdProvider cwd={hubCwd(session)}>
          <SheetRouter base="/extensions/skills" onLeave={onClose}>
            <SkillsTab />
          </SheetRouter>
        </ExtCwdProvider>
      </>
    );
  else if (shown === 'permissions') body = <PermissionsSheet session={session} />;
  else if (shown === 'agents') body = <AgentsSheet session={session} onClose={onClose} />;
  else if (shown === 'model') body = <ModelSheet session={session} onClose={onClose} />;
  else if (shown === 'memory') body = <MemorySheet session={session} onClose={onClose} />;
  else if (shown === 'cost') body = <CostSheet session={session} />;
  else if (shown === 'status') body = <StatusSheet session={session} />;
  else if (shown === 'resume') body = <ResumeSheet session={session} onClose={onClose} />;
  else if (shown === 'design') body = <DesignSheet session={session} onClose={onClose} />;
  else body = <HelpSheet items={items} onPick={onPick} />;
  return (
    <SessionSheet open={!!sheet} onClose={onClose} title={SHEET_TITLES[shown]} sub={shown === 'help' ? undefined : `${session.title || 'This session'}, ${where}`}>
      {body}
    </SessionSheet>
  );
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

function HelpSheet({ items, onPick }: { items: SlashItem[]; onPick: (item: SlashItem) => void }) {
  return (
    <div className="space-y-5">
      {sectionsOf(items).map((g) => (
        <section key={g.section}>
          <SectionHeading as="h3" count={g.items.length}>
            {SECTION_WORDS[g.section]}
          </SectionHeading>
          <ul className="m-0 list-none p-0">
            {g.items.map((it) => (
              <li key={`${it.section}:${it.name}`}>
                <button type="button" onClick={() => onPick(it)} className="flex min-h-[30px] w-full items-baseline gap-3 rounded-[var(--r-1)] px-1 py-1 text-left text-[13px] hov:bg-hover phone:min-h-11 phone:items-center phone:text-[15px]">
                  <span className="mono shrink-0 text-fg">/{it.name}</span>
                  {it.arg && <span className="mono shrink-0 text-fg-3">{it.arg}</span>}
                  <span className="min-w-0 flex-1 truncate text-fg-3">{it.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:hidden">
        <b className="font-medium text-fg-2">↵</b> send, <b className="font-medium text-fg-2">⇧↵</b> new line, <b className="font-medium text-fg-2">/</b> commands, <b className="font-medium text-fg-2">@</b> files, <b className="font-medium text-fg-2">esc</b> stop a running turn.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /permissions
// ---------------------------------------------------------------------------

function PermissionsSheet({ session }: { session: Session }) {
  const cwd = hubCwd(session);
  return (
    <div className="space-y-7">
      <section>
        <SectionHeading as="h3">This session</SectionHeading>
        <div role="radiogroup" aria-label="Permission mode for this session" className="mt-1">
          {PERMISSION_MODES.map((m) => (
            <Radio key={m.value} name="session-permission" checked={session.permissionMode === m.value} onChange={() => void patch(session, { permissionMode: m.value as PermissionMode }, `${m.label} for this session.`)} label={m.label} description={m.description} className="phone:py-2" />
          ))}
        </div>
      </section>
      <section>
        <SectionHeading as="h3">This project</SectionHeading>
        <p className="m-0 mt-1 text-[13px] leading-[1.45] text-fg-2 phone:text-[15px]">
          Rules in <span className="mono">.claude/settings.json</span> and <span className="mono">.conclave/settings.json</span> of {shortPath(session.cwd)} apply once the folder is trusted.
        </p>
        <TrustBanner cwd={cwd} className="mt-3" />
      </section>
      <section>
        <SectionHeading as="h3">Every session on this hub</SectionHeading>
        <div className="mt-2">
          <PermissionsSection />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /agents
// ---------------------------------------------------------------------------

function AgentsSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const agents = useHub((s) => s.agents);
  const [, navigate] = useLocation();
  const list = useMemo(() => agents.filter((a) => a.primary !== false || a.name === session.agent).sort((a, b) => Number(b.name === session.agent) - Number(a.name === session.agent) || a.name.localeCompare(b.name)), [agents, session.agent]);
  return (
    <div className="space-y-4">
      <ul className="rows m-0 list-none border-t border-rule-2 p-0" aria-label="Agents">
        {list.map((a) => {
          const on = a.name === session.agent;
          return (
            <li key={a.name}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => (on ? undefined : void patch(session, { agent: a.name }, `The ${a.name} agent takes the next turn.`))}
                className={cn('flex w-full items-start gap-3 py-2.5 text-left hov:bg-hover phone:min-h-14', on && 'cursor-default')}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn('text-[13px] font-medium phone:text-[15px]', on ? 'text-fg' : 'text-fg-2')}>{a.name}</span>
                    {on && <span className="text-[12px] text-fg-3">this session</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-fg-3 phone:text-[13px]">{a.description}</span>
                </span>
                {a.model && (
                  <span className="shrink-0 pt-0.5 text-[12px] text-fg-3">
                    <ModelName model={a.model} size={12} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <TextAction
        label="Edit agents"
        onClick={() => {
          onClose();
          navigate('/agents');
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// /model with effort
// ---------------------------------------------------------------------------

function ModelSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const mobile = useIsMobile();
  const messages = useHub((s) => s.messages[session.id]);
  // the levels this model has; a harness offers them once it said which (none hides Effort)
  const effort = useModelEffort(session.model);
  const choose = async (model: string) => {
    if (model === session.model) return onClose();
    // with history, a new model is a switch: the hub notes it, and the next request says who wrote the replies so far
    const s = messages?.length ? await attempt(() => api().handoff(session.id, model), `Switched to ${modelName(model)}.`) : await attempt(() => api().updateSession(session.id, { model }));
    if (s) upsertSession(s);
    onClose();
  };
  return (
    <div className="space-y-5">
      {effort && (
        <section>
          <SectionHeading as="h3">Effort</SectionHeading>
          <div className="mt-1">
            <EffortSegments
              effort={effort}
              size={mobile ? 'touch' : 'sm'}
              full={mobile}
              value={session.chat?.thinking}
              follow={{ value: 'agent', label: 'Agent' }}
              onChange={(v) => void patch(session, { chat: { thinking: v === 'agent' ? null : v } }, v === 'agent' ? 'Effort follows the agent.' : `Effort ${effortLabel(v, effort).toLowerCase()} for this session.`)}
            />
          </div>
          <p className="m-0 mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">How hard it thinks before it answers{effort.default ? `. The model's default is ${effortLabel(effort.default, effort).toLowerCase()}` : ''}. Agent uses what the {session.agent} agent sets.</p>
        </section>
      )}
      {/* Cyber access, where the model takes a program (session.chat.cyber) */}
      <div className="-mx-3">
        <CyberAccess model={session.model} value={session.chat?.cyber} onChange={(v) => void patch(session, { chat: { cyber: v ?? null } }, v ? `Cyber access ${cyberLabel(v)} for this session.` : 'Cyber access back to Default.')} />
      </div>
      <section>
        <SectionHeading as="h3">Model</SectionHeading>
        <div className="-mx-1 mt-1">
          <ModelList value={session.model} onChange={(m) => void choose(m)} onDone={() => undefined} autoFocus={!mobile} />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /memory
// ---------------------------------------------------------------------------

function MemorySheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const memories = useHub((s) => s.memories);
  const messages = useHub((s) => s.messages[session.id]);
  const projects = useHub((s) => s.projects);
  const [, navigate] = useLocation();
  const on = session.chat?.memory !== false;
  const used = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages ?? []) {
      const r = m.meta?.recalled ?? m.meta?.memories;
      if (Array.isArray(r)) for (const id of r) if (typeof id === 'string') ids.add(id);
    }
    return Object.values(memories).filter((m) => ids.has(m.id) || m.sourceSessionId === session.id);
  }, [messages, memories, session.id]);
  const project = session.projectId ? projects[session.projectId] : undefined;
  const roots = useMemo(() => [session.cwd, ...(project?.locations.map((l) => l.path) ?? [])], [session.cwd, project]);
  const here = useMemo(
    () =>
      Object.values(memories)
        .filter((m) => m.scope === 'project' && m.scopeKey && roots.some((r) => m.scopeKey === r || r.startsWith(`${m.scopeKey}/`) || m.scopeKey!.startsWith(`${r}/`)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12),
    [memories, roots],
  );
  return (
    <div className="space-y-6">
      <Checkbox
        checked={on}
        onChange={(v) => void patch(session, { chat: { memory: v } }, v ? 'Memory is on for this session.' : 'Memory is off for this session. It reads and saves nothing.')}
        label="Use memory in this session"
        description="Read what it knows about you and this project, and save what it learns. Off leaves no trace."
      />
      <MemoryList title="Used in this session" items={used} empty="Nothing from memory was used yet." />
      <MemoryList title={project ? `For ${project.name}` : 'For this folder'} items={here} empty="No notes for this project yet." />
      <TextAction
        label="Open Memory"
        onClick={() => {
          onClose();
          navigate('/memory');
        }}
      />
    </div>
  );
}

function MemoryList({ title, items, empty }: { title: string; items: Array<{ id: string; content: string; kind: string; updatedAt: number }>; empty: string }) {
  return (
    <section>
      <SectionHeading as="h3" count={items.length || undefined}>
        {title}
      </SectionHeading>
      {items.length === 0 ? (
        <p className="m-0 mt-1 text-[13px] text-fg-3 phone:text-[15px]">{empty}</p>
      ) : (
        <ul className="m-0 mt-1 list-none space-y-2 p-0">
          {items.map((m) => (
            <li key={m.id} className="border-l border-rule-2 pl-3 text-[13px] leading-[1.45] text-fg-2 phone:text-[15px]">
              {m.content}
              <span className="block text-[12px] text-fg-3">
                {m.kind}, {relTime(m.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// /cost
// ---------------------------------------------------------------------------

function CostSheet({ session }: { session: Session }) {
  const messages = useHub((s) => s.messages[session.id]);
  const models = useHub((s) => s.models);
  const st = session.stats;
  const info = models.flatMap((g) => g.models).find((m) => m.ref === session.model);
  const local = /^(ollama|lmstudio|llamacpp|local)\//.test(session.model);
  const costWord = st.costUsd ? usd(st.costUsd) : local ? 'local' : harnessId(session.model) || !info || (info.inputPrice === 0 && info.outputPrice === 0) ? 'plan' : usd(0);
  const base = st.inputTokens + st.cacheReadTokens;
  const cachePct = base ? Math.round((st.cacheReadTokens / base) * 100) : 0;
  const byModel = useMemo(() => {
    const out = new Map<string, { input: number; output: number; cost: number; value: number; replies: number }>();
    for (const m of messages ?? []) {
      if (m.role !== 'assistant' || !m.usage) continue;
      const key = m.model ?? session.model;
      const cur = out.get(key) ?? { input: 0, output: 0, cost: 0, value: 0, replies: 0 };
      cur.input += m.usage.inputTokens + (m.usage.cacheReadTokens ?? 0) + (m.usage.cacheWriteTokens ?? 0);
      cur.output += m.usage.outputTokens;
      cur.cost += m.usage.costUsd ?? 0;
      cur.value += m.usage.apiValueUsd ?? m.usage.costUsd ?? 0;
      cur.replies += 1;
      out.set(key, cur);
    }
    return [...out.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].input - a[1].input);
  }, [messages, session.model]);
  return (
    <div className="space-y-6">
      <StatGroup>
        <Stat value={costWord} label="Cost" delta={worthLine(st)} />
        <Stat value={compact(st.inputTokens + st.cacheReadTokens)} label="Tokens in" />
        <Stat value={compact(st.outputTokens)} label="Tokens out" />
        <Stat value={`${cachePct}%`} label="From cache" />
      </StatGroup>
      {byModel.length > 0 && (
        <section>
          <SectionHeading as="h3">By model</SectionHeading>
          <dl className="m-0 mt-1">
            {byModel.map(([ref, v]) => (
              <div key={ref} className="flex items-baseline gap-3 border-b border-rule py-2 text-[13px] phone:text-[15px]">
                <dt className="min-w-0 flex-1 truncate">
                  <ModelName model={ref} size={13} />
                </dt>
                <dd className="num m-0 text-fg-3">
                  {plural(v.replies, 'reply', 'replies')}, {compact(v.input)} in, {compact(v.output)} out{v.cost ? `, ${usd(v.cost)}` : ''}
                  {worthLine({ costUsd: v.cost, apiValueUsd: v.value }) ? `, ${worthLine({ costUsd: v.cost, apiValueUsd: v.value })}` : ''}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{costWord === 'plan' ? `This model runs on a plan or subscription, so its turns have no price per token.${worthLine(st) ? ` At API prices they would have cost ${usd(worth(st))}.` : ''}` : `${plural(st.messages, 'message')} so far. Usage by day and model is on the Usage page.`}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

function StatusSheet({ session }: { session: Session }) {
  const hub = useHub((s) => s.hub);
  const conn = useHub((s) => s.conn);
  const device = useHub((s) => s.devices[session.device || 'local']);
  const mcp = useHub((s) => s.mcp);
  const projects = useHub((s) => s.projects);
  const project = session.projectId ? projects[session.projectId] : undefined;
  const perm = PERMISSION_MODES.find((p) => p.value === session.permissionMode)?.label ?? session.permissionMode;
  const effort = useModelEffort(session.model);
  const off = Array.isArray(session.meta?.mcpOff) ? (session.meta.mcpOff as string[]) : [];
  const connected = mcp.filter((m) => m.status === 'connected' && !off.includes(m.name)).length;
  return (
    <dl className="m-0">
      <KV k="Model">
        <ModelName model={session.model} size={13} />
        {session.chat?.thinking ? <span className="text-fg-3">, effort {effortLabel((effort && shownEffort(session.chat.thinking, effort)) || session.chat.thinking).toLowerCase()}</span> : null}
      </KV>
      <KV k="Agent">{session.agent}</KV>
      <KV k="Mode">{session.mode[0].toUpperCase() + session.mode.slice(1)}</KV>
      <KV k="Permissions">{perm}</KV>
      <KV k="Device">
        {device?.name ?? session.device}
        <span className="text-fg-3">{device?.online === false ? ', offline' : ', online'}</span>
      </KV>
      <KV k="Folder" mono>
        {session.cwd}
      </KV>
      <KV k="Project">{project ? `${project.name}, ${plural(project.locations.length, 'location')}` : <span className="text-fg-3">Not known yet. It is learned when a turn ends.</span>}</KV>
      <KV k="Connectors">
        {plural(connected, 'server')} on{off.length ? <span className="text-fg-3">, {off.length} off here</span> : null}
      </KV>
      <KV k="Memory">{session.chat?.memory === false ? 'Off for this session' : 'On'}</KV>
      <KV k="Hub">
        {hub ? `${hub.name}, ${hub.version}` : 'Unknown'}
        <span className="text-fg-3">, {conn === 'open' ? 'connected' : conn}</span>
      </KV>
      <KV k="Session" mono>
        {session.id}
      </KV>
      <KV k="Started">{`${relTime(session.createdAt)}, at ${hhmm(session.createdAt)}`}</KV>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// /resume
// ---------------------------------------------------------------------------

function ResumeSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const sessions = useHub((s) => s.sessions);
  const projects = useHub((s) => s.projects);
  const devices = useHub((s) => s.devices);
  const groups = useMemo(() => {
    const ctx = { projects, devices };
    const mine = projectGroupOf(session, ctx).key;
    const list = Object.values(sessions)
      .filter((s) => s.id !== session.id && !underParent(s) && !isChat(s) && !(s.meta as { workflow?: unknown } | undefined)?.workflow)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const same = mine === 'chats' ? [] : list.filter((s) => projectGroupOf(s, ctx).key === mine).slice(0, 12);
    const rest = list.filter((s) => !same.includes(s)).slice(0, 15);
    return [
      { label: mine === 'chats' ? '' : `In ${projectGroupOf(session, ctx).label}`, items: same },
      { label: 'Recent', items: rest },
    ].filter((g) => g.items.length);
  }, [sessions, projects, devices, session]);
  return (
    <div className="space-y-5">
      {groups.length === 0 && <p className="m-0 text-[13px] text-fg-3 phone:text-[15px]">No other sessions yet.</p>}
      {groups.map((g) => (
        <section key={g.label}>
          <SectionHeading as="h3" count={g.items.length}>
            {g.label}
          </SectionHeading>
          <ul className="m-0 mt-1 list-none p-0">
            {g.items.map((s) => (
              <li key={s.id}>
                <Link href={`/s/${s.id}`} onClick={onClose} className="flex min-h-[34px] items-baseline gap-3 rounded-[var(--r-1)] px-1 py-1.5 text-[13px] hov:bg-hover phone:min-h-11 phone:items-center phone:text-[15px]">
                  <span className="min-w-0 flex-1 truncate text-fg">{s.title || 'New session'}</span>
                  <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{deviceName(s, { devices })}</span>
                  <span className="num w-14 shrink-0 text-right text-[12px] text-fg-3 phone:text-[13px]">{relTime(s.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
