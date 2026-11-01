/**
 * A sheet over a session, opened from the "/" menu (/mcp, /context, ...).
 * The session stays where it is: no page change. On a desktop it is a panel
 * near the foot of the conversation, 760px at most; on a phone a sheet from
 * the bottom.
 *
 * It sits at z 56, under the Extensions drawers (z 58), so a form a tab
 * opens (Add a server, a hook) comes up over it, and under menus and
 * dialogs. Escape closes it only when the key comes from inside it.
 *
 * SheetRouter gives a reused Extensions tab its own address inside the
 * sheet: its filters and views change there, and a link out of it closes
 * the sheet and goes to the page.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Router, useLocation } from 'wouter';
import { X } from 'lucide-react';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { IconButton } from '@/components/ui/Button';
import { useFocusTrap } from '@/components/ui/Overlay';
import { useHeld, usePresence } from '@/components/motion/usePresence';

export function SessionSheet({ open, onClose, title, sub, children, label }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; label?: string }) {
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const { mounted, leaving } = usePresence(open, 180);
  const held = useHeld(open, { title, sub, children });
  // the sheet itself takes the focus: Tab goes on to its first control, and nothing shows a ring before you move
  useFocusTrap(ref, open, { initial: ref });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as Node | null;
      // a drawer or dialog over the sheet takes its own Escape
      if (t && t !== document.body && !ref.current?.contains(t)) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!mounted) return null;
  return createPortal(
    <div className={cn('fixed inset-0 z-[56] flex flex-col items-center justify-end', leaving && 'pointer-events-none')}>
      <div aria-hidden className={cn('absolute inset-0', leaving ? 'anim-out' : 'anim-fade')} style={{ background: 'var(--scrim)' }} onClick={onClose} />
      <div
        ref={ref}
        role={leaving ? undefined : 'dialog'}
        aria-modal={leaving ? undefined : 'true'}
        aria-label={label ?? (typeof held.title === 'string' ? held.title : undefined)}
        inert={leaving || undefined}
        tabIndex={-1}
        data-session-sheet
        className={cn(
          'relative flex flex-col bg-raise outline-none',
          mobile ? 'max-h-[92dvh] w-full rounded-t-[var(--r-3)] border-t border-rule-2 pb-safe' : 'mb-[9vh] max-h-[78vh] w-[min(760px,calc(100vw-48px))] rounded-[var(--r-3)] border border-rule-2',
          leaving ? (mobile ? 'anim-sheet-out' : 'anim-out') : mobile ? 'anim-sheet' : 'anim-pop',
        )}
        style={{ boxShadow: 'var(--shadow-pop)' }}
      >
        {mobile && (
          <div aria-hidden className="flex h-5 shrink-0 items-start justify-center pt-2">
            <div className="h-1 w-9 rounded-full bg-rule-2" />
          </div>
        )}
        <div className={cn('flex shrink-0 items-start gap-3 pr-2 pl-5', mobile ? 'pt-1 pb-2 pl-4' : 'pt-3.5 pb-3')}>
          <div className="min-w-0 flex-1 pt-1">
            <h2 className="t-title m-0 truncate text-fg">{held.title}</h2>
            {held.sub && <p className="m-0 mt-0.5 truncate text-[12px] text-fg-3 phone:text-[13px]">{held.sub}</p>}
          </div>
          <IconButton label="Close" data-close size={mobile ? 'touch' : 'md'} onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'px-4 pb-5' : 'px-5 pb-5')}>{held.children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * An address of its own for a reused page tab. Paths under `base` stay in
 * the sheet; any other address closes it and opens that page.
 */
export function SheetRouter({ base, onLeave, children }: { base: string; onLeave: () => void; children: ReactNode }) {
  const [, navigate] = useLocation();
  const leave = useRef({ onLeave, navigate });
  leave.current = { onLeave, navigate };
  const hook = useMemo(() => {
    let path = base;
    let search = '';
    const listeners = new Set<() => void>();
    const subscribe = (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    };
    const go = (to: string) => {
      const [p, q = ''] = to.split('?');
      if (p !== base && !p.startsWith(`${base}/`)) {
        leave.current.onLeave();
        leave.current.navigate(to);
        return;
      }
      path = p;
      search = q;
      for (const l of listeners) l();
    };
    const useSheetLocation = (): [string, (to: string) => void] => [useSyncExternalStore(subscribe, () => path), go];
    const useSheetSearch = () => useSyncExternalStore(subscribe, () => search);
    return Object.assign(useSheetLocation, { searchHook: useSheetSearch });
  }, [base]);
  return <Router hook={hook}>{children}</Router>;
}
