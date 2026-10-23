import type { Tool } from './types';
import { fail } from './util';
import type { LearnedSkill } from '../extensions/learned';

export interface SkillManageInput {
  action: 'create' | 'patch' | 'list' | 'view' | 'disable';
  name?: string;
  description?: string;
  body?: string;
  section?: string;
  content?: string;
  pitfall?: string;
  scope?: 'global' | 'project';
  reason?: string;
}

const ACTIONS = ['create', 'patch', 'list', 'view', 'disable'] as const;

const DESCRIPTION = `Write and keep skills: Markdown how-tos saved from your own work, which agents load later with the Skill tool. A skill holds a method that worked (steps, commands, checks, pitfalls). Facts about the owner go to MemorySave instead, and one task's progress goes nowhere.

When to use it:
- After a task that took many steps (about 5 or more tool calls), a tricky fix, or a workflow that was not obvious: save the method with create.
- When a skill you loaded turned out wrong or missed a step: patch it before you finish.

Actions:
- list: the skills agents wrote, with when each was last used.
- view: one skill's text (name).
- create: name (lowercase words with dashes, such as "pbs-restore-test"), description (one line: what it does and when to use it), body (Markdown with the steps, commands and pitfalls, not this task's details). scope "project" for a method that only fits this folder; global otherwise.
- patch: name, then section and content to replace that section (or add it), pitfall to add one line under Pitfalls, or description.
- disable: name and reason, to retire a skill that is wrong or replaced. Agents never delete skills.

Markdown only: no scripts, no !\`command\` lines, no @file includes, no frontmatter, no secrets. Saving asks the owner unless they let skills save without asking.`;

function line(s: LearnedSkill): string {
  const used = s.lastUsedAt ? `last used ${new Date(s.lastUsedAt).toISOString().slice(0, 10)} (${s.uses ?? 1} times)` : 'never used';
  const scope = s.project ? `project ${s.project}` : 'global';
  return `- ${s.name}${s.enabled ? '' : ' (off)'}: ${s.description} [${scope}; created ${s.created}, updated ${s.updated}; ${used}${s.sessionId ? `; from ${s.sessionId}` : ''}]`;
}

export const SkillManageTool: Tool<SkillManageInput> = {
  name: 'SkillManage',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'create, patch, list, view or disable' },
      name: { type: 'string', description: 'Skill name: lowercase words with dashes' },
      description: { type: 'string', description: 'One line: what the skill does and when to use it' },
      body: { type: 'string', description: 'create: the skill in Markdown' },
      section: { type: 'string', description: 'patch: heading of the section to replace or add' },
      content: { type: 'string', description: 'patch: new text for that section' },
      pitfall: { type: 'string', description: 'patch: one line to add under Pitfalls' },
      scope: { type: 'string', enum: ['global', 'project'], description: 'create: project for a method that fits only this folder (default global)' },
      reason: { type: 'string', description: 'disable: why the skill is retired' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  readOnly: (input) => input.action === 'list' || input.action === 'view',
  summarize: (input) => {
    const n = input.name ?? '';
    switch (input.action) {
      case 'create':
        return `Save skill ${n}: ${String(input.description ?? '').slice(0, 80)}`;
      case 'patch':
        return input.pitfall ? `Add a pitfall to skill ${n}` : `Update skill ${n}${input.section ? `, section ${input.section}` : ''}`;
      case 'disable':
        return `Turn off skill ${n}${input.reason ? `: ${input.reason.slice(0, 80)}` : ''}`;
      case 'view':
        return `Read skill ${n}`;
      default:
        return 'List learned skills';
    }
  },
  async run(input, ctx) {
    const skills = ctx.host.learnedSkills;
    if (!skills) return fail('Skills cannot be saved on this hub.');
    if (!ACTIONS.includes(input.action)) return fail(`action must be one of ${ACTIONS.join(', ')}.`);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (input.action !== 'list' && !name) return fail('name is required.');
    try {
      switch (input.action) {
        case 'list': {
          const all = skills.list();
          if (!all.length) return { content: 'No learned skills yet.' };
          return { content: `${all.length} learned skills:\n${all.map(line).join('\n')}`, meta: { count: all.length } };
        }
        case 'view': {
          const s = skills.get(name);
          if (!s) return fail(`No learned skill named ${name}.`);
          return { content: `${line(s)}\n\n${s.body}` };
        }
        case 'create': {
          if (typeof input.description !== 'string' || typeof input.body !== 'string') return fail('create needs name, description and body.');
          const taken = skills.taken(name);
          if (taken) return fail(`A skill named ${name} already comes from ${taken}. Pick another name, or patch a learned skill instead.`);
          const s = skills.create({ name, description: input.description, body: input.body, ...(input.scope === 'project' ? { project: ctx.cwd } : {}) });
          return { content: `Saved skill ${s.name}${s.project ? ` for ${s.project}` : ''}. Agents can load it with Skill from the next turn on.`, meta: { skill: s.name } };
        }
        case 'patch': {
          const s = skills.patch(name, { section: input.section, content: input.content, pitfall: input.pitfall, description: input.description });
          return { content: `Updated skill ${s.name}.`, meta: { skill: s.name } };
        }
        case 'disable': {
          if (!input.reason?.trim()) return fail('disable needs a reason, such as "merged into pbs-restore-test" or "not used for 60 days".');
          const s = skills.disable(name, input.reason.trim());
          return { content: `Turned off skill ${s.name}. The owner can turn it on again in Extensions, Skills.`, meta: { skill: s.name } };
        }
      }
    } catch (err) {
      return fail((err as Error).message);
    }
    return fail('unknown action');
  },
};
