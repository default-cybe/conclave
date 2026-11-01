/**
 * Add a friend (docs/design/FRIENDS.md 2): make an invite, a link and a QR
 * code one person can use once within 24 hours, or use the link a friend
 * sent (pasted, or on a phone scanned with the camera). The hub checks the
 * friend's hub key against the link before it sends the request.
 */
import { useState } from 'react';
import type { FriendDto, FriendInvite, FriendReachability } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useCopy, useIsMobile, useNow } from '@/lib/hooks';
import { hostWords, parseFriendLink, shortFingerprint, untilText } from '@/lib/friends';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input } from '@/components/ui/Field';
import { Fingerprint } from '@/features/connect/Fingerprint';
import { QrScan } from '@/features/connect/QrScan';
import { errText, Group, SettingRow } from '@/features/settings/parts';
import { acceptInvite } from './actions';
import { AddByAddressRow, ByAddressSetting } from './AddByAddress';
import { SafetyCode } from './parts';

export function AddFriend({ reach }: { reach: FriendReachability | undefined }) {
  return (
    <Group title="Add a friend" id="add" help="A friend is someone else's Conclave hub. You trade notes, chats, sessions and projects, hub to hub.">
      <AddByAddressRow />
      <InviteRow reach={reach} />
      <UseLinkRow />
      <ByAddressSetting />
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Make an invite
// ---------------------------------------------------------------------------

function InviteRow({ reach }: { reach: FriendReachability | undefined }) {
  const mobile = useIsMobile();
  const [invite, setInvite] = useState<FriendInvite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lan, setLan] = useState(false);
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setInvite(await api().createFriendInvite({ includeLan: lan }));
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };
  return (
    <div>
      <SettingRow label="Invite a friend" help="A link and a QR code for one person. It works once, for 24 hours.">
        <Button variant={invite ? 'quiet' : 'outline'} size={mobile ? 'touch' : 'md'} className={invite ? 'phone:-ml-4 md:-mr-3' : undefined} busy={busy ? 'Making' : false} onClick={() => void make()}>
          {invite ? 'Make another' : 'Make an invite'}
        </Button>
      </SettingRow>
      {/* friends outside cannot reach the hub: an invite can carry this network's addresses for someone on it */}
      {reach && !reach.ok && !invite && (
        <Checkbox
          checked={lan}
          onChange={setLan}
          label="Include addresses on this network"
          description="For a friend on your Wi-Fi. Anyone else cannot use them."
          className="-mt-1 pb-3 phone:min-h-11 phone:items-center"
        />
      )}
      {error && <p className="m-0 max-w-[64ch] pb-3 text-[13px] leading-[1.5] text-fault phone:text-[14px]">{error}</p>}
      {invite && <InvitePanel invite={invite} className="pt-1 pb-5" />}
    </div>
  );
}

function InvitePanel({ invite, className }: { invite: FriendInvite; className?: string }) {
  const mobile = useIsMobile();
  const now = useNow(30_000);
  const [copied, copy] = useCopy();
  const size = mobile ? 'touch' : 'sm';
  const expired = invite.expiresAt <= now;
  const share = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && mobile;
  return (
    <div className={cn('flex flex-col gap-6 sm:flex-row sm:items-start', className)}>
      <div className="grid size-[232px] shrink-0 place-items-center rounded-[var(--r-2)] bg-white p-4 light:border light:border-rule" role="img" aria-label="QR code of the invite link">
        {!expired && <div className="size-[200px] [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: invite.qrSvg }} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-fg-3 phone:text-[13px]">Invite link</div>
        <p className="m-0 mt-1 font-mono text-[12.5px] leading-[1.5] break-all text-fg select-all [font-feature-settings:'zero'_1] phone:text-[13px]" data-invite-link>
          {invite.link}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size={size} onClick={() => copy(invite.link)} disabled={expired}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {share && (
            <Button variant="quiet" size={size} disabled={expired} onClick={() => void navigator.share({ text: invite.link }).catch(() => undefined)}>
              Share
            </Button>
          )}
        </div>
        <p className={cn('m-0 mt-3 max-w-[52ch] text-[12px] leading-[1.5] phone:text-[14px]', expired ? 'text-fault' : 'text-fg-3')}>
          {expired ? 'This invite expired. Make another.' : `Send it to one person, or let them scan the code. It works once, ${untilText(invite.expiresAt, now)}.`}
        </p>
        <div className="mt-4 text-[12px] text-fg-3 phone:text-[13px]">Your hub's key, for them to compare</div>
        <Fingerprint value={invite.fingerprint} size="sm" className="mt-1" />
        {invite.warning && <p className="m-0 mt-3 max-w-[60ch] text-[12px] leading-[1.5] text-warn phone:text-[13px]">{invite.warning}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Use a friend's link
// ---------------------------------------------------------------------------

function UseLinkRow() {
  const mobile = useIsMobile();
  const now = useNow(30_000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);
  const [sent, setSent] = useState<FriendDto>();
  const parsed = parseFriendLink(text);
  const expired = !!parsed && parsed.expiresAt <= now;
  const size = mobile ? 'touch' : 'md';

  const send = async (link = parsed?.link) => {
    if (!link) return;
    setBusy(true);
    const f = await acceptInvite(link);
    setBusy(false);
    if (f) {
      setSent(f);
      setText('');
    }
  };

  let note: { words: string; tone: 'dim' | 'fault' } | undefined;
  if (text.trim() && !parsed) note = { words: 'That is not a friend link. It starts with conclave://friend.', tone: 'fault' };
  else if (expired) note = { words: 'This invite has expired. Ask your friend for a new one.', tone: 'fault' };
  else if (parsed) note = { words: `An invite from the hub ${shortFingerprint(parsed.fp, 2)} at ${hostWords(parsed.url)}. It works ${untilText(parsed.expiresAt, now)}.`, tone: 'dim' };

  return (
    <div className="py-3.5">
      <div className="text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">
        <label htmlFor="friend-link">Use a friend's link</label>
      </div>
      <p className="m-0 mt-0.5 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Paste the link a friend sent you. Your hub checks their hub's key, then asks to be friends.</p>
      <form
        className="mt-2.5 flex max-w-[620px] flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed && !expired) void send();
        }}
      >
        <Input
          id="friend-link"
          mono
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(undefined);
          }}
          placeholder="conclave://friend?…"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          invalid={note?.tone === 'fault'}
          className="min-w-0 flex-1 phone:basis-full"
        />
        <Button type="submit" variant="solid" size={size} disabled={!parsed || expired} busy={busy ? 'Checking' : false} className="phone:flex-1">
          Send request
        </Button>
        {mobile && (
          <Button variant="outline" size="touch" onClick={() => setScan(true)} className="flex-1">
            Scan QR code
          </Button>
        )}
      </form>
      {note && <p className={cn('m-0 mt-2 max-w-[64ch] text-[12px] leading-[1.5] phone:text-[13px]', note.tone === 'fault' ? 'text-fault' : 'text-fg-3')}>{note.words}</p>}
      {sent && (
        <div className="mt-3 max-w-[64ch]" role="status">
          <p className="m-0 text-[13.5px] leading-[1.5] text-fg phone:text-[15px]">
            <span className="text-ok">Request sent.</span> Their hub's key checked out. You are friends once their owner accepts.
          </p>
          <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">Safety code, to compare with them:</p>
          <SafetyCode code={sent.safetyCode} className="mt-1" />
        </div>
      )}
      {scan && (
        <QrScan
          parse={parseFriendLink}
          onLink={(l) => {
            setScan(false);
            setText(l.link);
            setSent(undefined);
          }}
          onClose={() => setScan(false)}
          onCode={() => {
            setScan(false);
            requestAnimationFrame(() => document.getElementById('friend-link')?.focus());
          }}
          words={{
            aim: "Point the camera at the code in your friend's Settings, Friends.",
            wrong: 'That is not a Conclave friend invite.',
            none: 'There is no camera this page can use here. Paste the link your friend sent instead.',
            denied: 'Conclave may not use the camera. Allow it in the settings of this phone, or paste the link.',
            instead: 'Paste the link instead',
          }}
        />
      )}
    </div>
  );
}
