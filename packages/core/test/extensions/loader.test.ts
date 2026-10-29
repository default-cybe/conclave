import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { Extensions } from '../../src/extensions/registry';
import { PluginManager } from '../../src/extensions/plugins';
import { loadAgentsFromDir, loadCommandsFromDir, defaultModelMapper } from '../../src/extensions/loader';
import { tempDir, cleanup, write } from './_helpers';

const dirs: string[] = [];
function home(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  cleanup(...dirs.splice(0));
  if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
});

function makeExtensions(h: string, claude: string) {
  const config = new ConfigStore(h);
  const plugins = new PluginManager({ dir: join(h, 'plugins'), defaultMarketplaces: [] });
  // Point Claude compat at a temp dir so the real ~/.claude is never read.
  process.env.CLAUDE_CONFIG_DIR = claude;
  return new Extensions({ config, plugins });
}

describe('agent frontmatter and model aliases', () => {
  test('parses fields and maps aliases', () => {
    const dir = home();
    const map = defaultModelMapper('anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5');
    write(join(dir, 'sonnet.md'), `---\nname: s\ndescription: d\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nbody s`);
    write(join(dir, 'haiku.md'), `---\nname: h\nmodel: haiku\n---\nbody h`);
    write(join(dir, 'inherit.md'), `---\nname: i\nmodel: inherit\n---\nbody i`);
    write(join(dir, 'literal.md'), `---\nname: l\nmodel: openai/gpt-5.5\nsubagent: true\n---\nbody l`);
    const agents = loadAgentsFromDir(dir, 'user', map);
    const by = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(by.s.tools).toEqual(['Read', 'Grep', 'Glob']);
    // Claude Code names become tier words; each session resolves them (extensions/agent-model.ts)
    expect(by.s.model).toBe('smart');
    expect(by.s.prompt).toBe('body s');
    expect(by.h.model).toBe('fast');
    expect(by.i.model).toBeUndefined();
    expect(by.l.model).toBe('openai/gpt-5.5');
    expect(by.l.subagent).toBe(true);
    expect(agents.every((a) => a.source === 'user')).toBe(true);
  });

  test('tools accepts a YAML list too', () => {
    const dir = home();
    const map = defaultModelMapper('a/b', 'a/c');
    write(join(dir, 'x.md'), `---\nname: x\ntools:\n  - Read\n  - Bash\n---\nbody`);
    const [a] = loadAgentsFromDir(dir, 'user', map);
    expect(a.tools).toEqual(['Read', 'Bash']);
  });

  test('a description that is not valid YAML keeps every list item', () => {
    const dir = home();
    const map = defaultModelMapper('a/b', 'a/c');
    // "Use when: ..." makes the YAML parser fail, so the line parser takes over
    write(join(dir, 'y.md'), `---\nname: y\ndescription: Use when: memory needs a tidy\ndisallowedTools:\n  - Write\n  - Edit\n  - MultiEdit\ntools:\n  - Read\n  - Grep\n---\nbody`);
    const [a] = loadAgentsFromDir(dir, 'user', map);
    expect(a.description).toBe('Use when: memory needs a tidy');
    expect(a.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit']);
    expect(a.tools).toEqual(['Read', 'Grep']);
  });
});

describe('command loading', () => {
  test('nested folders give colon names and parse hints', () => {
    const dir = home();
    const map = defaultModelMapper('a/b', 'a/c');
    write(join(dir, 'git', 'commit.md'), `---\ndescription: Commit\nargument-hint: "[msg]"\nallowed-tools: Bash(git commit:*)\n---\nDo it $ARGUMENTS`);
    write(join(dir, 'hello.md'), `---\ndescription: Hi\n---\nhi`);
    const cmds = loadCommandsFromDir(dir, 'user', map);
    const by = Object.fromEntries(cmds.map((c) => [c.name, c]));
    expect(by['git:commit'].description).toBe('Commit');
    expect(by['git:commit'].argumentHint).toBe('[msg]');
    expect(by['git:commit'].allowedTools).toEqual(['Bash(git commit:*)']);
    expect(by.hello.body).toBe('hi');
  });

  test('unquoted bracket hints keep their brackets', () => {
    const dir = home();
    const map = defaultModelMapper('a/b', 'a/c');
    write(join(dir, 'fix.md'), `---\ndescription: Fix an issue\nargument-hint: [issue-number]\n---\nFix #$0`);
    write(join(dir, 'pr.md'), `---\ndescription: Open a PR\nargument-hint: [base] [title]\n---\nOpen it`);
    const by = Object.fromEntries(loadCommandsFromDir(dir, 'user', map).map((c) => [c.name, c]));
    expect(by.fix.argumentHint).toBe('[issue-number]');
    expect(by.pr.argumentHint).toBe('[base] [title]');
    expect(by.pr.description).toBe('Open a PR');
  });
});

describe('precedence', () => {
  test('project overrides user overrides claude overrides builtin', () => {
    const h = home();
    const claude = home();
    const cwd = home();
    const ext = makeExtensions(h, claude);

    // builtin assistant exists by default.
    expect(ext.agent('assistant')?.source).toBe('builtin');

    // claude-level override of assistant.
    write(join(claude, 'agents', 'assistant.md'), `---\nname: assistant\ndescription: claude\n---\nclaude body`);
    // user-level override.
    write(join(h, 'agents', 'assistant.md'), `---\nname: assistant\ndescription: user\n---\nuser body`);
    // project-level override.
    write(join(cwd, '.conclave', 'agents', 'assistant.md'), `---\nname: assistant\ndescription: project\n---\nproject body`);
    // a claude-only new agent.
    write(join(claude, 'agents', 'fromclaude.md'), `---\nname: fromclaude\ndescription: c\n---\nc`);

    ext.reload();
    expect(ext.agent('assistant', cwd)?.description).toBe('project');
    expect(ext.agent('assistant', cwd)?.source).toBe('project');
    expect(ext.agent('fromclaude', cwd)?.source).toBe('claude');

    // Without the project cwd, the user override wins.
    expect(ext.agent('assistant')?.description).toBe('user');
  });

  test('skills load from claude and user dirs', () => {
    const h = home();
    const claude = home();
    const ext = makeExtensions(h, claude);
    write(join(claude, 'skills', 'alpha', 'SKILL.md'), `---\nname: alpha\ndescription: A skill\nallowed-tools: Read\n---\nbody`);
    write(join(h, 'skills', 'beta', 'SKILL.md'), `---\nname: beta\ndescription: B\n---\nbody`);
    ext.reload();
    const names = ext.skills().map((s) => s.name).sort();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(ext.skill('alpha')?.allowedTools).toEqual(['Read']);
  });

  test('the built-in web-studio skill is listed and loads from the binary', () => {
    const ext = makeExtensions(home(), home());
    const s = ext.skills().find((x) => x.name === 'web-studio');
    expect(s?.source).toBe('builtin');
    expect(s?.description).toContain('rubric');
    expect(s?.body).toContain('## Phase 5: Score and fix');
    expect(s?.body).not.toMatch(/^---/);
    expect(s?.body).not.toContain('\u2014');
    // typed as /web-studio, it expands to the body with no base directory line
    const cmd = ext.command('web-studio');
    expect(cmd?.body.startsWith('# web-studio')).toBe(true);
  });

  test('a learned or user skill with the same name wins over the built-in one', () => {
    const h = home();
    const ext = makeExtensions(h, home());
    write(join(h, 'learned-skills', 'web-studio', 'SKILL.md'), `---\nname: web-studio\ndescription: learned copy\nsource: learned\n---\nlearned body`);
    ext.reload();
    expect(ext.skill('web-studio')?.description).toBe('learned copy');
    expect(ext.skill('web-studio')?.body).toBeUndefined();
    expect(ext.inventory().find((i) => i.name === 'web-studio' && i.source === 'builtin')?.shadowedBy).toBe('learned');
    write(join(h, 'skills', 'web-studio', 'SKILL.md'), `---\nname: web-studio\ndescription: user copy\n---\nuser body`);
    ext.reload();
    expect(ext.skill('web-studio')?.source).toBe('user');
    expect(ext.command('web-studio')?.body).toContain('user body');
  });
});
