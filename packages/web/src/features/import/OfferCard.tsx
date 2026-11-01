/**
 * The offer to import a newly paired computer's chats (import/offers.ts on
 * the hub, docs/DESIGN.md 38): "Found 12 chats from Claude Code and Codex on
 * studio. Import them?", with Import (the import sheet with that device
 * picked, which shows the cost estimate first) and Not now (the device is not
 * asked again). The Inbox lists the open ones; Devices shows each device's.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { ImportOffer } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';

/** Open offers, newest first. */
export function useImportOffers(): ImportOffer[] {
  const map = useHub((s) => s.importOffers);
  return useMemo(() => Object.values(map).sort((a, b) => b.createdAt - a.createdAt), [map]);
}

/** Where Import goes: the import sheet with the device picked (ChatsPage reads ?import=). */
export function importOfferHref(device: string): string {
  return `/sessions?import=${encodeURIComponent(device)}`;
}

/** Not now: the hub closes the offer for good, and the row leaves at once. */
async function dismiss(device: string): Promise<boolean> {
  const ok = await attempt(() => api().dismissImportOffer(device));
  if (!ok) return false;
  const { [device]: _gone, ...rest } = useHub.getState().importOffers;
  useHub.setState({ importOffers: rest });
  return true;
}

export function ImportOfferCard({ offer, compact, className }: { offer: ImportOffer; compact?: boolean; className?: string }) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const notNow = async () => {
    setBusy(true);
    if (!(await dismiss(offer.device))) setBusy(false);
  };
  return (
    <div aria-label={offer.text} className={cn(compact ? 'mt-2' : 'relative rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 pt-3.5 pb-4 anim-rise', className)}>
      <p className={cn('m-0 text-pretty', compact ? 'text-[13px] text-fg-2 phone:text-[15px]' : 'text-[14px] leading-[1.4] font-semibold text-fg phone:text-[15px]')}>{offer.text}</p>
      {!compact && <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">Nothing is imported until you pick the chats. You see the cost first.</p>}
      <div className={cn('flex flex-wrap items-center gap-2', compact ? 'mt-2' : 'mt-3.5')}>
        <Button variant="outline" size={compact ? 'sm' : undefined} onClick={() => navigate(importOfferHref(offer.device))}>
          Import
        </Button>
        <Button variant="quiet" size={compact ? 'sm' : undefined} busy={busy ? 'Closing' : false} onClick={() => void notNow()}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/** The phone Inbox's row: the device and the sentence; a tap imports, Not now at the right. */
export function PhoneOfferRow({ offer }: { offer: ImportOffer }) {
  const [busy, setBusy] = useState(false);
  const notNow = async () => {
    setBusy(true);
    if (!(await dismiss(offer.device))) setBusy(false);
  };
  return (
    <div className="flex min-h-[60px] items-center gap-1 pr-2.5 active:bg-hover">
      <Link href={importOfferHref(offer.device)} className="flex min-w-0 flex-1 flex-col justify-center self-stretch py-2.5 pl-5">
        <span className="block truncate text-[16px] leading-[1.35] text-fg">Past chats on {offer.deviceName}</span>
        <span className="mt-0.5 block text-[14px] leading-[1.35] text-pretty text-fg-2">{offer.text}</span>
      </Link>
      <button type="button" disabled={busy} onClick={() => void notNow()} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] text-fg-2 active:bg-hover disabled:text-fg-3">
        Not now
      </button>
    </div>
  );
}

/** The Inbox's section of offers, at the top of All. */
export function ImportOffersSection({ offers, className }: { offers: ImportOffer[]; className?: string }) {
  if (!offers.length) return null;
  return (
    <section aria-label="Past chats to import" className={cn('space-y-3', className)}>
      {offers.map((o) => (
        <ImportOfferCard key={o.device} offer={o} />
      ))}
    </section>
  );
}
