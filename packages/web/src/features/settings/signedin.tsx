/**
 * Signed in: the apps a person is signed in with (the Android app, the
 * iPhone web app, browsers, the desktop app's window, the CLI). They only
 * talk to the hub and run no work, so Devices does not list them
 * (lib/apps.ts). Each row has a plain name, what it is, online or when it
 * was last seen, "This browser" for this one, and Sign out.
 *
 * Settings, Your account shows your own; People shows a member's to the
 * owner. Signing this browser out goes back to the sign in page.
 */
import { useState } from 'react';
import type { AppDto } from '@conclave/core/client';
import { api, loadConnection, type Connection } from '@/lib/api';
import { appKind, isThisBrowser, signedIn, useSignedIn } from '@/lib/apps';
import { signOut } from '@/lib/people';
import { useIsMobile, useNow } from '@/lib/hooks';
import { removeKey, toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { agoWords, errText, Group, SettingRow } from './parts';

/** "Android app, online", "Browser, last seen 3h ago". */
export function appLine(a: AppDto, now: number): { kind: string; seen: string; online: boolean } {
  return { kind: appKind(a), online: !!a.online, seen: a.online ? 'online' : a.lastSeenAt ? `last seen ${agoWords(a.lastSeenAt, now)}` : 'not seen yet' };
}

interface RowsProps {
  apps: AppDto[];
  now: number;
  mobile: boolean;
  onEnd: (a: AppDto) => void;
  thisBrowser?: (a: AppDto) => boolean;
}

function AppRows({ apps, now, mobile, onEnd, thisBrowser }: RowsProps) {
  return (
    <>
      {apps.map((a) => {
        const l = appLine(a, now);
        const here = thisBrowser?.(a);
        return (
          <SettingRow
            key={a.id}
            label={
              <>
                {a.name}
                {here && <span className="ml-2 font-normal text-fg-3">This browser</span>}
              </>
            }
            help={
              <>
                {l.kind}, <span className={l.online ? 'text-ok' : undefined}>{l.seen}</span>
              </>
            }
          >
            <div className="flex md:justify-end">
              <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => onEnd(a)}>
                Sign out
              </Button>
            </div>
          </SettingRow>
        );
      })}
    </>
  );
}

/** The group itself: the apps, and which one is this browser. Each may be signed out from here (DELETE /api/clients/:id). */
export function SignedInView({ apps, conn, onEnd, now = Date.now(), mobile = false }: { apps: AppDto[]; conn: Pick<Connection, 'clientId'> | null; onEnd: (a: AppDto) => void; now?: number; mobile?: boolean }) {
  return (
    <Group id="signed-in" title="Signed in" count={apps.length} help="Phones, browsers and the desktop app you signed in with. They only talk to the hub; your computers run the work.">
      {apps.length ? (
        <AppRows apps={apps} now={now} mobile={mobile} onEnd={onEnd} thisBrowser={(a) => isThisBrowser(a, conn)} />
      ) : (
        <SettingRow label="No apps yet" help="Pair your phone in Devices, or sign in from another browser with the hub's address and your password." />
      )}
    </Group>
  );
}

/** Your own apps, in Settings, Your account. */
export function SignedInGroup() {
  const apps = useSignedIn();
  const conn = loadConnection();
  const now = useNow(60_000);
  const mobile = useIsMobile();
  const [ending, setEnding] = useState<AppDto>();
  const end = async (a: AppDto) => {
    if (isThisBrowser(a, conn)) return signOut();
    try {
      await api().revokeApp(a.id);
      removeKey('apps', a.id);
      toast({ title: `${a.name} is signed out.`, level: 'success' });
    } catch (e) {
      toast({ title: `Could not sign it out. ${errText(e)}`, level: 'error' });
    }
  };
  const here = ending && isThisBrowser(ending, conn);
  return (
    <>
      <SignedInView apps={apps} conn={conn} onEnd={setEnding} now={now} mobile={mobile} />
      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(undefined)}
        title={ending ? (here ? 'Sign out of this browser?' : `Sign out ${ending.name}?`) : ''}
        body={here ? 'This browser forgets the sign in. Your chats and memory stay on the hub.' : 'It stops getting approvals and notifications. Sign in on it again to bring it back.'}
        confirm="Sign out"
        busy="Signing out"
        onConfirm={async () => {
          if (ending) await end(ending);
          setEnding(undefined);
        }}
      />
    </>
  );
}

/** A member's apps, for the owner in People: listed when asked, each with Sign out. */
export function PersonApps({ person, onChange }: { person: { id: string; name: string }; onChange?: () => void }) {
  const [apps, setApps] = useState<AppDto[]>();
  const [ending, setEnding] = useState<AppDto>();
  const now = useNow(60_000);
  const mobile = useIsMobile();
  const load = () =>
    api()
      .personApps(person.id)
      .then((list) => setApps(signedIn(list)))
      .catch((e) => toast({ title: `Could not load the apps. ${errText(e)}`, level: 'error' }));
  if (!apps)
    return (
      <button type="button" className="link text-[12px] phone:text-[13px]" onClick={() => void load()}>
        Show signed in apps
      </button>
    );
  return (
    <div className="mt-1">
      {apps.length ? (
        <div className="rows">
          <AppRows apps={apps} now={now} mobile={mobile} onEnd={setEnding} />
        </div>
      ) : (
        <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">No apps signed in.</p>
      )}
      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(undefined)}
        title={ending ? `Sign out ${person.name}'s ${ending.name}?` : ''}
        body="It stops working until they sign in on it again."
        confirm="Sign out"
        busy="Signing out"
        onConfirm={async () => {
          if (!ending) return;
          try {
            await api().revokePersonApp(person.id, ending.id);
            toast({ title: `${ending.name} is signed out.`, level: 'success' });
          } catch (e) {
            toast({ title: `Could not sign it out. ${errText(e)}`, level: 'error' });
          }
          setEnding(undefined);
          await load();
          onChange?.();
        }}
      />
    </div>
  );
}
