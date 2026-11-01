/**
 * Chat, Assistant, Code: the switch in the sidebar's header (three small
 * icon buttons, like the Claude app's chat and code toggle), at the top of
 * the phone's drawer, and as the title over a phone's new conversation. It
 * shows the mode of the conversation that is open, else the one
 * remembered; a press opens a new conversation in that mode.
 */
import { useLocation } from 'wouter';
import { CalendarDays, Code, MessageCircle, type LucideIcon } from 'lucide-react';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Tooltip } from '@/components/ui/Tooltip';
import { modeOf, readPicks, savePicks, setStartMode, START_MODES, useStartMode, type Picks, type StartMode } from './start';

/** The compact switch's glyphs. */
export const MODE_ICONS: Record<StartMode, LucideIcon> = { chat: MessageCircle, assistant: CalendarDays, code: Code };

/** The mode of what is on screen: the open chat or session's, else the switch's. */
export function useCurrentMode(): StartMode {
  const [loc] = useLocation();
  const remembered = useStartMode((s) => s.mode);
  const fromSession = useHub((s) => {
    const id = loc.startsWith('/s/') ? loc.slice(3).split('/')[0] : undefined;
    const session = id ? s.sessions[id] : undefined;
    return session ? modeOf(session) : undefined;
  });
  if (loc === '/chat' || loc.startsWith('/chat/')) return 'chat';
  return fromSession ?? remembered;
}

/**
 * Open a new conversation in a mode: the empty page with the greeting and
 * the box. `at`: Code starts in this place (the + of a project in the
 * sidebar); the box is drawn again so it reads the new picks.
 */
export function openNew(mode: StartMode, navigate: (to: string) => void, at?: Pick<Picks, 'device' | 'cwd' | 'repo'>) {
  setStartMode(mode);
  if (at) {
    const picks = readPicks();
    savePicks(at.repo ? { ...picks, repo: at.repo, base: undefined } : { ...picks, repo: undefined, base: undefined, device: at.device, cwd: at.cwd, cwdDevice: at.device });
    useStartMode.setState((s) => ({ fresh: s.fresh + 1 }));
  }
  navigate('/');
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true }));
}

/** The sidebar's switch: three icon buttons, the open mode raised. */
function CompactSwitch({ className }: { className?: string }) {
  const [, navigate] = useLocation();
  const mode = useCurrentMode();
  return (
    <div role="radiogroup" aria-label="What to start" className={cn('flex items-center gap-0.5 rounded-[9px] bg-hover/60 p-0.5', className)}>
      {START_MODES.map((m) => {
        const on = m.value === mode;
        const Icon = MODE_ICONS[m.value];
        return (
          <Tooltip key={m.value} content={`${m.label}. ${m.detail}`} side="bottom">
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={m.label}
              onClick={() => openNew(m.value, navigate)}
              className={cn(
                'grid size-[26px] place-items-center rounded-[7px] transition-colors duration-[var(--dur-1)] focus-visible:outline-offset-1',
                on ? 'bg-raise text-fg shadow-[0_0_0_1px_var(--rule)]' : 'text-fg-3 hov:text-fg',
              )}
            >
              <Icon className="size-[15px]" strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function ModeSwitch({ phone, compact, className }: { phone?: boolean; compact?: boolean; className?: string }) {
  if (compact) return <CompactSwitch className={className} />;
  return <WordSwitch phone={phone} className={className} />;
}

function WordSwitch({ phone, className }: { phone?: boolean; className?: string }) {
  const [, navigate] = useLocation();
  const mode = useCurrentMode();
  return (
    <div role="radiogroup" aria-label="What to start" className={cn('flex items-center rounded-full p-0.5', phone ? 'gap-0 bg-surface-2' : 'gap-0.5 bg-sunk', className)}>
      {START_MODES.map((m) => {
        const on = m.value === mode;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={phone ? undefined : m.detail}
            onClick={() => openNew(m.value, navigate)}
            className={cn(
              'flex items-center rounded-full font-medium whitespace-nowrap transition-colors duration-[var(--dur-1)] focus-visible:outline-offset-1',
              phone ? 'h-9 px-3 text-[14px]' : 'h-[26px] px-3 text-[13px]',
              on ? 'bg-raise text-fg shadow-[inset_0_0_0_1px_var(--rule)]' : 'text-fg-3 hov:text-fg active:bg-hover',
            )}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
