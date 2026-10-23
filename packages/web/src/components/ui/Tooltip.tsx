import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/text';

type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * A small label on hover (after a delay) and on keyboard focus. Menu styled:
 * bg-raise, a rule-2 hairline, 12px text. Wraps exactly one element.
 */
export function Tooltip({ content, children, side = 'top', delay = 450, className }: { content: ReactNode; children: ReactElement; side?: Side; delay?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();

  const show = (now: boolean) => {
    clearTimeout(timer.current);
    if (now) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const gap = 6;
    let left = a.left + a.width / 2 - t.width / 2;
    let top = side === 'bottom' ? a.bottom + gap : a.top - t.height - gap;
    if (side === 'left') {
      left = a.left - t.width - gap;
      top = a.top + a.height / 2 - t.height / 2;
    } else if (side === 'right') {
      left = a.right + gap;
      top = a.top + a.height / 2 - t.height / 2;
    }
    if (side === 'top' && top < 4) top = a.bottom + gap;
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    setPos({ left, top });
  }, [open, side]);

  if (!isValidElement(children) || content === undefined || content === null || content === '') return children;
  const props = children.props as Record<string, unknown>;
  const call = (name: string, e: unknown) => (props[name] as ((e: unknown) => void) | undefined)?.(e);

  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (el: HTMLElement | null) => {
      anchor.current = el;
      const r = props.ref; // React 19: ref is a regular prop
      if (typeof r === 'function') r(el);
      else if (r && typeof r === 'object') (r as { current: unknown }).current = el;
    },
    'aria-describedby': open ? id : (props['aria-describedby'] as string | undefined),
    onPointerEnter: (e: unknown) => {
      call('onPointerEnter', e);
      if ((e as PointerEvent).pointerType === 'mouse') show(false);
    },
    onPointerLeave: (e: unknown) => {
      call('onPointerLeave', e);
      hide();
    },
    onPointerDown: (e: unknown) => {
      call('onPointerDown', e);
      hide();
    },
    onFocus: (e: unknown) => {
      call('onFocus', e);
      const el = (e as FocusEvent).target as HTMLElement | null;
      if (el?.matches?.(':focus-visible')) show(true);
    },
    onBlur: (e: unknown) => {
      call('onBlur', e);
      hide();
    },
    onKeyDown: (e: unknown) => {
      call('onKeyDown', e);
      if ((e as KeyboardEvent).key === 'Escape') hide();
    },
  });

  return (
    <>
      {child}
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className={cn('pointer-events-none fixed z-[80] max-w-[280px] rounded-[var(--r-2)] border border-rule-2 bg-raise px-2 py-1 text-[12px] leading-[1.35] text-fg-2 anim-fade', className)}
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, boxShadow: 'var(--shadow-pop)' }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
