/**
 * Which projects service belongs to which engine. Kept apart from
 * registry.ts so the engine, compaction and the runner can look it up
 * without importing the service (and its imports) at load time.
 */
import type { ProjectsService } from './service';

const attached = new WeakMap<object, ProjectsService>();

export function setProjects(engine: object, svc: ProjectsService): void {
  attached.set(engine, svc);
}

/** The projects service of an engine, when the hub has one. */
export function projectsOf(engine: object): ProjectsService | undefined {
  return attached.get(engine);
}
