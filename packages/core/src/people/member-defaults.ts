/**
 * A member's own Settings > Defaults (docs/design/ACCOUNTS.md 13): default
 * model, small model, second opinion model, default agent and device, hidden
 * models and memory switches, kept in their account settings (PATCH /api/me),
 * never in the hub's config.json. The owner's are the hub's config.
 *
 * Each model is one the member can call (memberCanUse), the agent one they
 * may start, the device one of their own. At run time the engine reads them
 * for the member's sessions (engine.ts createSession, memorySettings,
 * reviewerFor, hiddenFor).
 */
import type { Engine } from '../engine/engine';
import type { ConclaveConfig } from '../config/schema';
import type { MemberMemory } from '../client/people';
import { isHiddenModel } from '../config/hidden';
import { memberCanUse } from '../session/member-fallbacks';
import { PeopleError, type AccountSettings } from './store';

/** The defaults keys PATCH /api/me takes for a member. */
export const MEMBER_DEFAULT_KEYS = ['defaultModel', 'smallModel', 'reviewer', 'defaultAgent', 'defaultDevice', 'hiddenModels', 'memory'] as const;
type Key = (typeof MEMBER_DEFAULT_KEYS)[number];

const MEMORY_BOOLS = ['enabled', 'autoInject', 'recallEpisodes', 'autoExtract'] as const;
const HIDDEN_MAX = 100;

/** The hub's memory switches with a member's own over them; the owner's are the hub's. */
export function mergedMemory(hub: ConclaveConfig['memory'], own: MemberMemory | undefined): ConclaveConfig['memory'] {
  return own ? { ...hub, ...own } : hub;
}

/** Whether a member hid this model for themselves. */
export function memberHides(settings: Pick<AccountSettings, 'hiddenModels'>, ref: string): boolean {
  return !!settings.hiddenModels?.length && isHiddenModel({ models: { hidden: settings.hiddenModels } } as Pick<ConclaveConfig, 'models'>, ref);
}

const cannotUse = (m: string) => `You can't use ${m} on this hub. Pick a model from your own keys and plans, or one the owner allows you.`;

/**
 * The member's settings after the defaults in `patch`, checked: each model one
 * they can call, the agent one they may start, the device one of theirs.
 * null clears a key; a key left out keeps its value. Throws PeopleError 400.
 */
export function applyMemberDefaults(engine: Engine, accountId: string, settings: AccountSettings, patch: Partial<Record<Key, unknown>>): AccountSettings {
  const out: AccountSettings = { ...settings };
  for (const k of ['defaultModel', 'smallModel', 'reviewer'] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === null || v === '') {
      delete out[k];
      continue;
    }
    if (typeof v !== 'string' || v.length > 200) throw new PeopleError(400, `${k} must be a model.`);
    // a second opinion may come from an agent ("@name"), one the member may start
    const ok = k === 'reviewer' && v.startsWith('@') ? engine.agentsFor(accountId).some((a) => a.name === v.slice(1)) : memberCanUse(engine, accountId, v);
    if (!ok) throw new PeopleError(400, cannotUse(v));
    out[k] = v;
  }
  if (patch.defaultAgent !== undefined) {
    const v = patch.defaultAgent;
    if (v === null || v === '') delete out.defaultAgent;
    else if (typeof v !== 'string' || !engine.agentsFor(accountId).some((a) => a.name === v)) throw new PeopleError(400, `There is no agent ${String(v)} you can start.`);
    else out.defaultAgent = v;
  }
  if (patch.defaultDevice !== undefined) {
    const v = patch.defaultDevice;
    // "local" is the hub, the same as none
    if (v === null || v === '' || v === 'local') delete out.defaultDevice;
    else if (typeof v !== 'string' || engine.repos.devices.accountOf(v) !== accountId) throw new PeopleError(400, 'Pick one of your own computers, or the hub.');
    else out.defaultDevice = v;
  }
  if (patch.hiddenModels !== undefined) {
    const v = patch.hiddenModels ?? [];
    if (!Array.isArray(v) || v.length > HIDDEN_MAX || v.some((x) => typeof x !== 'string' || x.length > 200)) throw new PeopleError(400, `hiddenModels is at most ${HIDDEN_MAX} model refs or patterns.`);
    const list = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
    if (list.length) out.hiddenModels = list;
    else delete out.hiddenModels;
  }
  if (patch.memory !== undefined) {
    const m = patch.memory;
    if (m === null) delete out.memory;
    else {
      if (typeof m !== 'object' || Array.isArray(m)) throw new PeopleError(400, 'memory is { enabled, autoInject, injectLimit, recallEpisodes, autoExtract }.');
      const next: MemberMemory = { ...out.memory };
      for (const [k, x] of Object.entries(m as Record<string, unknown>)) {
        if (k === 'injectLimit') {
          if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 50) throw new PeopleError(400, 'memory.injectLimit is a whole number from 1 to 50.');
          next.injectLimit = x;
        } else if ((MEMORY_BOOLS as readonly string[]).includes(k)) {
          if (typeof x !== 'boolean') throw new PeopleError(400, `memory.${k} must be true or false.`);
          next[k as (typeof MEMORY_BOOLS)[number]] = x;
        } else throw new PeopleError(400, `memory.${k} is not one of yours to set.`);
      }
      out.memory = next;
    }
  }
  return out;
}
