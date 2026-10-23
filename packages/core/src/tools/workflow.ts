/**
 * Workflow: run a JavaScript workflow script that orchestrates subagents
 * (docs/WORKFLOWS.md). Compatible with Claude Code's Workflow tool. Main
 * agents only: workflow agents, subagents and untrusted agents never get it
 * (workflows/service.ts extension, UNTRUSTED_DENY).
 */
import type { Tool } from './types';
import { fail } from './util';
import { oneLine } from '../util/text';

export interface WorkflowInput {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
  run_in_background?: boolean;
  estimate?: { agents?: number; tokens?: number };
}

const DESCRIPTION = `Run a workflow: a JavaScript script that orchestrates many subagents, so the loop and the intermediate results stay out of your context and only the result comes back.

When to use it: the owner asked for a workflow, or a task clearly needs one (a review with independent checks, a sweep over many files, research across many sources, a migration in batches). Otherwise work directly. When Ultra is on, the system prompt says so and the rule there applies.

Pass the script inline with script, or a library workflow with name (review-changes, deep-research, research-sweep, plan-implement-verify, fix-until-green, fix-issue, bug-hunt, security-audit, design-panel, ui-pass, migrate, compare-harnesses), or scriptPath for a script saved earlier. Each run saves its script and returns the path; edit that file and run it again with scriptPath and resumeFromRunId, and unchanged calls replay from the journal.

The script begins with a pure literal: export const meta = { name, description, phases: [{ title }] }. Then the body, in an async context:
- agent(prompt, { label, phase, schema, model, effort, isolation: 'worktree', agentType }) returns the agent's final text, or the validated object when schema is set, or null when it fails or the owner skips it.
- parallel(thunks) waits for all; a thunk that throws gives null. pipeline(items, ...stages) runs each item through the stages with no barrier; each stage gets (prev, item, index). Prefer pipeline.
- phase(title), log(text), args, budget.total / budget.spent() / budget.remaining(), workflow(name, args).
- Date.now(), Math.random() and new Date() with no arguments throw; there is no filesystem, network or Node API. Agents do that work.
- lib (Conclave only, set meta.runtime: 'conclave'): lib.schemas.finding, lib.checkCitations, lib.dedupe, lib.panel, lib.loopUntilDry, lib.judgePanel, lib.exec, lib.runCheck, lib.fence, lib.ask, lib.approve.

A finding or claim counts only when something outside the agent that made it confirms it: a test or typecheck that runs, a quote found in the source, or independent votes tallied in code. Put earlier agents' output into later prompts with lib.fence.

Give estimate { agents, tokens } so the approval card can show the cost. With run_in_background the call returns at once and the result arrives later in a <workflow_result> block, so there is no need to wait. WorkflowStatus shows how a run is going (phases, agents, errors, the last log lines) when the owner asks or you need it before the result; do not call it in a loop.`;

export const WorkflowTool: Tool<WorkflowInput> = {
  name: 'Workflow',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'The workflow script, starting with export const meta = {...}' },
      scriptPath: { type: 'string', description: 'Path of a saved script (a run returns it)' },
      name: { type: 'string', description: 'A library workflow by name' },
      args: { description: 'Value the script reads as args. Pass arrays and objects as JSON values, not as a string.' },
      resumeFromRunId: { type: 'string', description: 'Replay unchanged calls from this earlier run' },
      run_in_background: { type: 'boolean', description: 'Return at once; the result arrives as a <workflow_result> block' },
      estimate: {
        type: 'object',
        properties: { agents: { type: 'number' }, tokens: { type: 'number' } },
        description: 'Your estimate of agents and total tokens, shown on the approval card',
      },
    },
    additionalProperties: false,
  },
  // the run's own agents and lib.exec calls go through permissions; the tool asks for approval itself
  // (workflows/service.ts runFromTool), except in bypass mode, where it starts without the card
  readOnly: true,
  summarize: (input) => `Workflow ${input.name ?? (input.scriptPath ? oneLine(input.scriptPath, 60) : 'script')}`,
  async run(input, ctx) {
    const svc = ctx.host.workflows;
    if (!svc) return fail('Workflows are not available on this hub.');
    if (ctx.depth > 0) return fail('Workflow is not available to subagents or workflow agents. Do the work directly.');
    if (!input.script && !input.scriptPath && !input.name && !input.resumeFromRunId) return fail('Give script, scriptPath or name.');
    try {
      const out = await svc.runFromTool(
        {
          ...(input.name ? { name: input.name } : {}),
          ...(input.script ? { script: input.script } : {}),
          ...(input.scriptPath ? { scriptPath: input.scriptPath } : {}),
          ...(input.args !== undefined ? { args: input.args } : {}),
          ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
          background: !!input.run_in_background,
          sessionId: ctx.sessionId,
        },
        { toolUseId: ctx.toolUseId, signal: ctx.signal, estimate: input.estimate },
      );
      return { content: out.text, meta: { workflowRunId: out.runId, ...(out.scriptPath ? { scriptPath: out.scriptPath } : {}) }, ...(out.isError ? { isError: true } : {}) };
    } catch (err) {
      if (ctx.signal.aborted) return fail('The workflow was interrupted.');
      return fail(`Workflow failed to start: ${(err as Error).message}`);
    }
  },
};
