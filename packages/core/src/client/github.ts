/**
 * Repo sessions: the HTTP contract (docs/DESIGN.md 30). The hub holds a
 * GitHub token as a secret, keeps one clone per repository per device, and
 * gives each repo session a git worktree on its own branch. It pushes the
 * branch, opens the pull request and reads its state for the apps. Only the
 * hub's own git and API calls use the token.
 */
import type { ChatSettings, PermissionMode } from '../types';

/** Who the token is and whether the hub can use it. */
export interface GithubStatusDto {
  /** A token is set and GitHub accepted it. */
  connected: boolean;
  /** Where the token comes from: the hub secret "github", or CONCLAVE_GITHUB_TOKEN. */
  source?: 'secret' | 'env';
  login?: string;
  name?: string;
  avatarUrl?: string;
  /** How many repositories the token can see, when they were listed. */
  repos?: number;
  /** Why a set token does not work ("GitHub did not accept the token"). */
  error?: string;
  /** The API address when it is not api.github.com (GitHub Enterprise, tests). */
  apiUrl?: string;
}

/** One repository the token can see. */
export interface GithubRepoDto {
  /** owner/name as GitHub spells it. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description?: string;
  /** Last push, epoch ms. */
  pushedAt?: number;
  /** The repository's page on GitHub. */
  url: string;
  /** The token may push to it. */
  canPush: boolean;
}

export interface GithubBranchesDto {
  defaultBranch: string;
  /** Branch names, the default branch first. */
  branches: string[];
}

/** POST /api/github/sessions: a session in a fresh worktree of a repository. */
export interface RepoSessionInput {
  /** owner/name. */
  repo: string;
  /** The branch to start from. Default: the repository's default branch. */
  base?: string;
  /** The device that keeps the clone and the worktree. Default: the hub. */
  device?: string;
  agent?: string;
  model?: string;
  title?: string;
  /** Sent as the first message once the worktree is ready. */
  prompt?: string;
  permissionMode?: PermissionMode;
  chat?: Partial<ChatSettings>;
}

export type PrState = 'open' | 'merged' | 'closed';
/** The pull request's checks: check runs and commit statuses together. none: there are none. */
export type CiState = 'pending' | 'success' | 'failure' | 'none';

/**
 * What a session carries about its repository (session.meta.repo), so lists
 * show the repository and branch without another request.
 */
export interface SessionRepoMeta {
  /** owner/name. */
  repo: string;
  branch: string;
  base: string;
  pr?: { number: number; url: string; state: PrState; draft?: boolean };
  ci?: CiState;
  /** The worktree was removed (Clean up). */
  cleaned?: boolean;
}

/** GET /api/sessions/:id/repo: the repo session in full. */
export interface RepoSessionDto extends SessionRepoMeta {
  sessionId: string;
  device: string;
  deviceName: string;
  /** The clone the worktree belongs to, on the device. */
  clonePath: string;
  /** The session's folder. */
  worktree: string;
  /** The commit the branch started from. */
  baseSha: string;
  defaultBranch: string;
  /** The repository's page on GitHub. */
  url: string;
  /** The branch's page on GitHub, once it is pushed. */
  branchUrl?: string;
  /** The branch's commit now, when the device is online and the worktree is there. */
  head?: string;
  /** Commits on the branch beyond the base. */
  commits?: number;
  /** Uncommitted files in the worktree. */
  dirty?: number;
  /** What the hub last pushed. */
  pushedSha?: string;
  pushedAt?: number;
  /** never: not pushed. current: GitHub has the branch as it is. behind: newer commits wait to be pushed. */
  pushed: 'never' | 'current' | 'behind';
  prTitle?: string;
  /** A link to the failing or running check, when there is one. */
  ciUrl?: string;
  /** When the hub last read the pull request. */
  checkedAt?: number;
  /** Clean up is offered: the pull request was merged or closed and the worktree is still there. */
  canCleanUp: boolean;
  /** The device is online, so git can run there. */
  online: boolean;
  /** One plain sentence about where things stand. */
  line: string;
}

/** POST /api/sessions/:id/repo/push. */
export interface PushInput {
  /** Commit what is not committed yet with this message first. Without it, uncommitted files stay and the push says so. */
  commitMessage?: string;
}

export interface PushResult {
  /** The branch on GitHub moved (false when it was already there). */
  pushed: boolean;
  branch: string;
  sha: string;
  /** Commits on the branch beyond the base. */
  commits: number;
  /** Files committed first, with commitMessage. */
  committed?: number;
  /** Uncommitted files left behind. */
  dirty?: number;
  line: string;
}

/** GET /api/sessions/:id/repo/pr-draft: a title and body drafted from the session, for the owner to edit. */
export interface PrDraft {
  title: string;
  body: string;
  base: string;
  head: string;
  commits: Array<{ sha: string; subject: string }>;
}

/** POST /api/sessions/:id/repo/pr. */
export interface OpenPrInput {
  title: string;
  body?: string;
  draft?: boolean;
}

/** POST /api/sessions/:id/repo/cleanup. */
export interface CleanupInput {
  /** Remove the worktree even with uncommitted files in it, or before the pull request is merged or closed. */
  force?: boolean;
}

/** The repository and branch of a session, when it is a repo session. */
export function sessionRepo(session: { meta?: Record<string, unknown> } | undefined): SessionRepoMeta | undefined {
  const r = session?.meta?.repo as SessionRepoMeta | undefined;
  return r && typeof r.repo === 'string' && typeof r.branch === 'string' ? r : undefined;
}
