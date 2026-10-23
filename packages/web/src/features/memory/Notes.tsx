/**
 * Memory notes (spec 11.7): what every model knows about the owner. Profile
 * notes first (always given), then the rest, filterable by kind and scope,
 * with search, inline edit and a link back to the session a note came from.
 * Notes imported from a connection say where they came from.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { MoreHorizontal, X } from 'lucide-react';
import type { MemoryEntry, MemoryHit, MemoryKind, MemoryScope } from '@conclave/core/types';
import type { MemoryConnectionInfo } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, removeKey, toast, upsertMemory, useHub } from '@/store/store';
import { useIsMobile, useIsWide, useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { shortDate } from '@/lib/format';
import { Button, IconButton } from '@/components/ui/Button';
import { Field, Input, Segmented, Textarea } from '@/components/ui/Field';
import { Dialog, Menu, type MenuItem } from '@/components/ui/Overlay';
import { Confirm } from './parts';
import { Aside, KV, Quote, Section, SectionHeading } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { AgentPicker } from '@/components/pickers/Pickers';
import { Kbd, MOD } from '@/components/ui/Kbd';
import { connectionName, useConnections } from './store';
import { ReviewQueue, useReviewQueue } from '@/features/import/Review';

type KindFilter = 'all' | MemoryKind | 'review';
type ScopeFilter = 'any' | MemoryScope;

const KIND_WORD: Record<MemoryKind, string> = {
  profile: 'Profile',
  fact: 'Fact',
  procedure: 'Procedure',
  episode: 'Episode',
};
const KIND_PLURAL: Record<MemoryKind, string> = {
  profile: 'Profile',
  fact: 'Facts',
  procedure: 'Procedures',
  episode: 'Episodes',
};
const KIND_HELP: Record<MemoryKind, string> = {
  profile: 'Always given to every model.',
  fact: 'Given to a session when it is relevant.',
  procedure: 'Steps for a task, given when the task comes up.',
  episode: 'What happened in a session, for later recall.',
};
const KIND_ORDER: MemoryKind[] = ['fact', 'procedure', 'profile', 'episode'];
/** Tags a file import adds: the tool the file belongs to. */
const TOOL_TAG: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode' };

function when(ts: number, now: number) {
  const d = now - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return shortDate(ts);
}

function usedWords(n: number) {
  if (!n) return 'not used yet';
  return n === 1 ? 'used once' : `used ${n.toLocaleString('en-US')} times`;
}

// ---------------------------------------------------------------------------
// Note text: inline mono for code, IPs and paths; search matches in fg 560
// ---------------------------------------------------------------------------

const TOKEN = /`([^`]+)`|\b((?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?::\d{2,5})?)\b|((?<![\w/.])~?\/[\w.@*+-]+(?:\/[\w.@*+-]+)*\/?)/g;

function marks(text: string, terms: RegExp | null, key: string): ReactNode {
  if (!terms) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(terms)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={`${key}-${m.index}`} className="bg-transparent font-[560] text-fg">
        {m[0]}
      </mark>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function NoteText({ text, query }: { text: string; query?: string }) {
  const terms = useMemo(() => {
    const words = (query ?? '')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return words.length ? new RegExp(`(${words.join('|')})`, 'gi') : null;
  }, [query]);
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    let token = m[1] ?? m[2] ?? m[3];
    let end = m.index! + m[0].length;
    // a path that ends a sentence keeps its period outside the mono run
    if (!m[1] && /[.,;:]$/.test(token)) {
      token = token.slice(0, -1);
      end -= 1;
    }
    if (m.index! > last) parts.push(marks(text.slice(last, m.index), terms, `t${i}`));
    parts.push(
      <span key={`m${i}`} className="mono text-fg">
        {marks(token, terms, `c${i}`)}
      </span>,
    );
    last = end;
    i++;
  }
  if (last < text.length) parts.push(marks(text.slice(last), terms, `t${i}`));
  return <>{parts}</>;
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function NotesTab({ adding, setAdding, store }: { adding: MemoryKind | null; setAdding: (k: MemoryKind | null) => void; store: ReactNode }) {
  const memoryMap = useHub((s) => s.memories);
  const config = useHub((s) => s.config);
  const booted = useHub((s) => s.booted);
  const wide = useIsWide();
  const now = useNow(60_000);
  const search = useSearch();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [scope, setScope] = useState<ScopeFilter>('any');
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  // learned items waiting for the owner show under To review only (features/import/Review.tsx)
  const all = useMemo(() => Object.values(memoryMap).filter((m) => m.meta?.review !== 'pending'), [memoryMap]);
  const review = useReviewQueue();
  const reviewCount = review.items?.length ?? 0;
  const focus = new URLSearchParams(search).get('focus');

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api()
        .searchMemory(term, 50)
        .then((r) => alive && setHits(r))
        .catch(() => alive && setHits([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  // the command palette opens a note with ?focus=<id>
  useEffect(() => {
    if (!focus || !memoryMap[focus]) return;
    const el = document.getElementById(`note-${focus}`);
    el?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, !!memoryMap[focus ?? '']]);

  // search results follow edits and deletes made while searching
  const results = useMemo(() => (hits ? hits.filter((h) => memoryMap[h.id]).map((h) => ({ ...memoryMap[h.id], score: h.score })) : null), [hits, memoryMap]);

  const byScope = (m: MemoryEntry) => scope === 'any' || m.scope === scope;
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, profile: 0, fact: 0, procedure: 0, episode: 0 };
    for (const m of all) if (byScope(m)) (c.all++, c[m.kind]++);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, scope]);
  const profile = useMemo(() => all.filter((m) => m.kind === 'profile' && byScope(m)).sort((a, b) => b.importance - a.importance || b.useCount - a.useCount), [all, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const notes = useMemo(
    () => all.filter((m) => m.kind !== 'profile' && (kind === 'all' || m.kind === kind) && byScope(m)).sort((a, b) => b.updatedAt - a.updatedAt),
    [all, kind, scope], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const matches = useMemo(
    () => (results ?? []).filter((m) => (kind === 'all' || m.kind === kind) && byScope(m)).sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt),
    [results, kind, scope], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const searching = results !== null;
  const empty = booted && all.length === 0;
  const mem = (config?.memory ?? {}) as { autoInject?: boolean; autoExtract?: boolean; injectLimit?: number };

  const filters = (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
      <FilterLinks
        label="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'profile', label: 'Profile', count: counts.profile },
          { value: 'fact', label: 'Facts', count: counts.fact },
          { value: 'procedure', label: 'Procedures', count: counts.procedure },
          { value: 'episode', label: 'Episodes', count: counts.episode },
          ...(reviewCount || kind === 'review' ? [{ value: 'review' as KindFilter, label: 'To review', count: reviewCount }] : []),
        ]}
      />
      <span aria-hidden className="hidden h-3.5 w-px self-center bg-rule-2 sm:block" />
      <FilterLinks
        label="Scope"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'any', label: 'Any scope' },
          { value: 'global', label: 'Global' },
          { value: 'project', label: 'Projects' },
          { value: 'agent', label: 'Agents' },
        ]}
      />
    </div>
  );

  const showProfile = !searching && (kind === 'all' || kind === 'profile');
  const showNotes = !searching && kind !== 'profile' && kind !== 'review';

  const list = (
    <div className="space-y-7 phone:space-y-8">
      {!searching && kind === 'review' && <ReviewQueue queue={review} />}
      {searching && (
        <Section title="Matches" count={matches.length} rows>
          {matches.length ? (
            matches.map((m) => <MemoryRow key={m.id} m={m} query={q} now={now} />)
          ) : (
            <p className="py-4 text-[14px] text-fg-2">
              Nothing matches {q.trim()}.{' '}
              <button type="button" className="link" onClick={() => setQ('')}>
                Clear the search
              </button>
            </p>
          )}
        </Section>
      )}
      {showProfile && (
        <section aria-labelledby="mem-profile">
          <SectionHeading id="mem-profile" count={profile.length} action={{ label: 'Add to profile', onClick: () => setAdding('profile') }}>
            Profile
          </SectionHeading>
          <p className="mt-2.5 mb-1 text-[12px] text-fg-3 phone:text-[13px]">Always given to every model, in every session.</p>
          <div className="rows">
            {profile.map((m) => (
              <MemoryRow key={m.id} m={m} now={now} hideKind focused={m.id === focus} />
            ))}
          </div>
          {profile.length === 0 && <p className="py-3 text-[14px] text-fg-2">A few lines about you and how you like answers. Every model reads them first.</p>}
        </section>
      )}
      {showNotes && (
        <Section title={kind === 'all' ? 'Notes' : KIND_PLURAL[kind as MemoryKind]} count={notes.length}>
          {notes.map((m) => (
            <MemoryRow key={m.id} m={m} now={now} focused={m.id === focus} />
          ))}
          {notes.length === 0 && (
            <p className="py-4 text-[14px] text-fg-2">
              No {kind === 'all' ? 'notes' : KIND_PLURAL[kind as MemoryKind].toLowerCase()} {scope === 'any' ? 'yet' : `with ${scope} scope`}.
            </p>
          )}
        </Section>
      )}
    </div>
  );

  return (
    <div className={cn(wide && 'grid grid-cols-[minmax(0,780px)_minmax(0,1fr)]')}>
      <div className={cn('min-w-0', wide ? 'pr-10' : 'max-w-[780px]')}>
        {empty ? (
          <EmptyState action={{ label: 'Add a note', onClick: () => setAdding('fact') }}>Nothing saved yet. Sessions write notes here when they learn something about you or your setup.</EmptyState>
        ) : (
          <>
            <div className="space-y-4">
              <Input
                size="lg"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && q) {
                    e.preventDefault();
                    setQ('');
                  }
                }}
                placeholder="Search memory"
                aria-label="Search memory"
                enterKeyHint="search"
                className="text-[14px]"
                // always pass a suffix: adding one later rebuilds the field and drops focus mid-word
                suffix={
                  q ? (
                    <IconButton label="Clear search" size="xs" tooltip={false} onClick={() => setQ('')} className="-mr-1.5">
                      <X />
                    </IconButton>
                  ) : (
                    <span aria-hidden className="block w-0" />
                  )
                }
              />
              {filters}
            </div>
            <div className="mt-7">
              <LoadingRows loading={!booted} rows={4} />
              {booted && list}
            </div>
          </>
        )}
      </div>
      {wide && !empty && (
        <aside className="min-w-0 border-l border-rule pl-10" aria-label="How memory is used">
          <div className="max-w-[460px]">
            <UsageAside all={all} mem={mem} store={store} />
          </div>
        </aside>
      )}
      <AddNote kind={adding} onClose={() => setAdding(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aside (wide screens): how sessions use memory, and the notes used most
// ---------------------------------------------------------------------------

function UsageAside({ all, mem, store }: { all: MemoryEntry[]; mem: { autoInject?: boolean; autoExtract?: boolean; injectLimit?: number }; store: ReactNode }) {
  // profile notes go to every session anyway; this is about the rest
  const top = [...all]
    .filter((m) => m.kind !== 'profile' && m.useCount > 0)
    .sort((a, b) => b.useCount - a.useCount)
    .slice(0, 5);
  const inject = mem.autoInject !== false;
  const extract = mem.autoExtract !== false;
  return (
    <div className="space-y-7">
      <Aside title="How sessions use it" action={{ label: 'Change', href: '/settings/defaults#memory' }}>
        <KV k="Profile">Every session</KV>
        <KV k="Other notes">{inject ? `Up to ${mem.injectLimit ?? 6} per turn, when relevant` : 'Only when a session searches'}</KV>
        <KV k="Learning">{extract ? 'Saves what it learns after a session' : 'Off'}</KV>
        <KV k="Store">{store}</KV>
      </Aside>
      {top.length > 0 && (
        <section>
          <SectionHeading>Used most</SectionHeading>
          <div className="rows">
            {top.map((m) => (
              <div key={m.id} className="flex items-baseline gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2" title={m.content.replace(/`/g, '')}>
                  <NoteText text={m.content} />
                </span>
                <span className="num shrink-0 text-[12px] text-fg-3">{m.useCount.toLocaleString('en-US')}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A note
// ---------------------------------------------------------------------------

function useClamped(ref: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return clamped;
}

/** Tags in the meta line: a connection's "imported, source:x" reads "from Basic Memory", a file import's tool tag "from Claude Code". */
function tagParts(tags: string[], conns: MemoryConnectionInfo[] | undefined): { from?: string; tags: string[] } {
  const source = tags.find((t) => t.startsWith('source:'));
  // a goal's memory is kept by the hub from the Goals page (source @goals)
  if (source === 'source:@goals') return { from: 'Goals', tags: tags.filter((t) => t !== 'imported' && !t.startsWith('source:') && t !== 'goal') };
  if (source) return { from: connectionName(conns, source.slice(7)), tags: tags.filter((t) => t !== 'imported' && !t.startsWith('source:')) };
  const tool = tags.find((t) => TOOL_TAG[t]);
  if (tool) return { from: `${TOOL_TAG[tool]} memory files`, tags: tags.filter((t) => t !== tool) };
  return { tags };
}

function MemoryRow({ m, query, now, hideKind, focused }: { m: MemoryEntry; query?: string; now: number; hideKind?: boolean; focused?: boolean }) {
  const sessions = useHub((s) => s.sessions);
  const conns = useConnections((s) => s.list);
  const mobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const clamped = useClamped(textRef, [m.content, open]);

  useEffect(() => {
    if (!editing) setText(m.content);
  }, [m.content, editing]);

  const save = async () => {
    const next = text.trim();
    if (!next || next === m.content) {
      setEditing(false);
      setText(m.content);
      return;
    }
    setBusy(true);
    const r = await attempt(() => api().updateMemory(m.id, { content: next }));
    setBusy(false);
    if (r) {
      upsertMemory(r);
      setEditing(false);
    }
  };

  const setKind = async (k: MemoryKind) => {
    if (k === m.kind) return;
    const r = await attempt(() => api().updateMemory(m.id, { kind: k }));
    if (r) {
      upsertMemory(r);
      toast({ title: k === 'profile' ? 'Moved to your profile. Every model gets it now.' : `Now a ${KIND_WORD[k].toLowerCase()}.` });
    }
  };

  const imported = m.tags.includes('imported');
  const menu: MenuItem[] = [
    { label: 'Edit', onSelect: () => setEditing(true) },
    { separator: true, label: '' },
    { group: true, label: 'Kind' },
    ...(['profile', 'fact', 'procedure', 'episode'] as MemoryKind[]).map((k) => ({
      label: KIND_WORD[k],
      checked: m.kind === k,
      onSelect: () => void setKind(k),
    })),
    { separator: true, label: '' },
    { label: 'Delete', danger: true, onSelect: () => setConfirm(true) },
  ];

  const src = m.sourceSessionId ? sessions[m.sourceSessionId] : undefined;
  const scope = m.scope === 'global' ? 'global' : m.scope === 'project' ? <span className="mono">{m.scopeKey ?? 'a project'}</span> : `for ${m.scopeKey ?? 'an agent'}`;
  const tp = tagParts(m.tags, conns);
  const meta: ReactNode[] = [...(hideKind ? [] : [KIND_WORD[m.kind]]), scope, ...tp.tags];
  if (typeof meta[0] === 'string') meta[0] = meta[0][0].toUpperCase() + meta[0].slice(1);
  if (tp.from) meta.push(`from ${tp.from}`);
  if (m.sourceSessionId)
    meta.push(
      <>
        from{' '}
        <Link href={`/s/${m.sourceSessionId}`} className="link text-fg-3" title={src?.title}>
          {src?.title ?? 'a past session'}
        </Link>
      </>,
    );
  meta.push(when(m.updatedAt, now), usedWords(m.useCount));

  if (editing)
    return (
      <div className="py-3">
        <Textarea
          prose
          autoFocus
          value={text}
          minRows={2}
          aria-label="Edit note"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setText(m.content);
              setEditing(false);
            }
          }}
        />
        {imported && (
          <p className="m-0 mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">
            {m.tags.includes('source:@goals') ? 'From Goals. Every agent recalls it; change the goal on the Goals page and this note follows.' : `Imported from ${tp.from}. The next sync puts its text back; change it there to keep the edit.`}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Button variant="solid" size={mobile ? 'touch' : 'sm'} busy={busy ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
          <Button
            variant="quiet"
            size={mobile ? 'touch' : 'sm'}
            onClick={() => {
              setText(m.content);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          {!mobile && (
            <span className="ml-auto text-[12px] text-fg-3">
              <Kbd>{MOD}</Kbd> <Kbd>↵</Kbd> saves, <Kbd>esc</Kbd> cancels
            </span>
          )}
        </div>
      </div>
    );

  return (
    <article id={`note-${m.id}`} className={cn('group flex items-start gap-3 py-3 anim-fade', focused && 'bg-raise')}>
      <div className="min-w-0 flex-1">
        <p ref={textRef} onDoubleClick={() => setEditing(true)} className={cn('t-prose m-0 break-words', query ? 'text-fg-2' : 'text-fg', !open && 'line-clamp-3')}>
          <NoteText text={m.content} query={query} />
        </p>
        {(clamped || open) && (
          <button type="button" className="mt-0.5 text-[12px] text-fg-3 hover:text-fg phone:text-[13px]" onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
        <div className="mt-1 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
          {meta.map((p, i) => (
            <span key={i}>
              {p}
              {i < meta.length - 1 && ', '}
            </span>
          ))}
        </div>
      </div>
      <Menu
        items={menu}
        label="Note actions"
        width={200}
        trigger={({ ref, props }) => (
          <IconButton
            ref={ref}
            label="Note actions"
            size={mobile ? 'touch' : 'sm'}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 coarse:opacity-100"
            {...props}
          >
            <MoreHorizontal />
          </IconButton>
        )}
      />
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this note?"
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          if (await attempt(() => api().deleteMemory(m.id))) removeKey('memories', m.id);
        }}
      >
        <Quote className="t-prose">{m.content.replace(/`/g, '')}</Quote>
        <p className="mt-3">{m.tags.includes('source:@goals') ? 'Sessions stop seeing it until the goal changes. Delete the goal on the Goals page to remove it for good.' : imported ? `Sessions stop seeing it. The next sync from ${tp.from} brings it back unless you delete it there too.` : 'Sessions stop seeing it. This cannot be undone.'}</p>
      </Confirm>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Add a note
// ---------------------------------------------------------------------------

const PLACEHOLDER: Record<MemoryKind, string> = {
  profile: 'Short answers with commands I can paste. No em dashes.',
  fact: 'The NAS is at 10.0.10.5 and runs TrueNAS.',
  procedure: 'To deploy, run bun run build, then restart the unit on the hub.',
  episode: 'Moved the reverse proxy to Caddy in LXC 101.',
};

function AddNote({ kind, onClose }: { kind: MemoryKind | null; onClose: () => void }) {
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const [content, setContent] = useState('');
  const [k, setK] = useState<MemoryKind>('fact');
  const [scope, setScope] = useState<MemoryScope>('global');
  const [scopeKey, setScopeKey] = useState('');
  const [agent, setAgent] = useState<string>();
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!kind) return;
    setK(kind);
    setContent('');
    setScope('global');
    setScopeKey('');
    setTags('');
  }, [kind]);

  const key = scope === 'project' ? scopeKey.trim() : scope === 'agent' ? agent : undefined;
  const ready = !!content.trim() && (scope === 'global' || !!key);
  const save = async () => {
    // ⌘↵ again while it saves would save the note twice
    if (!ready || busy) return;
    setBusy(true);
    const m = await attempt(() =>
      api().saveMemory({
        content: content.trim(),
        kind: k,
        scope,
        scopeKey: key,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    );
    setBusy(false);
    if (m) {
      upsertMemory(m);
      onClose();
      if (k === 'profile') navigate('/memory');
    }
  };

  return (
    <Dialog
      open={!!kind}
      onClose={onClose}
      title={k === 'profile' ? 'Add to your profile' : 'Add a note'}
      width={520}
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!ready} busy={busy ? 'Saving' : false} kbd={mobile ? undefined : `${MOD}↵`} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <Field label="Note" help={KIND_HELP[k]}>
          <Textarea
            prose
            data-autofocus
            minRows={3}
            value={content}
            placeholder={PLACEHOLDER[k]}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Kind</span>
          <Segmented className="self-start" label="Kind" value={k} onChange={setK} full={mobile} size={mobile ? 'touch' : 'md'} options={KIND_ORDER.map((x) => ({ value: x, label: KIND_WORD[x] }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Given to</span>
          <Segmented
            className="self-start"
            label="Scope"
            value={scope}
            onChange={setScope}
            full={mobile}
            size={mobile ? 'touch' : 'md'}
            options={[
              { value: 'global', label: 'Every session' },
              { value: 'project', label: 'One project' },
              { value: 'agent', label: 'One agent' },
            ]}
          />
          {scope === 'project' && <Input mono value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} placeholder="~/code/conclave" aria-label="Project folder" className="mt-1" />}
          {scope === 'agent' && (
            <div className="mt-1">
              <AgentPicker look="field" value={agent} onChange={setAgent} includeHidden />
            </div>
          )}
        </div>
        <Field label="Tags" optional help="Words, comma separated.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="homelab, network" />
        </Field>
      </div>
    </Dialog>
  );
}
