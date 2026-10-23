/**
 * When a run started (src/features/chat/util.ts turnStartedAt): the last
 * message the owner wrote. The hub's own notes in the middle of a run
 * (output limit, Stop hook feedback) are user messages too, and do not
 * restart the "Running 0:42" clock.
 *
 *   bun test packages/web/test/chat-turns.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import { turnStartedAt } from '../src/features/chat/util';

const session = { id: 's1', createdAt: 5 } as Session;

function msg(seq: number, role: Message['role'], content: ContentBlock[]): Message {
  return { id: `m${seq}`, sessionId: 's1', seq, role, kind: 'normal', content, createdAt: seq * 1000 };
}

describe('turn start', () => {
  test('the last message you wrote, past tool results and hub notes', () => {
    const list = [
      msg(1, 'user', [{ type: 'text', text: 'Fix the build' }]),
      msg(2, 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      msg(3, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
      msg(4, 'assistant', [{ type: 'text', text: 'Long answer cut by the output limit' }]),
      msg(5, 'user', [{ type: 'text', text: '<system-reminder>\nYour reply hit the output limit. Go on.\n</system-reminder>' }]),
    ];
    expect(turnStartedAt(list, session)).toBe(1000);
  });

  test('the session start when you wrote nothing yet', () => {
    expect(turnStartedAt([], session)).toBe(5);
    expect(turnStartedAt(undefined, session)).toBe(5);
  });
});
