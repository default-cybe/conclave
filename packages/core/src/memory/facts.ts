/**
 * Memories are facts, not orders (docs/MEMORY.md, Facts, not orders). A note
 * saved as an order ("Always answer short") is read back in a later session
 * as an instruction to the model, and can win over what the owner asks for
 * then. A fact ("The owner prefers short answers") leaves the call to the
 * agent. These are cheap word rules, run on explicit saves and on what
 * extraction returns; they look at how a note starts and at orders aimed at
 * "you", so a fact that mentions "always" ("The owner always uses pnpm")
 * passes.
 */

/** Words an order starts with. A fact starts with its subject instead. */
const ORDER_START = [
  'always',
  'never',
  'do not',
  "don't",
  'dont',
  'make sure',
  'be sure',
  'remember to',
  'ensure',
  'you must',
  'you should',
  'you need to',
  'must',
  'avoid',
  'please',
];

/** Verbs that start an order in the base form. "Use of", "Run 4" and "Check-in" are left alone. */
const ORDER_VERBS = [
  'use',
  'prefer',
  'keep',
  'run',
  'check',
  'answer',
  'reply',
  'respond',
  'write',
  'give',
  'ask',
  'call',
  'save',
  'put',
  'add',
  'start',
  'stop',
  'follow',
  'treat',
  'ignore',
  'mention',
  'skip',
  'show',
  'tell',
  'include',
  'try',
  'wait',
  'send',
  'stick',
  'default',
  'speak',
];

const VERB_RE = new RegExp(`^(?:${ORDER_VERBS.join('|')})\\s+(?!of\\b|\\d|-)`, 'i');
const START_RE = new RegExp(`^(?:${ORDER_START.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b(?!-)`, 'i');
/** "You must", "you should" and friends anywhere in the text. */
const YOU_RE = /\byou\s+(?:must|should|need\s+to|have\s+to|shall|are\s+to|will\s+need\s+to)\b|\bmake\s+sure\s+(?:to|you)\b/i;
/** "When deploying, run make release": a condition, a comma, then an order. */
const WHEN_RE = new RegExp(`^(?:when|whenever|if|before|after|for)\\b[^.,]{0,80},\\s*(?:(?:always|never)\\s+)?(?:do\\s+not|don't|make\\s+sure|${ORDER_VERBS.join('|')})\\b`, 'i');

/** Drop a leading list mark, quotes and "Remember:" or "Note that" that only wrap the note. */
function core(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '')
    .replace(/^["'“‘`]+/, '')
    .replace(/^(?:remember|note|fyi)\s*:\s*/i, '')
    .replace(/^(?:remember|note)\s+that\s+/i, '')
    .trim();
}

/** "Start date of the thesis is 2026-11-01": the first word is a noun, since a verb follows it before any comma. */
function nounStart(t: string): boolean {
  return t
    .split(',')[0]
    .split(/\s+/)
    .slice(1, 6)
    .some((w) => /^(?:is|are|was|were|has|have|had)$/i.test(w));
}

/**
 * The words that make a note read as an order to the model, or undefined
 * for a fact. "Always use pnpm" gives "Always", "When you deploy, run make
 * release" gives "run".
 */
export function orderIn(text: string): string | undefined {
  const t = core(text);
  if (!t) return undefined;
  const start = START_RE.exec(t) ?? (VERB_RE.test(t) && !nounStart(t) ? VERB_RE.exec(t) : null);
  if (start) return start[0].trim().split(/\s+/).slice(0, 2).join(' ');
  const you = YOU_RE.exec(t);
  if (you) return you[0];
  const when = WHEN_RE.exec(t);
  if (when) return when[0].split(',').pop()!.trim();
  return undefined;
}

function sentence(s: string): string {
  const t = s.trim().replace(/[!]+$/, '').replace(/\s*[.]+$/, '');
  return t ? `${t}.` : t;
}

/**
 * The same note as a fact, for the simple orders: "Always use pnpm" is "The
 * owner uses pnpm.", "Never use npm" is "The owner does not use npm.",
 * "Prefer short answers" is "The owner prefers short answers.". Undefined
 * when the order is not one of those; the caller drops it or asks again.
 */
export function asFact(text: string, subject = 'The owner'): string | undefined {
  const t = core(text).replace(/^please\s+/i, '');
  const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    [/^(?:always\s+)?use\s+(.+)$/i, (m) => `${subject} uses ${m[1]}`],
    [/^(?:always\s+)?prefer\s+(.+)$/i, (m) => `${subject} prefers ${m[1]}`],
    [/^(?:never|do\s+not|don't|dont)\s+use\s+(.+)$/i, (m) => `${subject} does not use ${m[1]}`],
    [/^avoid\s+(.+)$/i, (m) => `${subject} avoids ${m[1]}`],
  ];
  for (const [re, make] of rules) {
    const m = re.exec(t);
    if (!m || /\byou\b/i.test(m[1]) || /^(?:of|\d)\b/i.test(m[1])) continue;
    const out = sentence(make(m));
    if (!orderIn(out)) return out;
  }
  return undefined;
}

/** The rule in words, for tool errors and prompts. */
export const FACTS_NOT_ORDERS = 'Save a fact about the owner or their setup, not an order to the assistant: "The owner prefers short answers", not "Always answer short". An order is read back in later sessions as an instruction and can override what the owner asks for then.';
