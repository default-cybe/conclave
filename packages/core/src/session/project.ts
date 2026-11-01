import type { Machine } from '../machine/types';

/**
 * The command that runs a project's tests, read from the files at its root,
 * for the Environment block. A model that knows it does not spend turns
 * trying runners (one benchmark run tried three unittest invocations).
 * Undefined when nothing clear is found.
 */
export async function detectTestCommand(machine: Machine, cwd: string): Promise<string | undefined> {
  const entries = await machine.readdir(cwd).catch(() => []);
  const files = new Set(entries.filter((e) => e.type !== 'dir').map((e) => e.name));
  const dirs = new Set(entries.filter((e) => e.type === 'dir').map((e) => e.name));
  const read = (name: string) => machine.readText(`${cwd}/${name}`).catch(() => '');

  if (files.has('package.json')) {
    let test: unknown;
    try {
      test = JSON.parse(await read('package.json'))?.scripts?.test;
    } catch {
      test = undefined;
    }
    if (typeof test === 'string' && test.trim() && !/no test specified/.test(test)) {
      if (files.has('bun.lock') || files.has('bun.lockb')) return test.trim() === 'bun test' ? 'bun test' : 'bun run test';
      if (files.has('pnpm-lock.yaml')) return 'pnpm test';
      if (files.has('yarn.lock')) return 'yarn test';
      return test.trim() === 'bun test' ? 'bun test' : 'npm test';
    }
  }
  if (files.has('Cargo.toml')) return 'cargo test';
  if (files.has('go.mod')) return 'go test ./...';

  const python = files.has('pyproject.toml') || files.has('setup.py') || files.has('setup.cfg') || [...files].some((f) => f.endsWith('.py'));
  if (python || dirs.has('tests')) {
    const config = (await Promise.all(['pyproject.toml', 'setup.cfg', 'tox.ini'].filter((f) => files.has(f)).map(read))).join('\n');
    if (files.has('pytest.ini') || files.has('conftest.py') || /\[tool\.pytest|\[pytest\]|\[tool:pytest\]/.test(config)) return 'python3 -m pytest';
    for (const dir of ['tests', 'test']) {
      if (!dirs.has(dir)) continue;
      const inside = await machine.readdir(`${cwd}/${dir}`).catch(() => []);
      if (inside.some((e) => /^test.*\.py$/.test(e.name))) return `python3 -m unittest discover -s ${dir}`;
    }
    if ([...files].some((f) => /^test.*\.py$/.test(f))) return 'python3 -m unittest';
  }
  if (files.has('Makefile')) {
    if (/^test:/m.test(await read('Makefile'))) return 'make test';
  }
  return undefined;
}

/**
 * Facts about the device and folder for the Environment block, so the model
 * does not learn them from failed calls (run 4: four `python: command not
 * found` errors and two probes for tsc). Read once per session on the
 * machine the session's tools run on, so the system prompt stays the same.
 */
export interface WorkspaceFacts {
  /** python3 is on the PATH and python is not. Only checked for a Python project. */
  python3Only?: boolean;
  /** What the verify gate runs when the agent stops after edits. Undefined when the gate is off. */
  stopCheck?: string;
}

const PY_PROJECT_FILES = new Set(['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']);

/** Python files or packaging at the folder's root, or a python3 test command. */
async function looksPython(machine: Machine, cwd: string, testCommand?: string): Promise<boolean> {
  if (testCommand?.startsWith('python3')) return true;
  const entries = await machine.readdir(cwd).catch(() => []);
  return entries.some((e) => e.type !== 'dir' && (e.name.endsWith('.py') || PY_PROJECT_FILES.has(e.name)));
}

/** python3 runs on the machine and python does not. False when the shell cannot tell (cmd.exe, an offline device). */
export async function python3Only(machine: Machine, cwd: string): Promise<boolean> {
  try {
    const r = await machine.exec('command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1', { cwd, timeoutMs: 5_000 });
    return r.exitCode === 0 && !r.timedOut;
  } catch {
    return false;
  }
}

/**
 * The workspace facts for one session. `stopCheck` is the verify gate's own
 * lookup (session/verify-gate.ts verifyCommandFor, which ends in
 * detectVerifyCommand); pass it only when the gate is on for the agent.
 */
export async function detectWorkspaceFacts(machine: Machine, cwd: string, opts: { testCommand?: string; stopCheck?: () => Promise<string | undefined> }): Promise<WorkspaceFacts> {
  const python = await looksPython(machine, cwd, opts.testCommand);
  const facts: WorkspaceFacts = {};
  if (python && (await python3Only(machine, cwd))) facts.python3Only = true;
  if (opts.stopCheck) {
    const command = await opts.stopCheck().catch(() => undefined);
    // with no command, the gate compiles the Python files the turn edited (detectVerifyCommand)
    facts.stopCheck = command ?? (python ? 'python3 -m py_compile on the .py files you edit; no type checker found' : 'no type checker found');
  }
  return facts;
}
