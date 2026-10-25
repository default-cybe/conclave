/**
 * The "Make Conclave better" step's logic: which entries the chosen packs
 * install, one form field per value they need, and the install loop. Each
 * entry goes through the same preview and install routes as Discover, one at
 * a time, so secrets land in the hub's secrets store the same way.
 */
import { ApiError, type CatalogInput, type CatalogInstallRequest, type CatalogInstallResult, type CatalogItemDto, type CatalogPreviewRequest, type InstallPreview } from '@conclave/core/client';
import { EXTENSION_PACKS } from '@conclave/core/catalog/packs';

/** Ids of the chosen packs, in pack order, once each. */
export function packIds(chosen: string[]): string[] {
  return [...new Set(EXTENSION_PACKS.filter((p) => chosen.includes(p.id)).flatMap((p) => p.items))];
}

/** Tool preset per id over every pack (Homelab's read-only Proxmox). */
export const PACK_PRESETS: Record<string, string> = Object.assign({}, ...EXTENSION_PACKS.map((p) => p.presets ?? {}));

export interface KeyField extends CatalogInput {
  /** Names of the entries that use it. */
  for: string[];
  /** A secret the hub already holds: the field may stay empty. */
  saved: boolean;
}

const isSaved = (i: CatalogInput, saved: readonly string[]) => !!(i.secret && i.secretKey && saved.includes(i.secretKey));

/** One field per input name over the entries still to install. Required wins when two entries share a name. */
export function keyFields(items: CatalogItemDto[], saved: readonly string[]): KeyField[] {
  const out = new Map<string, KeyField>();
  for (const it of items) {
    if (it.installed) continue;
    for (const inp of it.inputs ?? []) {
      const f = out.get(inp.name);
      if (f) {
        f.for.push(it.name);
        f.required ||= inp.required;
      } else out.set(inp.name, { ...inp, for: [it.name], saved: isSaved(inp, saved) });
    }
  }
  return [...out.values()];
}

export type Row = { state: 'waiting' } | { state: 'installing' } | { state: 'done'; note?: string } | { state: 'skipped'; why: string } | { state: 'failed'; why: string };

const hubBins = (needs: Array<{ bin: string; where: string }>) => needs.filter((n) => n.where === 'hub').map((n) => n.bin);

/** Why an entry is skipped before anything is sent, or undefined to install it. */
export function skipReason(item: CatalogItemDto, values: Record<string, string>, saved: readonly string[]): string | undefined {
  if (item.installed) return 'Already installed';
  const empty = (item.inputs ?? []).filter((i) => i.required && !values[i.name]?.trim() && !isSaved(i, saved));
  if (empty.length) return empty.some((i) => i.secret) ? 'Missing key' : `Missing ${empty[0].label.toLowerCase()}`;
  const bins = hubBins(item.ready?.missing ?? []);
  if (bins.length) return `Needs ${bins.join(' and ')} on the hub`;
  return undefined;
}

export interface InstallDeps {
  preview: (req: CatalogPreviewRequest) => Promise<InstallPreview>;
  install: (req: CatalogInstallRequest) => Promise<CatalogInstallResult>;
}

/** Install the entries one at a time; onRow reports each row as it changes. Never throws. */
export async function installAll(items: CatalogItemDto[], values: Record<string, string>, saved: readonly string[], deps: InstallDeps, onRow: (id: string, row: Row) => void): Promise<void> {
  for (const item of items) {
    const skip = skipReason(item, values, saved);
    if (skip) {
      onRow(item.id, { state: 'skipped', why: skip });
      continue;
    }
    onRow(item.id, { state: 'installing' });
    try {
      const preset = PACK_PRESETS[item.id];
      const plan = await deps.preview({ id: item.id, ...(preset ? { options: { toolPreset: preset } } : {}) });
      const missing = hubBins(plan.needs.filter((n) => n.found === false));
      if (missing.length) {
        onRow(item.id, { state: 'skipped', why: `Needs ${missing.join(' and ')} on the hub` });
        continue;
      }
      const vals: Record<string, string> = {};
      for (const i of plan.inputs) if (values[i.name]?.trim()) vals[i.name] = values[i.name].trim();
      const r = await deps.install({ planId: plan.planId, values: vals });
      if (!r.ok) {
        onRow(item.id, { state: 'failed', why: r.test?.error ?? r.warnings[0] ?? 'The install did not finish.' });
        continue;
      }
      const device = plan.needs.filter((n) => n.where !== 'hub').map((n) => n.bin);
      onRow(item.id, { state: 'done', ...(device.length ? { note: `Needs ${device.join(' and ')} on the device that uses it` } : {}) });
    } catch (e) {
      // 409 that is not a stale plan: the thing it would add is already there
      if (e instanceof ApiError && e.status === 409 && !/expired|moved/i.test(e.message)) onRow(item.id, { state: 'skipped', why: 'Already installed' });
      else onRow(item.id, { state: 'failed', why: e instanceof Error ? e.message : String(e) });
    }
  }
}
