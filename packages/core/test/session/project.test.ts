import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine } from '../../src/machine/local';
import { detectTestCommand, detectWorkspaceFacts, python3Only } from '../../src/session/project';
import { createEngine } from '../../src/engine';
import type { Machine } from '../../src/machine/types';
import { buildSystemPrompt } from '../../src/session/prompt';

const root = mkdtempSync(join(tmpdir(), 'conclave-project-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const machine = new LocalMachine();

function repo(name: string, files: Record<string, string>): string {
  const d = join(root, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  mkdirSync(d, { recursive: true });
  return d;
}

describe('detectTestCommand', () => {
  test('the bench task layouts', async () => {
    expect(await detectTestCommand(machine, repo('ts', { 'package.json': '{"scripts":{"test":"bun test"}}', 'src/a.ts': '' }))).toBe('bun test');
    expect(await detectTestCommand(machine, repo('py', { 'tasksd/__init__.py': '', 'tests/test_api.py': '', 'README.md': '' }))).toBe('python3 -m unittest discover -s tests');
    expect(await detectTestCommand(machine, repo('rs', { 'Cargo.toml': '[package]', 'src/lib.rs': '' }))).toBe('cargo test');
    expect(await detectTestCommand(machine, repo('go', { 'go.mod': 'module x', 'x.go': '' }))).toBe('go test ./...');
  });

  test('package managers, pytest, make, and nothing clear', async () => {
    expect(await detectTestCommand(machine, repo('vitest', { 'package.json': '{"scripts":{"test":"vitest run"}}', 'pnpm-lock.yaml': '' }))).toBe('pnpm test');
    expect(await detectTestCommand(machine, repo('bunrun', { 'package.json': '{"scripts":{"test":"vitest"}}', 'bun.lock': '' }))).toBe('bun run test');
    expect(await detectTestCommand(machine, repo('npmdefault', { 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }))).toBeUndefined();
    expect(await detectTestCommand(machine, repo('pytest', { 'pyproject.toml': '[tool.pytest.ini_options]\n', 'tests/test_x.py': '' }))).toBe('python3 -m pytest');
    expect(await detectTestCommand(machine, repo('make', { Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }))).toBe('make test');
    expect(await detectTestCommand(machine, repo('lone', { 'bowling.py': '' }))).toBeUndefined();
    expect(await detectTestCommand(machine, join(root, 'missing'))).toBeUndefined();
  });

  test('the Environment block names it', () => {
    const base = { session: { cwd: '/w' }, agent: { name: 'coder', prompt: '' }, modelRef: 'm', mode: 'agent', toolNames: ['Bash'], platform: 'linux', isGitRepo: true, deviceName: 'hub', projectInstructions: [], profile: [], skills: [], subagents: [], date: '2026-10-17' } as never;
    const env = (p: object) => buildSystemPrompt({ ...(base as object), ...p } as never)[1].text;
    expect(env({ testCommand: 'cargo test' })).toContain('- Test command: cargo test');
    expect(env({})).not.toContain('Test command');
  });
});

describe('workspace facts', () => {
  /** A machine with these root entries (a trailing / marks a folder) whose shell answers the python check with `pythonExit`. */
  function fake(names: string[], pythonExit: number | 'throw' = 0) {
    const commands: string[] = [];
    const m = {
      readdir: async () => names.map((n) => ({ name: n.replace(/\/$/, ''), type: n.endsWith('/') ? 'dir' : 'file' })),
      exec: async (command: string) => {
        commands.push(command);
        if (pythonExit === 'throw') throw new Error('device offline');
        return { exitCode: pythonExit, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1 };
      },
    } as unknown as Machine;
    return { m, commands };
  }

  test('a Python project on a device with python3 and no python says so', async () => {
    const { m, commands } = fake(['tasksd/', 'tests/', 'README.md']);
    expect(await detectWorkspaceFacts(m, '/w', { testCommand: 'python3 -m unittest discover -s tests' })).toEqual({ python3Only: true });
    expect(commands).toEqual(['command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1']);
    // a lone exercise file counts as Python too
    expect((await detectWorkspaceFacts(fake(['bowling.py']).m, '/w', {})).python3Only).toBe(true);
  });

  test('python present, an offline device, or a project that is not Python: no line', async () => {
    expect(await detectWorkspaceFacts(fake(['app.py'], 1).m, '/w', {})).toEqual({});
    expect(await detectWorkspaceFacts(fake(['app.py'], 'throw').m, '/w', {})).toEqual({});
    const ts = fake(['package.json', 'src/']);
    expect(await detectWorkspaceFacts(ts.m, '/w', { testCommand: 'bun test' })).toEqual({});
    // not even asked
    expect(ts.commands).toEqual([]);
  });

  test('the check at stop: the gate command, py_compile for Python, or no type checker', async () => {
    const cmd = (c?: string) => async () => c;
    expect((await detectWorkspaceFacts(fake(['package.json']).m, '/w', { stopCheck: cmd('bun run typecheck') })).stopCheck).toBe('bun run typecheck');
    expect((await detectWorkspaceFacts(fake(['package.json']).m, '/w', { stopCheck: cmd() })).stopCheck).toBe('no type checker found');
    expect((await detectWorkspaceFacts(fake(['app.py'], 1).m, '/w', { stopCheck: cmd() })).stopCheck).toBe('python3 -m py_compile on the .py files you edit; no type checker found');
    const broken = async (): Promise<string | undefined> => {
      throw new Error('no settings');
    };
    expect((await detectWorkspaceFacts(fake([]).m, '/w', { stopCheck: broken })).stopCheck).toBe('no type checker found');
  });

  test('python3Only on this machine runs a real shell', async () => {
    const hasPython = Bun.spawnSync(['sh', '-c', 'command -v python']).exitCode === 0;
    const hasPython3 = Bun.spawnSync(['sh', '-c', 'command -v python3']).exitCode === 0;
    expect(await python3Only(machine, root)).toBe(hasPython3 && !hasPython);
  });

  test('the Environment block names them', () => {
    const base = { session: { cwd: '/w' }, agent: { name: 'coder', prompt: '' }, modelRef: 'm', mode: 'agent', toolNames: ['Bash'], platform: 'linux', isGitRepo: true, deviceName: 'hub', projectInstructions: [], profile: [], skills: [], subagents: [], date: '2026-10-20' } as never;
    const env = (p: object) => buildSystemPrompt({ ...(base as object), ...p } as never)[1].text;
    const text = env({ testCommand: 'python3 -m unittest discover -s tests', workspace: { python3Only: true, stopCheck: 'no type checker found' } });
    expect(text).toContain('- Python: use python3; this device has no python command');
    expect(text).toContain('- Check run when you stop: no type checker found');
    expect(env({ workspace: {} })).not.toContain('Python:');
    expect(env({})).not.toContain('Check run when you stop');
  });
});

describe('workspace facts in a session', () => {
  test('read once per session on the session machine; the stop check only for an agent with the verify gate', async () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-facts-home-'));
    const claude = mkdtempSync(join(tmpdir(), 'conclave-facts-claude-'));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claude;
    const cwd = repo('facts-ts', { 'package.json': '{"scripts":{"test":"bun test","typecheck":"tsc --noEmit"}}', 'bun.lock': '' });
    const engine = await createEngine({ home, noBackground: true, version: 'test' });
    try {
      const coder = await engine.createSession({ title: 'c', cwd, agent: 'coder' });
      const plain = await engine.createSession({ title: 'p', cwd, agent: 'general-purpose' });
      const m = engine.machineFor(coder);
      let reads = 0;
      const readdir = m.readdir.bind(m);
      m.readdir = (p: string) => {
        if (p === cwd) reads++;
        return readdir(p);
      };
      const parts = (s: typeof coder) => engine.systemPromptParts(s, engine.agentFor(s), 'x/y', 'agent', ['Bash', 'Read']);
      const first = await parts(coder);
      expect(first.workspace).toEqual({ stopCheck: 'bun run typecheck' });
      const after = reads;
      expect((await parts(coder)).workspace).toEqual(first.workspace);
      // the second build reads nothing again for the facts
      expect(reads).toBe(after);
      expect((await parts(plain)).workspace).toEqual({});
      expect(buildSystemPrompt(first)[1].text).toContain('- Check run when you stop: bun run typecheck');
    } finally {
      await engine.shutdown();
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    }
  }, 30_000);
});
