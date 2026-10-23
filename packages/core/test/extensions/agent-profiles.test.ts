import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultModelMapper, hooksField, loadAgentsFromDir } from '../../src/extensions/loader';
import { parseAgentMarkdown } from '../../src/extensions/builtin-agents';
import { agentModelRef, deepTierModel, subagentModel, type ModelHost } from '../../src/extensions/agent-model';
import { agentHookConfig, agentHooksAllowed, ensureRecipeScript, parseRecipeRef, recipeGroups, wantsVerifyGate } from '../../src/extensions/agent-hooks';
import type { AgentDef } from '../../src/extensions/types';
import type { ConclaveConfig } from '../../src/config/schema';
import { cleanup, tempDir, write } from './_helpers';

/**
 * Agent profile fields from docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2:
 * model tiers, effort, per-agent hooks and recipes, ultra and verifyCommand.
 */

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));
const td = (p = 'conclave-agentprof-') => {
  const d = tempDir(p);
  dirs.push(d);
  return d;
};

describe('frontmatter: tiers, effort, hooks, recipes', () => {
  test('Claude Code model names map to tier words; provider refs pass through', () => {
    const map = defaultModelMapper();
    expect(map('haiku')).toBe('fast');
    expect(map('sonnet')).toBe('smart');
    expect(map('opus')).toBe('deep');
    expect(map('opusplan')).toBe('deep');
    expect(map('Deep')).toBe('deep');
    expect(map('inherit')).toBeUndefined();
    expect(map('anthropic/claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
  });

  test('effort keeps xhigh and max; thinking wins over effort', () => {
    const dir = td();
    write(join(dir, 'a.md'), '---\nname: a\neffort: xhigh\n---\nbody');
    write(join(dir, 'b.md'), '---\nname: b\neffort: max\n---\nbody');
    write(join(dir, 'c.md'), '---\nname: c\nthinking: low\neffort: max\n---\nbody');
    const by = Object.fromEntries(loadAgentsFromDir(dir, 'user', defaultModelMapper()).map((x) => [x.name, x]));
    expect(by.a.thinking).toBe('xhigh');
    expect(by.b.thinking).toBe('max');
    expect(by.c.thinking).toBe('low');
  });

  test('hooks, recipes, ultra and verifyCommand load; unset ones stay absent', () => {
    const dir = td();
    write(
      join(dir, 'x.md'),
      [
        '---',
        'name: x',
        'hooks:',
        '  PreToolUse:',
        '    - matcher: Bash',
        '      hooks:',
        '        - type: command',
        '          command: ./check.sh',
        '  Bogus:',
        '    - hooks: [{ type: command, command: x }]',
        '  Stop:',
        '    - hooks: []',
        'recipes:',
        '  - no-test-gaming',
        '  - "write-scope WRITE_GLOB=docs/**,*.md"',
        'ultra: true',
        'verifyCommand: bun run typecheck',
        '---',
        'body',
      ].join('\n'),
    );
    write(join(dir, 'y.md'), '---\nname: y\n---\nbody');
    const by = Object.fromEntries(loadAgentsFromDir(dir, 'user', defaultModelMapper()).map((x) => [x.name, x]));
    expect(by.x.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }] });
    expect(by.x.recipes).toEqual(['no-test-gaming', 'write-scope WRITE_GLOB=docs/**,*.md']);
    expect(by.x.ultra).toBe(true);
    expect(by.x.verifyCommand).toBe('bun run typecheck');
    expect('hooks' in by.y || 'recipes' in by.y || 'ultra' in by.y || 'verifyCommand' in by.y).toBe(false);
  });

  test('a hooks value that is not an object is ignored', () => {
    expect(hooksField('Stop: x')).toBeUndefined();
    expect(hooksField(['a'])).toBeUndefined();
    expect(hooksField({ Stop: [{ hooks: [{ command: 'no type' }] }] })).toBeUndefined();
  });

  test('built-in files parse the same fields', () => {
    const def = parseAgentMarkdown('z', '---\nname: z\nmodel: opus\neffort: xhigh\nrecipes:\n  - verify-gate\n---\nbody');
    expect(def.model).toBe('deep');
    expect(def.thinking).toBe('xhigh');
    expect(def.recipes).toEqual(['verify-gate']);
    expect(wantsVerifyGate(def)).toBe(true);
    expect(wantsVerifyGate({ ...def, recipes: ['no-test-gaming'] })).toBe(false);
    expect(wantsVerifyGate({ ...def, recipes: undefined, verifyCommand: 'make check' })).toBe(true);
  });
});

function host(cfg: Partial<ConclaveConfig>, usable: (ref: string) => boolean = () => true): ModelHost {
  const config = { defaultModel: 'anthropic/claude-sonnet-5-5', smallModel: 'anthropic/claude-haiku-5-5', providers: {}, ...cfg } as ConclaveConfig;
  return { config: { get: () => config }, isUsable: usable };
}

describe('model tiers resolve per session', () => {
  const anthropic = { anthropic: { type: 'anthropic', apiKey: 'k' } } as unknown as ConclaveConfig['providers'];

  test('deep picks the cheapest deep catalog model of the session provider', () => {
    const h = host({ providers: anthropic });
    expect(deepTierModel(h, 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(agentModelRef(h, 'deep', 'anthropic/claude-sonnet-5-5')).toEqual({ model: 'anthropic/claude-opus-5-5', tier: 'deep' });
    // also when the deep model is the default model
    const h2 = host({ providers: anthropic, defaultModel: 'anthropic/claude-opus-5-5' });
    expect(agentModelRef(h2, 'opus', 'anthropic/claude-sonnet-5-5').model).toBe('anthropic/claude-opus-5-5');
  });

  test('a provider that lists models offers its first listed deep one', () => {
    const h = host({ providers: { z: { type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: 'k', models: ['glm-4.6', 'glm-5.3'] } } as never, defaultModel: 'z/glm-4.6' });
    expect(deepTierModel(h, 'z/glm-4.6')).toBe('z/glm-5.3');
  });

  test('models.tiers wins; fast is smallModel; smart is the session model', () => {
    const h = host({ providers: anthropic, models: { tiers: { deep: 'anthropic/claude-fable-5-1', fast: 'anthropic/claude-haiku-5' } } });
    expect(agentModelRef(h, 'deep', 'x/y').model).toBe('anthropic/claude-fable-5-1');
    expect(agentModelRef(h, 'haiku', 'x/y').model).toBe('anthropic/claude-haiku-5');
    expect(agentModelRef(host({ providers: anthropic }), 'fast', 'x/y').model).toBe('anthropic/claude-haiku-5-5');
    expect(agentModelRef(h, 'smart', 'openai/gpt-5.5').model).toBe('openai/gpt-5.5');
    expect(agentModelRef(h, undefined, 'openai/gpt-5.5').model).toBe('openai/gpt-5.5');
  });

  test('no deep model anywhere falls back to claude-code/opus when it is installed, then the session model', () => {
    const cc = host({ providers: { 'claude-code': { type: 'acp', command: 'claude' } } as never });
    expect(agentModelRef(cc, 'deep', 's/m').model).toBe('claude-code/opus');
    const missing = { ...cc, providers: { isConfigured: () => false } };
    expect(agentModelRef(missing, 'deep', 's/m').model).toBe('s/m');
    const none = host({ providers: {} });
    const r = agentModelRef(none, 'deep', 's/m');
    expect(r.model).toBe('s/m');
    expect(r.note).toContain('deep tier');
  });

  test('a subagent: a usable override wins, else the profile tier, else the parent', () => {
    const h = host({ providers: anthropic }, (ref) => ref.startsWith('anthropic/'));
    expect(subagentModel(h, 'anthropic/claude-opus-5', 'fast', 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-opus-5');
    expect(subagentModel(h, 'nope/model', 'fast', 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-haiku-5-5');
    expect(subagentModel(h, undefined, 'deep', 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(subagentModel(h, undefined, undefined, 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
  });
});

describe('agent hooks and recipes', () => {
  const agent = (over: Partial<AgentDef>): AgentDef => ({ name: 'a', description: '', prompt: '', source: 'user', ...over });
  const opts = (hooksDir: string, trusted = false) => ({ hooksDir, cwd: '/repo', trusted: () => trusted, pluginHooksOn: (n: string) => n !== 'off-plugin' });

  test('recipe refs carry tunables', () => {
    expect(parseRecipeRef('write-scope WRITE_GLOB=docs/**,*.md')).toEqual({ id: 'write-scope', env: { WRITE_GLOB: 'docs/**,*.md' } });
    expect(parseRecipeRef(' no-test-gaming ')).toEqual({ id: 'no-test-gaming', env: {} });
  });

  test('recipes become hook groups with the script written once, executable', () => {
    const dir = td();
    const groups = recipeGroups(agent({ recipes: ['write-scope WRITE_GLOB=**/*.test.*', 'verify-gate', 'not-a-recipe', 'diff-budget'] }), dir);
    const script = join(dir, 'recipes', 'write-scope.sh');
    expect(existsSync(script)).toBe(true);
    expect(statSync(script).mode & 0o111).toBeGreaterThan(0);
    const pre = groups.PreToolUse!;
    expect(pre[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit');
    expect((pre[0].hooks[0] as { command: string }).command).toBe(`WRITE_GLOB='**/*.test.*' ${script}`);
    expect(groups.PostToolUse?.[0].matcher).toBe('Edit|MultiEdit|Write');
    // verify-gate is not a hook, and an unknown id is skipped
    expect(Object.keys(groups).sort()).toEqual(['PostToolUse', 'PreToolUse']);
    // a stale script is rewritten
    write(script, 'old');
    ensureRecipeScript(dir, 'write-scope', readFileSync(script, 'utf8') === 'old' ? 'new text' : 'x');
    expect(readFileSync(script, 'utf8')).toBe('new text');
  });

  test('a subagent profile runs its Stop hooks on SubagentStop', () => {
    const dir = td();
    const stop = { hooks: [{ type: 'command' as const, command: 'echo stop' }] };
    const def = agent({ hooks: { Stop: [stop], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } });
    expect(agentHookConfig(def, 'SubagentStop', true, opts(dir))).toEqual({ SubagentStop: [stop] });
    expect(agentHookConfig(def, 'Stop', false, opts(dir))).toEqual({ Stop: [stop] });
    expect(agentHookConfig(def, 'PreToolUse', false, opts(dir))?.PreToolUse?.[0].matcher).toBe('Bash');
    expect(agentHookConfig(def, 'SubagentStop', false, opts(dir))).toBeUndefined();
    expect(agentHookConfig(agent({}), 'Stop', false, opts(dir))).toBeUndefined();
  });

  test('project agents need a trusted folder; plugin agents follow the plugin hooks switch', () => {
    const o = { trusted: () => false, pluginHooksOn: (n: string) => n !== 'off-plugin' };
    expect(agentHooksAllowed(agent({ source: 'builtin' }), '/repo', o)).toBe(true);
    expect(agentHooksAllowed(agent({ source: 'user', path: '/home/me/.conclave/agents/a.md' }), '/repo', o)).toBe(true);
    expect(agentHooksAllowed(agent({ source: 'project', path: '/repo/.conclave/agents/a.md' }), '/repo', o)).toBe(false);
    expect(agentHooksAllowed(agent({ source: 'claude', path: '/repo/.claude/agents/a.md' }), '/repo', o)).toBe(false);
    expect(agentHooksAllowed(agent({ source: 'claude', path: '/repo/.claude/agents/a.md' }), '/repo', { ...o, trusted: () => true })).toBe(true);
    expect(agentHooksAllowed(agent({ source: 'plugin', plugin: 'off-plugin' }), '/repo', o)).toBe(false);
    expect(agentHooksAllowed(agent({ source: 'plugin', plugin: 'on-plugin' }), '/repo', o)).toBe(true);
    const dir = td();
    const def = agent({ source: 'project', path: '/repo/.conclave/agents/a.md', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    expect(agentHookConfig(def, 'Stop', false, opts(dir, false))).toBeUndefined();
    expect(agentHookConfig(def, 'Stop', false, opts(dir, true))).toBeDefined();
  });
});
