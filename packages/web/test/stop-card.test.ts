/**
 * "Why did this turn stop" (src/features/chat/stopCard.ts): the reason, the
 * evidence and the next step, and a quiet task's words.
 *
 *   bun test packages/web/test/stop-card.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import { activity, stopCard } from '../src/features/chat/stopCard';
import { applyEvent, lastActiveAt } from '../src/store/store';

const session = (p: Partial<Session> = {}) => ({ id: 's1', status: 'idle', ...p }) as Session;
let seq = 0;
const msg = (p: Partial<Message> & { text?: string }): Message => {
  const { text, ...rest } = p;
  const content: ContentBlock[] = [{ type: 'text', text: text ?? '' }];
  return { id: `m${++seq}`, sessionId: 's1', seq, role: 'assistant', kind: 'normal', content, createdAt: 1, ...rest };
};
const notice = (text: string, meta?: Record<string, unknown>) => msg({ kind: 'notice', text, ...(meta ? { meta } : {}) });

describe('stopCard', () => {
  test('a refused reply says so, and offers the next model when the hub does', () => {
    const reply = msg({ text: 'I can not help with that part.', stopReason: 'refusal' });
    const c = stopCard(session(), [msg({ role: 'user', text: 'hi' }), reply, notice('x declined to continue.', { type: 'refusal', canTryNext: true })]);
    expect(c).toMatchObject({ kind: 'refusal', evidence: 'I can not help with that part.', next: 'Try the next model.' });
    expect(stopCard(session(), [reply])?.next).toBe('Rephrase, or switch model.');
  });
  test('a provider error quotes the notice and offers a retry', () => {
    const c = stopCard(session({ status: 'error' }), [notice('Error: Rejected with 402.', { type: 'provider_error', canRetry: true, level: 'error' })]);
    expect(c).toMatchObject({ kind: 'provider', evidence: 'Rejected with 402.', next: 'Retry with another model.' });
  });
  test('a limit says when it resumes', () => {
    const c = stopCard(session({ status: 'waiting_reset', resumeAt: 1_800_000_000_000 }), [notice('Usage limit reached.', { type: 'limit' })]);
    expect(c).toMatchObject({ kind: 'limit', evidence: 'Usage limit reached.' });
    expect(c?.next).toStartWith('It resumes at ');
  });
  test('a turn the owner cut', () => {
    const cut = msg({ text: 'Part of', stopReason: 'aborted' });
    expect(stopCard(session(), [msg({ role: 'user', text: 'go' }), cut, notice('Stopped', { level: 'info' })])?.kind).toBe('stopped');
    expect(stopCard(session({ meta: { stoppedTurn: true } }), [cut, notice('Stopped', { level: 'info' })])?.kind).toBe('stopped');
    expect(stopCard(session(), [cut])).toBeUndefined();
    // a Stop during a tool run where the turn can not resume (a task child): the reply ended on tool_use
    expect(stopCard(session(), [msg({ text: 'Running', stopReason: 'tool_use' }), notice('Stopped', { level: 'info' })])?.kind).toBe('stopped');
  });
  test('a turn a hub restart cut is interrupted, not stopped by you', () => {
    // engine.ts sets stoppedTurn on every session left running at startup, with no "Stopped" notice
    const restarted = session({ meta: { stoppedTurn: true } });
    expect(stopCard(restarted, [msg({ role: 'user', text: 'go' }), msg({ text: 'Part of' })])).toMatchObject({ kind: 'interrupted', title: 'Interrupted', next: 'Resume to go on.' });
    expect(stopCard(restarted, [])?.kind).toBe('interrupted');
    // a "Stopped" notice from an earlier turn does not count
    expect(stopCard(restarted, [notice('Stopped', { level: 'info' }), msg({ role: 'user', text: 'again' })])?.kind).toBe('interrupted');
  });
  test('an aborted reply with an error notice on an idle session is the provider, not you', () => {
    const cut = msg({ text: 'Part of', stopReason: 'aborted' });
    expect(stopCard(session(), [cut, notice('acp error: boom', { level: 'error' })])).toMatchObject({ kind: 'provider', title: 'Provider error', evidence: 'acp error: boom' });
    expect(stopCard(session(), [cut, notice('The harness hit its output limit.', { level: 'warning' })])).toMatchObject({ kind: 'provider', title: 'Stopped early' });
    // an older notice does not count
    const old = notice('old', { level: 'error' });
    expect(stopCard(session(), [old, msg({ text: 'Part of', stopReason: 'aborted' })])).toBeUndefined();
  });
  test('a running session with a stuck alert is stalled; without one, nothing', () => {
    expect(stopCard(session({ status: 'running' }), [], { stuckSince: 1_800_000_000_000 })?.kind).toBe('stalled');
    expect(stopCard(session({ status: 'running' }), [])).toBeUndefined();
  });
  test('a finished turn and a newer message of yours have no card', () => {
    expect(stopCard(session(), [msg({ text: 'Done.', stopReason: 'end_turn' })])).toBeUndefined();
    expect(stopCard(session(), [msg({ stopReason: 'refusal', text: 'No.' }), msg({ role: 'user', text: 'ok then' })])).toBeUndefined();
  });
});

describe('activity', () => {
  test('a task that streams and runs tools is not quiet, though session.updatedAt is old', () => {
    const NOW = 1_800_000_000_000;
    const updatedAt = NOW - 6 * 60_000;
    expect(activity(updatedAt, NOW)?.quiet).toBe(true);
    const base = { seq: 1, ts: NOW - 10_000 };
    applyEvent({ ...base, type: 'message.delta', sessionId: 'child1', messageId: 'm1', index: 0, kind: 'text', text: 'hi' } as Parameters<typeof applyEvent>[0]);
    expect(lastActiveAt('child1')).toBe(NOW - 10_000);
    applyEvent({ ...base, ts: NOW - 5_000, type: 'tool.started', sessionId: 'child1', messageId: 'm1', toolUseId: 't1', name: 'Bash', input: {} } as Parameters<typeof applyEvent>[0]);
    expect(activity(Math.max(updatedAt, lastActiveAt('child1') ?? 0), NOW)).toEqual({ text: 'Active now', quiet: false });
  });
  const NOW = 1_800_000_000_000;
  test('recent is active, 5 min of silence is quiet', () => {
    expect(activity(NOW - 10_000, NOW)).toEqual({ text: 'Active now', quiet: false });
    expect(activity(NOW - 120_000, NOW)).toEqual({ text: 'Active 2 min ago', quiet: false });
    expect(activity(NOW - 7 * 60_000, NOW)).toEqual({ text: 'No activity for 7 min', quiet: true });
    expect(activity(undefined, NOW)).toBeUndefined();
  });
});
