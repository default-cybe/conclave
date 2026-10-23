import type { Tool } from './types';
import { fail } from './util';
import { assertOutputSchema } from './schema';

export interface TaskInput {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
  run_in_background?: boolean;
  /** JSON Schema for the result; the call then returns the validated object as JSON. */
  schema?: Record<string, unknown>;
}

/** Longest JSON result returned inline; a bigger object is cut and the full one stays in the child session. */
const MAX_STRUCTURED_CHARS = 30_000;

/** Subagents may not start their own subagents past this depth. */
export const MAX_TASK_DEPTH = 2;

const DESCRIPTION = `Launch a subagent to handle a task on its own, with its own context window and tools. It works autonomously and returns one final report.

When to use it:
- Open-ended searches across a codebase ("where is X handled?", "find every caller of Y") that may take many rounds of Grep and Read.
- Independent pieces of work that can run in parallel: send several Task calls in one message.
- Work that matches a specialist agent: explore to search, builder to make one scoped change, tester to write and run tests, debugger to find a root cause, verifier to try to disprove a finding, reviewer for a diff, researcher for web research. Pick subagent_type from the list below; use "general-purpose" when none fits.

When not to use it:
- Reading a specific file you already know (use Read), or finding a class by name (use Glob or Grep).
- Small tasks you can finish in a few tool calls yourself.
- To verify or double-check your own work: run the tests or the check instead.

Writing the prompt (the subagent sees nothing of this conversation, so the brief must stand alone):
- State the goal and why it matters, and what done looks like.
- Include everything it needs: file paths, names, error messages, constraints, decisions already made, and what you already tried or ruled out.
- Say whether it should only research and report, or also change code.
- Say exactly what to return (e.g. "a list of file:line locations with one-line explanations", "a summary under 200 words").
- Prefer one clear, complete brief over a vague one; a vague brief gets a vague result.

The result:
- Its final message comes back to you; the user does not see it, so summarize what matters for them.
- Treat its report as well-founded but verify critical claims before acting on them.
- With run_in_background the call returns at once with the subagent's session id; you will be told when it finishes. Its report arrives later in a <subagent_result> block, so there is no need to wait. To check on it before then, TaskList shows each background task's state and TaskWait waits for one; do not call them in a loop.
- model optionally runs the subagent on a different model: "provider/model", or a tier word (fast, smart, deep).
- schema (a JSON Schema whose root is an object) makes the subagent return that object through its StructuredOutput tool; the result is the validated JSON. Use it when you will process the result, such as a list of findings.`;

export const TaskTool: Tool<TaskInput> = {
  name: 'Task',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-5 word) label for the task' },
      prompt: { type: 'string', description: 'Complete, self-contained brief for the subagent' },
      subagent_type: { type: 'string', description: 'Name of the agent to run' },
      model: { type: 'string', description: 'Optional "provider/model" or tier word (fast, smart, deep)' },
      run_in_background: { type: 'boolean', description: 'Return immediately and notify when done' },
      schema: { type: 'object', description: 'Optional JSON Schema (root type object) the result must match' },
    },
    required: ['description', 'prompt', 'subagent_type'],
    additionalProperties: false,
  },
  // The subagent's own tool calls go through permissions; launching it changes nothing. This also lets several run in parallel.
  readOnly: true,
  summarize: (input) => `Task (${input.subagent_type}): ${input.description}`,
  async run(input, ctx) {
    if (ctx.depth >= MAX_TASK_DEPTH) return fail('Task is not available here: subagents cannot start more subagents at this depth. Do the work directly.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return fail('prompt is required: write a complete brief for the subagent.');
    const agent = (input.subagent_type || '').trim() || 'general-purpose';
    const schema = input.schema && typeof input.schema === 'object' && Object.keys(input.schema).length ? input.schema : undefined;
    if (schema) {
      if (input.run_in_background) return fail('schema needs a foreground Task: leave run_in_background off.');
      try {
        assertOutputSchema(schema);
      } catch (err) {
        return fail(`schema is not usable: ${(err as Error).message}`);
      }
    }
    try {
      const res = await ctx.host.runSubagent({
        parentSessionId: ctx.sessionId,
        agent,
        prompt: input.prompt,
        description: input.description || agent,
        model: input.model || undefined,
        background: !!input.run_in_background,
        signal: ctx.signal,
        ...(schema ? { schema } : {}),
      });
      if (schema) {
        if (res.structured === undefined) return fail(`Subagent "${agent}" returned no valid result: ${res.error ?? 'unknown reason'}. Its last message:\n${(res.text ?? '').slice(0, 2_000)}`, { sessionId: res.sessionId, agent });
        let json = JSON.stringify(res.structured, null, 2);
        if (json.length > MAX_STRUCTURED_CHARS) json = `${json.slice(0, MAX_STRUCTURED_CHARS)}\n[cut: ${json.length} chars; the full result is in session ${res.sessionId}]`;
        return { content: json, meta: { sessionId: res.sessionId, agent, structured: true } };
      }
      if (input.run_in_background) {
        return {
          content: `Subagent "${agent}" started in the background (session ${res.sessionId}). You will be notified when it finishes. To check on it before then, TaskList shows its state and TaskWait waits for it.${res.text ? `\n${res.text}` : ''}`,
          meta: { sessionId: res.sessionId, agent, background: true },
        };
      }
      return { content: res.text?.trim() || '(The subagent finished without a final message.)', meta: { sessionId: res.sessionId, agent } };
    } catch (err) {
      if (ctx.signal.aborted) return fail('Subagent was interrupted.');
      return fail(`Subagent "${agent}" failed: ${(err as Error).message}`);
    }
  },
};
