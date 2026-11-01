/**
 * A plan's short name: its CLIProxyAPI credential prefix. With one, the
 * plan's models also read neu/claude-opus-5-5, which only that plan serves,
 * so Refusal fallback and the Window starter can keep a request on it. The
 * owner sets it in Settings > Models > Accounts (PUT /api/accounts/:id/prefix).
 * Pure: the hub checks names with it, the web app checks and suggests them.
 */

export const PREFIX_MAX = 24;
const PREFIX = /^[a-z0-9-]{1,24}$/;

/**
 * Why a short name cannot be used, or undefined when it can. `taken` holds
 * the other plans' names. Empty is fine: it removes the name.
 */
export function prefixProblem(name: string, taken: Iterable<string> = []): { reason: 'format' | 'taken'; message: string } | undefined {
  if (name === '') return undefined;
  if (!PREFIX.test(name)) return { reason: 'format', message: 'Use 1 to 24 lowercase letters, digits and dashes.' };
  for (const t of taken) if (t.toLowerCase() === name) return { reason: 'taken', message: `Another plan already has the short name ${name}.` };
  return undefined;
}

/** "Kai Müller" to "kai-muller": lowercase letters, digits and dashes, at most 24. Empty when nothing is left. */
export function slugPrefix(text: string | undefined): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PREFIX_MAX)
    .replace(/-+$/, '');
}

export interface PrefixPlan {
  id: string;
  /** What the page calls the plan: the owner's name for it, else the email or the provider's name. */
  label?: string;
  email?: string;
}

/**
 * Short names to offer plans that have none, by plan id: the name the owner
 * gave the plan, else the part of its email before @, else its label. Two
 * plans that would get the same one (kai@neu.edu and kai@example.com) get
 * their email's domain instead (neu, example). A name still taken gets a number.
 */
export function suggestPrefixes(plans: PrefixPlan[], taken: Iterable<string> = []): Map<string, string> {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const local = (p: PrefixPlan) => p.email?.split('@')[0];
  const domain = (p: PrefixPlan) => slugPrefix(p.email?.split('@')[1]?.split('.')[0]);
  // a label that is not the email is the owner's own name for the plan
  const first = (p: PrefixPlan) => (p.email && p.label && p.label !== p.email ? slugPrefix(p.label) : '') || slugPrefix(local(p)) || slugPrefix(p.label) || 'plan';
  const want = plans.map(first);
  const out = new Map<string, string>();
  plans.forEach((p, i) => {
    const clash = used.has(want[i]) || want.some((w, j) => j !== i && w === want[i]);
    const d = domain(p);
    let name = clash && d && !used.has(d) ? d : want[i];
    for (let n = 2; used.has(name); n++) name = `${want[i].slice(0, PREFIX_MAX - String(n).length - 1).replace(/-+$/, '')}-${n}`;
    used.add(name);
    out.set(p.id, name);
  });
  return out;
}
