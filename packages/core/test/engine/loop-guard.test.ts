import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoopGuard } from '../../src/session/loop-guard';
import type { Message, TextBlock } from '../../src/types';
import { firstUserText, startTestEngine, toolResults, type Block } from './harness';

/** The loop guard wired into the runner: warnings as reminders, halts by run kind. */

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);

describe('loop guard pollers', () => {
  const still = { content: 'Nothing finished yet.\n- t1 running (general-purpose: build)', isError: false };

  test('identical TaskWait, TaskList, WorkflowStatus and TaskResult polls are fine for a while, then warned at 10 and stopped at 15', () => {
    for (const [tool, input, result] of [
      ['TaskWait', { ids: ['t1'] }, still],
      ['TaskList', {}, { content: '1 background tasks:\n- t1 running (general-purpose: build)', isError: false }],
      ['WorkflowStatus', { id: 'w1' }, { content: 'w1 running, 2 of 5 calls done', isError: false }],
      ['TaskResult', { id: 't1' }, { content: 'Task t1 is still running. Wait for it with TaskWait.', isError: false }],
    ] as const) {
      const g = new LoopGuard({ unattended: true });
      const verdicts = Array.from({ length: 15 }, () => g.after(tool, input, result));
      expect(verdicts.map((v) => v.level)).toEqual([...Array(9).fill('ok'), ...Array(5).fill('warn'), 'halt']);
      expect(verdicts[14].code).toBe('poll');
    }
  });

  test('a TaskWait that blocked for its timeout is honest waiting, and a changed answer is a new poll', () => {
    const g = new LoopGuard({ unattended: true });
    for (let i = 0; i < 30; i++) expect(g.after('TaskWait', { ids: ['t1'] }, { ...still, meta: { durationMs: 60_000 } }).level).toBe('ok');
    const out = new LoopGuard({ unattended: true });
    for (let i = 0; i < 30; i++) expect(out.after('BashOutput', { bash_id: 'bash_1' }, { content: `<status>running</status>\n<stdout>\nline ${i}\n</stdout>\n<timestamp>${new Date(i * 1_000).toISOString()}</timestamp>`, isError: false }).level).toBe('ok');
  });

  test('a TaskResult that is not a still-running answer, and a real loop between waits, still halt', () => {
    const done = new LoopGuard({ unattended: true });
    const levels = Array.from({ length: 5 }, () => done.after('TaskResult', { id: 't1' }, { content: '- t1 completed\n\nreport', isError: false }).level);
    expect(levels).toEqual(['ok', 'ok', 'warn', 'warn', 'halt']);

    const g = new LoopGuard({ unattended: true });
    let last = '';
    for (let i = 0; i < 5; i++) {
      g.after('TaskWait', { ids: ['t1'] }, still);
      last = g.after('Grep', { pattern: 'needle' }, { content: 'No matches found', isError: false }).level;
    }
    expect(last).toBe('halt');
  });
});

describe('loop guard in the runner', () => {
  test('a subagent that sends the same Grep again and again is warned on the 4th request, stopped after the 5th, then reports with no tools', async () => {
    const isChild = (body: { messages?: unknown[] }) => firstUserText(body).includes('CHILD-BRIEF');
    const grep: Block = { tool: 'Grep', input: { pattern: 'needle' } };
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'find needle', prompt: 'CHILD-BRIEF find the needle', subagent_type: 'general-purpose' } }], [{ text: 'parent done' }]],
      route: (body) => (isChild(body) ? (body.tool_choice ? [{ text: 'REPORT: no needle in hay.txt' }] : [grep]) : undefined),
    });
    try {
      writeFileSync(join(t.cwd, 'hay.txt'), 'no match here');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'delegate');
      const childRequests = t.requests.filter((r) => isChild(JSON.parse(r)));
      // 5 tool steps, then the final-answer call with tool_choice none
      expect(childRequests).toHaveLength(6);
      expect(childRequests[2]).not.toContain('Loop guard');
      expect(childRequests[3]).toContain('Loop guard:');
      expect(childRequests[3]).toContain('same input 3 times in a row');
      expect(childRequests[4]).not.toContain('tool_choice');
      expect(JSON.parse(childRequests[5]).tool_choice).toEqual({ type: 'none' });
      expect(childRequests[5]).toContain('The loop guard stopped your tool calls for this turn');
      // the stop reason reaches the model once, not also in the tool-results reminder
      expect(childRequests[5].split('was called with the same input 5 times').length - 1).toBe(1);

      const child = t.engine.listSessions({ parentId: s.id })[0]!;
      expect(toolResults(t.engine, child.id)).toHaveLength(5);
      expect(notices(t.engine.getMessages(child.id)).some((n) => n.startsWith('Loop guard stopped the turn'))).toBe(true);
      const parentRequests = t.requests.filter((r) => !isChild(JSON.parse(r)));
      expect(parentRequests[1]).toContain('stopped by the loop guard');
      expect(parentRequests[1]).toContain('REPORT: no needle in hay.txt');
      expect(parentRequests[1]).not.toContain('produced no final answer');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an interactive turn gets one strong warning, then a repeat of the stopped call ends it', async () => {
    let file = '';
    const t = await startTestEngine({ script: [[{ text: 'unused' }]], route: (body) => (body.tool_choice ? [{ text: 'I kept reading a.txt; it says hello.' }] : [{ tool: 'Read', input: { file_path: file } }]) });
    try {
      file = join(t.cwd, 'a.txt');
      writeFileSync(file, 'hello');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'read it');
      expect(t.requests).toHaveLength(7);
      expect(t.requests[5]).toContain('This is the last warning in this turn');
      expect(JSON.parse(t.requests[6]).tool_choice).toEqual({ type: 'none' });
      const results = toolResults(t.engine, s.id);
      expect(results).toHaveLength(6);
      expect(results[5].content).toContain('Not run: the loop guard already stopped this exact Read call');
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs).some((n) => n.startsWith('Loop guard stopped the turn'))).toBe(true);
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')!;
      expect(last.content).toEqual([{ type: 'text', text: 'I kept reading a.txt; it says hello.' }]);
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an A-B-A-B cycle is warned after 6 calls, stopped after 10, then reported with no tools', async () => {
    const files = { a: '', b: '' };
    let n = 0;
    const t = await startTestEngine({
      script: [[{ text: 'unused' }]],
      route: (body) => (body.tool_choice ? [{ text: 'REPORT: a and b never change.' }] : [{ tool: 'Read', input: { file_path: n++ % 2 ? files.b : files.a } }]),
    });
    try {
      files.a = join(t.cwd, 'a.txt');
      files.b = join(t.cwd, 'b.txt');
      writeFileSync(files.a, 'A');
      writeFileSync(files.b, 'B');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      // unattended like a subagent: the first halt stops the turn
      t.engine.runnerFor(s.id).depth = 1;
      await t.run(s.id, 'compare');
      expect(t.requests[5]).not.toContain('repeating the same 2 calls');
      expect(t.requests[6]).toContain('repeating the same 2 calls (Read) with the same results (3 rounds)');
      expect(t.requests).toHaveLength(11);
      expect(JSON.parse(t.requests[10]).tool_choice).toEqual({ type: 'none' });
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs).some((x) => x.startsWith('Loop guard stopped the turn: The same 2 calls (Read) repeated 5 times'))).toBe(true);
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')!;
      expect((last.content[0] as TextBlock).text).toBe('REPORT: a and b never change.');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('varied work is never flagged and gets no final-answer call', async () => {
    // inputs are read when a request is answered, so they can point at the test cwd
    const inputs = Array.from({ length: 8 }, () => ({ file_path: '' }));
    const t = await startTestEngine({ script: [...inputs.map((input): Block[] => [{ tool: 'Read', input }]), [{ text: 'all read' }]] });
    try {
      inputs.forEach((inp, i) => {
        inp.file_path = join(t.cwd, `f${i}.txt`);
        writeFileSync(inp.file_path, `file ${i}`);
      });
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'read them all');
      expect(t.requests).toHaveLength(9);
      for (const r of t.requests) expect(r).not.toContain('Loop guard');
      for (const r of t.requests) expect(JSON.parse(r).tool_choice).toBeUndefined();
      expect(notices(t.engine.getMessages(s.id)).some((x) => x.startsWith('Loop guard'))).toBe(false);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('rejected plans are feedback: four drafts in one turn get no denial warning', async () => {
    const plan = (n: number): Block => ({ tool: 'ExitPlanMode', input: { plan: `# Plan draft ${n}\n- step` } });
    const t = await startTestEngine({ script: [[plan(1)], [plan(2)], [plan(3)], [plan(4)], [{ text: 'I will keep planning.' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, mode: 'plan', permissionMode: 'plan' });
      await t.run(s.id, 'plan the change');
      expect(t.approvals).toHaveLength(4);
      expect(t.requests).toHaveLength(5);
      for (const r of t.requests) expect(r).not.toContain('Loop guard');
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs).some((n) => n.startsWith('Loop guard stopped'))).toBe(false);
      expect(toolResults(t.engine, s.id).every((r) => r.content.startsWith('The user denied this action.'))).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('three denials in a row get a warning in an interactive turn', async () => {
    const touch = (f: string): Block => ({ tool: 'Bash', input: { command: `touch ${f}`, description: 'touch' } });
    const t = await startTestEngine({ script: [[touch('a1')], [touch('a2')], [touch('a3')], [{ text: 'I will ask first.' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'make files');
      expect(t.approvals).toHaveLength(3);
      expect(t.requests).toHaveLength(4);
      expect(t.requests[2]).not.toContain('were denied');
      expect(t.requests[3]).toContain('3 calls in a row were denied');
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs).some((n) => n.startsWith('Loop guard stopped'))).toBe(false);
      const carrier = msgs.find((m) => (m.meta?.loopGuard as { code?: string } | undefined)?.code === 'denied');
      expect(carrier).toBeDefined();
    } finally {
      await t.close();
    }
  }, 30_000);
});
