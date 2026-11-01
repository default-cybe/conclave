/**
 * Hook recipe helpers for the Hooks tab: goals (the filter), where a recipe
 * is installed in words, and the handler lines a recipe adds.
 */
import type { HookRecipeDto, RecipeInstall } from '@conclave/core/client';
import type { RecipeCategory, RecipeHandler } from '@conclave/core/extensions/hook-recipes';

export type Goal = 'all' | 'safety' | 'security' | 'token-savers' | 'memory' | 'verification' | 'minimal-code' | 'other';

export const GOALS: Array<{ value: Goal; label: string; cats?: RecipeCategory[]; gloss: string }> = [
  { value: 'all', label: 'All', gloss: '' },
  { value: 'safety', label: 'Safety', cats: ['safety', 'homelab'], gloss: 'Stop work from being thrown away: git, Proxmox, MCP writes.' },
  { value: 'security', label: 'Security', cats: ['security'], gloss: 'Keep secrets out of tool calls and catch injected instructions.' },
  { value: 'token-savers', label: 'Token savers', cats: ['token-savers'], gloss: 'Shrink what the model reads: test output, MCP JSON, subagent prompts.' },
  { value: 'memory', label: 'Memory', cats: ['memory'], gloss: 'Keep what matters across compaction and sessions, in Conclave and other CLIs.' },
  { value: 'verification', label: 'Verification', cats: ['verification'], gloss: 'Make the agent show evidence before it says done.' },
  { value: 'minimal-code', label: 'Minimal code', cats: ['minimal-code'], gloss: 'Push back on new dependencies and oversized diffs.' },
  { value: 'other', label: 'Other', cats: ['quality', 'ctf', 'self-improvement'], gloss: 'Formatting, CTF notes and traces for recursive-improve.' },
];

export const CATEGORY_WORD: Record<RecipeCategory, string> = {
  safety: 'safety',
  security: 'security',
  homelab: 'homelab',
  'token-savers': 'token saver',
  memory: 'memory',
  verification: 'verification',
  'minimal-code': 'minimal code',
  quality: 'quality',
  ctf: 'ctf',
  'self-improvement': 'self-improvement',
};

export function inGoal(r: Pick<HookRecipeDto, 'category'>, goal: Goal): boolean {
  if (goal === 'all') return true;
  return !!GOALS.find((g) => g.value === goal)?.cats?.includes(r.category);
}

const CLI_WORD: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', conclave: 'Conclave' };
export const cliWord = (c: string) => CLI_WORD[c] ?? c;

/** "this hub", "project ~/code/conclave", "Claude Code on arch-desktop". */
export function installWords(i: RecipeInstall, deviceName: (id: string) => string = (id) => id): string {
  if (i.scope === 'user') return 'this hub';
  if (i.scope === 'project') return `project ${(i.cwd ?? '').replace(/^\/(home\/[^/]+|root)/, '~')}`;
  return `${cliWord(i.scope)} on ${deviceName(i.device ?? 'local')}`;
}

/** "PreToolUse Bash" for a handler line; the long MCP regex is shortened. */
export function handlerWords(h: Pick<RecipeHandler, 'event' | 'matcher' | 'if'>): string {
  const m = h.matcher && h.matcher.length > 40 ? `${h.matcher.slice(0, 37)}…` : h.matcher;
  return [h.event, m].filter(Boolean).join(' ');
}

/** The first line of events, for a row: "PreToolUse Bash", or "PreToolUse and Stop". */
export function eventsWords(handlers: RecipeHandler[]): string {
  const events = [...new Set(handlers.map((h) => h.event))];
  if (events.length === 1 && handlers.length === 1) return handlerWords(handlers[0]);
  return events.join(' and ');
}

/** Ids of the starter set, for Hooks and Discover; a test keeps them equal to RECIPE_STARTER in core. */
export const STARTER = ['git-work-saver', 'secrets-firewall', 'proxmox-guard', 'mcp-write-gate', 'injection-tripwire', 'test-output-trim', 'new-dependency-gate', 'stop-verify'];
