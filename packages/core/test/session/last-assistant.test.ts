import { describe, expect, test } from 'bun:test';
import { storedAssistantText } from '../../src/session/transcript';
import type { Message } from '../../src/types';

const message = (text: string, role: Message['role'] = 'assistant', kind: Message['kind'] = 'normal'): Message => ({
  id: 'msg', sessionId: 'session', seq: 1, role, kind, content: [{ type: 'text', text }], createdAt: 0,
});

describe('storedAssistantText', () => {
  test('uses only the last 20 messages when they contain assistant text', () => {
    const store = {
      tail: (id: string, n: number) => { expect(id).toBe('member-session'); expect(n).toBe(20); return [message('answer'), message('question', 'user')]; },
      list: () => { throw new Error('full transcript read'); },
    };
    expect(storedAssistantText(store, 'member-session')).toBe('answer');
  });

  test('falls back when the tail has only tools, notices, reminders or quoted text', () => {
    let reads = 0;
    const store = {
      tail: () => [message('', 'assistant'), message('notice', 'assistant', 'notice'), message('<system-reminder>not an answer</system-reminder>')],
      list: (id: string) => { expect(id).toBe('session'); reads++; return [message('older answer')]; },
    };
    expect(storedAssistantText(store, 'session')).toBe('older answer');
    expect(reads).toBe(1);
  });

  test('preserves an empty result for a session with no assistant answer', () => {
    expect(storedAssistantText({ tail: () => [], list: () => [] }, 'session')).toBe('');
  });
});
