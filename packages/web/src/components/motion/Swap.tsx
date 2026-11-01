import type { ReactNode } from 'react';
import { cn } from '@/lib/text';

/**
 * One child gives way to the other in 120ms: opacity and 2px of travel, both
 * in the same cell so nothing around it moves. Copy turning into Check, Send
 * into Stop, a count changing. Under reduced motion the swap is instant.
 */
export function Swap({ on, off, children, className }: { on: boolean; off: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('cv-swap', className)}>
      <span data-off={on ? '' : undefined} aria-hidden={on || undefined} className="inline-flex">
        {off}
      </span>
      <span data-off={on ? undefined : ''} aria-hidden={!on || undefined} className="inline-flex">
        {children}
      </span>
    </span>
  );
}
