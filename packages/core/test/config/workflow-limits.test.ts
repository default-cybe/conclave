import { describe, expect, test } from 'bun:test';
import { WORKFLOW_LIMITS, workflowsProblem } from '../../src/config';
import { DEFAULTS } from '../../src/workflows/limits';

/** workflows.* caps (Settings > Advanced > Workflows and subagents): PATCH /api/config and `conclave config set` refuse a bad one. */
describe('workflowsProblem', () => {
  test('accepts whole numbers from 1 to each cap, null (reset) and a patch without workflows', () => {
    expect(workflowsProblem(undefined)).toBeUndefined();
    expect(workflowsProblem({})).toBeUndefined();
    expect(workflowsProblem({ concurrency: 1, perProvider: 32, hubMax: 64, maxAgents: 10_000 })).toBeUndefined();
    expect(workflowsProblem({ hubMax: null })).toBeUndefined();
    expect(workflowsProblem({ autoApproveTokens: 5_000_000 })).toBeUndefined();
    // keys it does not check pass through
    expect(workflowsProblem({ other: -1 })).toBeUndefined();
  });

  test('refuses 0, negatives, fractions, strings and values over the cap, naming the key and range', () => {
    expect(workflowsProblem({ concurrency: 0 })).toBe('workflows.concurrency must be a whole number from 1 to 16.');
    expect(workflowsProblem({ perProvider: -3 })).toBe('workflows.perProvider must be a whole number from 1 to 32.');
    expect(workflowsProblem({ hubMax: 2.5 })).toBe('workflows.hubMax must be a whole number from 1 to 64.');
    expect(workflowsProblem({ maxAgents: '50' })).toBe('workflows.maxAgents must be a whole number from 1 to 10000.');
    expect(workflowsProblem({ concurrency: 17 })).toContain('workflows.concurrency');
    expect(workflowsProblem({ perProvider: 33 })).toContain('workflows.perProvider');
    expect(workflowsProblem({ hubMax: 65 })).toContain('workflows.hubMax');
    expect(workflowsProblem({ maxAgents: 10_001 })).toContain('workflows.maxAgents');
    expect(workflowsProblem({ hubMax: Number.NaN })).toContain('workflows.hubMax');
    expect(workflowsProblem({ autoApproveTokens: 100_000_001 })).toContain('workflows.autoApproveTokens');
    expect(workflowsProblem(5)).toBe('workflows must be an object.');
  });

  test('defaults match the runtime, and concurrency tops out at the runtime clamp', () => {
    expect(WORKFLOW_LIMITS.concurrency).toEqual({ default: DEFAULTS.concurrency, max: DEFAULTS.maxConcurrency });
    expect([WORKFLOW_LIMITS.perProvider.default, WORKFLOW_LIMITS.hubMax.default, WORKFLOW_LIMITS.maxAgents.default]).toEqual([6, 16, 1000]);
  });
});
