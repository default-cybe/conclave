/**
 * Home on a phone (the iPhone app, docs/design/MOBILE-V2.md 3) is a new
 * conversation: an empty canvas with the mark and the greeting in the
 * middle, one line in amber when something waits on you ("2 need you", to
 * the Inbox), and the composer at the bottom. Chat, Assistant or Code is
 * the switch in the bar at the top (ModeSwitch.tsx), remembered on this
 * device; New opens Home with the one it was asked for (?chat, ?assistant,
 * ?code).
 */
import { useEffect } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { useNow } from '@/lib/hooks';
import { Mark } from '@/components/brand/Mark';
import { Docked } from '@/components/ui/Toast';
import { ChatComposer } from '@/features/conversation/ChatComposer';
import { greeting } from '@/features/conversation/units';
import { useOwnerName } from '@/features/conversation/Greeting';
import { preloadChatPage } from '@/features/conversation/lazy';
import { useSessionTarget } from './SessionStart';
import { setStartMode, useStartMode } from './start';
import { useToday } from './today';
import { nextEventLine } from './proposalWords';

export function PhoneHome() {
  const now = useNow(60_000);
  const name = useOwnerName();
  const waiting = useHub((s) => Object.keys(s.approvals).length + Object.keys(s.questions).length);
  // the calendar (docs/DESIGN.md, Calendar and mail): proposals wait on you too, and one quiet line says what is next
  const { data: today } = useToday();
  const proposals = today?.proposals?.length ?? 0;
  const next = today?.events?.length ? nextEventLine(today.events, now, today.timezone) : undefined;
  const mode = useStartMode((s) => s.mode);
  const search = useSearch();
  const [, navigate] = useLocation();

  // New asks for Chat, Assistant or Code in the address, once
  useEffect(() => {
    const q = new URLSearchParams(search);
    if (!q.has('chat') && !q.has('code') && !q.has('assistant')) return;
    setStartMode(q.has('code') ? 'code' : q.has('assistant') ? 'assistant' : 'chat');
    navigate('/', { replace: true });
  }, [search, navigate]);

  // a send opens the Chat page: have its code here first, so the message never lands on a blank page
  useEffect(() => {
    void preloadChatPage();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 pb-6 text-center">
        <span data-hero-mark className="grid">
          <Mark size={64} />
        </span>
        <h1 className="m-0 mt-5 max-w-[16ch] text-[28px] leading-[1.18] font-semibold tracking-[-0.02em] text-balance text-fg" style={{ fontStretch: '104%' }}>
          {greeting(name, new Date(now))}
        </h1>
        {waiting > 0 && (
          <Link href="/approvals" className="mt-3 flex min-h-11 items-center px-3 text-[16px] font-medium text-warn">
            {waiting} {waiting === 1 ? 'needs' : 'need'} you
          </Link>
        )}
        {proposals > 0 && (
          <Link href="/today" className={cn('flex min-h-11 items-center px-3 text-[16px] font-medium text-warn', waiting > 0 ? 'mt-0' : 'mt-3')}>
            {proposals} {proposals === 1 ? 'proposal' : 'proposals'} to approve
          </Link>
        )}
        {next && (
          <Link href="/today" className={cn('flex min-h-11 items-center px-3 text-[15px] text-fg-3', waiting + proposals > 0 ? 'mt-0' : 'mt-3')}>
            {next}
          </Link>
        )}
      </div>
      <Docked>{mode === 'chat' ? <ChatComposer chatId="new" /> : <SessionBox key={mode} mode={mode} />}</Docked>
    </div>
  );
}

function SessionBox({ mode }: { mode: 'assistant' | 'code' }) {
  const target = useSessionTarget(mode);
  return <ChatComposer chatId={`new:${mode}`} target={target} />;
}
