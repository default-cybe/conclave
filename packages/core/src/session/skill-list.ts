import type { SkillDef } from '../extensions/types';
import { resolveName } from '../extensions/registry';

/**
 * The skills section of the system prompt, kept under a token budget.
 *
 * Under the budget every skill is listed with its description, as before.
 * Over it, the skills most likely to matter get their descriptions: the
 * agent's own `skills:` list, project and hub (non-plugin) skills, and the
 * skills whose words match the agent's role or the session's first message.
 * Every other skill is listed by name, one line per plugin, and loads by
 * name as before. When even the names do not fit, plugins are listed with
 * counts and the Skill tool's query finds the rest.
 *
 * The result depends only on its inputs (no clock, no per-turn data), so a
 * session that passes the same first message gets the same text every turn.
 */

/** Default budget for the section, in estimated tokens (agents.skillTokens). */
export const DEFAULT_SKILL_TOKENS = 6000;

/** Share of the budget the name-only lines may take before plugins are shown as counts. */
const NAMES_SHARE = 0.6;
/** Keyword matches that get a description, at most. */
const MAX_MATCHES = 12;

const HEAD = '# Skills\nSkills are packaged instructions. When a task matches a skill, load it with the Skill tool before starting.';

/** Rough token count: about four characters per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SkillListInput {
  skills: SkillDef[];
  /** Estimated tokens the section may use; 0 or less lists every description. */
  budget?: number;
  /** The agent's own `skills:` frontmatter list. */
  wanted?: string[];
  /** Text to match skills against: the agent's name and description, the session's first message. */
  context?: string;
}

const line = (s: SkillDef) => `- ${s.name}: ${s.description}`;

export function skillsSection({ skills, budget = DEFAULT_SKILL_TOKENS, wanted = [], context = '' }: SkillListInput): string {
  const full = `${HEAD}\n${skills.map(line).join('\n')}`;
  if (budget <= 0 || estimateTokens(full) <= budget) return full;

  const described = new Set<SkillDef>();
  const order: SkillDef[] = [];
  const add = (s: SkillDef | undefined) => {
    if (s && !order.includes(s)) order.push(s);
  };
  for (const w of wanted) add(resolveName(skills, w));
  for (const s of skills) if (s.source === 'project') add(s);
  for (const s of matchSkills(skills, context).slice(0, MAX_MATCHES)) add(s);
  for (const s of skills) if (s.source !== 'plugin') add(s);

  let counts = estimateTokens(nameLines(skills, new Set(), false)) > budget * NAMES_SHARE;
  const render = () => {
    const top = skills.filter((s) => described.has(s));
    const rest = nameLines(skills, described, counts);
    return [HEAD, ...top.map(line), ...(rest ? [restIntro(counts), rest] : [])].join('\n');
  };
  for (const s of order) {
    described.add(s);
    if (estimateTokens(render()) > budget) described.delete(s);
  }
  // shortcut: when the described set alone overflows (a huge `skills:` list), names go to counts; fine for real lists
  if (!counts && estimateTokens(render()) > budget) counts = true;
  return render();
}

function restIntro(counts: boolean): string {
  return counts
    ? 'More skills are installed, counted by plugin below. Call the Skill tool with query set to a plugin name to list its skills, or to a few words to find one.'
    : 'More skills, by name only. Load one by its full name (plugin:name, as grouped below) with the Skill tool, or call Skill with query set to a few words to see descriptions.';
}

/** One line per plugin (and one for skills without a plugin), in the order the skills come. */
function nameLines(skills: SkillDef[], described: Set<SkillDef>, counts: boolean): string {
  const groups = new Map<string, string[]>();
  for (const s of skills) {
    if (described.has(s)) continue;
    const key = s.plugin ?? '';
    const short = s.plugin && s.name.startsWith(`${s.plugin}:`) ? s.name.slice(s.plugin.length + 1) : s.name;
    groups.set(key, [...(groups.get(key) ?? []), short]);
  }
  return [...groups]
    .map(([plugin, names]) => {
      const label = plugin || 'other';
      if (counts) return `- ${label}: ${names.length} skill${names.length === 1 ? '' : 's'}`;
      return plugin ? `- ${plugin}: ${names.join(', ')}` : `- ${names.join(', ')}`;
    })
    .join('\n');
}

const STOP = new Set(
  'the and for with that this from into your you are was were will when what which use using used uses also only then than them they their there here have has had not but can any all each other more most some such very just like make makes made about over under after before while where how why who its our out get got via per one two new add adds see run runs code task tasks work skill skills agent agents user users file files should must need needs want wants does done doing'.split(
    ' ',
  ),
);

/** Lowercase words of three or more letters, a trailing plural s dropped, stop words out. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#]{2,}/g) ?? []).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).filter((w) => !STOP.has(w));
}

/**
 * Skills ranked by how well their name and description match the context:
 * each shared word counts by how rare it is across the skills (IDF), three
 * times over in the name. A skill needs a name word or two description words.
 */
export function matchSkills(skills: SkillDef[], context: string): SkillDef[] {
  const want = new Set(words(context));
  if (!want.size) return [];
  const docs = skills.map((s) => ({ s, name: new Set(words(s.name.replace(/[-_:]/g, ' '))), desc: new Set(words(s.description)) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set([...d.name, ...d.desc])) df.set(w, (df.get(w) ?? 0) + 1);
  const scored: Array<{ s: SkillDef; score: number }> = [];
  for (const d of docs) {
    let score = 0;
    let inName = 0;
    let inDesc = 0;
    for (const w of want) {
      const idf = Math.log(1 + docs.length / (df.get(w) ?? 1));
      if (d.name.has(w)) {
        score += 3 * idf;
        inName++;
      } else if (d.desc.has(w)) {
        score += idf;
        inDesc++;
      }
    }
    if (inName || inDesc >= 2) scored.push({ s: d.s, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).map((x) => x.s);
}
