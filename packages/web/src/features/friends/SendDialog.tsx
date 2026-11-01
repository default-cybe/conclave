/**
 * Send to friend, the dialog (SendToFriend.tsx loads it when it first
 * opens): pick friends, review what goes (ShareReview.tsx), send, then the
 * sent state. The same review sends a new revision of a share already
 * sent (Update).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { SentShareDto, SharePreview } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile, useNow } from '@/lib/hooks';
import { friendHref } from '@/lib/friendInbox';
import { agoText } from '@/lib/friends';
import { summaryText, namesWords, rangeStops, reviewKey, reviewOptions, reviewStart, sendLabel, shareTargets, type ReviewChoices } from '@/lib/shares';
import { loadMessages, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { KnotRope } from '@/components/motion';
import { Dialog } from '@/components/ui/Overlay';
import { isChat } from '@/features/chat/util';
import { sendShare, updateShare } from './actions';
import { ReviewBody } from './ShareReview';
import { VerifiedBadge } from './parts';
import type { SendDialogProps, ShareSource } from './SendToFriend';

type Step = 'pick' | 'review' | 'sent';

/**
 * Pick friends, review, send. With `update`, a share sent before: no pick,
 * the review starts from its choices, and Send is a new revision.
 */
export default function SendDialog({ session, open, onClose, update }: SendDialogProps) {
  const phone = useIsMobile();
  const friendsMap = useHub((s) => s.friends);
  const targets = useMemo(() => shareTargets(Object.values(friendsMap)), [friendsMap]);
  const messages = useHub((s) => s.messages[session.id]);
  const kind = isChat(session) ? 'chat' : 'session';
  const [step, setStep] = useState<Step>('pick');
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [choices, setChoices] = useState<ReviewChoices>(() => reviewStart(kind));
  const [preview, setPreview] = useState<SharePreview>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<SentShareDto>();
  const ask = useRef(0);

  // each time it opens: from the start, a lone friend already picked
  useEffect(() => {
    if (!open) return;
    void loadMessages(session.id);
    setPreview(undefined);
    setError(undefined);
    setSent(undefined);
    setBusy(false);
    if (update) {
      setStep('review');
      setPicked(update.recipients.map((r) => r.friendId));
      setTitle(update.title);
      setNote(update.note ?? '');
      setChoices(reviewStart(kind, update.options));
    } else {
      setStep('pick');
      setPicked(targets.length === 1 ? [targets[0].id] : []);
      setTitle('');
      setNote('');
      setChoices(reviewStart(kind));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // the review: the hub answers each change, the latest answer wins
  const key = reviewKey(choices);
  useEffect(() => {
    if (!open || step !== 'review') return;
    const n = ++ask.current;
    setChecking(true);
    const t = setTimeout(
      () => {
        api()
          .previewShare({ sessionId: session.id, ...reviewOptions(choices) })
          .then((p) => {
            if (n !== ask.current) return;
            setPreview(p);
            setError(undefined);
          })
          .catch((e) => n === ask.current && setError(e instanceof Error ? e.message : String(e)))
          .finally(() => n === ask.current && setChecking(false));
      },
      preview ? 250 : 0,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, key, session.id]);

  // the title starts as the session's, as the review gives it (through the same rules as the rest)
  const titled = useRef(false);
  useEffect(() => {
    if (!open) titled.current = false;
    else if (preview && !titled.current) {
      titled.current = true;
      setTitle((t) => t || preview.title);
    }
  }, [open, preview]);

  const stops = useMemo(() => rangeStops(messages ?? []), [messages]);
  const names = picked.map((id) => friendsMap[id]?.name ?? 'a friend');
  const size = phone ? 'touch' : 'md';

  const send = async () => {
    setBusy(true);
    const t = title.trim();
    const n = note.trim();
    const done = update
      ? await updateShare(update.id, { ...reviewOptions(choices), ...(t ? { title: t } : {}), note: n })
      : await sendShare({ sessionId: session.id, to: picked, ...reviewOptions(choices), ...(t ? { title: t } : {}), ...(n ? { note: n } : {}) });
    setBusy(false);
    if (!done) return;
    if (update) return onClose();
    setSent(done);
    setStep('sent');
  };

  const heading = update ? `Update '${update.title}'` : step === 'pick' ? 'Send to friend' : step === 'review' ? `Send to ${namesWords(names)}` : 'Sent';

  const footer =
    step === 'pick' ? (
      <>
        <Button variant="quiet" size={size} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="solid" size={size} disabled={!picked.length} onClick={() => setStep('review')}>
          Next
        </Button>
      </>
    ) : step === 'review' ? (
      <>
        <Button variant="quiet" size={size} onClick={update ? onClose : () => setStep('pick')}>
          {update ? 'Cancel' : 'Back'}
        </Button>
        <Button variant="solid" size={size} disabled={!preview || !!error} busy={busy ? 'Sending' : false} onClick={() => void send()}>
          {update ? `Send revision ${update.revision + 1}` : sendLabel(names)}
        </Button>
      </>
    ) : (
      <>
        {picked.length === 1 && (
          <Link href={friendHref(picked[0])} onClick={onClose} className={cn('link mr-auto', phone ? 'py-3 text-[15px]' : 'text-[13px]')}>
            Open {names[0]}'s page
          </Link>
        )}
        <Button variant="solid" size={size} onClick={onClose}>
          Done
        </Button>
      </>
    );

  return (
    <Dialog open={open} onClose={onClose} title={heading} width={step === 'review' ? 600 : 480} footer={footer} bodyClassName={phone ? 'text-[15px]' : undefined}>
      {step === 'pick' && <Pick picked={picked} onPick={setPicked} session={session} />}
      {step === 'review' && (
        <ReviewBody kind={kind} preview={preview} choices={choices} onChoices={setChoices} stops={stops} title={title} onTitle={setTitle} note={note} onNote={setNote} checking={checking && !!preview} error={error} />
      )}
      {step === 'sent' && sent && <SentState share={sent} names={names} />}
    </Dialog>
  );
}

/** Friends to send to: active ones, a box each. */
function Pick({ picked, onPick, session }: { picked: string[]; onPick: (ids: string[]) => void; session: ShareSource }) {
  const friendsMap = useHub((s) => s.friends);
  const targets = useMemo(() => shareTargets(Object.values(friendsMap)), [friendsMap]);
  const now = useNow(60_000);
  const what = isChat(session) ? 'chat' : 'session';
  if (!targets.length)
    return (
      <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
        No friends to send to yet. A friend is someone else's Conclave hub that you both said yes to.{' '}
        <Link href="/settings/friends" className="link">
          Add a friend
        </Link>
      </p>
    );
  return (
    <div>
      <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
        Who gets <span className="text-fg">{session.title || `this ${what}`}</span>? You see what goes before it goes.
      </p>
      <ul className="m-0 mt-3 list-none p-0" aria-label="Friends">
        {targets.map((f) => {
          const on = picked.includes(f.id);
          return (
            <li key={f.id}>
              <label className="flex min-h-11 cursor-default items-center gap-3 rounded-[var(--r-1)] px-1 hov:bg-hover phone:min-h-12">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onPick(on ? picked.filter((x) => x !== f.id) : [...picked, f.id])}
                  className="size-4 shrink-0 accent-[var(--fg)]"
                  aria-label={f.name}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[14px] text-fg phone:text-[16px]">{f.name}</span>
                    {f.verified && <VerifiedBadge />}
                  </span>
                  <span className="block text-[12px] text-fg-3 phone:text-[13px]">{f.lastSeen ? `Seen ${agoText(f.lastSeen, now)}` : 'Not seen yet'}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** After Send: what went to whom, and what happens next. */
function SentState({ share, names }: { share: SentShareDto; names: string[] }) {
  return (
    <div role="status" className="flex flex-col gap-2">
      {/* the rope pulls out through the knot, the light leading (docs/design/KNOT-MOTION.md 5) */}
      <div className="flex h-8 items-center">
        {/* the knot sits a quarter of the way into the rope's view: line it up with the words */}
        <KnotRope moment="send" size={28} className="-ml-3.5" />
      </div>
      <p className="m-0 text-[15px] leading-[1.45] text-fg phone:text-[16px]">
        Sent '{share.title}' to {namesWords(names)}.
      </p>
      <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
        {summaryText(share.kind, share.summary)}. Their hub fetches it only when they accept, for 30 days.
      </p>
      <p className="m-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">Update sends a new revision of it. Unsend asks their hub to delete its copy. Both are on {names.length === 1 ? `${names[0]}'s page` : 'each friend\'s page'} and under Shares.</p>
    </div>
  );
}
