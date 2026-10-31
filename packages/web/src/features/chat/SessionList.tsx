/**
 * The session list (spec 11.2.1): a filter and New on top, then groups by
 * state (Waiting on you, Running, Waiting for reset), pinned, then by time.
 * Rows are words: title, a meta line with a mono logo, time and a state word.
 * Enter in the filter searches every message.
 *
 * Group by (the list options): Recent (the above), Project (one group per
 * project across devices, each row saying its device), Device, Agent and
 * Task. The choice is kept on this device (lib/grouping.ts).
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import { isDelegated, underParent } from '@conclave/core/session/delegated';
import { isUnread } from '@conclave/core/session/unread';
import { IMPORTED_KEY, IMPORTED_WORDS, byImportedDate, importedLabel, inImported } from '@conclave/core/session/imported';
import { api } from '@/lib/api';
import { attempt, removeKey, retainTranscript, upsertSession, useHub } from '@/store/store';
import { openNewChat, useUi, type ListGroup } from '@/store/ui';
import { cn, fuzzy } from '@/lib/text';
import { hhmm, relTime } from '@/lib/format';
import { useCoarsePointer, useIsMobile, useNow } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { openImportSheet } from '@/features/import/store';
import { isDuplicateCopy } from '@/features/import/ImportedLine';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { MOD } from '@/components/ui/Kbd';
import { SelectedMark, STATE_TEXT } from '@/components/ui/List';
import { InlineModel, MetaText } from './Log';
import { ConfirmDialog, MenuList, Popover, Sheet } from '@/components/ui/Overlay';
import { Elapsed } from '@/components/motion';
import { isTyping } from '@/components/Shell';
import { msgText, plain, splitVerdict, turnStartedAt, verdictWord } from './util';
import { branchShort, sessionRepo } from '@/lib/github';
import { deviceName, GROUP_WORDS, groupSessions } from '@/lib/grouping';
import { ShareProjectButton } from '@/features/friends/ShareProject';

const DAY = 86_400_000;

type Hit = { sessionId: string; messageId: string; snippet: string; title: string };

function startOfToday(now: number) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function stateGroup(s: Session): 'waiting' | 'running' | 'reset' | null {
  if (s.status === 'waiting_approval' || s.status === 'waiting_input') return 'waiting';
  if (s.status === 'running') return 'running';
  if (s.status === 'waiting_reset') return 'reset';
  return null;
}

export function SessionList({ activeId }: { activeId?: string }) {
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const tasks = useHub((s) => s.tasks);
  const projects = useHub((s) => s.projects);
  const group = useUi((s) => s.listGroup);
  const showArchived = useUi((s) => s.showArchived);
  const pinnedOnly = useUi((s) => s.pinnedOnly);
  const set = useUi((s) => s.set);
  const mobile = useIsMobile();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<Session | null>(null);
  const [del, setDel] = useState<Session | null>(null);
  const coarse = useCoarsePointer();
  const menuRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const now = useNow(30_000);

  const groups = useMemo(() => {
    const needle = q.trim();
    // every conversation: chats too, which group under Chats by project; a search finds delegated work as well
    // imported chats not continued yet are not the archive: they have a group of their own, last (core session/imported.ts)
    let list = Object.values(sessions).filter((s) => (!underParent(s) || (!!needle && isDelegated(s))) && (showArchived ? s.archived && !inImported(s) : !s.archived || inImported(s)) && (!pinnedOnly || s.pinned) && !isDuplicateCopy(s));
    if (needle) list = list.filter((s) => fuzzy(needle, `${s.title} ${s.agent} ${modelName(s.model)} ${s.tags.join(' ')} ${devices[s.device]?.name ?? ''}`) >= 0);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    const imported = list.filter(inImported).sort(byImportedDate);
    list = list.filter((s) => !inImported(s));
    const tail = imported.length ? [{ key: IMPORTED_KEY, label: IMPORTED_WORDS, items: imported, tone: undefined as 'warn' | undefined }] : [];
    const out: Array<{ key: string; label: string; tone?: 'warn'; items: Session[] }> = [];
    const push = (key: string, label: string, s: Session, tone?: 'warn') => {
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, label, tone, items: [] }));
      g.items.push(s);
    };
    // one group per project across devices, or per device, newest first (lib/grouping.ts)
    if (group === 'project' || group === 'device') return [...groupSessions(list, group, { projects, devices }).map((g) => ({ key: g.key, label: g.label, items: g.items, tone: undefined as 'warn' | undefined })), ...tail];
    if (group !== 'date') {
      for (const s of list) {
        if (group === 'agent') push(`a:${s.agent}`, s.agent, s);
        else push(`t:${s.taskId ?? ''}`, s.taskId ? (tasks[s.taskId]?.title ?? 'Task') : 'No task', s);
      }
      return [...out, ...tail];
    }
    const today = startOfToday(now);
    const order = ['waiting', 'running', 'reset', 'pinned', 'today', 'week', 'earlier'];
    for (const s of list) {
      const st = showArchived ? null : stateGroup(s);
      if (st === 'waiting') push('waiting', 'Waiting on you', s, 'warn');
      else if (st === 'running') push('running', 'Running', s);
      else if (st === 'reset') push('reset', 'Waiting for reset', s);
      else if (s.pinned && !showArchived) push('pinned', 'Pinned', s);
      else if (s.updatedAt >= today) push('today', 'Today', s);
      else if (s.updatedAt >= today - 6 * DAY) push('week', 'This week', s);
      else push('earlier', 'Earlier', s);
    }
    return [...out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)), ...tail];
  }, [sessions, devices, projects, tasks, group, showArchived, pinnedOnly, q, now]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // jury and debate rows show their verdict, which lives in the messages
  useEffect(() => {
    const want = flat.filter((s) => s.mode === 'jury' || s.mode === 'debate').slice(0, 6);
    const release = want.map((s) => retainTranscript(s.id));
    return () => release.forEach((r) => r());
  }, [flat]);

  // j/k and ]/[ move between sessions; / focuses the filter when no composer is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (useUi.getState().paletteOpen || document.querySelector('[role=dialog][aria-modal=true]')) return;
      if (e.key === '/' && !document.querySelector('[data-composer]')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        filterRef.current?.focus();
        return;
      }
      const down = e.key === 'j' || e.key === ']';
      const up = e.key === 'k' || e.key === '[';
      if (!down && !up) return;
      const i = flat.findIndex((s) => s.id === activeId);
      const next = flat[down ? Math.min(flat.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
      if (next) {
        e.preventDefault();
        navigate(`/s/${next.id}`);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flat, activeId, navigate]);

  const typed = useRef(q);
  typed.current = q;
  const search = async () => {
    const needle = q.trim();
    if (!needle) return;
    setSearching(true);
    const found = await api()
      .search(needle)
      .catch(() => []);
    setSearching(false);
    // typed on while it searched: these hits answer words the box no longer holds
    if (typed.current.trim() !== needle) return;
    setHits(found);
  };

  const viewNote = group !== 'date' || pinnedOnly;
  const groupWord: Record<ListGroup, string> = { date: 'state and time', project: 'project', agent: 'agent', device: 'device', task: 'task' };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-3 phone:pt-3">
        <Input
          ref={filterRef}
          size="sm"
          value={q}
          kbd={mobile ? undefined : '/'}
          aria-label="Filter sessions"
          placeholder={mobile ? 'Filter or search' : 'Filter'}
          enterKeyHint="search"
          onChange={(e) => {
            setQ(e.target.value);
            if (hits) setHits(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
            if (e.key === 'Escape' && (q || hits)) {
              e.preventDefault();
              e.stopPropagation();
              setQ('');
              setHits(null);
            }
          }}
          className="min-w-0 flex-1"
        />
        {!mobile && (
          <Button variant="solid" size="md" onClick={() => openNewChat()} title={`New session (${MOD} N)`}>
            New
          </Button>
        )}
        <IconButton ref={menuRef} label="List options" aria-haspopup="menu" aria-expanded={menu} active={menu} size={mobile ? 'lg' : 'md'} onClick={() => setMenu((m) => !m)} className="-mr-1.5">
          <MoreHorizontal />
        </IconButton>
        <Popover anchor={menuRef} open={menu} onClose={() => setMenu(false)} placement="bottom-end" width={230} label="List options" sheetTitle="List options">
          <MenuList
            onDone={() => setMenu(false)}
            label="List options"
            items={[
              { group: true, label: 'Group by' },
              ...(['date', 'project', 'device', 'agent', 'task'] as ListGroup[]).map((g) => ({ label: GROUP_WORDS[g], checked: group === g, onSelect: () => set({ listGroup: g }) })),
              { separator: true, label: '' },
              { label: 'Pinned only', checked: pinnedOnly, onSelect: () => set({ pinnedOnly: !pinnedOnly }) },
              { label: 'Archived', checked: showArchived, onSelect: () => set({ showArchived: !showArchived }) },
              { separator: true, label: '' },
              { label: 'Import past chats', onSelect: () => openImportSheet() },
            ]}
          />
        </Popover>
      </div>

      {(viewNote || showArchived) && !hits && (
        <p className="shrink-0 px-4 pb-2 text-[12px] text-fg-3 phone:text-[13px]">
          {showArchived ? 'Archived sessions' : 'All sessions'}
          {group !== 'date' && `, by ${groupWord[group]}`}
          {pinnedOnly && ', pinned only'}.{' '}
          <button type="button" className="link text-[12px] phone:text-[13px]" onClick={() => set({ listGroup: 'date', pinnedOnly: false, showArchived: false })}>
            Reset
          </button>
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4" role="navigation" aria-label="Sessions">
        {hits ? (
          <SearchHits hits={hits} query={q.trim()} searching={searching} activeId={activeId} onClear={() => setHits(null)} />
        ) : (
          <>
            {groups.length === 0 && (
              <p className="px-4 py-6 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">
                {q ? (
                  <>
                    No session title matches "{q}". Press <b className="font-medium text-fg-2">↵</b> to search inside messages.
                  </>
                ) : showArchived ? (
                  'Nothing is archived.'
                ) : (
                  'No sessions yet. Start one with New.'
                )}
              </p>
            )}
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <h2 className={cn('flex items-baseline gap-1.5 px-4 pt-3.5 pb-1 text-[12px] font-semibold phone:text-[13px]', g.tone === 'warn' ? 'text-warn' : 'text-fg-3')}>
                  {g.label}
                  {g.key !== 'today' && g.key !== 'week' && g.key !== 'earlier' && <span className="num font-[450] text-fg-3">{g.items.length}</span>}
                  {g.key.startsWith('p:') && <ShareProjectButton projectId={g.key.slice(2)} name={g.label} phone={mobile} className="ml-auto" />}
                </h2>
                {g.items.map((s) => (
                  <SessionRow key={s.id} s={s} active={s.id === activeId} onMenu={coarse ? () => setRowMenu(s) : undefined} device={group === 'project' ? deviceName(s, { devices }) : undefined} imported={g.key === IMPORTED_KEY ? importedLabel(s, now) : undefined} />
                ))}
              </section>
            ))}
            {!showArchived && !q && (
              <button type="button" onClick={() => set({ showArchived: true })} className="link mx-4 mt-4 text-[12px] phone:text-[13px]">
                Show archived
              </button>
            )}
          </>
        )}
      </div>

      {/* long press on a row (touch): its menu as a sheet */}
      <Sheet open={!!rowMenu} onClose={() => setRowMenu(null)} title={rowMenu?.title}>
        {rowMenu && (
          <MenuList
            onDone={() => setRowMenu(null)}
            label="Session actions"
            items={[
              { label: 'Open', onSelect: () => navigate(`/s/${rowMenu.id}`) },
              { label: rowMenu.pinned ? 'Unpin' : 'Pin to the top', onSelect: () => patchSession(rowMenu, { pinned: !rowMenu.pinned }) },
              { label: rowMenu.archived ? 'Unarchive' : 'Archive', onSelect: () => patchSession(rowMenu, { archived: !rowMenu.archived }) },
              { label: 'Delete', danger: true, onSelect: () => setTimeout(() => setDel(rowMenu), 0) },
            ]}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        title={del ? `Delete ${del.title}?` : 'Delete?'}
        body="Its messages leave the hub. Archive keeps them out of the list instead."
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          if (!del) return;
          const ok = await attempt(() => api().deleteSession(del.id));
          if (ok) {
            removeKey('sessions', del.id);
            if (del.id === activeId) navigate('/sessions');
          }
        }}
      />
    </div>
  );
}

async function patchSession(s: Session, p: { pinned?: boolean; archived?: boolean }) {
  const next = await attempt(() => api().updateSession(s.id, p));
  if (next) upsertSession(next);
}

function SessionRow({ s, active, onMenu, device, imported }: { s: Session; active: boolean; onMenu?: () => void; device?: string; imported?: string }) {
  const rowMeta = useRowMeta(s, device);
  // under Imported the line says where it came from and when it started there
  const meta = imported ?? rowMeta;
  const messages = useHub((st) => (s.status === 'running' ? st.messages[s.id] : undefined));
  let state: ReactNode;
  let tone: 'warn' | 'fault' | 'dim' | 'signal' = 'dim';
  if (s.status === 'waiting_approval') {
    state = 'approve';
    tone = 'warn';
  } else if (s.status === 'waiting_input') {
    state = 'answer';
    tone = 'warn';
  } else if (s.status === 'error') {
    state = 'failed';
    tone = 'fault';
  } else if (s.status === 'waiting_reset') state = s.resumeAt ? `resumes ${hhmm(s.resumeAt)}` : 'waiting for reset';
  else if (s.status === 'running') {
    state = <Elapsed since={turnStartedAt(messages, s)} format="short" className="text-signal" />;
    tone = 'signal';
  }
  return (
    <Row href={`/s/${s.id}`} active={active} unread={isUnread(s)} title={s.title} time={relTime(s.updatedAt)} onMenu={onMenu}>
      <span className="min-w-0">{meta}</span>
      <span className={cn('state-word text-right whitespace-nowrap', STATE_TEXT[tone])}>{state}</span>
    </Row>
  );
}

/**
 * A session row (spec 10.2): title and time on line 1, meta and state on
 * line 2, on one grid so the right column lines up. Selected rows get bg-raise
 * and the 2px fg bar, the only edge bar in the product.
 */
function Row({ href, active, unread, title, time, children, onMenu }: { href: string; active: boolean; unread?: boolean; title: ReactNode; time?: ReactNode; children: ReactNode; onMenu?: () => void }) {
  return (
    <Link
      href={href}
      onContextMenu={
        onMenu
          ? (e: ReactMouseEvent) => {
              e.preventDefault();
              onMenu();
            }
          : undefined
      }
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-4 py-[9px] text-[12px] leading-[1.4] text-fg-3 transition-colors duration-[var(--dur-1)] phone:py-3 phone:text-[13px]',
        active ? 'bg-raise' : 'hover:bg-hover',
      )}
    >
      {active && <SelectedMark />}
      <span className={cn('t-row truncate text-fg', unread && 'font-semibold')}>
        {title}
        {unread && <span className="sr-only">, new reply</span>}
      </span>
      <span className="num text-right">{time}</span>
      {children}
    </Link>
  );
}

/** "coder, [logo] Sonnet 5.5", "Jury of 4, verdict Caddy", "Routine, [logo] Gemini 3 Flash". Grouped by project, the device leads: "MacBook, coder, ...". */
function useRowMeta(s: Session, device?: string): ReactNode {
  const routine = useHub((st) => (s.routineId ? st.routines[s.routineId] : undefined));
  const verdict = useHub((st) => {
    if (s.mode !== 'jury' && s.mode !== 'debate') return undefined;
    const list = st.messages[s.id];
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.group && m.kind !== 'aside' && m.role === 'assistant') return verdictWord(splitVerdict(msgText(m)).sentence);
    }
    return undefined;
  });
  const model = <InlineModel model={s.model} />;
  // a repo session: its repository and branch (docs/DESIGN.md 30)
  const repo = sessionRepo(s);
  if (repo) return <MetaText parts={[repo.repo, branchShort(repo.branch)]} />;
  if (s.mode === 'jury') return <MetaText parts={[`Jury of ${s.modeConfig?.jury?.jurors.length ?? 0}`, verdict && `verdict ${verdict}`]} />;
  if (s.mode === 'debate') {
    const d = s.modeConfig?.debate;
    return <MetaText parts={['Debate', verdict ? `verdict ${verdict}` : d ? `${modelName(d.a)} and ${modelName(d.b)}` : null]} />;
  }
  // grouped by project, an imported chat says so where the agent would be
  const who = routine ? 'Routine' : device && s.tags.includes('imported') ? 'imported' : s.agent;
  return <MetaText parts={[device, who, model]} />;
}

function SearchHits({ hits, query, searching, activeId, onClear }: { hits: Hit[]; query: string; searching: boolean; activeId?: string; onClear: () => void }) {
  // one title per session, its matching messages under it
  const bySession = useMemo(() => {
    const out: Array<{ sessionId: string; title: string; items: Hit[] }> = [];
    for (const h of hits) {
      let g = out.find((x) => x.sessionId === h.sessionId);
      if (!g) out.push((g = { sessionId: h.sessionId, title: h.title, items: [] }));
      g.items.push(h);
    }
    return out;
  }, [hits]);
  const sessions = bySession.length;
  return (
    <div>
      <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-1 text-[12px] font-semibold text-fg-3 phone:text-[13px]">
        <span>
          {searching
            ? 'Searching messages'
            : hits.length
              ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}${sessions > 1 ? ` in ${sessions} sessions` : ''}`
              : 'No matches'}
        </span>
        <button type="button" onClick={onClear} className="link ml-auto text-[12px] font-normal">
          Back to the list
        </button>
      </div>
      {!searching && hits.length === 0 && <p className="px-4 py-3 text-[13px] text-fg-3">Nothing in any message matches "{query}".</p>}
      {bySession.map((g) => (
        <section key={g.sessionId} className="pb-1.5">
          <Link href={`/s/${g.sessionId}`} aria-current={g.sessionId === activeId ? 'page' : undefined} className={cn('t-row block truncate px-4 pt-2.5 pb-0.5 text-fg hover:underline hover:decoration-rule-2 hover:underline-offset-3')}>
            {g.title || 'Untitled'}
          </Link>
          {g.items.slice(0, 4).map((h) => (
            <Link
              key={h.messageId}
              href={`/s/${h.sessionId}#${h.messageId}`}
              className="block px-4 py-1 text-[12px] leading-[1.45] text-fg-3 transition-colors duration-[var(--dur-1)] hover:bg-hover phone:py-2 phone:text-[13px]"
            >
              <span className="line-clamp-2">{snippetParts(h.snippet, query)}</span>
            </Link>
          ))}
          {g.items.length > 4 && (
            <Link href={`/s/${g.sessionId}#${g.items[4].messageId}`} className="link mx-4 my-1 inline-block text-[12px] phone:text-[13px]">
              {g.items.length - 4} more in this session
            </Link>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * The hub marks matches as [word] and cut ends with an ellipsis. Matches turn
 * fg 560; text cut mid word at either end is trimmed to the word and marked.
 */
function snippetParts(raw: string, query: string): ReactNode {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  let snip = plain(raw).trim();
  const marked = /\[[^\]\n]{1,80}\]/.test(snip) && terms.some((t) => new RegExp(`\\[[^\\]]*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(snip));
  if (!marked && !/^[…A-Z0-9"'(`]/.test(snip)) {
    const sp = snip.indexOf(' ');
    if (sp > 0 && sp < 18) snip = '…' + snip.slice(sp + 1);
  }
  if (!marked && !/[.!?:…)"'`]$/.test(snip)) {
    const sp = snip.lastIndexOf(' ');
    if (sp > snip.length - 18) snip = snip.slice(0, sp).replace(/[,;:]$/, '') + '…';
  }
  const out: ReactNode[] = [];
  if (marked) {
    const re = /\[([^\]\n]{1,80})\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(snip))) {
      out.push(snip.slice(last, m.index));
      out.push(
        <span key={m.index} className="font-[560] text-fg">
          {m[1]}
        </span>,
      );
      last = m.index + m[0].length;
    }
    out.push(snip.slice(last));
    return out;
  }
  const lower = snip.toLowerCase();
  const needle = terms.find((t) => lower.includes(t)) ?? query.toLowerCase();
  const i = needle ? lower.indexOf(needle) : -1;
  if (i < 0) return snip;
  return (
    <>
      {snip.slice(0, i)}
      <span className="font-[560] text-fg">{snip.slice(i, i + needle.length)}</span>
      {snip.slice(i + needle.length)}
    </>
  );
}
