import { describe, expect, test } from 'bun:test';
import type { Message } from '@conclave/core/types.ts';
import { findBoundaries, TranscriptStore } from '../src/tui/transcript';

let seq = 0;
function msg(p: Partial<Message> & Pick<Message, 'role'>): Message {
  seq++;
  return { id: `m${seq}`, sessionId: 's', seq, kind: 'normal', content: [], createdAt: seq, ...p };
}

describe('findBoundaries', () => {
  test('splits at blank lines outside fences', () => {
    const text = 'para one\n\npara two\n\n```\ncode\n\nmore code\n```\n\nafter';
    const b = findBoundaries(text, 0);
    expect(b.map((i) => text.slice(0, i))).toEqual(['para one\n\n', 'para one\n\npara two\n\n', 'para one\n\npara two\n\n```\ncode\n\nmore code\n```\n\n']);
  });

  test('no boundary until text continues after the blank line', () => {
    expect(findBoundaries('para one\n\n', 0)).toEqual([]);
  });
});

describe('TranscriptStore', () => {
  test('streaming text commits finished paragraphs and keeps the tail live', () => {
    const st = new TranscriptStore();
    st.setActive(true);
    const user = msg({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    st.upsert(user, true);
    const a = msg({ role: 'assistant', model: 'x/y' });
    st.upsert(a, true);
    st.delta({ messageId: a.id, sessionId: 's', index: 0, kind: 'text', text: 'First para.\n\nSecond' });
    let r = st.build();
    expect(r.committed.map((i) => i.kind)).toEqual(['user', 'text']);
    expect(r.committed[1]).toMatchObject({ text: 'First para.', first: true });
    expect(r.live).toHaveLength(1);
    expect(r.live[0]).toMatchObject({ kind: 'text', text: 'Second', final: false, first: false });

    st.delta({ messageId: a.id, sessionId: 's', index: 0, kind: 'text', text: ' para.' });
    st.upsert({ ...a, content: [{ type: 'text', text: 'First para.\n\nSecond para.' }], stopReason: 'end_turn' }, false);
    r = st.build();
    expect(r.live).toHaveLength(0);
    expect(r.committed.map((i) => (i.kind === 'text' ? i.text : i.kind))).toEqual(['user', 'First para.', 'Second para.']);
  });

  test('a running tool holds back later items until its result arrives', () => {
    const st = new TranscriptStore();
    st.setActive(true);
    const a = msg({ role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }], stopReason: 'tool_use' });
    st.upsert(a, true);
    st.toolStarted('t1', 'Read', { file_path: '/a' });
    st.addLocal({ kind: 'info', text: 'later note' });
    let r = st.build();
    expect(r.committed.map((i) => i.kind)).toEqual(['text']);
    expect(r.live.map((i) => i.kind)).toEqual(['tool', 'info']);
    expect(r.live[0]).toMatchObject({ status: 'running' });

    st.upsert(msg({ role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '1\tline' }] }), true);
    r = st.build();
    expect(r.live).toHaveLength(0);
    expect(r.committed.map((i) => i.kind)).toEqual(['text', 'tool', 'info']);
    expect(r.committed[1]).toMatchObject({ status: 'done' });
  });

  test('approval wait shows on the tool', () => {
    const st = new TranscriptStore();
    st.setActive(true);
    st.upsert(msg({ role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }], stopReason: 'tool_use' }), true);
    st.setWaiting(['t9']);
    expect(st.build().live[0]).toMatchObject({ kind: 'tool', status: 'waiting' });
  });

  test('tools without a result become interrupted when the session stops', () => {
    const st = new TranscriptStore();
    st.setActive(true);
    st.upsert(msg({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'sleep 100' } }], stopReason: 'tool_use' }), true);
    st.toolStarted('t2', 'Bash', {});
    expect(st.build().live).toHaveLength(1);
    st.setActive(false);
    const r = st.build();
    expect(r.live).toHaveLength(0);
    expect(r.committed.at(-1)).toMatchObject({ kind: 'tool', status: 'interrupted' });
  });

  test('thinking and asides with labels', () => {
    const st = new TranscriptStore();
    st.upsert(msg({ role: 'assistant', model: 'a/b', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Answer' }], stopReason: 'end_turn' }), true);
    st.upsert(msg({ role: 'assistant', kind: 'aside', author: 'Second opinion', model: 'openai/gpt-5.5', content: [{ type: 'text', text: 'Looks fine' }], stopReason: 'end_turn' }), true);
    const r = st.build();
    expect(r.committed.map((i) => i.kind)).toEqual(['thinking', 'text', 'label', 'text']);
    expect(r.committed[2]).toMatchObject({ text: 'Second opinion', model: 'openai/gpt-5.5' });
    expect(r.committed[3]).toMatchObject({ aside: true });
  });

  test('jurors show before a verdict that was created first', () => {
    const st = new TranscriptStore();
    st.setActive(true);
    const verdict = msg({ role: 'assistant', group: 'g' });
    st.upsert(verdict, true);
    st.build();
    st.upsert(msg({ role: 'assistant', kind: 'aside', group: 'g', author: 'Juror 1', model: 'a/x', content: [{ type: 'text', text: 'one' }], stopReason: 'end_turn' }), true);
    st.upsert(msg({ role: 'assistant', kind: 'aside', group: 'g', author: 'Juror 2', model: 'b/y', content: [{ type: 'text', text: 'two' }], stopReason: 'end_turn' }), true);
    st.upsert({ ...verdict, content: [{ type: 'text', text: 'verdict' }], stopReason: 'end_turn' }, false);
    st.setActive(false);
    const labels = st
      .build()
      .committed.filter((i) => i.kind === 'label')
      .map((i) => (i as { text: string }).text);
    expect(labels).toEqual(['Juror 1', 'Juror 2', 'Verdict']);
  });

  test('tool_result only user messages render nothing', () => {
    const st = new TranscriptStore();
    st.upsert(msg({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'zz', content: 'x' }] }), true);
    expect(st.build().committed).toHaveLength(0);
  });

  test('recommit shows only the last entries with a marker', () => {
    const st = new TranscriptStore();
    for (let i = 0; i < 10; i++) st.addLocal({ kind: 'info', text: `n${i}` });
    st.build();
    st.recommit(3);
    const r = st.build();
    expect(r.committed.map((i) => (i as { text: string }).text.replace(/\x1b\[[0-9;]*m/g, ''))).toEqual(['… 7 earlier entries not shown (/export for the full transcript)', 'n7', 'n8', 'n9']);
  });

  test('a delta for an unknown message creates it', () => {
    const st = new TranscriptStore();
    st.setActive(true);
    st.delta({ messageId: 'new', sessionId: 's', index: 0, kind: 'text', text: 'hello' });
    expect(st.build().live[0]).toMatchObject({ kind: 'text', text: 'hello' });
  });
});
