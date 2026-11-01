import { useCallback, useRef } from 'react';
import { ApprovalCard, type ApprovalCardProps } from '@/components/inbox/ApprovalCard';
import type { Decision } from './inbox';

/**
 * The shared approval card with a stable onResolved. The card restarts its
 * confirm timer whenever onResolved changes, and pages that
 * re-render while sessions stream would otherwise keep pushing it back.
 */
export function StableApprovalCard({ onResolved, ...props }: ApprovalCardProps) {
  const latest = useRef(onResolved);
  latest.current = onResolved;
  const stable = useCallback((d: Decision, at: number) => latest.current?.(d, at), []);
  return (
    <div className="min-w-0">
      <ApprovalCard {...props} onResolved={stable} />
    </div>
  );
}
