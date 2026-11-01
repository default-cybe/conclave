/**
 * A new conversation, in any of the three modes: the greeting and the box,
 * like claude.ai. Under the box, and only here, today's cards: what waits on
 * you (answerable in place) and the day's plan and proposals. Chat sends
 * start a chat at /chat/:id; Assistant and Code start a session at /s/:id
 * (SessionStart.tsx).
 *
 * With a mouse and keyboard the first key typed goes into the box; on touch
 * nothing takes focus.
 */
import { useEffect } from 'react';
import { useCoarsePointer } from '@/lib/hooks';
import { useQuietAskToasts } from '@/store/store';
import { ChatComposer } from '@/features/conversation/ChatComposer';
import { Greeting } from '@/features/conversation/Greeting';
import { useSessionTarget } from './SessionStart';
import { TodaySection } from './today';
import { WaitingSection } from './sections';
import type { StartMode } from './start';

/** The knot over the greeting: as heavy over its 26px heading as the phone's 64px mark over its 28px one. */
const MARK = 60;

const PLACEHOLDER: Record<StartMode, string> = { chat: 'Ask anything', assistant: 'Type / for commands', code: 'Type / for commands' };

export function EmptyConversation({ mode }: { mode: StartMode }) {
  const touch = useCoarsePointer();
  useTypeToStart(!touch);
  // what waits on you is listed here, answerable in place: no toast over it
  useQuietAskToasts();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div aria-hidden className="min-h-8 flex-[4]" />
      <Greeting as="h1" size={MARK} />
      <div className="mt-7">{mode === 'chat' ? <ChatComposer chatId="new" minRows={3} blurOnEsc placeholder={PLACEHOLDER.chat} /> : <SessionComposer key={mode} mode={mode} />}</div>
      <div className="mx-auto w-full max-w-[784px] space-y-7 px-8 pt-4">
        <WaitingSection open={1} />
        <TodaySection />
      </div>
      <div aria-hidden className="min-h-8 flex-[6]" />
    </div>
  );
}

function SessionComposer({ mode }: { mode: 'assistant' | 'code' }) {
  const target = useSessionTarget(mode);
  return <ChatComposer chatId={`new:${mode}`} minRows={3} blurOnEsc target={target} />;
}

/**
 * Typing on a fresh page starts the message: the first printable key with
 * nothing else focused moves focus into the box, and the key lands there.
 * The box does not take focus on load, so no caret blinks and macOS draws
 * no input source badge beside it. Once the box has had focus, keys are the
 * shell's again, so Esc then G shortcuts work as before.
 */
function useTypeToStart(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const box = () => document.querySelector<HTMLElement>('[data-composer]');
    const onKey = (e: KeyboardEvent) => {
      // "/" is the shell's key for the box; modified keys are shortcuts
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === '/') return;
      const at = document.activeElement;
      if ((at && at !== document.body) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      box()?.focus({ preventScroll: true });
      // the key is text for the box now, not a shortcut
      e.stopPropagation();
    };
    const done = (e: FocusEvent) => {
      if ((e.target as HTMLElement | null)?.matches?.('[data-composer]')) stop();
    };
    const stop = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('focusin', done);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('focusin', done);
    return stop;
  }, [on]);
}
