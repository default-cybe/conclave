/**
 * Switching a session's model (docs/DESIGN.md 44). The default keeps the
 * full history, as it always did. In a chat over the hub's switch size the
 * picker first shows what the switch costs (GET switch-estimate) and offers
 * a short handover next to it; the owner's pick of Short handover is
 * remembered on this device, and picking Full history again forgets it.
 */
import type { Session } from '@conclave/core/types';
import type { SwitchEstimate, SwitchMath } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, upsertSession } from '@/store/store';
import { modelName } from '@/lib/models';

/** Set to "1" once the owner switched with a short handover on this device. */
export const BRIEF_KEY = 'conclave.switch.brief';

export function rememberedBrief(): boolean {
  try {
    return localStorage.getItem(BRIEF_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember Short handover; Full history (the default) forgets it. */
export function rememberBrief(on: boolean): void {
  try {
    if (on) localStorage.setItem(BRIEF_KEY, '1');
    else localStorage.removeItem(BRIEF_KEY);
  } catch {
    /* private mode: the default stays */
  }
}

/** "$0.40", or "under a cent". Halves round up ($0.145 reads $0.15). */
export function usdWords(n: number): string {
  if (n < 0.005) return 'under a cent';
  return `$${(Math.round(n * 100 + 1e-9) / 100).toFixed(2)}`;
}

/** "About $0.40 once, pays back after about 9 replies". */
export function priceLine(m: SwitchMath): string {
  const once = `About ${usdWords(m.onceUsd)} once`;
  if (m.paybackReplies === 0) return `${once}, cheaper than staying from the first reply`;
  if (m.paybackReplies === undefined) return `${once}, and each reply costs more than staying`;
  return `${once}, pays back after about ${m.paybackReplies} ${m.paybackReplies === 1 ? 'reply' : 'replies'}`;
}

/** What a short handover saves on the switch itself, in dollars. */
export function briefSaving(e: SwitchEstimate): number {
  return e.brief ? Math.max(0, e.full.onceUsd - e.brief.onceUsd) : 0;
}

/** The hub's estimate, or undefined (an older hub, a harness): the switch then goes ahead as before. */
export async function switchEstimate(session: Session, model: string): Promise<SwitchEstimate | undefined> {
  try {
    return await api().switchEstimate(session.id, model);
  } catch {
    return undefined;
  }
}

export async function switchSession(session: Session, model: string, brief = false): Promise<Session | undefined> {
  const s = await attempt(() => api().handoff(session.id, model, brief ? { brief: true } : {}), brief ? `Switched to ${modelName(model)} with a short handover.` : `Switched to ${modelName(model)}.`);
  if (s) upsertSession(s);
  return s;
}
