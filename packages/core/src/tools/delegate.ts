/**
 * Delegate: a Chat, Assistant or Code session hands a job to a Code or
 * Assistant session on one of the owner's devices and gets its answer back,
 * the way a subagent reports to Task (engine/delegate.ts does the work).
 */
import type { Session } from '../types';
import type { Tool } from './types';
import { fail } from './util';

export type DelegateTarget = 'code' | 'assistant';

export interface DelegateInput {
  to: DelegateTarget;
  prompt: string;
  description?: string;
  agent?: string;
  device?: string;
  folder?: string;
  readOnly?: boolean;
  background?: boolean;
}

/** What the tool asks the host for (engine/delegate.ts runDelegate). */
export interface DelegateRequest {
  to: DelegateTarget;
  prompt: string;
  /** The new session's title: the description, else the brief's first line. */
  title: string;
  agent?: string;
  device?: string;
  folder?: string;
  readOnly: boolean;
  background: boolean;
  /** The caller's subagent depth: only depth 0 may delegate. */
  depth: number;
  toolUseId: string;
  signal?: AbortSignal;
}

/** Where the job ran: on the result's meta.delegate and the child's meta.delegate, for the apps' rows. */
export interface DelegatePlace {
  to: DelegateTarget;
  device: string;
  deviceName: string;
  folder: string;
  readOnly: boolean;
  permissionMode: Session['permissionMode'];
}

export interface DelegateOutcome {
  sessionId: string;
  agent: string;
  place: DelegatePlace;
  /** The child's final answer, or the note that it started in the background. */
  text: string;
  error?: string;
}

/** The new session's title: the description, else the brief's first line, cut at 60 characters as a subagent's is. */
export function delegateTitle(input: Pick<DelegateInput, 'description' | 'prompt'>): string {
  const d = typeof input.description === 'string' ? input.description.trim() : '';
  const first = typeof input.prompt === 'string' ? (input.prompt.trim().split(/\r\n|\n|\r/)[0] ?? '').trim() : '';
  return (d || first || 'Delegated work').slice(0, 60);
}

const DESCRIPTION = `Hand a job to a Code or Assistant session on one of the owner's devices and get its answer back. Use it when the owner wants something done on their machines or in their files (find, read, check, run, change something), names a device or a folder, or asks you to ask code or the assistant. Do the job this way instead of telling them to move the chat.

- to: "code" works in a folder with files and a shell. "assistant" does mail, calendar, the browser and the owner's day.
- agent: for code, explore (read-only search, the default when readOnly) or coder (changes, the default otherwise). For the assistant, leave it out.
- device: a name from the list below; the hub when left out. folder: where to work on it, as a path or ~/...; its home folder when left out.
- prompt: the full brief. The session sees nothing of this conversation, so give the exact paths, names and words the owner used, what to look for, and what to return.
- readOnly: true unless the owner asked for changes. A read-only session gets no file-editing tools. It runs in this session's permission mode either way.
- background: return at once; the answer arrives later in a <subagent_result> block. Use it for long jobs.

The answer comes back to you, not to the owner: tell them what it found, plainly.`;

export const DelegateTool: Tool<DelegateInput> = {
  name: 'Delegate',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', enum: ['code', 'assistant'], description: 'code for files and the shell, assistant for mail, calendar and the browser' },
      prompt: { type: 'string', description: 'The full, self-contained brief' },
      description: { type: 'string', description: 'Short label (3-6 words) for the row and the new session title' },
      agent: { type: 'string', description: 'Agent to run: explore or coder for code; default by readOnly' },
      device: { type: 'string', description: 'Device name from the list; default the hub' },
      folder: { type: 'string', description: 'Folder on that device; default its home folder' },
      readOnly: { type: 'boolean', description: 'Default true; false only when the owner asked for changes' },
      background: { type: 'boolean', description: 'Return at once and get the answer later. Default false' },
    },
    required: ['to', 'prompt'],
    additionalProperties: false,
  },
  // the session it starts asks for its own calls; starting it changes nothing, so several run in parallel
  readOnly: true,
  summarize: (input) => `Delegate (${input.to}${input.device ? ` on ${input.device}` : ''}): ${delegateTitle(input)}`,
  async run(input, ctx) {
    if (!ctx.host.delegate) return fail('Delegate is not available on this hub.');
    if (input.to !== 'code' && input.to !== 'assistant') return fail('to must be "code" or "assistant".');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return fail('prompt is required: write the full brief.');
    try {
      const r = await ctx.host.delegate({
        to: input.to,
        prompt: input.prompt,
        title: delegateTitle(input),
        ...(input.agent?.trim() ? { agent: input.agent.trim() } : {}),
        ...(input.device?.trim() ? { device: input.device.trim() } : {}),
        ...(input.folder?.trim() ? { folder: input.folder.trim() } : {}),
        readOnly: input.readOnly !== false,
        background: !!input.background,
        depth: ctx.depth,
        toolUseId: ctx.toolUseId,
        signal: ctx.signal,
      });
      const who = `${input.to === 'code' ? 'Code' : 'Assistant'} (${r.agent}) on ${r.place.deviceName} in ${r.place.folder}`;
      const meta = { sessionId: r.sessionId, agent: r.agent, delegate: r.place, ...(input.background ? { background: true } : {}) };
      if (input.background) return { content: `${who} started in the background (session ${r.sessionId}). Its answer arrives in a <subagent_result> block when it finishes; there is no need to wait.`, meta };
      if (r.error) return fail(`${who} stopped with an error: ${r.error}${r.text ? `\nIts last message:\n${r.text}` : ''}`, meta);
      return { content: `${who} answered:\n\n${r.text.trim() || '(It finished without a final message.)'}`, meta };
    } catch (err) {
      if (ctx.signal.aborted) return fail('The delegated session was interrupted.');
      return fail((err as Error).message);
    }
  },
};
