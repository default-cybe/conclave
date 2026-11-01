/**
 * "Install on the hub" in Discover: whether a card, a setup step or the
 * Needs block gets the button, and the words around it. The hub works out
 * what would run (core catalog/hub-setup.ts) and sends it as an offer; this
 * only reads the offer.
 */
import type { CatalogItemDto, CatalogSetupRequest, CatalogSetupResult, HubByHand, HubSetupOffer, InstallPreview } from '@conclave/core/client';
import { listWords } from './words';

export const INSTALL_LABEL = 'Install on the hub';

/** What a card, step or Needs block shows. */
export type HubFix =
  /** The button: the confirm lists the commands, then runs them. */
  | { kind: 'run'; offer: HubSetupOffer; label: string }
  /** No button: one line saying why, and the command to copy when there is one. */
  | { kind: 'manual'; line: string; command?: string }
  /** A hub step whose programs are all there. */
  | { kind: 'done'; line: string };

const runnable = (o: HubSetupOffer): boolean => o.commands.length > 0 && !o.refusal;

/** The first command to copy for what the hub leaves to the owner. */
function firstManual(byHand: HubByHand[]): string | undefined {
  return byHand.find((h) => h.root && h.run)?.run ?? byHand.find((h) => h.run)?.run;
}

/** The card: the button when the hub can install what is missing, else why not with the command to copy. Nothing once added. */
export function cardFix(item: Pick<CatalogItemDto, 'installed' | 'ready'>): HubFix | null {
  if (item.installed) return null;
  const offer = item.ready?.hubSetup;
  if (!offer || !(item.ready.missing ?? []).some((n) => n.where === 'hub')) return null;
  if (runnable(offer)) return { kind: 'run', offer, label: INSTALL_LABEL };
  return { kind: 'manual', line: offer.why ?? 'Install it on the hub by hand.', command: firstManual(offer.byHand) };
}

/** A setup step in the preview. Device steps keep their copy and say where to run them. */
export function stepFix(step: InstallPreview['steps'][number], hubName: string, deviceName = 'the device'): HubFix | null {
  if (!step.run) return null;
  if (step.on === 'device') return { kind: 'manual', line: `This runs on ${deviceName}, not on ${hubName}. Run it there.` };
  const offer = step.hub;
  if (!offer) return null;
  if (runnable(offer)) {
    if (offer.done) return { kind: 'done', line: `Done: ${listWords(offer.checks)} ${offer.checks.length > 1 ? 'are' : 'is'} on ${hubName}.` };
    return { kind: 'run', offer, label: INSTALL_LABEL };
  }
  // the step's own command is already on screen with its copy button
  const command = firstManual(offer.byHand);
  return { kind: 'manual', line: offer.why ?? 'Run it by hand.', ...(command && command !== step.run ? { command } : {}) };
}

/** The body for POST /api/catalog/items/:id/setup: the target and the exact commands the owner saw. */
export function setupRequest(offer: HubSetupOffer): CatalogSetupRequest {
  const t = offer.target;
  const commands = offer.commands.map((c) => c.run);
  if ('step' in t) return { step: t.step, variant: t.variant, commands };
  if ('bin' in t) return { bin: t.bin, commands };
  return { commands };
}

/** The line above the commands in the confirm. */
export function confirmWords(offer: HubSetupOffer, hubName: string): string {
  const n = offer.commands.length;
  return `${n === 1 ? 'This runs' : `These ${n} run`} on ${hubName} as ${offer.user}, in ${offer.home}${n > 1 ? ', one after another, and stop at the first that fails' : ''}. Nothing runs with sudo.`;
}

/** The result line after a run. */
export function resultWords(r: CatalogSetupResult, hubName: string): { ok: boolean; text: string } {
  if (!r.ok) {
    const last = r.ran[r.ran.length - 1];
    const what = r.ran.length > 1 && last ? ` at ${last.split(/\s+/).slice(0, 3).join(' ')}` : '';
    return { ok: false, text: r.timedOut ? `Stopped after 10 minutes${what}.` : `Failed${what} with exit code ${r.exitCode ?? 'none'}.` };
  }
  const still = (r.ready.missing ?? []).filter((n) => n.where === 'hub').map((n) => n.bin);
  if (still.length) return { ok: false, text: `It ran, but ${listWords(still)} ${still.length > 1 ? 'are' : 'is'} still missing on ${hubName}.${r.note ? ` ${r.note}` : ''}` };
  return { ok: true, text: `Installed. Ready to add.${r.note ? ` ${r.note}` : ''}` };
}
