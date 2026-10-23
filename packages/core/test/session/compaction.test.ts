import { describe, expect, test } from 'bun:test';
import {
  anchorIndex,
  anchorSection,
  auditSummary,
  deterministicSections,
  filesTouched,
  FILES_TOUCHED_MAX,
  meteredTokens,
  recentToKeep,
  SUMMARY_INPUT_CHARS,
  summarizerInput,
  VERBATIM_MESSAGE_CHARS,
  VERBATIM_TOTAL_CHARS,
  verbatimUserMessages,
} from '../../src/session/compaction';
import { buildProviderMessages, reminder, renderTranscript } from '../../src/session/transcript';
import { SUMMARY_HEADINGS } from '../../src/session/prompt';
import type { ContentBlock, Message } from '../../src/types';

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `msg_${seq}`, sessionId: 'ses_x', seq, role, kind: 'normal', content, createdAt: seq, ...extra };
}
const user = (text: string, extra: Partial<Message> = {}) => msg('user', [{ type: 'text', text }], extra);

describe('verbatim user messages', () => {
  test('newest first; reminders and tool results skipped; a routine prompt (auto, plain text) kept', () => {
    const region = [
      user('first ask'),
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }]),
      msg('user', [{ type: 'tool_result', toolUseId: 't1', content: 'file text' }]),
      msg('user', [reminder('Stop hook feedback: go on')], { meta: { auto: true } }),
      msg('user', [{ type: 'text', text: 'second ask' }, reminder('Relevant memories: x')]),
      msg('user', [reminder('only a reminder')]),
      user('a routine prompt', { meta: { auto: true } }),
    ];
    const { quoted, omitted } = verbatimUserMessages(region);
    expect(quoted).toEqual(['a routine prompt', 'second ask', 'first ask']);
    expect(omitted).toBe(0);
  });

  test('each message is cut at the per-message cap and the total cap drops the oldest', () => {
    const long = 'x'.repeat(VERBATIM_MESSAGE_CHARS + 500);
    const cut = verbatimUserMessages([user(long)]).quoted[0];
    expect(cut.startsWith('x'.repeat(VERBATIM_MESSAGE_CHARS))).toBe(true);
    expect(cut).toContain('[... 500 chars cut]');

    const many = Array.from({ length: 10 }, (_, i) => user(`${i}`.repeat(VERBATIM_MESSAGE_CHARS)));
    const { quoted, omitted } = verbatimUserMessages(many);
    expect(quoted.join('').length).toBeLessThanOrEqual(VERBATIM_TOTAL_CHARS);
    expect(quoted[0][0]).toBe('9');
    expect(omitted).toBe(10 - quoted.length);
    expect(omitted).toBeGreaterThan(0);
  });

  test('messages quoted by an earlier summary follow the region ones', () => {
    expect(verbatimUserMessages([user('new ask')], ['old ask']).quoted).toEqual(['new ask', 'old ask']);
  });

  test('a message cut by an earlier summary is carried as it is, not cut again', () => {
    const long = 'y'.repeat(VERBATIM_MESSAGE_CHARS + 500);
    const first = verbatimUserMessages([user(long)]).quoted;
    const second = verbatimUserMessages([user('newer')], first).quoted;
    expect(second[1]).toBe(first[0]);
    expect(second[1]).toContain('[... 500 chars cut]');
    expect(second[1].match(/chars cut/g)).toHaveLength(1);
  });
});

describe('files touched', () => {
  test('newest first, no repeats, notebook paths included, capped', () => {
    const uses = (name: string, input: Record<string, unknown>) => msg('assistant', [{ type: 'tool_use', id: `t${seq}`, name, input }]);
    const region = [
      uses('Read', { file_path: '/a.ts' }),
      uses('Edit', { file_path: '/b.ts', old_string: 'x', new_string: 'y' }),
      uses('Grep', { pattern: 'x', path: '/c' }),
      uses('NotebookEdit', { notebook_path: '/n.ipynb' }),
      uses('Write', { file_path: '/a.ts', content: '' }),
    ];
    expect(filesTouched(region, ['/old.ts', '/b.ts'])).toEqual(['/a.ts', '/n.ipynb', '/b.ts', '/old.ts']);
    const lots = Array.from({ length: FILES_TOUCHED_MAX + 10 }, (_, i) => uses('Read', { file_path: `/f${i}` }));
    expect(filesTouched(lots)).toHaveLength(FILES_TOUCHED_MAX);
  });

  test('sections render only what exists', () => {
    expect(deterministicSections([], 0, [])).toBe('');
    const text = deterministicSections(['line one\nline two'], 2, ['/a.ts']);
    expect(text).toContain('## User messages (verbatim, newest first)\n\n1. line one\n   line two');
    expect(text).toContain('(2 older user messages not quoted.)');
    expect(text).toContain('## Files touched\n\n- /a.ts');
  });
});

describe('summary wrapper', () => {
  test('says the summary comes from the framework, not the user', () => {
    const msgs = [msg('user', [{ type: 'text', text: 'the summary' }], { kind: 'summary', meta: { coversThroughSeq: 0 } }), user('next')];
    const out = buildProviderMessages(msgs, { modelRef: 'm/x', toolNames: new Set(), cache: false });
    const text = JSON.stringify(out);
    expect(text).toContain('<conversation_summary>');
    expect(text).toContain('not a message from the user');
  });
});

describe('thinking after a summary (Anthropic prefix check)', () => {
  const think = (t: string): ContentBlock => ({ type: 'thinking', thinking: t, signature: `sig-${t}` });
  const thinkingOf = (out: ReturnType<typeof buildProviderMessages>) => out.flatMap((m) => m.content).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  const opts = { modelRef: 'anthropic/claude-opus-5-5', toolNames: new Set(['Bash']), cache: false };
  const reply = (blocks: ContentBlock[]) => msg('assistant', blocks, { model: 'anthropic/claude-opus-5-5' });

  test('without a summary the same model replays its own thinking, and another model never does', () => {
    const msgs = [
      user('ask'),
      reply([think('A'), { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]),
      msg('user', [{ type: 'tool_result', toolUseId: 'tu1', content: 'files' }]),
      reply([think('B'), { type: 'text', text: 'done' }]),
      msg('assistant', [think('OTHER'), { type: 'text', text: 'from gpt' }], { model: 'openai/gpt-5.5' }),
      user('next'),
    ];
    const got = thinkingOf(buildProviderMessages(msgs, opts)).map((b) => (b as { thinking: string }).thinking);
    expect(got).toEqual(['A', 'B']);
  });

  test('an ordinary auto compaction: the turns kept word for word go without thinking; text and tool calls stay', () => {
    const old = [user('old ask'), reply([think('OLD'), { type: 'text', text: 'old answer' }])];
    const kept = [
      user('recent ask'),
      reply([think('KEPT-1'), { type: 'redacted_thinking', data: 'enc' }, { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'pwd' } }]),
      msg('user', [{ type: 'tool_result', toolUseId: 'tu2', content: '/repo' }]),
      reply([think('KEPT-2'), { type: 'text', text: 'recent answer' }]),
    ];
    const summary = msg('user', [{ type: 'text', text: 'the summary' }], { kind: 'summary', meta: { coversThroughSeq: old[1].seq, trigger: 'auto' } });
    const after = [user('new ask'), reply([think('AFTER'), { type: 'text', text: 'new answer' }]), user('go on')];
    const all = [...old, ...kept, summary, ...after];
    const out = buildProviderMessages(all, opts);
    expect(thinkingOf(out).map((b) => (b as { thinking: string }).thinking)).toEqual(['AFTER']);
    const text = JSON.stringify(out);
    expect(text).toContain('recent answer');
    expect(text).toContain('"name":"Bash"');
    expect(text).toContain('/repo');
    expect(text).not.toContain('KEPT-');
    expect(text).not.toContain('"enc"');
    // the same bytes on every later request (a restart rebuilds the same)
    expect(JSON.stringify(buildProviderMessages(all, opts))).toBe(text);
  });

  test('a summary written without the model, and a manual one, follow the same rule', () => {
    for (const meta of [{ trigger: 'auto', fallback: 'no_llm', qualityDegraded: true }, { trigger: 'manual' }]) {
      const kept = [user('ask'), reply([think('K'), { type: 'text', text: 'a' }])];
      const summary = msg('user', [{ type: 'text', text: 's' }], { kind: 'summary', meta: { coversThroughSeq: kept[0].seq - 1, ...meta } });
      expect(thinkingOf(buildProviderMessages([...kept, summary, user('more')], opts))).toHaveLength(0);
    }
  });
});

describe('token meter', () => {
  const meter = { model: 'm/x', systemHash: 's', toolsHash: 't', baseTokens: 50_000, throughSeq: 0 };
  test('base tokens plus chars/4 of what was stored after the metered reply', () => {
    const ask = user('ask');
    const reply = msg('assistant', [{ type: 'text', text: 'reply' }]);
    const after = msg('user', [{ type: 'tool_result', toolUseId: 'x', content: 'r'.repeat(4_000) }]);
    const m = { ...meter, throughSeq: reply.seq };
    expect(meteredTokens(m, m, [ask, reply, after])).toBe(50_000 + 1_000);
  });
  test('another model, system, tool set or no usage means a full count', () => {
    expect(meteredTokens(meter, { ...meter, model: 'm/y' }, [])).toBeUndefined();
    expect(meteredTokens(meter, { ...meter, systemHash: 'z' }, [])).toBeUndefined();
    expect(meteredTokens(meter, { ...meter, toolsHash: 'z' }, [])).toBeUndefined();
    expect(meteredTokens({ ...meter, baseTokens: 0 }, meter, [])).toBeUndefined();
    expect(meteredTokens(undefined, meter, [])).toBeUndefined();
  });
});

describe('structured compaction input (item 13)', () => {
  test('the priority fill keeps user asks from the middle that a middle cut drops, with counted gap markers', () => {
    const region: Message[] = [];
    for (let i = 0; i < 100; i++) {
      if (i === 30 || i === 60) region.push(user(`MIDDLE-ASK-${i} please keep the old endpoint working`));
      else region.push(msg('assistant', [{ type: 'text', text: `step ${i} ${'z'.repeat(3_000)}` }]));
    }
    const old = renderTranscript(region, { maxChars: SUMMARY_INPUT_CHARS, includeTools: true });
    expect(old).not.toContain('MIDDLE-ASK-30');
    expect(old).not.toContain('MIDDLE-ASK-60');
    const input = summarizerInput(region);
    expect(input.length).toBeLessThanOrEqual(SUMMARY_INPUT_CHARS + 2_000);
    expect(input).toContain('MIDDLE-ASK-30 please keep the old endpoint working');
    expect(input).toContain('MIDDLE-ASK-60 please keep the old endpoint working');
    expect(input).toMatch(/\[\.\.\. \d+ messages omitted here, 0 of them from the user \.\.\.\]/);
    // in source order
    expect(input.indexOf('MIDDLE-ASK-30')).toBeLessThan(input.indexOf('MIDDLE-ASK-60'));
  });

  test('a 2,000-message region is sampled in every tenth of its history', () => {
    const region = Array.from({ length: 2_000 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `M${i}: ${'x'.repeat(200)}` }]));
    const input = summarizerInput(region);
    const seen = [...input.matchAll(/M(\d+):/g)].map((m) => Number(m[1]));
    for (let tenth = 0; tenth < 10; tenth++) expect(seen.some((n) => n >= tenth * 200 && n < (tenth + 1) * 200)).toBe(true);
  });

  test('the anchor index finds PRs, commits, branches, URLs, paths and errors, newest first, capped per kind', () => {
    const region = [
      user('Fix #412 on branch fix/retry-loop, see https://github.com/o/r/pull/415 and commit 3f9a2c1d'),
      msg('assistant', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git checkout -b feat/meter && cat /srv/app/config.toml' } }]),
      msg('user', [{ type: 'tool_result', toolUseId: 'tu1', content: 'TypeError: x is undefined\nENOENT: /srv/app/missing.json' }]),
      ...Array.from({ length: 30 }, (_, i) => user(`see /tmp/file${i}/x.txt`)),
    ];
    const idx = anchorIndex(region);
    expect(idx['issues and PRs']).toEqual(['#412', '#415']);
    expect(idx.commits).toEqual(['3f9a2c1d']);
    expect(idx.branches).toEqual(expect.arrayContaining(['fix/retry-loop', 'feat/meter']));
    expect(idx.urls).toEqual(['https://github.com/o/r/pull/415']);
    expect(idx.errors).toEqual(expect.arrayContaining(['TypeError', 'ENOENT']));
    expect(idx.paths).toHaveLength(20);
    expect(idx.paths[0]).toBe('/tmp/file29/x.txt');
    expect(anchorSection(idx)).toContain('- commits: 3f9a2c1d');
  });

  test('the audit names missing headings and identifiers; a full summary passes', () => {
    const region = [user('Update /srv/app/main.ts for #77')];
    const full = `${SUMMARY_HEADINGS.map((h) => `## ${h}\n- /srv/app/main.ts and #77`).join('\n')}`;
    expect(auditSummary(full, region)).toEqual([]);
    const problems = auditSummary('## Objective\nsomething', region);
    expect(problems).toContain('missing heading "## Next step"');
    expect(problems).toContain('missing identifier /srv/app/main.ts');
    expect(problems).toContain('missing identifier #77');
  });

  test('the kept tail is sized from the window and starts at a real user message', () => {
    const big = (role: 'user' | 'assistant', c: string) => msg(role, [{ type: 'text', text: c.repeat(30_000) }]);
    const active = [
      user('ask one'),
      msg('assistant', [{ type: 'text', text: 'a'.repeat(50_000) }]),
      user('ask two'),
      msg('assistant', [{ type: 'tool_use', id: 'k1', name: 'Read', input: { file_path: '/a' } }]),
      msg('user', [{ type: 'tool_result', toolUseId: 'k1', content: 'r'.repeat(30_000) }]),
      big('assistant', 'b'),
    ];
    // 200k window: 10k tokens (40k chars) reach back into the tool result, so the cut moves forward past it
    const small = recentToKeep(active, 200_000);
    expect(small.map((m) => m.id)).toEqual([active[5].id]);
    // 1M window: 25k tokens reach "ask two", which keeps the call with its result
    const large = recentToKeep(active, 1_000_000);
    expect(large[0].id).toBe(active[2].id);
    expect(large).toHaveLength(4);
  });
});
