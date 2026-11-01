/**
 * Which turns of a session log draw again (src/features/chat/Turn.tsx
 * sameTurn). The log rebuilds its lists on every streamed chunk and every
 * line a running command prints; a finished turn must not draw again for
 * either, and a turn must when its own tool moves.
 *
 *   bun test packages/web/test/turn-redraw.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Message, Session } from '@conclave/core/types';
import type { ToolRun } from '../src/store/store';
import { sameTurn, type TurnProps } from '../src/features/chat/Turn';

const session = { id: 's1' } as Session;
const done: Message = { id: 'a1', sessionId: 's1', seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], createdAt: 1, stopReason: 'tool_use' };
const run = (progress: string): ToolRun => ({ status: 'running', name: 'Bash', startedAt: 1, progress });

function props(p: Partial<TurnProps> = {}): TurnProps {
  return { messages: [done], session, streaming: {}, tools: { t1: run('') }, results: {}, known: null, ...p };
}

describe('turn redraws', () => {
  test('a finished turn stays as it is while another turn streams and runs', () => {
    const a = props({ tools: { t1: run(''), t2: run('line 1') } });
    const b = props({ messages: [done], streaming: { other: true }, tools: { ...a.tools, t2: run('line 1\nline 2') }, results: { t9: { type: 'tool_result', toolUseId: 't9', content: 'ok' } } });
    expect(sameTurn(a, b)).toBe(true);
  });

  test('a status or stats update of the session does not draw it again; another speaker or session does', () => {
    const a = props();
    const later = { ...session, status: 'running', updatedAt: 9, stats: { messages: 3 } } as unknown as Session;
    expect(sameTurn(a, { ...a, session: later })).toBe(true);
    expect(sameTurn(a, { ...a, session: { ...session, model: 'anthropic/claude-opus-5-5' } })).toBe(false);
    expect(sameTurn(a, { ...a, session: { ...session, agent: 'sysadmin' } })).toBe(false);
    expect(sameTurn(a, { ...a, session: { ...session, id: 's2' } })).toBe(false);
  });

  test('its own tool output, result or streaming state draws it again', () => {
    expect(sameTurn(props(), props({ tools: { t1: run('more') } }))).toBe(false);
    expect(sameTurn(props(), props({ results: { t1: { type: 'tool_result', toolUseId: 't1', content: 'ok' } } }))).toBe(false);
    expect(sameTurn(props(), props({ streaming: { a1: true } }))).toBe(false);
    expect(sameTurn(props(), props({ messages: [{ ...done }] }))).toBe(false);
  });
});
