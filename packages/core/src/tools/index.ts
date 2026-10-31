import type { Tool } from './types';
import { ReadTool } from './read';
import { WriteTool } from './write';
import { EditTool } from './edit';
import { MultiEditTool } from './multiedit';
import { BashTool } from './bash';
import { BashOutputTool } from './bash-output';
import { KillShellTool } from './kill-shell';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LSTool } from './ls';
import { WebFetchTool } from './webfetch';
import { WebSearchTool } from './websearch';
import { TodoWriteTool } from './todowrite';
import { TaskTool, MAX_TASK_DEPTH } from './task';
import { AskUserQuestionTool } from './ask-user';
import { EnterPlanModeTool } from './enter-plan-mode';
import { ExitPlanModeTool } from './exit-plan-mode';
import { SkillTool } from './skill';
import { ReadToolOutputTool } from './read-tool-output';
import { MemorySearchTool } from './memory-search';
import { MemorySaveTool } from './memory-save';
import { MemoryForgetTool } from './memory-forget';
import { ConsultTool } from './consult';
import { NotifyTool } from './notify';
import { ScheduleRoutineTool } from './schedule-routine';
import { NotebookEditTool } from './notebook-edit';
import { RepoMapTool } from './repo-map';
import { GoalListTool, GoalGetTool, GoalCreateTool, GoalUpdateTool, GoalLogTool } from './goals';
import { DayPlanTool } from './day-plan';
import { ProactivePrefsTool } from './proactive-prefs';
import { WorkflowTool } from './workflow';
import { WorkflowStatusTool } from './workflow-status';
import { SessionSearchTool, SessionReadTool } from './session-search';
import { SkillManageTool } from './skill-manage';
import { PlaceSearchTool, PlaceDetailsTool, DirectionsTool, MapImageTool } from './maps';
import { CalendarListTool, CalendarFreeBusyTool, CalendarEventTool } from './calendar';
import { MailSearchTool, MailReadTool, MailDraftTool } from './mail';
import { WatchReportTool, WatchCreateTool } from './watch';
import { DelegateTool } from './delegate';
import { ConclaveHelpTool } from './conclave-help';
import { ShareFileTool } from './share-file';
import { RenderFileTool } from './render-file';
import { CaptureTool } from './capture';
import { ReadPostTool } from './read-post';
import { SaveInspirationTool } from './save-inspiration';

export * from './types';
export { shellRegistry, ShellRegistry, type ShellInfo } from './shells';
export { isReadOnlyCommand, suggestBashRule, parseCommand } from './bash-rules';
export { applyEdit } from './edit-core';
export { clearWebFetchCache, htmlToMarkdown } from './webfetch';
export { webSearch, pickProvider, type SearchResult } from './websearch';
export {
  ReadTool,
  WriteTool,
  EditTool,
  MultiEditTool,
  BashTool,
  BashOutputTool,
  KillShellTool,
  GlobTool,
  GrepTool,
  LSTool,
  WebFetchTool,
  WebSearchTool,
  TodoWriteTool,
  TaskTool,
  AskUserQuestionTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  SkillTool,
  ReadToolOutputTool,
  MemorySearchTool,
  MemorySaveTool,
  MemoryForgetTool,
  ConsultTool,
  NotifyTool,
  ScheduleRoutineTool,
  NotebookEditTool,
  RepoMapTool,
  GoalListTool,
  GoalGetTool,
  GoalCreateTool,
  GoalUpdateTool,
  GoalLogTool,
  DayPlanTool,
  ProactivePrefsTool,
  WorkflowTool,
  WorkflowStatusTool,
  SessionSearchTool,
  SessionReadTool,
  SkillManageTool,
  PlaceSearchTool,
  PlaceDetailsTool,
  DirectionsTool,
  MapImageTool,
  CalendarListTool,
  CalendarFreeBusyTool,
  CalendarEventTool,
  MailSearchTool,
  MailReadTool,
  MailDraftTool,
  WatchReportTool,
  WatchCreateTool,
  DelegateTool,
  ConclaveHelpTool,
  ShareFileTool,
  RenderFileTool,
  CaptureTool,
  ReadPostTool,
  SaveInspirationTool,
};

/** Order matters for prompt caching: keep it stable. */
const BUILTINS: Tool[] = [
  TaskTool,
  BashTool,
  BashOutputTool,
  KillShellTool,
  GlobTool,
  GrepTool,
  LSTool,
  ReadTool,
  EditTool,
  MultiEditTool,
  WriteTool,
  NotebookEditTool,
  WebFetchTool,
  WebSearchTool,
  TodoWriteTool,
  AskUserQuestionTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  SkillTool,
  ReadToolOutputTool,
  RepoMapTool,
  MemorySearchTool,
  MemorySaveTool,
  MemoryForgetTool,
  ConsultTool,
  NotifyTool,
  ScheduleRoutineTool,
  // the life assistant (docs/design/ROUND-LIFE-ASSISTANT.md), appended so the order above stays cache-stable
  GoalListTool,
  GoalGetTool,
  GoalCreateTool,
  GoalUpdateTool,
  GoalLogTool,
  DayPlanTool,
  ProactivePrefsTool,
  // workflows (docs/WORKFLOWS.md), appended so the cached order stays
  WorkflowTool,
  // search over past chats (session/search.ts), appended for the same reason
  SessionSearchTool,
  SessionReadTool,
  // skills agents write (extensions/learned.ts)
  SkillManageTool,
  // maps (maps/service.ts), appended so the cached order stays
  PlaceSearchTool,
  PlaceDetailsTool,
  DirectionsTool,
  MapImageTool,
  // calendar and mail (pim/service.ts), appended for the same reason
  CalendarListTool,
  CalendarFreeBusyTool,
  CalendarEventTool,
  MailSearchTool,
  MailReadTool,
  MailDraftTool,
  // watches (watches/service.ts), opt-in: the agents that browse name them (the assistant); appended so the cached order stays
  WatchReportTool,
  WatchCreateTool,
  // a workflow run's progress (workflows/service.ts status), offered wherever Workflow is; appended so the cached order stays
  WorkflowStatusTool,
  // hand a job to a Code or Assistant session on a device (engine/delegate.ts); primary sessions only (engine.toolsFor)
  DelegateTool,
  // the Conclave docs that ship with the hub (platform/docs.ts), appended so the cached order stays
  ConclaveHelpTool,
  // a file for the owner as a file card (files/share.ts), appended so the cached order stays
  ShareFileTool,
  // HTML, SVG or Markdown in the outputs folder to PDF or PNG (tools/render-file.ts), opt-in; appended so the cached order stays
  RenderFileTool,
  // screenshots and a report of any URL with the hub's browser (browser/capture.ts), opt-in; appended so the cached order stays
  CaptureTool,
  // x.com posts and video files, videos tiled into contact sheets (tools/read-post.ts), opt-in; appended so the cached order stays
  ReadPostTool,
  // the owner's inspiration board, memories of kind inspiration (tools/save-inspiration.ts), opt-in; appended so the cached order stays
  SaveInspirationTool,
] as Tool[];

const BY_NAME = new Map(BUILTINS.map((t) => [t.name, t]));

/** Every built-in tool, in a stable order. */
export function builtinTools(): Tool[] {
  return [...BUILTINS];
}

export function toolByName(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/**
 * Tools an untrusted session (an agent reading email or web pages, a webhook
 * run) never gets from a bare name: anything that runs code, writes files, or
 * persists state, and the owner's goals, day, preferences, past chats,
 * skills and maps (home, quota), so a page cannot read them out or change them. Only a routine allow
 * rule with content ("Bash(zpool status -x)") brings one back, and then only
 * the calls that rule covers run without asking.
 */
export const UNTRUSTED_DENY = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'MemorySave', 'MemoryForget', 'ScheduleRoutine', 'GoalList', 'GoalGet', 'GoalCreate', 'GoalUpdate', 'GoalLog', 'DayPlan', 'ProactivePrefs', 'Workflow', 'WorkflowStatus', 'SessionSearch', 'SessionRead', 'SkillManage', 'PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage', 'CalendarList', 'CalendarFreeBusy', 'CalendarEvent', 'MailDraft', 'WatchCreate', 'Delegate', 'ShareFile', 'RenderFile', 'Capture', 'ReadPost', 'SaveInspiration', 'preview_start'];

/** Tools an untrusted session keeps without naming them: they touch nothing outside the session. */
export const UNTRUSTED_SAFE = ['TodoWrite', 'AskUserQuestion', 'ReadToolOutput', 'EnterPlanMode', 'ExitPlanMode', 'StructuredOutput'];

export interface ToolFilter {
  /** Allowlist of tool names. "Bash(git:*)" style entries count as "Bash"; "*" and "mcp__server__*" wildcards work. */
  allow?: string[];
  deny?: string[];
  /**
   * The session reads untrusted input: deny by default. A tool stays only when
   * UNTRUSTED_SAFE has it, or allow or grants name it (wildcards do not count;
   * "mcp__server" names that server's tools). UNTRUSTED_DENY tools need a grant
   * with content.
   */
  untrusted?: boolean;
  /** The routine's own allow rules, for an untrusted session: they may name tools the agent's list leaves unnamed. */
  grants?: string[];
  /** Opt-in tools the agent turns on without a tools list (AgentDef.optInTools, the assistant's browser). */
  optIn?: string[];
  /** true: plan mode (read-capable tools plus ExitPlanMode). false: normal mode (no ExitPlanMode). undefined: no change. */
  planMode?: boolean;
  /** Subagent depth; Task is removed at depth >= 2. */
  depth?: number;
}

function toMatcher(entry: string): (name: string) => boolean {
  const name = entry.trim().replace(/\(.*\)$/, '');
  if (!name.includes('*')) return (n) => n === name;
  const re = new RegExp(`^${name.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (n) => re.test(n);
}

/** True when an entry names the tool itself: "Read", "Bash(npm test)", or "mcp__server" for that server's tools. */
function names(entry: string, tool: string): boolean {
  const name = entry.trim().replace(/\([\s\S]*\)$/, '').trim();
  if (name.includes('*')) return false;
  return name === tool || (name.startsWith('mcp__') && !name.slice(5).includes('__') && tool.startsWith(`${name}__`));
}

/** True when an entry names the tool with content: "Bash(npm test)", "WebFetch(domain:x)". */
function namesWithContent(entry: string, tool: string): boolean {
  const m = /^([^()]+?)\(([\s\S]*)\)$/.exec(entry.trim());
  return !!m && m[1].trim() === tool && !!m[2].trim();
}

/** Does an untrusted session see this tool? Deny by default: only what the routine or the agent names. */
export function untrustedOffers(tool: string, f: Pick<ToolFilter, 'allow' | 'grants'>): boolean {
  const grants = f.grants ?? [];
  if (UNTRUSTED_DENY.includes(tool)) return grants.some((g) => namesWithContent(g, tool));
  if (UNTRUSTED_SAFE.includes(tool)) return true;
  return [...(f.allow ?? []), ...grants].some((e) => names(e, tool));
}

/**
 * Narrow a tool list for an agent and session state. Opt-in tools are kept
 * only when named explicitly in allow (wildcards do not count).
 */
export function filterTools<T extends Tool>(tools: T[], f: ToolFilter = {}): T[] {
  const allow = f.allow?.length ? f.allow.map(toMatcher) : undefined;
  const explicit = new Set((f.allow ?? []).map((a) => a.trim().replace(/\(.*\)$/, '')));
  const deny = (f.deny ?? []).map(toMatcher);
  return tools.filter((t) => {
    if (allow && !allow.some((m) => m(t.name))) return false;
    if (t.optIn && !explicit.has(t.name) && !f.optIn?.includes(t.name)) return false;
    if (deny.some((m) => m(t.name))) return false;
    if (f.untrusted && !untrustedOffers(t.name, f)) return false;
    if ((f.depth ?? 0) >= MAX_TASK_DEPTH && t.name === 'Task') return false;
    if (f.planMode === true) {
      if (t.name === 'EnterPlanMode') return false;
      if (t.name !== 'ExitPlanMode' && t.readOnly === false) return false;
    } else if (f.planMode === false && t.name === 'ExitPlanMode') return false;
    return true;
  });
}
