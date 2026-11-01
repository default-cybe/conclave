import type { Tool } from './types';
import { fail } from './util';

export interface MemoryForgetInput {
  id: string;
}

export const MemoryForgetTool: Tool<MemoryForgetInput> = {
  name: 'MemoryForget',
  description: `Delete a memory by id (ids come from MemorySearch results). Use it when the user asks you to forget something, when a memory is wrong or outdated, or before saving a corrected version.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the memory to delete' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (input) => `Forget memory ${input.id}`,
  async run(input, ctx) {
    const id = typeof input.id === 'string' ? input.id.trim().replace(/^\[|\]$/g, '') : '';
    if (!id) return fail('id is required.');
    try {
      const removed = await ctx.host.memory.remove(id);
      return removed ? { content: `Forgot memory ${id}.` } : fail(`No memory with id "${id}". Use MemorySearch to find the right id.`);
    } catch (err) {
      return fail(`Could not delete memory: ${(err as Error).message}`);
    }
  },
};
