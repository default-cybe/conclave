/**
 * Inbox (spec 11.3): approvals and questions from running sessions, and
 * alerts: two live chats editing one file, a turn that stopped making
 * progress (AlertCard.tsx).
 *
 * Wide (>= 1280): a 420px list and the selected item on the right, with the
 * session's last message and tool calls above the card. Below 1280: one
 * column of full cards, newest first. Approvals can be denied in bulk (never
 * allowed in bulk). The phone Inbox (PhoneInbox.tsx) offers the same things:
 * the filter with Results, kept in the address, and Earlier today (what
 * finished today and what was decided here) with Clear done (Earlier.tsx).
 *
 * Keys: J and K move, A allow once, S allow for this session, D deny (on the
 * focused card), Esc clears the selection of checked rows.
 *
 * A subagent's or a workflow agent's request also shows in the chat the
 * owner is in (lib/asks.ts); here its line reads "from subagent email in
 * <that chat's title>", and Open session opens that chat.
 *
 * From friends (features/friends/InboxFriends.tsx): requests, key changes,
 * notes not read yet and shares with Accept and Decline, under the list,
 * with a filter of their own.
 *
 * A computer paired for the first time with past chats on it: one offer to
 * import them (features/import/OfferCard.tsx), at the top of All.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { ApprovalRequest, QuestionRequest } from '@conclave/core/types';
import type { AlertItem } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, removeKey, useHub, useQuietAlertToasts, useQuietAskToasts } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm, relTime } from '@/lib/format';
import { harnessId } from '@/lib/models';
import { hrefOf } from '@/lib/recents';
import { askFromInbox, askHome } from '@/lib/asks';
import { useIsMobile, useIsWide, useNow } from '@/lib/hooks';
import { isTyping } from '@/components/Shell';
import { Page, PageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectedMark } from '@/components/ui/List';
import { approvalQuestion, waitWords } from '@/components/inbox/ApprovalCard';
import { StableApprovalCard } from '@/features/home/cards';
import { QuestionCard } from '@/components/inbox/QuestionCard';
import { AlertCard } from '@/components/inbox/AlertCard';
import { alertText, alertWord } from '@/components/inbox/alertWords';
import { HarnessName, ModelName } from '@/components/logo';
import { DECISION_WORDS, logResolved, useRetained } from '@/features/home/inbox';
import { GAP_OUT_MS, GapList, Roll } from '@/components/motion';
import { SessionContext } from '@/features/home/SessionContext';
import { MetaText } from '@/features/home/MetaText';
import { PhoneInbox } from './PhoneInbox';
import { EarlierRow, useEarlierToday, useInboxFilter, type Result } from './Earlier';
import { useFriendInbox } from '@/store/friends';
import { FriendsInboxSection } from '@/features/friends/InboxFriends';
import { ImportOffersSection, useImportOffers } from '@/features/import/OfferCard';

type Item =
  | { kind: 'approval'; id: string; createdAt: number; a: ApprovalRequest }
  | { kind: 'question'; id: string; createdAt: number; q: QuestionRequest }
  | { kind: 'alert'; id: string; createdAt: number; al: AlertItem };

const sessionOf = (it: Item) => (it.kind === 'approval' ? it.a.sessionId : it.kind === 'question' ? it.q.sessionId : it.al.sessionId);
/** The conversation an item shows in: a subagent's request is its top session's. */
const homeOf = (it: Item) => (it.kind === 'approval' ? askHome(it.a) : it.kind === 'question' ? askHome(it.q) : it.al.sessionId);
const fromOf = (it: Item) => (it.kind === 'approval' ? it.a : it.kind === 'question' ? it.q : undefined);

/** Phones get their own Inbox (PhoneInbox.tsx), as in the iPhone app. */
export default function ApprovalsPage() {
  // a new approval, question or alert shows up in the list: no toast over it
  useQuietAskToasts();
  useQuietAlertToasts();
  return useIsMobile() ? <PhoneInbox /> : <InboxPage />;
}

function InboxPage() {
  const wide = useIsWide();
  const phone = useIsMobile();
  const approvalMap = useHub((s) => s.approvals);
  const questionMap = useHub((s) => s.questions);
  const alertMap = useHub((s) => s.alerts);
  const alertsLive = useMemo(() => Object.values(alertMap).sort((a, b) => a.createdAt - b.createdAt), [alertMap]);
  const approvalsLive = useMemo(() => Object.values(approvalMap).sort((a, b) => a.createdAt - b.createdAt), [approvalMap]);
  const questionsLive = useMemo(() => Object.values(questionMap).sort((a, b) => a.createdAt - b.createdAt), [questionMap]);
  const A = useRetained(approvalsLive);
  const Q = useRetained(questionsLive);
  const { results, clear } = useEarlierToday();
  const friends = useFriendInbox();
  const offers = useImportOffers();

  const [filter, setFilter] = useInboxFilter();
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [denying, setDenying] = useState(false);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    if (filter === 'all' || filter === 'approvals') for (const a of A.list) out.push({ kind: 'approval', id: a.id, createdAt: a.createdAt, a });
    if (filter === 'all' || filter === 'questions') for (const q of Q.list) out.push({ kind: 'question', id: q.id, createdAt: q.createdAt, q });
    if (filter === 'all' || filter === 'alerts') for (const al of alertsLive) out.push({ kind: 'alert', id: al.id, createdAt: al.createdAt, al });
    return out.sort((x, y) => y.createdAt - x.createdAt);
  }, [A.list, Q.list, alertsLive, filter]);

  const total = approvalsLive.length + questionsLive.length + alertsLive.length + friends.count + offers.length;
  const current = items.find((i) => i.id === selected) ?? items[0];

  // checked rows that were resolved elsewhere drop out
  useEffect(() => {
    setChecked((c) => c.filter((id) => approvalMap[id]));
  }, [approvalMap]);

  const move = (d: 1 | -1) => {
    if (!items.length) return;
    if (wide) {
      const i = Math.max(
        0,
        items.findIndex((x) => x.id === current?.id),
      );
      const next = items[Math.min(items.length - 1, Math.max(0, i + d))];
      setSelected(next.id);
      requestAnimationFrame(() => focusCard(document.querySelector('[data-inbox-detail]')));
      return;
    }
    // one column: the card that holds focus is the current one; with none focused, J starts at the top
    const at = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-inbox-card]')?.dataset.inboxCard;
    const i = at ? items.findIndex((x) => x.id === at) : -1;
    const next = i < 0 ? items[d === 1 ? 0 : items.length - 1] : items[Math.min(items.length - 1, Math.max(0, i + d))];
    const el = document.querySelector<HTMLElement>(`[data-inbox-card="${next.id}"]`);
    focusCard(el);
    el?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        move(e.key === 'j' ? 1 : -1);
      } else if (e.key === 'Escape' && checked.length) setChecked([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const denySelected = async () => {
    setDenying(true);
    for (const id of checked) {
      const a = approvalMap[id];
      if (!a) continue;
      const ok = await attempt(() => api().resolveApproval(id, { decision: 'deny' }));
      if (ok) {
        logResolved({ kind: 'approval', id, at: Date.now(), decision: 'deny', approval: a });
        removeKey('approvals', id);
      }
    }
    setDenying(false);
    setChecked([]);
  };

  // the card slides out first; its line under Resolved arrives once it has gone, so it never shows twice
  const onResolved = (a: ApprovalRequest) => (d: keyof typeof DECISION_WORDS, at: number) => {
    A.release(a.id);
    setTimeout(() => logResolved({ kind: 'approval', id: a.id, at, decision: d, approval: a }), GAP_OUT_MS);
  };

  const filters = (
    <FilterLinks
      label="Show"
      // on phones each filter word gets a 44px tall hit area without moving
      className="phone:[&>button]:-my-3 phone:[&>button]:py-3"
      value={filter}
      onChange={(v) => {
        setFilter(v);
        setSelected(null);
      }}
      options={[
        { value: 'all', label: 'All' },
        { value: 'approvals', label: 'Approvals', count: approvalsLive.length },
        { value: 'questions', label: 'Questions', count: questionsLive.length },
        { value: 'alerts', label: 'Alerts', count: alertsLive.length },
        { value: 'friends', label: 'Friends', count: friends.count },
        { value: 'results', label: 'Results' },
      ]}
    />
  );

  const empty = items.length === 0;
  const earlier = (inList: boolean, className?: string) => <EarlierToday results={results} inList={inList} className={className} />;
  const fromFriends = filter === 'all' && friends.items.length > 0;
  const fromOffers = filter === 'all' && offers.length > 0;
  const friendsSection = (className?: string, inset?: boolean) => <FriendsInboxSection items={friends.items} inset={inset} className={className} />;

  return (
    <Page>
      <PageHeader
        title="Inbox"
        sub={total ? <><Roll value={total} /> waiting on you</> : undefined}
        actions={
          results.length > 0 && (
            <Button variant="quiet" onClick={clear}>
              Clear done
            </Button>
          )
        }
      >
        {filters}
      </PageHeader>

      {fromOffers && <ImportOffersSection offers={offers} className={cn('max-w-[760px]', !empty && 'mb-8')} />}
      {filter === 'results' ? (
        earlier(false, 'max-w-[760px]')
      ) : filter === 'friends' ? (
        friends.items.length ? (
          friendsSection('max-w-[760px]')
        ) : (
          <EmptyState className="max-w-[720px] pt-0 text-pretty">Nothing from friends. Their notes, shares and requests land here.</EmptyState>
        )
      ) : empty ? (
        fromFriends ? (
          friendsSection(cn('max-w-[760px]', fromOffers && 'mt-10'))
        ) : fromOffers ? null : (
          <EmptyState className="max-w-[720px] pt-0 text-pretty">{filter === 'all' ? 'Nothing is waiting on you. Approvals and questions from running sessions land here, with alerts about stuck sessions or two chats editing one file, and notes and shares from friends.' : filter === 'approvals' ? 'No approvals waiting.' : filter === 'alerts' ? 'No alerts. A session that stops making progress, or two chats editing one file, shows up here.' : 'No questions waiting.'}</EmptyState>
        )
      ) : wide ? (
        <div className="grid grid-cols-[420px_minmax(0,1fr)] border-t border-rule">
          <div className="min-w-0 border-r border-rule pt-2 pr-7">
            <BulkBar count={checked.length} busy={denying} onDeny={() => void denySelected()} onClear={() => setChecked([])} />
            {/* approve and close the gap (spec 1.4): a resolved row fades out and the rows below ride up */}
            <div role="list" aria-label="Waiting on you">
              <GapList items={items} keyOf={(it) => it.id} className="rows" exit="fade">
                {(it) => (
                <InboxRow
                  item={it}
                  selected={it.id === current?.id}
                  checking={checked.length > 0}
                  checked={checked.includes(it.id)}
                  held={it.kind === 'approval' ? A.isHeld(it.id) : it.kind === 'question' ? Q.isHeld(it.id) : false}
                  onSelect={() => setSelected(it.id)}
                  onCheck={(v) => setChecked((c) => (v ? [...c, it.id] : c.filter((x) => x !== it.id)))}
                />
                )}
              </GapList>
            </div>
            {fromFriends && friendsSection('mt-10', true)}
            {filter === 'all' && earlier(true, 'mt-10')}
          </div>
          <div className="min-w-0 pt-5 pl-7">
            {current && (
              <div className="sticky top-5 max-w-[860px]" data-inbox-detail>
                <Detail
                  item={current}
                  held={current.kind === 'approval' ? A.isHeld(current.id) : current.kind === 'question' ? Q.isHeld(current.id) : false}
                  onTouch={() => (current.kind === 'approval' ? A.touch(current.id) : current.kind === 'question' && Q.touch(current.id))}
                  onResolved={current.kind === 'approval' ? onResolved(current.a) : undefined}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        // approve and close the gap (spec 1.4): a card confirms in place, slides out, and the cards below ride up
        <GapList items={items} keyOf={(it) => it.id} className={cn('max-w-[760px] space-y-3', phone && 'space-y-4')}>
          {(it) =>
            it.kind === 'approval' ? (
              <div data-inbox-card={it.id} onPointerDownCapture={() => A.touch(it.id)} onKeyDownCapture={() => A.touch(it.id)}>
                <StableApprovalCard approval={it.a} onResolved={onResolved(it.a)} />
              </div>
            ) : it.kind === 'alert' ? (
              <div data-inbox-card={it.id}>
                <AlertCard alert={it.al} />
              </div>
            ) : Q.isHeld(it.id) ? (
              <AnsweredLine q={it.q} />
            ) : (
              <div data-inbox-card={it.id} className="border-b border-rule" onPointerDownCapture={() => Q.touch(it.id)} onKeyDownCapture={() => Q.touch(it.id)}>
                <QuestionCard question={it.q} />
              </div>
            )
          }
        </GapList>
      )}

      {fromFriends && !empty && !wide && friendsSection('mt-10 max-w-[760px]')}
      {filter === 'all' && (empty || !wide) && earlier(false, 'mt-10 max-w-[760px]')}
    </Page>
  );
}

/** Focus the first focusable part of a card: the approval card itself, or a question's first option. */
function focusCard(root: Element | null) {
  const el = root?.querySelector<HTMLElement>('[tabindex="0"], button');
  el?.focus();
}

function BulkBar({ count, busy, onDeny, onClear }: { count: number; busy: boolean; onDeny: () => void; onClear: () => void }) {
  if (!count) return null;
  return (
    <div className="flex items-center gap-2 pb-2 text-[13px] anim-fade" role="toolbar" aria-label="Selected approvals">
      <span className="num mr-auto text-fg-2">{count} selected</span>
      <Button variant="quiet" size="sm" onClick={onClear}>
        Clear
      </Button>
      <Button variant="danger" size="sm" busy={busy ? 'Denying' : false} onClick={onDeny}>
        Deny selected
      </Button>
    </div>
  );
}

function useItemWords(it: Item) {
  const now = useNow(15_000);
  const session = useHub((s) => s.sessions[sessionOf(it)]);
  const home = useHub((s) => s.sessions[homeOf(it)]);
  const deviceName = useHub((s) => (session?.device ? (s.devices[session.device]?.name ?? session.device) : undefined));
  const task = useHub((s) => (session?.taskId ? s.tasks[session.taskId] : undefined));
  let title: React.ReactNode;
  if (it.kind === 'approval') {
    const q = approvalQuestion(it.a, deviceName);
    title = (
      <>
        {q.text}
        {q.mono && <span className="mono">{q.mono}</span>}
        {q.after}
      </>
    );
  } else if (it.kind === 'alert') title = alertText(it.al, now);
  else title = it.q.questions[0]?.question ?? 'Question';
  const harness = it.kind === 'approval' ? (it.a.harness ?? (harnessId(session?.model) ? session?.model : undefined)) : undefined;
  const who = harness ? <HarnessName harness={harness} size={13} className="align-[-0.2em]" /> : session?.model ? <ModelName model={session.model} as="model" size={13} className="align-[-0.2em]" /> : undefined;
  // a subagent asks: "from subagent email in Find my Lisbon mail"
  const r = fromOf(it);
  const from = r ? askFromInbox(r, home?.title) : undefined;
  return { session, home, title, who, meta: from ? [from, who] : [task?.title ?? session?.title, session?.agent, who] };
}

function InboxRow({ item, selected, checking, checked, held, onSelect, onCheck }: { item: Item; selected: boolean; checking: boolean; checked: boolean; held: boolean; onSelect: () => void; onCheck: (v: boolean) => void }) {
  const now = useNow(1000);
  const { title, meta } = useItemWords(item);
  const approval = item.kind === 'approval';
  return (
    <div role="listitem" className={cn('group relative flex items-start gap-2.5 py-[10px] pr-3 pl-3 transition-colors duration-[var(--dur-1)]', selected ? 'bg-raise' : 'hover:bg-hover')}>
      {selected && <SelectedMark />}
      {/* every row keeps the checkbox gutter so titles line up; only approvals can be bulk denied */}
      <span className={cn('w-3.5 shrink-0 pt-[2px] transition-opacity duration-[var(--dur-1)]', checking || checked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100')}>
        {approval && !held && <Checkbox checked={checked} onChange={onCheck} label={<span className="sr-only">Select for bulk deny</span>} />}
      </span>
      <button type="button" onClick={onSelect} aria-current={selected || undefined} className="min-w-0 flex-1 text-left outline-offset-4">
        <span className={cn('t-row block truncate', held ? 'text-fg-3' : 'text-fg')}>{title}</span>
        <MetaText parts={meta} className="mt-0.5 text-[12px] leading-[1.4] text-fg-3" />
      </button>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4]">
        <span className="num text-fg-3">{relTime(item.createdAt, now)}</span>
        {held ? <span className="text-fg-3">resolved</span> : item.kind === 'alert' ? <span className="text-warn">{alertWord(item.al)}</span> : <span className="num text-warn">{waitWords(now - item.createdAt)}</span>}
      </span>
    </div>
  );
}

function Detail({ item, held, onTouch, onResolved }: { item: Item; held: boolean; onTouch: () => void; onResolved?: (d: keyof typeof DECISION_WORDS, at: number) => void }) {
  const { session, home, who, meta } = useItemWords(item);
  const sessionId = sessionOf(item);
  const r = fromOf(item);
  // a subagent's request: the chat it shows in, then who asks ("from subagent email")
  const from = r ? askFromInbox(r) : undefined;
  const deviceName = useHub((s) => (session?.device ? (s.devices[session.device]?.name ?? session.device) : undefined));
  return (
    <section aria-label="Selected request">
      <div className="flex items-baseline gap-4">
        <h2 className="t-title min-w-0 flex-1 truncate text-fg">{(from ? home?.title : session?.title) ?? 'Session'}</h2>
        <Link href={hrefOf(home ?? { id: homeOf(item) })} className="link shrink-0 text-[13px]">
          Open session
        </Link>
      </div>
      <MetaText parts={from ? [from, who, deviceName] : [meta[1], meta[2], deviceName]} className="mt-1 text-[12px] text-fg-3" />
      <SessionContext sessionId={sessionId} pendingToolUseId={item.kind === 'approval' ? item.a.toolUseId : undefined} className="mt-5" />
      <div className="mt-5" onPointerDownCapture={onTouch} onKeyDownCapture={onTouch}>
        {item.kind === 'approval' ? (
          <StableApprovalCard key={item.id} approval={item.a} inSession onResolved={onResolved} />
        ) : item.kind === 'alert' ? (
          <AlertCard key={item.id} alert={item.al} inSession />
        ) : held ? (
          <AnsweredLine q={item.q} />
        ) : (
          <div className="border-t border-rule-2">
            <QuestionCard key={item.id} question={item.q} inSession />
          </div>
        )}
      </div>
    </section>
  );
}

function AnsweredLine({ q }: { q: QuestionRequest }) {
  const [at] = useState(Date.now);
  const logged = useRef(false);
  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    logResolved({ kind: 'question', id: q.id, at, question: q });
  }, [q, at]);
  return (
    <p role="status" className="border-b border-rule py-3 text-[13px] text-fg-3 anim-fade">
      Answered, <span className="num">{hhmm(at)}</span>
    </p>
  );
}

/** Earlier today, as on a phone. `inList`: under the wide list, so titles line up with the rows above (they keep a checkbox gutter). */
function EarlierToday({ results, inList, className }: { results: Result[]; inList?: boolean; className?: string }) {
  return (
    <Section title="Earlier today" count={results.length || undefined} className={cn('anim-fade', className)} id="inbox-earlier" rows={false}>
      {results.length === 0 ? (
        <p className={cn('py-3 text-[13px] text-fg-3', inList && 'pl-9')}>Sessions that finish today, and what you decide here, show up here.</p>
      ) : (
        <GapList items={results} keyOf={(r) => r.id} exit="fade" className="rows">
          {(r) => <EarlierRow r={r} inset={inList} />}
        </GapList>
      )}
    </Section>
  );
}
