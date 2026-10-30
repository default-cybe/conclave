import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, toolResults, type Block, type Step } from './harness';
import { cleanup, FakeMachine, tempDir, write } from '../extensions/_helpers';
import { HOOK_RECIPES } from '../../src/extensions/hook-recipes';
import { runRecipeTests } from '../../src/extensions/recipes';
import { ensureRecipeScript, recipeGroups } from '../../src/extensions/agent-hooks';
import { Hooks } from '../../src/extensions/hooks';
import { BUILTIN_AGENTS } from '../../src/extensions/builtin-agents';
import { VerifyGate, detectVerifyCommand } from '../../src/session/verify-gate';
import { looksLikeSecretFile } from '../../src/modes/review';
import { riskyPattern, validateSchema } from '../../src/tools/schema';
import type { AgentDef, HookInput } from '../../src/extensions/types';
import type { Engine } from '../../src/engine/engine';
import { OWNER_ID } from '../../src/people/context';
import type { ExecResult, Machine } from '../../src/machine/types';
import type { Session } from '../../src/types';

/**
 * Defects found in the QA pass of the specialist subagents
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md section 4). Each test failed
 * before its fix. Scripted model and local fixtures only, no paid calls.
 */

const dirs: string[] = [];
const td = (p = 'conclave-spqa-') => {
  const d = tempDir(p);
  dirs.push(d);
  return d;
};
const budgetFilesBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('conclave-diff-budget-')));
afterAll(() => {
  cleanup(...dirs);
  for (const f of readdirSync(tmpdir())) if (f.startsWith('conclave-diff-budget-') && !budgetFilesBefore.has(f)) rmSync(join(tmpdir(), f), { force: true });
});

const WRITE_SCOPE = HOOK_RECIPES.find((r) => r.id === 'write-scope')!;
const by = Object.fromEntries(BUILTIN_AGENTS.map((a) => [a.name, a]));
const globOf = (agent: string) => (by[agent].recipes ?? []).find((r) => r.startsWith('write-scope'))!.split('WRITE_GLOB=')[1];

/** Run the write-scope script on each path with one WRITE_GLOB; returns the paths it refused. */
async function refused(glob: string | undefined, paths: string[]): Promise<string[]> {
  const res = await runRecipeTests({
    ...WRITE_SCOPE,
    tests: paths.map((p) => ({
      name: p,
      event: 'PreToolUse' as const,
      matcherValue: 'Write',
      ...(glob ? { env: { WRITE_GLOB: glob } } : {}),
      input: { tool_name: 'Write', tool_input: { file_path: p, content: 'x' } },
      expect: { blocked: false },
    })),
  });
  return res.filter((r) => !r.ok).map((r) => r.name);
}

describe('write scope', () => {
  test('a ./ prefix or a doubled slash is the same path, not a refusal; .. still is', async () => {
    // before: "./docs/a.md has a . part. Use the plain path." cost the agent a retry on a normal path
    expect(await refused('docs/**,**/*.md', ['./docs/a.md', 'docs//guide.md', './README.md'])).toEqual([]);
    expect(await refused('docs/**,**/*.md', ['docs/./../src/a.md', 'docs/../src/a.ts'])).toEqual(['docs/./../src/a.md', 'docs/../src/a.ts']);
  }, 30_000);

  test("the tester's scope covers the common test layouts and nothing else", async () => {
    const glob = globOf('tester');
    const tests = [
      'src/auth.test.ts',
      'tests/test_api.py',
      'conftest.py',
      'tests/conftest.py',
      'Tests/AppTests/AppTests.swift',
      'app/src/androidTest/java/dev/kai/FooTest.kt',
      'app/src/test/java/dev/kai/FooTest.kt',
      'src/__mocks__/fs.ts',
      'pkg/server_test.go',
    ];
    expect(await refused(glob, tests)).toEqual([]);
    const source = ['src/auth.ts', 'package.json', 'Sources/App/App.swift', 'app/src/main/java/dev/kai/Foo.kt'];
    expect(await refused(glob, source)).toEqual(source);
  }, 60_000);
});

describe('a write scope that cannot run refuses writes instead of allowing them', () => {
  const input = (cwd: string, file: string): HookInput => ({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
  const agent = (recipes: string[]): AgentDef => ({ name: 'scoped', description: 'test', prompt: 'x', source: 'user', recipes });

  test('a tunable typo or a character a tunable cannot hold blocks every write, with the reason', async () => {
    const cwd = td();
    const hooksDir = td('conclave-spqa-hooks-');
    for (const recipes of [['write-scope WRITE_GLOBS=docs/**'], ['write-scope WRITE_GLOB=docs/$(id)']]) {
      const hooks = recipeGroups(agent(recipes), hooksDir);
      const out = await new Hooks({}).run('PreToolUse', input(cwd, 'src/a.ts'), { matcherValue: 'Write', hooks });
      expect(out.blocked).toBe(true);
      expect(out.reason ?? '').toContain('write scope');
    }
  }, 30_000);

  test('jq missing on the hub blocks writes and says to install it; other recipes are still skipped', async () => {
    const cwd = td();
    const hooksDir = td('conclave-spqa-hooks-');
    const noJq = (bin: string) => bin !== 'jq';
    const hooks = recipeGroups(agent(['write-scope WRITE_GLOB=docs/**', 'no-test-gaming']), hooksDir, noJq);
    const out = await new Hooks({}).run('PreToolUse', input(cwd, 'docs/a.md'), { matcherValue: 'Write', hooks });
    expect(out.blocked).toBe(true);
    expect(out.reason ?? '').toContain('jq');
    // no-test-gaming has no such guard: it is skipped as before, so only the scope guard is there
    expect((hooks.PreToolUse ?? []).length).toBe(1);
  }, 30_000);
});

describe("a write scope still works for a session on another device", () => {
  test("the device's folder is not on the hub: the hook still decides from its input", async () => {
    // the owner's sessions run on arch-desktop and the MacBook; their folders are not on the hub, where hooks run
    const hooksDir = td('conclave-spqa-hooks-');
    const hooks = recipeGroups({ name: 'scoped', description: 'test', prompt: 'x', source: 'user', recipes: ['write-scope WRITE_GLOB=docs/**'] }, hooksDir);
    const deviceCwd = '/home/kai/code/qa-not-on-this-hub';
    const run = (file: string) => new Hooks({}).run('PreToolUse', { session_id: 's', cwd: deviceCwd, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }, { matcherValue: 'Write', hooks });
    // before: the hook did not start (no such folder on the hub) and the write went through
    expect((await run(`${deviceCwd}/src/a.ts`)).blocked).toBe(true);
    expect((await run(`${deviceCwd}/docs/a.md`)).blocked).toBe(false);
  }, 30_000);

  test('a hub recipe installed in the config (tagged with its recipe id) also runs for a device folder', async () => {
    const hooksDir = td('conclave-spqa-hooks-');
    const script = ensureRecipeScript(hooksDir, 'write-scope', WRITE_SCOPE.script!);
    const hooks = { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command' as const, command: `WRITE_GLOB='docs/**' ${script}`, recipe: 'write-scope' }] }] };
    const out = await new Hooks({}).run('PreToolUse', { session_id: 's', cwd: '/home/kai/code/qa-not-on-this-hub', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } }, { matcherValue: 'Write', hooks });
    expect(out.blocked).toBe(true);
  }, 30_000);
});

describe('verify gate', () => {
  function stub(result: Partial<ExecResult>) {
    const notices: string[] = [];
    const machine = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1, ...result }),
      readText: async () => {
        throw new Error('missing');
      },
      stat: async () => null,
    } as unknown as Machine;
    const strict = { name: 'strict', description: '', prompt: 'x', source: 'user', verifyCommand: 'bun run typecheck' };
    const engine = {
      extensions: { agent: () => strict },
      agentNamed: () => strict,
      accountOf: () => OWNER_ID,
      trust: { isTrusted: () => true },
      machineFor: () => machine,
      notice: (_id: string, text: string) => notices.push(text),
      audit: () => {},
    } as unknown as Engine;
    const session = { id: 'ses_gate', kind: 'agent', agent: 'strict', cwd: '/w', device: 'local', permissionMode: 'default' } as Session;
    return { gate: new VerifyGate(engine), session, notices };
  }

  test('a check that times out does not send the agent back: it says the check could not finish', async () => {
    const { gate, session, notices } = stub({ exitCode: null, timedOut: true, stdout: 'checking 1200 files' });
    gate.noteEdit(session.id, '/w/a.ts');
    expect(await gate.check(session)).toBeUndefined();
    expect(notices.join('\n')).toContain('did not finish');
  });

  test('a missing command (exit 127 or 126) is not the agent\'s failure: one notice, no reminder', async () => {
    for (const exitCode of [127, 126]) {
      const { gate, session, notices } = stub({ exitCode, stderr: 'sh: 1: bun: not found' });
      gate.noteEdit(session.id, '/w/a.ts');
      expect(await gate.check(session)).toBeUndefined();
      expect(notices.join('\n')).toContain('could not run');
      // and only once per session
      gate.noteEdit(session.id, '/w/b.ts');
      expect(await gate.check(session)).toBeUndefined();
      expect(notices.length).toBe(1);
    }
  });

  test('a Python check compiles the file the tool wrote, not an old path it was mapped from', async () => {
    const commands: string[] = [];
    const machine = {
      exec: async (command: string) => (commands.push(command), { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1 }),
      readText: async () => {
        throw new Error('missing');
      },
      stat: async () => null,
    } as unknown as Machine;
    const coder = { name: 'coder', description: '', prompt: 'x', source: 'builtin', recipes: ['verify-gate'] };
    const engine = {
      extensions: { agent: () => coder },
      agentNamed: () => coder,
      accountOf: () => OWNER_ID,
      trust: { isTrusted: () => true },
      machineFor: () => machine,
      notice: () => {},
      audit: () => {},
    } as unknown as Engine;
    const session = { id: 'ses_py', kind: 'agent', agent: 'coder', cwd: '/new', device: 'local', permissionMode: 'default' } as Session;
    const gate = new VerifyGate(engine);
    const edit = { name: 'Edit', editsFiles: true } as never;
    gate.extension().afterTool!({ sessionId: session.id, session, tool: edit, input: { file_path: '/old/app.py' } } as never, {} as never, { content: 'ok', meta: { path: '/new/app.py' } });
    await gate.check(session);
    expect(commands).toEqual(["python3 -m py_compile '/new/app.py'"]);
  });

  test('a real failure still sends the agent back', async () => {
    const { gate, session } = stub({ exitCode: 2, stdout: 'a.ts(1,1): error TS2322' });
    gate.noteEdit(session.id, '/w/a.ts');
    expect(await gate.check(session)).toContain('error TS2322');
  });

  test('in a package of a monorepo the lockfile at the repo root picks the package manager', async () => {
    const root = td();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'bun.lock'), '');
    write(join(root, 'packages', 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { typecheck: 'tsc --noEmit' } }));
    const machine = new FakeMachine({ home: td('conclave-spqa-home-') });
    expect(await detectVerifyCommand(machine, join(root, 'packages', 'web'))).toBe('bun run typecheck');
    // a lockfile above the repo root says nothing about this repo
    const outer = td();
    writeFileSync(join(outer, 'pnpm-lock.yaml'), '');
    const inner = join(outer, 'repo');
    mkdirSync(join(inner, '.git'), { recursive: true });
    write(join(inner, 'package.json'), JSON.stringify({ name: 'r', scripts: { typecheck: 'tsc' } }));
    expect(await detectVerifyCommand(machine, inner)).toBe('npm run --silent typecheck');
  });
});

describe('the review packet keeps secrets out', () => {
  test('a new .env or key file is left out by name, and tokens in the diff are redacted', async () => {
    const t = await startTestEngine({ script: [[{ text: 'Added the client.' }]], approve: 'allow' });
    try {
      const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: t.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      git('init', '-q');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
      writeFileSync(join(t.cwd, '.env'), 'OPENAI_API_KEY=sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGG1234\n');
      writeFileSync(join(t.cwd, 'deploy.pem'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtopsecretbody\n-----END RSA PRIVATE KEY-----\n');
      writeFileSync(join(t.cwd, 'client.ts'), 'export const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";\nexport const RETRIES = 5;\n');
      const s = await t.engine.createSession({ title: 'r', cwd: t.cwd });
      await t.run(s.id, 'add the api client');
      const before = t.chores.length;
      await t.engine.secondOpinion(s.id, { reviewer: 'mock/claude-sonnet-5-5' });
      const sent = t.chores.slice(before).find((c) => c.includes('The answer to review'))!;
      expect(sent).toBeDefined();
      expect(sent).toContain('RETRIES = 5');
      expect(sent).not.toContain('sk-proj-AAAABBBB');
      expect(sent).not.toContain('ghp_abcdefghijklmnop');
      expect(sent).not.toContain('topsecretbody');
      expect(sent).toContain('.env');
      expect(sent).toContain('left out');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('a schema from a model cannot stall the hub', () => {
  test('a pattern with a nested quantifier is not run on a long string', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } }, required: ['a'] };
    const t = Date.now();
    validateSchema(schema, { a: `${'a'.repeat(40)}!` });
    // before: about 2^40 backtracking steps, the event loop stalled for hours
    expect(Date.now() - t).toBeLessThan(500);
    // short strings still get the pattern
    expect(validateSchema(schema, { a: 'ab' }).length).toBe(1);
    expect(riskyPattern('^(a+)+$')).toBe(true);
    expect(riskyPattern('^(\\w*\\s?)*$')).toBe(true);
    expect(riskyPattern('^[a-z]+$')).toBe(false);
    expect(riskyPattern('^(foo|bar)+$')).toBe(false);
    expect(riskyPattern('^\\d{4}-\\d{2}$')).toBe(false);
  });
});

describe('secret file names', () => {
  test('env, key and credential files are left out; source files that only mention them are not', () => {
    for (const f of ['.env', 'app/.env.local', 'deploy.pem', 'certs/site.key', 'id_ed25519', '.npmrc', 'credentials.json', 'k8s/db-secrets.yaml', 'gcp-service-account.json', 'prod.tfvars']) expect({ f, out: looksLikeSecretFile(f) }).toEqual({ f, out: true });
    for (const f of ['src/credentialsForm.tsx', 'src/secrets.ts', 'docs/env.md', 'src/keyboard.ts', 'README.md', 'src/api/token.ts']) expect({ f, out: looksLikeSecretFile(f) }).toEqual({ f, out: false });
  });
});

describe('a specialist on a harness tier keeps its role', () => {
  const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
  const task = (subagent_type: string, prompt: string): Block => ({ tool: 'Task', input: { description: 'child job', prompt, subagent_type } });

  async function withHarness(script: Step[]) {
    const t = await startTestEngine({ script, approve: 'allow' });
    const cfg = t.engine.config.get();
    t.engine.config.update({ providers: { ...cfg.providers, fake: { type: 'acp', command: process.execPath, args: [AGENT] } } } as never);
    return t;
  }

  test("the profile's instructions reach the harness with the brief", async () => {
    const t = await withHarness([[task('ro-check', 'echo check the finding')], [{ text: 'parent done' }]]);
    try {
      await t.engine.extensions.saveAgent({ name: 'ro-check', description: 'test child', prompt: 'ROLE-MARKER: try to prove the finding wrong.', source: 'user', subagent: true, model: 'fake/default', tools: ['Read', 'Grep'] }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const result = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
      // the fake harness echoes what it was sent
      expect(result.content).toContain('echo check the finding');
      expect(result.content).toContain('ROLE-MARKER');
    } finally {
      await t.engine.acp?.shutdown();
      await t.close();
    }
  }, 60_000);

  test('a profile without file tools runs the harness read-only: its edit and run requests are refused without asking', async () => {
    const t = await withHarness([[task('ro-check', 'ask-exec')], [{ text: 'parent done' }]]);
    try {
      await t.engine.extensions.saveAgent({ name: 'ro-check', description: 'test child', prompt: 'Read only.', source: 'user', subagent: true, model: 'fake/default', tools: ['Read', 'Grep'] }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const result = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
      expect(result.content).toContain('outcome:no');
      expect(t.approvals.some((a) => a.includes('rm -rf build'))).toBe(false);
    } finally {
      await t.engine.acp?.shutdown();
      await t.close();
    }
  }, 60_000);

  test('a read-only profile with a shell is asked for each command on a harness, even in bypass', async () => {
    const t = await withHarness([[task('ro-shell', 'ask-exec')], [{ text: 'parent done' }]]);
    try {
      await t.engine.extensions.saveAgent({ name: 'ro-shell', description: 'test child', prompt: 'Reads and runs one test.', source: 'user', subagent: true, model: 'fake/default', tools: ['Read', 'Grep', 'Bash'] }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(s.id, 'go');
      // before: bypass ran the harness in auto, so the command ran without asking
      expect(t.approvals.some((a) => a.includes('rm -rf build'))).toBe(true);
      expect(t.engine.listSessions({ parentId: s.id })[0]?.permissionMode).toBe('default');
    } finally {
      await t.engine.acp?.shutdown();
      await t.close();
    }
  }, 60_000);

  test('a profile that may write still asks the owner on a harness, as before', async () => {
    const t = await withHarness([[task('rw-build', 'ask-exec')], [{ text: 'parent done' }]]);
    try {
      await t.engine.extensions.saveAgent({ name: 'rw-build', description: 'test child', prompt: 'Builds.', source: 'user', subagent: true, model: 'fake/default', tools: ['Read', 'Edit', 'Bash'] }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      expect(toolResults(t.engine, s.id).find((r) => r.name === 'Task')!.content).toContain('outcome:yes');
      expect(t.approvals.some((a) => a.includes('rm -rf build'))).toBe(true);
    } finally {
      await t.engine.acp?.shutdown();
      await t.close();
    }
  }, 60_000);
});

describe('prompts and recipes match the spec', () => {
  test('the refactorer has the new-dependency gate (4.6)', () => {
    expect((by.refactorer.recipes ?? []).map((r) => r.split(/\s+/)[0])).toContain('new-dependency-gate');
  });

  test('the designer says what to do when it cannot set the window width', () => {
    // Conclave's browser tools have no viewport control, so the 390 and 1440 shots need another way or an honest gap
    expect(by.designer.prompt).toContain('Playwright');
    expect(by.designer.prompt).toContain('say which ones you could not take');
  });
});

