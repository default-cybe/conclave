/**
 * The task details side sheet (spec 11.4, 480px from the right, bg, a rule
 * on the left, no shadow). Same look as the shared SideSheet, but it sits
 * one layer lower (z 58) so the pickers and menus inside it, which open in
 * shared popovers at z 60, show above it instead of behind it.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/components/ui/Overlay';

export function DetailSheet({ open, onClose, children, width = 480, label }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useFocusTrap(ref, open);

  // Escape closes the sheet. Open popovers handle Escape first in the capture
  // phase and stop it, so this only fires when nothing is layered above.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[58] flex justify-end">
      <div className="absolute inset-0 anim-fade" style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{ width }}
        className="relative flex h-full max-w-full flex-col overflow-hidden border-l border-rule bg-bg pt-safe pb-safe outline-none anim-right"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
