import type {
  DocumentBlock,
  ImageBlock,
  JsonSchema,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemoryScope,
  Notice,
  QuestionRequest,
  Session,
  TextBlock,
  Todo,
  ToolResultMeta,
} from '../types';
import type { Machine } from '../machine/types';
import type { ConclaveConfig } from '../config/schema';

export interface ToolOutput {
  content: string | Array<TextBlock | ImageBlock | DocumentBlock>;
  isError?: boolean;
  meta?: ToolResultMeta;
}

/**
 * Everything a tool may need from the engine. The engine implements this;
 * tools stay testable with a fake host.
 */
export interface ToolHost {
  config(): ConclaveConfig;
  /** The web search key saved in Settings > Web search (a hub secret), for WebSearch only. */
  searchKey?(provider: string): string | undefined;
  /** Run a subagent to completion and return its final text. */
  runSubagent(opts: {
    parentSessionId: string;
    agent: string;
    prompt: string;
    description: string;
    model?: string;
    background?: boolean;
    signal?: AbortSignal;
    /** JSON Schema for the result: the child gets StructuredOutput and the call returns the validated object (engine/structured-task.ts). */
    schema?: unknown;
  }): Promise<{ sessionId: string; text: string; structured?: unknown; error?: string }>;
  /** The agent's profile as this session's account sees it, for Task's capability preflight (engine/tool-check.ts). */
  subagentTools?(agent: string): { name: string; tools?: string[]; disallowedTools?: string[] } | undefined;
  /** Ask the user multiple-choice questions and wait. */
  askUser(sessionId: string, questions: QuestionRequest['questions'], signal?: AbortSignal): Promise<Record<string, string>>;
  /** One-shot completion on any model (used by Consult, WebFetch summarizing). */
  complete(opts: { model?: string; system?: string; prompt: string; maxTokens?: number; signal?: AbortSignal; purpose?: string }): Promise<string>;
  memory: {
    search(query: string, opts?: { scope?: MemoryScope; scopeKey?: string; limit?: number; kinds?: MemoryKind[] }): Promise<MemoryHit[]>;
    save(entry: { content: string; kind?: MemoryKind; scope?: MemoryScope; scopeKey?: string; tags?: string[]; sourceSessionId?: string; importance?: number }): Promise<MemoryEntry>;
    remove(id: string): Promise<boolean>;
  };
  setTodos(sessionId: string, todos: Todo[]): void;
  getTodos(sessionId: string): Todo[];
  notify(notice: Omit<Notice, 'id' | 'createdAt'>): Promise<void>;
  /** Store a large output and return its id. */
  saveOutput(sessionId: string, tool: string, content: string): string;
  readOutput(id: string): string | undefined;
  /** Load a skill body by name. */
  loadSkill(name: string): Promise<{ name: string; body: string; dir: string } | undefined>;
  /** Every skill the session may load, for the Skill tool's query. */
  listSkills?(): Promise<Array<{ name: string; description: string; plugin?: string }>>;
  /** Create a routine from chat. */
  createRoutine(input: { name: string; schedule: string; prompt: string; agent?: string; cwd?: string; device?: string }): Promise<{ id: string; nextRunAt?: number }>;
  /** Switch session into or out of plan mode. */
  setPermissionMode(sessionId: string, mode: Session['permissionMode']): void;
  /** Tell the session a background shell Bash moved there has ended; the note joins its next step or wakes it when idle. */
  shellEnded?(sessionId: string, text: string): void;
  /** Record an audit entry. */
  audit(sessionId: string, action: string, detail: string): void;
  /** Goals, preferences and day plans (assistant/service.ts), when the hub has them. */
  assistant?: import('../assistant/service').AssistantService;
  /** Places, directions and map images (maps/service.ts), when the hub has them. */
  maps?: import('../maps/service').MapsService;
  /** Watches (watches/service.ts): WatchReport and WatchCreate. */
  watches?: import('../watches/service').WatchService;
  /** The workflow engine (workflows/service.ts), for the Workflow tool. */
  workflows?: import('../workflows/service').WorkflowService;
  /** Calendars, mail and proposals (pim/service.ts), when the hub has them. */
  pim?: import('../pim/service').PimService;
  /** True when this session reads untrusted input (session/untrusted.ts): only then may mail text reach it. */
  untrusted?(): boolean;
  /**
   * The owner's past chats and sessions (session/search.ts), for SessionSearch
   * and SessionRead. The host leaves out the session asking and those it runs
   * under, and untrusted agents' sessions; a device name is resolved to its id.
   */
  pastSessions?: {
    search(q: Omit<import('../session/search').PastSessionQuery, 'exclude' | 'skipAgent'>): import('../session/search').PastSessionHit[];
    read(id: string, opts: { around?: number; count?: number }): import('../session/search').PastRead | undefined;
  };
  /**
   * Skills agents write (extensions/learned.ts), for SkillManage. The host
   * stamps the session id on new skills and reloads the registry after a write.
   */
  learnedSkills?: {
    list(): import('../extensions/learned').LearnedSkill[];
    get(name: string): import('../extensions/learned').LearnedSkill | undefined;
    create(input: { name: string; description: string; body: string; project?: string }): import('../extensions/learned').LearnedSkill;
    patch(name: string, input: { section?: string; content?: string; pitfall?: string; description?: string }): import('../extensions/learned').LearnedSkill;
    disable(name: string, reason: string): import('../extensions/learned').LearnedSkill;
    /** Where a skill with this name comes from when it is not a learned one ("user", "plugin superpowers"), else undefined. */
    taken(name: string): string | undefined;
  };
  /** MCP tools of this session whose schemas are deferred behind ToolSearch (tools/tool-search.ts). */
  deferredTools?(): Tool[];
  /** Background subagents of a session (engine/background.ts), for TaskList, TaskWait, TaskResult and TaskContinue. */
  tasks?: import('./background-tasks').TaskHost;
  /** Hand a job to a Code or Assistant session on a device and wait for its answer (engine/delegate.ts), for Delegate. */
  delegate?(req: import('./delegate').DelegateRequest): Promise<import('./delegate').DelegateOutcome>;
  /** Check that an absolute path may be shared with the owner (files/share.ts checkShareable over engine.shareRoots), for ShareFile. */
  shareCheck?(path: string): Promise<import('../files/share').ShareCheck>;
  /** The session's outputs folder on the hub (<home>/outputs/<sessionId>), made on first use. */
  outputsDir?(): string;
  /** playwright-core's chromium and the hub's browser binary, for RenderFile (tools/render-file.ts); an error when the hub has none. */
  renderBrowser?(): Promise<import('./render-file').RenderBrowser | { error: string }>;
  /** Capture a URL with the hub's browser into the session's outputs folder (browser/capture.ts). */
  capture?(url: string, opts: import('../browser/capture').CaptureOptions, signal?: AbortSignal): Promise<import('../browser/capture').CaptureResult>;
  /** The hub's ffmpeg, fetched on first use (util/ffmpeg.ts findFfmpeg), for ReadPost. */
  ffmpeg?(): Promise<{ path: string } | { error: string }>;
}

export interface ToolContext {
  sessionId: string;
  session: Session;
  /** Current working directory of the session on its machine. */
  cwd: string;
  machine: Machine;
  host: ToolHost;
  signal: AbortSignal;
  /** Model ref of the agent calling the tool. */
  model: string;
  agent: string;
  /** Subagent nesting depth (0 for the main session). */
  depth: number;
  /** Absolute path -> mtime at last Read. Edit/Write refuse files that changed since or were never read. */
  readState: Map<string, number>;
  /**
   * The newest read mark for a path in the session's context (a Read, Edit or
   * Write result's meta.readMark). The runner provides it; when it does, it
   * decides over readState, so a compaction that drops the Read refuses the edit.
   */
  readMark?(path: string): ReadMark | undefined;
  /** True when a Read of this absolute path would run without asking. Only then may Edit change a file it never read. */
  readAllowed?(absPath: string): boolean;
  /** Live progress lines (bash output) for the UI. */
  progress(text: string): void;
  toolUseId: string;
  /** Names of the tools in the session's tool list this step (the runner sets it; ToolSearch lists them on a miss). */
  toolNames?: string[];
  /**
   * Old folders of a session that moved (projects/move.ts). File tools map an
   * absolute path under roots[i].from to roots[i].to and push the old root on
   * hits, so the result can say so once.
   */
  pathMap?: PathMap;
}

/** What a file tool's result records about the file it read or wrote (meta.readMark). */
export interface ReadMark {
  path: string;
  mtimeMs: number;
  /** sha256 of the text; absent above 4 MB. */
  sha256?: string;
}

export interface PathMap {
  /** Only old roots that do not exist on the current device. Longest first. */
  roots: Array<{ from: string; to: string; device?: string }>;
  /** Old roots this call mapped. */
  hits: string[];
}

export interface Tool<I = Record<string, any>> {
  name: string;
  /** Model-facing description. Keep it precise: models follow these literally. */
  description: string;
  inputSchema: JsonSchema;
  /** True when the tool never changes anything. Read-only tools run in parallel and are allowed in plan mode. */
  readOnly: boolean | ((input: I) => boolean);
  /** Edits files (used by acceptEdits permission mode). */
  editsFiles?: boolean;
  /**
   * String matched against permission rules, e.g. the command for Bash,
   * the path for Read/Edit, the domain for WebFetch ("domain:example.com").
   */
  /** The path or command rules match against; a path under an old root of a moved session is mapped (ctx.pathMap) as the tool will map it. */
  ruleContent?(input: I, ctx: Pick<ToolContext, 'cwd' | 'machine' | 'pathMap'>): string | undefined;
  /** Short label for UI and approvals, e.g. "Read src/index.ts". */
  summarize?(input: I): string;
  /** Suggest an "always allow" rule for approvals, e.g. "Bash(npm test:*)". */
  suggestRule?(input: I): string | undefined;
  /** Hidden unless the session/agent opts in (e.g. browser tools). */
  optIn?: boolean;
  /**
   * Built for untrusted sessions: it only reads outside content into the
   * session and sends nothing out, so it runs there without asking (MailSearch).
   */
  untrustedReader?: boolean;
  /** The tool validates its own input, so the runner's top-level check is skipped (StructuredOutput lists every problem by path). */
  validatesInput?: boolean;
  /**
   * Longest a call may take. The runner stops waiting at this point or on a
   * user stop, even when the tool ignores its signal (MCP tools, HARNESS-REVIEW item 9).
   */
  timeoutMs?: number;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

/** The result of a call that ran past its time limit. */
export function timeoutOutput(ms: number): ToolOutput {
  return { content: `Error: tool call timed out after ${Math.round(ms / 100) / 10} s`, isError: true, meta: { code: 'TOOL_TIMEOUT' } };
}

export function toolIsReadOnly(tool: Tool, input: Record<string, any>): boolean {
  return typeof tool.readOnly === 'function' ? tool.readOnly(input) : tool.readOnly;
}

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Models sometimes send a structured parameter as a string: `edits` as a JSON
 * string, `replace_all` as "true", `limit` as "50". Claude Code accepts these,
 * so Conclave does too: a top-level string becomes the value it spells when
 * that value has the type the schema expects. Anything else is left as sent,
 * and validateInput reports it.
 */
export function coerceInput(schema: JsonSchema, input: unknown): { input: unknown; coerced: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { input, coerced: [] };
  const obj = input as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  const coerced: string[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const v = obj[key];
    if (typeof v !== 'string') continue;
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    if (!types.length || types.includes('string')) continue;
    const s = v.trim();
    let value: unknown;
    let ok = false;
    if (types.includes('array') || types.includes('object')) {
      try {
        value = JSON.parse(s);
        ok = (Array.isArray(value) && types.includes('array')) || (typeof value === 'object' && value !== null && !Array.isArray(value) && types.includes('object'));
      } catch {
        ok = false;
      }
    }
    if (!ok && types.includes('boolean') && (s === 'true' || s === 'false')) {
      value = s === 'true';
      ok = true;
    }
    if (!ok && (types.includes('number') || types.includes('integer')) && NUMERIC.test(s)) {
      value = Number(s);
      ok = Number.isFinite(value) && (types.includes('number') || Number.isInteger(value));
    }
    if (!ok) continue;
    out ??= { ...obj };
    out[key] = value;
    coerced.push(key);
  }
  return { input: out ?? input, coerced };
}

/** Minimal JSON schema validation for tool inputs: required keys and primitive types. */
export function validateInput(schema: JsonSchema, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'Input must be an object';
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) return `Missing required parameter: ${key}`;
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    if (!types.length) continue;
    const actual = Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer') || (t === 'integer' && actual === 'number' && Number.isInteger(v)));
    if (!ok) return `Parameter ${key} must be ${types.join(' or ')}, got ${actual}`;
    if (prop.enum && !prop.enum.includes(v)) return `Parameter ${key} must be one of: ${prop.enum.join(', ')}`;
  }
  return undefined;
}
