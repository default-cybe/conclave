/**
 * Import tasks and memories from Pimzino/agentic-tools-mcp files instead of
 * running that server (docs/design/ECOSYSTEM.md 1.10). Reads, on the device:
 *   <path>/.agentic-tools-mcp/tasks/tasks.json   { projects, tasks, subtasks, migration }
 *   <path>/.agentic-tools-mcp/memories/<category>/<title>.json
 * Tasks keep their parent and dependency links in meta, so a second import
 * skips what the first one brought in.
 */
import type { Machine } from '../machine/types';
import type { Task } from '../types';
import type { MemoryInput } from '../memory/types';
import type { TaskDraft, TaskImportRequest, TaskImportResult } from './types';
import { CatalogError } from './install';

interface AtProject {
  id: string;
  name: string;
  description?: string;
}

interface AtTask {
  id: string;
  name?: string;
  title?: string;
  details?: string;
  projectId?: string;
  parentId?: string;
  taskId?: string;
  completed?: boolean;
  status?: 'pending' | 'in-progress' | 'blocked' | 'done';
  priority?: number;
  complexity?: number;
  dependsOn?: string[];
  tags?: string[];
  estimatedHours?: number;
  actualHours?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface AtMemory {
  id?: string;
  title?: string;
  content?: string;
  details?: string;
  category?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  dateCreated?: string;
}

export interface TaskImportHost {
  machine(device: string): Machine | undefined;
  tasks(): Task[];
  createTask(input: Partial<Task> & { title: string }): Task;
  saveMemory(input: MemoryInput): Promise<unknown>;
  /** Ids of memories brought in before, so they are not added twice. */
  importedMemories(): Set<string>;
  rememberImported(ids: string[]): void;
}

/** agentic-tools priority 1 to 10 onto Conclave's 0 none, 1 low, 2 high, 3 urgent. */
export function mapPriority(p?: number): 0 | 1 | 2 | 3 {
  if (!p || p <= 0) return 0;
  if (p <= 5) return 1;
  if (p <= 8) return 2;
  return 3;
}

export function mapStatus(t: Pick<AtTask, 'status' | 'completed'>): { status: TaskDraft['status']; blocked: boolean } {
  if (t.status === 'done' || (t.completed && !t.status)) return { status: 'done', blocked: false };
  if (t.status === 'in-progress') return { status: 'doing', blocked: false };
  if (t.status === 'blocked') return { status: 'todo', blocked: true };
  return { status: 'todo', blocked: false };
}

/** Turn the agentic-tools tasks.json into task drafts. */
export function draftsFromTasksJson(data: { projects?: AtProject[]; tasks?: AtTask[]; subtasks?: AtTask[] }): TaskDraft[] {
  const projects = new Map((data.projects ?? []).map((p) => [p.id, p]));
  const all: AtTask[] = [...(data.tasks ?? []), ...(data.subtasks ?? []).map((s) => ({ ...s, parentId: s.parentId ?? s.taskId }))];
  return all
    .filter((t) => t?.id && (t.name || t.title))
    .map((t) => {
      const { status, blocked } = mapStatus(t);
      const labels = [...new Set([...(t.tags ?? []).map(String), ...(blocked ? ['blocked'] : [])])];
      const meta: Record<string, unknown> = { source: 'agentic-tools-mcp', sourceId: t.id };
      if (t.parentId) meta.parentId = t.parentId;
      if (t.dependsOn?.length) meta.dependsOn = t.dependsOn;
      if (t.complexity) meta.complexity = t.complexity;
      if (t.estimatedHours) meta.estimatedHours = t.estimatedHours;
      if (t.actualHours) meta.actualHours = t.actualHours;
      return {
        title: String(t.name ?? t.title).slice(0, 300),
        description: t.details ?? '',
        status,
        priority: mapPriority(t.priority),
        labels,
        project: t.projectId ? projects.get(t.projectId)?.name : undefined,
        meta,
      };
    });
}

export async function importAgenticTools(host: TaskImportHost, req: TaskImportRequest): Promise<TaskImportResult> {
  if (req.from !== 'agentic-tools-mcp') throw new CatalogError(400, 'from must be agentic-tools-mcp');
  if (!req.path?.trim()) throw new CatalogError(400, 'path is required');
  const device = req.device || 'local';
  const m = host.machine(device);
  if (!m) throw new CatalogError(404, `Device ${device} is not connected.`);
  const root = `${req.path.replace(/\/+$/, '')}/.agentic-tools-mcp`;
  const skipped: string[] = [];

  let data: { projects?: AtProject[]; tasks?: AtTask[]; subtasks?: AtTask[] } = {};
  const tasksFile = `${root}/tasks/tasks.json`;
  try {
    if (await m.stat(tasksFile)) data = JSON.parse(await m.readText(tasksFile));
    else skipped.push(`${tasksFile}: not found`);
  } catch (err) {
    skipped.push(`${tasksFile}: ${(err as Error).message}`);
  }
  const drafts = draftsFromTasksJson(data);

  const memories: Array<{ id: string; input: MemoryInput }> = [];
  const memDir = `${root}/memories`;
  try {
    if (await m.stat(memDir)) {
      for (const cat of await m.readdir(memDir)) {
        if (cat.type !== 'dir') continue;
        const catDir = `${memDir}/${cat.name}`;
        for (const f of await m.readdir(catDir)) {
          if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
          try {
            const mem = JSON.parse(await m.readText(`${catDir}/${f.name}`)) as AtMemory;
            const text = (mem.content ?? mem.details ?? '').trim();
            if (!text) {
              skipped.push(`memory ${f.name}: empty`);
              continue;
            }
            const category = mem.category ?? cat.name;
            memories.push({
              id: mem.id ?? `${cat.name}/${f.name}`,
              input: { content: mem.title && !text.startsWith(mem.title) ? `${mem.title}: ${text}` : text, kind: 'fact', tags: ['agentic-tools', category] },
            });
          } catch (err) {
            skipped.push(`memory ${f.name}: ${(err as Error).message}`);
          }
        }
      }
    }
  } catch (err) {
    skipped.push(`${memDir}: ${(err as Error).message}`);
  }

  const have = new Set(host.tasks().map((t) => (t.meta?.source === 'agentic-tools-mcp' ? String(t.meta.sourceId) : '')).filter(Boolean));
  const newDrafts = drafts.filter((d) => {
    if (have.has(String(d.meta.sourceId))) {
      skipped.push(`task ${d.title}: already imported`);
      return false;
    }
    return true;
  });
  const seenMem = host.importedMemories();
  const newMemories = memories.filter((x) => {
    if (seenMem.has(x.id)) {
      skipped.push(`memory ${x.id}: already imported`);
      return false;
    }
    return true;
  });
  const projects = new Set(newDrafts.map((d) => d.project).filter(Boolean)).size;

  if (req.dryRun) return { projects, tasks: newDrafts.length, memories: newMemories.length, skipped, preview: newDrafts.slice(0, 200) };

  for (const d of newDrafts) {
    host.createTask({ title: d.title, description: d.description, status: d.status, priority: d.priority as Task['priority'], labels: d.labels, project: d.project, meta: d.meta });
  }
  for (const mem of newMemories) await host.saveMemory(mem.input);
  host.rememberImported(newMemories.map((x) => x.id));
  return { projects, tasks: newDrafts.length, memories: newMemories.length, skipped };
}
