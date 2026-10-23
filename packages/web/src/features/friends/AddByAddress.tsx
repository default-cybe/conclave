/**
 * Add a friend by their hub's address (docs/design/FRIENDS.md, "Add a friend
 * by address"): their address, and an email if you like. Your hub checks the
 * key at that address and sends a request that waits in their Inbox. The
 * email stays here as a label and a contact; when the request cannot go, it
 * gets an invite they can use from their side, in a mail you send.
 *
 * Under it: your own hub's address to give friends, and whether hubs that
 * know only that address may ask at all.
 */
import { useEffect, useState } from 'react';
import type { AddFriendResult, FriendSettings } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useCopy, useIsMobile } from '@/lib/hooks';
import { isMailto } from '@/lib/sharedProjects';
import { attempt } from '@/store/store';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Input, OnOff } from '@/components/ui/Field';
import { SettingRow } from '@/features/settings/parts';
import { addFriendByAddress } from './projectActions';
import { SafetyCode } from './parts';

export function AddByAddressRow() {
  const phone = useIsMobile();
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddFriendResult>();
  const [copied, copy] = useCopy();
  const size = phone ? 'touch' : 'md';

  const send = async () => {
    if (!address.trim()) return;
    setBusy(true);
    const r = await addFriendByAddress({ address: address.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(name.trim() ? { name: name.trim() } : {}) });
    setBusy(false);
    setResult(r);
    if (r?.sent) {
      setAddress('');
      setName('');
    }
  };

  return (
    <div className="py-3.5">
      <div className="text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">
        <label htmlFor="friend-address">Add by address</label>
      </div>
      <p className="m-0 mt-0.5 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Their hub's address and, if you like, their email. The request lands in their Inbox, and they accept or decline it.</p>
      <form
        className="mt-2.5 flex max-w-[620px] flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          id="friend-address"
          mono
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setResult(undefined);
          }}
          placeholder="https://hub.example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          inputMode="url"
        />
        <div className="flex flex-wrap gap-2">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their email (optional)" type="email" autoCapitalize="off" autoComplete="off" aria-label="Their email" className="min-w-0 flex-1 basis-[220px]" />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name (optional)" aria-label="Their name" maxLength={60} className="min-w-0 flex-1 basis-[160px]" />
        </div>
        <div>
          <Button type="submit" variant="solid" size={size} disabled={!address.trim()} busy={busy ? 'Checking' : false} className="phone:w-full">
            Send request
          </Button>
        </div>
      </form>
      <p className="m-0 mt-2 max-w-[64ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Only your hub's name and address go with it. The email stays on your hub.</p>
      {result && (
        <div className="mt-3 max-w-[64ch]" role="status">
          {result.sent && result.friend ? (
            <>
              <p className="m-0 text-[13.5px] leading-[1.5] text-fg phone:text-[15px]">
                <span className="text-ok">{result.friend.status === 'active' ? 'You are friends.' : 'Request sent.'}</span>{' '}
                {result.friend.status === 'active' ? 'They had asked you too.' : 'It waits in their Inbox until they accept.'}
              </p>
              <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">A key you have not met before. Compare the safety code with them:</p>
              <SafetyCode code={result.friend.safetyCode} className="mt-1" />
            </>
          ) : (
            <>
              <p className="m-0 text-[13.5px] leading-[1.5] phone:text-[15px]">
                <span className="text-warn">Not sent.</span> <span className="text-fg-2">{result.reason}</span>
              </p>
              {isMailto(result.mailto) && result.invite ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <ButtonLink href={result.mailto} variant="outline" size={size} className="phone:flex-1">
                    Email them an invite
                  </ButtonLink>
                  <Button variant="quiet" size={size} onClick={() => copy(result.invite!.link)} className="phone:flex-1">
                    {copied ? 'Copied' : 'Copy the invite'}
                  </Button>
                </div>
              ) : (
                <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">Add their email to get an invite you can mail them, or make one below.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Your hub's address for friends, and whether hubs that know only that may ask. */
export function ByAddressSetting() {
  const phone = useIsMobile();
  const [st, setSt] = useState<FriendSettings>();
  const [copied, copy] = useCopy();
  useEffect(() => {
    let alive = true;
    api()
      .friendSettings()
      .then((s) => alive && setSt(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!st) return null;
  const set = async (on: boolean) => {
    setSt({ ...st, requestsByAddress: on });
    const next = await attempt(() => api().setFriendSettings({ requestsByAddress: on }));
    setSt(next ?? st);
  };
  return (
    <>
      <SettingRow label="Requests by address" help={st.requestsByAddress ? 'Hubs that know your address can ask to be friends. Each request waits for you; a few an hour at most.' : 'Off: friends need an invite from you.'}>
        <OnOff checked={st.requestsByAddress} onChange={(v) => void set(v)} label="Requests by address" size={phone ? 'touch' : 'sm'} />
      </SettingRow>
      {st.address && (
        <SettingRow label="Your hub's address" help="Give it to a friend, so they can add you by address.">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 truncate font-mono text-[12.5px] text-fg phone:text-[13px]')}>{st.address}</span>
            <Button variant="quiet" size={phone ? 'touch' : 'sm'} onClick={() => copy(st.address!)} className="shrink-0 md:-mr-3">
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </span>
        </SettingRow>
      )}
    </>
  );
}
