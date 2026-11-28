import { describe, expect, test } from 'bun:test';
import { CONFIG_NUMBERS, configPatchProblem, DEFAULT_CONFIG } from '../../src/config';

/** The settings the apps write (Settings > Defaults, Notifications, GitHub, Logs...): PATCH /api/config refuses a bad one. */
describe('configPatchProblem', () => {
  test('passes good values, null resets and unrelated keys', () => {
    expect(configPatchProblem({})).toBeUndefined();
    expect(configPatchProblem({ ui: { name: 'x' }, limits: { autoResume: false } })).toBeUndefined();
    expect(configPatchProblem({ limits: { maxSteps: 2000, subagentMaxSteps: 1, stuck: { minutes: 0 }, routine: { tokens: 0, costUsd: 2.5, minutes: 300 }, waitShortResets: false } })).toBeUndefined();
    expect(configPatchProblem({ cache: { ttl: '1h' }, permissions: { onFileConflict: 'ask' }, models: { tiers: { fast: 'zai/glm-5', deep: null }, vision: 'openai/gpt-5.5', sameModel: true } })).toBeUndefined();
    expect(configPatchProblem({ github: { reposRoot: '~/code', pollSeconds: 0 }, logs: { keepDays: 7, maxMB: null }, documents: { docling: { url: 'http://192.168.1.5:5001' } } })).toBeUndefined();
    expect(configPatchProblem({ documents: { docling: { url: '' } }, server: { heavyCommands: 0, uploadMaxMb: 1000 }, agents: { skillTokens: 0 }, mcp: { deferAbove: 50 } })).toBeUndefined();
  });

  test('refuses out of range, fractions, wrong types and bad choices, naming the key', () => {
    expect(configPatchProblem({ limits: { maxSteps: 0 } })).toBe('limits.maxSteps must be a whole number from 1 to 2000.');
    expect(configPatchProblem({ limits: { maxSteps: 2.5 } })).toContain('limits.maxSteps');
    expect(configPatchProblem({ limits: { stuck: { minutes: -1 } } })).toContain('limits.stuck.minutes');
    expect(configPatchProblem({ limits: { session: { costUsd: -0.5 } } })).toBe('limits.session.costUsd must be a number from 0 to 100000.');
    expect(configPatchProblem({ limits: { subagent: { turns: '5' } } })).toContain('limits.subagent.turns');
    expect(configPatchProblem({ context: { switchBriefAt: Number.NaN } })).toContain('context.switchBriefAt');
    expect(configPatchProblem({ cache: { ttl: '2h' } })).toBe('cache.ttl must be one of auto, 5m, 1h.');
    expect(configPatchProblem({ permissions: { onFileConflict: 'block' } })).toContain('permissions.onFileConflict');
    expect(configPatchProblem({ limits: { waitShortResets: 'yes' } })).toContain('limits.waitShortResets');
    expect(configPatchProblem({ models: { tiers: { smart: 'glm-5' } } })).toBe('models.tiers.smart must be a model as provider/model.');
    expect(configPatchProblem({ models: { vision: 3 } })).toContain('models.vision');
    expect(configPatchProblem({ github: { reposRoot: '  ' } })).toContain('github.reposRoot');
    expect(configPatchProblem({ documents: { docling: { url: 'file:///etc/passwd' } } })).toContain('documents.docling.url');
    expect(configPatchProblem({ logs: { maxMB: 5 } })).toContain('logs.maxMB');
    expect(configPatchProblem({ server: { heavyCommands: 33 } })).toContain('server.heavyCommands');
  });

  test('defaults match DEFAULT_CONFIG', () => {
    expect(CONFIG_NUMBERS['limits.maxSteps'].default).toBe(DEFAULT_CONFIG.limits.maxSteps!);
    expect(CONFIG_NUMBERS['limits.subagentMaxSteps'].default).toBe(DEFAULT_CONFIG.limits.subagentMaxSteps!);
    expect(CONFIG_NUMBERS['limits.stuck.minutes'].default).toBe(DEFAULT_CONFIG.limits.stuck!.minutes!);
    expect(CONFIG_NUMBERS['context.switchBriefAt'].default).toBe(DEFAULT_CONFIG.context.switchBriefAt!);
    expect(CONFIG_NUMBERS['limits.routine.tokens'].default).toBe(DEFAULT_CONFIG.limits.routine!.tokens!);
    expect(CONFIG_NUMBERS['limits.routine.minutes'].default).toBe(DEFAULT_CONFIG.limits.routine!.minutes!);
  });
});
