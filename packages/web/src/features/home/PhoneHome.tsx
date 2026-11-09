/**
 * Home on a phone (the iPhone app, docs/design/MOBILE-V2.md 3) is a new
 * conversation: an empty canvas with the mark and the greeting in the
 * middle, ONE line under it (homeLine: what waits on you in amber, else
 * the next event or the learnings to review, quiet), and the composer at
 * the bottom. Chat, Assistant or Code is
 * the switch in the bar at the top (ModeSwitch.tsx), remembered on this
 * device; New opens Home with the one it was asked for (?chat, ?assistant,
 * ?code).
 */
import { useEffect } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useHub } from '@/store/store';
import { useNow } from '@/lib/hooks';
import { Mark } from '@/components/brand/Mark';
import { Docked } from '@/components/ui/Toast';
import { ChatComposer } from '@/features/conversation/ChatComposer';
import { greeting } from '@/features/conversation/units';
import { useOwnerName } from '@/features/conversation/Greeting';
import { preloadChatPage } from '@/features/conversation/lazy';
import { IncognitoBarLine } from '@/features/conversation/incognito';
import { useSessionTarget } from './SessionStart';
import { setStartMode, showsDay, useStartMode, type SessionKind } from './start';
import { useToday } from './today';
import { nextEventLine } from './proposalWords';
import { useLearningsWaiting } from '@/features/settings/reflectLearnings';
import { learningsWaitWords } from '@/features/settings/reflectWords';
import { ModesNote } from './modes';

export function PhoneHome() {
  const now = useNow(60_000);
  const name = useOwnerName();
  const waiting = useHub((s) => Object.keys(s.approvals).length + Object.keys(s.questions).length);
  // the calendar (docs/DESIGN.md, Calendar and mail): proposals wait on you too, and one quiet line says what is next
  const { data: today } = useToday();
  const mode = useStartMode((s) => s.mode);
  // the day belongs to Assistant: Chat and Code show no proposals or next event (start.ts showsDay)
  const day = showsDay(mode) ? today : undefined;
  const proposals = day?.proposals?.length ?? 0;
  const next = day?.events?.length ? nextEventLine(day.events, now, day.timezone) : undefined;
  const learnings = useLearningsWaiting();
  const line = homeLine({ waiting, proposals, next, learnings });
  const search = useSearch();
  const [, navigate] = useLocation();

  // New asks for Chat, Assistant or Code in the address, once
  useEffect(() => {
    const q = new URLSearchParams(search);
    if (!q.has('chat') && !q.has('code') && !q.has('assistant') && !q.has('security')) return;
    setStartMode(q.has('code') ? 'code' : q.has('assistant') ? 'assistant' : q.has('security') ? 'security' : 'chat');
    navigate('/', { replace: true });
  }, [search, navigate]);

  // a send opens the Chat page: have its code here first, so the message never lands on a blank page
  useEffect(() => {
    void preloadChatPage();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* the bar's Incognito is on: the mark and its memory setting */}
      {(mode === 'chat' || mode === 'code') && <IncognitoBarLine code={mode === 'code'} />}
      <ModesNote className="shrink-0 px-5" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 pb-6 text-center">
        <span data-hero-mark className="grid">
          <Mark size={64} />
        </span>
        <h1 className="m-0 mt-5 max-w-[16ch] text-[28px] leading-[1.18] font-semibold tracking-[-0.02em] text-balance text-fg" style={{ fontStretch: '104%' }}>
          {greeting(name, new Date(now))}
        </h1>
        {line && (
          <Link href={line.href} className={line.warn ? 'mt-3 flex min-h-11 items-center px-3 text-[16px] font-medium text-warn' : 'mt-3 flex min-h-11 items-center px-3 text-[15px] text-fg-3'}>
            {line.text}
          </Link>
        )}
      </div>
      <Docked>{mode === 'chat' || mode === 'canvas' ? <ChatComposer chatId="new" /> : <SessionBox key={mode} mode={mode} />}</Docked>
    </div>
  );
}

/**
 * Home's one line: what waits on you ("4 need you, 2 proposals", amber, to
 * the Inbox, or to Today when only proposals wait), else the next event,
 * else the learnings to review (quiet: nothing is blocked on them). The
 * others are one tap away in the Inbox, Today and Settings > Reflect.
 */
export function homeLine(p: { waiting: number; proposals: number; next?: string; learnings: number }): { text: string; href: string; warn: boolean } | undefined {
  const asks = [p.waiting ? `${p.waiting} ${p.waiting === 1 ? 'needs' : 'need'} you` : '', p.proposals ? `${p.proposals} ${p.proposals === 1 ? 'proposal' : 'proposals'}` : ''].filter(Boolean);
  if (asks.length) return { text: asks.join(', ') + (p.waiting ? '' : ' to approve'), href: p.waiting ? '/approvals' : '/today', warn: true };
  if (p.next) return { text: p.next, href: '/today', warn: false };
  if (p.learnings) return { text: `${p.learnings} ${learningsWaitWords(p.learnings)}`, href: '/settings/reflect', warn: false };
  return undefined;
}

function SessionBox({ mode }: { mode: SessionKind }) {
  const target = useSessionTarget(mode);
  return <ChatComposer chatId={`new:${mode}`} target={target} />;
}
