/**
 * Question detection on "them" segments (docs/design/MEETING-MODE.md 4.3).
 * A heuristic, no model call: it runs on every partial and final, so it has
 * to cost microseconds.
 */

/** A segment that starts with one of these is a question. */
export const QUESTION_STARTS = [
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'which',
  'can you',
  'could you',
  'would you',
  'will you',
  'do you',
  'did you',
  'does',
  'is it',
  'are you',
  'have you',
  'any update',
  'any updates',
  'tell us',
  'tell me',
  'walk us through',
  'walk me through',
  'talk me through',
  'take me through',
  'what about',
  'thoughts on',
  'explain',
  'describe',
  'give me',
  'give us',
  'design',
  'implement',
  'write a',
  'write me',
  'should',
  'is there',
  'are there',
  'have we',
  "what's",
  "how's",
  "why's",
  "who's",
  "where's",
  'how about',
  'let\'s say',
  'suppose',
  'imagine',
];

/** A segment that contains one of these is a question. */
export const QUESTION_PHRASES = [
  'your update',
  'your status',
  'where are we on',
  'can you share',
  'can you show',
  'can you present',
  'can you explain',
  'can you tell',
  'can you walk',
  'could you explain',
  'tell me about',
  'walk me through',
  'i would love to hear',
  "i'd love to hear",
  "i'm curious",
  'i am curious',
  'what would you',
  'how would you',
  'how do you',
  'why did you',
  'what is the difference',
  "what's the difference",
];

const FILLERS = new Set(['so', 'okay', 'ok', 'and', 'alright', 'right', 'now', 'well', 'um', 'uh', 'great', 'cool', 'next', 'then', 'nice', 'sure']);

/** How many words after the owner's name a start may begin. */
const NAME_REACH = 6;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** True when the words from index i on begin with one of the starts. */
function startsAt(ws: string[], i: number): boolean {
  return QUESTION_STARTS.some((s) => {
    const parts = s.split(' ');
    return parts.every((p, k) => ws[i + k] === p);
  });
}

/**
 * Is this "them" segment a question for the owner? names: the owner's
 * display name and sign-in name (any case).
 */
export function isQuestion(text: string, names: string[] = []): boolean {
  const t = text.trim().toLowerCase();
  const ws = words(t);
  if (ws.length < 3) return false;
  if (t.endsWith('?')) return true;
  // "okay so tell me...", "great, and how would you...": skip a few lead-in words
  let lead = 0;
  while (lead < 3 && FILLERS.has(ws[lead])) lead++;
  if (startsAt(ws, lead)) return true;
  const flat = ` ${ws.join(' ')} `;
  if (QUESTION_PHRASES.some((p) => flat.includes(` ${p} `))) return true;
  const nameWords = new Set(names.flatMap((n) => words(n)).filter((w) => w.length >= 2));
  if (nameWords.size) {
    for (let i = 0; i < ws.length; i++) {
      if (!nameWords.has(ws[i])) continue;
      for (let j = i + 1; j <= i + NAME_REACH && j < ws.length; j++) if (startsAt(ws, j)) return true;
    }
  }
  return false;
}

/** Jaccard similarity of the two texts' word sets, 0 to 1. */
export function similarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}
