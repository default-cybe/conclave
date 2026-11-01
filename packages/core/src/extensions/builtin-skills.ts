/// <reference path="../agents-defaults/markdown.d.ts" />
import type { SkillDef } from './types';
import { parseMd } from './loader';
import webStudioMd from '../skills-defaults/web-studio/SKILL.md' with { type: 'text' };

/**
 * Skills that ship with Conclave, embedded as text imports so the compiled
 * binary carries them. They load first (registry.ts precedence), so a
 * Claude Code, plugin, learned, user or project skill with the same name wins.
 * They have no folder on disk: the body travels in SkillDef.body.
 */
const DEFAULT_FILES: Array<[string, string]> = [['web-studio', webStudioMd]];

export function builtinSkills(): SkillDef[] {
  return DEFAULT_FILES.map(([name, text]) => {
    const { data, body } = parseMd(text);
    return { name, description: String(data.description ?? '').trim(), dir: '', path: '', body: body.trim(), source: 'builtin' };
  });
}
