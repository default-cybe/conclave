/**
 * Suggested routines (docs/design/ECOSYSTEM.md 5.2): the hub's list, kept in
 * one small store so the Routines list, its empty state, onboarding and the
 * Add sheet share it, plus the words the rows use.
 */
import { create } from 'zustand';
import type { Device, Routine } from '@conclave/core/types';
import type { AddSuggestionRequest, AddSuggestionResult, RoutineSuggestionDto, RoutineSuggestionsDto } from '@conclave/core/client';
import type { DeviceRole, SuggestionCategory } from '@conclave/core/scheduler/suggestions';
import { eachDefaults, offeredDevices, roleDevice } from '@conclave/core/scheduler/suggest';
import { api } from '@/lib/api';
import { describeSchedule } from '@/lib/schedule';
import { memberNow, upsertRoutine, useHub } from '@/store/store';

export type Suggestion = RoutineSuggestionDto;

interface SuggestState {
  data?: RoutineSuggestionsDto;
  /** When data arrived, so a page that opens later reads needs and agents again. */
  loadedAt?: number;
  error?: string;
  loading: boolean;
}

/** Older than this and the list loads again in the background when a page shows it. */
const FRESH_MS = 30_000;

export const useSuggestStore = create<SuggestState>(() => ({ loading: false }));

let inflight: Promise<void> | undefined;

/**
 * Load the list; force reloads it (after an Add). A list older than 30 s
 * loads again too, while the old one stays on screen, so a server added in
 * Discover or an agent made elsewhere shows up without a reload.
 */
export function loadSuggestions(force = false): Promise<void> {
  const s = useSuggestStore.getState();
  if (inflight) return inflight;
  // suggestions install agents and MCP servers on the hub: the owner's (docs/design/ACCOUNTS.md)
  if (memberNow()) return Promise.resolve();
  if (!force && s.data && Date.now() - (s.loadedAt ?? 0) < FRESH_MS) return Promise.resolve();
  useSuggestStore.setState({ loading: true });
  inflight = api()
    .routineSuggestions()
    .then((data) => useSuggestStore.setState({ data, loadedAt: Date.now(), error: undefined, loading: false }))
    .catch((e: unknown) => useSuggestStore.setState({ error: e instanceof Error ? e.message : String(e), loading: false }))
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Add a suggestion, then refresh routines, agents and the list. */
export async function addSuggestion(id: string, req: AddSuggestionRequest): Promise<AddSuggestionResult> {
  const res = await api().addRoutineSuggestion(id, req);
  for (const r of res.routines) upsertRoutine(r);
  if (res.agentCreated) {
    try {
      useHub.setState({ agents: await api().agents() });
    } catch {
      // the agents list catches up on the next load
    }
  }
  await loadSuggestions(true);
  return res;
}

const CATEGORY_ORDER: SuggestionCategory[] = ['memory', 'homelab', 'security', 'dev', 'uni', 'meta'];
export const CATEGORY_WORD: Record<SuggestionCategory, string> = { memory: 'Memory', homelab: 'Homelab', security: 'Security', dev: 'Dev', uni: 'Uni', meta: 'Upkeep' };

/** Recommended first, then grouped by category in a fixed order. */
export function grouped(list: Suggestion[]): Array<{ category: SuggestionCategory; items: Suggestion[] }> {
  return CATEGORY_ORDER.map((category) => ({ category, items: list.filter((s) => s.category === category) })).filter((g) => g.items.length);
}

/** "Sundays at 04:10"; a webhook-only routine says so. */
export function whenWords(schedule: string): string {
  if (/^@once 2099/.test(schedule.trim())) return 'When its webhook is called';
  return describeSchedule(schedule);
}

/** The device a suggestion lands on by default, from its role, among the ones it may run on (hubRepos from the hub's list). */
export function defaultDevices(s: Pick<Suggestion, 'deviceRole' | 'eachOf' | 'hubNeedsRepos'>, devices: Device[], hubRepos?: boolean): string[] {
  const offered = offeredDevices(s, devices, hubRepos);
  if (s.deviceRole === 'each') return eachDefaults(s, offered).map((d) => d.id);
  const d = roleDevice(s.deviceRole, offered);
  return d ? [d.id] : [];
}

/**
 * Routines made from a suggestion, from the live routine list: a routine
 * deleted a moment ago is gone here at once, unlike the hub's added list,
 * which is only as new as the last load.
 */
export function addedRoutines(s: Pick<Suggestion, 'id'>, routines: Record<string, Routine>): Routine[] {
  return Object.values(routines).filter((r) => r.suggestion === s.id);
}

const ROLE_SHORT: Record<DeviceRole, string> = { hub: 'the hub', proxmox: 'the Proxmox host', workstation: 'your workstation', laptop: 'your laptop', each: 'each machine' };

/** "on arch-desktop", "on pve and arch-desktop", "on each machine" for the row's meta line. */
export function whereWords(s: Pick<Suggestion, 'deviceRole' | 'eachOf' | 'hubNeedsRepos'>, devices: Device[], hubRepos?: boolean): string {
  devices = offeredDevices(s, devices, hubRepos);
  if (s.deviceRole === 'each') {
    const names = s.eachOf?.length ? eachDefaults(s, devices).map((d) => d.name) : [];
    if (!names.length) return 'on each machine';
    return `on ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`;
  }
  const d = roleDevice(s.deviceRole, devices);
  return d ? `on ${d.name}` : `on ${ROLE_SHORT[s.deviceRole]}`;
}

/** The description without its leading schedule ("Sundays 04:10 on the workstation: reads ..." -> "Reads ..."). */
export function whatWords(description: string): string {
  const rest = description.replace(/^[^:]{0,80}?\d{1,2}:\d{2}[^:]{0,60}:\s*/, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Needs that are not met yet, in words. Optional ones are left out of the row. */
export function missingWords(s: Suggestion): Array<{ label: string; catalog?: string }> {
  return s.missing.filter((n) => !n.optional).map((n) => ({ label: shortNeed(n.label), catalog: n.catalog }));
}

/** "Basic Memory MCP server (0.24 or newer)" -> "Basic Memory". */
export function shortNeed(label: string): string {
  return label
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+MCP server\b/i, '')
    .replace(/,.*$/, '')
    .trim();
}

/** Discover's page for a catalog item. */
export const discoverHref = (catalog: string) => `/extensions/discover?item=${encodeURIComponent(catalog)}`;
