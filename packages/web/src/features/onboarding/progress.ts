/**
 * Setup progress lives in the hub config so every client agrees and a reload
 * resumes: ui.onboardingSteps (finished steps) and setup.progress (the step
 * to resume at, skipped steps, and a few answers such as CLI logins used).
 */
import { useMemo } from 'react';
import type { Device } from '@conclave/core/types';
import { toast, updateConfig, useHub, type HubConfig } from '@/store/store';
import { HARNESS_LOGINS, PROVIDERS } from '@/lib/providers';
import { deviceName, desktopNotifyOn, useNotifyDevices } from '@/lib/notify';
import { isStepId, type StepId } from './steps';

export interface SetupProgress {
  step?: StepId;
  skipped?: StepId[];
  /** CLI logins the owner chose to use (claude-code, codex ...). */
  logins?: string[];
  updatedAt?: number;
}

export function readProgress(config: HubConfig | undefined): SetupProgress {
  const p = (config?.setup?.progress ?? {}) as Record<string, unknown>;
  return {
    step: isStepId(p.step as string) ? (p.step as StepId) : undefined,
    skipped: Array.isArray(p.skipped) ? (p.skipped as StepId[]) : [],
    logins: Array.isArray(p.logins) ? (p.logins as string[]) : [],
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : undefined,
  };
}

export function useProgress(): SetupProgress & { done: StepId[]; completed: boolean } {
  const config = useHub((s) => s.config);
  return useMemo(() => ({ ...readProgress(config), done: (config?.ui?.onboardingSteps ?? []).filter(isStepId), completed: !!config?.setup?.completedAt }), [config]);
}

/** Save that a step was finished or skipped, and where to resume. Never blocks the flow. */
export async function recordStep(id: StepId, how: 'done' | 'skipped', resumeAt: StepId) {
  const config = useHub.getState().config;
  const done = new Set((config?.ui?.onboardingSteps ?? []).filter(isStepId));
  const skipped = new Set(readProgress(config).skipped);
  if (how === 'done') {
    done.add(id);
    skipped.delete(id);
  } else if (!done.has(id)) skipped.add(id);
  try {
    await updateConfig({ ui: { onboardingSteps: [...done] }, setup: { progress: { step: resumeAt, skipped: [...skipped], updatedAt: Date.now() } } });
  } catch (e) {
    toast({ title: `Could not save setup progress. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
  }
}

export async function saveProgressAnswer(patch: Partial<SetupProgress>) {
  try {
    await updateConfig({ setup: { progress: patch } });
  } catch {
    /* progress answers are a convenience; the step still works */
  }
}

// ---------------------------------------------------------------------------
// Facts: what is set up, from live hub state. The rail and Done read these.
// ---------------------------------------------------------------------------

export const HARNESS_CLI: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini', opencode: 'opencode' };
export const HARNESS_ORDER = ['claude-code', 'codex', 'gemini-cli', 'opencode'] as const;

/** Harnesses installed on a device, in the spec order, with versions. */
export function harnessesOn(d: Device): Array<{ id: string; version: string }> {
  const clis = d.info?.clis ?? {};
  return HARNESS_ORDER.filter((h) => clis[HARNESS_CLI[h]]).map((h) => ({ id: h, version: clis[HARNESS_CLI[h]] }));
}

export interface SetupFacts {
  hubName?: string;
  /** Subscription accounts signed in through CLIProxyAPI. */
  subscriptions: number;
  /** Provider ids with a working key, or a local provider that was found. */
  providers: string[];
  /** Keys that the provider rejected. */
  rejected: string[];
  logins: string[];
  /** Harness ids found on any device, and where. */
  harnesses: Array<{ id: string; devices: string[] }>;
  defaultModel?: string;
  smallModel?: string;
  defaultAgent?: string;
  memoryOn: boolean;
  learning: boolean;
  vault?: { url?: string; project?: string };
  imported: number;
  /** The hub's computers: the ones that run the device agent. Phones and browsers are apps, not devices (lib/apps.ts). */
  devices: Device[];
  /** Devices that get notifications: the browsers the hub pushes to, and this desktop app. */
  channels: string[];
  routines: number;
  routineNames: string[];
}

interface MemoryCfg {
  enabled?: boolean;
  autoExtract?: boolean;
  connections?: Array<{ id: string; type: string; options?: Record<string, unknown> }>;
}
export function vaultOf(config: HubConfig | undefined): { url?: string; project?: string } | undefined {
  const mem = (config?.memory ?? {}) as MemoryCfg;
  const c = mem.connections?.find((x) => x.type === 'basic-memory');
  if (!c) return undefined;
  return { url: c.options?.url as string | undefined, project: c.options?.project as string | undefined };
}

export function useSetupFacts(): SetupFacts {
  const config = useHub((x) => x.config);
  const models = useHub((x) => x.models);
  const secrets = useHub((x) => x.secrets);
  const deviceMap = useHub((x) => x.devices);
  const sessions = useHub((x) => x.sessions);
  const routineMap = useHub((x) => x.routines);
  const hub = useHub((x) => x.hub);
  const subs = useHub((x) => x.subscriptions);
  const notifyDevices = useNotifyDevices().list;
  return useMemo(() => {
    const progress = readProgress(config);
    const groups = new Map(models.map((g) => [g.provider, g]));
    const keys = new Set(secrets?.providers ?? []);
    const providers: string[] = [];
    const rejected: string[] = [];
    const cfgProviders = (config?.providers ?? {}) as Record<string, { enabled?: boolean }>;
    for (const p of PROVIDERS) {
      const g = groups.get(p.id);
      if (p.signIn === 'none') {
        if (cfgProviders[p.id]?.enabled === true) providers.push(p.id);
        continue;
      }
      if (!keys.has(p.id)) continue;
      if (g?.error || g?.enabled === false) rejected.push(p.id);
      else providers.push(p.id);
    }
    const devices = Object.values(deviceMap);
    const harnesses = HARNESS_ORDER.map((h) => ({ id: h as string, devices: devices.filter((d) => d.info?.clis?.[HARNESS_CLI[h]]).map((d) => d.name) })).filter((h) => h.devices.length);
    const mem = (config?.memory ?? {}) as MemoryCfg;
    const channels = notifyDevices.map((d) => d.name || 'A browser');
    if (desktopNotifyOn()) channels.unshift(deviceName());
    const routines = Object.values(routineMap);
    return {
      hubName: hub?.name,
      subscriptions: subs?.accounts.length ?? 0,
      providers,
      rejected,
      logins: progress.logins ?? [],
      harnesses,
      defaultModel: config?.defaultModel as string | undefined,
      smallModel: config?.smallModel as string | undefined,
      defaultAgent: config?.defaultAgent as string | undefined,
      memoryOn: mem.enabled !== false,
      learning: mem.autoExtract !== false,
      vault: vaultOf(config),
      imported: Object.values(sessions).filter((x) => x.tags?.includes('imported')).length,
      devices,
      channels,
      routines: routines.length,
      routineNames: routines.map((r) => r.name),
    };
  }, [config, models, secrets, deviceMap, sessions, routineMap, hub, subs, notifyDevices]);
}

/** Login plan names for a list of harness ids ("Claude Max", "ChatGPT Pro"). */
export function loginPlans(ids: string[]): string[] {
  return ids.map((id) => HARNESS_LOGINS.find((l) => l.id === id)?.plan ?? id);
}
