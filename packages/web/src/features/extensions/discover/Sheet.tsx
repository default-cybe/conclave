/**
 * The preview container (ECOSYSTEM.md 3.4): a 480px right side sheet on
 * desktop, a bottom sheet on tablets and phones (max 88vh) with the actions
 * pinned at the bottom above the safe area.
 */
import type { ReactNode } from 'react';
import { useBreakpoint } from '@/lib/hooks';
import { Sheet } from '@/components/ui/Overlay';
import { Drawer } from '../hooks/Drawer';

export function DiscoverSheet({ open, onClose, title, sub, footer, children, label }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; footer?: ReactNode; children: ReactNode; label?: string }) {
  const bp = useBreakpoint();
  if (bp === 'phone' || bp === 'tablet')
    return (
      <Sheet
        open={open}
        onClose={onClose}
        label={label ?? (typeof title === 'string' ? title : 'Preview')}
        title={
          <div className="min-w-0">
            <div className="truncate">{title}</div>
            {sub && <div className="mt-0.5 text-[13px] leading-[1.4] font-normal tracking-normal text-fg-3">{sub}</div>}
          </div>
        }
        footer={footer}
        className="min-h-[50dvh]"
      >
        <div className="px-4 pt-2 pb-6">{children}</div>
      </Sheet>
    );
  return (
    <Drawer open={open} onClose={onClose} title={title} sub={sub} footer={footer} width={480} label={label}>
      {children}
    </Drawer>
  );
}
