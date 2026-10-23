/**
 * Settings > Browser, Sites and logins: per profile, each site it is signed
 * in to (cookies) or has a saved login for, with the account, when it was
 * last used, and Edit login, Forget and Delete login. Add a login saves a
 * site's username and password (and a 2FA key) so the assistant can log in
 * by itself with browser_login. The hub keeps them encrypted and this page
 * never gets them back: it only shows that they are saved. Delete profile
 * removes a profile with its folder and logins; the default one stays.
 */
import { useState } from 'react';
import { ApiError, type BrowserLoginDto, type BrowserLoginInput, type BrowserStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile, useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { errText, Group, SettingRow } from './parts';
import { deleteProfileWords, forgetWords, LOGIN_FORM_HELP, LOGINS_HELP, profileLine, siteRows, siteRowWords, SUBDOMAINS_HELP, TOTP_HELP, type SiteRow } from './browserLoginWords';

type Status = BrowserStatusDto;
type Profile = Status['profiles'][number];

/** What the add and edit form starts from: a login to change, or a profile and site to save one for. */
export interface LoginFormStart {
  login?: BrowserLoginDto;
  profile?: string;
  host?: string;
}

export function SitesAndLogins({ s, onStatus }: { s: Status; onStatus: (s: Status) => void }) {
  const phone = useIsMobile();
  const now = useNow(60_000);
  const [form, setForm] = useState<LoginFormStart>();
  const [forgetting, setForgetting] = useState<{ profile: string; row: SiteRow }>();
  const [dropping, setDropping] = useState<BrowserLoginDto>();
  const [deleting, setDeleting] = useState<Profile>();
  /** Delete was refused because a session has the profile open: ask once more, to close it first. */
  const [closing, setClosing] = useState<{ p: Profile; why: string }>();
  const btn = phone ? 'touch' : 'sm';
  const count = s.profiles.reduce((n, p) => n + siteRows(p).length, 0);
  const names = s.profiles.map((p) => p.name);

  const forget = async (profile: string, row: SiteRow) => {
    try {
      onStatus(await api().forgetBrowserSite(profile, row.host));
      toast({ title: `${row.host} is forgotten in ${profile}.` });
    } catch (e) {
      toast({ title: `Could not forget ${row.host}. ${errText(e)}`, level: 'error' });
    }
    setForgetting(undefined);
  };
  const dropLogin = async (l: BrowserLoginDto) => {
    try {
      onStatus(await api().deleteBrowserLogin(l.id));
      toast({ title: `Deleted the saved login for ${l.host}.` });
    } catch (e) {
      toast({ title: `Could not delete the login. ${errText(e)}`, level: 'error' });
    }
    setDropping(undefined);
  };
  const deleteProfile = async (p: Profile, close: boolean) => {
    try {
      onStatus(await api().deleteBrowserProfile(p.name, close));
      toast({ title: `Deleted profile ${p.name}.` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !close) setClosing({ p, why: errText(e) });
      else toast({ title: `Could not delete ${p.name}. ${errText(e)}`, level: 'error' });
    }
  };

  return (
    <Group title="Sites and logins" count={count} help={LOGINS_HELP} action={{ label: 'Add a login', onClick: () => setForm({}) }} rows={false}>
      {s.profiles.map((p) => {
        const rows = siteRows(p);
        return (
          <section key={p.name} aria-label={`Profile ${p.name}`} className="mt-5 first:mt-3">
            <div className="flex items-center gap-3 border-b border-rule pb-2">
              <div className="min-w-0 flex-1">
                <h3 className="m-0 text-[13.5px] leading-[1.35] font-semibold text-fg phone:text-[15px]">{p.name}</h3>
                <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{profileLine(p)}</p>
              </div>
              {!p.isDefault && (
                <Button variant="danger" size={btn} onClick={() => setDeleting(p)}>
                  Delete profile
                </Button>
              )}
            </div>
            <div className="rows pl-4 phone:pl-3">
              {rows.length ? (
                rows.map((r) => {
                  const w = siteRowWords(r, now);
                  return (
                    <SettingRow
                      key={r.key}
                      label={r.host}
                      help={
                        <>
                          <span className={cn(r.login ? 'text-fg-2' : undefined)}>{w.account}</span>. {w.state}, {w.used}.{w.problem && <span className="block text-fault">{w.problem}</span>}
                        </>
                      }
                    >
                      <div className="flex flex-wrap gap-2 md:justify-end">
                        {r.login ? (
                          <Button variant="outline" size={btn} onClick={() => setForm({ login: r.login })}>
                            Edit login
                          </Button>
                        ) : (
                          <Button variant="outline" size={btn} onClick={() => setForm({ profile: p.name, host: r.host })}>
                            Save login
                          </Button>
                        )}
                        <Button variant="quiet" size={btn} onClick={() => setForgetting({ profile: p.name, row: r })}>
                          Forget
                        </Button>
                        {r.login && (
                          <Button variant="danger" size={btn} onClick={() => setDropping(r.login)}>
                            Delete login
                          </Button>
                        )}
                      </div>
                    </SettingRow>
                  );
                })
              ) : (
                <SettingRow label="No sites yet" help="Add a login, or sign in to a site below." />
              )}
            </div>
          </section>
        );
      })}

      {form && (
        <LoginDialog
          start={form}
          profiles={names}
          onClose={() => setForm(undefined)}
          onSaved={(next) => {
            onStatus(next);
            setForm(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={!!forgetting}
        onClose={() => setForgetting(undefined)}
        title={forgetting ? `Forget ${forgetting.row.host} in ${forgetting.profile}?` : ''}
        body={forgetting ? forgetWords(forgetting.row, forgetting.profile) : ''}
        confirm="Forget"
        busy="Forgetting"
        onConfirm={() => (forgetting ? forget(forgetting.profile, forgetting.row) : undefined)}
      />
      <ConfirmDialog
        open={!!dropping}
        onClose={() => setDropping(undefined)}
        title={dropping ? `Delete the saved login for ${dropping.host}?` : ''}
        body="The hub deletes the username, password and 2FA key. The profile stays signed in until you Forget the site."
        confirm="Delete login"
        busy="Deleting"
        onConfirm={() => (dropping ? dropLogin(dropping) : undefined)}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title={deleting ? `Delete profile ${deleting.name}?` : ''}
        body={deleting ? deleteProfileWords(deleting) : ''}
        confirm="Delete profile"
        busy="Deleting"
        onConfirm={() => (deleting ? deleteProfile(deleting, false) : undefined)}
      />
      <ConfirmDialog
        open={!!closing}
        onClose={() => setClosing(undefined)}
        title={closing ? `Close and delete ${closing.p.name}?` : ''}
        body={closing ? `${closing.why} Closing it ends the pages a chat or watch has open in it.` : ''}
        confirm="Close and delete"
        busy="Deleting"
        onConfirm={() => (closing ? deleteProfile(closing.p, true) : undefined)}
      />
    </Group>
  );
}

/** Add a login, or change one. The password and 2FA key go to the hub and never come back. */
function LoginDialog({ start, profiles, onClose, onSaved }: { start: LoginFormStart; profiles: string[]; onClose: () => void; onSaved: (s: Status) => void }) {
  const phone = useIsMobile();
  const size = phone ? 'touch' : 'md';
  const editing = start.login;
  const first = editing?.profile ?? start.profile ?? (profiles.includes('default') ? 'default' : (profiles[0] ?? ''));
  const [profile, setProfile] = useState(first);
  const [newName, setNewName] = useState('');
  const [site, setSite] = useState(editing?.origin ?? (start.host ? `https://${start.host}` : ''));
  const [username, setUsername] = useState(editing?.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [dropTotp, setDropTotp] = useState(false);
  const [subdomains, setSubdomains] = useState(editing?.subdomains ?? false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const chosen = profile || newName.trim();
  const ready = !!chosen && !!site.trim() && !!username.trim() && (!!editing || !!password);

  const save = async () => {
    setBusy(true);
    setProblem(undefined);
    const body: BrowserLoginInput = {
      profile: chosen,
      site: site.trim(),
      username: username.trim(),
      subdomains,
      ...(password ? { password } : {}),
      ...(totp.trim() ? { totp: totp.trim() } : dropTotp ? { totp: null } : {}),
    };
    try {
      const next = editing ? await api().updateBrowserLogin(editing.id, body) : await api().addBrowserLogin(body);
      setPassword('');
      setTotp('');
      onSaved(next);
      toast({ title: editing ? 'Saved.' : 'Saved. The assistant can log in there by itself now.' });
    } catch (e) {
      setProblem(errText(e));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `Edit login, ${editing.host}` : 'Add a login'}
      description={LOGIN_FORM_HELP}
      width={520}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={size} busy={busy ? 'Saving' : false} disabled={!ready} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        <Field label="Profile" help="The profile whose browser logs in. Its cookies keep the login after.">
          <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="">New profile</option>
          </Select>
        </Field>
        {!profile && (
          <Field label="Name of the new profile" help="Letters, digits, dot, dash or underscore.">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} spellCheck={false} />
          </Field>
        )}
        <Field label="Site" help="The address you log in at, such as https://www.facebook.com.">
          <Input mono value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://www.facebook.com" spellCheck={false} inputMode="url" autoComplete="off" />
        </Field>
        <Checkbox checked={subdomains} onChange={setSubdomains} label="Include subdomains" description={SUBDOMAINS_HELP} />
        <Field label="Username" help="Your email, phone or user name on the site.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Password" help={editing ? 'Saved on the hub, encrypted. Type a new one to replace it.' : 'Kept on the hub, encrypted. It is not shown again.'}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editing ? 'Saved' : 'Password'} autoComplete="new-password" />
        </Field>
        <Field label="2FA key" optional help={editing?.totp ? 'Saved on the hub, encrypted. Type a new one to replace it.' : TOTP_HELP}>
          <Input mono value={totp} onChange={(e) => setTotp(e.target.value)} placeholder={editing?.totp ? 'Saved' : 'JBSW Y3DP EHPK 3PXP'} spellCheck={false} autoComplete="off" disabled={dropTotp} />
        </Field>
        {editing?.totp && <Checkbox checked={dropTotp} onChange={setDropTotp} label="Remove the 2FA key" description="The assistant asks you for the code instead." />}
        {problem && (
          <p className="m-0 text-[13px] text-fault" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Dialog>
  );
}
