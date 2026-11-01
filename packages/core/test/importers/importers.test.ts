import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertClaudeCode, convertCodex } from '../../src/importers';
import { cleanUserText } from '../../src/importers/claude-code';
import { parseJsonl } from '../../src/importers/files';
import { FIXTURE_HOME, PATHS, cleanupFixtureHomes } from './fixture-home';

afterAll(cleanupFixtureHomes);

const read = (rel: string) => readFileSync(join(FIXTURE_HOME, rel), 'utf8');

describe('Claude Code transcript conversion', () => {
  const msgs = convertClaudeCode(read(PATHS.claudeA)).messages;

  test('keeps real turns, merges split assistant lines and parallel tool results', () => {
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[0].content).toEqual([{ type: 'text', text: '/model opus' }]);
    expect(msgs[1].content).toEqual([{ type: 'text', text: 'Please fix the login bug in auth.ts' }]);

    const a1 = msgs[2];
    expect(a1.model).toBe('anthropic/claude-sonnet-4-5-20250929');
    expect(a1.stopReason).toBe('tool_use');
    expect(a1.usage).toEqual({ inputTokens: 10, outputTokens: 120, cacheReadTokens: 5000, cacheWriteTokens: 1000 });
    expect(a1.content).toEqual([
      { type: 'thinking', thinking: 'Let me look at auth.ts', signature: 'sig1' },
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/home/u/proj/auth.ts' } },
      { type: 'tool_use', id: 'toolu_02', name: 'Grep', input: { pattern: 'login' } },
    ]);

    expect(msgs[3].content).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_01', content: 'export function login() {}', meta: { external: true } },
      { type: 'tool_result', toolUseId: 'toolu_02', content: 'auth.ts:1', meta: { external: true } },
    ]);
    expect(msgs[4].content).toEqual([{ type: 'text', text: 'Fixed it.' }]);
    expect(msgs[5].content).toEqual([
      { type: 'text', text: 'Thanks! Now add a test.' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
    expect(msgs[1].createdAt).toBe(Date.parse('2025-10-01T10:00:00.000Z'));
    expect(msgs.every((m) => m.kind === 'normal')).toBe(true);
  });

  test('skips sidechain, synthetic and bookkeeping lines', () => {
    const all = JSON.stringify(msgs);
    expect(all).not.toContain('subagent work');
    expect(all).not.toContain('No response requested');
    expect(all).not.toContain('Caveat');
    expect(all).not.toContain('Set model to opus');
  });

  test('cleanUserText', () => {
    expect(cleanUserText('<bash-input>ls -la</bash-input>')).toBe('!ls -la');
    expect(cleanUserText('<bash-stdout>x</bash-stdout>')).toBeUndefined();
    expect(cleanUserText('<command-name>clear</command-name>')).toBe('/clear');
  });
});

describe('Claude Code compaction boundaries', () => {
  const u = (uuid: string, parentUuid: string | null, text: string, extra: object = {}) => ({ type: 'user', uuid, parentUuid, sessionId: 's', message: { role: 'user', content: text }, ...extra });
  const a = (uuid: string, parentUuid: string, text: string) => ({ type: 'assistant', uuid, parentUuid, sessionId: 's', message: { id: 'm' + uuid, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } });
  const boundary = (uuid: string, extra: object) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, content: 'Conversation compacted', ...extra });
  const att = (uuid: string, parentUuid: string) => ({ type: 'attachment', uuid, parentUuid, attachment: { type: 'file' } });
  // June, a rewound prompt, compaction 1, September, compaction 2, October
  const file = (b2: object, afterB2: object[]) =>
    [
      u('u1', null, 'June prompt'),
      a('a1', 'u1', 'June reply'),
      u('x1', 'u1', 'rewound prompt'),
      boundary('b1', { logicalParentUuid: 'a1' }),
      u('s1', 'b1', 'summary 1', { isCompactSummary: true }),
      u('u2', 's1', 'Sept prompt'),
      a('a2', 'u2', 'Sept reply'),
      boundary('b2', b2),
      ...afterB2,
      { type: 'last-prompt', leafUuid: 'u3', sessionId: 's' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
  const texts = (text: string) => convertClaudeCode(text).messages.map((m) => `${m.kind}:${(m.content[0] as { text: string }).text}`);
  const whole = ['normal:June prompt', 'normal:June reply', 'summary:summary 1', 'normal:Sept prompt', 'normal:Sept reply', 'summary:summary 2', 'normal:Oct prompt', 'normal:Oct reply'];
  const plain = [u('s2', 'b2', 'summary 2', { isCompactSummary: true }), u('u3', 's2', 'Oct prompt'), a('a3', 'u3', 'Oct reply')];

  test('a boundary whose logical parent is a preserved tail written after it, looping back, keeps the whole history once', () => {
    // the tail p1 hangs off the summary, a preserved reply is re-written under it, and the boundary points at p1
    const tail = [u('s2', 'b2', 'summary 2', { isCompactSummary: true }), att('p1', 's2'), a('a2', 'p1', 'Sept reply'), u('u3', 'a2', 'Oct prompt'), a('a3', 'u3', 'Oct reply')];
    const b2 = { logicalParentUuid: 'p1', compactMetadata: { preservedSegment: { tailUuid: 'p1' } } };
    expect(texts(file(b2, tail))).toEqual(whole);
  });

  test('a boundary with no logical parent, or a dead one, continues from the line before it', () => {
    expect(texts(file({}, plain))).toEqual(whole);
    expect(texts(file({ logicalParentUuid: 'gone' }, plain))).toEqual(whole);
  });

  test('a healthy boundary imports as before', () => {
    expect(texts(file({ logicalParentUuid: 'a2' }, plain))).toEqual(whole);
  });
});

describe('Codex transcript conversion', () => {
  test('groups assistant items and maps tool calls and outputs', () => {
    const msgs = convertCodex(read(PATHS.codexC)).messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'List the files' }]);
    expect(msgs[1]).toMatchObject({ model: 'openai/gpt-5-codex' });
    expect(msgs[1].content).toEqual([
      { type: 'thinking', thinking: '**Listing files**' },
      { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: ['bash', '-lc', 'ls'], workdir: '/home/u/proj' } },
    ]);
    expect(msgs[2].content).toEqual([{ type: 'tool_result', toolUseId: 'call_1', content: 'a.txt\nb.txt\n', meta: { external: true, exitCode: 0 } }]);
    expect(msgs[3].content).toEqual([{ type: 'text', text: 'There are two files.' }]);
    expect(msgs[4].content).toEqual([{ type: 'text', text: 'Add c.txt' }]);
    expect(msgs[5].content[0]).toMatchObject({ type: 'tool_use', id: 'call_2', name: 'apply_patch' });
    expect(msgs[6].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call_2', content: 'Success. Updated the following files:\nA c.txt\n' });
    expect(msgs[8].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call_3', isError: true, meta: { external: true, exitCode: 1 } });
    expect(JSON.stringify(msgs)).not.toContain('environment_context');
    expect(JSON.stringify(msgs)).not.toContain('user_instructions');
  });

  test('falls back to UI events for old rollouts', () => {
    const msgs = convertCodex(read(PATHS.codexD)).messages;
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', [{ type: 'text', text: 'Old style prompt' }]],
      ['assistant', [{ type: 'text', text: 'Old style answer' }]],
    ]);
  });

  test('tolerates garbage and unknown line types', () => {
    const text = '{"type":"mystery","payload":{}}\nnot json\n{"timestamp":"2025-01-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}';
    expect(convertCodex(text).messages).toHaveLength(1);
  });
});

describe('parseJsonl', () => {
  test('leaves an unterminated tail for the next read and reports byte offsets', () => {
    const text = '{"a":1}\n{"b":"é"}\n{"c":';
    const lines = parseJsonl(text);
    expect(lines.map((l) => l.value)).toEqual([{ a: 1 }, { b: 'é' }]);
    expect(lines[1].end).toBe(Buffer.byteLength('{"a":1}\n{"b":"é"}\n'));
    expect(parseJsonl(text, { startByte: lines[0].end }).map((l) => l.value)).toEqual([{ b: 'é' }]);
  });
});
