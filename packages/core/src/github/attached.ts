/**
 * Which GitHub service belongs to which engine (docs/DESIGN.md 30). Kept
 * apart from service.ts so routes can look it up without importing it at
 * load time.
 */
import type { GithubService } from './service';

const attached = new WeakMap<object, GithubService>();

export function setGithub(engine: object, svc: GithubService): void {
  attached.set(engine, svc);
}

/** The GitHub service of an engine, when the hub has one. */
export function githubOf(engine: object): GithubService | undefined {
  return attached.get(engine);
}
