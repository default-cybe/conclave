import type { CSSProperties } from 'react';
import { cn } from '@/lib/text';

/** A plain static block for a first load that takes more than 300ms. No shimmer. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cn('block rounded-[var(--r-1)] bg-hover', className)} style={style} />;
}
