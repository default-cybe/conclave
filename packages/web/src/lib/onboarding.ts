/**
 * First-run setup state. The hub config carries it so every client agrees:
 * ui.onboarded (core schema) and setup.completedAt / setup.progress (spec 11.11).
 * Either marker counts as done.
 */
import { updateConfig, useHub, type HubConfig } from '@/store/store';

/** Routes that render the onboarding flow (outside the shell). */
export const SETUP_PATHS = ['/welcome', '/setup'];
export const SETUP_ROUTE = '/welcome';

export function isSetupPath(path: string): boolean {
  return SETUP_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

export function isOnboarded(config: HubConfig | undefined): boolean | undefined {
  if (!config) return undefined;
  return config.ui?.onboarded === true || !!config.setup?.completedAt;
}

/** True, false, or undefined while the config is still loading. */
export function useOnboarded(): boolean | undefined {
  return useHub((s) => isOnboarded(s.config));
}

/** The Done step: write both markers. */
export async function finishOnboarding() {
  await updateConfig({ ui: { onboarded: true }, setup: { completedAt: Date.now() } });
}

/** "Skip setup": the owner can always leave; the app stops redirecting. */
export async function skipOnboarding() {
  await updateConfig({ ui: { onboarded: true } });
}

/** "Run setup again" from Settings or the command palette. */
export const RUN_SETUP_AGAIN = '/setup?again=1';
