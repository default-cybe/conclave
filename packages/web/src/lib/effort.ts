/**
 * The Effort control's words and menus, on the levels the hub's model list
 * gives each model (ModelInfo.effort, from @conclave/core/providers/effort):
 * the chat composer, Home's session start, the /model sheet. A stored level
 * the model lacks shows (and is sent) as the nearest one it has.
 */
import { clampEffort, effortChoices, effortLabel, isEffortSetting, type EffortSetting, type ModelEffort } from '@conclave/core/providers/effort';
import type { SelectOption } from '@/components/ui/Select';
import { useHub } from '@/store/store';

export type { EffortSetting, ModelEffort };
export { clampEffort, effortLabel, isEffortSetting };

/** What the models list says a model offers, or undefined when it has no Effort control. */
export function effortOf(models: Array<{ models: Array<{ ref: string; effort?: ModelEffort }> }>, ref: string | undefined): ModelEffort | undefined {
  if (!ref) return undefined;
  for (const g of models) for (const m of g.models) if (m.ref === ref) return m.effort?.levels.length || m.effort?.off ? m.effort : undefined;
  return undefined;
}

export function useModelEffort(ref: string | undefined): ModelEffort | undefined {
  return useHub((s) => effortOf(s.models, ref));
}

/** The setting the menu shows: the stored one as the model takes it, else the model's default. */
export function shownEffort(stored: EffortSetting | undefined, e: ModelEffort): EffortSetting | undefined {
  return clampEffort(stored, e) ?? (e.default && (e.default === 'off' ? e.off : e.levels.includes(e.default)) ? e.default : undefined);
}

/**
 * The menu's rows, lowest first: Off where the model can stop thinking, then
 * its levels, the default one marked. `follow` adds a first row for "no
 * setting" (the agent's level), named by it.
 */
export function effortMenu<F extends string = never>(e: ModelEffort, follow?: { value: F; label: string; detail?: string }): Array<SelectOption<EffortSetting | F>> {
  const rows: Array<SelectOption<EffortSetting | F>> = follow ? [{ value: follow.value, label: follow.label, text: follow.label, ...(follow.detail ? { detail: follow.detail } : {}) }] : [];
  for (const s of effortChoices(e)) {
    const label = effortLabel(s, e);
    rows.push({ value: s, label, text: label, ...(s === e.default ? { hint: 'default' } : {}) });
  }
  return rows;
}

/** The stored setting for the next model: kept when it has it, else the nearest; nothing when it has no Effort. */
export function effortForModel(stored: EffortSetting | undefined, next: ModelEffort | undefined): EffortSetting | undefined {
  return clampEffort(stored, next);
}
