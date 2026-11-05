/**
 * Reflect's report (GET /api/reflect/report): one account's week, month or
 * last 3, 6 or 12 months. Numbers come from SQL over that account's rows;
 * topics, the 4D notes, suggestions and the question come from one pass of
 * the account's own small model over session titles and summaries. Ranges
 * are rolling and end now, in the account's timezone.
 */
export type ReflectRange = 'week' | 'month' | '3m' | '6m' | '12m';
export const REFLECT_RANGES: ReflectRange[] = ['week', 'month', '3m', '6m', '12m'];

export interface ReflectNamed {
  name: string;
  count: number;
}

/** One of the four AI Fluency habits, with what the data shows and one example from the person's own chats. */
export interface ReflectHabit {
  key: 'delegation' | 'description' | 'discernment' | 'diligence';
  observation: string;
  example?: string;
}

export interface ReflectReport {
  range: ReflectRange;
  start: number;
  end: number;
  timezone: string;
  /** When this report was made; it is kept until Refresh or until it is a week old. */
  generatedAt: number;
  /** model: topics, 4D notes, suggestions and question came from the model pass; basic: from the numbers only. */
  insights: 'model' | 'basic';
  /** Why the model pass did not run or was not used, in words. */
  insightsNote?: string;
  /** 1. One plain sentence about the period. */
  headline: string;
  totals: { chats: number; sessions: number; workflows: number; hoursActive: number; tokens: number; costUsd: number; projects: number };
  /** 2. What you worked on. */
  work: {
    topics: Array<{ name: string; example: string }>;
    projects: Array<{ name: string; sessions: number; example: string }>;
    /** Projects whose first session ever is in this range. */
    newThisPeriod: string[];
  };
  /** 3. When you work. heatmap[weekday][hour], Monday first, counts of your messages in local time. */
  rhythm: { heatmap: number[][]; messages: number; activeDays: number; longestStreak: number; busiestDay?: { date: string; count: number }; lateNightShare: number };
  /** 4. Delegation, Description, Discernment, Diligence, in that order; a habit without data is left out. */
  habits: ReflectHabit[];
  /** 5. Models and agents. costPerResult: cost over finished turns, when there was cost. */
  models: {
    models: Array<{ name: string; calls: number; tokens: number; costUsd: number }>;
    agents: ReflectNamed[];
    fallbacks: number;
    topFallback?: string;
    switches: number;
    finishedTurns: number;
    costPerResult?: number;
  };
  /** 6. Fun stats. */
  fun: {
    topTool?: ReflectNamed;
    longestChat?: { title: string; messages: number; sessionId: string };
    biggestWorkflow?: { name: string; agents: number; costUsd: number };
    newPeople: string[];
    memoriesAdded: number;
    skillsLearned: string[];
    goalsMoved: number;
    goalsDone: number;
  };
  /** 7. Up to four practical suggestions grounded in the numbers; none when nothing stands out. */
  suggestions: Array<{ text: string; why: string }>;
  /** 8. A question to talk through in a new chat. Empty when the range is too thin to ask one (under 3 sessions or 5 messages). */
  question: string;
  /** What was left out: health-related sessions (by topic) and incognito ones. */
  excluded: { health: number; incognito: number };
}
