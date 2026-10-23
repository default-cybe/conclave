/**
 * Floating layers (spec 10.12, 10.13): Popover, Menu, Dialog, Sheet, SideSheet,
 * ConfirmDialog. All use bg-raise, a rule-2 hairline and --shadow-pop.
 * Portaled; Esc and outside click close; dialogs and sheets trap focus and
 * give it back to the trigger. Each one enters in 180ms and leaves in 120ms
 * (sheets slide back down in 180ms); a leaving layer is inert and keeps its
 * last content so the exit never flashes empty.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { useHeld, usePresence } from '../motion/usePresence';
import { Button, IconButton, type ButtonVariant } from './Button';
import { Kbd } from './Kbd';

// ---------------------------------------------------------------------------
// Focus helpers
// ---------------------------------------------------------------------------

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('data-focus-skip') && el.offsetParent !== null);
}

/** Trap Tab inside `ref` while open, focus the first field, restore focus on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean, opts: { initial?: RefObject<HTMLElement | null> } = {}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // look for the first field a frame later, after the parent's own open effects have rendered (a form that opens in another mode)
    requestAnimationFrame(() => {
      const root = ref.current;
      if (root?.contains(document.activeElement)) return;
      const first = opts.initial?.current ?? (root ? (root.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? focusables(root).find((el) => !el.matches('[data-close]'))) : null);
      (first ?? root)?.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const list = focusables(ref.current);
      if (!list.length) return;
      const a = list[0];
      const z = list[list.length - 1];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Close on Escape, topmost layer first. */
const escStack: Array<() => void> = [];
function useEscape(open: boolean, onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const fn = () => cb.current();
    escStack.push(fn);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || escStack[escStack.length - 1] !== fn) return;
      e.stopPropagation();
      e.preventDefault();
      fn();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = escStack.lastIndexOf(fn);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [open]);
}

const FLOAT = 'border border-rule-2 bg-raise';

// ---------------------------------------------------------------------------
// Popover: anchored on desktop, a bottom sheet on phones
// ---------------------------------------------------------------------------

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'bottom';

export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'bottom-start',
  className,
  width,
  maxHeight = 480,
  sheetTitle,
  label,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  width?: number;
  maxHeight?: number;
  /** Title shown at the top of the phone sheet. */
  sheetTitle?: ReactNode;
  /** aria-label of the dialog */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  const mobile = useIsMobile();
  const { mounted, leaving } = usePresence(open && !mobile);
  const shown = useHeld(open, children);
  useEscape(open, onClose);

  useLayoutEffect(() => {
    if (!open || mobile) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      let top: number;
      let left: number;
      let side = placement.split('-')[0];
      if (side === 'right') {
        left = a.right + gap;
        top = a.top;
        if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
      } else {
        const below = vh - a.bottom - gap - 8;
        const above = a.top - gap - 8;
        if (side === 'bottom' && h > below && above > below) side = 'top';
        if (side === 'top' && h > above && below > above) side = 'bottom';
        top = side === 'bottom' ? a.bottom + gap : a.top - gap - Math.min(h, above);
        left = placement.endsWith('end') ? a.right - w : placement === 'bottom' ? a.left + a.width / 2 - w / 2 : a.left;
      }
      left = Math.max(8, Math.min(left, vw - w - 8));
      const maxH = side === 'top' ? a.top - gap - 8 : side === 'bottom' ? vh - a.bottom - gap - 8 : vh - 16;
      setPos({ left, top: Math.max(8, top), maxH });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, placement, mobile]);

  // give focus back to the trigger when a keyboard user closes the popover
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    return () => {
      const a = document.activeElement;
      if (!a || a === document.body || el?.contains(a)) anchor.current?.focus({ preventScroll: true });
    };
  }, [open, anchor]);

  useEffect(() => {
    if (!open || mobile) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, onClose, anchor, mobile]);

  // phones: the sheet runs its own exit
  if (mobile)
    return (
      <Sheet open={open} onClose={onClose} title={sheetTitle} label={label} className={className}>
        {shown}
      </Sheet>
    );
  if (!mounted) return null;

  return createPortal(
    <div
      ref={ref}
      role={leaving ? undefined : 'dialog'}
      aria-label={label}
      inert={leaving || undefined}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, maxHeight: pos ? Math.min(pos.maxH, maxHeight) : undefined, boxShadow: 'var(--shadow-pop)' }}
      className={cn('fixed z-[75] flex flex-col overflow-hidden rounded-[var(--r-2)]', leaving ? 'anim-out' : 'anim-pop', FLOAT, className)}
    >
      <div className="flex min-h-0 flex-col overflow-y-auto">{shown}</div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: ReactNode;
  /** A logo before the label (models, providers). */
  lead?: ReactNode;
  /** Right aligned hint: a kbd string ("⌘K") or a node. */
  hint?: ReactNode;
  /** Quiet second line under the label. */
  detail?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
  separator?: boolean;
  /** A group label row (meta, fg-3) */
  group?: boolean;
  /** Keep the menu open after selecting. */
  keep?: boolean;
}

/** Menu rows with arrow key navigation. Rows 30px (44 on phones), 8px padding. */
export function MenuList({ items, onDone, className, autoFocus = true, label }: { items: MenuItem[]; onDone: () => void; className?: string; autoFocus?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const first = ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true]),[role=menuitemcheckbox]:not([aria-disabled=true])');
    requestAnimationFrame(() => first?.focus({ preventScroll: true }));
  }, [autoFocus]);
  const onKey = (e: ReactKeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem],[role=menuitemcheckbox]') ?? [])].filter((el) => el.getAttribute('aria-disabled') !== 'true');
    const i = list.indexOf(document.activeElement as HTMLElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') n = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      n = list.findIndex((el, j) => j > i && (el.textContent ?? '').trim().toLowerCase().startsWith(k));
      if (n < 0) n = list.findIndex((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(k));
    }
    if (n >= 0 && list[n]) {
      e.preventDefault();
      list[n].focus();
    }
  };
  return (
    <div ref={ref} role="menu" aria-label={label} onKeyDown={onKey} className={cn('p-1', className)}>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} role="separator" className="mx-1 my-1 h-px bg-rule" />;
        if (it.group)
          return (
            <div key={i} className="px-2 pt-2 pb-1 text-[12px] text-fg-3">
              {it.label}
            </div>
          );
        const check = it.checked !== undefined;
        return (
          <button
            key={i}
            type="button"
            role={check ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={check ? it.checked : undefined}
            aria-disabled={it.disabled || undefined}
            tabIndex={-1}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect?.();
              if (!it.keep) onDone();
            }}
            className={cn(
              'flex min-h-[30px] w-full items-center gap-2 rounded-[var(--r-1)] px-2 py-1 text-left text-[13px] outline-none phone:min-h-11 phone:text-[15px]',
              it.disabled ? 'text-fg-3' : it.danger ? 'text-fault hov:bg-hover focus-visible:bg-hover' : 'text-fg hov:bg-hover focus-visible:bg-hover',
              'focus-visible:outline-none',
            )}
          >
            {it.lead && <span className="flex shrink-0 items-center">{it.lead}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{it.label}</span>
              {it.detail && <span className="block truncate text-[12px] text-fg-3">{it.detail}</span>}
            </span>
            {it.hint && <span className="ml-3 shrink-0 text-[12px] text-fg-3">{typeof it.hint === 'string' ? <Kbd>{it.hint}</Kbd> : it.hint}</span>}
            {check && <Check className={cn('size-3.5 shrink-0', !it.checked && 'invisible')} strokeWidth={1.75} />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A trigger plus its menu. The trigger is rendered by you so it can be a
 * text button, an IconButton with MoreHorizontal, or a row action.
 */
export function Menu({
  trigger,
  items,
  placement = 'bottom-end',
  width = 220,
  label,
}: {
  trigger: (p: { ref: RefObject<HTMLButtonElement | null>; open: boolean; toggle: () => void; props: { 'aria-haspopup': 'menu'; 'aria-expanded': boolean; onClick: () => void } }) => ReactNode;
  items: MenuItem[];
  placement?: Placement;
  width?: number;
  label?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      {trigger({ ref, open, toggle, props: { 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: toggle } })}
      <Popover anchor={ref} open={open} onClose={close} placement={placement} width={width} label={label}>
        <MenuList items={items} onDone={close} label={label} />
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
  className,
  bodyClassName,
  top,
  label,
  closeButton = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Actions, bottom right, 8px apart, primary last. */
  footer?: ReactNode;
  /** 480 default, 560 for a confirm with code, 640 for the palette. */
  width?: number;
  className?: string;
  bodyClassName?: string;
  /** Distance from the top on desktop. Default 12vh. */
  top?: string;
  /** aria-label when there is no title */
  label?: string;
  closeButton?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const { mounted, leaving } = usePresence(open, mobile ? 180 : 120);
  const held = useHeld(open, { title, description, children, footer });
  useEscape(open, onClose);
  useFocusTrap(ref, open);
  useLockScroll(open);
  if (!mounted) return null;
  // while it leaves, it shows what it showed when it closed
  ({ title, description, children, footer } = held);
  return createPortal(
    <div className={cn('fixed inset-0 z-[70] flex items-end justify-center md:items-start', leaving && 'pointer-events-none')} style={{ paddingTop: mobile ? undefined : (top ?? '12vh') }}>
      <div className={cn('absolute inset-0', leaving ? 'anim-out' : 'anim-fade')} style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role={leaving ? undefined : 'dialog'}
        aria-modal={leaving ? undefined : 'true'}
        aria-label={typeof title === 'string' ? title : label}
        inert={leaving || undefined}
        tabIndex={-1}
        style={{ maxWidth: mobile ? undefined : width, boxShadow: 'var(--shadow-pop)' }}
        className={cn(
          'relative flex w-full flex-col overflow-hidden outline-none',
          FLOAT,
          mobile ? cn('max-h-[88dvh] rounded-t-[var(--r-3)] border-x-0 border-b-0 pb-safe', leaving ? 'anim-sheet-out' : 'anim-sheet') : cn('max-h-[76vh] rounded-[var(--r-2)]', leaving ? 'anim-out' : 'anim-rise'),
          className,
        )}
      >
        {mobile && <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-rule-2" />}
        {(title || description || closeButton) && (
          <div className="flex shrink-0 items-start gap-3 px-5 pt-[18px] pb-2">
            <div className="min-w-0 flex-1">
              {title && <h2 className="t-title text-fg">{title}</h2>}
              {description && <p className="mt-1 text-[14px] leading-[1.45] text-fg-2">{description}</p>}
            </div>
            {closeButton && (
              <IconButton label="Close" size="sm" onClick={onClose} className="-mt-0.5 -mr-1.5" data-close tooltip={false}>
                <X />
              </IconButton>
            )}
          </div>
        )}
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 pb-5 text-[14px] text-fg-2', !title && !description && !closeButton && 'pt-5', bodyClassName)}>{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pb-5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirm a destructive action. Name the thing in the question:
 * "Delete routine Server watchdog? Its 48 past runs stay in the history."
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirm = 'Delete',
  cancel = 'Cancel',
  tone = 'danger',
  busy,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  body?: ReactNode;
  /** The verb on the confirm button: "Delete", "Revoke", "Restore". */
  confirm?: string;
  cancel?: string;
  tone?: 'danger' | 'neutral';
  /** Progressive verb while confirming ("Deleting"). */
  busy?: string;
  children?: ReactNode;
  width?: number;
}) {
  const [working, setWorking] = useState(false);
  const mobile = useIsMobile();
  const variant: ButtonVariant = tone === 'danger' ? 'danger-outline' : 'solid';
  // phones get 44px targets
  const size = mobile ? 'touch' : 'md';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={width}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose}>
            {cancel}
          </Button>
          <Button
            variant={variant}
            size={size}
            busy={working ? (busy ?? true) : false}
            onClick={async () => {
              setWorking(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setWorking(false);
              }
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {body && <p>{body}</p>}
      {children}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * Phone bottom sheet: full width, top corners r-3, a grabber, max 88vh, safe
 * area padding. Swipe down on the grabber or tap the scrim to close.
 */
export function Sheet({ open, onClose, title, children, className, label, footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; className?: string; label?: string; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const { mounted, leaving } = usePresence(open, 180);
  const held = useHeld(open, { title, children, footer });
  useEscape(open, onClose);
  useFocusTrap(ref, open);
  useLockScroll(open);
  useEffect(() => {
    if (open) setDrag(0);
  }, [open]);
  if (!mounted) return null;
  // while it leaves, it shows what it showed when it closed
  ({ title, children, footer } = held);
  return createPortal(
    <div className={cn('fixed inset-0 z-[70] flex flex-col justify-end', leaving && 'pointer-events-none')}>
      <div className={cn('absolute inset-0', leaving ? 'anim-out' : 'anim-fade')} style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role={leaving ? undefined : 'dialog'}
        aria-modal={leaving ? undefined : 'true'}
        aria-label={typeof title === 'string' ? title : label}
        inert={leaving || undefined}
        tabIndex={-1}
        // a sheet let go after a drag slides on down from where the finger left it
        style={{ transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? 'none' : undefined }}
        className={cn('relative flex max-h-[88dvh] flex-col rounded-t-[var(--r-3)] border-t border-rule-2 bg-raise pb-safe outline-none', leaving ? 'anim-sheet-out' : !drag && 'anim-sheet', className)}
      >
        <div
          className="flex h-6 shrink-0 touch-none items-start justify-center pt-2"
          onPointerDown={(e) => {
            start.current = e.clientY;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            start.current = null;
            if (drag > 80) onClose();
            else setDrag(0);
          }}
        >
          <div aria-hidden className="h-1 w-9 rounded-full bg-rule-2" />
        </div>
        {title && <div className="t-title shrink-0 px-4 pb-2 text-fg">{title}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t border-rule px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Side sheet from the right (tablet and desktop below 1280): bg, a rule
 * left border, no shadow. Used for the chat context panel and task details.
 */
export function SideSheet({ open, onClose, children, width = 340, className, label, modal = true }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; className?: string; label?: string; modal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = usePresence(open);
  const shown = useHeld(open, children);
  useEscape(open, onClose);
  useFocusTrap(ref, open && modal);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[65] flex justify-end" style={{ pointerEvents: modal && !leaving ? 'auto' : 'none' }}>
      {modal && <div className={cn('absolute inset-0', leaving ? 'anim-out' : 'anim-fade')} style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden />}
      <div
        ref={ref}
        role={leaving ? undefined : 'dialog'}
        aria-modal={(modal && !leaving) || undefined}
        aria-label={label}
        inert={leaving || undefined}
        tabIndex={-1}
        style={{ width, pointerEvents: leaving ? 'none' : 'auto' }}
        className={cn('relative flex h-full max-w-full flex-col overflow-y-auto border-l border-rule bg-bg pt-safe pb-safe outline-none', leaving ? 'anim-right-out' : 'anim-right', className)}
      >
        {shown}
      </div>
    </div>,
    document.body,
  );
}

let locks = 0;
function useLockScroll(on: boolean) {
  useEffect(() => {
    if (!on) return;
    locks++;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      if (--locks <= 0) {
        locks = 0;
        document.documentElement.style.overflow = '';
      }
    };
  }, [on]);
}
