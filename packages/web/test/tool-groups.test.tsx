/**
 * The thoughts and calls between two pieces of prose fold into one summary
 * row (docs/design/CHAT-AND-MOTION.md 6.3): the words of the summary
 * (src/lib/toolLine.ts groupSummary, workSummary), what groups and what
 * stays a row (src/features/chat/toolGroups.ts), how a turn splits into
 * pieces (Turn.tsx turnPieces), what the summary says at its right, which
 * calls stay in view under a closed group, and where a link to a tool
 * result lands (MessageList.tsx linkedCall).
 *
 *   bun test packages/web/test/tool-groups.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import { callPhrase, groupSummary, thoughtTime, workSummary, type ToolCall } from '../src/lib/toolLine';
import { groupState, pinned, segment, standsAlone, troubleWords, workName, type WorkEntry } from '../src/features/chat/toolGroups';
import { AssistantTurn, turnPieces } from '../src/features/chat/Turn';
import { ToolGroup, asWork, callStatus, groupNow, type ToolItem, type WorkItem } from '../src/features/chat/ToolRows';
import { linkedCall } from '../src/features/chat/MessageList';

const bash = (command: string): ToolCall => ({ name: 'Bash', input: { command } });
const read = (file_path: string): ToolCall => ({ name: 'Read', input: { file_path } });
const edit = (file_path: string): ToolCall => ({ name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } });
const grep = (pattern: string): ToolCall => ({ name: 'Grep', input: { pattern } });

describe('group summary words', () => {
  test('counts by kind, in the order each kind first ran', () => {
    const calls = [bash('bun test'), read('a.ts'), bash('git status'), grep('x'), bash('ls'), read('b.ts'), grep('y'), bash('a'), bash('b'), grep('z'), edit('a.ts'), bash('c')];
    expect(groupSummary(calls)).toBe('Ran 6 commands, read 2 files, searched 3 times, edited 1 file');
  });

  test('a file counts once however often it was read or edited; commands and searches count each call', () => {
    expect(groupSummary([read('a.ts'), read('a.ts'), read('b.ts')])).toBe('Read 2 files');
    expect(groupSummary([edit('a.ts'), edit('a.ts')])).toBe('Edited 1 file');
    expect(groupSummary([bash('bun test'), bash('bun test')])).toBe('Ran 2 commands');
    expect(groupSummary([grep('x'), grep('x')])).toBe('Searched 2 times');
  });

  test('one of a kind reads naturally', () => {
    expect(groupSummary([read('a.ts'), grep('x')])).toBe('Read 1 file, searched once');
    expect(groupSummary([bash('ls'), { name: 'WebSearch', input: { query: 'q' } }])).toBe('Ran 1 command, searched the web once');
    expect(groupSummary([{ name: 'Write', input: { file_path: 'n.md' } }, { name: 'WebFetch', input: { url: 'https://a.dev/x' } }, { name: 'WebFetch', input: { url: 'https://b.dev/y' } }])).toBe('Wrote 1 file, fetched 2 pages');
  });

  test('subagents, the plan, MCP servers and other tools', () => {
    expect(groupSummary([{ name: 'Task', input: { description: 'x' } }, { name: 'Task', input: { description: 'y' } }])).toBe('Ran 2 subagents');
    expect(groupSummary([{ name: 'TodoWrite', input: {} }, { name: 'TodoWrite', input: {} }, read('a.ts')])).toBe('Updated the plan, read 1 file');
    expect(groupSummary([{ name: 'mcp__github__create_issue', input: {} }, { name: 'mcp__github__list_prs', input: {} }, { name: 'mcp__proxmox__list_guests', input: {} }])).toBe('Used github 2 times, used proxmox');
    expect(groupSummary([{ name: 'Frobnicate', input: {} }, { name: 'LS', input: { path: 'src' } }])).toBe('Used Frobnicate, listed 1 folder');
    expect(groupSummary([])).toBe('');
  });

  test('calls without a path still count', () => {
    expect(groupSummary([read('a.ts'), { name: 'Read', input: {} }])).toBe('Read 2 files');
  });
});

describe('a stretch of work in words', () => {
  const think = (ms?: number, live?: boolean) => ({ thought: { ms, live } });
  const step = (c: ToolCall) => ({ call: c });

  test('the thoughts are one phrase with their total time; one call is named', () => {
    // found by the owner: "Thought for 9s", "Ran git log", "Thought for 6s" were three rows
    expect(workSummary([think(9_000), step(bash('git log --oneline -5')), think(6_000)])).toBe('Thought for 15s, ran git log');
    expect(workSummary([think(4_000), step(read('src/auth.ts'))])).toBe('Thought for 4s, read auth.ts');
  });

  test('several calls are counted; the thinking comes last when the work started with a call', () => {
    const calls = [bash('a'), bash('b'), read('x.ts'), bash('c'), read('y.ts'), bash('d'), bash('e'), bash('f')];
    expect(workSummary([...calls.map(step), think(40_000)])).toBe('Ran 6 commands, read 2 files, thought for 40s');
    expect(workSummary([think(2_000), ...calls.map(step), think(70_000)])).toBe('Thought for 1m 12s, ran 6 commands, read 2 files');
  });

  test('without thoughts it is the group summary; thoughts alone are their time', () => {
    expect(workSummary([step(read('a.ts')), step(grep('x'))])).toBe('Read 1 file, searched once');
    expect(workSummary([think(1_000), think(15_000)])).toBe('Thought for 16s');
    expect(workSummary([])).toBe('');
  });

  test('a thought still streaming reads "thinking"; one with no time known reads "reasoned"', () => {
    expect(workSummary([step(bash('git status')), think(undefined, true)])).toBe('Ran git status, thinking');
    expect(workSummary([think(), step(bash('ls'))])).toBe('Reasoned, ran ls');
  });

  test('the same words as a thought row and the tool line', () => {
    expect(thoughtTime(12_000)).toBe('12s');
    expect(thoughtTime(84_000)).toBe('1m 24s');
    expect(thoughtTime(200)).toBe('1s');
    expect(callPhrase(bash('cd app && bun test src'))).toBe('ran bun test');
    expect(callPhrase({ name: 'Task', input: { description: 'x' } })).toBe('ran a subagent');
  });
});

type E = WorkEntry<string, string>;
const call = (name: string, id = name): E => ({ type: 'call', name, item: id });
const th = (id: string): E => ({ type: 'thought', item: id });

describe('what groups', () => {
  test('a single call stays a row; two or more steps in a row are one group', () => {
    expect(segment([call('Bash')])).toEqual([{ kind: 'one', item: 'Bash' }]);
    expect(segment([call('Read', 'r'), call('Grep', 'g')])).toEqual([{ kind: 'group', entries: [call('Read', 'r'), call('Grep', 'g')] }]);
  });

  test('thoughts before, between and after the calls are in the group: one stretch of work is one row', () => {
    expect(segment([th('t0'), call('Read', 'r'), th('t1'), call('Edit', 'e'), th('t2')])).toEqual([{ kind: 'group', entries: [th('t0'), call('Read', 'r'), th('t1'), call('Edit', 'e'), th('t2')] }]);
    // the owner's turn: "Thought for 9s", "Ran git log", "Thought for 6s" were three rows before
    expect(segment([th('a'), call('Bash', 'b'), th('c')])).toEqual([{ kind: 'group', entries: [th('a'), call('Bash', 'b'), th('c')] }]);
  });

  test('a lone thought stays as it is', () => {
    expect(segment([th('t')])).toEqual([{ kind: 'thought', item: 't' }]);
  });

  test('workflows, subagents, cards and questions keep a row of their own and split the work around them', () => {
    for (const name of ['Workflow', 'Task', 'AskUserQuestion', 'PlaceSearch', 'Directions', 'MapImage', 'WatchReport']) expect(standsAlone(name)).toBe(true);
    for (const name of ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'mcp__github__create_issue']) expect(standsAlone(name)).toBe(false);
    // a subagent is one row of its own, as the Claude app shows it: never "ran 2 subagents" in a fold
    expect(segment([call('Read', 'r'), call('Task', 't1'), call('Task', 't2'), th('x'), call('Bash', 'b')])).toEqual([
      { kind: 'one', item: 'r' },
      { kind: 'one', item: 't1' },
      { kind: 'one', item: 't2' },
      { kind: 'group', entries: [th('x'), call('Bash', 'b')] },
    ]);
    expect(segment([call('Read', 'r1'), call('Read', 'r2'), call('Workflow', 'w'), call('Bash', 'b')])).toEqual([
      { kind: 'group', entries: [call('Read', 'r1'), call('Read', 'r2')] },
      { kind: 'one', item: 'w' },
      { kind: 'one', item: 'b' },
    ]);
    expect(segment([th('t0'), call('Bash', 'b'), call('Workflow', 'w'), th('t1')])).toEqual([
      { kind: 'group', entries: [th('t0'), call('Bash', 'b')] },
      { kind: 'one', item: 'w' },
      { kind: 'thought', item: 't1' },
    ]);
  });

  test('a call and a thought before a card are a group; the card stays its own row', () => {
    expect(segment([call('Read', 'r'), th('t'), call('AskUserQuestion', 'q')])).toEqual([
      { kind: 'group', entries: [call('Read', 'r'), th('t')] },
      { kind: 'one', item: 'q' },
    ]);
  });

  test('a workflow and a subagent keep their row whatever name they arrive under', () => {
    expect(workName('Workflow')).toBe('Workflow');
    expect(workName('mcp__conclave__Workflow')).toBe('Workflow');
    expect(standsAlone('mcp__conclave__Workflow')).toBe(true);
    expect(workName('mcp__conclave__Task')).toBe('Task');
    expect(workName('workflow')).toBe('Workflow');
    // a harness that only titled the call: its input is a workflow script
    expect(workName('Tool', { script: "export const meta = { name: 'sweep', phases: [] }" })).toBe('Workflow');
    expect(workName('Tool', { command: 'ls' })).toBe('Tool');
    expect(workName('mcp__github__create_issue')).toBe('mcp__github__create_issue');
    expect(workName('Bash', { script: 'export const meta = {}' })).toBe('Bash');
    // Claude Code calls its subagent tool Agent
    expect(workName('Agent', { description: 'Find the auth code', prompt: 'List every JWT use', subagent_type: 'explore' })).toBe('Task');
    expect(workName('Agent', { description: 'Find the auth code', prompt: 'List every JWT use' })).toBe('Task');
    expect(workName('Agent', { query: 'x' })).toBe('Agent');
    // Delegate hands a job to a Code or Assistant session: a subagent row of its own
    expect(workName('Delegate', { to: 'code', prompt: 'Find names' })).toBe('Task');
    expect(standsAlone('Delegate')).toBe(true);
  });
});

describe('the state a summary row shows', () => {
  test('waiting on you first, then running, then failures, then done', () => {
    expect(groupState(['done', 'running', 'waiting']).state).toBe('waiting');
    expect(groupState(['done', 'running', 'failed']).state).toBe('running');
    expect(groupState(['done', 'failed', 'failed', 'denied'])).toEqual({ state: 'failed', failed: 2, denied: 1 });
    expect(groupState(['done', 'done']).state).toBe('done');
  });

  test('the failed count in words', () => {
    expect(troubleWords({ failed: 1, denied: 0 })).toBe('1 failed');
    expect(troubleWords({ failed: 2, denied: 1 })).toBe('2 failed, 1 denied');
    expect(troubleWords({ failed: 0, denied: 1 })).toBe('1 denied');
    expect(troubleWords({ failed: 0, denied: 0 })).toBe('');
  });

  test('a call that waits on you stays in view under a closed group; the running one is the summary words (groupNow)', () => {
    expect(pinned('waiting')).toBe(true);
    for (const s of ['running', 'done', 'failed', 'denied', 'pending'] as const) expect(pinned(s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------

const session = { id: 's1', agent: 'coder', model: 'anthropic/claude-sonnet-5-5', cwd: '~/code' } as Session;
const use = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: 'tool_use', id, name, input });
const said = (text: string): ContentBlock => ({ type: 'text', text });
const thought: ContentBlock = { type: 'thinking', thinking: 'Look first.', durationMs: 3000 };
const asst = (id: string, content: ContentBlock[], seq = 1): Message => ({ id, sessionId: 's1', seq, role: 'assistant', kind: 'normal', content, createdAt: 1_000 + seq, model: session.model, agent: 'coder' });
const ok = (id: string, content = 'ok') => ({ type: 'tool_result' as const, toolUseId: id, content, meta: { durationMs: 1200 } });

describe('a turn in pieces', () => {
  const m1 = asst('m1', [thought, said('Reading first.'), use('r', 'Read', { file_path: 'a.ts' }), thought, use('g', 'Grep', { pattern: 'x' })], 1);
  const m2 = asst('m2', [use('b', 'Bash', { command: 'bun test' }), said(''), use('e', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' })], 3);
  const m3 = asst('m3', [said('Done.')], 5);

  test('calls in a row across messages are one piece of work, the thought between them inside', () => {
    const pieces = turnPieces([m1, m2, m3], {}, {}, {});
    expect(pieces.map((p) => p.type)).toEqual(['block', 'block', 'work', 'block']);
    const work = pieces[2];
    if (work.type !== 'work') throw new Error('work');
    expect(work.entries.map((e) => (e.type === 'call' ? e.item.tool.id : 'thought'))).toEqual(['r', 'thought', 'g', 'b', 'e']);
  });

  test('a thought after the last call is in the same piece of work; it may still stream there', () => {
    const pieces = turnPieces([asst('m', [use('r', 'Read'), use('g', 'Grep'), thought])], {}, {}, {});
    expect(pieces.map((p) => p.type)).toEqual(['work']);
    const streamed = turnPieces([asst('m', [use('r', 'Read'), use('g', 'Grep'), thought])], { m: true }, {}, {});
    const work = streamed[0];
    if (work.type !== 'work') throw new Error('work');
    const last = work.entries[work.entries.length - 1];
    expect(last.type === 'thought' && last.item.streaming).toBe(true);
  });

  test('a thought on its own (prose around it) stays a block of its own', () => {
    const pieces = turnPieces([asst('m', [said('First.'), thought, said('Then.')])], {}, {}, {});
    expect(pieces.map((p) => p.type)).toEqual(['block', 'block', 'block']);
  });

  const render = (live: boolean, results = {}, messages = [m1, m2, m3]) =>
    renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <AssistantTurn messages={messages} session={session} streaming={{}} tools={{}} results={results} known={null} live={live} />
      </Router>,
    );

  test('a finished turn shows the summary row, closed, with the calls as hidden markers only', () => {
    const results = { r: ok('r'), g: ok('g'), b: ok('b'), e: ok('e') };
    const html = render(false, results);
    // the thought between the read and the search is in the group; its time comes last, as the work started with a call
    expect(html).toContain('Read 1 file, searched once, ran 1 command, edited 1 file, thought for 3s');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="tool-r"');
    expect(html).toContain('data-tool-ref="e"');
    // the marker carries the edited path, for the session's file list
    expect(html).toContain('data-tool-path="a.ts"');
  });

  test('while the turn works on its calls (no answer under them yet), the group is closed, as on Android', () => {
    const html = render(true, { r: ok('r') }, [m1, m2]);
    expect(html).toContain('data-group-toggle="" aria-expanded="false"');
    expect(html).not.toContain('id="tool-r"');
    expect(html).not.toContain('id="tool-e"');
    // the step it is at now, in signal: the last call that has not finished
    expect(html).toContain('Editing a.ts');
  });

  test('with the answer under it the group closes, even while the session still runs', () => {
    const results = { r: ok('r'), g: ok('g'), b: ok('b'), e: ok('e') };
    const html = renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <AssistantTurn messages={[m1, m2, m3]} session={session} streaming={{ m3: true }} tools={{}} results={results} known={null} live />
      </Router>,
    );
    expect(html).toContain('data-group-toggle="" aria-expanded="false"');
  });

  test("the owner's turn: a thought, git log and a thought before the answer are one row", () => {
    const t9: ContentBlock = { type: 'thinking', thinking: 'Check the history.', durationMs: 9_000 };
    const t6: ContentBlock = { type: 'thinking', thinking: 'That is the commit.', durationMs: 6_000 };
    const m = asst('m', [t9, use('gl', 'Bash', { command: 'git log --oneline -5' }), t6, said('The change landed in 4f2a.')]);
    const html = render(false, { gl: ok('gl') }, [m]);
    expect(html).toContain('Thought for 15s, ran git log');
    // one summary row, closed: the thoughts are inside it, not rows of their own
    expect(html).not.toContain('cv-fold-row');
    expect((html.match(/data-group-toggle/g) ?? []).length).toBe(1);
  });

  test('while the turn works, the group stays closed and says "Thinking" while its last thought streams', () => {
    const t9: ContentBlock = { type: 'thinking', thinking: 'Check the history.', durationMs: 9_000 };
    const m = asst('m', [t9, use('gl', 'Bash', { command: 'git log --oneline -5' }), { type: 'thinking', thinking: 'Now the' }]);
    const html = renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <AssistantTurn messages={[m]} session={session} streaming={{ m: true }} tools={{}} results={{ gl: ok('gl') }} known={null} live />
      </Router>,
    );
    // the summary sits in the title; the row says what it does now
    expect(html).toContain('title="Thinking, ran git log"');
    expect(html).toContain('text-signal">Thinking</span>');
    expect(html).toContain('data-group-toggle="" aria-expanded="false"');
    expect(html).not.toContain('id="tool-gl"');
    expect(html).not.toContain('Thought for 9s</');
  });

  test('a failed call shows in the summary', () => {
    const html = render(false, { r: ok('r'), g: { ...ok('g', 'boom'), isError: true }, b: ok('b'), e: ok('e') });
    expect(html).toContain('1 failed');
  });

  test('a single call stays one row', () => {
    const html = renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <ToolGroup entries={asWork([{ tool: { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }, result: ok('x') }])} sessionId="s1" />
      </Router>,
    );
    expect(html).toContain('id="tool-x"');
    expect(html).not.toContain('data-group-toggle');
  });
});

describe('a running turn folds as a finished one does (Android Work.now)', () => {
  const item = (id: string, name: string, input: Record<string, unknown>, done: boolean): ToolItem => ({ tool: { type: 'tool_use', id, name, input }, ...(done ? { result: ok(id) } : {}) });
  const statusOf = (waiting: string[] = []) => (c: ToolItem) => callStatus(c, waiting.includes(c.tool.id));
  const callE = (i: ToolItem): WorkItem => ({ type: 'call', name: i.tool.name, item: i });
  const thoughtE = (streaming: boolean): WorkItem => ({ type: 'thought', item: { block: { type: 'thinking', thinking: 'hm' }, key: 't', ...(streaming ? { streaming: true } : {}) } });

  test('the label is the last step not yet done; "Thinking" while the last thought streams; nothing once the turn is past it', () => {
    const entries = [callE(item('a', 'Read', { file_path: 'src/a.ts' }, true)), callE(item('b', 'Bash', { command: 'cd x && bun test' }, false))];
    expect(groupNow(entries, statusOf(), true)).toBe('Running bun test');
    expect(groupNow(entries, statusOf(), false)).toBe(null);
    expect(groupNow([...entries, thoughtE(true)], statusOf(), true)).toBe('Thinking');
    // every call done and the thought ended: between steps, no label
    expect(groupNow([callE(item('a', 'Read', {}, true)), thoughtE(false)], statusOf(), true)).toBe(null);
  });

  test('a call that waits on you gives no label; its row stays in view instead', () => {
    const entries = [callE(item('a', 'Read', {}, true)), callE(item('b', 'Bash', { command: 'rm -rf build' }, false))];
    expect(groupNow(entries, statusOf(['b']), true)).toBe(null);
  });

  const m = asst('m', [thought, use('r', 'Read', { file_path: 'a.ts' }), use('g', 'Grep', { pattern: 'x' }), use('b', 'Bash', { command: 'bun test' })], 1);
  const live = (messages: Message[], results: Record<string, ReturnType<typeof ok>>, streaming: Record<string, true> = {}) =>
    renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <AssistantTurn messages={messages} session={session} streaming={streaming} tools={{}} results={results} known={null} live />
      </Router>,
    );

  test('steps fold into one closed group while running, with the current step as its label', () => {
    const html = live([m], { r: ok('r'), g: ok('g') });
    expect((html.match(/data-group-toggle/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Running bun test');
    for (const id of ['r', 'g', 'b']) expect(html).not.toContain(`id="tool-${id}"`);
    expect(html).not.toContain('cv-fold-row');
  });

  test('the final answer stays outside the group, and the group drops its label once the answer starts', () => {
    const answer = asst('m2', [said('All green.')], 3);
    const html = live([m, answer], { r: ok('r'), g: ok('g'), b: ok('b') }, { m2: true });
    expect(html.indexOf('All green.')).toBeGreaterThan(html.indexOf('data-group-toggle'));
    expect(html).toContain('data-group-toggle="" aria-expanded="false"');
    expect(html).not.toContain('Running bun test');
  });

  test('a call with an approval open stays in view under the closed group, and a question keeps its own row', () => {
    // the store's approvals are not read in a server render, so the rule is checked on its parts
    const b = item('b', 'Bash', { command: 'rm -rf build' }, false);
    expect(callStatus(b, true)).toBe('waiting');
    expect(pinned(callStatus(b, true))).toBe(true);
    const ask = asst('q', [use('r', 'Read', { file_path: 'a.ts' }), use('g', 'Grep', { pattern: 'x' }), use('ask', 'AskUserQuestion', { questions: [{ question: 'Which branch?' }] })], 1);
    const html = live([ask], { r: ok('r'), g: ok('g') });
    expect(html).toContain('id="tool-ask"');
    expect(html).toContain('Which branch?');
  });
});

describe('a link to a tool result', () => {
  const calls = asst('a', [use('t1', 'Read'), use('t2', 'Bash')], 2);
  const result: Message = { id: 'u', sessionId: 's1', seq: 3, role: 'user', kind: 'normal', content: [ok('t2'), ok('t1')], createdAt: 3 };
  const prose = asst('p', [said('Here.'), use('t3', 'Bash')], 4);

  test('lands on the call the result answers', () => {
    expect(linkedCall([calls, result, prose], 'u')).toBe('t2');
  });

  test('a message of calls only lands on its first call; a message with words lands on the message', () => {
    expect(linkedCall([calls, result, prose], 'a')).toBe('t1');
    expect(linkedCall([calls, result, prose], 'p')).toBe(null);
    expect(linkedCall([calls, result, prose], 'nope')).toBe(null);
  });
});
