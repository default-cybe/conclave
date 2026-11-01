import type { ReactNode } from 'react';
import { cn } from '@/lib/text';
import { Roll } from '../motion/Roll';

/**
 * A readout (spec 10.8): the number in stat size (20/540, tabular) with a
 * label under it in meta fg-3. No box, no icon, no trend arrow, no sparkline.
 * A delta, when needed, is a word under the label. A plain number or
 * figure rolls when it changes (Roll): only the changed digits move.
 */
export function Stat({ value, label, delta, tone, className }: { value: ReactNode; label: ReactNode; delta?: ReactNode; tone?: 'warn' | 'fault' | 'ok'; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className={cn('t-stat truncate', tone === 'warn' ? 'text-warn' : tone === 'fault' ? 'text-fault' : tone === 'ok' ? 'text-ok' : 'text-fg')}>{typeof value === 'string' || typeof value === 'number' ? <Roll value={value} /> : value}</div>
      <div className="mt-1 truncate text-[12px] text-fg-3 phone:text-[13px]">{label}</div>
      {delta && <div className="truncate text-[12px] text-fg-3">{delta}</div>}
    </div>
  );
}

/** Stats in a row split by 1px rules with 20px padding. At most four. */
export function StatGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-start [&>*]:flex-1 [&>*+*]:border-l [&>*+*]:border-rule [&>*+*]:pl-5 [&>*:not(:last-child)]:pr-5', className)}>{children}</div>;
}
