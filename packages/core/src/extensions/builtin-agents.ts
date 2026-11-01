/// <reference path="../agents-defaults/markdown.d.ts" />
import type { PermissionMode, SessionMode } from '../types';
import type { AgentDef } from './types';
import { agentExtras, defaultModelMapper, parseMd } from './loader';
import { toList } from '../util/frontmatter';
import assistantMd from '../agents-defaults/assistant.md' with { type: 'text' };
import chatMd from '../agents-defaults/chat.md' with { type: 'text' };
import coderMd from '../agents-defaults/coder.md' with { type: 'text' };
import researcherMd from '../agents-defaults/researcher.md' with { type: 'text' };
import reviewerMd from '../agents-defaults/reviewer.md' with { type: 'text' };
import tutorMd from '../agents-defaults/tutor.md' with { type: 'text' };
import plannerMd from '../agents-defaults/planner.md' with { type: 'text' };
import sysadminMd from '../agents-defaults/sysadmin.md' with { type: 'text' };
import securityMd from '../agents-defaults/security.md' with { type: 'text' };
import librarianMd from '../agents-defaults/librarian.md' with { type: 'text' };
import exploreMd from '../agents-defaults/explore.md' with { type: 'text' };
import generalPurposeMd from '../agents-defaults/general-purpose.md' with { type: 'text' };
import verifierMd from '../agents-defaults/verifier.md' with { type: 'text' };
import builderMd from '../agents-defaults/builder.md' with { type: 'text' };
import testerMd from '../agents-defaults/tester.md' with { type: 'text' };
import debuggerMd from '../agents-defaults/debugger.md' with { type: 'text' };
import designerMd from '../agents-defaults/designer.md' with { type: 'text' };
import refactorerMd from '../agents-defaults/refactorer.md' with { type: 'text' };
import docsWriterMd from '../agents-defaults/docs-writer.md' with { type: 'text' };
import webSearcherMd from '../agents-defaults/web-searcher.md' with { type: 'text' };
import codeResearcherMd from '../agents-defaults/code-researcher.md' with { type: 'text' };
import factCheckerMd from '../agents-defaults/fact-checker.md' with { type: 'text' };
import synthesizerMd from '../agents-defaults/synthesizer.md' with { type: 'text' };
import workflowMd from '../agents-defaults/workflow.md' with { type: 'text' };
import emailMd from '../agents-defaults/email.md' with { type: 'text' };

/**
 * Built-in agent profiles. These ship with Conclave and are always available.
 * User, project, plugin and Claude Code agents with the same name override
 * them (see registry.ts precedence).
 *
 * Each one is a markdown file in agents-defaults/ (frontmatter plus the
 * prompt), the same format as a user agent. The files are embedded as text
 * imports so the compiled binary carries them. Every prompt was checked in
 * real-model trials before it shipped; see docs/agents/README.md.
 *
 * Most agents leave model unset and inherit the session's model. The
 * specialists name a tier word instead (fast, smart, deep), which each
 * session resolves through models.tiers (extensions/agent-model.ts); a user
 * can pin a model in their own copy.
 */
const DEFAULT_FILES: Array<[string, string]> = [
  ['assistant', assistantMd],
  ['chat', chatMd],
  ['coder', coderMd],
  ['researcher', researcherMd],
  ['reviewer', reviewerMd],
  ['tutor', tutorMd],
  ['planner', plannerMd],
  ['sysadmin', sysadminMd],
  ['security', securityMd],
  ['librarian', librarianMd],
  ['explore', exploreMd],
  ['general-purpose', generalPurposeMd],
  // specialists (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md section 4)
  ['verifier', verifierMd],
  ['builder', builderMd],
  ['tester', testerMd],
  ['debugger', debuggerMd],
  ['designer', designerMd],
  ['refactorer', refactorerMd],
  ['docs-writer', docsWriterMd],
  ['web-searcher', webSearcherMd],
  ['code-researcher', codeResearcherMd],
  ['fact-checker', factCheckerMd],
  ['synthesizer', synthesizerMd],
  ['workflow', workflowMd],
  // reads mail as untrusted input for the assistant (docs/DESIGN.md, Calendar and mail)
  ['email', emailMd],
];

const MODES = new Set<SessionMode>(['agent', 'chat', 'plan', 'jury', 'debate', 'loop']);
const PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'bypass']);
const MEMORY = new Set(['global', 'agent', 'none']);

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length ? s : undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  const s = str(v)?.toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  return undefined;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function positiveInt(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 1 ? Math.floor(n) : undefined;
}

/** Parse one default agent file. The file name is the fallback for `name`. */
export function parseAgentMarkdown(fallbackName: string, text: string): AgentDef {
  const { data, body } = parseMd(text);
  const mode = str(data.mode);
  const pm = str(data.permissionMode);
  const memory = str(data.memory);
  const def: AgentDef = {
    name: str(data.name) ?? fallbackName,
    description: str(data.description) ?? '',
    prompt: body.trim(),
    // tier words (fast, smart, deep) and Claude Code names stay words; each session resolves them
    model: defaultModelMapper()(str(data.model)),
    tools: toList(data.tools),
    disallowedTools: toList(data.disallowedTools),
    mode: mode && MODES.has(mode as SessionMode) ? (mode as SessionMode) : undefined,
    permissionMode: pm && PERMISSION_MODES.has(pm as PermissionMode) ? (pm as PermissionMode) : undefined,
    color: str(data.color),
    icon: str(data.icon),
    skills: toList(data.skills),
    mcpServers: toList(data.mcpServers),
    memory: memory && MEMORY.has(memory) ? (memory as AgentDef['memory']) : undefined,
    subagent: bool(data.subagent),
    primary: bool(data.primary),
    untrusted: bool(data.untrusted),
    temperature: num(data.temperature),
    maxSteps: positiveInt(data.maxSteps ?? data.maxTurns),
    // thinking (or effort), hooks, recipes, ultra and verifyCommand, read like user agents
    ...agentExtras(data),
    source: 'builtin',
  };
  // Drop unset keys so the objects look like hand-written ones.
  for (const k of Object.keys(def) as Array<keyof AgentDef>) if (def[k] === undefined) delete def[k];
  return def;
}

const PARSED = DEFAULT_FILES.map(([name, text]) => ({ name, text, def: parseAgentMarkdown(name, text) }));

export const BUILTIN_AGENTS: AgentDef[] = PARSED.map((p) => p.def);

export function builtinAgents(): AgentDef[] {
  // Fresh clones so callers cannot mutate the shared defaults.
  return BUILTIN_AGENTS.map((a) => ({ ...a }));
}

/**
 * The shipped default of a built-in agent: the parsed profile and the raw
 * markdown file. Undefined for any other name. The UI uses it to show the
 * original next to a user's edited copy and to offer a reset.
 */
export function builtinAgentDefault(name: string): { agent: AgentDef; markdown: string } | undefined {
  const hit = PARSED.find((p) => p.def.name === name);
  return hit ? { agent: { ...hit.def }, markdown: hit.text } : undefined;
}
