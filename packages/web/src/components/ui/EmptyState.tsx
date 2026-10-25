import type { ReactNode } from 'react';
import { cn } from '@/lib/text';
import { Wave } from '../wave';
import { Button } from './Button';
import { useDelayed } from '@/lib/hooks';
import { KnotRope } from '../motion/KnotRope';
import { Pet } from '../motion/Pet';

/**
 * Empty state (spec 10.23): an ambient wave band (72px, 56 on phones), one
 * sentence that says what will appear and how to cause it, one outline
 * action. Left aligned with the column, never centered in the viewport.
 */
export function EmptyState({
  children,
  action,
  wave = true,
  pet,
  className,
}: {
  /** The sentence. */
  children: ReactNode;
  /** One action: { label, onClick } or your own node. */
  action?: { label: string; onClick: () => void } | ReactNode;
  /** Draw the ambient band. Default true; turn off for a second empty state on the same screen. */
  wave?: boolean;
  /** The idle pet in place of the wave (CHAT-AND-MOTION 1.11). */
  pet?: boolean;
  className?: string;
}) {
  const act =
    action && typeof action === 'object' && 'label' in (action as object) && 'onClick' in (action as object) ? (
      <Button variant="outline" onClick={(action as { onClick: () => void }).onClick}>
        {(action as { label: string }).label}
      </Button>
    ) : (
      (action as ReactNode)
    );
  return (
    <div className={cn('py-4', className)}>
      {pet ? <Pet state="idle" size={48} className="text-fg-2" /> : wave && <Wave variant="ambient" className="h-[72px] phone:h-14" />}
      <p className={cn('max-w-[60ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]', (wave || pet) && 'mt-4')}>{children}</p>
      {act && <div className="mt-4">{act}</div>}
    </div>
  );
}

/**
 * First load: the knot runs where the rows will come (waiting on the hub,
 * docs/design/KNOT-MOTION.md), shown only after 300ms (spec 2). `rows` is
 * how many rows are coming: the space it keeps grows with it, up to three.
 */
export function LoadingRows({ loading, rows = 4, className }: { loading: boolean; rows?: number; className?: string }) {
  const show = useDelayed(loading, 300);
  if (!show) return null;
  return (
    <div className={cn('flex items-start py-4', className)} style={{ minHeight: 56 * Math.min(3, rows) }} role="status" aria-busy="true" aria-label="Loading">
      <KnotRope moment="run" size={32} className="anim-fade" />
    </div>
  );
}
