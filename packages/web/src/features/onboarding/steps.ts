/**
 * The twelve setup steps (spec 11.11, plus subscription sign-in as step 2). Ids are the URL segment: /setup/<id>.
 * `line` is the one line under the name on the Welcome procedure strip.
 */
export const STEP_IDS = ['hub', 'subscriptions', 'providers', 'extensions', 'agents', 'defaults', 'memory', 'import', 'devices', 'notifications', 'routines', 'done'] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface StepDef {
  id: StepId;
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
  { id: 'hub', name: 'Hub', line: 'Name and access', title: 'Hub', lede: 'The hub stores your keys, chats and memory. Your other devices connect to it.', skippable: false },
  {
    id: 'subscriptions',
    name: 'Subscriptions',
    line: 'Claude, ChatGPT, Gemini',
    title: 'Subscriptions',
    lede: 'Sign in with a plan you already pay for, such as Claude, ChatGPT or Gemini. Its models appear in the model picker.',
    skippable: true,
    wide: true,
  },
  { id: 'providers', name: 'API keys', line: 'Pay per use', title: 'API keys', lede: 'Add a key for each provider you pay per use. Each key is tested when you save it.', skippable: true, wide: true },
  { id: 'extensions', name: 'Extensions', line: 'Recommended set', title: 'Extensions', lede: 'Install a recommended set of extensions. Any of them can be removed later.', skippable: true },
  { id: 'agents', name: 'Coding agents', line: 'Optional', title: 'Coding agents', lede: 'Optional. Run a session with Claude Code, Codex or another installed CLI instead of the built-in agent.', skippable: true, wide: true },
  { id: 'defaults', name: 'Defaults', line: 'Models per agent', title: 'Defaults', lede: 'The model, agent and device a new session uses. Each session can change them.', skippable: true },
  { id: 'memory', name: 'Memory', line: 'Where notes live', title: 'Memory', lede: 'What Conclave remembers about you, and where it stores the notes.', skippable: true },
  { id: 'import', name: 'Import', line: 'Past chats', title: 'Past chats', lede: 'Import Claude Code, Codex and Gemini CLI chats as archived sessions. Memory can learn from them.', skippable: true },
  { id: 'devices', name: 'Devices', line: 'Computers and phones', title: 'Devices', lede: 'Sessions run on the computers you pair. Phones get approvals and notifications.', skippable: true },
  { id: 'notifications', name: 'Notifications', line: 'What reaches you', title: 'Notifications', lede: 'Choose which events send a notification, and which devices get them.', skippable: true },
  { id: 'routines', name: 'Routines', line: 'Starter set', title: 'Routines', lede: 'Routines run on the hub on a schedule. Each one can be edited or paused later.', skippable: true },
  { id: 'done', name: 'Done', line: 'Open Home', title: 'Setup complete', lede: 'What is set up. Change any item here, or later in Settings.', skippable: false },
];

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function stepDef(id: StepId): StepDef {
  return STEPS[stepIndex(id)];
}

export function isStepId(v: string | undefined): v is StepId {
  return !!v && (STEP_IDS as readonly string[]).includes(v);
}

/** "01" */
export function stepNumber(id: StepId): string {
  return String(stepIndex(id) + 1).padStart(2, '0');
}
