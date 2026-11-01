/**
 * A background task that reported back (src/features/chat/agentResult.ts,
 * AgentResultRow.tsx): the hub's notice line and the reminder only message
 * that hands the report to the model read as one compact row, "Message from
 * subagent count widgets", that opens to the report. A user message with
 * nothing the owner wrote never draws an empty bubble.
 *
 *   bun test packages/web/test/agent-result.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { Message, Session } from '@conclave/core/types';
import { AgentResultRow } from '../src/features/chat/AgentResultRow';
import { NoticeLine } from '../src/features/chat/Notices';
import { Bubble } from '../src/features/chat/PhoneTranscript';
import { buildUnits } from '../src/features/chat/MessageList';
import { buildUnits as chatUnits } from '../src/features/conversation/units';
import { agentResultWords, noticeResult, reportFor, resultsIn, type AgentResultRef } from '../src/features/chat/agentResult';
import { isContextOnly } from '../src/features/chat/util';

const session = { id: 's1', agent: 'coder', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', status: 'idle' } as Session;
const ref: AgentResultRef = { type: 'subagent', id: 'ses_child', label: 'count widgets', agent: 'general-purpose', state: 'completed' };
const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const reportBlock = wrap(`A background subagent you started has finished. Its final report:\n<subagent_result session="ses_child" agent="general-purpose" state="completed" description="count widgets">\n**42** widgets in \`src/\`.\n</subagent_result>`);

const msg = (id: string, seq: number, m: Partial<Message>): Message => ({ id, sessionId: 's1', seq, role: 'user', kind: 'normal', content: [], createdAt: 1_800_000_000_000 + seq, ...m }) as Message;
const notice = msg('n1', 3, { role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'Background task finished: count widgets' }], meta: { level: 'info', kind: 'agent-result', agentResult: ref } });
const carrier = msg('u2', 4, { content: [{ type: 'text', text: reportBlock }], meta: { auto: true, kind: 'agent-result', agentResults: [ref] } });
const html = (node: React.ReactNode) => renderToStaticMarkup(<Router ssrPath="/s/s1">{node}</Router>);

describe('a finished background task', () => {
  test('reads as one row with its label and state', () => {
    const closed = html(<AgentResultRow result={ref} report="**42** widgets" />);
    expect(closed).toContain('Message from subagent count widgets');
    expect(closed).toContain('>done<');
    expect(closed).toContain('aria-expanded="false"');
    // closed: no report yet
    expect(closed).not.toContain('42');
    const failed = html(<AgentResultRow result={{ ...ref, state: 'failed' }} />);
    expect(failed).toMatch(/class="[^"]*text-fault[^"]*">failed</);
    expect(agentResultWords({ type: 'workflow', id: 'wfr_1', label: 'deep-research', state: 'stopped' })).toEqual({ title: 'Message from workflow deep-research', state: 'stopped' });
  });

  test('opens to the report as markdown at a capped height, with a link to the subagent', () => {
    const open = html(<AgentResultRow result={ref} report="**42** widgets" defaultOpen />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('<strong>42</strong> widgets');
    expect(open).toContain('max-h-[320px]');
    expect(open).toContain('overflow-y-auto');
    expect(open).toContain('href="/s/ses_child"');
    const run = html(<AgentResultRow result={{ type: 'workflow', id: 'wfr_1', label: 'deep-research', state: 'completed' }} report="done" defaultOpen />);
    expect(run).toContain('href="/workflows/runs/wfr_1"');
    expect(run).toContain('Message from workflow deep-research');
  });

  test('the notice line is the row, and the report comes from the message that carries it', () => {
    expect(noticeResult(notice)).toEqual(ref);
    const line = html(<NoticeLine message={notice} session={session} />);
    expect(line).toContain('Message from subagent count widgets');
    expect(line).not.toContain('Background task finished');
    expect(resultsIn(carrier)).toEqual([{ ...ref, report: '**42** widgets in `src/`.' }]);
    expect(reportFor([notice, carrier], ref, notice.seq)).toBe('**42** widgets in `src/`.');
    // a hub from before the meta: the words alone, the report matched by its label
    const old = msg('n0', 3, { role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'Background task failed: count widgets' }], meta: { level: 'warning' } });
    const oldRef = noticeResult(old)!;
    expect(oldRef).toMatchObject({ type: 'subagent', label: 'count widgets', state: 'failed' });
    expect(reportFor([old, carrier], oldRef, old.seq)).toBe('**42** widgets in `src/`.');
    expect(noticeResult(msg('n2', 5, { role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'Switched to GPT-5.5' }] }))).toBeUndefined();
  });

  test('the log draws one row for it: the notice, and no bubble for the reminder message', () => {
    const list = [msg('u1', 1, { content: [{ type: 'text', text: 'start' }] }), msg('a1', 2, { role: 'assistant', content: [{ type: 'text', text: 'Started it.' }], stopReason: 'end_turn' }), notice, carrier, msg('a2', 5, { role: 'assistant', content: [{ type: 'text', text: '42 it is.' }], stopReason: 'end_turn' })];
    const units = buildUnits(list, session);
    expect(units.map((u) => u.kind)).toEqual(['user', 'turn', 'notice', 'turn']);
    expect(units.filter((u) => u.kind === 'user').map((u) => (u as { message: Message }).message.id)).toEqual(['u1']);
    // the Chat page too
    expect(chatUnits(list).filter((u) => u.kind === 'user').map((u) => u.key)).toEqual(['u1']);
  });
});

describe('a user message with nothing the owner wrote', () => {
  const hook = msg('u3', 6, { content: [{ type: 'text', text: wrap('Stop hook feedback:\nrun the tests') }], meta: { auto: true } });
  const mixed = msg('u4', 7, { content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }, { type: 'text', text: reportBlock }] });
  const blank = msg('u5', 8, { content: [{ type: 'text', text: '  ' }] });

  test('is hub context: hook feedback, tool results with a note after them, blank text', () => {
    for (const m of [hook, mixed, blank, msg('u6', 9, {})]) expect(isContextOnly(m)).toBe(true);
    expect(isContextOnly(msg('u7', 10, { content: [{ type: 'text', text: 'hi' }, { type: 'text', text: wrap('recalled') }] }))).toBe(false);
    expect(isContextOnly(msg('u8', 11, { content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }))).toBe(false);
  });

  test('draws no bubble on the phone or in the log', () => {
    expect(html(<Bubble message={msg('u0', 1, { content: [{ type: 'text', text: 'mine' }] })} />)).toContain('rounded-[20px]');
    expect(html(<Bubble message={hook} />)).not.toContain('rounded-[20px]');
    const list = [msg('u1', 1, { content: [{ type: 'text', text: 'go' }] }), msg('a1', 2, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: {} }], stopReason: 'tool_use' }), mixed, hook, blank, msg('a2', 9, { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' })];
    expect(buildUnits(list, session).filter((u) => u.kind === 'user')).toHaveLength(1);
    expect(chatUnits(list).filter((u) => u.kind === 'user')).toHaveLength(1);
  });
});
