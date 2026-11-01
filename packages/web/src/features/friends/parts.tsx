/**
 * Pieces the friends screens share: the verified badge, the safety code in
 * groups, a short key, the line about whether friends reach this hub, and
 * the block a key change puts in front of a friend.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ShieldCheck } from 'lucide-react';
import type { FriendDto, FriendReachability } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { reachWords, safetyGroups, shortFingerprint, type Tone } from '@/lib/friends';
import { onHubEvent, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { confirmKey, removeFriend } from './actions';

export const TONE: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', fault: 'text-fault', dim: 'text-fg-3' };

/** "Verified" with a shield, in ok: the owner compared the safety code with this friend. */
export function VerifiedBadge({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-ok phone:text-[13px]', className)}>
      <ShieldCheck className="size-3.5 phone:size-4" strokeWidth={2} aria-hidden />
      Verified
    </span>
  );
}

/** The safety code: four groups of five digits, two by two, the way people read it out. */
export function SafetyCode({ code, size = 'md', className }: { code: string; size?: 'md' | 'lg'; className?: string }) {
  const groups = safetyGroups(code);
  return (
    <p aria-label={`Safety code ${groups.join(' ')}`} className={cn('num m-0 grid w-max grid-cols-2 text-fg', size === 'lg' ? 'gap-x-4 gap-y-0.5 text-[20px] leading-[1.35] font-[540]' : 'gap-x-3 text-[15px] leading-[1.45] font-[520] phone:text-[17px]', className)}>
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </p>
  );
}

/** "3f9a 12c0 8e41 07b2" in mono, quiet. */
export function ShortKey({ fp, className }: { fp: string; className?: string }) {
  return <span className={cn('font-mono text-[0.92em] tracking-[-0.01em] [font-feature-settings:"zero"_1]', className)}>{shortFingerprint(fp)}</span>;
}

/** Can friends reach this hub: loaded once, again when remote access changes. */
export function useReachability(): FriendReachability | undefined {
  const [r, setR] = useState<FriendReachability>();
  const remote = useHub((s) => s.remote);
  useEffect(() => {
    let alive = true;
    api()
      .friendReachability()
      .then((x) => alive && setR(x))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [remote?.mode, remote?.state, remote?.addresses.length]);
  return r;
}

/**
 * Friends cannot reach this hub: says so plainly and links to Remote access.
 * When they can: one quiet line with the address they get.
 */
export function ReachLine({ r, className }: { r: FriendReachability | undefined; className?: string }) {
  const w = reachWords(r);
  if (!w) return null;
  if (w.ok)
    return (
      <p className={cn('m-0 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]', className)}>
        {w.title} {w.detail && <span className="text-fg-3">{w.detail}</span>}
      </p>
    );
  return (
    <div className={cn('max-w-[64ch]', className)} role="status">
      <p className="m-0 text-[15px] leading-[1.45] text-fg phone:text-[16px]">
        <span className="text-warn">{w.title}</span> {w.why}
      </p>
      {w.detail && <p className="m-0 mt-1 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">{w.detail}</p>}
      <Link href="/settings/remote" className="link mt-2 inline-block text-[13px] phone:text-[15px]">
        Open Remote access
      </Link>
    </div>
  );
}

/**
 * A friend's hub answered with a key its old key did not sign: nothing moves
 * until the owner confirms the new key (after asking the friend) or removes
 * the friend.
 */
export function KeyChange({ f, onRemoved, className }: { f: FriendDto; onRemoved?: () => void; className?: string }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [ask, setAsk] = useState<'confirm' | 'remove' | null>(null);
  return (
    <section aria-label={`${f.name}'s hub has a new key`} className={cn('border-l-2 border-fault py-1 pl-4', className)}>
      <h3 className="m-0 text-[14px] leading-[1.4] font-semibold text-fault phone:text-[16px]">{f.name}'s hub has a new key</h3>
      <p className="m-0 mt-1 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
        {f.blockedReason ?? `${f.name}'s hub answers with a new key its old key did not sign. Nothing is sent or taken until you confirm it.`} Ask {f.name} if they set their hub up again. If they did not, someone else may hold the address.
      </p>
      <dl className="m-0 mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px] leading-[1.5] phone:text-[13px]">
        <dt className="text-fg-3">Old key</dt>
        <dd className="m-0 text-fg-2">
          <ShortKey fp={f.fingerprint} />
        </dd>
        {f.pendingFingerprint && (
          <>
            <dt className="text-fg-3">New key</dt>
            <dd className="m-0 text-fg">
              <ShortKey fp={f.pendingFingerprint} />
            </dd>
          </>
        )}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size={size} onClick={() => setAsk('confirm')}>
          Confirm new key
        </Button>
        <Button variant="danger" size={size} onClick={() => setAsk('remove')}>
          Remove {f.name}
        </Button>
      </div>
      <ConfirmDialog
        open={ask === 'confirm'}
        onClose={() => setAsk(null)}
        tone="neutral"
        title={`Take ${f.name}'s new key?`}
        body={`Only if ${f.name} told you they set their hub up again. What waits for them is sealed for the new key, and the safety code changes: compare the new one with ${f.name}.`}
        confirm="Confirm new key"
        busy="Confirming"
        onConfirm={() => confirmKey(f)}
      />
      <RemoveDialog f={f} open={ask === 'remove'} onClose={() => setAsk(null)} onRemoved={onRemoved} />
    </section>
  );
}

/** Remove a friend, after asking. */
export function RemoveDialog({ f, open, onClose, onRemoved }: { f: FriendDto; open: boolean; onClose: () => void; onRemoved?: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Remove ${f.name}?`}
      body={`${f.name}'s hub is asked to stop too, and what waits to go to them is cancelled. Nothing more goes either way. Notes you have stay here.`}
      confirm="Remove"
      busy="Removing"
      onConfirm={async () => {
        if (await removeFriend(f)) onRemoved?.();
      }}
    />
  );
}

/** Run `fn` when the hub says this friend changed (a delivery, a pull, an accept). */
export function useFriendEvents(friendId: string | undefined, fn: () => void) {
  useEffect(() => {
    if (!friendId) return;
    return onHubEvent((e) => {
      if (e.type === 'friend.updated' && e.friend.id === friendId) fn();
    });
  }, [friendId, fn]);
}
