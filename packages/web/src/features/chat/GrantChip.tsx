/**
 * The live-grant chip of a Security mode hunt (docs/design/SECURITY-MODE.md
 * 4.3): next to the lane in the composer row, "Live: <host> 37/500". Its
 * menu shows each live grant and revokes it. Owner only: the route is admin,
 * so a member's fetch fails and nothing shows.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { durationShort } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { PickerButton } from '@/components/ui/Select';
import { MenuList, Popover, type MenuItem } from '@/components/ui/Overlay';

type Grant = Awaited<ReturnType<ReturnType<typeof api>['grants']>>[number];

export const grantLiveNow = (g: Grant, now: number) => !g.revokedAt && now < g.expiresAt && (g.used ?? 0) < g.requestBudget;

export function GrantChip({ sessionId }: { sessionId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const now = useNow(30_000);
  const load = () =>
    api()
      .grants(sessionId)
      .then(setGrants)
      .catch(() => setGrants([]));
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [sessionId]);
  const live = grants.filter((g) => grantLiveNow(g, now));
  if (!live.length) return null;
  const first = live[0];
  const items: MenuItem[] = live.flatMap((g) => [
    { group: true, label: g.hosts.join(', ') },
    { label: `${g.used ?? 0} of ${g.requestBudget} requests, ${g.rateRps}/s`, detail: `Expires in ${durationShort(g.expiresAt - now)}`, disabled: true },
    { label: 'Revoke grant', danger: true, onSelect: () => void attempt(() => api().revokeGrant(sessionId, g.id)).then(load) },
  ]);
  return (
    <>
      <PickerButton ref={ref} look="text" prefix="Live" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(true)} className="h-[24px] text-[12px]">
        <span className="mono">{first.hosts[0]}</span> <span className="num text-fg-3">{first.used ?? 0}/{first.requestBudget}</span>
        {live.length > 1 && <span className="text-fg-3"> +{live.length - 1}</span>}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={300} label="Live grants" sheetTitle="Live grants">
        <MenuList items={items} onDone={() => setOpen(false)} label="Live grants" />
      </Popover>
    </>
  );
}
