/**
 * Repo sessions in the apps (docs/DESIGN.md 30): the words for a session's
 * repository, branch, pull request and checks. Pure, so the tests read them.
 */
import { sessionRepo } from '@conclave/core/client';
import type { CiState, PrState, RepoSessionDto, SessionRepoMeta } from '@conclave/core/client';

export { sessionRepo };

/** The branch without the conclave/ every repo session branch starts with. */
export function branchShort(branch: string): string {
  return branch.startsWith('conclave/') ? branch.slice('conclave/'.length) : branch;
}

/** "acme/widgets on fix-login-ab12": what the session lists show for a repo session. */
export function repoWhere(r: Pick<SessionRepoMeta, 'repo' | 'branch'>): string {
  return `${r.repo} on ${branchShort(r.branch)}`;
}

const PR_WORD: Record<PrState, string> = { open: 'open', merged: 'merged', closed: 'closed' };

/** "Pull request #12, open", "#12 merged" (short). */
export function prWords(pr: NonNullable<SessionRepoMeta['pr']>, short = false): string {
  const state = pr.state === 'open' && pr.draft ? 'draft' : PR_WORD[pr.state];
  return short ? `#${pr.number} ${state}` : `Pull request #${pr.number}, ${state}`;
}

const CI_WORD: Record<CiState, string> = { pending: 'Checks running', success: 'Checks passed', failure: 'A check failed', none: 'No checks' };

export function ciWords(ci: CiState | undefined): string | undefined {
  return ci && ci !== 'none' ? CI_WORD[ci] : undefined;
}

/** The color a state word takes: violet while checks run, red for a failed check, green when merged or passed. */
export function ciTone(ci: CiState | undefined): 'signal' | 'fault' | 'ok' | 'dim' {
  return ci === 'pending' ? 'signal' : ci === 'failure' ? 'fault' : ci === 'success' ? 'ok' : 'dim';
}

export function prTone(state: PrState | undefined): 'ok' | 'dim' | 'fg' {
  return state === 'merged' ? 'ok' : state === 'closed' ? 'dim' : 'fg';
}

export interface RepoActions {
  push: boolean;
  openPr: boolean;
  viewPr: boolean;
  cleanUp: boolean;
}

/**
 * Which actions a repo session offers now. Push while there are commits
 * GitHub does not have; Open pull request once there are commits and no pull
 * request is open or merged; Clean up after a merge or close.
 */
export function repoActions(r: Pick<RepoSessionDto, 'cleaned' | 'online' | 'commits' | 'pushed' | 'pr' | 'canCleanUp' | 'dirty'>): RepoActions {
  if (r.cleaned) return { push: false, openPr: false, viewPr: !!r.pr, cleanUp: false };
  const commits = r.commits ?? 0;
  const live = r.pr && r.pr.state === 'open';
  const done = r.pr && r.pr.state !== 'open';
  return {
    push: r.online && !done && (r.pushed === 'behind' || (r.pushed === 'never' && (commits > 0 || (r.dirty ?? 0) > 0)) || (!!live && (r.dirty ?? 0) > 0)),
    openPr: r.online && !live && !done && (commits > 0 || (r.dirty ?? 0) > 0),
    viewPr: !!r.pr,
    cleanUp: r.canCleanUp,
  };
}
