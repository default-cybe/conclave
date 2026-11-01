/**
 * The greeting over a new chat (docs/design/CHAT-AND-MOTION.md 2.4): the
 * Knot as the hero, then "Good evening, Kai." by the local time, with the
 * owner's name (asked in setup step 1, lib/people.ts greetingName), or no
 * name when there is none. The Chat page and Home share it. The Knot
 * writes a loop and a half when the page opens, and in the
 * second loop, with the knot nearly whole, it settles into the mark: the
 * light lets go from its tail until it rests at home, and the knot turns
 * fg (spec 1.9, docs/design/brand/README.md). Under reduced motion it is
 * the still mark, and so it is under the launch: the launch's tied knot
 * flies into it (components/BootSplash.tsx).
 */
import { useEffect, useState } from 'react';
import { useHub } from '@/store/store';
import { useIsMobile, useNow } from '@/lib/hooks';
import { greetingName } from '@/lib/people';
import { cn } from '@/lib/text';
import { Knot, LOOP, useReducedMotion } from '@/components/motion';
import { bootSplashShowing } from '@/components/BootSplash';
import { greeting } from './units';

/** The hero settles in the hold of its second loop: one loop, then the write (1300ms) and 100ms of hold. */
const SETTLE_AT = LOOP.knot + 1400;

/** The name to greet: the owner's, or a member's own name on the hub (docs/design/ACCOUNTS.md). */
export function useOwnerName(): string | undefined {
  const name = useHub((s) => (s.config?.ui as { name?: unknown } | undefined)?.name);
  const me = useHub((s) => s.me);
  return greetingName(me, name);
}

export function Greeting({
  as: Tag = 'p',
  size,
  className,
}: {
  as?: 'p' | 'h1';
  /** The knot's box in px: 112 on desktop and 96 on phones unless set (Home sets 60). */
  size?: number;
  className?: string;
}) {
  const name = useOwnerName();
  // a page left open from the afternoon into the evening says so
  const minute = useNow(60_000);
  const phone = useIsMobile();
  const reduced = useReducedMotion();
  const [writing, setWriting] = useState(() => !reduced && !bootSplashShowing());
  useEffect(() => {
    if (!writing) return;
    const t = setTimeout(() => setWriting(false), SETTLE_AT);
    return () => clearTimeout(t);
  }, [writing]);
  return (
    <div className={cn('flex flex-col items-center px-4 text-center', className)}>
      <span data-hero-mark className="grid">
        <Knot state={writing && !reduced ? 'thinking' : 'brand'} size={size ?? (phone ? 96 : 112)} />
      </span>
      <Tag className="mt-5 text-[26px] leading-[1.2] font-[560] tracking-[-0.015em] text-fg phone:text-[24px]" style={{ fontStretch: '104%' }}>
        {greeting(name, new Date(minute))}
      </Tag>
    </div>
  );
}
