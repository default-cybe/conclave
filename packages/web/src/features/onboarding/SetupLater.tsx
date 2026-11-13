/**
 * "Set up later" (design review #8): the old setup steps that are not part
 * of the four (extension packs, coding agents, defaults, past chats,
 * devices, notifications, routines). Home lists the ones still to do until
 * the owner hides the list; Settings, About lists all of them. Each opens
 * its page at /setup/<id>.
 */
import { Link, useLocation } from 'wouter';
import { toast, updateConfig, useHub } from '@/store/store';
import { useOnboarded } from '@/lib/onboarding';
import { Section } from '@/components/ui/Section';
import { Button, type ButtonSize } from '@/components/ui/Button';
import { HOVER_ROW } from '@/features/home/sections';
import { Group, SettingRow } from '@/features/settings/parts';
import { LATER, stepHref, type LaterId } from './steps';
import { laterDone, laterLeft, useProgress, useSetupFacts } from './progress';
import { errText } from './parts';

/** The items Home shows: none for a member, before setup is done, or once hidden. */
export function useSetupLater() {
  const facts = useSetupFacts();
  const { done } = useProgress();
  const owner = useHub((s) => s.me?.role === 'owner');
  const hidden = useHub((s) => !!s.config?.setup?.laterHidden);
  const onboarded = useOnboarded();
  return owner && onboarded && !hidden ? laterLeft(facts, done) : [];
}

const hide = () => void updateConfig({ setup: { laterHidden: true } }).catch((e) => toast({ title: `Could not hide the list. ${errText(e)}`, level: 'error' }));

/** Home, under the box. */
export function SetupLaterSection() {
  const left = useSetupLater();
  if (!left.length) return null;
  return (
    <Section title="Set up later" count={left.length} action={{ label: 'Hide', onClick: hide }} id="home-later">
      {left.map((s) => (
        <Link key={s.id} href={stepHref(s.id)} className={`${HOVER_ROW} grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-2.5 text-[13.5px]`}>
          <span className="truncate font-medium text-fg">{s.name}</span>
          <span className="truncate text-[12.5px] text-fg-3">{s.line}</span>
        </Link>
      ))}
    </Section>
  );
}

/** Settings, About: every item, done or not. */
export function SetupLaterGroup({ size }: { size: ButtonSize }) {
  const facts = useSetupFacts();
  const { done } = useProgress();
  const [, navigate] = useLocation();
  return (
    <Group title="Set up later" id="setup-later">
      {LATER.map((s) => {
        const ok = laterDone(s.id as LaterId, facts, done);
        return (
          <SettingRow key={s.id} label={s.name} help={ok ? `${s.line}. Set up.` : s.line}>
            <Button variant="outline" size={size} onClick={() => navigate(stepHref(s.id))}>
              {ok ? 'Change' : 'Set up'}
            </Button>
          </SettingRow>
        );
      })}
    </Group>
  );
}
