/**
 * Built-in hooks (ECOSYSTEM.md 4.3 item 16): memory recall, memory
 * extraction, compaction and file recall, listed in Extensions > Hooks >
 * Built in with their last run, a token cost and an On / Off.
 *
 * Recall, extraction and compaction stay where they run (the session runner
 * and the engine); their switches are the existing config keys, so turning
 * one off here is the same as setting it in config.json. File recall is a new
 * in-process PreToolUse hook on Read, off by default: when the agent opens a
 * file, memories tagged with that path (or that mention it) are added to the
 * result, plus memories tagged repo:<name> once per session.
 */
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { BuiltinHookDto, BuiltinHookId } from '../client';
import type { HookEvent } from '../config/schema';
import type { Hooks } from '../extensions/hooks';
import type { HookInput } from '../extensions/types';
import type { Engine } from './engine';
import { EngineError } from './errors';

const KV_KEY = 'hooks.builtin';
const FILE_RECALL_BUDGET = 1_500;
const MEMORY_RECALL_BUDGET = 4_000;

interface Stored {
  'file-recall'?: { enabled?: boolean; budgetChars?: number };
  'memory-recall'?: { budgetChars?: number };
}

interface Def {
  id: BuiltinHookId;
  event: HookEvent;
  label: string;
  description: string;
  setting?: string;
  canDisable: boolean;
}

const DEFS: Def[] = [
  {
    id: 'memory-recall',
    event: 'UserPromptSubmit',
    label: 'Memory recall',
    description: 'Before each message reaches the model, finds related memories and adds them as a note the model can see. Every injection is listed in the run log with its size.',
    setting: 'memory.autoInject',
    canDisable: true,
  },
  {
    id: 'memory-extract',
    event: 'Stop',
    label: 'Memory extraction',
    description: 'When a session goes idle, a small model reads it and saves durable facts and procedures as memories.',
    setting: 'memory.autoExtract',
    canDisable: true,
  },
  {
    id: 'compaction',
    event: 'PreCompact',
    label: 'Compaction',
    description: 'When the context is nearly full, older messages are summarized so the session keeps going. PreCompact hooks run first and can add what the summary must keep.',
    setting: 'context.compactAt',
    canDisable: false,
  },
  {
    id: 'file-recall',
    event: 'PreToolUse',
    label: 'File recall',
    description: 'When the agent reads a file, adds memories tagged with that path or that mention it, and memories tagged repo:<name> once per session. Off by default.',
    canDisable: true,
  },
];

function stored(engine: Engine): Stored {
  return engine.repos.kv.get<Stored>(KV_KEY, {});
}

function isOn(engine: Engine, id: BuiltinHookId): boolean {
  const cfg = engine.config.get();
  switch (id) {
    case 'memory-recall':
      return cfg.memory.enabled && cfg.memory.autoInject;
    case 'memory-extract':
      return cfg.memory.enabled && cfg.memory.autoExtract;
    case 'compaction':
      return true;
    case 'file-recall':
      return cfg.memory.enabled && stored(engine)['file-recall']?.enabled === true;
  }
}

/** The label the built-in writes in its traces. */
const traceLabel = (id: BuiltinHookId) => id;

export function builtinHooks(engine: Engine): BuiltinHookDto[] {
  const runner = engine.hookRunner;
  const recent = runner?.recent({ limit: 200 }) ?? [];
  const s = stored(engine);
  return DEFS.map((d) => {
    const last = [...recent].reverse().find((t) => t.label === traceLabel(d.id));
    const tokens = runner?.tokensPerSession(d.event, traceLabel(d.id));
    const budget = d.id === 'file-recall' ? (s['file-recall']?.budgetChars ?? FILE_RECALL_BUDGET) : d.id === 'memory-recall' ? (s['memory-recall']?.budgetChars ?? MEMORY_RECALL_BUDGET) : undefined;
    return {
      id: d.id,
      event: d.event,
      label: d.label,
      description: d.description,
      enabled: isOn(engine, d.id),
      canDisable: d.canDisable,
      ...(budget ? { budgetChars: budget } : {}),
      ...(last ? { lastRun: last } : {}),
      ...(tokens ? { tokensPerSession: tokens } : {}),
      ...(d.setting ? { setting: d.setting } : {}),
    };
  });
}

export function setBuiltinHook(engine: Engine, id: string, patch: { enabled?: unknown; budgetChars?: unknown }): BuiltinHookDto {
  const def = DEFS.find((d) => d.id === id);
  if (!def) throw new EngineError(404, `unknown built-in hook ${id}. Built-ins: ${DEFS.map((d) => d.id).join(', ')}`);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new EngineError(400, 'enabled must be a boolean');
  if (patch.budgetChars !== undefined && (typeof patch.budgetChars !== 'number' || !Number.isFinite(patch.budgetChars) || patch.budgetChars < 200 || patch.budgetChars > 50_000)) {
    throw new EngineError(400, 'budgetChars must be a number from 200 to 50000');
  }
  const enabled = patch.enabled as boolean | undefined;
  if (enabled === false && !def.canDisable) throw new EngineError(400, `${def.label} cannot be turned off: long sessions would no longer fit the model. Raise context.compactAt instead.`);
  if (patch.budgetChars !== undefined && def.id !== 'file-recall' && def.id !== 'memory-recall') throw new EngineError(400, `${def.label} has no budget to set`);

  const s = stored(engine);
  if (def.id === 'file-recall') {
    s['file-recall'] = { ...s['file-recall'], ...(enabled !== undefined ? { enabled } : {}), ...(patch.budgetChars !== undefined ? { budgetChars: patch.budgetChars as number } : {}) };
    engine.repos.kv.set(KV_KEY, s);
  } else if (def.id === 'memory-recall' && patch.budgetChars !== undefined) {
    s['memory-recall'] = { ...s['memory-recall'], budgetChars: patch.budgetChars as number };
    engine.repos.kv.set(KV_KEY, s);
  }
  if (enabled !== undefined && (def.id === 'memory-recall' || def.id === 'memory-extract')) {
    const user = engine.config.getUser();
    const memory = { ...(user.memory ?? {}), ...(def.id === 'memory-recall' ? { autoInject: enabled } : { autoExtract: enabled }) } as never;
    engine.config.update({ memory });
  }
  return builtinHooks(engine).find((d) => d.id === def.id)!;
}

/** Most chars memory recall may add to one message. */
export function memoryRecallBudget(engine: Engine): number {
  return stored(engine)['memory-recall']?.budgetChars ?? MEMORY_RECALL_BUDGET;
}

/** Register the in-process built-ins on the runner. Returns a function that removes them. */
export function registerBuiltinHooks(engine: Engine, hooks: Hooks): () => void {
  const seenRepo = new Set<string>();
  const offFile = hooks.register(
    'PreToolUse',
    async (input: HookInput) => {
      if (!isOn(engine, 'file-recall')) return;
      const path = (input.tool_input as { file_path?: unknown } | undefined)?.file_path;
      if (typeof path !== 'string' || !path) return;
      const abs = isAbsolute(path) ? path : resolve(input.cwd, path);
      const rel = relative(input.cwd, abs);
      const inRepo = !rel.startsWith('..');
      const shown = inRepo ? rel : abs;
      const repo = basename(input.cwd);
      const budget = stored(engine)['file-recall']?.budgetChars ?? FILE_RECALL_BUDGET;
      // the session's account's memory only
      const hits = await engine.memoryFor(engine.sessionAccount(input.session_id)).search(`${shown} ${basename(abs)}`, { limit: 8, external: false }).catch(() => []);
      const tags = new Set([`path:${shown}`, shown, abs]);
      const forFile = hits.filter((h) => h.tags.some((t) => tags.has(t)) || h.content.includes(shown) || (inRepo && h.content.includes(abs)));
      const repoKey = `${input.session_id}\u0000${repo}`;
      const forRepo = inRepo && !seenRepo.has(repoKey) ? hits.filter((h) => h.tags.includes(`repo:${repo}`) && !forFile.includes(h)) : [];
      if (forRepo.length) seenRepo.add(repoKey);
      if (seenRepo.size > 2_000) seenRepo.clear();
      const picked = [...forFile, ...forRepo];
      if (!picked.length) return;
      let text = `Memories about ${shown} (from earlier sessions; may be outdated):\n${picked.map((h) => `- [${h.id}] ${h.content}`).join('\n')}`;
      if (text.length > budget) text = `${text.slice(0, budget)}\n[cut by Conclave: ${text.length - budget} chars over budget]`;
      return { additionalContext: [text] };
    },
    'Read',
    traceLabel('file-recall'),
  );
  return () => offFile();
}
