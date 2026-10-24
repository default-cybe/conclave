import { describe, expect, test } from 'bun:test';
import { TodoWriteTool } from '../../src/tools/todowrite';
import { TaskTool } from '../../src/tools/task';
import { AskUserQuestionTool } from '../../src/tools/ask-user';
import { EnterPlanModeTool } from '../../src/tools/enter-plan-mode';
import { ExitPlanModeTool } from '../../src/tools/exit-plan-mode';
import { SkillTool } from '../../src/tools/skill';
import { ReadToolOutputTool } from '../../src/tools/read-tool-output';
import { MemorySaveTool } from '../../src/tools/memory-save';
import { MemorySearchTool } from '../../src/tools/memory-search';
import { MemoryForgetTool } from '../../src/tools/memory-forget';
import { ConsultTool } from '../../src/tools/consult';
import { NotifyTool } from '../../src/tools/notify';
import { ScheduleRoutineTool } from '../../src/tools/schedule-routine';
import { builtinTools, filterTools, toolByName } from '../../src/tools';
import { toolIsReadOnly } from '../../src/tools/types';
import { fakeHost, makeCtx, text } from './helpers';

const cwd = '/tmp';

describe('TodoWrite', () => {
  test('stores todos and allows a single in_progress item', async () => {
    const host = fakeHost();
    const ctx = makeCtx({ cwd, host });
    const out = await TodoWriteTool.run(
      {
        todos: [
          { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
          { content: 'Ship it', activeForm: 'Shipping it', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(host.todos.get('sess_test')?.length).toBe(2);
    expect(text(out)).toContain('1 in progress');
  });

  test('rejects two in_progress items', async () => {
    const host = fakeHost();
    const out = await TodoWriteTool.run(
      {
        todos: [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
        ],
      },
      makeCtx({ cwd, host }),
    );
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Only one');
    expect(host.todos.size).toBe(0);
  });

  test('rejects bad status, defaults activeForm', async () => {
    const host = fakeHost();
    const bad = await TodoWriteTool.run({ todos: [{ content: 'A', activeForm: 'x', status: 'done' as any }] }, makeCtx({ cwd, host }));
    expect(bad.isError).toBe(true);
    await TodoWriteTool.run({ todos: [{ content: 'A', status: 'completed' }] }, makeCtx({ cwd, host }));
    expect(host.todos.get('sess_test')?.[0].activeForm).toBe('A');
  });

  test('accepts plain strings and a bare todo object; still rejects real errors', async () => {
    expect(TodoWriteTool.validatesInput).toBe(true);
    const host = fakeHost();
    const out = await TodoWriteTool.run({ todos: ['Run tests', 'Format output'] as any }, makeCtx({ cwd, host }));
    expect(out.isError).toBeFalsy();
    expect(host.todos.get('sess_test')).toEqual([
      { content: 'Run tests', activeForm: 'Run tests', status: 'in_progress' },
      { content: 'Format output', activeForm: 'Format output', status: 'pending' },
    ]);
    const bare = await TodoWriteTool.run({ content: 'Ship', activeForm: 'Shipping', status: 'pending' } as any, makeCtx({ cwd, host }));
    expect(bare.isError).toBeFalsy();
    expect(host.todos.get('sess_test')).toEqual([{ content: 'Ship', activeForm: 'Shipping', status: 'pending' }]);
    expect((await TodoWriteTool.run({ todos: ['  '] as any }, makeCtx({ cwd, host }))).isError).toBe(true);
    expect((await TodoWriteTool.run({} as any, makeCtx({ cwd, host }))).isError).toBe(true);
  });

  test('summarize handles [null], string items, and bare object without throwing', () => {
    expect(TodoWriteTool.summarize!({ todos: [null] } as any)).toBe('Update todos (0/1 done)');
    expect(TodoWriteTool.summarize!({ todos: ['Run tests', 'Ship'] } as any)).toBe('Update todos (0/2 done)');
    expect(TodoWriteTool.summarize!({ content: 'Ship', status: 'completed' } as any)).toBe('Update todos (1/1 done)');
    expect(TodoWriteTool.summarize!({} as any)).toBe('Update todos (0/0 done)');
  });
});

describe('Task', () => {
  test('runs a subagent and returns its text with the session id', async () => {
    const host = fakeHost();
    const out = await TaskTool.run({ description: 'find callers', prompt: 'Find all callers of foo', subagent_type: 'explore' }, makeCtx({ cwd, host }));
    expect(text(out)).toBe('done: find callers');
    expect(out.meta?.sessionId).toBe('sub_1');
    expect(host.subagents[0].agent).toBe('explore');
  });
  test('refused at depth 2', async () => {
    const out = await TaskTool.run({ description: 'x', prompt: 'y', subagent_type: 'explore' }, makeCtx({ cwd, depth: 2 }));
    expect(out.isError).toBe(true);
  });
});

describe('AskUserQuestion', () => {
  const q = (n: number) => ({ question: `Q${n}?`, header: `H${n}`, multiSelect: false, options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }] });
  test('asks and formats answers', async () => {
    const host = fakeHost();
    const out = await AskUserQuestionTool.run({ questions: [q(1), q(2)] }, makeCtx({ cwd, host }));
    expect(text(out)).toContain('"Q1?" -> "Yes"');
    expect(host.questions.length).toBe(1);
  });
  test('validates counts', async () => {
    expect((await AskUserQuestionTool.run({ questions: [] }, makeCtx({ cwd }))).isError).toBe(true);
    expect((await AskUserQuestionTool.run({ questions: [q(1), q(2), q(3), q(4), q(5)] }, makeCtx({ cwd }))).isError).toBe(true);
    const one = { ...q(1), options: [{ label: 'Only', description: '' }] };
    expect((await AskUserQuestionTool.run({ questions: [one] }, makeCtx({ cwd }))).isError).toBe(true);
  });
});

describe('plan mode', () => {
  test('enter and exit switch the permission mode', async () => {
    const host = fakeHost();
    await EnterPlanModeTool.run({}, makeCtx({ cwd, host }));
    expect(host.modes.sess_test).toBe('plan');
    const out = await ExitPlanModeTool.run({ plan: '# Plan\n1. do it' }, makeCtx({ cwd, host }));
    expect(host.modes.sess_test).toBe('default');
    expect(text(out)).toContain('approved');
    expect(ExitPlanModeTool.readOnly).toBe(false);
  });
});

describe('Skill and ReadToolOutput', () => {
  test('skill body with base dir and arguments', async () => {
    const out = await SkillTool.run({ skill: 'demo', args: 'flair' }, makeCtx({ cwd }));
    expect(text(out)).toContain('Base directory for this skill: /skills/demo');
    expect(text(out)).toContain('Do the demo with flair.');
    expect((await SkillTool.run({ skill: 'nope' }, makeCtx({ cwd }))).isError).toBe(true);
  });

  test('pages and greps stored output', async () => {
    const host = fakeHost();
    const id = host.saveOutput('s', 'Bash', Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n'));
    const page = text(await ReadToolOutputTool.run({ id, offset: 10, limit: 3 }, makeCtx({ cwd, host })));
    expect(page).toContain('    10\trow 10');
    expect(page).toContain('offset=13');
    const grep = text(await ReadToolOutputTool.run({ id, grep: '^row 9\\d$' }, makeCtx({ cwd, host })));
    expect(grep).toContain('10 matching lines');
    expect((await ReadToolOutputTool.run({ id: 'missing' }, makeCtx({ cwd, host }))).isError).toBe(true);
  });
});

describe('memory tools', () => {
  test('save, search, forget', async () => {
    const host = fakeHost();
    const ctx = makeCtx({ cwd: '/work/proj', host });
    const saved = await MemorySaveTool.run({ content: 'User prefers tabs over spaces', tags: ['#style'], scope: 'project' }, ctx);
    expect(saved.isError).toBeFalsy();
    expect(host.memories[0].scopeKey).toBe('/work/proj');
    expect(host.memories[0].tags).toEqual(['style']);
    const found = text(await MemorySearchTool.run({ query: 'tabs' }, ctx));
    expect(found).toContain('User prefers tabs');
    const id = host.memories[0].id;
    expect(text(await MemoryForgetTool.run({ id }, ctx))).toContain('Forgot');
    expect((await MemoryForgetTool.run({ id }, ctx)).isError).toBe(true);
  });
  test('refuses secrets', async () => {
    const host = fakeHost();
    const out = await MemorySaveTool.run({ content: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz123456' }, makeCtx({ cwd, host }));
    expect(out.isError).toBe(true);
    expect(host.memories.length).toBe(0);
  });
});

describe('Consult, Notify, ScheduleRoutine', () => {
  test('consult labels the answer with the model', async () => {
    const host = fakeHost();
    host.setTodos('sess_test', [{ content: 'Fix bug', status: 'in_progress' }]);
    const out = await ConsultTool.run({ model: 'openai/gpt-5.5', question: 'Is this safe?', include_context: true }, makeCtx({ cwd, host }));
    expect(text(out)).toStartWith('Answer from openai/gpt-5.5:');
    expect(host.completions[0].model).toBe('openai/gpt-5.5');
    expect(host.completions[0].prompt).toContain('[in_progress] Fix bug');
  });
  test('notify and routine', async () => {
    const host = fakeHost();
    await NotifyTool.run({ title: 'Done', message: 'Build passed' }, makeCtx({ cwd, host }));
    expect(host.notices[0]).toMatchObject({ title: 'Done', body: 'Build passed', sessionId: 'sess_test' });
    const r = await ScheduleRoutineTool.run({ name: 'daily', schedule: '0 9 * * *', prompt: 'Summarize' }, makeCtx({ cwd, host }));
    expect(text(r)).toContain('rt_daily');
  });
});

describe('index', () => {
  test('builtinTools has unique names and toolByName works', () => {
    const names = builtinTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill', 'ReadToolOutput', 'MemorySearch', 'MemorySave', 'MemoryForget', 'Consult', 'Notify', 'ScheduleRoutine', 'NotebookEdit', 'RepoMap']) {
      expect(toolByName(n)?.name).toBe(n);
    }
  });

  test('every tool has a description and an object schema', () => {
    for (const t of builtinTools()) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      expect(t.description).not.toContain('\u2014');
    }
  });

  test('filterTools: untrusted, depth, plan mode, allow/deny', () => {
    const all = builtinTools();
    const names = (ts: { name: string }[]) => ts.map((t) => t.name);
    // untrusted: deny by default, only what the agent or the routine names
    const untrusted = names(filterTools(all, { untrusted: true }));
    for (const n of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'MemorySearch']) expect(untrusted).not.toContain(n);
    expect(untrusted).toEqual(['TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ReadToolOutput']);
    const named = names(filterTools(all, { untrusted: true, allow: ['Read', 'WebFetch', 'Bash', 'Grep*', 'Write'] }));
    expect(named).toContain('Read');
    expect(named).toContain('WebFetch');
    // a wildcard is not a name; an agent's list never brings back Bash or Write
    for (const n of ['Grep', 'Bash', 'Write']) expect(named).not.toContain(n);
    const granted = names(filterTools(all, { untrusted: true, grants: ['Bash(zpool status -x)', 'Write', 'MemorySearch', 'WebFetch(domain:example.org)'] }));
    for (const n of ['Bash', 'MemorySearch', 'WebFetch']) expect(granted).toContain(n);
    expect(granted).not.toContain('Write');
    const mcp = [{ name: 'mcp__mail__read', description: 'x', inputSchema: { type: 'object' }, readOnly: true }, { name: 'mcp__mail__send', description: 'x', inputSchema: { type: 'object' }, readOnly: false }] as never[];
    expect(names(filterTools(mcp, { untrusted: true, grants: ['mcp__mail__read'] }))).toEqual(['mcp__mail__read']);
    expect(names(filterTools(mcp, { untrusted: true, grants: ['mcp__mail'] }))).toEqual(['mcp__mail__read', 'mcp__mail__send']);
    expect(names(filterTools(mcp, { untrusted: true, grants: ['mcp__*'] }))).toEqual([]);
    expect(names(filterTools(all, { depth: 2 }))).not.toContain('Task');
    expect(names(filterTools(all, { depth: 1 }))).toContain('Task');

    const plan = filterTools(all, { planMode: true });
    expect(names(plan)).toContain('ExitPlanMode');
    expect(names(plan)).toContain('Bash');
    expect(names(plan)).not.toContain('Write');
    expect(names(plan)).not.toContain('EnterPlanMode');
    expect(names(filterTools(all, { planMode: false }))).not.toContain('ExitPlanMode');

    expect(names(filterTools(all, { allow: ['Read', 'Bash(git:*)', 'Memory*'] }))).toEqual(['Bash', 'Read', 'MemorySearch', 'MemorySave', 'MemoryForget']);
    expect(names(filterTools(all, { deny: ['Web*'] }))).not.toContain('WebFetch');
  });

  test('readOnly flags', () => {
    expect(toolIsReadOnly(toolByName('Read')!, {})).toBe(true);
    expect(toolIsReadOnly(toolByName('Edit')!, {})).toBe(false);
    expect(toolIsReadOnly(toolByName('Bash')!, { command: 'git status' })).toBe(true);
    expect(toolIsReadOnly(toolByName('Bash')!, { command: 'git push' })).toBe(false);
  });
});
