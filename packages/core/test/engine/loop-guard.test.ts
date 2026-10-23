import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, TextBlock } from '../../src/types';
import { firstUserText, startTestEngine, toolResults, type Block } from './harness';

/** The loop guard wired into the runner: warnings as reminders, halts by run kind. */

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);

describe('loop guard in the runner', () => {
  test('a subagent that sends the same Grep again and again is warned on the 4th request and stopped after the 5th', async () => {
    const isChild = (body: { messages?: unknown[] }) => firstUserText(body).includes('CHILD-BRIEF');
    const grep: Block = { tool: 'Grep', input: { pattern: 'needle' } };
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'find needle', prompt: 'CHILD-BRIEF find the needle', subagent_type: 'general-purpose' } }], [{ text: 'parent done' }]],
      route: (body) => (isChild(body) ? [grep] : undefined),
    });
    try {
      writeFileSync(join(t.cwd, 'hay.txt'), 'no match here');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'delegate');
      const childRequests = t.requests.filter((r) => isChild(JSON.parse(r)));
      expect(childRequests).toHaveLength(5);
      expect(childRequests[2]).not.toContain('Loop guard');
      expect(childRequests[3]).toContain('Loop guard:');
      expect(childRequests[3]).toContain('same input 3 times in a row');

      const child = t.engine.listSessions({ parentId: s.id })[0]!;
      expect(toolResults(t.engine, child.id)).toHaveLength(5);
      expect(notices(t.engine.getMessages(child.id)).some((n) => n.startsWith('Loop guard stopped the turn'))).toBe(true);
      const parentRequests = t.requests.filter((r) => !isChild(JSON.parse(r)));
      expect(parentRequests[1]).toContain('stopped by the loop guard');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an interactive turn gets one strong warning, then a repeat of the stopped call ends it', async () => {
    let file = '';
    const t = await startTestEngine({ script: [[{ text: 'unused' }]], route: () => [{ tool: 'Read', input: { file_path: file } }] });
    try {
      file = join(t.cwd, 'a.txt');
      writeFileSync(file, 'hello');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'read it');
      expect(t.requests).toHaveLength(6);
      expect(t.requests[5]).toContain('This is the last warning in this turn');
      const results = toolResults(t.engine, s.id);
      expect(results).toHaveLength(6);
      expect(results[5].content).toContain('Not run: the loop guard already stopped this exact Read call');
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs).some((n) => n.startsWith('Loop guard stopped the turn'))).toBe(true);
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
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
