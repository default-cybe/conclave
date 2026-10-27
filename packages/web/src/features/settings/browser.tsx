/**
 * Settings > Browser: the hub's browser profiles, the sites the owner signed
 * in to with each, and Sign in to a site. That opens a remote view of a
 * profile's page on the hub: the newest frame of the page as a picture,
 * with clicks, scrolling, keys and text sent back. The owner signs in once
 * (Facebook for a Marketplace watch); the login stays in the profile, and
 * watches and the assistant browse with it.
 */
import { useEffect, useState } from 'react';
import type { BrowserStatusDto, SignInViewDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { Field, Input, Select } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { agoWords, errText, Group, SettingRow } from './parts';
import { EnginesGroup, newProfileWords, profileHelp, ProfileEngine, ProxyGroup } from './browserParts';
import { SitesAndLogins } from './sitesLogins';
import { RemotePage } from './RemotePage';

/** "Signed in to facebook.com 2d ago" or "No sites yet". */
export function sitesWords(p: BrowserStatusDto['profiles'][number], now = Date.now()): string {
  if (!p.sites.length) return 'No sites signed in yet';
  const [first, ...rest] = p.sites;
  return `Signed in to ${first.host} ${agoWords(first.at, now)}${rest.length ? `, and ${rest.map((s) => s.host).slice(0, 3).join(', ')}` : ''}`;
}

export function BrowserSection() {
  const [s, setS] = useState<BrowserStatusDto>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<SignInViewDto>();
  const load = () =>
    api()
      .browserStatus()
      .then(setS)
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load the browser settings. {error}</p>;
  if (!s) return <LoadingRows loading rows={3} />;
  return (
    <div className="space-y-9">
      {s.engines && <EnginesGroup s={s} onStatus={setS} />}

      <Group
        title="Profiles"
        count={s.profiles.length}
        help={`The assistant and watches browse with these. Each keeps its own logins. A watch that needs a login uses the profile you signed in with.${s.newProfileEngine ? ` ${newProfileWords(s.newProfileEngine)}` : ''}`}
      >
        {s.profiles.map((p) => (
          <SettingRow key={p.name} label={p.name} help={profileHelp(p, sitesWords(p))}>
            {s.engines ? <ProfileEngine p={p} s={s} onStatus={setS} /> : <span className="text-[13px] text-fg-2 phone:text-[14px]">{sitesWords(p)}</span>}
          </SettingRow>
        ))}
        {!s.available && <p className="py-3 text-[13px] text-fault">{s.reason ?? 'The browser is not available on this hub.'}</p>}
      </Group>

      <SitesAndLogins s={s} onStatus={setS} />

      {s.proxy && <ProxyGroup s={s} onStatus={setS} />}

      <Group title="Sign in to a site" help="Opens the site in a profile on the hub and shows it here. Click and type as you would, then press Done. Good for sites with a puzzle or a check. What you type goes to the site only: the hub keeps the cookies, not the password. A saved login, above, is kept on the hub, encrypted.">
        <SettingRow label="Sign in" help="Use your personal account. Watches check at most a few times a day; sites limit automated use, and a watch can stop working when a site changes.">
          <Button variant="solid" size="sm" disabled={!s.available} onClick={() => setPicking(true)}>
            Sign in to a site
          </Button>
        </SettingRow>
      </Group>

      <OpenDialog
        open={picking}
        profiles={s.profiles.map((p) => p.name)}
        onClose={() => setPicking(false)}
        onOpen={(v) => {
          setPicking(false);
          setView(v);
        }}
      />
      {view && (
        <SignInDialog
          view={view}
          onClose={(next) => {
            setView(undefined);
            if (next) setS(next);
            else void load();
          }}
        />
      )}
    </div>
  );
}

function OpenDialog({ open, profiles, onClose, onOpen }: { open: boolean; profiles: string[]; onClose: () => void; onOpen: (v: SignInViewDto) => void }) {
  const phone = useIsMobile();
  // an existing profile by default (default first), so Open never makes a profile the owner did not name
  const [profile, setProfile] = useState(profiles.includes('default') ? 'default' : (profiles[0] ?? ''));
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const chosen = profile || name.trim();
  const go = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      onOpen(await api().openSignIn(chosen, url.trim()));
    } catch (e) {
      setProblem(errText(e));
    }
    setBusy(false);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Sign in to a site"
      description="Pick the profile to keep the login in and the site to open."
      footer={
        <>
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy ? 'Opening' : false} disabled={!chosen || !url.trim()} onClick={() => void go()}>
            Open
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Profile">
          <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">New profile</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        {!profile && (
          <Field label="Name of the new profile" help="Letters, digits, dot, dash or underscore.">
            <Input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="marketplace" />
          </Field>
        )}
        <Field label="Site">
          <Input mono value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} inputMode="url" placeholder="https://www.facebook.com/" />
        </Field>
        {problem && <p className="text-[13px] text-fault">{problem}</p>}
      </div>
    </Dialog>
  );
}

/** The remote view: the page's newest frame, clicks and keys back to it. */
function SignInDialog({ view, onClose }: { view: SignInViewDto; onClose: (status?: BrowserStatusDto) => void }) {
  const phone = useIsMobile();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try {
      const next = await api().signInDone(view.id);
      toast({ title: `Signed in. Profile ${view.profile} keeps the login.` });
      onClose(next);
    } catch (e) {
      setProblem(errText(e));
      setBusy(false);
    }
  };
  const cancel = () => {
    void api()
      .closeSignIn(view.id)
      .catch(() => undefined);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={cancel}
      title={`Sign in, profile ${view.profile}`}
      width={980}
      top="5vh"
      bodyClassName="px-4 pb-4 phone:px-3"
      footer={
        <>
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={cancel}>
            Cancel
          </Button>
          <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy ? 'Saving' : false} onClick={() => void done()}>
            Done, I am signed in
          </Button>
        </>
      }
    >
      <RemotePage
        viewKey={view.id}
        poll={(after) => api().signInFrame(view.id, after)}
        send={(events) => api().signInInput(view.id, events)}
        interactive
        phoneWidth
        startUrl={view.url}
        problem={problem}
        help="Click the page, then type, or type in the box and press Send. The picture follows the page about twice a second."
      />
    </Dialog>
  );
}
