/**
 * PullRequest: the model's way to publish a repo session's branch
 * (docs/DESIGN.md 30). Only repo sessions get it (the github runner
 * extension adds it), never subagents or untrusted sessions.
 *
 * Every push and every pull request asks the owner, in any permission mode,
 * with no "always allow": the tool asks itself, so neither a rule, a mode
 * nor a hook can answer for the owner. It is marked read-only so the runner
 * does not ask a second time; reading the state asks nothing.
 */
import type { Tool, ToolOutput } from '../tools/types';
import type { GithubService } from './service';

export const PULL_REQUEST_TOOL = 'PullRequest';

interface Input {
  action: 'push' | 'open' | 'status';
  title?: string;
  body?: string;
  draft?: boolean;
}

function text(content: string, isError = false): ToolOutput {
  return isError ? { content, isError: true } : { content };
}

export function pullRequestTool(svc: GithubService): Tool<Input> {
  return {
    name: PULL_REQUEST_TOOL,
    description: [
      "Publish this session's work on GitHub. This session works in a git worktree of a GitHub repository, on its own branch made for it.",
      '',
      '- action "push": push the branch to GitHub.',
      '- action "open": push the branch and open a pull request into the base branch, with a short title and a Markdown body that says what changed and how it was checked.',
      '- action "status": the pull request and its checks, as GitHub has them now.',
      '',
      'Only commits are pushed: commit your changes in the worktree first. The owner approves every push and every pull request, so call it once the work is done and checked, not after each commit. Conclave never force pushes and never pushes to the default branch. Do not run git push yourself.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['push', 'open', 'status'], description: 'What to do.' },
        title: { type: 'string', description: 'The pull request title (action "open").' },
        body: { type: 'string', description: 'The pull request body in Markdown (action "open").' },
        draft: { type: 'boolean', description: 'Open the pull request as a draft.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    readOnly: true,
    summarize: (i) => (i.action === 'open' ? `Open a pull request: ${i.title ?? ''}`.trim() : i.action === 'push' ? 'Push the branch' : 'Read the pull request'),
    async run(input, ctx) {
      const row = svc.row(ctx.sessionId);
      if (!row) return text('This session is not a repo session.', true);
      if (row.cleanedAt) return text('This session was cleaned up. Its worktree is gone.', true);
      const engine = svc.engine;
      try {
        if (input.action === 'status') {
          const d = await svc.dto(ctx.sessionId, { refresh: true });
          return text([d.line, d.pr ? `Pull request: ${d.pr.url}` : '', d.ciUrl ? `Checks: ${d.ciUrl}` : ''].filter(Boolean).join('\n'));
        }
        if (input.action !== 'push' && input.action !== 'open') return text('action must be push, open or status.', true);
        if (input.action === 'open' && !input.title?.trim()) return text('A pull request needs a title.', true);
        if (input.action === 'open' && row.prNumber && row.prState === 'open') return text(`Pull request #${row.prNumber} is already open: ${row.prUrl}. Use action "push" to add commits to it.`, true);
        const summary =
          input.action === 'push'
            ? `Push ${row.branch} to ${row.repo}`
            : `Open a pull request on ${row.repo} from ${row.branch} into ${row.base}: ${input.title!.trim()}${input.draft ? ' (draft)' : ''}`;
        const answer = await engine.requestApproval(
          ctx.sessionId,
          {
            toolUseId: ctx.toolUseId,
            tool: PULL_REQUEST_TOOL,
            input: { action: input.action, repo: row.repo, branch: row.branch, base: row.base, ...(input.action === 'open' ? { title: input.title!.trim(), body: input.body ?? '', draft: !!input.draft } : {}) },
            summary,
            noAlways: true,
          },
          ctx.signal,
        );
        if (answer.decision !== 'allow') return text(`The owner said no.${answer.message && answer.message !== 'aborted' ? ` Their note: ${answer.message}` : ''} Do not retry the same thing; ask what they want.`, true);
        if (input.action === 'push') {
          const r = await svc.push(ctx.sessionId);
          return text(r.line);
        }
        const d = await svc.openPr(ctx.sessionId, { title: input.title!.trim(), body: input.body ?? '', draft: !!input.draft });
        return text(`Opened pull request #${d.pr?.number}: ${d.pr?.url}\n${d.line}`);
      } catch (err) {
        return text((err as Error).message, true);
      }
    },
  };
}
