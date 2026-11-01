import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alertsOf, liveAlerts } from '../../src/alerts/attached';
import type { AlertItem } from '../../src/client/alerts';
import type { EngineEventEnvelope, Notice } from '../../src/types';
import { firstUserText, startTestEngine, toolResults, until, type Block, type Step, type TestEngine } from './harness';

/**
 * File conflict alerts (docs/DESIGN.md 28): a write on a file another live
 * chat wrote in the last 10 minutes gets a line for the model, one Inbox item
 * and a notification, debounced per pair and file.
 */

/** Route each session's requests by a word in its first message: its own script, step by step. Plans are read on each request. */
function byPrompt(plansOf: () => Record<string, Step[]>) {
  const seen: Record<string, number> = {};
  return (body: { messages?: unknown[] }) => {
    const plans = plansOf();
    const first = firstUserText(body);
    const key = Object.keys(plans).find((k) => first.includes(k));
    if (!key) return undefined;
    const i = (seen[key] = (seen[key] ?? 0) + 1);
    return plans[key][Math.min(i - 1, plans[key].length - 1)];
  };
}

function watch(t: TestEngine) {
  const raised: AlertItem[] = [];
  const cleared: string[] = [];
  const notices: Notice[] = [];
  t.engine.bus.on((e: EngineEventEnvelope) => {
    if (e.type === 'alert.raised') raised.push(e.alert);
    if (e.type === 'alert.cleared') cleared.push(e.id);
    if (e.type === 'notice' && e.notice.alertId) notices.push(e.notice);
  });
  return { raised, cleared, notices, ids: () => [...new Set(raised.map((a) => a.id))] };
}

const readB = (path: string): Block => ({ tool: 'Read', input: { file_path: path } });
const write = (path: string, content: string): Step => [{ tool: 'Write', input: { file_path: path, content } }];
const read = (path: string): Step => [readB(path)];
const done: Step = [{ text: 'done' }];

describe('file conflicts', () => {
  test('a write on a file another chat wrote gets a line, one Inbox item and a notification', async () => {
    let file = '';
    const t = await startTestEngine({
      script: [done],
      route: byPrompt(() => ({ 'TASK-A': [write(file, 'export const a = 1;\n'), done], 'TASK-B': [read(file), write(file, 'export const b = 2;\n'), done] })),
    });
    try {
      file = join(t.cwd, 'src', 'auth', 'redirect.ts');
      const w = watch(t);
      const a = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd, permissionMode: 'bypass' });
      const b = await t.engine.createSession({ title: 'Refactor auth', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(a.id, 'TASK-A');
      await t.run(b.id, 'TASK-B');

      // A wrote first: nothing to say; B's write lands on A's file
      expect(toolResults(t.engine, a.id).find((r) => r.name === 'Write')!.content).not.toContain('Another chat');
      const bWrite = toolResults(t.engine, b.id).find((r) => r.name === 'Write')!;
      expect(bWrite.isError).toBe(false);
      expect(bWrite.content).toContain("Another chat, 'Fix login', changed this file less than a minute ago.");
      // the line reached the model with the result
      expect(t.requests.some((r) => r.includes("Another chat, 'Fix login', changed this file"))).toBe(true);

      const items = alertsOf(t.engine)!.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('fileConflict');
      expect(items[0].text).toBe("'Fix login' and 'Refactor auth' are both editing src/auth/redirect.ts");
      expect(items[0].sessions).toEqual([
        { id: a.id, title: 'Fix login' },
        { id: b.id, title: 'Refactor auth' },
      ]);
      expect(items[0].sessionId).toBe(b.id);
      expect(items[0].path).toBe(file);
      expect(items[0].device).toBe('local');
      expect(w.notices).toHaveLength(1);
      expect(w.notices[0].body).toBe(items[0].text);
      expect(w.notices[0].alertId).toBe(items[0].id);

      // the live state for the Map
      const live = liveAlerts(t.engine);
      expect(live.conflicts).toHaveLength(1);
      expect(live.conflicts[0]).toMatchObject({ file, device: 'local', sessions: [a.id, b.id] });

      // over HTTP shape: dismiss closes it
      expect(alertsOf(t.engine)!.act(items[0].id, 'stop')).toBe('bad');
      expect(alertsOf(t.engine)!.act(items[0].id, 'dismiss')).toBe('ok');
      expect(alertsOf(t.engine)!.list()).toHaveLength(0);
      expect(w.cleared).toEqual([items[0].id]);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('agents in separate git worktrees do not conflict', async () => {
    const t = await startTestEngine({
      script: [done],
      // both write the same path relative to their own worktree
      route: byPrompt(() => ({ 'TASK-A': [write('src/app.ts', 'a\n'), done], 'TASK-B': [write('src/app.ts', 'b\n'), done] })),
    });
    try {
      const repo = join(t.cwd, 'repo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'README.md'), 'x\n');
      const git = (cwd: string, ...args: string[]) => {
        const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      };
      git(repo, 'init', '-q');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init');
      const wt = join(t.cwd, 'wt-b');
      git(repo, 'worktree', 'add', '-q', wt);

      const w = watch(t);
      const a = await t.engine.createSession({ title: 'Fix login', cwd: repo, permissionMode: 'bypass' });
      const b = await t.engine.createSession({ title: 'Refactor auth', cwd: wt, permissionMode: 'bypass' });
      await t.run(a.id, 'TASK-A');
      await t.run(b.id, 'TASK-B');
      expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('a\n');
      expect(readFileSync(join(wt, 'src/app.ts'), 'utf8')).toBe('b\n');
      expect(toolResults(t.engine, b.id).find((r) => r.name === 'Write')!.content).not.toContain('Another chat');
      expect(w.raised).toHaveLength(0);
      expect(liveAlerts(t.engine).conflicts).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a subagent and its own parent do not conflict', async () => {
    let file = '';
    const t = await startTestEngine({
      script: [done],
      route: byPrompt(() => ({
        'CHILD-BRIEF': [write(file, 'from the child\n'), done],
        'PARENT-TASK': [[{ tool: 'Task', input: { description: 'Write the file', prompt: 'CHILD-BRIEF: write it', subagent_type: 'general-purpose' } }], read(file), write(file, 'from the parent\n'), done],
      })),
    });
    try {
      file = join(t.cwd, 'notes.md');
      const w = watch(t);
      const p = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(p.id, 'PARENT-TASK');
      const child = t.engine.listSessions({ parentId: p.id })[0]!;
      expect(toolResults(t.engine, child.id).find((r) => r.name === 'Write')!.isError).toBe(false);
      const parentWrite = toolResults(t.engine, p.id).find((r) => r.name === 'Write')!;
      expect(parentWrite.isError).toBe(false);
      expect(parentWrite.content).not.toContain('Another chat');
      expect(readFileSync(file, 'utf8')).toBe('from the parent\n');
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a background subagent that still runs does not conflict with its parent, but two running siblings do', async () => {
    let file = '';
    let pair = '';
    const bg = (brief: string) => ({ tool: 'Task', input: { description: brief, prompt: `${brief}: write it`, subagent_type: 'general-purpose', run_in_background: true } });
    const t = await startTestEngine({
      script: [done],
      route: byPrompt(() => ({
        // each child writes, then keeps working a while
        'CHILD-SOLO': [write(file, 'child\n'), { blocks: [{ text: 'done' }], delayMs: 1_500 }],
        'CHILD-ONE': [write(pair, 'one\n'), { blocks: [{ text: 'done' }], delayMs: 1_500 }],
        'CHILD-TWO': [{ blocks: [readB(pair)], delayMs: 400 }, write(pair, 'two\n'), { blocks: [{ text: 'done' }], delayMs: 800 }],
        // the parent writes the file while its child still runs
        'PARENT-SOLO': [[bg('CHILD-SOLO')], { blocks: [readB(file)], delayMs: 400 }, write(file, 'parent\n'), done],
        'PARENT-PAIR': [[bg('CHILD-ONE'), bg('CHILD-TWO')], done],
      })),
    });
    try {
      file = join(t.cwd, 'notes.md');
      pair = join(t.cwd, 'pair.md');
      const w = watch(t);
      const allIdle = (parentId: string) => t.engine.listSessions({ parentId }).every((c) => c.status === 'idle');

      const p = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, permissionMode: 'bypass' });
      t.engine.runnerFor(p.id).noteDelayMs = 60_000;
      await t.run(p.id, 'PARENT-SOLO');
      const parentWrite = toolResults(t.engine, p.id).find((r) => r.name === 'Write')!;
      expect(parentWrite.isError).toBe(false);
      expect(t.engine.listSessions({ parentId: p.id })[0].status).toBe('running');
      expect(parentWrite.content).not.toContain('Another chat');
      expect(await until(() => allIdle(p.id), 10_000)).toBe(true);
      expect(w.raised).toHaveLength(0);

      const q = await t.engine.createSession({ title: 'Parent two', cwd: t.cwd, permissionMode: 'bypass' });
      t.engine.runnerFor(q.id).noteDelayMs = 60_000;
      await t.run(q.id, 'PARENT-PAIR');
      expect(await until(() => t.engine.listSessions({ parentId: q.id }).length === 2 && allIdle(q.id), 10_000)).toBe(true);
      const [one, two] = ['CHILD-ONE', 'CHILD-TWO'].map((d) => t.engine.listSessions({ parentId: q.id }).find((c) => c.title === d)!);
      expect(toolResults(t.engine, two.id).find((r) => r.name === 'Write')!.content).toContain("Another chat, 'CHILD-ONE', changed this file");
      expect(w.raised).toHaveLength(1);
      expect(w.raised[0].sessions!.map((s) => s.id)).toEqual([one.id, two.id]);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('one item per pair of sessions and file per 10 minutes', async () => {
    let file = '';
    const t = await startTestEngine({
      script: [done],
      route: byPrompt(() => ({
        'TASK-A1': [write(file, '1\n'), done],
        'TASK-B1': [read(file), write(file, '2\n'), done],
      })),
    });
    try {
      file = join(t.cwd, 'shared.ts');
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const a = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd, permissionMode: 'bypass' });
      const b = await t.engine.createSession({ title: 'Refactor auth', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(a.id, 'TASK-A1');
      await t.run(b.id, 'TASK-B1');
      expect(w.ids()).toHaveLength(1);
      expect(w.notices).toHaveLength(1);
      const first = w.ids()[0];

      // both keep writing: the open item is updated, no second item or notification
      const now = Date.now();
      const sa = t.engine.getSession(a.id)!;
      const sb = t.engine.getSession(b.id)!;
      expect(svc.onWrite(sa, file, { at: now + 1_000 })).toBe("Another chat, 'Refactor auth', changed this file less than a minute ago.");
      expect(svc.onWrite(sb, file, { at: now + 2_000 })).toContain("Another chat, 'Fix login'");
      // nothing new from A since: B is not told again
      expect(svc.onWrite(sb, file, { at: now + 3_000 })).toBeUndefined();
      expect(w.ids()).toEqual([first]);
      expect(w.notices).toHaveLength(1);
      expect(svc.list()[0].updatedAt).toBe(now + 3_000);

      // dismissed: still nothing new inside the 10 minutes
      expect(svc.act(first, 'dismiss')).toBe('ok');
      expect(svc.onWrite(sa, file, { at: now + 4 * 60_000 })).toContain("'Refactor auth'");
      expect(w.ids()).toEqual([first]);
      expect(svc.list()).toHaveLength(0);

      // 10 minutes after the item, while both still work, a new one
      t.engine.setStatus(a.id, 'running');
      t.engine.setStatus(b.id, 'running');
      svc.onWrite(sa, file, { at: now + 10 * 60_000 });
      svc.onWrite(sb, file, { at: now + 11 * 60_000 });
      expect(w.ids()).toHaveLength(2);
      expect(w.notices).toHaveLength(2);
      expect(svc.list()).toHaveLength(1);

      // an unrelated file of the same pair is its own item
      svc.onWrite(sa, join(t.cwd, 'other.ts'), { at: now + 11 * 60_000 });
      svc.onWrite(sb, join(t.cwd, 'other.ts'), { at: now + 11 * 60_000 + 1 });
      expect(svc.list().map((i) => i.file).sort()).toEqual(['other.ts', 'shared.ts']);
      t.engine.setStatus(a.id, 'idle');
      t.engine.setStatus(b.id, 'idle');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a write on another device or long after the other chat went quiet is no conflict', async () => {
    const t = await startTestEngine({ script: [done] });
    try {
      const svc = alertsOf(t.engine)!;
      const w = watch(t);
      const a = await t.engine.createSession({ title: 'A', cwd: t.cwd });
      const b = await t.engine.createSession({ title: 'B', cwd: t.cwd });
      const file = join(t.cwd, 'x.ts');
      const now = Date.now();
      svc.onWrite(t.engine.getSession(a.id)!, file, { at: now });
      // the same path on another device
      expect(svc.onWrite({ ...t.engine.getSession(b.id)!, device: 'macbook' }, file, { at: now + 1 })).toBeUndefined();
      // 11 minutes later A is no longer live
      expect(svc.onWrite(t.engine.getSession(b.id)!, file, { at: now + 11 * 60_000 })).toBeUndefined();
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('an edit an ACP harness reports counts as a write', async () => {
    const t = await startTestEngine({ script: [done] });
    try {
      const svc = alertsOf(t.engine)!;
      const w = watch(t);
      const a = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd });
      const b = await t.engine.createSession({ title: 'Claude Code run', cwd: t.cwd });
      const file = join(t.cwd, 'src', 'a.ts');
      svc.onWrite(t.engine.getSession(a.id)!, file);
      // what session/harness.ts emits for a tool_update with a diff
      t.engine.bus.emit({ type: 'tool.completed', sessionId: b.id, toolUseId: 'ht_1', result: { type: 'tool_result', toolUseId: 'ht_1', content: '', meta: { external: true, path: 'src/a.ts' } } });
      expect(w.raised).toHaveLength(1);
      expect(w.raised[0].text).toBe("'Fix login' and 'Claude Code run' are both editing src/a.ts");
    } finally {
      await t.close();
    }
  }, 60_000);

  test('ask mode: the second write asks first, and a denial leaves the file alone', async () => {
    let file = '';
    const t = await startTestEngine({
      script: [done],
      overrides: { permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [], onFileConflict: 'ask' } },
      route: byPrompt(() => ({ 'TASK-A': [write(file, 'mine\n'), done], 'TASK-B': [read(file), write(file, 'theirs\n'), done] })),
    });
    try {
      file = join(t.cwd, 'config.ts');
      const w = watch(t);
      const a = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd, permissionMode: 'bypass' });
      const b = await t.engine.createSession({ title: 'Refactor auth', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(a.id, 'TASK-A');
      // A's own first write asked nothing, even in bypass mode with ask on
      expect(t.approvals).toHaveLength(0);
      await t.run(b.id, 'TASK-B');
      // bypass mode, yet the conflicting write asked; the harness denies
      expect(t.approvals).toHaveLength(1);
      expect(t.approvals[0]).toContain("Another chat, 'Fix login', changed this file");
      expect(toolResults(t.engine, b.id).find((r) => r.name === 'Write')!.content).toContain('The user denied this action');
      expect(readFileSync(file, 'utf8')).toBe('mine\n');
      // the approval was the Inbox item: no alert
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('ask mode: an allowed write lands with its line and raises no second item', async () => {
    let file = '';
    const t = await startTestEngine({
      script: [done],
      approve: 'allow',
      overrides: { permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [], onFileConflict: 'ask' } },
      route: byPrompt(() => ({ 'TASK-A': [write(file, 'mine\n'), done], 'TASK-B': [read(file), write(file, 'theirs\n'), read(file), write(file, 'theirs again\n'), done] })),
    });
    try {
      file = join(t.cwd, 'config.ts');
      const w = watch(t);
      const a = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd, permissionMode: 'bypass' });
      const b = await t.engine.createSession({ title: 'Refactor auth', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(a.id, 'TASK-A');
      await t.run(b.id, 'TASK-B');
      // asked once per pair and file in the window: the second write went ahead
      expect(t.approvals).toHaveLength(1);
      const writes = toolResults(t.engine, b.id).filter((r) => r.name === 'Write');
      expect(writes.map((r) => r.isError)).toEqual([false, false]);
      expect(writes[0].content).toContain("Another chat, 'Fix login', changed this file");
      expect(writes[1].content).not.toContain('Another chat');
      expect(readFileSync(file, 'utf8')).toBe('theirs again\n');
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);
});
