/**
 * Which workflow service belongs to which engine. Kept apart from service.ts
 * so the engine, the tool host and the Workflow tool can look it up without
 * importing the service (and QuickJS) at load time.
 */
import type { WorkflowService } from './service';

const attached = new WeakMap<object, WorkflowService>();

export function setWorkflows(engine: object, svc: WorkflowService): void {
  attached.set(engine, svc);
}

/** The workflow service of an engine, when the hub has one. */
export function workflowsOf(engine: object): WorkflowService | undefined {
  return attached.get(engine);
}
