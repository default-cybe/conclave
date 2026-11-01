/**
 * Shares (docs/design/FRIENDS.md, phases 2 and 3).
 *
 *   /shares       what friends sent (waiting first) and what you sent, with
 *                 Update and Unsend
 *   /shares/:id   one share from a friend: Accept and Decline while it
 *                 waits; once accepted, the conversation read only and
 *                 marked as quoted from the friend's hub, the code's diff,
 *                 and Continue as fork, Handoff, Use as reference and
 *                 Apply code. An unsent or expired share says so.
 *
 * On a phone a share draws its own bar like a conversation; the list is a
 * page under Friends.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ReceivedShareDto, ShareViewDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn, parseDiff } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { hrefOf } from '@/lib/recents';
import { toolLine } from '@/lib/toolLine';
import { agoText } from '@/lib/friends';
import { friendHref, shareHref } from '@/lib/friendInbox';
import { codeWords, quotedUnits, receivedWords, sentActive, shareWaiting, summaryText, type QuotedUnit } from '@/lib/shares';
import { upsertReceivedShare, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Diff } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Section, SectionHeading } from '@/components/ui/Section';
import { PhoneBar } from '@/components/PhoneFrame';
import { Markdown } from '@/features/chat/Markdown';
import { SentShareCard, useShareAnswer } from './ShareCards';
import { ApplyDialog, FORK_LINE, ForkDialog, HandoffDialog, ReferenceDialog } from './ShareActions';
import { TONE } from './parts';
import { ShareArrived } from './moments';

export default function SharesRoute() {
  const { id } = useParams<{ id?: string }>();
  return id ? <SharePage key={id} id={id} /> : <SharesList />;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function SharesList() {
  const phone = useIsMobile();
  const received = useHub((s) => s.receivedShares);
  const sent = useHub((s) => s.sentShares);
  const now = useNow(60_000);
  usePageHeader('Shares', '/settings/friends');
  const inbox = useMemo(() => Object.values(received).sort((a, b) => Number(shareWaiting(b)) - Number(shareWaiting(a)) || b.receivedAt - a.receivedAt), [received]);
  const out = useMemo(() => Object.values(sent).sort((a, b) => Number(sentActive(b)) - Number(sentActive(a)) || b.updatedAt - a.updatedAt), [sent]);
  const waiting = inbox.filter(shareWaiting).length;
  return (
    <Page width="column">
      {!phone && (
        <div className="pt-6">
          <Link href="/settings/friends" className="link text-[13px]">
            Friends
          </Link>
        </div>
      )}
      <PageHeader title="Shares" className="pt-2" sub="Chats and sessions friends sent you, and the ones you sent them. Nothing a friend sends is fetched before you accept it." />
      <Section title="From friends" count={waiting || undefined} countTone="warn" id="received" className="mb-9" rows={false}>
        {inbox.length === 0 ? (
          <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">Nothing yet. When a friend sends you a chat or a session, it lands in your Inbox and here.</p>
        ) : (
          <ul className="m-0 list-none divide-y divide-rule p-0">
            {inbox.map((s) => (
              <ReceivedRow key={s.id} s={s} now={now} />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Sent" count={out.length || undefined} id="sent" rows={false}>
        {out.length === 0 ? (
          <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">You have not sent a share. Send a chat or a session from its menu, Send to friend.</p>
        ) : (
          <div className="flex flex-col gap-3 pt-3">
            {out.map((s) => (
              <SentShareCard key={s.id} s={s} />
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}

function ReceivedRow({ s, now }: { s: ReceivedShareDto; now: number }) {
  const w = receivedWords(s, now);
  return (
    <li>
      <Link href={shareHref(s.id)} className="group flex min-h-[60px] items-start gap-3 py-3">
        <span className="min-w-0 flex-1">
          <span className="t-row block truncate text-fg underline decoration-transparent underline-offset-[3px] group-hover:decoration-rule-2">{s.title}</span>
          <span className="mt-0.5 block truncate text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            From {s.friendName}. {summaryText(s.kind, s.summary)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4] phone:text-[13px]">
          <span className="num text-fg-3">{relTime(s.receivedAt, now)}</span>
          <span className={TONE[w.tone]}>{w.word}</span>
          <ShareArrived id={s.id} size={12} />
        </span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// One share from a friend
// ---------------------------------------------------------------------------

/** The share from the store, or from the hub when the store does not hold it; null when the hub does not know it. */
function useReceived(id: string): ReceivedShareDto | null | undefined {
  const stored = useHub((s) => s.receivedShares[id]);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (stored) return;
    let alive = true;
    api()
      .receivedShare(id)
      .then((r) => alive && upsertReceivedShare(r))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [id, stored]);
  return stored ?? (missing ? null : undefined);
}

/** The read only view, once accepted, again when a new revision is fetched. */
function useView(s: ReceivedShareDto | null | undefined) {
  const [view, setView] = useState<ShareViewDto>();
  const [error, setError] = useState<string>();
  const ready = s?.state === 'accepted';
  useEffect(() => {
    if (!ready || !s) return;
    let alive = true;
    setError(undefined);
    api()
      .viewShare(s.id)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [ready, s?.id, s?.acceptedRevision]);
  return { view: ready ? view : undefined, error: ready ? error : undefined };
}

function SharePage({ id }: { id: string }) {
  const phone = useIsMobile();
  const s = useReceived(id);
  const { view, error } = useView(s);
  usePageHeader(s?.title ?? 'Share', s ? friendHref(s.friendId) : '/shares');

  if (s === null) {
    const words = (
      <p className="m-0 px-[var(--gutter)] pt-6 text-[14px] text-fg-2 phone:px-5 phone:text-[15px]">
        This share is not on this hub.{' '}
        <Link href="/shares" className="link">
          All shares
        </Link>
      </p>
    );
    return phone ? (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <PhoneBar lead="back" back="/shares" title="Share" />
        {words}
      </div>
    ) : (
      words
    );
  }
  if (!s) return phone ? <PhoneBar lead="back" back="/shares" title="" /> : <LoadingRows loading rows={5} className="px-[var(--gutter)] pt-6" />;

  const body = <ShareBody s={s} view={view} error={error} />;
  if (phone)
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <PhoneBar lead="back" back={friendHref(s.friendId)} title={s.title} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-10">{body}</div>
      </div>
    );
  return (
    <Page width="column" innerClassName="max-w-[calc(820px+2*var(--gutter))]">
      <nav aria-label="Where this is" className="flex items-baseline gap-1.5 pt-6 text-[13px]">
        <Link href="/shares" className="link">
          Shares
        </Link>
        <span aria-hidden className="text-fg-4">
          /
        </span>
        <Link href={friendHref(s.friendId)} className="link">
          {s.friendName}
        </Link>
      </nav>
      <PageHeader title={s.title} className="pt-2 pb-3" />
      {body}
    </Page>
  );
}

function ShareBody({ s, view, error }: { s: ReceivedShareDto; view?: ShareViewDto; error?: string }) {
  const now = useNow(60_000);
  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-1.5">
        <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
          {s.friendName} sent it {agoText(s.receivedAt, now)}. {summaryText(s.kind, s.summary)}
          {s.revision > 1 ? `, revision ${s.revision}` : ''}.
        </p>
        {s.note && <blockquote className="m-0 border-l-2 border-rule-2 pl-3 text-[14px] leading-[1.55] whitespace-pre-wrap text-fg phone:text-[16px]">{s.note}</blockquote>}
      </header>
      <StateBlock s={s} />
      {s.state === 'accepted' && (
        <>
          {error && <p className="m-0 text-[13px] text-fault phone:text-[14px]">{error}</p>}
          {!view && !error && <LoadingRows loading rows={4} />}
          {view && <AcceptedShare s={s} view={view} />}
        </>
      )}
      <MadeFrom s={s} />
    </div>
  );
}

/** How the share stands, with what can be done about it now. */
function StateBlock({ s }: { s: ReceivedShareDto }) {
  const phone = useIsMobile();
  const now = useNow(60_000);
  const w = receivedWords(s, now);
  const { busy, run, fetching } = useShareAnswer(s);
  const size = phone ? 'touch' : 'md';
  if (s.state === 'accepted' && !s.updateWaiting) return null;
  const answer = shareWaiting(s) || s.state === 'declined' || s.state === 'fetching';
  return (
    <section aria-label="Share state" className={cn('border-l-2 py-1 pl-4', w.tone === 'warn' ? 'border-warn' : 'border-rule-2')}>
      <p className={cn('m-0 text-[14px] leading-[1.45] font-medium phone:text-[16px]', w.tone === 'dim' ? 'text-fg' : TONE[w.tone])}>{w.word}</p>
      {w.line && <p className="m-0 mt-1 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">{w.line}</p>}
      {s.state === 'offered' && <p className="m-0 mt-1 max-w-[64ch] text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">Accept fetches it from {s.friendName}'s hub and checks their key signed it. Then you can read it, continue it or apply its code.</p>}
      {answer && (
        <div className="mt-3 flex gap-2 phone:w-full">
          {s.state === 'offered' && (
            <Button variant="quiet" size={size} disabled={!!busy || fetching} busy={busy === 'decline' ? 'Declining' : false} onClick={() => void run('decline')} className="phone:flex-1">
              Decline
            </Button>
          )}
          <Button variant="solid" size={size} disabled={!!busy || fetching} busy={busy === 'accept' || fetching ? 'Fetching' : false} onClick={() => void run('accept')} className="phone:flex-1">
            {s.updateWaiting ? `Accept revision ${s.revision}` : 'Accept'}
          </Button>
        </div>
      )}
    </section>
  );
}

type Ask = 'fork' | 'handoff' | 'reference' | 'apply' | null;

function AcceptedShare({ s, view }: { s: ReceivedShareDto; view: ShareViewDto }) {
  const phone = useIsMobile();
  const [ask, setAsk] = useState<Ask>(null);
  const size = phone ? 'touch' : 'md';
  const root = view.sessions.find((x) => !x.parentId) ?? view.sessions[0];
  const subs = view.sessions.filter((x) => x !== root);
  const files = useMemo(() => (view.code?.diff ? parseDiff(view.code.diff) : []), [view.code?.diff]);
  return (
    <>
      <section aria-label="What you can do with it" className="flex flex-col gap-2">
        {/* a phone: the fork across, the rest two by two under it */}
        <div className="flex flex-wrap gap-2 phone:grid phone:grid-cols-2">
          <Button variant="solid" size={size} disabled={!view.verified.ok} onClick={() => setAsk('fork')} className="phone:col-span-2">
            Continue as fork
          </Button>
          <Button variant="outline" size={size} disabled={!view.verified.ok} onClick={() => setAsk('handoff')}>
            Handoff
          </Button>
          {view.code && (
            <Button variant="outline" size={size} disabled={!view.verified.ok} onClick={() => setAsk('apply')}>
              Apply code
            </Button>
          )}
          <Button variant="outline" size={size} disabled={!view.verified.ok} onClick={() => setAsk('reference')} className={cn(view.code && 'phone:col-span-2')}>
            Use as reference
          </Button>
        </div>
        <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Continue as fork starts a new {s.kind === 'chat' ? 'chat' : 'session'} on your models. {FORK_LINE}</p>
      </section>

      <section aria-labelledby="quoted-h">
        <SectionHeading id="quoted-h" count={root?.messages.length}>
          Conversation
        </SectionHeading>
        <Provenance s={s} view={view} />
        {root && <Quoted messages={root.messages} friend={s.friendName} />}
        {subs.map((x) => (
          <div key={x.id} className="mt-6">
            <h3 className="m-0 text-[13px] font-semibold text-fg phone:text-[15px]">Subagent: {x.title}</h3>
            <Quoted messages={x.messages} friend={s.friendName} />
          </div>
        ))}
      </section>

      {view.code && (
        <section aria-labelledby="code-h">
          <SectionHeading id="code-h">Code</SectionHeading>
          <p className="m-0 pt-3 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
            {codeWords(view.code)}
            {view.code.kind === 'git-bundle' && view.code.base ? `, from ${view.code.base.slice(0, 10)}` : ''}. Apply code puts it on a new branch after you approve the plan.
          </p>
          {view.code.excluded.length > 0 && (
            <ul className="m-0 mt-1 list-none p-0 text-[12px] leading-[1.6] text-fg-3 phone:text-[13px]">
              {view.code.excluded.map((e) => (
                <li key={e.path}>
                  Left out on their side: <span className="font-mono">{e.path}</span> ({e.reason})
                </li>
              ))}
            </ul>
          )}
          {files.length > 0 ? (
            <div className="mt-4 flex flex-col gap-5">
              {files.map((f) => (
                <Diff key={f.path} file={f} verb={f.lines.every((l) => l.type !== 'del' && l.type !== 'ctx') ? 'Added' : 'Changed'} maxLines={phone ? 24 : 40} />
              ))}
            </div>
          ) : (
            view.code.files.length > 0 && (
              <ul className="m-0 mt-2 list-none p-0 font-mono text-[12px] leading-[1.6] text-fg-2 phone:text-[13px]">
                {view.code.files.map((f) => (
                  <li key={f} className="truncate">
                    {f}
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
      )}

      <ForkDialog s={s} open={ask === 'fork'} onClose={() => setAsk(null)} />
      <HandoffDialog s={s} open={ask === 'handoff'} onClose={() => setAsk(null)} />
      <ReferenceDialog s={s} open={ask === 'reference'} onClose={() => setAsk(null)} />
      <ApplyDialog s={s} code={view.code} open={ask === 'apply'} onClose={() => setAsk(null)} />
    </>
  );
}

/** Where the turns come from, and whether the signature checks out against the friend's key. */
function Provenance({ s, view }: { s: ReceivedShareDto; view: ShareViewDto }) {
  return (
    <div className="flex flex-col gap-0.5 pt-3 pb-1">
      {view.verified.ok ? (
        <p className="m-0 flex items-center gap-1.5 text-[12px] font-medium text-ok phone:text-[13px]">
          <ShieldCheck className="size-3.5 shrink-0 phone:size-4" strokeWidth={2} aria-hidden />
          Quoted from {s.friendName}'s hub, signed by their key
        </p>
      ) : (
        <p className="m-0 flex items-center gap-1.5 text-[12px] font-medium text-fault phone:text-[13px]">
          <ShieldAlert className="size-3.5 shrink-0 phone:size-4" strokeWidth={2} aria-hidden />
          The signature does not check out: {view.verified.reason}. Accept it again.
        </p>
      )}
      <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{view.provenance}</p>
    </div>
  );
}

/** A shared conversation as quoted turns: the friend's asks in bubbles, their assistant's words and a line for its tool calls. */
function Quoted({ messages, friend }: { messages: ShareViewDto['sessions'][number]['messages']; friend: string }) {
  const units = useMemo(() => quotedUnits(messages), [messages]);
  if (!units.length) return <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[15px]">No messages in the range they shared.</p>;
  return (
    <ol className="m-0 mt-3 flex list-none flex-col gap-3 border-l-2 border-rule-2 p-0 pl-4" aria-label={`Quoted from ${friend}'s hub`}>
      {units.map((u) => (
        <li key={u.key} className="flex flex-col">
          <QuotedTurn u={u} friend={friend} />
        </li>
      ))}
    </ol>
  );
}

function QuotedTurn({ u, friend }: { u: QuotedUnit; friend: string }) {
  if (u.kind === 'user')
    return (
      <>
        <span className="text-[12px] text-fg-3 phone:text-[13px]">{friend}</span>
        <div className="t-chat mt-1 max-w-[85%] self-start rounded-[18px] bg-raise px-3.5 py-2 break-words whitespace-pre-wrap text-fg light:border light:border-rule phone:rounded-[20px] phone:bg-surface-2 phone:px-4 phone:py-2.5">
          {u.text || (u.attachments ? `${u.attachments} ${u.attachments === 1 ? 'attachment' : 'attachments'}` : '')}
        </div>
      </>
    );
  const line = toolLine(u.calls);
  return (
    <>
      {u.first && <span className="mb-1 text-[12px] text-fg-3 phone:text-[13px]">{u.model ? `${friend}'s assistant, ${modelName(u.model)}` : `${friend}'s assistant`}</span>}
      {u.text && <Markdown text={u.text} className="text-[14.5px] phone:text-[16px]" />}
      {line && (
        <p className={cn('m-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]', u.text && 'mt-1.5')}>
          {line}
          {u.failed > 0 ? `, ${u.failed} failed` : ''}
        </p>
      )}
    </>
  );
}

/** Sessions made from it here: forks, handoffs and the reference. */
function MadeFrom({ s }: { s: ReceivedShareDto }) {
  const sessions = useHub((st) => st.sessions);
  if (!s.sessions.length) return null;
  const word = { fork: 'Fork', handoff: 'Handoff', reference: 'Reference' } as const;
  return (
    <Section title="Made from it" count={s.sessions.length} rows={false}>
      <ul className="m-0 list-none p-0 pt-1">
        {s.sessions.map((x) => {
          const own = sessions[x.id];
          return (
            <li key={x.id} className="flex min-h-11 items-center gap-3 text-[13px] phone:text-[15px]">
              <span className="w-20 shrink-0 text-fg-3">{word[x.role]}</span>
              {own ? (
                <Link href={hrefOf(own)} className="link min-w-0 truncate">
                  {own.title}
                </Link>
              ) : (
                <span className="text-fg-3">Not on this hub any more</span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
