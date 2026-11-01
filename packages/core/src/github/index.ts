/** Repo sessions on GitHub (docs/DESIGN.md 30). */
import type { Engine } from '../engine/engine';
import { GithubService } from './service';
import { githubOf, setGithub } from './attached';

/** Make the service for an engine and start it: the PullRequest tool for repo sessions and the pull request poll. */
export function attachGithub(engine: Engine, opts: { fetch?: typeof fetch; timer?: boolean } = {}): GithubService {
  const prev = githubOf(engine);
  if (prev) return prev;
  const svc = new GithubService(engine, opts);
  svc.start();
  setGithub(engine, svc);
  return svc;
}

export { githubOf, GithubService };
