/**
 * The knot rope on the friends screens (docs/design/KNOT-MOTION.md 5): a
 * share that arrives while you watch ties the rope in on its card
 * (receive), and a friend just added ties the knot by their name
 * (success). Send plays in the sent state of Send to friend. Each plays
 * once; a moment that has played stays a beat, then goes. Reduced motion
 * shows the tied knot for that beat.
 */
import { KnotRope } from '@/components/motion';
import { momentPlayed, useFriendMoments } from '@/store/friends';

/** How long a played moment stays before it goes. */
const HOLD_MS = 1200;

/** On a share card that arrived while you watched: the rope slides in and ties. It is twice as wide as `size`. */
export function ShareArrived({ id, size = 14, className }: { id: string; size?: number; className?: string }) {
  const on = useFriendMoments((s) => !!s.shares[id]);
  if (!on) return null;
  return <KnotRope moment="receive" size={size} label="Just arrived" className={className} onDone={() => setTimeout(() => momentPlayed('shares', id), HOLD_MS)} />;
}

/** By a friend just added: the light runs the knot and settles. */
export function FriendAdded({ id, size = 16, className }: { id: string; size?: number; className?: string }) {
  const on = useFriendMoments((s) => !!s.friends[id]);
  if (!on) return null;
  return <KnotRope moment="success" size={size} label="Friends now" className={className} onDone={() => setTimeout(() => momentPlayed('friends', id), HOLD_MS)} />;
}
