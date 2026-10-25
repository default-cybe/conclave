/** The "Why did this turn stop" card at the end of a transcript (stopCard.ts). The Retry and Try the next model buttons sit under their own notice. */
import type { Session } from '@conclave/core/types';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { stopCard } from './stopCard';

export function StopCardView({ session, className }: { session: Session; className?: string }) {
  const messages = useHub((s) => s.messages[session.id]);
  const stuckSince = useHub((s) => Object.values(s.alerts).find((a) => a.kind === 'stuck' && a.reason === 'idle' && a.sessionId === session.id)?.since);
  const card = stopCard(session, messages ?? [], { stuckSince });
  if (!card) return null;
  return (
    <div data-stop-card={card.kind} className={cn('rounded-[var(--r-1)] border border-rule-2 bg-raise px-3 py-2.5 text-[12.5px] phone:text-[14px]', className)}>
      <p className="m-0 font-medium text-fg">Why this turn stopped: {card.title}</p>
      <p className="m-0 mt-0.5 text-fg-3">{card.evidence}</p>
      <p className="m-0 mt-0.5 text-fg-2">{card.next}</p>
    </div>
  );
}
