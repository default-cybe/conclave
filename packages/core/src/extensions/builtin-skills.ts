/// <reference path="../agents-defaults/markdown.d.ts" />
import type { SkillDef } from './types';
import { parseMd } from './loader';
import webStudioMd from '../skills-defaults/web-studio/SKILL.md' with { type: 'text' };
import bughuntCatalogueMd from '../skills-defaults/bughunt-catalogue/SKILL.md' with { type: 'text' };
import cveViolationHuntMd from '../skills-defaults/cve-violation-hunt/SKILL.md' with { type: 'text' };
import bugChainingMd from '../skills-defaults/bug-chaining/SKILL.md' with { type: 'text' };
import toolGithubMcpAdvisoriesMd from '../skills-defaults/tool-github-mcp-advisories/SKILL.md' with { type: 'text' };
import toolOsVmd from '../skills-defaults/tool-osv-mcp/SKILL.md' with { type: 'text' };
import toolSemgrepFixRuleMd from '../skills-defaults/tool-semgrep-fix-rule/SKILL.md' with { type: 'text' };
import toolProxyMcpReplayMd from '../skills-defaults/tool-proxy-mcp-replay/SKILL.md' with { type: 'text' };
import toolPlaywrightTwoTenantMd from '../skills-defaults/tool-playwright-two-tenant/SKILL.md' with { type: 'text' };
import toolReaGhidraDiffMd from '../skills-defaults/tool-rea-ghidra-diff/SKILL.md' with { type: 'text' };
import toolLldbAppleCheckMd from '../skills-defaults/tool-lldb-mcp-apple-check/SKILL.md' with { type: 'text' };
import toolPostPatchValidationMd from '../skills-defaults/tool-post-patch-validation/SKILL.md' with { type: 'text' };

/**
 * Skills that ship with Conclave, embedded as text imports so the compiled
 * binary carries them. They load first (registry.ts precedence), so a
 * Claude Code, plugin, learned, user or project skill with the same name wins.
 * They have no folder on disk: the body travels in SkillDef.body.
 */
const DEFAULT_FILES: Array<[string, string]> = [
  ['web-studio', webStudioMd],
  ['bughunt-catalogue', bughuntCatalogueMd],
  ['cve-violation-hunt', cveViolationHuntMd],
  ['bug-chaining', bugChainingMd],
  ['tool-github-mcp-advisories', toolGithubMcpAdvisoriesMd],
  ['tool-osv-mcp', toolOsVmd],
  ['tool-semgrep-fix-rule', toolSemgrepFixRuleMd],
  ['tool-proxy-mcp-replay', toolProxyMcpReplayMd],
  ['tool-playwright-two-tenant', toolPlaywrightTwoTenantMd],
  ['tool-rea-ghidra-diff', toolReaGhidraDiffMd],
  ['tool-lldb-mcp-apple-check', toolLldbAppleCheckMd],
  ['tool-post-patch-validation', toolPostPatchValidationMd],
];

export function builtinSkills(): SkillDef[] {
  return DEFAULT_FILES.map(([name, text]) => {
    const { data, body } = parseMd(text);
    const group = name === 'web-studio' ? undefined : 'security';
    return { name, description: String(data.description ?? '').trim(), dir: '', path: '', body: body.trim(), source: 'builtin', ...(group ? { group } : {}) };
  });
}
