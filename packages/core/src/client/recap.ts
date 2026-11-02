/** Account-private, deterministic Reflect recap. Calendar periods use the account's timezone. */
export type RecapPeriod = 'week' | 'month' | 'year';
export interface RecapRank {
  name: string;
  count: number;
}
export interface RecapMemory {
  id: string;
  content: string;
  firstSeen: number;
}
export interface RecapDto {
  period: RecapPeriod;
  start: number;
  end: number;
  timezone: string;
  totals: { chats: number; sessions: number; workflows: number; tokens: number; costUsd: number; models: number };
  models: Array<RecapRank & { tokens: number; costUsd: number }>;
  projects: RecapRank[];
  topics: RecapRank[];
  people: RecapMemory[];
  preferences: RecapMemory[];
  rhythm: { activeDays: number; longestStreak: number; busiestDay?: RecapRank; timeOfDay?: RecapRank };
  facts: string[];
}
