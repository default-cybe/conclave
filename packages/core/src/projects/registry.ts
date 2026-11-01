/**
 * The projects service attached to each engine (create.ts), so routes, the
 * /device command and Engine.moveSession reach it without widening the
 * engine's interfaces.
 */
import type { Engine } from '../engine/engine';
import { ProjectsService } from './service';
import { projectsOf, setProjects } from './attached';

/** Make the service for an engine and start it: its runner extension and its turn-end listener. */
export function attachProjects(engine: Engine): ProjectsService {
  const prev = projectsOf(engine);
  if (prev) return prev;
  const svc = new ProjectsService(engine);
  svc.start();
  setProjects(engine, svc);
  return svc;
}

export { projectsOf, ProjectsService };
