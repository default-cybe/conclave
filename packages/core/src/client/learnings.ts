/**
 * Reflect's Learnings (docs/ASSISTANT.md, Learnings): corrections,
 * preferences, "remember: ..." and praise caught from what you typed, waiting
 * for you to save, edit or skip, and skill or routine ideas from requests you
 * repeat. Nothing is written until you press Save.
 */

export type LearningKind = 'correction' | 'preference' | 'remember' | 'positive';
/** Where a saved learning goes: a memory, the agent's instructions, the project's CONCLAVE.md, or the learned skill that was running. */
export type LearningTarget = 'memory' | 'agent' | 'project' | 'skill';

export interface Learning {
  id: string;
  kind: LearningKind;
  /** The memory text: a fact in third person ("The user prefers pnpm."). */
  fact: string;
  /** The instruction text for an agent, project or skill file ("Use pnpm, not npm."). */
  rule: string;
  /** What you typed, exactly (cut at 400 characters). */
  quote: string;
  /** 0 to 1, from the model check. */
  confidence: number;
  /** How many times it came up. */
  count: number;
  sessionId: string;
  sessionTitle?: string;
  agent?: string;
  cwd?: string;
  /** The learned skill that was loaded when you said it. */
  skill?: string;
  status: 'pending' | 'saved' | 'skipped';
  savedTo?: { target: LearningTarget; ref?: string };
  createdAt: number;
  updatedAt: number;
}

/** One place a learning can be saved, and why it cannot when it cannot. */
export interface LearningTargetOption {
  target: LearningTarget;
  label: string;
  /** Agent name, folder, or skill name. */
  ref?: string;
  refused?: string;
}

/** Something already saved that says nearly the same thing: Save can merge into it. */
export interface LearningSimilar {
  kind: 'memory' | 'skill';
  /** Memory id or skill name. */
  ref: string;
  text: string;
}

export interface LearningView extends Learning {
  targets: LearningTargetOption[];
  similar: LearningSimilar[];
}

export interface SkillIdea {
  id: string;
  kind: 'skill' | 'routine';
  /** Lowercase words with dashes for a skill; a short title for a routine. */
  name: string;
  description: string;
  /** Skill: Markdown steps. Routine: the prompt for each run. */
  body: string;
  /** Routine only: a cron expression. */
  schedule?: string;
  /** Titles of the sessions that asked for it. */
  examples: string[];
}

export interface LearningsDto {
  items: LearningView[];
  pending: number;
  /** Messages caught by the quick check that wait for the model check. */
  queued: number;
  ideas: SkillIdea[];
  ideasAt?: number;
}

/** What Save would write, shown before anything is written. */
export interface LearningPreview {
  target: LearningTarget;
  ref?: string;
  /** The file, for agent, project and skill. */
  path?: string;
  text: string;
  /** Unified diff lines ("+ ..." added, "  ..." kept) for files; empty for a memory. */
  diff: string[];
  refused?: string;
}

export interface LearningSaveInput {
  target: LearningTarget;
  /** The edited text; default: fact for memory, rule otherwise. */
  text?: string;
  /** memory only. */
  memoryKind?: 'profile' | 'fact';
  /** memory only: update this memory instead of adding one. */
  mergeInto?: string;
}
