/** The life assistant (docs/design/ROUND-LIFE-ASSISTANT.md). */
export * from './types';
export { GoalService, GoalError, goalMemoryText, goalNote, renameNote, GOALS_SOURCE, GOAL_TAG, validDate, type GoalTasks, type GoalMemoryPort } from './goals';
export { PrefsService, PrefsError, mergePrefs, renderPrefs, parsePrefsText, parseHours, DEFAULT_CHECKLIST, PREFS_TAG, CHECKLIST_TAG, ASSISTANT_AGENT } from './prefs';
export { AssistantService, AssistantError, REFLECTION_TAG, type AssistantHost } from './service';
export { QuietHoursNotifier, QUIET_JOB, type QuietHoursOptions } from './quiet';
export { buildDay, renderDay, runWords, type DayReport } from './day';
export { localDate, localMinutes, localHhmm, insideHours, nextOpening, cronHours, zoneIn, validZone, hubZone, addDays, daysBetween, dayRange } from './time';
export { goalGuide, flowGuide, FLOW_GUIDES, type FlowGuide } from './guides';

export { attachAssistant, assistantOf, assistantFor, forgetAssistant } from './registry';
