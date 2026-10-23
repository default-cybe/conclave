/**
 * Helpers for workflow tests on the scripted engine (test/engine/harness.ts).
 * No paid model calls: every model reply comes from the script or a route.
 */
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import type { RequestBody, TestEngine } from '../engine/harness';
import { workflowsOf } from '../../src/workflows/attached';
import type { WorkflowService } from '../../src/workflows/service';
import type { StartWorkflowInput } from '../../src/client/workflows';
import type { RunRow } from '../../src/workflows/store';

type Msg = { role: string; content: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

/** Text of the last user message (tool results left out). */
export function lastUserText(body: RequestBody): string {
  const msgs = (body.messages ?? []) as Msg[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const t = textOf(msgs[i].content);
    if (t) return t;
  }
  return '';
}

/** True when the last message carries tool results (the model's next step after a tool call). */
export function afterToolResult(body: RequestBody): boolean {
  const msgs = (body.messages ?? []) as Msg[];
  const last = msgs[msgs.length - 1];
  return !!last && Array.isArray(last.content) && last.content.some((b) => (b as { type?: string }).type === 'tool_result');
}

/** The tool_result text of the last message. */
export function lastToolResult(body: RequestBody): string {
  const msgs = (body.messages ?? []) as Msg[];
  const last = msgs[msgs.length - 1];
  if (!last || !Array.isArray(last.content)) return '';
  return last.content
    .filter((b) => (b as { type?: string }).type === 'tool_result')
    .map((b) => {
      const c = (b as { content?: unknown }).content;
      return typeof c === 'string' ? c : textOf(c);
    })
    .join('\n');
}

export function hasTool(body: RequestBody, name: string): boolean {
  return !!body.tools?.some((t) => t.name === name);
}

/** The system prompt as text. */
export function systemText(body: RequestBody): string {
  const s = body.system;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) return s.map((b) => (b as { text?: string }).text ?? '').join('\n');
  return '';
}

/** The working directory the system prompt names. */
export function workingDir(body: RequestBody): string | undefined {
  return /Working directory: (.+)/.exec(systemText(body))?.[1]?.trim();
}

export function svcOf(engine: Engine): WorkflowService {
  const svc = workflowsOf(engine);
  if (!svc) throw new Error('no workflow service');
  return svc;
}

/** Start a script in a new session and wait for its end. */
export async function runScript(t: TestEngine | { engine: Engine; cwd: string }, script: string, extra: Partial<StartWorkflowInput> & { session?: Record<string, unknown> } = {}): Promise<RunRow> {
  const svc = svcOf(t.engine);
  const { session: sessionExtra, ...rest } = extra;
  const sessionId = rest.sessionId ?? (await t.engine.createSession({ cwd: t.cwd, ...(sessionExtra ?? {}) })).id;
  const run = await svc.startRun({ script, sessionId, ...rest });
  return svc.wait(run.id);
}

/** A second engine on the same home and mock model, as after a hub restart. */
export async function reopen(t: TestEngine): Promise<Engine> {
  const cfg = t.engine.config.get();
  return createEngine({
    home: t.home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: cfg.defaultModel,
      smallModel: cfg.smallModel,
      providers: { mock: cfg.providers.mock },
      permissions: cfg.permissions,
      memory: cfg.memory,
      hooks: {},
      limits: cfg.limits,
      // tier words stay on the mock model, as in test/engine/harness.ts
      models: cfg.models,
    } as never,
  });
}

/** Count the scripted requests a block of work made. */
export async function countRequests<T>(t: TestEngine, fn: () => Promise<T>): Promise<{ value: T; requests: number }> {
  const before = t.requests.length;
  const value = await fn();
  return { value, requests: t.requests.length - before };
}

/** Turn off the ACP harnesses the default config lists, so a tier word never starts a real Claude Code or Codex in a test. */
export function noHarnesses(engine: Engine): void {
  const cfg = engine.config.get();
  engine.config.update({ providers: Object.fromEntries(Object.entries(cfg.providers).map(([id, p]) => [id, p.type === 'acp' ? { ...p, enabled: false } : p])) });
}
