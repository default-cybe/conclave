/**
 * Map DTOs: a live view of everything the hub is doing (docs/DESIGN.md,
 * section 28). The hub sits in the middle, devices and projects branch off
 * it, and chats, sessions, subagents and workflow agents are nodes.
 *
 * GET /api/map is the snapshot; GET /api/map?at=<ms> is the same view
 * rebuilt from stored rows at that time (the last 24 hours). While a client
 * asks for them ({type:'map', on:true} on the socket), `map.delta` events
 * carry token and tool activity, at most a few a second.
 */

/**
 * running: a turn is going. waiting: it waits on you (an approval or a
 * question). paused: a usage limit, until it resets. idle: a chat or a
 * session between turns. done: a subagent, workflow agent or run that
 * finished. failed: the last turn or run ended in an error.
 */
export type MapState = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'paused';

/** chat: the Chat page. session: a workbench session. subagent: started by another session. workflow: a run. agent: a workflow run's agent. */
export type MapNodeKind = 'chat' | 'session' | 'subagent' | 'workflow' | 'agent';

export interface MapTool {
  /** The tool_use id. */
  id?: string;
  name: string;
  /** What it works on: a file name, a command, a pattern, a host. */
  target?: string;
  startedAt: number;
  /** Absent while it runs. */
  durationMs?: number;
  error?: boolean;
}

export interface MapUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface MapNode {
  /** The session id; a workflow run is "wf:<run id>". */
  id: string;
  kind: MapNodeKind;
  title: string;
  state: MapState;
  /** What a waiting node waits on. */
  waitingOn?: 'approval' | 'question';
  agent?: string;
  /** "provider/model". */
  model?: string;
  device: string;
  /** The folder it works in. Chats have none. */
  cwd?: string;
  /** The group it hangs off (MapGroup.id). Children of another node have their parent's group. */
  group: string;
  /** The node it hangs off: a subagent's session, a workflow agent's run, a run's session. */
  parentId?: string;
  /** Workflow run id, for runs and their agents. */
  runId?: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  /** The tool running now. */
  tool?: MapTool;
  /** The last tools, newest first, at most 5. */
  tools: MapTool[];
  usage: MapUsage;
  /** Output tokens in the last minute. */
  tokensPerMin: number;
  /** Output tokens per second now, smoothed over a few seconds (the streams follow it). */
  rate: number;
  error?: string;
  /** paused: when the limit resets. */
  resumeAt?: number;
  /** When the node stopped making progress. Filled by the stuck agent alert (docs/DESIGN.md 28); unset until then. */
  stuckSince?: number;
}

/** A project, a folder without one, or the chats. A project on two devices is two groups. */
export interface MapGroup {
  id: string;
  kind: 'project' | 'folder' | 'chats';
  name: string;
  /** "local" for the hub itself. Chats run on the hub. */
  device: string;
  projectId?: string;
  path?: string;
}

export interface MapDevice {
  id: string;
  name: string;
  /** Unknown in a replay. */
  online?: boolean;
}

/** Two agents changing the same file. Filled by the file conflict alert (docs/DESIGN.md 28); absent until then. */
export interface MapConflict {
  /** Node ids. */
  a: string;
  b: string;
  file: string;
  since: number;
}

export interface MapTotals {
  running: number;
  waiting: number;
  /** Since local midnight of the day shown (GET /api/map?tz=<Date#getTimezoneOffset>). */
  today: { from: number; tokens: number; costUsd: number };
}

export interface MapSnapshot {
  /** The time it shows. */
  at: number;
  /** False for a replay. */
  live: boolean;
  /** The earliest time a replay reaches. */
  from: number;
  hub: { name: string; state: MapState };
  devices: MapDevice[];
  groups: MapGroup[];
  nodes: MapNode[];
  totals: MapTotals;
  conflicts?: MapConflict[];
}

/** Part of a node that changed. Only the fields that changed are set. */
export interface MapNodePatch {
  id: string;
  /** A node the client may not have yet (it started, or its place changed): the whole of it. */
  node?: MapNode;
  /** The node is gone (deleted). */
  removed?: boolean;
  state?: MapState;
  waitingOn?: 'approval' | 'question' | null;
  title?: string;
  /** The tool running now; null when none runs. */
  tool?: MapTool | null;
  /** Tools that finished since the last delta, oldest first. */
  done?: MapTool[];
  usage?: MapUsage;
  tokensPerMin?: number;
  rate?: number;
  lastActivityAt?: number;
  endedAt?: number;
  error?: string;
}

/** The map.delta event. */
export interface MapDelta {
  at: number;
  /** Whose work the delta is about (docs/design/ACCOUNTS.md). */
  accountId?: string;
  nodes: MapNodePatch[];
  /** Groups and devices the new nodes hang off, when the client may not have them. */
  groups?: MapGroup[];
  devices?: MapDevice[];
  hub?: { state: MapState };
}

export interface MapQuery {
  /** Rebuild the map at this time (epoch ms, within the last 24 hours). */
  at?: number;
  /** The client's Date#getTimezoneOffset(), for "today". */
  tz?: number;
}
