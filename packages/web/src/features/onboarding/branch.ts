/**
 * The first choice of setup: is this device the hub, or a client of a hub
 * that already exists? Setup itself is the hub branch only; the client
 * branch is the Connect screen. Pure, so the rules are tested on their own.
 */
import type { MeDto } from '@conclave/core/client';
import { displayNameProblem, personName, tidyDisplayName } from '@/lib/people';

export type SetupBranch = 'hub' | 'client';

/** True when this client reaches the hub on its own computer (the desktop app's hub, or `conclave serve` opened locally). */
export function hubIsHere(address: string | undefined): boolean {
  if (!address) return false;
  try {
    const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** The choices the Welcome screen offers. A hub on this computer was already chosen as the hub, so it offers no client path. */
export function branchChoices(address: string | undefined): SetupBranch[] {
  return hubIsHere(address) ? ['hub'] : ['hub', 'client'];
}

/** Where a choice leads: the setup steps, or the Connect screen. */
export function branchTarget(branch: SetupBranch): '/setup/hub' | '/connect' {
  return branch === 'hub' ? '/setup/hub' : '/connect';
}

/**
 * The name the Hub step's name field starts with. First setup of a hub
 * starts empty: whatever name the hub holds then (ui.name, an owner display
 * name from a restored backup or another person's hub) is not known to be
 * this person's. Run again on a hub that finished setup, it shows the
 * signed-in owner's own display name. A member never gets one: setup is
 * the owner's.
 */
export function startingName(me: Pick<MeDto, 'name' | 'displayName' | 'role'> | undefined, setupDone: boolean): string {
  if (!setupDone || me?.role !== 'owner') return '';
  const own = personName(me);
  return own && !displayNameProblem(own) ? tidyDisplayName(own) : '';
}
