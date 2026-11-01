/**
 * An invite link from the owner (docs/design/ACCOUNTS.md 4): /invite/<secret>
 * on the hub's own address. It says whose account it is, takes a password,
 * and signs this browser in. The link works once and for 7 days.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { InviteInfo } from '@conclave/core/client';
import { probeClient, saveConnection, type Connection } from '@/lib/api';
import { rememberAccount } from '@/lib/people';
import { keepAddresses } from '@/lib/remote';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Field, Help, Input } from '@/components/ui/Field';
import { defaultDeviceName, servedFrom } from './ConnectForm';
import { IntroFrame } from './IntroFrame';

const MIN = 12;

export default function InvitePage({ secret, onJoined }: { secret: string; onJoined: (c: Connection) => Promise<void> }) {
  const mobile = useIsMobile();
  const base = servedFrom() || window.location.origin;
  const [info, setInfo] = useState<InviteInfo | null>();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void probeClient(base)
      .then((c) => c.invite(secret))
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [base, secret]);

  const short = password.length > 0 && [...password].length < MIN;
  const differ = again.length > 0 && again !== password;
  const ready = [...password].length >= MIN && again === password && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const reply = await (await probeClient(base)).acceptInvite(secret, password, defaultDeviceName(), 'web');
      const conn: Connection = { baseUrl: base, token: reply.token, ...(reply.identity?.publicKey ? { hubKey: reply.identity.publicKey } : {}), ...(reply.account ? { account: reply.account } : {}), clientId: reply.clientId, hubName: reply.hub.name };
      saveConnection(conn);
      rememberAccount(conn);
      keepAddresses(conn, reply.addresses);
      await onJoined(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/\.?$/, '.') : 'That did not work. Try again.');
      setBusy(false);
    }
  };

  return (
    <IntroFrame label="Invite" wordmark={64} align="start">
      {info === undefined ? (
        <p className="text-[14px] text-fg-3">Checking the link</p>
      ) : info === null ? (
        <>
          <h2 className="t-title m-0 text-fg">This link does not work any more</h2>
          <p className="mt-1.5 max-w-[48ch] text-[14px] leading-[1.45] text-fg-2">An invite works once and for 7 days. Ask the owner of the hub for a new one.</p>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col">
          <h2 className="t-title m-0 text-fg">Join {info.hub}</h2>
          <p className="mt-1.5 max-w-[52ch] text-[14px] leading-[1.45] text-fg-2">
            The owner made the account <span className="font-medium text-fg">{info.name}</span> for you. Other people on this hub do not see your chats, memory or keys. The owner runs the computer the hub is on and could read what is stored there.
          </p>
          <div className="mt-6 flex max-w-[420px] flex-col gap-4">
            <input type="text" name="username" autoComplete="username" value={info.name} readOnly hidden />
            <Field label="Password" error={short ? `At least ${MIN} characters.` : undefined}>
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </Field>
            <Field label="Password again" error={differ ? 'The two do not match.' : undefined}>
              <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
          </div>
          <div className="mt-6">
            <Button type="submit" variant="solid" size={mobile ? 'touch' : 'lg'} full={mobile} disabled={!ready} busy={busy ? 'Joining' : false}>
              Join
            </Button>
          </div>
          {error && (
            <Help error className="mt-3 max-w-[52ch]">
              <span role="alert">{error}</span>
            </Help>
          )}
        </form>
      )}
    </IntroFrame>
  );
}
