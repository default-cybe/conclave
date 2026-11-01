import type { QuestionRequest } from '../types';
import type { Tool } from './types';
import { fail } from './util';

export interface AskUserQuestionInput {
  questions: QuestionRequest['questions'];
}

const DESCRIPTION = `Ask the user 1-4 multiple-choice questions and wait for the answers.

When to use it:
- To settle ambiguous requirements or preferences before doing work that depends on them.
- To let the user choose between real alternatives (approaches, libraries, trade-offs).
- To get a decision you are not allowed to make yourself.

Rules:
- 1 to 4 questions per call, each with 2 to 4 options.
- header is a very short label for the question (at most 12 characters, e.g. "Auth method").
- Each option has a short label (1-5 words) and a description of what choosing it means.
- Set multiSelect to true when several options can be chosen together.
- The user can always type their own answer, so do not add an "Other" option.
- If you recommend an option, put it first and add "(Recommended)" to its label.
- Do not use this to ask whether a plan is ready; in plan mode use ExitPlanMode for that.`;

export const AskUserQuestionTool: Tool<AskUserQuestionInput> = {
  name: 'AskUserQuestion',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question, ending with a question mark' },
            header: { type: 'string', description: 'Very short label (max 12 chars)' },
            multiSelect: { type: 'boolean', description: 'Allow choosing more than one option' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short option text (1-5 words)' },
                  description: { type: 'string', description: 'What this option means or implies' },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
          },
          required: ['question', 'header', 'multiSelect', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `Ask: ${Array.isArray(input.questions) ? input.questions.map((q) => q.header || q.question).join(', ') : ''}`,
  async run(input, ctx) {
    const qs = input.questions;
    if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return fail('questions must contain 1 to 4 questions.');
    const seen = new Set<string>();
    for (const [i, q] of qs.entries()) {
      if (!q || typeof q.question !== 'string' || !q.question.trim()) return fail(`Question ${i + 1} needs question text.`);
      if (seen.has(q.question)) return fail(`Question ${i + 1} repeats an earlier question; each question must be unique.`);
      seen.add(q.question);
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return fail(`Question ${i + 1} must have 2 to 4 options.`);
      const labels = new Set<string>();
      for (const o of q.options) {
        if (!o || typeof o.label !== 'string' || !o.label.trim()) return fail(`Question ${i + 1} has an option without a label.`);
        if (labels.has(o.label)) return fail(`Question ${i + 1} has duplicate option "${o.label}".`);
        labels.add(o.label);
      }
    }
    const clean: QuestionRequest['questions'] = qs.map((q) => ({
      question: q.question.trim(),
      header: q.header?.trim().slice(0, 24) || undefined,
      multiSelect: !!q.multiSelect,
      options: q.options.map((o) => ({ label: o.label.trim(), description: o.description?.trim() || undefined })),
    }));
    let answers: Record<string, string>;
    try {
      answers = await ctx.host.askUser(ctx.sessionId, clean, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) return fail('The question was cancelled.');
      return fail(`Could not ask the user: ${(err as Error).message}`);
    }
    const lines = clean.map((q) => {
      const a = answers[q.question] ?? (q.header ? answers[q.header] : undefined);
      return `- "${q.question}" -> ${a !== undefined && a !== '' ? `"${a}"` : '(no answer)'}`;
    });
    return { content: `The user answered:\n${lines.join('\n')}\nContinue with these answers in mind.`, meta: { answers } };
  },
};
