/**
 * What kind of background task a row shows (a workflow, a subagent, a job
 * delegated to a device) and the icon it leads with. One place, so a later
 * motion pack can swap the icons without touching the rows.
 */
import { Bot, Bug, Eye, FlaskConical, Globe, Hammer, Laptop, Palette, Search, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';

export type TaskKind = 'workflow' | 'subagent' | 'delegate';

export const TASK_KIND_LABEL: Record<TaskKind, string> = { workflow: 'Workflow', subagent: 'Subagent', delegate: 'Delegate' };
export const TASK_KIND_GROUP: Record<TaskKind, string> = { workflow: 'Workflows', subagent: 'Subagents', delegate: 'Delegated' };

const AGENT_ICONS: Record<string, LucideIcon> = {
  explore: Search,
  builder: Hammer,
  tester: FlaskConical,
  reviewer: Eye,
  debugger: Bug,
  researcher: Globe,
  designer: Palette,
  verifier: ShieldCheck,
};

/** The icon a task row leads with: a flow for a workflow, a device for a delegated job, the agent's own for a subagent (a bot when it has none). */
export function taskIcon(kind: TaskKind, agent?: string): LucideIcon {
  if (kind === 'workflow') return Workflow;
  if (kind === 'delegate') return Laptop;
  return (agent && AGENT_ICONS[agent.toLowerCase()]) || Bot;
}

const ORDER: readonly TaskKind[] = ['workflow', 'subagent', 'delegate'];

/** The items by kind, workflows first; each group keeps its order, empty groups are left out. */
export function groupByKind<T>(items: readonly T[], kindOf: (t: T) => TaskKind): Array<{ kind: TaskKind; items: T[] }> {
  return ORDER.map((kind) => ({ kind, items: items.filter((t) => kindOf(t) === kind) })).filter((g) => g.items.length > 0);
}
