/**
 * Subscription sign-in in the web app (CLIProxyAPI on the hub, or one the
 * owner runs): the status hook, words for its states, and which logo each
 * sign-in shows. The hub never sends a key or token here.
 */
import { useEffect, useState } from 'react';
import type { SubscriptionAccountDto, SubscriptionsStatus } from '@conclave/core/client';
import type { LogoId } from '@/components/logo';
import { api } from './api';
import { useHub } from '@/store/store';

/** Company mark per sign-in id. Muse signs in with Meta. */
export const SUB_LOGO: Record<string, LogoId> = {
  claude: 'anthropic',
  codex: 'openai',
  antigravity: 'google',
  xai: 'xai',
  kimi: 'moonshot',
  'kimi-ai': 'moonshot',
  meta: 'llama',
};

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** The status: loaded once, then kept current by subscriptions.updated events. */
export function useSubscriptions(): { status: SubscriptionsStatus | undefined; set: (s: SubscriptionsStatus) => void; error?: string; reload: () => void } {
  const live = useHub((s) => s.subscriptions);
  const [error, setError] = useState<string>();
  const set = (s: SubscriptionsStatus) => useHub.setState({ subscriptions: s });
  const reload = () => {
    setError(undefined);
    api()
      .subscriptions()
      .then(set)
      .catch((e) => setError(errText(e)));
  };
  useEffect(reload, []);
  return { status: live, set, error, reload };
}

export type Tone = 'ok' | 'fault' | 'dim' | 'live' | 'warn';

/** "On." and the rest of the status sentence. */
export function statusSentence(s: SubscriptionsStatus): { word: string; tone: Tone; rest: string } {
  const n = s.accounts.length;
  const accounts = n === 0 ? 'No account is signed in yet.' : n === 1 ? 'One account is signed in.' : `${n} accounts are signed in.`;
  switch (s.state) {
    case 'on':
      return { word: 'On.', tone: 'ok', rest: s.mode === 'builtin' ? `CLIProxyAPI ${s.version ?? ''} runs on the hub. ${accounts}`.replace('  ', ' ') : `The hub uses your CLIProxyAPI at ${s.external?.url ?? ''}. ${accounts}` };
    case 'installing':
      return { word: 'Installing.', tone: 'live', rest: s.detail ?? 'Downloading CLIProxyAPI.' };
    case 'starting':
      return { word: 'Starting.', tone: 'live', rest: s.detail ?? 'Starting CLIProxyAPI.' };
    case 'error':
      return { word: 'Not working.', tone: 'fault', rest: s.error ?? 'CLIProxyAPI does not answer.' };
    default:
      return { word: 'Off.', tone: 'dim', rest: 'Signing in to a subscription runs CLIProxyAPI on the hub.' };
  }
}

export const ACCOUNT_WORD: Record<SubscriptionAccountDto['state'], { word: string; tone: Tone }> = {
  active: { word: 'Active', tone: 'ok' },
  refreshing: { word: 'Refreshing', tone: 'live' },
  disabled: { word: 'Turned off', tone: 'dim' },
  unavailable: { word: 'Limited', tone: 'warn' },
  error: { word: 'Failed', tone: 'fault' },
  unknown: { word: 'Unknown', tone: 'dim' },
};

export const TONE_CLASS: Record<Tone, string> = { ok: 'text-ok', fault: 'text-fault', dim: 'text-fg-3', live: 'text-signal', warn: 'text-warn' };

/** "me@example.com", or the provider's name when the account has no label. */
export function accountLabel(a: SubscriptionAccountDto): string {
  return a.label ?? a.providerName;
}

/**
 * Defaults that work with what was just signed in: when the default (or
 * small) model's provider has no key, the best model from the
 * subscriptions takes its place. Undefined when nothing needs to change.
 */
export function subscriptionDefaults(status: SubscriptionsStatus, config: Record<string, unknown> | undefined, configured: (provider: string) => boolean): { defaultModel?: string; smallModel?: string } | undefined {
  const ids = status.models.flatMap((g) => g.models.map((m) => m.id));
  if (!ids.length) return undefined;
  const pick = (order: string[]) => order.find((id) => ids.includes(id)) ?? ids[0];
  const usable = (ref: unknown) => typeof ref === 'string' && ref.includes('/') && configured(ref.slice(0, ref.indexOf('/')));
  const out: { defaultModel?: string; smallModel?: string } = {};
  if (!usable(config?.defaultModel)) out.defaultModel = `${status.provider}/${pick(['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol', 'gpt-6-astra', 'gemini-4-argon'])}`;
  if (!usable(config?.smallModel)) out.smallModel = `${status.provider}/${pick(['claude-haiku-5-5', 'gpt-6-luna', 'gemini-3.8-flash', 'claude-sonnet-5-5'])}`;
  return Object.keys(out).length ? out : undefined;
}

/** Wait until the status is on (or failed). Resolves with the last status. */
export function untilOn(timeoutMs = 10 * 60_000): Promise<SubscriptionsStatus | undefined> {
  return new Promise((resolve) => {
    const done = (s: SubscriptionsStatus | undefined) => {
      clearTimeout(t);
      off();
      resolve(s);
    };
    const check = (s: SubscriptionsStatus | undefined) => {
      if (s && (s.state === 'on' || (s.state === 'error' && !/Trying again/.test(s.detail ?? '')))) done(s);
    };
    const off = useHub.subscribe((st) => check(st.subscriptions));
    const t = setTimeout(() => done(useHub.getState().subscriptions), timeoutMs);
    check(useHub.getState().subscriptions);
  });
}
