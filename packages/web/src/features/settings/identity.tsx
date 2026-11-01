/**
 * Settings, Remote access, "This hub" (docs/design/HUB-LOGIN-AND-IDENTITY.md):
 * the hub's fingerprint, to compare with a phone that logged in with the
 * password, and the password itself. Only the owner token sees and changes
 * the password; a paired app sees the fingerprint only.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { PasswordStatus } from '@conclave/core/client';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { useHub, useIsOwner } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Field, Help, Input } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { Fingerprint } from '@/features/connect/Fingerprint';
import { errText, Group, SettingRow } from './parts';

/** The hub refuses shorter ones too. */
export const MIN_PASSWORD = 12;

/** What is wrong with a new password and its repeat, or undefined when it can be saved. */
export function passwordProblem(password: string, again: string): string | undefined {
  if (password.length < MIN_PASSWORD) return `Use ${MIN_PASSWORD} characters or more.`;
  if (password !== again) return 'The two passwords do not match. Type the same one twice.';
  return undefined;
}

export function IdentityGroup() {
  const fingerprint = useHub((s) => s.hub?.fingerprint);
  const owner = useIsOwner();
  return (
    <Group title="This hub" id="identity">
      <SettingRow label="Fingerprint" help="A phone that logs in with the password shows it once. Check that the two match." top>
        {fingerprint ? <Fingerprint value={fingerprint} size="sm" className="md:ml-auto" /> : <span className="text-[13px] text-fg-3 phone:text-[14px]">None yet. Update the hub to give it a key.</span>}
      </SettingRow>
      {owner && <PasswordRow />}
    </Group>
  );
}

function PasswordRow() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [status, setStatus] = useState<PasswordStatus>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    api()
      .passwordStatus()
      .then(setStatus)
      .catch((e) => setError(errText(e)));
  }, []);

  const help = 'Log in from a phone with the hub address and this password, when you cannot scan a code. Off until you set one.';
  return (
    <>
      <SettingRow label="Password" help={help}>
        {error ? (
          <span className="text-[13px] text-fault phone:text-[14px]">{error}</span>
        ) : !status ? (
          <span className="text-[13px] text-fg-3">Loading…</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2 md:justify-end">
            <span className="text-[13px] text-fg-3 phone:w-full phone:text-[14px]">{status.set ? (status.setAt ? `Set ${shortDate(status.setAt)}` : 'Set') : 'Not set'}</span>
            <Button variant="outline" size={size} onClick={() => setEditing(true)}>
              {status.set ? 'Change' : 'Set a password'}
            </Button>
            {status.set && (
              <Button variant="danger" size={size} onClick={() => setRemoving(true)}>
                Remove
              </Button>
            )}
          </span>
        )}
      </SettingRow>
      <PasswordDialog open={editing} change={!!status?.set} onClose={() => setEditing(false)} onSaved={setStatus} />
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove the password?"
        body="Phones that logged in with it stay signed in. New phones pair with a code until you set one again."
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          try {
            setStatus(await api().clearPassword());
            setRemoving(false);
          } catch (e) {
            setError(errText(e));
            setRemoving(false);
          }
        }}
      />
    </>
  );
}

function PasswordDialog({ open, change, onClose, onSaved }: { open: boolean; change: boolean; onClose: () => void; onSaved: (s: PasswordStatus) => void }) {
  const mobile = useIsMobile();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setAgain('');
    setTried(false);
    setError(undefined);
  }, [open]);

  const problem = passwordProblem(password, again);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await api().setPassword(password));
      onClose();
    } catch (err) {
      // the hub's words: too short, or not the owner
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const size = mobile ? 'touch' : 'md';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={change ? 'Change the password' : 'Set a password'}
      description="12 characters or more. The hub keeps only a hash of it."
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={size} busy={busy ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="New password">
          <Input type="password" autoComplete="new-password" autoFocus value={password} invalid={tried && password.length < MIN_PASSWORD} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Type it again">
          <Input type="password" autoComplete="new-password" value={again} invalid={tried && !!problem && password.length >= MIN_PASSWORD} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {/* the submit button sits in the dialog footer; Enter in a field still saves */}
        <button type="submit" hidden />
        {((tried && problem) || error) && (
          <Help error>
            <span role="alert">{error ?? problem}</span>
          </Help>
        )}
      </form>
    </Dialog>
  );
}
