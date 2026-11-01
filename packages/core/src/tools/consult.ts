import type { Tool } from './types';
import { fail } from './util';

export interface ConsultInput {
  model: string;
  question: string;
  include_context?: boolean;
}

const CONSULT_SYSTEM = `Another AI agent is consulting you mid-task for a second opinion. Answer its question directly and concretely.
Point out mistakes, risks or better options if you see them, and say how confident you are. Be concise: no preamble, no restating the question.`;

const DESCRIPTION = `Ask a different model a focused question and get its answer back. Use it for a second opinion mid-task: checking a plan or a tricky diagnosis, reviewing a risky change, or breaking a tie between approaches.

Usage:
- model is a "provider/model" reference, e.g. "openai/gpt-5.5" or "zai/glm-5".
- The other model sees only what you send. Make the question self-contained: include the relevant code, error messages, constraints and what you already tried.
- include_context adds a short summary of this session (title, working directory, current todo list). It does not send the conversation.
- The answer is advice, not ground truth. Weigh it against what you have verified yourself.
- Do not use it for simple questions you can answer yourself.`;

export const ConsultTool: Tool<ConsultInput> = {
  name: 'Consult',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Model to ask, as "provider/model"' },
      question: { type: 'string', description: 'Self-contained question with all needed context' },
      include_context: { type: 'boolean', description: 'Add a short summary of this session (title, cwd, todos)' },
    },
    required: ['model', 'question'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `Consult ${input.model}`,
  async run(input, ctx) {
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!model) return fail('model is required, e.g. "openai/gpt-5.5".');
    if (!question) return fail('question is required.');
    let prompt = question;
    if (input.include_context) {
      const todos = ctx.host.getTodos(ctx.sessionId);
      const lines = [
        `Session: ${ctx.session?.title || '(untitled)'}`,
        `Working directory: ${ctx.cwd}`,
        `Asking agent: ${ctx.agent} on ${ctx.model}`,
      ];
      if (todos.length) lines.push('Todo list:', ...todos.map((t) => `- [${t.status}] ${t.content}`));
      prompt = `<context>\n${lines.join('\n')}\n</context>\n\n${question}`;
    }
    try {
      const answer = await ctx.host.complete({ model, system: CONSULT_SYSTEM, prompt, signal: ctx.signal, purpose: 'consult' });
      return { content: `Answer from ${model}:\n\n${answer.trim() || '(empty answer)'}`, meta: { model } };
    } catch (err) {
      if (ctx.signal.aborted) return fail('Consult was interrupted.');
      return fail(`Could not consult ${model}: ${(err as Error).message}`);
    }
  },
};
