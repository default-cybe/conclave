/**
 * Template upgrades. A template is copied into a routine when the owner adds
 * it, so a better prompt in a new release would never reach routines already
 * installed. Each template lists the hashes of the prompts it shipped before.
 * On hub start a routine made from a template (by its template id, or for
 * older routines by its name) whose prompt is one of those old prompts gets
 * the current prompt, allow and deny rules and precheck. What the owner
 * chose stays: schedule, timezone, model, agent, notify, device, folder and
 * whether it is on. A prompt the owner edited is left alone; upgrade() in
 * routines.ts applies the template anyway when asked.
 */
import { createHash } from 'node:crypto';
import type { Routine } from '../types';
import { ROUTINE_TEMPLATES, type RoutineTemplate } from './templates';

/** sha256 (first 16 hex) of each prompt a template shipped before its current one. */
export const PREVIOUS_PROMPTS: Record<string, string[]> = {
  // before the day plan round (docs/design/ROUND-LIFE-ASSISTANT.md)
  // and before calendars and mail were built in (docs/DESIGN.md, Calendar and mail)
  'morning-brief': ['5a84ab10d4e974c3', '87d91dda9e3d370a'],
  'evening-wrap-up': ['7a30bed7bf5a523d'],
  'weekly-review': ['163b0ff14a187d36'],
  // before notes became facts, not orders (memory/facts.ts)
  'nightly-reflection': ['99a6c6e2af8acdf0'],
};

export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
}

export interface TemplateUpgrade {
  routineId: string;
  name: string;
  template: RoutineTemplate;
  /** current: same prompt. link: same prompt, template id missing. upgrade: an older shipped prompt. edited: the owner changed it. */
  state: 'current' | 'link' | 'upgrade' | 'edited';
}

/**
 * Templates that shipped before routines kept a template id. Only their
 * routines are matched by name alone; a routine made from any newer template
 * has the id, so one with the same name and its own prompt (an owner's own
 * "Heartbeat") is theirs.
 */
export const NAMED_TEMPLATES = new Set(['morning-brief', 'evening-wrap-up', 'nightly-librarian', 'weekly-review', 'server-watchdog', 'uni-deadlines', 'research-digest', 'repo-health']);

/** The template a routine came from: its template id, else a template with the same name that is an older one or has the same prompt. */
export function templateFor(r: Pick<Routine, 'template' | 'name' | 'prompt'>, templates: RoutineTemplate[] = ROUTINE_TEMPLATES): RoutineTemplate | undefined {
  if (r.template) return templates.find((t) => t.id === r.template);
  const name = r.name.trim().toLowerCase();
  return templates.find((t) => t.name.toLowerCase() === name && (NAMED_TEMPLATES.has(t.id) || promptHash(t.prompt) === promptHash(r.prompt ?? '')));
}

export function planUpgrades(routines: Routine[], templates: RoutineTemplate[] = ROUTINE_TEMPLATES): TemplateUpgrade[] {
  const out: TemplateUpgrade[] = [];
  for (const r of routines) {
    // routines from suggestions have their own catalog
    if (r.suggestion) continue;
    const t = templateFor(r, templates);
    if (!t) continue;
    const h = promptHash(r.prompt);
    let state: TemplateUpgrade['state'];
    if (h === promptHash(t.prompt)) state = r.template === t.id ? 'current' : 'link';
    else if ((PREVIOUS_PROMPTS[t.id] ?? []).includes(h)) state = 'upgrade';
    else state = 'edited';
    out.push({ routineId: r.id, name: r.name, template: t, state });
  }
  return out;
}

function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const out = [...new Set([...(a ?? []), ...(b ?? [])])];
  return out.length ? out : undefined;
}

/** The routine with the template's prompt and rules, and the owner's own choices kept. */
export function applyUpgrade(r: Routine, t: RoutineTemplate, now: number): Routine {
  const next: Routine = { ...r, prompt: t.prompt, template: t.id, updatedAt: now };
  const allow = union(r.allow, t.allow);
  const deny = union(r.deny, t.deny);
  if (allow) next.allow = allow;
  if (deny) next.deny = deny;
  if (t.precheck && !r.precheck) next.precheck = t.precheck;
  return next;
}
