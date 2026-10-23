import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { X } from 'lucide-react';
import { cn } from '@/lib/text';
import { dismissToast, useHub, type Toast } from '@/store/store';
import { useUi } from '@/store/ui';
import { useIsMobile } from '@/lib/hooks';
import { usePresenceList } from '../motion/usePresence';
import { WatchStrip } from '@/features/watches/WatchStrip';

/**
 * Toasts (spec 10.14), as one stack (ui.html toast-stack): bottom left on
 * desktop. On phones a toast never covers a card's buttons or the composer:
 * it sits under the top bar, where the page's top scrolls by; with a sheet
 * open it moves above the sheet, and the side panel opens over it. The newest toast is in front; older ones sit behind it, 11px
 * further from the edge and 5% smaller, words hidden. Hover or focus fans the stack out so every toast reads; leaving
 * restacks it. Positions move on the critically damped spring (--spring).
 * A toast rises 18px and fades in; it leaves with a 6px drop and a fade,
 * or slides 22px right when you dismiss it. Saved, copied and undo all land
 * here. One line plus at most one text action. Auto dismiss after 5s
 * unless sticky; the timers wait while the stack is fanned. Failures start
 * with "Failed." in fault. At most three. Raise one with toast() from store/store.
 */
export function Toaster() {
  const toasts = useHub((s) => s.toasts);
  const mobile = useIsMobile();
  const shown = usePresenceList(toasts.slice(-3), toastKey, 200);
  const sheet = useSheetOpen(mobile && shown.length > 0);
  const panel = useUi((s) => s.panelOpen) && mobile;
  const [fan, setFan] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const dismissed = useRef(new Set<string>());
  const box = useRef<HTMLDivElement>(null);

  // measure each toast (transforms do not change offsetHeight)
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const next: Record<string, number> = {};
    let changed = false;
    for (const n of el.querySelectorAll<HTMLElement>('[data-toast]')) {
      const h = n.offsetHeight;
      next[n.dataset.toast!] = h;
      if (heights[n.dataset.toast!] !== h) changed = true;
    }
    if (changed || Object.keys(next).length !== Object.keys(heights).length) setHeights(next);
  });

  // nothing left to fan
  useEffect(() => {
    if (!shown.some((s) => !s.leaving)) setFan(false);
  }, [shown]);

  if (!shown.length) return null;
  const top = mobile;
  const sign = top ? 1 : -1;
  const GAP = 8;
  const PEEK = 11;
  // front is the newest toast still showing; a leaving toast keeps its slot while it goes
  const order = [...shown].reverse();
  let liveIdx = 0;
  let offset = 0;
  const slots = order.map((s) => {
    const idx = s.leaving ? Math.max(0, liveIdx - 1) : liveIdx++;
    const h = heights[s.key] ?? 40;
    const fanned = offset;
    if (!s.leaving) offset += h + GAP;
    return { ...s, idx, fanned };
  });
  const live = liveIdx;
  const frontH = heights[order.find((s) => !s.leaving)?.key ?? ''] ?? 40;
  const height = fan ? Math.max(frontH, offset - GAP) : frontH + Math.max(0, live - 1) * PEEK;

  return (
    <div
      ref={box}
      role="region"
      aria-label="Notifications"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setFan(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setFan(false)}
      onFocus={() => setFan(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFan(false);
      }}
      onClick={(e) => {
        // phones: a tap on the stack fans it out; a tap on a button does its job
        if (mobile && !(e.target as HTMLElement).closest('button') && live > 1) setFan((f) => !f);
      }}
      className={cn(
        'cv-toasts fixed',
        // phones: under the 56px top bar; a sheet leaves the top of the screen free; the side panel goes over it (z 60).
        // computers: at the bottom left of the page, past the sidebar (--side-w, Sidebar.tsx)
        mobile ? cn('inset-x-4', sheet ? 'top-[calc(var(--safe-t)+8px)]' : 'top-[calc(var(--safe-t)+64px)]', panel ? 'z-[55]' : 'z-[90]') : 'bottom-6 left-[calc(var(--side-w,0px)+24px)] z-[90] w-[360px]',
      )}
      style={{ height } as CSSProperties}
      data-fan={fan || undefined}
      data-top={top || undefined}
    >
      {slots.map(({ item, key, leaving, idx, fanned }) => {
        const y = fan ? fanned : idx * PEEK;
        const scale = fan ? 1 : 1 - idx * 0.05;
        return (
          <div
            key={key}
            data-toast={key}
            className="cv-toast-slot"
            style={
              {
                transform: `translateY(${sign * y}px) scale(${scale})`,
                zIndex: 10 - idx,
                [top ? 'top' : 'bottom']: 0,
                transformOrigin: top ? '50% 0' : '50% 100%',
              } as CSSProperties
            }
          >
            <ToastItem t={item} leaving={leaving} dismissed={dismissed.current.has(key)} hidden={!fan && idx > 0 && !leaving} paused={fan} onDismiss={() => dismissed.current.add(key)} top={top} />
          </div>
        );
      })}
    </div>
  );
}

/** True while a modal dialog or sheet is open (not the side panel). Dialogs portal straight into body. */
function useSheetOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const check = () => setOpen(!!document.querySelector('[role="dialog"][aria-modal="true"]:not([data-panel])'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true });
    return () => mo.disconnect();
  }, [enabled]);
  return enabled && open;
}

const toastKey = (t: Toast) => t.id;

function ToastItem({ t, leaving, dismissed, hidden, paused: stackPaused, onDismiss, top }: { t: Toast; leaving: boolean; dismissed: boolean; hidden: boolean; paused: boolean; onDismiss: () => void; top: boolean }) {
  const [, navigate] = useLocation();
  const [hover, setHover] = useState(false);
  const paused = hover || stackPaused;
  const left = useRef(t.sticky ? Infinity : (t.ttl ?? 5000));
  useEffect(() => {
    if (paused || left.current === Infinity) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => dismissToast(t.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - startedAt;
    };
  }, [paused, t.id]);
  const failed = t.level === 'error';
  const title = failed ? t.title.replace(/^(request )?failed[.:]?\s*/i, '') : t.title;
  const text = [title, t.body].filter(Boolean).join(title && !/[.?!]$/.test(title) ? '. ' : ' ');
  const close = () => {
    onDismiss();
    dismissToast(t.id);
  };
  return (
    <div
      role={failed ? 'alert' : 'status'}
      inert={leaving || hidden || undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={cn(
        'cv-toast flex w-full min-w-0 gap-3 rounded-[var(--r-2)] border border-rule-2 bg-raise py-2 pr-2 pl-3 text-[13px] leading-[1.4] text-fg phone:text-[14px]',
        t.watch ? 'flex-col gap-2' : 'items-center',
        leaving ? (dismissed ? 'cv-toast-gone' : 'cv-toast-out') : top ? 'cv-toast-in-top' : 'cv-toast-in',
      )}
      style={{ boxShadow: 'var(--shadow-pop)' }}
    >
      <div className="cv-toast-body flex min-w-0 flex-1 items-center gap-3" data-hidden={hidden || undefined}>
        <p
          className={cn('min-w-0 flex-1 truncate', t.link && 'cursor-default')}
          onClick={
            t.link
              ? () => {
                  navigate(t.link!);
                  dismissToast(t.id);
                }
              : undefined
          }
          title={text}
        >
          {failed && <span className="text-fault">Failed. </span>}
          {text}
        </p>
        {t.action && (
          <button
            type="button"
            onClick={() => {
              t.action!.run();
              dismissToast(t.id);
            }}
            className="shrink-0 rounded-[var(--r-1)] px-1.5 py-0.5 font-medium text-fg hov:bg-hover"
          >
            {t.action.label}
          </button>
        )}
        {!t.action && t.link && (
          <button
            type="button"
            onClick={() => {
              navigate(t.link!);
              dismissToast(t.id);
            }}
            className="shrink-0 rounded-[var(--r-1)] px-1.5 py-0.5 font-medium text-fg hov:bg-hover"
          >
            Open
          </button>
        )}
        <button type="button" onClick={close} aria-label="Dismiss" className="grid size-6 shrink-0 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {/* a watch's notice: the photos of what changed, under the line (features/watches) */}
      {t.watch && !hidden && <WatchStrip notice={t.watch} />}
    </div>
  );
}

/** The foot of a page that holds a composer (Chat, a session), clear of the home indicator. Toasts on phones stay at the top, away from it. */
export function Docked({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('shrink-0 pb-safe', className)}>{children}</div>;
}
