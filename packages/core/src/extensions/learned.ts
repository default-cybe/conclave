/**
 * Skills the agents write (docs/EXTENSIONS.md, Skills agents write). A method
 * that worked becomes a skill, not a memory note: memory holds facts about
 * the owner, a skill holds steps, commands and pitfalls that an agent loads
 * when a task needs them.
 *
 *   <hub home>/learned-skills/<name>/SKILL.md
 *
 * The registry loads this folder between plugins and the owner's own
 * ~/.conclave/skills, so a skill the owner wrote wins over a learned one with
 * the same name. Frontmatter holds name, description, `source: learned`, the
 * session it came from, created and updated dates, `project` for a skill
 * that fits one folder, and `disabled: true` once it is turned off.
 *
 * Learned skills are Markdown only: one SKILL.md, no scripts or other files,
 * no hooks and no allowed-tools (the loader ignores both), no !`command`
 * lines or @file includes (a skill typed as /name would run or read them),
 * and nothing the secrets filter flags. Agents never delete one; they turn
 * it off. The owner can edit, turn off or delete each one.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, toFrontmatter } from '../util/frontmatter';
import { containsSecret, redactSecrets } from '../memory/secrets';
import type { SkillDef } from './types';

export const LEARNED_DIR = 'learned-skills';

export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  /** Session the skill was written in. */
  sessionId?: string;
  /** The folder a project skill is for; absent for a global skill. */
  project?: string;
  /** YYYY-MM-DD */
  created: string;
  updated: string;
  enabled: boolean;
  /** Why it was turned off, when an agent turned it off. */
  disabledReason?: string;
  dir: string;
  path: string;
  /** Last time an agent loaded it with Skill, epoch ms. */
  lastUsedAt?: number;
  uses?: number;
}

export class LearnedSkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const MAX_BODY = 20_000;
const MAX_DESCRIPTION = 400;

/** A place to keep use counts (the hub's kv table). */
export interface UseStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

const USE_KEY = 'skills.learned.used';

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function str(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/** The problem with a skill an agent wants to write, or undefined when it is fine. */
export function learnedTextProblem(input: { name?: string; description?: string; body?: string }): string | undefined {
  if (input.name !== undefined && !NAME_RE.test(input.name)) return 'name must be 3 to 64 lowercase letters, digits and dashes, such as "pbs-restore-test".';
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (d.length < 10) return 'description is too short. Say in one line what the skill does and when to use it.';
    if (d.length > MAX_DESCRIPTION || /\n/.test(d)) return `description must be one line under ${MAX_DESCRIPTION} characters.`;
  }
  const texts = [input.description ?? '', input.body ?? ''];
  if (input.body !== undefined) {
    const b = input.body.trim();
    if (!b) return 'body is empty. Write the method in Markdown: steps, commands, checks and pitfalls.';
    if (b.length > MAX_BODY) return `body is over ${MAX_BODY} characters. Keep the method short; leave out this task's details.`;
    if (/^---\s*\n/.test(b)) return 'Send the body without frontmatter. Name and description are their own fields.';
  }
  for (const t of texts) {
    // a skill typed as /name expands these (extensions/commands.ts)
    if (/!`[^`]+`/.test(t)) return 'Skills are Markdown only: write commands in a code block, not as !`command` lines, which would run when the skill is typed.';
    if (/(^|[\s(])@(?:[~./]|\{)/.test(t)) return 'Skills are Markdown only: write paths as plain text or code, not as @file includes.';
    if (containsSecret(t)) return 'This looks like it contains a secret (a password, key or token). Leave the value out and say where it is kept instead.';
  }
  return undefined;
}

/** A Markdown section by its heading text (any level), as [start, end) line indexes, or undefined. */
function findSection(lines: string[], heading: string): { start: number; end: number; level: number } | undefined {
  const want = heading.replace(/^#+\s*/, '').trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m || m[2].toLowerCase() !== want) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = /^(#{1,6})\s/.exec(lines[j]);
      if (n && n[1].length <= level) {
        end = j;
        break;
      }
    }
    return { start: i, end, level };
  }
  return undefined;
}

/** Replace a section's text (keeping its heading), or add the section at the end. */
export function replaceSection(body: string, heading: string, content: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  const title = heading.replace(/^#+\s*/, '').trim();
  const found = findSection(lines, title);
  const text = content.trim();
  if (!found) return `${lines.join('\n')}\n\n## ${title}\n\n${text}\n`;
  const next = [...lines.slice(0, found.start + 1), '', text, ...(found.end < lines.length ? [''] : []), ...lines.slice(found.end)];
  return `${next.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Add one line under "Pitfalls", making the section when it is missing. */
export function addPitfall(body: string, pitfall: string): string {
  const line = `- ${pitfall.trim().replace(/^[-*]\s+/, '')}`;
  const lines = body.replace(/\s+$/, '').split('\n');
  const found = findSection(lines, 'Pitfalls');
  if (!found) return `${lines.join('\n')}\n\n## Pitfalls\n\n${line}\n`;
  let at = found.end;
  while (at > found.start + 1 && !lines[at - 1].trim()) at--;
  return `${[...lines.slice(0, at), line, ...lines.slice(at)].join('\n').trim()}\n`;
}

function readSkill(dir: string, name: string, uses: Record<string, { at: number; n: number }>): LearnedSkill | undefined {
  const path = join(dir, name, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter<Record<string, unknown>>(text);
  const u = uses[name];
  return {
    name,
    description: str(data.description) ?? '',
    body: body.trim(),
    ...(str(data.session) ? { sessionId: str(data.session) } : {}),
    ...(str(data.project) ? { project: str(data.project) } : {}),
    created: str(data.created) ?? '',
    updated: str(data.updated) ?? str(data.created) ?? '',
    enabled: data.disabled !== true && str(data.disabled) !== 'true',
    ...(str(data['disabled-reason']) ? { disabledReason: str(data['disabled-reason']) } : {}),
    dir: join(dir, name),
    path,
    ...(u ? { lastUsedAt: u.at, uses: u.n } : {}),
  };
}

/** True when a project skill fits this folder (the folder or one below it). */
export function fitsFolder(project: string | undefined, cwd: string | undefined): boolean {
  if (!project) return true;
  if (!cwd) return false;
  const p = project.replace(/\/+$/, '');
  return cwd === p || cwd.startsWith(`${p}/`);
}

/**
 * The enabled learned skills as the registry loads them: global ones, and
 * project ones whose folder holds cwd. No allowed-tools, whatever the file says.
 */
export function loadLearnedSkills(home: string, cwd?: string): SkillDef[] {
  const dir = join(home, LEARNED_DIR);
  if (!existsSync(dir)) return [];
  const out: SkillDef[] = [];
  for (const name of safeList(dir)) {
    const s = readSkill(dir, name, {});
    if (!s || !s.enabled || !fitsFolder(s.project, cwd)) continue;
    out.push({ name: s.name, description: s.description, dir: s.dir, path: s.path, source: 'user', learned: { ...(s.sessionId ? { sessionId: s.sessionId } : {}), ...(s.project ? { project: s.project } : {}), created: s.created, updated: s.updated } });
  }
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => NAME_RE.test(n) && statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'SKILL.md')));
  } catch {
    return [];
  }
}

/** Reads and writes the learned-skills folder. Cheap to make; holds no state but the paths. */
export class LearnedSkills {
  readonly dir: string;

  constructor(
    home: string,
    private uses?: UseStore,
    private now: () => number = Date.now,
  ) {
    this.dir = join(home, LEARNED_DIR);
  }

  private useMap(): Record<string, { at: number; n: number }> {
    return this.uses?.get<Record<string, { at: number; n: number }>>(USE_KEY, {}) ?? {};
  }

  list(): LearnedSkill[] {
    const uses = this.useMap();
    return safeList(this.dir)
      .map((n) => readSkill(this.dir, n, uses))
      .filter((s): s is LearnedSkill => !!s)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): LearnedSkill | undefined {
    if (!NAME_RE.test(name)) return undefined;
    return readSkill(this.dir, name, this.useMap());
  }

  private write(s: Pick<LearnedSkill, 'name' | 'description' | 'body' | 'sessionId' | 'project' | 'created' | 'enabled' | 'disabledReason'>): LearnedSkill {
    const dir = join(this.dir, s.name);
    mkdirSync(dir, { recursive: true });
    const fm = {
      name: s.name,
      description: redactSecrets(s.description.trim()),
      source: 'learned',
      session: s.sessionId,
      project: s.project,
      created: s.created,
      updated: day(this.now()),
      ...(s.enabled ? {} : { disabled: true, 'disabled-reason': s.disabledReason ? redactSecrets(s.disabledReason.replace(/\s+/g, ' ').trim().slice(0, 200)) : undefined }),
    };
    writeFileSync(join(dir, 'SKILL.md'), toFrontmatter(fm, redactSecrets(s.body)));
    return this.get(s.name)!;
  }

  /** A new skill. Throws when the name is taken or the text breaks a rule. */
  create(input: { name: string; description: string; body: string; sessionId?: string; project?: string }): LearnedSkill {
    const problem = learnedTextProblem(input);
    if (problem) throw new LearnedSkillError(400, problem);
    if (this.get(input.name)) throw new LearnedSkillError(409, `A learned skill named ${input.name} exists. Patch it instead.`);
    return this.write({ ...input, created: day(this.now()), enabled: true });
  }

  /** Replace a section, add a pitfall, or change the description. */
  patch(name: string, input: { section?: string; content?: string; pitfall?: string; description?: string; sessionId?: string }): LearnedSkill {
    const cur = this.require(name);
    let body = cur.body;
    if (input.section !== undefined || input.content !== undefined) {
      if (!input.section?.trim() || !input.content?.trim()) throw new LearnedSkillError(400, 'A section patch needs section (the heading) and content (its new text).');
      body = replaceSection(body, input.section, input.content);
    }
    if (input.pitfall !== undefined) {
      if (!input.pitfall.trim()) throw new LearnedSkillError(400, 'pitfall is empty.');
      body = addPitfall(body, input.pitfall);
    }
    const description = input.description?.trim() || cur.description;
    if (body === cur.body && description === cur.description) throw new LearnedSkillError(400, 'Nothing to change. Send section and content, pitfall, or description.');
    const problem = learnedTextProblem({ description, body });
    if (problem) throw new LearnedSkillError(400, problem);
    return this.write({ ...cur, description, body });
  }

  /** The owner's edit from the app: new description or body, kept to the same rules. */
  edit(name: string, input: { description?: string; body?: string }): LearnedSkill {
    const cur = this.require(name);
    const next = { description: input.description?.trim() ?? cur.description, body: input.body ?? cur.body };
    const problem = learnedTextProblem(next);
    if (problem) throw new LearnedSkillError(400, problem);
    return this.write({ ...cur, ...next });
  }

  /** Turn it on or off; an agent that turns one off gives the reason. */
  setEnabled(name: string, enabled: boolean, reason?: string): LearnedSkill {
    const cur = this.require(name);
    if (cur.enabled === enabled && (enabled || !reason)) return cur;
    return this.write({ ...cur, enabled, disabledReason: enabled ? undefined : reason });
  }

  /** Delete the folder. Only the owner does this (the API); agents turn skills off. */
  remove(name: string): boolean {
    if (!this.get(name)) return false;
    rmSync(join(this.dir, name), { recursive: true, force: true });
    return true;
  }

  /** An agent loaded it with Skill. */
  recordUse(name: string): void {
    if (!this.uses) return;
    const map = this.useMap();
    const prev = map[name];
    map[name] = { at: this.now(), n: (prev?.n ?? 0) + 1 };
    this.uses.set(USE_KEY, map);
  }

  private require(name: string): LearnedSkill {
    const s = this.get(name);
    if (!s) throw new LearnedSkillError(404, `No learned skill named ${name}. SkillManage list shows them.`);
    return s;
  }
}
