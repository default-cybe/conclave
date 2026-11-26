import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine } from './harness';
import { bashRefusal } from '../../src/engine/commands';
import { mayRunProjectCommand } from '../../src/session/verify-gate';
import type { Engine } from '../../src/engine/engine';
import type { Session } from '../../src/types';

/** A project command whose !`cmd` line leaves a marker file when it runs. */
function addCommand(cwd: string): string {
  mkdirSync(join(cwd, '.conclave', 'commands'), { recursive: true });
  writeFileSync(join(cwd, '.conclave', 'commands', 'mark.md'), 'Marked: !`touch ran.txt && echo done`\n');
  return join(cwd, 'ran.txt');
}

describe('!`cmd` lines in a typed command', () => {
  test('command and verify checks use the executing Windows shell', async () => {
    const machine = { lastInfo: { shell: 'C:\\Windows\\System32\\cmd.exe' } };
    const engine = {
      machineFor: () => machine,
      machineHome: async () => 'C:\\Users\\owner',
      permissionRulesFor: () => ({ allow: ['Bash'], ask: [], deny: ['Bash(mkdir:*)'] }),
      runnerFor: () => ({ sessionAllow: [] }),
      config: { get: () => ({ permissions: { additionalDirectories: [] } }) },
      trust: { isTrusted: () => false },
      requestApproval: () => { throw new Error('denied commands must not ask'); },
    } as unknown as Engine;
    const command = "echo 'safe & mkdir cc-review-owned & echo '";
    for (const permissionMode of ['default', 'plan', 'bypass'] as const) {
      const session = { id: 'windows-test', cwd: 'C:\\work', permissionMode } as Session;
      expect(await bashRefusal(engine, session, command, 'test', new AbortController().signal)).toContain('Denied');
      expect(await mayRunProjectCommand(engine, session, command)).toBe(false);
    }
  });

  test('get the permission check a Bash call gets', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]], approve: 'deny' });
    try {
      const marker = addCommand(t.cwd);
      const s = await t.engine.createSession({ cwd: t.cwd });

      // plan mode refuses it without asking
      t.engine.setPermissionMode(s.id, 'plan');
      await t.engine.command(s.id, '/mark');
      expect(existsSync(marker)).toBe(false);
      expect(t.approvals).toEqual([]);

      // default mode asks; the owner says no
      t.engine.setPermissionMode(s.id, 'default');
      await t.engine.command(s.id, '/mark');
      expect(existsSync(marker)).toBe(false);
      expect(t.approvals.length).toBe(1);
      expect(t.approvals[0]).toContain('/mark runs: touch ran.txt');

      // a deny rule wins over bypass mode
      const settings = join(t.cwd, '.conclave', 'settings.json');
      writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Bash(touch:*)'] } }));
      t.engine.setPermissionMode(s.id, 'bypass');
      await t.engine.command(s.id, '/mark');
      expect(existsSync(marker)).toBe(false);
      expect(t.approvals.length).toBe(1);

      // an allow rule lets it run without asking
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(touch:*)', 'Bash(echo:*)'] } }));
      t.engine.setProjectTrust(t.cwd, true);
      t.engine.setPermissionMode(s.id, 'default');
      await t.engine.command(s.id, '/mark');
      expect(existsSync(marker)).toBe(true);
      expect(t.approvals.length).toBe(1);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an @file line skips a file a Read deny rule covers', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      mkdirSync(join(t.cwd, '.conclave', 'commands'), { recursive: true });
      writeFileSync(join(t.cwd, '.conclave', 'commands', 'peek.md'), 'Look at @secret.env and @notes.md\n');
      writeFileSync(join(t.cwd, 'secret.env'), 'TOKEN=hunter2\n');
      writeFileSync(join(t.cwd, 'notes.md'), 'plain notes\n');
      writeFileSync(join(t.cwd, '.conclave', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(**/*.env)'] } }));
      t.engine.setProjectTrust(t.cwd, true);
      const s = await t.engine.createSession({ cwd: t.cwd });
      await t.engine.command(s.id, '/peek');
      await Promise.race([t.engine.runnerFor(s.id).waitIdle(), Bun.sleep(10_000)]);
      const sent = t.requests.at(-1) ?? '';
      expect(sent).toContain('plain notes');
      expect(sent).not.toContain('hunter2');
      expect(sent).toContain('@secret.env');
    } finally {
      await t.close();
    }
  }, 30_000);
});
