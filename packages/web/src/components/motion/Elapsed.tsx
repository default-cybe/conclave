import { cn } from '@/lib/text';
import { useNow } from '@/lib/hooks';
import { durationShort, elapsedClock } from '@/lib/format';
import { Roll } from './Roll';

/**
 * A ticking elapsed counter: "clock" reads 12:04, "short" reads 12m. The
 * digits roll up (Roll) on the shared one second timer. Screen readers get
 * the plain value.
 */
export function Elapsed({ since, until, format = 'clock', className }: { since: number | undefined; until?: number; format?: 'clock' | 'short'; className?: string }) {
  const now = useNow(1000);
  if (!since) return null;
  const ms = Math.max(0, (until ?? now) - since);
  return <Roll value={format === 'clock' ? elapsedClock(ms) : durationShort(ms)} direction="up" duration={format === 'clock' ? 380 : 240} className={cn('num', className)} />;
}
