/**
 * StructuredOutput: a tool built from a JSON Schema for one child session (a
 * workflow agent() call with a schema, or Task with a schema). The model
 * calls it with the object as its input; a valid call is recorded and the
 * turn should end, an invalid one returns each problem by path so the model
 * can fix it. After maxAttempts invalid calls the tool stops asking
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.6).
 */
import type { JsonSchema } from '../types';
import type { Tool } from './types';
import { assertOutputSchema, formatProblems, validateSchema, type Schema } from './schema';

export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** Attempts per child, as in Claude Code. */
export const STRUCTURED_OUTPUT_ATTEMPTS = 5;

export interface StructuredOutputState {
  /** The first valid value, once the model called the tool correctly. */
  value?: unknown;
  done: boolean;
  /** Calls so far, valid or not. */
  attempts: number;
  /** The last problems the validator reported. */
  lastProblems?: string;
}

export function structuredOutputTool(schema: unknown, opts: { maxAttempts?: number; state?: StructuredOutputState } = {}): { tool: Tool; state: StructuredOutputState } {
  assertOutputSchema(schema);
  const max = opts.maxAttempts ?? STRUCTURED_OUTPUT_ATTEMPTS;
  const state: StructuredOutputState = opts.state ?? { done: false, attempts: 0 };
  const tool: Tool = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Return your final result as structured data. Call this once, with the result object as the input, when your work is done. ' +
      'If the call is rejected, fix every listed problem and call it again. After a valid call, end your turn with one short line.',
    inputSchema: schema as unknown as JsonSchema,
    readOnly: true,
    validatesInput: true,
    summarize: () => 'StructuredOutput',
    async run(input) {
      if (state.done) return { content: 'Already recorded. End your turn now.' };
      state.attempts++;
      const problems = validateSchema(schema as Schema, input);
      if (!problems.length) {
        state.value = input;
        state.done = true;
        return { content: 'Recorded. End your turn now with one short line; do not repeat the data.' };
      }
      state.lastProblems = formatProblems(problems);
      if (state.attempts >= max) {
        return { content: `The output does not match the schema and no attempts are left:\n${state.lastProblems}\nEnd your turn now.`, isError: true };
      }
      return { content: `The output does not match the schema (attempt ${state.attempts} of ${max}). Fix these and call StructuredOutput again:\n${state.lastProblems}`, isError: true };
    },
  };
  return { tool, state };
}

/** The reminder for a child that ended its turn without a valid StructuredOutput call. */
export function structuredOutputNudge(state: StructuredOutputState): string {
  const why = state.lastProblems ? `Your last call was rejected:\n${state.lastProblems}\n` : 'You ended your turn without calling it.\n';
  return `Your result must go through the StructuredOutput tool. ${why}Call StructuredOutput now with the complete result object.`;
}

/**
 * For ACP children (Claude Code, Codex) that cannot get the tool: find a JSON
 * object in the final message. A fenced json block wins, else the outermost
 * braces.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter((s): s is string => !!s && s.trim().startsWith('{'));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}
