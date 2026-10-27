/**
 * The visual check through the real runner (session/visual-check.ts): a
 * scripted coder edits UI files, and at stop it is reminded to look at them
 * unless a tool result in the turn carried an image.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type Block, type Step } from './harness';
import { UI_FILE, VISUAL_REMINDER } from '../../src/session/visual-check';
import { wantsVisualCheck } from '../../src/extensions/agent-hooks';

const write = (file_path: string, content: string): Block => ({ tool: 'Write', input: { file_path, content } });
const read = (file_path: string): Block => ({ tool: 'Read', input: { file_path } });
/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function rig(sub?: Step[]) {
  const steps: Step[] = [];
  const t = await startTestEngine({ script: [[{ text: 'unused' }]], approve: 'allow', route: (body) => (firstUserText(body).includes('SUB-BRIEF') ? sub?.shift() : steps.shift()) });
  const events: Array<Record<string, any>> = [];
  t.engine.bus.on((e: Record<string, any>) => {
    if (e.type === 'visual.checked') events.push(e);
  });
  // each request carries the whole transcript: count the reminders in the last one
  const reminded = () => (t.requests.at(-1) ?? '').split('You changed UI files and have not looked').length - 1;
  return { t, steps, events, reminded };
}

describe('visual check in a coder session', () => {
  test('a UI edit with no image looked at gets one reminder', async () => {
    const { t, steps, events, reminded } = await rig();
    try {
      steps.push([write(join(t.cwd, 'Button.tsx'), 'export const B = () => <button />;\n')], [{ text: 'Added the button.' }], [{ text: 'No browser here, so I could not take screenshots.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'add a button');
      expect(t.requests.length).toBe(3);
      expect(t.requests[2]).toContain(VISUAL_REMINDER);
      expect(reminded()).toBe(1);
      expect(events.map((e) => [e.outcome, e.reminded])).toEqual([['reminded', true]]);
      expect(t.engine.listAudit({ sessionId: s.id }).some((a) => a.action === 'visual.check' && a.detail.startsWith('reminded: 1 UI file changed'))).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a UI edit plus a Read of a PNG gets none', async () => {
    const { t, steps, events, reminded } = await rig();
    try {
      writeFileSync(join(t.cwd, 'shot.png'), PNG);
      steps.push([write(join(t.cwd, 'app.css'), 'body { margin: 0; }\n')], [read(join(t.cwd, 'shot.png'))], [{ text: 'Looked at it; fine.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'reset the margin');
      expect(t.requests.length).toBe(3);
      expect(reminded()).toBe(0);
      expect(events.map((e) => e.outcome)).toEqual(['looked']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a non-UI edit gets none', async () => {
    const { t, steps, events, reminded } = await rig();
    try {
      steps.push([write(join(t.cwd, 'util.ts'), 'export const x = 1;\n'), write(join(t.cwd, 'Button.test.tsx'), 'test("b", () => {});\n')], [{ text: 'Done.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'add x');
      expect(t.requests.length).toBe(2);
      expect(reminded()).toBe(0);
      expect(events).toEqual([]);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('the reminder comes once per user turn, and again in the next turn', async () => {
    const { t, steps, events, reminded } = await rig();
    try {
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      // turn 1: reminded, then another UI edit and a stop without looking: no second reminder
      steps.push([write(join(t.cwd, 'a.html'), '<p>a</p>\n')], [{ text: 'Done.' }], [write(join(t.cwd, 'b.svg'), '<svg/>\n')], [{ text: 'Still no browser.' }]);
      await t.run(s.id, 'make a page');
      expect(t.requests.length).toBe(4);
      expect(reminded()).toBe(1);
      // turn 2: a new user turn with a UI edit gets its own reminder
      steps.push([write(join(t.cwd, 'c.vue'), '<template/>\n')], [{ text: 'Done.' }], [{ text: 'Cannot screenshot.' }]);
      await t.run(s.id, 'and a component');
      expect(t.requests.length).toBe(7);
      expect(t.requests[6]).toContain(VISUAL_REMINDER);
      expect(events.map((e) => e.outcome)).toEqual(['reminded', 'reminded']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('not on a subagent: a builder that edits UI ends with no reminder', async () => {
    const sub: Step[] = [];
    const { t, steps, events, reminded } = await rig(sub);
    try {
      sub.push([write(join(t.cwd, 'Card.jsx'), 'export const C = () => <div />;\n')], [{ text: 'Added Card.' }]);
      steps.push([{ tool: 'Task', input: { subagent_type: 'builder', description: 'Add card', prompt: 'SUB-BRIEF: add a Card component.' } }], [{ text: 'The builder added Card.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'add a card');
      expect(sub.length).toBe(0);
      expect(reminded()).toBe(0);
      expect(events).toEqual([]);
    } finally {
      await t.close();
    }
  }, 30_000);
});

describe('visual check rules', () => {
  test('UI files and the profiles that turn it on', () => {
    for (const p of ['a/B.tsx', 'x.jsx', 'v.vue', 's.svelte', 'c.css', 'c.scss', 'i.html', 'i.svg', 'app/src/main/kotlin/dev/x/ui/Home.kt']) expect(UI_FILE.test(p)).toBe(true);
    for (const p of ['a.ts', 'b.py', 'app/src/main/kotlin/dev/x/data/Repo.kt', 'README.md']) expect(UI_FILE.test(p)).toBe(false);
    expect(wantsVisualCheck({ name: 'x', recipes: ['visual-check'] } as never)).toBe(true);
    expect(wantsVisualCheck({ name: 'x', recipes: ['regression-gate'] } as never)).toBe(false);
  });
});
