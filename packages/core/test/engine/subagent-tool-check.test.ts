/**
 * Tool preflight before a subagent or a delegated session starts (idea-9, GPT
 * ideas run wfr_0mvnmulncxbcgx31tlg): a brief that needs a capability its
 * agent has no tool for is refused up front with words that name a better
 * agent, instead of starting and failing mid-run.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, toolResults, type RequestBody, type TestEngine } from './harness';
import { runDelegate } from '../../src/engine/delegate';
import { missingTools } from '../../src/engine/tool-check';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const isChild = (body: RequestBody) => firstUserText(body).includes('CHILD-JOB');
const task = (agent: string, prompt: string) => ({ tool: 'Task', input: { description: 'child job', prompt, subagent_type: agent } });

describe('missingTools', () => {
  const reader = { name: 'reader', tools: ['Read', 'Grep'] };

  test('a brief that needs a shell is refused for an agent without Bash', () => {
    expect(missingTools('Run the tests and report what fails.', reader)).toContain('no Bash');
    expect(missingTools('Run the tests and report what fails.', reader)).toContain('coder or general-purpose');
  });

  test('a brief that changes files is refused for an agent without file-editing tools, even with a shell', () => {
    const looker = { name: 'looker', tools: ['Read', 'Grep', 'Glob', 'Bash'] };
    expect(missingTools('Fix the off-by-one in src/app.ts', looker)).toContain('no file-editing');
  });

  test("a read-only run loses only the file-editing tools; a shell stays (explore keeps its Bash)", () => {
    expect(missingTools('Run the tests and report.', { name: 'explore', tools: ['Read', 'Grep', 'Bash'] }, 'read-only')).toBeUndefined();
    // a read-only run takes the edit tools away even when the list names them (engine.ts toolsFor)
    expect(missingTools('Fix the bug.', { name: 'coder', tools: ['Read', 'Edit', 'Bash'] }, 'read-only')).toContain('gets no file-editing');
    expect(missingTools('Fix the bug.', { name: 'coder' }, 'read-only')).toContain('gets no file-editing');
  });

  test('plan mode loses the shell too, whatever the list says', () => {
    expect(missingTools('Run the tests and report.', { name: 'coder', tools: ['Read', 'Edit', 'Bash'] }, 'plan')).toContain('plan mode');
    expect(missingTools('Fix the bug.', { name: 'coder', tools: ['Read', 'Edit', 'Bash'] }, 'plan')).toContain('plan mode');
    // research briefs still pass in plan mode
    expect(missingTools('Find every caller of parse().', { name: 'explore', tools: ['Read', 'Grep'] }, 'plan')).toBeUndefined();
  });

  test('disallowedTools counts even when tools is undefined (all defaults)', () => {
    expect(missingTools('Run the tests and report what fails.', { name: 'no-shell', disallowedTools: ['Bash'] })).toContain('Bash');
    expect(missingTools('Run the tests and report what fails.', { name: 'no-shell', tools: ['Read', 'Grep'], disallowedTools: ['Edit'] })).toContain('no Bash');
  });

  test('research briefs that mention a tool in passing are not refused (never block when unsure)', () => {
    expect(missingTools('Summarize what the install script does.', reader)).toBeUndefined();
    expect(missingTools('Explain the migration in the deploy notes.', reader)).toBeUndefined();
    expect(missingTools('Find where the code writes the config value.', reader)).toBeUndefined();
    // a clear instruction still refuses
    expect(missingTools('Install the package and report the output.', reader)).toContain('no Bash');
    expect(missingTools('Then run the linter on src/.', reader)).toContain('no Bash');
  });

  test('research briefs and agents with the tools pass', () => {
    expect(missingTools('Find every caller of parse() and report file:line.', reader)).toBeUndefined();
    expect(missingTools('When did this change? Use git log.', { name: 'explore', tools: ['Read', 'Grep', 'Bash'] })).toBeUndefined();
    expect(missingTools('Run the tests.', { name: 'coder', tools: ['Read', 'Edit', 'Bash'] })).toBeUndefined();
    expect(missingTools('Fix the config.', { name: 'general-purpose' })).toBeUndefined();
  });
});

describe('Task preflight', () => {
  test('a shell job on an agent without Bash is refused before the subagent starts', async () => {
    t = await startTestEngine({
      script: [[task('reader', 'CHILD-JOB: run the tests and report what fails')], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'RAN: ok' }] : undefined),
    });
    await t.engine.extensions.saveAgent({ name: 'reader', description: 'reads only', prompt: 'Read-only search.', source: 'user', subagent: true, tools: ['Read', 'Grep'] }, 'user');
    const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
    await t.run(s.id, 'go');
    const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
    expect(res.isError).toBe(true);
    expect(res.content).toContain('no Bash');
    expect(res.content).toContain('reader');
    expect(t.engine.listSessions({ parentId: s.id })).toHaveLength(0);
    expect(t.requests.some((r) => isChild(JSON.parse(r)))).toBe(false);
  });

  test('a shell job from a plan-mode parent is refused: the child inherits read-only and would get no shell', async () => {
    t = await startTestEngine({
      script: [[task('coder', 'CHILD-JOB: run the tests and report what fails')], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'RAN: ok' }] : undefined),
    });
    const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'plan' });
    await t.run(s.id, 'go');
    const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
    expect(res.isError).toBe(true);
    expect(res.content).toContain('plan mode');
    expect(t.engine.listSessions({ parentId: s.id })).toHaveLength(0);
    expect(t.requests.some((r) => isChild(JSON.parse(r)))).toBe(false);
  });

  test('a research job on the same agent still runs', async () => {
    t = await startTestEngine({
      script: [[task('reader', 'CHILD-JOB: find every caller of parse()')], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'FOUND: 2 callers' }] : undefined),
    });
    await t.engine.extensions.saveAgent({ name: 'reader', description: 'reads only', prompt: 'Read-only search.', source: 'user', subagent: true, tools: ['Read', 'Grep'] }, 'user');
    const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
    await t.run(s.id, 'go');
    const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('FOUND: 2 callers');
  });
});

describe('Delegate preflight', () => {
  test("a read-only job whose brief changes files is refused before a session starts", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    await expect(
      runDelegate(t.engine, chat.id, { to: 'code', prompt: 'Fix the failing check in app.ts', title: 'Fix the check', readOnly: true, background: false, depth: 0, toolUseId: 't1' }),
    ).rejects.toThrow('no file-editing');
    expect(t.engine.listSessions({ parentId: chat.id })).toHaveLength(0);
  });
});
