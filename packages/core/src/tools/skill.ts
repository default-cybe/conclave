import type { Tool } from './types';
import { fail } from './util';
import { matchSkills } from '../session/skill-list';
import type { SkillDef } from '../extensions/types';

export interface SkillInput {
  skill?: string;
  args?: string;
  query?: string;
}

/** Most skills a keyword query returns, with full descriptions. */
const QUERY_LIMIT = 15;

const DESCRIPTION = `Load a skill: a packaged set of instructions (and sometimes scripts or reference files) for a specific kind of task.

Usage:
- The available skills are listed in your instructions, some with descriptions and some by name only. When a task matches one, load it before starting and follow its instructions.
- skill is the skill's exact name. args is optional free text passed to the skill.
- To find a skill, call it with query instead of skill: a few words searches every skill's name and description, and a plugin name lists that plugin's skills.
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
      query: { type: 'string', description: 'Instead of skill: words to search the skills for, or a plugin name to list its skills' },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input) => (typeof input.skill === 'string' ? input.skill.replace(/^\//, '') : undefined),
  summarize: (input) => (input.skill ? `Load skill ${input.skill}` : `Find skills: ${input.query ?? ''}`),
  async run(input, ctx) {
    const name = typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '') : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!name && query) return findSkills(query, (await ctx.host.listSkills?.()) ?? []);
    if (!name) return fail('skill (a name to load) or query (words to search) is required.');
    let skill;
    try {
      skill = await ctx.host.loadSkill(name);
    } catch (err) {
      return fail(`Could not load skill "${name}": ${(err as Error).message}`);
    }
    if (!skill) return fail(`Unknown skill "${name}". Use one of the skills listed in your instructions, spelled exactly, or call Skill with query to search for one.`);
    const args = input.args?.trim() ?? '';
    let body = skill.body;
    if (body.includes('$ARGUMENTS')) body = body.replaceAll('$ARGUMENTS', args);
    // a built-in skill has no folder, so no base directory line
    const parts = [`<skill name="${skill.name}">`, ...(skill.dir ? [`Base directory for this skill: ${skill.dir}`, ''] : []), body.trim()];
    if (args && !skill.body.includes('$ARGUMENTS')) parts.push('', `ARGUMENTS: ${args}`);
    parts.push('</skill>');
    return { content: parts.join('\n'), meta: { skill: skill.name, dir: skill.dir } };
  },
};

/** A plugin's skills (query is its name), else the skills that best match the words. */
function findSkills(query: string, all: Array<Pick<SkillDef, 'name' | 'description' | 'plugin'>>) {
  const lower = query.toLowerCase();
  const plugin = all.filter((s) => s.plugin?.toLowerCase() === lower);
  if (plugin.length) {
    // a plugin can hold hundreds of skills: one short line each
    const short = (d: string) => (d.length > 140 ? `${d.slice(0, 137).replace(/\s+\S*$/, '')}...` : d);
    return { content: `${plugin.length} skills in ${plugin[0].plugin}:\n${plugin.map((s) => `- ${s.name}: ${short(s.description)}`).join('\n')}`, meta: { count: plugin.length } };
  }
  const hits = matchSkills(all as SkillDef[], query).slice(0, QUERY_LIMIT);
  if (!hits.length) return { content: `No skill matches "${query}". Try other words, or a plugin name from your instructions.`, meta: { count: 0 } };
  return { content: `Skills matching "${query}", best first. Load one with skill set to its name.\n${hits.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`, meta: { count: hits.length } };
}
