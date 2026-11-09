/**
 * Chat, Assistant, Code, Security, Canvas: the switch in the sidebar's
 * header (five icon buttons, the open one raised, like the Claude app's
 * toggle), at the top of the phone's drawer, and as the title over a phone's
 * new conversation. On a phone it is one picker that names the mode
 * ("Code"), with the five and a line each, so none is clipped. It
 * shows the mode of the conversation that is open, else the one
 * remembered; a pick opens a new conversation in that mode. Security and
 * Canvas are left out when the person turned them off (modes.tsx).
 */
import { useLocation } from 'wouter';
import { CalendarDays, Code, MessageCircle, ShieldCheck, Spline, type LucideIcon } from 'lucide-react';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Tooltip } from '@/components/ui/Tooltip';
import { SelectMenu } from '@/components/ui/Select';
import { canvasHome } from '@/features/canvas/model';
import { modeOf, readPicks, savePicks, setStartMode, START_MODES, useStartMode, type Picks, type StartMode } from './start';
import { useShownModes } from './modes';

/** The compact switch's glyphs. */
export const MODE_ICONS: Record<StartMode, LucideIcon> = { chat: MessageCircle, assistant: CalendarDays, code: Code, security: ShieldCheck, canvas: Spline };

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
  if (loc === '/canvas' || loc.startsWith('/canvas/')) return 'canvas';
  return fromSession ?? remembered;
}

/**
 * Open a new conversation in a mode: the empty page with the greeting and
 * the box. `at`: Code starts in this place (the + of a project in the
 * sidebar); the box is drawn again so it reads the new picks.
 */
export function openNew(mode: StartMode, navigate: (to: string) => void, at?: Pick<Picks, 'device' | 'cwd' | 'repo'>) {
  setStartMode(mode);
  // Canvas starts no conversation: it opens on the last file open (owner decision, PR #250)
  if (mode === 'canvas') return navigate(canvasHome());
  if (at) {
    // Security keeps picks of its own (start.ts)
    const kind = mode === 'security' ? mode : undefined;
    const picks = readPicks(kind);
    savePicks(at.repo ? { ...picks, repo: at.repo, base: undefined } : { ...picks, repo: undefined, base: undefined, device: at.device, cwd: at.cwd, cwdDevice: at.device }, kind);
    useStartMode.setState((s) => ({ fresh: s.fresh + 1 }));
  }
  navigate('/');
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true }));
}

/** The sidebar's switch: icon buttons, the open mode raised. `vertical`: a column, for the folded sidebar's strip. */
function CompactSwitch({ className, vertical }: { className?: string; vertical?: boolean }) {
  const [, navigate] = useLocation();
  const mode = useCurrentMode();
  const modes = useShownModes();
  return (
    <div role="radiogroup" aria-label="What to start" className={cn('flex items-center gap-0.5 rounded-[9px] bg-hover/60 p-0.5', vertical && 'flex-col', className)}>
      {modes.map((m) => {
        const on = m.value === mode;
        const Icon = MODE_ICONS[m.value];
        return (
          <Tooltip key={m.value} content={`${m.label}. ${m.detail}`} side={vertical ? 'right' : 'bottom'}>
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

export function ModeSwitch({ phone, compact, vertical, className }: { phone?: boolean; compact?: boolean; vertical?: boolean; className?: string }) {
  // the desktop sidebar keeps the icon switch (owner, 2026-11-07); the phone keeps the picker, where five pills were clipped
  if (compact) return <CompactSwitch className={className} vertical={vertical} />;
  return <ModePicker phone={phone} className={className} />;
}

/** One picker naming the open mode; the menu lists the five with what each does. */
function ModePicker({ phone, className }: { phone?: boolean; className?: string }) {
  const [, navigate] = useLocation();
  const mode = useCurrentMode();
  const modes = useShownModes();
  return (
    <SelectMenu
      look="text"
      label="What to start"
      value={mode}
      width={phone ? 300 : 280}
      options={modes.map((m) => ({ value: m.value, label: m.label, detail: m.detail }))}
      // a hunt or Canvas opened by a link while that mode is off still names it
      placeholder={START_MODES.find((m) => m.value === mode)?.label}
      onChange={(v) => openNew(v, navigate)}
      className={cn('font-medium text-fg', phone ? 'h-11 px-2 text-[16px]' : 'text-[13px]', className)}
    />
  );
}
