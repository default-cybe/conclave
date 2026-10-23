/**
 * "Install on the hub": the confirm that lists the exact commands and the
 * account they run as, then the result (ok, or the failure with the end of
 * its output). The hub works out the commands (core catalog/hub-setup.ts);
 * when they changed since the card was drawn it answers 409 with the new
 * ones, and the dialog shows those instead of running anything. The card
 * refreshes when the dialog closes, so the result stays on screen until then.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, type CatalogItemDto, type CatalogSetupResult, type HubSetupOffer } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { CodeBlock } from '@/components/ui/Code';
import { errText } from '@/features/settings/parts';
import { confirmWords, resultWords, setupRequest, type HubFix } from './hub-setup';

/** A command to read and copy. Long ones (the uv script's URL) wrap instead of running out of the box. */
function RunLine({ run, className }: { run: string; className?: string }) {
  return <CodeBlock code={run} shell wrap copy className={cn('[&>pre]:pr-9', className)} />;
}

export function HubSetupDialog({
  open,
  itemId,
  itemName,
  offer: first,
  hubName,
  onClose,
  onReady,
}: {
  open: boolean;
  itemId: string;
  itemName: string;
  offer: HubSetupOffer;
  hubName: string;
  onClose: () => void;
  /** When the dialog closes after a run, with the readiness the hub checked again. */
  onReady: (ready: CatalogItemDto['ready']) => void;
}) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const [offer, setOffer] = useState(first);
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<CatalogSetupResult>();
  const [error, setError] = useState<string>();
  const ready = useRef<CatalogItemDto['ready']>(undefined);

  useEffect(() => {
    if (!open) return;
    setOffer(first);
    setPhase('confirm');
    setResult(undefined);
    setError(undefined);
    ready.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    if (phase === 'running') return;
    onClose();
    const r = ready.current;
    ready.current = undefined;
    // after the dialog has left: the card may lose its button, and the dialog with it
    if (r) setTimeout(() => onReady(r), 200);
  };

  const run = async () => {
    setPhase('running');
    setError(undefined);
    try {
      const r = await api().catalogSetup(itemId, setupRequest(offer));
      ready.current = r.ready;
      setResult(r);
      setPhase('done');
    } catch (e) {
      const fresh = e instanceof ApiError ? (e.body as { setup?: HubSetupOffer } | undefined)?.setup : undefined;
      if (fresh) setOffer(fresh);
      setPhase('confirm');
      setError(errText(e));
    }
  };

  const words = result ? resultWords(result, hubName) : undefined;
  const canRun = offer.commands.length > 0 && !offer.refusal;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Install on ${hubName}`}
      description={phase === 'done' ? itemName : `What ${itemName} needs. ${canRun ? confirmWords(offer, hubName) : (offer.why ?? '')}`}
      width={560}
      footer={
        phase === 'done' ? (
          <Button variant="solid" size={size} onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="quiet" size={size} disabled={phase === 'running'} onClick={close}>
              Cancel
            </Button>
            {canRun && (
              <Button variant="solid" size={size} busy={phase === 'running' ? 'Installing' : false} onClick={() => void run()}>
                Install
              </Button>
            )}
          </>
        )
      }
    >
      {phase !== 'done' && (
        <>
          {error && (
            <p className="m-0 mb-3 text-[13px] leading-[1.5] text-fault phone:text-[14px]" role="alert">
              {error}
            </p>
          )}
          {offer.commands.map((c, i) => (
            <div key={c.run} className={cn('py-2', i > 0 && 'border-t border-rule')}>
              <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
                {offer.commands.length > 1 ? `${i + 1}. ` : ''}
                {c.say}
              </p>
              <RunLine run={c.run} className="mt-2" />
            </div>
          ))}
          <ByHand items={offer.byHand} />
          {phase === 'running' && (
            <p className="m-0 mt-3 text-[13px] text-signal phone:text-[14px]" aria-live="polite">
              Installing on {hubName}. This can take a few minutes.
            </p>
          )}
        </>
      )}
      {phase === 'done' && result && words && (
        <>
          <p className={cn('m-0 text-[14px] leading-[1.5]', words.ok ? 'text-ok' : 'text-fault')} aria-live="polite">
            {words.text}
          </p>
          {result.tail && <CodeBlock code={result.tail} copy wrap maxLines={words.ok ? 6 : 16} className="mt-3" />}
          <ByHand items={result.ready.hubSetup?.byHand ?? []} />
        </>
      )}
    </Dialog>
  );
}

/** Programs left to the owner: why, and the command to copy. */
function ByHand({ items }: { items: HubSetupOffer['byHand'] }) {
  if (!items.length) return null;
  return (
    <div className="mt-4">
      <div className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Still by hand</div>
      {items.map((h) => (
        <div key={h.bin} className="border-b border-rule py-2 last:border-b-0">
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{h.why}</p>
          {h.run && <RunLine run={h.run} className="mt-2" />}
        </div>
      ))}
    </div>
  );
}

/**
 * The line under a card or a step: the button that opens the confirm, or why
 * the hub cannot do it with the command to copy.
 */
export function HubFixLine({ fix, itemId, itemName, hubName, onReady, className, compact }: { fix: HubFix; itemId: string; itemName: string; hubName: string; onReady: (ready: CatalogItemDto['ready']) => void; className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  if (fix.kind === 'done') return <p className={cn('m-0 text-[12px] leading-[1.45] text-ok phone:text-[13px]', className)}>{fix.line}</p>;
  if (fix.kind === 'manual')
    return (
      <div className={className} onClick={(e) => e.stopPropagation()}>
        <p className="m-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{fix.line}</p>
        {fix.command && !compact && <RunLine run={fix.command} className="mt-1.5" />}
      </div>
    );
  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => setOpen(true)} aria-label={`${fix.label}: ${itemName}`}>
        {fix.label}
      </Button>
      <HubSetupDialog open={open} itemId={itemId} itemName={itemName} offer={fix.offer} hubName={hubName} onClose={() => setOpen(false)} onReady={onReady} />
    </div>
  );
}
