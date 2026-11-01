/**
 * A detail or form panel from the right (bg, a rule on the left, no shadow),
 * full screen on phones. Used by Hooks, Plugins and MCP servers.
 *
 * It sits at z 58, under the shared popovers (z 75), so pickers and menus
 * inside it open above it; confirm dialogs (z 70) open above both. Escape
 * closes it only when no layer above has taken the key.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { IconButton } from '@/components/ui/Button';
import { useFocusTrap } from '@/components/ui/Overlay';

export function Drawer({
  open,
  onClose,
  title,
  sub,
  children,
  footer,
  width = 600,
  label,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One line under the title (meta, fg-3). */
  sub?: ReactNode;
  children: ReactNode;
  /** Actions, right aligned, primary last. */
  footer?: ReactNode;
  width?: number;
  /** aria-label when the title is not plain text. */
  label?: string;
  bodyClassName?: string;
}) {
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useFocusTrap(ref, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    // keep the page behind still, also after a dialog opened over the drawer frees it on close
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = 'hidden';
    const keep = new MutationObserver(() => {
      if (root.style.overflow !== 'hidden') root.style.overflow = 'hidden';
    });
    keep.observe(root, { attributes: true, attributeFilter: ['style'] });
    return () => {
      keep.disconnect();
      document.removeEventListener('keydown', onKey);
      root.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[58] flex justify-end">
      {!mobile && <div className="absolute inset-0 anim-fade" style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden />}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        tabIndex={-1}
        style={{ width: mobile ? '100%' : width }}
        className={cn('relative flex h-full max-w-full flex-col overflow-hidden bg-bg pt-safe pb-safe outline-none', mobile ? 'anim-fade' : 'border-l border-rule anim-right')}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-rule px-5 pt-4 pb-3.5 phone:px-4 phone:pt-2 phone:pb-3">
          <div className="min-w-0 flex-1 phone:pt-2.5">
            <h2 className="t-title truncate text-fg">{title}</h2>
            {sub && <div className="mt-0.5 min-w-0 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">{sub}</div>}
          </div>
          <IconButton label="Close" size={mobile ? 'touch' : 'sm'} onClick={onClose} data-close tooltip={false} className={cn(!mobile && '-mr-1.5')}>
            <X />
          </IconButton>
        </header>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 phone:px-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3 phone:px-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
