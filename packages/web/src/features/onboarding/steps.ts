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
  { id: 'hub', name: 'Hub', line: 'Connect or create', title: 'Connect to your hub', lede: 'The hub keeps your keys, sessions and memory. Every other device connects to it.', skippable: false },
  {
    id: 'subscriptions',
    name: 'Subscriptions',
    line: 'Plans you pay for',
    title: 'Sign in to your AI subscriptions',
    lede: 'Use the plans you already pay for. Sign in once and every model those accounts give shows up in the model picker.',
    skippable: true,
    wide: true,
  },
  { id: 'providers', name: 'Providers', line: 'Keys and plans', title: 'Add your providers', lede: 'Each key is tested against the provider when you paste it. You can add more later in Settings.', skippable: true, wide: true },
  { id: 'extensions', name: 'Extensions', line: 'Recommended set', title: 'Make Conclave better', lede: 'Install these extensions? You can remove any of them later in Extensions.', skippable: true },
  { id: 'agents', name: 'Coding agents', line: 'Optional engines', title: 'Coding agents as engines', lede: 'Optional. Conclave runs its own agent loop. Use Claude Code or Codex as the engine for a session, on the machine where each one is installed.', skippable: true, wide: true },
  { id: 'defaults', name: 'Defaults', line: 'Models per agent', title: 'Pick defaults', lede: 'What a new session uses when you do not choose. Any session can change it.', skippable: true },
  { id: 'memory', name: 'Memory', line: 'Basic Memory vault', title: 'Memory', lede: 'What Conclave remembers about you and your machines, and where it keeps the notes.', skippable: true },
  { id: 'import', name: 'Import', line: 'Past chats', title: 'Import past chats', lede: 'Bring in your Claude Code, Codex and Gemini CLI chats as archived sessions, and learn memory from them if you want, so search and memory start from what you already did.', skippable: true },
  { id: 'devices', name: 'Devices', line: 'Computer and phone', title: 'Pair your devices', lede: 'Sessions run on computers you pair. Your phone gets approvals and notifications.', skippable: true },
  { id: 'notifications', name: 'Notifications', line: 'What reaches you', title: 'What reaches you', lede: 'Approvals and failures can find you while you are away from Conclave.', skippable: true },
  { id: 'routines', name: 'Routines', line: 'Starter set', title: 'Starter routines', lede: 'Routines run on the hub on a schedule. Add a few to start; each one can be edited or paused later.', skippable: true },
  { id: 'done', name: 'Done', line: 'Open Home', title: 'Conclave is ready', lede: 'Here is what is set up. Every line can be changed later in Settings.', skippable: false },
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
