/**
 * Hook recipes service (ECOSYSTEM.md 4.2): list, test, install and remove the
 * recipes in hook-recipes.ts, in Conclave (config.json or a project's
 * .conclave/settings.json) or in another CLI's settings on a device (Claude
 * Code, Codex, Gemini CLI).
 *
 * Install writes the script to <hooks>/recipes/<id>.sh (0755), turns each
 * handler's "{script}" into that path with NAME='value' prefixes for tunables
 * that differ from the defaults, tags Conclave handlers with "recipe": "<id>",
 * merges them into the scope, then runs the recipe's tests through the real
 * hook runner in a temp copy of RECIPE_FIXTURE. A failed test does not undo
 * the install; the caller shows it. In other CLIs' files the recipe is found
 * again by its script path, and the recipe field is left out.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { HookEvent, HookMatcher, HooksConfig } from '../config/schema';
import type { Machine } from '../machine/types';
import type { HookRecipeDetail, HookRecipeDto, RecipeInstall, RecipeInstallRequest, RecipeInstallResult, RecipeRemoveWhere } from '../client';
import type { RecipeTestResult } from '../catalog/types';
import { GEMINI_TOOLS } from './compat';
import { Hooks } from './hooks';
import { HOOK_RECIPES, RECIPE_FIXTURE, RECIPE_FIXTURE_TRANSCRIPT, RECIPE_STUB_SEARCH, type HookRecipe, type RecipeHandler, type RecipeTest } from './hook-recipes';
import type { HookInput, HookOutcome, RuntimeHookCommand } from './types';

export class RecipeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Cli = 'claude-code' | 'codex' | 'gemini';

export interface RecipeHost {
  /** ~/.conclave/hooks on the hub. */
  hooksDir: string;
  /** Path of config.json, for messages. */
  configPath: string;
  /** A scope's hooks as stored (user: config.json, project: <cwd>/.conclave/settings.json). */
  readScope(scope: 'user' | 'project', cwd?: string): HooksConfig;
  /** Save a scope's whole hooks list through the normal save path (lint, audit, reload). */
  saveScope(scope: 'user' | 'project', cwd: string | undefined, hooks: HooksConfig): void;
  /** A connected device, for installs into other CLIs. "local" is the hub. */
  machine?(device: string): Machine | undefined;
  /** Small persistent store for install records (kv). */
  store?: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  audit?(action: string, detail: string): void;
  /** Which programs exist on the hub. Defaults to Bun.which. */
  which?(bin: string): string | null;
  /** Whether a project folder is trusted; its .conclave/settings.json hooks stay off until it is. */
  trusted?(cwd: string): boolean;
}

const KV_KEY = 'hooks.recipes.installs';
const CLI_FILES: Record<Cli, string> = { 'claude-code': '~/.claude/settings.json', codex: '~/.codex/hooks.json', gemini: '~/.gemini/settings.json' };
const GEMINI_EVENT: Partial<Record<HookEvent, string>> = {
  PreToolUse: 'BeforeTool',
  PostToolUse: 'AfterTool',
  UserPromptSubmit: 'BeforeAgent',
  Stop: 'AfterAgent',
  PreCompact: 'PreCompress',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Notification: 'Notification',
};
const GEMINI_TOOL_NAME: Record<string, string> = {};
for (const [g, c] of Object.entries(GEMINI_TOOLS)) GEMINI_TOOL_NAME[c] ??= g;

/** "jq 1.6+" -> "jq". */
const binOf = (need: string) => need.trim().split(/\s+/)[0];
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export function recipeById(id: string): HookRecipe | undefined {
  return HOOK_RECIPES.find((r) => r.id === id);
}

function mustRecipe(id: string): HookRecipe {
  const r = recipeById(id);
  if (!r) throw new RecipeError(404, `There is no hook recipe called ${id}.`);
  return r;
}

/** Whether a handler came from this recipe: tagged, or running its script. */
export function isRecipeHandler(h: { recipe?: string; command?: string }, id: string): boolean {
  return h.recipe === id || (typeof h.command === 'string' && h.command.includes(`/recipes/${id}.sh`));
}

/** Remove a recipe's handlers from a hooks list. Returns the new list and how many were removed. */
export function withoutRecipe(hooks: HooksConfig, id: string): { hooks: HooksConfig; removed: number } {
  let removed = 0;
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks ?? {}) as Array<[HookEvent, HookMatcher[]]>) {
    // another CLI's file can hold shapes Conclave does not know; leave them as they are
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: HookMatcher[] = [];
    for (const g of groups ?? []) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hs = g.hooks.filter((h) => {
        const hit = isRecipeHandler(h as RuntimeHookCommand, id);
        if (hit) removed++;
        return !hit;
      });
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) out[event] = kept;
  }
  return { hooks: out, removed };
}

/** The env prefix for tunables that differ from the recipe's defaults, and the changed values. */
export function envPrefix(r: HookRecipe, env: Record<string, string> = {}): { prefix: string; changed: Record<string, string> } {
  const changed: Record<string, string> = {};
  for (const e of r.env ?? []) {
    const v = env[e.name];
    if (v !== undefined && v !== e.default) {
      // globs (WRITE_GLOB) need * ? [ ] { }; the value is single-quoted on the command line
      if (!/^[\w ./:,@%+=*?{}[\]-]*$/.test(v)) throw new RecipeError(400, `${e.name} has characters a tunable cannot hold. Use letters, digits and . / : , @ % + = - * ? [ ] { }.`);
      changed[e.name] = v;
    }
  }
  for (const k of Object.keys(env)) if (!(r.env ?? []).some((e) => e.name === k)) throw new RecipeError(400, `${r.id} has no tunable called ${k}.`);
  const prefix = Object.entries(changed).map(([k, v]) => `${k}=${shq(v)} `).join('');
  return { prefix, changed };
}

/** The handlers a recipe adds, as a hooks list. tag adds "recipe": "<id>" (Conclave files only). */
export function recipeHooks(r: HookRecipe, scriptPath: string, env: Record<string, string> = {}, tag = true): HooksConfig {
  const { prefix } = envPrefix(r, env);
  const out: HooksConfig = {};
  for (const h of r.handlers) {
    const handler: RuntimeHookCommand =
      h.type === 'prompt'
        ? { type: 'prompt', prompt: h.prompt ?? '' }
        : { type: 'command', command: `${prefix}${(h.command ?? '{script}').split('{script}').join(scriptPath)}` };
    if (h.timeout) handler.timeout = h.timeout;
    if (h.if) handler.if = h.if;
    if (h.async) handler.async = true;
    if (tag) handler.recipe = r.id;
    (out[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [handler] });
  }
  return out;
}

function mergeInto(base: HooksConfig, add: HooksConfig): HooksConfig {
  const next = structuredClone(base);
  for (const [ev, list] of Object.entries(add) as Array<[HookEvent, HookMatcher[]]>) next[ev] = [...(next[ev] ?? []), ...(list ?? [])];
  return next;
}

/** Claude Code shape to Gemini CLI's: event and tool renames, timeouts in milliseconds. */
export function toGemini(hooks: HooksConfig): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [ev, groups] of Object.entries(hooks) as Array<[HookEvent, HookMatcher[]]>) {
    const name = GEMINI_EVENT[ev];
    if (!name) throw new RecipeError(400, `Gemini CLI has no ${ev} event, so this recipe cannot run there.`);
    out[name] = (groups ?? []).map((g) => ({
      ...(g.matcher ? { matcher: g.matcher.replace(/[A-Za-z]+/g, (w) => GEMINI_TOOL_NAME[w] ?? w) } : {}),
      hooks: g.hooks.map((h) => {
        const x = { ...h } as Record<string, unknown>;
        if (typeof x.timeout === 'number') x.timeout = x.timeout * 1000;
        if (typeof x.command === 'string') x.command = (x.command as string).replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, '$GEMINI_PROJECT_DIR');
        delete x.recipe;
        delete x.if;
        return x;
      }),
    }));
  }
  return out;
}

/** Regex groups that Rust's regex crate (Codex) cannot compile: lookahead and lookbehind. */
const LOOKAROUND = /\(\?<?[=!][^()]*\)/g;

/**
 * Claude Code shape to Codex's. The file format is the same, but Codex
 * compiles matchers with Rust's regex crate, which has no lookaround, and
 * skips a group whose matcher does not compile. Lookaround groups are dropped,
 * so such a matcher can match more tools; recipes that use one check the tool
 * name again in their script.
 */
export function toCodex(hooks: HooksConfig): HooksConfig {
  const out = structuredClone(hooks);
  for (const groups of Object.values(out)) for (const g of groups ?? []) if (g?.matcher) g.matcher = g.matcher.replace(LOOKAROUND, '');
  return out;
}

/** What the person must still do in the other CLI before the hooks run there. */
const CLI_NOTE: Record<Cli, string> = {
  'claude-code': 'Claude Code reads hooks when it starts. Restart open Claude Code sessions, or review the change in /hooks.',
  codex: 'Codex runs a new hook only after you trust it. Start Codex and pick Review hooks, or open /hooks.',
  gemini: 'Gemini CLI reads hooks when it starts. Restart open Gemini CLI sessions.',
};

/** Remove a recipe's handlers from a Gemini settings hooks object (matched by script path). */
function geminiWithout(hooks: Record<string, unknown>, id: string): { hooks: Record<string, unknown>; removed: number } {
  let removed = 0;
  const out: Record<string, unknown> = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[ev] = groups;
      continue;
    }
    const kept = groups
      .map((g) => {
        const gg = g as { hooks?: Array<{ command?: string }> };
        if (!Array.isArray(gg.hooks)) return g;
        const hs = gg.hooks.filter((h) => {
          const hit = isRecipeHandler(h, id);
          if (hit) removed++;
          return !hit;
        });
        return hs.length ? { ...gg, hooks: hs } : undefined;
      })
      .filter(Boolean);
    if (kept.length) out[ev] = kept;
  }
  return { hooks: out, removed };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

function sh(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
}

/** A temp copy of RECIPE_FIXTURE: a git repo with a.txt committed, then modified, plus the untracked files. */
export function makeRecipeFixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'conclave-recipe-fx-'));
  sh(['git', 'init', '-q'], d);
  sh(['git', 'config', 'user.email', 'recipes@conclave.local'], d);
  sh(['git', 'config', 'user.name', 'recipes'], d);
  sh(['git', 'config', 'commit.gpgsign', 'false'], d);
  writeTree(d, RECIPE_FIXTURE.committed);
  sh(['git', 'add', '-A'], d);
  sh(['git', 'commit', '-qm', 'init'], d);
  writeTree(d, RECIPE_FIXTURE.after);
  return d;
}

/** Check one outcome against a test's expectations. Returns the reasons it failed (empty when it passed). */
export function checkExpect(t: RecipeTest, o: HookOutcome, cwd: string): string[] {
  const e = t.expect;
  const why: string[] = [];
  const ran = (o.trace ?? []).length > 0;
  if (e.ran !== undefined && e.ran !== ran) why.push(e.ran ? 'the handler did not run' : 'the handler ran but should have been skipped');
  if (e.blocked !== undefined && !!o.blocked !== e.blocked) why.push(e.blocked ? 'it did not block' : `it blocked: ${o.reason ?? ''}`);
  if (e.reason && !new RegExp(e.reason).test(o.reason ?? '')) why.push(`the reason did not match /${e.reason}/: ${o.reason ?? '(none)'}`);
  if (e.permissionDecision !== undefined && (o.permissionDecision ?? null) !== e.permissionDecision) why.push(`decision was ${o.permissionDecision ?? 'none'}, expected ${e.permissionDecision ?? 'none'}`);
  const ctx = o.additionalContext.join('\n');
  if (e.context && !new RegExp(e.context).test(ctx)) why.push(`the context did not match /${e.context}/: ${ctx.slice(0, 120) || '(empty)'}`);
  if (e.contextLacks && new RegExp(e.contextLacks).test(ctx)) why.push(`the context has /${e.contextLacks}/`);
  if (e.noContext && ctx) why.push('it added context');
  if (e.system && !new RegExp(e.system).test(o.systemMessages.join('\n'))) why.push(`no system message matched /${e.system}/`);
  const out = typeof o.updatedToolOutput === 'string' ? o.updatedToolOutput : o.updatedToolOutput !== undefined ? JSON.stringify(o.updatedToolOutput) : '';
  if (e.output && !new RegExp(e.output).test(out)) why.push(`the new output did not match /${e.output}/: ${out.slice(0, 80) || '(none)'}`);
  if (e.outputUnder && !(out && out.length < e.outputUnder)) why.push(`the new output is ${out.length} chars, expected under ${e.outputUnder}`);
  if (e.updatedInput) {
    for (const [k, v] of Object.entries(e.updatedInput)) {
      const a = (o.updatedInput as Record<string, unknown> | undefined)?.[k];
      const ok = Array.isArray(v) ? Array.isArray(a) && v.every((x) => a.includes(x)) : JSON.stringify(a) === JSON.stringify(v);
      if (!ok) why.push(`updatedInput.${k} was ${JSON.stringify(a)}`);
    }
  }
  if (e.file) {
    const f = join(cwd, e.file.path);
    if (!existsSync(f)) why.push(`${e.file.path} was not written`);
    else if (!new RegExp(e.file.matches).test(readFileSync(f, 'utf8'))) why.push(`${e.file.path} does not match /${e.file.matches}/`);
  }
  if (e.gitRef) {
    const refs = sh(['git', 'for-each-ref', '--format=%(refname)'], cwd);
    if (!refs.includes(e.gitRef)) why.push(`no git ref ${e.gitRef}`);
  }
  return why;
}

export interface RecipeTestOptions {
  which?: (bin: string) => string | null;
  /** Only these test names. */
  only?: string[];
}

/** The hooks list one test runs: the recipe's handlers for that event, with the test's env and TMPDIR in front. */
function testHooks(r: HookRecipe, t: RecipeTest, script: string, prefixEnv: Record<string, string>): HooksConfig {
  const prefix = Object.entries(prefixEnv).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const hooks: HooksConfig = {};
  for (const h of r.handlers.filter((x: RecipeHandler) => x.event === t.event)) {
    const cmd: RuntimeHookCommand =
      h.type === 'command'
        ? { type: 'command', command: `${prefix} ${(h.command ?? '{script}').split('{script}').join(script)}`, timeout: h.timeout ?? 30 }
        : { type: 'prompt', prompt: h.prompt ?? '', ...(h.timeout ? { timeout: h.timeout } : {}) };
    if (h.if) cmd.if = h.if;
    if (h.async) cmd.async = true;
    (hooks[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [cmd] });
  }
  return hooks;
}

/**
 * Run a recipe's bundled tests through the real hook runner, each in its own
 * fixture folder and TMPDIR. Cases whose programs are missing are reported
 * as failed with the missing program named, without running.
 */
export async function runRecipeTests(r: HookRecipe, opts: RecipeTestOptions = {}): Promise<RecipeTestResult[]> {
  const which = opts.which ?? ((b: string) => Bun.which(b));
  const tests = r.tests.filter((t) => !opts.only || opts.only.includes(t.name));
  if (!tests.length) return [];
  // the tests bring their own stub conclave CLI
  const missing = r.needs.map(binOf).filter((b) => !which(b) && !(b === 'conclave' && tests.every((t) => t.stubConclave)));
  const home = mkdtempSync(join(tmpdir(), 'conclave-recipe-'));
  const cleanup: string[] = [home];
  try {
    if (missing.length) return tests.map((t) => ({ name: t.name, ok: false, why: `Not run: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not on the hub, so the script would exit before it decides.` }));
    const stubDir = join(home, 'stubbin');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, 'conclave'), `#!/usr/bin/env bash\nif [ "$1" = memory ] && [ "$2" = search ]; then cat <<'J'\n${JSON.stringify(RECIPE_STUB_SEARCH)}\nJ\nfi\nexit 0\n`);
    chmodSync(join(stubDir, 'conclave'), 0o755);
    let script = '';
    if (r.script) {
      script = join(home, 'recipes', `${r.id}.sh`);
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, r.script);
      chmodSync(script, 0o755);
    }
    const results: RecipeTestResult[] = [];
    for (const t of tests) {
      let cwd: string;
      try {
        cwd = makeRecipeFixture();
      } catch (err) {
        results.push({ name: t.name, ok: false, why: `Could not make the test folder: ${(err as Error).message.split('\n')[0]}` });
        continue;
      }
      cleanup.push(cwd);
      const tmp = mkdtempSync(join(tmpdir(), 'conclave-recipe-tmp-'));
      cleanup.push(tmp);
      const env: Record<string, string> = { TMPDIR: tmp, ...(t.stubConclave ? { PATH: `${stubDir}:${process.env.PATH ?? ''}` } : {}), ...(t.env ?? {}) };
      const hooks = testHooks(r, t, script, env);
      const runner = new Hooks({ complete: async () => t.modelReply ?? '{}' });
      const input = { session_id: `recipe-test-${r.id}`, cwd, hook_event_name: t.event, ...t.input } as HookInput;
      if (t.transcript) {
        const tp = join(tmp, 'transcript.jsonl');
        writeFileSync(tp, RECIPE_FIXTURE_TRANSCRIPT);
        input.transcript_path = tp;
      }
      try {
        for (let i = 0; i < (t.repeat ?? 0); i++) await runner.run(t.event, input, { matcherValue: t.matcherValue, hooks });
        const o = await runner.run(t.event, input, { matcherValue: t.matcherValue, hooks });
        if (r.handlers.some((h) => h.async && h.event === t.event)) await Bun.sleep(400);
        const why = checkExpect(t, o, cwd);
        const trace = o.trace?.[0];
        results.push({ name: t.name, ok: !why.length, ...(why.length ? { why: why.join('; ') + (trace?.stderr ? `. stderr: ${trace.stderr.trim().slice(0, 200)}` : '') } : {}), ...(trace ? { trace } : {}) });
      } catch (err) {
        results.push({ name: t.name, ok: false, why: `The test run failed: ${(err as Error).message}` });
      }
    }
    return results;
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HookRecipes {
  constructor(private host: RecipeHost) {}

  private which(bin: string): string | null {
    return this.host.which ? this.host.which(bin) : Bun.which(bin);
  }

  scriptPath(id: string): string {
    return join(this.host.hooksDir, 'recipes', `${id}.sh`);
  }

  private records(): Record<string, RecipeInstall[]> {
    return this.host.store?.get<Record<string, RecipeInstall[]>>(KV_KEY, {}) ?? {};
  }

  private saveRecords(rec: Record<string, RecipeInstall[]>): void {
    this.host.store?.set(KV_KEY, rec);
  }

  private ready(r: HookRecipe): { ok: boolean; missing: string[] } {
    const missing = r.needs.map(binOf).filter((b) => !this.which(b));
    return { ok: !missing.length, missing };
  }

  /** Where a recipe is installed: Conclave scopes found by scanning, other CLIs from the install records. */
  installed(id: string, cwd?: string): RecipeInstall[] {
    const rec = this.records()[id] ?? [];
    const out: RecipeInstall[] = [];
    const scopes: Array<['user' | 'project', string | undefined]> = [['user', undefined]];
    if (cwd) scopes.push(['project', cwd]);
    for (const [scope, c] of scopes) {
      let hooks: HooksConfig = {};
      try {
        hooks = this.host.readScope(scope, c);
      } catch {
        continue;
      }
      if (!withoutRecipe(hooks, id).removed) continue;
      const known = rec.find((x) => x.scope === scope && (scope === 'user' || x.cwd === c));
      out.push(known ?? { scope, ...(c ? { cwd: c } : {}), env: {}, installedAt: 0 });
    }
    // project installs in other folders, and installs in other CLIs, as recorded
    for (const x of rec) if ((x.scope === 'project' && x.cwd !== cwd) || (x.scope !== 'user' && x.scope !== 'project')) out.push(x);
    return out;
  }

  list(cwd?: string): HookRecipeDto[] {
    return HOOK_RECIPES.map((r) => {
      const { script, tests, ...rest } = r;
      return { ...rest, scriptBytes: script ? Buffer.byteLength(script) : 0, testCount: tests.length, installed: this.installed(r.id, cwd), ready: this.ready(r) };
    });
  }

  get(id: string, cwd?: string): HookRecipeDetail {
    const r = mustRecipe(id);
    return { ...r, installed: this.installed(id, cwd), ready: this.ready(r), scriptPath: this.scriptPath(id) };
  }

  test(id: string, opts: { only?: string[] } = {}): Promise<RecipeTestResult[]> {
    return runRecipeTests(mustRecipe(id), { which: (b) => this.which(b), only: opts.only });
  }

  async install(id: string, req: RecipeInstallRequest): Promise<RecipeInstallResult> {
    const r = mustRecipe(id);
    if (!req || (req.scope !== 'user' && req.scope !== 'project')) throw new RecipeError(400, 'scope must be user or project');
    if (req.scope === 'project' && !req.cwd && !req.target) throw new RecipeError(400, 'Pick a project folder to add a project hook.');
    // a relative folder would land next to wherever the hub was started
    if (req.scope === 'project' && !req.target && !isAbsolute(req.cwd as string)) throw new RecipeError(400, `The project folder must be a full path, like /home/you/code/app. Got ${req.cwd}.`);
    const env = req.env ?? {};
    const { changed } = envPrefix(r, env);
    if (req.target) return this.installTarget(r, req, changed);

    if (!r.targets.includes('conclave')) throw new RecipeError(400, `${r.title} works only in ${r.targets.join(', ')}. Pick that as the target.`);
    const missing = this.ready(r).missing;
    if (missing.length && !req.force) throw new RecipeError(409, `${r.title} needs ${missing.join(' and ')} on the hub. Install ${missing.length === 1 ? 'it' : 'them'}, or add it anyway.`);

    const scriptPath = this.scriptPath(r.id);
    if (r.script) {
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(scriptPath, r.script, { mode: 0o755 });
      chmodSync(scriptPath, 0o755);
    }
    const cwd = req.scope === 'project' ? req.cwd : undefined;
    const current = withoutRecipe(this.host.readScope(req.scope, cwd), r.id).hooks;
    this.host.saveScope(req.scope, cwd, mergeInto(current, recipeHooks(r, scriptPath, changed)));

    const installed: RecipeInstall = { scope: req.scope, ...(cwd ? { cwd } : {}), env: changed, installedAt: Date.now() };
    this.record(r.id, installed);
    this.host.audit?.('hooks.recipe.install', `${r.id} ${req.scope}${cwd ? ` ${cwd}` : ''}`);
    const tests = req.skipTests ? [] : await this.test(r.id);
    const untrusted = req.scope === 'project' && this.host.trusted && !this.host.trusted(cwd as string);
    return {
      ok: true,
      tests,
      installed,
      file: req.scope === 'user' ? this.host.configPath : join(cwd as string, '.conclave', 'settings.json'),
      ...(untrusted ? { note: 'This folder is not trusted yet, so its hooks stay off. Trust it at the top of Extensions to turn them on.' } : {}),
    };
  }

  private record(id: string, x: RecipeInstall): void {
    const rec = this.records();
    const same = (a: RecipeInstall) => a.scope === x.scope && a.cwd === x.cwd && a.device === x.device;
    rec[id] = [...(rec[id] ?? []).filter((a) => !same(a)), x];
    this.saveRecords(rec);
  }

  private forget(id: string, match: (x: RecipeInstall) => boolean): void {
    const rec = this.records();
    if (!rec[id]) return;
    rec[id] = rec[id].filter((x) => !match(x));
    if (!rec[id].length) delete rec[id];
    this.saveRecords(rec);
  }

  private device(id: string): Machine {
    const m = this.host.machine?.(id);
    if (!m) throw new RecipeError(409, `Device ${id} is not connected. Start the Conclave daemon there, then try again.`);
    return m;
  }

  private async installTarget(r: HookRecipe, req: RecipeInstallRequest, changed: Record<string, string>): Promise<RecipeInstallResult> {
    const { cli, device } = req.target!;
    if (!(['claude-code', 'codex', 'gemini'] as const).includes(cli)) throw new RecipeError(400, 'target.cli must be claude-code, codex or gemini');
    if (!r.targets.includes(cli)) throw new RecipeError(400, `${r.title} does not work in ${cli}. It works in ${r.targets.join(', ')}.`);
    const m = this.device(device);
    const missing: string[] = [];
    for (const b of r.needs.map(binOf)) {
      if (!/^[\w.+-]+$/.test(b)) continue;
      const res = await m.exec(`command -v ${b} >/dev/null 2>&1`, { cwd: '/', timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }));
      if (res.exitCode !== 0) missing.push(b);
    }
    if (missing.length && !req.force) throw new RecipeError(409, `${r.title} needs ${missing.join(' and ')} on ${m.name}. Install ${missing.length === 1 ? 'it' : 'them'} there, or add it anyway.`);
    const scriptPath = m.resolve('~/.conclave/hooks/recipes/' + `${r.id}.sh`, '/');
    if (r.script) {
      await m.writeFile(scriptPath, r.script);
      await m.exec(`chmod 755 ${shq(scriptPath)}`, { cwd: '/', timeoutMs: 10_000 });
    }
    const file = m.resolve(CLI_FILES[cli], '/');
    let data: Record<string, unknown> = {};
    const st = await m.stat(file).catch(() => null);
    if (st) {
      const text = await m.readText(file);
      try {
        data = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (err) {
        throw new RecipeError(400, `${CLI_FILES[cli]} on ${m.name} is not valid JSON (${(err as Error).message}). Fix it first; Conclave will not overwrite it.`);
      }
    }
    const plain = recipeHooks(r, scriptPath, changed, false);
    const add = cli === 'codex' ? toCodex(plain) : plain;
    const prev = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<string, unknown>;
    if (cli === 'gemini') {
      const base = geminiWithout(prev, r.id).hooks;
      const g = toGemini(add);
      for (const [ev, list] of Object.entries(g)) base[ev] = [...((base[ev] as unknown[]) ?? []), ...list];
      data.hooks = base;
    } else {
      data.hooks = mergeInto(withoutRecipe(prev as HooksConfig, r.id).hooks, add);
    }
    await m.writeFile(file, JSON.stringify(data, null, 2) + '\n');
    const installed: RecipeInstall = { scope: cli, device, env: changed, installedAt: Date.now() };
    this.record(r.id, installed);
    this.host.audit?.('hooks.recipe.install', `${r.id} ${cli} on ${device}`);
    // the tests run on the hub: they check the recipe, not the device
    const tests = req.skipTests ? [] : await this.test(r.id);
    return { ok: true, tests, installed, file: `${CLI_FILES[cli]} on ${m.name}`, note: CLI_NOTE[cli] };
  }

  /** Remove a recipe's handlers from one place, and its script when nothing uses it any more. */
  async remove(id: string, where: RecipeRemoveWhere = {}): Promise<{ ok: true; removed: number }> {
    const r = mustRecipe(id);
    if (where.cli) {
      const device = where.device ?? 'local';
      const m = this.device(device);
      const file = m.resolve(CLI_FILES[where.cli], '/');
      let removed = 0;
      if (await m.stat(file).catch(() => null)) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse((await m.readText(file)).trim() || '{}') as Record<string, unknown>;
        } catch (err) {
          throw new RecipeError(400, `${CLI_FILES[where.cli]} on ${m.name} is not valid JSON (${(err as Error).message}). Fix it first; Conclave will not overwrite it.`);
        }
        const prev = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<string, unknown>;
        const next = where.cli === 'gemini' ? geminiWithout(prev, r.id) : withoutRecipe(prev as HooksConfig, r.id);
        removed = next.removed;
        if (removed) {
          if (Object.keys(next.hooks).length) data.hooks = next.hooks;
          else delete data.hooks;
          await m.writeFile(file, JSON.stringify(data, null, 2) + '\n');
        }
      }
      this.forget(r.id, (x) => x.scope === where.cli && (x.device ?? 'local') === device);
      if (!this.records()[r.id]?.some((x) => x.device === device)) await m.remove(m.resolve(`~/.conclave/hooks/recipes/${r.id}.sh`, '/')).catch(() => undefined);
      this.host.audit?.('hooks.recipe.remove', `${r.id} ${where.cli} on ${device}`);
      return { ok: true, removed };
    }
    const scope = where.scope ?? 'user';
    if (scope === 'project' && !where.cwd) throw new RecipeError(400, 'cwd is required to remove a project hook.');
    if (scope === 'project' && !isAbsolute(where.cwd as string)) {
      // an install record from before full paths were required: forget it, but touch no file
      if (!(this.records()[r.id] ?? []).some((x) => x.scope === 'project' && x.cwd === where.cwd)) throw new RecipeError(400, `The project folder must be a full path, like /home/you/code/app. Got ${where.cwd}.`);
      this.forget(r.id, (x) => x.scope === 'project' && x.cwd === where.cwd);
      return { ok: true, removed: 0 };
    }
    const cwd = scope === 'project' ? where.cwd : undefined;
    const next = withoutRecipe(this.host.readScope(scope, cwd), r.id);
    if (next.removed) this.host.saveScope(scope, cwd, next.hooks);
    this.forget(r.id, (x) => x.scope === scope && (scope === 'user' || x.cwd === cwd));
    // the hub's script goes when no Conclave scope still runs it
    const stillUser = withoutRecipe(this.host.readScope('user'), r.id).removed > 0;
    const stillProject = (this.records()[r.id] ?? []).some((x) => x.scope === 'project');
    const path = this.scriptPath(r.id);
    if (!stillUser && !stillProject && existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* leave it */
      }
    }
    this.host.audit?.('hooks.recipe.remove', `${r.id} ${scope}${cwd ? ` ${cwd}` : ''}`);
    return { ok: true, removed: next.removed };
  }
}
