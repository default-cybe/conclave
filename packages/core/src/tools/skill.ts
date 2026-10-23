import type { Tool } from './types';
import { fail } from './util';

export interface SkillInput {
  skill: string;
  args?: string;
}

const DESCRIPTION = `Load a skill: a packaged set of instructions (and sometimes scripts or reference files) for a specific kind of task.

Usage:
- The available skills and their descriptions are listed in your instructions. When a task matches one, load it before starting and follow its instructions.
- skill is the skill's exact name. args is optional free text passed to the skill.
- The result includes the skill's base directory; files it mentions with relative paths live there (read them with Read, run its scripts with Bash).
- Do not load a skill that is already loaded in this conversation; follow the instructions you already have.`;

export const SkillTool: Tool<SkillInput> = {
  name: 'Skill',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Name of the skill to load' },
      args: { type: 'string', description: 'Optional arguments for the skill' },
    },
    required: ['skill'],
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input) => (typeof input.skill === 'string' ? input.skill.replace(/^\//, '') : undefined),
  summarize: (input) => `Load skill ${input.skill}`,
  async run(input, ctx) {
    const name = typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '') : '';
    if (!name) return fail('skill is required.');
    let skill;
    try {
      skill = await ctx.host.loadSkill(name);
    } catch (err) {
      return fail(`Could not load skill "${name}": ${(err as Error).message}`);
    }
    if (!skill) return fail(`Unknown skill "${name}". Use one of the skills listed in your instructions, spelled exactly.`);
    const args = input.args?.trim() ?? '';
    let body = skill.body;
    if (body.includes('$ARGUMENTS')) body = body.replaceAll('$ARGUMENTS', args);
    const parts = [`<skill name="${skill.name}">`, `Base directory for this skill: ${skill.dir}`, '', body.trim()];
    if (args && !skill.body.includes('$ARGUMENTS')) parts.push('', `ARGUMENTS: ${args}`);
    parts.push('</skill>');
    return { content: parts.join('\n'), meta: { skill: skill.name, dir: skill.dir } };
  },
};
