/**
 * The refusal fallback list as written: in config.json (objects) and in an
 * agent's frontmatter (`refusalFallback:` a list of "model" or
 * "model@account" strings, or `off`). Pure, with no engine imports, so the
 * agent loader can read it.
 */
import type { RefusalFallbackEntry } from '../config/schema';

/** Longest list kept. More than this is a mistake, not a plan. */
export const MAX_REFUSAL_ENTRIES = 12;

/** "cliproxy/claude-opus-5-5@neu" -> { model, account: "neu" }. A string without @ has no account. */
export function parseRefusalEntry(raw: unknown): RefusalFallbackEntry | undefined {
  if (typeof raw === 'string') {
    const s = raw.trim();
    const at = s.lastIndexOf('@');
    // "@agent" refs are agents, not models
    if (!s || at === 0) return undefined;
    const model = (at > 0 ? s.slice(0, at) : s).trim();
    const account = at > 0 ? s.slice(at + 1).trim() : '';
    return model ? { model, ...(account ? { account } : {}) } : undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!model || model.startsWith('@')) return undefined;
  const account = typeof r.account === 'string' ? r.account.trim() : '';
  return { model, ...(account ? { account } : {}) };
}

/** A list from config or frontmatter, cleaned: bad entries and repeats dropped, at most MAX_REFUSAL_ENTRIES. */
export function parseRefusalEntries(raw: unknown): RefusalFallbackEntry[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out: RefusalFallbackEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const e = parseRefusalEntry(item);
    if (!e) continue;
    const key = refusalEntryText(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= MAX_REFUSAL_ENTRIES) break;
  }
  return out;
}

/** The entry as frontmatter writes it: "model" or "model@account". */
export function refusalEntryText(e: RefusalFallbackEntry): string {
  return e.account ? `${e.model}@${e.account}` : e.model;
}

/**
 * An agent's `refusalFallback:` frontmatter. `off` (or false) turns the
 * fallback off for sessions with this agent; a list replaces the owner's
 * list for them and turns it on. Undefined: the owner's setting applies.
 */
export function refusalFallbackField(raw: unknown): RefusalFallbackEntry[] | false | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === false) return false;
  if (typeof raw === 'string' && /^(off|false|no|none)$/i.test(raw.trim())) return false;
  const list = parseRefusalEntries(raw);
  return list.length ? list : undefined;
}
