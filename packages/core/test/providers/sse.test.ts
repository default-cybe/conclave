import { describe, expect, test } from 'bun:test';
import { SseParser, parseSse, parseSseJson } from '../../src/providers/sse';
import { ProviderError } from '../../src/providers/types';

function bodyFrom(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      ctrl.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const m of parseSse(stream)) out.push(m);
  return out;
}

describe('SseParser', () => {
  test('LF, CRLF and CR line endings', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const p = new SseParser();
      const msgs = p.push(`event: a${eol}data: one${eol}${eol}data: two${eol}${eol}`);
      expect(msgs).toEqual([
        { event: 'a', data: 'one', id: undefined },
        { event: 'message', data: 'two', id: undefined },
      ]);
    }
  });

  test('multi-line data, comments, id and missing space after colon', () => {
    const p = new SseParser();
    const msgs = p.push(': keep-alive\nid: 7\ndata:first\ndata: second\n\n');
    expect(msgs).toEqual([{ event: 'message', data: 'first\nsecond', id: '7' }]);
  });

  test('CRLF split across chunks does not create an empty event boundary', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\ndata: b\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'message', data: 'a\nb', id: undefined }]);
  });

  test('flushes a final event without trailing blank line', () => {
    const p = new SseParser();
    expect(p.push('data: tail', true)).toEqual([{ event: 'message', data: 'tail', id: undefined }]);
  });

  test('strips a leading BOM', () => {
    const p = new SseParser();
    expect(p.push('﻿data: x\n\n')).toEqual([{ event: 'message', data: 'x', id: undefined }]);
  });
});

describe('parseSse', () => {
  test('handles byte-level chunking including split multi-byte characters', async () => {
    const text = 'event: delta\ndata: {"t":"héllo 🌍"}\n\ndata: [DONE]\n\ndata: ignored\n\n';
    const bytes = new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
    const msgs = await all(bodyFrom(chunks));
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0].data)).toEqual({ t: 'héllo 🌍' });
    expect(msgs[0].event).toBe('delta');
  });

  test('stops at [DONE]', async () => {
    const msgs = await all(bodyFrom(['data: 1\n\n', 'data: [DONE]\n\n', 'data: 2\n\n']));
    expect(msgs.map((m) => m.data)).toEqual(['1']);
  });

  test('idle timeout raises a network error', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    let err: unknown;
    try {
      for await (const _ of parseSse(stream, { idleTimeoutMs: 30, provider: 'x' })) void _;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
  });

  test('abort raises an aborted error', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    let err: unknown;
    try {
      for await (const _ of parseSse(stream, { signal: ctrl.signal })) void _;
    } catch (e) {
      err = e;
    }
    expect((err as ProviderError).kind).toBe('aborted');
  });
});

describe('parseSseJson', () => {
  test('parses one object or several lines', () => {
    expect(parseSseJson('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseSseJson('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseSseJson('not json')).toEqual([]);
  });
});
