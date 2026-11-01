/**
 * The saved hub did not answer when the app started (lib/reach.ts): the shell
 * opens with what it has and this line under its header, with when the next
 * try starts and Retry. While a try runs the knot runs. Once the hub
 * answers it says so, with the knot's success, and goes away by itself.
 */
import { useEffect, useRef, useState } from 'react';
import { useReach, retryHubNow } from '@/lib/reach';
import { useIsMobile, useNow } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { KnotRope } from '@/components/motion';

/** How long "Back online" stays after its knot has played, ms. */
const BACK_HOLD = 1200;

/** "in 12 s", "in 1 min", or undefined while a try runs. */
export function nextTryWords(nextAt: number | undefined, now: number): string | undefined {
  if (!nextAt) return undefined;
  const s = Math.max(0, Math.ceil((nextAt - now) / 1000));
  return s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

export function OfflineBanner() {
  const offline = useReach((s) => s.offline);
  const mobile = useIsMobile();
  const now = useNow(1000);
  const [back, setBack] = useState(false);
  const was = useRef(offline);
  useEffect(() => {
    if (was.current && !offline) setBack(true);
    if (offline) setBack(false);
    was.current = offline;
  }, [offline]);
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hide.current), []);
  if (!offline && back)
    return (
      <div role="status" className="flex shrink-0 items-center gap-3 border-b border-rule bg-raise px-[var(--gutter)] py-1.5 anim-fade phone:py-1">
        <KnotRope moment="success" size={16} onDone={() => (hide.current = setTimeout(() => setBack(false), BACK_HOLD))} />
        <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.4] text-fg phone:text-[14px]">
          <span className="text-ok">Back online.</span>
        </p>
      </div>
    );
  if (!offline) return null;
  const next = nextTryWords(offline.nextAt, now);
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-rule bg-raise px-[var(--gutter)] py-1.5 anim-fade phone:py-1">
      {!next && <KnotRope moment="run" size={16} />}
      <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.4] text-fg phone:text-[14px]">
        <span className="text-fault">Can't reach {offline.label}.</span> Retrying…
        <span className="block text-[12px] text-fg-3 phone:text-[13px] md:ml-2 md:inline">{next ? <span className="num">Next try {next}</span> : 'Trying now…'}</span>
      </p>
      <Button variant="outline" size={mobile ? 'touch' : 'sm'} disabled={!next} onClick={retryHubNow}>
        Retry
      </Button>
    </div>
  );
}
