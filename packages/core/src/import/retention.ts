/**
 * Vendor history cleanup (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.11).
 *
 * Claude Code deletes transcripts older than cleanupPeriodDays (default 30)
 * at startup, and Gemini CLI's general.sessionRetention is on with maxAge
 * 30d. Without a change, "import all my old chats" finds about one month.
 * The fix writes 3650 days and keeps every other key. 0 is never written: it
 * misbehaved in some Claude Code versions.
 */
import type { ImportRetention } from '../client/import';
import type { Machine } from '../machine/types';
import { claudeRootOn, geminiRootOn, joinPath } from '../importers/files';

export const KEEP_DAYS = 3650;

function days(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*([dhwmy]?)\s*$/i.exec(v);
    if (!m) return undefined;
    const n = Number(m[1]);
    const unit = (m[2] || 'd').toLowerCase();
    return unit === 'h' ? n / 24 : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : unit === 'y' ? n * 365 : n;
  }
  return undefined;
}

async function readJson(machine: Machine, path: string): Promise<{ exists: boolean; value?: Record<string, any>; error?: string }> {
  const st = await machine.stat(path).catch(() => null);
  if (!st) return { exists: false };
  try {
    const v = JSON.parse(await machine.readText(path));
    // a file that holds a list or a plain value is not a settings object: never rewrite it
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { exists: true, error: 'it does not hold a JSON object' };
    return { exists: true, value: v };
  } catch (err) {
    return { exists: true, error: (err as Error).message };
  }
}

/** Retention settings for Claude Code and Gemini CLI on a machine. A tool that is not installed is left out. */
export async function readRetention(machine: Machine, device: string): Promise<ImportRetention[]> {
  const out: ImportRetention[] = [];
  const claude = claudeRootOn(machine);
  if (await machine.stat(claude).catch(() => null)) {
    const file = joinPath(claude, 'settings.json');
    const s = await readJson(machine, file);
    const v = s.value?.cleanupPeriodDays;
    const d = days(v);
    const risk: ImportRetention['risk'] = s.error ? 'low' : d === undefined || d <= 30 ? 'high' : d < 365 ? 'low' : 'none';
    out.push({
      device,
      tool: 'claude-code',
      file,
      setting: 'cleanupPeriodDays',
      ...(v !== undefined ? { value: v } : {}),
      risk,
      text: s.error
        ? `Claude Code's settings.json could not be read (${s.error}), so the cleanup setting is unknown.`
        : d === undefined
          ? 'Claude Code deletes chats older than 30 days when it starts. Keep them for 10 years so they can be imported.'
          : d <= 30
            ? `Claude Code deletes chats older than ${d} days when it starts. Keep them for 10 years so they can be imported.`
            : d < 365
              ? `Claude Code keeps chats for ${d} days.`
              : `Claude Code keeps chats for ${Math.round(d / 365)} years.`,
      fixable: !s.error && risk !== 'none',
    });
  }
  const gemini = geminiRootOn(machine);
  if (await machine.stat(gemini).catch(() => null)) {
    const file = joinPath(gemini, 'settings.json');
    const s = await readJson(machine, file);
    const r = s.value?.general?.sessionRetention;
    const enabled = r === undefined ? true : r?.enabled !== false;
    const d = days(r?.maxAge) ?? 30;
    const risk: ImportRetention['risk'] = s.error ? 'low' : !enabled ? 'none' : d <= 30 ? 'high' : d < 365 ? 'low' : 'none';
    out.push({
      device,
      tool: 'gemini',
      file,
      setting: 'general.sessionRetention',
      ...(r !== undefined ? { value: r } : {}),
      risk,
      text: s.error
        ? `Gemini CLI's settings.json could not be read (${s.error}), so the retention setting is unknown.`
        : !enabled
          ? 'Gemini CLI keeps every chat.'
          : d <= 30
            ? `Gemini CLI deletes chats older than ${d} days. Keep them for 10 years so they can be imported.`
            : `Gemini CLI keeps chats for ${d < 365 ? `${d} days` : `${Math.round(d / 365)} years`}.`,
      fixable: !s.error && risk !== 'none',
    });
  }
  return out;
}

/** Write the 10 year setting into the tool's settings.json, keeping every other key. */
export async function fixRetention(machine: Machine, tool: ImportRetention['tool']): Promise<{ file: string; before: unknown; after: unknown }> {
  if (tool === 'claude-code') {
    const file = joinPath(claudeRootOn(machine), 'settings.json');
    const s = await readJson(machine, file);
    if (s.error) throw new Error(`Claude Code's settings.json is not valid JSON (${s.error}). Fix it by hand first.`);
    const value = s.value ?? {};
    const before = value.cleanupPeriodDays;
    value.cleanupPeriodDays = KEEP_DAYS;
    await machine.writeFile(file, JSON.stringify(value, null, 2) + '\n');
    return { file, before, after: KEEP_DAYS };
  }
  const file = joinPath(geminiRootOn(machine), 'settings.json');
  const s = await readJson(machine, file);
  if (s.error) throw new Error(`Gemini CLI's settings.json is not valid JSON (${s.error}). Fix it by hand first.`);
  const value = s.value ?? {};
  if (value.general !== undefined && (!value.general || typeof value.general !== 'object' || Array.isArray(value.general))) throw new Error("Gemini CLI's settings.json has a general entry that is not an object. Fix it by hand first.");
  const general = value.general ?? (value.general = {});
  const before = general.sessionRetention;
  general.sessionRetention = { ...(before && typeof before === 'object' ? before : {}), enabled: true, maxAge: `${KEEP_DAYS}d` };
  await machine.writeFile(file, JSON.stringify(value, null, 2) + '\n');
  return { file, before, after: general.sessionRetention };
}
