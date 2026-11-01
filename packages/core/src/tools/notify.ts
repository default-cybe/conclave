import type { Tool } from './types';
import { fail } from './util';

export interface NotifyInput {
  title: string;
  message: string;
}

export const NotifyTool: Tool<NotifyInput> = {
  name: 'Notify',
  description: `Send the user a push notification on their phone and other devices.

Use it sparingly: when long-running work finishes or fails, when you are blocked and need the user, or when a routine finds something they asked to hear about. Do not use it for routine progress updates.
- title: a few words.
- message: one or two sentences saying what happened and what, if anything, the user should do.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title' },
      message: { type: 'string', description: 'One or two sentences' },
    },
    required: ['title', 'message'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `Notify: ${input.title}`,
  async run(input, ctx) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!title || !message) return fail('title and message are both required.');
    try {
      await ctx.host.notify({ title: title.slice(0, 120), body: message.slice(0, 1000), level: 'info', sessionId: ctx.sessionId, link: `/s/${ctx.sessionId}` });
      return { content: 'Notification sent.' };
    } catch (err) {
      return fail(`Could not send the notification: ${(err as Error).message}`);
    }
  },
};
