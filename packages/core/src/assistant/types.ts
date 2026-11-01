/**
 * The life assistant (docs/design/ROUND-LIFE-ASSISTANT.md): goals, proactive
 * preferences, day plans and the heartbeat and reflection routines. Plain
 * types, no imports from node, so the web app and its mock use them too.
 */
import type { MemoryEntry, RoutineRun, Task } from '../types';

/** Life areas, after Muse's goal categories, fitted to this owner. */
export type GoalArea = 'study' | 'career' | 'health' | 'money' | 'homelab' | 'relationships' | 'interests' | 'other';

export const GOAL_AREAS: GoalArea[] = ['study', 'career', 'health', 'money', 'homelab', 'relationships', 'interests', 'other'];

/** How each area reads in the app and in prompts. */
export const GOAL_AREA_LABEL: Record<GoalArea, string> = {
  study: 'Study',
  career: 'Career',
  health: 'Health',
  money: 'Money',
  homelab: 'Homelab and projects',
  relationships: 'Relationships',
  interests: 'Interests',
  other: 'Something else',
};

/** Active or done. There is no pause: a break is a progress entry, or done and reopened later. */
export type GoalStatus = 'active' | 'done';

export interface Goal {
  id: string;
  /** In the owner's own words. */
  title: string;
  area: GoalArea;
  /** Two or three sentences: what done looks like and why it matters. */
  description: string;
  /** One line: where it stands, or the next step. */
  nextStep?: string;
  /** Local date, YYYY-MM-DD. */
  targetDate?: string;
  status: GoalStatus;
  /** Set on a subgoal. Goals nest one level only. */
  parentId?: string;
  /** Task board ids linked to this goal. */
  taskIds: string[];
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** Who wrote a progress entry. */
export type GoalEntrySource = 'owner' | 'assistant' | 'routine';

/** A dated note about what happened. Entries build the goal's history. */
export interface GoalEntry {
  id: string;
  goalId: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  text: string;
  source: GoalEntrySource;
  sessionId?: string;
  createdAt: number;
}

/** A top-level goal as the list shows it. */
export interface GoalSummary extends Goal {
  subgoals: Goal[];
  lastEntry?: GoalEntry;
  /** Entries on the goal and its subgoals. */
  entryCount: number;
  /** Linked tasks that are not done, on the goal and its subgoals. */
  openTasks: number;
}

export interface GoalDetail {
  goal: Goal;
  parent?: Goal;
  subgoals: Goal[];
  /** Newest first, subgoal entries included (their goalId says which). */
  entries: GoalEntry[];
  /** Linked tasks on the goal and its subgoals that still exist. */
  tasks: Task[];
}

export interface GoalInput {
  title: string;
  area?: GoalArea;
  description?: string;
  nextStep?: string;
  targetDate?: string;
  parentId?: string;
  taskIds?: string[];
  sourceSessionId?: string;
}

/** null clears a field. */
export interface GoalPatch {
  title?: string;
  area?: GoalArea;
  description?: string;
  nextStep?: string | null;
  targetDate?: string | null;
  status?: GoalStatus;
  taskIds?: string[];
}

// ---------------------------------------------------------------------------
// Proactive preferences
// ---------------------------------------------------------------------------

/** How a proactive message reads: one brief line, a short list, or a full page when it needs one. */
export type ProactiveHow = 'line' | 'list' | 'page';

export const PROACTIVE_HOW_LABEL: Record<ProactiveHow, string> = { line: 'One line', list: 'Short list', page: 'Full page' };

export interface ProactivePrefs {
  /** Topics and situations worth a message without being asked. */
  tell: string[];
  /** Topics never to bring up. */
  never: string[];
  /** When messages may arrive, local time "HH:MM". Outside this window are quiet hours. */
  hours: { start: string; end: string };
  how: ProactiveHow;
  /** IANA zone the owner set. Without it the zone comes from profile memory, then the hub. */
  timezone?: string;
}

/** A change to the preferences. hours may also be "09:00-21:30"; timezone "" clears it. */
export type PrefsPatch = Partial<Omit<ProactivePrefs, 'hours'>> & { hours?: ProactivePrefs['hours'] | string };

export const DEFAULT_PREFS: ProactivePrefs = { tell: [], never: [], hours: { start: '09:00', end: '21:30' }, how: 'list' };

/** Where the timezone came from. */
export type TimezoneSource = 'set' | 'profile' | 'hub';

// ---------------------------------------------------------------------------
// Day plans
// ---------------------------------------------------------------------------

export type DayPlanItemKind = 'event' | 'task' | 'goal' | 'focus' | 'reminder';

export interface DayPlanItem {
  /** Local "HH:MM", when the item has a time. */
  time?: string;
  text: string;
  kind?: DayPlanItemKind;
  /** A task or goal id. */
  ref?: string;
}

export interface DayPlan {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** One sentence on what matters most today. */
  summary: string;
  items: DayPlanItem[];
  /** The one suggested focus block. */
  focus?: { text: string; start: string; end: string; goalId?: string };
  /** At most one question, with two or three tappable options. */
  question?: { text: string; options: string[]; answer?: string };
  /** The session that saved it (the morning run), where an answer goes. */
  sessionId?: string;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Settings > Assistant and Home > Today
// ---------------------------------------------------------------------------

/** The heartbeat or the nightly reflection, as Settings shows it. */
export interface AssistantRoutineDto {
  template: 'heartbeat' | 'nightly-reflection';
  routineId?: string;
  enabled: boolean;
  schedule?: string;
  timezone?: string;
  /** The model it runs on, as set on the routine ("fast" is the hub's small model). */
  model?: string;
  nextRunAt?: number;
  lastRun?: RoutineRun;
  /** Runs since local midnight: how many went to the model and how many the precheck skipped. */
  today: { ran: number; skipped: number };
  /** Heartbeat only: the checklist note. */
  checklist?: string;
  checklistId?: string;
}

export interface AssistantSettingsDto {
  prefs: ProactivePrefs;
  timezone: { zone: string; source: TimezoneSource };
  /** Quiet hours right now, and when they end. */
  quiet: { now: boolean; until?: number };
  /** Routine notices waiting for quiet hours to end. */
  waiting: number;
  heartbeat: AssistantRoutineDto;
  reflection: AssistantRoutineDto;
}

/** The last reflection, as Settings > Reflect says it: "Last ran 02:40, saved 2 notes, retired 1". */
export interface ReflectRunDto {
  id: string;
  status: RoutineRun['status'];
  /** schedule: the night's run; manual: Reflect now. */
  trigger: RoutineRun['trigger'];
  startedAt: number;
  finishedAt?: number;
  sessionId?: string;
  /** Notes it saved and notes it retired (MemorySave and MemoryForget calls that went through). */
  saved: number;
  retired: number;
  /** Why it was skipped, or what failed. */
  reason?: string;
}

/** Settings > Reflect (GET /api/assistant/reflect): the nightly reflection on one page. */
export interface ReflectDto {
  /** The same switch as Settings > Assistant, Nightly reflection. */
  enabled: boolean;
  /** "02:40" in the routine's timezone; absent when its schedule is no single daily time (edited on Routines). */
  time?: string;
  schedule: string;
  timezone: string;
  /** The routine's model: "fast" is the small model; absent is the default model. */
  model?: string;
  routineId?: string;
  nextRunAt?: number;
  last?: ReflectRunDto;
  /** The notes it keeps on how to work with you: the assistant's procedure memories tagged reflection, newest first. */
  notes: MemoryEntry[];
}

/** PUT /api/assistant/reflect. */
export interface ReflectPatch {
  enabled?: boolean;
  /** "HH:MM", once a day. */
  time?: string;
  /** A model ref, "fast" for the small model, or "" for the default model. */
  model?: string;
}

/** POST /api/assistant/reflect/run: the run it started, or why it did not call a model. */
export interface ReflectNowDto {
  run?: ReflectRunDto;
  /** Set when there was nothing to read: "No chats since the last reflection". */
  skipped?: string;
  reflect: ReflectDto;
}

export interface TodayGoal {
  id: string;
  title: string;
  area: GoalArea;
  nextStep?: string;
  targetDate?: string;
  /** Days until the target date, negative when it passed. */
  daysLeft?: number;
}

export interface TodayDto {
  date: string;
  timezone: string;
  plan?: DayPlan;
  /** The latest run of the day plan routine (morning-brief) today. */
  run?: Pick<RoutineRun, 'id' | 'routineId' | 'status' | 'startedAt' | 'finishedAt' | 'sessionId' | 'summary' | 'error'>;
  /** The day plan routine, when it is installed. */
  planRoutine?: { id: string; enabled: boolean; nextRunAt?: number };
  /** Up to three active goals with a next step, nearest target date first. */
  goals: TodayGoal[];
  tasks: { dueToday: number; overdue: number };
  /** Today's events from the calendars the assistant may read (docs/DESIGN.md, Calendar and mail). Absent with no calendar. */
  events?: import('../pim/types').TodayEvent[];
  /** A calendar that could not be read, in one sentence. */
  calendarError?: string;
  /** Calendar changes and messages waiting for the owner's approval. */
  proposals?: import('../pim/types').ProposalDto[];
}

/** Name of the template a routine came from, kept on the routine. */
export const ASSISTANT_TEMPLATES = { plan: 'morning-brief', review: 'evening-wrap-up', weekly: 'weekly-review', heartbeat: 'heartbeat', reflection: 'nightly-reflection' } as const;
