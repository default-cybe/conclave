/**
 * People on this hub (docs/design/ACCOUNTS.md). Three sections:
 *
 * - People (the owner): who has an account, how they sign in, which of the
 *   hub's keys they may use with a monthly budget and what they spent.
 *   Add a person with an invite link or a password, edit access, set a new
 *   password, make a new link, a workspace on the hub machine, remove.
 * - Your account (everyone): display name, sign-in name and email, a
 *   member's password and default model, the apps you are signed in with
 *   (signedin.tsx), and the sign ins this browser keeps: switch, add, sign
 *   out.
 * - Providers for a member: which keys their calls use, the budget on the
 *   hub's, and a key of their own.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { InviteDto, MeDto, PersonDto, ProviderAccessDto, ProviderGrantsDto, WorkspaceCode } from '@conclave/core/client';
import { api } from '@/lib/api';
import { DISPLAY_NAME_MAX, accountLabel, addAccount, displayNameProblem, isCurrent, nameProblem, personName, refreshAccount, savedAccounts, signOut, switchAccount, tidyDisplayName, useMe } from '@/lib/people';
import { useIsMobile } from '@/lib/hooks';
import { shortDate, usd } from '@/lib/format';
import { hubKeyProviders, providerInfo } from '@/lib/providers';
import { toast, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Segmented, Select } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { Command } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { errText, Group, Outcome, SettingRow } from './parts';
import { PersonApps, SignedInGroup } from './signedin';

const MIN_PASSWORD = 12;

/** Refresh who is signed in after a change to it. */
async function reloadMe(): Promise<void> {
  try {
    const me = await api().me();
    useHub.setState({ me });
    refreshAccount(me);
  } catch {
    /* the next full load gets it */
  }
}

/** What People calls a person: their display name, else their sign-in name. */
const called = (p: PersonDto) => personName(p) ?? p.name;

/** A display name as PATCH takes it: unchanged is left out, empty clears it. */
function displayNamePatch(typed: string, had: string | undefined): { displayName?: string | null } {
  const n = tidyDisplayName(typed);
  if (n === (had ?? '')) return {};
  return { displayName: n || null };
}

/** "Anthropic $1.20 of $5 this month" */
function spendLine(s: { provider?: string; name: string; spentUsd: number; monthlyUsd?: number }): string {
  return `${(s.provider && providerInfo(s.provider)?.name) || s.name} ${usd(s.spentUsd, { precise: true })}${s.monthlyUsd !== undefined ? ` of ${usd(s.monthlyUsd, { precise: true })}` : ''}`;
}

// ---------------------------------------------------------------------------
// People (the owner)
// ---------------------------------------------------------------------------

export function PeopleSection() {
  const [people, setPeople] = useState<PersonDto[]>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PersonDto>();
  const [resetting, setResetting] = useState<PersonDto>();
  const [removing, setRemoving] = useState<PersonDto>();
  const [workspace, setWorkspace] = useState<{ person: PersonDto; code: WorkspaceCode }>();
  const [link, setLink] = useState<{ person: string; invite: InviteDto }>();
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';

  const load = () =>
    api()
      .people()
      .then(setPeople)
      .catch((e) => toast({ title: `Could not load people. ${errText(e)}`, level: 'error' }));
  useEffect(() => {
    void load();
  }, []);

  if (!people) return <LoadingRows loading rows={3} />;
  const members = people.filter((p) => p.role === 'member');

  const newLink = async (p: PersonDto) => {
    try {
      setLink({ person: called(p), invite: await api().newInvite(p.id) });
      void load();
    } catch (e) {
      toast({ title: `Could not make a link. ${errText(e)}`, level: 'error' });
    }
  };
  const openWorkspace = async (p: PersonDto) => {
    try {
      setWorkspace({ person: p, code: await api().workspaceCode(p.id) });
    } catch (e) {
      toast({ title: `Could not make a code. ${errText(e)}`, level: 'error' });
    }
  };

  return (
    <div className="space-y-9">
      <Group
        title="People"
        count={people.length}
        right={
          <Button variant="solid" size={size} onClick={() => setAdding(true)}>
            Add person
          </Button>
        }
        help="Each person has their own chats, memory, routines, devices and keys. The hub's own computer and its settings stay yours."
      >
        {people.map((p) => (
          <SettingRow
            key={p.id}
            top
            label={
              <>
                {called(p)}
                {p.role === 'owner' && <span className="ml-2 font-normal text-fg-3">owner, you</span>}
              </>
            }
            help={
              <>
                {[`Signs in as ${p.name}`, p.email, p.role === 'member' ? (p.passwordSet ? 'Password set' : p.inviteExpiresAt ? `Invite open until ${shortDate(p.inviteExpiresAt)}` : 'No password yet') : undefined, `${p.devices} device${p.devices === 1 ? '' : 's'}, ${p.apps} app${p.apps === 1 ? '' : 's'}`]
                  .filter(Boolean)
                  .join(' · ')}
                {p.role === 'member' && (
                  <span className="block">{p.spend.length ? p.spend.map(spendLine).join(', ') + ' this month' : "No access to the hub's keys"}</span>
                )}
                {p.role === 'member' && p.ownPlans ? <span className="block">Has {p.ownPlans} own {p.ownPlans === 1 ? 'plan' : 'plans'}</span> : null}
                {p.role === 'member' && p.apps > 0 && <PersonApps person={p} onChange={() => void load()} />}
              </>
            }
          >
            {p.role === 'member' && (
              <div className="flex flex-wrap gap-2 md:justify-end">
                <Button variant="outline" size={size} onClick={() => setEditing(p)}>
                  Access
                </Button>
                <Button variant="outline" size={size} onClick={() => setResetting(p)}>
                  Password
                </Button>
                <Button variant="outline" size={size} onClick={() => void newLink(p)}>
                  Invite link
                </Button>
                <Button variant="outline" size={size} onClick={() => void openWorkspace(p)}>
                  Workspace
                </Button>
                <Button variant="danger" size={size} onClick={() => setRemoving(p)}>
                  Remove
                </Button>
              </div>
            )}
          </SettingRow>
        ))}
        {!members.length && <SettingRow label="Nobody else yet" help="Add a person and send them the invite link, or set a password for them." />}
      </Group>

      <Group title="What a person can do" rows={false}>
        <ul className="m-0 mt-3 max-w-[64ch] list-disc space-y-1.5 pl-5 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
          <li>Chat, keep memory and routines, and use the assistant. Nobody else on the hub sees these, you included, in the apps.</li>
          <li>Code on devices they pair themselves. Tools never run on the hub's own computer for them, unless you give them a workspace: its own user or container on that computer.</li>
          <li>Use the hub's keys only where you allow it, up to the monthly budget you set, or their own keys.</li>
          <li>Friends, remote access, extensions, MCP servers, hooks and hub settings stay yours.</li>
        </ul>
      </Group>

      <AddPersonDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(p, invite) => {
          setAdding(false);
          void load();
          if (invite) setLink({ person: called(p), invite });
          else toast({ title: `${called(p)} can sign in now.`, level: 'success' });
        }}
      />
      {editing && (
        <AccessDialog
          person={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
      {resetting && (
        <PasswordDialog
          person={resetting}
          onClose={() => setResetting(undefined)}
          onSaved={() => {
            toast({ title: `New password set. ${called(resetting)}'s apps are signed out.`, level: 'success' });
            setResetting(undefined);
            void load();
          }}
        />
      )}
      <Dialog open={!!link} onClose={() => setLink(undefined)} title={link ? `Invite link for ${link.person}` : ''} description="Send it to them. It works once and for 7 days, and shows only now." width={560}>
        {link && (
          <>
            <Command command={link.invite.url} copy />
            <p className="mt-3 text-[13px] text-fg-3">Open until {shortDate(link.invite.expiresAt)}. A new link ends this one.</p>
          </>
        )}
      </Dialog>
      <Dialog open={!!workspace} onClose={() => setWorkspace(undefined)} title={workspace ? `Workspace for ${called(workspace.person)}` : ''} description="Run these on the hub's computer. The workspace is a device of theirs with its own user, so it cannot read your files. The code works for an hour." width={640}>
        {workspace && (
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg-2">Its own user (Linux)</div>
              <Command command={workspace.code.commands.linux.join('\n')} copy />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg-2">Or its own container (Docker)</div>
              <Command command={workspace.code.commands.docker.join('\n')} copy />
            </div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(undefined)}
        title={removing ? `Remove ${called(removing)}?` : ''}
        body="Their chats, memory, routines, devices, apps and keys are deleted, and their apps sign out. This cannot be undone."
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api().removePerson(removing.id);
            toast({ title: `${called(removing)} was removed.`, level: 'success' });
          } catch (e) {
            toast({ title: `Could not remove. ${errText(e)}`, level: 'error' });
          }
          setRemoving(undefined);
          void load();
        }}
      />
    </div>
  );
}

/** The hub's providers with a key or a signed in plan, for the access checkboxes: the hub refuses the others. */
function useHubProviders(): Array<{ id: string; name: string }> {
  const models = useHub((s) => s.models);
  return useMemo(() => hubKeyProviders(models), [models]);
}

/** Access to the hub's keys: a checkbox per provider and an optional monthly budget. */
function AccessFields({ value, onChange }: { value: Record<string, { on: boolean; budget: string }>; onChange: (v: Record<string, { on: boolean; budget: string }>) => void }) {
  const providers = useHubProviders();
  if (!providers.length) return <p className="text-[13px] text-fg-3">The hub has no keys to share yet. Add one in Settings, Providers.</p>;
  return (
    <div className="flex flex-col gap-3">
      {providers.map((p) => {
        const v = value[p.id] ?? { on: false, budget: '' };
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Checkbox className="min-w-[180px] flex-1" checked={v.on} onChange={(on) => onChange({ ...value, [p.id]: { ...v, on } })} label={`Use the hub's ${p.name} key`} />
            {v.on && (
              <label className="flex items-center gap-2 text-[13px] text-fg-3">
                Monthly budget $
                <Input className="w-[92px]" inputMode="decimal" value={v.budget} placeholder="no cap" onChange={(e) => onChange({ ...value, [p.id]: { ...v, budget: e.target.value } })} aria-label={`Monthly budget for ${p.name} in US dollars`} />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

function grantsOf(v: Record<string, { on: boolean; budget: string }>): ProviderGrantsDto | string {
  const out: ProviderGrantsDto = {};
  for (const [id, g] of Object.entries(v)) {
    if (!g.on) continue;
    const t = g.budget.trim().replace(/^\$/, '');
    if (!t) {
      out[id] = { monthlyUsd: null };
      continue;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return 'A budget is a number of dollars, 0 or more.';
    out[id] = { monthlyUsd: n };
  }
  return out;
}

function AddPersonDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (p: PersonDto, invite?: InviteDto) => void }) {
  const [shown, setShown] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [how, setHow] = useState<'invite' | 'password'>('invite');
  const [password, setPassword] = useState('');
  const [access, setAccess] = useState<Record<string, { on: boolean; budget: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mobile = useIsMobile();
  useEffect(() => {
    if (!open) return;
    setShown('');
    setName('');
    setEmail('');
    setPassword('');
    setAccess({});
    setError(undefined);
  }, [open]);

  const nameOk = !!name.trim() && !nameProblem(name);
  const shownBad = displayNameProblem(shown);
  const ready = nameOk && !shownBad && (how === 'invite' || [...password].length >= MIN_PASSWORD) && !busy;
  const submit = async () => {
    const providers = grantsOf(access);
    if (typeof providers === 'string') return setError(providers);
    setBusy(true);
    setError(undefined);
    try {
      const out = await api().addPerson({ name: name.trim(), ...(tidyDisplayName(shown) ? { displayName: tidyDisplayName(shown) } : {}), ...(email.trim() ? { email: email.trim() } : {}), ...(how === 'password' ? { password } : { invite: true }), providers });
      onAdded(out.person, out.invite);
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add person"
      width={560}
      footer={
        <>
          <Button variant="ghost" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!ready} busy={busy ? 'Adding' : false} onClick={() => void submit()}>
            Add
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <Field label="Display name" optional help="What the apps call them. Spaces are fine. Left empty, their sign-in name." error={shownBad}>
          <Input value={shown} onChange={(e) => setShown(e.target.value)} maxLength={DISPLAY_NAME_MAX} autoComplete="off" placeholder="Dee Okafor" autoFocus />
        </Field>
        <Field label="Sign-in name" help="What they type to sign in. One word: letters, digits, dot, dash." error={nameProblem(name)}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="dee" />
        </Field>
        <Field label="Email" optional>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">How they sign in</span>
          <Segmented
            label="How they sign in"
            value={how}
            onChange={setHow}
            className="self-start"
            options={[
              { value: 'invite', label: 'Invite link' },
              { value: 'password', label: 'Password' },
            ]}
          />
        </div>
        {how === 'password' && (
          <Field label="Password" help={`At least ${MIN_PASSWORD} characters. Tell it to them; they can change it.`}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">The hub's keys</span>
          <AccessFields value={access} onChange={setAccess} />
          <span className="text-[12px] text-fg-3">Without access they add their own keys. The budget counts calls on your keys only.</span>
        </div>
        {error && <p className="m-0 text-[13px] text-fault">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function AccessDialog({ person, onClose, onSaved }: { person: PersonDto; onClose: () => void; onSaved: () => void }) {
  const offered = useHubProviders();
  // a grant on a key the hub no longer has is not shown, and goes on Save
  const [access, setAccess] = useState<Record<string, { on: boolean; budget: string }>>(() =>
    Object.fromEntries(
      Object.entries(person.providers)
        .filter(([id]) => !offered.length || offered.some((p) => p.id === id))
        .map(([id, g]) => [id, { on: true, budget: typeof g.monthlyUsd === 'number' ? String(g.monthlyUsd) : '' }]),
    ),
  );
  const [shown, setShown] = useState(person.displayName ?? '');
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mobile = useIsMobile();
  const submit = async () => {
    const providers = grantsOf(access);
    if (typeof providers === 'string') return setError(providers);
    const bad = displayNameProblem(shown) ?? nameProblem(name);
    if (bad) return setError(bad);
    setBusy(true);
    setError(undefined);
    try {
      await api().updatePerson(person.id, { providers, ...displayNamePatch(shown, person.displayName), ...(name.trim() !== person.name ? { name: name.trim() } : {}), email: email.trim() || null });
      onSaved();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${called(person)}'s access`}
      width={560}
      footer={
        <>
          <Button variant="ghost" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} busy={busy ? 'Saving' : false} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <Field label="Display name" optional help="What the apps call them. Spaces are fine.">
          <Input value={shown} onChange={(e) => setShown(e.target.value)} maxLength={DISPLAY_NAME_MAX} autoComplete="off" />
        </Field>
        <Field label="Sign-in name" help="What they type to sign in.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label="Email" optional>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">The hub's keys</span>
          <AccessFields value={access} onChange={setAccess} />
          {person.spend.length > 0 && <span className="text-[12px] text-fg-3">This month: {person.spend.map(spendLine).join(', ')}.</span>}
        </div>
        {error && <p className="m-0 text-[13px] text-fault">{error}</p>}
      </div>
    </Dialog>
  );
}

function PasswordDialog({ person, onClose, onSaved }: { person: PersonDto; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mobile = useIsMobile();
  const ready = [...password].length >= MIN_PASSWORD && !busy;
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api().resetPersonPassword(person.id, password);
      onSaved();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`New password for ${called(person)}`}
      description="Their apps sign out. Tell them the new password."
      footer={
        <>
          <Button variant="ghost" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!ready} busy={busy ? 'Saving' : false} onClick={() => void submit()}>
            Set password
          </Button>
        </>
      }
    >
      <Field label="Password" help={`At least ${MIN_PASSWORD} characters.`} error={error}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Your account (everyone)
// ---------------------------------------------------------------------------

export function YourAccountSection() {
  const me = useMe();
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [shown, setShown] = useState(me?.displayName ?? '');
  const [name, setName] = useState(me?.name ?? '');
  const [email, setEmail] = useState(me?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string>();
  const [confirmOut, setConfirmOut] = useState(false);
  const models = useHub((s) => s.models);
  const saved = savedAccounts();
  useEffect(() => {
    setShown(me?.displayName ?? '');
    setName(me?.name ?? '');
    setEmail(me?.email ?? '');
  }, [me?.displayName, me?.name, me?.email]);

  if (!me) return <p className="text-[14px] text-fg-3">This hub has one person, the owner. Update it to add people.</p>;
  const member = me.role === 'member';
  const shownBad = displayNameProblem(shown);
  const nameBad = nameProblem(name);
  const changed = tidyDisplayName(shown) !== (me.displayName ?? '') || name.trim() !== me.name || email.trim() !== (me.email ?? '');

  const saveProfile = async () => {
    setBusy('profile');
    try {
      await api().updateMe({ ...displayNamePatch(shown, me.displayName), ...(name.trim() !== me.name ? { name: name.trim() } : {}), email: email.trim() || null });
      await reloadMe();
      toast({ title: 'Saved.', level: 'success' });
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };
  const savePassword = async () => {
    setBusy('password');
    try {
      await api().setPassword(password);
      setPassword('');
      await reloadMe();
      toast({ title: 'Password changed.', level: 'success' });
    } catch (e) {
      toast({ title: `Could not change it. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };
  const setDefault = async (ref: string) => {
    try {
      await api().updateMe({ defaultModel: ref || null });
      await reloadMe();
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
  };

  return (
    <div className="space-y-9">
      <Group title="You">
        <SettingRow label={personName(me) ?? me.name} help={member ? 'A member of this hub. The owner manages the hub and its settings.' : 'The owner of this hub.'} />
        <SettingRow label="Display name" htmlFor="me-display-name" help={shownBad ?? 'What the apps call you. Spaces are fine.'}>
          <Input id="me-display-name" className="w-full md:w-[240px]" value={shown} onChange={(e) => setShown(e.target.value)} maxLength={DISPLAY_NAME_MAX} invalid={!!shownBad} autoComplete="name" />
        </SettingRow>
        <SettingRow label="Sign-in name" htmlFor="me-name" help={nameBad ?? 'What you type to sign in. One word.'}>
          <Input id="me-name" className="w-full md:w-[240px]" value={name} onChange={(e) => setName(e.target.value)} invalid={!!nameBad} autoComplete="username" autoCapitalize="off" spellCheck={false} />
        </SettingRow>
        <SettingRow label="Email" htmlFor="me-email">
          <Input id="me-email" type="email" className="w-full md:w-[240px]" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </SettingRow>
        <SettingRow label="">
          <Button variant="outline" size={size} disabled={!changed || !!shownBad || !!nameBad || !name.trim()} busy={busy === 'profile' ? 'Saving' : false} onClick={() => void saveProfile()}>
            Save
          </Button>
        </SettingRow>
      </Group>

      {member ? (
        <Group title="Password">
          <SettingRow label="New password" htmlFor="me-password" help={`At least ${MIN_PASSWORD} characters. Your other apps stay signed in.`}>
            <form
              className="flex w-full gap-2 md:w-auto"
              onSubmit={(e) => {
                e.preventDefault();
                if ([...password].length >= MIN_PASSWORD) void savePassword();
              }}
            >
              <Input id="me-password" type="password" className="flex-1 md:w-[200px]" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <Button type="submit" variant="outline" size={size === 'sm' ? 'md' : size} disabled={[...password].length < MIN_PASSWORD} busy={busy === 'password' ? 'Saving' : false}>
                Change
              </Button>
            </form>
          </SettingRow>
        </Group>
      ) : (
        <Group title="Password">
          <SettingRow label="The hub password" help="Yours is set in Remote access, with the hub token.">
            <Link href="/settings/remote" className="link text-[13px]">
              Remote access
            </Link>
          </SettingRow>
        </Group>
      )}

      {member && (
        <Group title="Defaults">
          <SettingRow label="Model for new chats" htmlFor="me-model" help="Yours only. Left empty, the hub's default.">
            <Select id="me-model" value={me.preferences.defaultModel ?? ''} onChange={(e) => void setDefault(e.target.value)} className="w-full md:w-[260px]">
              <option value="">The hub's default</option>
              {models.flatMap((g) => g.models.map((m) => (
                <option key={m.ref} value={m.ref}>
                  {m.name}
                </option>
              )))}
            </Select>
          </SettingRow>
        </Group>
      )}

      <SignedInGroup />

      <Group title="Accounts on this browser" count={saved.length}>
        {saved.map((c) => (
          <SettingRow key={`${c.baseUrl} ${c.account?.id ?? c.token.slice(0, 8)}`} label={accountLabel(c)} help={c.hubName ?? c.baseUrl}>
            {isCurrent(c) ? (
              <Outcome word="Now" tone="ok" />
            ) : (
              <Button variant="outline" size={size} onClick={() => switchAccount(c)}>
                Switch
              </Button>
            )}
          </SettingRow>
        ))}
        <SettingRow label="">
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Button variant="outline" size={size} onClick={addAccount}>
              Add account
            </Button>
            <Button variant="danger" size={size} onClick={() => setConfirmOut(true)}>
              Sign out
            </Button>
          </div>
        </SettingRow>
      </Group>

      <ConfirmDialog
        open={confirmOut}
        onClose={() => setConfirmOut(false)}
        title={`Sign out as ${personName(me) ?? me.name}?`}
        body="This browser forgets the sign in. Your chats and memory stay on the hub."
        confirm="Sign out"
        busy="Signing out"
        onConfirm={signOut}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers, for a member
// ---------------------------------------------------------------------------

function accessWords(p: ProviderAccessDto): { word: string; tone: 'ok' | 'warn' | 'dim' | 'fault'; detail: string } {
  if (p.source === 'own') return { word: 'Your key', tone: 'ok', detail: 'Calls use your key and your account with the provider.' };
  if (p.source === 'hub') {
    const left = p.monthlyUsd !== undefined ? `${usd(p.spentUsd, { precise: true })} of ${usd(p.monthlyUsd, { precise: true })} this month, resets ${shortDate(p.resetsAt)}` : `${usd(p.spentUsd, { precise: true })} this month, no cap`;
    const over = p.monthlyUsd !== undefined && p.spentUsd >= p.monthlyUsd;
    return { word: over ? 'Budget used' : "The hub's key", tone: over ? 'warn' : 'ok', detail: left };
  }
  return { word: 'No access', tone: 'dim', detail: 'Add your own key, or ask the owner.' };
}

export function MemberProvidersSection() {
  const me = useMe();
  if (!me) return null;
  return (
    <div className="space-y-9">
      <Group title="Providers" count={me.providers.length} help="Your keys stay on the hub in your own file. Nobody else's calls use them.">
        {me.providers.map((p) => (
          <ProviderRow key={p.provider} p={p} />
        ))}
      </Group>
    </div>
  );
}

function ProviderRow({ p }: { p: ProviderAccessDto }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const w = accessWords(p);
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await api().setSecret('providers', p.provider, value);
      setKey('');
      await reloadMe();
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };
  return (
    <SettingRow top label={providerInfo(p.provider)?.name ?? p.name} help={<Outcome word={w.word} tone={w.tone}>{w.detail}</Outcome>}>
      {p.ownKey ? (
        <Button variant="outline" size={size} busy={busy ? 'Removing' : false} onClick={() => void save(null)}>
          Remove my key
        </Button>
      ) : (
        <form
          className="flex w-full gap-2 md:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void save(key.trim());
          }}
        >
          <Input type="password" className="flex-1 md:w-[200px]" placeholder="Your key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Your ${p.name} key`} />
          <Button type="submit" variant="outline" size={size === 'sm' ? 'md' : size} disabled={!key.trim()} busy={busy ? 'Saving' : false}>
            Save
          </Button>
        </form>
      )}
    </SettingRow>
  );
}

export type { MeDto };
