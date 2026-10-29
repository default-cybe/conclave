/**
 * Chats and Code on a phone (docs/design/MOBILE-V2.md 6): a search field,
 * then one row per conversation, newest first. A row is the title with the
 * time at its right, and a second line only when it says something:
 * "Running", "Waiting for you", "Failed". Archived is a row at the end, and
 * opens the archived ones. Typing filters titles; Enter searches every
 * message.
 *
 * Chats are conversations with the assistant (they update memory); Code is
 * agent sessions on your devices. Code has Group by under the search:
 * Recent, Project (one group per project across devices, each row with its
 * device) or Device, kept on this device (lib/grouping.ts).
 */
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ChevronRight, Search, X } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import { underParent } from '@conclave/core/session/delegated';
import { isUnread } from '@conclave/core/session/unread';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { cn, fuzzy } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { askHome } from '@/lib/asks';
import { repoWhere, sessionRepo } from '@/lib/github';
import { deviceName, GROUP_WORDS, groupSessions } from '@/lib/grouping';
import { useUi, type ListGroup } from '@/store/ui';
import { Segmented } from '@/components/ui/Field';
import { modelName } from '@/lib/models';
import { hrefOf, liveState } from '@/lib/recents';
import { usePageHeader } from '@/components/ui/Page';
import { ImportSheet } from '@/features/import/ImportSheet';
import { isDuplicateCopy } from '@/features/import/ImportedLine';
import { ShareProjectButton } from '@/features/friends/ShareProject';
import { isChat } from './util';
import { AsciiField } from '@/components/ascii/AsciiField';

type Kind = 'chats' | 'code';
type Hit = { sessionId: string; messageId: string; snippet: string; title: string };

const WORDS: Record<Kind, { root: string; empty: string; archivedEmpty: string; search: string }> = {
  chats: { root: '/chats', empty: 'Chats you start show up here. Each one can add to what the assistant remembers.', archivedEmpty: 'No archived chats.', search: 'Search chats' },
  code: { root: '/sessions', empty: 'Sessions an agent runs on your devices show up here. Switch Home to Code to start one.', archivedEmpty: 'No archived sessions.', search: 'Search sessions' },
};

export function PhoneChats({ kind }: { kind: Kind }) {
  const search = useSearch();
  const archived = new URLSearchParams(search).has('archived');
  const words = WORDS[kind];
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const projects = useHub((s) => s.projects);
  const approvals = useHub((s) => s.approvals);
  const questions = useHub((s) => s.questions);
  const booted = useHub((s) => s.booted);
  const now = useNow(60_000);
  // phones offer Recent, Project and Device; Agent and Task stay on the desktop list
  const stored = useUi((s) => s.listGroup);
  const group: PhoneGroup = kind === 'code' && (stored === 'project' || stored === 'device') ? stored : 'date';
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const typed = useRef(q);
  typed.current = q;
  // the archived list leads back to the list
  usePageHeader(archived ? (kind === 'chats' ? 'Archived chats' : 'Archived sessions') : undefined, words.root);

  const mine = (s: Session) => !isDuplicateCopy(s) && (kind === 'chats' ? isChat(s) : !isChat(s) && !underParent(s) && !(s.meta as { workflow?: unknown } | undefined)?.workflow);
  const all = useMemo(() => Object.values(sessions).filter(mine), [sessions, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const archivedCount = useMemo(() => all.filter((s) => s.archived).length, [all]);
  // a subagent's request waits on you in the conversation it shows in (lib/asks.ts)
  const waiting = useMemo(() => new Set([...Object.values(approvals), ...Object.values(questions)].flatMap((x) => [x.sessionId, askHome(x)])), [approvals, questions]);
  const list = useMemo(() => {
    const needle = q.trim();
    let out = all.filter((s) => s.archived === archived);
    if (needle) out = out.filter((s) => fuzzy(needle, `${s.title} ${kind === 'code' ? `${s.agent} ${modelName(s.model)} ${devices[s.device]?.name ?? ''}` : ''}`) >= 0);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [all, archived, q, kind, devices]);
  const groups = useMemo(() => (group === 'date' ? undefined : groupSessions(list, group, { projects, devices })), [list, group, projects, devices]);

  const runSearch = async () => {
    const needle = q.trim();
    if (needle.length < 2) return;
    setSearching(true);
    setHits([]);
    const found = await attempt(() => api().search(needle));
    setSearching(false);
    if (typed.current.trim() !== needle) return;
    setHits((found ?? []).filter((h) => sessions[h.sessionId] && mine(sessions[h.sessionId])));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-1 pb-2">
        <label className="relative flex h-11 items-center rounded-[12px] bg-surface-2">
          <Search className="pointer-events-none absolute left-3 size-[18px] text-fg-3" strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            value={q}
            aria-label={words.search}
            placeholder="Search"
            enterKeyHint="search"
            autoComplete="off"
            onChange={(e) => {
              setQ(e.target.value);
              if (hits) setHits(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runSearch();
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent pr-11 pl-10 text-[16px] text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={() => {
                setQ('');
                setHits(null);
              }}
              className="absolute right-0 grid size-11 place-items-center text-fg-3"
            >
              <X className="size-[18px]" strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </label>
        {kind === 'code' && !archived && (
          <Segmented
            size="touch"
            full
            label="Group by"
            value={group}
            onChange={(g) => useUi.getState().set({ listGroup: g as ListGroup })}
            options={PHONE_GROUPS.map((g) => ({ value: g, label: GROUP_WORDS[g] }))}
            className="mt-2"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        {hits ? (
          <Hits hits={hits} searching={searching} query={q.trim()} sessions={sessions} />
        ) : list.length === 0 ? (
          booted && (
            <>
              {!q && !archived && (
                <div className="mt-4 px-5">
                  <AsciiField align="start" size={11} className="h-24" />
                </div>
              )}
              <p className="m-0 px-5 py-3 text-[15px] leading-[1.45] text-pretty text-fg-3">{q ? `Nothing here is called "${q.trim()}". Press Search on the keyboard to look inside messages.` : archived ? words.archivedEmpty : words.empty}</p>
            </>
          )
        ) : groups ? (
          groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h2 className="m-0 flex items-baseline gap-1.5 px-5 pt-4 pb-1 text-[13px] font-medium text-fg-3">
                <span className="min-w-0 truncate">{g.label}</span>
                <span className="num font-normal">{g.items.length}</span>
                {g.key.startsWith('p:') && <ShareProjectButton projectId={g.key.slice(2)} name={g.label} phone className="ml-auto" />}
              </h2>
              <ul className="m-0 list-none p-0">
                {g.items.map((s) => (
                  <li key={s.id}>
                    <Row session={s} now={now} state={liveState(s, waiting)} device={group === 'project' ? `${deviceName(s, { devices })}${s.tags.includes('imported') ? ', imported' : ''}` : undefined} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <ul className="m-0 list-none p-0">
            {list.map((s) => (
              <li key={s.id}>
                <Row session={s} now={now} state={liveState(s, waiting)} />
              </li>
            ))}
          </ul>
        )}
        {!archived && !hits && archivedCount > 0 && (
          <Link href={`${words.root}?archived`} className="mt-1 flex min-h-[52px] items-center gap-3 px-5 text-[16px] text-fg-2 active:bg-hover">
            <span className="flex-1">Archived</span>
            <span className="num text-[14px] text-fg-3">{archivedCount}</span>
            <ChevronRight className="size-4 text-fg-4" strokeWidth={2} aria-hidden />
          </Link>
        )}
      </div>
      {kind === 'code' && <ImportSheet />}
    </div>
  );
}

const LINE: Record<'running' | 'waiting' | 'failed', { word: string; tone: string }> = {
  running: { word: 'Running', tone: 'text-signal' },
  waiting: { word: 'Waiting for you', tone: 'text-warn' },
  failed: { word: 'Failed', tone: 'text-fault' },
};

type PhoneGroup = 'date' | 'project' | 'device';
const PHONE_GROUPS: PhoneGroup[] = ['date', 'project', 'device'];

/** A row: the title and time, then a line when it says something: the device (grouped by project) and the state. */
function Row({ session: s, now, state, device }: { session: Session; now: number; state: 'running' | 'waiting' | undefined; device?: string }) {
  const line = state ? LINE[state] : s.status === 'error' ? LINE.failed : undefined;
  const repo = sessionRepo(s);
  const unread = isUnread(s);
  return (
    <Link href={hrefOf(s)} className="flex min-h-[52px] flex-col justify-center px-5 py-2.5 transition-colors duration-[var(--dur-1)] active:bg-hover">
      <span className="flex items-baseline gap-3">
        <span className={cn('min-w-0 flex-1 truncate text-[16px] leading-[1.35] text-fg', unread && 'font-semibold')}>
          {s.title || (isChat(s) ? 'New chat' : 'New session')}
          {unread && <span className="sr-only">, new reply</span>}
        </span>
        <span className="num shrink-0 text-[13px] text-fg-3">{relTime(s.updatedAt, now)}</span>
      </span>
      {(line || device || repo) && (
        <span className="mt-0.5 flex min-w-0 gap-1.5 text-[14px] leading-[1.35]">
          {device && <span className="min-w-0 truncate text-fg-3">{device}</span>}
          {device && (line || repo) && <span className="text-fg-4" aria-hidden>·</span>}
          {line ? <span className={cn('shrink-0', line.tone)}>{line.word}</span> : repo && <span className="min-w-0 truncate text-fg-3">{repoWhere(repo)}</span>}
        </span>
      )}
    </Link>
  );
}

function Hits({ hits, searching, query, sessions }: { hits: Hit[]; searching: boolean; query: string; sessions: Record<string, Session> }) {
  const [, navigate] = useLocation();
  if (!hits.length) return <p className="m-0 px-5 py-3 text-[15px] text-fg-3">{searching ? 'Searching messages…' : `No message mentions "${query}".`}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {hits.map((h) => (
        <li key={`${h.sessionId}:${h.messageId}`}>
          <button
            type="button"
            onClick={() => navigate(`${hrefOf(sessions[h.sessionId] ?? { id: h.sessionId })}#${h.messageId}`)}
            className="flex min-h-[52px] w-full flex-col justify-center px-5 py-2.5 text-left active:bg-hover"
          >
            <span className="truncate text-[16px] text-fg">{h.title}</span>
            <span className="mt-0.5 line-clamp-2 text-[14px] leading-[1.4] text-fg-3">{h.snippet}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
