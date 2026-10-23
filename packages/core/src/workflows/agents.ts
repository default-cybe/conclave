/**
 * Workflow agent() calls as Conclave subagents (docs/WORKFLOWS.md, "Agents
 * are Conclave subagents"). Each call is a normal child session through
 * engine/subagent.ts, so it reuses the step budget, the loop guard,
 * permissions, usage rows and transcripts.
 *
 * - The child's parent is the session that started the run; it is tagged
 *   ['subagent', 'workflow'] and carries meta.workflow = { runId, seq, label,
 *   phase, effort }, which the runner extension reads (workflows/ext.ts).
 * - agentType resolves through the extension registry, with Claude Code's
 *   names mapped (Explore, Plan, general-purpose). Without one the step runs
 *   the `workflow` profile, else general-purpose. A missing agent falls back
 *   to that default and the run log says so.
 * - With a schema the child gets a StructuredOutput tool; a turn that ends
 *   without a valid call is nudged, up to 5 attempts, then the call is null.
 *   ACP children (Claude Code, Codex) are asked for JSON in the final message
 *   instead; the hub validates it and sends up to 2 follow-ups.
 */
import type { Engine } from '../engine/engine';
import { continueSubagent, runSubagent, type SubagentResult } from '../engine/subagent';
import { agentModelRef } from '../extensions/agent-model';
import { assertOutputSchema, formatProblems, validateSchema, type Schema } from '../tools/schema';
import { extractJsonObject, STRUCTURED_OUTPUT_ATTEMPTS, structuredOutputNudge, structuredOutputTool, type StructuredOutputState } from '../tools/structured-output';
import type { Tool } from '../tools/types';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Options a script may pass in opts.conclave. */
export interface ConclaveCallOptions {
  device?: string;
  cwd?: string;
  /** Allowlist of tool names for this step. */
  tools?: string[];
  maxSteps?: number;
  /** A command run in a fresh worktree before the agent (for example bun install --frozen-lockfile). */
  worktreeSetup?: string;
  /** Make the worktree from this earlier call's kept commit instead of HEAD. */
  worktreeFrom?: number;
  /** Return { value, seq, worktree, tokens, durationMs } instead of the bare answer. */
  withMeta?: boolean;
}

export interface AgentSpec {
  prompt: string;
  label?: string;
  phase?: string;
  schema?: Schema;
  model?: string;
  effort?: Effort;
  isolation?: 'worktree';
  agentType?: string;
  conclave?: ConclaveCallOptions;
  stallMs?: number;
}

/** Validate what a script passed to agent(). Throws with a reason the script sees. */
export function readAgentSpec(prompt: unknown, raw: unknown): AgentSpec {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('agent() needs a prompt string');
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const spec: AgentSpec = { prompt };
  if (str('label')) spec.label = str('label')!.slice(0, 200);
  if (str('phase')) spec.phase = str('phase')!.slice(0, 200);
  if (o.schema !== undefined && o.schema !== null) {
    assertOutputSchema(o.schema);
    spec.schema = o.schema as Schema;
  }
  // model null means "inherit" (scan.js passes it)
  if (str('model')) spec.model = str('model');
  if (o.effort !== undefined && o.effort !== null) {
    if (!EFFORTS.includes(o.effort as Effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
    spec.effort = o.effort as Effort;
  }
  if (o.isolation !== undefined && o.isolation !== null) {
    if (o.isolation !== 'worktree') throw new Error("isolation must be 'worktree'");
    spec.isolation = 'worktree';
  }
  if (str('agentType')) spec.agentType = str('agentType');
  if (typeof o.stallMs === 'number' && o.stallMs > 0) spec.stallMs = o.stallMs;
  if (o.conclave && typeof o.conclave === 'object' && !Array.isArray(o.conclave)) {
    const c = o.conclave as Record<string, unknown>;
    const conclave: ConclaveCallOptions = {};
    if (typeof c.device === 'string' && c.device) conclave.device = c.device;
    if (typeof c.cwd === 'string' && c.cwd) conclave.cwd = c.cwd;
    if (Array.isArray(c.tools)) conclave.tools = c.tools.filter((t): t is string => typeof t === 'string');
    if (typeof c.maxSteps === 'number' && c.maxSteps >= 1) conclave.maxSteps = Math.floor(c.maxSteps);
    if (typeof c.worktreeSetup === 'string' && c.worktreeSetup.trim()) conclave.worktreeSetup = c.worktreeSetup.trim();
    if (typeof c.worktreeFrom === 'number') conclave.worktreeFrom = c.worktreeFrom;
    if (c.withMeta === true) conclave.withMeta = true;
    if (Object.keys(conclave).length) spec.conclave = conclave;
  }
  return spec;
}

/** The parts of a spec that decide its answer, for the journal key (label and phase left out). */
export function keyParts(spec: AgentSpec): Record<string, unknown> {
  return {
    prompt: spec.prompt,
    schema: spec.schema,
    model: spec.model,
    effort: spec.effort,
    agentType: spec.agentType,
    isolation: spec.isolation,
    conclave: spec.conclave,
  };
}

/** Claude Code's agent names, as Conclave names them. */
const CLAUDE_NAMES: Record<string, string> = { explore: 'explore', plan: 'planner', 'general-purpose': 'general-purpose', 'code-reviewer': 'reviewer' };

/**
 * The profile an agentType names, and a note when it fell back. Without an
 * agentType the step runs the `workflow` profile when it exists.
 */
export function resolveProfile(engine: Engine, agentType: string | undefined, cwd: string): { name: string; note?: string } {
  const has = (n: string) => !!engine.extensions.agent(n, cwd);
  const fallback = has('workflow') ? 'workflow' : 'general-purpose';
  if (!agentType) return { name: fallback };
  if (has(agentType)) return { name: engine.extensions.agent(agentType, cwd)!.name };
  const mapped = CLAUDE_NAMES[agentType.toLowerCase()];
  if (mapped && has(mapped)) return { name: mapped };
  return { name: fallback, note: `agent ${agentType} is not installed here; using ${fallback}` };
}

/** Live state of one child that the runner extension reads. */
export interface StepState {
  runId: string;
  seq: number;
  structured?: { tool: Tool; state: StructuredOutputState };
  tools?: string[];
  maxSteps?: number;
  /** Last time the child made progress, for stallMs. */
  lastActivity: number;
  /** Stop the call after this long without progress. */
  stallMs?: number;
}

export interface StepOutcome {
  value: unknown;
  childSessionId?: string;
  /** Terminal failure (the call resolves to null). */
  error?: string;
  /** A usage limit stopped it; run again after this time. */
  parkedUntil?: number;
  /** Notes for the run log. */
  notes: string[];
}

export interface StepRunOptions {
  engine: Engine;
  parentSessionId: string;
  spec: AgentSpec;
  runId: string;
  seq: number;
  workflowName: string;
  device: string;
  cwd: string;
  /** Model from meta.phases[].model when the call sets none. */
  phaseModel?: string;
  signal: AbortSignal;
  /** Register the child's live state (structured output, limits) under its session id. */
  register(sessionId: string, state: StepState): void;
  /** The child of an earlier attempt to continue (a parked call). */
  continueChild?: string;
  /** meta.permissions of the workflow: rules for its agents only. */
  rules?: { allow?: string[]; deny?: string[] };
  /** Harness models that did not start earlier in this run; a tier word skips them. */
  failedHarnesses?: Set<string>;
}

function untilAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Run one agent() call to its answer: the text, the validated object, or
 * null with an error. A rate limit returns parkedUntil instead.
 */
export async function runStep(o: StepRunOptions): Promise<StepOutcome> {
  const { engine, spec } = o;
  const notes: string[] = [];
  const parent = engine.getSession(o.parentSessionId);
  if (!parent) return { value: null, error: 'the session that started the run is gone', notes };
  const profile = resolveProfile(engine, spec.agentType, o.cwd);
  if (profile.note) notes.push(profile.note);

  let model: string | undefined;
  // a tier word the owner did not pin in models.tiers (deep may land on claude-code/opus)
  let tierGuess = false;
  // the call's model, else the phase's, else the profile's own (verifier: deep), resolved here so a failed harness can fall back
  const ask = spec.model ?? o.phaseModel ?? profileModel(engine, profile.name, o.cwd);
  if (ask) {
    // agentModelRef checks that an ACP harness is installed before a tier lands on it
    const r = agentModelRef(engine, ask, parent.model);
    model = r.model;
    tierGuess = !!r.tier && !engine.config.get().models?.tiers?.[r.tier] && model !== parent.model;
    if (r.note) notes.push(r.note);
    // a harness the tier picked did not start earlier in this run: go straight to the session's model
    if (tierGuess && o.failedHarnesses?.has(model)) {
      model = parent.model;
      tierGuess = false;
    }
  }

  let acp = false;
  try {
    const ref = model ?? engine.extensions.agent(profile.name, o.cwd)?.model ?? parent.model;
    acp = !!engine.providers.resolve(engine.isUsable(ref) ? ref : parent.model).acp;
  } catch {
    acp = false;
  }

  const structured = spec.schema && !acp ? structuredOutputTool(spec.schema, { maxAttempts: STRUCTURED_OUTPUT_ATTEMPTS }) : undefined;
  const stepState: StepState = {
    runId: o.runId,
    seq: o.seq,
    ...(structured ? { structured } : {}),
    ...(spec.conclave?.tools ? { tools: spec.conclave.tools } : {}),
    ...(spec.conclave?.maxSteps ? { maxSteps: spec.conclave.maxSteps } : {}),
    ...(spec.stallMs ? { stallMs: spec.stallMs } : {}),
    lastActivity: Date.now(),
  };

  let prompt = spec.prompt;
  if (spec.schema && acp) {
    prompt += `\n\nEnd with your result as one JSON object and nothing else in your final message. It must match this JSON Schema:\n${JSON.stringify(spec.schema)}`;
  }
  const label = spec.label ?? `agent ${o.seq}`;

  let r: SubagentResult;
  let turnAt = Date.now();
  try {
    if (o.continueChild) {
      o.register(o.continueChild, stepState);
      r = await continueSubagent(engine, o.continueChild, engine.config.get().limits.resumePrompt, o.signal);
    } else {
      r = await runSubagent(engine, {
        parentSessionId: o.parentSessionId,
        agent: profile.name,
        prompt,
        description: label,
        ...(model ? { model } : {}),
        signal: o.signal,
        workflow: {
          cwd: o.cwd,
          device: o.device,
          title: `${o.workflowName} / ${label}`,
          tags: ['workflow'],
          meta: {
            workflow: { runId: o.runId, seq: o.seq, label, ...(spec.phase ? { phase: spec.phase } : {}), ...(spec.effort ? { effort: spec.effort } : {}) },
            ...(o.rules ? { workflowRules: o.rules } : {}),
          },
          onCreated: (id) => o.register(id, stepState),
        },
      });
    }
  } catch (err) {
    return { value: null, error: (err as Error).message, notes };
  }
  const child = r.sessionId;
  if (untilAborted(o.signal)) return { value: null, childSessionId: child, error: 'stopped', notes };
  if (r.stop === 'rate_limit') return { value: null, childSessionId: child, parkedUntil: r.resumeAt ?? Date.now() + 5 * 60_000, notes };
  if (r.error) return { value: null, childSessionId: child, error: r.error, notes };
  // a harness turn that failed (not installed, not logged in, refused to start) is an error, not an answer
  const failed = acp ? harnessError(engine, child, turnAt) : undefined;
  if (failed && tierGuess && !o.continueChild) {
    // the tier picked a harness that would not start: run the call once more on the session's model
    o.failedHarnesses?.add(model!);
    const again = await runStep({ ...o, spec: { ...spec, model: 'inherit' }, phaseModel: undefined });
    return { ...again, notes: [...notes, `${model} did not start (${failed.slice(0, 160)}), so this call ran on the session's model`, ...again.notes] };
  }
  if (failed) return { value: null, childSessionId: child, error: failed, notes };

  if (!spec.schema) return { value: r.text, childSessionId: child, notes };

  if (structured) {
    // a turn that ended without a valid StructuredOutput call is nudged, within the attempt limit
    let turns = 1;
    for (; !structured.state.done && structured.state.attempts < STRUCTURED_OUTPUT_ATTEMPTS && turns < STRUCTURED_OUTPUT_ATTEMPTS; turns++) {
      if (untilAborted(o.signal)) return { value: null, childSessionId: child, error: 'stopped', notes };
      const next = await continueSubagent(engine, child, structuredOutputNudge(structured.state), o.signal).catch((err) => ({ sessionId: child, text: '', error: (err as Error).message }) as SubagentResult);
      if (next.stop === 'rate_limit') return { value: null, childSessionId: child, parkedUntil: next.resumeAt ?? Date.now() + 5 * 60_000, notes };
      if (next.error) return { value: null, childSessionId: child, error: next.error, notes };
    }
    if (structured.state.done) return { value: structured.state.value, childSessionId: child, notes };
    return {
      value: null,
      childSessionId: child,
      error: `no valid StructuredOutput after ${turns} ${turns === 1 ? 'turn' : 'turns'} and ${structured.state.attempts} ${structured.state.attempts === 1 ? 'call' : 'calls'}${structured.state.lastProblems ? `:\n${structured.state.lastProblems}` : ''}`,
      notes,
    };
  }

  // ACP: JSON in the final message, checked here, with up to 2 follow-ups
  let text = r.text;
  for (let attempt = 0; ; attempt++) {
    const value = extractJsonObject(text);
    const problems = value === undefined ? [{ path: '$', message: 'no JSON object found in the final message' }] : validateSchema(spec.schema, value);
    if (!problems.length) return { value, childSessionId: child, notes };
    if (attempt >= 2 || untilAborted(o.signal)) return { value: null, childSessionId: child, error: `the final message did not match the schema:\n${formatProblems(problems)}`, notes };
    turnAt = Date.now();
    const next = await continueSubagent(engine, child, `Your final message must be one JSON object matching the schema. Fix these and reply with only the JSON:\n${formatProblems(problems)}`, o.signal);
    if (next.error) return { value: null, childSessionId: child, error: next.error, notes };
    const again = harnessError(engine, child, turnAt);
    if (again) return { value: null, childSessionId: child, error: again, notes };
    text = next.text;
  }
}

function profileModel(engine: Engine, name: string, cwd: string): string | undefined {
  try {
    return engine.extensions.agent(name, cwd)?.model;
  } catch {
    return undefined;
  }
}

/** The error notice a harness turn left in the child since `since`, cut to its first lines (session/harness.ts writes it). */
function harnessError(engine: Engine, sessionId: string, since: number): string | undefined {
  const msgs = engine.repos.messages.list(sessionId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.createdAt < since) break;
    if (m.kind !== 'notice' || (m.meta as { level?: string } | undefined)?.level !== 'error') continue;
    const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // keep the head and the first stderr lines: the reason is usually there
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('---'));
    return lines.slice(0, 3).join(' ').slice(0, 400);
  }
  return undefined;
}
