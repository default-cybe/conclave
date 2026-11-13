/**
 * Setup is four steps (design review #8): Welcome, Hub, Connect a model, Make
 * it yours. Then Chat opens. Ids are the URL segment: /welcome, /setup/<id>.
 * `line` is the one line under the name on the Welcome procedure strip.
 *
 * The other old steps are "Set up later" pages (LATER): the same screens,
 * opened from cards on Home and in Settings, outside the four. Old step
 * URLs keep working: a step folded into one of the four opens that step.
 */
export const STEP_IDS = ['welcome', 'hub', 'model', 'yours'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const LATER_IDS = ['extensions', 'agents', 'defaults', 'import', 'devices', 'notifications', 'routines'] as const;
export type LaterId = (typeof LATER_IDS)[number];

/** Every page the setup flow renders. */
export type PageId = StepId | LaterId;

/** Old step ids that are now part of one of the four. */
export const FOLDED: Record<string, StepId> = { subscriptions: 'model', providers: 'model', modes: 'yours', memory: 'yours', done: 'yours' };

export interface StepDef {
  id: PageId;
  name: string;
  line: string;
  title: string;
  lede: string;
  /** Shows "Skip for now". */
  skippable: boolean;
  /** Wider content column for tables. */
  wide?: boolean;
}

export const STEPS: StepDef[] = [
  { id: 'welcome', name: 'Welcome', line: 'Set up or connect', title: 'Welcome', lede: '', skippable: false },
  { id: 'hub', name: 'Hub', line: 'Name and access', title: 'Hub', lede: 'The hub stores your keys, chats and memory. Your other devices connect to it.', skippable: false },
  {
    id: 'model',
    name: 'Connect a model',
    line: 'One plan or one key',
    title: 'Connect a model',
    lede: 'Sign in with a plan you already pay for, such as Claude, ChatGPT or Gemini, or paste one API key. Conclave tests it and uses it as the default model.',
    skippable: true,
    wide: true,
  },
  {
    id: 'yours',
    name: 'Make it yours',
    line: 'Memory and modes',
    title: 'Make it yours',
    lede: 'Choose whether Conclave remembers you, and which extra modes you want. Settings changes both later.',
    skippable: false,
  },
];

/** "Set up later": cards on Home and in Settings open these. */
export const LATER: StepDef[] = [
  { id: 'extensions', name: 'Extension packs', line: 'Recommended tools', title: 'Extensions', lede: 'Install a recommended set of extensions. Any of them can be removed later.', skippable: false },
  {
    id: 'agents',
    name: 'Coding agents',
    line: 'Claude Code, Codex and others as engines',
    title: 'Coding agents',
    lede: 'Optional. Run a session with Claude Code, Codex or another installed CLI instead of the built-in agent.',
    skippable: false,
    wide: true,
  },
  { id: 'defaults', name: 'Defaults', line: 'Models per agent', title: 'Defaults', lede: 'The model, agent and device a new session uses. Each session can change them.', skippable: false },
  { id: 'import', name: 'Past chats', line: 'Claude Code, Codex and Gemini CLI', title: 'Past chats', lede: 'Import Claude Code, Codex and Gemini CLI chats as archived sessions. Memory can learn from them.', skippable: false },
  { id: 'devices', name: 'Devices', line: 'Computers and phones', title: 'Devices', lede: 'Sessions run on the computers you pair. Phones get approvals and notifications.', skippable: false },
  { id: 'notifications', name: 'Notifications', line: 'What reaches you', title: 'Notifications', lede: 'Choose which events send a notification, and which devices get them.', skippable: false },
  { id: 'routines', name: 'Routines', line: 'Starter set', title: 'Routines', lede: 'Routines run on the hub on a schedule. Each one can be edited or paused later.', skippable: false },
];

export function stepIndex(id: PageId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function stepDef(id: PageId): StepDef {
  return STEPS.find((s) => s.id === id) ?? LATER.find((s) => s.id === id)!;
}

export function isStepId(v: string | undefined): v is StepId {
  return !!v && (STEP_IDS as readonly string[]).includes(v);
}

export function isLaterId(v: string | undefined): v is LaterId {
  return !!v && (LATER_IDS as readonly string[]).includes(v);
}

/** The page an id from a URL or saved progress opens: itself, the step it was folded into, or nothing. */
export function pageFor(v: string | undefined): PageId | undefined {
  if (isStepId(v) || isLaterId(v)) return v;
  return v ? FOLDED[v] : undefined;
}

/** Where a page lives: Welcome is /welcome, the rest /setup/<id>. */
export function stepHref(id: PageId): string {
  return id === 'welcome' ? '/welcome' : `/setup/${id}`;
}

/** "01" */
export function stepNumber(id: StepId): string {
  return String(stepIndex(id) + 1).padStart(2, '0');
}
