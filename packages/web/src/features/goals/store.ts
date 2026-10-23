/**
 * Goals on the client: the list, details loaded on demand, and actions that
 * refetch what they changed. The hub keeps one memory per goal, so a
 * memory.updated event for a goal (tag source:@goals) also refreshes the list
 * when the assistant or a routine changed something.
 */
import { create } from 'zustand';
import type { Goal, GoalDetail, GoalInput, GoalPatch, GoalSummary } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { errText } from '@/features/settings/parts';

interface GoalsState {
  list?: GoalSummary[];
  loading: boolean;
  error?: string;
  details: Record<string, GoalDetail>;
  /** Goals that failed to load, by id: gone (deleted, or a wrong link) or the error text. */
  missing: Record<string, { gone: boolean; text: string }>;
}

export const useGoals = create<GoalsState>(() => ({ loading: false, details: {}, missing: {} }));

const set = useGoals.setState;
const get = useGoals.getState;

export async function loadGoals(): Promise<void> {
  set({ loading: !get().list });
  try {
    set({ list: await api().goals({ status: 'all' }), loading: false, error: undefined });
  } catch (e) {
    set({ loading: false, error: errText(e) });
  }
}

export async function loadGoal(id: string): Promise<GoalDetail | undefined> {
  try {
    const d = await api().goal(id);
    const { [id]: _was, ...missing } = get().missing;
    set({ details: { ...get().details, [id]: d }, missing });
    return d;
  } catch (e) {
    // a goal deleted here or on another device, or a wrong link: say so instead of loading forever
    const gone = (e as { status?: number }).status === 404;
    const { [id]: _stale, ...details } = get().details;
    set({ details: gone ? details : get().details, missing: { ...get().missing, [id]: { gone, text: errText(e) } } });
    return undefined;
  }
}

/** The top goal of a goal, for refetching its detail after a subgoal changed. */
function topOf(id: string): string {
  const list = get().list ?? [];
  return list.find((g) => g.id === id || g.subgoals.some((s) => s.id === id))?.id ?? id;
}

async function refresh(id?: string): Promise<void> {
  const top = id ? topOf(id) : undefined;
  await Promise.all([loadGoals(), top ? loadGoal(top) : undefined, id && id !== top ? loadGoal(id) : undefined]);
}

async function run<T>(fn: () => Promise<T>, fail: string, id?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    await refresh(id);
    return out;
  } catch (e) {
    toast({ title: `${fail} ${errText(e)}`, level: 'error' });
    return undefined;
  }
}

export const goalActions = {
  create: (input: GoalInput) => run(async () => api().createGoal(input), 'Could not save the goal.', input.parentId),
  update: (id: string, patch: GoalPatch) => run(() => api().updateGoal(id, patch), 'Could not save the change.', id),
  remove: async (id: string): Promise<boolean> => {
    const ok = await run(() => api().deleteGoal(id), 'Could not delete the goal.');
    if (ok) {
      const details = { ...get().details };
      delete details[id];
      set({ details });
    }
    return !!ok;
  },
  addEntry: (id: string, text: string, date?: string) => run(() => api().addGoalEntry(id, { text, ...(date ? { date } : {}) }), 'Could not add the progress.', id),
  removeEntry: (id: string, entryId: string) => run(() => api().deleteGoalEntry(id, entryId), 'Could not remove the entry.', id),
  /** Make a task on the board and link it to the goal. */
  addTask: (goal: Goal, title: string) =>
    run(async () => {
      const task = await api().createTask({ title, status: 'todo', labels: ['goal', goal.area], description: `For the goal: ${goal.title}` });
      await api().updateGoal(goal.id, { taskIds: [...goal.taskIds, task.id] });
      return task;
    }, 'Could not add the task.', goal.id),
};

// a goal changed on the hub (the assistant, a routine, another device): refetch, at most every 400ms
let timer: ReturnType<typeof setTimeout> | undefined;
let last: string | undefined;
useHub.subscribe((s, prev) => {
  // every streamed chunk updates the hub store; past the first look only a memory change can touch a goal
  if ((s.memories === prev.memories && last !== undefined) || !get().list) return;
  const sig = Object.values(s.memories)
    .filter((m) => m.tags.includes('source:@goals'))
    .map((m) => `${m.id}:${m.updatedAt}`)
    .sort()
    .join('|');
  if (sig === last) return;
  const first = last === undefined;
  last = sig;
  if (first) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    void loadGoals();
    for (const id of Object.keys(get().details)) void loadGoal(id);
  }, 400);
});
