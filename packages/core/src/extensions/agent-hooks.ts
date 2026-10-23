/**
 * Hooks that belong to an agent profile (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 4.2 item 3 and 4.6): the profile's own `hooks:` frontmatter, in Claude
 * Code's shape, plus `recipes:`, ids from the recipe library that become hook
 * groups. They apply only to sessions running that agent, so a tester gets
 * its write scope without turning it on for every session.
 *
 * - For a subagent, its Stop hooks run on SubagentStop (as in Claude Code).
 *   SubagentStart and SubagentStop fire with the parent session, so the
 *   child's profile is looked up by agent_type.
 * - A recipe entry is "id" or "id NAME=value ...": the tunables of that recipe.
 *   "verify-gate" and "regression-gate" are not hooks: they turn on the
 *   built-in gates on the session's device (session/verify-gate.ts,
 *   session/regression-gate.ts).
 * - Recipe scripts are written to <hooks>/recipes/<id>.sh when missing or
 *   different from the shipped text, the same path an install uses. A recipe
 *   whose programs (jq, bash) are not on the hub is skipped with one warning,
 *   except a recipe that narrows what the agent may do (write-scope): when it
 *   cannot be set up (a program missing, a bad tunable) the tools it guards
 *   are refused with the reason, so a tester never writes source because jq
 *   is missing.
 * - Hooks and recipes from a project folder's agent run only once that folder
 *   is trusted, like the folder's own settings hooks. A plugin agent's hooks
 *   follow the plugin's hooks switch.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { HookEvent, HookMatcher, HooksConfig } from '../config/schema';
import type { AgentDef, RuntimeHookCommand } from './types';
import { recipeById, recipeHooks } from './recipes';
import { GATE_RECIPES, REGRESSION_GATE_RECIPE, VERIFY_GATE_RECIPE, type HookRecipe } from './hook-recipes';
import { logger } from '../util/log';

const log = logger('agent-hooks');

/** The recipe id that turns on the verify gate instead of a hook. */
export const VERIFY_GATE = VERIFY_GATE_RECIPE;
/** The recipe id that turns on the regression gate instead of a hook. */
export const REGRESSION_GATE = REGRESSION_GATE_RECIPE;

export interface RecipeRef {
  id: string;
  env: Record<string, string>;
}

/** "write-scope WRITE_GLOB=docs/**,*.md" -> { id, env }. */
export function parseRecipeRef(entry: string): RecipeRef {
  const parts = entry.trim().split(/\s+/);
  const env: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) env[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return { id: parts[0] ?? '', env };
}

/** Whether an agent turns on the verify gate. */
export function wantsVerifyGate(def: AgentDef | undefined): boolean {
  if (!def) return false;
  return !!def.verifyCommand || (def.recipes ?? []).some((r) => parseRecipeRef(r).id === VERIFY_GATE);
}

/** Whether an agent turns on the regression gate. */
export function wantsRegressionGate(def: AgentDef | undefined): boolean {
  return !!def && (def.recipes ?? []).some((r) => parseRecipeRef(r).id === REGRESSION_GATE);
}

const written = new Map<string, string>();
const programs = new Map<string, boolean>();
const warned = new Set<string>();

function hasProgram(bin: string): boolean {
  let hit = programs.get(bin);
  if (hit === undefined) programs.set(bin, (hit = !!Bun.which(bin)));
  return hit;
}

function warnOnce(text: string): void {
  if (warned.has(text)) return;
  warned.add(text);
  log.warn(text);
}

/** Path of a recipe's script, written when it is missing or out of date. */
export function ensureRecipeScript(hooksDir: string, id: string, script: string): string {
  const path = join(hooksDir, 'recipes', `${id}.sh`);
  if (written.get(path) === script && existsSync(path)) return path;
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== script) {
    mkdirSync(join(hooksDir, 'recipes'), { recursive: true });
    writeFileSync(path, script, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  written.set(path, script);
  return path;
}

/** Recipes that narrow what an agent may do. One that cannot be set up refuses its tools instead of letting them through. */
const FAIL_CLOSED = new Set(['write-scope']);

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Groups that refuse every call a fail-closed recipe guards, with the reason. Needs only sh. */
function refusingGroups(recipe: HookRecipe, why: string): HooksConfig {
  const text = `Refused: the ${recipe.title.toLowerCase()} for this agent could not be set up (${why}), so these writes are blocked until it can. Say so in your report.`;
  const out: HooksConfig = {};
  for (const h of recipe.handlers) {
    if (h.type === 'prompt') continue;
    (out[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: `printf '%s\\n' ${shq(text)} >&2; exit 2`, shell: 'sh', timeout: 5, recipe: recipe.id } as HookMatcher['hooks'][number]] });
  }
  return out;
}

/**
 * Hook groups for a profile's recipes. Unknown ids are logged and skipped;
 * a recipe that cannot be set up is skipped too, unless it is fail-closed
 * (write-scope), which then refuses the tools it guards. `has` checks a
 * program on the hub (tests pass their own).
 */
export function recipeGroups(def: AgentDef, hooksDir: string, has: (bin: string) => boolean = hasProgram): HooksConfig {
  let out: HooksConfig = {};
  for (const entry of def.recipes ?? []) {
    const ref = parseRecipeRef(entry);
    if (!ref.id || GATE_RECIPES.has(ref.id)) continue;
    const recipe = recipeById(ref.id);
    if (!recipe) {
      warnOnce(`agent ${def.name}: there is no hook recipe called ${ref.id}`);
      continue;
    }
    if (!recipe.targets.includes('conclave')) continue;
    const closed = FAIL_CLOSED.has(recipe.id);
    // a recipe whose programs are missing on the hub (jq on a bare install) would fail on every call: skip it, say so once
    const missing = recipe.needs.map((n) => n.trim().split(/\s+/)[0]).filter((b) => !has(b));
    if (missing.length) {
      const why = `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not on the hub; install ${missing.length === 1 ? 'it' : 'them'}`;
      warnOnce(`agent ${def.name}: recipe ${ref.id} ${closed ? 'refuses its tools' : 'skipped'}, ${missing.join(' and ')} not found on the hub`);
      if (closed) out = mergeHookConfigs(out, refusingGroups(recipe, why));
      continue;
    }
    try {
      const script = recipe.script ? ensureRecipeScript(hooksDir, recipe.id, recipe.script) : '';
      const hooks = recipeHooks(recipe, script, ref.env);
      // a hub recipe reads the folder from its input, so it also runs for a session whose folder is on another device;
      // a fail-closed one blocks when it crashes or times out
      const anyCwd = recipe.handlers.every((h) => h.runOn === 'hub');
      for (const groups of Object.values(hooks)) for (const g of groups ?? []) for (const h of g.hooks as RuntimeHookCommand[]) {
        if (anyCwd) h.anyCwd = true;
        if (closed) h.onFailure = 'block';
      }
      out = mergeHookConfigs(out, hooks);
    } catch (err) {
      const why = (err as Error).message.replace(/\.$/, '');
      warnOnce(`agent ${def.name}: recipe ${ref.id} ${closed ? 'refuses its tools' : 'skipped'}: ${why}`);
      if (closed) out = mergeHookConfigs(out, refusingGroups(recipe, why));
    }
  }
  return out;
}

/** Whether a profile's hooks may run: project agents need a trusted folder; plugin agents need the plugin's hooks on. */
export function agentHooksAllowed(def: AgentDef, cwd: string, opts: { trusted(cwd: string): boolean; pluginHooksOn(name: string): boolean }): boolean {
  if (def.source === 'builtin') return true;
  if (def.source === 'plugin') return !def.plugin || opts.pluginHooksOn(def.plugin);
  const inFolder = !!def.path && !!cwd && (def.path === cwd || def.path.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep));
  if (def.source === 'project' || inFolder) return opts.trusted(cwd);
  return true;
}

/** Groups of one event from a hooks object; for a subagent's own profile, Stop groups join SubagentStop. */
function groupsFor(hooks: HooksConfig, event: HookEvent, asSubagent: boolean): HookMatcher[] {
  const own = hooks[event] ?? [];
  if (asSubagent && event === 'SubagentStop') return [...(hooks.Stop ?? []), ...own];
  if (asSubagent && event === 'Stop') return [];
  return own;
}

export interface AgentHookOptions {
  hooksDir: string;
  cwd: string;
  trusted(cwd: string): boolean;
  pluginHooksOn(name: string): boolean;
}

/**
 * The hooks one profile adds to an event, or undefined for none.
 * `asSubagent` is true when the profile is the child of a SubagentStart or
 * SubagentStop event (its Stop hooks run there).
 */
export function agentHookConfig(def: AgentDef | undefined, event: HookEvent, asSubagent: boolean, opts: AgentHookOptions): HooksConfig | undefined {
  if (!def || (!def.hooks && !def.recipes?.length)) return undefined;
  if (!agentHooksAllowed(def, opts.cwd, opts)) return undefined;
  const groups = [...groupsFor(def.hooks ?? {}, event, asSubagent), ...groupsFor(def.recipes?.length ? recipeGroups(def, opts.hooksDir) : {}, event, asSubagent)];
  return groups.length ? { [event]: groups } : undefined;
}

/** Two hook configs as one. */
export function mergeHookConfigs(a: HooksConfig, b: HooksConfig | undefined): HooksConfig {
  if (!b) return a;
  const out: HooksConfig = { ...a };
  for (const [ev, groups] of Object.entries(b) as Array<[HookEvent, HookMatcher[]]>) out[ev] = [...(out[ev] ?? []), ...(groups ?? [])];
  return out;
}
