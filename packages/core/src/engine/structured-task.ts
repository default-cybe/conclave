/**
 * Task with a schema (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2 item 4):
 * the child gets a StructuredOutput tool built from the schema, and the call
 * returns the validated object. Same rules as a workflow agent() call (3.6):
 * a turn that ends without a valid call is nudged, up to 5 attempts, then the
 * call fails with the last problems. A child on an ACP harness (Claude Code,
 * Codex) is asked for JSON in its final message instead; the hub validates it
 * and sends up to 2 follow-ups.
 *
 * The tool reaches only that child: a runner extension adds it to the
 * child's tool list while its call is running.
 */
import type { Engine } from './engine';
import type { RunnerExtension } from '../session/runner-ext';
import { continueSubagent, runSubagent } from './subagent';
import { subagentModel } from '../extensions/agent-model';
import { assertOutputSchema, formatProblems, validateSchema, type Schema } from '../tools/schema';
import { extractJsonObject, STRUCTURED_OUTPUT_ATTEMPTS, STRUCTURED_OUTPUT_TOOL, structuredOutputNudge, structuredOutputTool, type StructuredOutputState } from '../tools/structured-output';
import type { Tool } from '../tools/types';

export interface StructuredTaskOptions {
  parentSessionId: string;
  agent: string;
  prompt: string;
  description: string;
  model?: string;
  schema: unknown;
  signal?: AbortSignal;
}

export interface StructuredTaskResult {
  sessionId: string;
  text: string;
  /** The validated object, when the child produced one. */
  structured?: unknown;
  /** Why there is no object. */
  error?: string;
}

const live = new WeakMap<Engine, Map<string, { tool: Tool; state: StructuredOutputState }>>();

function registry(engine: Engine): Map<string, { tool: Tool; state: StructuredOutputState }> {
  let map = live.get(engine);
  if (map) return map;
  map = new Map();
  live.set(engine, map);
  const ext: RunnerExtension = {
    name: 'task-schema',
    tools: (session, tools) => {
      const hit = map!.get(session.id);
      if (!hit) return undefined;
      return [...tools.filter((t) => t.name !== STRUCTURED_OUTPUT_TOOL), hit.tool];
    },
  };
  engine.runnerExtensions.register(ext);
  return map;
}

function isAcp(engine: Engine, ref: string): boolean {
  try {
    return !!engine.providers.resolve(ref).acp;
  } catch {
    return false;
  }
}

export async function runStructuredTask(engine: Engine, o: StructuredTaskOptions): Promise<StructuredTaskResult> {
  assertOutputSchema(o.schema);
  const schema = o.schema as Schema;
  const parent = engine.getSession(o.parentSessionId);
  if (!parent) throw new Error('Parent session gone');
  // as the parent's account sees agents: a member never gets the owner's own (docs/design/ACCOUNTS.md 2)
  const acct = engine.accountOf(parent);
  const def = engine.agentNamed(o.agent, parent.cwd, acct) ?? engine.agentNamed('general-purpose', undefined, acct);
  const acp = isAcp(engine, subagentModel(engine, o.model, def?.model, parent.model));
  const map = registry(engine);

  if (acp) {
    const prompt = `${o.prompt}\n\nEnd with your result as one JSON object and nothing else in your final message. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
    const r = await runSubagent(engine, { parentSessionId: o.parentSessionId, agent: o.agent, prompt, description: o.description, model: o.model, signal: o.signal });
    let text = r.text;
    for (let attempt = 0; ; attempt++) {
      const value = extractJsonObject(text);
      const problems = value === undefined ? [{ path: '$', message: 'no JSON object found in the final message' }] : validateSchema(schema, value);
      if (!problems.length) return { sessionId: r.sessionId, text, structured: value };
      if (attempt >= 2 || o.signal?.aborted) return { sessionId: r.sessionId, text, error: `the final message did not match the schema:\n${formatProblems(problems)}` };
      const next = await continueSubagent(engine, r.sessionId, `Your final message must be one JSON object matching the schema. Fix these and reply with only the JSON:\n${formatProblems(problems)}`, o.signal);
      if (next.error) return { sessionId: r.sessionId, text: next.text, error: next.error };
      text = next.text;
    }
  }

  const structured = structuredOutputTool(schema, { maxAttempts: STRUCTURED_OUTPUT_ATTEMPTS });
  let child: string | undefined;
  try {
    const r = await runSubagent(engine, {
      parentSessionId: o.parentSessionId,
      agent: o.agent,
      prompt: `${o.prompt}\n\nReturn your result by calling the ${STRUCTURED_OUTPUT_TOOL} tool.`,
      description: o.description,
      model: o.model,
      signal: o.signal,
      workflow: {
        meta: { taskSchema: true },
        onCreated: (id) => {
          child = id;
          map.set(id, structured);
        },
      },
    });
    child = r.sessionId;
    if (r.error) return { sessionId: child, text: r.text, error: r.error };
    let text = r.text;
    for (let turn = 1; !structured.state.done && structured.state.attempts < STRUCTURED_OUTPUT_ATTEMPTS && turn < STRUCTURED_OUTPUT_ATTEMPTS; turn++) {
      if (o.signal?.aborted) break;
      const next = await continueSubagent(engine, child, structuredOutputNudge(structured.state), o.signal);
      text = next.text;
      if (next.error) return { sessionId: child, text, error: next.error };
    }
    if (structured.state.done) return { sessionId: child, text, structured: structured.state.value };
    return { sessionId: child, text, error: `no valid ${STRUCTURED_OUTPUT_TOOL} call after ${Math.max(structured.state.attempts, 1)} attempts${structured.state.lastProblems ? `:\n${structured.state.lastProblems}` : ''}` };
  } finally {
    if (child) map.delete(child);
  }
}
